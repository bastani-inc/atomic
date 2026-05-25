# Windows Setup

Atomic requires a bash shell on Windows. Checked locations (in order):

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

## Self-Update Behavior

`atomic update --self` can update Windows installations that Atomic can identify as writable global package-manager installs. `atomic update` includes the same self-update step before updating packages unless you pass `--extensions`.

When self-update starts on Windows, Atomic first cleans any previous `.atomic-native-quarantine` directory under the global package root. If native add-ons from the current install are loaded by the running process, Atomic moves those files into a per-run quarantine directory and copies them back into place before invoking the package manager. This lets the package manager replace native dependency files that Windows would otherwise keep locked.

If Atomic cannot safely self-update the current installation, it exits with a clear message instead of guessing. The message explains that the install is unsupported, unmanaged, or not writable; prints the detected executable path when available; and tells you to update Atomic with the package manager, wrapper, source checkout, or release artifact that originally installed it.
