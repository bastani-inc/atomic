# Qlty CLI Command Reference

> **Sources** (all retrieved 2026-08-26), one section per upstream page:
> <https://docs.qlty.sh/cli/commands/init.md>, <https://docs.qlty.sh/cli/commands/check.md>,
> <https://docs.qlty.sh/cli/commands/fmt.md>, <https://docs.qlty.sh/cli/commands/metrics.md>,
> <https://docs.qlty.sh/cli/commands/smells.md>, <https://docs.qlty.sh/cli/commands/plugins-list.md>,
> <https://docs.qlty.sh/cli/commands/plugins-enable.md>.
> Prose, flag descriptions, and examples are copied from those pages unchanged; the MDX
> `<AccordionGroup>` / `<Accordion>` option lists are rendered as Markdown bullet lists and the
> per-example captions are rendered as code-block comments. `initializd` is upstream's typo,
> preserved. For any flag not listed here, fetch the live page via <https://docs.qlty.sh/llms.txt>.

---

## `init`

```bash
qlty init [OPTIONS]
```

Set up Qlty in the current repository

This command will generate an initial project configuration file based on the contents of the repository and write it to `.qlty/qlty.toml` at the repository root.

When run without the `--skip-plugins` command, initialization will try to determine a reasonable set of linters and formatters to enable. Certain linters and formatters are enabled based on the detection of a linter configuration file. Others are enabled just based on the presence of target files of the programming language.

Following initialization, the command will print a summary of the configuration.

After generating a configuration file, the command will ask if you want to *sample* the results of the enabled plugins. Sampling runs each plugin against a small set of targets.

If Qlty is already initialized in the current repository, this command will exit with an error.

### Arguments

* `-y, --yes` — Answer yes to all prompts
* `-n, --no` — Answer no to all prompts
* `--skip-plugins` — Skip enabling plugins
* `--dry-run` — Print the generated configuration to stdout instead of saving to disk
* `--skip-default-source` — Initialize without default source
* `--source <SOURCE>` — A custom source to use for plugins. This can be a URL(name=url) or a path to a local directory(name=directory)

### Examples

```bash
# Generate a Qlty config for the current repository
qlty init

# Generate a Qlty config and skip prompts
qlty init --no

# Generate a Qlty config with no plugins
qlty init --skip-plugins
```

---

## `check`

```bash
qlty check [OPTIONS] [PATHS]...
```

Run linters

By default, only changed files are analyzed. Use `--all` or specify paths to override this behavior.

Installs plugins and their required runtimes as needed before analyzing.

By default, issues are cached locally to speed up subsequent runs.

Must be run within a Git repository with Qlty initializd.

### Arguments

* `[PATHS]...` — Files to analyze
* `-a, --all` — Check all files, not just changed
* `--fix` — Apply all auto-fix suggestions automatically. When combined with `--ai`, AI-generated fixes are applied without prompting for review. See [AI Autofixes Security Considerations](https://docs.qlty.sh/cloud/ai-autofixes.md#security-considerations) for important guidance when using this flag.
* `--no-fix` — Do not apply auto-fix suggestions
* `--ai` — Generate AI-powered fixes using a large language model (requires Qlty Cloud authentication). AI fixes should be reviewed before applying. Using `--ai` with `--fix` applies AI suggestions automatically without review—see [Security Considerations](https://docs.qlty.sh/cloud/ai-autofixes.md#security-considerations).
* `--unsafe` — Allow fixes for rules that may produce incorrect results and require careful human review. By default, fixes for certain rules are blocked because they are more likely to need manual judgment. This flag removes those restrictions.
* `--no-formatters` — Disable formatter checks
* `--no-progress` — Disable progress bar
* `--no-fail` — Exit successfully regardless of what issues are found
* `--no-error` — Exit successfully regardless of linter errors
* `--sample <SAMPLE>` — Sample results from a number of files for each linter
* `--level <LEVEL>` — Minimum level of issues to show [default: note] [possible values: note, fmt, low, medium, high]
* `-j, --jobs <JOBS>` — Maximum number of concurrent jobs
* `--filter <FILTER>` — Filter by plugin or check
* `-v, --verbose...` — Print verbose output
* `--summary` — Print a summary of issues
* `--upstream <UPSTREAM>` — Upstream base ref to compare against
* `--no-cache` — Disable caching issues
* `--print-errors` — Print errors to stderr
* `--fail-level <FAIL_LEVEL>` — Minimum level of issues to fail on [default: fmt] [possible values: note, fmt, low, medium, high]
* `--sarif` — SARIF output

### Examples

```bash
# Run linters on changed files on your current branch
qlty check

# Run linters on all files
qlty check --all

# Run only ESLint on all files
qlty check --all --filter=eslint

# Run linters on the web/ folder
qlty check web/
```

---

## `fmt`

```bash
qlty fmt [OPTIONS] [PATHS]...
```

Auto-format files by rewriting them

By default, only changed files are auto-formatted. Use `--all` or specify paths to override this behavior.

Installs plugins and their required runtimes as needed before analyzing.

Must be run within a Git repository with Qlty initializd.

### Arguments

* `[PATHS]...` — Files to analyze
* `-a, --all` — Check all files, not just changed
* `--no-progress` — Disable progress bar
* `--no-error` — Exit successfully regardless of linter errors
* `--sample <SAMPLE>` — Sample results from a number of files for each linter
* `--jobs <JOBS>` — Maximum number of concurrent jobs
* `--filter <FILTER>` — Filter by plugin or check
* `--trigger <TRIGGER>` — [default: manual] [possible values: manual, pre-commit, pre-push, build]
* `-v, --verbose...` — Print verbose output
* `--upstream <UPSTREAM>` — Upstream base ref to compare against
* `--index` — Format files in the Git index
* `--index-file <INDEX_FILE>` — Format files in the specified Git index file

### Examples

```bash
# Auto-format changed files on your current branch
qlty fmt

# Auto-format all files with prettier
qlty fmt --all --filter=prettier

# Auto-format files in a directory
qlty fmt web/
```

---

## `metrics`

```bash
qlty metrics [OPTIONS] [PATHS]...
```

Compute code quality metrics

Calculate metrics like classes count, complexity, lines of code, and cohesion for [supported languages](https://docs.qlty.sh/languages.md) using our custom built static analysis.

### Arguments

* `[PATHS]...` — Files to analyze
* `-a, --all` — Compute metrics for all files, not just changed
* `-d, --dirs` — Print per-directory stats
* `--functions` — Print function stats
* `--max-depth <MAX_DEPTH>` — Directory depth to print, this flag will also set to print per-directory stats
* `--sort <SORT>` — Sort output by column [possible values: name, classes, functions, fields, lines, loc, complexity, lcom]
* `--limit <LIMIT>` — Maximum rows to print
* `--exclude-tests` — Exclude tests
* `--upstream <UPSTREAM>` — Upstream base ref to compare against
* `--quiet` — Only show results

### Examples

```bash
# Summarize metrics across directories
qlty metrics --all --max-depth 2

# Review the 10 most complex files
qlty metrics --all --sort complexity --limit 10

# View function-level metrics for a file
qlty metrics --functions remix/app/root.tsx
```

---

## `smells`

```bash
qlty smells [OPTIONS] [PATHS]...
```

Find code smells like duplication and complexity

Detect issues like duplication (copy and pasted code), high complexity, deeply nested control flows, etc. for [supported languages](https://docs.qlty.sh/languages.md) using our custom built static analysis.

### Arguments

* `[PATHS]...` — Files to analyze
* `-a, --all` — Compute smells for all files, not just changed
* `--no-duplication` — Don't check for duplication
* `--include-tests` — Include tests
* `--no-snippets` — Don't show code snippets
* `--upstream <UPSTREAM>` — Upstream base ref to compare against
* `--quiet` — Only show results

### Examples

```bash
# Analyze your current branch
qlty smells

# Analyze your entire project for code smells
qlty smells --all

# Analyze specific paths for code smells
qlty smells example-app/components/ui react-app/utils

# Analyze a specific file for code smells
qlty smells example-app/components/ui/Dropdown.tsx

# Skip duplication analysis
qlty smells --all --no-duplication

# Analyze for code smells against a specific upstream branch
qlty smells --upstream origin/main
```

---

## `plugins list`

```bash
qlty plugins list [OPTIONS]
```

List all available plugins

This command lists all available plugins based on the sources declared in the current project's `qlty.toml` configuration file.

### Examples

```bash
# List all available plugins
qlty plugins list
```

---

## `plugins enable`

```bash
qlty plugins enable [OPTIONS] [PLUGINS]...
```

Enable plugins for the current project

The command edits the current project's `qlty.toml` file to enable plugins.

### Arguments

* `[PLUGINS]...` — Plugins to enable specified as name=version

### Examples

```bash
# Enable the latest version of shellcheck
qlty plugins enable shellcheck

# Enable shellcheck version 1.2.3
qlty plugins enable shellcheck=1.2.3

# Enable rubocop and eslint
qlty plugins enable rubocop eslint
```

### See also

`qlty plugins upgrade`, `qlty plugins disable` — see
<https://docs.qlty.sh/cli/commands/plugins-upgrade.md> and
<https://docs.qlty.sh/cli/commands/plugins-disable.md>.
