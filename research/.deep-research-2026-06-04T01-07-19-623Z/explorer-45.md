## Partition 45: Cross-platform native dependency audit for clipboard, WASM, ffmpeg, yt-dlp, gh, browser cookies, and paths

### Locator
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

### Pattern Finder
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

### Analyzer
## 1. Behavioral model

This partition is the repo’s **native-dependency boundary layer**: it concentrates all cross-platform “not pure TS” behavior that a Rust migration would need to replace, preserve, or shell out to.

Main behaviors:
- **Clipboard I/O**: tries native addon first, then platform CLIs, then OSC52 fallback.
- **Clipboard image ingestion**: handles paste/capture paths that differ across macOS, Linux/Wayland/X11, and WSL.
- **WASM image/runtime support**: patches `photon_rs_bg.wasm` lookup so the executable can find the asset beside itself.
- **Path normalization**: canonicalizes tilde, `file://`, cwd-relative formatting, and cloud-sync quirks.
- **Web/media tooling**: depends on `yt-dlp`, `ffmpeg`, `ffprobe`, `gh`, and browser-cookie extraction for specific fetch/search flows.

The key architectural point: these are not isolated helpers; they are **load-bearing compatibility shims** for the CLI, TUI, and web-access features.

## 2. Key flows and invariants

### Clipboard
- `clipboard-native.ts` loads `@mariozechner/clipboard` with platform/display guards.
- `clipboard.ts` uses a fallback ladder:
  1. native addon
  2. `termux-clipboard-set`
  3. `wl-copy`
  4. `xclip`
  5. `xsel`
  6. OSC52

**Invariant:** clipboard copy must work even when no native addon is available.

### Clipboard images
- `clipboard-image.ts` is platform-sensitive and knows about Wayland/X11, WSL, and image format conversion/capture paths.
- Tests show BMP/image conversion is part of the compatibility contract.

**Invariant:** pasted images must survive platform-specific encoding differences.

### WASM image pipeline
- `photon.ts` patches `fs.readFileSync` lookup behavior for `photon_rs_bg.wasm`.
- `scripts/build-binaries.sh` bundles the WASM asset and copied runtime assets into release artifacts.

**Invariant:** the binary must still locate the WASM asset after packaging/relocation.

### Paths
- `paths.ts` normalizes path forms and preserves cwd-relative display behavior.
- Tests cover canonicalization and Windows-ish edge cases.

**Invariant:** user-facing path formatting must remain stable across platforms and repo layouts.

### Web/media/native CLI dependencies
- `youtube-extract.ts` requires `yt-dlp` + `ffmpeg`.
- `video-extract.ts` requires `ffmpeg`/`ffprobe`.
- `github-api.ts` / `github-extract.ts` rely on `gh`.
- `chrome-cookies.ts` reads browser cookies via OS-specific credential stores / profile paths / SQLite DBs.
- `gemini-web-config.ts` and `gemini-web.ts` make browser-cookie support optional but structurally supported.

**Invariant:** these features degrade by environment, not by code path alone; availability checks and hints are part of the UX contract.

## 3. Tests / validation

Observed coverage targets:
- `clipboard-native.test.ts`
- `clipboard-image.test.ts`
- `clipboard-image-bmp-conversion.test.ts`
- `path-utils.test.ts`
- `paths.test.ts`
- `bash-close-hang-windows.test.ts`

What this suggests:
- Clipboard/native-path behavior is explicitly regression-tested.
- Path normalization is considered a stable contract.
- Windows edge cases already matter enough to have dedicated tests.

What is still unclear:
- Whether CI runs all package-local tests for `packages/coding-agent` and `packages/web-access`.
- Whether native-tool availability failures are tested as fallback/hint behavior, or only happy-path resolution.

## 4. Risks, unknowns, and verification steps

### Migration risks
- **Rust replacement scope is larger than helper code**: clipboard, media extraction, browser-cookie auth, and WASM asset loading all cross process/platform boundaries.
- **Shell-out vs reimplementation decision is unresolved**:
  - `gh`, `ffmpeg`, `yt-dlp` are usually best kept as subprocess dependencies.
  - clipboard and cookie access may need Rust crates or OS-specific bindings.
  - WASM asset lookup needs a new packaging story.
- **Path semantics are user-visible**; regressions will break prompts, logs, and file operations.

### Unknowns
- Exact native dependency list beyond the audited files.
- Whether release packaging already assumes a specific executable layout beyond current `bun build --compile` output.
- How much of browser-cookie support must survive in a Rust port versus being optional.

### Verify next
1. Audit `scripts/build-binaries.sh` against your intended Rust packaging model.
2. Decide per dependency: **Rust crate**, **subprocess bridge**, or **feature removal**.
3. Preserve or re-spec:
   - clipboard fallback order
   - image paste behavior
   - path canonicalization rules
   - availability checks and user-facing hints
4. Run platform-specific tests on macOS, Linux/Wayland/X11, Windows/WSL.

### Online Researcher
## 1. Relevant external facts

- **Rust paths are platform-native, not shell-aware.** `std::path` works with local path syntax, and `std::fs::canonicalize` resolves symlinks / returns an absolute path, but it does **not** expand `~` or parse `file://` URLs automatically.  
  Source: Rust docs for `std::path` and `std::fs::canonicalize`.

- **`yt-dlp` is a CLI downloader; `ffmpeg`/`ffprobe` are the common media pipeline dependencies.** `yt-dlp` docs say `ffmpeg` and `ffprobe` are strongly recommended/required for merging, conversion, and many post-processing tasks.  
  Sources: `yt-dlp` dependency docs, FAQ, and man page.

- **`gh repo clone` is a real CLI contract, not a library API.** GitHub CLI’s `gh repo clone <repository> [<directory>]` clones repos locally and depends on auth/config for private repos.  
  Source: GitHub CLI manual for `gh repo clone`.

- **Chromium cookies are stored in a profile DB and decrypted via OS secrets.** Your local implementation matches the common model: macOS uses Keychain; Linux typically uses Secret Service / `secret-tool`; cookie values live in a SQLite DB and may be encrypted.  
  Sources: local repo code + external Chromium-cookie tooling/docs surfaced in research.

- **`@mariozechner/clipboard` is a native Node clipboard addon backed by Rust (`clipboard-rs`).** It supports text, image, rich text, files, and HTML.  
  Source: npm registry package docs.

## 2. Local implications

- **Paths:** your TS path utilities are not a 1:1 stdlib port. In Rust you’ll need custom logic for:
  - `~` expansion
  - `file://` parsing
  - `@file` stripping
  - cwd-relative formatting
  - Unicode-space normalization
  - cloud-sync xattr / setfattr behavior

- **Clipboard:** this is already “native” under the hood. Migration options:
  - keep a subprocess/native boundary, or
  - replace with a Rust clipboard crate and expose a clean internal API.

- **WASM (`photon_rs_bg.wasm`):** your current workaround patches `fs.readFileSync` because the bundle expects the WASM next to the executable. In Rust, prefer:
  - embedding the WASM/resource, or
  - resolving assets relative to the executable with explicit fallback paths.

- **Video / YouTube:** your repo is currently CLI-driven:
  - `yt-dlp` for stream URLs
  - `ffmpeg` for frame extraction  
  A Rust rewrite can use crates for orchestration, but these external binaries still matter unless you replace them with Rust-native media tooling.

- **GitHub access:** `gh` is only used as a transport for API/clone operations. In Rust you can either:
  - keep shelling out to `gh`, or
  - switch to GitHub REST/GraphQL + git libraries.

- **Browser cookies:** this is the hardest native seam. A Rust port still needs:
  - profile discovery
  - OS secret-store access
  - SQLite access
  - decryption logic
  - browser-specific profile conventions

## 3. Version/API assumptions

- Rust `std::path` / `std::fs::canonicalize` behavior is stable, but **does not include shell conveniences** like `~` or `file://`.
- `yt-dlp`/`ffmpeg`/`gh` are assumed to remain external CLIs unless you intentionally replace them.
- Cookie decryption assumptions are browser/version-sensitive; Chromium profile formats and encryption schemes can change.

## 4. Unverified or unnecessary research

- I did **not** fully audit every transitive browser-cookie edge case across all Chromium variants.
- I did **not** verify exact minimum versions for `ffmpeg`, `yt-dlp`, or `gh` because the repo currently treats them as user-installed tools, not pinned deps.
- For this repo, external research was necessary mainly for the **native boundary definitions**; the actual migration plan should be driven by the local TS seams above.