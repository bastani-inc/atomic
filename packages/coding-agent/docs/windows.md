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

The installer verifies `SHA256SUMS` before changing an existing install. It stores versioned payloads under `%LOCALAPPDATA%\atomic` and places an ASCII-only `atomic.cmd` plus an `atomic-current` junction in `%LOCALAPPDATA%\atomic\bin` by default. The relative shim remains safe when the install path contains Unicode text or the bin directory is elsewhere. Set `ATOMIC_INSTALL_DIR`, `ATOMIC_BIN_DIR`, or `ATOMIC_VERSION` to override those values. `GITHUB_TOKEN` or `GH_TOKEN` is optional for higher GitHub API limits. Exact pins use Atomic's `MAJOR.MINOR.PATCH` or `MAJOR.MINOR.PATCH-alpha.REVISION` release tag form.

Every attempt removes its own `atomic-install-*` staging directory under the Windows temp path before it finishes. Windows can hold a file or an executable image open briefly after the process that used it exits, so the installer clears read-only attributes, retries the removal a bounded number of times, and verifies the directory is gone after each try. If it still cannot remove the directory, it reports the exact path, the number of attempts, and the last Windows error instead of leaving the residue unmentioned. A cleanup failure never replaces the original error: when an install fails for another reason, that error is still the one you see and the incomplete cleanup is reported as a warning.

After the script is fetched, it enables TLS 1.2 for its own GitHub requests and restores the caller's prior protocol setting. A downloaded script cannot repair the connection used to fetch itself: on a legacy Windows PowerShell 5.1 host where the literal `irm` command cannot reach GitHub, enable TLS 1.2 in that shell before rerunning the same one-liner.

The installer adds the bin directory to the User PATH and the current PowerShell process. Restart the terminal when it finishes so other processes see the new PATH. A custom `ATOMIC_BIN_DIR` containing `;` cannot be one Windows PATH entry, so the installer leaves PATH untouched and prints a direct-run command for `atomic.cmd` instead. If the bin directory already holds a same-stem launcher that `PATHEXT` resolves before `atomic.cmd`, such as a stale `atomic.exe` from an older Node-based install, the installer reports it and stops before downloading anything; remove that entry and rerun. Because the shim is `atomic.cmd`, `PATHEXT` must include `.CMD` for bare `atomic` to resolve; if it does not, the installer says so and stops rather than reporting a success you could not use. An unexpected regular `current` entry under `ATOMIC_INSTALL_DIR`, or a regular `atomic-current` entry under `ATOMIC_BIN_DIR`, is reported and left untouched instead of being moved or deleted. A pinned `-Ref` is honored literally: if GitHub answers with a different release tag, the install stops before downloading anything. Package-manager installation remains available but requires Node.js; see the [Quickstart](/quickstart#package-managers).

By default, Atomic uses a Bash shell for the `bash` tool and `!`/`!!` shortcuts. If you use those surfaces, Atomic checks these locations in order:

1. Custom path from `~/.atomic/agent/settings.json` (legacy `~/.pi/agent/settings.json` also supported)
2. Git Bash (`C:\Program Files\Git\bin\bash.exe`)
3. `bash.exe` on PATH (Cygwin, MSYS2, WSL)

For users who want the default Bash surfaces, [Git for Windows](https://git-scm.com/download/win) is sufficient. Native Windows users can instead enable the optional PowerShell tool described below; `!`/`!!` remain Bash-only.

## Custom Shell Path

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```

Paths copied from Git Bash, MSYS2, Cygwin, or WSL are accepted anywhere Atomic resolves a file path. For example, `/c/Users/name/project/file.ts`, `/cygdrive/c/Users/name/project/file.ts`, and `/mnt/c/Users/name/project/file.ts` resolve as the matching Windows drive path.

## Filesystem Watchers

On Windows, Atomic canonicalizes paths before starting native filesystem watchers. If a watcher target cannot be canonicalized or still contains an unsafe 8.3 short-name component such as `USERNA~1`, Atomic avoids native `fs.watch` for that target and uses polling where the feature supports it. This protects long-running sessions, footer git status refreshes, and custom theme reloads from Windows/libuv path-prefix assertion crashes.

## Self-Update Behavior

`atomic update --self` can update Windows installations that Atomic can identify as writable global package-manager installs. `atomic update` includes the same self-update step before updating packages unless you pass `--extensions`.

When self-update starts on Windows, Atomic first cleans any previous `.atomic-native-quarantine` directory under the global package root. If native add-ons from the current install are loaded by the running process, Atomic moves those files into a per-run quarantine directory and copies them back into place before invoking the package manager. This lets the package manager replace native dependency files that Windows would otherwise keep locked.

If Atomic cannot safely self-update the current installation, it exits with a clear message instead of guessing. The message explains that the install is unsupported, unmanaged, or not writable; prints the detected executable path when available; and tells you to update Atomic with the package manager, wrapper, source checkout, or release artifact that originally installed it. Archive installs are not managed by `atomic update`; rerun the PowerShell installer to replace `current` with the requested release. Standalone Bun binaries direct users to the current [Atomic releases](https://github.com/bastani-inc/atomic/releases/latest), never upstream Pi artifacts.

### PowerShell tool

On native Windows, Atomic registers the `powershell` tool by default when PowerShell 7 (`pwsh.exe`) or Windows PowerShell (`powershell.exe`) is on `PATH`. If neither executable is available, the tool is omitted so the agent is not offered a command that cannot run. Add `powershell` to `defaultTools` to enable it explicitly when you want it active alongside a narrower built-in selection. The `bash` tool and `!`/`!!` shortcuts continue to use Bash. Both `ATOMIC_*` and legacy `PI_*` session variables are available.

PowerShell calls are rendered in the transcript with a `PS>` prompt so they are never mistaken for Bash, and truncated PowerShell output is spilled to its own `atomic-powershell-*` temp file rather than the Bash one.

The package root exports `createPowerShellTool()`, `createPowerShellToolDefinition()`, `createLocalPowerShellOperations()`, their public option/input/detail types, and `getPowerShellConfig()` for SDK integrations. Factory-created tools expose the current `ATOMIC_*` and legacy `PI_*` session snapshot by default; set `exposeSessionEnvironment: false` to opt out. Executing the default local operations remains Windows-only and requires a resolvable PowerShell executable.
