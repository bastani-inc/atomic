---
title: Installation
description: Install Atomic with a package manager or a release archive, and uninstall it cleanly.
---

# Installation

**Outcome:** `atomic` is on your `PATH` and `atomic --version` prints a version.

**Prerequisites:** A supported shell. See [Prerequisites](/quickstart#prerequisites).

## Install

### Package managers

Requires Node.js 22.19 or newer (or Bun 1.4.2+ for Bun installs):

```bash
npm install -g @bastani/atomic
# or: pnpm add -g @bastani/atomic
# or: bun add -g @bastani/atomic
```

- Atomic does not require package install scripts; pass `--ignore-scripts` if you disable lifecycle scripts.
- Package managers select the right platform runtime automatically. Keep a standalone archive's complete directory (`node_modules`, libraries, licenses) intact.
- Atomic's native module ships as one optional package per platform (`@bastani/atomic-natives-<platform>`), and npm, pnpm and Bun install only the one for your platform. A global install writes about 17,660 files and 224 MiB on Linux, and about 17,690 files and 211 MiB on Windows.
- Atomic publishes no shrinkwrap: the package manager resolves Atomic's dependencies when you install, so two installs of the same release can get different versions of packages Atomic depends on indirectly. The packages Atomic depends on directly are pinned to exact versions. The [release archive](#release-archive) carries the exact dependency tree its release was tested with. Atomic 0.10.4-alpha.1 and earlier published a shrinkwrap, and npm 11.6.2 and later installed the native module package of every platform for them.
- On Linux, `npm ci` from a project lockfile that npm 11.10 or older wrote (npm 10 included) installs both the glibc and the musl package, about 5 MiB more, because those lockfiles do not record which C library each package needs. Atomic loads the one that matches.
- Do not omit optional dependencies (`npm install --omit=optional`, `pnpm install --no-optional`, `bun install --omit=optional`) in a project: without your platform's package Atomic stops at startup with an error that names the package. Reinstall Atomic without those options to fix it. A global npm install is unaffected: npm installs the platform package of a global package even with `--omit=optional`.
- Atomic also stops when its native module is from another release. If you updated Atomic while it was running, the message says so: restart it. Otherwise the installation is broken, and the message names both releases: reinstall Atomic. A process that stopped this way, such as an SDK program, keeps refusing until it restarts; if you reinstall while it runs, its message then says to restart it.
- Sessions are stored locally in `~/.atomic/workflows/journal.sqlite` with no database server needed. To share sessions across machines, see [Sharing storage across hosts](/storage#sharing-storage-across-hosts).
- On Node 22, `AsyncLocalStorage` runs on promise hooks, which make every `await` in an Atomic process cost more. Node 24 and Bun have no such cost, so run Atomic on Node 24 or later to avoid it. Do not set `NODE_OPTIONS=--experimental-async-context-frame` for this: Node 24 and later refuse to start with that option, and commands Atomic runs for you inherit `NODE_OPTIONS`.

### Release archive

Install the self-contained release archive without Node.js or a package manager:

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/bastani-inc/atomic/main/install.sh | sh
```

```powershell
# Windows PowerShell
irm https://raw.githubusercontent.com/bastani-inc/atomic/main/install.ps1 | iex
```

The installer fetches the matching GitHub Release archive and `SHA256SUMS`, verifies the SHA-256 checksum, and installs into a versioned directory:

| Platform | Default payload directory | Default launcher | PATH behavior |
| --- | --- | --- | --- |
| macOS / Linux | `~/.local/share/atomic` | `~/.local/bin/atomic` | Never edits shell rc files; prints a paste-safe `export PATH=...` (or `fish_add_path`) command if missing |
| Windows | `%LOCALAPPDATA%\atomic` | `%LOCALAPPDATA%\atomic\bin\atomic.cmd` | Adds the bin directory to User PATH when missing and tells you to open a new terminal |

**Terminal output:** In an interactive terminal, the installer prints the release, platform, live download progress bar, one-line phase confirmations, logo (UTF-8 terminals on macOS/Linux; Windows Terminal on Windows), `Installed version: <tag>` on upgrades, and a `To start:` block. Set `NO_COLOR=1` for plain text output (`Downloading <archive> (<size> MB) ... done`); plain mode also activates automatically when stdout is not a TTY, `CI` is set, or Unix `TERM` is unset/`dumb`. Verification, errors, and exit codes are identical.

#### ATOMIC_VERSION

Pin an exact release tag (`MAJOR.MINOR.PATCH` or `MAJOR.MINOR.PATCH-alpha.REVISION`) via `ATOMIC_VERSION` or a flag (which overrides the env var):

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/bastani-inc/atomic/main/install.sh | sh -s -- --ref 0.9.11
```

```powershell
# Windows PowerShell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/bastani-inc/atomic/main/install.ps1))) -Ref 0.9.11
```

Pins are honored literally: if GitHub returns a different tag, the installer aborts before downloading.

#### Rerunning the installer

If the requested version (or latest release when unpinned) is already installed and healthy, the installer prints `atomic <tag> is already installed; skipping download (use --force to reinstall)`, prints the install path and any PATH guidance, and exits without downloading.

- **Offline reruns:** Pinned reruns make no network request. Unpinned reruns still check for the latest tag.
- **Health checks:** An install is healthy when `current` points to the target version inside the install root (a `current` that points at a versions directory somewhere else is repaired), the launcher matches its recorded hash and resolves to `current`, and the version directory must still hold the files Atomic needs to start: `package.json`, `app.js`, `native-modifiers.js`, `native-module-path.js`, `native-platform.js`, `builtin/`, and `node_modules/`. On macOS/Linux, the launcher link must resolve to an executable `current/atomic` (without executing it). On Windows, `current\atomic.exe --version` must match, `atomic.cmd` and `atomic-current` must match, and a missing User PATH entry is restored. Any broken or missing piece triggers a full repair install.
- **Concurrency and atomic switches:** Only one installer runs per install directory at a time. A second run waits up to 30 minutes (override in seconds with `ATOMIC_INSTALL_LOCK_TIMEOUT`), printing `Waiting for another atomic installer ... to finish...`. A killed installer releases its lock and the next run cleans up partial files. The previous `atomic` version stays usable until the final switch.

To force a reinstall, pass `--force` on macOS/Linux or `-Force` on Windows, or set `ATOMIC_FORCE_INSTALL=1`:

```bash
curl -fsSL https://raw.githubusercontent.com/bastani-inc/atomic/main/install.sh | sh -s -- --force
curl -fsSL https://raw.githubusercontent.com/bastani-inc/atomic/main/install.sh | ATOMIC_FORCE_INSTALL=1 sh
```

```powershell
$env:ATOMIC_FORCE_INSTALL = "1"; irm https://raw.githubusercontent.com/bastani-inc/atomic/main/install.ps1 | iex
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/bastani-inc/atomic/main/install.ps1))) -Force
```

#### ATOMIC_INSTALL_DIR

Override the versioned payload root (default `~/.local/share/atomic` on macOS/Linux, `%LOCALAPPDATA%\atomic` on Windows). On macOS/Linux, a relative value resolves against the physical directory where the installer starts and is used verbatim, including any trailing whitespace or newline. The install root cannot equal or sit inside the launcher path (`ATOMIC_BIN_DIR/atomic`); invalid layouts fail before downloading.

#### ATOMIC_BIN_DIR

Override the launcher directory (default `~/.local/bin` on macOS/Linux, `%LOCALAPPDATA%\atomic\bin` on Windows). Relative values resolve the same way as `ATOMIC_INSTALL_DIR`. It cannot sit inside the install root's `current` or `versions` directories. On Unix, values containing `:` cannot be added as one `PATH` entry, so the installer prints direct-run instructions instead.

#### GITHUB_TOKEN / GH_TOKEN

Optional. The installer resolves releases via `github.com` redirects first and falls back to the GitHub API (60 unauthenticated requests/hour per IP) only when needed. If rate-limited, pass `GITHUB_TOKEN=$(gh auth token)` (or `GH_TOKEN`).

`curl` and GNU `wget` pass the token through a protected temporary file instead of process arguments. BusyBox `wget` works without a token or when redirects avoid the API; use `curl` or GNU `wget` if authenticated API fallback is needed.

<a id="which-runtime-runs-your-workflows" />

### Which runtime runs Atomic?

Package-manager installs run on Node.js; standalone release archives run on Bun. Installing Bun separately does not switch an npm install to Bun. [Codemode scripts](/codemode) always run inside a sandboxed JavaScript VM with no direct Node or Bun APIs.

### Git

Atomic requires Git 2.30.0 or newer for worktrees, git packages, and the footer branch display. It uses the first `git` found in an absolute `PATH` directory (never the working directory) if it reports 2.30.0+. Otherwise, Atomic downloads a verified portable Git ([desktop/dugite-native](https://github.com/desktop/dugite-native)) just like `fd` and `rg`. A few things differ with an older Git: SDK workspace bindings need Git 2.33+; before Git 2.33, a named subagent worktree whose creation was cut off (for example by a killed Atomic) is reported as busy after a 30-second wait rather than at once; and before Git 2.36, a worktree snapshot restore stops with an error when a worktree of its store has a path with a line break.

- **Location:** `~/.atomic/agent/bin/git/` (or under `ATOMIC_CODING_AGENT_DIR`).
- **When:** Downloaded at interactive startup or on the first git package install/update. Run `/tools` to check which Git Atomic uses and why.
- **Verification:** Pinned to one release and verified against a built-in SHA-256 checksum; mismatched downloads are discarded.
- **Updates:** When a new Atomic version pins a newer Git release, the next online start switches to it while running commands finish on the older copy. Offline or after a failed download, the cached copy continues working and `/tools` notes the reason.
- **Supported platforms:** macOS (x64, arm64), Linux with glibc 2.34+ (x64, arm64, armv7), and Windows (x64, arm64, x86).
- **Agent shells:** If no `git` is on `PATH`, the `bash` tool prepends portable Git so agents can run `git`. If an older system `git` is on `PATH`, your shells keep it while Atomic uses portable Git internally.
- **Offline mode:** `ATOMIC_OFFLINE=1` prevents downloads; an already-cached portable Git still works.
- **Cache cleanup:** Older portable releases stay cached while existing commands may use them. Close running Atomic sessions before deleting `~/.atomic/agent/bin/git/`. The next online startup downloads git again; until then, offline use needs a system git.

If no suitable Git is found and portable download is unavailable, install Git for your platform (shown in the error and `/tools`):

| System | Install command |
| --- | --- |
| macOS | `xcode-select --install` |
| Windows | `winget install --id Git.Git -e --source winget` |
| Ubuntu 22.04+, Debian and derivatives | `apt-get install git` |
| Ubuntu earlier than 22.04 | `add-apt-repository ppa:git-core/ppa && apt update && apt install git` |
| Fedora, RHEL, Rocky, Alma, Oracle Linux | `dnf install git` |
| Amazon Linux 2 / 2023 | `yum install git` / `dnf install git` |
| openSUSE, SLES | `zypper install git` |
| Arch, Manjaro | `pacman -S git` |
| Alpine and other musl distributions | `apk add git` |
| Void, Gentoo, Mageia, NixOS | `xbps-install git`, `emerge --ask --verbose dev-vcs/git`, `urpmi git`, `nix-env -i git` |
| Termux, FreeBSD, OpenBSD, illumos | `pkg install git`, `pkg install git`, `pkg_add git`, `pkg install developer/versioning/git` |

Run Linux package-manager commands as root. See [git-scm.com/downloads](https://git-scm.com/downloads) for other systems.

**HTTPS certificates with portable Git:**
- **Linux:** Uses its bundled CA file (override with `GIT_SSL_CAINFO`, which takes precedence over `http.sslCAInfo` while set). HTTPS clones/fetches require system `libcurl` (for example `apt install libcurl4`); local operations do not.
- **macOS:** Uses system certificate trust.
- **Windows:** Uses the Windows certificate store.

### Alpine and musl Linux archives

The shell installer detects Alpine and downloads `atomic-linux-x64-musl.tar.gz` or `atomic-linux-arm64-musl.tar.gz`. Keep the complete archive, including payload-local `libgcc` and `libstdc++`; stock Alpine needs no runtime package install.

**Clipboard support:**
- Install `wl-clipboard` (Wayland), `xclip` or `xsel` (X11), or the Termux:API app + `termux-api` package (Termux).
- OSC 52 forwards clipboard writes over SSH, Mosh, or Rex and acts as a fallback on headless Linux. Set `ATOMIC_CLIPBOARD_OSC52=1` (legacy alias `PI_CLIPBOARD_OSC52=1`) to force terminal forwarding; your terminal must support OSC 52 and forwarding cannot verify the local write.

Start Atomic in your project directory:

```bash
cd /path/to/project
atomic
```

### Updating while Intercom is running

Sessions on one machine share a single Intercom broker process. Both the release-archive installers and `atomic update` finish by running `atomic intercom upgrade` with the newly installed binary:

- If no sessions are connected, the older broker stops and the next session starts the new one.
- If sessions are still connected, they are not interrupted; the next session started on the new version takes over the broker.

Installing an older release with `--ref`/`-Ref` skips this step silently if that version lacks `atomic intercom upgrade`. `atomic update` skips it with a note if `atomic` on `PATH` points to a different binary than the one updated. If the step fails, the install still succeeds with a warning.

You can run `atomic intercom upgrade` manually anytime (it is idempotent), and you should run it after upgrading via a package manager such as `npm install -g`.

## Uninstall

**Release archive:**
- **macOS / Linux:** delete `~/.local/share/atomic` and `~/.local/bin/atomic`.
- **Windows:** delete `%LOCALAPPDATA%\atomic`. If you set `ATOMIC_BIN_DIR`, also remove `atomic.cmd` and the `atomic-current` junction from that directory, then remove it from User PATH.

**Package manager:**

```bash
npm uninstall -g @bastani/atomic
# or: pnpm remove -g @bastani/atomic
# or: bun remove -g @bastani/atomic
```

Uninstalling removes only the CLI. Your config, credentials, sessions, and installed packages remain in `~/.atomic/agent/` until you delete that directory.

## Verify the install

```bash
atomic --version
```

You should see a single version line (for example `0.9.14-alpha.2`). If your shell reports `command not found`, open a new shell or add the installer's bin directory to `PATH`.

## Next step

Continue to [Authentication](/getting-started/authentication).
