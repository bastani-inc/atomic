---
name: qlty
description: Code quality checks, formatting, and metrics via qlty CLI. Use when asked to verify code quality, add or run verifiers, lint or format code, measure complexity, or find code smells. Includes environment-aware setup and manual offline configuration when qlty is missing or installation is restricted.
---

# Qlty code quality

Use qlty to coordinate relevant linters, formatters and built-in analysis. Repository checks in AGENTS.md, package scripts and CI remain authoritative. Prefer the project's tools and user priorities over generic language presets: a TypeScript repository using Biome does not need a competing ESLint/Prettier rollout.

## Choose useful checks

Inspect the task, languages, existing config, scripts, lockfiles and baseline findings. Select reliable, low-noise checks that address the requested risks. Security plugins, linter extensions and metrics are choices, not a checklist to maximize. Record commands, scope, output and a relevant baseline; fix in-scope findings rather than reporting complexity numbers without context.

## Check environment and authorization

1. Look for existing `.qlty/qlty.toml`, installed `qlty --version`, cached plugins and runtimes. Preserve existing configuration; do not run init over it.
2. During authorized coding, missing configuration is not a blocker: run `qlty init --no` when available, inspect its generated suggestions and tailor them. Configuration is a reviewable change. Explicit read-only tasks remain read-only, or use isolated scratch configuration.
3. Prefer installed/cached tools. Install missing tools/plugins when online access and permissions permit. A known offline or restricted environment is sufficient reason not to attempt prohibited downloads; otherwise make a reasonable capability check or one bounded setup attempt. Do not repeat blocked installs or require production credentials.
4. If the binary is missing or init cannot run, read [manual configuration](references/manual-configuration.md) and prepare repo-appropriate `.qlty/qlty.toml` by hand when configuration changes are in scope. This requires no network. Validate TOML and available schema support, and label configuration preparation separately from checks executed.
5. Continue available repository checks when optional qlty installation or execution is unavailable. Report the constraint, attempted commands and observed output, checks actually run and coverage still missing. Optional qlty availability is not a universal completion gate and does not relax authoritative checks.

## Installation when permitted

The documented macOS/Linux installer is `curl https://qlty.sh | sh`. Inspect installer and platform support before executing downloaded code. The default binary location is `~/.qlty/bin`; check that location before reinstalling and add it to this shell's PATH if appropriate. `QLTY_NO_MODIFY_PATH=1` prevents shell-profile edits; `QLTY_INSTALL_BIN_PATH` chooses another installation directory. Windows support varies by release; verify current support rather than assuming POSIX commands work there.

Online, start with <https://docs.qlty.sh/llms.txt> and fetch relevant command/plugin documentation. Offline, use bundled references instead of attempting the network. Never invent plugin versions or flags.

## Run and report

Use explicit paths or a suitable upstream base to keep checks in scope. Commands default to changed files; `--all` widens coverage. `check` and `fmt` may install plugin runtimes on first use. A cached plugin can work offline, but uncached dependencies cannot. Installed built-in `metrics` and `smells` may work offline without plugin downloads; configuration source resolution can still need locally available definitions. A missing binary runs none of these checks.

```bash
qlty check
qlty check --upstream origin/main
qlty metrics --functions path/to/file.ts
qlty smells path/to/file.ts
```

Choose the relevant subset. For authorized formatting/fixes, use scoped `qlty fmt` or `qlty check --fix --level=low`, inspect the diff and rerun checks. Do not use `--all` formatting by habit or rewrite files during read-only review. Avoid unsafe auto-fixes and broad churn. `--level` controls displayed severity; `--fail-level` controls failure severity. Do not suppress errors to manufacture a green result.

Report four distinct facts: configuration prepared/changed, checks passed with command/output, failed checks, and checks not run with reasons. A parsed TOML file is not lint, security, metrics or full schema evidence. A clean run with no applicable plugins is not full quality coverage.

## Bundled references

- [Manual configuration](references/manual-configuration.md): offline/missing-binary recipe and source-backed TOML.
- [Quickstart](references/quickstart.md): installation and initialization.
- [Commands](references/commands.md): exact init/check/fmt/metrics/smells/plugin flags.
- [Plugins and extensions](references/plugins-and-extensions.md): definitions, extra packages and package-file choices.
- [Upstream agent examples](references/coding-with-ai-agents.md): source excerpts, not a mandate to run every command or download in restricted environments.

These are dated source excerpts. Prefer current official documentation when reachable; preserve the environment and authorization rules above when an upstream example assumes unrestricted installation.
