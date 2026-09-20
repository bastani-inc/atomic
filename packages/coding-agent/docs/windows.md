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

The installer verifies `SHA256SUMS` before changing an existing install. By default, it stores versioned payloads under `%LOCALAPPDATA%\atomic` and places an ASCII-only `atomic.cmd` plus an `atomic-current` junction in `%LOCALAPPDATA%\atomic\bin`. The relative shim supports Unicode install paths and a bin directory elsewhere.

Set `ATOMIC_INSTALL_DIR`, `ATOMIC_BIN_DIR`, or `ATOMIC_VERSION` to override those values. `GITHUB_TOKEN` or `GH_TOKEN` is optional for higher GitHub API limits. Exact pins use Atomic's `MAJOR.MINOR.PATCH` or `MAJOR.MINOR.PATCH-alpha.REVISION` release tag form.

The installer removes its `atomic-install-*` staging directory before finishing. If cleanup fails, it reports the path and Windows error. An installation failure remains the primary error; incomplete cleanup appears as a warning.

After the script is fetched, it enables TLS 1.2 for its own GitHub requests and restores the caller's prior protocol setting. A downloaded script cannot repair the connection used to fetch itself: on a legacy Windows PowerShell 5.1 host where the literal `irm` command cannot reach GitHub, enable TLS 1.2 in that shell before rerunning the same one-liner.

While it runs, the installer prints the release and platform, a live download progress bar with the percentage and megabytes received, one-line phase confirmations, the Atomic logo in Windows Terminal, and a `To start:` block. It then prints `Installed to <path>` and adds the bin directory to the User PATH and the current PowerShell process; when it changed the User PATH it says so and asks you to open a new terminal so other processes see the new PATH. Set `NO_COLOR=1` for plain text without colours, the progress bar, or the logo; output is also plain when `CI` is set or standard output is redirected. Legacy console windows outside Windows Terminal draw the bar with `#` and `-` and skip the logo.

Check these installation constraints:

- A custom `ATOMIC_BIN_DIR` containing `;` cannot be one Windows PATH entry. The installer leaves PATH untouched and prints a direct-run command for `atomic.cmd` instead.
- A same-stem launcher that `PATHEXT` resolves before `atomic.cmd`, such as a stale `atomic.exe`, stops installation before download. Remove that entry and rerun.
- `PATHEXT` must include `.CMD` for bare `atomic` to resolve. Otherwise, the installer reports the problem and stops.
- An unexpected regular `current` entry under `ATOMIC_INSTALL_DIR`, or regular `atomic-current` entry under `ATOMIC_BIN_DIR`, is reported and left untouched instead of being moved or deleted.
- A pinned `-Ref` is honored literally. If GitHub returns a different release tag, installation stops before download.

Package-manager installation remains available but requires Node.js; see the [Quickstart](/getting-started/installation#package-managers).

Atomic uses a Bash shell for the `bash` tool. For that tool, Atomic checks these locations in order:

1. Custom path from `~/.atomic/agent/settings.json` (legacy `~/.pi/agent/settings.json` also supported)
2. Git Bash (`C:\Program Files\Git\bin\bash.exe`)
3. `bash.exe` on PATH (Cygwin, MSYS2, WSL)

For the Bash tool, [Git for Windows](https://git-scm.com/download/win) is sufficient. Native Windows `!`/`!!` shortcuts instead use PowerShell, preferring `pwsh.exe` and falling back to `powershell.exe` on `PATH`. They do not use `shellPath`; any `shellCommandPrefix` must use PowerShell syntax. WSL remains Bash-based.

## Custom Shell Path

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```

Paths copied from Git Bash, MSYS2, Cygwin, or WSL are accepted anywhere Atomic resolves a file path. For example, `/c/Users/name/project/file.ts`, `/cygdrive/c/Users/name/project/file.ts`, and `/mnt/c/Users/name/project/file.ts` resolve as the matching Windows drive path.

## Interactive Startup

You can type while Atomic finishes startup. Submitting shows the working indicator; Escape cancels a submission still waiting for resources. If loading fails before the prompt is sent, Atomic restores your exact draft and sends no provider request. Use `/reload` to retry resource loading.

## Filesystem Watchers

Atomic uses polling where supported when a Windows path cannot be watched safely. Theme reloads and Git status updates may therefore arrive through polling rather than native filesystem notifications.

## Self-Update Behavior

`atomic update --self` can update Windows installations that Atomic can identify as writable global package-manager installs. `atomic update` includes the same self-update step before updating packages unless you pass `--extensions`.

Atomic handles loaded native add-ons during package-manager self-update so Windows file locks do not prevent their replacement.

If Atomic cannot safely self-update the current installation, it exits with a clear message instead of guessing. The message explains that the install is unsupported, unmanaged, or not writable; prints the detected executable path when available; and tells you to update Atomic with the package manager, wrapper, source checkout, or release artifact that originally installed it. Archive installs are not managed by `atomic update`; rerun the PowerShell installer to replace `current` with the requested release. Standalone Bun binaries direct users to the current [Atomic releases](https://github.com/bastani-inc/atomic/releases/latest), never upstream Pi artifacts.

### PowerShell tool

On native Windows, Atomic registers the `powershell` tool by default when PowerShell 7 (`pwsh.exe`) or Windows PowerShell (`powershell.exe`) is on `PATH`. If neither executable is available, the tool is omitted so the agent is not offered a command that cannot run. Add `powershell` to `defaultTools` to enable it explicitly when you want it active alongside a narrower built-in selection. The `bash` tool continues to use Bash; `!`/`!!` use PowerShell. Both `ATOMIC_*` and legacy `PI_*` session variables are available.

PowerShell calls are rendered in the transcript with a `PS>` prompt so they are never mistaken for Bash, and truncated PowerShell output is spilled to its own `atomic-powershell-*` temp file rather than the Bash one.

The package root exports `createPowerShellTool()`, `createPowerShellToolDefinition()`, `createLocalPowerShellOperations()`, their public option/input/detail types, and `getPowerShellConfig()` for SDK integrations. Factory-created tools expose the current `ATOMIC_*` and legacy `PI_*` session snapshot by default; set `exposeSessionEnvironment: false` to opt out. Executing the default local operations remains Windows-only and requires a resolvable PowerShell executable.
