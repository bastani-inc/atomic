I’m unable to write `/home/alexlavaee/Documents/projects/github_work/atomic-file-length-limit/research/subagents/issue-1445-remaining-splits.md` because this subagent only has read/search tools available and no file edit/write tool. I did not modify files.

Below is the report content to place in that file.

```md
## Analysis: Issue #1445 Remaining Oversized File Split Directions

### Overview
This pass inspected representative remaining tracked TS/JS/Rust files that still exceed the 500-line gate after the issue #1445 staging work, using the current `bun run check:file-length` scope rules as context. The files below are oversized because they combine public types/exports with multiple internal helper clusters or adapter/test scenario logic in a single module. The safest split direction is behavior-preserving extraction into sibling helper modules while keeping existing public import paths stable through the original files.

### Scope Notes
- The file-length gate is defined in `package.json:25` as `bun scripts/check-file-length.ts`.
- The repository policy documents that tracked `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, and `.rs` files are limited to 500 physical lines, with generated/vendored exclusions and first-five-line generated markers excluded from enforcement (`CLAUDE.md:83`).
- `packages/cursor/src/proto/agent_pb.ts` is very large, but it starts with generated markers (`packages/cursor/src/proto/agent_pb.ts:1-2`), so it is excluded by the documented generated-file rule and is not treated here as a behavior-preserving split candidate.

---

## 1. `packages/web-access/extract.ts`

### What It Contains
- Imports extraction backends and helpers for readability, RSC, PDF, GitHub, YouTube, Gemini URL context/web fallback, video extraction, frame extraction, activity logging, and concurrency limiting (`packages/web-access/extract.ts:1-13`).
- Defines extraction constants and basic error helpers:
  - `DEFAULT_TIMEOUT_MS`, `CONCURRENT_LIMIT`, `NON_RECOVERABLE_ERRORS`, `MIN_USEFUL_CONTENT` (`packages/web-access/extract.ts:15-19`)
  - `errorMessage`, `isConfigParseError`, `isAbortError`, `abortedResult`, and `safeVideoInfo` (`packages/web-access/extract.ts:20-41`)
- Defines public extraction shapes:
  - `VideoFrame` (`packages/web-access/extract.ts:52-56`)
  - `FrameData` / `FrameResult` (`packages/web-access/extract.ts:58-59`)
  - `ExtractedContent` (`packages/web-access/extract.ts:61-69`)
  - `ExtractOptions` (`packages/web-access/extract.ts:71-78`)
- Implements the Jina Reader fallback in `extractWithJinaReader()` (`packages/web-access/extract.ts:83-136`).
- Implements the main public orchestration function `extractContent()` (`packages/web-access/extract.ts:139-253`), which runs extraction in this order:
  1. Abort short-circuit (`packages/web-access/extract.ts:143-145`)
  2. Requested video frame extraction (`packages/web-access/extract.ts:147-148`)
  3. Local video detection and video extraction (`packages/web-access/extract.ts:150-163`)
  4. URL validation (`packages/web-access/extract.ts:166-170`)
  5. GitHub extraction (`packages/web-access/extract.ts:173-183`)
  6. YouTube extraction when enabled (`packages/web-access/extract.ts:185-210`)
  7. HTTP/readability extraction (`packages/web-access/extract.ts:214-218`)
  8. Jina fallback (`packages/web-access/extract.ts:221-223`)
  9. Gemini URL context / Gemini web fallback (`packages/web-access/extract.ts:225-236`)
  10. Human-readable fallback guidance (`packages/web-access/extract.ts:241-252`)
- Implements HTML/text helper functions:
  - `stripElementBlocks()` (`packages/web-access/extract.ts:255-284`)
  - `stripTags()` (`packages/web-access/extract.ts:286-302`)
  - `collapseWhitespace()` (`packages/web-access/extract.ts:304-319`)
  - `isLikelyJSRendered()` (`packages/web-access/extract.ts:322-336`)
- Implements HTTP/readability extraction in `extractViaHttp()` (`packages/web-access/extract.ts:338-480`), including:
  - Timeout setup and abort wiring (`packages/web-access/extract.ts:344-350`)
  - Browser-like request headers (`packages/web-access/extract.ts:354-366`)
  - HTTP status error result construction (`packages/web-access/extract.ts:369-378`)
  - response size checks (`packages/web-access/extract.ts:381-393`)
  - PDF extraction branch (`packages/web-access/extract.ts:396-414`)
  - unsupported content-type handling (`packages/web-access/extract.ts:417-429`)
  - non-HTML text handling (`packages/web-access/extract.ts:435-439`)
  - Readability parsing and RSC fallback (`packages/web-access/extract.ts:442-465`)
  - Markdown conversion and incomplete-content classification (`packages/web-access/extract.ts:468-477`)
  - error logging and abort cleanup (`packages/web-access/extract.ts:478-480`)
- Exports `extractHeadingTitle()` (`packages/web-access/extract.ts:483-487`) and `fetchAllContent()` (`packages/web-access/extract.ts:494-499`).

### Why It Remains Oversized
The file combines public type definitions, extraction orchestration, Jina fallback logic, HTTP/readability extraction, HTML heuristics, title extraction, abort/error helpers, and concurrency wrapping. The main size driver is that `extractContent()` and `extractViaHttp()` each contain multiple backend-specific branches in the same public module (`packages/web-access/extract.ts:139-253`, `packages/web-access/extract.ts:338-480`).

### Public Surfaces That Must Remain Stable
These exports are used by sibling modules through the current `./extract.js` specifier:
- `ExtractedContent` is imported by GitHub, content tools, Perplexity, storage, video, frames, web search, Exa, Gemini URL context, and formatting modules (`packages/web-access/github-extract.ts:5`, `packages/web-access/content-tools.ts:9`, `packages/web-access/perplexity.ts:6`, `packages/web-access/storage.ts:2`, `packages/web-access/video-extract.ts:10`, `packages/web-access/extract-frames.ts:4`, `packages/web-access/web-search-tool.ts:6`, `packages/web-access/exa.ts:8`, `packages/web-access/gemini-url-context.ts:4`, `packages/web-access/web-search-formatting.ts:1`).
- `fetchAllContent` is imported by content tools and web-search feature logic (`packages/web-access/content-tools.ts:9`, `packages/web-access/web-search-features.ts:2`).
- `extractHeadingTitle` is imported by video, YouTube, and Gemini URL-context extraction (`packages/web-access/video-extract.ts:10`, `packages/web-access/youtube-extract.ts:10`, `packages/web-access/gemini-url-context.ts:4`).
- The existing `./extract.js` import specifier must remain valid.

### Safest Split Pattern
Use `extract.ts` as the stable public barrel/orchestrator and extract sibling implementation modules:

1. `extract-types.ts`
   - Move `VideoFrame`, `FrameData`, `FrameResult`, `ExtractedContent`, and `ExtractOptions` from `packages/web-access/extract.ts:52-78`.
   - Re-export them from `extract.ts` so existing `import type { ExtractedContent } from "./extract.js"` remains valid.

2. `extract-errors.ts` or `extract-utils.ts`
   - Move `errorMessage`, `isConfigParseError`, `isAbortError`, `abortedResult`, and `safeVideoInfo` from `packages/web-access/extract.ts:20-41`.
   - Keep behavior identical by preserving exact string handling and return shapes.

3. `extract-jina.ts`
   - Move Jina constants and `extractWithJinaReader()` from `packages/web-access/extract.ts:80-136`.
   - Keep `activityMonitor` calls and `AbortSignal.any()` behavior unchanged.

4. `extract-html.ts`
   - Move `stripElementBlocks()`, `stripTags()`, `collapseWhitespace()`, `isLikelyJSRendered()`, `extractHeadingTitle()`, and `extractTextTitle()` from `packages/web-access/extract.ts:255-336` and `packages/web-access/extract.ts:483-491`.
   - Re-export `extractHeadingTitle` from `extract.ts`.

5. `extract-http.ts`
   - Move `extractViaHttp()` from `packages/web-access/extract.ts:338-480`.
   - Import HTML helpers from `extract-html.ts`.
   - Preserve the exact timeout, header, content-type, PDF, RSC fallback, markdown, and error-result behavior.

6. Leave `extract.ts` with:
   - public re-exports,
   - imports from sibling helpers,
   - `extractContent()` orchestration (`packages/web-access/extract.ts:139-253`),
   - `fetchAllContent()` (`packages/web-access/extract.ts:494-499`).

---

## 2. `packages/cursor/src/stream.ts`

### What It Contains
- Imports Cursor transport/state/model helpers and the `@earendil-works/pi-ai` stream interfaces (`packages/cursor/src/stream.ts:1-14`).
- Defines public `CursorStreamAdapterOptions` (`packages/cursor/src/stream.ts:16-23`).
- Defines internal runtime and timing constants:
  - `CursorStreamRuntime` (`packages/cursor/src/stream.ts:25-31`)
  - `DEFAULT_PAUSED_TURN_IDLE_TIMEOUT_MS`, `DEFAULT_STREAM_READ_TIMEOUT_MS`, `TOOL_CALL_BATCH_IDLE_TIMEOUT_MS` (`packages/cursor/src/stream.ts:33-35`)
- Defines internal read result unions (`packages/cursor/src/stream.ts:37-44`) and UUID helper (`packages/cursor/src/stream.ts:46-48`).
- Exports `CursorStreamAdapter` (`packages/cursor/src/stream.ts:50-344`), which:
  - Stores transport/conversation/UUID/timeout runtime state in a private `#runtime` field (`packages/cursor/src/stream.ts:51-63`)
  - Provides `streamSimple()` to create an assistant-message event stream and asynchronously run the Cursor stream (`packages/cursor/src/stream.ts:65-69`)
  - Disposes state/transport (`packages/cursor/src/stream.ts:71-74`)
  - Cleans up a session by canceling conversation state and discarding the wire conversation (`packages/cursor/src/stream.ts:76-79`)
  - Exposes lifecycle snapshots from conversation state and transport (`packages/cursor/src/stream.ts:81-83`)
  - Memoizes `CursorMessageReader` instances per `CursorRunStream` (`packages/cursor/src/stream.ts:85-91`)
  - Implements the main private `#runStream()` loop (`packages/cursor/src/stream.ts:93-344`)
- Implements stream/error/message helpers after the class:
  - `normalizeCursorReadError()` (`packages/cursor/src/stream.ts:346-348`)
  - `createOutputMessage()` (`packages/cursor/src/stream.ts:350-368`)
  - context-to-tool-result helpers (`packages/cursor/src/stream.ts:370-402`)
  - conversation identity derivation and hashing (`packages/cursor/src/stream.ts:404-442`)
  - image-input detection (`packages/cursor/src/stream.ts:444-453`)
  - stream mutation helpers for text, thinking, tool calls, and open-content closure (`packages/cursor/src/stream.ts:455-510`)
  - usage update mapping (`packages/cursor/src/stream.ts:512-526`)
  - read/timeout helper (`packages/cursor/src/stream.ts:528-560`)
- Exports factory `createCursorStreamAdapter()` (`packages/cursor/src/stream.ts:562-564`).

### Why It Remains Oversized
The file combines the public adapter class, Cursor run-loop state machine, conversation identity logic, stream-content mutation helpers, context serialization helpers, read timeout handling, and factory export. The main size driver is the `CursorStreamAdapter` implementation plus many private helper clusters that support `#runStream()` (`packages/cursor/src/stream.ts:50-344`, `packages/cursor/src/stream.ts:346-560`).

### Public Surfaces That Must Remain Stable
- `CursorStreamAdapterOptions` is exported from the module (`packages/cursor/src/stream.ts:16-23`).
- `CursorStreamAdapter` is exported and imported by the Cursor provider through the current `./stream.js` specifier (`packages/cursor/src/provider.ts:28`).
- `createCursorStreamAdapter()` is exported (`packages/cursor/src/stream.ts:562-564`).
- Tests import `CursorStreamAdapter` directly from `../../packages/cursor/src/stream.js`, so that path/specifier must remain valid (`test/unit/cursor-stream-01.test.ts:4`, `test/unit/cursor-stream-02.test.ts:4`, `test/unit/cursor-stream-03.test.ts:4`).

### Safest Split Pattern
Keep `stream.ts` as the public adapter entrypoint and move private helpers into sibling modules:

1. `stream-types.ts`
   - Move `CursorStreamRuntime`, `IteratorReadResult`, and `CursorReadRaceResult` from `packages/cursor/src/stream.ts:25-44`.
   - Keep `CursorStreamAdapterOptions` exported from `stream.ts`, or re-export it from `stream.ts` if moved.

2. `stream-output.ts`
   - Move output-message and stream mutation helpers:
     - `createOutputMessage()` (`packages/cursor/src/stream.ts:350-368`)
     - `appendTextDelta()` (`packages/cursor/src/stream.ts:455-467`)
     - `appendThinkingDelta()` (`packages/cursor/src/stream.ts:469-481`)
     - `appendToolCall()` (`packages/cursor/src/stream.ts:483-495`)
     - `closeOpenContent()` (`packages/cursor/src/stream.ts:497-510`)
     - `updateUsage()` (`packages/cursor/src/stream.ts:512-526`)
   - This keeps stream shape/event sequencing centralized without changing public imports.

3. `stream-context.ts`
   - Move context/tool-result/image helpers:
     - `getTrailingToolResults()` (`packages/cursor/src/stream.ts:370-378`)
     - `textFromToolResult()` (`packages/cursor/src/stream.ts:380-382`)
     - `textFromMessage()` (`packages/cursor/src/stream.ts:384-402`)
     - `hasImageInput()` (`packages/cursor/src/stream.ts:444-453`)

4. `stream-conversation-id.ts`
   - Move conversation identity helpers:
     - `deriveCursorConversationIdentity()` (`packages/cursor/src/stream.ts:404-408`)
     - `deriveCursorBridgeKeyFromSessionId()` (`packages/cursor/src/stream.ts:410-412`)
     - `deriveCursorWireConversationIdFromSessionId()` (`packages/cursor/src/stream.ts:414-416`)
     - `deriveCursorConversationKey()` (`packages/cursor/src/stream.ts:418-426`)
     - `hashCursorKey()` (`packages/cursor/src/stream.ts:428-430`)
     - `deterministicCursorConversationId()` (`packages/cursor/src/stream.ts:432-442`)
   - Export only the helpers needed by `stream.ts`; keep the public `stream.ts` API unchanged.

5. `stream-reader.ts`
   - Move `normalizeCursorReadError()` and `readNextCursorMessage()` from `packages/cursor/src/stream.ts:346-348` and `packages/cursor/src/stream.ts:528-560`.
   - Also move read-timeout constants if only used there.

6. Leave in `stream.ts`:
   - public `CursorStreamAdapterOptions`,
   - `CursorStreamAdapter`,
   - `createCursorStreamAdapter()`,
   - the main `#runStream()` orchestration.
   - Existing imports from `./stream.js` continue to work.

---

## 3. `packages/coding-agent/src/config.ts`

### What It Contains
- Imports filesystem/path/runtime helpers and local process/path utilities (`packages/coding-agent/src/config.ts:1-6`).
- Defines package/runtime detection:
  - `__filename` / `__dirname` (`packages/coding-agent/src/config.ts:11-12`)
  - `isBunBinary` (`packages/coding-agent/src/config.ts:18-20`)
  - `isBunRuntime` (`packages/coding-agent/src/config.ts:23`)
- Defines install-method types and self-update command shapes:
  - `InstallMethod` (`packages/coding-agent/src/config.ts:29`)
  - `SelfUpdateCommandStep` (`packages/coding-agent/src/config.ts:31-35`)
  - `SelfUpdateCommand` (`packages/coding-agent/src/config.ts:37-39`)
  - self-update command constructors (`packages/coding-agent/src/config.ts:41-56`)
- Implements install detection in `detectInstallMethod()` (`packages/coding-agent/src/config.ts:61-80`).
- Exports self-update helpers:
  - `getSelfUpdateCommand()` (`packages/coding-agent/src/config.ts:305-315`)
  - `getSelfUpdateUnavailableInstruction()` (`packages/coding-agent/src/config.ts:318-334`)
  - `getUpdateInstruction()` (`packages/coding-agent/src/config.ts:337-353`)
- Exports package-resource path helpers:
  - `getPackageDir()` (`packages/coding-agent/src/config.ts:356-383`)
  - `getThemesDir()` (`packages/coding-agent/src/config.ts:386-399`)
  - `getExportTemplateDir()` (`packages/coding-agent/src/config.ts:402-409`)
  - `getPackageJsonPath()` through `getBundledInteractiveAssetPath()` (`packages/coding-agent/src/config.ts:412-452`)
- Exports package/app config constants:
  - `PACKAGE_NAME` (`packages/coding-agent/src/config.ts:495`)
  - `APP_NAME`, `APP_TITLE`, `CONFIG_DIR_NAME`, `LEGACY_CONFIG_DIR_NAME`, `CONFIG_DIR_NAMES`, `VERSION`, `CHANGELOG_URL` (`packages/coding-agent/src/config.ts:498-505`)
- Exports environment-name constants:
  - `LEGACY_ENV_PREFIX` (`packages/coding-agent/src/config.ts:508`)
  - `ENV_AGENT_DIR` through `WORKFLOW_STAGE_SUBAGENT_GUARD_ENV` (`packages/coding-agent/src/config.ts:511-523`)
- Exports Codex fast-mode environment helpers:
  - `CodexFastModeEnvironmentSettings` (`packages/coding-agent/src/config.ts:525-545`)
  - serializer/parser/accessors (`packages/coding-agent/src/config.ts:547-570`)
- Exports environment helpers:
  - `getEnvNames()` (`packages/coding-agent/src/config.ts:574-577`)
  - `getEnvValue()` (`packages/coding-agent/src/config.ts:579-585`)
  - `hasEnvValue()` (`packages/coding-agent/src/config.ts:587-589`)
  - `setEnvValue()` (`packages/coding-agent/src/config.ts:591-593`)
- Exports user/project/config path helpers:
  - `expandTildePath()` (`packages/coding-agent/src/config.ts:595-599`)
  - `getShareViewerUrl()` (`packages/coding-agent/src/config.ts:602-610`)
  - `getAgentDir()` through `getDebugLogPath()` (`packages/coding-agent/src/config.ts:612-701`)

### Why It Remains Oversized
This file is a broad public configuration surface. It combines install detection, self-update command generation, package resource resolution, package/app metadata constants, environment variable naming/compatibility logic, Codex fast-mode serialization, and user/project path construction. Its size comes from the number of public exports rather than one single internal algorithm.

### Public Surfaces That Must Remain Stable
The module exposes many public constants/functions from `packages/coding-agent/src/config.ts`; these should remain importable from the current `config` module path. Especially stable:
- Runtime/install exports: `isBunBinary`, `isBunRuntime`, `InstallMethod`, `SelfUpdateCommand`, `detectInstallMethod()` (`packages/coding-agent/src/config.ts:18-29`, `packages/coding-agent/src/config.ts:37-39`, `packages/coding-agent/src/config.ts:61`)
- Update helpers (`packages/coding-agent/src/config.ts:305-353`)
- Package path helpers (`packages/coding-agent/src/config.ts:356-452`)
- Package/app constants (`packages/coding-agent/src/config.ts:495-505`)
- Environment constants and helpers (`packages/coding-agent/src/config.ts:508-593`)
- User/project path helpers (`packages/coding-agent/src/config.ts:595-701`)

### Safest Split Pattern
Use `config.ts` as a stable public barrel and extract implementation by domain:

1. `config-runtime.ts`
   - Move Bun/runtime detection and install-method detection:
     - `isBunBinary`, `isBunRuntime` (`packages/coding-agent/src/config.ts:18-23`)
     - `InstallMethod` (`packages/coding-agent/src/config.ts:29`)
     - `detectInstallMethod()` (`packages/coding-agent/src/config.ts:61-80`)
   - Re-export from `config.ts`.

2. `config-self-update.ts`
   - Move `SelfUpdateCommandStep`, `SelfUpdateCommand`, command constructors, and update helpers:
     - `packages/coding-agent/src/config.ts:31-56`
     - `packages/coding-agent/src/config.ts:305-353`
   - Preserve exact command arrays and display-string generation.

3. `config-package-paths.ts`
   - Move package directory/resource path helpers:
     - `getPackageDir()` through `getBundledInteractiveAssetPath()` (`packages/coding-agent/src/config.ts:356-452`)
   - Keep raw path behavior and compiled-binary detection behavior unchanged.

4. `config-app.ts`
   - Move package/app metadata loading and constants:
     - `PACKAGE_NAME`, `APP_NAME`, `APP_TITLE`, `CONFIG_DIR_NAME`, `LEGACY_CONFIG_DIR_NAME`, `CONFIG_DIR_NAMES`, `VERSION`, `CHANGELOG_URL` (`packages/coding-agent/src/config.ts:495-505`)
   - Re-export from `config.ts`.

5. `config-env.ts`
   - Move environment-name constants and generic env helpers:
     - `LEGACY_ENV_PREFIX` and `ENV_*` constants (`packages/coding-agent/src/config.ts:508-523`)
     - `getEnvNames()`, `getEnvValue()`, `hasEnvValue()`, `setEnvValue()` (`packages/coding-agent/src/config.ts:574-593`)

6. `config-codex-fast-mode.ts`
   - Move `CodexFastModeEnvironmentSettings` and serializer/parser/accessors (`packages/coding-agent/src/config.ts:525-570`).

7. `config-user-paths.ts`
   - Move user/project path helpers:
     - `expandTildePath()` through `getDebugLogPath()` (`packages/coding-agent/src/config.ts:595-701`)
   - Import constants/env helpers from the new sibling modules.
   - Re-export everything from `config.ts` to preserve callers.

---

## 4. `packages/coding-agent/src/modes/interactive/components/chat-message-renderer.ts`

### What It Contains
- Imports message, TUI, markdown theme, extension renderer, core message, skill parsing, theme, and component dependencies (`packages/coding-agent/src/modes/interactive/components/chat-message-renderer.ts:1-18`).
- Defines public render entry type `ChatMessageEntry` for assistant/tool/bash/user/custom/summary/system messages (`packages/coding-agent/src/modes/interactive/components/chat-message-renderer.ts:21-36`).
- Defines public render options `ChatMessageRenderOptions` (`packages/coding-agent/src/modes/interactive/components/chat-message-renderer.ts:38-49`).
- Exports `chatEntriesFromAgentMessages()` (`packages/coding-agent/src/modes/interactive/components/chat-message-renderer.ts:51-137`), which:
  - Converts agent messages into render entries.
  - Tracks pending tool calls by ID.
  - Inserts partial tool entries for assistant tool calls.
  - Updates pending tool entries when tool results arrive.
  - Filters legacy compaction summary messages.
- Defines `LiveChatEventLike` (`packages/coding-agent/src/modes/interactive/components/chat-message-renderer.ts:139-151`).
- Exports `LiveChatEntriesController` (`packages/coding-agent/src/modes/interactive/components/chat-message-renderer.ts:153-397`), which incrementally updates live chat entries from streamed events.
- Defines internal helper guards/converters:
  - `isChatMessageEntry()` (`packages/coding-agent/src/modes/interactive/components/chat-message-renderer.ts:399-401`)
  - `isLegacyCompactionSummaryMessage()` (`packages/coding-agent/src/modes/interactive/components/chat-message-renderer.ts:403-405`)
  - `isAgentMessageLike()` (`packages/coding-agent/src/modes/interactive/components/chat-message-renderer.ts:407-409`)
  - `assistantContentHasRenderablePayload()` (`packages/coding-agent/src/modes/interactive/components/chat-message-renderer.ts:411-422`)
  - `minimalAssistantMessage()` (`packages/coding-agent/src/modes/interactive/components/chat-message-renderer.ts:424-430`)
  - `toolResultFromUnknown()` (`packages/coding-agent/src/modes/interactive/components/chat-message-renderer.ts:432-459`)
- Exports `renderChatMessageEntry()` (`packages/coding-agent/src/modes/interactive/components/chat-message-renderer.ts:461-531`), which dispatches render entries to the correct component type.
- Defines rendering text helpers:
  - `userMessageComponent()` (`packages/coding-agent/src/modes/interactive/components/chat-message-renderer.ts:533-545`)
  - `getMessageText()` (`packages/coding-agent/src/modes/interactive/components/chat-message-renderer.ts:547-549`)
  - `messageContentText()` (`packages/coding-agent/src/modes/interactive/components/chat-message-renderer.ts:551-557`)

### Why It Remains Oversized
The file combines three related but separable responsibilities:
1. converting complete persisted agent messages into chat entries,
2. maintaining live streaming chat entries,
3. rendering a chat entry to a TUI component.

The `LiveChatEntriesController` class is the largest single cluster (`packages/coding-agent/src/modes/interactive/components/chat-message-renderer.ts:153-397`), while the module also contains public render dispatch and message conversion logic (`packages/coding-agent/src/modes/interactive/components/chat-message-renderer.ts:51-137`, `packages/coding-agent/src/modes/interactive/components/chat-message-renderer.ts:461-531`).

### Public Surfaces That Must Remain Stable
The module exports:
- `ChatMessageEntry` (`packages/coding-agent/src/modes/interactive/components/chat-message-renderer.ts:21-36`)
- `ChatMessageRenderOptions` (`packages/coding-agent/src/modes/interactive/components/chat-message-renderer.ts:38-49`)
- `chatEntriesFromAgentMessages()` (`packages/coding-agent/src/modes/interactive/components/chat-message-renderer.ts:51-137`)
- `LiveChatEventLike` (`packages/coding-agent/src/modes/interactive/components/chat-message-renderer.ts:139-151`)
- `LiveChatEntriesController` (`packages/coding-agent/src/modes/interactive/components/chat-message-renderer.ts:153-397`)
- `renderChatMessageEntry()` (`packages/coding-agent/src/modes/interactive/components/chat-message-renderer.ts:461-531`)

Although a repository-wide grep did not show direct `.js` imports of `chat-message-renderer.js` in tracked TS tests at the time of inspection, this file is a component module and its exported names should remain available from the same path to preserve current public/internal import behavior.

### Safest Split Pattern
Keep `chat-message-renderer.ts` as a stable barrel and extract by responsibility:

1. `chat-message-renderer-types.ts`
   - Move `ChatMessageEntry`, `ChatMessageRenderOptions`, and `LiveChatEventLike` (`packages/coding-agent/src/modes/interactive/components/chat-message-renderer.ts:21-49`, `packages/coding-agent/src/modes/interactive/components/chat-message-renderer.ts:139-151`).
   - Re-export from `chat-message-renderer.ts`.

2. `chat-message-entry-conversion.ts`
   - Move `chatEntriesFromAgentMessages()` and related guards:
     - `chatEntriesFromAgentMessages()` (`packages/coding-agent/src/modes/interactive/components/chat-message-renderer.ts:51-137`)
     - `isLegacyCompactionSummaryMessage()` (`packages/coding-agent/src/modes/interactive/components/chat-message-renderer.ts:403-405`)
   - Preserve pending tool-call map behavior and ordering.

3. `live-chat-entries-controller.ts`
   - Move `LiveChatEntriesController` and live-event helper functions:
     - class (`packages/coding-agent/src/modes/interactive/components/chat-message-renderer.ts:153-397`)
     - `isChatMessageEntry()` (`packages/coding-agent/src/modes/interactive/components/chat-message-renderer.ts:399-401`)
     - `isAgentMessageLike()` (`packages/coding-agent/src/modes/interactive/components/chat-message-renderer.ts:407-409`)
     - `assistantContentHasRenderablePayload()` (`packages/coding-agent/src/modes/interactive/components/chat-message-renderer.ts:411-422`)
     - `minimalAssistantMessage()` (`packages/coding-agent/src/modes/interactive/components/chat-message-renderer.ts:424-430`)
     - `toolResultFromUnknown()` (`packages/coding-agent/src/modes/interactive/components/chat-message-renderer.ts:432-459`)

4. `chat-message-entry-render.ts`
   - Move `renderChatMessageEntry()` and its local helpers:
     - `renderChatMessageEntry()` (`packages/coding-agent/src/modes/interactive/components/chat-message-renderer.ts:461-531`)
     - `userMessageComponent()` (`packages/coding-agent/src/modes/interactive/components/chat-message-renderer.ts:533-545`)
     - `getMessageText()` (`packages/coding-agent/src/modes/interactive/components/chat-message-renderer.ts:547-549`)
     - `messageContentText()` (`packages/coding-agent/src/modes/interactive/components/chat-message-renderer.ts:551-557`)

5. Leave `chat-message-renderer.ts` re-exporting the same public types/classes/functions from sibling modules so existing import paths remain stable.

---

## Cross-Cutting Split Guidance

### Preserve `.js` Import Specifiers
For TypeScript source modules that currently import siblings with `.js` specifiers, newly extracted sibling modules should also be imported with `.js` specifiers in authored TS. For example, `packages/web-access/video-extract.ts:10` imports from `./extract.js`, so `extract.ts` should remain the outward-facing module even if it internally imports from `./extract-types.js`, `./extract-http.js`, etc.

### Preserve Public Barrels
For each oversized public module, keep the original file as:
- the public import path,
- a re-export barrel for moved types/functions,
- and, where useful, the top-level orchestration layer.

This pattern is safest for:
- `packages/web-access/extract.ts`
- `packages/cursor/src/stream.ts`
- `packages/coding-agent/src/config.ts`
- `packages/coding-agent/src/modes/interactive/components/chat-message-renderer.ts`

### Preserve Raw TS Companion/Public Package Surfaces
Where package consumers or tests import directly from source paths, keep the original source file exports intact. This is explicit for Cursor stream tests importing `../../packages/cursor/src/stream.js` (`test/unit/cursor-stream-01.test.ts:4`, `test/unit/cursor-stream-02.test.ts:4`, `test/unit/cursor-stream-03.test.ts:4`) and for web-access modules importing `./extract.js` (`packages/web-access/content-tools.ts:9`, `packages/web-access/video-extract.ts:10`, `packages/web-access/youtube-extract.ts:10`).

### Prefer Sibling Helper Modules Over New Nested Public Paths
The lowest-risk split pattern is to create sibling implementation modules beside the oversized file, then have the existing file import/re-export them. This avoids changing package exports, test imports, raw TS companion paths, and runtime `.js` import specifiers.
```