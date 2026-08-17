-- =============================================================
-- 0005_rls.sql
-- Row-level security. Model: one owner today, additional
-- collaborators later, least privilege throughout.
--
-- Honest scope note: the service-role key bypasses RLS by design.
-- RLS is what protects the dashboard (which uses the publishable
-- key and a real login). The guards in 0004 are what constrain
-- anything holding the service-role key. Both layers matter.
-- =============================================================

alter table projects        enable row level security;
alter table agents          enable row level security;
alter table tasks           enable row level security;
alter table artifacts       enable row level security;
alter table jobs            enable row level security;
alter table approvals       enable row level security;
alter table evidence        enable row level security;
alter table audit_events    enable row level security;
alter table job_logs        enable row level security;
alter table action_policies enable row level security;
alter table system_settings enable row level security;

-- ---- Owned tables: read / create / update your own rows ------
-- DELETE is intentionally granted to nobody. Deletion is an
-- approval_required action and must go through the approval flow
-- with a privileged connection, never a stray dashboard click.
do $$
declare t text;
begin
  foreach t in array array['projects','agents','tasks','artifacts','jobs','approvals','evidence']
  loop
    execute format(
      'create policy %1$s_select_own on %1$I for select to authenticated using (owner_id = auth.uid())', t);
    execute format(
      'create policy %1$s_insert_own on %1$I for insert to authenticated with check (owner_id = auth.uid())', t);
    execute format(
      'create policy %1$s_update_own on %1$I for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid())', t);
  end loop;
end;
$$;

-- ---- Append-only tables: read your own history --------------
create policy audit_events_select_own on audit_events for select to authenticated
  using (owner_id = auth.uid());

create policy job_logs_select_own on job_logs for select to authenticated
  using (owner_id = auth.uid());

-- ---- Policy and settings ------------------------------------
-- Readable by the signed-in owner so the dashboard can display the
-- autonomy matrix and the pause state. Updatable so you can hit the
-- kill switch or promote an action type. Not insertable or
-- deletable: the vocabulary of actions is a schema-level decision.
create policy action_policies_select on action_policies for select to authenticated using (true);
create policy action_policies_update on action_policies for update to authenticated
  using (true) with check (true);

create policy system_settings_select on system_settings for select to authenticated using (true);
create policy system_settings_update on system_settings for update to authenticated
  using (true) with check (true);

-- ---- Convenience views ---------------------------------------
-- security_invoker = true makes each view run with the caller's
-- permissions, so RLS still applies through the view.

create view v_pending_approvals with (security_invoker = true) as
  select a.id, a.project_id, p.name as project_name, a.job_id, a.action_type,
         a.risk_level, a.action_preview, a.target_reference,
         ag.name as requested_by, a.requested_at, a.expires_at,
         (a.expires_at < now()) as is_stale
    from approvals a
    join projects p on p.id = a.project_id
    left join agents ag on ag.id = a.requested_by_agent_id
   where a.status = 'pending'
   order by a.requested_at desc;

create view v_job_activity with (security_invoker = true) as
  select j.id, j.project_id, p.name as project_name, j.job_type,
         pol.risk_level, pol.auto_allowed, j.status, j.attempt_count, j.max_attempts,
         ag.name as agent_name, j.queued_at, j.started_at, j.finished_at,
         extract(epoch from (coalesce(j.finished_at, now()) - coalesce(j.started_at, j.queued_at)))::int as duration_seconds,
         j.output_artifact_id, j.error_summary
    from jobs j
    join projects p on p.id = j.project_id
    join action_policies pol on pol.action_type = j.job_type
    left join agents ag on ag.id = j.agent_id
   order by j.created_at desc;

create view v_project_summary with (security_invoker = true) as
  select p.id, p.name, p.slug, p.status, p.priority, p.tags, p.is_demo, p.updated_at,
         (select count(*) from tasks t where t.project_id = p.id and t.status not in ('done','cancelled')) as open_tasks,
         (select count(*) from tasks t where t.project_id = p.id and t.status = 'done') as done_tasks,
         (select count(*) from artifacts a where a.project_id = p.id) as artifact_count,
         (select count(*) from evidence e where e.project_id = p.id) as evidence_count,
         (select count(*) from jobs j where j.project_id = p.id and j.status in ('queued','claimed','running')) as active_jobs,
         (select count(*) from jobs j where j.project_id = p.id and j.status = 'failed') as failed_jobs,
         (select count(*) from approvals ap where ap.project_id = p.id and ap.status = 'pending') as pending_approvals
    from projects p
   where p.archived_at is null;
