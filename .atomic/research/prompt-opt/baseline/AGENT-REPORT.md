# Prompt-optimization baseline report

## Artifacts created

- `.atomic/research/prompt-opt/baseline/exports.txt`
- `.atomic/research/prompt-opt/baseline/sizes.tsv`
- `.atomic/research/prompt-opt/baseline/frontmatter.txt`
- `.atomic/research/prompt-opt/baseline/hazards.txt`
- `.atomic/research/prompt-opt/baseline/structured-fields.txt`
- `.atomic/research/prompt-opt/baseline/prompt-graph.md`
- `.atomic/research/prompt-opt/baseline/rule-inventory.md`
- `.atomic/research/prompt-opt/baseline/AGENT-REPORT.md`

Deterministic helper scripts, also confined to the allowed baseline directory:

- `.atomic/research/prompt-opt/baseline/export-inventory-rerun.ts`
- `.atomic/research/prompt-opt/baseline/structured-fields-rerun.sh`
- `.atomic/research/prompt-opt/baseline/rule-inventory-rerun.ts`

## Counts

- In-scope files recorded in `sizes.tsv`: **67** (9 agent Markdown, 7 chain-prompt Markdown, 47 non-declaration builtin TypeScript, 4 prompt-engineer skill/reference Markdown).
- Exported-symbol inventory rows, including declaration files: **334**.
- Distinct semantic-rule checklist entries: **2,420**.
- Duplicated semantic-rule clusters: **15**.
- Render helpers/compositions flagged for query-last reordering: **11**.

### Hazards

Counts are regex match occurrences using the exact expressions recorded in `hazards.txt`:

| Hazard class | Count |
| --- | ---: |
| reasoning-echo | 17 |
| prefill | 5 |
| self-verification nagging | 0 |
| uppercase absolutes | 7 |
| thinking-words | 35 |

## Prompt-bearing builtin files missed by the objective’s enumerated list

Five additional files contain stage/model-facing prompt text:

1. `packages/workflows/builtin/goal-runner.ts` — inline post-approval PR/MR/review prompt.
2. `packages/workflows/builtin/ralph-runner.ts` — inline first-turn orchestrator and post-approval PR/MR/review prompts.
3. `packages/workflows/builtin/open-claude-design-runner.ts` — three inline design-system discovery prompts.
4. `packages/workflows/builtin/open-claude-design-utils.ts` — shared HTML/design/reference/bootstrap prompt contracts.
5. `packages/workflows/builtin/adversarial-verification-runner.ts` — verification rubric written for model consumption.

See `prompt-graph.md` for line ranges, composition edges, duplicated-rule evidence, and the 11 ordering flags.

## Validation

- Confirmed `sizes.tsv` has exactly 67 data rows.
- Confirmed `frontmatter.txt` has all 9 agent headers and preserves the text between each file’s first two `---` delimiters.
- Regenerated `exports.txt` and `structured-fields.txt` with their recorded helper commands.
- Confirmed all 67 SCOPE files have a section in `rule-inventory.md`.
- `git status --short -- packages/subagents packages/workflows/builtin packages/workflows/skills/prompt-engineer .atomic/research/prompt-opt/baseline` reports only the new baseline directory; no source file in SCOPE was modified.
