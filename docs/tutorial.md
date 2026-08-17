# omnios-core: a guided tour

This is the walkthrough, written for the person who owns the system rather than
the person who typed it. It explains **why each piece exists, what it is
defending against, and where it will bend** when you push on it. It does not
walk through syntax line by line — the code is there for that, and every file is
short enough to read directly.

Read it in order. Each part builds on the previous one.

---

## Part 0 — The one idea the whole system is built around

Everything here follows from a single sentence:

> **The rules live in the database, not in the agent.**

That is the entire thesis. It sounds like an implementation detail. It is
actually the difference between a system you can trust and a system you have to
supervise.

Consider the ordinary way people build this. You write an agent. Inside the
agent you write `if (action === 'send_email') await askUser()`. It works. Then
you write a second agent, and it needs the same check, so you copy it. Then you
add a cron job that touches the same tables and forgets the check entirely. Then
a model writes a new script for you at 2am and it never had the check. Every new
piece of code is a new chance to forget, and the failure is silent — the email
just goes out.

The alternative is to put the rule where the data is. In this system, the
statement "an agent may not run a `send_message` job without an approved
approval record" is not a line of TypeScript. It is a PostgreSQL trigger. If a
job row tries to move to `running` and its action class is
`approval_required` and there is no approved approval, the **database refuses
the write** and raises `OMNIOS_APPROVAL_REQUIRED`.

That refusal applies to:

- the local agent runner
- the dashboard
- a future worker on a VPS
- a script you write in six months
- a script an AI writes for you and you skim before running
- you, personally, poking at the SQL editor with the most powerful key you own

There is no code path around it, because it is not in a code path. This is why
the guard tests matter so much and why there are 33 of them: they are not
testing the agent, they are testing the walls.

A useful way to hold it: **the agent is not trusted and does not need to be.**
It is a worker with a narrow permit, operating inside a room whose doors it
cannot open. If it goes haywire, misreads an instruction, or is manipulated by
something it read on the internet, the worst it can do is fill the room with
drafts and requests for permission.

---

## Part 1 — Authority versus identity

This distinction is the security core, and it is the one thing worth
understanding properly. Most agent systems get it wrong.

There are two different questions a system can ask about a request:

1. **Who is allowed to do this?** — authority
2. **Who should we record as having done this?** — attribution

They feel like the same question. They are not, and conflating them is how
agent systems get compromised.

In omnios-core:

- **Authority comes from `auth.uid()`.** That is Supabase's function for "the
  end user proven by a signed JWT from a real login". It cannot be set by the
  caller. It either exists because a human signed in, or it does not exist.
- **Attribution comes from a header,** `x-omnios-actor`. The agent sets it so
  the audit log can say "the runner did this" rather than "something did this".

Now the important part. **The header can be forged and it does not matter.**

An agent can claim to be a user in that header. It gains nothing. The guard that
protects approval decisions does not look at the header at all — it checks
whether `auth.uid()` is present. The agent connects with a service-role key,
which is enormously powerful in the ordinary sense (it bypasses row-level
security) and yet has **no `auth.uid()` at all**, because no human logged in to
create it.

So the agent can do a great deal, and it can never approve anything. It can
create an approval request. It cannot grant one. Not because it was told not to
— because the credential it holds is structurally incapable of satisfying the
check. Test 05 is exactly this: an approval decision attempted from a key-only
connection returns `OMNIOS_HUMAN_SESSION_REQUIRED`.

There is a second, subtler trap here, and I fell into it during the build. It is
worth showing because it is instructive.

Migration `0008` had to fix `os_actor_type()`. The original version resolved the
actor from the header, and when the header was absent it returned `NULL`, which
broke inserts. The obvious fix — "if no header, assume it's the user" — is a
security hole: an unattributed connection would be *promoted* to human. The
correct fix resolves identity from the **channel** the request arrived on, which
the caller cannot choose:

- a request carrying a real Auth session → `user`
- a request arriving through the API with only a key → `agent`
- direct database work with no request context at all → `system`

The lesson generalises: when a default is ambiguous, **default to less
authority, never more.** An unlabelled caller is not a person.

---

## Part 2 — The policy table, and why five classes instead of a boolean

`action_policies` has 28 rows, one per action type, and each is assigned one of
five risk classes:

| class | meaning | example |
|---|---|---|
| `read` | observes, changes nothing | `read_source` |
| `internal_write` | changes only our own records | `research_topic`, `update_task_status` |
| `external_draft` | prepares something outward-facing but does not release it | `draft_report`, `open_pull_request_draft` |
| `approval_required` | you decide, every time | `send_message`, `deploy`, `delete_data`, `place_trade` |
| `prohibited` | never, by anyone, no approval possible | `exfiltrate_secrets` |

Why not just `safe` / `needs_approval`? Because a two-state system forces you to
lie about one of the two.

If you make it permissive, "organise files in the project folder" and "wire money"
land in the same bucket, and you stop reading the approvals because most of them
are noise. Approval fatigue is the actual failure mode of these systems: a queue
of forty items where thirty-eight are trivial trains you to click approve
without reading, and then item thirty-nine is the one that mattered.

If you make it restrictive, the agent cannot do anything without a prompt, and
you turn yourself into its keyboard.

Five classes let the boring middle happen silently while the consequential edge
stops dead. `internal_write` is unattended by design: nothing outside the system
observes it, and it is all reversible. `external_draft` is the interesting one —
it is the "write it, don't send it" class. Drafting is safe; releasing is not.
Splitting drafting from sending is what lets an agent be genuinely useful under
low autonomy, because the expensive, slow, judgement-heavy part (composing) is
unblocked and only the irreversible instant (sending) needs you.

And `prohibited` exists because some things should not be one tired click away.
There is no approval flow for `exfiltrate_secrets`. A category with no path to
yes is a real safety property, not decoration.

### Promotion, and the note requirement

Your autonomy level is `low_risk_operations`. The design intent is graduated
autonomy: once you have watched a specific action work correctly enough times,
you promote *that one action type* to automatic. Not the agent, not a tier —
one action.

Promotion requires a written reason (`promoted_note`), enforced by the database:
test 16 shows the refusal `OMNIOS_PROMOTION_NEEDS_NOTE`. This is not
bureaucracy. Six months from now the interesting question will be "why is this
automatic?" and the honest answer is usually "I don't remember". A forced
sentence at the moment of decision is the cheapest possible defence against your
own future forgetting.

And an agent cannot promote itself (test 17, `OMNIOS_SELF_PROMOTION_BLOCKED`).
An agent that can widen its own permissions has no permissions, only
preferences.

---

## Part 3 — The audit log, and why it is append-only

`audit_events` cannot be updated. It cannot be deleted from. Triggers refuse
both with `OMNIOS_AUDIT_APPEND_ONLY` (tests 11 and 12).

The reasoning: a log that can be edited by the thing it is logging is not
evidence, it is a rumour. Its whole value is that it is the one place where the
record of what happened is not subject to revision by whatever caused it. That
guarantee has to be absolute, or it is not a guarantee — "append-only except
when convenient" gives you nothing at the moment you actually need it, which is
when something has gone wrong and you are trying to reconstruct why.

This has a consequence people find surprising, and it produced one of the bugs
in this build. Deleting a project used to be impossible. `audit_events` had a
foreign key to `projects` with `ON DELETE SET NULL`, so deleting a project made
PostgreSQL try to *modify* audit rows, and the append-only trigger correctly
refused. Two guarantees, both correct, in direct conflict.

The resolution tells you which guarantee ranks higher: the foreign key was
dropped. `audit_events.project_id` is now a plain identifier with no referential
integrity. It keeps pointing at a project that no longer exists — which is
exactly right, because the historical fact "this happened in project X" remains
true after X is deleted. Referential integrity is a statement about the present.
History is a statement about the past. Do not let the present rewrite the past.

Test 29 verifies this end to end: delete the project, and 17 audit events about
it survive. The dashboard renders those rows as `(deleted project)`.

Two things deliberately do **not** go in the audit log: secrets, and full
document contents. An audit log becomes a very attractive target if it is also
an archive. It records *what changed*, and points elsewhere for *what the thing
was*.

---

## Part 4 — Jobs as a state machine, and why the runner is dull

A job moves `queued → running → awaiting_approval → completed | failed`, and
the legal transitions are enforced in the database. `queued` cannot jump
straight to `completed` (test 02, `OMNIOS_BAD_TRANSITION`).

That specific test looks pedantic. It is the most practically valuable guard in
the set, because "mark it done without doing it" is precisely what a confused
agent does when it hits an error it cannot handle. A state machine that only
permits real paths makes a whole family of quiet failures impossible.

Three related properties, each defending against a specific way agents
misbehave:

- **Idempotency keys** (test 21). Every job carries a unique key. Run the demo
  twice and the second attempt collides instead of duplicating work. Agents
  retry — on timeouts, on ambiguity, on losing track. Idempotency is what makes
  retrying safe, and therefore what makes retrying acceptable.
- **Bounded retries** (test 20, `OMNIOS_RETRY_LIMIT`). Three attempts, then it
  stops and stays failed. An unbounded retry loop against a paid API is a way to
  spend real money on the same mistake repeatedly.
- **Refusal over circumvention.** When the runner hits a blocked action it
  writes a refusal and stops. It does not try another route. This is the single
  most important behavioural property of the runner, and it is why the runner is
  intentionally boring: about 300 lines, no framework, no planner, no
  self-modification. The clever part of this system is the walls. The worker
  should be simple enough that you can read all of it in one sitting and be
  confident it contains no surprises.

The demo workflow — research → evidence → draft → approval → project record —
sends nothing, by design. It produces a draft and an evidence record, links them
to the project as artifacts, and when it reaches the step that would contact the
outside world it stops and files an approval request. That is the shape every
future workflow should copy.

### The evidence table, which is the quiet favourite

`evidence` stores a source URL, an excerpt, when it was captured, a relevance
note and a verification status, linked to the task and job that used it.

The purpose is to make an agent's *reasoning* inspectable rather than just its
*output*. A draft with no evidence trail is an assertion; you either trust it or
you redo the work, and redoing the work means the agent saved you nothing. With
evidence rows you can check the three claims that actually matter without
rereading everything: did it look at real sources, do those sources say what it
thinks they say, and what did it fail to find.

This is also why one of the redaction bugs mattered more than it looked. My
secret-scrubbing pattern for `sk-` API keys matched inside the phrase
"risk-management" and mangled a NIST URL in an evidence record. A destroyed
source URL is an unverifiable claim. **Over-redaction attacks the same property
that evidence exists to protect.** Being too aggressive about safety is not
automatically safe.

---

## Part 5 — The emergency pause, and honesty about what it does not do

Flip `emergency_pause` and only `read`-class jobs may start. Write-capable work
is refused at the database with `OMNIOS_EMERGENCY_PAUSE` (tests 09 and 10).

Two design decisions worth noticing.

**Read work continues.** A pause that blinds you is a bad pause. When something
is wrong you need to look at the system more than usual, not less, so
observation stays available while action stops.

**Only a signed-in human can engage it.** A key-only caller is refused
(`OMNIOS_HUMAN_SESSION_REQUIRED`, tests 27 and 28). An agent cannot pause the
system — which sounds backwards until you notice that a control an agent can
operate is a control an agent can operate *wrongly*, and a kill switch is the
one thing that must answer only to you.

**Now the honest limitation.** The pause prevents new write-capable jobs from
*starting*. It does not kill work already running. If a job is mid-flight when
you flip it, that job continues to completion.

I am telling you this plainly rather than letting you discover it during an
incident. It is a real gap and it is documented in `docs/known-limitations.md`.
Closing it properly requires cooperative cancellation — running jobs
periodically re-checking the flag and aborting cleanly — which is genuine work
and was not in this scope. In practice the exposure is small right now because
jobs are short and there is one runner. It grows the moment you add a worker
that runs long tasks unattended, so close it before you do that.

A related distinction: **system-wide pause** and **per-agent pause** are
different tools. Setting one agent's `status` to `paused` stops that worker only
(test 33, `OMNIOS_AGENT_PAUSED`). Note that `offline` is deliberately *not* a
block — a laptop is offline most of the time, and queued work should wait for it
rather than be rejected.

---

## Part 6 — Row-level security, and the key that cannot delete

Every table has row-level security. Owner A cannot see owner B's projects (tests
22 and 23). Today you are the only user, so this looks like ceremony. It is
cheap insurance: adding multi-user access later means creating a user, not
retrofitting isolation into a schema that assumed one person. Retrofitting
isolation is a rewrite.

More interesting: the `authenticated` role — the one the dashboard uses — has
**no DELETE policy at all** on the core tables (test 24). Not "delete is
restricted". Delete simply is not granted, so the row survives the attempt.

That is deliberate. The dashboard is a *console*: it shows you state and lets
you decide. It is not an administration tool. Destructive operations belong to
deliberate, scripted, reviewable actions, not to a button that lives one
mis-click away from the approve button. In a system whose purpose is visibility,
the interface you use most often should be the one that can do the least damage.

The dashboard also never holds a service-role key. It uses the publishable key
plus your session, which means **row-level security is what decides what you
see**, not application code. If the RLS policies are right, the UI cannot leak;
if the UI has a bug, it cannot exceed your own permissions. Enforcement lives in
one place.

Approve and deny are deliberately thin: they write `status` and
`decision_note`, and if the database refuses, the error is shown to you
verbatim, including the Postgres code. No prettification. When something is
blocked you want to know exactly which guard blocked it, and a friendly
paraphrase throws that away. The UI is a window onto the rules, not a second
implementation of them.

---

## Part 7 — Reading the failures, which is the real lesson

Five bugs were found by testing during this build. Four were mine. Their
pattern is more instructive than the fixes.

1. **`os_write_audit()` referenced `NEW.project_id`** on tables without that
   column. PL/pgSQL resolves record fields at compile time, so *every* project
   insert failed. Fixed by reading fields through `to_jsonb(NEW)`.
2. **`os_actor_type()` returned `NULL`** because in SQL, `x not in (...)` is
   `NULL` when `x` is `NULL` — three-valued logic, not two. The fix had to avoid
   the tempting hole of treating an unlabelled caller as human.
3. **The audit foreign key made project deletion impossible** — two correct
   guarantees in conflict, resolved by deciding which one ranks higher.
4. **Redaction over-matched**, corrupting a real evidence URL.
5. **Migration `0009` compared `agents.status` to `'disabled'`**, which is not a
   member of the enum (`offline`, `idle`, `running`, `paused`, `error`). Every
   assigned-job insert failed with `22P02`.

Two observations.

**They were all found by tests that tried to break things, not by tests that
confirmed things work.** A test suite that only walks happy paths tells you the
feature exists. These tests each assert that a specific bad thing *cannot*
happen, which is why they caught bugs in the guards themselves. If you add one
kind of test as this grows, add this kind.

**Bug 5 failed closed.** Because the broken comparison threw an error, the guard
blocked *everything* rather than permitting everything. Nothing was ever
wrongly allowed; the system was merely useless until fixed. That is the correct
direction to fail, and it did not happen by luck — a guard that raises on
anything unexpected fails closed by construction. Write guards so that the
error case is refusal.

I will also flag the temptation I had to resist, repeatedly. Several tests
failed and the fastest way to green was to loosen the guard being tested. Every
time, the failing test was right and my code was wrong. **A guard weakened to
make a test pass is worse than no guard, because you now believe you have one.**

---

## Part 8 — What is not yet true

Stated plainly, because a system you trust incorrectly is worse than one you
distrust accurately.

- **The runner has never executed against the live database from here.** I was
  never given a service-role key, and I did not ask you to hand one to an
  automated process. It is verified by typecheck, 58 unit tests and 33
  in-database guard tests — not by a live end-to-end run. Run `npm run
  agent:demo` on your Mac to close that gap yourself.
- **The dashboard's signed-in views have not been seen with data,** because no
  Auth user exists yet. Every page's query was replayed against the live API
  (all succeeded; a deliberately bogus column returned `42703`, proving the
  column names are real), and the login page renders. Rendering with rows is
  unverified.
- **`max_concurrent_jobs` is stored and ignored.** The runner does not read it.
  It matters when there is more than one worker.
- **The pause does not stop running jobs** (Part 5).
- **All five integrations are inert.** Google Drive, Outlook, Calendar, Finance
  and GitHub exist as an interface with `enabled: false`; every method throws
  `OMNIOS_ADAPTER_DISABLED`. The shape is proven, the connections are not made.
- **Nothing is deployed and nothing is pushed.** One local commit exists. No
  Vercel deployment. The GitHub connector returned `403 user_blocked` on write
  endpoints, so you create and push the repo by hand.

---

## Part 9 — How to think about extending it

Four rules that keep the design coherent as you add to it.

**Add rules to the database, not to the agent.** When you want a new
restriction, the question is "what trigger or policy expresses this?" If your
answer is a check inside one workflow, you have built something that the next
piece of code will forget.

**Add action types to the policy table before writing the code that performs
them.** The table is the vocabulary of the system. A new action arriving without
a policy row is an action with undefined risk.

**Promote one action type at a time, with a reason, after watching it work.**
That is what graduated autonomy means concretely. It is not a slider.

**When adding a worker, change nothing about the rules.** The point of
enforcing in the database is that a VPS worker inherits every guard without
being trusted to implement any of them. It authenticates, claims only jobs it is
granted, and hits the same walls. `docs/future-worker-vps.md` covers the
specifics. If adding a worker requires reimplementing a check, the check is in
the wrong place — move it down.

---

## The short version

- The rules live in the database, so nothing you or a model writes later can
  route around them.
- Authority comes from a human login; the agent's identity is only a label.
  The agent can ask for permission and structurally cannot grant it.
- Five risk classes exist so the boring middle runs unattended and only
  consequential, irreversible actions interrupt you — approval fatigue is the
  real enemy.
- History is append-only and outranks referential integrity.
- Jobs are a state machine, so "claimed done without doing it" is impossible.
- Evidence rows make reasoning checkable, which is why over-redaction is a bug
  and not extra safety.
- The failures found during the build all came from tests that tried to break
  things, and every guard that broke, broke closed.
- Five things are honestly not finished, and they are listed in Part 8.
