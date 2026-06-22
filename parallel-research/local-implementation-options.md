I could not write `/Users/norinlavaee/cursor-image-support/parallel-research/local-implementation-options.md` because this worker session has only read/search tools and no write/edit/shell tool. Findings are below for parent persistence.

## Analysis: Cursor image handling / PR #1387

### Overview

Images fail for Cursor because current Cursor provider registration advertises text-only model input, and the stream adapter rejects any user or tool-result image before invoking Cursor transport. PR #1387 appears to add that explicit pre-transport rejection and user-facing fallback guidance rather than adding true image transport.

### Entry Points

- `packages/coding-agent/src/cli/file-processor.ts:51-77` — `@image` CLI files become `ImageContent` attachments.
- `packages/coding-agent/src/core/agent-session.ts:1287-1295` — prompt text plus `currentImages` are assembled into a user message.
- `packages/cursor/src/provider.ts:121-124` — Cursor provider delegates every request to `CursorStreamAdapter.streamSimple`.
- `packages/cursor/src/stream.ts:92-98` — Cursor stream setup validates auth, then rejects image input before opening transport.

### Why images currently fail for Cursor

**Severity: blocking for Cursor image prompts**

1. Image attachments enter the normal prompt path:
   - `processFileArguments()` detects supported image MIME types and creates `{ type: "image", mimeType, data }` blocks at `packages/coding-agent/src/cli/file-processor.ts:51-77`.
   - `AgentSession` appends those images to the user content array after the text part at `packages/coding-agent/src/core/agent-session.ts:1287-1295`.

2. Cursor models are declared as text-only:
   - `CursorProviderModelDefinition.input` is typed as `["text"]` at `packages/cursor/src/model-mapper.ts:28-35`.
   - `mapCursorCatalogToProviderModels()` hardcodes `input: ["text"]` for every mapped Cursor model at `packages/cursor/src/model-mapper.ts:89-99`.

3. Cursor stream adapter rejects image content before transport:
   - `CURSOR_IMAGE_INPUT_ERROR` says Cursor supports text input only and suggests removing image content or switching to a vision-capable provider at `packages/cursor/src/stream.ts:36`.
   - `#runStream()` checks `hasImageInput(context)` and throws that error before request-id creation or `transport.run()` at `packages/cursor/src/stream.ts:92-98`.
   - `hasImageInput()` returns true for user messages whose content array contains an image, and for tool-result messages whose content contains an image at `packages/cursor/src/stream.ts:446-452`.

4. Even if the guard were removed, current Cursor protobuf encoding drops image data:
   - `encodeRunRequest()` builds the Cursor request from `extractCurrentActionText(request)` and `parseHistoricalTurns(...)`, not from rich multimodal content, at `packages/cursor/src/proto/protobuf-codec.ts:154-166`.
   - `extractCurrentActionText()` delegates to `textFromMessage()` at `packages/cursor/src/proto/protobuf-codec.ts:666-669`.
   - `textFromMessage()` converts user content arrays by keeping only text parts and joining them with newlines at `packages/cursor/src/proto/protobuf-codec.ts:675-678`.
   - `rawToolResultText()` likewise keeps only text parts from tool results at `packages/cursor/src/proto/protobuf-codec.ts:671-673`.

### What PR #1387 changes

Based on the current worktree, PR #1387’s local implementation is the explicit rejection path:

- Adds/uses a dedicated error message constant at `packages/cursor/src/stream.ts:36`.
- Adds `hasImageInput(context)` detection for user and tool-result images at `packages/cursor/src/stream.ts:446-452`.
- Calls that detector before Cursor transport invocation at `packages/cursor/src/stream.ts:92-98`.
- Adds test coverage:
  - user image input rejected before transport, with “text input only”, “images/screenshots”, and “vision-capable provider” guidance at `test/unit/cursor-stream.test.ts:783-801`.
  - tool-result image input rejected before resume, with same guidance and no credential leak at `test/unit/cursor-stream.test.ts:804-831`.

The PR does **not** implement Cursor image transport, fallback routing, or central model capability gating in the inspected code. It prevents silent image dropping by failing early with richer guidance.

## Local implementation options

### Option A — True Cursor image transport

Required local changes:

- Extend Cursor model definitions from text-only to image-capable only if Cursor protocol support is known:
  - `CursorProviderModelDefinition.input` currently only allows `["text"]` at `packages/cursor/src/model-mapper.ts:28-35`.
  - `mapCursorCatalogToProviderModels()` hardcodes `input: ["text"]` at `packages/cursor/src/model-mapper.ts:89-99`.

- Replace the rejection in `CursorStreamAdapter`:
  - Remove or conditionally bypass `hasImageInput(context)` throw at `packages/cursor/src/stream.ts:92-98`.
  - Keep detection for deciding whether to encode image-bearing request payloads.

- Implement image serialization in Cursor protobuf request construction:
  - `encodeRunRequest()` currently passes only text/historical turns into `buildCursorRequest()` at `packages/cursor/src/proto/protobuf-codec.ts:154-166`.
  - `textFromMessage()` and `rawToolResultText()` currently strip images at `packages/cursor/src/proto/protobuf-codec.ts:671-678`.
  - Need to map Atomic `ImageContent { data, mimeType }` into Cursor’s actual protobuf image fields. Generated protobuf includes image-related generated types/comments around `packages/cursor/src/proto/agent_pb.ts:8440-8478`, but current request builder does not use them.

Implementation risks:
- **High**: Cursor’s private headless provider API may not accept images even if generated protobuf contains image content items.
- **High**: Incorrect blob/checkpoint encoding may break conversation state because run state is persisted through blob stores in `packages/cursor/src/proto/protobuf-codec.ts:154-166` and committed later.
- **Medium**: Tool-result image semantics need separate mapping from user prompt image semantics because `rawToolResultText()` currently returns text-only.

### Option B — Automatic fallback to another vision provider

Required local changes:

- Add routing before `CursorStreamAdapter.streamSimple()` is called:
  - Cursor provider currently directly calls `streamAdapter.streamSimple(model, context, streamOptions)` at `packages/cursor/src/provider.ts:121-124`.
  - At this layer the provider does not have a documented alternative model/provider selection mechanism.

- Or implement fallback at `AgentSession` before `agent.prompt()`:
  - `AgentSession` builds user content with images at `packages/coding-agent/src/core/agent-session.ts:1287-1295`.
  - `_runAgentPrompt()` then calls `this.agent.prompt(messages)` at `packages/coding-agent/src/core/agent-session.ts:1328-1332`.
  - A fallback strategy would need to inspect selected `this.model`, message images, and available configured vision-capable models before calling the agent.

- Use existing capability metadata:
  - Models expose `input` capability through model definitions; Cursor maps to `["text"]` at `packages/cursor/src/model-mapper.ts:89-99`.
  - CLI model listing already surfaces image support via `m.input.includes("image")` at `packages/coding-agent/src/cli/list-models.ts:67`.

Implementation risks:
- **High**: Automatic provider switching changes user-selected model/provider semantics and credential requirements.
- **Medium**: Conversation continuity may be provider-specific; switching mid-session can change tool-call and reasoning behavior.
- **Medium**: Need deterministic fallback selection rules when multiple configured vision providers exist.

### Option C — Model capability gating

Required local changes:

- Add central preflight validation in `AgentSession` after message construction and before `this.agent.prompt(messages)`:
  - Images are available as `currentImages` at `packages/coding-agent/src/core/agent-session.ts:1209-1222`.
  - Final user content is built at `packages/coding-agent/src/core/agent-session.ts:1287-1295`.
  - Model validation/auth checks happen at `packages/coding-agent/src/core/agent-session.ts:1246-1278`; image capability gating could live nearby.

- Gate on selected model input:
  - Cursor model `input` is `["text"]` at `packages/cursor/src/model-mapper.ts:89-99`.
  - Other models may include `"image"` per custom provider docs and model schemas, with registry schema accepting `"text" | "image"` at `packages/coding-agent/src/core/model-registry.ts:156-176`.

- Decide whether tool-result images should be gated at agent continuation time too:
  - Cursor currently checks both user and tool-result images in `hasImageInput()` at `packages/cursor/src/stream.ts:446-452`.

Implementation risks:
- **Medium**: Gating only initial user images will not catch tool-result images unless continuation paths are also validated.
- **Medium**: Some providers may accept images despite incomplete metadata; gating depends on model catalog accuracy.
- **Low/Medium**: Extensions can transform input images before model execution at `packages/coding-agent/src/core/agent-session.ts:1209-1222`, so validation must run after extension transforms.

### Option D — Richer UX guidance

Required local changes:

- Improve current Cursor-specific message:
  - Existing message is at `packages/cursor/src/stream.ts:36`.
  - Current tests assert broad guidance terms at `test/unit/cursor-stream.test.ts:783-831`.

- Include selected model/provider and actionable commands:
  - Could mention Cursor text-only, suggest `/model` to select a model with image support, or settings to block images.
  - Settings already include `blockImages` and `autoResize` in `packages/coding-agent/src/core/settings-manager.ts:42-50`.
  - Interactive settings label “Block images” says it prevents images from being sent to LLM providers at `packages/coding-agent/src/modes/interactive/components/settings-selector.ts:410-414`.

- Optionally centralize provider capability error formatting near other user-facing model/auth errors:
  - `AgentSession` formats no-model/unresolved/auth errors around `packages/coding-agent/src/core/agent-session.ts:1246-1278`.

Implementation risks:
- **Low**: Message-only changes are least invasive.
- **Medium**: If guidance names specific providers or commands, tests and docs can drift as providers/models change.
- **Low/Medium**: Cursor-specific stream errors occur after the agent run starts, while central preflight UX would produce earlier feedback.

## Review findings

- **Blocking / Cursor images unsupported** — `packages/cursor/src/stream.ts:92-98`, `packages/cursor/src/stream.ts:446-452`: any image in user or tool-result context causes an error before Cursor transport.
- **Blocking / no image serialization path** — `packages/cursor/src/proto/protobuf-codec.ts:154-166`, `packages/cursor/src/proto/protobuf-codec.ts:671-678`: request encoding converts rich content to text-only strings, dropping image parts.
- **Informational / capability metadata says text-only** — `packages/cursor/src/model-mapper.ts:28-35`, `packages/cursor/src/model-mapper.ts:89-99`: Cursor models expose `input: ["text"]`.
- **Informational / PR improves failure mode** — `test/unit/cursor-stream.test.ts:783-831`: tests assert early rejection, provider fallback guidance, no transport/resume call, and no access token leak.

## Residual risks

- No write tool was available, so the requested markdown file was not created by this worker.
- PR diff metadata could not be inspected via git commands; conclusions are based on current worktree implementation and tests.
- True Cursor image transport feasibility depends on Cursor private protocol behavior not proven by current code.