---
title: "Run Atomic on Android (Termux)"
sidebarTitle: "Run on Android (Termux)"
description: "Install Atomic in Termux on Android, compile the required native module locally, and configure clipboard and storage access."
---

[Termux](https://termux.dev/) provides a terminal emulator and Linux environment on Android.

<Warning>
**Community-supported platform:** Android uses bionic libc rather than glibc or musl, so Atomic's `install.sh` installer does not run on Termux (it exits with `unsupported Linux libc: bionic`) and Atomic does not publish prebuilt Android ARM64 native binaries. You must install Atomic via npm and compile the required native module (`@bastani/atomic-natives`) locally with Rust before starting a session.
</Warning>

## Requirements and limitations

- **Termux apps:** Install both [Termux](https://github.com/termux/termux-app#installation) and [Termux:API](https://github.com/termux/termux-api#installation) from GitHub or F-Droid (the Google Play version is deprecated).
- **Install `fd` and `ripgrep` through `pkg`:** On Android, Atomic does not auto-download Linux `fd` or `rg` binaries because they cannot run on bionic libc.
- **Text-only clipboard:** Image clipboard paste (`Ctrl+V`) is not supported on Termux.
- **Shared storage access:** Run `termux-setup-storage` once to grant access to `/storage/emulated/0`.

## Install Atomic in Termux

<Steps>
  <Step title="Install Termux dependencies">
    Update Termux packages and install Node.js, Git, Termux:API CLI helpers, `fd`, `ripgrep`, and the Rust/C toolchain needed to compile the native module:

    ```bash
    pkg update && pkg upgrade
    pkg install nodejs termux-api git fd ripgrep rust clang
    ```
  </Step>

  <Step title="Install the Atomic CLI">
    Install `@bastani/atomic` globally with npm (included with Termux's `nodejs` package). Atomic does not require npm install scripts, so `--ignore-scripts` is safe:

    ```bash
    npm install -g --ignore-scripts @bastani/atomic
    mkdir -p ~/.atomic/agent
    ```
  </Step>

  <Step title="Compile the Android ARM64 native module">
    Clone the Atomic release tag matching your installed npm version, compile the native library with Cargo, and copy the resulting `.node` binary into `~/.atomic/agent`:

    ```bash
    ATOMIC_VER="$(node -p "require('$(npm root -g)/@bastani/atomic/package.json').version")"
    git clone --depth 1 --branch "$ATOMIC_VER" https://github.com/bastani-inc/atomic.git ~/atomic-src
    cd ~/atomic-src
    cargo build --release --manifest-path crates/atomic-natives/Cargo.toml
    cp target/release/libatomic_natives.so ~/.atomic/agent/atomic_natives.android-arm64.node
    ```

    You can remove `~/atomic-src` after copying the compiled `.node` binary.
  </Step>

  <Step title="Point Atomic to the compiled native module and start">
    Set `NAPI_RS_NATIVE_LIBRARY_PATH` in your current shell and persist it in `~/.bashrc`, then launch Atomic:

    ```bash
    export NAPI_RS_NATIVE_LIBRARY_PATH="$HOME/.atomic/agent/atomic_natives.android-arm64.node"
    echo 'export NAPI_RS_NATIVE_LIBRARY_PATH="$HOME/.atomic/agent/atomic_natives.android-arm64.node"' >> ~/.bashrc
    atomic
    ```
  </Step>
</Steps>

<Note>
Setting `NAPI_RS_NATIVE_LIBRARY_PATH` bypasses Atomic's exact native-module release version check. When you upgrade `@bastani/atomic` later, rebuild the `.node` file from the matching release tag so native bindings stay in sync.
</Note>

## Clipboard support

When `TERMUX_VERSION` is set, Atomic uses `termux-clipboard-set` and `termux-clipboard-get` for text clipboard operations. Both commands time out after 5 seconds and require both the Termux:API Android app and the `termux-api` package.

If `termux-clipboard-set` fails, Atomic does not automatically fall back to OSC 52 unless you are connected over SSH, Mosh, or Rex, or set `ATOMIC_CLIPBOARD_OSC52=1`. Otherwise Atomic reports that the clipboard is unavailable. Image clipboard paste (`Ctrl+V`) is not supported on Termux.

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

### Native module failed to load

Confirm `NAPI_RS_NATIVE_LIBRARY_PATH` points to an existing `.node` file built from the same Atomic release version:

```bash
ls -la "$NAPI_RS_NATIVE_LIBRARY_PATH"
```

### Clipboard not working

Install both Android apps from GitHub or F-Droid (Termux and Termux:API), then install the CLI helper package:

```bash
pkg install termux-api
```

### Permission denied for shared storage

Run once to grant storage permission:

```bash
termux-setup-storage
```

### Missing `fd` or `rg` warnings

Install both packages through Termux:

```bash
pkg install fd ripgrep
```

### Package installation issues

Termux has no official `pkg install bun` package; use npm from the `nodejs` package unless you installed Bun separately. If npm fails, clear its cache and retry:

```bash
npm cache clean --force
npm install -g --ignore-scripts @bastani/atomic
```
