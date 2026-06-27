# E2E Feature Validation: Workflow `Loop:` Pending-State Visibility

## Feature tested

This branch adds compact workflow loop/pending-state visibility in Atomic's workflows UI. The user-facing surface is:

- `/workflow status` list rows
- `/workflow status <run-id>` run detail output
- Workflow graph overlay/statusline

The main implementation surface is `packages/workflows/src/tui/workflow-loop-summary.ts`, with integrations in the status list, run detail renderer, and graph overlay renderer.

## Setup / preflight

- Repository type: initialized Bun TypeScript monorepo.
- Dependency/setup state: `bun.lock` and `node_modules` were present; no setup command was needed before validation.
- Commands were run from repo root: `/Users/norinlavaee/atomic-show-pending-states`.

## Bugs found and fixed

Research identified four feature-owned issues after the original loop-summary implementation. This pass validated the implementer's fixes for all four:

1. **Medium-width non-loop graph statuslines dropped action labels.**
   - Fix: graph statusline hint selection now keeps full `navigate` / `attach` labels whenever no loop rail is rendered and the full hints fit.
2. **Expanded child workflow graph views could omit the graph `Loop:` rail.**
   - Fix: the graph statusline computes its loop summary from displayed/expanded stages rather than only the root run stages.
3. **Non-positive builtin bounded-loop inputs displayed `0 remain`.**
   - Fix: builtin workflows use known runner defaults for non-positive loop inputs (`ralph.max_loops=10`, `goal.max_turns=10`, `open-claude-design.max_refinements=3`) in the display layer.
4. **Ordinary numeric stage labels such as `oauth-2` were over-normalized to `oauth`.**
   - Fix: numeric suffixes are preserved unless the family repeats or belongs to known builtin counted stage families.

## Manual/product scenarios executed

### 1. Real TUI entrypoint: `/workflow status`

Launched Atomic from the checkout in a tmux session using Bun:

```sh
tmux new-session -d -s atomic-loop-e2e -c /Users/norinlavaee/atomic-show-pending-states \
  'ATOMIC_OFFLINE=1 AGENT=1 bun packages/coding-agent/src/cli.ts --offline --no-skills --no-context-files --no-approve'
```

Then sent `/workflow status` in the TUI.

Evidence captured from tmux:

```text
╭ BACKGROUND  0 runs ──────────────────────────────────────────────────────────╮
│   no workflow runs in current session                                        │
╰──────────────────────────────────────────────────────────────────────────────╯
```

Result: the real command entrypoint rendered successfully for the available empty-state path.

### 2. Live workflow execution attempt

A full live agent-backed workflow run remains blocked in this checkout by missing local model/API authentication. Validation therefore used the real TUI entrypoint where practical, plus controlled product render paths with representative run snapshots for states that require active workflow data.

### 3. Controlled product render-path evidence for fixed edge cases

A temporary Bun script exercised the actual graph renderer and loop-summary builder with representative workflow snapshots. Evidence snippets:

```text
non-loop width 80: │ GRAPH │↑↓←→ navigate · ↵ attach · / stages · ctrl+d detach · q quit
non-loop width 84: │ GRAPH │ ↑↓←→ navigate · ↵ attach · / stages · ctrl+d detach · q quit
non-loop width 88: │ GRAPH │ ↑↓←→ navigate · ↵ attach · / stages · ctrl+d detach · q quit
expanded child graph: │ GRAPH │Loop: child-first → child-second ↑↓←→ navigate · ↵ attach · / stages · ctrl+d detach · q quit
expanded child contains boundary=false, child-first=true, loop=true
ralph max_loops 0: Loop: prompt-refine → research → orchestrator → review ×3 · ↻ 9 rounds remain
goal max_turns -2: Loop: work-turn → review ×3 · ↻ 9 turns remain
oauth-2 ordinary: Loop: oauth-2
oauth repeated: Loop: oauth ×2 repeats
```

Result: all four researched edge cases are now represented correctly through the same product render helpers used by the TUI.

## Automated validation commands

### Targeted feature tests

```sh
AGENT=1 bun test test/unit/workflow-loop-summary.test.ts test/unit/status-list-render.test.ts test/unit/run-detail-render.test.ts test/unit/overlay-graph-navigation-02.test.ts test/unit/overlay-graph-expanded.test.ts
```

Result:

```text
bun test v1.3.14 (0d9b296a)

 69 pass
 0 fail
Ran 69 tests across 5 files. [485.00ms]
```

### Typecheck

```sh
bun run typecheck
```

Result:

```text
$ tsc --noEmit
```

Exit status: passed.

### Lint

```sh
bun run lint
```

Result:

```text
$ tsc --noEmit
```

Exit status: passed.

### File length gate

```sh
bun run check:file-length
```

Result:

```text
$ bun scripts/check-file-length.ts
File length check passed: 1850 files checked from tracked files (max 500; skipped 64 by path, 32 by generated marker).
```

## Fixes made

Implementation changes validated in this pass:

- `packages/workflows/src/tui/graph-view-render-helpers.ts`
  - Uses displayed/expanded graph stages for loop summaries.
  - Keeps full non-loop action labels at medium widths when they fit.
- `packages/workflows/src/tui/workflow-loop-summary.ts`
  - Applies builtin defaults for non-positive bounded-loop inputs.
  - Preserves ordinary numeric labels and only collapses counted families when appropriate.
- Targeted unit coverage was added/updated for graph overlay, expanded child workflows, status list, run detail, and loop summary behavior.
- User-facing docs and the workflows changelog were updated for the fixed behavior.

## Retest results

All post-fix validation passed:

- Targeted loop/graph/status tests: 69 passing, 0 failing.
- `bun run typecheck`: passed.
- `bun run lint`: passed.
- `bun run check:file-length`: passed.
- Tmux `/workflow status` entrypoint: rendered successfully.
- Controlled product render-path evidence: all four fixed edge cases showed expected output.

## Unrelated / tangential issues or limitations

- Full live workflow execution could not be completed because this local checkout did not have configured model/API authentication. This is an environment limitation, not a confirmed feature bug.
- Startup surfaced pre-existing workflow discovery diagnostics from user-global workflow files under `~/.atomic/agent/workflows` and `/Users/norinlavaee/linkedIn-workflows`. They did not block `/workflow status` validation and were not part of this feature.
- Pre-existing untracked directories/files remain outside this validation report: `.babysit-pr-2026-06-26T05-48-49-610Z/`, `babysit-pr/`, and `research/web/2026-06-26-pending-state-tui-validation-references.md`.

## QA E2E video

No Playwright browser QA video applies. This feature is terminal TUI behavior, not browser UI. Tmux/product-render validation and targeted Bun tests were used as reviewable evidence instead.
