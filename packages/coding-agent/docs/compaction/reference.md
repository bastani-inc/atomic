---
title: "Compaction reference"
sidebarTitle: "Compaction"
description: "Reference for compaction parameters, HTTP compactor contract, saved boundary fields, session_history tool, extension hooks, SDK concurrency, error classes, exports, branch summaries, and settings."
---

## Parameters

Extension events and compaction results carry one parameter:

| Parameter | Default | Meaning |
| --- | --- | --- |
| `query` | Latest user request | Your `/compact` instructions when provided, otherwise the text of the latest user request (or `"the latest user request"` when no user message exists on the active branch). A compactor model receives it as its query. |

Instructions passed to `/compact`, `session.compact({ query })`, `ctx.compact({ query })`, or RPC `compact` are also appended to the boundary message after the recovery steps. Automatic compaction passes no custom instructions.

Endpoint-specific knobs live on each compactor model in [`models.json`](/models#remote-compaction-models) (`compactionParams`, `endpointPath`, `timeoutMs`, `maxTokens`, `headers`) or via [`atomic.registerProvider()`](/custom-provider/api-reference) (`ProviderCompactorModelConfig`), never as top-level `session.compact()` or `settings.json` compaction options (see [Settings](#settings)). When `compactionParams` is omitted, Atomic does not inject provider-specific body fields so the remote API applies its own defaults.

Compacted text from a compactor model or a `session_before_compact` extension hook has no built-in size limit: only a `maxTokens` you set on a compactor model limits its output (using `estimateTextTokens()` at 4 ASCII characters or 1 non-ASCII character per token), and it has no default. The default request timeout is exported from `@bastani/atomic`:

| Default | Export | Model override field | Meaning |
| --- | --- | --- | --- |
| `120000` | `COMPACTOR_REQUEST_TIMEOUT_MS` | `timeoutMs` | Wall-clock limit on one compactor request, in milliseconds |

### Compactor request contract {#compactor-request-contract}

Each compactor provider defines its own `api` identifier and `baseUrl` (for example, built-in `morph/morph-compactor` defines `api: "morph-compact"` and `baseUrl: "https://api.morphllm.com/v1"`). Custom compactors in `models.json` or `atomic.registerProvider()` must declare `api` at the provider or model level unless overriding an existing compactor model.

Atomic `POST`s JSON to `<baseUrl><endpointPath>` (`endpointPath` defaults to `"/compact"`; `""` `POST`s directly to `baseUrl`):

- **Message framing (`messages`).** An array of `{ role: "user" | "assistant", content: string }` items produced by `buildCompactorMessages()`. Prior compaction boundaries are hoisted first (labelled `[Previously compacted history]`), followed by remaining LLM-visible messages in order. Each item's `content` begins with a `<keepContext>\n<label>\n</keepContext>` header (`[User]`, `[Assistant]`, `[Tool result: <name>]` or `[Tool result: <name> (error)]`, `[Shell execution]`, `[Extension context: <customType>]`, or `[Previous branch summary]`). Lines longer than 2,000 characters are wrapped (`wrapLongLines()`), images become `[Image omitted from text compaction (<mimeType>)]`, thinking blocks are omitted, and `excludeFromContext` messages are skipped.
- **Payload precedence.** Atomic copies any defined keys from `compactionParams` first, then writes `messages`, `query`, and `model` last—so core fields cannot be overridden by `compactionParams`.
- **Headers and authentication.** Sends `Content-Type: application/json`, merges resolved provider and model `headers`, and adds `Authorization: Bearer <apiKey>` when `apiKey` is present and no explicit `Authorization` header was set. Either `apiKey` or at least one custom header in `headers` satisfies the credential check (`missing-credentials` is thrown only when both are absent). The API key and sensitive auth headers (`Authorization`, `Proxy-Authorization`, `X-API-Key`, `API-Key`) are redacted from HTTP error excerpts and compacted output.
- **Error body truncation.** On non-2xx HTTP responses, Atomic reads at most **8 KiB** of the response body, redacts secrets, normalizes control characters and whitespace, and truncates the excerpt to **500 characters**.
- **Response parsing.** Reads joined non-empty `messages[].content` strings when present, otherwise `output`. Optional `usage` is recorded only when **both** `usage.input_tokens` and `usage.output_tokens` are numbers.
- **Automatic fallback.** Any failure (missing `baseUrl`, missing credentials, network/HTTP error, timeout, malformed/empty output, output exceeding a configured `maxTokens`, or pressing `Escape` / `abortCompaction()`) falls back automatically to memory compaction (`form: "cleared"`) with `fallbackReason` set.

Compaction resets Claude's signed reasoning chain, so `thinking` and `redacted_thinking` blocks do not survive a boundary. See [Preserved thinking and model switches](/models/reference#preserved-thinking-and-model-switches) for behavior between boundaries.

## Automatic trigger and continuation limits {#automatic-trigger-and-continuation-limits}

- **Automatic skip condition.** Automatic compaction skips when the system prompt and clear boundary together would already reach or exceed the automatic trigger (`systemPrompt + boundary >= trigger`), letting [`fallbackModels`](/settings#fallbackmodels) handle provider overflow.
- **Completed answer preservation.** An assistant answer that finishes over the automatic threshold remains as the session's last answer so `prompt()`, RPC `get_last_assistant_text`, and `/copy` can read it; Atomic compacts immediately before the next request.
- **Overflow recovery.** On a provider context-overflow error, Atomic compacts and retries the interrupted turn at most once per turn.
- **Truncated responses (`stopReason: "length"`).**
  - Stopped with `length` before the requested output cap: 1 compact-and-retry, or at most 1 direct continuation if nothing can be compacted.
  - Hit the requested output cap: up to **3** direct continuations.
  - Output-budget error: at most **1** direct continuation.

## The `session_history` tool {#the-session_history-tool}

When an agent's tool allowlist omits `read` or `search` (such as a restricted subagent), Atomic registers one read-only tool named `session_history` (`SESSION_HISTORY_TOOL_NAME`) after its first context clear, or on resume whenever `read` or `search` is absent.

| Parameter | Type | Behavior |
| --- | --- | --- |
| `pattern` | `string` (optional) | Case-sensitive regular expression search over this session's history with 0 surrounding context lines. Combine with `lines` to restrict the search to an entry range or `?cursor=` continuation URL. |
| `lines` | `string` (optional) | 1-based saved-entry range (`"100-300"` or `"120"`) or a `?cursor=` continuation URL from an earlier truncated call. |

- **Limits.** Reads clamp to at most **400 entries** per call (`MAX_READ_ENTRIES`), and output truncates at **50,000 characters** (`MAX_OUTPUT_CHARS`).
- **Isolation.** `session_history` can reach only `history://sessions/<own session id>` and rejects URLs targeting any other session, file, or project, leaving the agent's other tools unchanged.

## Persistence and resume {#persistence-and-resume}

A successful compaction appends a `type: "compaction"` entry (see [`CompactionEntry`](/session-format#compactionentry)):

```json
{
  "type": "compaction",
  "id": "c1",
  "parentId": "m9",
  "timestamp": "2026-11-17T10:00:00.000Z",
  "summary": "Context cleared. Your earlier conversation (51,234 tokens) is no longer in your context window. ...",
  "firstKeptEntryId": null,
  "tokensBefore": 51234,
  "details": {
    "strategy": "verbatim-lines",
    "promptVersion": 7,
    "parameters": {"query": "fix the failing test"},
    "stats": {"linesBefore": 812, "linesDeleted": 812, "linesKept": 0, "rangeCount": 0, "tokensBefore": 51234, "tokensAfter": 2210, "percentReduction": 95.7},
    "form": "cleared",
    "history": {"sessionId": "019f6a2e-...", "rangeUnit": "entries", "entriesBefore": 4210, "boundaryEntry": 4211, "totalEntries": 4211}
  }
}
```

<Note>
**Schema compatibility fields.** `"strategy": "verbatim-lines"`, `promptVersion: 7`, and `stats.rangeCount: 0` are retained from earlier line-based compaction versions as stable schema discriminators so active boundaries stay distinguishable from retired summary-compaction entries—even on a zero-line clear (`form: "cleared"`).
</Note>

| Field | Meaning |
| --- | --- |
| `summary` | Full boundary message shown to the model: `Context cleared` or `Context compacted` text, any compacted text, recovery instructions, and any `/compact` instructions |
| `firstKeptEntryId` | Always `null` on new boundaries because no earlier message stays in context |
| `tokensBefore` | Provider-aware whole-context token count before the boundary, used for budgeting and the chat boundary line |
| `coveredThroughEntryId` | Actively written during resume-budget compaction on Claude models with fixed thinking budgets so newly added resume context (changed instructions, blueprint context, or recovery notices) replays after the boundary; also present on boundaries written by earlier versions while a tool call waited for its result (current Atomic never writes a boundary while a tool call waits) |
| `usage` | Compactor endpoint usage when reported |
| `fromHook` | `true` when an extension supplied compacted text from `session_before_compact` |
| `systemMessage` | Optional replayed system prompt and tool state checkpoint at this boundary |
| `details.form` | `"cleared"` (no model call) or `"compacted"` (compactor or extension supplied replacement text) |
| `details.backend` | `"compactor"` or `"extension"`, present only on `"compacted"` boundaries |
| `details.model` | Compactor ID as `provider/model` when a compactor produced the text |
| `details.fallbackReason` | Reason a configured compactor was not used and context was cleared instead |
| `details.history` | Boundary location in `history://sessions/<sessionId>`: `rangeUnit: "entries"`, `entriesBefore`, `boundaryEntry`, and `totalEntries` |
| `details.historyAccess` | `"read-search"` or `"session-history-tool"`. Resumed sessions receive `session_history` whenever `read` or `search` is absent from resumed tools |
| `details.stats` | Heuristic estimates: `tokensAfter` counts the system prompt and boundary message, `linesBefore` counts replaced context lines, `linesKept` counts compacted lines (`0` on a clear), and `rangeCount` is `0` |
| `details.backupPath` | Path to the pre-compaction backup (`<sessionFile>.<timestamp>.<label>.bak`, never auto-deleted). Populated only for JSONL stores, never SQLite, PostgreSQL, or memory stores (see [Storage](/storage)). |

Only `compaction` entries with `details.strategy: "verbatim-lines"` affect active context. Resuming uses the saved boundary text directly without another model request, and messages appended after the boundary stay ordinary messages. Inactive legacy formats do not reapply historical omissions, so content they previously hid may reappear on resume.

## Extension hooks

Atomic exposes three compaction hooks below plus `session_before_tree` for branch navigation (see [Extension hooks for branch summarization](#extension-hooks-for-branch-summarization)).

### `session_before_compact`

Extensions can cancel compaction or provide custom replacement text before any compactor call runs:

```typescript
atomic.on("session_before_compact", async (event) => {
  const { reason, parameters, preparation, branchEntries, signal } = event;
  if (signal.aborted) return { cancel: true };

  // Optional offline replacement. Empty or whitespace text counts as no replacement.
  if (reason === "manual" && branchEntries.length > 100) {
    const requests = preparation.region.lines.filter((line) => line.startsWith("[User]: "));
    return { compactedText: requests.join("\n") };
  }
});
```

`preparation` (`VerbatimCompactionPreparation`) is a deep-frozen clone (attempting to mutate it throws a `TypeError`):

- `preparation.region` (`NumberedRegion`): the entire active context since the last boundary serialized for hooks—`lines` holds one line per element with role prefixes (`[User]: `, `[Assistant]: `, `[Assistant tool calls]: `, `[Tool result]: `), starting with any prior boundary text; optional `messageSpans` gives `{ role, start, end, previousSummary? }` 1-based line ranges per serialized message; `tokenEstimate` gives its estimated token count.
- `preparation.regionEntryIds`: array of session entry IDs covered by `preparation.region`.
- `preparation.parameters.query`: `/compact` instructions or the latest user request.
- `preparation.firstKeptEntryId` (`null`) and `preparation.keptTailMessageCount` (`0`): fixed compatibility fields kept because current boundaries replace the entire active window.

Return `{ cancel: true }` to cancel compaction. Return `{ compactedText }` to write a `Context compacted` boundary offline without provider credentials; the model sees your text in a `<compacted-context>` block followed by recovery instructions.

Empty or whitespace-only text counts as no replacement, so the configured compaction form runs normally. Extension-supplied `compactedText` has no built-in size limit.

### `session_compact`

Emitted as an observe-only event after the boundary is saved:

```typescript
atomic.on("session_compact", async (event) => {
  console.log(event.result.form, event.result.backend, event.result.model); // "cleared" | "compacted"
  console.log(event.result.fallbackReason);            // set when a configured compactor was not used
  console.log(event.result.history);                   // { sessionId, rangeUnit: "entries", entriesBefore, boundaryEntry, totalEntries }
  console.log(event.compactionEntry.details.strategy); // "verbatim-lines"
  console.log(event.fromExtension);
});
```

`event.result.compactedText` matches the saved entry's `summary`. Observer errors are isolated and cannot roll back the saved boundary.

### `session_compact_failed`

Emitted as an observe-only event when a manual, threshold, or overflow compaction fails or is cancelled:

```typescript
atomic.on("session_compact_failed", async (event) => {
  console.log(event.reason, event.errorMessage);
  console.log(event.aborted, event.willRetry, event.fromExtension);
});
```

`errorMessage` is absent when cancelled. `fromExtension` marks failures after a `session_before_compact` handler supplied replacement text, and no boundary is saved. A compactor failure is not a compaction failure because Atomic falls back to clearing context and reports `fallbackReason` on `session_compact`.

## SDK concurrency and message queuing {#sdk-concurrency-and-message-queuing}

For `session.compact()` usage and return types, see [Compaction and tree navigation](/sdk#compaction-and-tree-navigation).

- **Shared manual runs.** Concurrent manual SDK `session.compact()` calls share one run and resolve to the same result. Calling `abortCompaction()` cancels the run for all waiters, or falls back to clearing context if a compactor request is already in flight.
- **Manual takeover.** A manual compaction request arriving during automatic compaction cancels the automatic work and its continuation, then runs once the active work settles (or follows the automatic boundary if it already committed).
- **Automatic continuations.** Automatic continuations, including output-cap continuations, belong to the original prompt. Both the `prompt()` promise and `agent_settled` finish only after the full continuation chain completes.
- **Waiting messages.** User messages arriving during compaction (from typed input, prompt templates, skills, SDK `prompt()`, RPC `prompt`, or extension `sendUserMessage()`) wait in arrival order until compaction ends, then run once. If an earlier waiting message has already started a turn, later messages without `streamingBehavior` or `deliverAs` queue behind it as steering.
- **Inspecting and clearing queued input.** Waiting messages appear in `getSteeringMessages()`, `getFollowUpMessages()`, and `queue_update` events, and `clearQueue()` returns them without sending them. Before the TUI runs an extension command during compaction, it hands already-typed messages to the session so messages sent by the command run after them.
- **Turn hooks.** SDK `prepareNextTurn` and `prepareNextTurnWithContext` callbacks receive the rebuilt context after mid-turn compaction. Returning `{ action: "end" }` from `finishTurn` keeps queued input pending until an explicit prompt or continuation, while mid-turn compaction resumes streaming automatically.

## Compaction errors {#compaction-errors}

`setCompactionModel()`, RPC `set_compaction_model`, session compaction calls, and direct `requestCompactorOutput()` calls throw subclasses of `CompactionError`. Branch on the class or `error.code`, not on the message string.

<Note>
Reading an invalid `compactionModel` or `compaction.reserveTokens` value from `settings.json` throws a plain `Error` rather than `CompactionConfigError`.
</Note>

| Class | `code` | `retryable` | Subclass fields | When |
| --- | --- | --- | --- | --- |
| `CompactionConfigError` | `invalid-setting` | `false` | `source`, `field`, `scope?` | `setCompactionModel()` receives a non-string or whitespace-padded `model`; RPC `set_compaction_model` additionally validates `scope` (`"global" \| "project"`) and `persist` (`boolean`) at runtime |
| `CompactionCancelledError` | `cancelled` | `false` | `reason?` | Compaction is cancelled via abort signal or `session_before_compact` returning `{ cancel: true }` |
| `CompactionStateError` | `nothing-to-compact`, `pending-tool-call`, `no-model-selected`, `snapshot-failed`, `boundary-not-built` | `false` | `detail?` | `session.compact()` cannot proceed in the current session state |
| `CompactorFailure` | `missing-base-url`, `missing-credentials`, `request-aborted`, `timeout`, `http-error`, `network-error`, `malformed-response`, `empty-output`, `compactor-failed` | `true` for `timeout`, `network-error`, and HTTP `408`/`429`/`5xx`; `false` otherwise | `status?`, `timeoutMs?`, `model?` | Direct `requestCompactorOutput()` fails (during `session.compact()`, Atomic catches `CompactorFailure` and falls back to clearing context) |

Every `CompactionError` carries `code`, `hint`, `retryable`, and `fields()`. Use `isCompactionError`, `isCompactionConfigError`, `isCompactionCancelledError`, `isCompactionStateError`, `isCompactorFailure`, `findCompactionError`, and `isRetryableCompactionError` to match errors across realms or cause chains. Use `serializeCompactionError`, `parseSerializedCompactionError`, and `rehydrateCompactionError` to preserve the typed class across worker or RPC boundaries (the RPC client rehydrates `compaction_error` responses automatically).

## Package exports

`@bastani/atomic` exports these compaction and branch-summarization helpers, errors, and types:

| Export | Use |
| --- | --- |
| `CompactionError`, `CompactionConfigError`, `CompactionCancelledError`, `CompactionStateError`, `CompactorFailure` | Typed compaction error family (`code`, `hint`, `retryable`, `fields()`) |
| `isCompactionError`, `isCompactionConfigError`, `isCompactionCancelledError`, `isCompactionStateError`, `isCompactorFailure`, `findCompactionError`, `isRetryableCompactionError` | Type guards and cause-chain helpers for compaction errors |
| `serializeCompactionError`, `parseSerializedCompactionError`, `rehydrateCompactionError` | Cross-process serialization and rehydration for `CompactionError` |
| `buildBoundaryText(input, totalEntries)` | Build the boundary message for a session, history location, and optional instructions or compacted text |
| `buildCompactorMessages(messages, isBoundary)` | Frame active context messages in the wire format sent to a compactor |
| `requestCompactorOutput(request)` | Send one `CompactorRequest` to a compactor endpoint; resolves `{ text, usage? }` or throws `CompactorFailure` / `CompactionCancelledError` |
| `resolveCompactionModel(configured, models)` | Resolve `compactionModel` to a `CompactionModelSelection` (`auto` with any fallback reason, or a compactor) |
| `classifyCompactionModel(configured, models)` | Classify a `compactionModel` string as `"auto"`, `"compactor"`, `"chat"`, `"classifier"`, or `"unknown"` |
| `prepareCompactionBoundary`, `shouldCompact`, `calculateContextTokens`, `getLastAssistantUsage`, `DEFAULT_COMPACTION_SETTINGS` | Compaction threshold checks, token counting, boundary preparation, and default compaction settings |
| `estimateTokens`, `estimateTextTokens`, `wrapLongLines`, `serializeConversation`, `serializeConversationForCompaction` | Token estimation, 2,000-char line wrapping, and conversation serializers |
| `collectEntriesForBranchSummary`, `prepareBranchEntries`, `generateBranchSummary` | Branch-entry collection, budget trimming, and branch summary generation |
| `COMPACTOR_REQUEST_TIMEOUT_MS` | Default wall-clock request timeout in milliseconds (`120000`) when a compactor model omits `timeoutMs` |
| `SESSION_HISTORY_TOOL_NAME` | `"session_history"`, the read-only history tool granted after clearing when `read` or `search` is absent |

The types `CompactorModel`, `CompactorApi`, `ProviderCompactorModelConfig`, `CompactionForm`, `CompactionBackend`, `CompactionHistoryLocation`, `CompactionModelKind`, `CompactionModelSelection`, `CompactorMessage`, `CompactorRequest`, `CompactionErrorCode`, `SerializedCompactionError`, `BranchSummaryEntry`, `BranchPreparation`, `BranchSummaryResult`, `CollectEntriesResult`, `FileOperations`, `GenerateBranchSummaryOptions`, `LineRange`, `VerbatimCompactionDetails`, `VerbatimCompactionParameters`, `VerbatimCompactionPreparation`, and `VerbatimCompactionResult` are exported alongside them.

## Branch summaries {#branch-summaries}

### Branch summary format {#branch-summary-format}

Built-in branch summarization prepends the preamble `"The user explored a different conversation branch before returning here.\nSummary of that exploration:\n\n"` and writes structured Markdown with these sections:

```markdown
## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [Requirements mentioned by user]

## Progress
### Done
- [x] [Completed tasks]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues, if any]

## Key Decisions
- **[Decision]**: [Rationale]

## Next Steps
1. [What should happen next]

<read-files>
path/to/file1.ts
path/to/file2.ts
</read-files>

<modified-files>
path/to/changed.ts
</modified-files>
```

### `BranchSummaryEntry` structure

`BranchSummaryEntry` is exported from `@bastani/atomic` (see [`BranchSummaryEntry`](/session-format#branchsummaryentry)). Default branch summarization stores cumulative file lists in `details`, while extensions can store custom metadata:

```typescript
interface BranchSummaryEntry<T = unknown> {
  type: "branch_summary";
  id: string;
  parentId: string | null;
  timestamp: string; // ISO timestamp
  fromId: string;    // Entry we navigated from
  summary: string;
  details?: T;       // Implementation-specific data (not sent to LLM)
  usage?: Usage;     // Usage from the summary model call
  fromHook?: boolean; // true if supplied by an extension
}

// Default branch summarization stores this shape in details:
interface BranchSummaryDetails {
  readFiles: string[];
  modifiedFiles: string[];
}
```

### Message serialization and edge cases

Branch-summary prompts serialize conversation messages with role labels so the model summarizes rather than continuing the conversation:

```text
[User]: What they said
[Assistant]: Response text
[Assistant tool calls]: read(path="foo.ts"); edit(path="bar.ts", ...)
[Tool result]: Output from tool
```

Thinking blocks are omitted. Built-in branch summarization truncates every tool result to **500 characters** before serialization (with a marker stating how many characters were removed). Calling `serializeConversation()` directly on unshortened messages truncates tool results at 2,000 characters.

Key edge cases in `generateBranchSummary()`:

- **Empty branch.** When no summarizable messages exist in the abandoned segment, `generateBranchSummary()` returns `{ summary: "No content to summarize" }` without calling the model.
- **Nested branch summaries near the budget.** When walking newest-to-oldest reaches `tokenBudget`, an earlier `branch_summary` entry is still included if `totalTokens < tokenBudget * 0.9` so nested branch context is preserved when almost enough room remains.
- **Replacing the default prompt.** Setting `replaceInstructions: true` alongside `customInstructions` on `GenerateBranchSummaryOptions` replaces the built-in structured summary prompt instead of appending `Additional focus: ...`.

### Extension hooks for branch summarization {#extension-hooks-for-branch-summarization}

`session_before_tree` fires before `/tree` navigation regardless of whether the user requested a summary. Handlers can cancel navigation or supply a custom summary:

```typescript
atomic.on("session_before_tree", async (event, ctx) => {
  const { preparation, signal } = event;

  // preparation.targetId - destination entry ID
  // preparation.oldLeafId - current leaf being abandoned
  // preparation.commonAncestorId - shared ancestor entry ID
  // preparation.entriesToSummarize - entries in the abandoned branch
  // preparation.userWantsSummary - whether the user requested a summary

  // Cancel navigation:
  return { cancel: true };

  // Provide a custom summary (applied only when userWantsSummary is true):
  if (preparation.userWantsSummary) {
    return {
      summary: {
        summary: "Your summary...",
        details: { /* custom data */ },
      },
    };
  }
});
```

`SessionBeforeTreeEvent` and `SessionBeforeTreeResult` are exported from `@bastani/atomic`.

## Settings {#settings}

Configure compaction in `~/.atomic/agent/settings.json` or `<project-dir>/.atomic/settings.json` (legacy `.pi` paths are also supported):

```json
{
  "compactionModel": "auto",
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384
  }
}
```

See [Compaction settings](/settings#compaction) for the complete `compaction` and `branchSummary` settings table, and [Select a compaction model](/compaction/custom-compactors#select-a-compaction-model) for choosing memory compaction (`auto`) or a registered compactor. Setting `"compaction": { "enabled": false }` turns off automatic compaction while keeping manual `/compact` available.

<Note>
**Removed settings.** These legacy compaction settings are ignored without error if still present in `settings.json` (or passed to `session.compact()`): `compaction.compression_ratio`, `compaction.preserve_recent`, `compaction.keepContextShare`, `compaction.query`, `compaction.planningTimeoutMs`, `compaction.modelOverrides`, `compaction.background`, `compaction.backgroundThresholdPercent`, and `compaction.historyRecall`. Configure endpoint-specific parameters like `compression_ratio` or `preserve_recent` under `compactionParams` in `models.json` instead.
</Note>

## Historical formats

Older compaction records remain parseable:

- Earlier `type: "compaction"` entries with `details.strategy: "verbatim-lines"` and no `details.form` kept filtered conversation lines or a summary. They remain active and replay as written, displaying as `Context compacted` (or `Context cleared` for boundaries that started a fresh window).
- Retired `type: "context_compaction"` records stored logical entry and content-block deletions. They are inert, so previously hidden content may reappear when an old session resumes.
- Older `type: "compaction"` entries without `details.strategy: "verbatim-lines"` stored summary prose and are also inert.
