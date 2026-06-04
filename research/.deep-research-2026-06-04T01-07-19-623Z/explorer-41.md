## Partition 41: Web content extraction for HTML, GitHub, PDF, YouTube, video, and subprocess tools

### Locator
## 1. Must-read paths

- `packages/coding-agent/package.json` — published CLI/package boundary (`atomic`, bin, build scripts, runtime deps).
- `packages/coding-agent/src/main.ts` — top-level orchestration; best place to see what a Rust CLI must replace.
- `packages/coding-agent/src/cli.ts` — process bootstrap / dispatch entrypoint.
- `packages/coding-agent/src/core/sdk.ts` — central session/runtime boundary (`createAgentSession()`).
- `packages/coding-agent/src/core/extensions/loader.ts` — dynamic TS/JS extension loading; biggest Rust compatibility risk.
- `packages/coding-agent/src/core/extensions/types.ts` — public extension ABI to preserve or redesign.
- `packages/coding-agent/src/core/session-manager.ts` — session persistence/branching contract.
- `packages/coding-agent/src/core/model-registry.ts` — provider/model/auth registry.
- `packages/coding-agent/src/core/tools/` — built-in tool surface (`read`, `bash`, `edit`, `write`, etc.).
- `packages/coding-agent/src/modes/interactive/` — TUI/interactive behavior.
- `packages/coding-agent/src/modes/rpc/` — headless RPC surface; likely easiest Rust-compatible interface.
- `packages/coding-agent/docs/{extensions,sdk,rpc,tui,packages,models,session-format}.md` — canonical behavior contracts.

## 2. Supporting paths

- `package.json`, `bunfig.toml`, `tsconfig.json`, `tsconfig.base.json`, `prek.toml` — workspace/runtime/tooling assumptions.
- `.github/workflows/test.yml`, `.github/workflows/publish.yml` — CI/release shape to preserve.
- `docs/ci.md` — explains how bundled companion packages ship today.
- `scripts/build-binaries.sh` — current binary distribution strategy.
- `scripts/bump-version.ts` — versioning workflow.
- `packages/workflows/package.json` — raw-TS companion package model.
- `packages/workflows/src/extension/workflow-module-loader.ts` — user workflow TS loading via `jiti`.
- `packages/workflows/src/runs/` — workflow execution/runtime semantics.
- `packages/subagents/src/runs/shared/pi-spawn.ts` — subprocess spawning vs in-process decision point.
- `packages/subagents/src/runs/shared/worktree.ts` — git worktree isolation.
- `packages/mcp/index.ts`, `packages/mcp/server-manager.ts` — MCP transport/proxy lifecycle.
- `packages/web-access/{extract.ts,github-extract.ts,video-extract.ts}` — HTML/GitHub/video extraction dependencies.
- `packages/intercom/broker/` — IPC protocol that could be rewritten cleanly in Rust.
- `test/unit`, `test/integration`, `packages/coding-agent/test/` — current verification surface.

## 3. Entry points / symbols

- `createAgentSession()` in `packages/coding-agent/src/core/sdk.ts`
- `main()` in `packages/coding-agent/src/main.ts`
- CLI arg parsing in `packages/coding-agent/src/cli/args.ts`
- Extension ABI types in `packages/coding-agent/src/core/extensions/types.ts`
- Extension loader in `packages/coding-agent/src/core/extensions/loader.ts`
- Session persistence in `packages/coding-agent/src/core/session-manager.ts`
- Model/provider registry in `packages/coding-agent/src/core/model-registry.ts`
- Workflow loader in `packages/workflows/src/extension/workflow-module-loader.ts`
- Subagent process bridge in `packages/subagents/src/runs/shared/pi-spawn.ts`
- MCP transport manager in `packages/mcp/server-manager.ts`
- Web extraction pipeline in `packages/web-access/extract.ts`

## 4. Gaps or uncertainty

- No Rust baseline exists here: no `Cargo.toml` / `*.rs` files were found.
- The biggest unknown is whether you want:
  - a full Rust rewrite,
  - a Rust host that still embeds/shells out to TS,
  - or a hybrid where only core runtime is Rust.
- Dynamic TS extension/workflow loading is the hardest compatibility boundary.
- External `pi-*` dependencies are load-bearing and not in this repo; their behavior must be replaced or wrapped.
- Some design docs/specs may be historical and not exactly match current tree layout.

If you want, I can next turn this into a **Rust migration map**: “replace first / wrap first / keep as-is” by subsystem.

### Pattern Finder
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

### Analyzer
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

### Online Researcher
## 1. Relevant external facts

- **No Rust baseline exists in this repo**: the research artifact found **no `Cargo.toml` or `*.rs` files**, so this is a greenfield Rust migration, not a port.
- **Bun/TypeScript runtime assumptions are baked in** today:
  - `packages/coding-agent` is the published CLI/package boundary.
  - `packages/workflows` and other companion packages ship as **raw TypeScript**.
- **Dynamic TS loading is a major compatibility boundary**:
  - `packages/coding-agent/src/core/extensions/loader.ts`
  - `packages/workflows/src/extension/workflow-module-loader.ts`
  These imply the current system can load user code at runtime, which Rust cannot mirror directly without an embedding or IPC strategy.
- **Current behavior is organized around a few core contracts**:
  - session/runtime creation: `createAgentSession()`
  - CLI bootstrap: `main()`
  - session persistence: `session-manager.ts`
  - model/provider registry: `model-registry.ts`
  - tool surface: `core/tools/`
  - RPC surface: `modes/rpc/`
  - interactive TUI: `modes/interactive/`
- **Load-bearing external dependencies are not in this repo**:
  - `pi-*` behavior is referenced but not vendored, so Rust migration must replace or wrap those semantics.

## 2. Local implications

- **Best migration order**:
  1. **Rust CLI shell + RPC/headless core**
  2. **Session manager + model registry + builtin tools**
  3. **Interactive TUI**
  4. **Extension/workflow runtime**
- **Hardest part is extension compatibility**:
  - If you need to preserve user-defined TS extensions/workflows, Rust should likely start as a **host/orchestrator** that shells out to TS or loads plugins over IPC.
  - A full native Rust plugin ABI would require redesigning the extension contracts.
- **The likely “stable seam” is RPC**:
  - The `modes/rpc/` surface is probably the easiest place to preserve behavior while swapping the implementation underneath.
- **Subprocess boundaries already exist**:
  - `subagents`, `mcp`, and `web-access` suggest there are already natural process/service boundaries that could become Rust-native wrappers or remain external helpers.
- **Worktree/session semantics should be preserved first**:
  - `session-manager.ts` and `subagents` worktree logic are likely user-visible behavior, so they should be migrated before “nice-to-have” UI details.

## 3. Version/API assumptions

- I’m assuming:
  - **TypeScript is the current source of truth**
  - **Bun is the current runtime/tooling**
  - **Rust migration means replacing the `@bastani/atomic` runtime layer**, not just adding a Rust helper binary
- I did **not** verify external Rust ecosystem choices yet (for example: `tokio`, `clap`, `serde`, `ratatui`, `reqwest`) because they are not needed to interpret this repo’s current structure.
- If you want a real implementation plan, the next decision is whether the target is:
  - **full rewrite**
  - **Rust host + TS compatibility layer**
  - **hybrid core in Rust, plugins in TS**

## 4. Unverified or unnecessary research

- Not needed yet:
  - exact Rust crate choices
  - platform-specific packaging details
  - binary distribution strategy in Rust
- Unverified:
  - how much of the `pi-*` behavior must remain API-compatible
  - whether TS extension loading must remain first-class
  - whether the interactive TUI must be preserved exactly or can be redesigned

If you want, I can turn this into a **module-by-module migration map**: “rewrite first / wrap first / keep TS for now.”