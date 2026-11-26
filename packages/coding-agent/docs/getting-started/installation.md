---
title: "Install Atomic"
sidebarTitle: "Installation"
description: "Install Atomic with a package manager or standalone release archive, verify your setup, configure Git, and uninstall cleanly."
---

**Outcome:** `atomic` is on your `PATH` and `atomic --version` prints a version.

**Prerequisites:** A supported shell. See [Prerequisites](/quickstart#prerequisites).

## Package managers

Install globally with npm, pnpm, or Bun (requires [Node.js 24.20.0 or newer](#nodejs-version), or Bun 1.4.2+ for Bun installs):

```bash
npm install -g @bastani/atomic
# or: pnpm add -g @bastani/atomic
# or: bun add -g @bastani/atomic
```

- Atomic does not require package install scripts; pass `--ignore-scripts` if you disable lifecycle scripts.
- Package managers select the matching platform native package (`@bastani/atomic-natives-<platform>`) automatically.
- Sessions save locally in `~/.atomic/workflows/journal.sqlite` with no database server needed. To share sessions across machines, see [Sharing storage across hosts](/storage#sharing-storage-across-hosts).

### Node.js version

Package-manager installs need Node.js 24 LTS, version 24.20.0 or newer. The [release archive](#release-archive) bundles its own runtime and needs no Node.js.

- **Why 24.20.0:** Node.js releases before 24.15.0 bundle a SQLite version with a bug that can corrupt Atomic's session database ([SQLite WAL-reset bug](https://www.sqlite.org/wal.html#walresetbug)). Node.js 24.17.0 through 24.19.0 reject valid certificates for IPv6 addresses such as an `https://[::1]` proxy ([nodejs/node#64145](https://github.com/nodejs/node/pull/64145)); 24.20.0 fixes both.
- **Check your version:** Run `node --version`. It must print `v24.20.0` or a later `v24` release, or a newer major version.
- **Upgrade:** Install the current Node.js 24 LTS release from [nodejs.org](https://nodejs.org/en/download), or with a version manager: `nvm install 24`, `fnm install 24`, or `mise use -g node@24`. Then reinstall Atomic with `npm install -g @bastani/atomic` so it runs on the new Node.js.

### Package manager troubleshooting

- **Optional native packages:** Do not omit optional dependencies (`npm install --omit=optional`, `pnpm install --no-optional`, or `bun install --omit=optional`) in a project. Without your platform's native package, Atomic stops at startup with an error naming the missing package; reinstall without those flags to fix it. Global npm installs still pull transitive optional native packages even with `--omit=optional`.
- **Dependency resolution:** Atomic pins its direct dependencies to exact versions and does not bundle a lockfile, so your package manager resolves sub-dependencies at install time. Use the [release archive](#release-archive) if you want the exact dependency tree the release was tested with.
- **Older Linux lockfiles:** On Linux, `npm ci` from an older project lockfile that omits C-library tags can install both the glibc and musl native packages. Atomic loads the matching one automatically.
- **Mismatched native module after an update:** Atomic stops if its native module comes from a different release. If you updated Atomic while it was running, restart it. Otherwise reinstall to repair the installation. A long-running SDK program that stopped this way keeps refusing new sessions until restarted. This version check applies to packaged releases and skips standalone binaries, source checkouts, `NAPI_RS_NATIVE_LIBRARY_PATH` overrides, and apps that bundle the SDK without pinning `@bastani/atomic-natives`.

## Release archive

Install the self-contained release archive without Node.js or a package manager:

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/bastani-inc/atomic/main/install.sh | sh
```

```powershell
# Windows PowerShell
irm https://raw.githubusercontent.com/bastani-inc/atomic/main/install.ps1 | iex
```

The installer fetches the matching GitHub Release archive and `SHA256SUMS`, verifies the SHA-256 checksum, and installs into a versioned directory. Keep the archive's complete directory (`node_modules`, libraries, and licenses) intact.

| Platform | Default payload directory | Default launcher | PATH behavior |
| --- | --- | --- | --- |
| macOS / Linux | `~/.local/share/atomic` | `~/.local/bin/atomic` | Never edits shell rc files; prints a paste-safe `export PATH=...` (or `fish_add_path`) command if missing |
| Windows | `%LOCALAPPDATA%\atomic` | `<ATOMIC_INSTALL_DIR>\bin\atomic.cmd` (default `%LOCALAPPDATA%\atomic\bin\atomic.cmd`) | Adds the bin directory to User PATH when missing and tells you to open a new terminal |

### Installer options and reruns

Customize the archive installer with flags or environment variables:

| Option or variable | Behavior |
| --- | --- |
| `ATOMIC_VERSION`, `--ref <tag>`, `-r <tag>`, `--ref=<tag>` (Unix), `-Ref <tag>` (Windows) | Pin an exact release tag (`MAJOR.MINOR.PATCH` or `MAJOR.MINOR.PATCH-alpha.REVISION`). CLI flags override `ATOMIC_VERSION`. Pins are honored literally; if GitHub returns a different tag, the installer aborts before downloading. |
| `ATOMIC_INSTALL_DIR` | Override the versioned payload root (default `~/.local/share/atomic` on macOS/Linux, `%LOCALAPPDATA%\atomic` on Windows). Relative paths resolve against the directory where the installer starts. The install root cannot equal or sit inside the launcher path. |
| `ATOMIC_BIN_DIR` | Override the launcher directory. Defaults to `~/.local/bin` on macOS/Linux (stays `~/.local/bin` even if `ATOMIC_INSTALL_DIR` changes) and `<ATOMIC_INSTALL_DIR>\bin` on Windows. Cannot sit inside the install root's `current` or `versions` directories. Paths containing `:` on Unix or `;` on Windows cannot be added as one `PATH` entry, so the installer prints direct-run instructions instead. |
| `ATOMIC_FORCE_INSTALL=1`, `--force` (Unix), `-Force` (Windows) | Force a reinstall even when the target version is already installed and healthy. Only exact `"1"` enables `ATOMIC_FORCE_INSTALL` (`true` and `yes` do not). |
| `GITHUB_TOKEN`, `GH_TOKEN` | Optional token for authenticated GitHub API fallback if rate-limited (60 unauthenticated requests/hour per IP). `GITHUB_TOKEN` takes precedence over `GH_TOKEN`. `curl` and GNU `wget` pass the token through a protected temporary file rather than process arguments; BusyBox `wget` works without a token or when redirects avoid the API. |
| `NO_COLOR` | Any value (including an empty string) switches installer output to plain text without color or progress bars. Plain mode also activates automatically when stdout is not a TTY, `CI` is set, or Unix `TERM` is unset or `dumb`. |
| `ATOMIC_INSTALL_LOCK_TIMEOUT` | Seconds a concurrent installer waits for another install into the same directory before failing (default `1800`, 30 minutes). |

Pin a version:

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/bastani-inc/atomic/main/install.sh | sh -s -- --ref 0.9.11
```

```powershell
# Windows PowerShell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/bastani-inc/atomic/main/install.ps1))) -Ref 0.9.11
```

Force a reinstall:

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/bastani-inc/atomic/main/install.sh | sh -s -- --force
curl -fsSL https://raw.githubusercontent.com/bastani-inc/atomic/main/install.sh | ATOMIC_FORCE_INSTALL=1 sh
```

```powershell
# Windows PowerShell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/bastani-inc/atomic/main/install.ps1))) -Force
$env:ATOMIC_FORCE_INSTALL = "1"; irm https://raw.githubusercontent.com/bastani-inc/atomic/main/install.ps1 | iex
```

**Reruns and atomic switches:** If the target version is already installed and healthy, the installer skips downloading, prints the install path and `PATH` guidance, and exits `0`. Pinned reruns make no network request; unpinned reruns check for the latest tag. Health checks verify that `current` points to the target version inside the install root, the launcher matches and resolves to `current`, and the core runtime files and bundled packages are intact (on Windows, `current\atomic.exe --version` must match and a missing User PATH entry is restored). Any missing or corrupted piece triggers a repair install. The previous version stays usable until the final switch, and a killed installer releases its lock so the next run cleans up partial files.

### Alpine and musl Linux archives

The shell installer detects Alpine and downloads `atomic-linux-x64-musl.tar.gz` or `atomic-linux-arm64-musl.tar.gz`. Keep the complete archive, including bundled `libgcc` and `libstdc++`; stock Alpine needs no runtime package install.

**Clipboard support:**

- Install `wl-clipboard` (Wayland), `xclip` or `xsel` (X11), or the Termux:API app plus `termux-api` package (Termux).
- OSC 52 forwards clipboard writes over SSH, Mosh, or Rex and acts as a fallback on headless Linux. Set `ATOMIC_CLIPBOARD_OSC52=1` (legacy alias `PI_CLIPBOARD_OSC52=1`) to force terminal forwarding; your terminal must support OSC 52, and forwarding cannot verify the local write.

## Verify the install

```bash
atomic --version
```

You should see a single version line (for example `0.10.5`). If your shell reports `command not found`, open a new shell or add the installer's bin directory to `PATH`.

## Which runtime runs Atomic

Package-manager installs run on Node.js (`#!/usr/bin/env node`), including global installs created with `bun add -g` unless you explicitly run with Bun (`--bun`). Standalone release archives run on Bun. Installing Bun separately does not switch an npm install to Bun. [Codemode scripts](/codemode) always run inside a sandboxed JavaScript VM with no direct Node or Bun APIs.

Both runtimes use the same SQLite version for local storage. Node.js includes its own copy of SQLite. On macOS, Bun would otherwise use the SQLite that comes with macOS, whose version depends on your macOS release, so the macOS release archives include their own copy, in `lib/libsqlite3.dylib`. You don't need to do anything. `atomic storage status` shows the version in use on its `library:` line. If that copy can't be loaded, Atomic prints one warning and uses the system's SQLite instead.

## Git

Atomic requires Git 2.30.0 or newer for worktrees, git packages, and the footer branch display. It uses the first `git` found in an absolute `PATH` directory (never the working directory) if that binary reports 2.30.0 or newer. Otherwise, Atomic downloads a verified portable Git (pinned to Git 2.56.0 from [desktop/dugite-native](https://github.com/desktop/dugite-native)), just as it does for `fd` and `rg`.

Newer Git versions unlock two extra behaviors: Git 2.33+ is required for SDK workspace bindings and immediate error detection when creating a named subagent worktree is interrupted, and Git 2.36+ supports restoring worktree snapshots whose paths contain line breaks.

- **Location:** `~/.atomic/agent/bin/git/` (or under `ATOMIC_CODING_AGENT_DIR`).
- **When:** Downloaded at interactive startup or on the first git package install or update. Run `/tools` to check which Git Atomic uses and why.
- **Verification:** Pinned to one release and verified against a built-in SHA-256 checksum; mismatched downloads are discarded.
- **Updates:** When a new Atomic version pins a newer Git release, the next online start switches to it while running commands finish on the older copy. Offline or after a failed download, the cached copy continues working and `/tools` notes the reason.
- **Supported platforms:** macOS (x64, arm64), Linux with glibc 2.34+ (x64, arm64, armv7), and Windows (x64, arm64, x86).
- **Agent shells:** If no `git` is on `PATH`, the `bash` tool prepends portable Git so agents can run `git`. If an older system `git` is on `PATH`, your shells keep it while Atomic uses portable Git internally.
- **Offline mode:** `ATOMIC_OFFLINE=1` prevents downloads; an already-cached portable Git still works.
- **Cache cleanup:** Older portable releases stay cached while running commands may use them. Close running Atomic sessions before deleting `~/.atomic/agent/bin/git/`. The next online startup downloads Git again; until then, offline use needs a system Git.

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

- **Linux:** Uses its bundled CA file (override with `GIT_SSL_CAINFO`, which takes precedence over `http.sslCAInfo` while set). HTTPS clones and fetches require system `libcurl` (for example `apt install libcurl4`); local operations do not.
- **macOS:** Uses system certificate trust.
- **Windows:** Uses the Windows certificate store.

## Updating while Intercom is running

Sessions on one machine share a single Intercom broker process. Both the release-archive installers and `atomic update` finish by running `atomic intercom upgrade` with the newly installed binary:

- If no sessions are connected, the older broker stops and the next session starts the new one.
- If sessions are still connected, they are not interrupted; the next session started on the new version takes over the broker.

Installing an older release with `--ref` or `-Ref` skips this step silently if that version lacks `atomic intercom upgrade`. `atomic update` skips it with a note if `atomic` on `PATH` points to a different binary than the one updated. If the step fails, the install still succeeds with a warning.

You can run `atomic intercom upgrade` manually anytime (it is idempotent), and you should run it after upgrading via a package manager such as `npm install -g`.

**Windows npm upgrades from 0.10.4 or earlier:** Earlier Intercom brokers locked files inside the npm installation folder, which can cause `npm install -g @bastani/atomic` to fail with `EBUSY` on Windows while an older broker is running. Close running Atomic sessions and wait 5 seconds (or run `atomic intercom restart`), then run `npm install -g @bastani/atomic`. From 0.10.5 onward, the broker runs outside the installation directory, so npm upgrades and uninstalls succeed while sessions and the broker run.

## Uninstall

**Release archive:**

- **macOS / Linux:** Delete `~/.local/share/atomic` and `~/.local/bin/atomic` (or your custom `ATOMIC_INSTALL_DIR` and `ATOMIC_BIN_DIR` launcher).
- **Windows:** Delete `%LOCALAPPDATA%\atomic`. If you set `ATOMIC_BIN_DIR`, also remove `atomic.cmd` and the `atomic-current` junction from that directory, then remove it from User PATH.

**Package manager:**

```bash
npm uninstall -g @bastani/atomic
# or: pnpm remove -g @bastani/atomic
# or: bun remove -g @bastani/atomic
```

Uninstalling removes only the CLI. Your config, credentials, and installed packages remain in `~/.atomic/agent/`, and your default SQLite sessions remain in `~/.atomic/workflows/journal.sqlite`, until you delete `~/.atomic/`.

## Next step

Continue to [Authenticate a provider](/getting-started/authentication).
