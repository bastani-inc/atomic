# Upstream provenance

- Repository: https://github.com/pbakaus/impeccable
- Tree: `.agents/skills/impeccable`
- Commit: `630fc2682a5bd39b25a8e61f74b6b3f14f2b1e21`
- Synced: 2026-07-12

The skill tree is copied from the pinned tree, with the security deviation below.

Atomic security deviation:

- `scripts/lib/is-generated.mjs` retains argument-array `execFileSync` for `git check-ignore`; upstream changed this to shell-based `execSync`, which permits command substitution from project-controlled filenames. `LICENSE`, `UPSTREAM_FILES.json`, and this provenance file are Atomic packaging additions copied from, or documenting, the upstream repository.
