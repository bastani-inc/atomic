---
name: qlty
description: Code quality checks, formatting, and metrics via qlty CLI. Use when asked to verify code quality, add or run verifiers, make sure code is high quality before commit or handoff, lint or auto-format a codebase, measure complexity, cohesion, or lines of code, or find code smells like duplication and deep nesting.
---

# Qlty Code Quality

`qlty` is a universal code quality tool: one CLI that drives 70+ linters, auto-formatters, and security scanners across 40+ languages and technologies, plus its own static analysis for metrics and code smells.

**Prefer the `qlty` CLI over ad-hoc per-tool linter invocations.** Do not reach for `eslint`, `ruff`, `rubocop`, `shellcheck`, `prettier`, `gofmt`, and friends one at a time. Run them through `qlty check` / `qlty fmt` so every language in the repository is covered by one command, with one config, one cache, and one consistent issue format. Fall back to invoking a tool directly only when the repository's own scripts require it (for example a project's `npm run check`) or when qlty has no plugin for it.

## Documentation

**Reference <https://docs.qlty.sh/llms.txt> heavily.** It is the authoritative index of every qlty documentation page, each available as Markdown by appending `.md` to the page URL. Fetch the index first, then fetch the specific pages you need — command pages under `https://docs.qlty.sh/cli/commands/`, concepts under `https://docs.qlty.sh/cli/concepts/`, and language support under `https://docs.qlty.sh/languages/`.

Local excerpts of the most-used pages live in [references/](references/), each attributed to its upstream URL:

- [references/quickstart.md](references/quickstart.md) — install, `qlty init`, first run
- [references/commands.md](references/commands.md) — `check`, `fmt`, `metrics`, `smells`, `init`, `plugins`
- [references/plugins-and-extensions.md](references/plugins-and-extensions.md) — enabling plugins, linter extensions, `qlty.toml`
- [references/coding-with-ai-agents.md](references/coding-with-ai-agents.md) — upstream's own guidance for agents

The local copies are point-in-time excerpts. When they disagree with the live docs, the live docs win — fetch from `llms.txt`.

## When to Use

- **Check code for linting issues before commit or handoff.** `qlty check` is the last gate before you hand work to a human or another stage.
- **Auto-fix formatting and style issues.** `qlty fmt` rewrites files; `qlty check --fix` applies lint auto-fixes.
- **Calculate code metrics** — complexity, lines of code, cohesion, duplication — with `qlty metrics`.
- **Find code smells** — duplicated code, deeply nested control flow, overly complex functions — with `qlty smells`.
- **When a user asks for "verifiers", or asks you to make sure the code is high quality, use this skill.** Those requests mean: enable the right linters for this codebase, then run the check/fmt/metrics/smells loop and fix what it reports.

## Install

Skip this if `qlty --version` already works.

```bash
# macOS & Linux
curl https://qlty.sh | bash
```

Upstream documents the same installer as `curl https://qlty.sh | sh`; both work, the script is POSIX `sh`.

```powershell
# Windows
powershell -c "iwr https://qlty.sh | iex"
```

The binary lands in `~/.qlty/bin` and **that directory must be on `PATH`**. The installer appends an export to your shell rc file, which does not help a non-interactive or already-running shell — export it yourself when a command reports `qlty: command not found`:

```bash
export PATH="$HOME/.qlty/bin:$PATH"
```

Two useful installer environment variables: `QLTY_INSTALL_BIN_PATH` puts the binary somewhere already on `PATH` (for example `$HOME/.local/bin`), and `QLTY_NO_MODIFY_PATH=1` suppresses the rc-file edit. qlty supports macOS and Linux on x64 and arm64 (glibc and musl); Windows support is newer, so verify it rather than assuming.

## Enable the right plugins for this codebase

Blindly running `qlty check` in a repository with no configuration finds nothing. Tailor the plugin set to the codebase first — this is what turns qlty from a lint runner into a quality bar.

```bash
qlty init                      # detect file types, write .qlty/qlty.toml with a baseline plugin set
qlty plugins list              # every available plugin
qlty plugins enable eslint     # enable one the baseline missed
```

Then review `.qlty/qlty.toml` against what the repository actually uses: a TypeScript repo usually wants `eslint` plus `prettier`, Python wants `ruff`, Go wants `staticcheck`/`gofmt`, shell wants `shellcheck`/`shfmt`, and almost every repo benefits from `trivy` or `gitleaks` for secrets and vulnerabilities. Enable security and type-checking plugins deliberately; they are the ones that catch defects rather than style.

Also enable **linter extensions** — the plugin ecosystem of each linter (`eslint-plugin-react`, `eslint-plugin-security`, RuboCop extensions, Ruff/Pylint/Bandit packages). In `qlty.toml`, either list them with `extra_packages` or point at the project's own dependency manifest with `package_file`:

```toml
[[plugin]]
name = "eslint"
version = "8.57.0"
extra_packages = ["eslint-plugin-react@7.33.2", "eslint-plugin-security@3.0.1"]
```

See [references/plugins-and-extensions.md](references/plugins-and-extensions.md) and <https://docs.qlty.sh/cli/linter-extensions.md>.

`qlty init` writes `.qlty/qlty.toml` into the repository. In someone else's checkout that is a real, reviewable change — say so before running it, and do not leave it behind uncommitted in a repository you were only asked to inspect.

## Core commands

All of `check`, `fmt`, and `smells` must run inside a Git repository with qlty initialized, and default to **changed files only**; pass `--all` or explicit paths to widen. `check` and `fmt` install any missing plugins and language runtimes on demand, so the first run is slow and needs network access.

```bash
qlty check                                   # lint changed files
qlty check --all                             # lint the whole repository
qlty check --all --filter=eslint             # one plugin only
qlty check --fix --level=low                 # apply auto-fixes, surface low-severity and up
qlty check --upstream origin/main            # only what this branch changed

qlty fmt                                     # auto-format changed files
qlty fmt --all                               # auto-format everything

qlty metrics --all --max-depth 2             # per-directory summary
qlty metrics --all --sort complexity --limit 10   # the 10 most complex files
qlty metrics --functions path/to/file.ts     # function-level complexity

qlty smells --all                            # duplication, deep nesting, high complexity
qlty smells --upstream origin/main           # smells introduced by this branch
```

`--level` sets what is displayed (`note`, `fmt`, `low`, `medium`, `high`); `--fail-level` sets what makes the command exit non-zero. `--sarif` emits SARIF for tooling.

## Offline use

The `qlty` binary is self-contained, but its commands split on network needs:

- **Offline-safe:** `qlty metrics` and `qlty smells` use qlty's own built-in static analysis — no plugin or runtime downloads, so they work with no network at all.
- **Network on first use:** `qlty check` and `qlty fmt` install the enabled plugins and any qlty-managed language runtimes on demand, per repository, on their first run. With no network that first run fails.

In a network-restricted environment (sandboxes, locked-down CI, benchmark runs), either pre-warm the cache while you still have network — run `qlty init` and one `qlty check --all` in the target repository so plugins and runtimes land in `~/.qlty` — or scope quality verification to `qlty metrics` and `qlty smells` and say so in your report rather than presenting them as full lint coverage.

## Working loop

Upstream's own recommendation for agents, and a good default here:

1. `qlty fmt` before committing — formatting churn should never reach a reviewer.
2. `qlty check --fix --level=low` before finishing, then fix by hand whatever it could not auto-fix.
3. For a quality-focused request, add `qlty smells --all` and `qlty metrics --all --sort complexity --limit 10`, and act on the worst offenders rather than reporting the numbers.

Report what you ran and what it found. A clean `qlty check` is evidence; "I made it high quality" is not.
