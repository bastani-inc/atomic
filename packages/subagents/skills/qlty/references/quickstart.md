# Getting Started with the Qlty CLI

> **Source:** <https://docs.qlty.sh/cli/quickstart.md> (retrieved 2026-08-26).
> Copied from the upstream page. Text is unchanged; the page's MDX wrappers (`<Steps>`,
> `<CodeGroup>`, `<Accordion>`) and its embedded video iframes are rendered as plain Markdown
> headings and code blocks. Fetch the live page via <https://docs.qlty.sh/llms.txt> when in doubt.

## 1. Install the CLI

First, install our CLI onto your local machine:

```shell
# macOS & Linux
curl https://qlty.sh | sh
```

```shell
# Windows
powershell -c "iwr https://qlty.sh | iex"
```

Qlty CLI supports macOS and Linux on X64 and ARM64, with Windows support in development.

### Alternative: Installing with verification

We provide GitHub attestations powered by Sigstore that allow you to verify the authenticity of the Qlty CLI before installing it.

**Prerequisites:** [GitHub CLI (`gh`)](https://cli.github.com/manual/installation) must be installed.

**Example (macOS Apple Silicon):**

```shell
# Download the archive from https://github.com/qltysh/qlty/releases
curl -LO https://github.com/qltysh/qlty/releases/latest/download/qlty-aarch64-apple-darwin.tar.xz

# Verify the attestation
gh attestation verify --owner qltysh qlty-aarch64-apple-darwin.tar.xz

# Unpack and install
tar -xJf qlty-aarch64-apple-darwin.tar.xz
sudo mv qlty-aarch64-apple-darwin/qlty /usr/local/bin/
```

For other platforms, download the appropriate archive from [GitHub releases](https://github.com/qltysh/qlty/releases).

Learn more: [GitHub artifact attestations documentation](https://docs.github.com/en/actions/concepts/security/artifact-attestations)

## 2. Initialize your repository

From your Git repository, run:

```shell
qlty init
```

This will generate a baseline configuration based on the file types within your project and store it as `.qlty/qlty.toml` in your repository.

You can find more plugins with `qlty plugins list` and enable them with `qlty plugins enable [plugin]`.

## 3. Identify code smells and review quality metrics

Check the code quality (for [supported programming languages](https://docs.qlty.sh/languages.md)):

```bash
# Scan for code smells like duplication
qlty smells --all
```

```bash
# Review a summary of quality metrics
qlty metrics --all --max-depth=2 --sort complexity --limit 10
```

## 4. Lint your project

```bash
# Run linters on changed files on your current branch
qlty check
```

```bash
# Run linters on all files
qlty check --all
```

```bash
# Run only the shellcheck linter on all files
qlty check --all --filter=shellcheck
```

```bash
# Run linters on the web/ folder
qlty check web/
```

## 5. Auto-format your code

```bash
# Auto-format changed files on your current branch
qlty fmt
```

## System requirements

> **Source:** <https://docs.qlty.sh/cli/system-requirements.md> (retrieved 2026-08-26).

The Qlty CLI runs on macOS and Linux on X64 and ARM64. Note that the quickstart page and the
system-requirements page disagree about Windows: the quickstart says "Windows support is in
development" while the system-requirements table lists Windows 11+ on X86 as supported. Verify
Windows behavior against the live docs rather than relying on either statement.
