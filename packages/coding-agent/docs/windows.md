---
title: "Windows"
description: "Install, configure, and troubleshoot Atomic on Windows and WSL."
---

# Windows setup

## Install

Install the self-contained Windows release archive with Windows PowerShell 5.1 or newer:

```powershell
irm https://raw.githubusercontent.com/bastani-inc/atomic/main/install.ps1 | iex
```

This path does not require Node.js or a package manager. To pin an exact release (`MAJOR.MINOR.PATCH` or `MAJOR.MINOR.PATCH-alpha.REVISION`):

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/bastani-inc/atomic/main/install.ps1))) -Ref 0.9.11
```

By default, the installer verifies `SHA256SUMS`, stores versioned payloads under `%LOCALAPPDATA%\atomic`, and places an ASCII-only `atomic.cmd` plus an `atomic-current` junction in `%LOCALAPPDATA%\atomic\bin`. The relative shim supports Unicode install paths and custom bin directories.

Override defaults with `ATOMIC_INSTALL_DIR`, `ATOMIC_BIN_DIR`, `ATOMIC_VERSION`, or optional `GITHUB_TOKEN`/`GH_TOKEN` (used only if release resolution falls back to the GitHub API). See [Installation](/getting-started/installation#release-archive) for cross-platform archive options and [Package managers](/getting-started/installation#package-managers) if you install with Node.js.

### Windows installer behavior and constraints

- **Reruns and repair:** When the requested release is already installed and healthy, rerunning skips the download and restores a missing User PATH entry; pass `-Force` or set `ATOMIC_FORCE_INSTALL=1` to reinstall anyway. A missing or mismatched `atomic.cmd` shim or `atomic-current` junction, a `current` junction that points outside the install root, or an installed payload that lost `app.js` or another startup file triggers a repair install.
- **PATH and `PATHEXT`:** The installer adds the bin directory to User PATH and the current PowerShell process, then asks you to open a new terminal when User PATH changed. A custom `ATOMIC_BIN_DIR` containing `;` cannot be one Windows PATH entry, so the installer leaves PATH untouched and prints a direct-run command for `atomic.cmd`. `PATHEXT` must include `.CMD` for bare `atomic` to resolve, or installation stops with an error.
- **Existing launchers and directories:** A same-stem launcher that `PATHEXT` resolves before `atomic.cmd`, such as a stale `atomic.exe`, stops installation before download until you remove it. An unexpected regular `current` entry under `ATOMIC_INSTALL_DIR`, or regular `atomic-current` entry under `ATOMIC_BIN_DIR`, is reported and left untouched instead of being moved or deleted.
- **Pinned versions:** A pinned `-Ref` is honored literally. If GitHub returns a different release tag, installation stops before download.
- **TLS 1.2 on legacy PowerShell 5.1:** Once fetched, the script enables TLS 1.2 for its own GitHub requests and restores your previous protocol setting. Because a downloaded script cannot repair the connection used to fetch itself, enable TLS 1.2 in your shell first if `irm` cannot reach GitHub.
- **Output and cleanup:** Set `NO_COLOR=1` for plain text output without colors, progress bar, or logo (output is also plain under `CI` or redirected stdout; legacy console windows draw `#`/`-` bars without the logo). The installer removes its `atomic-install-*` staging directory when done and prints a warning if cleanup fails.

## Shell discovery

Atomic uses Bash for the `bash` tool and checks these locations in order:

1. Custom `shellPath` in `~/.atomic/agent/settings.json` (legacy `~/.pi/agent/settings.json` is also read)
2. Git Bash at `%ProgramFiles%\Git\bin\bash.exe`
3. Git Bash at `%ProgramFiles(x86)%\Git\bin\bash.exe`
4. `bash.exe` on `PATH` (Cygwin, MSYS2, or WSL)

Windows Store app aliases (such as those in `%LOCALAPPDATA%\Microsoft\WindowsApps`) are accepted wherever Atomic checks for a shell.

For legacy WSL `bash.exe` from `%SystemRoot%\System32`:

- Ownerless `bash` tool calls send commands over stdin to avoid command-line quoting issues.
- Supervised and background shell tasks reject legacy WSL `bash.exe` with `ContainmentUnavailable`. Run Atomic inside WSL for supervised POSIX shells.

For the `bash` tool, [Git for Windows](https://git-scm.com/download/win) is sufficient. Native Windows `!` and `!!` commands use PowerShell instead of `shellPath`, so any `shellCommandPrefix` for interactive commands must use PowerShell syntax. Inside WSL, `!` and `!!` remain Bash-based.

PowerShell discovery checks these locations in order:

1. `pwsh.exe` on `PATH`
2. `%ProgramFiles%\PowerShell\7\pwsh.exe`
3. `powershell.exe` on `PATH`
4. `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`

Atomic searches only absolute directories on `PATH`, in order, and never searches the current working directory first. Empty and relative `PATH` entries are skipped, and directory entries never count as executables.

## Custom shell path

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```

Paths copied from Git Bash, MSYS2, Cygwin, or WSL work anywhere Atomic resolves a file path. For example, `/c/Users/name/project/file.ts`, `/cygdrive/c/Users/name/project/file.ts`, and `/mnt/c/Users/name/project/file.ts` resolve to the matching Windows drive path.

## Choose a terminal

Windows terminals run Atomic through a console host (conhost). Terminals that rely on the older built-in Windows conhost have bugs that affect Atomic. Use [Windows Terminal](https://aka.ms/terminal), which ships a current conhost.

| Terminal | Conhost | Status |
| --- | --- | --- |
| [Windows Terminal](https://aka.ms/terminal) | Bundled, current | Recommended |
| [VS Code](https://code.visualstudio.com), [Tabby](https://tabby.sh), [WezTerm](https://wezterm.org) nightly | Bundled, current | Works |
| [Alacritty](https://alacritty.org) | Built-in, unless `conpty.dll` and `OpenConsole.exe` from Windows Terminal sit next to `alacritty.exe` | Works only with those files |
| WezTerm 20240203 and older | Bundled, old | [Known issues](#known-issues) |
| Classic console (`cmd.exe` or PowerShell without Windows Terminal), mintty (Git Bash), ConEmu, Cmder, [Hyper](https://hyper.is), Windows OpenSSH | Built-in | [Known issues](#known-issues) |

## Windows and WSL keybindings

Atomic adjusts several default shortcuts on native Windows and WSL to avoid terminal conflicts:

| Action | Native Windows | WSL |
| --- | --- | --- |
| Queue follow-up message | `Ctrl+Q` | `Ctrl+Q` |
| Dequeue messages / move model up | `Alt+Q` | `Alt+Q` |
| Cycle scoped models backward | `Alt+P` | `Alt+P` |
| Undo in editor | `Ctrl+Z` | `Alt+Z` |
| Open interactive PowerShell subshell | `Alt+Z` | Not used (`Ctrl+Z` suspends) |
| Paste image or clipboard text | `Alt+V` or `Ctrl+V` | `Alt+V` or `Ctrl+V` |
| Jump to previous / next prompt | `Ctrl+Up` / `Ctrl+Down` | `Ctrl+Up` / `Ctrl+Down` |

On native Windows (outside VS Code's integrated terminal), pressing the unmodified secondary mouse button pastes clipboard text into the focused input. See [Keybindings](/keybindings) for the complete shortcut reference.

## Interactive startup

On eligible interactive starts, Atomic opens the prompt editor immediately so you can start typing right away, and your text is kept while the session finishes loading. See [Startup typing](/usage#startup-typing) for which keys apply immediately and which wait in order.

Submitting before loading finishes shows the working indicator, and pressing Escape cancels a queued submission. If resource loading fails before a prompt sends, Atomic restores your draft without sending a model request; run `/reload` to retry.

## Shutdown and shell process cleanup

- **Graceful shutdown:** Quitting Atomic gives the interactive engine up to 5 seconds to run `session_shutdown` handlers.
- **Console close and Windows sign-out:** Closing the console window (exit code `0xC000013A`) and signing out, restarting, or shutting down Windows also run `session_shutdown` handlers with `fromSignal: true` for up to about 4 seconds before Windows terminates the process.
- **Shell process-tree cleanup:** On native Windows, `!` commands and ownerless `bash` or `powershell` tool calls start in their own Windows Job object, so pressing Escape, hitting a timeout, or aborting stops the shell and the processes it started. Because Git Bash starts child processes with `CREATE_BREAKAWAY_FROM_JOB`, processes left running after `bash` exits cannot be stopped by that job. Set `ATOMIC_HOST_SPAWN=child-process` to revert to `child_process`.

## Headless skill commands

Skills such as `/skill:skill-creator` run evaluation queries in a hidden Windows console that cannot answer interactive credential prompts. Configure an API key, an environment variable, or a credential command that reads a cached token without prompting.

## Filesystem watchers

When a Windows path cannot be watched reliably with native filesystem events, Atomic falls back to polling where supported. Theme reloads and Git status updates may therefore arrive after a short polling delay.

## Self-update behavior

`atomic update` and `atomic update --self` update Atomic only. Pass `atomic update --all` to update both Atomic and installed packages, or `atomic update --extensions` to update installed packages only.

For writable global package-manager installs on Windows, Atomic handles loaded native add-ons during self-update so Windows file locks do not block replacement.

If Atomic cannot safely self-update an installation, it exits with an explanation naming the detected executable path when available and tells you to update through the package manager, wrapper, source checkout, or release artifact that installed it. Release archive installs are not updated by `atomic update`; rerun `install.ps1` instead. Standalone Bun binaries point you to the latest [Atomic releases](https://github.com/bastani-inc/atomic/releases/latest).

## PowerShell tool

On native Windows, Atomic enables the `powershell` tool by default whenever `pwsh.exe` or `powershell.exe` is found in the discovery order above. If neither is found, Atomic omits the tool. Add `powershell` to `defaultTools` if you want it alongside a narrower built-in tool list. Both `ATOMIC_*` and legacy `PI_*` session environment variables are available inside PowerShell calls.

PowerShell calls render with a `PS>` prompt in the transcript, and truncated output spills to an `atomic-powershell-*` temporary file separate from Bash spill files.

For SDK integrations, `@bastani/atomic` exports `createPowerShellTool()`, `createPowerShellToolDefinition()`, `createLocalPowerShellOperations()`, their public types, and `getPowerShellConfig()`. Factory-created tools expose the `ATOMIC_*` and legacy `PI_*` session snapshot by default; pass `exposeSessionEnvironment: false` to opt out. Default local execution is Windows-only and requires a resolvable PowerShell executable.

## Known issues

These issues come from older versions of Windows conhost:

| Issue | Affects | Remedy |
| --- | --- | --- |
| Opening the external editor (`Ctrl+G`) crashes the session ([microsoft/terminal#17515](https://github.com/microsoft/terminal/issues/17515)) | Built-in conhost | Use a terminal with a current conhost |
| Text such as `;0;rgb:0000/0000/0000` appears in the prompt, and BEL opens the external editor | Built-in conhost behind mintty or Windows OpenSSH | Use a terminal with a current conhost |
| Fragments such as `79` or `55` appear in the prompt | WezTerm 20240203 | Use WezTerm nightly |
