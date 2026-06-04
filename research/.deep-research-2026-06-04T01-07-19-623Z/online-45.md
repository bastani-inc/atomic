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