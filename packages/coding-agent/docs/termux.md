---
title: "Termux (Android) setup"
sidebarTitle: "Termux (Android)"
description: "Install Atomic in Termux on Android, build the required native module, and configure clipboard access."
---

[Termux](https://termux.dev/) provides a terminal emulator and Linux environment on Android.

## Requirements and limitations

- **Do not run `install.sh`:** Termux uses Android's bionic libc rather than glibc or Alpine's musl libc. Running Atomic's release-archive installer exits with `unsupported Linux libc: bionic`.
- **Local Android ARM64 native module required:** Atomic requires `@bastani/atomic-natives` to start any session and exits with `NativeModuleUnavailableError` when no compatible binary is found. Atomic does not publish a prebuilt Android ARM64 package. Build the addon locally from `crates/atomic-natives` in the [Atomic repository](https://github.com/bastani-inc/atomic) using Rust and `@napi-rs/cli` (NAPI-RS), then set `NAPI_RS_NATIVE_LIBRARY_PATH` to the compiled `.node` file. Setting `NAPI_RS_NATIVE_LIBRARY_PATH` bypasses Atomic's exact native-module release version check; add the `export` line to `~/.bashrc` so it persists across shells.
- **Install `fd` and `ripgrep` from Termux:** On Android, Atomic does not auto-download Linux `fd` or `rg` binaries because they cannot run on bionic libc. Install both packages through `pkg`.
- **Termux apps:** Install [Termux](https://github.com/termux/termux-app#installation) and [Termux:API](https://github.com/termux/termux-api#installation) from GitHub or F-Droid (the Google Play version is deprecated).
- **Text-only clipboard:** Image clipboard paste (`Ctrl+V`) is not supported on Termux.
- **Shared storage access:** Run `termux-setup-storage` once to grant access to `/storage/emulated/0`.

## Install Atomic in Termux

```bash
# Update packages
pkg update && pkg upgrade

# Install Node.js, Git, Termux:API CLI tools, fd, and ripgrep
pkg install nodejs termux-api git fd ripgrep

# Install Atomic with npm (included with Termux's nodejs package)
npm install -g --ignore-scripts @bastani/atomic

# Create config directory
mkdir -p ~/.atomic/agent

# Point Atomic to your locally built Android ARM64 native module
export NAPI_RS_NATIVE_LIBRARY_PATH=/path/to/atomic_natives.android-arm64.node
echo 'export NAPI_RS_NATIVE_LIBRARY_PATH=/path/to/atomic_natives.android-arm64.node' >> ~/.bashrc

# Run Atomic
atomic
```

Atomic does not require npm install scripts, so `--ignore-scripts` is safe.

## Clipboard support

When `TERMUX_VERSION` is set, Atomic uses `termux-clipboard-set` and `termux-clipboard-get` for text clipboard operations. Both commands time out after 5 seconds and require both the Termux:API Android app and the `termux-api` package.

If `termux-clipboard-set` fails, Atomic does not automatically fall back to OSC 52 unless you are connected over SSH, Mosh, or Rex, or set `ATOMIC_CLIPBOARD_OSC52=1`. Otherwise Atomic reports that the clipboard is unavailable.

Image clipboard paste (`Ctrl+V`) is not supported on Termux.

## Example AGENTS.md for Termux

Create `~/.atomic/agent/AGENTS.md` to document your Termux environment and helper commands for the model:

```markdown
# Agent environment: Termux on Android

## Location
- OS: Android (Termux terminal emulator)
- Home: `/data/data/com.termux/files/home`
- Prefix: `/data/data/com.termux/files/usr`
- Shared storage: `/storage/emulated/0` (Downloads, Documents, etc.)

## Useful Termux:API commands
- Open a URL: `termux-open-url "https://example.com"`
- Open a file: `termux-open file.pdf` or `termux-open --chooser image.jpg`
- Copy and paste text: `termux-clipboard-set "text"` and `termux-clipboard-get`
- Send a notification: `termux-notification -t "Title" -c "Content"`
- Check device info: `termux-battery-status`, `termux-wifi-connectioninfo`, `termux-telephony-deviceinfo`
- Share a file: `termux-share -a send file.txt`
- Quick helpers: `termux-toast "message"`, `termux-vibrate`, `termux-tts-speak "hello"`, `termux-camera-photo out.jpg`

## Notes
- Both the Termux:API Android app and `pkg install termux-api` are required for `termux-*` commands.
- Run `termux-setup-storage` before accessing `/storage/emulated/0`.
```

## Troubleshooting

### Clipboard not working

Install both Android apps from GitHub or F-Droid:

1. Termux
2. Termux:API

Then install the CLI helper package:

```bash
pkg install termux-api
```

### Permission denied for shared storage

Run once to grant storage permission:

```bash
termux-setup-storage
```

### Missing `fd` or `rg` warnings

If Atomic warns that `fd` or `rg` could not be found on Android, install them with `pkg`:

```bash
pkg install fd ripgrep
```

### Package installation issues

Termux has no official `pkg install bun` package. Use npm from the `nodejs` package unless you installed Bun separately.

If npm fails, clear its cache and retry:

```bash
npm cache clean --force
npm install -g --ignore-scripts @bastani/atomic
```
