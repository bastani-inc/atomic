# Task F — Open Claude Design prompt optimization notes

## Changed files

| File | Before (`wc -lc`) | After (`wc -lc`) |
| --- | ---: | ---: |
| `packages/workflows/builtin/open-claude-design-setup.ts` | 272 lines / 17,233 chars | 267 lines / 15,156 chars |
| `packages/workflows/builtin/open-claude-design-phases.ts` | 332 lines / 16,082 chars | 329 lines / 14,049 chars |
| `packages/workflows/builtin/open-claude-design-feedback.ts` | 359 lines / 12,460 chars | unchanged: 359 lines / 12,460 chars |
| `packages/workflows/builtin/open-claude-design-utils.ts` | 319 lines / 13,532 chars | 314 lines / 12,411 chars |
| `packages/workflows/builtin/open-claude-design-runner.ts` | 336 lines / 14,360 chars | 331 lines / 14,332 chars |
| **Total** | **1,618 lines / 73,667 chars** | **1,600 lines / 68,408 chars** |

`open-claude-design-feedback.ts` was deliberately left byte-unchanged because its labels, placeholders, delimiters, and rendered feedback markers are parser/threading contracts; it contained no prompt prose that could be safely trimmed independently of those contracts.

## Rubric trace

- **§2.1 / R12, §2.4 / R7:** removed numbered process narration, hedging, repeated outcome statements, and redundant “after writing, summarize” instructions; retained outcome, constraints, evidence, and stopping behavior in descriptive tagged sections.
- **§2.2 / task requirements:** compressed `HTML_PREVIEW_RULES`, `ANTI_SLOP_RULES`, `REFERENCE_PRECEDENCE`, and browser bootstrap guidance while retaining every aesthetic, accessibility, state, routing, fallback, retry, command, and evidence constraint.
- **§2.3 / R5:** changed judgment-style emphasis (`ONE`, duplicated `MUST`, `Always`) to direct rules. True invariants remain firm: parser labels, reference precedence, actual-page capture, artifact paths, and no-fabrication constraints.
- **§2.5 / R8:** kept compact reasons where behavior depends on them (clean rendered preview, implementation certainty, no post-export feedback because no refinement remains, and evidence needed by downstream generation/review).
- **§2.6 / R7:** retained descriptive XML sections and made artifact/context blocks distinct from the final objective/instructions.
- **§2.7 / R6:** moved rendered inputs before the query in `buildReferenceDiscoveryPrompt`, `buildInitialGeneratePrompt`, `buildGenerateRevisionPrompt`, the exporter prompt, and all three `ds-*` prompts. `buildLivePreviewDisplayPrompt` was also made context-first.
- **§2.8 / R2:** each reporting/completion stage now composes exactly one grounding clause: “Before reporting progress, audit each claim against a tool result from this session. Report only work you can point to evidence for; say so explicitly when something is unverified.”
- **§2.9 / R4:** the three `ds-*` prompts compose one shared delegation decision rule; it permits further delegation only for genuinely independent work too large for a handful of tool calls, forbids delegated self-verification, and prefers one subagent.
- **§2.11 / R3:** added explicit word limits and retained named Markdown/structured shapes for discovery, reference research, generation, revision, export, display, and all `ds-*` reports.
- **§2.12 / R1, §2.13 / R9, §2.17 / R11:** no reasoning-extraction, thought-process, or response-prefill guidance exists in the assigned files; the required hazard grep is empty.
- **§2.16 / R10:** generation/revision scope is one clause prohibiting unrelated features or abstractions.

## Deduplicated rules

- Initial generation’s second statement of reference precedence was removed; the surviving authoritative statement is `REFERENCE_PRECEDENCE`, composed as `<reference_precedence>`.
- Initial/revision/export “after writing, return a summary and not HTML” narration was folded into each single `<output_format>` contract.
- Exporter statements about the approved preview being canonical and the spec embedding it were consolidated into the objective plus one instruction block.
- Final-display repetitions of “export is complete / do not solicit changes / re-run the workflow” were consolidated across the objective and `next_action_hint` output requirement.
- Reference-discovery repetitions about clicking actual pages, capturing motion/stills, recording destinations, and citing observed traits were consolidated into one instruction each; command and fallback details remain.
- Browser setup narration about deterministic setup was removed; the surviving rules live in `buildPlaywrightCliBootstrapRules`: PATH handling, one install retry, permission/missing-runtime/network handling, no project dependency, preview/evidence commands, browser install, three-attempt fallback, and manual path/URL.

No distinct semantic rule was eliminated.

## Parser-contract literals protected

`open-claude-design-feedback.ts` was not edited. Confirmed unchanged:

- Canonical field labels in `FIELD_LABELS`: `displaymethod`, `previewpath`, `previewfileurl`, `annotatedsnapshot`, `usernotes`, `livechanges`, `nextactionhint`, `manualopeninstructions`, `specpath`.
- Emitted/extracted labels: `display_method`, `preview_path`, `preview_file_url`, `annotated_snapshot`, `user_notes`, `live_changes`, `next_action_hint`, `manual_open_instructions`, `spec_path`.
- Rendered feedback markers: `### User annotations from `, `Accepted live variants/edits:`, `Annotated snapshot:`, `the initial preview`, `the live design review`.
- Placeholder tokens: `none`, `na`, `null`, `undefined`, `notavailable`, `unavailable`, `notcaptured`, `nonotes`, `nousernotes`, `nofeedback`, `noannotations`, `nonecaptured`, `tbd`, `pending`.
- Parsing delimiters/markers remain unchanged: colon-separated inline values, Markdown headings/bullets/numbered labels, backtick/bold stripping, and horizontal-rule termination.
- Feedback threading error markers and verbatim annotation inclusion behavior remain unchanged.

## Preservation checks

- Template variable `{previous}` remains in the exporter prompt.
- All `playwright-cli` commands, screenshot/video artifact patterns, `/skill:impeccable` literals, paths, field labels, output enum values, and browser fallback behavior remain.
- No exported symbol or signature changed.

Export diff for the five assigned files:

```diff
(empty)
```

## Validation

- `bun run typecheck`: **pass**.
- `bun run check:file-length`: **pass** (2,450 files checked).
- Focused Open Claude Design/parser suite: **39 pass, 0 fail** across:
  - `test/unit/builtin-workflows-open_claude_design-01.test.ts`
  - `test/unit/builtin-workflows-open_claude_design-02.test.ts`
  - `test/unit/open-claude-design-feedback.test.ts`
  - `test/unit/open-claude-design-setup.test.ts`
- `bun run test:unit`: **run; repository-wide suite did not pass** — 3,782 pass, 2 skip, 45 fail, 28 errors. Failures shown were in concurrently edited, out-of-scope Goal/Ralph/pattern/subagent prompt surfaces. The first run also exposed four exact Open Claude Design wording assertions; the prompt text was corrected without changing tests, and the focused suite then passed 39/39. No parser-contract test remains failing.
- `git diff --check`: **pass**.
- Required hazard grep: **empty output**.
