# omnios-core, explained in one page

## The problem

You want a robot assistant that does real work — research, drafts, organising
files, tracking tasks. But a robot that can send emails and spend money is
dangerous, because it will eventually misunderstand something. So how do you
give it real abilities without giving it the power to wreck things?

The wrong answer is to tell it "please ask me first". Instructions get
forgotten. The next helper you build won't have them.

## The idea

**Put the rules in the walls, not in the robot.**

Think of a lab where the dangerous chemicals are behind a door that only opens
with a teacher's fingerprint. You don't need to trust the students. It doesn't
matter how curious, confused, or clever they are — the door doesn't open. You
can hand out lab coats freely because the door is doing the work.

In this system the "walls" are the **database** — Supabase, the place where all
the information lives. A database can run little rules called **triggers**: bits
of logic that fire automatically whenever someone tries to change something, and
can refuse the change.

So the rule "don't send a message without permission" isn't a note in the
agent's instructions. It's a trigger. The agent physically cannot write that
change, and neither can any future script, or you at 2am, or an AI writing code
for you next year. There's no way around it, because it isn't a step anyone can
skip — it's the floor.

## Who's allowed to say yes

Here's the clever bit.

The **agent** (the program doing work on your Mac) connects using a very powerful
password called a **service-role key**. It can read and write almost anything.

But approving an action requires something different: proof that a *human*
logged in. In Supabase that proof is a function called `auth.uid()`, and it only
exists when a real person signed in with an email and password. The agent's key,
powerful as it is, has no `auth.uid()` — nobody logged in to make it.

Result: **the agent can ask for permission and is physically incapable of
granting it.** Not because it's polite. Because the thing it would need doesn't
exist in its hands.

## Not everything needs your permission

If the robot asked about every tiny thing, you'd get forty notifications a day,
stop reading them, and click "approve" on autopilot. Then the one that mattered
slips through. That's called **approval fatigue**, and it's how these systems
actually fail — not with a bang, with a bored click.

So every action is sorted into one of five **risk classes**:

| class | means | example |
|---|---|---|
| `read` | just looking | reading a webpage |
| `internal_write` | changes only our own notes | saving research |
| `external_draft` | writes something but doesn't send it | drafting an email |
| `approval_required` | you decide, every time | actually sending it |
| `prohibited` | never, no exceptions, no approval possible | leaking passwords |

The split between `external_draft` and `approval_required` is the useful one.
Writing is safe; *sending* is the irreversible moment. So the slow, hard part
(composing) happens without you, and only the final click needs you.

## Showing its work

Two more pieces make the robot's behaviour checkable instead of mysterious.

**Evidence rows.** When the agent claims something, it stores the source link and
the exact quote it used. So you can check whether it actually read real sources,
instead of just trusting the summary. A claim without a source is just an
assertion.

**The audit log.** Every change gets recorded, and that record is **append-only**
— it can never be edited or deleted, again enforced by a trigger. A log that the
robot could edit would be worthless, like letting someone rewrite the security
footage. You keep it precisely because it can't be changed.

## The stop button

There's an **emergency pause**. Flip it and nothing that writes or sends can
start. Reading still works, on purpose — when something's going wrong you want
to *look* more, not less. And only a signed-in human can flip it. An agent can't
pause the system, because a switch a robot can flip is a switch a robot can flip
by mistake.

Honest limit: it stops new work from starting. It does not stop a job already
running. That's written down in `docs/known-limitations.md` rather than hidden.

## Why you should half-trust this

Thirty-three tests run against the real database, and each one *tries to break a
rule* and checks that it fails. That's a different thing from tests that confirm
features work. It found five real bugs during the build, four of them mine.

And every one of those bugs broke in the safe direction: the guard blocked
everything instead of allowing everything. A system that fails closed is annoying
when it's wrong. A system that fails open is dangerous when it's wrong.

## In one sentence

The agent isn't trusted, doesn't need to be, and works inside a room whose doors
it cannot open.
