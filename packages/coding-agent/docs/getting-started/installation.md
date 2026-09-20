---
title: Installation
description: Install Atomic with a package manager or a release archive, and uninstall it cleanly.
---

# Installation

**Outcome:** Atomic is on your `PATH` and `atomic --version` prints a version.

**Prerequisites:** A supported shell. See [Prerequisites](/quickstart#prerequisites).

## Install

### Package managers

Install with npm:

```bash
npm install -g @bastani/atomic
```

With pnpm:

```bash
pnpm add -g @bastani/atomic
```

With Bun:

```bash
bun add -g @bastani/atomic
```

Atomic does not require package install scripts. Add `--ignore-scripts` if you want to disable dependency lifecycle scripts during a package install.

Embedded PostgreSQL is available without install scripts or a first-run download on Linux x64/ARM64, both glibc and musl, macOS x64/ARM64, and Windows x64/ARM64.

Keep a standalone archive's complete directory, including `node_modules`, libraries, and licenses. Package managers select the runtime for your platform automatically.

Windows ARM64 uses Windows x64 PostgreSQL under Windows 11's x64 emulation, not native PostgreSQL ARM64. It requires the Microsoft Visual C++ x64 v14 Redistributable. Windows 10 on ARM cannot run this x64 runtime, and Windows ARM64 execution still needs hardware validation.

### Release archive

Alternatively, install the self-contained release archive, which needs no Node.js or package manager.

On macOS or Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/bastani-inc/atomic/main/install.sh | sh
```

On Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/bastani-inc/atomic/main/install.ps1 | iex
```

The installer downloads only the matching GitHub Release archive and `SHA256SUMS`, verifies the checksum, and keeps the complete payload in a versioned directory.

In an interactive terminal it prints the release and platform it is installing, draws a live progress bar with the percentage and megabytes downloaded, confirms each phase on one line, shows the Atomic logo (UTF-8 terminals on macOS/Linux, Windows Terminal on Windows), and ends with a `To start:` block. PATH guidance appears only when the launcher directory is not already on your `PATH`. When an install already exists it prints the installed version, or `Version <tag> already installed`, and still repairs that version in place.

Set `NO_COLOR=1` for plain text instead: no colours, no progress bar, and no logo, with `Downloading <archive> (<size> MB) ... done` in place of the bar. The installer also switches to plain output on its own when standard output is not a terminal, when `CI` is set, or (on macOS/Linux) when `TERM` is `dumb` or unset. Plain mode changes only the presentation; verification, error messages, and exit codes stay the same.

On macOS or Linux, the default paths are `~/.local/share/atomic` for versioned payloads and `~/.local/bin/atomic` for the launcher. The installer never edits your shell configuration; when `~/.local/bin` is not on your `PATH` it prints a paste-safe `export PATH=...` command (or `fish_add_path` for fish) and names the startup file to add it to.

On Windows, the defaults are `%LOCALAPPDATA%\atomic` for payloads and `%LOCALAPPDATA%\atomic\bin\atomic.cmd` for the launcher. The installer prints `Installed to <path>`, and when it adds the bin directory to your User PATH it says so and asks you to open a new terminal.

The installer accepts these environment variables:

#### ATOMIC_VERSION

Pin an exact release tag instead of the latest release, or pass a flag that overrides it. On macOS or Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/bastani-inc/atomic/main/install.sh | sh -s -- --ref 0.9.11
```

On Windows PowerShell:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/bastani-inc/atomic/main/install.ps1))) -Ref 0.9.11
```

Pins use Atomic's `MAJOR.MINOR.PATCH` or `MAJOR.MINOR.PATCH-alpha.REVISION` release tag form and are honored literally: if GitHub answers with a different release tag, the installer stops before downloading anything rather than installing a version you did not ask for.

#### ATOMIC_INSTALL_DIR

Override the install root that holds the versioned payloads (default `~/.local/share/atomic` on macOS/Linux, `%LOCALAPPDATA%\atomic` on Windows). On macOS/Linux, a relative value resolves against the physical directory where the installer starts and is used exactly as given, including any trailing whitespace or newline. The install root cannot equal or sit inside the launcher path (`ATOMIC_BIN_DIR/atomic`); impossible layouts fail before any download or filesystem change.

#### ATOMIC_BIN_DIR

Override the launcher directory (default `~/.local/bin` on macOS/Linux, `%LOCALAPPDATA%\atomic\bin` on Windows). Relative values resolve the same way as `ATOMIC_INSTALL_DIR`. It cannot sit inside the install root's `current` or `versions` directories, which the installer replaces on every install. A Unix value containing `:` cannot be one PATH entry, so the installer prints direct-run guidance instead of editing PATH.

#### GITHUB_TOKEN / GH_TOKEN

Optional; raises GitHub API limits on shared networks. Curl and GNU Wget keep the token in a protected temporary file instead of process arguments. BusyBox Wget remains supported without a token, and with a token when the latest-release redirect avoids the API; if an authenticated API fallback is needed, install curl or GNU Wget rather than exposing the token.

### Which runtime runs your workflows

How you install Atomic decides which runtime hosts it: a package-manager install runs under Node, while the standalone binaries are Bun-compiled and run under Bun. Authored workflows execute inside whichever host is active, so a workflow that reaches for a `Bun.*` global runs only under the standalone binary and fails with `Bun is not defined` under an npm install. Installing Bun separately does not change that — the npm install still runs on Node. Write workflow code against APIs both hosts provide, such as `node:child_process` and `node:fs`; see [Custom Workflow Authoring](/workflows/authoring) for the rule and worked examples.

### Alpine and musl Linux archives

The shell installer detects Alpine and selects `atomic-linux-x64-musl.tar.gz` or `atomic-linux-arm64-musl.tar.gz`. Keep the complete archive, including payload-local `libgcc` and `libstdc++`; stock Alpine needs no runtime package install.

Two features work differently on musl:

- **Clipboard:** install `wl-clipboard` on Wayland, `xclip` or `xsel` on X11, or the Termux:API app and `termux-api` package on Termux. OSC 52 is available only over SSH or Mosh, not as a substitute for a failed local clipboard backend.
- **Durable workflows:** PostgreSQL is included and provisions offline without Docker or external Postgres. If no durable backend can be provisioned, Atomic warns and uses non-durable in-memory storage.

Then start Atomic in the project directory you want it to work on:

```bash
cd /path/to/project
atomic
```

## Uninstall

On macOS or Linux, for a default archive install, remove `~/.local/share/atomic` and the `~/.local/bin/atomic` link.

On Windows, remove `%LOCALAPPDATA%\atomic`. If you set `ATOMIC_BIN_DIR`, also remove `atomic.cmd` and the `atomic-current` junction from that directory, then remove the directory from your User PATH.

For a package install, remove the global package with the same package manager. With npm:

```bash
npm uninstall -g @bastani/atomic
```

With pnpm:

```bash
pnpm remove -g @bastani/atomic
```

With Bun:

```bash
bun remove -g @bastani/atomic
```

These commands remove the CLI only. User configuration, auth, sessions, and packages remain under `~/.atomic/agent/` unless you delete that directory yourself.

## Verify the install

Run:

```bash
atomic --version
```

Expected output is a single version line, for example:

```text
0.9.14-alpha.2
```

If the shell reports `command not found`, the launcher directory is not on your `PATH` yet. Open a new shell, or add the bin directory the installer printed to your `PATH` and try again.

## Next step

Continue to [Authentication](/getting-started/authentication).
