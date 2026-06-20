I can’t write to the target file from here because this session is read-only, but below is the exact Markdown content I found for `research/subagents/issue-1445-prior-research.md`.

```md
# Issue #1445 Prior Local Research / Docs / Specs

Relevant local artifacts for the file-length gate / module-splitting / Bun / prek / CI / raw TypeScript / import-path-stability work around issue #1445.

## Related Research Docs

- 🟢 `research/2026-06-20-implement-github-issue-1445-https-github-com-bastani-inc-atomic-issues-1445-in-t.md` — Current local research thread for issue #1445; summarizes the 500-line gate, current offenders, and required follow-up validation.
- 🟢 `research/web/2026-06-20-file-length-linter-references.md` — Cached references for the issue; captures the intended 500-line rule, exclusions, `git ls-files` enumeration, Bun argv/spawn guidance, `prek` hook wiring, and CI insertion.
- 🟢 `research/2026-06-20-test-research-question-*.md` / `research/2026-06-20-test-*.md` — Numerous stub research artifacts created during the same investigation session; mostly placeholders, but they indicate active issue-1445 research coverage.

## Related Specs

- 🟢 `specs/2026-06-10-implement-github-issue-1332-in-this-repository-the-private-atomic-monorepo-bun-w.md` — Recent spec in the same implementation style as issue-driven work; useful as a template for Bun-based repo changes and validation workflow.
- 🟢 `specs/2026-05-25-address-the-following-gh-issue-https-github-com-flora131-atomic-issues-1045.md` — Earlier issue-implementation spec showing the repo’s pattern for turning GitHub issues into concrete local work.
- 🟢 `specs/2026-05-03-atomic-package-split.md` — Relevant to module splitting / package boundary decisions; helpful context for refactors that reduce large files by moving code into smaller modules.
- 🟡 `specs/2026-03-18-codebase-architecture-modularity-refactor.md` — Modularity refactor spec; older but directly relevant to splitting oversized modules into smaller units.
- 🟡 `specs/2026-01-24-bun-shell-script-conversion.md` — Bun scripting / TS-execution context; relevant to the `bun scripts/check-file-length.ts` style of implementation.
- 🔴 `specs/2026-01-31-sdk-migration-and-graph-execution.md` — Older architecture/spec context; only indirectly relevant, mainly as precedent for larger structural changes.

## Related Docs / Conventions

- 🟢 `CLAUDE.md` — Repository conventions: `bun run check:file-length`, 500-line source-file limit, documented exclusions, raw TypeScript and `.js` import-extension conventions.
- 🟢 `AGENTS.md` — Development rules mirroring the same 500-line file-length gate, raw TypeScript expectations, and Bun-first workflow.
- 🟢 `docs/ci.md` — CI pipeline documentation explicitly showing `bun run check:file-length` as a required PR step after typecheck.
- 🟢 `prek.toml` — Local hook configuration containing `bun run check:file-length` with `pass_filenames = false`, matching the issue’s pre-commit intent.
- 🟢 `package.json` — Root script wiring includes `check:file-length` and `lint` composition with typecheck.
- 🟢 `packages/coding-agent/CHANGELOG.md` — Mentions issue #1445 and records the contributor-validation change to the monorepo-wide file-length gate in Bun scripts, local `prek` hooks, and PR CI.
  - Same issue note also appears in sibling package changelogs:
    - `packages/cursor/CHANGELOG.md`
    - `packages/intercom/CHANGELOG.md`
    - `packages/mcp/CHANGELOG.md`
    - `packages/natives/CHANGELOG.md`
    - `packages/subagents/CHANGELOG.md`
    - `packages/web-access/CHANGELOG.md`
    - `packages/workflows/CHANGELOG.md`

## Most Directly Relevant Paths for Issue #1445

1. `research/2026-06-20-implement-github-issue-1445-https-github-com-bastani-inc-atomic-issues-1445-in-t.md`
2. `research/web/2026-06-20-file-length-linter-references.md`
3. `CLAUDE.md`
4. `AGENTS.md`
5. `docs/ci.md`
6. `prek.toml`
7. `package.json`
8. `packages/coding-agent/CHANGELOG.md`
9. `specs/2026-05-03-atomic-package-split.md`
10. `specs/2026-03-18-codebase-architecture-modularity-refactor.md`
```

If you want, I can also turn this into a tighter “final report” format with only the highest-signal artifacts.