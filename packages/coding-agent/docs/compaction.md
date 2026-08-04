# Compaction & Branch Summarization

LLMs have finite context windows. Atomic reduces transcript context with **verbatim line compaction** while preserving an exact count of recent context-visible messages as ordinary messages. Branch summarization is a separate, intentionally lossy feature used only when navigating away from a branch.

Compaction runs entirely locally; no external compaction service is involved. It normally uses the active session model. If that model cannot rank the lines — a rate limit, a quota exhaustion, a provider error, a context overflow, or an empty plan — Atomic *borrows* the next model from your configured `fallbackModels` for that one planner request. **A configured fallback model may therefore receive the compaction transcript**, and it is sent with that provider's own credentials. Borrowing never changes the session's model or thinking level. The model only selects which lines to delete — Atomic reconstructs the retained text mechanically, so surviving lines are never rewritten.

## Overview

| Mechanism | Trigger | Model output | Durable result |
|---|---|---|---|
| Verbatim compaction | `/compact`, RPC `compact`, or automatic threshold/overflow recovery | Bare `start,end` deletion records (one per line) | A `CompactionEntry` whose `summary` is mechanically reconstructed transcript text |
| Planner fallback borrowing | Any terminal planner outcome on the current planner model | Same deletion records, from a configured `fallbackModels` entry | The same `"planned"` boundary, with `details.plannerModel` naming the borrowed model |
| Fresh context window | Load-bearing compaction after every configured model failed | *(none — no model call)* | A `CompactionEntry` with `details.rung: "fresh"` |
| Branch summarization | Optional `/tree` navigation | Generated summary prose | A `BranchSummaryEntry` |

There is one context-compaction door: `compact`.

## Verbatim Line Compaction

### What "verbatim" means

Atomic serializes the compactable part of the conversation into role-tagged lines:

```text
[User]: Fix the failing parser test
[Assistant thinking]: I will inspect the parser.
[Assistant tool calls]: read(path="src/parser.ts")
[Tool result]: export function parse(...) {
...
[Assistant]: The off-by-one error is fixed.
```

The planner sees the same text numbered as `N→content` and returns only one-based, inclusive line ranges as bare records:

```text
2,5
```

Each line is `start,end` — unsigned decimal integers, one comma, no brackets or prose. Atomic safety-normalizes endpoints by swapping reversed pairs, clamping to the transcript, sorting, merging overlap/adjacency, and splitting around explicit protected spans. It then reconstructs from the original input lines. The model never writes, summarizes, reorders, or normalizes retained text. Every retained non-marker line is byte-identical to an input line and remains in input order.

### Markers and repeated compaction

Each deleted span is replaced on its own line with exactly:

```text
(filtered N lines)
```

The spelling is always plural, including `(filtered 1 lines)`. When a later compaction swallows an earlier marker, Atomic adds the earlier marker's count to the new marker. Adjacent old markers are folded too, so counts remain cumulative across repeated compactions. On repeated compaction, the planner receives the prior durable verbatim summary plus every currently active ordinary message except the exact protected tail.

### Protected structure

Role-header lines such as `[User]:` and `[Assistant]:` are ordinary ranked lines and may be deleted. Explicit protected spans, including blank lines, are never deleted. The configured number of newest context-visible messages remains outside the classifier request entirely; all preceding active transcript content is included.

Images in the compactable region become the literal line `[image]`; images in the protected recent tail remain normal image content. Tool-result text remains capped at 16,000 characters before becoming durable compaction text, with an explicit truncation marker for the remainder.

### `keepContext` tags

Wrap any section you never want compressed in `<keepContext>` / `</keepContext>`. Tagged content survives compression verbatim regardless of the compression ratio:

```
<keepContext>
You are researching only. Do not implement code changes.
</keepContext>
```

Every line of the span becomes a protected line, tag lines included, and the guarantee is mechanical rather than advisory: deletion ranges are split around protected lines after the planner responds, so a protected line survives even if the planner ignores its instructions.

Three properties are worth knowing when using this for long-lived instructions:

- **Spans re-arm themselves.** Each compaction re-ranks the previous compaction's output, so a constraint must survive every cycle, not just the first. Because the tag lines are protected too, the span is re-detected on the next boundary and stays protected for the life of the session.
- **Tags are structural and bounded.** Each tag must be the whole line, after the transcript's role header — a tag mentioned inside prose is payload, not syntax. A span opens and closes within one message, and an unclosed span protects through the end of *its own message*, never the rest of the region. User and assistant messages may both protect: prompts, run inputs, and steering arrive as user messages, and an agent may pin its own core information — a restated contract amendment, a decision that changes later behavior. Tags inside **tool results** are inert, because that payload is file contents, fetched pages, and command output, and honoring it would let read material mark itself unreclaimable and persist ahead of real content; restate what matters in your own message instead. A closing tag with no opener is ignored.
- **Kept content counts against the compression budget.** Protection does not raise the keep target. Protect 40% under a `compression_ratio` of `0.5` and the remaining 60% compresses harder to reach the same total, so the ratio stays a real bound on output size. Protecting more therefore costs the surrounding transcript, which is why the guidance is to tag the constraint rather than the material it applies to.

Results report the force-preserved ranges as `keptRanges`, so protection that fired unexpectedly is diagnosable rather than a silent reduction in what compaction reclaimed.

Use it for role constraints, invariants, and anything whose loss would silently change behavior. Prefer it over restating a constraint: without tags, a one-line constraint competes line-by-line against bulky tool output and is the cheaper deletion.

## Parameters

The effective parameters appear in extension events and successful results:

| Parameter | Default | Meaning |
|---|---:|---|
| `compression_ratio` | `0.5` | Fraction of compactable **lines to keep**, not a token ratio |
| `preserve_recent` | `2` | Exact number of newest context-visible messages protected client-side |
| `query` | Last visible user message | Relevance focus for deciding which older lines to retain |

`preserve_recent` counts context-visible messages without aligning the boundary to a user turn. An assistant message or tool result may therefore begin the kept tail. Because such a tail can start or end mid-turn, the kept messages are not replayed as structured message blocks: they are serialized with the same transcript grammar as the compacted region and appended to the end of the boundary string, so the whole boundary reaches the provider as one message. Serialization of the kept tail is lossless — tool results keep their full text instead of being truncated at 16k characters, and images stay attached as image blocks rather than becoming `[image]` markers — so protected content is preserved, not merely summarized. A value of `0` protects no messages and makes the entire active transcript compactable. If `query` is absent, Atomic derives it from the last visible user message.

The query is used whole and is never truncated. This matters for structured prompts: a truncated query would make section order the retention policy, because only the leading section could influence what the planner kept, and a constraint stated later in the prompt could not. Long queries are safe — an oversized planner request surfaces as an explicit provider-overflow failure rather than silent truncation — but `keepContext` tags, not query length, are the way to guarantee a span survives.

Configure defaults in `~/.atomic/agent/settings.json` or `.atomic/settings.json`:

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "compression_ratio": 0.5,
    "preserve_recent": 2,
    "query": "optional focus"
  }
}
```

`reserveTokens` controls the automatic threshold that decides when compaction runs; it is not converted into a classifier line ratio. Manual calls can pass parameter overrides through the SDK.

## When compaction runs

- **Manual:** `/compact`, `ctx.compact()`, `session.compact()`, or RPC `{ "type": "compact" }`.
- **Threshold:** automatic compaction starts when estimated context usage exceeds the effective input budget minus `reserveTokens`. Atomic checks both completed responses and the prospective next-turn context after tool results have been appended. A post-tool crossing is compacted before the active Pi tool loop sends its follow-up provider request.
- **Overflow:** an actual provider context overflow compacts and then retries the interrupted turn.

Exactly the configured recent-message tail is outside the compactable region; Atomic does not force the final logical turn to remain outside it. After successful automatic compaction, input queued before compaction started resumes automatically once the active run becomes idle; pressing Escape is not required to release it. Pressing Escape while compaction is active cancels it like other session operations. In isolated interactive mode, cancellation and host UI response frames use an independent RPC control lane, so they can reach the engine while the ordinary `compact` request is still pending instead of waiting behind it. Atomic writes a backup snapshot immediately before appending a compaction boundary.

Manual compaction is single-flight. A manual request made while another manual compaction is still in flight joins that run and receives its result instead of starting a second model call, so it emits no extra `compaction_start`/`compaction_end` pair and appends no extra boundary; `abortCompaction()` (Escape) still cancels the single owning run for every waiter. A manual request made while an automatic compaction is in flight is rejected immediately with an "automatic compaction is already in progress" error rather than racing it. In the interactive TUI, `/compact` typed while any compaction is active is refused with a warning; it is not queued, because queueing would only defer a duplicate compaction. Ordinary text typed during compaction is still queued as usual.

The post-tool check stays inside the active Pi loop: it runs the rung ladder once for that completed tool turn, returns the rebuilt context to the loop, and never calls or schedules `agent.continue()`. Normal context reconstruction preserves provider tool-call/result protocol validity. Below-threshold tool turns follow the unchanged request path. Because the same active run resumes without emitting another `agent_start`, the interactive TUI replaces the compaction loader with its working spinner as soon as successful mid-turn compaction ends; streaming feedback therefore resumes immediately without waiting for another user interaction.

## Planning rungs and failure behavior

Atomic asks a planner model, at the inherited session reasoning level and through the normal session stream/provider wrapper, to rank every eligible line in one global pass and apply one threshold. The entire compactable region is sent in one classifier request; it is never split into chunks. Manual, threshold, and overflow compaction all calculate the line target directly from the prepared `compression_ratio`. Explicit protected lines form a hard keep floor.

**The planner sends no output cap.** Only the provider's own context clamp bounds the response, so reasoning tokens cannot crowd out the deletion records. The reasoning level is inherited from the session and is never modified between attempts; a `model:level` suffix on a `fallbackModels` entry sets the level for that candidate only.

Each planner attempt ends in exactly one typed outcome:

| Outcome | Meaning | What happens next |
|---|---|---|
| ranked | Valid deletion records | Boundary written, `rung: "planned"` |
| recovered | A length-truncated response with usable complete records | Boundary written silently, `rung: "planned"` |
| overflowed | The planner request itself exceeded the context window, including a silent overflow that arrives as an ordinary `stop` or `length` completion whose usage already exceeds the window — classified before the response text is parsed, so valid-looking records or truncation recovery cannot mask it | The oldest region lines are withheld and the *same* model retried, repeatedly, until no strictly smaller view remains; the withheld head becomes a deterministic deletion |
| rateLimited | A limit failure. `category` says which one — `rate_limited` for `429`/rate limit/overloaded/any `5xx`, `quota` for quota, billing, or usage-limit exhaustion — and `exhausted` separately reports whether a retry was actually scheduled | Advance to the next configured model |
| unusable | Malformed output, no usable safe ranges, or reasoning starvation (`starved`) | Advance to the next configured model |
| providerError | Any other provider or transport failure | Advance to the next configured model |

Each trimmed retry halves the remaining suffix, so the walk is finite, and each view
derives its own keep target from `compression_ratio`. Carrying the original
whole-preparation target into a smaller view would ask it to keep every visible
line — a request for zero deletions, whose obedient empty answer then hits the
zero-usable-ranges rejection. The planner
door returns validated line numbers, so no unvalidated model output leaves it,
and the runner still validates once more before writing a boundary.

Generic usage-limit wording, such as `The usage limit has been reached`, is
classified as quota exhaustion (`exhausted: false`). That is a deliberate local
addition rather than a copy of pi-ai's tables: pi-ai lists it in neither its
retryable nor its non-retryable set, so it never spends a backoff, and reporting
it as transient throttling would claim a retry budget that was never used.

Unavailable credentials are ladder control flow, not an early failure. If the
session model has no usable credentials, no request is attempted for it, that
candidate is marked attempted, and a configured fallback with its own working
credentials can still rank the lines. A load-bearing caller with no usable
credentials anywhere still reaches the credential-free fresh rung; a recoverable
caller reports the original authentication error and writes nothing.

`settings.retry` still governs transport attempts *within* one candidate, with its existing backoff. When a candidate is exhausted, Atomic borrows the next entry from `settings.fallbackModels`, resolving that candidate's own credentials. Each candidate is tried at most once per compaction run, in configured order, keyed by `provider/model:thinkingLevel`. That walk is one monotonic pass over the configured list. Each position is inspected at most once — whether it fails to resolve to a model, has no usable credentials, duplicates an earlier identity, or yields a planner — so the order can never rewind to an earlier entry even if the registry or its credentials later change.

Borrowing never mutates the session: no `agent.state.model` write, no model-change or thinking-level entry, no system-prompt refresh, no `model_changed`/`model_select`/`model_fallback_start`, and no `agent.continue()`. After compaction returns, `session.model` is exactly what it was before, and the main chat's own fallback bookkeeping is untouched.

When every configured model is exhausted, what happens depends on how much the caller can afford to lose:

| Call site | Urgency | Can borrow a model | Can start a fresh context window |
|---|---|---|---|
| `/compact`, `ctx.compact()`, `session.compact()`, RPC `compact` | recoverable | yes | no |
| Threshold auto-compaction | recoverable | yes | no |
| Overflow recovery | load-bearing | yes | yes |
| Post-tool preflight | load-bearing | yes | yes |

A recoverable compaction fails honestly: it writes no compaction entry, schedules no continuation, and reports the typed cause through `compaction_end`. Manual compaction's recoverable urgency is fixed at the door: `session.compact()` projects only compaction parameters, so no runtime property on a caller-supplied object can raise it to `load_bearing` and reach the destructive rung. A load-bearing compaction always completes, falling through to the **fresh context window** rung described below.

A syntactically valid usable result is accepted once after safety-only normalization, even when it deletes fewer lines or tokens than requested. Atomic never adds or restores model-selected deletions to force a target. During overflow recovery, the existing one-shot compact-and-retry continuation may therefore surface unresolved overflow naturally.

### The fresh context window rung

`startNewContextWindow` is total: no provider, no credentials, no network, no failure mode. A region below the planner minimum reaches it only when the context is already known not to fit — overflow recovery, or a post-tool preflight whose projected context is over the provider hard input limit — because no planner change could make such a region rankable. A post-tool threshold crossing that still fits is a safe no-op instead: no boundary, no planner call, and the follow-up request proceeds unchanged. Clearing a context that fits would destroy conversation for nothing. It discards the compactable region and any prior durable summary, keeps explicit protected spans, and keeps the `preserve_recent` protected tail — dropping the tail only when the tail **alone** exceeds the provider hard input limit, in which case the boundary persists `firstKeptEntryId: null`. It emits the whole region as one deletion range and hands it to the same validation and reconstruction path as every other rung, so retained lines stay byte-identical.

A committed fresh boundary stays visible even when the following provider hard-input-limit gate reports its own error: `compaction_end` carries `result` and `errorMessage` independently, and the boundary is shown before the status. The fresh rung destroys conversation, so it is loud: the boundary reads `✻ Context cleared (compaction degraded)` instead of `✻ Context compacted`, in the main chat and in attached workflow stage chat alike, and `details.rung` records `"fresh"` durably. The precise cause stays in the `0600` diagnostic sidecar.

The ladder guarantees that *compaction* completes. It does not guarantee the *turn* succeeds: if every configured model is rate limited, the follow-up request will be too. What it buys is that a compaction failure does not additionally destroy the turn, that a healthy fallback model rescues quality when one exists, and that the retry starts from a small context.

During a post-tool preflight, Atomic still gates the rebuilt context: if it is known to exceed the provider's hard input limit even after compaction, Atomic refuses to send the follow-up request and reports the limit failure clearly. The fresh rung's tail-dropping rule exists so that gate is reachable rather than hollow.

### Length-truncated response recovery

When the planner model's output is truncated at the provider's own limit (indicated by `stopReason: "length"`), Atomic silently recovers complete newline-terminated deletion records from the truncated response. Atomic sends no `max_tokens` of its own, so this reflects the provider's context clamp rather than a caller-imposed cap. A deterministic line parser validates each completed line (those followed by a newline) against the strict `start,end` grammar. The final fragment after the last newline is always discarded — even if it looks syntactically complete — because EOF may have cut a multi-digit integer (e.g. `300,30` could have intended `300,305`). If any completed line has invalid syntax or zero usable records survive validation, the attempt becomes an `unusable` outcome and the ladder advances.

Example of truncated output:

```text
120,180
6,40
300,
```

Recovery yields `120,180` and `6,40`; discards `300,` without guessing. The planner prompt instructs the model to emit ranges in descending deletion confidence (lowest continuation value first) so the most important deletions appear earliest and survive truncation.

Successful partial recovery is an ordinary successful compaction: no warning, banner, toast, or special status copy appears. The UI shows the normal spinner then `✻ Context compacted`.

For operational observability, a private recovery diagnostic sidecar is written beside persisted sessions with `0600` permissions. It records the full raw response, stop reason, usage (including `usage.reasoning`), the request `maxTokens` (now always absent, since no cap is sent), model metadata, recovered range count, and recovery category. The sidecar path is never surfaced in the success UI, error messages, or user-visible status. In-memory sessions and sidecar write failures do not affect the successful recovery.

### Planner failure diagnostics

For a persisted session, each failed planner attempt writes its own JSON sidecar beside the session JSONL and carries the path on the typed outcome. When a recoverable compaction exhausts every configured model, the resulting `RangePlanError` includes that path, for example:

```text
Compaction range planning returned malformed output (diagnostic: /path/session-compaction-diagnostic-1785222000000-019fa7….json)
```

The private sidecar uses `0600` permissions where supported and records the full planner response text, stop reason, provider error, usage, the request `maxTokens` (absent — no cap is sent), timestamp, failure category, and non-secret model metadata for **the model that made that attempt**, so a run rescued by a fallback leaves per-model evidence. It does not record API keys, request headers, the planner prompt, or the numbered transcript request. The raw response itself may contain sensitive text if the model echoed input, so treat the sidecar with the same care as its adjacent session file.

Diagnostic categories distinguish malformed output, valid output with no usable ranges, provider errors, stream failures, reasoning starvation (`starved`), transient rate limiting (`rate_limited`), quota exhaustion (`quota`), and context overflow (`context_overflow`) — overflow is a distinct typed outcome in code, so it is distinct in the durable record too rather than folded into a generic provider failure. When a *borrowed* fallback model produces the accepted ranking, a separate `<session>-compaction-success-<timestamp>-<id>.json` sidecar records that model and its effective thinking level, so a rescued run leaves evidence for both the model that failed and the model that succeeded. Quota, billing, and usage-limit exhaustion get their own `quota` category, so they stay distinguishable from transient throttling in the durable record and not only in provider text. A limit record additionally sets `rateLimitExhausted`, derived from observed retry activity: `true` only when a retry was actually scheduled, and `false` for quota or for a throttled request under a disabled or zero retry budget. Atomic classifies the whole HTTP `5xx` class as rate limiting, which is a local broadening — pi-ai lists only selected statuses, so it may schedule no backoff for one Atomic types this way, and `rateLimitExhausted` reports that fact rather than assuming it. Every sidecar filename carries both a timestamp and a per-attempt identifier, and is created exclusively, so two attempts inside the same millisecond — routine across overflow trims or a fast fallback walk — cannot overwrite each other's evidence. In-memory sessions do not create sidecars. If the diagnostic write fails, Atomic preserves the original classification rather than replacing the planner outcome.

Interactive main chat and attached workflow stage chat treat `compaction_end` as the authority for cancellation and failure UI. A failed or cancelled `/compact` stops its spinner, shows the event-provided status or diagnostic path without a duplicate stack trace, writes no boundary, and leaves the session usable for another `/compact` attempt or a normal follow-up turn.

Context thresholds and persisted token-reduction statistics use API-aware normalized usage. OpenAI Responses, Codex Responses, and OpenAI Completions sum uncached input plus cache-read/cache-write partitions. Anthropic Messages alone applies the mirrored-cache guard needed by compatible endpoints that duplicate the same prompt tokens across `input` and cache fields.

## Persistence and resume

A successful run appends the existing pi-style `type:"compaction"` entry shape:

```json
{
  "type": "compaction",
  "id": "c1",
  "parentId": "m9",
  "timestamp": "2026-07-13T10:00:00.000Z",
  "summary": "[User]: fix the failing test\n(filtered 42 lines)\n[Assistant]: Fixed.",
  "firstKeptEntryId": "m7",
  "tokensBefore": 51234,
  "details": {
    "strategy": "verbatim-lines",
    "promptVersion": 3,
    "rung": "planned",
    "parameters": {"compression_ratio": 0.5, "preserve_recent": 2, "query": "fix the failing test"},
    "stats": {"linesBefore": 812, "linesDeleted": 417, "linesKept": 395, "rangeCount": 63, "tokensBefore": 51234, "tokensAfter": 24980, "percentReduction": 51.2}
  }
}
```

`details.rung` is one of `"planned"` (a model ranked the lines — the session model **or** a borrowed fallback, including silent partial recovery), `"extension"` (a `session_before_compact` override), or `"fresh"` (the compactable conversation was discarded and a new context window started). `details.plannerModel` is present **only** when a borrowed fallback model ranked the lines:

```json
"details": {
  "strategy": "verbatim-lines",
  "promptVersion": 3,
  "rung": "planned",
  "plannerModel": {"provider": "openai", "id": "gpt-5.1", "thinkingLevel": "high"}
}
```

There is no format-version bump and no new entry type. Both `"fresh"` and `plannerModel` are additive: they are absent on every existing entry and on any compaction that used the session model, so old readers are unaffected. A `"fresh"` boundary that had to drop the `preserve_recent` tail persists `firstKeptEntryId: null`.

A `compaction` entry is active only when `details.strategy === "verbatim-lines"`. On rebuild, Atomic emits one visible custom-role boundary message: the durable `summary` with the kept tail—the entries from `firstKeptEntryId` up to the boundary—serialized and concatenated onto its end. The tail is never restored as separate assistant/tool-result blocks, so a tail that starts or ends mid-turn cannot produce out-of-order provider blocks; images inside the tail ride along as image blocks on that same boundary message. When no pre-boundary context-visible message is retained—such as with `preserve_recent: 0`—`firstKeptEntryId` is `null` and the boundary carries the `summary` alone. Messages appended after the boundary are always replayed as real messages. The boundary is converted to a user-role provider message and shown in the TUI as a collapsible compaction card.

Resume does not rerun planning or re-derive deletions: the exact compacted string and nullable tail boundary are already in JSONL. Existing records with a string `firstKeptEntryId` keep their original resume behavior. Legacy `context_compaction` logical-deletion records and old `compaction` summary records without the discriminator are inert archival data. Their historical omissions are not reapplied when an old session resumes.

## Extension hooks

### `session_before_compact`

Extensions may cancel or provide a complete replacement for the prepared region:

```typescript
pi.on("session_before_compact", async (event) => {
  const { reason, parameters, preparation, branchEntries, signal } = event;
  if (signal.aborted) return { cancel: true };

  // Optional offline override. It must contain non-whitespace text.
  if (reason === "manual" && branchEntries.length > 100) {
    return { compactedText: preparation.region.lines.slice(0, 40).join("\n") };
  }
});
```

`preparation` is a deep-frozen clone. An override changes only the compacted region text; Atomic retains the prepared boundary and persists the supplied text verbatim. Empty/whitespace text is rejected. The override path does not require provider credentials.

### `session_compact`

After persistence, Atomic emits an observe-only event:

```typescript
pi.on("session_compact", async (event) => {
  console.log(event.result.rung, event.result.stats);   // rung: "planned" | "extension" | "fresh"
  console.log(event.result.plannerModel);               // set only when a fallback model was borrowed
  console.log(event.compactionEntry.details.strategy);  // "verbatim-lines"
  console.log(event.fromExtension);
});
```

Observer errors are isolated and cannot roll back the already-persisted boundary.

## Branch Summarization

### When It Triggers

When you use `/tree` to navigate to a different branch, Atomic offers to summarize the work you're leaving. This injects context from the left branch into the new branch.

Branch summarization is a separate mechanism from context compaction. It generates a summary of the abandoned branch path and injects it into the new branch position. This is appropriate here because the alternative (losing branch context entirely on navigation) is worse than a lossy summary.

### How It Works

1. **Find common ancestor**: Deepest node shared by old and new positions
2. **Collect entries**: Walk from old leaf back to common ancestor
3. **Prepare with budget**: Include messages up to token budget (newest first)
4. **Generate summary**: Call LLM with structured format
5. **Append entry**: Save `BranchSummaryEntry` at navigation point

```mermaid
%%{init: {'theme':'base', 'themeVariables': { 'primaryColor':'#f8f9fa','primaryTextColor':'#2c3e50','primaryBorderColor':'#4a5568','lineColor':'#4a90e2','secondaryColor':'#ffffff','tertiaryColor':'#e9ecef'}}}%%
flowchart TD
    A["user navigates /tree\nold leaf → new target"]
    B["find common ancestor"]
    C["collect abandoned branch entries\n(old leaf → common ancestor)"]
    D["prepare with token budget\n(newest first)"]
    E["generate branch summary\nLLM call · structured format"]
    F["append BranchSummaryEntry\nat common ancestor or new target"]
    G["navigate to new target\nbranch summary context carried forward"]

    A --> B --> C --> D --> E --> F --> G
```

```text
Tree before navigation:

         ┌─ B ─ C ─ D (old leaf, being abandoned)
    A ───┤
         └─ E ─ F (target)

Common ancestor: A
Entries to summarize: B, C, D

After navigation with summary:

         ┌─ B ─ C ─ D ─ [summary of B,C,D]
    A ───┤
         └─ E ─ F (new leaf)
```

### Cumulative File Tracking

Branch summarization tracks files cumulatively. When generating a summary, Atomic extracts file operations from:

- Tool calls in the messages being summarized
- Previous branch summary `details` (if any)

This means file tracking accumulates across nested branch summaries, preserving the full history of read and modified files.

### BranchSummaryEntry Structure

Defined in [`session-manager.ts`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/core/session-manager.ts):

```typescript
interface BranchSummaryEntry<T = unknown> {
  type: "branch_summary";
  id: string;
  parentId: string | null;
  timestamp: string;  // ISO timestamp
  summary: string;
  fromId: string;      // Entry we navigated from
  fromHook?: boolean;  // true if provided by extension (legacy field name)
  details?: T;         // implementation-specific data
}

// Default branch summarization uses this for details (from branch-summarization.ts):
interface BranchSummaryDetails {
  readFiles: string[];
  modifiedFiles: string[];
}
```

Extensions can store custom data in `details`.

See [`collectEntriesForBranchSummary()`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/core/compaction/branch-summarization.ts), [`prepareBranchEntries()`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/core/compaction/branch-summarization.ts), and [`generateBranchSummary()`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/core/compaction/branch-summarization.ts) for the implementation.

## Branch Summary Format

Branch summarization uses a structured format:

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

## Critical Context
- [Data needed to continue]

<read-files>
path/to/file1.ts
path/to/file2.ts
</read-files>

<modified-files>
path/to/changed.ts
</modified-files>
```

### Message Serialization for Branch Summaries

Before branch summarization, messages are serialized to text via [`serializeConversation()`](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/src/core/compaction/utils.ts):

```text
[User]: What they said
[Assistant thinking]: Internal reasoning
[Assistant]: Response text
[Assistant tool calls]: read(path="foo.ts"); edit(path="bar.ts", ...)
[Tool result]: Output from tool
```

This prevents the model from treating it as a conversation to continue.

Tool results are truncated to 2000 characters during serialization. Content beyond that limit is replaced with a marker indicating how many characters were truncated.

## Extension Hooks for Branch Summarization

### session_before_tree

Fired before `/tree` navigation. Always fires regardless of whether user chose to summarize. Can cancel navigation or provide custom summary.

```typescript
pi.on("session_before_tree", async (event, ctx) => {
  const { preparation, signal } = event;

  // preparation.targetId - where we're navigating to
  // preparation.oldLeafId - current position (being abandoned)
  // preparation.commonAncestorId - shared ancestor
  // preparation.entriesToSummarize - entries that would be summarized
  // preparation.userWantsSummary - whether user chose to summarize

  // Cancel navigation entirely:
  return { cancel: true };

  // Provide custom summary (only used if userWantsSummary is true):
  if (preparation.userWantsSummary) {
    return {
      summary: {
        summary: "Your summary...",
        details: { /* custom data */ },
      }
    };
  }
});
```

See `SessionBeforeTreeEvent` and `TreePreparation` in the types file.

## Summary request isolation

Verbatim planning and branch summarization are standalone provider requests. Each receives a fresh routing session ID instead of reusing the chat's provider-affinity ID, and sets cache retention to `none` so it cannot write summary/planner prompts into the main prompt cache. Neither sends a `max_tokens` of its own. Existing API-key, header-only `ANTHROPIC_AUTH_TOKEN`, custom-header, abort, and bounded retry behavior still applies. These controls affect provider request routing/cache writes only; successful results are persisted through the normal Atomic session lifecycle.

**Isolation is per model, not per session.** When compaction borrows a fallback model, that request is built with the borrowed candidate's own API key, headers, and base URL; the session model's credentials are never sent to another provider. The corollary is a real data-flow change: **a model listed in `settings.fallbackModels` may receive the compaction transcript.** The list is user-authored, so the set of providers that can see it is yours to control — remove an entry if you do not want it to see transcript content.

## Settings

Configure compaction in `~/.atomic/agent/settings.json` or `<project-dir>/.atomic/settings.json` (legacy `.pi` paths are also supported):

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Enable automatic Verbatim Compaction. |
| `reserveTokens` | `16384` | Tokens to reserve for the next LLM response; threshold auto-compaction starts when completed-response usage or a prospective post-tool context exceeds the model's effective input budget minus this reserve. It is an **input-side** reserve only and never caps planner output. |

Compaction has no configuration key of its own for fallback borrowing: it reuses `settings.fallbackModels`, the same ordered `provider/model[:thinkingLevel]` list that main-chat model fallback walks. With no `fallbackModels` configured, compaction behaves as before: one planner model, then either an honest failure (recoverable) or a fresh context window (load-bearing).

Disable auto-compaction with `"enabled": false`. You can still compact manually with `/compact`.

## Historical formats

Two old formats remain parseable but inactive:

- `type:"context_compaction"` records store logical entry/content-block deletion targets from older versions. Those records are inert, so content they once hid can re-enter context when an old session resumes.
- `type:"compaction"` without `details.strategy: "verbatim-lines"` stored generated summary prose. Those records also remain inert.

Both are distinguished from active boundaries by the discriminated `details` on the shared `CompactionEntry` shape; the session format version is the same for all of them.
