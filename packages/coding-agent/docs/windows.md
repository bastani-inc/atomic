# Windows Setup

## Install

Install the self-contained Windows release archive with Windows PowerShell 5.1 or newer:

```powershell
irm https://raw.githubusercontent.com/bastani-inc/atomic/main/install.ps1 | iex
```

This path does not require Node.js or a package manager. To pin an exact release:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/bastani-inc/atomic/main/install.ps1))) -Ref 0.9.11
```

The installer verifies `SHA256SUMS` before changing an existing install. It stores versioned payloads under `%LOCALAPPDATA%\atomic` and places `atomic.cmd` in `%LOCALAPPDATA%\atomic\bin` by default. Set `ATOMIC_INSTALL_DIR`, `ATOMIC_BIN_DIR`, or `ATOMIC_VERSION` to override those values. `GITHUB_TOKEN` or `GH_TOKEN` is optional for higher GitHub API limits.

The installer adds the bin directory to the User PATH and the current PowerShell process. Restart the terminal when it finishes so other processes see the new PATH. Package-manager installation remains available but requires Node.js; see the [Quickstart](/quickstart#package-managers).

After installation, Atomic requires a bash shell for its shell tool. Checked locations (in order):

1. Custom path from `~/.atomic/agent/settings.json` (legacy `~/.pi/agent/settings.json` also supported)
2. Git Bash (`C:\Program Files\Git\bin\bash.exe`)
3. `bash.exe` on PATH (Cygwin, MSYS2, WSL)

For most users, [Git for Windows](https://git-scm.com/download/win) is sufficient.

## Custom Shell Path

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```

## Filesystem Watchers

On Windows, Atomic canonicalizes paths before starting native filesystem watchers. If a watcher target cannot be canonicalized or still contains an unsafe 8.3 short-name component such as `USERNA~1`, Atomic avoids native `fs.watch` for that target and uses polling where the feature supports it. This protects long-running sessions, async subagent result notifications, footer git status refreshes, and custom theme reloads from Windows/libuv path-prefix assertion crashes.

## Self-Update Behavior

`atomic update --self` can update Windows installations that Atomic can identify as writable global package-manager installs. `atomic update` includes the same self-update step before updating packages unless you pass `--extensions`.

When self-update starts on Windows, Atomic first cleans any previous `.atomic-native-quarantine` directory under the global package root. If native add-ons from the current install are loaded by the running process, Atomic moves those files into a per-run quarantine directory and copies them back into place before invoking the package manager. This lets the package manager replace native dependency files that Windows would otherwise keep locked.

If Atomic cannot safely self-update the current installation, it exits with a clear message instead of guessing. The message explains that the install is unsupported, unmanaged, or not writable; prints the detected executable path when available; and tells you to update Atomic with the package manager, wrapper, source checkout, or release artifact that originally installed it. Archive installs are not managed by `atomic update`; rerun the PowerShell installer to replace `current` with the requested release. Standalone Bun binaries direct users to the current [Atomic releases](https://github.com/bastani-inc/atomic/releases/latest), never upstream Pi artifacts.
