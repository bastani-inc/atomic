# Workflow Operations

Run and operate workflows from interactive chat or the workflow tool: identify runs, inspect their graphs, communicate with stages, answer human-input gates, and manage durable execution.

## Automatic stage models

A stage authored with `model: "auto"` runs the user's default model (`defaultProvider` and `defaultModel`, the model last chosen with `/model`) when it has credentials, otherwise the launching session's model. Atomic resolves it without a model request, before the stage's first session, and records the resolved model on the stage in place of `auto`. The stage's `fallbackModels` follow it, then, in a session, the launching session's model. A task whose `reads` include image files (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`) needs a model that accepts image input: `auto` then stands for the default model when it accepts images, else the launching session's model when that one does, and otherwise the task fails before a session opens and names the settings to change. A run started through the SDK `run()` or on a worker uses the settings and credentials its stage sessions start with; the "session's model" there is the model given to `createAgentSessionAdapter()`, if any. Stage status shows the model and thinking level the stage actually ran. Replay reuses a stage's recorded result without resolving `auto` again. A paused or resumed stage keeps the session it already has, on the model it started with, even if the default model changed meanwhile; a stage that reopens a saved session runs that session's model while it is still in the stage's model chain, and otherwise the chain's first model. See [authoring automatic stages](/workflows/authoring#automatic-stage-model-selection).

## Workflow run identifiers and the agent panel

Status views and control messages show workflow run identifiers in full. `/workflows` rows show the 8-character prefix, and the run's Space preview shows the full identifier, wrapping it on narrow terminals. Selectors accept either the full 36-character UUID or its unique 8-character hexadecimal prefix. Other truncated forms are rejected. Colliding prefixes report the matching full UUIDs and require a full UUID; resolved results retain canonical identifiers.

Stage selectors preserve exact stage IDs and names, composite `runId:stageId` IDs, and `tool:<argsHash>` IDs. Bare UUID stage IDs additionally accept a unique 8-character hexadecimal prefix across the expanded graph. Exact names take precedence. Partial names and truncated composite/tool IDs do not match; colliding UUID prefixes require the full stage UUID.

### Intercom delivery to pending workflow stages

A workflow stage uses the root-anchored `workflow:<rootRunId>/<segment>[/<segment>...]` path shown by `intercom list` and workflow status surfaces. A segment may be a stage name, a materialized run id, or a glob: `*` matches one segment and may be embedded, while `**` matches any depth. Model-facing `workflow status` and interactive status list/detail surfaces enumerate materialized pending stages by display name and canonical stage ID, printing the path only when `pendingStageDeliveryAvailable` is true and the owning run is nonterminal. An ended root or nested child never advertises a retained pending target. Duplicate names remain independently identifiable. The workflow SDK `sessionId` is the stage's Atomic session ID, not a workflow path: it reaches the stage only while the stage is connected and visible to you, and it never queues for a pending stage.

Join `workflow:<rootRunId>` and run `intercom({ action: "list" })` to see live sessions, materialized `PENDING`/`RUNNING` stages, and possible future literal, glob, and nested-child targets with queued counts. Then use ordinary Intercom delivery:

```ts
intercom({
  action: "send",
  to: "workflow:<rootRunId>/reviewer",
  message: "Scope changed: raw amendment text is now part of the oracle."
})
// queued — distinct from live-session delivered
```

Send material updates through Intercom to every affected workflow stage, including stages that have not started. Name and pattern sends remain sticky for every future matching stage until root termination. When shared scope or acceptance criteria change, broadcast one authoritative update to `workflow:<rootRunId>/**` (or a narrower path pattern) rather than enumerating stages; live matches receive it immediately and future descendants receive it before their first model turn. A syntactically valid path outside the persisted known set still queues, with no warning, and settles undeliverable at terminal only if never delivered; an entry delivered at least once is not reported undeliverable. The queued result's `prediction` field says whether the path is `known`, `predicted` by the decision model, or `unknown`, and a single `No stage named <x> is expected; did you mean <closest>?` line appears only when the decision model has judged the path unlikely. Set `intercom.showUnknownTargetWarnings` to `true` to bring back a note on every `unknown` send. Use `ask` once the stage session is live and can reply. Queued messages are limited to 50 per target and 1,000 (or 64 MiB) per run across all targets; a send past either limit is refused and nothing already queued is dropped, so prefer one broadcast to a pattern over many per-stage sends. See [deferred delivery to pending stages](/intercom/reference#deferred-delivery-to-pending-stages).

When the launch scan cannot read some stage names (names built by helpers, imported step factories, loops over lists, or child workflows chosen at run time), the [decision model](/settings#decisionmodel) predicts them in the background from candidates in the workflow source. Prediction needs probabilities, so it runs only with a classifier `decisionModel`, such as `typesafe/jev-latest`; with a chat model nothing is predicted and the scan alone decides the known set. Launch never waits for it. Status shows one `stage predictions:` line (a `predictions` row in the workflow tool's run detail) listing each predicted path as `predicted`, `confirmed` (a matching stage started) or `unused` (none did before the run ended), with the probability. If the decision model fails or times out, status shows `stage predictions unavailable (<code>)` once and the scan alone decides the known set.

Credential-like candidate names are excluded from prediction requests, and source excerpts are redacted. A site with excluded candidates stays uncertain rather than treating a remaining candidate as exhaustive. Use non-sensitive stage names to make future targets discoverable.

To verify a sticky update, inspect its per-stage `deliveryStates` in `intercom list` or `workflow({ action: "status", runId: "<rootRunId>" })`. Both list at most 5 states, those still needing action first; `deliveryStateCounts` totals every state. The future target's queued count includes messages retained for stages that have not started yet, even after delivery to earlier stages. It is not an unread count or proof of receipt by every stage. `delivered` confirms admission to stage context, not compliance with the update. A transport-only or older receipt appears as `receipt-unverified`; check the stage transcript before resending. See [pending delivery states](/intercom/reference#deferred-delivery-to-pending-stages) for skip reasons and recovery.

### Runs in the agent panel

Each of the session's top-level workflow runs has a row in the [agent panel](/background-tasks#the-agent-panel) below the main chat's prompt:

```text
  ∀ ralph     ▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱  3/5 stages      12m · ↓ 61.0k tokens
  ◆ review    approve the plan?                             needs input · 3m
  ✗ deploy    stage build failed                            failed · 41m
```

The row shows the run's state, stage progress, elapsed time and available token totals. A waiting question or a failure's reason replaces the progress display. Narrow terminals omit the stage bar and tokens before shortening the task text. Press ↓ on an empty prompt, select the run and press Enter to open its graph. A finished run's row stays until you have opened the run, from the panel, `/tasks`, F2 or `/workflows`. A paused run, or one blocked on a failed stage, is listed like a paused subagent: its row stays while another subagent, workflow run or background shell runs, and leaves once nothing does, until you resume the run. `x` pressed twice stops a run gracefully; it stays resumable.

Stage progress includes nested child workflows and updates as stages appear:

- The numerator counts completed, failed, and skipped stages.
- The denominator counts currently materialized stages, not future work.
- Expanded children replace their workflow boundary; neither the boundary nor durable tool nodes add to the stage count.
- If a child started, its stages and tools remain inspectable in the parent graph even when its boundary fails or is skipped. This includes nested work on local workers and separate worker hosts. A stage ID listed for the boundary itself still selects the boundary for inspection and control. If the child never started, has no nodes, or an older record cannot identify it, the graph shows the boundary summary instead.

`single`/`chain` uses the same count.

### Pending questions and exact identities

When a run waits on one question, its agent panel row and its `/tasks` row show `◆`, `needs input` and the question, also when the question comes from a nested child workflow. In `/tasks`, Space on the run opens a card with the question, its numbered choices and a reply box, and Enter sends the reply to that question.

Open the run from the panel to answer in the graph or its stage chat, or use `workflow answer`.

When several questions wait at once, as from parallel stages, or when the question is a custom UI prompt (`ctx.ui.custom`), the row shows `needs input` and the current stage without a question or reply box. Press Enter on the row to open the graph and answer there. The graph, the stage chat and `workflow answer` stay available for every question. Question text has terminal controls removed and never enters the transcript or parent-model context. `workflowNotifications.notifyOn` is unchanged, and F2 still opens only the active workflow.

A run that ended blocked, or that you stopped with `x` twice, shows as `stopped`: its row ages out like other finished rows, and `x` dismisses it. A run you stopped this way stays resumable.

Status, run detail, dispatch confirmation, and run-picker cards wrap full IDs onto continuation rows. Run detail also wraps exact pending-stage addresses instead of ellipsizing them. Narrow status cards wrap the canonical stage ID or drop its display-name decoration, never show a partial ID. Borders stay closed at the minimum layout width; narrower terminals, including sub-30-column terminals, can hard-clip the box.

An `AWAITING INPUT` banner has two identity rows: `？` with the full run id, then the workflow name and optional metadata. The question and options appear below it in the normal prompt UI.

The `/workflows` list shows this session's runs newest first. Use the arrow keys to select a row and type to search. It also lists definitions that could not be loaded with `✗` and their reason; Enter shows the source file and message details without stack frames. Fix the file, then use `/reload`. Loaded definitions are not launch rows: ask the agent to start a workflow through the workflow tool.

In a run's graph, press `o` for run details: declared outputs, artifacts, ordered events and nested blockers. Use ↑/↓ to select among blockers and Enter or → to open the selected blocker; with zero or one blocker, ↑/↓ scrolls instead. PageUp/PageDown scroll in either case. Press `l` to switch between the summary and logs, and Esc to go back one level. Completion notices show bounded output and artifact previews when expanded with Ctrl+O; open run details to inspect the outcome and artifact locations. Large values and unusually wide output records are truncated for display without changing stored results.

The workflow tool's `status` action lists active runs first, with runs waiting for input or blocked at the top, then running and paused runs, followed by ended runs (failed, cancelled, then completed); the newest run comes first within each group.

## Running Workflows

List or inspect unfamiliar workflows before running them. If required inputs are missing and cannot be inferred, ask for the missing values before launch:

```ts
workflow({ action: "list" })
workflow({ action: "get", workflow: "fan-out-and-synthesize" })
workflow({ action: "inputs", workflow: "fan-out-and-synthesize" })
workflow({ action: "models" })
```

The workflow tool action surface is:

- discovery: `list`, `get`, `inputs`, plus `models` for the configured model catalog
- execution: `run` with the workflow name and validated `inputs`
- inspection: `status`, `stages`, `stage`, `transcript`
- prompt response: `answer`; run control: `pause`, `quit`, `resume`; free-form stage communication: ordinary Intercom `send`/live `ask` to `workflow:<rootRunId>/<segment>[/<segment>...]` path targets, including `*` and `**` globs
- rediscovery: `reload`

Every registered `workflow` tool call has a hard 150-second wall-clock deadline at the public tool boundary. It covers request handling through the returned result; for background `run` and `resume`, it covers startup and acknowledgement, not the workflow execution that continues afterward. A deadline returns one structured result:

```json
{
  "action": "run",
  "runId": "339e05a4-2289-408e-9076-d1a348f582ae",
  "status": "failed",
  "code": "WORKFLOW_TIMEOUT",
  "timeoutMs": 150000,
  "error": "Workflow run request timed out after 150000ms. The outcome is unknown. Inspect workflow status before retrying."
}
```

Expiry aborts the request operation signal so work that supports cancellation can stop, discards any later success or error, and never retries the action. The interactive engine remains available for the next command. For mutating actions (`reload`, `run`, `answer`, `pause`, `resume`, and `quit`), the error additionally says that the outcome is unknown and instructs you to inspect workflow status before retrying; a timeout never claims that a mutation succeeded. When a timed-out `run` has already allocated its detached run, the structured result includes that exact full `runId`; inspect `status` with that id before any retry. A timeout before run allocation has no `runId`. Read-only actions (`models`, `list`, `get`, `inputs`, `status`, `stages`, `stage`, and `transcript`) omit that unknown-state guidance.

Explicit user interruption is different from the request deadline. Before startup acknowledgement, interrupting a `run` tool call cancels its initialization owner, records an allocated root as locally `killed`, and prevents delayed setup from starting workflow code. An already-aborted request starts no action. Interrupted resume preparation releases a claim it has acquired instead of dispatching later. After startup acknowledgement, the workflow is detached: aborting the original caller does not stop it; use run-level controls.

Cancellation does not undo committed journal writes or external effects. Inspect status and external effects before retrying an interrupted mutation. A request timeout does not cancel an already accepted detached launch.

Run-level `quit` preserves eligible checkpointed work as a paused run instead of cancelling its durable record. Inspect the run with the workflow tool's `status` action if it reports a storage error; local suspension alone is not proof that the journal saved the pause.

From interactive chat, named workflow launches run in the background so the parent chat stays available. Run `/workflows <run>` to see agents working and chat with and steer each stage. Inspection, prompt-response, and control calls (`status`, `stages`, `stage`, `transcript`, `answer`, `pause`, `resume`, `quit`) remain available while work runs.

The no-`runId` status listing includes bounded pending-stage rows after each run summary. Each row gives the display name, canonical stage ID, literal `pending` lifecycle, `pendingStageDeliveryAvailable`, and either the exact usable Intercom target or `unavailable`. Interactive status cards and run detail show the same identity/availability distinction within their width budgets. Status cards wrap exact targets onto continuation rows instead of rendering a partially truncated address; bounded omissions retain an explicit remaining-stage count.

`workflow({ action: "models" })` returns the registry's configured-auth catalog snapshot in registry order. Each entry includes `provider`, `id`, `fullId`, an `isCurrent` marker, and `availableThinkingLevels` derived from the real model's `reasoning` and `thinkingLevelMap` metadata. This is not proof of credentials, entitlements, OAuth freshness, or live provider access, and it exposes no authentication details.

Named launches wait only for **startup admission**, not for workflow completion. Atomic returns `status: "running"` after durable registration, reusable-worktree setup, and other pre-body setup succeed, while the workflow body and stages continue in the background. If setup fails before the workflow body is admitted — for example, `git_worktree_dir` points inside the invoking checkout, or names a path that must be created while the session is outside the source Git repository — the original `workflow` tool call instead returns a structured `status: "failed"` result with the allocated full run id and concrete setup error. Ordinary setup failures retain no background-start claim or orphan run, so the caller can correct the inputs and retry. Database-unavailable admission instead preserves the failed local run and skips durable cleanup; follow the recovery guidance below before retrying. Failures after admission remain ordinary background lifecycle outcomes reported through status and lifecycle notices. Reusable-worktree setup reuses an existing worktree root of any repository from any session cwd. When `git_worktree_dir` names a non-empty directory that is not a Git checkout, the run gets its own checkout beneath it, and resuming or retrying that run reuses the same checkout.

A model may launch in the foreground only when the user explicitly requests it or foreground execution is technically required, and it must tell the user before launching.

Inspect the workflow's input contract, then launch it by name:

```ts
workflow({ action: "inputs", workflow: "fan-out-and-synthesize" })
workflow({ action: "run", workflow: "fan-out-and-synthesize", inputs: { prompt: "Map the workflow runtime by subsystem" } })
```

In chat, ask the agent to run a workflow by name; it makes these calls. Runtime validation is strict: unknown input keys, missing required values, type mismatches, and invalid `select` choices fail before a named workflow run starts or before a child workflow starts.

In headless (`-p`, `--print`, or `--mode json`) sessions, named workflow dispatch skips pickers and returns an accepted run identity rather than waiting for terminal completion. Inspect `workflow status` for progress, errors and results. Lack of rendering or an input adapter is not an execution restriction: a required durable gate remains pending until an authorized host or answer arrives, never silently succeeds. Explicit `NON_INTERACTIVE_WORKFLOW_POLICY` supplied to the runtime or dispatcher still enforces its restrictions.

SDK applications can instead bind [human-input callbacks](/sdk#human-input-without-a-terminal) without a terminal. The same workflow definition can collect text, confirmation and stage questionnaires through that host, including in nested workflows. Ordinary unsupported dialogs refuse; durable approval prompts remain pending without a usable host. Do not remove or bypass a required approval to make a headless run finish. Custom terminal widgets still require a presentation host.

Withdrawing an SDK adapter cancels its current presentation, not the durable approval. Bind a replacement adapter to answer a live pending request. To hand off a persisted run, gracefully quit it, retain its definition and durable storage, then use the existing resume command in the other host. Completed checkpointed tool results are reused; an effect without a saved checkpoint is not guaranteed exactly once. Inspect `status` for the current pending prompt before answering. Old or repeated answers cannot authorize a new request, and host rebinding never raises an exhausted budget.

Graph node cards show each model stage's effective model and thinking level above its status, including after fallback and durable resume. Long model names are truncated first, preserving the complete thinking level and a canonical `-fast` model suffix. This suffix is model identity, not a separate fast-mode switch, and does not indicate the service tier. Thinking `off` is omitted; stages without a model show no model placeholder. Tool nodes retain their `durable tool` body. The agent panel shows the session's runs below the prompt; `/tasks` lists them beside subagents and shells.


## Workflow Commands

```text
/workflows [run-id] [stage-id-or-name]  # Browse running and completed workflows
/workflow-authoring [request]            # Load the reference for writing workflow definitions
```

| To | Use |
| --- | --- |
| Run a named workflow, list definitions, or show a workflow's inputs | Ask the agent; it uses the `workflow` tool. |
| Check a run's status | Its row in `/workflows` and its graph, or the workflow tool's `status` action |
| Pause, resume or quit a run | `p`, `r` and `q` (twice) in the run's graph |
| Resume a run left by an earlier session or interrupted by a restart | `/resume` |
| Fork a run from a stage | `d` on a finished stage, then `f` in its detail, or the workflow tool's `fork` action |
| Rediscover workflow files and package entries | `/reload` |

Neither command takes flags; confirmations happen inline.

`/workflow-authoring` adds Atomic's workflow authoring guide to the conversation without starting a model turn, and shows `Loaded workflow authoring reference (ctrl+o to expand)`. Add a request after the command, such as `/workflow-authoring a workflow that reviews each changed package`, to submit that request with the guide.

Surface behavior:

- **Graph vs. stage chat** - `/workflows` opens the graph (or ↓ to the run in the agent panel), and `/workflows <run-id> <stage>` opens a stage's chat directly. In the graph, press Enter on a stage to open its chat. If a provider request failed and is being retried, reopening keeps the error in the transcript. The token arrow stays `↑` until the retry starts receiving a reply (`↓`). A chat that stayed open counts the failed reply it saw; a reopened chat starts its count from the request context, which omits that failed attempt. On a failed stage, Enter opens its failure detail; press `t` there for its chat.
- **Live stage borders** - A running stage pulses in the theme’s warning colour (usually yellow); a stage waiting for input pulses in its info colour. Focus a stage to hold its border at full brightness. With colour off, read the status inside the card.
- **Run state** - The graph header puts the run's state before its stage counts and colors the ORCHESTRATOR pill to match: `↑ blocked`, followed by the exit reason when the workflow gave one and shortened to fit; `❚❚ paused`; or `○ quit`. A running run shows no state, including one you resumed. `↑ N` counts blocked stages, and `◌ N` the stages [suspended](#suspended-stages) with their session released. The stage switcher (`/`), the workflow tool's `status` action, and the `/workflows` list show the same state.
- **Going back** - In an attached stage chat, `←` on an empty prompt (or at the start of a typed prompt, preserving the draft) returns to the graph. On a pending question (`ask_user_question` or a choice, yes/no or input prompt), `←` or `Backspace` (at the start of an input) returns to the graph and leaves the question pending; `↑↓` moves between answers on a choice or yes/no prompt. On a choice or yes/no prompt card, `esc` closes the card back to the stage's `Answer <stage>…` composer without leaving; Enter on the empty composer reopens the card, and typing text and pressing Enter answers the pending question. On an `ask_user_question` dialog, `esc` cancels the question. When a stage dialog is stacked over a mounted custom component, `esc` cancels that dialog and returns to the component. The graph has no prompt: `esc` goes back one level (it closes a stage's failure detail, a tool detail or the `?` overlay first), and at the top it returns to where you opened the graph from, such as main chat or the `/workflows` list. `←` only moves to a previous sibling. It does nothing at the leftmost node or inside a detail; only Esc goes back. A custom question widget owns every key; `ctrl+c` closes the workflow view from it. `ctrl+x` does not navigate. See [Keybindings](/keybindings#navigation).
- **Graph keys** - The hint line under the graph lists exactly the keys that work on the focused node, in this order: `esc back · ↵ open stage chat · ↑↓←→ move · x stop stage · p pause run · q quit run · / stages · f filter: all · ? keys · h hide`. `?` lists them all. Enter opens a running, waiting or completed stage's chat (the hint reads `↵ open stage chat`) and a failed stage's failure detail (`↵ open failure detail`). `x` then `x` again within 3 seconds stops the focused running stage so it can be resumed from its stage chat. `p` pauses the run while it runs; while the run is paused or blocked, `r resume run` takes its place. `q` then `q` again within 3 seconds quits the run gracefully, keeping it resumable; after the first press the hint reads `q again to quit <name>`. On a completed or failed stage, `d` opens its detail. `/` finds a stage, and `f` cycles a status filter (all, running, stopped, completed, failed) that dims the nodes it doesn't match without moving anything. A stopped stage or run shows `◼` in a muted colour; a failed one shows a red `✗`. A suspended stage shows `◌` in its node card, the stage switcher and the stage strip, the same mark as a [released subagent](/subagents#released-subagents) in the chat, `/tasks` and the agent panel. The mark is dim except on a selected row, where it uses the selection colours. A paused stage shows `❚❚`. The workflow tool's `status` header counts killed and cancelled runs under `◼`, and failed runs under `✗`.
- **Stage details** - A failed stage's detail shows the stage, elapsed time and a short reason, with `r retry from stage · f fork from stage · t transcript · l logs · esc back`. `r` retries in place, keeping completed work, keeps focus on the same stage and reports another failure. A completed stage's detail reads `✓ <name> · completed in <time> · <tokens>`, with `f fork from stage · t transcript · l logs · esc back`. `f` asks `New run from <stage>? enter confirm · esc cancel` (naming completed tool steps that will run again and warning if the source run must first stop resumably) and then starts and opens a new run from that stage; the source run is unchanged. `t` opens the transcript; `l` toggles the error log, including error codes, hints and causes. Long reasons and logs are truncated.
- **Stage input label** - An attached stage chat has accent-coloured composer rules naming the stage and its state or elapsed time (`stage · <name> · <state/time>`), and its empty prompt reads `Message <stage>…` (`Answer <stage>…` while the stage waits on a question). A subagent's chat opened from `/tasks` or the agent panel uses `<name> · <task> · <state/time>`, with `Message <name>…` or `Answer <name>…`. Awaiting-input prompt cards and mounted questions also identify their owning stage (`[stage: name]`). Long labels truncate with `…`.
- **Draft preservation** - Leaving a stage or opening another run preserves unsent composer and prompt drafts and keeps pending custom questions unresolved so they reappear when you attach again.
- **Queued-message survival** - Detaching preserves queued steering and follow-up text. Reattach to see the pending messages; the graph shows their count as `✉ N queued`. Queues also survive model fallback and eligible post-mortem reopening. Custom session adapters must publish `queue_update` snapshots and expose pre-attachment queues as described in [authoring](/workflows/authoring#stage-follow-on-user-messages).
- **Reserved keys** - `ctrl+d` does not navigate workflow surfaces and keeps its ordinary editor or prompt behavior where applicable; `q` quits a run only in the graph and remains printable in text-owning prompts. In a stage chat with a prompt, `esc` only interrupts a running stage; in the graph it closes the stage switcher, a detail or the `?` overlay, then goes back to where the graph was opened from. `ctrl+c` closes the workflow view. In the graph, `h` hides it and returns to the view that opened it.
- **Wheel and trackpad** - While the workflow graph is active, vertical wheel/trackpad gestures pan it up and down, and horizontal gestures pan wide graphs left and right when the terminal exposes horizontal wheel events. Focused graph and stage-chat overlays receive those gestures through the fullscreen application route, so scrolling stays inside the active workflow surface instead of falling through to terminal or main-chat scrollback.
- **Stage chat scrolling** - An attached stage chat scrolls like the main transcript: the wheel follows `fullscreenWheelScrollLines`, Alt+wheel scrolls five times as far, `fullscreenScrollbar` controls its scrollbar, `ctrl+home` and `ctrl+end` jump to the top and the latest message, `ctrl+up` and `ctrl+down` jump between prompts, and the half-page bindings work once you bind them. Scrolled up, its last row shows **↓ jump to bottom**, or **↓ N new messages** once new output arrives. A `/tasks` transcript opened from a stage chat behaves the same way and follows the stage's Ctrl+T and Ctrl+O. See [Keybindings](/keybindings#tui-fullscreen-viewport).
- **Selection and copying** - Graph panning, stage scrolling, click-to-attach, and drag or multi-click selection work without a separate selection mode. A click on a key in the graph's hint line, a stage chat's hint row or the stage switcher presses that key. Copy uses OSC 52; if the terminal blocks it, use its Shift/Option modifier-drag bypass. `ctrl+t` retains the host thinking toggle, not a workflow action.
- **Tool and node detail** - Attached stage chats match main chat's tool-detail expansion behavior while keeping expansion state local to the workflow UI context. Press Ctrl+O (the configurable `app.tools.expand` binding) to expand every visible workflow node and tool card, including single, parallel, and nested subagent progress, current tool activity, and artifact paths; press it again to collapse them. The toggle works for active, completed, and archived stage views, including at the supported 40-column terminal minimum. A mounted prompt, custom question, or other input-owning overlay keeps the key instead of changing it.
- **Footer context** - An attached live stage chat shows its own current folder and Git branch and shows the live extension status lines that the stage's own session sets, such as the MCP server indicator, never the main chat's. Branch changes trigger a repaint through the host's cached footer provider. As in the main chat, the line with the stage's model, reasoning level, folder and branch shows only while the stage's agent is idle. While it works, the model line is hidden and the separate hint line lists its live keys, including the interrupt key. The compact `/tasks` sheet keeps the conversation visible; detail, transcript and input pages remain fullscreen.
- **Working indicator** - Stage chat shows `∀` during accepted prompt startup and active work, including retained-session follow-ups. Retry, fallback, compaction, cancellation, and errors take precedence. `NO_COLOR` removes foreground colors; `ATOMIC_REDUCED_MOTION=1` makes the indicator static.
- **Background progress** - The agent panel below the main prompt shows background subagents, shells and workflow runs. Close the graph to return to it; `/tasks` also lists the session's background work.
- **Run control** - Use `pause` and `resume` for resumable live work. Pause holds a stage's queued steering and follow-up items in place without dequeuing them or starting continuation; `resume` releases those items once in their existing per-queue order, but queue release alone does not start a model turn. `resume` on a non-paused run reopens the saved snapshot or overlay. Use `quit` to pause a live run gracefully while preserving it for a later resume. In a run's graph, `p` pauses the run, `r` continues paused, resumably blocked and recoverably failed runs (including an explicit failed exit with `resumable: true`), and `q` twice quits it. The workflow tool's `stageId` pauses or resumes one stage and also targets tool nodes.
- **Rediscovery** - Use `/reload` after adding, editing, installing, or removing workflow resources or package manifest workflow entries and you want Atomic to rediscover them in-process ([Reloading workflow resources](/workflows/operations#reloading-workflow-resources)).
- **Status listing** - `/workflows` and the workflow tool's `status` action list all retained active and terminal top-level runs; implementation-owned nested child runs are flattened into their parent workflow rather than listed separately.
- **Status times** - The workflow tool's run detail displays `started` and `ended` in the system local timezone as `HH:mm:ss`. If they differ from your expected clock, check the timezone of the machine or container running Atomic and any inherited `TZ` environment setting. Elapsed durations and raw timestamps in structured results are unchanged.

`/workflows` shows this session's workflow runs under the title **Workflows**. With exactly one run it opens that run's graph. Otherwise it lists the runs newest first. Each row names the workflow and what tells the run apart (its label, else its first text input, else its short id), then its state: `running · stage 3/5 implement · 12m · $1.84`, `needs input · <question>` with `◆`, or a failed run's `✗` and one-line reason. Stopped runs show `◼`.

Rows update while the list is open, keeping your search and selected run. Type to search, and press Space to preview the selected run. Enter on a run opens its graph, and `esc` at the graph's top comes back to the list. `esc` clears a typed search first; with an empty search it closes the list. With no runs it shows `No workflows in this session.` and the configured close key, `esc to close` by default; Enter does nothing. Without an interactive terminal it prints the run list. Ask the agent to list installed definitions. Runs from earlier sessions and runs interrupted by a restart resume from `/resume`.

At the supported 40-column terminal minimum, attached stage chats keep the `← return to graph` hint. The TUI may truncate provider/model context to make room, but it keeps that context separate from the hierarchy hint so the controls stay readable.

<p align="center"><img src="../images/workflow-graph.png" alt="Workflow Graph Viewer" width="600" /></p>

Human-in-the-loop prompts appear as awaiting-input nodes in the workflow graph, not as ordinary chat modals — see [Lifecycle Notices and Human Input](/workflows/operations#lifecycle-notices-and-human-input) for how to find and answer them.

### Skills in attached stage chats

Use `/skill:<selector> [arguments]` in an editable stage composer, including qualified selectors such as `/skill:review@project`. Completion reads that stage's own resource catalog and `enableSkillCommands` setting, with the same source tags as main chat. The next completion request reflects a stage resource reload. If the host cannot expose stage command metadata, it reports discovery as unavailable instead of substituting main-chat resources.

Suggestions use the terminal's default background, including selected rows; accent text and the selection arrow mark the current choice, matching main chat.

Enter starts an idle turn or steers a streaming turn; Ctrl+F preserves follow-up delivery. The command stays bound to the submitted stage even if you switch panes. Its session performs the existing expansion once, including the selected skill's location, candidate identity, base directory, and trimmed arguments. Relative skill references use the skill directory; tools retain the stage cwd and restrictions. Manually typed commands still work when suggestions are disabled. Unknown bare selectors pass through unchanged, while qualified-resolution and file-read errors appear in the attached chat.

Mounted HIL and custom prompts take precedence: a `/skill:` answer is literal prompt input. Blocked stages, read-only archives, and replay do not admit skill messages. Explicit editable [post-mortem chat](/workflows/operations#post-mortem-chat-vs-execution-resume) can use its own skills, but cannot revive a workflow node or change the completed DAG. Skill invocation grants no additional delegation or tool authority and does not forward unrelated commands to the parent chat.

`/tasks` opens the owner task list locally, never a skill or model message. Empty and populated lists use the same compact picker as main chat, without combining tasks from other chats. Enter or → opens the selected task's chat, and Space peeks at it in a card under the row. Enter on that card, with no reply typed, opens the task's detail page, whose actions offer retained transcript inspection, confirmed cancellation, and stdin when available. Terminal tasks omit live actions. Escape returns from a task's detail to the picker with selection preserved, then closes it; in a task's chat, `←` on an empty prompt goes back and Escape interrupts. A stage question arriving during inspection remains pending and is shown when you leave the inspector. Task navigation does not create a main-chat input-needed notice; genuine main-chat prompts waiting behind a visible graph still do.

`/tasks` is also suggested in the stage slash menu independently of `enableSkillCommands`. Its [background-task status](/background-tasks) appears below MCP status; the graph-return shortcut does not overwrite the task-inspection hint. Pausing a workflow stage cancels its active and admitted queued background agents and commands and waits for cleanup. Subagents stopped this way stay resumable: the stage agent can continue them with `subagent({ action: "resume", id })`, and resuming the run after Atomic restarts restores them with the stage. Only a stage that finishes, or whose run ends or is cancelled, ends its subagents for good. It blocks fresh launches immediately; already-in-flight command setup may briefly start during the transition but must drain and be cancelled before pause completes. Stage-scoped pause leaves main-chat tasks and sibling stages alone. Merely detaching the chat or ending a foreground turn does not cancel background work. Closing the stage generation still cancels remaining owned work.

If inspection fails, the host displays the error and keeps your input for retry. It does not send the command to the model.

`/tasks` is reserved for local task inspection; stage extensions cannot override it. `@` file mentions and Tab complete paths relative to the stage cwd.

## Monitor and Control Runs

The workflow tool exposes lifecycle controls for non-interactive use:

```ts
workflow({ action: "status" })                                  // list every session run, in-flight first
workflow({ action: "status", statusFilter: "running" })         // filter the run listing by status
workflow({ action: "status", statusFilter: "awaiting_input" })  // runs with a pending human prompt
workflow({ action: "status", statusFilter: "suspended" })       // runs with a stage suspended with its session released
workflow({ action: "status", format: "json" })                  // structured listing for programmatic use
workflow({ action: "status", runId: "<full-run-uuid>" })         // full detail for one run
workflow({ action: "status", runId: "<full-run-uuid>", summary: true })  // status, outputs and blockers only

workflow({ action: "stages", runId: "<full-run-uuid>", statusFilter: "all" })
workflow({ action: "stage", runId: "<full-run-uuid>", stageId: "review" })
// Prefer sessionFile/transcriptPath from stages/stage; quote the exact path, preserve Windows separators, then search/read small ranges.
workflow({ action: "transcript", runId: "<full-run-uuid>", stageId: "review" })
// Omit tail/limit for the default 5-entry preview; pass them for quick recent-context checks.
workflow({ action: "transcript", runId: "<full-run-uuid>", stageId: "review", tail: 40 })
workflow({ action: "transcript", runId: "<full-run-uuid>", stageId: "review", limit: 20, includeToolOutput: true })

// Free-form stage communication uses Intercom; prompt responses use workflow answer.
intercom({ action: "send", to: "<full-run-uuid>:review", message: "please focus on tests" })
workflow({ action: "answer", runId: "<full-run-uuid>", stageId: "approval", promptId: "prompt-1", response: true })
workflow({ action: "resume", runId: "<full-run-uuid>", stageId: "review", message: "continue with tests" })

workflow({ action: "pause", runId: "<full-run-uuid>" })
workflow({ action: "pause", runId: "<full-run-uuid>", stageId: "review" })
workflow({ action: "pause", all: true })

workflow({ action: "resume", runId: "<full-run-uuid>" })
workflow({ action: "resume", runId: "<full-run-uuid>", stageId: "review", message: "continue" })

workflow({ action: "quit", runId: "<full-run-uuid>" })
workflow({ action: "quit", all: true })

// Abort one in-flight ctx.tool node without pausing the run.
workflow({ action: "quit", runId: "<full-run-uuid>", stageId: "tool:<argsHash>" })
workflow({ action: "pause", runId: "<full-run-uuid>", stageId: "publish-artifact" })

workflow({ action: "reload", reason: "added team workflow" })
```

Control behavior:

- `runId` accepts the full UUID or a unique 8-character hexadecimal prefix for lifecycle and inspection actions, including `status`. Status lists and run pickers show top-level user-launched workflows; nested child runs remain part of the expanded parent graph.
- `status`, `stages`, `stage`, and `transcript` with a full `runId` use the session store, then read the journal if the run is absent locally. Inspection never claims ownership or executes workflow code. A running root with an expired lease appears as `crashed`; a live foreign lease remains protected.
- `status` without `runId` lists every top-level run in the session with a concise per-run summary: the full run id, workflow name, run status, started/ended timing with pause-adjusted elapsed time, currently active stages, awaiting-input details (count plus the stage, prompt id, kind, and message for each pending human prompt), and `suspendedCount`, the number of stages suspended with their session released (`suspendedStages` names them). In-flight runs are listed first. The summaries carry the exact identifiers that `answer`, `pause`, `resume`, and `quit` accept, so an orchestrating agent can list runs and act on them directly.
- `status` with a `runId` includes the run's final outputs as `detail.result`, also when another session started the run and Atomic reads it back from the journal. The detail lists every stage and can be large for a run with many stages. Add `summary: true` for a compact `summary` object instead of `detail`: `runId`, `name`, `status`, timing, `result`, `error`, `resumable`, `resumeGuidance`, and `blockers`. Each blocker names a failed or blocked stage or `ctx.tool` node, or a stage awaiting input (with its `promptId` and prompt text), and is empty for a run that completed, was cancelled, or was killed. The summary omits the stage and tool history; `summary` has no effect on the `status` listing without a `runId`.
- `statusFilter` narrows the `status` run listing: run statuses (`pending`, `running`, `paused`, `blocked`, `completed`, `failed`, `skipped`, `cancelled`, `killed`) match runs directly, `awaiting_input` selects runs with at least one stage awaiting input or pending human prompt, `suspended` selects runs with at least one stage suspended with its session released, and `all` (the default) includes everything. On `stages`, `suspended` selects stages that wait with their session released (see [Suspended stages](#suspended-stages)). `waiting`, the earlier name of `suspended`, is still accepted as a deprecated alias.
- `format: "json"` on data-bearing inspection actions (`status`, `stages`, `stage`, `transcript`) returns the full structured result; the default text output for `status` is the concise per-run summary list.
- `status` / `status <runId>` show terminal `ctx.exit(...)` statuses (`completed`, `skipped`, `cancelled`, or `blocked`) and the optional exit reason when one was supplied.
- `stages` lists stage summaries, including flattened stages from nested `ctx.workflow(...)` imports and `sessionFile`/`transcriptPath` when a stage has a persisted session. Use `statusFilter: "all"` to include completed, failed, skipped, and pending stages.
- `stage` returns details and the persisted `sessionFile` for an exact stage ID/name or a unique bare UUID prefix, including nested child stages in the expanded graph. Partial names do not resolve. Ambiguous names or UUID prefixes report collisions.
- Local and retained/durable `stages` listings use the same expanded graph as `stage` and `transcript`: pass the listed ID back unchanged with that listing's `runId`. Valid nested boundaries are replaced by their descendants; missing, empty, or invalid children retain an inspectable boundary summary. Detail/transcript results identify the actual owning run and local stage ID.
- Intercom's slash-separated `target` is a messaging address, not a `workflow` `stageId`. An Intercom stage row also includes its owning `runId` and local `stageId`; pass that pair to `stage` or `transcript`, or use the expanded ID from `workflow stages` with the root run ID.
- `transcript` returns the transcript path without inlining rows when a path exists. For a live stage, a path-only result or a zero-entry preview counts resident messages without reading saved entries. A nonempty preview counts the transcript rows, including any restored provider errors. Without a path, the default preview includes up to 5 recent entries. For targeted lookup, quote the exact `sessionFile`/`transcriptPath` value without changing platform separators (preserve Windows backslashes), search it with `rg` or `grep`, then read only small surrounding ranges. Text results include JSON-escaped `sessionFileJson`/`transcriptPathJson` lines for copy-safe path literals. Pass explicit `tail` or `limit` to request a preview; `tail` overrides `limit`; `includeToolOutput` includes captured snapshot tool output in snapshot transcript results.
- `answer` responds only to a pending primitive or structured human-input prompt. It accepts `promptId` plus `response`, `text`, or `message`, preserves prompt-kind validation, and never sends stage chat, steers, resumes, or starts a model turn.
- Send free-form updates through ordinary Intercom to `workflow:<rootRunId>/<segment>[/<segment>...]`; `*` matches one segment and `**` any depth. Use `intercom list` inside the invocation group to see live, pending, and possible future targets. Atomic delivers immediately to live stages and queues matching future stages, delivering them before their first model turn. `workflow:<rootRunId>/**` remains sticky for every future descendant until root termination; narrower name and pattern sends reach every future match. Valid paths outside the known set still queue, with no warning, and settle undeliverable at terminal only if never delivered. Use `ask` once the target has a reply-capable live session. Use the workflow tool's `resume` action only for paused workflow control. While an interrupted run waits to be resumed, the background subagents its stages launched are addressable as well: sends to them wait in the broker, not in the run's journal, and are delivered once after the resumed stage restores the subagent. If another session resumes the run, senders waiting for a subagent are told so and should send again there. If the run ends before the stage restores a subagent, the held sends return `Session not found`. A session keeps these targets for the 32 workflow invocations it finished most recently, so a message to a stage of one of them still gets that run's own answer. An older finished invocation's targets no longer resolve, and its stages are reached from `/workflows`. An invocation that runs again gets its targets back and counts from its latest finish; a refused resume does not change its place. Deleting the invocation from its journal removes its targets. If an older Intercom broker reports that it retires routes only when their connection closes, run `atomic intercom restart` before transferring a nested run to another host.
- `pause` and `quit` can target one top-level run or `all: true`; `stageId` cannot be combined with `all: true`. Stage-scoped `pause` controls can target a visible nested child stage from the expanded graph. Atomic routes stage controls to the owning nested run internally.
- `pause` and `quit` can also name one in-flight `ctx.tool` node with `stageId`, by expanded node id, local `tool:<argsHash>` id, or tool name. Both mean the same thing for a tool: abort that single call now. Tool nodes stay non-attachable — this is an abort control, not a chat target. Identifiers resolve exactly first and then uniquely; a name shared by two tool nodes (or by a stage and a tool) returns the same ambiguity diagnostic stages get, listing each match as `<name> (tool)`.
- Aborting one tool node leaves every sibling stage and sibling tool node running and does not pause the run. The node becomes `cancelled`, writes no replayable checkpoint, and re-runs on a later resume. Whether the run itself survives is ordinary author control flow: an awaited `ctx.tool` that is aborted rejects, exactly as it would for any other failure, unless the workflow catches it. A node that has already settled reports that it is not running rather than silently succeeding.
- If targeted cancellation escapes workflow code, the failed run records `failedToolNodeId`, not a fabricated `failedStageId`. Resume the run without a stage override to retry that unfinished tool and replay completed work. The tool remains a non-attachable `cancelled` tool node.
- Whole-run `quit` stays authoritative even if workflow code catches the tool rejection. A catch may run cleanup, but its returned outputs do not convert the quit into a completed run: the executor suspends and quit's paused/resumable record stands. To abort one call and intentionally keep the workflow going, target that node instead of quitting the run.
- A targeted tool abort reports the node outcome and the run separately: `status: "cancelled"` for the node it cancelled, `stageId` for that node, `abandoned` when the callback ignored its signal, and `workflowStatus` for the run status *observed* when the action returned. It never reports `paused`, and it never predicts what the run does next.
- `pause` preserves resumable live work. With no active stage/tool handle (including initialization and between-node waits), it keeps the same executor paused rather than quitting it. Run-level `resume` on that live process releases the barrier exactly once; later tracked steps, cached replay, and run completion wait for that explicit resume. An in-flight `ctx.tool` call cannot be held: run-level `pause` stops it as `quit` does, the run pauses resumably, the call is recorded `cancelled`, and resume runs it again. An already-started untracked JavaScript await or non-cancellable I/O may still finish; pause cannot physically freeze arbitrary author code or roll back effects. A stage declared during this pause defers registration until its asynchronous method runs after resume; synchronous session access requires resume first.
- A stage pause cancels that generation's owned task executions, not its queued messages or future workflow stages. User and Intercom messages remain held until resume; resume allows fresh tasks and never restarts cancelled commands. Subagents the pause stopped stay resumable with `subagent({ action: "resume", id })`, and a resume after Atomic restarts restores them. Cancellation and cleanup failures reject the pause rather than reporting a successful stop. The pause waits for the cleanup of the commands it cancels; cleanup a command quarantined before the pause, while its output was still held open after it finished, is confirmed when the stage closes.
- A whole-run executor-only pause also holds already-live owned child workflows, including children with no tracked node yet. Resume persists the root's running transition before releasing those child executors; a child-scoped control leaves sibling workflows alone.
- Live executor resume does not require a checkpoint. Cross-process resume still requires durable checkpoint or pending-prompt progress: losing a zero-progress live owner cannot reconstruct its JavaScript continuation. Cancelling the original startup request before acknowledgement remains terminal cancellation, not this live pause.
- `resume` can target a live paused stage with `stageId`; the target may be an exact stage id or an exact stage name. `message` is forwarded to paused work. Durable/cross-process resume is whole-run only and refuses a stage selector before dispatch rather than resuming the entire root. For a live interrupted streaming prompt, Atomic preserves the existing prompt loop without duplicating the user message and injects `Continue where you left off. If you believe you are finished with your original task (or a redefined task if the user told you), stop.` when required before normal readiness-gate completion. For a paused stage that was idle waiting for a new stage-chat turn, a non-empty message resumes the stage and starts exactly one fresh prompt containing that message; an empty resume releases the pause without creating a prompt.
- An explicit workflow-tool `resume` target absent locally triggers journal discovery. Prefixes require successful discovery before selecting a unique UUID; discovery failure cannot select a local prefix match. Malformed targets are rejected before lookup. Ordinary `status` listing remains session-local.
- Exact-id durable inspection is separate from resume. `status`, `stages`, `stage`, and `transcript` may hydrate one missing-local root for read-only inspection, but they never claim it or execute replay. Only an explicit `resume` action enters the claim-and-dispatch path.
- Run-level `quit` gracefully pauses in-flight work and preserves eligible checkpointed runs for a later resume. Runs waiting during initialization or between nodes are also controllable, even with no active stage or tool. An executor-only quit retires the owner (including one already paused); without usable durable progress it is nonresumable and offers no resume hint.
- Killing a run, or aborting the `signal` passed to `run()`, ends its stages still in flight, and those of its nested child runs, as `failed` with the error `workflow killed`, and cancels its running `ctx.tool` calls. A run cancelled by its parent's exit ends them as `skipped`. Status then lists no active stage for the run. Pause and quit leave stages resumable.
- `reload` refreshes discovered workflow resources in-process; the optional `reason` is echoed in the result.

Use `/workflows <run-id>` to open the interactive graph, then select a stage to open its chat. When a run needs user input or attention, tell the user instead of polling silently.

### Suspended stages

A stage whose model called a long-running tool that supports it (a CI wait, a deployment, a `bash` or `powershell` `wait` on a background task without `budgetMs`, or `ask_user_question`) does not keep its session while it waits. Once the call has run longer than the stage's `releaseWhenWaiting` threshold (60 seconds by default), Atomic saves the stage's conversation and its pending call, closes the session, and frees the stage's slot for other stages. `status` and `stages` show the stage as `suspended` and say what it waits on (`suspended (tool: wait_ci)` for the tool calls, `suspended (between turns)` after `stage.release()` or for a stage the workflow holds unused), and the JSON `stages` result carries its `wait`; a stage waiting for a human answer reads `awaiting_input (released)`. The workflow's card in the chat, expanded, marks a suspended stage with the dim `◌` waiting mark a [released subagent](/subagents#released-subagents) has, and a paused stage with `⏸`. In the stage's chat, the call it waits on shows as pending, not as interrupted, and shows its result once the stage reopens. A stage still released when its run ends leaves `suspended`; `statusFilter: "suspended"` lists the runs that have such a stage. When the results arrive, Atomic reopens the same session from the session store and the stage continues the same turn. Short calls, and tools that do not support it, run inline as before.

A stage waiting on its model's `ask_user_question` also stays `awaiting_input`; answer it in the stage's chat as usual. The same threshold releases a stage whose readiness question waits on you (the stage stays `awaiting_input` and reopens with your answer), and a finished stage the workflow keeps without using it, for example while it waits for a child workflow (the stage is `suspended` until it is messaged or rehydrated). See [`releaseWhenWaiting`](/workflows/api-reference#releasewhenwaiting).

Controls work on a suspended stage:

- Messages and steering to a stage waiting on a tool call are held, and reach the stage in order when it reopens. They are held in memory, so they are lost if Atomic stops before the stage wakes; Intercom sends wait in the run's queue and survive a restart. A message to a stage waiting between turns reopens it.
- `pause` holds the stage: results that arrive meanwhile wait until you resume it.
- Subagents the stage launched keep running, and keep their shells: they can still wait on, stop and start background shells, and get those shells' completion notices. The stage's own session launches nothing until it reopens.
- While a stage's conversation waits on a tool call's result, nothing starts a new turn on its session: a notification such as a finished subagent's, steering and follow-ups wait, and join the turn the result continues, and a compaction leaves the waiting call's turn in the conversation. If the conversation has moved past a waiting call anyway, for example because the model kept working, Atomic cancels that call and drops its late result instead of failing the stage: the stage keeps its own result, including a captured `structured_output`, and the run goes on. A result that arrives while the stage's session is still running waits for that run to settle first. A dropped call, and a stage prompt or retry that was not sent because the session waits on a result, are recorded in the [debug log](/development#debugging) as `stale-detached-call` and `stage-input-held-for-detached-results`.
- `quit`, or a crash of the Atomic process, stops the wait. Resuming the run reopens the stage and starts the pending tool call again with the same call id and arguments, then continues the turn; a call whose result was saved before the stop is not started again, and the turn continues from that result. It does not send the stage's prompt again, also for a stage that waited between turns. A tool call can therefore run more than once across a restart.
- If the session store the run resumes with does not hold a waiting stage's session, resume fails with `StageRehydrationError` (`session-not-found`) before changing anything, for a run that stopped with Atomic and for one that failed or is blocked alike. Resume with the session storage the run was started with; `atomic storage status` shows which one this process selects. On a machine that uses local-only storage and is not joined to shared storage, run `atomic team join <url> --token-file <path>` first (see [Team and CI setup](/guides/team-setup)); joining sets the team database but keeps sessions in a local store, so also select the session storage that holds the waiting stage's session. A child workflow, including one a worker pool runs, checks its own waiting stages when it starts again: a missing session fails the child with the same error before it does any work, and the pool does not retry it until the root is resumed, when the child checks again. The error's `rootRunId` names the run to resume; a worker pool keeps its children's sessions in a store that run's journal selects, so resume it with the journal storage it was started with, on the machine that ran a local pool.
- If the session store is unreachable when the results arrive, Atomic saves the results with the stage's wait and tries to reopen the session, and to save the results into it, three times over a few seconds. When the store is still unreachable, the live run shows `↑ blocked`, not failed, with `StageRehydrationError` (`session-unavailable`). Make the store reachable, then press `r` in the graph to request a resume. If the run can resume, the stage continues its turn from the saved results and the tool does not run again. This block does not send a chat notice.
- If the reopened session returns from the turn without saving the results, the stage fails with `StageRehydrationError` (`results-not-saved`) instead of completing, and the results stay saved with its wait. Resuming the run continues the turn from them.
- If Atomic cannot save a record of a stage's wait to the run's journal after three attempts, the stage carries on and the run logs the reason once; the stage's `waitRecordFailure` shows it (`StageWaitRecordError`, `wait-record-unavailable`). Until its next record is saved, a resume after a crash starts the stage from its previous record, which can run a finished tool call again.

To keep a stage resident for its whole wait, set `releaseWhenWaiting: false` on the stage or the run.

### Diagnosing a stage with an empty history

The run display shows stage execution durations without extra startup rows. To inspect startup diagnostics, use the workflow tool's `stage` / `stages` output. Live stages report `startup` with the current phase, total startup age, and seconds on the current step, for example `startup reload-active (45s total, 45s on current step; active)`. Phases are model resolution, route authority, resource preparation, queued/active resource reload, SDK creation, extension binding, attachment, delivery readiness, and first dispatch. Once the stage sends its first prompt, the line stops tracking steps and reads `startup complete (dispatched after 2s)`, with the seconds from stage start to dispatch; it does not change again while the stage runs or after it finishes, so it does not mean the stage is stuck. An allocated session ID is not proof of attachment; first dispatch is not proof of a provider response or reviewer approval.

Resource discovery allows up to four stage reloads at a time per Atomic process. `reload-queued` means the stage is waiting for a reload slot; `reload-active` means it has started loading resources. A slow active reload holds one slot, not the entire queue. This limit is separate from the workflow's stage concurrency setting.

Slow startup is not automatically killed. Pause and graceful quit retain their resumable hold semantics; resume may still join the same pending creation and does not reset its age. Repeated pause/resume is not a startup restart.

Explicit stage `abort()` or execution-owner cancellation rejects startup callers promptly. Cancelling a stage in `reload-queued` removes it from the queue immediately, and its reload never starts. A cancelled stage may still show `ownershipPending: true`: non-cancellable resource loading, SDK creation, or binding must finish before its owner can be released. An active reload keeps its slot until it settles. Do not retry in-process while cleanup remains pending. If the operation never settles, stop the owning Atomic process before starting fresh execution; reconcile external effects first. Fresh execution is not a resumed reviewer approval, and a zero-progress run may have no usable durable continuation.

### Pausing, quitting, and resuming

If a stage is waiting on `ask_user_question`, quitting the run with `workflow({ action: "quit", runId: "<run-id>" })` cancels and dismisses that question without requiring an answer. This includes the “Are you ready to move on to the next stage?” question and questions in nested stages. Quit leaves the run paused under the usual resume rules; it does not approve the question or advance downstream work. Questions belonging to other runs are unaffected. After resuming a cancelled readiness question, answer the new question; an old answer cannot restart the run.

If pause or quit reports a stage cancellation error, do not assume that stage stopped: check the run with the workflow tool's `status` action before retrying. A readiness answer already accepted by a stage whose stop failed can continue normally; it does not require resume unless the stage actually paused.

Graceful quit is idempotent for an already-paused resumable run. Pending durable questions remain associated with that run; answers cannot advance it until explicit resume.

Pause holds the live executor, while quit retires it at a durability boundary. Neither freezes arbitrary JavaScript or rolls back effects. Already-started non-cancellable I/O can finish later. A run quit before any durable progress may be nonresumable.

Quit stops admitting tool calls, cancels owned in-flight calls, and waits a bounded time for cleanup. The result lists `cancelledTools` and any `abandonedTools` with their owning `{runId, nodeId}`. An abandoned callback may still have external effects. Inspect those effects before resuming; unfinished callbacks run again, while completed checkpoints replay.

If the journal pause cannot be saved, the run remains locally paused. Preserve the run ID, restore storage access, and inspect status. Retrying quit can save the pause; resume retries the running transition before releasing the executor. Existing checkpoints remain available, but a failed write does not create durable progress.

Catching a tool cancellation cannot turn whole-run quit into completion. To abort one tool and continue the workflow, target the tool node instead.

When a paused stage interrupted an active model turn, Atomic preserves that turn's existing pause loop: a non-empty resume message is delivered exactly once through the resumed loop, and (if the stage has not finalized) Atomic injects `Continue where you left off. If you believe you are finished with your original task (or a redefined task if the user told you), stop.` before normal completion/readiness handling. A no-message interrupted-turn resume injects the same continuation directly. A different state applies when the stage was idle and waiting for a new stage-chat turn: resuming with a non-empty message starts exactly one fresh prompt containing the text, while an empty resume only releases the pause and does not fabricate a user turn or continuation.

The same continuation applies to user messages queued into a live streaming stage. Steering a turn (Enter in an attached stage chat) or queueing a follow-up (Ctrl+F) arms the identical continuation prompt, which Atomic injects once when the interrupted turn ends — even if several messages were queued during that turn — so a steered stage returns to its original (or user-redefined) objective instead of stopping after answering the queued message.

Messages delivered to an idle stage start a fresh user turn immediately and receive no continuation nudge; abort, kill, workflow exit, and finalized/fail-fast stage boundaries suppress late prompt creation and continuation injection.

Resuming a stage that was interrupted mid-session also restores the background subagents that stage launched. It replays the stage's interrupted Intercom messages before the stage continues, and both are visible in the stage transcript. Stages keep the same `workflow:<rootRunId>/...` Intercom targets after resume, and messages queued for them while they were down are delivered once. Opening a post-mortem chat on a completed stage does not restart its stopped subagents.

If Atomic stopped after a stage's model gave its final answer to the stage's prompt but before the stage was recorded as finished, resuming the run finishes that stage with the saved answer and sends the model nothing; the stage's result, and its `output` file, are that answer. A stage that stopped earlier in its turn gets a "continue" prompt instead, and so does a forked stage that stopped before its own prompt reached its conversation, a stage with a `schema`, or one whose last turn asked you a question, so its readiness question can still be asked. See [durable resume of a stage](/workflows/api-reference#releasewhenwaiting) for the exact cases.

Before you resume it, an interrupted run's stages stay reachable through Intercom: messages sent to them are queued and delivered once after resume. See [deferred delivery to pending stages](/intercom/reference#deferred-delivery-to-pending-stages).

Resuming several stages can make partial progress. Inspect status after an acknowledgement or persistence error: stages already running are not retried, and genuinely paused stages remain available for another resume. A later resume can retry a failed durable-state update. Terminal runs cannot be revived.

### Post-mortem chat vs. execution resume

These are distinct operations. *Resuming workflow execution* (`r` in the graph, `/resume`, or the workflow tool's `resume` action) is for paused, interrupted, recoverably failed, or unfinished durable work; it may replay checkpoints, continue an incomplete stage, and dispatch remaining DAG work. *Opening a post-mortem chat* reopens one terminal agent stage's retained conversation for follow-up only — it never resumes, retries, rewinds, or otherwise changes workflow execution.

If you resume a failed workflow while its stage chat is open, the pane follows the resumed stage. Your draft stays in the composer, and new messages go to the resumed stage in the same conversation. If a chat turn is still running on a stage the resume needs, Atomic names the stage and refuses the resume. Wait for that turn to finish or press Esc in its chat, then resume again.

Any eligible terminal agent stage with a valid retained session opens as an interactive post-mortem chat through the explicit user-driven TUI path: completed-workflow inspection, or `/workflows` followed by stage selection, including restored/replayed durable snapshots after a restart. A nested stage selected in the graph is resolved through the expanded graph and routed to the child run that owns the stage while the overlay remains rooted on the requested graph; the resolved owner is preserved when sibling child workflows reuse the same local stage ID.

Atomic disposes the live session of each completed stage whose conversation is saved, so a long run or a long-lived session does not hold every finished stage in memory. A stage run with `ctx.task`, `ctx.chain` or `ctx.parallel` is released as soon as it completes, a stage run with `ctx.stage` once the workflow no longer holds its stage context, and every remaining completed stage when the run ends, whether it completed, failed, or was cancelled. Resuming a failed run replays its completed stages from the saved run and does not need their live sessions. A stage context the workflow still holds keeps its session, so `ctx.stage` can prompt it again. This also applies after a resume: releasing the failed attempt's context does not close the resumed stage. Attaching to such a stage or messaging it reopens the saved conversation first, which takes a moment, without rerunning the workflow. While the session that ran the workflow is open, the released stage also stays in the Intercom session list under its previous name as `closed · reply: post-mortem only`: an ask to it reopens the saved conversation, runs one turn with the question, and returns that turn's final answer (or a failure if the conversation cannot be reopened), and a plain send is delivered to the session that ran the workflow. Once that session ends or is replaced, the Intercom entry is gone; reopen the stage from its graph with `/workflows`. A stage with a mounted chat (visible or hidden), queued or in-flight messages, an active turn, compaction or retry keeps its live session while that lasts, and is released as soon as the last of them ends. A stage you reopen by attaching, by messaging it, or with an Intercom ask is released the same way once its chat is closed and its turn has ended; the next attach, message or ask reopens it from its saved transcript, and it keeps its Intercom name. So memory holds only the stages you are actually using. A completed stage with no saved transcript keeps its live session until the session that ran the workflow is replaced or shut down. The saved transcript, result, and run record are never removed.

If you resume an SDK run with a different `stageControlRegistry`, you can clear the old registry without closing the resumed stage’s chat or cancelling its pending question. Inspecting a completed run keeps questions in an open stage chat answerable. Intercom asks to the same released stage are answered in order, and its listed ID remains usable after the reply.

Intercom and the stage chat opened from the graph own stage communication. The workflow tool has no free-form message action; start a new workflow if tracked work remains after a terminal root.

When a nested stage is reopened after a restart or from another checkout through the explicit TUI path, its session cwd comes from the durable root workflow (resolved workflow cwd first, then original invocation cwd) while stage-control ownership remains with the actual child run. Follow-up turns are appended in place to the stage's retained session (no separate fork), so the agent may still invoke its ordinary tools and cause side effects; only the workflow DAG, run/stage status, results, timings, checkpoints, and topology are immutable. Post-mortem chat does not resume or modify workflow execution state.

During a live post-mortem turn, Escape aborts only the retained conversation's active work and restores queued steering/follow-up text to the editor. The conversation queue remains held. Clearing or restoring every visible queued item does not release that hold. The next ordinary submission releases the conversation queue before starting a new turn. Neither action pauses, resumes, or changes the terminal workflow execution state.

Every host session replacement or shutdown invalidates post-mortem handles, including a session whose lazy reopen is still pending: if creation finishes after the boundary, Atomic disposes the newly created session and rejects the already-submitted prompt before it can execute. A stage stays a **read-only transcript** when it has no valid retained agent session — prompt/HIL and boundary/summary nodes, skipped nodes without a completed conversation, non-terminal handle-less stages (another process may still own the session), and missing/malformed/deleted session files.

When a known stage cannot be reopened, the attached chat shows the complete `SESSION UNAVAILABLE` explanation down to the supported 40-column minimum instead of incorrectly labeling an invalid file as an archived transcript. Recoverably failed stages keep their execution-resume semantics and are not silently reopened as post-mortem chat.

The target receives the original ask and replies with ordinary `intercom.reply`. Only its correlated reply satisfies the requester; another session cannot answer for it.

The target sees the original ask, and its normal `intercom.reply` remains correlated to the originating child session and message ID. The parent chat or another session cannot satisfy the waiter. Late-message routing uses single-owner claiming: after the workflow post-mortem router claims a completed-stage ask and assigns its completion promise, later listeners preserve that claim, making bundled extension registration order irrelevant.

This reopens only the conversation. The workflow DAG and terminal stage snapshot remain completed and are never resumed or re-dispatched. If the target run or stage was deleted, lacks a valid retained conversation, is non-resumable, or fails to reopen, the caller receives a bounded actionable `intercom.ask` tool error instead of waiting indefinitely.

Workflow stages and their subagent transcripts are excluded from ordinary `/resume`, `atomic -r`, `--continue`, and global history. Use workflow inspection and resume commands for stages. A stage's subagents continue through `subagent({ action: "resume", id })` from the stage that launched them; once that stage has finished, or its run has ended or been cancelled, all of them are terminal, including ones the stage paused or quit, and `resume` refuses them with an error that says their workflow stage ended (see [Run control](/subagents#run-control)). An explicit `--session` file path can still open a stage transcript. Older unmarked workflow sessions may remain in ordinary history.

Embedding hosts can run the same pause, quit, and resume actions programmatically with `session.workflows`; see [Workflow run control](/sdk#workflow-run-control).

## Workflow activity for extensions

Extensions can subscribe with `ctx.observeWorkflowActivity(observer)` and use the typed `workflow_lifecycle`, `workflow_activity_changed`, `workflow_stage_completed`, and `workflow_heartbeat` hooks. See [Workflow activity and lifecycle hooks](/extensions/events#workflow-activity-and-lifecycle-hooks) for the public types and subscription example.

The workflows extension publishes activity for its owning session, folding nested runs into full root summaries. Observation is silent and independent of `workflowNotifications.enabled`, `notifyOn`, and the user/agent attribution filters used by chat notices. It neither wakes the model nor adds graph nodes. The built-in [Herdr reporter](/herdr) is one consumer: it reports these root states, combined with agent and approval-prompt activity, to the owning Herdr pane (see its [setup guidance](/herdr#setup)).

| Runtime situation | Root activity |
| --- | --- |
| A stage or `ctx.tool` is executing | `working` |
| One branch waits for human input while another executes | `working`, with `needsAttention: true` |
| No stage executes, and at least one waits with its session released for a result it will continue with | `working / waiting`; a pending human prompt beside it adds `needsAttention: true` |
| Only human input can advance the workflow | `blocked / awaiting_input` |
| An active failure requires intervention, or a budget stop requires approval | `blocked / manual_intervention` |
| Paused with no execution draining | `idle / paused` |
| Quit or cancellation requested while work drains | `working / stopping`; independent sibling execution retains its own working reason |
| Execution completed or intentionally stopped | `idle` |
| A failed or blocked executor has ended without a pending prompt or budget approval | `idle / quiescent`, with `needsAttention: true`; the stored failure remains unchanged |

Registration delivers an ordered initial snapshot, followed by structurally changed root replacements and removals. Late attachment reconstructs current activity; historical `running` records alone are not evidence of live execution. Durable catalog/resume hydration publishes `recovering` before awaiting the backend and `ready` afterwards. `recovering` and `unavailable` are unknown source states, not empty ready snapshots: do not interpret them as idle.

Lifecycle targets identify runs, stages, tools, and prompts. Nested stage/tool ids use the expanded graph's `runId:nodeId` identity; `runId` still names the actual owning run and `rootRunId` names the aggregate. Control requests carry `action` and remain distinct from the status outcome. Prompt cancellation is not an answer. The completion convenience hook shares its event id with the corresponding successful stage lifecycle event and excludes failed/skipped stages. Only an explicit execution replay publishes `delivery: "replay"`; reading restored history never manufactures completion hooks. Heartbeats observe the existing configured scheduler cadence and do not prove execution.

## Lifecycle Notices and Human Input

Atomic emits deduplicated main-chat notices when top-level workflow runs complete, fail, end blocked, or stop at an active recoverable provider/auth/rate-limit block. A recoverable block remains resumable (`status` surfaces and headless results report it as blocked even though the stored live snapshot stays active), is retained durably as blocked for cross-session resume, appears in the resume picker, and its notice says the workflow **is blocked** rather than implying terminal completion. Each blocked occurrence is deduped by its `blockedAt` timestamp, so a resumed workflow that hits another recoverable block re-notifies the invoking chat. Nested child workflow outcomes are reflected inside the expanded parent graph instead of producing separate top-level cards.

Treat blocked runs as continuable by default: resume, answer a pending prompt, steer, or use a follow-up workflow. An explicit inline/no-workflow request overrides this default. Safely hold/stop the affected run, reconcile completed work and in-flight side effects, then continue inline without duplicate execution or claiming completed work was undone. Preserve safety, authorization and validation. See [execution-mode guidance](/workflows/verification#execution-mode). Resolve material ambiguity from objective and repository evidence. A `budget_exceeded` stop remains an authorization boundary: summarize progress and ask before raising the budget; do not evade the chosen limit by changing execution mode.

Lifecycle notices appear once in main chat without interrupting current streaming text, as one line that names the run and how it ended, such as `● Workflow "ralph" completed · 4.0s` or `✗ Workflow "ralph" failed · at review`. Press Ctrl+O (expand tool output) to show the notice's card with the run id, stage, error, outputs and the command to inspect it. Atomic also queues a model update so later responses can correct stale progress claims.

The `workflow` tool's own row reads like every other tool's: `Workflow(<name> · <what it was asked>)` for a run, and `workflow <action> <target>` for the other actions, with one result line under it. A run's line follows the run until it ends, for example `∀ Running · 1/3 stages · ↓ 22.4k tokens`, `! Waiting for input at review`, `✓ Completed in 4s · 3 stages · 32.4k tokens` or `✗ Failed at review · <reason>`. Ctrl+O expands the row to the run's inputs, its stages and their durations, and its outputs. Notices waiting for delivery survive recoverable delivery failures; session replacement does not send them to an unrelated chat.

An awaiting-input workflow remains visible in status and graph views without waking the main model. Open `/workflows <run-id>` and select the waiting node to answer its question.

A stage's `ask_user_question` and extension dialogs, including permission confirmations, belong to that stage's chat, not the main chat or a sibling stage. Text inputs, selections, confirmations and editors appear there with their prompt kind and can also be answered with the `workflow` tool's `answer` action. Use the current `promptId` to avoid answering a replaced or cancelled question. A subagent launched by a stage keeps its own questions in its own task view; open the stage's `/tasks` to answer them.

Resume of a recoverable block continues the same workflow ID and reuses completed checkpoints. It does not reroute, allocate a replacement instance or replay completed effects. Concurrent admission is refused while another executor or resume owns the instance. A fail-closed topology mismatch preserves the prior resumable snapshot and prompt answers for inspection and a corrected retry.

An unchanged blocked result or a non-resumable refusal is not progress. Inspect status under the same ID after resume. For provider/auth blocks, resolve the reported cause first: quota limits need recovery; expired or missing OAuth needs normal login; authentication preparation timeouts require checking the credential source. Then explicitly resume. Human-input waits and progressing model streams remain separate from authentication preparation deadlines.

Completed top-level `ctx.tool` nodes replay under the same ID. See [`ctx.tool` — durable cached tool execution](#ctx-tool-—-durable-cached-tool-execution). A fail-closed topology mismatch preserves the previous resumable state; retry only after restoring the matching contract.

Control notices report deliberate actions on a top-level run. Starting a run shows `● Workflow "<name>" started`, quitting it shows `◼ Workflow "<name>" was stopped`, and resuming it shows `● Workflow "<name>" resumed`. Each notice is one line; Ctrl+O shows its retained run details. These use the same steer delivery and capped-backoff retry as failure notices. The quit message tells the model that the stop was deliberate and user-requested, so it must not resume the run or take over the work unless asked. Use `/workflows <run-id>` for the current session’s run controls, or `/resume` for a run left by another session.

**Only attributed user actions notify.** The equivalent `workflow({ action: "run" | "pause" | "quit" | "resume" })` tool calls stay silent: the tool result already tells the agent what it just did. Pausing a run does not attribute an actor or raise a main-chat control notice. Engine-internal transitions are silent too — answering a human-in-the-loop prompt resumes the run internally without waking the model. Workflow activity and lifecycle observation report pause requests independently of chat notices.

**Two attributions.** *Origin* is who launched the run and renders on every kind as "which you started" or "which the user started"; it is set once at dispatch, persisted through session restore and durable resume, and inherited by a continuation from the run it continues. *Actor* is who performed this one event and renders as "The user resumed" or "You resumed". They differ routinely — the agent starts a run and the user quits it. A run with no recorded origin, including a restored snapshot, omits the clause entirely rather than guessing.

Each attributed request produces one notice. Whole-run resume reports the run; stage resume reports the stage when siblings remain paused. Quit does not also report its intermediate pause. Restored existing states stay silent, and nested children do not produce separate top-level notices.

Configure lifecycle behavior with `workflowNotifications.enabled` (default `true`) and `workflowNotifications.notifyOn` (default `["started", "completed", "failed", "blocked", "budget_warning", "awaiting_input", "paused", "quit", "resumed"]`). A config that pins `notifyOn` explicitly keeps exactly the kinds it lists, so `notifyOn: ["failed"]` suppresses every control notice. `budget_warning` is delivered once per run and dimension through the same lifecycle-notice renderer.

Heartbeats are separate from lifecycle notices. They report ongoing top-level runs at the definition's `heartbeatIntervalMinutes`, default `15`; `0` disables them. `workflowNotifications.notifyOn` does not filter heartbeats. Terminal runs stop them; an already-visible card remains historical rather than an instruction to continue ended work. See [heartbeat behavior](/workflows/api-reference#heartbeatintervalminutes).

Human input is runtime-only: call `ctx.ui.input`, `ctx.ui.confirm`, `ctx.ui.select`, `ctx.ui.editor`, or `ctx.ui.custom<T>` when the workflow needs a decision. No builder-level declaration is required or supported.

Human-in-the-loop prompts from `ctx.ui.input`, `ctx.ui.confirm`, `ctx.ui.select`, `ctx.ui.editor`, and `ctx.ui.custom<T>` appear as awaiting-input nodes in the workflow UI/graph viewer, not as ordinary chat modals. Workflow definitions do not declare HIL; runtime `ctx.ui.*` calls create prompt nodes. If the prompt lives inside an imported child workflow, it still appears in the same expanded parent graph so the user can focus and answer it without switching to a separate child status entry. When the attached stage has a pending prompt, its attribution banner is headed `AWAITING INPUT` and shows the full run id in a two-row identity block; the question and its options continue through the existing prompt UI below the banner.

When a run waits on exactly one known question, its agent panel row shows it. Answer in the graph opened with `/workflows <run-id>`, its attached stage chat, the run's `/tasks` peek card, or with `workflow answer`; the panel itself does not answer, restrict, or remove any of those paths.

Use `/workflows <run-id>` (or F2), then press Enter on the focused node or click a graph node to focus and open or attach it for local answers. Custom widget prompts mount inside the attached stage chat and must be completed interactively with the widget's `done(value)` callback.

When a workflow needs human input, answer in the graph viewer or attached stage chat when possible:

```text
/workflows <run-id>
```

Agents can answer primitive and structured pending prompts programmatically with `workflow({ action: "answer", ... })` only while the root workflow is nonterminal; use `promptId` when it is present in the stage details, and provide answer content with `response`, `text`, or `message`. Arbitrary custom TUI widget prompts intentionally refuse this path in iteration 1 because a generic `T` cannot be reconstructed safely from a non-TUI payload.

`ctx.ui.custom<T>(factory, options?)` reuses Atomic's TUI component path: the factory receives the same real `(tui, theme, keybindings, done)` types as extension `ctx.ui.custom`, and the workflow resumes with the value passed to `done(value)`. Use `options.label` for a safe display-only graph/status label and `options.replayIdentity` when widget semantics can change without the callsite changing. Do not put secrets in labels or replay identities; only a hash of the identity is stored, and label text is not part of replay identity. Both inline connected rendering and `overlay: true` mount in the graph viewer's attached stage chat: overlay is a placement hint rather than a capability request, so an in-stage `ask_user_question` — which always asks for an overlay — mounts, takes focus, and resolves like any other custom prompt. There is no nested host overlay above the graph chrome; the widget occupies the stage-chat custom-UI slot and `overlayOptions` / `onHandle` are not consumed there.

A stage's extension dialog has `PendingPrompt.source: "stage-dialog"` and the primitive `kind` `confirm`, `select`, `input` or `editor`. Its request is saved before the dialog is shown or an SDK host can approve it. Concurrent dialogs queue, and each has its own `promptId`. A dialog opened from a stage's custom component appears above that component immediately. Answer it to return to the same component without leaving the stage chat, or press Escape to cancel just the dialog. With no `promptId`, `workflow answer` answers that visible dialog rather than a questionnaire underneath it. Timed dialogs expose `PendingPrompt.expiresAt`, an absolute timestamp in milliseconds, and show the remaining time. Answering in the stage chat or with `workflow answer` dismisses any SDK dialog for the same request. SDK stage sessions without a live workflow record use their inherited `humanInput` host instead.

Stage-chat prompt answers can replay only while the source run remains in memory. `StageSnapshot.promptAnswerState` reports `available`, `unavailable`, or `ambiguous`; unavailable or ambiguous answers require a new prompt. The journal retains a stage dialog's prompt kind and waiting or settled state, but never its raw answer. Reopening saved history reports that answer as unavailable, and resuming unfinished work does not reuse an earlier permission. Durable `ctx.ui` answers have the separate checkpoint behavior described below.

Prompt replay keys include the prompt kind, message text, select choices, input/editor initial value, custom prompt identity hash, and hashed author callsite, so changing any of those inputs may intentionally re-ask on continuation. An empty `ctx.ui.select(..., [])` has no answerable choices and throws before creating a prompt node. Arbitrary custom-widget answers cannot be supplied through `workflow answer`; focus the `custom` awaiting-input node in the interactive graph instead.

If the user answers a human-in-the-loop prompt in the workflow UI or stage UI broker, the stage receives the answer directly and the active main chat receives a display-only notice (`triggerTurn: false`, `excludeFromContext: true`) containing a concise answer summary. The notice is rendered for the user and persisted for audit, but it does not wake the model, enter LLM context, or authorize answering any other workflow prompt. Prompt answers sent by the main-chat `workflow` tool are suppressed from this notice because the tool result already informs the current turn.

When an interactive, non-schema workflow stage calls `ask_user_question`, Atomic waits for the stage's assistant turn to finish and then brokers the deterministic readiness question **“Are you ready to move on to the next stage?”**. This includes typed or freeform questionnaire answers reported as `details.answers[].kind === "chat"`: the assistant first gives its normal conversational response, then the stage becomes `awaiting_input` with `inputRequest.kind: "readiness_gate"` in workflow status and graph surfaces.

In this chat-answer flow, choosing the ready option completes the stage and releases dependent stages. Choosing the not-ready option keeps the stage open for a genuine stage-chat turn and brokers readiness again after that turn. A chat answer is never treated as an invisible stay decision. On the readiness gate, **Type something.** sends the typed text as the next stage-chat message (empty or whitespace-only text cannot be submitted). **Chat about this** is a plain option — it does not open an inline editor — and stays by sending `The user would like to chat more about this`.

The readiness prompt can be answered in the attached stage UI or with `workflow({ action: "answer", ... })`. Ordinary structured-option answers retain their existing readiness behavior. A schema-backed stage that has successfully finalized through `structured_output` is terminal and does not reopen this readiness gate.

### Readiness after a steer

When you steer a stage that asked you a question — you type an answer into **Chat about this**, send the stage a message, or type an answer to the readiness question — the [decision model](/settings#decisionmodel) decides readiness after the stage replies, instead of always asking. It reads the stage's prompt, your message and the stage's reply, each truncated, and answers two questions: whether to `advance` or `stay`, and whether the reply fully addresses your message and leaves nothing you still need to answer. State that contains a credential is never sent. Only a message sent after the stage asked its question counts: picking one of the question's options asks the readiness question as before. If you send another message while the decision model is answering, its answer is discarded, and Atomic decides again once the stage has replied to your newer message.

| Decision | When | What happens |
| --- | --- | --- |
| Advance | P(advance) ≥ 0.85 and P(reply fully addresses your message) ≥ 0.8 | The stage completes without the readiness question, as if you had answered that you are ready. |
| Stay | P(stay) ≥ 0.7 | The stage stays open without asking, and waits for your next message. |
| Ask | Neither, or the decision model is unavailable, times out or fails | Atomic asks “Are you ready to move on to the next stage?” as before. |

Advancing cannot be undone, so it has the higher bar. The thresholds are exported from `@bastani/atomic/workflows` as `READINESS_DECISION_THRESHOLDS`. The decision needs probabilities, which only a classifier gives, so with a chat model as the decision model, or none configured, Atomic always asks and records no decision. The decision is bounded by [`httpIdleTimeoutMs`](/settings#http).

Each decision is recorded on the stage while the run is live in this session: a `ready` line under the stage in the workflow tool's run detail, `readinessDecision` in `workflow({ action: "stages" })` and `stage` output, with the outcome, the model and the probabilities, and a readiness notice in the stage's chat, for example `● Decision model advanced the stage (p=0.93, addressed p=0.91) · <decision model>`. When the question was asked because the decision failed, the record names the typed error's class and code, such as `DecisionTimeoutError` and `timeout`. A pause during the decision keeps your message and decides again after resume.

Turn it off with `workflows.autoAdvanceAfterSteer: false` in `settings.json`, or `/settings` → **Auto-advance after steer**. Stages that run on [local workers](/settings#local-worker-pools) always ask.

## Durable Workflows and Cross-Session Resume

Atomic workflows persist runs in a SQLite journal. It opens on the first workflow action and commits registrations, checkpoints, and control transitions before reporting them as durable. By default it is the [journal store](/storage#the-workflow-journal-store) in `~/.atomic/workflows/journal/`, which keeps each root on its own shard file so concurrent runs and their local workers do not share a write lock; you never need separate journals for performance. Set `ATOMIC_WORKFLOW_JOURNAL_PATH` before starting Atomic only to isolate runs in one file. Keep journal files on durable local storage. To share runs across machines, select a remote SQLite-compatible database through a [storage adapter](/storage#sharing-storage-across-hosts) rather than placing the file on a network filesystem. Storage failures stop the action rather than selecting another store.

Select process-local memory explicitly with `workflows.journal.memory: true` or SDK `RunOpts.journal: { memory: true }`. It supports checkpoint replay within the process but not recovery after exit. See [Choosing the durable backend](/workflows/api-reference#choosing-the-durable-backend).

### Storage failures and recovery

Preserve the journal and full run ID when storage fails. Check the reported file, directory permissions, available space, and filesystem health. Restore access, inspect the run with the workflow tool's `status` action, and explicitly resume an eligible run. Do not delete the journal to bypass an error. A failed pause leaves the local executor paused; resume retries the durable running transition before releasing it. If that write also fails, the executor stays paused and the error is reported.

If recovery reports `Workflow definition not found`, restore the matching definition, run `/reload`, and retry with the same full run ID. Changing a definition or its call order can invalidate checkpoint replay.

### Multiple sessions

A run with a live journal lease cannot be claimed by another executor, even when a long-running tool has not updated its progress. After a process crashes and its lease expires (about two minutes without renewal), inspection reports `crashed`. Concurrent resume attempts admit one executor. The same rules apply across machines that share a journal database; see [Sharing storage across hosts](/storage#sharing-storage-across-hosts).

SDK recovery requires the workflow journal, its snapshot blobs, the workflow definition, and the repository's required commits. `session.workflows.getRun(runId)` and `getStages(runId)` inspect saved state without taking ownership; `resume(runId)` explicitly claims eligible work. If the recorded worktree is missing or has drifted, Atomic restores it to a fresh worktree under the Atomic home and reports the new path; your existing checkout is not modified. A resume never fails because a checkout cannot be restored exactly: Atomic restores the best state it can reach, or continues without the checkout, and says so once in the run's notices and on a `checkout:` line of the workflow tool's run detail. The run's stages are told the same in their system prompt. Push the missing commits or restore the missing content, then resume again to get the exact state; see [Resuming](/worktree-snapshots#resuming). Save the full UUID. An owning session can also release checkpointed paused runs through `await session.dispose()` or a session switch, allowing another authorized session to adopt them. See [SDK run control](/sdk#workflow-run-control).

Snapshots respect Git ignores and `.atomic/snapshot-ignore`, the built-in deny list, and configured size limits. A tracked denied path keeps its `HEAD` version, not its working-copy change. No deny-listed bytes are captured unless they are already in a commit reachable from a remote-tracking ref. If unpushed history touches a denied path, Atomic omits its bundle; push the listed commits before restoring on another host. Ignored build outputs must be rebuilt. Restore verifies Git-stored content, not host-specific worktree encodings; conversion filters and unavailable LFS objects are reported as warnings.

Fencing prevents a displaced executor from saving new checkpoints, not from finishing arbitrary external effects already underway. Use idempotent effects and stable operation keys. Completed checkpoints replay; an unfinished callback may run again.

### How it works

- Only `ctx.*` work is checkpointed. Plain TypeScript outside those calls is not durable.
- Completed tool, stage, prompt, and child-workflow checkpoints replay without repeating completed work. Unfinished work may run again.
- Resume and inspection read the journal, not chat transcripts, as the recovery catalog.
- Unsupported or inconsistent saved topology is refused rather than repaired by guessing. Preserve the run ID and diagnostic.
- Independent roots persist independently; nested workflows share their root's ordering.

**Privacy and retention.** The journal contains workflow inputs, completed tool outputs, UI responses, stage outputs, message delivery receipts, and chat-session paths. Treat the file and its SQLite sidecar files as sensitive. History does not automatically delete runs by age or count. Worktree snapshot content that no resumable run or session needs is deleted in the background (see [Retention and collection](/worktree-snapshots#retention-and-collection)); the run records stay. Confirmed picker deletion removes inactive workflow records while preserving independent chat transcripts.

Sticky receipts suppress repeat delivery to the same recipient session, whether the message arrived as pre-start context or through live Intercom forwarding. This also holds after a failed stage retries or a cold resume. Repeated confirmations do not increase the delivery count. Delivery without an explicit recipient uses the stage's previous receipts; delivery to a new recipient session remains eligible.

**Resume after editing a workflow.** Changes to definitions, validated inputs, or `ctx.*` call order can invalidate replay. Finish or delete retained runs before incompatible changes. On mismatch, restore the matching definition rather than changing names or arguments to bypass a checkpoint.

Resume preserves graph identities, completed metadata, and pause-adjusted elapsed time. Completed children and durable tools/prompts replay; incomplete work continues. Stage-chat prompt answers remain live-memory-only. Use exact stage IDs when names collide.

### `ctx.tool` — durable cached tool execution

`ctx.tool(name, args, fn, options?)` runs arbitrary TypeScript as a durable graph node and caches its result. The node has no stage chat controls. Its graph card always says `durable tool`, shows status separately, and does not preview the result or error.

#### Inspecting a tool result

Focus a tool node and press Enter, click it, or select it from the switcher to open its read-only card. The card shows the tool name, a short argument summary, and the result or error.

The card starts collapsed, showing the last visual rows. Press `app.tools.expand`, normally Ctrl+O, to see the full bounded result and available callback source. Inspection never executes the callback or reads a source file.

The statusline shows the resolved key with `expand` or `collapse`, including remapped keys, alongside return and scroll hints. It omits that hint when expansion is unbound. Scroll with `↑`/`↓`, `PageUp`/`PageDown`, `Home`/`End`, the wheel, or the scrollbar. Escape returns to the graph; `←` does nothing in this detail. This view offers no chat attachment, steering, pause, or resume.

The footer shows `Took` or `Elapsed`; cached results are labelled. Truncation is marked with `… [truncated]`. Unrenderable values show placeholders rather than a complete result. Durable checkpoints retain the actual output.

#### Failures and replay

A throwing tool failure can fail the run even if the workflow body later returns. Use `failureMode: "return"` when failure is expected data for a repair step. Status retains the selected failed tool's identity and original error; later cancellation does not rewrite it as success.

Set `failureMode: "return"` when a failed check is expected data for a later repair stage. Atomic runs all configured retries first, then returns a `WorkflowToolOutcome<TValue>`. A successful callback returns `{ ok: true, value, attempts, cached }`. An exhausted callback failure returns `{ ok: false, error, attempts, cached }`; `error` preserves integer `exitCode` and string or byte-buffer `stdout`/`stderr` when the thrown value exposes them. The live and restored tool node stays `failed`, while the workflow body may continue and complete. On replay, Atomic returns the same stored outcome with `cached: true` and does not run the callback again.

On resume, completed top-level `ctx.tool` nodes retain their graph identity and cached outcomes, including concurrent `Promise.all` fan-out. A `failureMode: "return"` checkpoint, success or `return_failure`, is reused rather than running the callback again. All continuation attempts use the same run identity and checkpoint history.

Resume must match the retained workflow/checkpoint contract; do not change tool names or arguments to replay completed side effects. Inspection-only throwing records are not success checkpoints, so unfinished calls may execute again. Topology mismatches fail closed before unmatched live work is admitted; retained prompt answers and the prior resumable snapshot remain available for a corrected retry. An effect without a saved checkpoint is not guaranteed exactly once.

Recoverable output is explicit data flow. Atomic does not add a failed tool outcome to a later stage prompt. The workflow author must place the needed fields in `prompt`, `previous`, an output, or an artifact. Each persisted error text field is best-effort secret-redacted with the workflow persistence rules and limited to 16 KiB of UTF-8; truncated fields keep the final bytes with a marker. Keep the database sensitive even with this filter.

Cancellation, closed tool admission, and durable-storage faults still throw. They never become ordinary `{ ok: false }` callback outcomes. Omitting `failureMode: "return"` also keeps the existing behavior: an exhausted callback error rejects `ctx.tool` and fails the workflow unless author code catches it. Atomic persists that failed node and the root's selected tool link for later inspection, but excludes the failure record from the replay cache, so a resume or rerun calls the function again. Command failures that expose `exitCode`, `stdout`, or `stderr` remain failures even when a wrapper also uses cancellation-like text or codes; only a real run cancellation that wins the terminal race produces a killed/cancelled root.

Forward the callback's `{ signal }` to external work. Run cancellation stops every owned tool; a node-targeted pause or quit stops only that node. With `timeoutMs`, each attempt gets a fresh deadline; expiry counts as an attempt failure, not operator cancellation.

A cancelled tool is `cancelled`, not cached failure data, even in return mode. Resume may execute it again. A late result after cancellation does not become a successful checkpoint. Keep tool names, arguments, and call order compatible with the retained run.

Do not retain `ctx.tool` for detached work after the workflow ends. Calls after closure reject without starting their callback.

```ts
export default workflow({
  name: "data-pipeline",
  inputs: { source: Type.String() },
  run: async (ctx) => {
    // This side effect is cached durably. On resume, it will NOT re-execute.
    // Forwarding `signal` lets a quit or targeted abort stop a hung fetch instead of
    // pinning the run until the request gives up on its own.
    const data = await ctx.tool(
      "fetch-dataset",
      { source: ctx.inputs.source },
      async ({ signal }) => {
        const res = await fetch(ctx.inputs.source, { signal });
        return await res.text();
      },
      { retriesAllowed: true, maxAttempts: 3, timeoutMs: 45 * 60_000 },
    );

    // Subsequent stages use the cached result.
    const analysis = await ctx.task("analyze", { prompt: `Analyze: ${data}` });
    return { summary: analysis.text };
  },
});
```

A bounded repair loop can pass only the needed failure evidence and use distinct arguments for each real rerun:

```ts
for (let iteration = 1; iteration <= 2; iteration += 1) {
  const tests = await ctx.tool(
    "run-tests",
    { iteration },
    async () => runCommand(["bun", "test"]),
    { failureMode: "return", retriesAllowed: true, maxAttempts: 2, timeoutMs: 10 * 60_000 },
  );

  if (tests.ok) break;
  await ctx.task("repair-tests", {
    prompt: `Fix these test failures:\n${tests.error.stderr ?? tests.error.message}`,
  });
}
```

Changing `iteration` makes each loop pass a distinct durable call. Reusing the same call position and arguments during resume replays its stored outcome instead of running it again.

### Resuming runs from earlier sessions

`/resume` lists resumable workflow runs under **Workflow runs**, next to your sessions, newest first. It includes runs left by an earlier session and runs interrupted by a restart; runs whose process still holds them are left out, and a run whose process stopped without ending it shows as `crashed`. A selected run is checked again before it resumes or opens. See [Resuming and Deleting Sessions](/sessions#resuming-and-deleting-sessions) for the picker's keys.

Each run is a two-line row. The first line is the workflow name and what the run is about: its label, or else a one-line objective or prompt input, or else the workflow's description. If none is available, it shows the workflow name alone. The second line shows the run's state, its stage progress and current stage, its age, elapsed time, cost and branch when known, how many answers it waits on, a short failure reason, and the run's generated progress summary when one exists. Search matches the name, label, summary, state and full run id.

Progress summaries are generated in the background at workflow heartbeat intervals and once when a run finishes or becomes blocked. The latest saved summary remains available without the original session; it may lag behind current progress. If generation is unavailable, the row shows only its status details. Set `sessionSummary.enabled` to `false` to disable summary generation and resume-context messages.

Resuming through `/resume`, `/resume <id>`, or the workflow tool adds the saved summary to the main chat as model-visible context, including the run ID, workflow name, status, and summarized-through timestamp. This does not start an extra model turn. Repeating resume for the same live attachment does not duplicate the message; runs without a summary add no message.

If resume reports a checkpoint decoding error or an unavailable serializer, retain the full run ID and original diagnostic when reporting the problem. Do not delete saved progress or launch a fresh copy just to bypass the error: that can repeat completed side effects.

Only runs with usable durable checkpoints or pending prompts can resume. Deleted durable entries and missing artifacts are not offered. The workflow tool's `status` action still exposes eligible terminal runs for inspection.

Only valid current-format journal records are selectable. Unsupported or malformed records are not reinterpreted.

You can resume a failed run by ID as soon as the failure appears. If its previous attempt is still saving in this session, resume waits for that save before retrying; you do not need to start a new run.

Selecting a paused, resumable failed, blocked, or crash-recovery target from the current project re-dispatches the workflow with its cached inputs and the **original workflow id**. Every nested invocation validates and reuses its durable boundary and child identity before dispatch. Previously completed `ctx.tool`, `ctx.ui`, stage/task/chain/parallel items, and child boundaries replay from checkpoints instead of executing again; only incomplete work continues.

Workflow resume is project-scoped. Resuming a run from another project in `/resume` asks: `Workflow run found in different project: <cwd>. Fork it into the current directory?` Choosing Yes forks the whole run into the current directory with the same mechanism as a stage fork: a new run ID copies saved checkpoints and stage conversation history in one step and continues incomplete work there. Completed side effects replay from their saved results; the source run remains unchanged. Choosing No cancels without creating a run. The workflow definition must remain available in the current or original project. SDK, workflow-tool, and headless resume calls do not prompt: use the workflow tool's `fork` action or `forkRun` instead, or reopen the original project to resume the original run.

The fork inherits the source run's label and saved progress summary. When summaries are enabled and a saved summary exists, the main chat receives it before the fork resumes, identified by the new run ID and `forked from <source run id>`. Declining the fork adds no summary context.

A run quit while a `ctx.tool` call was in flight resumes the same way: the unfinished call left no replayable checkpoint, so resume re-executes exactly that callback at the same ordinal and `tool:<argsHash>` node id, while every completed tool — including a sibling that finished before the quit — replays from cache. A cancelled node never replays a cancellation as a value.

Selecting a completed target—or a checkpointed failed target marked non-resumable—follows a separate read-only open path. Atomic reconstructs root and reciprocal nested child-run snapshots from authoritative checkpoints, remaps persisted source-stage, boundary, and tool references into a stable expanded hierarchy, and never calls the resume dispatcher or runs workflow code, tools, tasks, or prompts. These graphs remain inspectable even when no retained chat transcript survives, including tool-only graphs.

A terminal child stage with a valid retained session may be reopened for detached post-mortem conversation through its graph or completed graph inspection. Follow-up is routed to that real child `{runId, stageId}` and may append chat, but it cannot pause, resume, retry, mutate root or child execution state, write a terminal checkpoint, or emit a duplicate lifecycle notice. Tool nodes never offer chat attachment.

Older compatible tool checkpoints still replay their cached output without rerunning callbacks. Unsupported or malformed formats are refused; do not edit records to force recovery.

Fresh completed inspection does not currently persist the workflow's declared root output. Live `run()` results still expose the declared output, and this output-persistence limit does not block durable tool topology or read-only graph inspection.

Targets resolve across top-level live and stored runs using full UUIDs or unique 8-hex prefixes. A stored run that cannot resume is not a missing run. Exact loadable paused live targets retain direct in-session precedence. Interactive `/resume <prefix>` also checks chat sessions. If the prefix matches more than one entry, it lists the matching IDs and starts nothing, even when only one run can resume. Use its full ID to select it. If the run changes after it is listed, the picker asks you to refresh. Reopen `/resume` and select the current attempt; the old selection will not retry a newer failure or block. A root appearing in both resumable and read-only history remains resumable. Nested child runs remain excluded from this top-level resume namespace.

The non-interactive `workflow` surface reads the journal for explicit IDs. `resume` loads the definition, revalidates eligibility, then claims and dispatches the run. `status`, `stages`, `stage`, and `transcript` read a missing-local root without dispatching it. `status` without a run ID remains session-local.

Targets other than full UUIDs or 8-hex prefixes are rejected before catalog lookup. Durable read-only prefix inspection includes actively running roots owned by other sessions, without claiming or resuming them. Once resolved, subsequent stage and transcript inspection uses the canonical root UUID, even when a nested child shares its prefix. Completed or failed roots with valid checkpoints remain inspectable when retained conversations are unavailable; invalid transcript paths are stripped while the graph remains visible.

Validation uses the final retained transcript for a repeated stage replay key, so an obsolete superseded checkpoint path does not hide an otherwise valid read-only graph. Reopening inspection refreshes a changed authoritative retained-chat handle. Session-cache-only rows are hidden because the backend is authoritative. Checkpointed non-resumable failed roots appear only in read-only history; cancelled, killed, blocked non-resumable, failed roots without saved progress, and other terminal non-success states are never added. Normal `/resume`, `atomic -r`, and `--continue` behavior for internal workflow stage sessions is unchanged.

### Forking a run from a stage

`f` in a stage's detail creates a new run in the current directory from a saved run, from any project, and starts it in the background. The workflow tool's `fork` action does the same, and can fork the whole run.

The source run is never changed, so you can fork the same run several times. A fork from a stage replays every completed `ctx.tool` call, prompt answer and stage that finished before that stage, then runs the stage and everything after it again. Prompts asked at or after the stage are asked again. The tool action names a stage inside a nested workflow with a dot path, such as `implement-api.review-2`, and also accepts replacement `inputs` and `carryMessages: "all"` to keep Intercom messages and prompt answers recorded after the stage.

A fork checks everything before it writes anything. When a check fails, nothing is created (a write that fails on a shared journal is the one exception, below) and the command reports a typed error with what to do next:

- An unknown stage lists up to 10 stages you can fork from.
- A run that is executing, being resumed or being forked is busy; pause or quit it (or wait), then fork again.
- A workflow definition that is missing, renamed, or no longer accepts the run's inputs is reported as a definition mismatch; pass replacement inputs or restore the definition.
- A run that is not in this node's journal is reported with the journal it searched; when that journal is local-only, the error says so and names the command that joins shared storage.
- On a shared journal, a rejected write of the fork is not proof that nothing was written: the reply can be lost while the commit lands. If reading the fork back confirms it, the fork goes on. If it cannot be confirmed, the copied sessions are kept and the error names the fork run: once the journal is reachable, inspect that exact run with the workflow tool's `status` action and resume it if it exists. Do not fork the source again before that check.

The workflow tool's run detail shows `forkedFrom` with the source run ID and stage. See [`forkRun`](/workflows/api-reference#forkrun-runid-options) for the SDK equivalent and the full error reference.

### Recovering an uncaught tool abort

After `workflow({ action: "pause", runId, stageId: "tool:<argsHash>" })`, inspect the run. If the author did not catch cancellation, its terminal status is `failed`, its selected frontier is `failedToolNodeId`, and the tool node is `cancelled`. Resume the run with `r` in its graph or with `workflow({ action: "resume", runId: "<full-run-uuid>" })` **without `stageId`**. Completed model and tool checkpoints replay without invoking their callbacks; only the unfinished tool and subsequent work execute. This does not roll back external work a cancelled callback performed before abort, so verify that retrying that unfinished operation is safe.

Recovery requires saved checkpoints proving one unfinished tool and its completed predecessors. When the failed tool ran in parallel (for example inside `Promise.all`), siblings that were cancelled because the run failed, or that threw in the same batch, are run again on resume and may be called before the failed tool. Any other tool reached before the failed tool is rejected before its callback runs, and the failed tool is not run either, so the run stays resumable once the original flow is restored. Missing, ambiguous, corrupt, or cyclic state fails with `insufficient_state`. Chat text and status snapshots cannot substitute for checkpoints. Preserve the original diagnostic and run ID when reporting a failure.

A tool-frontier continuation must reach and consume the exact unfinished tool before reporting `completed`, whether the body returns normally or calls `ctx.exit({ status: "completed" })`. Omitting the call, including by changing control flow, fails with `insufficient_state: replay topology mismatch` and the pending tool's exact ID. A substituted tool is rejected before its callback runs. While that frontier is pending, completed model and child-workflow predecessors can replay, but new model stages, tasks, and child workflows cannot execute in its place. Stage and task worktree setup also waits for live admission. Replaying completed predecessors alone is not proof of completion. Failed replay publishes no successful result; inspect the same ID and restore the matching flow before another supported resume. Quit, kill, caught targeted cancellation, and intentional non-completed exits retain their existing behavior.

After upgrading Atomic itself or applying a code fix, start a new Atomic process; `/reload` refreshes definitions, not loaded code.

If saved state cannot prove safe replay, reconcile the original run and external effects before choosing recovery. Do not restart the original workflow from the beginning to bypass the error. A separately authorized recovery-only workflow may perform verified remaining operations, but must not repeat completed side effects or fabricate checkpoints.

That history does not authorize any live release action.

### Cancellation, failure, and retry semantics

| Scenario | Behavior |
| --- | --- |
| **Internally cancelled workflow** | Marked `cancelled` in durable state and excluded from resume discovery in `/resume`. Start a new workflow run if you intentionally want to retry cancelled work. |
| **Stage failure (recoverable)** | Workflow marked `failed` or `blocked` and remains resumable by default. Resuming it continues from the last completed checkpoint unless durable metadata explicitly sets `resumable: false`. |
| **Stage failure (non-recoverable)** | Workflow marked `failed` or `blocked` with `resumable: false`, so it cannot resume execution. A failed root with saved checkpoint progress may still appear in read-only history for inspection; a blocked root does not. |
| **Process crash** | Workflow remains `running` in durable state. Exact-id status/inspection reconstructs its retained checkpoint DAG as `crashed` once the owner heartbeat is stale and shows whether resume is available. At startup, `resumeInFlight` controls recovery of eligible runs originally invoked in the current working directory. Resume runs left untouched from `/resume`. |
| **`ctx.tool` retry/default failure** | When `retriesAllowed: true`, the tool function is retried with exponential backoff. Cancellation is checked before each attempt, during retry backoff, and through the callback's own `signal`. Without `failureMode: "return"`, an exhausted callback error propagates and the workflow fails. |
| **Recoverable `ctx.tool` failure** | With `failureMode: "return"`, exhausted callback failures are durably returned after retries. The tool node remains failed, downstream handoff is explicit, and replay returns the same outcome with `cached: true`. Cancellation and storage faults still throw. |
| **`ctx.tool` node quit/pause** | `quit`/`pause` with a tool node id or name aborts that call's signal, marks the node `cancelled`, and leaves sibling stages and tools running. The action returns `status: "cancelled"` with the separately observed `workflowStatus`; it never reports the run as paused. No replayable `tool:` checkpoint and no `return_failure` outcome are written — return mode writes only inspection metadata — so resume re-runs exactly that call at the same ordinal and node id. |
| **Run quit with in-flight tools** | Stops new tool calls, cancels owned calls, and waits a bounded time for cleanup before recording pause. Completed checkpoints remain reusable. Catching cancellation cannot turn quit into completion. |
| **Abandoned `ctx.tool` callback** | Quit reports callbacks that ignored cancellation by `{runId, nodeId}`. They may still cause external effects but cannot save a late checkpoint. Reconcile effects before same-ID resume retries unfinished work. |
| **`ctx.ui` pending prompt** | If a UI prompt was not answered before interruption, resume leaves off on that prompt — the user must answer it to continue. |

### Configuring journal storage

Set `workflows.journal.path` in `settings.json` or set `ATOMIC_WORKFLOW_JOURNAL_PATH` before starting Atomic to select a local SQLite file. The non-empty environment value overrides settings; SDK `RunOpts.journal` and `createAgentSession({ journal })` override both. Relative settings paths resolve against the [storage home](/storage#storage-home) (`~/.atomic` by default, `<agentDir>` when `ATOMIC_CODING_AGENT_DIR` is customized, or `<parent>` when adopted). With no override, Atomic uses the journal store in `workflows/journal/` under the storage home (`~/.atomic/workflows/journal/` by default); adopt files you selected before with `atomic storage adopt <path>`. To use a remote database, select an [adapter module](/storage#selecting-an-adapter) in `workflows.journal` or shared `storage`. To select the journal for one process without editing settings, use `ATOMIC_WORKFLOWS_JOURNAL`, `ATOMIC_STORAGE`, or `--storage`; see [Selecting storage per process](/storage#selecting-storage-per-process).

For process-local storage, use `workflows.journal.memory: true` without a non-empty settings path, or pass `journal: { memory: true }` to SDK `run()`. Memory is never selected after a storage failure. Preserve a SQLite journal and its sidecar files; use the same journal and working directory to resume an existing run. See [Workflow storage settings](/settings#workflow-storage).

Pending-stage Intercom cleanup checks durable ownership only for runs with messages that need settlement. Repeated failures with the same message produce one warning per extension instance. Interactive hosts receive a display-only notification, never a console stack trace, even if notification delivery fails; headless hosts retain a console diagnostic. Pending messages are not discarded when cleanup fails.

Fresh-process resume and inspection read authoritative checkpoints from the journal. Unsupported records are not treated as successful cached work. Keep the original diagnostic and run ID if decoding fails.

## Workflow Locations

Atomic discovers workflow definitions in this order:

| Location | Scope | Notes |
|----------|-------|-------|
| `.atomic/extensions/workflow/config.json` | Project | `workflows.<name>.path`; project entries override global entries |
| `.atomic/workflows/*.{ts,js,mjs,cjs}` | Project | Current project workflow directory |
| `~/.atomic/agent/extensions/workflow/config.json` | Global | `workflows.<name>.path` for user-wide configured paths |
| `~/.atomic/agent/workflows/*.{ts,js,mjs,cjs}` | Global | Current user workflow directory (when `ATOMIC_CODING_AGENT_DIR` co-locates Atomic's store in `<agentDir>/workflows`, top-level `journal/`, `pool/`, and `runs/` are skipped) |
| Installed Atomic packages | Package | Uses package metadata or conventional `workflows/` directories |
| Bundled workflows | Built-in | Shipped with `@bastani/atomic/workflows` |

Workflow configuration and discovery use only the current `.atomic` roots by default. `ATOMIC_CODING_AGENT_DIR` overrides the user agent directory. Import workflow APIs from `@bastani/atomic/workflows` and schemas from `typebox`.

A workflow module may export one default workflow definition and/or named workflow definitions. Discovery checks the default export first, then named exports.

Discovery validates every runtime export of a discovered workflow file as a workflow definition. Discovery rejects a named export that is not a workflow definition — a widget factory, shared constant, or utility function — with an `INVALID_DEFINITION` discovery diagnostic (`export is not an object`), even when the module also has a valid default export (the valid workflow still loads; the diagnostic flags the extra export as skipped). TypeScript erases type-only exports (`export type` / `export interface`) at runtime, so discovery never flags them.

To co-locate reusable helpers with your workflows — for example a `ctx.ui.custom<T>` widget factory you want to import in tests without running the workflow — put them in a subdirectory and import them from the workflow file. Discovery scans only the top level of each workflow directory, so subdirectories such as `.atomic/workflows/lib/` are never treated as workflow modules:

```text
.atomic/workflows/
  release-picker.ts      # only runtime export: workflow({...})
  lib/
    table-selector.ts    # widget factory + helpers; not scanned by discovery
```

```ts
// .atomic/workflows/release-picker.ts
import { workflow } from "@bastani/atomic/workflows";
import { Type } from "typebox";
import { tableSelectorFactory } from "./lib/table-selector.js";
```

```ts
// .atomic/workflows/lib/table-selector.ts
import type { WorkflowCustomUiFactory } from "@bastani/atomic/workflows";

export const tableSelectorFactory: WorkflowCustomUiFactory<{ id: string; name: string }> = (
  tui,
  theme,
  _keybindings,
  done,
) => ({
  render: (width) => ["..."],
  invalidate: () => {},
  handleInput: (data) => {
    if (data === "enter") {
      /* ... done({ id, name }) ... */
      return true;
    }
    return false;
  },
});
```

Atomic loads workflow files with [jiti](https://github.com/unjs/jiti), so TypeScript works without compilation.

## Reloading workflow resources

Run `/reload` after adding, editing, renaming, or deleting workflow modules or changing workflow config. Reload rescans project and user conventional directories, legacy `.pi` locations, configured file/directory paths, and package resources without restarting Atomic. The workflow tool's `reload` action uses the same in-process path.

Reload is safe while workflows run: existing runs keep their starting definitions and controls, and new launches use the refreshed registry. A fatal refresh failure retains the previous registry. Top-level `/reload` also replaces extensions but preserves live runs in the same process. After a process exit, `resumeInFlight` controls startup recovery of eligible interrupted runs; use explicit resume for runs left untouched.

`/new`, `/fork`, and `/resume` are different: they leave the current session, so they quit running workflows. When any are running, Atomic asks first ("Quit N running workflows and start a new session?"). Confirming quits each run immediately at its last checkpoint; declining, or a confirmation prompt that fails, cancels the command and the runs keep going. Without an interactive UI (RPC, or an extension that switches sessions), the switch proceeds and the runs are quit the same way. Resume a quit run later from `/resume`. The new session also lists the runs it inherited, and its model can resume them through the `workflow` tool, which makes the new session their owner. `/reload` keeps runs executing and releases nothing.

The workflow tool reads that same live registry. Project, user, package-provided, and built-in workflow definitions therefore appear immediately after reload; restarting Atomic is not required.

A successful rescan may still contain per-resource diagnostics. Both reload surfaces show `CONFIG_INVALID`, `IMPORT_FAILED`, `INVALID_DEFINITION`, `PATH_NOT_FOUND`, and duplicate-name diagnostics instead of reporting bare success while silently skipping a resource. Valid sibling workflows remain available. Fix the reported source/path and reload again; no process restart is required.

## Run budgets

Set an optional `budget` on workflow extension config or an authored definition. Direct workflow `run` calls use the registered workflow's declared budget and an optional user-provided `budget` override. Approved `resume` calls may supply `budget`. Each field resolves independently: run override, then definition, then config default. Omission inherits; `0` disables only its dimension.

Budgets are operator-selected. Never invent a cap or convert an estimate into one. Pass only the fields and values the user requested. Raising an exhausted budget requires approval.

```ts
export default workflow({
  name: "bounded-review",
  description: "Review a change within an operator-selected budget.",
  budget: { maxDurationMs: 900_000, maxTokens: 50_000, maxCost: 5, warnAtPercent: 80 },
  outputs: {},
  run: async (ctx) => {
    // ...
    return {};
  },
});
```

`maxDurationMs` and `maxTokens` must be non-negative finite integers. `maxCost` and `warnAtPercent` must be non-negative finite numbers. Invalid config produces `CONFIG_INVALID`; invalid authored or direct-run declarations throw a `TypeError` before the workflow body runs. Nested `ctx.workflow(child)` calls use the child's own declared budget and remain subject to the root run's duration scope; a root exhaustion wins simultaneous child exhaustion, while a child-only exhaustion soft-lands that child run and returns to the parent.

### What each limit counts

- `maxDurationMs` measures elapsed run time, excluding pauses and carrying prior elapsed time across resume. It is checked at stage and durable-tool boundaries and immediately after a completed `ctx.task` saves its result checkpoint.
- `maxTokens` counts uncached input plus output tokens across the complete run tree, including nested children and stage retries. Cache reads and writes remain separate reported counters.
- `maxCost` charges the summed `usage.cost`.

Child budgets meter only their subtree; the root meter also includes child spend. Child-only exhaustion returns a blocked child result to the parent, which can continue.

### Warnings and exhausted budgets

A `budget_warning` notice is emitted once per run and dimension at `warnAtPercent`, default `80`. Token and cost budgets are checked after every model call, including the calls of a stage's subagents and compaction: once a call reaches the cap, the stage starts no further model call in its turn, and the tool calls it asked for are answered as cancelled. On exhaustion, an already-live frontier stage gets one current-turn wrap-up. Atomic then records a resumable `budget_exceeded` block with its reading, ceiling, frontier, wrap-up summary, and `wrapUpUsage` when model usage is available.

Atomic never creates a stage just for wrap-up. If no stage turn is live at the boundary, the run stops without a wrap-up summary and leaves its once-per-run delivery allowance unused.

Resume carries prior duration, token, and cost spend without charging replayed completions again. After approval, pass a raised resume budget to continue with that prior spend.

### Exhaustion after a task checkpoint

If the duration ceiling is exhausted after a task saves its result, the root becomes a resumable `budget_exceeded` block, not raw `running` with no active or control node.

For `ctx.parallel(..., { failFast: false })`, the outcome depends on the tasks at that boundary:

- If every authored task reaches it after saving a complete result, Atomic waits for settlement and selects the earliest authored exhausted task as the resume frontier. A raised-budget resume replays those results without rerunning models, then continues after the parallel barrier.
- If any task was still pending at exhaustion or had an ordinary failure, the existing aggregate-failure behavior wins.

Pause and quit remain available while task results are being saved. A later resume reuses completed task results, including text, structured values, artifacts, warnings, and model metadata. Inspect status if persistence or control fails rather than assuming the run stopped or completed.

## Workflow Configuration

Configured workflow paths live in workflow extension config. Project config paths are relative to the project root. Global config paths are relative to `~/.atomic/agent`.

Project config:

```text
.atomic/extensions/workflow/config.json
```

Global config:

```text
~/.atomic/agent/extensions/workflow/config.json
```

Example config:

```json
{
  "workflows": {
    "team": { "path": "./workflows/team.ts" },
    "shared": { "path": "/shared/team/workflows" }
  },
  "defaultConcurrency": 1000,
  "maxDepth": 3,
  "budget": { "maxDurationMs": 0, "maxTokens": 0, "maxCost": 0, "warnAtPercent": 80 },
  "persistRuns": true,
  "statusFile": false,
  "resumeInFlight": "never",
  "workflowNotifications": {
    "enabled": true,
    "notifyOn": ["started", "completed", "failed", "blocked", "budget_warning", "awaiting_input", "paused", "quit", "resumed"]
  },
  "worktree": {
    "symlinkDirectories": ["node_modules"]
  }
}
```

Runtime config defaults:

| Key | Default | Purpose |
|-----|---------|---------|
| `defaultConcurrency` | `1000` | Default stage concurrency and concurrency for authored `ctx.parallel(...)` execution |
| `maxDepth` | `3` | Maximum workflow nesting depth |
| `budget` | `{ maxDurationMs: 0, maxTokens: 0, maxCost: 0, warnAtPercent: 80 }` | Default per-run budget declaration; `0` disables a dimension; warnings default to `80` percent |
| `persistRuns` | `true` | Persist run metadata for status/resume/history |
| `statusFile` | `false` | Write a derived status file; defaults under `.atomic/workflows/status.json` when enabled |
| `resumeInFlight` | `"never"` | At process startup, `"never"` leaves interrupted durable workflows for a manual resume from `/resume`, `"ask"` requests confirmation, and `"auto"` resumes them |
| `workflowNotifications.enabled` | `true` | Emit workflow lifecycle notices into the active main chat |
| `workflowNotifications.notifyOn` | `["started", "completed", "failed", "blocked", "budget_warning", "awaiting_input", "paused", "quit", "resumed"]` | Lifecycle states to track; terminal `completed`/`failed`/`blocked` outcomes, active recoverable blocks, duration budget warnings, and attributed user `started`/`quit`/`resumed` actions on a top-level run create main-chat notices. `pause` does not attribute an actor; `awaiting_input` is tracked for dedupe/restore without waking the main agent. |
| `worktree.symlinkDirectories` | `["node_modules"]` | Main-root directories symlinked into each runner-managed temporary worktree during post-creation setup |

Startup recovery uses the durable catalog, not session transcripts. Only interrupted, checkpointed workflows still marked `running` without pending human prompts and originally invoked in the current working directory are eligible. Runs from other projects sharing the database, or older runs without a recorded invocation directory, remain untouched and available to resume from `/resume`. Fresh-heartbeat live owners, paused or quit runs, failed or blocked runs, and runs awaiting input are not restarted automatically. `"ask"` leaves runs untouched when no confirmation UI is available or you decline. Manual resume from `/resume` or the workflow tool remains available in every mode. Session switches and `/reload` do not trigger startup recovery. Workflow resources must be enabled and available at startup. If project trust or missing resources prevent recovery, enable them and resume the run from `/resume`. If recovery fails, Atomic reports a warning; resume the run from `/resume` to retry.

Recovered agent-owned workflows belong to the recovering session, so its agent can inspect and control them. Adoption requires the same working directory and confirmation that the previous owner has stopped. Atomic will not take ownership from a live or unverified owner or override another session's recovery.

After accepting startup recovery, inspect the original run ID with the workflow tool's `status` action to confirm its next stages progress. If an older version failed with `This extension ctx is stale`, upgrade, restart Atomic, and resume the same run ID rather than launch a duplicate workflow.

Invalid JSON or invalid shapes produce `CONFIG_INVALID` diagnostics. Missing config files are ignored.

## Local workflow workers

Local workers are opt-in. With no `localWorkers` setting or `RunOpts.localWorkers` option, Atomic does not create pool tables, worker processes, or worker polling loops. Enable a pool only for wide fan-out where running child workflows in separate processes is useful.

```json
{
  "workflows": {
    "localWorkers": {
      "count": 4,
      "definitions": [
        { "path": "./workflows/research.ts", "exportName": "research" }
      ]
    },
    "admission": {
      "limits": { "session": 4, "process": 8 },
      "host": { "maxLoadPerCpu": 2, "minFreeMemoryBytes": 2147483648 }
    }
  }
}
```

The root workflow remains in its original process and owns the run graph, run controls and the root's journal writes. It can be an inline closure. The pool adds one coordinator process per root, and the worker processes run under it: the coordinator handles worker messages and heartbeats, pool journal writes, and the Intercom routes of pooled children, so a busy pool does not slow down the interactive TUI. Only an entire first-level `ctx.workflow(child)` subtree can move to a local worker. Nested workflows stay on that worker. Independent stage placement is not supported. Register every worker-eligible child definition by its module path and export name. The worker loads the module again in its own process, so the definition must be importable rather than a closure. Missing or incompatible definitions fail the run; Atomic does not fall back to local execution.

Worker definitions are loaded in the SDK with `loadWorkerWorkflow(absolutePath, exportName)`, then passed to `ctx.workflow(...)`. The SDK also accepts `RunOpts.localWorkers`; the settings form applies to CLI launches. Paths in worker settings resolve against the invocation working directory. `RunOpts.localWorkers` paths resolve against `cwd` (or the current working directory when omitted). On resume, Atomic checks the saved worker options and definition entry-module digests. A changed pool size (`count`) or root limits (`admission.limits`, `admission.host`) are applied, and the root records them. A definition added or removed, or any other changed setting, is refused, and the error names each change. An edited entry module needs your confirmation, described next. The digest covers the entry file, not its imported dependency graph: after editing a helper module, a resume replays completed steps from the journal and runs new work with the current code.

To resume after editing a definition's entry module, accept the edit. `/resume` and `/resume <id>` ask `Workflow definition changed since this run started · enter resume with the new definition · esc cancel`; Enter accepts it and Esc leaves the run as it was. In the SDK, pass `acceptEntryChanges: true` in `RunOpts` or `runtime.resumeDurableWorkflow`; without it, the SDK refuses the resume and the error names each change. Completed steps still replay from the journal, and the root's unfinished children run the edited module, including children queued before the crash that no worker had started. Whether the edited module still replays what a child recorded is up to you: a child whose replayed calls no longer match its recorded ones fails, as any replay mismatch does. A resume may also run under another execution mode than the launch, for example a headless resume of a run launched in the terminal UI; unfinished children then run under the resume's mode.

Pools work with any journal the worker processes can open by the same selection: the default local SQLite file, a SQLite file with a custom prefix, or a remote database through a [storage adapter](/storage#selecting-an-adapter) such as libSQL or Turso. Select it with `workflows.journal`, shared `storage`, `ATOMIC_WORKFLOWS_JOURNAL` or `--storage`, or `RunOpts.journal` with a `path` or an adapter. A memory journal, and a journal passed to the SDK as an object, cannot host workers. The workers run on the root's machine, unless the root uses [shared placement](#workers-on-other-hosts). When the journal is not the default local file and shared placement is off, the pool keeps its work queue, leases, admission state, pooled stage transcripts and worker logs in a SQLite file under `workflows/pool/` in the [storage home](/storage#storage-home) (`~/.atomic/workflows/pool/` by default, or `<agentDir>/workflows/pool/` when `ATOMIC_CODING_AGENT_DIR` is customized), while the run's checkpoints stay in the journal. Resume such a root on the machine where it ran, with the journal selected as it was: resuming it on another machine fails with an error naming the original machine, because that machine's pool database holds the queue and leases of its children, and changing the adapter, its options, its prefix or the agent directory selects another pool database and fails with an error naming both. Changing only where a credential is read from, such as the environment variable that holds the token, does not. One limit remains: if a worker is declared lost in the instant its stage takes a queued Intercom message, that message can be recorded as delivered and not offered again to the replacement worker's stage. On the default local SQLite journal this cannot happen. Start a new run to opt in; an existing unpooled run cannot change placement on resume. If new global worker settings prevent an older run from resuming, disable those settings for that resume.

The supported placement is multiple local processes on Linux or macOS. Windows and any host without native process identity and boot identity refuse activation with an error. This is a containment requirement: lease expiry does not prove that an old process stopped. To run workers on other machines as well, see [Workers on other hosts](#workers-on-other-hosts).

The root's existing status, stage list, steering, pause, quit, and resume controls still address one root. A run paused this way can be resumed from `/resume` in a new Atomic process, for example after an upgrade, once the process that paused it has exited; children that an earlier process failed because of a fault of the pool itself run again. Pausing the run pauses the stages on local workers even while the root's own steps run; on a busy machine some workers can take a few seconds to confirm, and the pause reports how many stages have not confirmed yet. They pause on their own, so pausing again is not needed. A worker failure can replay an unfinished child from its last committed checkpoint. This is at-least-once recovery. An external effect that happens before its checkpoint can happen again; use stable logical idempotency keys for effects that must not duplicate.

### Watching stages on local workers

A stage that runs on a local worker opens from the workflow graph like any other stage. While its session is still starting on the worker (loading resources, creating the session), the stage reads as `queued` with what it is doing, such as `creating session 32s`, on its graph node, in the stage list, the workflow tool's `status` and its stage list, and its chat says it is starting on its local worker. The chat streams the stage as soon as its session starts; messages you send meanwhile are delivered then. While it runs, its chat shows the transcript so far and the reply as it streams, with tool calls. The chat header reads `on local worker`. Enter steers the running turn and Ctrl+F queues a follow-up, as for any stage. `/skill:` commands complete with the stage's own skills, `/compact` compacts the stage's session, and a `!` command runs in the stage's working directory on its worker. `/tasks` and the task footer list the stage's agents and shells on its worker; you can view their output and transcripts, send input and stop them there. Queued messages show on the stage's graph node (`✉ N queued`) even when its chat is closed. Pausing one stage with the workflow tool's `stageId`, and the stage chat's pause and resume, hold and release just that stage; other stages, including ones on other workers, keep running, and the paused stage keeps its worker. While the whole pool is paused, a single stage cannot be paused or resumed on its own; resume the run first.

If the worker running an open stage dies or loses its lease, the chat header shows `RECONNECTING` until the stage runs again on a replacement worker. The chat then reloads from the replacement's transcript and sends again, once each, in the order and the mode you sent them (a steer still steers the running turn, a follow-up still waits for it), the messages the replacement does not have, such as messages that were still queued. The header then shows how many were redelivered. Messages you sent stay queued for the stage even if you close its chat before they arrive, and they are delivered when the stage runs again. If the stage or its run ends first, the header shows how many messages were not delivered.

A child on a local worker can ask for input. A `ctx.ui` prompt (`input`, `confirm`, `select`, `editor`) shows on its stage like any workflow prompt: answer it in the stage chat or with the workflow tool's `answer` action, and the answer goes to the worker. A question a stage asks with `ask_user_question` shows the same form in its stage chat as for any stage; answer it there or with the workflow tool's `answer` action. A `ctx.ui.custom` prompt cannot be shown outside the worker that raised it: in a child on a local worker it fails the child with an error saying so. Use `input`, `confirm`, `select` or `editor` there, or run that child in process. If the worker dies while a `ctx.ui` prompt waits for its answer, the prompt shows again once the replacement worker reaches it; answer that one. Prompts answered before the worker died are not asked again. An `ask_user_question` form still waiting when the worker died shows again in the stage chat once the replacement worker resumes the stage, and your answer goes to the stage as that question's answer. A stage chat you keep open meanwhile shows the question the replacement asks, so you can answer there without reopening the stage. An answer you give after the worker died but before the replacement asks again is kept and given to that same question, so you are not asked twice. If the replacement asks a different question at that point (for example, one whose text depends on data), that question replaces the old one, an open stage chat shows it, and the kept answer is dropped.

Only the stages you have open stream to the root process. A pool with many workers sends nothing extra for stages nobody is watching.

When the stage finishes, close the chat and open the stage again to continue in post-mortem chat. A finished stage that ran on a local worker reopens for post-mortem chat in the same session and after a restart.

### Worker startup and failures

Each worker process must report that it is ready within `localWorkers.startupTimeoutMs` milliseconds. By default the deadline is 30000 ms, scaled up when the pool has more workers than the machine has CPU cores or the machine is already busy: it is 30000 ms times (worker count + 1-minute load average) ÷ CPU cores, at least 30000 ms and at most 600000 ms. When a pool starts, it runs children as soon as one worker is ready. A worker that exits or times out during that startup is left out of the pool, and the run fails only when no worker starts. A replacement worker that cannot start fails the run. `startupTimeoutMs` is not saved with the root, so you can change it before resuming. If a run fails with `WorkerStartupTimeoutError` (code `worker_startup_failed`, message `Local worker startup failed: worker not ready after … ms`), the machine could not start the workers in time; set `workflows.localWorkers.startupTimeoutMs` (or `localWorkers.startupTimeoutMs` in the SDK) to a higher value, or use fewer workers.

A worker that exits is detected immediately, and its child is replayed from its last committed checkpoint on a replacement worker. A worker that is still running keeps its child as long as it keeps responding, even when the pool is briefly too busy to process its heartbeats. Only a running worker that has not responded for `localWorkers.leaseMs` milliseconds (30000 by default) is stopped and its child replayed. When a root is resumed after its process crashed, children that were held by the crashed process's workers are replayed on the new workers right away.

A worker that exits or is killed while it runs a child does not stop the root. The root fences that worker's attempt and replays the child from its last committed checkpoint on a replacement worker, up to three attempts per child. A child that loses its third worker fails alone with `worker_retry_limit`; the pool and the root's other children keep running. One child's failure never stops the pool: it fails only that child, and the pool closes when the root ends. A child whose result was recorded keeps it whatever happens to the pool afterwards. A journal the worker briefly cannot reach does not end its child: a heartbeat that fails because the database is unreachable keeps the child running while its lease (`localWorkers.leaseMs`) lasts, and the next heartbeat that gets through renews it. An idle worker waits out the outage instead of exiting. A fault of the pool itself that reaches a running child, such as a checkpoint write the database refused, an outage longer than the lease, or a refused lease (`stale_work_lease`), replays the child the same way instead of failing it; after its third attempt the child fails with the retryable `worker_retry_limit`, naming the fault. A busy machine slows workers but does not fail them: a worker that still responds keeps its child however late its heartbeats are processed, and a stage's queued Intercom messages are delivered however slowly the worker acknowledges them. A stage on a worker reads its queued and sticky Intercom messages itself and receives them before its first turn, so it starts without waiting for a busy root. If the root later fails to record or deliver them, the run's status shows one `Intercom delivery:` line for the whole run; the messages stay queued and arrive live or on the stage's next drain.

When the pool cannot confirm a worker's cleanup, the worker is retired and replaced, and its unfinished child replays on another worker. This happens when a tool process group the worker started is still running after SIGKILL, or the worker process itself outlives SIGKILL. The event shows as a warning on the root run and is written to the worker's log. It never fails a child. The process permits of those groups stay quarantined: they stay counted against `admission.limits`, and closing the pool reports them. A tool process that waits for capacity which only quarantined permits hold waits at most 15 seconds for those groups to exit. It then fails with the retryable `worker_cleanup_unconfirmed`, naming the groups and the limit, and on a worker that ends the child's attempt, so the child replays within its three attempts and then fails with `worker_retry_limit` instead of waiting forever. Capacity held by running work is waited for however long it takes. Processes that a command detaches into their own session, such as an `ssh` ControlMaster daemon, are not part of the worker's cleanup and do not delay it.

If the root process exits, even when it is killed, the pool's coordinator and workers exit with it. Resume the root to continue its children. If the coordinator process itself dies, its workers exit with it, and each pooled child the root is waiting on fails with a retryable `WorkerLostError` (code `worker_lost`, `phase: "coordinator"`). The coordinator writes its standard error to `coordinator.log` in the root's log directory, and the error names that file in `logPath`.

Each worker writes its standard error to `worker-logs/<root run ID>/<worker ID>.log` in the directory that holds the workflow journal. With the default journal store, that is `workflows/journal/worker-logs/` under the [storage home](/storage#storage-home) (`~/.atomic/workflows/journal/worker-logs/` by default); with an explicit journal file, the directory of that file. With a journal in another database, the logs are in `workflows/pool/worker-logs/` under the [storage home](/storage#storage-home) (`~/.atomic/workflows/pool/worker-logs/` by default). Characters in the root run ID that are unsafe in a file name are percent-encoded. `WorkerStartupError`, `WorkerStartupTimeoutError`, and `WorkerRetryLimitError` name the worker's log in `logPath`; read the log for the worker's output. If Atomic cannot write a log, the worker keeps running without it, the error's `logFailure` holds the error code (such as `EACCES`), and the run shows one warning. Atomic keeps the logs of workers that fail, of workers whose cleanup it could not confirm, and of every worker of a pool that failed. It deletes the logs of the other workers still running, and the coordinator's log, when the pool shuts down normally.

### Worker resource limits

`admission.limits` caps concurrent agent sessions and managed tool processes for one root. A session permit covers creation through disposal, including fallback and delegated sessions. A process permit remains held until the Atomic-managed process is confirmed stopped; yielding an observation wait does not release it. Processes launched outside Atomic's managed tools are not counted. The worker count is a placement limit, separate from these resource caps.

`admission.host` adds launch gates for load per CPU and free memory. These measurements are advisory; they are not operating-system resource ceilings. `minFreeMemoryBytes` holds new sessions and tool processes in every worker while the machine's free memory is below it; it does not shrink a worker that grew after its sessions started.

A child whose live stages all wait released, on a tool call's result or on your answer, gives up its place among `localWorkers.count`, so the next child can run meanwhile: the pool starts another worker for it, at most `count` more in all, while the waiting child stays on its worker. At most `count` children run at once. When a waiting child's result or answer arrives, it takes a place back before it opens a session or starts a tool process; while every place is taken it waits, and it goes before any child that has not started yet. Once a worker is idle and enough of the other workers are ready to keep `count`, the pool ends it. These extra workers never count as worker failures. A waiting child keeps the memory of its worker meanwhile, so a pool can hold `count` workers plus one per waiting child; `admission.limits` still caps sessions and tool processes across all of them. A worker host started with `startWorkflowWorkerHost()` starts no extra workers: its `maxWorkers` stays the most it runs, and its waiting children keep their workers.

A worker serves one child after another, and keeps in memory only what the child it runs needs: its own checkpoints, read from the journal when it claims the child, and its own stages. What it held for a finished child is let go of before it runs the next one. As a backstop, `localWorkers.maxWorkerRssBytes` replaces a worker whose resident memory has grown past that many bytes with a fresh worker once its current child ends; a running child is never interrupted, and these replacements never count as worker failures. A pool's memory is then about `localWorkers.count` times the larger of that limit and one child's working set.

Without any `admission` setting, pooled stages still start one at a time, at most one every 5 seconds, while the machine's load per CPU is above `localWorkers.maxLoadPerCpu` (default `3`). See [Local worker pools](/settings#local-worker-pools).

`admission.userLimits` applies the selected session or process limit across runs that use a single canonical local SQLite journal path. Select that file (`workflows.journal.path` or `RunOpts.journal`) and set `userDatabase` to the same path: the default [journal store](/storage#the-workflow-journal-store) keeps each root on its own shard, so a run with `userLimits` on it is refused with a `WorkflowAdmissionConfigError` before it is placed in the journal. For pooled roots on a journal in another database, the limit counts across the pooled roots on this machine that use that journal; omit `userDatabase`. A conflicting journal selection or unsupported storage fails the same way instead of claiming a cross-run limit that cannot be enforced. This is local-user coordination, not a multi-tenant security boundary. Include the admission option on participating non-pooled SDK runs if they should share the user-wide limit.

Pooled SDK runs reject process-bound adapter, UI, persistence and similar runtime overrides before launch. CLI-owned host bindings remain local to the root; workers construct their own stage sessions.

### Workers on other hosts

A root can let workers on other machines run its pooled children when every machine opens the same shared journal, such as a libSQL or Turso database selected through the [libSQL adapter](/storage#selecting-an-adapter). This is opt-in and changes nothing for roots that do not use it. The default local SQLite journal keeps its workers on its own machine.

From the SDK, start the root with `workers: { placement: "shared" }` beside `localWorkers`:

```ts
await run(root, {}, {
  cwd: process.cwd(),
  journal: { adapter: "@bastani/atomic-storage-libsql", options: { url: "libsql://pool.example.com" }, secrets: { authToken: { file: "turso-token" } } },
  localWorkers: { count: 2, definitions: [{ path: `${process.cwd()}/workflows/research.ts`, exportName: "research" }] },
  workers: { placement: "shared" },
  admission: { limits: { session: 8 } },
});
```

Then start a worker host on each other machine with `atomic worker start`, or from code with the same journal selection:

```ts
import { startWorkflowWorkerHost } from "@bastani/atomic/workflows";

const host = await startWorkflowWorkerHost({
  journal: { adapter: "@bastani/atomic-storage-libsql", options: { url: "libsql://pool.example.com" }, secrets: { authToken: { file: "turso-token" } } },
  maxWorkers: 4,
  labels: { zone: "east" },
});
// host.stats(), then host.drain() to finish running children, or host.stop() to stop now.
```

`startWorkflowWorkerHost` also takes `idleExitMs`, which drains and stops the host once none of its workers ran a child for that long, and `onEvent`, which receives `claimed` and `released` as its workers take and let go of children, `degraded` and `recovered` while its polls of the journal fail and once they succeed again, and `idle-exit`. Without `journal`, it opens the journal this machine selects for workflow runs. `host.closed` settles once the host has stopped, whichever way it stopped. `readWorkflowWorkerFleet({ journal })` returns the registered hosts and the pool stats of each running root, as `atomic worker status` prints them.

A host that cannot reach the journal keeps its running children. It polls again after 1 second, then twice as long after each further failure, up to 30 seconds, and `host.stats().degraded` says how many polls failed in a row and why.

Worker hosts run on Linux or macOS, like local workers: on Windows, or where Atomic's native process identity does not load, `startWorkflowWorkerHost` fails with `SharedPoolSetupError` (code `process-containment-unavailable`) before it opens the journal.

A worker host serves every running root on that journal that uses shared placement, up to `maxWorkers` workers in total, split evenly between the roots it serves. When another root starts, roots holding more than their share finish the children their workers hold and then give up the extra workers. When the host has no workers left, a root whose workers have sat idle for a few seconds gives them to a waiting root that has ready work, so a host with one worker still serves a later root. A paused root keeps its host's workers, paused with it. It runs a root's children only if it has the root's worker definitions at the same absolute module paths with the same entry module. Children run in the root's recorded working directory, so each host needs that directory too, unless the root binds its children to a workspace (below). The pool's work queue, leases, admission state and pooled stage transcripts all live in the shared journal, under the journal's prefix; no machine keeps a pool database of its own. A root with shared placement resumes on any machine that opens the journal: if the root's machine dies, resuming the run from `/resume` (or `resumeDurableWorkflow`) on another machine continues it, and its children replay from their last committed checkpoints. Running worker hosts serve the resumed root without being restarted.

`admission.limits` count across every host of the pool. `admission.host` thresholds apply on each host to the workers it runs. While the root's budget blocks further spending, no host starts its children. `admission.userLimits` is not supported with shared placement. Give every machine that runs a shared root or a worker host its own hostname: admission and the cleanup of workers' tool processes tell machines apart by hostname.

To bind children to a repository state, pass `workers.workspace`: a binding with `remotes`, `head`, `tree` and `envHash`, a bound workspace, or a `workspace({ … })` value, which the root resolves when it starts. A child started with `ctx.workflow(child, { workspace })` is bound to its own workspace's state instead, and on the host that runs it, its workspace is that host's worktree. A bound child runs only on a host that can run it on that tree, never in another host's copy of the root's directory:

- A host whose `placement.prefer(binding)` returns the path of a local worktree whose current tree is `binding.tree` takes that work first and runs it there.
- A host that restores takes bound work it does not have and runs it at the verified path its restore returns. By default a host with git restores the tree from the snapshot the work carries, or else from the binding's remotes and the worktree snapshots recorded in the shared journal, into a new worktree under its agent directory; pass `restore` to restore another way, or `restore: false` to turn restoring off. The default restore then builds the new worktree's blueprints, from the host's own agent directory (its global blueprint and a trusted repository's `.atomic/blueprint.yaml`), before the child starts; a blueprint that fails is a warning the host prints and never stops the child. A host given its own `restore` builds none. See [Resume on any machine](/guides/resume-on-any-machine). A failed restore puts the work back for another host, without counting as one of the child's attempts, and the host waits before it restores that binding again: one second after the first failure, twice as long after each further one, up to a minute.
- A host with neither never takes bound work, however long it waits. The root's own workers take only unbound work.

A cold host can restore a bound tree, the root's or a child's, with its uncommitted, untracked and unpushed content. The root's machine snapshots the root's bound worktree when the root starts, and a child's bound worktree when it dispatches the child, and the work carries that snapshot. These snapshots follow the root's `snapshots` settings: Git ignores, `.atomic/snapshot-ignore`, the deny list and the size limits apply, and `snapshots.enabled: false` turns them off. Snapshot garbage collection keeps the root's own snapshot while the root's worker pool runs, and the snapshot a child carries for as long as the root run's queued work exists, which is until the root run is deleted from history. Both are kept at any `snapshots.graceSeconds`, `0` included. A root bound by a `WorkspaceBinding` alone, or resumed without its `workspace({ … })` value, has no worktree to snapshot. Its children's trees then restore only from the binding's remotes and from snapshots that checkpoints recorded of that exact tree, and children it queued earlier keep the snapshot they carried.

If no live host that serves the root and can restore a binding claims a bound child within `workers.claimWindowMs` (default 60000), the child fails with `WorkspaceRestoreUnavailableError`. A host waiting after failed restores of the binding does not count, and its last failure is the error's `cause`, for example a remote it cannot reach. Start a capable host and resume the root to run it.

### Checkpoint shipping

`workers.checkpointShipping` sets how each host records the checkpoints of the children it runs. The default, `"sync"`, commits every checkpoint to the shared journal before the step returns. With `{ intervalMs?, maxBatch?, maxLagMs? }`, each host first records a child's checkpoints in a local journal under its pool state directory (`workflows/pool/ship/`), and then ships them to the shared journal:

| Option | Range | Default | Meaning |
| --- | --- | --- | --- |
| `intervalMs` | 100 to 60 000 | 2 000 | How often a host ships what its children recorded. A host also ships at least every quarter of `maxLagMs`. |
| `maxBatch` | 1 to 1 000 | 64 | The normal shipment size. Near the lag target, a shipment can carry up to 1 000 checkpoints to catch up in fewer requests. |
| `maxLagMs` | 1 000 to 600 000 | 30 000 | The target maximum age of an unshipped checkpoint. The host uses recent delivery times to start catch-up shipping early; while catching up, the child's next step waits and its host claims no new children. |

A step returns once its host has recorded the checkpoint locally, and the host ships its children's checkpoints in batches in the background. Each shipment of a child's checkpoints is one request to the shared store. `maxLagMs` is not a hard deadline. The host adapts catch-up scheduling as delivery times and batch sizes change. A sudden slowdown, queued store requests or retries can still exceed the target while those estimates adapt. When recent deliveries take half of `maxLagMs` or more, each of a child's steps waits until the step before it is shipped, so unshipped steps don't pile up. If lag remains above the target, reduce the host's worker count or increase `maxLagMs` to allow for the store's delivery time.

The host ships everything a child recorded before the child completes, before a pause or quit takes effect, and before the host stops. A delivery that fails is retried. Children can continue until catch-up backpressure holds their next step. A host whose oldest unshipped checkpoint reaches its catch-up point claims no new children until it catches up.

Everything a child records goes through its host's local journal: its checkpoints, its agent stages' session transcripts, the checkpoints that bill model usage, and those that carry worktree snapshots. A few steps wait for shipping:

- A step that ends an agent stage returns once it is shipped, with everything the child recorded before it. The root's budget sees the stage's model usage as it is spent, and the stage's transcript is in the shared journal when the stage ends. The usage of a stage that is still running reaches the budget with the child's heartbeat, as without shipping.
- A checkpoint that carries worktree snapshots is kept only once the shared journal holds the snapshots' content, and ships after it. If a snapshot collection with a `snapshots.graceSeconds` shorter than the shipping lag removes that content before the checkpoint ships, the checkpoint is recorded without its snapshots and a `blobs-collected` warning is printed. The default of 3600 seconds is well above any lag.
- A child that reads back one of its own sessions, as a stage that resumes its session does, first ships what it holds of that session.

**Checkpoint shipping is at-least-once for the steps a host has not shipped yet.** If a host dies, its children replay elsewhere from their last shipped checkpoint, so every step since then runs again. Their stages' session writes since then are dropped with them: a replay continues each session from what was shipped, so a session never mixes the writes of two attempts. The replay window is normally around `maxLagMs` per child, but grows when shipping cannot keep up. Tools that run in that window must tolerate running twice. With `"sync"`, only the step in progress can run again. A host whose child was replaced has its late batches refused, and its unshipped checkpoints are dropped. If a work lease expires without replacement or the root renews the same lease late, the host keeps pending checkpoints and retries shipping after renewal.

A host that starts again with the same pool state directory and shared journal first ships what it left unshipped, for children whose work it still owns, and drops the rest. Retain the pool state directory across service and container restarts to recover unshipped checkpoints. Set `localWorkers.leaseMs` longer than a host takes to restart, so a restarted host still owns that work and ships its steps instead of dropping them. Rolling a worker host back to 0.9.88 or earlier discards its unshipped steps and session writes. Its children replay from their last shipped checkpoints. Drain the host before rolling it back to avoid that replay.

A host whose local journal fails, for example on a full disk, commits that child's checkpoints directly for the rest of the attempt and reports it once as a pool health warning. A later attempt tries the local journal again. If the local journal cannot open at startup, the pool still starts and all its children on that host commit directly to the shared journal, with one health warning for the root. Only one process at a time uses a root's local checkpoint journal. Other processes sharing the same agent directory use synchronous commits for that root instead; the journal becomes available again when its owning pool closes or its process dies. Once a root's run ends, each host removes that root's local journal file when it holds nothing left to ship and no pool or Atomic connection on the host has it open. A host that was down when a root's run ended, for example after a crash, removes that root's local journal the next time a worker host starts or a shared pool opens on the same shared journal and pool state directory. Checkpoints it never shipped go with it, because a run that ended no longer accepts them. It keeps the local journals of runs that are still running or paused, and any local journal a pool or another connection Atomic opened on the host has open, even one opened while the host removes it. Detection of connections opened directly by other programs or earlier Atomic releases is best effort. Close these connections before a host starts again. One small lock file per shared journal stays in `workflows/pool/ship/`: it keeps a process from opening a root's local journal while another removes it. Unshipped checkpoints of runs that have not ended stay on disk for recovery after a restart. A resume may change the setting.

A worker host checks its setup once, before it opens anything, and reports every missing piece together in one `SharedPoolSetupError`: a journal that is not selected through a storage adapter, an adapter that does not load, a secret whose environment variable or file is missing, or a `restore` function on a host where git is not installed and Atomic cannot download a portable one (the error's `cause` is the `GitUnavailableError` from `resolveGit()`, and the problem's `hint` says how to install git). The error's `hint` says how to fix each one, for example `atomic team join <url> --token-file <path>` to join a machine to shared storage, or `atomic install npm:@bastani/atomic-storage-libsql`. A host with a `restore` function uses the git `resolveGit()` from `@bastani/atomic` resolves, downloading a portable git when the machine has none; pass `git: { path, env }` to run another git instead. A host without one never downloads git: without git it starts, reports `restore: false` in its stats, and takes bound work only where its tree is warm. Starting a root with shared placement fails the same way, in one `SharedPoolSetupError` with operation `shared-placement`, before its journal opens: a journal other machines cannot open, an adapter that does not load, or a missing secret.

The workflow tool's run detail shows a `SHARED POOL` section for such a root: how many children are ready, leased, completed and failed, how many stage inputs wait, the fleet's queue across every running or paused shared root, each host with its state (`busy`, `idle`, `draining`, `degraded`, `stale`, or `live` for a host of an older version), workers, slots, busy workers, git and whether it restores, and each lease with how long ago it was renewed. The status JSON carries the same in `sharedPool`: per-host `state`, `busy`, `draining`, `heartbeatAgoMs` and `degraded`, and `fleet` with `store` and `queue`. `host.stats()` returns the same for the roots a host serves, plus the host's own git source, whether it is draining, its last placement failure, why it last stopped serving a root, and the last health warning of its workers. `readWorkflowWorkerFleet()` returns every host and root of a journal in the same shapes, and `workflowWorkerFleetLines()` prints them as `atomic worker status` does.

Each host also reports, with its heartbeat:

- its [checkpoint shipping](#checkpoint-shipping), while a root it serves ships checkpoints: the age of its oldest unshipped checkpoint or session write, how many writes it holds, whether it is catching up and claims no new children meanwhile, and the last delivery failure. Status shows it on the host's line, as `shipping 4.0s behind, 12 pending`, and in the JSON as the host's `shipping` (`lagMs`, `pending`, `lagging`, `error`). `host.stats().shipping` is the same for the host itself.
- the progress of each child it runs: how long ago its attempt last recorded a checkpoint or a session entry, and how many checkpoints it recorded on that host. Status shows it on the child's lease line, as `last step 3.0s ago, 7 checkpoints`, and in the JSON as the lease's `lastProgressAgoMs` and `checkpoints`.

Status shows only what a host reported with its latest heartbeat, so a host of an older version, which reports neither, shows neither. When the fleet runs a fleet controller, status also shows the controller that holds its lease (`fleet.controller`: `holder`, `epoch`, `renewedAgoMs`) and its five latest decisions and failures, newest first (`fleet.scaleEvents`: `seq`, `kind`, `target?`, `live?`, `reason`, `error?`, `agoMs`). Events without a scaling plan omit `target` and `live`. It shows every [fleet-wide rate limit](#fleet-wide-model-rate-limits) too, with its rate and any 429 cooldown every host still waits out (`fleet.rateLimits`: `scope`, `requestsPerMinute?`, `cooldownInMs`). A scope used only for a cooldown has no rate and disappears when its cooldown expires.

Status never waits on a shared store that stops answering. A read that fails shows `Shared pool stats unavailable, shared store unknown` (`fleet.store.state` `"unknown"` from `readWorkflowWorkerFleet()`) with why and a hint; a read that takes more than 5 seconds shows the store `degraded` instead. Status in a running process writes nothing to find this out; `readWorkflowWorkerFleet()` and `atomic worker status`, which open the journal for the read alone, also try one write that changes nothing and report the store degraded when it does not commit within 2 seconds. It shows `shared store degraded`, why, and the same hint when its own read runs out of time, when one of the process's writes to the pool has waited more than 10 seconds, when the store failed three writes in a row while worker hosts are registered, or when the libSQL adapter reports that the server left its writes unanswered. sqld 0.24.33 and earlier can stop taking writes from every client until it restarts ([tursodatabase/libsql#2286](https://github.com/tursodatabase/libsql/issues/2286)): start sqld with `--checkpoint-interval-s 60` (`SQLD_CHECKPOINT_INTERVAL_S=60`) to avoid it, and restart it if writes stay stuck.

On a database server such as sqld or Turso, every write of the shared pool goes as one request that holds the server's write lock only for that request: a checkpoint, a heartbeat, a claim, a completion, a stage input and a host's report. Each process sends at most four writes at once. Lease renewals and host reports go first, so a busy host does not let its leases lapse. A write that finds the lock busy is sent again after a short random wait, for up to ten minutes. A request the server leaves unanswered for 30 seconds is abandoned and the write planned again, without being applied twice. A server under contention therefore makes children slower, not stuck. If the store keeps refusing a child's writes for two minutes, the child moves to another host without using one of its attempts. A write the store can never take, such as one past its response size limit, fails the child after its attempt limit with an error that names the refusal. If children stop making progress for minutes, check whether the server still takes a write from a new client, such as `CREATE TABLE IF NOT EXISTS probe(x)`. sqld 0.24 can stop taking writes from every client under heavy contention; only a restart of the server clears that.

#### Fleet-wide model rate limits

Each host normally backs off from a provider on its own. To keep a whole fleet under one provider's rate limit, set `workers.rateLimits`, by provider id or `provider/model`:

```ts
workers: {
  placement: "shared",
  rateLimits: {
    anthropic: { requestsPerMinute: 400 },
    "openai/gpt-5": { requestsPerMinute: 60, burst: 10, prefetch: 2 },
  },
  shareCooldowns: true,
}
```

- **`requestsPerMinute`** is the rate across every host, not per host. A call to a model counts against its provider's limit and its own when both are set. The shared journal keeps each limit's schedule in whole milliseconds, rounded up, so a limit whose interval (60 000 / `requestsPerMinute` ms) is not a whole number of milliseconds runs slightly below its rate, by at most a millisecond per journal request; it never runs above it, unless hosts of 0.9.88, which round down, share the limit.
- **`burst`** is how many calls may start at once after a quiet spell. Default: ten seconds' worth of the rate, and at least one.
- **`prefetch`** is how many calls' worth a host takes from the shared journal at a time. Default: half the root's workers on that host, rounded up. Higher values mean fewer journal writes but a less even split between hosts.
- **`shareCooldowns: true`** sends every 429 cooldown a host records to the other hosts through the journal, so all of them hold that provider or model back until the cooldown ends. By default a cooldown holds back only the host that hit it.

A call waits for its turn before it is sent; it never fails because of a fleet limit. If the shared journal does not answer within one second, the host meters that provider at its share of the rate (the rate divided by the live worker hosts) until the journal answers again, and `host.stats().rateLimit` and the pool's coordination stats show `"local-fallback"`. Both settings are saved with the root, and a resume may change them. Without `rateLimits` and `shareCooldowns`, nothing changes.

Fleet scaling estimates also use granted calls and token-waiting worker time to estimate a host cap across every root. They hold limited growth while a minute of recent history warms. A scope with no draws during that minute no longer holds growth, so an unused provider or model does not freeze work using another scope. Bucket movement not explained by counted draws, as with older hosts, also disables that scope's cap for the observation window. SDK readers opt into the same behavior with `readWorkflowWorkerFleet({ rateHistory: true })`; call it at least once every 30 seconds. A one-shot status read does not keep rate history.

What differs for a child that runs on another host:

- Its stages show in the root's graph and status. Everything the root sends to one of its stages goes to that stage's queue of inputs in the shared journal: answers to its `ctx.ui` prompts and `ask_user_question` forms, text from its stage chat (messages, steers and follow-ups), and Intercom messages sent to it. The host running the stage takes them one at a time, in order, and records a receipt for each. Text a stage cannot take yet because it waits for an answer, as a replacement attempt that asks its question again does, waits until that answer has gone in. If that host dies, the next host to run the stage takes what it had not finished, and each input reaches the stage's session once.
- Its stage chat sends messages, steers and follow-ups, and shows its `ask_user_question` form, but shows no live transcript. Pausing or resuming that one stage, `/compact` and `!` commands fail with `RemoteStageCommandUnsupportedError`. Pause the whole run instead, or open the stage's post-mortem chat once it finishes.
- An Intercom send to one of its stages is queued, then delivered through the stage's queue. A send that waits for a reply (an ask) is refused: the stage's replies cannot reach the sender. So is a send to a stage that has no Intercom access. A message the stage's session fails to take is settled as undeliverable and its sender is told, and the stage's later messages and input go on. A message sent to several stages, such as a broadcast, stays queued for the others instead, and the failure shows in the run's `Intercom delivery:` status line.
- Tool processes a dead host started cannot be confirmed gone from another machine. A child whose attempt ran such processes is not replayed until a worker host or root on the dead machine confirms them gone.

## Settings

Settings can list package sources directly:

```json
{
  "packages": [
    "npm:my-atomic-workflows@1.0.0",
    "git:github.com/user/team-workflows@v2",
    "./tools/local-workflows"
  ]
}
```

Use object form to filter which workflows load from a package:

```json
{
  "packages": [
    {
      "source": "npm:my-atomic-workflows",
      "workflows": ["workflows/*.ts", "!workflows/experimental/**"]
    }
  ]
}
```

`workflows` patterns follow package filtering rules:

- Omit `workflows` to load every workflow allowed by the package manifest.
- Use `[]` to load no workflows from that package.
- Use `!pattern` to exclude matches.
- Use `+path` to force-include an exact path.
- Use `-path` to force-exclude an exact path.

Run `atomic config` to enable or disable package resources interactively. Atomic saves workflow package filters as `workflows` patterns in settings.

## Package Setup

Atomic packages can ship workflows through package metadata or conventional directories. A package manifest can declare workflows next to extensions, skills, prompt templates, and themes:

```json
{
  "name": "my-atomic-workflows",
  "keywords": ["atomic-package", "pi-package"],
  "atomic": {
    "extensions": ["./src/index.ts"],
    "workflows": ["./workflows"]
  }
}
```

Paths are relative to the package root and may use glob patterns. Include `atomic-package` for Atomic package discovery and `pi-package` for compatibility with existing package-gallery tooling.

For new Atomic package examples, prefer `atomic.workflows` and `atomic.extensions`. `pi.workflows` and `pi.extensions` remain supported for compatibility with existing packages. Workflows can be declared with `atomic.workflows` or discovered from conventional `workflows/` / `workflow/` directories. Unlike other resource types, package workflows still fall back to conventional directories when a package manifest exists but omits the workflow key. App-level config prefers `atomicConfig` where available; legacy `piConfig` is still read as a shim.

Convention directory example:

```text
my-atomic-workflows/
  package.json
  workflows/
    release-plan.ts
    review-loop.ts
  src/
    index.ts
```

Install packages globally or locally:

```bash
atomic install npm:my-atomic-workflows
atomic install git:github.com/user/my-atomic-workflows
atomic install ./local-workflow-package -l
```

By default, `atomic install` writes to global settings (`~/.atomic/agent/settings.json`). Use `-l` to write to project settings (`.atomic/settings.json`). A team can commit project settings to share the same workflow package set.

To try a package for one run, use `--extension` or `-e`:

```bash
atomic -e npm:my-atomic-workflows
atomic -e ./local-workflow-package
```

Workflow stage sessions inherit the same package and temporary `-e` resource discovery snapshot as the main chat. That means a workflow loaded from an external package or directory can start stages that see the package's extensions/tools, subagents and agent definitions, skills, prompt templates, themes, workflows, and trusted borrowed project-local resources without sharing the parent chat's resource-loader instance. Passing an explicit `resourceLoader` in stage options still opts that stage out of this inheritance.
