# Task F report — Open Claude Design prompt surface

Optimized the assigned Open Claude Design prompts for the cross-model rubric. Full edit rationale, preservation inventory, and parser-contract audit are in `task-F.md`.

## Files and size

- `open-claude-design-setup.ts`: 272 lines / 17,233 chars → 267 / 15,156
- `open-claude-design-phases.ts`: 332 / 16,082 → 329 / 14,049
- `open-claude-design-feedback.ts`: unchanged at 359 / 12,460
- `open-claude-design-utils.ts`: 319 / 13,532 → 314 / 12,411
- `open-claude-design-runner.ts`: 336 / 14,360 → 331 / 14,332
- Total: 1,618 / 73,667 → 1,600 / 68,408

Edits trace to rubric §§2.1–2.9, 2.11–2.13, 2.16, and 2.17: prompt prose was compressed, grounded-reporting and explicit length/shape contracts were added, judgment-call absolutes were converted to direct decision rules, scope was reduced to one clause, and the `ds-*` prompts received one shared delegation rule. No reasoning-extraction or response-prefill guidance remains.

## Query-last reorder

Rendered inputs now precede role/objective/instructions in:

1. `buildReferenceDiscoveryPrompt`
2. `buildInitialGeneratePrompt`
3. `buildGenerateRevisionPrompt`
4. exporter prompt
5. `ds-locator`
6. `ds-analyzer`
7. `ds-patterns`

`buildLivePreviewDisplayPrompt` was also made context-first.

## Deduplication and preservation

- Reference precedence survives once in `REFERENCE_PRECEDENCE` and is composed into generation/revision prompts.
- “Return a summary, not HTML” survives once per stage in `<output_format>`.
- Export canonical-preview/embedding rules and final-display no-more-refinement rules were consolidated rather than repeated.
- Reference capture and browser bootstrap narration was compressed while retaining actual-page navigation, video and full-page still capture, artifact paths, destination metadata, observed-trait evidence, retry/install commands, permission/runtime/network handling, three-attempt fallback, and manual paths.
- `HTML_PREVIEW_RULES` and `ANTI_SLOP_RULES` retain every aesthetic, responsive, state, accessibility, content, and annotation constraint.
- `{previous}`, all `playwright-cli` literals/commands, `/skill:impeccable` literals, artifact paths, field names, and enum values remain.
- No distinct semantic rule was eliminated.

## Parser contracts

`open-claude-design-feedback.ts` was deliberately left byte-unchanged. Protected literals include:

- Canonical labels: `displaymethod`, `previewpath`, `previewfileurl`, `annotatedsnapshot`, `usernotes`, `livechanges`, `nextactionhint`, `manualopeninstructions`, `specpath`.
- Emitted/extracted labels: `display_method`, `preview_path`, `preview_file_url`, `annotated_snapshot`, `user_notes`, `live_changes`, `next_action_hint`, `manual_open_instructions`, `spec_path`.
- Markers: `### User annotations from `, `Accepted live variants/edits:`, `Annotated snapshot:`, `the initial preview`, `the live design review`.
- Placeholder tokens: `none`, `na`, `null`, `undefined`, `notavailable`, `unavailable`, `notcaptured`, `nonotes`, `nousernotes`, `nofeedback`, `noannotations`, `nonecaptured`, `tbd`, `pending`.
- Colon, Markdown heading/bullet/numbered-label, backtick/bold, and horizontal-rule parsing delimiters are unchanged.

## Export diff

```diff
(empty)
```

No exported symbol or signature changed.

## Gates

- `bun run typecheck`: pass
- `bun run check:file-length`: pass
- Focused Open Claude Design/parser tests: 39 pass, 0 fail
- `bun run test:unit`: run; full concurrent repository state reported 3,782 pass, 2 skip, 45 fail, 28 errors in out-of-scope Goal/Ralph/pattern/subagent prompt surfaces. Four initial Open Claude wording assertions were fixed in prompt text without weakening tests; the complete focused suite then passed.
- `git diff --check`: pass
- Hazard grep output: empty

Hazard command:

```text
rg -n -i 'explain your (reasoning|thinking|thought)|show your (reasoning|thinking|work)|narrate|think out loud|chain[- ]of[- ]thought|internal (reasoning|deliberation)|reasoning process|thought process|double.check|re-?verify|verify your own|prefill' packages/workflows/builtin/open-claude-design-{setup,phases,feedback,utils,runner}.ts
# no output
```
