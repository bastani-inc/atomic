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
| `working` | An agent turn is running. |
| `idle` | The turn has fully settled and Atomic is waiting for you to type. |
| `blocked` | A dialog is open and waiting on you, or the turn ended in a provider error. |

Precedence runs top down: an open dialog wins over a recorded failure, a failure
wins over an active turn, and idle is the fallback. A dialog opened during a
turn therefore shows `blocked`, not `working`.

`idle` is decided at `agent_settled`, which Atomic emits only after retries,
compaction retries, and queued continuations are finished. A pane does not
flicker to idle between a failed request and its retry.

## What it sends

Each report carries the pane id, the fixed identity `herdr:atomic` / `atomic`,
the state, a short label or error string, a sequence number, and a reference to
the Atomic session file.

**Prompt text, tool arguments, and model output never cross the socket.** The
only free text is a dialog title or a provider error string, and both are capped
at 120 characters.

The label shown for a `blocked` pane is the title of the dialog waiting on you —
"Trust project folder?", "Approve edit?" — taken from the oldest open dialog when
several are stacked.

## When it is active

The reporter registers nothing at all unless every one of these holds:

- `HERDR_ENV` is exactly `"1"`, and both `HERDR_PANE_ID` and `HERDR_SOCKET_PATH`
  are set. Herdr exports these into each pane it opens.
- The session is running the interactive TUI. Headless modes — RPC, JSON, print —
  have no pane to describe, and RPC still reports a UI, so the mode is what
  decides rather than UI availability.
- No file-based `herdr-agent-state.ts` / `herdr-agent-state.js` integration
  loaded in the same cycle. If you installed Herdr's own file integration, that
  one wins and the builtin stands down, so the pane never gets two reporters.

Outside a Herdr pane there is no socket, no timer, and no listener. There are no
Atomic settings and no environment knobs for tuning it.

Atomic can defer extension loading so the TUI paints on the first frame, which
means the reporter sometimes loads after `session_start` has already fired. It
binds to the session on whichever lifecycle event it sees first and seeds its
state from whether the agent is currently idle, so a pane is described correctly
whether the reporter arrived before or after the turn it is describing.

The stand-down check is applied both when the extension loads and again when it
first activates. A file-based integration that loads after the builtin therefore
still wins, and the pane never ends up with two writers regardless of load order.

## Failure behavior

A dead, refusing, or hung Herdr socket degrades to silence. Each report gets one
500 ms attempt and one 1500 ms retry, then is dropped. No Atomic lifecycle path
can be delayed, blocked, or failed by the reporter.

Writes are serialized: one report is in flight at a time, and state queued
behind it collapses to the newest value rather than replaying a stale sequence.

## Session lifecycle

Quitting Atomic releases the pane — the queue drains, then a final
`pane.release_agent` goes out, and nothing is reported afterwards.

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
