## 1. Behavioral model

This partition is the repo’s **content-ingestion layer** for URLs and local media:

- `packages/web-access/extract.ts` is the orchestrator. It routes by input type to:
  - generic HTML/RSC extraction,
  - GitHub repo/file extraction,
  - PDF extraction,
  - YouTube extraction,
  - local video extraction,
  - fallback web services (`jina`, Gemini web/API).
- `packages/web-access/github-extract.ts` turns GitHub URLs into either:
  - a cloned local repo, or
  - API-driven file/tree rendering.
- `packages/web-access/pdf-extract.ts` decodes PDF bytes to markdown and writes the result to disk.
- `packages/web-access/video-extract.ts` handles local video files via `ffmpeg/ffprobe`, and online video via Gemini web/API.
- `packages/subagents/src/runs/shared/pi-spawn.ts` is not content extraction itself, but it is a **subprocess-resolution primitive** used by adjacent orchestration code. It determines how the CLI is spawned across environments, which matters if a Rust rewrite changes binary layout or package resolution.

For a Rust migration, this partition is mostly about deciding what becomes:
- native Rust parsing/IO,
- subprocess bridges (`git`, `gh`, `ffmpeg`, `ffprobe`),
- or retained JS compatibility for browser-like parsing/AI provider logic.

## 2. Key flows and invariants

### HTML / generic web flow
- `extractContent()` first checks abort state.
- If frame extraction isn’t requested, it tries specialized paths before generic HTML.
- Generic HTML path depends on:
  - `Readability`
  - `linkedom`
  - `Turndown`
  - concurrent fetch limiting (`p-limit`, limit = 3)
  - timeout/error classification (`abort`, config parse, non-recoverable content issues).

**Invariant:** non-recoverable errors like “Unsupported content type” and “Response too large” should stop fallback churn; aborts always return an aborted result.

### GitHub flow
- `parseGitHubUrl()` distinguishes:
  - repo root,
  - `blob`,
  - `tree`,
  - and rejects non-code GitHub sections.
- `github-extract.ts` uses:
  - config from `web-search.json`,
  - clone caching,
  - `gh repo clone` first, then `git clone` fallback.
- It filters binary files, noise dirs, and oversized repos/files.

**Invariant:** repo cloning is cached by `owner/repo@ref`; invalid/too-large repos should fail cleanly without poisoning the cache.

### PDF flow
- `isPDF()` uses content-type or `.pdf` extension.
- `extractPDFToMarkdown()`:
  - bounds pages to `maxPages` (default 100),
  - extracts page text sequentially,
  - writes markdown to `~/Downloads` by default,
  - returns metadata + output path.
- Filename derivation is sanitized and arXiv-aware.

**Invariant:** extraction is intentionally lossy/truncated for huge PDFs, but must still emit a usable markdown artifact.

### YouTube / video flow
- `extractContent()` can request:
  - a whole video transcript,
  - a single frame,
  - or multiple frames across a timestamp/range.
- Local video path uses `ffmpeg`/`ffprobe`.
- Online video path prefers Gemini web/API.
- Frame extraction supports both single timestamp and range synthesis.

**Invariant:** frame extraction is only valid for YouTube or local video files; duration must be discoverable before range sampling.

### Subprocess resolution flow
- `pi-spawn.ts` resolves the coding-agent binary path by:
  - checking current argv entry,
  - walking up to a package root,
  - falling back to installed package resolution,
  - finally falling back to `APP_NAME` on PATH.
- This is used by subagent runners to spawn the correct CLI.

**Invariant:** the spawn path must work both from source checkout and installed package layouts, including Windows-ish resolution fallbacks.

## 3. Tests / validation

Evidence here is **stronger for subprocess resolution than for extraction**:

- There are explicit unit tests for `packages/subagents/src/runs/shared/pi-spawn.ts`:
  - `test/unit/subagents-pi-spawn.test.ts`
- The broader repo has many tests around integration/runtime, but I did **not** see direct test filenames for:
  - `extract.ts`
  - `github-extract.ts`
  - `pdf-extract.ts`
  - `video-extract.ts`

So validation for this partition appears to rely on:
- indirect integration coverage,
- manual/browser-backed behavior,
- and runtime error handling rather than dedicated extraction unit suites.

## 4. Risks, unknowns, and verification steps

### Main Rust migration risks
- **HTML parsing stack is JS-heavy**: `Readability`, `linkedom`, `turndown` have no trivial 1:1 Rust equivalent.
- **GitHub cloning is subprocess-driven**: keep `git`/`gh` or reimplement transport/auth.
- **PDF/video extraction are toolchain dependent**:
  - PDF: `unpdf`
  - video: `ffmpeg`/`ffprobe`
- **AI/web fallback behavior is coupled to browser/session state** (`Gemini web`, cookies, availability checks).
- **Path/config behavior is user-visible** (`.atomic`, config files, Downloads output).

### Unknowns
- Whether there are hidden fixtures/tests for web-access outside the obvious test names.
- How much of the current fallback ordering is intentional vs incidental.
- Whether you want Rust to replace only the orchestration, or also the extraction engines.

### Verify next
1. Trace the call sites into `extractContent()` and `extractGitHub()` to see which callers depend on exact error strings and return shape.
2. Inspect any tests under `packages/web-access` specifically, if present.
3. Inventory subprocess contracts:
   - `git`, `gh`, `ffmpeg`, `ffprobe`
   - exact exit-code / stderr expectations.
4. Decide migration boundary:
   - **Rust orchestrator + JS extraction helpers**, or
   - **full native extraction pipeline** with subprocess fallbacks.