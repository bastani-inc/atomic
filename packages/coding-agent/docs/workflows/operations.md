# Workflow Operations

Run and operate workflows from interactive chat or the workflow tool: identify runs, inspect their graphs, communicate with stages, answer human-input gates, and manage durable execution.

## Workflow run identifiers and the BACKGROUND panel

Workflow run identifiers are shown in full everywhere they are presented to users: the `BACKGROUND` panel, workflow status and detail views, run pickers, control messages, and awaiting-input attribution banners. Input matches that: every command and workflow-tool action that accepts `runId` requires the **full 36-character UUID**, exactly as displayed. Typed prefixes are not accepted, and neither is a 32-character dashless form. A target that is not a well-formed UUID is rejected with `Run id must be a full 36-character UUID; got "339e05a4" (8 chars).`, which is deliberately distinct from `Run not found:` so a truncated paste is diagnosable as truncated rather than looking like a stale run. Because ids are unique and matched exactly, a run target can no longer be ambiguous.

Stage targeting is exact but not UUID-bound, because stage identifiers are not all bare UUIDs. A `stageId` resolves by exact stage id — a bare UUID at the root, the full `runId:stageId` composite for a stage inside a nested workflow, or `tool:<argsHash>` for a `ctx.tool` node — or by exact stage or tool name. Partial names no longer match, so `build` will not select `build-check`. Two stages that share an exact name are still reported as ambiguous, listing the full matching identifiers.

### Intercom delivery to pending workflow stages

A workflow stage uses the root-anchored `workflow:<rootRunId>/<segment>[/<segment>...]` path shown by `intercom list` and workflow status surfaces. A segment may be a stage name, a materialized run id, or a glob: `*` matches one segment and may be embedded, while `**` matches any depth. Model-facing `workflow status` and interactive status list/detail surfaces enumerate materialized pending stages by display name and canonical stage ID, printing the path only when `pendingStageDeliveryAvailable` is true and the owning run is nonterminal. An ended root or nested child never advertises a retained pending target. Duplicate names remain independently identifiable. The workflow SDK `sessionId` is **not** an Intercom target.

Join `workflow:<rootRunId>` and run `intercom({ action: "list" })` to see live sessions, materialized `PENDING`/`RUNNING` stages, and possible future literal, glob, and nested-child targets with queued counts. Then use ordinary Intercom delivery:

```ts
intercom({
  action: "send",
  to: "workflow:<rootRunId>/reviewer",
  message: "Scope changed: raw amendment text is now part of the oracle."
})
// queued — distinct from live-session delivered
```

Send material updates through Intercom to every affected workflow stage, including stages that have not started. Name and pattern sends remain sticky for every future matching stage until root termination. When shared scope or acceptance criteria change, broadcast one authoritative update to `workflow:<rootRunId>/**` (or a narrower path pattern) rather than enumerating stages; live matches receive it immediately and future descendants receive it before their first model turn. A syntactically valid path outside the persisted known set queues with a `notInKnownSet` warning and settles undeliverable at terminal only if never delivered; an entry delivered at least once is not reported undeliverable. Use `ask` once the stage session is live and can reply.

At 80 columns and wider, each `BACKGROUND` card keeps the full run identity and preserves its mode, progress, live-tool details, and elapsed/status metadata. When the remaining single-row budget permits, it adds bounded pending-stage details: a target is either shown exactly or replaced by a `stage`-labeled canonical ID, and `… N more` reports omitted pending stages. If no bounded pending-stage form fits, the pending label is omitted entirely rather than displacing the existing metadata. Tool nodes are read-only durable graph nodes, not attachable stage chats. Below 80 columns, the panel keeps its aggregate collapsed form and omits run IDs, stage identities, targets, and tool names.

For chat surfaces such as workflow status, run detail, dispatch confirmation, and the run picker, a full id wraps onto continuation rows when the card is narrower than the id. Pending-stage targets in run detail use the same rule: the exact address wraps instead of being ellipsized, and narrow status cards wrap the canonical stage ID or drop its display-name decoration rather than rendering a partial ID. The renderer keeps the card border closed at its minimum layout width, while terminals below that floor — including sub-30-column terminals — can hard-clip the box. An awaiting-input attribution banner is titled `AWAITING INPUT` and contains the same two identity rows — `？` plus the full run id, then the workflow name and optional metadata — while the existing prompt question and options remain below it in the normal prompt UI.

The `/workflow connect` run picker shows five runs at a time; use the arrow keys or mouse wheel to scroll through additional retained runs.

The rendered card shape at the 80-column breakpoint is:

```text
│   ●  339e05a4-2289-408e-9076-d1a348f582ae                                    │
│     stage-output-transcript · chain · 2/3 · 12m                              │
│                                                                              │
│   ●  d4e5f6a1-77b2-4c31-9e0a-2f1c8b4d6e5f                                    │
│     build-check · chain · 0/2 · 12m                                          │
```

Below the breakpoint the same run set is represented by the collapsed count line, for example ` ▾  4 background · 2 ● · 1 quit`; a tool-only run adds its live count, for example ` ▾  1 background · 1 ● · 1 tool`.

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
- execution: named `run` with validated `workflow` and `inputs`
- inspection: `status`, `stages`, `stage`, `transcript`
- prompt response: `answer`; run control: `pause`, `interrupt`, `quit`, `resume`; free-form stage communication: ordinary Intercom `send`/live `ask` to `workflow:<rootRunId>/<segment>[/<segment>...]` path targets, including `*` and `**` globs
- rediscovery: `reload`

Every registered `workflow` tool call has one hard two-minute wall-clock deadline at the shared public tool boundary. The deadline covers request handling through the returned result; for background `run` and `resume`, it therefore covers startup/resume admission and acknowledgement only, not the workflow execution that continues after acknowledgement. A deadline returns one structured result:

```json
{
  "action": "run",
  "runId": "339e05a4-2289-408e-9076-d1a348f582ae",
  "status": "failed",
  "code": "WORKFLOW_TIMEOUT",
  "timeoutMs": 120000,
  "error": "Workflow run request timed out after 120000ms. The outcome is unknown. Inspect workflow status before retrying."
}
```

Expiry aborts the request operation signal so work that supports cancellation can stop, discards any later success or error, and never retries the action. The interactive engine remains available for the next command. For mutating actions (`reload`, `run`, `answer`, `pause`, `resume`, `interrupt`, and `quit`), the error additionally says that the outcome is unknown and instructs you to inspect workflow status before retrying; a timeout never claims that a mutation succeeded. When a timed-out `run` has already allocated its detached run, the structured result includes that exact full `runId`; inspect `status` with that id before any retry. A timeout before run allocation has no `runId`. Read-only actions (`models`, `list`, `get`, `inputs`, `status`, `stages`, `stage`, and `transcript`) omit that unknown-state guidance.

From interactive chat, named workflow launches run in the background so the parent chat stays available. Run `/workflow connect <run>` to see agents working and chat with and steer each stage. Inspection, prompt-response, and control calls (`status`, `stages`, `stage`, `transcript`, `answer`, `pause`, `resume`, `interrupt`, `quit`) remain available while work runs.

The no-`runId` status listing includes bounded pending-stage rows after each run summary. Each row gives the display name, canonical stage ID, literal `pending` lifecycle, `pendingStageDeliveryAvailable`, and either the exact usable Intercom target or `unavailable`. Interactive status cards and run detail show the same identity/availability distinction within their width budgets. Status cards wrap exact targets onto continuation rows instead of rendering a partially truncated address; bounded omissions retain an explicit remaining-stage count.


`workflow({ action: "models" })` returns the registry's configured-auth catalog snapshot in registry order. Each entry includes `provider`, `id`, `fullId`, an `isCurrent` marker, and `availableThinkingLevels` derived from the real model's `reasoning` and `thinkingLevelMap` metadata. This is not proof of credentials, entitlements, OAuth freshness, or live provider access, and it exposes no authentication details.

Named launches wait only for **startup admission**, not for workflow completion. Atomic returns `status: "running"` after durable registration, reusable-worktree setup, and other pre-body setup succeed, while the workflow body and stages continue in the background. If setup fails before the workflow body is admitted — for example, `git_worktree_dir` points inside the invoking checkout — the original `workflow` tool call instead returns a structured `status: "failed"` result with the allocated full run id and concrete setup error. No background-start claim or orphan run is retained, so the caller can correct the inputs and retry immediately. Failures after admission remain ordinary background lifecycle outcomes reported through status and lifecycle notices.

A model may launch in the foreground only when the user explicitly requests it or foreground execution is technically required, and it must tell the user before launching.

Run a named workflow with inputs:

```ts
workflow({
  action: "run",
  workflow: "fan-out-and-synthesize",
  inputs: { prompt: "map workflow runtime by subsystem", max_concurrency: 4 },
})
```

Slash equivalent:

```text
/workflow fan-out-and-synthesize prompt="map workflow runtime by subsystem" max_concurrency=4
```

<p align="center"><img src="../images/workflow-command.png" alt="Running a Workflow Command" width="600" /></p>

Input overrides are bare `key=value` tokens. Atomic parses values as JSON when possible, so `count=3`, `flag=true`, and `prompt="multi word value"` preserve useful types. A whole input object can also be passed as one JSON token. Runtime validation is strict: unknown input keys, missing required values, type mismatches, and invalid `select` choices fail before a named workflow run starts or before a child workflow starts.

In the TUI, `/workflow <name>` opens an inline input picker when the workflow declares inputs and either no arguments were supplied or required inputs are missing. Supplied values seed the picker. The picker is mounted and focused in the terminal host in both isolated and non-isolated interactive modes, so Tab/Shift+Tab, arrows, text editing, configured keybindings, Enter, Escape, and Ctrl+C remain responsive without per-keypress host⇄engine traffic. Escape or Ctrl+C cancels without starting the workflow. Pass `--no-picker` to skip that interactive flow.

In non-interactive (`-p`, `--print`, or `--mode json`) sessions, named workflow dispatch waits for the terminal run snapshot and skips pickers. Because human input is runtime-only and workflows no longer carry a declaration-time HIL marker, headless dispatch does not reject a workflow because its source contains `ctx.ui.*`.

If you copy a HIL workflow example into a headless session, it can pass dispatch and then fail when execution reaches the prompt with an error such as `atomic-workflows: interactive ctx.ui.confirm is unavailable in headless (non-interactive) mode; run the workflow in interactive mode or remove the interactive prompt from this stage` (the primitive name varies, including `ctx.ui.custom`). Run those workflows interactively, or guard/remove runtime `ctx.ui.*` calls before using headless mode.

<p align="center"><img src="../images/workflow-input-picker.png" alt="Workflow Input Picker" width="600" /></p>

## Workflow Commands

```text
/workflow list
/workflow inputs <name>
/workflow <name> --help
/workflow <name> [key=value ...]
/workflow connect [run-id]
/workflow attach [run-id] [stage-id-or-name]
/workflow pause [run-id] [stage-id-or-name]
/workflow status [run-id]
/workflow status --all
/workflow interrupt <run-id|--all>
/workflow quit <run-id|--all>
/workflow resume <run-id> [stage-id-or-name] [message]
/workflows [full-workflow-uuid]
/workflow reload
```

Common controls:

```text
/workflow status                       # list retained active and terminal runs
/workflow connect <run-id>             # graph viewer, including terminal runs
/workflow attach <run-id> <stage>      # chat with a single stage
/workflow interrupt <run-id>           # pause resumably
/workflow resume <run-id> [stage] msg  # forward a steer message and resume
/workflow quit <run-id>                # pause gracefully and keep the run resumable
/workflows [run-id]                    # retained alias for /workflow resume (history picker)
```

Surface behavior:

- **Graph vs. stage chat** - Use `connect` for the workflow graph. Use `attach` when you want a chat pane for a specific stage.
- **Hierarchy chord** - `ctrl+x` is the workflow hierarchy chord: in an attached stage chat it means **return to graph**, and in the graph it means **return to main chat**. The workflow surface handles `ctrl+x` before configurable editor or tool actions, including while a composer draft, primitive prompt, custom question, stage switcher, or legacy prompt card owns input.
- **Draft preservation** - Leaving a stage preserves unsent composer and prompt drafts and keeps pending custom questions unresolved so they reappear when you attach again.
- **Queued-message survival** - Steering and follow-up entries queued from a stage chat live on the stage session, not on the pane. Detaching to the graph and reattaching rehydrates the pending `Steering:` / `Follow-up:` rows, and while you are detached the stage's graph node shows a `✉ N queued` badge so a pending message stays visible without attaching. The attached chat shows the pending text; the detached node shows only their count. Both read one projection that the stage handle keeps current from the session's complete `queue_update` snapshots, so rows and badge shrink together as the agent consumes entries. That projection is fed by the events rather than by a concrete Atomic `AgentSession`, so a stage backed by a custom `AgentSessionAdapter` keeps this behavior as long as it publishes ordinary `queue_update` events; each snapshot replaces the previous steering and follow-up lists rather than adding to them. A queue can also outlive the session holding it — a stage session that fails over to a fallback model hands its pending messages to the session replacing it, and a completed stage reopened as a post-mortem chat is restored holding whatever it was queued. Those messages were announced before the projection could reach the new session, so Atomic reads it once as it attaches and the rows and badge show them too.
- **Reserved keys** - `ctrl+d` and `q` do not navigate workflow surfaces; `ctrl+d` keeps its ordinary editor or prompt behavior where applicable, and `q` remains printable in text-owning prompts. Existing `esc`, `ctrl+c`, and graph `h` close/hide controls are unchanged.
- **Wheel and trackpad** - While the workflow graph is active, vertical wheel/trackpad gestures pan it up and down, and horizontal gestures pan wide graphs left and right when the terminal exposes horizontal wheel events. Focused graph and stage-chat overlays receive those gestures through the fullscreen application route, so scrolling stays inside the active workflow surface instead of falling through to terminal or main-chat scrollback.
- **Fullscreen mouse routing and selection** - A focused workflow graph or attached stage chat overlay receives wheel/trackpad and click input through the host's application-owned input route before the fullscreen viewport. Events the overlay does not consume fall through to pi-tui's viewport, while non-overlay focused components leave pi-tui's transcript scrolling, scrollbar interaction, and drag-selection path intact. Graph panning, stage-chat scrolling, node click-to-attach, and drag or multi-click selection therefore work without a separate selection mode. Copy uses OSC 52; terminals that refuse OSC 52 writes still support the modifier-drag bypass (Shift/Option, as provided by the terminal). `ctrl+t` is not a workflow control: focused workflow overlays leave it to the host `app.thinking.toggle` action, while inline tree selectors keep `app.tree.filter.noTools`.
- **Tool and node detail** - Attached stage chats match main chat's tool-detail expansion behavior while keeping expansion state local to the workflow UI context. Press Ctrl+O (the configurable `app.tools.expand` binding) to expand every visible workflow node and tool card, including single, parallel, and nested subagent progress, current tool activity, and artifact paths; press it again to collapse them. The toggle works for active, completed, and archived stage views, including at the supported 40-column terminal minimum. A mounted prompt, custom question, or other input-owning overlay keeps the key instead of changing it.
- **Footer context** - An attached live stage chat carries the main chat's current-folder and Git-branch identity into its themed footer and mirrors live extension status lines such as the MCP server indicator. Branch changes trigger a repaint through the host's cached footer provider, and extension status changes are read from that same provider rather than recomputed by the workflow UI.
- **Working animation lifecycle** - Ordinary attached-stage work keeps the same exact one-cell `∀` visible while following the active workflow theme's dark → accent → bright/bold → accent → dark luminance ramp every 88ms. Every agent and SDK turn resets to the dark regular phase with a fresh lifecycle-relative cadence; turn, terminal, error, replacement, and disposal cleanup stop the active timer without stale repaint. In an eligible retained-stage chat, every accepted idle follow-up — including a workflow-authored `stage.sendUserMessage(...)` after a prior turn ended — shows Working on admission or attach, including while Atomic restores a saved retained conversation, and keeps it through prompt startup, pre-turn compaction, and agent handoff. Attaching or remounting mid-delivery paints immediately rather than waiting for the turn's first event. A message queued into a live turn with `followUp`/`steer` uses that turn's existing status instead of starting a new one. A no-turn result, prompt or restore error, or terminal completion removes it; once the last accepted post-terminal delivery settles, a leftover start cannot bring it back. An accepted manual retry clears stale status from the prior prompt before showing new pre-stream activity. `NO_COLOR` retains regular/bold activity without foreground-color escapes. Reduced motion uses a static regular accent `∀` without an animation timer; factual automatic retry, fallback, compaction, cancellation, and error copy retains precedence.
- **Subagent statusline** - If a subagent is running while the fullscreen workflow graph is open, the graph statusline mirrors its summary so the run remains visible; hide the graph with `h`, leave it with `ctrl+x`, or reconnect later to return to the full below-editor widget.
- **Run control** - Use `interrupt`, `pause`, and `resume` for resumable live work. Pause/interrupt holds a stage's queued steering and follow-up items in place without dequeuing them or starting continuation; `resume` releases those items once in their existing per-queue order, but queue release alone does not start a model turn. `resume` on a non-paused run reopens the saved snapshot or overlay. Use `quit` to pause a live run gracefully while preserving it for `/workflow resume`.
- **Rediscovery** - Use `/workflow reload` after adding, editing, installing, or removing workflow resources or package manifest workflow entries and you want Atomic to rediscover them in-process ([Reloading workflow resources](#reloading-workflow-resources)).
- **Status listing** - `/workflow status` lists all retained active and terminal top-level runs by default; implementation-owned nested child runs are flattened into their parent workflow rather than listed separately. `/workflow status --all` is retained as a compatibility alias.

`/workflows` is the retained-run history alias for `/workflow resume`: with no id it opens the same mixed picker, but the resumable section lists only runs that the resume path can actually accept and the completed section is read-only inspection. A run with no durable checkpoint, missing/pruned artifacts, or explicit deletion is omitted from the resume picker; an explicit `/workflow resume <id>` still returns an explanatory error. It is intentionally different from `/workflow list`, which lists installed workflow definitions. See [`/workflow resume` — cross-session resume selector](#workflow-resume--cross-session-resume-selector) for the full picker semantics.

At the supported 40-column terminal minimum, attached stage chats keep the `ctrl+x return to graph` hierarchy hint. The TUI may truncate provider/model context to make room, but it keeps that context separate from the hierarchy hint so the controls stay readable.

<p align="center"><img src="../images/workflow-graph.png" alt="Workflow Graph Viewer" width="600" /></p>

Human-in-the-loop prompts appear as awaiting-input nodes in the workflow graph, not as ordinary chat modals — see [Lifecycle Notices and Human Input](#lifecycle-notices-and-human-input) for how to find and answer them.

## Monitor and Control Runs

The workflow tool exposes lifecycle controls for non-interactive use:

```ts
workflow({ action: "status" })                                  // list every session run, in-flight first
workflow({ action: "status", statusFilter: "running" })         // filter the run listing by status
workflow({ action: "status", statusFilter: "awaiting_input" })  // runs with a pending human prompt
workflow({ action: "status", format: "json" })                  // structured listing for programmatic use
workflow({ action: "status", runId: "<full-run-uuid>" })         // full detail for one run

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

workflow({ action: "interrupt", runId: "<full-run-uuid>" })
workflow({ action: "interrupt", all: true })

workflow({ action: "resume", runId: "<full-run-uuid>" })
workflow({ action: "resume", runId: "<full-run-uuid>", stageId: "review", message: "continue" })

workflow({ action: "quit", runId: "<full-run-uuid>" })
workflow({ action: "quit", all: true })

// Abort one in-flight ctx.tool node without pausing the run.
workflow({ action: "quit", runId: "<full-run-uuid>", stageId: "tool:<argsHash>" })
workflow({ action: "interrupt", runId: "<full-run-uuid>", stageId: "publish-artifact" })

workflow({ action: "reload", reason: "added team workflow" })
```

Control behavior:

- `runId` requires the full 36-character run UUID for every lifecycle and inspection action, including `status`. User-facing status surfaces print that exact value, so pass it back verbatim; typed prefixes are rejected with a distinct `Run id must be a full 36-character UUID` diagnostic rather than resolved. Because ids are matched exactly and are unique, no run target is ambiguous. Status lists and run pickers show top-level user-launched workflows; nested child runs are implementation details of the expanded parent graph.
- `status`, `stages`, `stage`, and `transcript` with an explicit full `runId` first use the current session store, then perform one exact DBOS hydration when that id is absent locally. This is inspection only: Atomic does not claim ownership, change status, run workflow code, or resume the workflow. A stale durable `running` root is shown as `crashed` with its resumability and an explicit `/workflow resume <id>` hint; fresh work owned by another Atomic process remains `running`, offers read-only status guidance, and stays protected from local control or resume. Deleted/tombstoned, absent, malformed, cyclic, orphaned, nonreciprocal, out-of-scope, and duplicate-node records report distinct failures instead of inventing a partial graph. `status` without `runId` remains current-session-only and never scans durable history.
- `status` without `runId` lists every top-level run in the session with a concise per-run summary: the full run id, workflow name, run status, started/ended timing with pause-adjusted elapsed time, currently active stages, and awaiting-input details (count plus the stage, prompt id, kind, and message for each pending human prompt). In-flight runs are listed first. The summaries carry the exact identifiers that `answer`, `pause`, `resume`, `interrupt`, and `quit` accept, so an orchestrating agent can list runs and act on them directly.
- `statusFilter` narrows the `status` run listing: run statuses (`pending`, `running`, `paused`, `blocked`, `completed`, `failed`, `skipped`, `cancelled`, `killed`) match runs directly, `awaiting_input` selects runs with at least one stage awaiting input or pending human prompt, and `all` (the default) includes everything.
- `format: "json"` on data-bearing inspection actions (`status`, `stages`, `stage`, `transcript`) returns the full structured result; the default text output for `status` is the concise per-run summary list.
- `status` / `status <runId>` show terminal `ctx.exit(...)` statuses (`completed`, `skipped`, `cancelled`, or `blocked`) and the optional exit reason when one was supplied.
- `stages` lists stage summaries, including flattened stages from nested `ctx.workflow(...)` imports and `sessionFile`/`transcriptPath` when a stage has a persisted session. Use `statusFilter: "all"` to include completed, failed, skipped, and pending stages.
- `stage` returns details for one stage by exact stage id or exact stage name, including nested child stages shown in the expanded graph and the persisted `sessionFile` when available. User-facing graph and control messages print full stage IDs; pass one back verbatim, or use the stage's exact name. Prefixes and partial names no longer resolve. Two stages sharing an exact name return an ambiguity diagnostic rather than selecting one.
- `transcript` is reference-first with a small preview by default: it returns metadata, transcript paths, and up to 5 recent entries. For targeted lookup, quote the exact `sessionFile`/`transcriptPath` value without changing platform separators (preserve Windows backslashes), search it with `rg` or `grep`, then read only small surrounding ranges. Text results include JSON-escaped `sessionFileJson`/`transcriptPathJson` lines for copy-safe path literals. Pass explicit `tail` or `limit` to override the 5-entry preview; `tail` overrides `limit`; `includeToolOutput` includes captured snapshot tool output in snapshot transcript results.
- `answer` responds only to a pending primitive or structured human-input prompt. It accepts `promptId` plus `response`, `text`, or `message`, preserves prompt-kind validation, and never sends stage chat, steers, resumes, or starts a model turn.
- Send free-form updates through ordinary Intercom to `workflow:<rootRunId>/<segment>[/<segment>...]`; `*` matches one segment and `**` any depth. Use `intercom list` inside the invocation group to see live, pending, and possible future targets. Atomic delivers immediately to live stages and queues matching future stages, delivering them before their first model turn. `workflow:<rootRunId>/**` remains sticky for every future descendant until root termination; narrower name and pattern sends reach every future match. Valid paths outside the known set queue with a `notInKnownSet` warning and settle undeliverable at terminal only if never delivered. Use `ask` once the target has a reply-capable live session. Use `workflow resume` only for paused workflow control.
- `pause`, `interrupt`, and `quit` can target one top-level run or `all: true`; `stageId` cannot be combined with `all: true`. Stage-scoped `pause` and `interrupt` controls can target a visible nested child stage from the expanded graph. Atomic routes stage controls to the owning nested run internally.
- `interrupt` and `quit` can also name one in-flight `ctx.tool` node with `stageId`, by expanded node id, local `tool:<argsHash>` id, or tool name. Both mean the same thing for a tool: abort that single call now. Tool nodes stay non-attachable — this is an abort control, not a chat target. Identifiers resolve exactly first and then uniquely; a name shared by two tool nodes (or by a stage and a tool) returns the same ambiguity diagnostic stages get, listing each match as `<name> (tool)`.
- Aborting one tool node leaves every sibling stage and sibling tool node running and does not pause the run. The node becomes `cancelled`, writes no replayable checkpoint, and re-runs on a later resume. Whether the run itself survives is ordinary author control flow: an awaited `ctx.tool` that is aborted rejects, exactly as it would for any other failure, unless the workflow catches it. A node that has already settled reports that it is not running rather than silently succeeding.
- Whole-run `quit` stays authoritative even if workflow code catches the tool rejection. A catch may run cleanup, but its returned outputs do not convert the quit into a completed run: the executor suspends and quit's paused/resumable record stands. To abort one call and intentionally keep the workflow going, target that node instead of quitting the run.
- A targeted tool abort reports the node outcome and the run separately: `status: "cancelled"` for the node it cancelled, `stageId` for that node, `abandoned` when the callback ignored its signal, and `workflowStatus` for the run status *observed* when the action returned. It never reports `paused`, and it never predicts what the run does next.
- `pause` never accepts a tool node: `ctx.tool` has no turn boundary to stop at, so Atomic rejects it with `Tool nodes cannot be paused; ... Use interrupt or quit to abort it.` instead of a silent no-op.
- `interrupt` is resumable: it pauses live work when pausable stages exist and keeps the run in live history/status.
- `pause` is useful for pausing a live run or a single live stage without treating it as a destructive abort.
- `resume` can target a stage with `stageId`; the target may be an exact stage id or an exact stage name. `message` is forwarded to paused work. For a live interrupted streaming prompt, Atomic preserves the existing prompt loop without duplicating the user message and injects `Continue where you left off. If you believe you are finished with your original task (or a redefined task if the user told you), stop.` when required before normal readiness-gate completion. For a paused stage that was idle waiting for a new stage-chat turn, a non-empty message resumes the stage and starts exactly one fresh prompt containing that message; an empty resume releases the pause without creating a prompt.
- An explicit workflow-tool `resume` target that is absent from the current session store triggers targeted DBOS discovery before Atomic returns `Run not found`. The target must be a full run UUID; an eligible exact ID resumes under the original workflow ID, and a malformed target is rejected before any durable lookup happens. Resource-loading and durable-backend failures remain visible. Ordinary workflow-tool `status` listing stays session-local and does not eagerly hydrate durable history.
- Exact-id durable inspection is separate from resume. `status`, `stages`, `stage`, and `transcript` may hydrate one missing-local root for read-only inspection, but they never claim it or execute replay. Only an explicit `resume` action enters the claim-and-dispatch path.
- Run-level `quit` gracefully pauses in-flight work, marks the run resumable, and leaves it available to `/workflow resume`. A run whose only in-flight work is a `ctx.tool` node is quit like any other: it pauses as resumable instead of reporting that there are no controllable stages.
- `reload` refreshes discovered workflow resources in-process; the optional `reason` is echoed in the result.

Use slash commands for graph connect and stage attach because those are interactive TUI surfaces. When a run needs user input or attention, tell the user instead of polling silently.

### Pausing, quitting, and resuming

Graceful quit is idempotent for an already-paused resumable run. If a run is waiting on `ctx.ui`, quit preserves its current DBOS prompt reservation. Answers cannot advance paused workflow code until explicit resume; checkpointing the answer releases exactly that reservation generation. Concurrent and nested prompts use composed scopes and independent DBOS reservation tokens.

**Quit closes `ctx.tool` admission before it becomes a durability boundary.** A run-level quit pauses controllable stages and waits for their acknowledgements, then closes the root-shared tool-admission boundary shared by the root run and every nested run. Closing is what makes the following scan final: a call admitted while the stage pauses were still being acknowledged is included, and no call can start afterwards — not even while the durable write is in flight. Quit then aborts that complete set, waits a bounded interval for the callbacks to settle, and only then records the durable paused transition and marks the run resumable.

Aborting a call is the point of no return: that callback's executor is already committed to suspending. So if the durable paused transition then fails or is refused, Atomic still records the pause locally — the run is never left reported as running with nothing running it — but does not advertise it as resumable, and the reported error names both the durable failure and what it left behind. The run stays controllable, so running `/workflow quit` again re-attempts the durable transition and upgrades the run to resumable once it lands.

A `ctx.tool` call attempted after admission closed never runs: it receives the graceful-quit signal, so it suspends the workflow instead of failing it, and creates no graph node, checkpoint, or side effect.

A callback that ignores its abort signal is abandoned rather than pinning quit forever — mirroring the failure path — and the quit result reports each abandoned call in `abandonedTools` alongside the cancelled nodes in `cancelledTools`. Both carry the owning `{runId, nodeId}` identity, because two nested child runs legitimately share one local `tool:<argsHash>` id; slash/tool output prints them as `<runId>/<nodeId>`.

A run whose only in-flight work is a `ctx.tool` node counts as controllable work: it pauses as resumable instead of returning `no_active_stages`. Because a cancelled tool node has no replayable checkpoint, resume re-executes exactly that callback at the same ordinal and node id; completed sibling tools replay from cache.

Catching the cancellation does not opt out. If workflow code wraps the aborted `await ctx.tool(...)` in `try`/`catch` and returns normally, Atomic still suspends the run rather than publishing a completed result, so the paused/resumable state quit recorded is what survives.

When a callback was abandoned, its executor stays alive but stops owning the run: Atomic detaches that background job, so `/workflow resume` launches a fresh executor under the same workflow id instead of adopting a job nothing is driving. The abandoned callback may still finish afterwards — its aborted signal blocks any replayable write, and its stale bookkeeping can neither mutate the replacement run's tool node nor unregister the replacement's job or cancellation entry.

When a paused stage interrupted an active model turn, Atomic preserves that turn's existing pause loop: a non-empty resume message is delivered exactly once through the resumed loop, and (if the stage has not finalized) Atomic injects `Continue where you left off. If you believe you are finished with your original task (or a redefined task if the user told you), stop.` before normal completion/readiness handling. A no-message interrupted-turn resume injects the same continuation directly. A different state applies when the stage was idle and waiting for a new stage-chat turn: resuming with a non-empty message starts exactly one fresh prompt containing the text, while an empty resume only releases the pause and does not fabricate a user turn or continuation.

The same continuation applies to user messages queued into a live streaming stage. Steering a turn (Enter in an attached stage chat) or queueing a follow-up (Ctrl+F) arms the identical continuation prompt, which Atomic injects once when the interrupted turn ends — even if several messages were queued during that turn — so a steered stage returns to its original (or user-redefined) objective instead of stopping after answering the queued message.

Messages delivered to an idle stage start a fresh user turn immediately and receive no continuation nudge; abort, kill, workflow exit, and finalized/fail-fast stage boundaries suppress late prompt creation and continuation injection.

When several paused stages resume together, Atomic settles every acknowledgement and then re-reads the actual stage/control state. A late rejection after its stage visibly starts counts as resumed and is not retried; genuinely paused failures remain available for a later resume. The run and durable root follow visible running work, while slash/tool output reports acknowledgement or durable-transition failures as partial progress instead of a no-op. If local resume succeeds but persisting the durable running transition fails, a later resume request retries reconciliation while the durable handle remains paused. A terminal run cannot be revived by a late acknowledgement.

### Post-mortem chat vs. execution resume

These are distinct operations. *Resuming workflow execution* (`/workflow resume`) is for paused, interrupted, recoverably failed, or unfinished durable work; it may replay checkpoints, continue an incomplete stage, and dispatch remaining DAG work. *Opening a post-mortem chat* reopens one terminal agent stage's retained conversation for follow-up only — it never resumes, retries, rewinds, or otherwise changes workflow execution.

Any eligible terminal agent stage with a valid retained session opens as an interactive post-mortem chat through the explicit user-driven TUI path: completed-workflow inspection, `/workflow attach`, or `/workflow connect` followed by stage selection, including restored/replayed durable snapshots after a restart. Explicit `/workflow attach <root-run> <nested-stage>` targets are resolved through the expanded graph and routed to the child run that owns the stage while the overlay remains rooted on the requested graph; the resolved owner is preserved when sibling child workflows reuse the same local stage ID.

Intercom and explicit `/workflow attach` own stage communication. The workflow tool has no free-form message action; start a new workflow if tracked work remains after a terminal root.

When a nested stage is reopened after a restart or from another checkout through the explicit TUI path, its session cwd comes from the durable root workflow (resolved workflow cwd first, then original invocation cwd) while stage-control ownership remains with the actual child run. Follow-up turns are appended in place to the stage's retained session (no separate fork), so the agent may still invoke its ordinary tools and cause side effects; only the workflow DAG, run/stage status, results, timings, checkpoints, and topology are immutable. Post-mortem chat does not resume or modify workflow execution state.

Pressing Escape during a live post-mortem turn aborts that retained conversation's active work and restores queued steering/follow-up text to the editor without changing the terminal workflow snapshot. The conversation remains paused; the next ordinary submission explicitly releases the conversation queue before it starts the new turn. Clearing or restoring every visible queued item does not implicitly resume it.

Every host session replacement or shutdown invalidates post-mortem handles, including a session whose lazy reopen is still pending: if creation finishes after the boundary, Atomic disposes the newly created session and rejects the already-submitted prompt before it can execute. A stage stays a **read-only transcript** when it has no valid retained agent session — prompt/HIL and boundary/summary nodes, skipped nodes without a completed conversation, non-terminal handle-less stages (another process may still own the session), and missing/malformed/deleted session files.

When a known stage cannot be reopened, the attached chat shows the complete `SESSION UNAVAILABLE` explanation down to the supported 40-column minimum instead of incorrectly labeling an invalid file as an archived transcript. Recoverably failed stages keep their execution-resume semantics and are not silently reopened as post-mortem chat.

Completed stages also remain addressable by blocking `intercom.ask` calls from sibling workflow stages. If an ask reaches a completed target with a retained conversation, Atomic schedules one serialized post-mortem turn in that exact conversation.

The target sees the original ask, and its normal `intercom.reply` remains correlated to the originating child session and message ID. The parent chat or another session cannot satisfy the waiter. Late-message routing uses single-owner claiming: after the workflow post-mortem router claims a completed-stage ask and assigns its completion promise, later listeners preserve that claim, making bundled extension registration order irrelevant.

This reopens only the conversation. The workflow DAG and terminal stage snapshot remain completed and are never resumed or re-dispatched. If the target run or stage was deleted, lacks a valid retained conversation, is non-resumable, or fails to reopen, the caller receives a bounded actionable `intercom.ask` tool error instead of waiting indefinitely.


Workflow stage sessions and first-party subagent transcripts created inside them are classified as **internal** at creation and excluded from the standard `/resume`, `atomic -r`, `--continue`, and global history surfaces. Fork-context stages and subagents inherit the owning run/stage marker in their initial JSONL header, avoiding a briefly visible ordinary session. Workflow stage sessions remain resumable and inspectable through the workflow-specific commands and tool actions shown here (`/workflow resume`, `/workflow attach`, `workflow({ action: "status" | "stages" | "stage" | "resume" })`), which read the run/stage store and its `sessionFile` links directly. Subagent transcripts remain artifacts only; no workflow command revives their terminal child identities.

Passing a stage session's file path to `--session` still opens it explicitly. Classification requires exact `internal: true` plus complete run/stage metadata; malformed legacy markers and ordinary user forks remain in standard history. Legacy workflow sessions created before this marker behavior lack provable ownership and continue to appear until they age out.

## Lifecycle Notices and Human Input

Atomic emits deduplicated main-chat notices when top-level workflow runs complete, fail, end blocked, or stop at an active recoverable provider/auth/rate-limit block. A recoverable block remains resumable (`status` surfaces and headless results report it as blocked even though the stored live snapshot stays active), is retained durably as blocked for cross-session resume, appears in the resume picker, and its notice says the workflow **is blocked** rather than implying terminal completion. Each blocked occurrence is deduped by its `blockedAt` timestamp, so a resumed workflow that hits another recoverable block re-notifies the invoking chat. Nested child workflow outcomes are reflected inside the expanded parent graph instead of producing separate top-level cards.

Treat a blocked run as continuable by default; the blocked notice text itself carries this instruction. On a `WORKFLOW BLOCKED` notice or a blocked status, keep the work moving: resume a resumable block, answer the pending prompt, steer the stage past the obstacle, or start a follow-up workflow that carries the remaining tracked work past a terminal block — continue inline only if the remaining work is minimal. Stop for user input only when the task is so ambiguous that competing interpretations lead to materially different outcomes and judgment cannot infer intent from the stated objective and repository evidence; mine git history, commits, PRs, issues, and the user's own comments before asking. When `ask_user_question` or another human input channel is unavailable, continue fully autonomously on the interpretation best supported by that evidence, and record the assumption in the result or an artifact. A budget-exceeded stop (the resumable `budget_exceeded` blocked rail) is the exception, and its notice says so: the exhausted budget is a boundary someone chose, so summarize progress and the estimated next steps, ask the user whether to proceed — prefer the `ask_user_question` tool when it is available — and resume with a raised `budget` only after approval.

Previously, the streaming `persistWhenStreaming` path directly appended the visible card. It did not enqueue a native steer/follow-up or schedule a later model step. Therefore, an earlier provider context snapshot could finish with an uncorrected running claim.

Streaming lifecycle delivery now deliberately splits display from reconciliation. Before send admission resolves, Atomic appends one `display: true`, `excludeFromContext: true` lifecycle card to agent state and `SessionManager`; that same durable entry atomically carries the recovery marker for its hidden turn. Atomic separately submits the same raw notice text as a `display: false` internal reconciliation through the native steer boundary. This fixes the former direct-context race: a visible entry cannot become provider input between an assistant `workflow` call and its required `status=running` result, while a notice that arrives during final text still causes a later correcting step. The lifecycle path never aborts the active chat itself.

| Parent state when the notice arrives | Card and prompt transition | Invariants |
| --- | --- | --- |
| Idle | Commits the display card, then starts one native prompt with the hidden reconciliation. | Admission already includes the durable card; only the hidden copy enters model context. |
| Active between completed tool calls | Commits the card and queues the hidden steer for the next native provider step. | Existing completed tool ordering stays intact. |
| Active with the workflow tool result pending | Waits for earlier event writes, commits the context-excluded card, then lets the hidden steer follow the matching result. | Provider and reopened-file order remains assistant tool call → `status=running` tool result → lifecycle reconciliation. |
| Active final-text streaming | Commits the card without stopping the current text; the hidden steer then creates a safe continuation that can correct a stale progress claim. | The unrelated text finishes normally unless another caller aborts it, and an ordinary abort cannot clear the admitted reconciliation. |

The visible card preserves the lifecycle custom type, raw notice text, exact details payload (including omitted optional fields), and display behavior. Each deduplicated occurrence has exactly one visible/persisted lifecycle card; the internal reconciliation is hidden and persisted separately only after agent-core consumes it at the provider-safe boundary. If the process exits after card admission but before consumption, startup finds the unresolved marker and queues that hidden correction once; repeated startup binding skips an already queued intent, and the persisted hidden completion suppresses all later restores. Protection is registered before public card listeners run. Session replacement and shutdown fail closed while the hidden input remains queued, since persisting it before a pending tool result would break provider protocol order; host-owned invalidation work does not run on that failed teardown. A transient reconciliation write failure retries persistence without re-queueing model input or creating another card. Physical session appends restore the exact prior file length after a partial write failure, so a later card or reconciliation retry cannot inherit a malformed JSONL tail or phantom parent. Before session replacement or shutdown can discard consumed in-memory recovery state, Atomic flushes the reconciliation again; if that write still fails, disposal stops and keeps the current session recoverable. `clearQueue()` restores only protected references it actually removed, so a reference already drained into core-local in-flight state is not aliased. Stage-session delivery transfer moves protection only with transferred queued references and leaves in-flight ownership at the source. Delivery is acknowledged only after the display card append succeeds; while the invoking chat remains active, a rejected admission retains its original payload and retries with capped backoff even if the run changes state or notification configuration is reinstalled. Session replacement cancels those admission attempts and clears their payloads rather than waking an unrelated chat with an uninspectable old run. Awaiting-input workflow states are tracked for dedupe/restore, but they do not enqueue main-chat connect cards or wake the model; prompt state remains visible through workflow status/connect surfaces.

When an active recoverable block is resumed in-process, Atomic dispatches a fresh-ID continuation that replays the source's completed stages and re-runs the failed one. The durable source is left untouched (stays `blocked`/resumable) so it remains discoverable and recoverable, including a zero-checkpoint first-stage block, if the process dies before the continuation settles. The local source snapshot is killed when that continuation is admitted, so this session has one active run. A fail-closed topology mismatch puts the blocked snapshot back so the same session can retry. A process-local claim prevents a concurrent same-session double-dispatch.

Completed top-level `ctx.tool` nodes also replay into the fresh run. See [`ctx.tool` — durable cached tool execution](#ctxtool--durable-cached-tool-execution). A fail-closed topology mismatch ends that continuation; the durable source stays blocked and resumable, and the same session can retry after the continuation settles.

Deliberate control actions on a top-level run report themselves too. `/workflow <name>` emits a `WORKFLOW STARTED` notice (`▶`), `/workflow pause` a `WORKFLOW PAUSED` notice (`⏸`, warning tone), `/workflow quit` a `WORKFLOW QUIT` notice (`⏹`, warning tone, carrying a `resumable` field), and `/workflow resume` a `WORKFLOW RESUMED` notice (`▶`). All four travel the same steer delivery, capped-backoff retry, and notice-card path as the failure notice. The paused and quit text states that the stop was deliberate and user-requested and tells the model not to resume the run or take the work over unless asked, with `/workflow resume <run-id>` as the card hint; the resumed text does not, because the run is progressing again.

**Only user actions notify.** The equivalent `workflow({ action: "run" | "pause" | "quit" | "resume" })` tool calls stay silent: the tool result already tells the agent what it just did, and a second steer would spend a turn repeating it. `/workflow interrupt` raises no notice at all. Engine-internal transitions are silent for the same reason a notice must name an actor to exist — answering a human-in-the-loop prompt resumes the run internally, and reporting that would both flood the chat and defeat the deliberate decision that `awaiting_input` never wakes the model.

**Two attributions.** *Origin* is who launched the run and renders on every kind as "which you started" or "which the user started"; it is set once at dispatch, persisted through session restore and durable resume, and inherited by a continuation from the run it continues. *Actor* is who performed this one event and renders as "The user paused" or "You paused". They differ routinely — the agent starts a run and the user quits it. A run with no recorded origin, including a legacy or restored snapshot, omits the clause entirely rather than guessing.

**One notice per request.** A whole-run pause or resume reports at run scope. A stage-scoped `/workflow pause <run> <stage>` that leaves other stages running reports at stage scope, and one that stops the last active stage reports the run instead — never a stage card and a run card for the same request. A quit reports only the quit, never the pause it publishes on the way. Because control actions are reversible, these notices are deduplicated by run id *and* the occurrence timestamp, so pause → resume → pause → resume emits four notices while repeated snapshot invalidations at one unchanged state emit one. Resuming reports a resume and never a start, whoever asked for it — a resumed run re-enters the dispatch path, so keying that on the resume rather than on the requester is what stops an agent-requested resume of a user-started run from being announced as a fresh launch. Resuming a failed or blocked run launches a continuation under a fresh run id, and its notice names both ("run 4d7e, continuing run 8c31"); resuming a quit run reuses the original workflow id so durable checkpoints replay, so that notice names the one id. A run that is already started, paused, or quit when notifications install — restore, replay, `/reload`, or a session-preserving reinstall — is seeded as delivered and stays silent, and nested `ctx.workflow(...)` child runs never notify at top level.

Configure lifecycle behavior with `workflowNotifications.enabled` (default `true`) and `workflowNotifications.notifyOn` (default `["started", "completed", "failed", "blocked", "budget_warning", "awaiting_input", "paused", "quit", "resumed"]`). A config that pins `notifyOn` explicitly keeps exactly the kinds it lists, so `notifyOn: ["failed"]` suppresses every control notice. `budget_warning` is delivered once per run and dimension through the same lifecycle-notice renderer.

**Heartbeats are separate from lifecycle notices.** A lifecycle notice reports a transition; a heartbeat reports that nothing has transitioned yet. While a top-level run is active, Atomic raises one `workflows:workflow-heartbeat` card per `startedAt + n × heartbeatIntervalMinutes` boundary, on the same queued-steer delivery (`triggerTurn`, `deliverAs: "steer"`, `persistWhenStreaming`) and the same notice-card renderer, under its own custom type. The cadence is per workflow definition — `15` minutes by default, `0` to disable — and is documented under [`heartbeatIntervalMinutes`](/workflows/api-reference#heartbeatintervalminutes). `workflowNotifications.notifyOn` selects lifecycle kinds only; it does not list or filter heartbeats. Heartbeats stop when the run reaches a terminal state: one idempotent cleanup pass drops its timer, its schedule, and any heartbeat still queued inside the scheduler, a later process discards those records rather than replaying them, and a card the parent's queue had already accepted is excluded from the model's context when it is read ([#1975](https://github.com/bastani-inc/atomic/issues/1975)).

Human input is runtime-only: call `ctx.ui.input`, `ctx.ui.confirm`, `ctx.ui.select`, `ctx.ui.editor`, or `ctx.ui.custom<T>` when the workflow needs a decision. No builder-level declaration is required or supported.

Human-in-the-loop prompts from `ctx.ui.input`, `ctx.ui.confirm`, `ctx.ui.select`, `ctx.ui.editor`, and `ctx.ui.custom<T>` appear as awaiting-input nodes in the workflow UI/graph viewer, not as ordinary chat modals. Workflow definitions do not declare HIL; runtime `ctx.ui.*` calls create prompt nodes. If the prompt lives inside an imported child workflow, it still appears in the same expanded parent graph so the user can focus and answer it without switching to a separate child status entry. When the attached stage has a pending prompt, its attribution banner is headed `AWAITING INPUT` and shows the full run id in a two-row identity block; the question and its options continue through the existing prompt UI below the banner.

Use `/workflow connect <run-id>` (or F2), then press Enter on the focused node or click a graph node to focus and open or attach it for local answers. Custom widget prompts mount inside the attached stage chat and must be completed interactively with the widget's `done(value)` callback.

When a workflow needs human input, answer in the graph viewer or attached stage chat when possible:

```text
/workflow connect <run-id>
/workflow attach <run-id> <stage-id-or-name>
```

Agents can answer primitive and structured pending prompts programmatically with `workflow({ action: "answer", ... })` only while the root workflow is nonterminal; use `promptId` when it is present in the stage details, and provide answer content with `response`, `text`, or `message`. Arbitrary custom TUI widget prompts intentionally refuse this path in iteration 1 because a generic `T` cannot be reconstructed safely from a non-TUI payload.

`ctx.ui.custom<T>(factory, options?)` reuses Atomic's TUI component path: the factory receives the same real `(tui, theme, keybindings, done)` types as extension `ctx.ui.custom`, and the workflow resumes with the value passed to `done(value)`. Use `options.label` for a safe display-only graph/status label and `options.replayIdentity` when widget semantics can change without the callsite changing. Do not put secrets in labels or replay identities; only a hash of the identity is stored, and label text is not part of replay identity. Both inline connected rendering and `overlay: true` mount in the graph viewer's attached stage chat: overlay is a placement hint rather than a capability request, so an in-stage `ask_user_question` — which always asks for an overlay — mounts, takes focus, and resolves like any other custom prompt. There is no nested host overlay above the graph chrome; the widget occupies the stage-chat custom-UI slot and `overlayOptions` / `onHandle` are not consumed there.

Prompt answers are replayable only while the source run remains in the live in-memory store. `StageSnapshot.promptAnswerState` is snapshot-safe metadata for continuation: `available` means a matching live answer can be replayed, `unavailable` means the matching prompt node exists but its private answer was purged, and `ambiguous` means multiple matching prompt nodes exist so Atomic asks again. The raw answer lives in a private `PromptAnswerRecord` ledger, is never written to snapshots or persistence, and remains resident in memory until the answer is cleared, the run is removed, or the store is cleared.

Prompt replay keys include the prompt kind, message text, select choices, input/editor initial value, custom prompt identity hash, and hashed author callsite, so changing any of those inputs may intentionally re-ask on continuation. An empty `ctx.ui.select(..., [])` has no answerable choices and throws before creating a prompt node. Arbitrary custom-widget answers cannot be supplied through `workflow answer`; focus the `custom` awaiting-input node in the interactive graph instead.

If the user answers a human-in-the-loop prompt in the workflow UI or stage UI broker, the stage receives the answer directly and the active main chat receives a display-only notice (`triggerTurn: false`, `excludeFromContext: true`) containing a concise answer summary. The notice is rendered for the user and persisted for audit, but it does not wake the model, enter LLM context, or authorize answering any other workflow prompt. Prompt answers sent by the main-chat `workflow` tool are suppressed from this notice because the tool result already informs the current turn.

When an interactive, non-schema workflow stage calls `ask_user_question`, Atomic waits for the stage's assistant turn to finish and then brokers the deterministic readiness question **“Are you ready to move on to the next stage?”**. This includes typed or freeform questionnaire answers reported as `details.answers[].kind === "chat"`: the assistant first gives its normal conversational response, then the stage becomes `awaiting_input` with `inputRequest.kind: "readiness_gate"` in workflow status and graph surfaces.

In this chat-answer flow, choosing the ready option completes the stage and releases dependent stages. Choosing the not-ready option keeps the stage open for a genuine stage-chat turn and brokers readiness again after that turn. A chat answer is never treated as an invisible stay decision. On the readiness gate, **Type something.** sends the typed text as the next stage-chat message (empty or whitespace-only text cannot be submitted). **Chat about this** is a plain option — it does not open an inline editor — and stays by sending `The user would like to chat more about this`.

The readiness prompt can be answered in the attached stage UI or with `workflow({ action: "answer", ... })`. Ordinary structured-option answers retain their existing readiness behavior. A schema-backed stage that has successfully finalized through `structured_output` is terminal and does not reopen this readiness gate.


## Durable Workflows and Cross-Session Resume

Atomic workflows use **DBOS/Postgres as their sole persistent workflow backend**. Atomic configures and launches DBOS lazily on the first workflow action, reuses that process-wide instance, and awaits readiness before workflow execution, resume, inspection, or deletion can access durable state. `DBOS_SYSTEM_DATABASE_URL` may select an existing database. Once DBOS is ready, query and write failures fail the workflow action and never switch backends.

**Zero-configuration local database.** Without `DBOS_SYSTEM_DATABASE_URL`, Atomic runs DBOS against its own embedded Postgres built from package-distributed binaries — no Docker daemon, system Postgres install, install lifecycle script, or first-run download. npm installations receive only their target runtime through the matching `@bastani/atomic-natives` platform leaf, and standalone archives contain only their target runtime, so both remain offline at runtime. Linux musl x64 and ARM64 use checksum-pinned PostgreSQL 18.6 Alpine/musl builds; existing platforms use PostgreSQL 18.4. Both are PostgreSQL major 18 and share the compatible `~/.atomic/postgres/v18` cluster layout on dedicated port `5439`. The first workflow action initializes the cluster once and starts `postgres` directly behind an opaque retained native process lease. Concurrent Atomic sessions may attach to the same cluster, and an abrupt process exit releases the lease without killing Postgres. During orderly durable shutdown, only the process holding that exact lease sends fast shutdown and waits for the retained process; attached or replacement clusters are left untouched.

**Running as root (Linux).** PostgreSQL refuses to run as UID 0, so a root Atomic process (containers, CI sandboxes, eval harnesses) resolves an unprivileged system account (`postgres`, `nobody`, or `daemon`) and keeps the cluster under `/var/lib/atomic-postgres` instead (a root home directory is untraversable for that account). Before any owner command runs, Atomic probes that candidate runner itself and accepts it only when it proves the account's exact UID, exact primary GID, membership in that primary group, and no root group; legitimate additional nonroot groups remain valid. The retained native direct-Postgres spawn also clears inherited supplementary groups before setting the primary GID and UID. When the embedded binaries themselves sit under an untraversable prefix (for example a root-owned `~/.nvm` global install), Atomic publishes and reuses one exact package-content runtime generation under a root-owned cache. Published runtime files remain readable/executable but not writable by the Postgres account. Runtime reuse and publication re-snapshot the current source, publication validates the deterministic path after rename, and source mutation, corrupt content, or setup-lease displacement fails closed without unbounded repair copies.

If embedded provisioning fails without leaving retained-process cleanup pending, Atomic tries DBOS's reusable `dbos-db` Docker container. If DBOS still cannot become ready, workflows **degrade to a process-local in-memory backend with a loud warning** instead of refusing to run: the run executes normally, but its state does not survive the process and `/workflow resume` after exit has nothing to restore. Fix the configured database or set `DBOS_SYSTEM_DATABASE_URL` to a working Postgres to restore durability.

**Multiple concurrent Atomic sessions.** Every Atomic process launches DBOS with a unique executor id, and running root workflows carry owner/heartbeat metadata. Once an active model stage has a session path, Atomic records that identity after the stage-start record and awaits the checkpoint before the first model use, then runs serialized, unref'd liveness checkpoints on a bounded 30-second cadence for the root and nested scoped workflows. Each accepted checkpoint refreshes root metadata; timers stop on every stage exit and cannot keep Atomic alive. A persistent checkpoint fault fails the active stage instead of disappearing in a detached timer. A stage that is shutting down drains the checkpoint still in flight rather than abandoning it, so a failure that lands after the model turn finished is reported instead of discarded, and a stage whose final durability checkpoint fails is recorded as `failed` rather than `completed` — its caller receives the error and its concurrency slot is released either way. **Running workflows are never resume targets**: a running row with a fresh heartbeat is hidden from every session's picker and refused by direct `/workflow resume <id>` — resuming a workflow that is executing elsewhere would double-dispatch it. Once the heartbeat goes stale (about two minutes after a crash), an exact inspection or the resume picker reports the workflow as `crashed`.

Within one Atomic process, DBOS writes stay ordered per durable root workflow. A slow or stalled write for one root does not block an independent top-level workflow from persisting its registration, reaching startup admission, or recording later checkpoints. Nested workflows share their durable root's write order. Process shutdown and explicit lifecycle drains still wait for every root.

When two sessions race to resume the same paused workflow, a durable first-writer-wins claim decides exactly one winner; the loser reconciles to the authoritative state and reports that the workflow changed while resume was pending.

### How it works

- **Only `ctx.*` blocks are checkpointed**: code outside `ctx.*` is not durable.
- **Durable side effects and graph nodes**: every `ctx.tool` invocation creates a tracked, non-chat graph node before its callback runs. Atomic flushes successful outputs and opt-in recoverable failure outcomes before exposing them, so resume does not repeat an already-settled callback. Tool nodes can appear before, between, after, or without model stages. An unfinished, aborted, or abandoned tool node has no replayable result and runs again on resume, while completed siblings stay cache hits.
- **Durable child identity before dispatch**: before a nested `ctx.workflow(...)` can run child code or a child side effect, Atomic persists and awaits a versioned boundary-start record containing its stable boundary and child run ids, root/parent ownership, source order and parents, composed replay scope, alias, workflow, lifecycle state, and a deterministic fingerprint of the definition plus exact validated inputs. Distinct-input parallel calls keep stable independent scopes even when restart reverses dispatch order; identical calls share that fingerprint and use their own ordinal. Replay validates and reuses that identity before allocating any UUID.
- **Symmetric nested scopes**: child effects stay stored under the durable root, while every child sees only its own local checkpoint view. Each nesting layer strips exactly one scope and never suffix-matches sibling or root data, so the rule composes at any depth.
- **Stable durable graph**: tool, stage, task, chain, parallel, and child-workflow checkpoints preserve stable source identity/order, parent DAG edges, actual status, owning-run/boundary metadata, timing, output summary, model, retained chat-session references, and exact `{ runId, stageId }` targets. Fresh-process resume and completed inspection reconstruct tool-only, nested-child, mixed, and parallel topology directly from DBOS.
- **DBOS-only discovery and exact inspection**: `/workflow resume`, `/workflows`, completed inspection, deletion, and targeted lookup hydrate/query DBOS. An explicit full run id on `status`, `stages`, `stage`, or `transcript` hydrates only that root when the current-session store misses; a no-id status listing stays session-local. Session JSONL remains only a chat transcript referenced by a current checkpoint; it is not a workflow catalog or discovery source.
- **Fail-closed compatibility**: prior local and pre-current records are not converted. A completed current-format child boundary created before boundary-start or invocation-fingerprint identity is accepted only when child checkpoints reciprocally prove the same root, parent run, boundary, child, and scope. Active records without a provable invocation fingerprint, and malformed, duplicate, stale, nonreciprocal, mixed, aliased, cyclic, orphaned, or unsupported topology, are hidden or refused before cache/control/child dispatch without inventing a child link or executing repair work.
- **Topology validation boundary**: authoring and discovery guidance cannot prove dynamic acyclicity. Runtime topology work must validate each materialized parent edge incrementally during execution and replay, and DBOS hydration must reject cyclic restored topology before exposing cache, control, or child dispatch.
- **Cross-session safety**: per-process executor identity, owner/heartbeat liveness on running handles, and claim-guarded status transitions prevent double dispatch when several Atomic sessions share the database.

**Privacy and retention.** DBOS persists workflow inputs, completed tool outputs, UI responses, stage outputs, and chat-session paths. Treat the configured database as sensitive. History does not automatically delete records by age or count; confirmed picker deletion removes inactive DBOS workflow state while preserving independent chat transcripts.

**Resume after editing a workflow.** Replay identity combines the workflow id with stable content hashes and call order. Child calls additionally bind the child definition to the exact validated input value, with a per-identical-invocation ordinal. Editing definitions, inputs, or `ctx.*` call structure can intentionally invalidate matches. Finish or delete retained runs before deploying incompatible workflow changes. Atomic refuses a stored child boundary whose fingerprint, replay scope, alias, workflow, ownership, source order, or parentage no longer matches instead of attaching it to the changed call site.

Durable `/workflow resume` preserves completed stage metadata, active-stage elapsed time, total run elapsed time, source order and parent edges, actual lifecycle status, nested ownership, and exact control targets. A completed nested boundary, its completed child stages, `ctx.tool` effects, and answered `ctx.ui` responses are cache hits; only incomplete child or downstream parent work continues. Raw stage-chat prompt answers represented by `StageSnapshot.promptAnswerState` remain live-memory-only and are not DBOS-persisted. While a model stage or task is active, Atomic persists its session identity as soon as the path exists and refreshes pause-adjusted duration plus root liveness at most once per serialized 30-second heartbeat. Nested stages route the same checkpoint through their scoped backend to the durable root. Graceful quit forces an exact stage and run timing checkpoint even inside the ordinary update bucket; normal completion also persists the final accumulated run total.

Each new Atomic process that reopens unfinished work starts from the latest saved baseline, so repeated process-boundary resumes keep stable boundary/child ids, status, graph, and lifecycle duration cumulative without double-counting pauses. A stage paused at ten seconds resumes at ten seconds, and the main-chat dashboard reports prior-session elapsed plus current-session elapsed. Completed inspection uses that same accumulated run timing rather than DBOS record wall-clock age.

Repeated, sibling, sequential, parallel, and multi-level child calls keep independent composed scopes and stable boundary order. The expanded graph routes attach, send, pause, interrupt, and resume through each stage's ordinary owning `{ runId, stageId}`. Resolution is exact: an expanded id, a local stage id, or a name must match whole, and colliding names return an ambiguity diagnostic rather than selecting the first match silently.

### `ctx.tool` — durable cached tool execution

The `ctx.tool(name, args, fn, options?)` primitive runs arbitrary TypeScript code as a first-class durable graph node and caches the result durably. The node is non-attachable and has no stage chat controls, and its graph card body is the constant `durable tool` in every state — status, timing, and dependency rows keep their own rows, and the card does not preview the result or error. In the graph viewer, focusing the node and pressing Enter, clicking it, or choosing it from the switcher opens a read-only host-style operator card from the snapshot: a status-tinted shaded rectangle with the same inner padding and header/body gap as the main-chat tool block, inset from the orchestrator header and footer bars, a `$ <tool-name>` call header, an optional short argument summary, and the result or error as its body. Running and completed call headers have no status marker; pending, failed, cached, and cancelled calls retain their quiet markers. It is collapsed by default and wraps the fully bounded result or error before showing its last visual rows, with `... (N earlier lines, ctrl+o Expand)` above the tail when the action is bound; the configured `app.tools.expand` action (`ctrl+o` by default) toggles the full bounded result or error and then a muted callback-source block when source exists. The graph statusline advertises the resolved expand key with `expand` or `collapse` alongside return-to-graph and scroll hints, including remapped keys, and omits that segment entirely when the action is unbound. The footer says `Took` for settled calls or `Elapsed` for running calls, using the same second-resolution duration as the main-chat tool block, with cached/replayed markers kept as a quiet suffix. The operator surface has no ARGS/RESULT/SOURCE/TIMING/MARKERS debug table and does not expose raw clock fields. Source capture uses `fn.toString()` at registration without re-executing the callback or reading a file. `↑`/`↓`, `PageUp`/`PageDown`, `Home`/`End`, the wheel, and the scrollbar all scroll the block, so a long payload stays readable on a keyboard-only session or a terminal without mouse reporting; Escape or `ctrl+x` returns to the graph. The message block is read-only and never offers chat attachment, steering, interrupt, or resume. Bounded payloads remain width-safe and mark truncation explicitly with `… [truncated]`; source tabs expand and control bytes become `\xNN`, while cyclic payloads, throwing `toJSON`, or throwing property getters render `<cycle>`, `<unserializable>`, or `<unreadable>` instead of crashing the view. The same cap applies to what the live run snapshot retains for a tool node, while durable checkpoints keep the exact output, raw-args `argsHash`, and replay behavior unchanged.

When the workflow body fulfills but one or more admitted tool calls failed, Atomic promotes the first observed failure to the terminal run failure, regardless of admission order, and persists that selected tool-node identity for status inspection and lifecycle output. A direct uncaught `await ctx.tool(...)` rejection keeps the original error and persists its failed-node link through session and durable restore. First-event arbitration also preserves the selected node when concurrent failures throw the same object or primitive; unrelated later stage or body errors do not inherit a caught tool's origin. Tool admission remains open while author code can catch a failure and continue. Once the body settles and failure has won before any real cancellation, Atomic closes admission, cancels remaining non-failed tool nodes, waits for observed failed nodes to finish publication, and publishes the failed root without waiting for callbacks that ignore cancellation.

Set `failureMode: "return"` when a failed check is expected data for a later repair stage. Atomic runs all configured retries first, then returns a `WorkflowToolOutcome<TValue>`. A successful callback returns `{ ok: true, value, attempts, cached }`. An exhausted callback failure returns `{ ok: false, error, attempts, cached }`; `error` preserves integer `exitCode` and string or byte-buffer `stdout`/`stderr` when the thrown value exposes them. The live and restored tool node stays `failed`, while the workflow body may continue and complete. On replay, Atomic returns the same stored outcome with `cached: true` and does not run the callback again.

On a fresh-ID continuation, completed top-level `ctx.tool` nodes replay into the new run and keep their graph identity as parents of downstream stages, including concurrent `Promise.all` fan-out. A `failureMode: "return"` checkpoint, success or `return_failure`, is reused as the recorded outcome rather than re-running the callback. A later fresh-ID hop reuses that result only when the intermediate run republished the checkpoint under its own id. That republish is best-effort; if it does not land, the next hop runs the callback again.

Start a new run, or change the tool name or args, to force a completed return-mode callback to execute again. A continuation will not. Inspection-only `tool-failure:` throwing records stay out of the replay cache, so those calls run again. Completed child stages replay; incomplete siblings follow their ordinary continuation policy. When the source checkpoint has topology, a fresh-ID continuation fails closed if it admits a live parent the restored set does not include. Replayed siblings that settle before the next sibling spawns still keep the source parents, including concurrent root-level tools with no seed stage. A topology-less checkpoint skips that check and infers parents on the continuation. A fail-closed mismatch ends the continuation; the blocked source stays resumable in the same session, including its recorded prompt answers and BLOCKED notice, and no terminal source entry is persisted. `/workflow resume` can be retried without asking those questions again. After a non-mismatch continuation settles, Atomic persists the superseded source as terminal so a rebuilt session cannot resurrect it.

Recoverable output is explicit data flow. Atomic does not add a failed tool outcome to a later stage prompt. The workflow author must place the needed fields in `prompt`, `previous`, an output, or an artifact. Each persisted error text field is best-effort secret-redacted with the workflow persistence rules and limited to 16 KiB of UTF-8; truncated fields keep the final bytes with a marker. Keep the database sensitive even with this filter.

Cancellation, closed tool admission, and durable-storage faults still throw. They never become ordinary `{ ok: false }` callback outcomes. Omitting `failureMode: "return"` also keeps the existing behavior: an exhausted callback error rejects `ctx.tool` and fails the workflow unless author code catches it. Atomic persists that failed node and the root's selected tool link for later inspection, but excludes the failure record from the replay cache, so a resume or rerun calls the function again. Command failures that expose `exitCode`, `stdout`, or `stderr` remain failures even when a wrapper also uses cancellation-like text or codes; only a real run cancellation that wins the terminal race produces a killed/cancelled root.

**Per-node cancellation and per-attempt deadlines.** Each logical `ctx.tool` call runs under its own `AbortController`, combined with the run's signal and handed to the callback as `{ signal }`. A run abort cascades to every live node; `workflow({ action: "quit"|"interrupt", runId, stageId })` naming one tool node aborts exactly that node and leaves its siblings alone. Without `timeoutMs`, retries share that logical call signal. With `timeoutMs`, every attempt gets a fresh signal and deadline; expiry aborts that attempt and becomes an ordinary attempt failure, while run cancellation and operator abort remain cancellation.

A cancelled call is recorded as `cancelled`, not `failed`, and is never a run failure by itself: it writes no replayable `tool:` checkpoint and no `return_failure` outcome even under `failureMode: "return"`, so a cancellation can never replay as data. Return mode does keep exactly one inspection-only `tool-failure:` record carrying the cancellation message, written for every cancellation timing — while the callback awaits, when the callback throws, and when the callback fulfills after the abort but before persistence. That id is excluded from replay lookup, so `getToolCheckpoint()` still misses and the call runs again. A callback that ignores its signal and returns late is caught before persistence, so its value cannot become a checkpoint either. Resume recomputes the same ordinal and `argsHash` from authored order, so the re-run occupies the same `tool:<argsHash>` graph node instead of creating a new one.

Tool admission stays open while the workflow body runs and while already-admitted tools drain, including immediate promise-settlement continuations. Before any completed, failed, blocked, exited, or cancelled executor outcome is published, admission closes atomically. A detached call through a retained `ctx.tool` function after that point returns a rejected native promise without starting its callback, retries, graph node, or durable checkpoint; ignoring that promise does not emit an unhandled rejection.

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

### `/workflow resume` — cross-session resume selector

The `/workflow resume` command mirrors `/resume` ergonomics and `/workflows` is its alias. With no id, it builds one newest-first picker from live runs that satisfy the shared resumability predicate and current DBOS resumable/completed records. DBOS is the authoritative catalog; selected records are hydrated and revalidated before resume or inspection. Running workflows never appear: fresh-heartbeat rows are excluded in every session to prevent double dispatch, and stale ones surface as `crashed`. A row whose durable checkpoint or referenced artifact is missing is not resumable and is omitted rather than offered and rejected later. Naming such an id explicitly still produces the existing clear no-checkpoint/not-resumable error.

The resume picker lists only runs the resume path would actually accept. One shared predicate (`isWorkflowRunResumable` in `packages/workflows/src/durable/resume-eligibility.ts`) backs both the picker and the `resume` command, so a row can never be offered and then refused. A run stops being resumable when it reaches a terminal state without a durable checkpoint or pending prompt progress, when its durable entry is explicitly deleted with Ctrl+D, or when its referenced artifacts are gone. The broader `connect`/`attach` pickers and `/workflow status` keep listing terminal runs for inspection; only `resume` is filtered.

Rows carry semantic colors — completed green, paused yellow, failed/blocked/crashed red — and show checkpoint progress without the redundant pending-prompt count. The open picker live-updates on local run changes plus a bounded cross-session poll, so state transitions appear (and freshly running workflows disappear) without reopening it.

Ctrl+D deletes a highlighted inactive durable or completed row after confirmation. Deletion rechecks same-process activity and the authoritative DBOS status, refuses a `running` workflow, and leaves host and stage chat transcripts untouched. The history surface matches `/resume` retention semantics: eligible runs remain searchable regardless of age or count. Aged-out history is driven by the state-aware `WORKFLOW_ARTIFACT_RETENTION_MS` policy: only terminal or unowned directories older than the policy are pruned, and pruning deletes the durable entry first, removing the artifact directory only when that deletion succeeds — a refused or unavailable deletion preserves both. Running, paused, quit, blocked, and awaiting-input runs retain their artifacts and durable records so they remain resumable. The picker mounts before asynchronous catalog hydration completes and merges DBOS rows when ready.

Only current-format DBOS records are selectable. Atomic hides unsupported or malformed records without reinterpreting them.

Selecting a paused, resumable failed, blocked, or crash-recovery target follows the existing resume path unchanged: Atomic re-dispatches the workflow with its cached inputs and the **original workflow id**. Every nested invocation validates and reuses its durable boundary and child identity before dispatch. Previously completed `ctx.tool`, `ctx.ui`, stage/task/chain/parallel items, and child boundaries replay from checkpoints instead of executing again; only incomplete work continues.

A run quit while a `ctx.tool` call was in flight resumes the same way: the unfinished call left no replayable checkpoint, so resume re-executes exactly that callback at the same ordinal and `tool:<argsHash>` node id, while every completed tool — including a sibling that finished before the quit — replays from cache. A cancelled node never replays a cancellation as a value.

Selecting a completed target—or a checkpointed failed target marked non-resumable—follows a separate read-only open path. Atomic reconstructs root and reciprocal nested child-run snapshots from authoritative checkpoints, remaps persisted source-stage, boundary, and tool references into a stable expanded hierarchy, and never calls the resume dispatcher or runs workflow code, tools, tasks, or prompts. These graphs remain inspectable even when no retained chat transcript survives, including tool-only graphs.

A terminal child stage with a valid retained session may be reopened for detached post-mortem conversation through `/workflow attach` or completed graph inspection. Follow-up is routed to that real child `{runId, stageId}` and may append chat, but it cannot pause, resume, retry, mutate root or child execution state, write a terminal checkpoint, or emit a duplicate lifecycle notice. Tool nodes never offer chat attachment.

New tool checkpoints persist topology. A current-format tool checkpoint created before that additive topology existed still replays safely: its cached output remains authoritative and its callback is never rerun. Root-level inspection derives deterministic fallback identity/order from checkpoint identity and record order. If a topology-less cached tool replays inside a child workflow, Atomic first appends awaited topology metadata with the current child/boundary ownership, without replacing the original output checkpoint. Foreign or malformed checkpoint formats remain excluded.

Fresh completed inspection does not currently persist the workflow's declared root output. Live `run()` results still expose the declared output, and this output-persistence limit does not block durable tool topology or read-only graph inspection.

```text
/workflow resume                          # Mixed picker: resumable + completed
/workflow resume <full-workflow-uuid> # Resume unfinished work or open completed detail/chat
/workflows                               # Alias for the same mixed picker
/workflows <full-workflow-uuid>        # Alias for targeted resume/open
```

Targets resolve across top-level live, resumable durable, and completed entries as one namespace, matched by full UUID only. An exact loadable paused top-level live target resumes directly from in-session state without enumerating the durable completed-history catalog; this keeps explicit live resume responsive even when retained durable history is large and preserves live-over-durable precedence for duplicate IDs. If a stale or concurrent catalog view presents the same failed root as both resumable and read-only history, the resumable durable target wins. Nested child runs remain excluded from this top-level target namespace even when addressed by an exact ID.

The non-interactive `workflow` surface uses exact targeted DBOS lookup for explicit ids. `resume` loads workflow resources, queries and revalidates the authoritative resumable record, then claims and dispatches only when the caller explicitly requested resume. `status`, `stages`, `stage`, and `transcript` hydrate one exact missing-local root into an isolated read-only snapshot and never dispatch. This targeted path does not change `workflow({ action: "status" })` without a run id: an empty session-local listing neither scans DBOS nor implies that DBOS deleted the workflow.

A target that is not a full UUID is rejected before the combined catalog is consulted, so a truncated id never reaches durable lookup. Read-only inspection behavior is otherwise unchanged. A current completed or non-resumable failed backend row with valid graph checkpoints remains inspectable even if every retained stage conversation is unavailable. Missing, empty, directory, context-empty, or partially malformed transcript paths are stripped from chat attachment while the graph stays read-only and visible.

Validation uses the final retained transcript for a repeated stage replay key, so an obsolete superseded checkpoint path does not hide an otherwise valid read-only graph. Reopening inspection refreshes a changed authoritative retained-chat handle. Session-cache-only rows are hidden because the backend is authoritative. Checkpointed non-resumable failed roots appear only in read-only history; cancelled, killed, blocked non-resumable, failed roots without saved progress, and other terminal non-success states are never added. Normal `/resume`, `atomic -r`, and `--continue` behavior for internal workflow stage sessions is unchanged.

### Cancellation, failure, and retry semantics

| Scenario | Behavior |
| --- | --- |
| **Internally cancelled workflow** | Marked `cancelled` in durable state and excluded from `/workflow resume` discovery. Start a new workflow run if you intentionally want to retry cancelled work. |
| **Stage failure (recoverable)** | Workflow marked `failed` or `blocked` and remains resumable by default. `/workflow resume <id>` continues from the last completed checkpoint unless durable metadata explicitly sets `resumable: false`. |
| **Stage failure (non-recoverable)** | Workflow marked `failed` or `blocked` with `resumable: false`, so it cannot resume execution. A failed root with saved checkpoint progress may still appear in read-only history for inspection; a blocked root does not. |
| **Process crash** | Workflow remains `running` in durable state. Exact-id status/inspection reconstructs its retained checkpoint DAG as `crashed` once the owner heartbeat is stale and shows whether explicit resume is available. `/workflow resume <id>` is still required to claim the root and continue from the last completed checkpoint. |
| **`ctx.tool` retry/default failure** | When `retriesAllowed: true`, the tool function is retried with exponential backoff. Cancellation is checked before each attempt, during retry backoff, and through the callback's own `signal`. Without `failureMode: "return"`, an exhausted callback error propagates and the workflow fails. |
| **Recoverable `ctx.tool` failure** | With `failureMode: "return"`, exhausted callback failures are durably returned after retries. The tool node remains failed, downstream handoff is explicit, and replay returns the same outcome with `cached: true`. Cancellation and storage faults still throw. |
| **`ctx.tool` node quit/interrupt** | `quit`/`interrupt` with a tool node id or name aborts that call's signal, marks the node `cancelled`, and leaves sibling stages and tools running. The action returns `status: "cancelled"` with the separately observed `workflowStatus`; it never reports the run as paused. No replayable `tool:` checkpoint and no `return_failure` outcome are written — return mode writes only inspection metadata — so resume re-runs exactly that call at the same ordinal and node id. |
| **Run quit with in-flight tools** | Quit closes tool admission after stage pauses acknowledge, rescans every root/nested node, aborts that set, and waits a bounded interval before recording the durable paused/resumable transition, so the run is not declared quiesced while a callback still runs and no late call can slip in. A tool-only run pauses as resumable instead of reporting no controllable stages. A call attempted after the close is refused with the graceful-quit signal. Catching the cancellation in workflow code cannot turn the quit into a completed run. |
| **Abandoned `ctx.tool` callback** | A callback that ignores its abort signal is abandoned after the bounded wait: quit proceeds, the node is published as `cancelled`, each abandoned call is reported as an owning `{runId, nodeId}` identity, and the stale background job is detached so resume relaunches a fresh executor under the same workflow id. A late return from that callback is discarded before persistence, cannot become a checkpoint, and cannot mutate or unregister the replacement run. |
| **`ctx.ui` pending prompt** | If a UI prompt was not answered before interruption, resume leaves off on that prompt — the user must answer it to continue. |

### Configuring DBOS/Postgres

**Linux musl and Windows ARM64.** Linux musl x64 and ARM64 npm installations and standalone archives carry genuine Alpine/musl PostgreSQL 18.6 runtimes, rather than the glibc-linked `@embedded-postgres/linux-*` binaries. Windows ARM64 carries PostgreSQL 18.4 x64 and runs it through Windows 11 ARM64's built-in x64 emulation; this is not native PostgreSQL ARM64. It requires Windows 11 and the Microsoft Visual C++ x64 v14 Redistributable (Microsoft's x64 installer also includes ARM64 components). Windows 10 on ARM supports x86 but not x64 emulation and is unsupported. CI executes the complete `initdb` → start → connect → clean shutdown path on stock Alpine for both musl architectures. The repository has no Windows ARM64 runner, so package selection, Portable Executable architecture, and payload contents are verified there, but the emulated runtime path still requires Windows ARM64 hardware validation.

Set `ATOMIC_POSTGRES_RUNTIME_DIR` to a complete extracted runtime containing `bin/initdb`, `bin/pg_ctl`, and `bin/postgres` to override packaged runtime discovery, including in air-gapped deployments. Otherwise DBOS/Postgres durability requires no setup on supported local platforms. To use an existing Postgres database, set `DBOS_SYSTEM_DATABASE_URL` before starting Atomic; that explicit URL retains precedence over embedded provisioning. Atomic provisions embedded Postgres next (with drop-privilege support when running as root on Linux), then Docker as a platform fallback. If no durable backend can be provisioned, workflows run on a process-local in-memory backend with a loud non-durable warning — never on the legacy per-workflow file store under `~/.atomic/workflow-durable` — and cross-process resume is unavailable until Postgres provisioning is fixed.

```bash
export DBOS_SYSTEM_DATABASE_URL="postgresql://user:password@localhost:5432/atomic_dbos_sys"
```

When `/workflow resume` lists or resumes a DBOS-backed workflow in a fresh process, Atomic first hydrates its in-memory replay mirror from DBOS. Atomic stores checkpoints as structured, versioned DBOS outputs containing the checkpoint kind, id, tool argument hash, UI prompt hash, stage replay key, completed output, and additive versioned stage-topology metadata when available, so replay can skip completed `ctx.tool`, `ctx.ui`, `ctx.stage`, `ctx.task`, `ctx.chain`, `ctx.parallel`, and `ctx.workflow` work without relying on prior in-process state and completed inspection can rebuild the original DAG.

Atomic updates the in-memory replay mirror for awaited DBOS checkpoints only after DBOS accepts the write, and root metadata is mirrored as versioned DBOS records where the latest timestamp wins during hydration. Unmarked raw-output checkpoint records remain readable as generic stage checkpoints when their workflow has compatible current metadata; marked envelopes with unsupported envelope versions are ignored rather than decoded as raw output, while unsupported or malformed additive topology fields are ignored without dropping an otherwise valid stage envelope.

Atomic does not use the legacy file backend under `~/.atomic/workflow-durable`; cross-session `/workflow resume` reads DBOS only.

## Workflow Locations

Atomic discovers workflow definitions in this order:

| Location | Scope | Notes |
|----------|-------|-------|
| `.atomic/extensions/workflow/config.json` | Project | `workflows.<name>.path`; project entries override global entries |
| `.atomic/workflows/*.{ts,js,mjs,cjs}` | Project | Legacy `.pi/workflows/` is also checked |
| `~/.atomic/agent/extensions/workflow/config.json` | Global | `workflows.<name>.path` for user-wide configured paths |
| `~/.atomic/agent/workflows/*.{ts,js,mjs,cjs}` | Global | Legacy `~/.pi/agent/workflows/` is also checked |
| Installed Atomic packages | Package | Uses package metadata or conventional `workflows/` directories |
| Bundled workflows | Built-in | Shipped with `@bastani/atomic/workflows` |

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

Run `/workflow reload` after adding, editing, renaming, or deleting workflow modules or changing workflow config. Reload rescans project and user conventional directories, legacy `.pi` locations, configured file/directory paths, and package resources without restarting Atomic. The workflow tool's `reload` action uses the same in-process path.

Reload builds a complete replacement registry before publishing it. Concurrent requests are serialized and coalesced, stale discovery from an earlier session cannot overwrite newer state, and a fatal refresh failure retains the previous registry. Reload is safe while workflows are running: existing runs keep the definition and runtime snapshot they started with, their mounted `BACKGROUND` card and live tool-node metadata keep updating in place, and subsequent list/get/inputs/help/completion/invocation calls use the newly published registry.

The top-level `/reload` command replaces the extension generation as well as rediscovering resources. Within the same Atomic process, the replacement workflows extension adopts the current session's run store and control registries before installing its UI, then remounts the below-editor panel from the adopted snapshot. In-process subagent children keep bundled workflow definitions as resources but do not load the workflows extension or expose its tool, so a child cannot rebind the parent's store. If an older extension generation already displaced a live run into an auxiliary session scope, `/reload` reclaims that live store together with its stage, job, cancellation, tool-control, and prompt owners; retained terminal history from the parent scope is merged before the panel remounts. Newly created session scopes never inherit another session's state. Installed builds can evaluate the extension and host SDK through separate jiti module copies; Atomic canonicalizes each generation's `pi.events` facade through a process-shared session-bus map so both copies adopt the same owners. In-flight `ctx.tool` callbacks and their durable node controls remain owned by that live run and may settle normally after reload; completed siblings remain checkpointed. A run or active tool node can also arrive after the UI is installed through durability hydration, which invalidates the store and mounts or updates the panel immediately. This same-process handoff differs from a process crash: after a real process exit there is no live callback to preserve, so explicit `/workflow resume` replays checkpoints and re-executes only unfinished tool work.

After `/reload` invalidates the predecessor extension API, in-flight runs keep executing on that generation's module graph. Transcript appends from the captured persistence port are advisory: a stale-extension-context error is ignored so the run can complete, and any other persistence error still fails the run.

The `/workflow` argument-completion popup reads that same live registry. Project, user, package-provided, and built-in workflow names therefore appear immediately after reload both after `/workflow ` and after `/workflow inputs `; restarting Atomic is not required.

A successful rescan may still contain per-resource diagnostics. Both reload surfaces show `CONFIG_INVALID`, `IMPORT_FAILED`, `INVALID_DEFINITION`, `PATH_NOT_FOUND`, and duplicate-name diagnostics instead of reporting bare success while silently skipping a resource. Valid sibling workflows remain available. Fix the reported source/path and reload again; no process restart is required.

## Run budgets

Set an optional `budget` on workflow extension config, an authored `workflow({...})` definition, a `workflow({ action: "run" })` tool call, or a `workflow({ action: "resume" })` continuation to raise or narrow the ceiling. Each field resolves independently: run override, then definition, then config default. An omitted field falls through; a present `0` disables that dimension.

Budgets are operator-selected. Atomic's agent guidance treats "no budget" as the correct default: the agent passes a `budget` on a `run` or `resume` call only when you asked for a limit, and otherwise omits the field so the definition and config resolve normally. A cap the agent invented would stop an otherwise healthy run at a duration, token, or cost boundary you never chose, and the stop reads as a workflow failure rather than as an added override. When you do state a limit, only the fields you named are passed; the rest keep falling through.

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

`maxDurationMs` is enforced at stage and durable-tool boundaries, and again immediately after a completed `ctx.task` persists its result checkpoint. Elapsed run time excludes paused time and resumed runs carry prior elapsed time. If that post-task boundary finds the duration ceiling already exhausted, the root becomes a resumable `budget_exceeded` block instead of remaining raw `running` with no active or control node. When every authored task in `ctx.parallel(..., { failFast: false })` reaches that boundary together after persisting a complete result, Atomic waits for the tasks to settle and deterministically uses the earliest authored exhausted task as the resume frontier rather than replacing the budget stop with a generic parallel failure. A raised-budget resume then replays those completed task results without rerunning their models and continues after the parallel barrier. If any authored parallel task was still pending at exhaustion, or any task instead has an ordinary failure, the existing aggregate-failure behavior wins. A root still awaiting that task-result persist remains quit/interrupt-controllable and is not diagnosed as a stranded root; aborting it after the persist has already started does not leave an unobserved checkpoint rejection or block durable finalization behind the original write. Catching that rejection in workflow code and returning outputs does not overwrite the requested pause. Exact-id quit or interrupt of a nested task tail quits the aggregate root so the parent snapshot and durable handle do not stay raw `running`. A later resume reuses a completed task result or, if only the terminal stage checkpoint exists, that complete `WorkflowTaskResult` including the exact persisted text (schema-backed `maxOutput` truncation included), primitive structured values such as `null`, generated worktree artifacts, warnings, session, and model metadata, without rerunning the model. Exact `workflow status <id>` uses the live tool-control registry and reports the same stranded-root diagnostic as the listing. Same-process DBOS hydration rejects unknown checkpoint history instead of skipping it. `maxTokens` counts uncached input plus output tokens across the complete run tree, including nested children and stage retries; cache reads and writes remain reported counters and `maxCost` charges the summed `usage.cost`. A `budget_warning` lifecycle notice is emitted once per run and dimension at `warnAtPercent` (default `80`); exhaustion gives an already-live frontier stage one current-turn wrap-up, then records a resumable `budget_exceeded` blocked result with its reading, ceiling, frontier, wrap-up summary, and the wrap-up turn's own `wrapUpUsage` when model usage is available. No new stage is created just to host a wrap-up; when no stage turn is live at the exhausting boundary, the run stops with no wrap-up summary and leaves the once-per-run delivery allowance unused. A resumed run carries prior duration, token, and cost spend without double-charging replayed completions; pass a raised resume budget to continue with the prior spend. Nested child budgets meter only their subtree while the root meter still includes child spend, and a child-only exhaustion returns to the parent as a blocked child result while the parent continues.

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
  "defaultConcurrency": 4,
  "maxDepth": 4,
  "budget": { "maxDurationMs": 0, "maxTokens": 0, "maxCost": 0, "warnAtPercent": 80 },
  "persistRuns": true,
  "statusFile": false,
  "resumeInFlight": "ask",
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
| `defaultConcurrency` | `4` | Default concurrency for authored `ctx.parallel(...)` execution |
| `maxDepth` | `4` | Maximum workflow nesting depth |
| `budget` | `{ maxDurationMs: 0, maxTokens: 0, maxCost: 0, warnAtPercent: 80 }` | Default per-run budget declaration; `0` disables a dimension; warnings default to `80` percent |
| `persistRuns` | `true` | Persist run metadata for status/resume/history |
| `statusFile` | `false` | Write a derived status file; defaults under `.atomic/workflows/status.json` when enabled |
| `resumeInFlight` | `"ask"` | Behavior when discovering resumable in-flight work |
| `workflowNotifications.enabled` | `true` | Emit workflow lifecycle notices into the active main chat |
| `workflowNotifications.notifyOn` | `["started", "completed", "failed", "blocked", "budget_warning", "awaiting_input", "paused", "quit", "resumed"]` | Lifecycle states to track; terminal `completed`/`failed`/`blocked` outcomes, active recoverable blocks, duration budget warnings, and the user-initiated `started`/`paused`/`quit`/`resumed` control actions on a top-level run create main-chat notices, while `awaiting_input` is tracked for dedupe/restore without waking the main agent |
| `worktree.symlinkDirectories` | `["node_modules"]` | Main-root directories symlinked into each runner-managed temporary worktree during post-creation setup |

Invalid JSON or invalid shapes produce `CONFIG_INVALID` diagnostics. Missing config files are ignored.

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
