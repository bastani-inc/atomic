# Cursor protocol image/blob attachment feasibility probe

Date: 2026-06-15  
Scope: inspect-only review of local repo and installed dependencies; no source/test edits. One report file was written here.

## Bottom line

**Feasibility: medium for a gated serialization experiment; low for enabling by default today.**

The vendored Cursor protobuf descriptors already contain several image/blob-bearing shapes that can be serialized through the current HTTP/2 Connect transport. A local, non-network round-trip experiment successfully encoded a full `AgentClientMessage.runRequest` containing normal user text plus a `SelectedContext.selectedImages[0]` inline PNG byte payload, framed it with `encodeCursorConnectFrame`, decoded it back, and verified the text and image fields survived.

However, the production Cursor provider intentionally advertises and enforces text-only behavior. Current stream tests assert that user and tool-result images are rejected before the transport is invoked. If that guard were simply removed, the current codec would still drop image content because it extracts only text blocks and creates empty `SelectedContext` messages. So the transport can carry image bytes, but the current application wiring cannot send images without code changes and remote Cursor acceptance is unproven.

## Review findings

### 1. Generated Cursor protocol has image/blob attachment-like shapes

Severity: **informational / enabling evidence**

- `packages/cursor/src/proto/agent_pb.ts:1812-1856` — `agent.v1.UserMessage` has `text`, optional `selected_context`, optional `rich_text`, and optional `bytes selected_context_blob` fields. This is the direct user-message envelope used by `AgentRunRequest`.
- `packages/cursor/src/proto/agent_pb.ts:11198-11202` — `agent.v1.SelectedContext` has `repeated agent.v1.SelectedImage selected_images = 1`.
- `packages/cursor/src/proto/agent_pb.ts:10409-10455` — `agent.v1.SelectedImage` has `uuid`, `path`, `dimension`, `mime_type`, and a `data_or_blob_id` oneof with `blobId`, inline `data`, or `blobIdWithData`.
- `packages/cursor/src/proto/agent_pb.ts:10464-10479` — `SelectedImage_BlobIdWithData` explicitly contains both `blob_id` and raw `data`, described as allowing a client to populate the server-side cache without re-uploading.
- `packages/cursor/src/proto/agent_pb.ts:10003-10036` — `ImageProto` is described as “same as SelectedImage, but with the data field is the full image data”; it carries raw bytes, uuid, path, dimension, task-specific description, and MIME type.
- `packages/cursor/src/proto/agent_pb.ts:8465-8514` — MCP tool-result content supports image blocks: `McpImageContent` has raw bytes plus MIME type, and `McpToolResultContentItem` is a text-or-image oneof.
- `packages/cursor/src/proto/agent_pb.ts:7873-7914` — KV control messages support arbitrary blob bytes via `GetBlobArgs/GetBlobResult` and `SetBlobArgs`. Existing codec state already stores and answers blobs by SHA-256-like byte ids.
- `packages/cursor/src/proto/agent_pb.ts:7286-7358` and `:7386-7395` — `GenerateImageToolCall` exists, but this is an image-generation tool result path (`description`, `filePath`, reference image paths, base64 output), not direct user attachment support.

Interpretation: the protobuf surface has plausible user-image and tool-result-image carriers. The safest user-image candidate is `UserMessage.selectedContext.selectedImages[]` with either inline `data` for small images or `blobIdWithData` to exercise Cursor’s blob cache path.

### 2. Current Atomic Cursor code deliberately blocks images before transport

Severity: **high blocker for any current runtime experiment through public APIs**

- `packages/cursor/src/stream.ts:36` defines the runtime error: `Cursor supports text input only; images/screenshots are not supported by Cursor's headless provider API...`.
- `packages/cursor/src/stream.ts:115-117` throws that error before constructing or sending a Cursor run request.
- `packages/cursor/src/stream.ts:445-450` detects image blocks in both user messages and tool-result messages.
- `test/unit/cursor-stream.test.ts:783-801` asserts user-image input produces an error and `transport.runs.length === 0`.
- `test/unit/cursor-stream.test.ts:804-830` asserts tool-result images are rejected before resume.
- `packages/cursor/README.md:13-18` documents “Text input only” and says images/screenshots are unsupported in Cursor's headless provider API.

Interpretation: a live experiment cannot be conducted via `CursorStreamAdapter.streamSimple` without changing or bypassing this guard. That guard is intentional and covered by tests.

### 3. If the image guard were bypassed, current codec would still not serialize images

Severity: **high implementation gap**

- `packages/cursor/src/proto/protobuf-codec.ts:154-169` builds run requests from `extractCurrentActionText(...)`, historical parsed text/tool turns, and a generated `buildCursorRequest(...)`; no image extraction is performed.
- `packages/cursor/src/proto/protobuf-codec.ts:317-323` constructs a `selectedContextBlob` from only root/system prompt blob ids and then calls `createUserMessage(userText, selectedContextBlob)`.
- `packages/cursor/src/proto/protobuf-codec.ts:374-383` creates `UserMessage` with `selectedContext: create(SelectedContextSchema, {})`; no `selectedImages` are populated.
- `packages/cursor/src/proto/protobuf-codec.ts:670-677` only joins `part.type === "text"` blocks for tool results and user content arrays. Image blocks would be ignored if not rejected earlier.
- `packages/cursor/src/proto/protobuf-codec.ts:621-625` creates MCP success content with a single text item only; it does not use `McpImageContentSchema`.
- `packages/cursor/src/transport.ts:81-88` defines `CursorToolResultMessage` as `{ text: string; isError: boolean; ... }`; there is no content array for image tool results.

Interpretation: enabling image serialization requires codec changes, not just removing the stream-layer rejection.

### 4. Current model metadata and tests lock Cursor provider to text input

Severity: **medium compatibility/test expectation blocker**

- `packages/cursor/src/model-mapper.ts:25-33` types `CursorProviderModelDefinition.input` as exactly `["text"]`.
- `packages/cursor/src/model-mapper.ts:90-99` maps every Cursor catalog model to `input: ["text"]`.
- `test/unit/cursor-model-mapper.test.ts:27-33` asserts mapped Cursor models have `input === ["text"]`.
- `node_modules/@earendil-works/pi-ai/dist/types.d.ts:165-195` shows the installed public `pi-ai` framework supports `ImageContent` in user messages, and `:211-216` supports images in tool-result messages. The limitation is therefore Cursor-provider-specific, not a general Pi type-system limitation.

Interpretation: even if the protocol can serialize images, the provider contract currently tells callers not to send them. Keep this metadata unchanged until remote proof exists, or gate any experiment outside normal model discovery/selection.

### 5. Transport is byte-oriented and likely safe for text if a codec experiment is gated

Severity: **low transport risk / positive feasibility evidence**

- `packages/cursor/src/transport.ts:150-158` exposes the `CursorProtocolCodec` seam as `Uint8Array` encoders/decoders.
- `packages/cursor/src/transport.ts:370-372` sends `encodeCursorConnectFrame(this.#codec.encodeRunRequest(request))` as the initial stream body.
- `packages/cursor/src/transport.ts:444-447` sends tool results as `encodeCursorConnectFrame(this.codec.encodeToolResult(result))`.
- `packages/cursor/src/transport.ts:669-675` writes framed bytes via `this.stream.write(Buffer.from(data), ...)`.
- `node_modules/@bastani/atomic-natives/native/index.d.ts:3-14` confirms the native dependency exposes `write(data: Buffer)`, `cursorH2OpenStream(..., initialBody?: Buffer)`, and unary `body: Buffer`; it has no message-shape awareness.
- Existing tests in `test/unit/cursor-transport.test.ts:238-274` prove text run requests and text frames still encode/decode; `:402-434` proves blob store get/set control frames persist arbitrary bytes across runs.

Interpretation: the HTTP/2/Connect layer should not care whether protobuf bytes contain text only or text plus image fields. A feature-gated codec variant can be validated without changing the native transport.

## Local validation performed

1. Targeted Cursor tests were run read-only:

```text
bun test test/unit/cursor-stream.test.ts test/unit/cursor-transport.test.ts test/unit/cursor-model-mapper.test.ts
66 pass, 0 fail
```

2. A direct protobuf round-trip of `UserMessage.selectedContext.selectedImages` plus `McpImageContent` succeeded:

```json
{"userBytes":91,"userText":"describe this","selectedImages":1,"selectedImageCase":"data","selectedImageMime":"image/png","selectedImageDataLength":8,"mcpBytes":36,"mcpItems":2,"mcpSecondCase":"image","mcpSecondMime":"image/png","mcpSecondDataLength":8}
```

3. A full local `AgentClientMessage.runRequest` + Connect frame round-trip with text plus one inline `SelectedImage` succeeded:

```json
{"payloadBytes":149,"frameBytes":154,"topCase":"runRequest","actionCase":"userMessageAction","text":"text stays intact","imageCount":1,"imageCase":"data","imageMime":"image/png","imageBytes":8}
```

This validates serialization/framing only; it does not prove Cursor’s remote headless service accepts or uses the image.

## Feasibility assessment

A minimal experiment is feasible if it is **opt-in and isolated**:

- Add or inject a codec path that converts `ImageContent` from the final user message into `SelectedContext.selectedImages[]` while keeping the normal `UserMessage.text` unchanged.
- Start with inline `SelectedImage.data` for a tiny PNG. If the server requires blob hydration, try `SelectedImage.blobIdWithData` and add the same bytes to the run blob store so same-stream `kvGetBlob` requests can be answered.
- Do not change `model.input` from `["text"]` or remove the default rejection until a real Cursor canary proves headless support.
- Tool-result image support is less minimal: `CursorToolResultMessage` and `createMcpSuccess` are text-only today, though the generated MCP protobuf shape supports images.

Expected blast radius for text is low if feature-gated, because text remains in `UserMessage.text` and current transport is length-prefixed bytes. The main risk is remote Cursor rejecting unknown/unsupported image-bearing request fields, ignoring them, or changing private protobuf expectations.

## Safe experimental validation plan

1. **No-network serialization test:** behind a local helper or injected codec, construct a `UserMessage` with text plus one tiny `SelectedImage` and assert `fromBinary` sees both. Also assert a text-only request remains unchanged at the public behavior level.
2. **Fake transport canary:** use `Http2CursorAgentTransport` with a fake `CursorHttp2Client` and experimental codec. Inspect the captured `initialBody` to assert `AgentClientMessage.runRequest.action.userMessageAction.userMessage.text` still matches and `selectedContext.selectedImages[0]` carries the image bytes/MIME.
3. **Live opt-in canary only outside CI:** require an explicit env flag and real Cursor OAuth, use a disposable conversation id and a 1x1 PNG. Ask a deterministic prompt such as “What color is the attached image?” Log only sanitized success/failure and Cursor protocol errors, never credentials or image bytes.
4. **Compare carriers:** if inline `data` is ignored/rejected, try `blobIdWithData`; if that works, test whether `blobId` plus pre-populated blob store is sufficient. Keep image sizes tiny first, then test conservative limits.
5. **Only after remote proof:** update runtime tests, provider metadata, and docs. Until then, retain the current rejection path and text-only model metadata.

## Residual risks

- Cursor’s generated protobuf includes image fields, but that does not prove the private headless `AgentService/Run` path accepts or feeds them to the selected model.
- `selected_context_blob` semantics are partly reverse-engineered in the current codec. The correct image carrier may require updating both inline `selectedContext` and the selected-context blob payload.
- Remote behavior may differ by Cursor client version, model, account, or rollout flag.
- Inline base64/bytes may hit undocumented request-size or tokenization limits; blob-backed transfer could be required.
- Tool-result images require an interface change beyond user-message serialization.
- Current tests and README intentionally enforce text-only behavior; any implementation must update them only after remote validation, not before.
