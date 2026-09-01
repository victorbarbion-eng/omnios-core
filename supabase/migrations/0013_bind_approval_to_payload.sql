-- =============================================================
-- 0013_bind_approval_to_payload.sql
--
-- Closes a time-of-check-to-time-of-use hole in the approval gate.
--
-- THE HOLE. os_guard_jobs() asked: "does an approved approval exist for
-- THIS job id and THIS action type?" It never asked whether the job still
-- contains what the human was shown. So:
--
--   1. agent queues send_message with input_reference
--      {"to": "consultant@example.com", "body": "..."}
--   2. agent requests approval; approvals.action_preview and
--      action_payload record that, and the human reads it and approves
--   3. agent updates jobs.input_reference to {"to": "someone-else", ...}
--   4. agent moves the job to running
--
-- Step 4 passes every existing guard. The approval is approved, the job
-- id matches, the action type matches. Nothing lied; the check simply
-- asked the wrong question. The approval authorised an IDENTIFIER when
-- what a human agreed to was CONTENT.
--
-- Worth noting where this sits in the threat model. The agent already
-- holds the service-role key by design — the thesis of this system is
-- that such a key still cannot obtain a human decision. That thesis held.
-- What did not hold is that a decision, once obtained, stayed attached to
-- the thing it was given for. That is arguably worse than a missing
-- guard, because the audit trail would have shown a properly approved
-- job running, and the operator reading it would have had no reason to
-- look further.
--
-- TWO FIXES, deliberately overlapping.
--
-- 1. FREEZE. Once an approval exists for a job in pending or approved
--    state, jobs.input_reference cannot change. The request is the
--    contract; you may not edit the thing you asked about while it is
--    being considered. This is the simpler control and it does most of
--    the work.
--
-- 2. BIND. The approval records a sha256 of the job payload at request
--    time, and the execution gate recomputes it and compares. This
--    catches anything that gets past the freeze — a future migration
--    that adds a bypass, a direct write from a superuser session, a
--    trigger disabled and re-enabled.
--
-- One would be enough for the honest failure. Two are here because the
-- freeze is a rule about WHEN and the digest is a fact about WHAT, and
-- only the second still means something if the first is ever loosened.
--
-- BREAKING, on purpose: an approval granted before this migration has no
-- digest, and a job whose approval has no digest is refused. Failing
-- closed is the only defensible direction for a control whose whole
-- purpose is to make "approved" specific. Re-request those approvals;
-- the error says so.
-- =============================================================

alter table approvals
  add column if not exists approved_payload_digest text;

comment on column approvals.approved_payload_digest is
  'sha256 of the job''s input_reference, captured when this approval was requested. The execution gate recomputes it and refuses if the payload has changed since, so "approved" means this exact content and not merely this job id.';

-- ---- Canonical digest ----------------------------------------
-- jsonb renders with sorted keys and normalised whitespace, so the same
-- logical payload always produces the same text and therefore the same
-- hash. Do NOT switch this to json: that preserves input formatting and
-- key order, and two identical payloads would hash differently.
create or replace function os_payload_digest(p jsonb) returns text
language sql immutable as $$
  select encode(digest(coalesce(p, '{}'::jsonb)::text, 'sha256'), 'hex');
$$;

comment on function os_payload_digest is
  'Stable sha256 of a jsonb payload. jsonb (not json) because it normalises key order, which is what makes the hash comparable across writes.';

-- ---- Capture the digest when an approval is requested ---------
create or replace function os_bind_approval_payload() returns trigger
language plpgsql as $$
declare
  v_payload jsonb;
begin
  if new.job_id is null then
    return new;   -- an approval not tied to a job has no payload to bind
  end if;

  select input_reference into v_payload from jobs where id = new.job_id;
  if not found then
    raise exception 'OMNIOS_UNKNOWN_JOB: approval % references job % which does not exist.', new.id, new.job_id
      using errcode = 'foreign_key_violation';
  end if;

  new.approved_payload_digest := os_payload_digest(v_payload);
  return new;
end;
$$;

comment on function os_bind_approval_payload is
  'Records what the job actually contained at the moment approval was requested.';

drop trigger if exists approvals_bind_payload on approvals;
create trigger approvals_bind_payload
  before insert on approvals
  for each row execute function os_bind_approval_payload();

-- ---- Freeze the payload while a decision is outstanding -------
create or replace function os_freeze_job_payload() returns trigger
language plpgsql as $$
declare
  v_open integer;
begin
  if new.input_reference is not distinct from old.input_reference then
    return new;   -- not touching the payload; nothing to protect
  end if;

  select count(*) into v_open
    from approvals a
   where a.job_id = new.id
     and a.status in ('pending', 'approved');

  if v_open > 0 then
    raise exception
      'OMNIOS_PAYLOAD_FROZEN: job % has an approval pending or granted, so its input_reference can no longer change. Cancel that approval and request a new one for the new content.',
      new.id
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

comment on function os_freeze_job_payload is
  'Refuses a change to a job payload once an approval for it is pending or granted. You may not edit the question while it is being answered.';

drop trigger if exists jobs_freeze_payload on jobs;
create trigger jobs_freeze_payload
  before update on jobs
  for each row execute function os_freeze_job_payload();

-- ---- Verify the binding at execution -------------------------
-- Replaces the whole of os_guard_jobs() from 0004 so the approval gate
-- can compare digests. Everything else in it is unchanged; the only edit
-- is inside step 3.
create or replace function os_guard_jobs() returns trigger
language plpgsql as $$
declare
  v_risk       risk_class;
  v_auto       boolean;
  v_allowed    boolean;
  v_approval   approvals;
  v_now_digest text;
begin
  v_risk := os_risk_level(new.job_type);
  v_auto := os_is_auto_allowed(new.job_type);

  if v_risk = 'prohibited' then
    raise exception 'OMNIOS_PROHIBITED: action type "%" is prohibited by policy and cannot be queued.', new.job_type
      using errcode = 'check_violation';
  end if;

  if tg_op = 'INSERT' then
    return new;
  end if;

  if new.status is distinct from old.status then

    v_allowed := case old.status
      when 'queued'            then new.status in ('claimed','cancelled','failed')
      when 'claimed'           then new.status in ('running','awaiting_approval','queued','failed','cancelled')
      when 'running'           then new.status in ('awaiting_approval','completed','failed','cancelled')
      when 'awaiting_approval' then new.status in ('running','completed','failed','cancelled')
      when 'failed'            then new.status in ('queued','cancelled')
      when 'completed'         then false
      when 'cancelled'         then false
    end;

    if not v_allowed then
      raise exception 'OMNIOS_BAD_TRANSITION: job % cannot move from % to %.', new.id, old.status, new.status
        using errcode = 'check_violation';
    end if;

    if new.status in ('claimed','running') and os_emergency_pause() and v_risk <> 'read' then
      raise exception 'OMNIOS_EMERGENCY_PAUSE: system is paused; only risk_level=read jobs may start (job % is %).',
        new.id, v_risk
        using errcode = 'check_violation';
    end if;

    -- 3. The approval gate, now asking about content and not only about
    --    identity.
    if new.status in ('running','completed') and not v_auto then
      select * into v_approval
        from approvals a
       where a.job_id = new.id
         and a.action_type = new.job_type
         and a.status = 'approved'
       order by a.decided_at desc nulls last
       limit 1;

      if not found then
        raise exception
          'OMNIOS_APPROVAL_REQUIRED: job % (%) needs an approved approval record before it can run. Set status to awaiting_approval and create one.',
          new.id, new.job_type
          using errcode = 'check_violation';
      end if;

      if v_approval.approved_payload_digest is null then
        raise exception
          'OMNIOS_APPROVAL_UNBOUND: approval % was granted before payload binding existed, so it cannot be shown to authorise this exact content. Request a new approval.',
          v_approval.id
          using errcode = 'check_violation';
      end if;

      v_now_digest := os_payload_digest(new.input_reference);
      if v_now_digest <> v_approval.approved_payload_digest then
        raise exception
          'OMNIOS_PAYLOAD_CHANGED: job % was approved with a different payload. The approval authorised specific content, not this job id. Request a new approval for what the job now contains.',
          new.id
          using errcode = 'insufficient_privilege';
      end if;
    end if;

    if new.status = 'claimed'   and new.claimed_at  is null then new.claimed_at  := now(); end if;
    if new.status = 'running'   and new.started_at  is null then new.started_at  := now(); end if;
    if new.status in ('completed','failed','cancelled') and new.finished_at is null then
      new.finished_at := now();
    end if;
  end if;

  if new.attempt_count > new.max_attempts then
    raise exception 'OMNIOS_RETRY_LIMIT: job % exceeded max_attempts (%).', new.id, new.max_attempts
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function os_guard_jobs is
  'The job guard. Since 0013 the approval gate compares a digest of the job payload against the one recorded when approval was requested, so an approval authorises content rather than an identifier.';
