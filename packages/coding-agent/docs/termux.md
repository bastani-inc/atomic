---
title: "Termux"
description: "Android Termux compatibility, native module requirements, clipboard support, and setup notes."
---

# Termux (Android) setup

[Termux](https://termux.dev/) provides a terminal emulator and Linux environment on Android.

Termux uses Android's bionic libc, not Alpine's musl libc. Do not run the root `install.sh` there. Atomic's glibc and musl Linux release archives are not Android packages and do not provide a Termux target.

## Native module requirement

Atomic requires its `@bastani/atomic-natives` native module to start any session. Without a compatible native binary, Atomic exits at startup with `NativeModuleUnavailableError`.

Atomic does not publish a prebuilt `@bastani/atomic-natives` package for Android ARM64. To run Atomic in Termux, you must build the native binding locally for Android ARM64 and point `NAPI_RS_NATIVE_LIBRARY_PATH` to the compiled `.node` file before starting Atomic.

## Prerequisites

1. Install [Termux](https://github.com/termux/termux-app#installation) from GitHub or F-Droid (the Google Play version is deprecated).
2. Install [Termux:API](https://github.com/termux/termux-api#installation) from GitHub or F-Droid for clipboard and device integrations.

## Installation

```bash
# Update packages
pkg update && pkg upgrade

# Install dependencies
pkg install nodejs termux-api git

# Install Atomic with npm (included with Termux's nodejs package)
npm install -g @bastani/atomic

# Create config directory
mkdir -p ~/.atomic/agent

# Point Atomic to your locally built Android ARM64 native binding
export NAPI_RS_NATIVE_LIBRARY_PATH=/path/to/atomic_natives.android-arm64.node

# Run Atomic
atomic
```

Atomic does not require package install scripts; pass `--ignore-scripts` if you disable lifecycle scripts during installation.

## Clipboard support

In Termux, Atomic uses `termux-clipboard-set` and `termux-clipboard-get` for text clipboard operations. Both the Termux:API app and the `termux-api` package must be installed.

Image clipboard paste (`Ctrl+V`) is not supported on Termux.

## Example AGENTS.md for Termux

Create `~/.atomic/agent/AGENTS.md` to document your Termux environment for the model:

````markdown
# Agent Environment: Termux on Android

## Location
- **OS**: Android (Termux terminal emulator)
- **Home**: `/data/data/com.termux/files/home`
- **Prefix**: `/data/data/com.termux/files/usr`
- **Shared storage**: `/storage/emulated/0` (Downloads, Documents, etc.)

## Opening URLs
```bash
termux-open-url "https://example.com"
```

## Opening Files
```bash
termux-open file.pdf          # Opens with default app
termux-open --chooser image.jpg      # Choose app
```

## Clipboard
```bash
termux-clipboard-set "text"   # Copy
termux-clipboard-get          # Paste
```

## Notifications
```bash
termux-notification -t "Title" -c "Content"
```

## Device Info
```bash
termux-battery-status         # Battery info
termux-wifi-connectioninfo    # WiFi info
termux-telephony-deviceinfo   # Device info
```

## Sharing
```bash
termux-share -a send file.txt # Share file
```

## Other Useful Commands
```bash
termux-toast "message"        # Quick toast popup
termux-vibrate                # Vibrate device
termux-tts-speak "hello"      # Text to speech
termux-camera-photo out.jpg   # Take photo
```

## Notes
- Termux:API app must be installed for `termux-*` commands
- Use `pkg install termux-api` for the command-line tools
- Storage permission needed for `/storage/emulated/0` access
````

## Limitations

- **No prebuilt Android ARM64 native module:** Termux uses Android's bionic libc rather than glibc or musl, and Atomic ships no prebuilt Android native package. Starting a session fails with `NativeModuleUnavailableError` unless `NAPI_RS_NATIVE_LIBRARY_PATH` points to a locally built Android ARM64 binding.
- **No image clipboard:** Termux clipboard commands support text only.
- **Shared storage access:** Run `termux-setup-storage` once to grant access to `/storage/emulated/0`.

## Troubleshooting

### Clipboard not working

Install both apps from GitHub or F-Droid:

1. Termux
2. Termux:API

Then install the CLI tools:

```bash
pkg install termux-api
```

### Permission denied for shared storage

Run once to grant storage permissions:

```bash
termux-setup-storage
```

### Package installation issues

Termux has no official `pkg install bun` package. Use npm from the `nodejs` package unless you installed Bun separately.

If npm fails, clear its cache and retry:

```bash
npm cache clean --force
npm install -g @bastani/atomic
```
