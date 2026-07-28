#!/usr/bin/env bash
set -euo pipefail
SCOPE_FILES=($( { find packages/subagents/agents packages/subagents/prompts -maxdepth 1 -name '*.md'; find packages/workflows/builtin -maxdepth 1 -name '*.ts' ! -name '*.d.ts'; printf '%s\n' packages/workflows/skills/prompt-engineer/SKILL.md; find packages/workflows/skills/prompt-engineer/references -maxdepth 1 -name '*.md'; } | LC_ALL=C sort ))
fields=(stop_review_loop objective_alignment required_by_objective consistent_with_objective beyond_objective contradicts_objective requirements_traceability overall_correctness reviewer_error overall_explanation code_location findings P0 P1 P2 P3 contact_supervisor intercom playwright-cli tmux fetch_content research/web/ progress.md 'git status --porcelain' send_to_user '{task}' '{previous}' '{chain_dir}' '{item}' '{outputs.name}')
printf '# command: bash .atomic/research/prompt-opt/baseline/structured-fields-rerun.sh > .atomic/research/prompt-opt/baseline/structured-fields.txt\n'
for field in "${fields[@]}"; do
  printf '\n## %s\n' "$field"
  rg -n -F --no-heading --color never -- "$field" "${SCOPE_FILES[@]}" | LC_ALL=C sort || true
done
