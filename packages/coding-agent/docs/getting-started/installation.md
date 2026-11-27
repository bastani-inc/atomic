---
title: "Install Atomic"
sidebarTitle: "Install Atomic"
description: "Install Atomic with a package manager or standalone release archive, verify your setup, configure Git, and uninstall cleanly."
---

**Outcome:** `atomic` is on your `PATH` and `atomic --version` prints the installed version.

**Prerequisites:** A supported shell. See [Prerequisites](/quickstart#prerequisites).

| How you want to install | Best choice | Runtime requirement |
| --- | --- | --- |
| Global CLI via npm, pnpm, or Bun | [Package managers](#package-managers) | [Node.js 24.20.0+](#nodejs-version) (or `bun --bun` with Bun 1.4.5+) |
| Zero-dependency install with pinned runtime | [Release archive](#release-archive) | None (bundles its own runtime) |

## Package managers

Install globally with npm, pnpm, or Bun:

<Tabs>
  <Tab title="npm">
    ```bash
    npm install -g @bastani/atomic
    ```
  </Tab>
  <Tab title="pnpm">
    ```bash
    pnpm add -g @bastani/atomic
    ```
  </Tab>
  <Tab title="Bun">
    ```bash
    bun add -g @bastani/atomic
    ```
  </Tab>
</Tabs>

- **Runtime requirement:** All package-manager installs—**including `bun add -g @bastani/atomic`**—run on [Node.js 24.20.0 or newer](#nodejs-version) by default. Running a package-manager install on Bun requires launching explicitly with `bun --bun` and **Bun 1.4.5+**.
- **No install scripts required:** Pass `--ignore-scripts` if your environment disables npm lifecycle scripts.
- **Native bindings:** Your package manager selects the matching platform package (`@bastani/atomic-natives-<platform>`) automatically.
- **Local storage by default:** Sessions save in `~/.atomic/workflows/journal.sqlite` with no database server needed. To share sessions across machines, see [Sharing storage across hosts](/storage#sharing-storage-across-hosts).

### Node.js version

Package-manager installs require **Node.js 24 LTS, version 24.20.0 or newer**. If you cannot upgrade Node.js right away, use the [release archive](#release-archive), which bundles its own runtime.

<Note>
Node.js 24.20.0 fixes both an upstream SQLite WAL-reset bug that could corrupt Atomic's session database on releases earlier than 24.15.0 and an IPv6 TLS proxy bug affecting 24.17.0 through 24.19.0.
</Note>

- **Check your version:** Run `node --version`. It must print `v24.20.0` or a later `v24` release (or a newer major version).
- **On an older Node.js:** `atomic` stops at startup with `Atomic needs Node.js 24.20.0 or newer, but this is Node.js <version>.` and links back to this section.
- **Upgrade:** Install the current Node.js 24 LTS release from [nodejs.org](https://nodejs.org/en/download), or with a version manager (`nvm install 24`, `fnm install 24`, or `mise use -g node@24`), then reinstall Atomic with `npm install -g @bastani/atomic`.

### Package manager troubleshooting

- **Optional native packages:** Do not disable optional dependencies (`npm install --omit=optional`, `pnpm install --no-optional`, or `bun install --omit=optional`) in a project. Without your platform's native package, Atomic stops at startup naming the missing package; reinstall without those flags to fix it. (Global `npm install -g` still pulls transitive optional native packages even with `--omit=optional`.)
- **Dependency resolution:** Atomic pins its direct dependencies to exact versions while your package manager resolves sub-dependencies at install time. Use the [release archive](#release-archive) if you want the exact tested dependency tree.
- **Older Linux lockfiles:** On Linux, `npm ci` from an older lockfile lacking C-library tags can install both glibc and musl native packages; Atomic loads the matching one automatically.
- **Mismatched native module after an update:** Atomic refuses to start if its native module comes from a different release. If you updated Atomic while it was running, restart it; otherwise reinstall to repair the installation. For local native-binding diagnostics and overrides, see [Diagnostics and debugging](/development).

## Release archive

Install the self-contained release archive without Node.js or a package manager:

<Tabs>
  <Tab title="macOS / Linux">
    ```bash
    curl -fsSL https://raw.githubusercontent.com/bastani-inc/atomic/main/install.sh | sh
    ```
  </Tab>
  <Tab title="Windows PowerShell">
    ```powershell
    irm https://raw.githubusercontent.com/bastani-inc/atomic/main/install.ps1 | iex
    ```
  </Tab>
</Tabs>

The installer downloads the matching GitHub Release archive and `SHA256SUMS`, verifies the SHA-256 checksum, and installs into a versioned directory. Keep the installed directory (`node_modules`, libraries, and licenses) intact.

| Platform | Default payload directory | Default launcher | PATH behavior |
| --- | --- | --- | --- |
| macOS / Linux | `~/.local/share/atomic` | `~/.local/bin/atomic` | Never edits shell rc files; prints a paste-safe `export PATH=...` (or `fish_add_path`) command if missing. |
| Windows | `%LOCALAPPDATA%\atomic` | `<ATOMIC_INSTALL_DIR>\bin\atomic.cmd` (default `%LOCALAPPDATA%\atomic\bin\atomic.cmd`) | Adds the bin directory to User PATH if missing and prompts you to open a new terminal. |

<Accordion title="Archive installer options, version pinning, and reruns">

Customize the installer with CLI flags or environment variables:

| Option or variable | Behavior |
| --- | --- |
| `ATOMIC_VERSION`, `--ref <tag>`, `-r <tag>`, `--ref=<tag>` (Unix), `-Ref <tag>` (Windows) | Pin an exact release tag (`MAJOR.MINOR.PATCH` or `MAJOR.MINOR.PATCH-alpha.REVISION`). CLI flags override `ATOMIC_VERSION`; if GitHub returns a different tag, the installer aborts before downloading. |
| `ATOMIC_INSTALL_DIR` | Override the payload root (default `~/.local/share/atomic` on macOS/Linux, `%LOCALAPPDATA%\atomic` on Windows). Relative paths resolve from the starting directory. Cannot equal or sit inside the launcher path. |
| `ATOMIC_BIN_DIR` | Override the launcher directory. Defaults to `~/.local/bin` on macOS/Linux (unchanged if `ATOMIC_INSTALL_DIR` changes) and `<ATOMIC_INSTALL_DIR>\bin` on Windows. Cannot sit inside `current` or `versions`. Paths containing `:` (Unix) or `;` (Windows) cannot be added as a single `PATH` entry, so the installer prints direct-run instructions instead. |
| `ATOMIC_FORCE_INSTALL=1`, `--force` (Unix), `-Force` (Windows) | Force a reinstall even when the target version is already installed and healthy. Only exact `"1"` enables `ATOMIC_FORCE_INSTALL` (`true` and `yes` do not). |
| `GITHUB_TOKEN`, `GH_TOKEN` | Optional token for authenticated GitHub API fallback if rate-limited (`GITHUB_TOKEN` takes precedence over `GH_TOKEN`). `curl` and GNU `wget` pass the token through a protected temporary file rather than process arguments; BusyBox `wget` works without a token or when redirects bypass the API. |
| `NO_COLOR` | Any value (including an empty string) switches output to plain text without color or progress bars. Plain mode also activates when stdout is not a TTY, `CI` is set, or Unix `TERM` is unset or `dumb`. |
| `ATOMIC_INSTALL_LOCK_TIMEOUT` | Seconds a concurrent installer waits for another install into the same directory before failing (default `1800`, 30 minutes). |

Pin an exact version:

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/bastani-inc/atomic/main/install.sh | sh -s -- --ref 0.10.14
```

```powershell
# Windows PowerShell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/bastani-inc/atomic/main/install.ps1))) -Ref 0.10.14
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

**Reruns and atomic switches:** If the target version is already installed and healthy, the installer skips downloading, prints the install path and `PATH` guidance, and exits `0`. Pinned reruns make no network request; unpinned reruns check for the latest tag.

Health checks verify that `current` points to the target version inside the install root, the launcher resolves to `current`, and the core runtime files and bundled packages are intact. On Windows, existing-install checks inspect the `current` junction target, required payload files, the recorded `.atomic-launcher.sha256` hash, and `atomic.cmd` (without executing a potentially broken `atomic.exe`) and restore a missing User `PATH` entry; `--version` is checked on newly staged downloads before switching. Any missing or corrupted piece triggers a repair install while keeping the previous version usable until the final switch.

</Accordion>

### Alpine and musl Linux archives

The shell installer automatically detects Alpine (`/etc/alpine-release`) and downloads `atomic-linux-x64-musl.tar.gz` or `atomic-linux-arm64-musl.tar.gz`. Keep the complete archive intact—including its bundled `libgcc` and `libstdc++` libraries—so stock Alpine runs without extra C++ runtime packages.

## Verify the install

```bash
atomic --version
```

You should see a single version line (for example `0.10.14`). If your shell reports `command not found`, open a new terminal or add the installer's bin directory to your `PATH`.

<Tip>
**Linux, Termux, and SSH clipboard support:** To copy text from `/copy` or fullscreen selection on Linux or Termux, install `wl-clipboard` (Wayland), `xclip` or `xsel` (X11), or `termux-api` (Termux). Over SSH or headless Linux, Atomic automatically forwards clipboard writes via OSC 52. See [Clipboard and OSC 52](/terminal-setup#clipboard-and-osc-52).
</Tip>

## Which runtime runs Atomic

- **Package-manager installs** (`npm`, `pnpm`, and `bun add -g`) run on **Node.js** via `#!/usr/bin/env node` unless you explicitly launch with `bun --bun` (Bun 1.4.5+). Installing Bun separately does not switch an existing npm or pnpm install to Bun.
- **Standalone release archives** bundle and run on **Bun**.

Both runtimes ship an up-to-date, consistent SQLite library for local session storage (macOS release archives bundle their own SQLite copy so they do not depend on the macOS system SQLite). Run `atomic storage status` to inspect the active SQLite library version.

## Git

Atomic requires **Git 2.30.0 or newer** for worktrees, git packages, and the footer branch indicator. It uses the first `git` found in an absolute `PATH` directory (never the working directory) when that binary is 2.30.0+; otherwise it automatically downloads a SHA-256-verified portable Git into `~/.atomic/agent/bin/git/`.

- Run `/tools` inside Atomic to inspect which Git binary is active and why.
- Set `ATOMIC_OFFLINE=1` to disable automatic downloads (an already-cached portable Git still works).

<Accordion title="Install Git manually and platform notes">

- **Version capabilities:** Git 2.33+ enables SDK workspace bindings and immediate error detection when creating a named subagent worktree is interrupted; Git 2.36+ supports restoring worktree snapshots whose paths contain line breaks.
- **Portable Git platforms and behavior:** Available for macOS (x64, arm64), Linux with glibc 2.34+ (x64, arm64, armv7), and Windows (x64, arm64, x86). Downloaded at interactive startup or on the first git package install/update, and updated automatically when a new Atomic release pins a newer copy. If no `git` is on `PATH`, the `bash` tool prepends portable Git so agents can run `git`; if an older system `git` is on `PATH`, your shell keeps it while Atomic uses portable Git internally. Close running Atomic sessions before deleting `~/.atomic/agent/bin/git/`.
- **HTTPS certificates with portable Git:** Linux uses its bundled CA file (overridable with `GIT_SSL_CAINFO`, which takes precedence over `http.sslCAInfo`) and needs system `libcurl` (for example `apt install libcurl4`) for HTTPS clones/fetches; macOS uses system trust; Windows uses the Windows certificate store.

If no suitable Git is found and portable download is unavailable, install Git for your platform:

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

</Accordion>

## Updating while Intercom is running

Sessions on one machine share a single [Intercom](/intercom) broker process. Both the release-archive installers and `atomic update` finish by running `atomic intercom upgrade` with the newly installed binary:

- If no sessions are connected, the older broker stops and the next session starts the new one.
- If sessions are still connected, they are not interrupted; the next session launched on the new version takes over the broker.

You can run `atomic intercom upgrade` manually at any time (it is idempotent), and you should run it after upgrading directly via a package manager such as `npm install -g @bastani/atomic`. Pinning an older release without `atomic intercom upgrade` skips this step silently; `atomic update` skips it with a note if `atomic` on `PATH` points to a different binary than the one updated.

<Accordion title="Upgrading on Windows from 0.10.4 or earlier">

Earlier Intercom brokers (0.10.4 and earlier) locked files inside the npm installation folder, which can cause `npm install -g @bastani/atomic` to fail with `EBUSY` on Windows while an older broker is running. Close running Atomic sessions and wait 5 seconds (or run `atomic intercom restart`), then rerun `npm install -g @bastani/atomic`. From 0.10.5 onward, the broker runs outside the installation directory, so npm upgrades and uninstalls succeed while sessions and the broker run.

</Accordion>

## Uninstall

<Tabs>
  <Tab title="Package manager">
    ```bash
    npm uninstall -g @bastani/atomic
    # or: pnpm remove -g @bastani/atomic
    # or: bun remove -g @bastani/atomic
    ```
  </Tab>
  <Tab title="macOS / Linux archive">
    Delete `~/.local/share/atomic` and `~/.local/bin/atomic` (or your custom `ATOMIC_INSTALL_DIR` and `ATOMIC_BIN_DIR` launcher).
  </Tab>
  <Tab title="Windows archive">
    Delete `%LOCALAPPDATA%\atomic`. If you set `ATOMIC_BIN_DIR`, also remove `atomic.cmd` and the `atomic-current` junction from that directory, then remove it from User `PATH`.
  </Tab>
</Tabs>

Uninstalling removes only the CLI. Your settings, credentials, and installed packages remain in `~/.atomic/agent/`, and your default SQLite sessions remain in `~/.atomic/workflows/journal.sqlite`, until you delete `~/.atomic/`.

## Next step

Continue to [Authenticate a provider](/getting-started/authentication).
