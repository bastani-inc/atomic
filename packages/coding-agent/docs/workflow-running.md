# Run, monitor, and control workflows

Launch named or one-off workflows, inspect their graphs and transcripts, answer human-input prompts, and use non-destructive control surfaces without polling loops.

> **Security:** Workflow definitions and their stages run with the permissions available to Atomic and may execute tools or package code. Run only trusted definitions and packages. Git worktrees isolate checkout state and working directories, not operating-system access; use a container, VM, or another OS-enforced boundary for untrusted code.

### Launching with natural language

You can also kick off a built-in workflow by describing the task in chat. Atomic picks the matching workflow and fills in inputs from your request:

```text
Run a deep codebase research workflow on how the rate limiter behaves under burst traffic.
```

```text
Use the goal workflow to implement specs/2026-03-rate-limit.md, run the focused rate-limit tests, finish only when burst traffic returns 429 with Retry-After, and cap it at 5 turns.
```

```text
Use the ralph workflow to research a database-layer migration, implement it, review it, and set `create_pr=true` for final-stage PR handoff.
```

```text
Run open-claude-design to refresh the settings page hierarchy as a page.
```

If required inputs are missing or ambiguous, Atomic will either ask or open the inline input picker before launching.

### Monitor and steer a built-in run

Named runs go to the background. Common controls:

```text
/workflow status                       # list retained active and terminal runs
/workflow connect <run-id>             # graph viewer, including terminal runs
/workflow attach <run-id> <stage>      # chat with a single stage
/workflow interrupt <run-id>           # pause resumably
/workflow resume <run-id> [stage] msg  # forward a steer message and resume
/workflow quit <run-id>                # pause gracefully and keep the run resumable
/workflows [run-id]                    # retained alias for /workflow resume (history picker)
```

`/workflows` (plural) is a retained alias for `/workflow resume`. With no argument it opens the DBOS-backed resume/history picker; with a run id it resumes that run directly. Ctrl+D deletes a highlighted inactive durable or completed row after confirmation. Deletion rechecks same-process activity and the authoritative DBOS status, refuses a `running` workflow, and leaves host and stage chat transcripts untouched.

The history surface matches `/resume` retention semantics: eligible runs remain searchable regardless of age or count, with no automatic history garbage collection. DBOS/Postgres is the only workflow catalog, so listing, targeted lookup, completed inspection, and deletion query current database records directly. The picker mounts before asynchronous catalog hydration completes and merges DBOS rows when ready.

Graceful quit is idempotent for an already-paused resumable run. If a run is waiting on `ctx.ui`, quit preserves its current DBOS prompt reservation. Answers cannot advance paused workflow code until explicit resume; checkpointing the answer releases exactly that reservation generation. Concurrent and nested prompts use composed scopes and independent DBOS reservation tokens.

When a paused stage is resumed, whether or not the resume includes a message, Atomic first lets the stage answer any non-empty resume message and then (if the stage has not already finalized) injects `Continue where you left off. If you believe you are finished with your original task (or a redefined task if the user told you), stop.` into the same stage session before normal stage completion/readiness handling. This re-drives an interrupted no-message resume before result harvesting, keeps interrupted work moving without asking you to type a continuation prompt, and prevents stages that already finished their scoped work from overstepping.

The same continuation applies to user messages queued into a live streaming stage. Steering a turn (Enter in an attached stage chat), queueing a follow-up (Ctrl+F), or using `workflow({ action: "send" })` with `steer`/`followUp` delivery arms the identical continuation prompt, which Atomic injects once when the interrupted turn ends — even if several messages were queued during that turn — so a steered stage returns to its original (or user-redefined) objective instead of stopping after answering the queued message. Messages delivered to an idle stage start a fresh user turn and receive no continuation nudge, and the injection is suppressed for aborted runs and finalized or fail-fast-skipped stages.

When several paused stages resume together, Atomic settles every acknowledgement and then re-reads the actual stage/control state. A late rejection after its stage visibly starts counts as resumed and is not retried; genuinely paused failures remain available for a later resume. The run and durable root follow visible running work, while slash/tool output reports acknowledgement or durable-transition failures as partial progress instead of a no-op. If local resume succeeds but persisting the durable running transition fails, a later resume request retries reconciliation while the durable handle remains paused. A terminal run cannot be revived by a late acknowledgement.

Durable `/workflow resume` preserves completed stage metadata, active-stage elapsed time, total run elapsed time, and graph topology. While an LM stage or task is active, repeated durable checkpoints refresh its accumulated pause-adjusted duration even when its session file does not change, and refresh the run's total accumulated elapsed time alongside it; graceful quit and recoverable failure additionally persist the exact run total at the boundary. Each new Atomic process that reopens the unfinished session mid-chat starts from the latest saved baseline and uses the same continuation prompt shown above, so repeated process-boundary resumes keep status, graph, stored, and lifecycle duration cumulative without double-counting pauses from earlier process segments — a resumed mid-running stage timer continues from its previously accumulated elapsed time instead of restarting at zero, and the total workflow duration shown in the main-chat dashboard and status surfaces reports prior-session elapsed plus current-session elapsed. Replayed `ctx.stage`, `ctx.task`, `ctx.chain`, `ctx.parallel`, and child-workflow checkpoints keep their original summaries, timing, session/model metadata, and parallel fanout parentage instead of appearing as freshly flattened replay nodes.

**Post-mortem chat vs. execution resume.** These are distinct operations. *Resuming workflow execution* (`/workflow resume`) is for paused, interrupted, recoverably failed, or unfinished durable work; it may replay checkpoints, continue an incomplete stage, and dispatch remaining DAG work. *Opening a post-mortem chat* reopens one terminal agent stage's retained conversation for follow-up only — it never resumes, retries, rewinds, or otherwise changes workflow execution. Any eligible terminal agent stage with a valid retained session opens as an interactive post-mortem chat regardless of how you reach it: same-process `task`/`tasks`/`chain` stages, completed-workflow inspection, generic `/workflow attach` / `/workflow connect`, restored/replayed durable snapshots after a restart, and `workflow({ action: "send" })`. Explicit `/workflow attach <root-run> <nested-stage>` targets are resolved through the expanded graph and routed to the child run that owns the stage while the overlay remains rooted on the requested graph; the resolved owner is preserved when sibling child workflows reuse the same local stage ID. When a nested stage is reopened after a restart or from another checkout, its session cwd comes from the durable root workflow (resolved workflow cwd first, then original invocation cwd) while stage-control ownership remains with the actual child run. Follow-up turns are appended in place to the stage's retained session (no separate fork), so the agent may still invoke its ordinary tools and cause side effects; only the workflow DAG, run/stage status, results, timings, checkpoints, and topology are immutable. Every host session replacement or shutdown invalidates post-mortem handles, including a session whose lazy reopen is still pending: if creation finishes after the boundary, Atomic disposes the newly created session and rejects the already-submitted prompt before it can execute. A stage stays a **read-only transcript** when it has no valid retained agent session — prompt/HIL and boundary/summary nodes, skipped nodes without a completed conversation, non-terminal handle-less stages (another process may still own the session), and missing/malformed/deleted session files. When a known stage cannot be reopened, the attached chat shows the complete `SESSION UNAVAILABLE` explanation down to the supported 40-column minimum instead of incorrectly labeling an invalid file as an archived transcript. Recoverably failed stages keep their execution-resume semantics and are not silently reopened as post-mortem chat.

Workflow stage sessions and first-party subagent transcripts created inside them are classified as **internal** at creation and excluded from the standard `/resume`, `atomic -r`, `--continue`, and global history surfaces. Fork-context stages and subagents inherit the owning run/stage marker in their initial JSONL header, avoiding a briefly visible ordinary session. They remain resumable and inspectable through the workflow-specific commands and tool actions shown here (`/workflow resume`, `/workflow attach`, `workflow({ action: "status" | "stages" | "stage" | "resume" })`), which read the run/stage store and its `sessionFile` links directly. Passing a stage session's file path to `--session` still opens it explicitly. Classification requires exact `internal: true` plus complete run/stage metadata; malformed legacy markers and ordinary user forks remain in standard history. Legacy workflow sessions created before this marker behavior lack provable ownership and continue to appear until they age out.

Human-in-the-loop prompts from `ctx.ui.input`, `ctx.ui.confirm`, `ctx.ui.select`, `ctx.ui.editor`, and `ctx.ui.custom<T>` appear as awaiting-input nodes in the workflow graph viewer, not as chat modals — use `/workflow connect <run-id>` (or F2), then press Enter on the focused node or click a visible graph node directly to focus and open/attach it for local answers.

`ctx.ui.custom<T>(factory, options?)` reuses Atomic's TUI component path: the factory receives the same real `(tui, theme, keybindings, done)` types as extension `ctx.ui.custom`, and the workflow resumes with the value passed to `done(value)`. Use `options.label` for a safe display-only graph/status label and `options.replayIdentity` when widget semantics can change without the callsite changing. Do not put secrets in labels or replay identities; only a hash of the identity is stored, and label text is not part of replay identity. Inline connected rendering is supported; `overlay: true` is rejected clearly because nested workflow graph overlays are not safely supported yet.

Prompt-answer replay through the live store is available only while the source run remains in memory. `StageSnapshot.promptAnswerState` is snapshot-safe metadata for continuation: `available` means a matching live answer can be replayed, `unavailable` means the matching prompt node exists but its private answer was purged, and `ambiguous` means multiple matching prompt nodes exist so Atomic asks again. Raw answers in the private live-store `PromptAnswerRecord` ledger are never written to stage snapshots and remain resident until the answer is cleared, the run is removed, or the store is cleared. Durable `ctx.ui.input`, `confirm`, `select`, `editor`, and `custom` responses are separately persisted as DBOS UI checkpoint values for cross-session replay; treat the durable database as sensitive. Prompt replay keys include the prompt kind, message text, select choices, input/editor initial value, custom prompt identity hash, and hashed author callsite, so changing any of those inputs may intentionally re-ask on continuation. An empty `ctx.ui.select(..., [])` has no answerable choices and throws before creating a prompt node. Arbitrary custom-widget answers cannot be supplied through `workflow send`; focus the `custom` awaiting-input node in the interactive graph instead.


## Running Workflows

List or inspect unfamiliar workflows before running them. If required inputs are missing and cannot be inferred, ask for the missing values before launch:

```ts
workflow({ action: "list" })
workflow({ action: "get", workflow: "deep-research-codebase" })
workflow({ action: "inputs", workflow: "deep-research-codebase" })
```

The workflow tool action surface is:

- discovery: `list`, `get`, `inputs`
- execution: named `run`, plus direct one-off `task`, `tasks`, and `chain` modes
- inspection: `status`, `stages`, `stage`, `transcript`
- messaging and run control: `send`, `pause`, `interrupt`, `quit`, `resume`
- rediscovery: `reload`

From interactive chat, model-launched workflows run in the background so the parent chat stays available. Run `/workflow connect <run>` to see agents working and chat with and steer each stage. Named workflow launches already run in the background; direct `task`, `tasks`, and `chain` launches must pass top-level `async: true`, and their accepted raw/rendered results include the same actionable connect guidance. This rule applies only to launches, not inspection or control calls (`status`, `stages`, `stage`, `transcript`, `send`, `pause`, `resume`, `interrupt`, `quit`). A model may launch in the foreground only when the user explicitly requests it or foreground execution is technically required, and it must tell the user before launching.

Run a named workflow with inputs:

```ts
workflow({
  action: "run",
  workflow: "deep-research-codebase",
  inputs: { prompt: "map workflow runtime", max_concurrency: 4 },
})
```

Slash equivalent:

```text
/workflow deep-research-codebase prompt="map workflow runtime" max_concurrency=4
```

<p align="center"><img src="images/workflow-command.png" alt="Running a Workflow Command" width="600" /></p>

Input overrides are bare `key=value` tokens. Values are JSON-parsed when possible, so `count=3`, `flag=true`, and `prompt="multi word value"` preserve useful types. A whole input object can also be passed as one JSON token. Runtime validation is strict: unknown input keys, missing required values, type mismatches, and invalid `select` choices fail before a named workflow run starts or before a child workflow starts.

In the TUI, `/workflow <name>` opens an input picker when the workflow declares inputs and either no arguments were supplied or required inputs are missing. Supplied values seed the picker. Pass `--no-picker` to skip that interactive flow.

In non-interactive (`-p`, `--print`, or `--mode json`) sessions, named workflow dispatch waits for the terminal run snapshot and skips pickers. Because human input is runtime-only and workflows no longer carry a declaration-time HIL marker, headless dispatch does not reject a workflow just because its source contains `ctx.ui.*`. If you copy a HIL workflow example into a headless session, it can pass dispatch and then fail when execution reaches the prompt with an error such as `atomic-workflows: interactive ctx.ui.confirm is unavailable in headless (non-interactive) mode; run the workflow in interactive mode or remove the interactive prompt from this stage` (the primitive name varies, including `ctx.ui.custom`). Run those workflows interactively, or guard/remove runtime `ctx.ui.*` calls before using headless mode.

<p align="center"><img src="images/workflow-input-picker.png" alt="Workflow Input Picker" width="600" /></p>

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
/workflows [workflow-id-or-prefix]
/workflow reload
```

Use `connect` for the workflow graph. Use `attach` when you want a chat pane for a specific stage. `ctrl+x` is the workflow hierarchy chord: in an attached stage chat it means **return to graph**, and in the graph it means **return to main chat**. The workflow surface handles `ctrl+x` before configurable editor or tool actions, including while a composer draft, primitive prompt, custom question, stage switcher, or legacy prompt card owns input. Leaving a stage preserves unsent composer and prompt drafts and keeps pending custom questions unresolved so they reappear when you attach again. `ctrl+d` and `q` do not navigate workflow surfaces; `ctrl+d` keeps its ordinary editor or prompt behavior where applicable, and `q` remains printable in text-owning prompts. Existing `esc`, `ctrl+c`, and graph `h` close/hide controls are unchanged. While the workflow graph is active, vertical wheel/trackpad gestures pan it up and down, and horizontal gestures pan wide graphs left and right when the terminal exposes horizontal wheel events; these gestures remain scoped to the graph instead of leaking into the main chat or terminal scrollback. Attached stage chats capture mouse/trackpad wheel events by default so scrolling stays inside the active stage transcript or prompt instead of falling through to terminal/main-chat scrollback. Live `subagent` tool calls in stage chats use the same single, parallel, and chain progress widgets as main chat, including after exiting and re-attaching to an in-flight stage; press Ctrl+O (the `app.tools.expand` binding) to expand live detail for every child, including current tool activity and artifact paths. If an async/background subagent is running while the fullscreen workflow graph is open, the graph statusline mirrors the async summary so the background run remains visible; hide the graph with `h`, leave it with `ctrl+x`, or reconnect later to return to the full below-editor async widget. Press `ctrl+t` inside an attached stage chat to toggle **copy mode**: copy mode disables workflow-chat mouse reporting so normal terminal/tmux text selection can work; press `ctrl+t` again to leave copy mode and restore transcript or prompt scrolling. Archived read-only stage transcripts expose the same footer and copy-mode status, so their text can also be selected and copied; `esc` closes the transcript and `ctrl+x` returns to the graph. While copy mode is on, wheel/trackpad gestures are handled by the terminal/tmux and may scroll terminal scrollback, so leave copy mode before using the wheel again. Use `interrupt`, `pause`, and `resume` for resumable live work; `resume` on a non-paused run reopens the saved snapshot or overlay. Use `quit` to pause a live run gracefully while preserving it for `/workflow resume`. Use `/workflow reload` after adding, editing, installing, or removing workflow resources or package manifest workflow entries and you want Atomic to rediscover them in-process. `/workflow status` lists all retained active and terminal top-level runs by default; implementation-owned nested child runs are flattened into their parent workflow rather than listed separately. `/workflow status --all` is retained as a compatibility alias.

`/workflows` is the retained-run history alias for `/workflow resume`: with no id it opens the same mixed resumable/completed picker, and with an id it resumes unfinished work or opens completed inspection. It is intentionally different from `/workflow list`, which lists installed workflow definitions.

At the supported 40-column terminal minimum, attached stage chats use the compact `ctrl+x graph · ctrl+t …` footer. Provider/model context may be truncated to make room, but remains separated from the hierarchy hint so the controls stay readable.

<p align="center"><img src="images/workflow-graph.png" alt="Workflow Graph Viewer" width="600" /></p>

Human-in-the-loop prompts from `ctx.ui.input`, `ctx.ui.confirm`, `ctx.ui.select`, `ctx.ui.editor`, and `ctx.ui.custom<T>` appear as awaiting-input nodes in the workflow UI/graph viewer, not as ordinary chat modals. Workflows do not declare HIL up front; prompt nodes are created when the runtime `ctx.ui.*` call executes. If the prompt lives inside an imported child workflow, it still appears in the same expanded parent graph so the user can focus and answer it without switching to a separate child status entry. Custom widget prompts mount inside the attached stage chat and must be completed interactively with the widget's `done(value)` callback.

## Monitor and Control Runs

The workflow tool exposes lifecycle controls for non-interactive use:

```ts
workflow({ action: "status" })
workflow({ action: "status", runId: "<id-or-prefix>" })

workflow({ action: "stages", runId: "<id-or-prefix>", statusFilter: "all" })
workflow({ action: "stage", runId: "<id-or-prefix>", stageId: "review" })
// Prefer sessionFile/transcriptPath from stages/stage; quote the exact path, preserve Windows separators, then search/read small ranges.
workflow({ action: "transcript", runId: "<id-or-prefix>", stageId: "review" })
// Omit tail/limit for the path-only default when a transcript file exists; pass either option for a bounded preview.
workflow({ action: "transcript", runId: "<id-or-prefix>", stageId: "review", tail: 40 })
workflow({ action: "transcript", runId: "<id-or-prefix>", stageId: "review", limit: 20, includeToolOutput: true })

workflow({ action: "send", runId: "<id-or-prefix>", stageId: "review", text: "please focus on tests" })
workflow({ action: "send", runId: "<id-or-prefix>", stageId: "approval", promptId: "prompt-1", response: true, delivery: "answer" })
workflow({ action: "send", runId: "<id-or-prefix>", stageId: "review", message: "continue with tests", delivery: "resume" })

workflow({ action: "pause", runId: "<id-or-prefix>" })
workflow({ action: "pause", runId: "<id-or-prefix>", stageId: "review" })

workflow({ action: "interrupt", runId: "<id-or-prefix>" })
workflow({ action: "interrupt", all: true })

workflow({ action: "resume", runId: "<id-or-prefix>" })
workflow({ action: "resume", runId: "<id-or-prefix>", stageId: "review", message: "continue" })

workflow({ action: "quit", runId: "<id-or-prefix>" })
workflow({ action: "quit", all: true })

workflow({ action: "reload", reason: "added team workflow" })
```

Control behavior:

- `runId` accepts full run ids or unique prefixes for every lifecycle and inspection action, including `status`. The abbreviated IDs printed by status surfaces are valid inputs. Exact IDs take precedence; a prefix shared by multiple runs returns an ambiguity diagnostic with longer matching prefixes instead of selecting the first run. Status lists and run pickers show top-level user-launched workflows; nested child runs are implementation details of the expanded parent graph.
- `status` / `status <runId>` show terminal `ctx.exit(...)` statuses (`completed`, `skipped`, `cancelled`, or `blocked`) and the optional exit reason when one was supplied.
- `stages` lists stage summaries, including flattened stages from nested `ctx.workflow(...)` imports and `sessionFile`/`transcriptPath` when a stage has a persisted session. Use `statusFilter: "all"` to include completed, failed, skipped, and pending stages.
- `stage` returns details for one stage by stage id, unique prefix, or stage name, including nested child stages shown in the expanded graph and the persisted `sessionFile` when available. Abbreviated stage IDs printed in graph/control messages use this same unique-prefix resolver; collisions return an ambiguity diagnostic rather than selecting a stage.
- `transcript` is reference-first. When a transcript file exists, the default is path-only with metadata and lazy-read guidance; pass explicit `tail` or `limit` for a bounded preview. When no transcript path exists, Atomic falls back to up to five recent entries. For targeted lookup, quote the exact `sessionFile`/`transcriptPath` value without changing platform separators (preserve Windows backslashes), search it with `rg` or `grep`, then read only small surrounding ranges. Text results include JSON-escaped `sessionFileJson`/`transcriptPathJson` lines for copy-safe path literals. `tail` overrides `limit`. `includeToolOutput` affects only inlined or fallback preview entries and does not bypass the path-only default.
- `send` delivery modes are `auto`, `answer`, `prompt`, `steer`, `followUp`, and `resume`. Prompt answers can include `promptId` and can carry answer content in `response`, `text`, or `message`; structured UI prompts usually prefer `response`. Follow-up messaging to completed or failed stages reuses the retained `sessionFile` when available so the conversation resumes from the archived stage transcript instead of starting empty; if no session metadata was retained, Atomic refuses the follow-up rather than silently resetting. Explicit `delivery: "resume"` or `delivery: "steer"` against a completed post-mortem stage returns a structured `noop` with guidance to use `followUp` or `prompt`; it never appends the supplied text or mutates workflow execution. Arbitrary `ctx.ui.custom<T>` widget prompts require the interactive workflow graph and return a clear unsupported message when targeted through `send`.
- `delivery: "auto"` first answers a pending prompt, then resumes paused work, then steers a streaming stage, then queues a follow-up.
- `pause`, `interrupt`, and `quit` can target one top-level run or `all: true`; `stageId` cannot be combined with `all: true`. Stage-scoped `pause` and `interrupt` controls can target a visible nested child stage from the expanded graph; `quit` remains run-level. Atomic routes stage controls to the owning nested run internally.
- `interrupt` is resumable: it pauses live work when pausable stages exist and keeps the run in live history/status.
- `pause` is useful for pausing a live run or a single live stage without treating it as a destructive abort.
- `resume` can target a stage with `stageId`; the target may be a stage id, unique prefix, or stage name. `message` is forwarded to paused work. For a live interrupted stage, Atomic automatically injects `Continue where you left off. If you believe you are finished with your original task (or a redefined task if the user told you), stop.` after any non-empty resume-message answer—or immediately after a no-message resume—before normal readiness-gate completion when the stage has not already finalized, including when the resume-answer turn used `ask_user_question`.
- `quit` gracefully pauses in-flight work, marks the run resumable, and leaves it available to `/workflow resume`.
- `reload` refreshes discovered workflow resources in-process; the optional `reason` is echoed in the result.

Use slash commands for graph connect and stage attach because those are interactive TUI surfaces. When a run needs user input or attention, surface that to the user instead of polling silently.


## Lifecycle Notices and Human Input

Atomic emits deduplicated main-chat notices when top-level workflow runs complete, fail, or end blocked. Nested child workflow completion/failure is reflected inside the expanded parent graph instead of producing separate top-level completion cards. These terminal notices are queued into the active main chat as steering/context messages (`triggerTurn: true`, `deliverAs: "steer"`) so the model can react without the user manually polling status. Awaiting-input workflow states are tracked for dedupe/restore, but they do not enqueue main-chat connect cards or wake the model; prompt state remains visible through workflow status/connect surfaces. Configure lifecycle behavior with `workflowNotifications.enabled` (default `true`) and `workflowNotifications.notifyOn` (default `["completed", "failed", "blocked", "awaiting_input"]`).

Human input is runtime-only: call `ctx.ui.input`, `ctx.ui.confirm`, `ctx.ui.select`, `ctx.ui.editor`, or `ctx.ui.custom<T>` at the point where the workflow actually needs a decision. No builder-level declaration is required or supported.

When a workflow needs human input, answer in the graph viewer or attached stage chat when possible:

```text
/workflow connect <run-id>
/workflow attach <run-id> <stage-id-or-name>
```

Agents can answer primitive and structured pending prompts programmatically with `workflow({ action: "send", delivery: "answer", ... })`; use `promptId` when it is present in the stage details, and provide answer content with `response`, `text`, or `message`. Arbitrary custom TUI widget prompts intentionally refuse this path in iteration 1 because a generic `T` cannot be reconstructed safely from a non-TUI payload.

If the user answers a human-in-the-loop prompt in the workflow UI or stage UI broker, the stage receives the answer directly and the active main chat receives a display-only notice (`triggerTurn: false`, `excludeFromContext: true`) containing a concise answer summary. The notice is rendered for the user and persisted for audit, but it does not wake the model, enter LLM context, or authorize answering any other workflow prompt. Prompt answers sent by the main-chat `workflow` tool are suppressed from this notice because the tool result already informs the current turn.

## Direct One-Off Runs

Use direct workflow-native orchestration for one-off tracked work that does not need a reusable workflow file.

Single tracked task:

```ts
workflow({
  task: {
    name: "review",
    task: "Review this patch for API risks.",
    context: "fresh",
    output: "reviews/api.md",
  },
  async: true,
  intercom: { delivery: "result" },
})
```

Parallel fan-out:

```ts
workflow({
  tasks: [
    { name: "docs", task: "Review documentation gaps" },
    { name: "risks", task: "Review operational risks" },
  ],
  concurrency: 2,
  outputMode: "file-only",
  async: true,
})
```

Dependent chain:

```ts
workflow({
  task: "Design the workflow SDK migration",
  chain: [
    { name: "research", task: "Research {task}" },
    { name: "plan", task: "Plan from {previous}" },
  ],
  async: true,
})
```

Mixed chain with a parallel review step:

```ts
workflow({
  task: "map the release process",
  chain: [
    { name: "researcher", task: "Research {task}" },
    {
      parallel: [
        { name: "risk-reviewer", task: "Review risks in {previous}" },
        { name: "docs-reviewer", task: "Find documentation gaps in {previous}" },
      ],
      concurrency: 2,
    },
    { name: "planner", task: "Create a plan from {previous}" },
  ],
  async: true,
  intercom: { delivery: "result" },
})
```

Direct mode supports top-level/default options and per-task options such as `context`, `forkFromSessionFile`, `model`, `fallbackModels`, `thinkingLevel`, `contextWindow`, `tools`, `noTools`, `customTools`, `mcp`, `output`, `outputMode`, `reads`, `worktree`, `gitWorktreeDir`, `baseBranch`, `maxOutput`, `artifacts`, `sessionDir`, `cwd`, and `agentDir`. Direct chains also support `chainName`, `chainDir`, and `failFast`.

For large fan-outs, prefer `outputMode: "file-only"` so the parent result contains compact file references instead of full output. Treat intercom payloads from async direct runs as user-visible workflow output.

Worktree isolation is an explicit runtime option, not a property inferred from task text. Natural-language instructions to create or use a worktree do not enable runner isolation, and `cwd` only selects the starting directory; a write-capable direct run without a worktree option executes in that checkout. Set `worktree: true` for runner-managed temporary per-task worktrees, or set `gitWorktreeDir` for a runner-managed reusable same-repository worktree. Invalid, empty, foreign-repository, or conflicting worktree requests fail with an actionable diagnostic rather than falling back to the invoking checkout. For independent task queues, prefer one run per item with its own reusable worktree instead of a monolithic chain rooted in the primary checkout.
