# Manual configuration without downloads

Sources: [qlty.toml specification](https://docs.qlty.sh/cli/qlty-toml.md) and [init](https://docs.qlty.sh/cli/commands/init.md), inspected 2026-09-05. This is adaptation guidance, not a verbatim upstream excerpt.

When qlty is missing, init fails, or installation is prohibited, configuration can still be prepared offline. First inspect existing `.qlty/qlty.toml`; preserve it and make only task-relevant changes. For read-only work, leave the checkout unchanged or prepare an isolated scratch fixture. Do not create a new repository/worktree copy merely to evade a task's checkout constraint.

## Minimal built-in analysis configuration

For a repository whose generated files live under `dist` and whose tests live under `test`, this is a valid starting point. Adapt patterns to observed layout, not assumptions:

```toml
config_version = "0"
exclude_patterns = ["**/dist/**"]
test_patterns = ["**/test/**"]
```

`config_version` is the string `"0"`, not a number. No plugin or remote source is required in this minimal example. It prepares built-in analysis configuration, not lint or security coverage. It does not mean metrics or smells have run.

When installed qlty is available, `qlty init --no --skip-plugins --skip-default-source` can prepare a similar no-download starting point; inspect installed help first. Do not repeat it over existing config.

## Add only justified plugins

Use locally available plugin definitions, a known project configuration, or bundled references to identify supported names/options. Keep the repository's existing formatter and linter; do not add competing presets. When plugin versions are not locally known, omit the optional version rather than inventing a pin, and record that resolution/execution remains unverified.

The official specification supports the default plugin source and plugin declarations:

```toml
config_version = "0"

[[source]]
name = "default"
default = true

[[plugin]]
name = "shellcheck"
```

This example is appropriate only when shell analysis is relevant. Preparing it offline does not fetch its source, plugin or runtime. Uncached source resolution or plugin installation can need network even if the qlty binary exists. Prefer a known cached/local source where available; see `qlty init --source` in [commands](commands.md). Do not invent local source paths.

For linter extensions, use either `extra_packages` or `package_file`, not both; consult [plugins and extensions](plugins-and-extensions.md). Avoid introducing new lockfiles or changing the project's package manager.

## Validate what is available

Python 3.11+ can check TOML syntax without network:

```bash
python3 -c 'import pathlib,tomllib; p=pathlib.Path(".qlty/qlty.toml"); c=tomllib.loads(p.read_text()); assert c["config_version"] == "0"; print("TOML parsed; config_version is string 0")'
```

This checks syntax and one required field, not the full qlty schema or plugin availability. If qlty is installed, run a relevant command such as `qlty metrics --all` in the authorized fixture to exercise configuration loading and built-in analysis. Use available schema tooling if present. Report any unavailable schema validation and do not download validators in a prohibited environment.

For a cached-plugin run, record the actual `qlty check` command and output; do not infer it passed from cache-directory existence. For a missing binary, report only configuration preparation and whichever authoritative repository checks actually ran. Missing optional qlty does not turn successful implementation into failure, but required project checks remain required.
