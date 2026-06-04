## 1. Established patterns

- **Single orchestration entrypoint with layered fallbacks**
  - `packages/web-access/extract.ts::extractContent()` is the main dispatcher.
  - Pattern: special-case structured inputs first, then fall back in a fixed order:
    1. local video
    2. GitHub
    3. YouTube
    4. raw HTTP
    5. Jina reader
    6. Gemini URL context / Gemini web
  - This is a consistent “best-effort extraction pipeline,” not a single parser.

- **Capability detection before work**
  - Examples:
    - `isYouTubeURL()` / `isYouTubeEnabled()` in `youtube-extract.ts`
    - `isVideoFile()` / config-gated video support in `video-extract.ts`
    - `isPDF()` in `pdf-extract.ts`
    - `parseGitHubUrl()` in `github-extract.ts`
  - The code prefers “can I handle this?” checks before any expensive fetch/process.

- **Heuristic-first HTML extraction**
  - `extract.ts::extractViaHttp()` uses:
    - `@mozilla/readability` for article extraction
    - `linkedom` for parsing
    - `turndown` for markdown conversion
    - `extractRSCContent()` as a fallback for React Server Components-ish payloads
  - If `Readability` fails, it does not immediately error; it tries alternate structure-based detection.

- **Hardening around failures and aborts**
  - Repeated patterns:
    - `isAbortError()` / abort-aware returns
    - `isConfigParseError()` / `shouldRethrow()`
    - `activityMonitor.logComplete(...)` on success or abort, `logError(...)` on real failures
  - This shows a strong convention: user cancellation is not treated as an error.

- **Config-driven behavior with cached JSON loading**
  - `github-extract.ts`, `video-extract.ts`, `youtube-extract.ts`, and `web-access/index.ts` all read JSON config from Atomic config paths and cache it in module scope.
  - Common shape:
    - read config once
    - validate/normalize fields manually
    - use defaults when invalid or missing

- **Native subprocesses for media extraction**
  - `video-extract.ts` and `youtube-extract.ts` use:
    - `ffmpeg`
    - `ffprobe`
    - `yt-dlp`
  - Media extraction is intentionally delegated to system binaries rather than implemented in TS.

- **“Extract structured output, then decorate it”**
  - `youtube-extract.ts` and `video-extract.ts` often return `ExtractedContent` plus optional `thumbnail`, `frames`, or `duration`.
  - `web-access/index.ts::stripThumbnails()` exists to trim extra payload when needed.

- **GitHub content extraction is repository-aware**
  - `github-extract.ts` distinguishes root/blob/tree URLs via `parseGitHubUrl()`.
  - It also filters non-code segments like `issues`, `pulls`, `actions`, etc., so only repo content paths are treated as extractable.

## 2. Variations / exceptions

- **PDF extraction is a simpler one-way conversion**
  - `pdf-extract.ts` directly converts pages to markdown and writes to disk.
  - Unlike HTML/GitHub/YouTube, it does not participate in the richer multi-fallback chain.

- **Video and YouTube are similar but not identical**
  - `video-extract.ts` handles local files and Gemini-based analysis.
  - `youtube-extract.ts` handles remote YouTube URLs via `yt-dlp` + `ffmpeg` and optional Gemini/Perplexity fallback.
  - Both support frame extraction, but only YouTube has stream URL resolution.

- **Web search code-search is a tool proxy, not extraction**
  - `code-search.ts` is a separate pattern: it routes to MCP tools (`get_code_context_exa`) and falls back to broader Exa web search if missing.
  - It shares the “fallback strategy” pattern, but not the content extraction pipeline.

- **Gemini URL-context extraction is a specialized fallback**
  - `gemini-url-context.ts` uses the Gemini API `url_context` tool.
  - This is only used after local HTML extraction fails, so it is a late-stage rescue path.

## 3. Anti-patterns or risks

- **High dependency on external binaries and services**
  - `ffmpeg`, `ffprobe`, `yt-dlp`, Gemini API/web cookies, Jina reader, Perplexity, Exa, `gh`.
  - Migration risk: extraction quality and coverage are not self-contained.

- **Multiple overlapping fallbacks can obscure root cause**
  - A failing URL may silently traverse several mechanisms before returning an error.
  - Good for resilience, but harder to debug and harder to make deterministic in a Rust rewrite.

- **Config parsing is duplicated across modules**
  - `video-extract.ts`, `youtube-extract.ts`, and `github-extract.ts` each reimplement:
    - JSON read
    - parse try/catch
    - normalization
    - defaults
  - This is a maintainability smell, though it is also a recognizable repo convention.

- **Extraction logic mixes orchestration, IO, and formatting**
  - `extract.ts` does transport, parsing, heuristics, fallback selection, and output shaping in one place.
  - That coupling will be expensive to port if you want clean Rust module boundaries.

- **PDF extractor is structurally inconsistent**
  - `pdf-extract.ts` uses different style/formatting than the rest of `web-access` (more imperative, less standardized).
  - It’s functional, but less aligned with the rest of the extraction architecture.

## 4. Evidence index

- `packages/web-access/extract.ts`
  - `extractContent()`, `extractViaHttp()`, `computeRangeTimestamps()`, `isLikelyJSRendered()`
  - fallback order and HTML extraction pipeline
- `packages/web-access/github-extract.ts`
  - `parseGitHubUrl()`, repo/type detection, clone + file/tree handling
- `packages/web-access/video-extract.ts`
  - config gating, `extractVideo()`, `extractVideoFrame()`, `getLocalVideoDuration()`
- `packages/web-access/youtube-extract.ts`
  - `isYouTubeURL()`, `getYouTubeStreamInfo()`, `extractYouTubeFrame(s)`, thumbnail handling
- `packages/web-access/pdf-extract.ts`
  - direct PDF-to-markdown conversion flow
- `packages/web-access/code-search.ts`
  - MCP tool fallback pattern
- `packages/web-access/gemini-url-context.ts`
  - Gemini URL-context fallback extraction
- `packages/web-access/index.ts`
  - extension registration, provider/workflow config, `fetchAllContent()`, result shaping