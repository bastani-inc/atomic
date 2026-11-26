---
title: "Windows setup"
sidebarTitle: "Windows"
description: "Install Atomic, configure Bash and PowerShell, pick a terminal, and troubleshoot Windows or WSL."
---

## Install with PowerShell

Install the self-contained Windows release archive with Windows PowerShell 5.1 or newer (no Node.js or package manager required):

```powershell
irm https://raw.githubusercontent.com/bastani-inc/atomic/main/install.ps1 | iex
```

To pin an exact release (`MAJOR.MINOR.PATCH` or `MAJOR.MINOR.PATCH-alpha.REVISION`):

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/bastani-inc/atomic/main/install.ps1))) -Ref 0.9.11
```

By default, the installer verifies `SHA256SUMS`, stores versioned payloads under `%LOCALAPPDATA%\atomic`, and creates an ASCII-only `atomic.cmd` launcher plus an `atomic-current` junction in `%LOCALAPPDATA%\atomic\bin`. The relative shim supports Unicode install paths and custom bin directories.

Override defaults with `ATOMIC_INSTALL_DIR`, `ATOMIC_BIN_DIR` (defaults to `<ATOMIC_INSTALL_DIR>\bin`, so changing `ATOMIC_INSTALL_DIR` moves the default bin directory too), `ATOMIC_VERSION` (`-Ref` takes precedence over `ATOMIC_VERSION`), or optional `GITHUB_TOKEN`/`GH_TOKEN` (used only if release resolution falls back to the GitHub API). See [Release archive](/getting-started/installation#release-archive) for cross-platform archive options and [Package managers](/getting-started/installation#package-managers) if you install with Node.js.

### Installer rules and edge cases

- **Reruns, repair, and locking:** Concurrent installer runs serialize on an exclusive lock file under `ATOMIC_INSTALL_DIR`. When the requested release is already installed and healthy, rerunning skips the download and restores a missing User PATH entry; pass `-Force` or set `ATOMIC_FORCE_INSTALL=1` to reinstall anyway. A missing or mismatched `atomic.cmd` shim or `atomic-current` junction, a `current` junction pointing outside the install root, or a payload missing `app.js` or another startup file triggers a repair install.
- **PATH and `PATHEXT`:** The installer adds the bin directory to User PATH and the current PowerShell process, then asks you to open a new terminal when User PATH changed. A custom `ATOMIC_BIN_DIR` containing `;` cannot be one Windows PATH entry, so the installer leaves PATH untouched and prints a direct command for `atomic.cmd`. `PATHEXT` must include `.CMD` for bare `atomic` to resolve, or installation stops with an error.
- **Existing launchers and directories:** A same-stem launcher that `PATHEXT` resolves before `atomic.cmd`, such as a stale `atomic.exe`, stops installation before download until you remove it. An unexpected regular `current` entry under `ATOMIC_INSTALL_DIR`, or regular `atomic-current` entry under `ATOMIC_BIN_DIR`, is reported and left untouched instead of being moved or deleted.
- **Pinned versions:** `-Ref` is validated against `MAJOR.MINOR.PATCH` or `MAJOR.MINOR.PATCH-alpha.REVISION` and honored literally. If GitHub returns a different release tag, installation stops before download.
- **TLS 1.2 on legacy PowerShell 5.1:** Once downloaded, the script enables TLS 1.2 for its own GitHub requests and restores your previous protocol setting. Because a downloaded script cannot fix the connection used to fetch itself, enable TLS 1.2 in your shell first if `irm` cannot reach GitHub.
- **Output, Intercom upgrade, and cleanup:** Setting `NO_COLOR` to any value (even empty) switches installer output to plain text without colors, progress bar, or logo (output is also plain under `CI` or redirected stdout; legacy consoles draw `#`/`-` bars without the logo). After installing, `install.ps1` runs `atomic intercom upgrade` to replace any older running Intercom broker and warns if that step fails ([Updating while Intercom is running](/getting-started/installation#updating-while-intercom-is-running)). The installer removes its `atomic-install-*` staging directory when done and warns if cleanup fails.

## Bash and PowerShell discovery

Atomic uses Bash for the `bash` tool and checks these locations in order:

1. Custom `shellPath` in `~/.atomic/agent/settings.json`, trusted project `.atomic/settings.json`, or legacy `~/.pi/agent/settings.json`
2. Git Bash at `%ProgramFiles%\Git\bin\bash.exe`
3. Git Bash at `%ProgramFiles(x86)%\Git\bin\bash.exe`
4. `bash.exe` on `PATH` (Cygwin, MSYS2, or WSL)

Windows Store app aliases (such as those in `%LOCALAPPDATA%\Microsoft\WindowsApps`) are accepted wherever Atomic searches for a shell. Atomic checks only absolute directories on `PATH` in order, skips empty and relative `PATH` entries and directories, never searches the current working directory first, and caches missing `PATH` lookups for 30 seconds.

For the `bash` tool on native Windows, [Git for Windows](https://git-scm.com/download/win) is recommended. Every `bash` tool call in an Atomic CLI or interactive session rejects legacy WSL `%SystemRoot%\System32\bash.exe` with `ContainmentUnavailable` because Windows cannot isolate legacy WSL child processes reliably. Run Atomic directly inside WSL when you want a WSL POSIX shell. (Only standalone SDK `createBashTool()` calls without background task management fall back to sending commands over stdin on legacy WSL `bash.exe`.)

PowerShell discovery checks these locations in order:

1. `pwsh.exe` on `PATH`
2. `%ProgramFiles%\PowerShell\7\pwsh.exe`
3. `powershell.exe` on `PATH`
4. `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`

### Native Windows `shellCommandPrefix` caveat

On native Windows, Atomic prepends `shellCommandPrefix` to **both** model `bash` tool calls (which run in Bash) and interactive `!` and `!!` commands (which run in PowerShell), while the model `powershell` tool ignores `shellCommandPrefix`.

Because Bash and PowerShell use incompatible syntax, putting PowerShell syntax in `shellCommandPrefix` breaks every model `bash` tool call, and putting Bash syntax breaks every `!` and `!!` command. Leave `shellCommandPrefix` unset on native Windows unless you intentionally disable one side (for example, by excluding `bash`). Inside WSL, both `bash` tool calls and `!`/`!!` run in Bash, so Bash syntax works for both. See [Shell aliases](/shell-aliases).

### Set a custom Bash path

Set `shellPath` in `~/.atomic/agent/settings.json` or a trusted project's `.atomic/settings.json`:

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```

If `shellPath` is a bare executable name (with no `/`, `\`, or `:`), Atomic searches absolute `PATH` directories. Otherwise Atomic checks the path literally. If the configured `shellPath` does not exist, Atomic stops with `Custom shell path not found: ...` instead of falling back to Git Bash.

POSIX-style paths copied from Git Bash, MSYS2, Cygwin, or WSL work anywhere Atomic resolves a file path. Atomic translates `/c/...`, `/cygdrive/c/...`, and `/mnt/c/...` (case-insensitive single drive letter) into `C:\...`, while leaving UNC/double-slash paths (`//...`) and paths already containing `\` untouched.

## PowerShell tool

On native Windows, Atomic enables the `powershell` tool by default whenever `pwsh.exe` or `powershell.exe` is found in the discovery order above, and omits it if neither is installed. This tool is Windows-only and is not enabled on Linux or macOS even if `pwsh` is installed.

- **Execution flags and encoding:** Atomic launches PowerShell with `-NoProfile -NonInteractive -ExecutionPolicy Bypass` (using `-EncodedCommand` with UTF-16LE base64 in interactive and CLI sessions, or `-Command` in standalone SDK calls), sets UTF-8 console output, and wraps Windows PowerShell 5.1 (`powershell.exe`) calls so script errors exit with code `1`.
- **Environment and PTY control:** Both `ATOMIC_*` and legacy `PI_*` session environment variables are available inside PowerShell calls ([Environment variables](/environment-variables)). Setting `ATOMIC_NO_PTY=1` (legacy `PI_NO_PTY=1`, where `ATOMIC_NO_PTY=0` overrides `PI_NO_PTY=1`) disables PTY allocation for both `powershell` and `bash` tool calls.
- **Tool lists and output:** Add `powershell` to `defaultTools` in [Tool settings](/settings#tools) if you define a custom built-in tool allowlist. To disable all shell execution on native Windows, exclude both `bash` and `powershell` (`--exclude-tools bash,powershell`; see [No built-in sandbox](/security#no-built-in-sandbox)). PowerShell calls render with a `PS>` prompt, and truncated output spills to an `atomic-powershell-*` temporary file separate from Bash spill files.
- **SDK exports:** `@bastani/atomic` exports `createPowerShellTool()`, `createPowerShellToolDefinition()`, `createLocalPowerShellOperations()`, their public types, and `getPowerShellConfig()` ([PowerShell tool behavior](/sdk/reference#powershell-tool-behavior)). Factory-created tools expose the `ATOMIC_*` and legacy `PI_*` session snapshot by default; pass `exposeSessionEnvironment: false` to opt out.

## Choose a terminal

Windows terminals run Atomic through a console host (`conhost`). Terminals using the older built-in Windows `conhost` have rendering and input bugs that affect Atomic. Use [Windows Terminal](https://aka.ms/terminal), which ships a current `conhost` (see [Windows Terminal setup](/terminal-setup#windows-terminal) for WSL and SSH `Shift+Enter` configuration). For terminal multiplexers and Windows desktop or terminal automation with psmux and UI Automation, see [Herdr](/herdr) and [Computer use](/computer-use#windows).

| Terminal | Conhost | Status |
| --- | --- | --- |
| [Windows Terminal](https://aka.ms/terminal) | Bundled, current | Recommended |
| [VS Code](https://code.visualstudio.com), [Tabby](https://tabby.sh), [WezTerm](https://wezterm.org) nightly | Bundled, current | Works |
| [Alacritty](https://alacritty.org) | Built-in, unless `conpty.dll` and `OpenConsole.exe` from Windows Terminal sit next to `alacritty.exe` | Works only with those files |
| WezTerm 20240203 and older | Bundled, old | [Known issues](#known-issues) |
| Classic console (`cmd.exe` or PowerShell without Windows Terminal), mintty (Git Bash), ConEmu, Cmder, [Hyper](https://hyper.is), Windows OpenSSH | Built-in | [Known issues](#known-issues) |

## Windows and WSL keybindings

Atomic adjusts several default shortcuts on native Windows and WSL to avoid terminal conflicts. WSL keybindings activate automatically on Linux whenever `WSL_DISTRO_NAME` or `WSL_INTEROP` is set.

| Action | Native Windows | WSL |
| --- | --- | --- |
| Queue follow-up message | `Ctrl+Q` | `Ctrl+Q` |
| Dequeue messages / move model up | `Alt+Q` | `Alt+Q` |
| Cycle scoped models backward | `Alt+P` | `Alt+P` |
| Undo in editor | `Ctrl+Z` | `Alt+Z` |
| Open interactive PowerShell subshell | `Alt+Z` | Not used (`Ctrl+Z` suspends) |
| Paste image or clipboard text | `Alt+V` or `Ctrl+V` | `Alt+V` or `Ctrl+V` |
| Jump to previous / next prompt | `Ctrl+Up` / `Ctrl+Down` | `Ctrl+Up` / `Ctrl+Down` |

On native Windows outside VS Code's integrated terminal, pressing the unmodified secondary mouse button pastes clipboard text into the focused input. See [Keybindings](/keybindings) for the complete shortcut reference.

## Startup, shutdown, and process cleanup

- **Early startup typing:** On eligible interactive starts, Atomic opens the prompt editor right away so you can start typing while the session finishes loading. Submitting early shows the working indicator, and pressing `Escape` cancels a queued submission. If resource loading fails before a prompt sends, Atomic restores your draft without sending a model request; run `/reload` to retry. See [Startup typing](/usage#startup-typing).
- **Graceful shutdown:** Quitting Atomic gives the session up to 5 seconds to run `session_shutdown` handlers.
- **Console close and Windows sign-out:** Closing the console window (exit code `0xC000013A`) and signing out, restarting, or shutting down Windows also run `session_shutdown` handlers with `fromSignal: true` for up to about 4 seconds before Windows terminates the process.
- **Shell process-tree cleanup:** Interactive and CLI `bash` and `powershell` tool calls are contained automatically by the session. Interactive `!` commands and standalone SDK `bash` or `powershell` calls start in their own Windows Job object, so pressing `Escape`, hitting a timeout, or aborting stops the shell and its child processes. Because Git Bash starts child processes with `CREATE_BREAKAWAY_FROM_JOB`, processes left running after `bash` exits cannot be stopped by that job. Set `ATOMIC_HOST_SPAWN=child-process` to disable native Job-object containment for `!` commands, helper processes, and standalone SDK tool calls and fall back to Node's `child_process` ([Environment variables](/environment-variables#diagnostics-and-performance)).
- **Node.js compile cache:** On Node.js, Atomic enables Node's persistent compile cache automatically and warms a cold default cache in a background helper during interactive runs. Set `NODE_COMPILE_CACHE` to use a custom directory (letting Node write it on exit) or `NODE_DISABLE_COMPILE_CACHE=1` to disable it ([Environment variables](/environment-variables#diagnostics-and-performance)).

## Self-update on Windows

Run `atomic update` or `atomic update --self` to update Atomic (add `--force` to reinstall the same version), `atomic update --all` to update Atomic and installed packages, `atomic update --extensions` to update installed packages only, or `atomic update --models` to refresh the model catalog.

For writable global package-manager installs on Windows, Atomic handles loaded native add-ons during self-update so Windows file locks do not block replacement. For custom or wrapped installations, configure `selfUpdateCommand` in global settings or `ATOMIC_SELF_UPDATE_COMMAND` (see [Custom update command](/reference/cli#custom-update-command)).

If you upgrade an npm install from 0.10.4 or earlier while an older Intercom broker is running, `npm install -g @bastani/atomic` can fail with `EBUSY` because earlier brokers locked files inside the npm install directory. Close running Atomic sessions and wait 5 seconds (or run `atomic intercom restart`), then rerun the install. From 0.10.5 onward, the broker runs outside the install directory ([Updating while Intercom is running](/getting-started/installation#updating-while-intercom-is-running)).

If Atomic cannot safely self-update an installation, it exits with an explanation naming the detected executable path when available and tells you how to update. Release archive installs are not updated by `atomic update`; rerun `install.ps1` instead. Standalone Bun binaries point you to the latest [Atomic releases](https://github.com/bastani-inc/atomic/releases/latest).

## Headless skills and file watchers

- **Headless skill commands:** Skills such as `/skill:skill-creator` run evaluation queries in a hidden Windows console that cannot answer interactive credential prompts. Configure an API key, an environment variable, or a credential command that reads a cached token without prompting.
- **File watcher polling:** When a Windows path cannot be watched reliably with native filesystem events, Atomic falls back to polling: every 1,000 ms for custom theme files and Git HEAD, and every 250 ms for Git reftable lists. Theme reloads and Git status updates may arrive after that short interval.

## Known issues

These issues come from older versions of Windows `conhost`:

| Issue | Affects | Remedy |
| --- | --- | --- |
| Opening the external editor (`Ctrl+G`) crashes the session ([microsoft/terminal#17515](https://github.com/microsoft/terminal/issues/17515)) | Built-in conhost | Use a terminal with a current conhost |
| Text such as `;0;rgb:0000/0000/0000` appears in the prompt, and BEL opens the external editor | Built-in conhost behind mintty or Windows OpenSSH | Use a terminal with a current conhost |
| Fragments such as `79` or `55` appear in the prompt | WezTerm 20240203 | Use WezTerm nightly |
