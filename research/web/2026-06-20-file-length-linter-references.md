---
title: File length linter implementation references for Atomic issue 1445
fetched_at: 2026-06-20
sources:
  - https://github.com/bastani-inc/atomic/issues/1445
  - https://bun.com/docs/guides/process/argv
  - https://bun.sh/docs/api/spawn
  - https://bun.sh/docs/api/file-io
  - https://bun.com/docs/runtime/glob
  - https://git-scm.com/docs/git-ls-files
  - https://www.gnu.org/software/coreutils/manual/html_node/wc-invocation.html
  - https://prek.j178.dev/reference/configuration/
  - https://bun.com/docs/guides/runtime/cicd
  - https://docs.bastani.ai/development
  - https://www.typescriptlang.org/docs/handbook/modules/reference.html
  - https://docs.npmjs.com/cli/v10/configuring-npm/package-json#files
---

# Concise cached notes

- Issue #1445 (queried via `gh issue view` 2026-06-20): open enhancement/tech-debt issue titled “Enforce a 500-line max on all source files (TS/JS/Rust) via a pre-commit + CI linter, and refactor the monorepo to comply”. It requires a hard cutover, no phased rollout, no grandfather/baseline list, and only generated/vendored glob+marker exclusions.
- Issue #1445 rule: violation when physical line count is >500; all physical lines count including blanks/comments; count should be `wc -l` style with trailing-newline correction so final unterminated line counts.
- Issue #1445 in-scope extensions: `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.rs`; prefer tracked-file enumeration with `git ls-files`, fallback to recursive walk; support `--max=<n>` (default 500) and quiet/CI mode; report path + count sorted descending, exit non-zero if violations.
- Issue #1445 exclusions: `**/node_modules/**`, `**/dist/**`, `**/target/**`, `**/binaries/**`, `**/.git/**`; generated marker in first ~5 lines matching `@generated`, `auto-generated`, `DO NOT EDIT`, `GENERATED -- do not edit`; `**/vendor/**`; `*.min.js` / `*.min.mjs`; `packages/workflows/skills/impeccable/**`.
- Issue #1445 wiring: root `package.json` script `"check:file-length": "bun scripts/check-file-length.ts"`; include in lint; add `prek.toml` local/system hook with `pass_filenames = false`; add `.github/workflows/test.yml` step after Typecheck running `bun run check:file-length`.
- Issue #1445 acceptance: script exists/defaults 500/supports --max/honors exclusions/nonzero on violation; `bun run check:file-length` clean; `bun run hooks:run` enforces locally; CI fails oversized files; all first-party files ≤500 except generated/vendored; typecheck/test:unit/test:integration pass; docs updated where relevant.
- Bun args: Bun.argv is raw and includes Bun flags; docs recommend `process.argv` for flags passed to the script.
- Bun spawn: Bun.spawn/Bun.spawnSync accept command arrays; spawnSync returns stdout/stderr Buffer, exitCode, success; docs say spawnSync is better for CLI tools.
- Bun file IO: Bun.file is lazy; read with `.text()`, `.bytes()`, `.arrayBuffer()`; use `node:fs` for directories; `fs.readdir(..., { recursive: true })` is available in Bun.
- Bun Glob: native `Glob` supports `match()`, `scan()`/`scanSync()`; glob syntax includes `?`, `*`, `**`, `[]`, `{}` and escaping. Bun also implements `node:fs` glob APIs with exclude.
- git ls-files: default/`--cached` shows tracked files in index; `-z` emits NUL-terminated unquoted filenames; `--full-name` outputs paths relative to repository top-level even from subdirectories. Fallback recursive walk may include untracked/ignored files unless it explicitly prunes `.gitignore`/output dirs; use only when git enumeration is unavailable.
- GNU wc -l: `--lines` prints newline counts; if a non-empty file lacks a trailing newline, `wc -l` undercounts physical lines by one, so add a trailing-newline correction for “physical lines”.
- prek: repo = local hooks require id/name/entry/language. `language = system` runs a system executable. `pass_filenames = false` prevents filenames from being appended. `stages` includes pre-commit/pre-push. Entry normally runs without shell; shell is an optional prek extension.
- GitHub Actions Bun: official setup uses `oven-sh/setup-bun@v2`; steps are checkout, setup Bun, install, run scripts. Existing Atomic `test.yml` has File length check immediately after Typecheck.
- npm package.json `files`: the optional `files` array is an include list for packed/installed package contents; omitting it defaults to `["*"]`; root `.npmignore` does not override `files`, but `.npmignore` in subdirectories can. `package.json`, README, LICENSE, and files named by `main`/`bin` are always included. For raw/no-build packages that need nested runtime `.ts` assets, include those directories/globs explicitly in `files` and avoid relying only on `main`/`bin`.
- TypeScript module resolution docs: TS resolves internally to `.ts`/`.d.ts` for a specifier that names a JS file; docs explicitly show `import x from "./mod.js"` resolving to `mod.ts`, and note extensionless ESM imports are not supported by Node.js. Preserve `.js` relative specifiers in TS ESM/no-build-step raw TypeScript packages.
