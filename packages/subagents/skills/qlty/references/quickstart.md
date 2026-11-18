# Getting Started with the Qlty CLI

> **Source:** <https://docs.qlty.sh/cli/quickstart.md> (retrieved 2026-11-18).
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

We provide GitHub attestations powered by Sigstore that allow you to verify the authenticity of the Qlty CLI before installing it. The check uses the [GitHub CLI (`gh`)](https://cli.github.com/manual/installation) 2.67.0 or later and doesn't depend on your machine's certificate store.

Follow the steps in [Integrity Verification](https://docs.qlty.sh/cli/integrity-verification.md) to download a release, verify it and install it. They are copied in [Integrity verification](#integrity-verification) below.

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

## Integrity verification

> **Source:** <https://docs.qlty.sh/cli/integrity-verification.md> (retrieved 2026-11-18). The
> "Verifying the CLI", "Checking an installed binary" and "Verifying upgrades" sections, copied
> unchanged; the warning callout is rendered as a quote.

You can verify any Qlty CLI release with the GitHub CLI (`gh`) before you install it. The check doesn't depend on your machine's certificate store, so it holds even when that store is out of date.

> **Warning:** Use `gh` 2.67.0 or later, signed in with `gh auth login`, even for public repositories. Older versions can report success for an archive that has no attestation. Install `gh` from a source that checks its own packages, such as Homebrew, winget, or a signed package repository.

**Example (macOS Apple Silicon):**

```shell
VERSION=0.660.0
TARGET=aarch64-apple-darwin

# Work in a new empty directory, so a failed step can't leave
# files from an earlier run behind
WORK="$(mktemp -d)"
ARCHIVE="$WORK/qlty-$TARGET.tar.xz"

# Install only if the download, the attestation check and the extraction
# all succeed. This replaces the qlty on your PATH, or installs to
# ~/.qlty/bin if you have none.
if curl -fL "https://github.com/qltysh/qlty/releases/download/v$VERSION/qlty-$TARGET.tar.xz" -o "$ARCHIVE" &&
  gh attestation verify "$ARCHIVE" --owner qltysh &&
  tar -xJf "$ARCHIVE" -C "$WORK"; then
  DEST="$(dirname "$(command -v qlty || echo "$HOME/.qlty/bin/qlty")")"
  mkdir -p "$DEST"
  install -m 755 "$WORK/qlty-$TARGET/qlty" "$DEST/qlty"
else
  echo "Download, attestation check or extraction failed. Not installing." >&2
fi

# Confirm which qlty runs, and its version
command -v qlty && qlty --version
```

If you installed to `~/.qlty/bin` for the first time, add it to your `PATH`.

For other platforms, set `TARGET` to `x86_64-apple-darwin`, `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`, `x86_64-unknown-linux-musl` or `aarch64-unknown-linux-musl`. See all archives on [GitHub releases](https://github.com/qltysh/qlty/releases).

**Example (Windows, PowerShell):**

```powershell
$Version = "0.660.0"
$Zip = "qlty-x86_64-pc-windows-msvc.zip"

# Work in a new empty directory, so a failed step can't leave
# files from an earlier run behind
$Work = New-Item -ItemType Directory -Path (Join-Path $env:TEMP ([guid]::NewGuid()))
$Archive = Join-Path $Work $Zip

Invoke-WebRequest -UseBasicParsing "https://github.com/qltysh/qlty/releases/download/v$Version/$Zip" -OutFile $Archive

# Install only if the attestation verifies and the archive extracts. This
# replaces the qlty.exe on your PATH, or installs to ~\.qlty\bin if you have none.
gh attestation verify $Archive --owner qltysh
if ($LASTEXITCODE -eq 0) {
  Expand-Archive $Archive -DestinationPath (Join-Path $Work "qlty") -ErrorAction Stop
  $Existing = Get-Command qlty -ErrorAction SilentlyContinue
  $Dest = if ($Existing) { Split-Path $Existing.Source } else { Join-Path $HOME ".qlty\bin" }
  New-Item -ItemType Directory -Force -Path $Dest | Out-Null
  Copy-Item (Join-Path $Work "qlty\qlty.exe") (Join-Path $Dest "qlty.exe") -Force -ErrorAction Stop
  if (-not $Existing) { $env:Path = "$Dest;$env:Path" }
} else {
  Write-Error "Attestation verification failed. Not installing."
}

qlty --version
```

If you installed to `~\.qlty\bin` for the first time, the script adds it to `PATH` for the current session only. Add it to your user `PATH` to keep it.

### Checking an installed binary

To check a `qlty` you already have, download and verify the archive for the version you installed, then compare the binaries. Set `VERSION` yourself rather than running `qlty --version`: if the binary was replaced, running it could expose your tokens.

```shell
VERSION=0.660.0
TARGET=aarch64-apple-darwin
WORK="$(mktemp -d)"
ARCHIVE="$WORK/qlty-$TARGET.tar.xz"

if curl -fL "https://github.com/qltysh/qlty/releases/download/v$VERSION/qlty-$TARGET.tar.xz" -o "$ARCHIVE" &&
  gh attestation verify "$ARCHIVE" --owner qltysh &&
  tar -xJf "$ARCHIVE" -C "$WORK"; then
  shasum -a 256 "$WORK/qlty-$TARGET/qlty" "$(command -v qlty)"
else
  echo "Download, attestation check or extraction failed. Nothing to compare." >&2
fi
```

If the two checksums differ, reinstall with the steps above, and rotate any Qlty tokens that machine could read. A `VERSION` that doesn't match the installed release also makes them differ, so check it first.

### Verifying upgrades

`qlty upgrade --verify-attestations` downloads each release's archive and checks its attestation before installing it, on macOS and Linux. It needs `gh` 2.67.0 or later, signed in. From v0.662.0, the upgrade stops if the attestation can't be verified, and on Windows the command refuses and points to this page. Without the flag, `qlty upgrade` runs the installer script, which does not check attestations. See [`upgrade`](https://docs.qlty.sh/cli/commands/upgrade).
