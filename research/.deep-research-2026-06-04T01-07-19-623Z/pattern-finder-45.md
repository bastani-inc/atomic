## 1. Established patterns

- **Capability probing + fallback ladders** are the dominant shape.
  - Clipboard writes: native addon → platform tool (`pbcopy`/`clip`/`wl-copy`/`xclip`/`xsel`) → OSC 52 in `packages/coding-agent/src/utils/clipboard.ts`.
  - Clipboard image reads: Wayland `wl-paste` → X11 `xclip` → native addon → WSL PowerShell → `null` in `packages/coding-agent/src/utils/clipboard-image.ts`.
  - Video/YouTube extraction: Gemini web cookies → Gemini API → Perplexity/thumbnail/stream helpers in `packages/web-access/video-extract.ts` and `youtube-extract.ts`.
  - GitHub repo access: `gh` CLI first, otherwise return `null`/hint in `packages/web-access/github-api.ts`.

- **Platform branching is explicit and centralized.**
  - `process.platform`, `WAYLAND_DISPLAY`, `DISPLAY`, `TERMUX_VERSION`, and WSL checks gate behavior in clipboard and browser-cookie code.
  - Browser cookie support is split by OS in `packages/web-access/chrome-cookies.ts` with separate macOS vs Linux config tables.

- **Path handling is normalized before use.**
  - `packages/coding-agent/src/utils/paths.ts` treats `~`, `file://`, Unicode spaces, and symlinks as first-class cases.
  - Tests validate macOS-style filename quirks: NFC/NFD accents, curly quotes, screenshot spacing, and `~draft.md` staying literal in `packages/coding-agent/test/path-utils.test.ts` and `paths.test.ts`.

- **Native dependencies are wrapped behind tiny adapters.**
  - `loadClipboardNative()` isolates `@mariozechner/clipboard`.
  - `loadPhoton()` patches `fs.readFileSync` around `@silvia-odwyer/photon-node`’s WASM lookup in `packages/coding-agent/src/utils/photon.ts`.
  - External CLIs are called through small helpers like `mapFfmpegError`, `mapYtDlpError`, and `checkGhAvailable()`.

## 2. Variations / exceptions

- **WASM is handled differently from CLI dependencies.**
  - `photon.ts` does not shell out; it monkey-patches filesystem reads so the WASM file can be found next to the executable.
  - That’s a one-off compatibility shim, not the general pattern.

- **Browser cookies are OS- and browser-specific, not generic.**
  - macOS reads from Keychain + browser profiles like Chrome/Arc/Helium.
  - Linux uses `secret-tool` and Chromium/Chrome profile paths.
  - Cookie names are hard-coded to Google auth cookie set in `chrome-cookies.ts`.

- **Video vs YouTube extraction diverge.**
  - Local files use `ffmpeg`/`ffprobe` directly.
  - YouTube uses `yt-dlp` for stream info, then `ffmpeg` for frame extraction.
  - Both reuse the same error-mapping style but not the same transport.

- **`gh` is optional but preferred.**
  - `github-api.ts` degrades gracefully to `null` instead of hard-failing if `gh` is missing.
  - It’s treated as an enhancement path for private repos and API browsing, not a hard requirement.

## 3. Anti-patterns or risks

- **Many features depend on host-installed native tooling.**
  - `ffmpeg`, `ffprobe`, `yt-dlp`, `gh`, `wl-copy`, `wl-paste`, `xclip`, `xsel`, `pbcopy`, `clip`, `security`, `secret-tool`, `powershell.exe`.
  - A Rust port that removes Node must still replace these process-level dependencies or keep subprocess bridges.

- **Some platform logic is heuristic, not capability-based.**
  - Wayland detection in `clipboard-image.ts` and `clipboard.ts` uses env vars and `isWaylandSession()`.
  - Path guessing in `resolveFilePath()` uses whitespace normalization and directory scans, which may hide mismatches rather than surface them.

- **WASM loading is brittle to packaging layout.**
  - `photon.ts` patches `fs.readFileSync` because the dependency expects a colocated `.wasm` file.
  - This is a build/distribution coupling risk for any non-Node runtime.

- **Cookie decryption is tightly coupled to browser internals.**
  - Hard-coded origins, cookie names, profile names, and keychain/secret-tool assumptions in `chrome-cookies.ts`.
  - Likely the highest migration risk if you want this to work cross-platform in Rust without reusing OS-specific helpers.

- **Path compatibility is broad but ad hoc.**
  - There are many special cases for macOS screenshot names, Unicode normalization, and file URLs.
  - Rust’s path handling will need to preserve these semantics exactly or tests will regress.

## 4. Evidence index

- `packages/coding-agent/src/utils/clipboard-native.ts`
- `packages/coding-agent/src/utils/clipboard.ts`
- `packages/coding-agent/src/utils/clipboard-image.ts`
- `packages/coding-agent/src/utils/photon.ts`
- `packages/coding-agent/src/utils/paths.ts`
- `packages/coding-agent/test/clipboard-native.test.ts`
- `packages/coding-agent/test/clipboard.test.ts`
- `packages/coding-agent/test/clipboard-image-bmp-conversion.test.ts`
- `packages/coding-agent/test/path-utils.test.ts`
- `packages/coding-agent/test/paths.test.ts`
- `packages/web-access/video-extract.ts`
- `packages/web-access/youtube-extract.ts`
- `packages/web-access/github-api.ts`
- `packages/web-access/chrome-cookies.ts`
- `packages/web-access/config-paths.ts`