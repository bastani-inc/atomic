---
title: Herdr
description: How Atomic reports its pane state to the Herdr terminal multiplexer.
---

# Herdr

[Herdr](https://github.com/herdrdev/herdr) is a terminal multiplexer built for
coding agents. It shows, per pane, whether the agent running there is working,
idle, or waiting on you, so you can tell at a glance which pane needs attention.

Atomic ships a builtin reporter for it. There is nothing to install, nothing to
configure, and no flag to set: run Atomic inside a Herdr pane and the pane
reflects what Atomic is doing.

## What it reports

Three states, and nothing else:

| State | When |
| --- | --- |
| `working` | An agent turn is running, or any top-level workflow run is still nonterminal. |
| `idle` | The turn and all tracked top-level workflow runs have settled. |
| `blocked` | A dialog is open and waiting on you, a workflow awaits input/pauses/blocks/fails, or the turn ended in a provider error. |

Workflow runs are tracked independently, so concurrent runs keep the pane at
`working` until the last one ends. A run that is killed, cancelled, or skipped
ends the same way a completed one does — its contribution is dropped, and the
pane is never told it completed. Ending a run leaves its stage statuses as they
were, so a run stopped while a stage awaited input is reported by the run's own
terminal status rather than by the stage it stopped in. A workflow wait uses
only a short workflow/stage label; run ids, prompt bodies, stage prompts, tool
data, and model output never reach the Herdr socket.

Across `/reload`, `/new`, `/resume`, and `/fork` the replacement session
reconstructs what it reports from the workflow store it can observe, rather
than assuming it saw every past event. A run still live keeps the pane's state,
and one the new session cannot see has its contribution dropped rather than
left behind.

Which runs stay live differs by boundary, and the pane follows. `/reload` and
`/fork` replace the session inside the same process without asking you
anything, so the workflows keep running and the pane keeps reporting them.
`/new` and `/resume` ask first — they say that switching stops in-flight
workflows and clears workflow history — so when you agree, those runs stop and
the pane returns to `idle`.

Precedence runs top down: an open user dialog wins over a workflow block, a
workflow block wins over a recorded failure, a failure wins over an active turn
or workflow run, and idle is the fallback. A dialog opened during a turn
therefore shows `blocked`, not `working`.

`idle` is decided at `agent_settled`, which Atomic emits only after retries,
compaction retries, and queued continuations are finished. A pane does not
flicker to idle between a failed request and its retry.

## What it sends

Each report carries the pane id, the fixed identity `herdr:atomic` / `atomic`,
the state, a short label, a sequence number, and a reference to the Atomic
session file. A workflow report uses its workflow or stage name as the label;
it never uses a run id or prompt body. Dialog and workflow labels are capped at
120 characters.

**Prompt text, stage prompts, tool arguments, model output, and provider error text
never cross the socket.** A dialog title or workflow label within the cap is sent
exactly as given, whitespace and all; a longer value is sent as its first 119
characters followed by an ellipsis. Nothing else is rewritten into the report.

A turn that ended in a provider error reports the fixed string
`Agent turn failed`, never the provider's own message. That message is whatever
the provider or a custom `streamSimple` implementation put there — an exception
string, a normalized response body, raw request metadata — and real ones carry
authorization headers and echoed prompt content. Truncating it would not make it
safe, so it is not sent at all. The detail stays in the session transcript.

The label shown for a `blocked` pane is the title of the dialog waiting on you —
"Approve edit?", "Overwrite this file?" — taken from the oldest open dialog when
several are stacked.

One wait is deliberately not reported: the project-trust prompt Atomic shows the
first time you open an untrusted folder. That selector is displayed by the
terminal host before the interactive engine child exists, and the reporter lives
in that child, so nothing is on the socket yet. Reporting begins once trust is
resolved and the session starts. Every later dialog, including a trust prompt
raised by an extension mid-session, is reported normally.

## When it is active

The reporter registers nothing at all unless every one of these holds:

- The host presents a terminal pane: the interactive TUI, or the engine child
  that drives it. Headless modes — RPC, JSON, print — have no pane to describe,
  and RPC still reports a UI, so this is decided before the extension loads
  rather than by the extension declining afterwards. In a headless host the
  reporter is never constructed and registers no event handlers.
- `HERDR_ENV` is exactly `"1"`, and both `HERDR_PANE_ID` and `HERDR_SOCKET_PATH`
  are set. Herdr exports these into each pane it opens.
- No file-based `herdr-agent-state.ts` / `herdr-agent-state.js` integration
  loaded in the same cycle. If you installed Herdr's own file integration, that
  one wins and the builtin stands down, so the pane never gets two reporters.

Outside a Herdr pane there is no socket, no timer, and no listener. There are no
Atomic settings and no environment knobs for tuning it.

Atomic can defer extension loading so the TUI paints on the first frame, which
means the reporter sometimes loads after `session_start` has already fired. It
binds to the session on whichever lifecycle event it sees first, and seeds both
whether a turn is running and whether a dialog is already open, so a pane is
described correctly whether the reporter arrived before or after the wait it is
describing.

The stand-down check is applied both when the extension loads and again when it
first activates. A file-based integration that loads after the builtin therefore
still wins, and the pane never ends up with two writers regardless of load order.

## Failure behavior

A dead, refusing, or hung Herdr socket degrades to silence. Each report gets one
500 ms attempt and one 1500 ms retry, then is dropped without a diagnostic.

Reporting never blocks the agent. Ordinary lifecycle callbacks — session start,
turn start, settle, block open and close — hand their report to the writer and
return without waiting for the socket, and a non-quit shutdown drops queued work
and returns at once.

Quit is the one exception, and it is deliberate: Atomic drains what is queued and
then attempts the release, because a pane left claimed by a dead agent is worse
than a slow exit. Against a socket that accepts connections and never answers,
that wait is bounded by the transport budgets — at most three requests (session
identity, one coalesced state, the release) at 2 s each, so roughly six seconds
in the worst case, and nothing at all when the socket is healthy or absent. A
substituted transport that never settles has no separate reporter timeout.

Writes are serialized. State, session identity, and the final release all go
through one queue, so exactly one request is ever in flight; state queued behind
an in-flight write collapses to the newest value, and never collapses across a
session or release entry. Herdr silently drops a report whose sequence is not
above the last one it accepted, so overlapping writes would lose reports rather
than reorder them.

## Session lifecycle

Quitting Atomic releases the pane — the queue drains, then a final
`pane.release_agent` is attempted, and nothing is reported afterwards. Like every
other report it can be dropped if the socket is gone, in which case Herdr falls
back on its own handling for an agent that stopped reporting.

`/reload`, `/new`, `/resume`, and forking do **not** release the pane. The
outgoing reporter goes quiet and drops its queued work; the incoming one
re-reports on its own `session_start`. Sequence numbers continue upward across
the handover, because Herdr silently drops a report whose sequence is not above
the last one it accepted.

One caveat: sequence continuity survives session replacement inside one Atomic
process, not a process restart. A fresh Atomic process re-seeds from the wall
clock, which is above anything a predecessor could have reached — unless the
system clock moved backwards between the two, in which case the new process's
first reports may be dropped until it catches up.

## Extension authors

The blocked state comes from the same block door extensions use. Every blocking
`ctx.ui` dialog opens one automatically. If your extension mounts and drives its
own waiting UI, wrap it in
[`pi.awaitUserDecision()`](/extensions#pi-awaituserdecision-label-reason) so the
pane reports it, and subscribe to `agent_blocked` / `agent_unblocked` if you want
to observe waits yourself.
