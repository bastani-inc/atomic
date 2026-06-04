## 1. Must-read paths

- `scripts/build-binaries.sh` — shows the native dependency story for release bundles: cross-platform clipboard addons, `photon_rs_bg.wasm`, copied runtime `node_modules`, and bundled assets.
- `packages/coding-agent/src/utils/clipboard-native.ts` — direct native clipboard addon loader (`@mariozechner/clipboard`) with platform/display guards.
- `packages/coding-agent/src/utils/clipboard.ts` — fallback ladder for clipboard I/O (`clipboard addon` → `termux-clipboard-set` / `wl-copy` / `xclip` / `xsel` / OSC52).
- `packages/coding-agent/src/utils/clipboard-image.ts` — clipboard image ingestion; references Wayland/X11, WSL, and platform-specific capture paths.
- `packages/coding-agent/src/utils/photon.ts` — WASM/native image pipeline workaround; patches `fs.readFileSync` to find `photon_rs_bg.wasm` next to the executable.
- `packages/coding-agent/src/utils/paths.ts` — canonical path normalization/resolution, tilde/file:// handling, cwd-relative formatting, cloud-sync ignore attrs.
- `packages/web-access/youtube-extract.ts` — YouTube frame/video path, hard dependency on `yt-dlp` and `ffmpeg`.
- `packages/web-access/video-extract.ts` — local video handling and `ffmpeg`/`ffprobe` dependency surface.
- `packages/web-access/github-api.ts` — `gh` CLI dependency for private/large repo GitHub access.
- `packages/web-access/github-extract.ts` — GitHub clone path using `gh repo clone`.
- `packages/web-access/chrome-cookies.ts` — browser-cookie extraction for Gemini Web; macOS Keychain + Linux `secret-tool`, Chromium profile paths, SQLite cookie DB access.
- `packages/web-access/gemini-web-config.ts` — `chromeProfile` / `allowBrowserCookies` config contract.
- `packages/web-access/README.md` — best high-level inventory of native tools and user-facing constraints.

## 2. Supporting paths

- `packages/web-access/index.ts` — tool descriptions explicitly encode native requirements (`yt-dlp + ffmpeg`, browser cookies).
- `packages/web-access/extract.ts` — routing for video, GitHub, HTML, and fallback behavior.
- `packages/web-access/gemini-web.ts` — cookie-authenticated Gemini Web request flow.
- `packages/coding-agent/src/index.ts` — exports clipboard/image utilities and shows what the CLI surface expects.
- `packages/coding-agent/src/modes/interactive/chat-input-actions.ts` — clipboard-image paste entrypoint.
- `packages/coding-agent/src/core/keybindings.ts` — binds clipboard paste actions into the TUI.
- `packages/coding-agent/test/clipboard-native.test.ts` — verifies native clipboard resolution behavior.
- `packages/coding-agent/test/clipboard-image.test.ts` — clipboard image conversion paths.
- `packages/coding-agent/test/clipboard-image-bmp-conversion.test.ts` — image format handling around clipboard ingestion.
- `packages/coding-agent/test/path-utils.test.ts` and `packages/coding-agent/test/paths.test.ts` — path normalization/canonicalization coverage.
- `packages/coding-agent/test/bash-close-hang-windows.test.ts` — platform process/path edge case coverage.
- `packages/web-access/CHANGELOG.md` — migration clues for native dependency behavior changes (`gh`, cookies, `ffmpeg`, `yt-dlp`).

## 3. Entry points / symbols

- `loadClipboardNative()` / `clipboard` in `packages/coding-agent/src/utils/clipboard-native.ts`
- `copyToClipboard()` in `packages/coding-agent/src/utils/clipboard.ts`
- `loadPhoton()` / `patchPhotonWasmRead()` / `getFallbackWasmPaths()` in `packages/coding-agent/src/utils/photon.ts`
- `canonicalizePath()` / `normalizePath()` / `resolvePath()` / `getCwdRelativePath()` in `packages/coding-agent/src/utils/paths.ts`
- `checkGhAvailable()` / `fetchViaApi()` / `showGhHint()` in `packages/web-access/github-api.ts`
- `getGoogleCookies()` / `readBrowserPassword()` / `readKeychainPassword()` / `readLinuxPassword()` in `packages/web-access/chrome-cookies.ts`
- `isGeminiWebAvailable()` / `getActiveGoogleEmail()` in `packages/web-access/gemini-web.ts`
- `web_search` / `fetch_content` tool docs in `packages/web-access/index.ts`
- `fetchVideoInfo()` / frame-extraction path in `packages/web-access/youtube-extract.ts`
- `extractLocalVideo()` / ffmpeg error handling in `packages/web-access/video-extract.ts`

## 4. Gaps or uncertainty

- I verified the repo has **no Rust code yet**; these are the TS/native seams most likely to require Rust equivalents or subprocess bridges.
- I did **not** fully verify every transitive native dependency for the web stack (e.g. any hidden browser automation/runtime pieces), only the obvious audited paths above.
- CI/build coverage for the native paths should be confirmed against `.github/workflows/*` if you want exact release impact.
- The biggest migration risk remains **WASM + native CLI interop**: clipboard addon, `photon_rs_bg.wasm`, `gh`, `ffmpeg`, `yt-dlp`, and browser-cookie access all imply nontrivial Rust replacement or shell-out strategy.