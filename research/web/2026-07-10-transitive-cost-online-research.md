---
title: "Upstream Atomic/Pi docs and patterns for session cost, events, TUI status, subagents, and workflows"
date: 2026-07-10
researcher: "online/contextual research subagent"
breaking_changes_allowed: false
status: "complete"
fetch_order:
  - "checked existing research/web cache first"
  - "fetched https://docs.bastani.ai/llms.txt"
  - "fetched markdown docs from docs.bastani.ai and pi.dev/docs/latest"
  - "cloned GitHub repos with fetch_content for source/doc permalinks"
repo_shas:
  bastani_inc_atomic: "44ebff2a8091aff4a45a3c4dd794b34fd47e5c3e"
  earendil_works_pi: "34582ef34beec868b0df4fb969385b8af5960c45"
  nicobailon_pi_subagents: "7f8419e152fd89e6c7ea18851cd997205a8926a3"
sources:
  - "https://docs.bastani.ai/llms.txt"
  - "https://docs.bastani.ai/usage.md"
  - "https://docs.bastani.ai/sessions.md"
  - "https://docs.bastani.ai/session-format.md"
  - "https://docs.bastani.ai/extensions.md"
  - "https://docs.bastani.ai/tui.md"
  - "https://docs.bastani.ai/subagents.md"
  - "https://docs.bastani.ai/workflows.md"
  - "https://pi.dev/docs/latest/usage.md"
  - "https://pi.dev/docs/latest/session-format.md"
  - "https://pi.dev/docs/latest/extensions.md"
  - "https://github.com/bastani-inc/atomic"
  - "https://github.com/earendil-works/pi"
  - "https://github.com/nicobailon/pi-subagents"
cache_reused:
  - "research/web/2026-07-08-pi-atomic-intercom-compatibility.md"
  - "research/web/2026-07-08-pi-atomic-runtime-intercom-compatibility.md"
  - "research/web/2026-05-14-nicobailon-pi-subagents-github.md"
---

## Summary

Relevant upstream documentation is public and mostly concentrated in Atomic's docs index (`llms.txt`) plus source-backed docs in `bastani-inc/atomic`. The most relevant patterns are:

- **Session usage/cost is first-class UI and session metadata**: docs say `/session` reports tokens/cost and the footer shows token/cache usage, cost, context usage, and model; source computes totals from assistant-message `usage` fields.
- **Session format is append-only JSONL with tree entries**: Atomic v3 sessions add `context_window_change`, `context_compaction`, internal workflow-session metadata, and extension `custom` / `custom_message` entries; Pi's latest docs describe the compatible v3 tree baseline but still document legacy summary compaction.
- **Event bus is the extension integration seam**: extensions subscribe with `pi.on(...)`; public docs list lifecycle, session, agent, provider, tool, and compaction events; source stores handlers per event and emits them in registration order, catching extension errors.
- **Interactive footer/status patterns are documented**: `ctx.ui.setStatus`, widgets, working indicators, and `ctx.ui.setFooter` are public TUI patterns. Source stores statuses in `FooterDataProvider` and custom footer factories receive read-only footer data.
- **Subagents/workflows are now bundled Atomic extensions/packages, while upstream Pi stays small**: Atomic docs publicly document bundled subagents and workflows. Pi public docs explicitly say core Pi does not include built-in sub-agents/workflows; third-party `pi-subagents` documents the parent/child session pattern that Atomic's bundled subagents resemble.
- **Compatibility implication (`breaking_changes_allowed=false`)**: preserve `.atomic` primary behavior plus `.pi`/Pi compatibility where already documented; do not remove existing session JSONL fields, extension event names, tool names, footer APIs, or Pi-style package/extension patterns without an alias/migration path.

## Detailed Findings

### 1. Source discovery and cached context

- Existing local cache already had relevant Pi/Atomic compatibility notes:
  - `research/web/2026-07-08-pi-atomic-intercom-compatibility.md` — Atomic `.atomic` primary / `.pi` fallback expectations, extension manifest compatibility, intercom public conventions.
  - `research/web/2026-07-08-pi-atomic-runtime-intercom-compatibility.md` — runtime/session-dir compatibility and package/binary assumptions.
  - `research/web/2026-05-14-nicobailon-pi-subagents-github.md` — older capture of `pi-subagents` architecture and extension registration.
- `https://docs.bastani.ai/llms.txt` is available and lists all relevant pages, including `usage.md`, `sessions.md`, `session-format.md`, `extensions.md`, `tui.md`, `subagents.md`, and `workflows.md`.
- `https://pi.dev/llms.txt` returned a missing-page response, so Pi docs were fetched directly from known `https://pi.dev/docs/latest/...` markdown-like pages.

### 2. Session usage/cost and footer display

**Public docs**

Atomic Usage docs state the interactive footer includes "working directory, session name, token/cache usage, cost, context usage, and current model" and `/session` shows "session file, ID, messages, tokens, and cost":

- Docs page: https://docs.bastani.ai/usage.md
- Source permalink: [`packages/coding-agent/docs/usage.md#L9-L15`](https://github.com/bastani-inc/atomic/blob/44ebff2a8091aff4a45a3c4dd794b34fd47e5c3e/packages/coding-agent/docs/usage.md#L9-L15), [`#L42-L48`](https://github.com/bastani-inc/atomic/blob/44ebff2a8091aff4a45a3c4dd794b34fd47e5c3e/packages/coding-agent/docs/usage.md#L42-L48)

Atomic Sessions docs state `/session` shows the current file, ID, message count, tokens, and cost:

- Docs page: https://docs.bastani.ai/sessions.md

**Source pattern**

Atomic computes session export/info token and cost totals by summing assistant-message usage buckets (`input`, `output`, `cacheRead`, `cacheWrite`) and `usage.cost.total`:

```ts
if (message.role === "assistant") {
  const assistantMsg = message as AssistantMessage;
  toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
  totalInput += assistantMsg.usage.input;
  totalOutput += assistantMsg.usage.output;
  totalCacheRead += assistantMsg.usage.cacheRead;
  totalCacheWrite += assistantMsg.usage.cacheWrite;
  totalCost += assistantMsg.usage.cost.total;
}
```

Permalink: [`packages/coding-agent/src/core/agent-session-export.ts#L26-L55`](https://github.com/bastani-inc/atomic/blob/44ebff2a8091aff4a45a3c4dd794b34fd47e5c3e/packages/coding-agent/src/core/agent-session-export.ts#L26-L55)

The interactive usage meter scans **all session entries** rather than just the active post-compaction message state, then renders input/output/cache/cost/context-window indicators:

```ts
for (const entry of session.sessionManager.getEntries()) {
  if (entry.type === "message" && entry.message.role === "assistant") {
    totalInput += entry.message.usage.input;
    totalOutput += entry.message.usage.output;
    totalCacheRead += entry.message.usage.cacheRead;
    totalCacheWrite += entry.message.usage.cacheWrite;
    totalCost += entry.message.usage.cost.total;
  }
}
```

Permalink: [`packages/coding-agent/src/modes/interactive/components/footer.ts#L38-L64`](https://github.com/bastani-inc/atomic/blob/44ebff2a8091aff4a45a3c4dd794b34fd47e5c3e/packages/coding-agent/src/modes/interactive/components/footer.ts#L38-L64); rendering details at [`#L76-L127`](https://github.com/bastani-inc/atomic/blob/44ebff2a8091aff4a45a3c4dd794b34fd47e5c3e/packages/coding-agent/src/modes/interactive/components/footer.ts#L76-L127)

**Concise takeaway**: for transitive/child cost reporting, the upstream-compatible data source is assistant-message `usage` in JSONL entries. If aggregating child/subagent/workflow costs, prefer additive `usage`-bucket aggregation from persisted child sessions/artifacts and avoid relying only on current active LLM context after compaction.

### 3. Session file format and persistence surface

**Public docs**

Atomic Session Format docs define JSONL session files with a header and tree entries connected by `id`/`parentId`, stored under `~/.atomic/agent/sessions/--<path>--/<timestamp>_<uuid>.jsonl`:

- Docs page: https://docs.bastani.ai/session-format.md
- Sessions page: https://docs.bastani.ai/sessions.md
- Usage source permalink for session CLI flags: [`packages/coding-agent/docs/usage.md#L74-L95`](https://github.com/bastani-inc/atomic/blob/44ebff2a8091aff4a45a3c4dd794b34fd47e5c3e/packages/coding-agent/docs/usage.md#L74-L95)

Atomic's typed session surface currently includes:

```ts
export const CURRENT_SESSION_VERSION = 3;
export interface SessionHeader {
  type: "session";
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
  internal?: boolean;
  workflow?: SessionWorkflowMetadata;
}
```

Permalink: [`packages/coding-agent/src/core/session-manager-types.ts#L5-L29`](https://github.com/bastani-inc/atomic/blob/44ebff2a8091aff4a45a3c4dd794b34fd47e5c3e/packages/coding-agent/src/core/session-manager-types.ts#L5-L29)

Atomic session entries include model/thinking/context-window changes, compaction, branch summaries, labels, session info, and extension entries:

```ts
export type SessionEntry =
  | SessionMessageEntry
  | ThinkingLevelChangeEntry
  | ContextWindowChangeEntry
  | ModelChangeEntry
  | CompactionEntry
  | ContextCompactionEntry
  | BranchSummaryEntry
  | CustomEntry
  | CustomMessageEntry
  | LabelEntry
  | SessionInfoEntry;
```

Permalink: [`packages/coding-agent/src/core/session-manager-types.ts#L40-L99`](https://github.com/bastani-inc/atomic/blob/44ebff2a8091aff4a45a3c4dd794b34fd47e5c3e/packages/coding-agent/src/core/session-manager-types.ts#L40-L99), [`#L121-L173`](https://github.com/bastani-inc/atomic/blob/44ebff2a8091aff4a45a3c4dd794b34fd47e5c3e/packages/coding-agent/src/core/session-manager-types.ts#L121-L173)

`CustomEntry` is documented in source as extension state that does **not** participate in LLM context; `CustomMessageEntry` usually participates in context unless excluded and controls TUI display:

- `CustomEntry`: [`session-manager-types.ts#L111-L125`](https://github.com/bastani-inc/atomic/blob/44ebff2a8091aff4a45a3c4dd794b34fd47e5c3e/packages/coding-agent/src/core/session-manager-types.ts#L111-L125)
- `CustomMessageEntry`: [`session-manager-types.ts#L140-L159`](https://github.com/bastani-inc/atomic/blob/44ebff2a8091aff4a45a3c4dd794b34fd47e5c3e/packages/coding-agent/src/core/session-manager-types.ts#L140-L159)

**Pi comparison**

Pi latest public docs describe the same JSONL tree and v3 baseline, but still document legacy summary compaction (`compaction` entry and `compactionSummary` message). Atomic docs/source now describe `context_compaction` as validated logical deletion and retired summary compaction as archival only.

- Pi docs: https://pi.dev/docs/latest/session-format.md
- Atomic docs: https://docs.bastani.ai/session-format.md

**Concise takeaway**: do not change JSONL field names or omit historical/legacy entries when parsing. For new Atomic features, write additive entries/metadata and keep old Pi-compatible session reads tolerant.

### 4. Extension event bus / lifecycle patterns

**Public docs**

Atomic Extensions docs state extensions can subscribe to lifecycle events, register LLM-callable tools, add commands, interact with users, add custom UI, persist session state, and customize rendering:

- Docs page: https://docs.bastani.ai/extensions.md
- Source permalink: [`packages/coding-agent/docs/extensions.md#L5-L17`](https://github.com/bastani-inc/atomic/blob/44ebff2a8091aff4a45a3c4dd794b34fd47e5c3e/packages/coding-agent/docs/extensions.md#L5-L17)

The documented lifecycle includes `session_start`, `resources_discover`, `input`, `before_agent_start`, `agent_start`, message events, turn events, provider request/response events, tool events, compaction events, tree events, and shutdown:

- Source permalink: [`packages/coding-agent/docs/extensions.md#L285-L340`](https://github.com/bastani-inc/atomic/blob/44ebff2a8091aff4a45a3c4dd794b34fd47e5c3e/packages/coding-agent/docs/extensions.md#L285-L340)

**Source pattern**

The public `ExtensionAPI` exposes event subscription overloads for session, agent, provider, message, tool, model, input, and trust events:

- Permalink: [`packages/coding-agent/src/core/extensions/api-types.ts#L66-L118`](https://github.com/bastani-inc/atomic/blob/44ebff2a8091aff4a45a3c4dd794b34fd47e5c3e/packages/coding-agent/src/core/extensions/api-types.ts#L66-L118)

`pi.on(event, handler)` appends handlers to the extension's `handlers` map:

```ts
on(event: string, handler: HandlerFn): void {
  runtime.assertActive();
  const list = extension.handlers.get(event) ?? [];
  list.push(handler);
  extension.handlers.set(event, list);
}
```

Permalink: [`packages/coding-agent/src/core/extensions/loader-api.ts#L38-L44`](https://github.com/bastani-inc/atomic/blob/44ebff2a8091aff4a45a3c4dd794b34fd47e5c3e/packages/coding-agent/src/core/extensions/loader-api.ts#L38-L44)

Generic event emit iterates extensions and handlers for `event.type`; session-before handlers can return cancellation, and thrown errors are routed to extension error handling rather than crashing the host path:

```ts
for (const ext of extensions) {
  const handlers = ext.handlers.get(event.type);
  if (!handlers || handlers.length === 0) continue;
  for (const handler of handlers) {
    try {
      const handlerResult = await handler(event, ctx);
      if (isSessionBeforeEvent(event) && handlerResult) {
        result = handlerResult as SessionBeforeEventResult;
        if (result.cancel) return result as RunnerEmitResult<TEvent>;
      }
    } catch (error) {
      emitCaughtError(emitError, ext.path, event.type, error);
    }
  }
}
```

Permalink: [`packages/coding-agent/src/core/extensions/runner-events.ts#L109-L130`](https://github.com/bastani-inc/atomic/blob/44ebff2a8091aff4a45a3c4dd794b34fd47e5c3e/packages/coding-agent/src/core/extensions/runner-events.ts#L109-L130)

**Concise takeaway**: event names and handler result shapes are public extension API. Add new events additively; avoid renaming existing event strings or changing cancellation semantics.

### 5. Interactive footer/status bar and TUI extension patterns

**Public docs**

Atomic TUI docs document persistent footer status, widgets, working indicators, and custom footers:

- Docs page: https://docs.bastani.ai/tui.md
- `ctx.ui.setStatus`: [`packages/coding-agent/docs/tui.md#L723-L733`](https://github.com/bastani-inc/atomic/blob/44ebff2a8091aff4a45a3c4dd794b34fd47e5c3e/packages/coding-agent/docs/tui.md#L723-L733)
- Widgets: [`packages/coding-agent/docs/tui.md#L767-L793`](https://github.com/bastani-inc/atomic/blob/44ebff2a8091aff4a45a3c4dd794b34fd47e5c3e/packages/coding-agent/docs/tui.md#L767-L793)
- Custom footer: [`packages/coding-agent/docs/tui.md#L797-L817`](https://github.com/bastani-inc/atomic/blob/44ebff2a8091aff4a45a3c4dd794b34fd47e5c3e/packages/coding-agent/docs/tui.md#L797-L817)

**Source pattern**

The interactive extension UI context exposes `setStatus`, `setWidget`, `setFooter`, `setHeader`, custom UI, editor controls, and footer-data access:

- Permalink: [`packages/coding-agent/src/modes/interactive/interactive-extension-context.ts#L108-L155`](https://github.com/bastani-inc/atomic/blob/44ebff2a8091aff4a45a3c4dd794b34fd47e5c3e/packages/coding-agent/src/modes/interactive/interactive-extension-context.ts#L108-L155)

Extension statuses are stored in `FooterDataProvider` and exposed read-only to footer factories:

```ts
getExtensionStatuses(): ReadonlyMap<string, string> {
  return this.extensionStatuses;
}
setExtensionStatus(key: string, text: string | undefined): void {
  if (text === undefined) {
    this.extensionStatuses.delete(key);
  } else {
    this.extensionStatuses.set(key, text);
  }
}
```

Permalink: [`packages/coding-agent/src/core/footer-data-provider.ts#L147-L170`](https://github.com/bastani-inc/atomic/blob/44ebff2a8091aff4a45a3c4dd794b34fd47e5c3e/packages/coding-agent/src/core/footer-data-provider.ts#L147-L170)

Setting a status updates footer data and requests a render:

```ts
InteractiveModeBase.prototype.setExtensionStatus = function(this: InteractiveModeBase, key: string, text: string | undefined): void {
  this.footerDataProvider.setExtensionStatus(key, text);
  this.ui.requestRender();
};
```

Permalink: [`packages/coding-agent/src/modes/interactive/interactive-extension-runtime.ts#L61-L64`](https://github.com/bastani-inc/atomic/blob/44ebff2a8091aff4a45a3c4dd794b34fd47e5c3e/packages/coding-agent/src/modes/interactive/interactive-extension-runtime.ts#L61-L64)

Custom footers are swapped in-place so below-editor widgets remain last in the UI tree:

- Permalink: [`packages/coding-agent/src/modes/interactive/interactive-extension-widgets.ts#L52-L95`](https://github.com/bastani-inc/atomic/blob/44ebff2a8091aff4a45a3c4dd794b34fd47e5c3e/packages/coding-agent/src/modes/interactive/interactive-extension-widgets.ts#L52-L95)

**Concise takeaway**: status/footer features should use `ctx.ui.setStatus` for additive indicators and `setFooter` only when replacing the whole footer is intentional. Preserve `footerData.getExtensionStatuses()` for compatibility with existing custom footers.

### 6. Subagent extension/workflow patterns

**Atomic bundled subagents**

Atomic public docs state `@bastani/atomic` bundles `@bastani/subagents`, and Atomic can decide whether to use a single child, parallel group, chain, foreground run, or background run:

- Docs page: https://docs.bastani.ai/subagents.md
- Source permalink: [`packages/coding-agent/docs/subagents.md#L6-L30`](https://github.com/bastani-inc/atomic/blob/44ebff2a8091aff4a45a3c4dd794b34fd47e5c3e/packages/coding-agent/docs/subagents.md#L6-L30)

Atomic's subagent docs also state foreground runs stream progress, background runs continue after control returns, and async status/interrupt/resume/doctor are public tool actions:

- Source permalink: [`packages/coding-agent/docs/subagents.md#L79-L108`](https://github.com/bastani-inc/atomic/blob/44ebff2a8091aff4a45a3c4dd794b34fd47e5c3e/packages/coding-agent/docs/subagents.md#L79-L108)

Fresh vs forked context is documented; forked context creates a real branched child session and should fail fast instead of silently downgrading:

- Source permalink: [`packages/coding-agent/docs/subagents.md#L110-L121`](https://github.com/bastani-inc/atomic/blob/44ebff2a8091aff4a45a3c4dd794b34fd47e5c3e/packages/coding-agent/docs/subagents.md#L110-L121)

The bundled subagent tool schema includes `context: "fresh" | "fork"`, `async`, `share`, and `sessionDir` options:

- Permalink: [`packages/subagents/src/extension/schemas.ts#L195-L209`](https://github.com/bastani-inc/atomic/blob/44ebff2a8091aff4a45a3c4dd794b34fd47e5c3e/packages/subagents/src/extension/schemas.ts#L195-L209)

The subagent package scans child session JSONL to extract optional token metadata by reading `entry.usage ?? entry.message?.usage` and summing input/output:

- Permalink: [`packages/subagents/src/shared/session-tokens.ts#L19-L44`](https://github.com/bastani-inc/atomic/blob/44ebff2a8091aff4a45a3c4dd794b34fd47e5c3e/packages/subagents/src/shared/session-tokens.ts#L19-L44)

**Pi / third-party upstream pattern**

Pi latest Usage docs say core Pi intentionally does not include built-in sub-agents/workflows and pushes workflow-specific behavior into extensions, skills, prompt templates, and packages:

- Pi docs: https://pi.dev/docs/latest/usage.md

The public `nicobailon/pi-subagents` README documents the parent/child mental model: "Pi is the parent session. A subagent is a focused child Pi session with its own job," foreground runs stream in conversation, and background runs can be checked later:

- Permalink: [`README.md#L41-L47`](https://github.com/nicobailon/pi-subagents/blob/7f8419e152fd89e6c7ea18851cd997205a8926a3/README.md#L41-L47)

**Concise takeaway**: Atomic's bundled subagents are publicly documented and can be treated as first-party extension surface, but Pi compatibility still matters because upstream Pi expects subagents/workflows to be package/extension-provided rather than core-only.

### 7. Workflows and workflow sessions/status

**Public docs**

Atomic Workflows docs define workflows as executable engineering loops with tracked stages, parallel branches, artifacts, human input, live status, checkpoints, and resumable background execution:

- Docs page: https://docs.bastani.ai/workflows.md
- Source permalink: [`packages/coding-agent/docs/workflows.md#L1-L20`](https://github.com/bastani-inc/atomic/blob/44ebff2a8091aff4a45a3c4dd794b34fd47e5c3e/packages/coding-agent/docs/workflows.md#L1-L20)

Workflow files are plain TypeScript modules exporting `workflow({...})`; docs show `.atomic/workflows/<name>.ts`, `@bastani/workflows`, TypeBox schemas, `ctx.task`, and `/workflow reload/list/inputs/run`:

- Source permalink: [`packages/coding-agent/docs/workflows.md#L117-L153`](https://github.com/bastani-inc/atomic/blob/44ebff2a8091aff4a45a3c4dd794b34fd47e5c3e/packages/coding-agent/docs/workflows.md#L117-L153)

Workflow stage sessions are documented as `internal`, excluded from normal `/resume` / `atomic -r` / `--continue`, and resumable/inspectable through workflow commands and tool actions:

- Source permalink: [`packages/coding-agent/docs/workflows.md#L411-L414`](https://github.com/bastani-inc/atomic/blob/44ebff2a8091aff4a45a3c4dd794b34fd47e5c3e/packages/coding-agent/docs/workflows.md#L411-L414)

**Source pattern**

The workflow authoring function validates `description`, `run`, `outputs`, optional `inputs`, normalizes the name, freezes schemas, and stamps a branded definition with `__piWorkflow: true`:

- Permalink: [`packages/workflows/src/authoring/workflow.ts#L138-L176`](https://github.com/bastani-inc/atomic/blob/44ebff2a8091aff4a45a3c4dd794b34fd47e5c3e/packages/workflows/src/authoring/workflow.ts#L138-L176)

The module loader rejects hand-rolled workflow objects that do not come from `workflow({...})`:

- Permalink: [`packages/workflows/src/extension/workflow-module-loader.ts#L97-L108`](https://github.com/bastani-inc/atomic/blob/44ebff2a8091aff4a45a3c4dd794b34fd47e5c3e/packages/workflows/src/extension/workflow-module-loader.ts#L97-L108)

**Concise takeaway**: workflow stage/session cost or status additions should attach to workflow run/stage metadata and internal stage sessions, not pollute normal session history. Keep `workflow({...})` as the public authoring boundary; avoid accepting arbitrary object shapes as workflow definitions.

## Additional Resources

- [Atomic docs index (`llms.txt`)](https://docs.bastani.ai/llms.txt) — authoritative list of current Atomic docs pages.
- [Atomic Usage](https://docs.bastani.ai/usage.md) — interactive UI, footer/session commands, CLI/session flags, env variables.
- [Atomic Session Format](https://docs.bastani.ai/session-format.md) — JSONL schema, entries, `SessionManager` API.
- [Atomic Extensions](https://docs.bastani.ai/extensions.md) — event lifecycle, extension APIs, persistence, custom tools/UI.
- [Atomic TUI](https://docs.bastani.ai/tui.md) — status/footer/widget/custom UI patterns.
- [Atomic Subagents](https://docs.bastani.ai/subagents.md) — bundled subagent extension behavior, async control, fresh/fork context.
- [Atomic Workflows](https://docs.bastani.ai/workflows.md) — workflow authoring, execution, stage sessions, graph/status UI.
- [Pi Usage](https://pi.dev/docs/latest/usage.md) and [Pi Session Format](https://pi.dev/docs/latest/session-format.md) — upstream Pi compatibility baseline.
- [`nicobailon/pi-subagents`](https://github.com/nicobailon/pi-subagents) — public third-party Pi subagent package documenting parent/child session conventions.

## Gaps or Limitations

- Pi does not appear to publish `llms.txt` at `https://pi.dev/llms.txt`; known docs pages were fetched directly.
- `https://pi.dev/docs/latest/workflows.md` and `https://pi.dev/docs/latest/subagents.md` returned missing-page responses, consistent with Pi's docs saying core Pi does not include built-in workflows/subagents.
- This report is research only and intentionally does not propose or implement code changes.
