#!/usr/bin/env bash
# =============================================================
# tests/concurrent_claim.sh
#
# The one thing tests/db_guards.sql structurally cannot prove.
#
# os_selftest() runs inside a single plpgsql function, which means a
# single session and a single transaction. FOR UPDATE SKIP LOCKED is
# about what happens when SEPARATE transactions ask at the same
# instant, and a function cannot open a second transaction. So the
# suite can prove the leasing logic and cannot prove the race is gone.
#
# This script proves the race is gone, by causing one.
#
# Two scenarios:
#   A. N workers, 1 job   -> exactly one worker wins, N-1 get nothing.
#   B. N workers, N jobs  -> all N are claimed, with no job claimed
#                            twice. This is the half that matters for
#                            SKIP LOCKED specifically: without it the
#                            losers would BLOCK behind the winner
#                            rather than moving on to the next job.
#
# Usage:
#   DATABASE_URL=postgresql://... ./tests/concurrent_claim.sh
#   ./tests/concurrent_claim.sh            # reads SUPABASE_DB_URL from .env
#
# Safe to run against a live project: every row it creates is marked
# is_demo and prefixed 'concurrency-', and it deletes them at the end.
# =============================================================
set -uo pipefail

WORKERS="${WORKERS:-8}"

DB="${DATABASE_URL:-}"
if [ -z "$DB" ]; then
  ENV_FILE="$(dirname "$0")/../.env"
  if [ -f "$ENV_FILE" ]; then
    DB="$(grep -E '^SUPABASE_DB_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"'"'"'')"
  fi
fi
if [ -z "$DB" ]; then
  echo "No database URL. Set DATABASE_URL, or SUPABASE_DB_URL in .env" >&2
  exit 2
fi

PSQL=(psql "$DB" -v ON_ERROR_STOP=1 -tAq)
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail=0
say() { printf '%s\n' "$*"; }
check() { # check <name> <actual> <expected>
  if [ "$2" = "$3" ]; then
    say "  PASS  $1 (got $2)"
  else
    say "  FAIL  $1 — expected $3, got $2"
    fail=1
  fi
}

cleanup_rows() {
  "${PSQL[@]}" >/dev/null <<'SQL'
delete from jobs    where idempotency_key like 'concurrency:%';
delete from projects where slug = 'concurrency-test';
delete from agents   where name like 'concurrency-worker%';
SQL
}

# ---- fixtures ------------------------------------------------
cleanup_rows
"${PSQL[@]}" >/dev/null <<SQL
insert into projects (owner_id, name, slug, description, is_demo)
values ('00000000-0000-0000-0000-0000000000aa', 'CONCURRENCY test',
        'concurrency-test', 'temporary fixture', true);

insert into agents (owner_id, name, role, allowed_actions, status, is_demo)
select '00000000-0000-0000-0000-0000000000aa',
       'concurrency-worker-' || g, 'race participant',
       array['read_source'], 'idle', true
  from generate_series(1, $WORKERS) g;
SQL

AGENTS="$("${PSQL[@]}" -c \
  "select id from agents where name like 'concurrency-worker%' order by name;")"

queue_jobs() { # queue_jobs <count>
  "${PSQL[@]}" >/dev/null <<SQL
delete from jobs where idempotency_key like 'concurrency:%';
insert into jobs (owner_id, project_id, job_type, idempotency_key, is_demo)
select '00000000-0000-0000-0000-0000000000aa',
       (select id from projects where slug = 'concurrency-test'),
       'read_source', 'concurrency:' || g, true
  from generate_series(1, $1) g;
SQL
}

race() { # race -> writes one line per worker into $TMP/out
  rm -f "$TMP"/out.*
  local i=0
  while read -r agent; do
    [ -z "$agent" ] && continue
    i=$((i + 1))
    (
      psql "$DB" -tAq -c \
        "select coalesce((os_claim_next_job('$agent'::uuid, 60)).id::text, 'NONE');" \
        2>"$TMP/err.$i" > "$TMP/out.$i"
    ) &
  done <<< "$AGENTS"
  wait
  cat "$TMP"/out.* 2>/dev/null | tr -d ' ' | grep -v '^$'
}

# ---- scenario A: N workers, 1 job ----------------------------
say ""
say "A. $WORKERS workers race for 1 queued job"
queue_jobs 1
RESULT_A="$(race)"
WON_A="$(printf '%s\n' "$RESULT_A" | grep -vc '^NONE$')"
check "exactly one worker claims the job" "$WON_A" "1"

DUPES_A="$("${PSQL[@]}" -c "
  select count(*) from (
    select id from jobs
     where idempotency_key like 'concurrency:%' and lease_count > 1
  ) x;")"
check "no job was leased more than once" "$DUPES_A" "0"

# ---- scenario B: N workers, N jobs ---------------------------
say ""
say "B. $WORKERS workers race for $WORKERS queued jobs"
queue_jobs "$WORKERS"
RESULT_B="$(race)"
WON_B="$(printf '%s\n' "$RESULT_B" | grep -vc '^NONE$')"
UNIQ_B="$(printf '%s\n' "$RESULT_B" | grep -v '^NONE$' | sort -u | wc -l | tr -d ' ')"

check "every worker claimed a job (SKIP LOCKED, no blocking)" "$WON_B" "$WORKERS"
check "no two workers claimed the same job" "$UNIQ_B" "$WON_B"

STILL_QUEUED="$("${PSQL[@]}" -c "
  select count(*) from jobs
   where idempotency_key like 'concurrency:%' and status = 'queued';")"
check "no job left unclaimed" "$STILL_QUEUED" "0"

OVER_LEASED="$("${PSQL[@]}" -c "
  select count(*) from jobs
   where idempotency_key like 'concurrency:%' and lease_count <> 1;")"
check "each job leased exactly once" "$OVER_LEASED" "0"

# ---- cleanup -------------------------------------------------
cleanup_rows
say ""
if [ "$fail" -eq 0 ]; then
  say "concurrent_claim: all checks passed"
else
  say "concurrent_claim: FAILURES above"
fi
exit "$fail"
