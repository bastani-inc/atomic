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