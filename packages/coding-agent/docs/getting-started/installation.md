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

Workflow persistence uses a local SQLite journal store by default, in `~/.atomic/workflows/journal/`. No database server or separate database installation is needed, and Atomic manages the store's files itself. To isolate runs in one file, use `ATOMIC_WORKFLOW_JOURNAL_PATH` or the [workflow storage settings](/settings#workflow-storage). To share runs across machines, see [Sharing storage across hosts](/storage#sharing-storage-across-hosts).

Keep a standalone archive's complete directory, including `node_modules`, libraries, and licenses. Package managers select the runtime for your platform automatically.


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

In an interactive terminal it prints the release and platform it is installing, draws a live progress bar with the percentage and megabytes downloaded, confirms each phase on one line, shows the Atomic logo (UTF-8 terminals on macOS/Linux, Windows Terminal on Windows), and ends with a `To start:` block. PATH guidance appears only when the launcher directory is not already on your `PATH`. When a different version is installed it prints `Installed version: <tag>` before upgrading.

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

#### Rerunning the installer

If the release you ask for (or the latest release, when you pin nothing) is already installed and healthy, the installer prints `atomic <tag> is already installed; skipping download (use --force to reinstall)` and stops there. It still looks up the release tag and prints `Installed to <path>` and any PATH guidance, but it downloads nothing and leaves the installed files alone. On Windows it also adds the bin directory to your User PATH if it went missing.

An install counts as healthy when `current` points at that release's version directory inside the install root (a `current` that points at a versions directory somewhere else is repaired) and the launcher resolves to it. On macOS/Linux that means the launcher link resolves to an executable `current/atomic`; the installer never runs the installed binary to decide. On Windows it means `current\atomic.exe --version` reports the release and the `atomic.cmd` shim and `atomic-current` junction match what the installer creates. On both platforms the version directory must still hold the files Atomic needs to start: `package.json`, `app.js`, `native-modifiers.js`, `native-module-path.js`, `native-platform.js`, and the `builtin` and `node_modules` directories. A different version, or a missing or broken launcher or payload, installs exactly as before and repairs the install.

To reinstall a healthy install anyway, pass `--force` on macOS/Linux or `-Force` on Windows, or set `ATOMIC_FORCE_INSTALL=1`. The environment variable works with `curl ... | sh` and `irm ... | iex`, where you cannot pass a flag:

```bash
curl -fsSL https://raw.githubusercontent.com/bastani-inc/atomic/main/install.sh | sh -s -- --force
curl -fsSL https://raw.githubusercontent.com/bastani-inc/atomic/main/install.sh | ATOMIC_FORCE_INSTALL=1 sh
```

```powershell
$env:ATOMIC_FORCE_INSTALL = "1"; irm https://raw.githubusercontent.com/bastani-inc/atomic/main/install.ps1 | iex
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/bastani-inc/atomic/main/install.ps1))) -Force
```

#### ATOMIC_INSTALL_DIR

Override the install root that holds the versioned payloads (default `~/.local/share/atomic` on macOS/Linux, `%LOCALAPPDATA%\atomic` on Windows). On macOS/Linux, a relative value resolves against the physical directory where the installer starts and is used exactly as given, including any trailing whitespace or newline. The install root cannot equal or sit inside the launcher path (`ATOMIC_BIN_DIR/atomic`); impossible layouts fail before any download or filesystem change.

#### ATOMIC_BIN_DIR

Override the launcher directory (default `~/.local/bin` on macOS/Linux, `%LOCALAPPDATA%\atomic\bin` on Windows). Relative values resolve the same way as `ATOMIC_INSTALL_DIR`. It cannot sit inside the install root's `current` or `versions` directories, which the installer replaces on every install. A Unix value containing `:` cannot be one PATH entry, so the installer prints direct-run guidance instead of editing PATH.

#### GITHUB_TOKEN / GH_TOKEN

Optional; raises GitHub API limits on shared networks. Curl and GNU Wget keep the token in a protected temporary file instead of process arguments. BusyBox Wget remains supported without a token, and with a token when the latest-release redirect avoids the API; if an authenticated API fallback is needed, install curl or GNU Wget rather than exposing the token.

### Which runtime runs your workflows

How you install Atomic decides which runtime hosts it: a package-manager install runs under Node, while the standalone binaries are Bun-compiled and run under Bun. Authored workflows execute inside whichever host is active, so a workflow that reaches for a `Bun.*` global runs only under the standalone binary and fails with `Bun is not defined` under an npm install. Installing Bun separately does not change that — the npm install still runs on Node. Write workflow code against APIs both hosts provide, such as `node:child_process` and `node:fs`; see [Custom Workflow Authoring](/workflows/authoring) for the rule and worked examples.

### Git

Atomic needs git 2.30.0 or newer for workflow worktrees, git packages, and the footer branch. It uses the first `git` in an absolute directory on your `PATH` (never the working directory) when that git runs and reports 2.30.0 or newer. Otherwise it downloads a portable git, the build GitHub Desktop ships from [desktop/dugite-native](https://github.com/desktop/dugite-native), the same way it provides `fd` and `rg`:

- **Where:** `~/.atomic/agent/bin/git/` (under the directory `ATOMIC_CODING_AGENT_DIR` points to, when set).
- **When:** at interactive startup, before a workflow run starts, and the first time a git package is installed or updated. Run `/tools` to see which git Atomic uses, its version, and why none is available.
- **Verified:** Atomic pins one release and checks every download against a SHA-256 stored in its source. A download that does not match is discarded and nothing is installed.
- **Updates:** when a new Atomic version pins a different git release, the next start that can reach github.com selects the new release. Commands already using an older release keep their executable and helper paths. Offline, or after a failed download, the older copy keeps working, Atomic says so once, and `/tools` shows why; it tries again at the next start.
- **Platforms:** macOS x64 and arm64, Linux x64, arm64, and armv7 with glibc 2.34 or newer, and Windows x64, arm64, and x86.
- **Agent shells:** when no `git` is on your `PATH` at all, the `bash` tool puts the portable git first on `PATH`, so agents run the same git Atomic uses. An older system git stays on `PATH` for your shells; Atomic uses the portable copy only for its own git commands.
- **Offline:** with `ATOMIC_OFFLINE=1` Atomic never downloads git. A portable git that is already installed keeps working.

Older portable releases stay cached while existing commands may use them. To reclaim that space, close the Atomic sessions using the tools directory before removing its `git/` cache. The next online startup downloads git again; until then, offline use needs a system git.

When no git is available and Atomic cannot download one, the error names the command for your system and `/tools` shows it:

| System | Command |
|---|---|
| macOS | `xcode-select --install` |
| Windows | `winget install --id Git.Git -e --source winget` |
| Ubuntu 22.04 and newer, Debian and derivatives | `apt-get install git` |
| Ubuntu earlier than 22.04 | `add-apt-repository ppa:git-core/ppa && apt update && apt install git` (its own package is older than 2.30) |
| Fedora, RHEL, Rocky, Alma, Oracle Linux | `dnf install git` |
| Amazon Linux 2 and 2023 | `yum install git` and `dnf install git` |
| openSUSE, SLES | `zypper install git` |
| Arch, Manjaro | `pacman -S git` |
| Alpine and other musl distributions | `apk add git` |
| Void, Gentoo, Mageia, NixOS | `xbps-install git`, `emerge --ask --verbose dev-vcs/git`, `urpmi git`, `nix-env -i git` |
| Termux, FreeBSD, OpenBSD, illumos | `pkg install git`, `pkg install git`, `pkg_add git`, `pkg install developer/versioning/git` |

Linux commands are for a root shell. Other systems: see [git-scm.com/downloads](https://git-scm.com/downloads).

Certificates and HTTPS differ by platform:

- **Linux:** the portable git verifies servers with its bundled CA file. Set `GIT_SSL_CAINFO` to use your own bundle; while Atomic sets it, it takes precedence over `http.sslCAInfo` in your git config. HTTPS clones and fetches use the system libcurl, so install it if your image lacks it, for example `apt install libcurl4`. Local operations such as commits and worktrees do not need it.
- **macOS:** the portable git uses the system's certificate trust.
- **Windows:** the portable git uses the Windows certificate store, like Git for Windows.

### Alpine and musl Linux archives

The shell installer detects Alpine and selects `atomic-linux-x64-musl.tar.gz` or `atomic-linux-arm64-musl.tar.gz`. Keep the complete archive, including payload-local `libgcc` and `libstdc++`; stock Alpine needs no runtime package install.

Clipboard setup depends on your environment:

- **Clipboard:** install `wl-clipboard` on Wayland, `xclip` or `xsel` on X11, or the Termux:API app and `termux-api` package on Termux. OSC 52 forwards copies over SSH, Mosh, or Rex and is a fallback on headless Linux. Set `ATOMIC_CLIPBOARD_OSC52=1`, or the legacy `PI_CLIPBOARD_OSC52=1`, to force terminal forwarding. Your terminal must support it; forwarding does not confirm a successful local clipboard write.

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
