# Atomic Technical Design Document / RFC

| Document Metadata      | Details                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Author(s)              | Alex Lavaee                                                                                                              |
| Status                 | Draft (implemented on PR #1326)                                                                                          |
| Team / Owner           | Atomic CLI / `@bastani/atomic` coding-agent tools                                                                        |
| Created / Last Updated | 2026-06-10                                                                                                               |
| Compatibility Posture  | Backward-compatible; breaking changes disallowed because `@bastani/atomic` is a published package with downstream users. |
| Issue                  | [GitHub issue #1323](https://github.com/bastani-inc/atomic/issues/1323)                                                  |
| Requirement Source     | GitHub issue #1323, PR #1326 review feedback, and the shipped implementation.                                            |

## 1. Executive Summary

This RFC documents the implemented oversized-read airlock in Atomic's built-in `read` tool in `packages/coding-agent/src/core/tools/read.ts`. The shipped design uses a **character-based** gate:

- `READ_TOOL_MAX_RESULT_CHARS = 50_000`
- the selected text range is blocked when `selectedContent.length > READ_TOOL_MAX_RESULT_CHARS`
- structured metadata is recorded as `OversizedReadDetails.chars` and `OversizedReadDetails.maxChars`

When a text selection exceeds 50,000 characters, the tool returns only a concise `File read blocked` guidance message. It does **not** include the oversized selected file content. Reads at or below the 50,000-character threshold continue through the existing offset/limit and truncation behavior.

## 2. Deviation from issue #1323

Issue #1323 described a literal 20,000-token gate. PR #1326 intentionally implements a 50,000-character gate instead, matching the `mehmoodosman/claude-code` `DEFAULT_MAX_RESULT_SIZE_CHARS` convention. This is an intentional and tighter practical rail: 50,000 UTF-16 JavaScript string characters is below the rough 20,000-token wording under the common `chars / 4` heuristic, and it avoids introducing tokenizer dependencies or provider-specific token accounting into the Read tool.

This spec therefore documents the shipped character-based behavior as authoritative. References to `READ_TOOL_MAX_RESULT_TOKENS`, `estimatedTokens`, `maxTokens`, or `Math.ceil(text.length / 4)` are stale and do not describe this branch.

## 3. Context and Motivation

Relevant implementation points:

- `packages/coding-agent/src/core/tools/read.ts` — Read tool implementation and oversized-read block.
- `packages/coding-agent/src/core/tools/truncate.ts` — existing 2,000-line / 50KB output truncation utilities.
- `packages/coding-agent/src/core/messages.ts` — `toolResult` messages are passed through into LLM context.
- `packages/coding-agent/src/core/agent-session.ts` — extension `tool_result` hook can observe/modify results after tool execution.

Before #1323, a whole-file `read` of a large text file could still place the leading 2,000-line / 50KB chunk into the transcript, even when the better recovery path was to search or request a smaller range. The new gate makes `read` the chokepoint for refusing oversized selected text ranges before model-visible content is returned.

## 4. Interaction with the existing 50KB byte-truncation rail

The existing `truncateHead` rail remains in place for **allowed** reads:

- `DEFAULT_MAX_LINES = 2000`
- `DEFAULT_MAX_BYTES = 51_200` (50KB)

The oversized-read gate is intentionally checked before `truncateHead` for selected content above 50,000 characters. That means an oversized selection is **blocked with guidance by design** rather than truncated-and-shown as a 50KB leading chunk. This prevents the transcript from receiving a large arbitrary prefix of a file when the selected range is already known to be too large.

For selected ranges at or below 50,000 characters, the 50KB byte rail still applies. This matters for multi-byte UTF-8 text: a selection can be under 50,000 JavaScript characters while still exceeding 51,200 bytes, in which case `truncateHead` returns the existing byte-truncated output and continuation guidance.

## 5. Functional Requirements

- [x] Add a 50,000-character configured threshold for model-visible text read selections in `packages/coding-agent/src/core/tools/read.ts`.
- [x] Evaluate the requested text range after `offset`/`limit` selection and before returning file contents.
- [x] Block text reads whose selected range is `> 50,000` characters.
- [x] Return a concise guidance message when blocked, including:
  - file path,
  - character count,
  - configured threshold of 50,000 characters,
  - clear instructions to search/read incrementally,
  - concrete examples using smaller line ranges and targeted searches for normal multi-line selections.
- [x] Ensure blocked results omit the oversized selected file content entirely.
- [x] Preserve existing behavior for reads at or below the threshold, including the existing 2,000-line / 50KB truncation behavior.
- [x] Preserve the existing Read tool input schema (`path`, optional `offset`, optional `limit`).
- [x] Expose additive structured metadata through `ReadToolDetails.oversizedRead`.

## 6. Single-long-line / first-line-exceeds-byte-limit guidance

Line pagination is not useful when the selected content is a single very long line or when the first selected line alone exceeds `DEFAULT_MAX_BYTES = 51_200`. In those cases, the blocked guidance should avoid examples such as `offset: 120` and instead recommend byte slicing with shell tools, for example:

```sh
sed -n '<startLine>p' '<path>' | head -c 51200
sed -n '<startLine>p' '<path>' | tail -c +51201 | head -c 51200
```

Normal multi-line oversized selections continue to use incremental line-range guidance such as `read({ "offset": <startLine>, "limit": 200 })` and targeted snippets around likely matches.

## 7. Data Model

Blocked results are additive to the existing result shape:

```ts
interface OversizedReadDetails {
  blocked: true;
  path: string;
  chars: number;
  maxChars: number;
  startLine: number;
  requestedLimit?: number;
  totalFileLines: number;
  firstLineBytes: number;
  byteGuidance: boolean;
}
```

`requestedLimit` is surfaced in the guidance message when present so users can see whether their explicit line limit was still too broad for the selected content.

## 8. Rendering Requirements

The TUI/read renderer should display oversized block messages as ordinary tool output, not as source code. Even when the blocked path has a syntax-highlightable extension such as `.ts`, `formatReadResult` skips `highlightCode` when `result.details?.oversizedRead?.blocked === true`.

This keeps messages such as `File read blocked...` readable as tool guidance rather than colorized as TypeScript or another source language.

## 9. Non-Goals

- Do not add a user-facing setting, CLI flag, or environment variable to customize the 50,000-character threshold in this iteration.
- Do not remove or replace the existing 2,000-line / 50KB truncation rail for allowed reads.
- Do not redesign all tool-output truncation across `bash`, `grep`, `find`, custom tools, MCP tools, or extension tools.
- Do not prevent users from producing large output via `bash cat`; this RFC scopes only the built-in `read` tool.
- Do not introduce a tokenizer dependency or provider-specific tokenization.
- Do not change image read/resize behavior; image behavior remains outside the text-character gate.
- Do not add a build step.

## 10. Test Plan

Unit coverage in `packages/coding-agent/test/tools.test.ts` should include:

- reads at exactly 50,000 characters are allowed,
- reads above 50,000 characters are blocked without leaking sentinel content,
- small `offset`/`limit` ranges from otherwise oversized files are allowed,
- single-line oversized selections produce byte/sed guidance instead of useless line-pagination examples,
- oversized block rendering skips source syntax highlighting and renders as tool output,
- existing line-limit, byte-limit, offset, limit, offset+limit, and image-detection tests remain green.

Validation commands:

```sh
bun run typecheck
bun run test:unit
```

## 11. Changelog Entry

`packages/coding-agent/CHANGELOG.md` documents the user-visible fix under `## [Unreleased]`:

```md
- Fixed the Read tool to block text file-read results above 50,000 characters (matching the mehmoodosman/claude-code `DEFAULT_MAX_RESULT_SIZE_CHARS` limit) and return incremental-read guidance instead of inserting oversized file contents into model context ([#1323](https://github.com/bastani-inc/atomic/issues/1323)).
```
