# Compaction Model Setting and Structured Compaction Input — Technical Design Document / RFC

| Document Metadata      | Details |
| ---------------------- | ------- |
| Author(s)              | Flora (with Atomic) |
| Status                 | Accepted for implementation |
| Team / Owner           | `packages/coding-agent` — compaction; `packages/ai` — providers |
| Created / Last Updated | 2026-10-06 |
| Issue                  | [#3470](https://github.com/bastani-inc/atomic/issues/3470) — Claude blocks verbatim compaction with a reverse-engineering restriction |
| Builds on              | [`specs/2026-07-27-compaction-fallback-rungs.md`](2026-07-27-compaction-fallback-rungs.md) (planned → borrowed fallback → fresh ladder) |
| Compatibility posture  | Additive setting; default `auto` keeps the session model as compactor. Planner request format changes (prompt version bump); persisted results keep today's shape. |

---

## 1. Executive Summary

Atomic compacts by asking the session model which transcript lines to delete
(`verbatim-lines`). On Claude-subscription sessions Anthropic refuses that request as a
"reverse engineering or duplicating model outputs" violation (§2.2). Users have no first-class
way to compact with a different model without changing their chat model.

This RFC:

1. Adds **`compactionModel`**, modeled on `routerModel`: `auto` (default, the session model), an
   exact **chat** model, a registered **classifier** such as `typesafe/jev-latest`, or the new
   **`morph/morph-compactor`**.
2. Replaces the planner's numbered-transcript input with **Morph's structured object**:
   `messages: [{ id, role, lines[] }]` plus `query` and `compression_ratio`. Chat planners return
   per-message `compacted_line_ranges`; classifiers score message line groups; Morph receives the
   same messages through its `/v1/compact` API.
3. Adds a first-party **Morph** provider (`/login morph`, `MORPH_API_KEY`, a new `compactor` model type).
4. Keeps today's fallback ladder (selected compaction model → `fallbackModels` → `fresh` at
   load-bearing urgency), with one addition: a **provider policy refusal** falls back to **pi's
   summary compaction** on the same model before the ladder continues (§4.6).

Every model-planned or scored backend yields the same verbatim result: deletions only, surviving
lines byte-identical, validated by `validateDeletedRanges`. The pi fallback yields a summary.

Out of scope: provider-native compaction endpoints, Anthropic-only chunking, prompt changes aimed
at the refusal classifier.

---

## 2. Context and Motivation

### 2.1 Current state

- `compaction-runner.ts` `runVerbatimCompaction` ladder: session-model planner → each configured
  `fallbackModels` entry borrowed for one planner request → `fresh` (load-bearing only).
- `range-planner.ts` `buildRangePlannerPrompt` sends the region as `N→line` rows inside
  `<numbered-transcript>`; the model answers bare `start,end` records.
- `routerModel` (`settings-types.ts:129`, `structured-output/resolver.ts`, `/settings` UI) accepts
  `""`/`auto`, an exact chat model, or a registered classifier, with global/project scope.
- Providers declare typed model maps behind API-key auth (`providers/typesafe.ts` registers classifiers).

### 2.2 Evidence (Opus 5.5 medium on Claude-subscription OAuth unless noted)

| Request | Result |
| ------- | ------ |
| Today's planner request (with / without thinking) | refused, ~1.5 s |
| Reworded / prompt-engineered / honest-purpose variants | refused |
| Native turns with numbers; per-message blocks; JSON `{id, role, lines[]}` | refused |
| Index or metadata-only tables (29k) | refused |
| Planner request over plain docs (202k) | accepted |
| Native history + "summarize our conversation" (155k) | accepted |
| GPT-6.1 Sol, JSON `{id, role, lines[]}` + per-message ranges | accepted; 142 records, 0 rejected, 49.7% kept, 9% fewer input tokens than numbered lines |
| GPT-6.1 Sol, exact Morph `{role, content}` strings + per-message ranges | accepted, but 207/207 ranges out of bounds: chat models cannot count lines without explicit line arrays |
| Morph `/v1/compact`, role-structured messages | accepted, per-message `compacted_line_ranges`, ~1 s |

---

## 3. Goals and Non-Goals

### 3.1 Goals

1. `compactionModel` with `routerModel`-equivalent validation, scopes, and `/settings` UI.
2. One structured compaction input built from the region, shared by all backends.
3. Chat planner backend using the structured input (prompt version bumped).
4. Classifier backend (e.g. Jev) scoring line groups; code applies the keep target.
5. Morph provider and `/v1/compact` backend.
6. Today's ladder unchanged apart from rung 1 being the selected compaction model.
7. Compaction details record backend, model, and prompt version; the card shows backend and model.

### 3.2 Non-Goals

- Provider-native compaction endpoints; Anthropic chunking.
- Branch summarization changes (open question Q2).

---

## 4. Design

### 4.1 Structured compaction input

Built once per compaction from the same region and serializer as today:

```json
{
  "messages": [
    { "id": 1, "role": "user",      "lines": ["[User]: Fix the login timeout…", ""] },
    { "id": 2, "role": "assistant", "lines": ["[Assistant thinking]: …", "", "[Assistant tool calls]: read(path=\"auth.ts\")", ""] },
    { "id": 3, "role": "tool",      "lines": ["[Tool result]: …", "…"] }
  ],
  "query": "<compaction query>",
  "compression_ratio": 0.5,
  "protected": [{ "id": 4, "start": 2, "end": 5 }]
}
```

- `lines` of message *k* are exactly the region lines belonging to that message (Atomic's
  serializer output, including the blank separator), so `id` + 1-based line position maps
  bijectively to global line numbers. A unit test asserts the round trip over every line.
- Thinking blocks stay included as serialized text.
- Protected `<keepContext>` lines are listed per message and also enforced host-side.

### 4.2 Resolution

```text
compactionModel
 ├─ "" | "auto"            → chat planner on the session model
 ├─ provider/chat-model    → chat planner on that model (borrowed; session model unchanged)
 ├─ provider/classifier    → classifier backend (e.g. typesafe/jev-latest)
 └─ morph/morph-compactor  → Morph backend
```

Validation mirrors `resolveRouterModel` (exact IDs through the current registry: chat,
classifier, or compactor types). Unknown IDs are settings errors naming `compactionModel`.
Missing credentials for an explicit backend are backend failures (§4.6).

### 4.3 Chat planner backend

- System prompt: the context-manager role validated during the investigation ("you manage the
  working context of a coding assistant…"), retention priorities equivalent to today's policy,
  and the decision rule that low-value lines are interleaved, so expect many ranges and never
  drop a block for age alone.
- User turn: the structured input as JSON inside `<compaction_request>`, then goal and output contract.
- Output: one record per line, `id:start,end` (1-based, inclusive, within one message), most
  confident first. Parsed by a new parser mirroring `parseRangeRecords` (including truncation
  recovery); mapped to global ranges; validated by `validateDeletedRanges`.
- `PROMPT_VERSION` bumped; the old numbered-transcript prompt is removed.

### 4.4 Classifier backend

- Units: each message, with long messages split into consecutive line groups (bounded lines and
  tokens per unit). Protected lines and the preserved tail are never units.
- One classify call per unit, concurrency-limited (≤ 4), state Morph-shaped:
  `{ query, message: { id, role, lines: [...unit lines] }, position: "lines a-b of n" }`, one
  `score` question ("how much the assistant still needs these lines": not needed … essential).
- Code sorts units by score (confidence, then age as tie-breakers) and deletes lowest-scored
  units until the keep target; validates with `validateDeletedRanges`.
- A failed classify call fails the backend (falls through the ladder); no partial results.

### 4.5 Morph backend and provider

- `POST https://api.morphllm.com/v1/compact` with
  `{ messages: [{ role, content: lines.join("\n") }], query, compression_ratio, preserve_recent: 0, include_markers: false }`.
  Morph numbers lines server-side by splitting on `\n`, matching `lines`.
- Map each returned message's `compacted_line_ranges` to global lines; drop out-of-range records
  (counted in diagnostics); validate. Atomic reconstructs the result itself; Morph's text is ignored.
- `packages/ai/src/providers/morph.ts`: `createProvider({ id: "morph", name: "Morph", auth: {
  apiKey: envApiKeyAuth("Morph API key", ["MORPH_API_KEY"]) }, compactors: { "morph-compact": … } })`,
  following `typesafe.ts`. New `compactor` model type in `ModelTypeMap`/`isModelType`;
  compactors never appear in `/model` or auto routing. `env-api-keys.ts`: `morph: "MORPH_API_KEY"`;
  `/login morph` stores the key in `auth.json`.

### 4.6 Fallback ladder

```text
rung 1  selected compaction model (auto → session model)
          └─ on policy_refusal → pi summary compaction on the same model
rung 2  each fallbackModels entry, borrowed as a chat planner (skip one equal to rung 1)
          └─ on policy_refusal → pi summary compaction on that model
rung 3  fresh (load_bearing urgency only)
```

- **Refusal detection.** `classifyPlannerFailure` gains `policy_refusal`, checked before
  `provider_error`, for provider policy blocks (e.g. Anthropic's "This request was blocked as it
  seems to violate Anthropic's Terms of Service…", usage- or content-policy refusals). The
  diagnostic sidecar records the category. Refusal messages are never retried as transient errors,
  even if they contain digits such as `500`.
- **pi fallback.** A port of upstream pi's compaction (`earendil-works/pi`
  `packages/coding-agent/src/core/compaction`): `prepareCompaction` cut point with
  `keepRecentTokens`, `compact`/`generateSummaryWithUsage` with `SUMMARIZATION_SYSTEM_PROMPT` and
  `SUMMARIZATION_PROMPT` / `UPDATE_SUMMARIZATION_PROMPT`, turn-prefix summaries, and
  `readFiles`/`modifiedFiles` details. It reuses Atomic's existing `SUMMARIZATION_SYSTEM_PROMPT` and
  `serializeConversation` where they match pi, runs on the model that refused, and persists a
  summary compaction (`backend: "summary"`). The card labels it "summary (pi fallback)".
- If the pi summary also fails (including another refusal), the ladder continues with the next
  rung. All non-refusal failures follow the existing ladder unchanged.
- Known risk: pi's summary request also sends the serialized conversation as text; on Anthropic it
  may be refused too, in which case the ladder continues. The Opus live check records the outcome.

### 4.7 Settings and UI

```ts
interface Settings {
	compactionModel?: string; // default "" (= auto)
}
```

- Accessors mirror `getRouterModel`/`setRouterModel`, global or project scope.
- A project-scoped value may not select `morph/*` (no new third-party egress from an untrusted repo).
- `/settings` → **Compaction model**: Auto (current model), chat models, classifiers, Morph
  (marked "requires /login morph" without a credential).
- Compaction details gain `backend: "planner" | "classifier" | "morph" | "summary"` and `model`;
  the card shows them.

---

## 5. Cross-Cutting Concerns

- **Privacy:** Morph and third-party classifiers receive the compactable region; only via an
  explicit setting.
- **Docs:** `packages/coding-agent/docs/compaction.md` "Compaction model" section, `/login morph`
  in providers docs, and troubleshooting for the #3470 message: Atomic falls back to a pi-style
  summary on a policy refusal, then to `fallbackModels`; to keep verbatim compaction, add a
  `fallbackModels` entry or choose another `compactionModel` (chat model, classifier, or Morph).
  Anthropic remains a supported compactor; docs must not imply otherwise.
- **Changelog** (`packages/coding-agent/CHANGELOG.md`, Unreleased): Added `compactionModel`,
  Morph provider, classifier compaction; Changed planner input to a structured per-message format;
  Fixed guidance for #3470.

## 6. Test Plan

- Structured input: bijective id/line ↔ global mapping over every line; protected lines per message.
- Chat planner: record parser (valid, malformed, out-of-range, cross-message, truncated);
  mapping and validation; prompt-version recorded.
- Classifier backend (faked classify): unit splitting; ordering and keep target; protected/tail
  never deleted; failure → ladder.
- Morph backend (faked fetch): request body; per-message range mapping; out-of-range drop;
  HTTP errors → ladder.
- Settings/resolver: values, scopes (project cannot pick Morph), unknown IDs, UI round-trip.
- Ladder: rung 1 substitution, duplicate skip, policy refusal → pi summary on the same model,
  pi summary failure → next rung, non-refusal error → existing ladder, manual `/compact` never
  reaches `fresh`; refusal text with "500" is not retried as 5xx.
- pi fallback port: cut point and `keepRecentTokens`, initial vs update prompt, turn-prefix
  summary, persisted summary entry and file-operation details.
- Quality check on the investigation fixture with GPT-6.1 Sol: structured-input planner vs the
  old numbered prompt (deleted lines by kind, token reduction) — no regression beyond 5 points.
- Live checks: `/compact` with `compactionModel=auto` on an Opus session with a non-Anthropic
  `fallbackModels` entry (records whether the Claude attempt succeeded or was refused and which
  rung produced the result; compaction must succeed); `compactionModel=openai-codex/gpt-6.1-sol`
  on an Opus session; `typesafe/jev-latest`; `morph/morph-compactor`; `auto` on GPT-6.1 Sol.

## 7. Open Questions

- **Q1** Classifier unit size and score criteria tuning (measure on the fixture during implementation).
- **Q2** Whether `compactionModel` should also govern branch summarization.
