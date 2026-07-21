# Cursor protocol evidence ledger

This directory isolates the private Cursor protobuf/Connect boundary used by `@bastani/cursor`. The physical schema is now exactly the purpose-minimal authored sources in `schema/cursor-catalog.proto`, `schema/cursor-conversation.proto`, and `schema/cursor-stream.proto`; their checked-in `cursor-*_pb.ts` outputs are re-exported by the authored `cursor-protocol.ts` boundary. Production uses those descriptors through `@bufbuild/protobuf`, the direct HTTP/2 transport in `transport-http2.ts`, and Connect framing in `transport-frame.ts`. The former broad `agent_pb.ts` descriptor is intentionally absent.

## Evidence classes and provenance

- **Checked-in verified (CV):** independently matched to the checked-in descriptors or transport constants at source baseline `e5e1c2fd9d6887ca62ab81fbc3143298f948f955` and covered by deterministic codec/fixture tests.
- **Independently inferred (II):** required behavior derived from a checked-in field's representational limits or Connect stream semantics and identified as inference below.
- **Live observed (LO):** no fields in this ledger. One bounded Cursor preparation attempt timed out before `Run`, so there was no successful live protocol capture; no credential refresh completed.

The browser auth flow and retained generated material include work informed by the MIT-licensed [`ndraiman/pi-cursor-provider`](https://github.com/ndraiman/pi-cursor-provider) project at commit `82fc4e73f9ae820d87b34ac36713b18989910a36`. That is license attribution, not authority for production behavior. The authoritative implementation boundary is the explicitly used checked-in subset below plus Atomic's tests and sanitized fixtures.

The generated TypeScript files were produced from only those three authored schemas with `@bufbuild/protoc-gen-es` 2.12.1 (`target=ts,import_extension=js`). Their generated headers are genuine generator output; authored `.proto`, barrel, codec, and documentation files do not claim to be generated. To reproduce in a temporary Buf module, run `bunx --bun @bufbuild/buf generate` with a local plugin command of `bunx --bun @bufbuild/protoc-gen-es` and copy the three outputs without editing them.

Account scoping is II, not a Cursor or OIDC-ID-token claim. Atomic applies the three-part compact-JWT shape and issuer/subject claim conventions described by RFC 7519 and RFC 9068 to host-stored OAuth values, accepts only Cursor HTTPS issuers, and hashes the accepted pair into a one-way discriminator. It does not assert token-signature verification or that the access token is an OIDC ID token. This policy was checked against a sanitized host credential observation; no token or claim value was retained, and no Cursor endpoint was called.

## Endpoint and framing ledger

| Operation | Endpoint / content type | Production message or shape | Evidence |
|---|---|---|---|
| Browser login | `https://cursor.com/loginDeepControl?...` | PKCE browser URL | CV: `auth.ts`, `config.ts` |
| Login poll | `GET https://api2.cursor.sh/auth/poll` | JSON auth polling | CV: `auth.ts`, `config.ts` |
| OAuth refresh | `POST https://api2.cursor.sh/auth/exchange_user_api_key` | JSON refresh exchange | CV: `auth.ts`, `config.ts` |
| Catalog | `POST https://api2.cursor.sh/agent.v1.AgentService/GetUsableModels`, `application/proto` | empty `GetUsableModelsRequest`; raw unary `GetUsableModelsResponse` | CV: `transport-http2.ts`, discovery fixtures |
| Agent run | `POST https://api2.cursor.sh/agent.v1.AgentService/Run`, `application/connect+proto`, `connect-protocol-version: 1` | framed `AgentClientMessage` / `AgentServerMessage` stream | CV: `transport-http2.ts`, run/stream fixtures |

RPC headers include redacted bearer authorization, `te: trailers`, `x-cursor-client-version`, `x-cursor-client-type: cli`, `x-ghost-mode: true`, and a per-request ID. The checked-in client-version constant is `cli-2026.01.09-231024f`; it is part of catalog/request generation identity but is not proof that the private service still accepts that value.

A Connect frame is one flags byte followed by a four-byte unsigned big-endian payload length and that many payload bytes. Flag bit `0b10` marks end-stream. Catalog compatibility framing is validated through the complete response; incomplete headers/bodies, multiple data bodies, compression, and malformed trailing bytes reject the whole catalog atomically. A safe JSON end-stream envelope may contain `error.code` and `error.message`; those values are classified and sanitized before exposure.

## Field-level production ledger

Protobuf strings, bytes, nested messages, repeated elements, and map entries use wire type 2 (length-delimited). Booleans and integer scalars use wire type 0 (varint).

| Operation / message | Field | No. / wire | Production use | Evidence |
|---|---|---|---|---|
| `GetUsableModelsResponse` | `models` | 1 / 2 | Preserve every row and literal order | CV: `get-usable-models-*` fixtures |
| `ModelDetails` (catalog) | `model_id` | 1 / 2 | Exact route ID; empty rejects whole response | CV: discovery fixtures |
| `ModelDetails` (catalog) | `display_model_id`, `display_name`, `display_name_short` | 3, 4, 5 / 2 | Presentation label only; never identity/routing | CV: descriptor + catalog tests |
| `ModelDetails` (catalog/run) | optional `max_mode` | 7 / 0 | Preserve presence and absent/false/true state | CV: Max-state/run fixtures |
| `AgentClientMessage` | `run_request` | 1 / 2 | Initial Run envelope | CV: all `run-route-*` fixtures |
| `AgentRunRequest` | `conversation_state`, `action`, `model_details`, `conversation_id`, `requested_model` | 1, 2, 3, 5, 9 / 2 | Canonical context, current action, exact route twice, conversation key | CV: descriptor + codec tests |
| `ModelDetails` (run) | `model_id`, optional `max_mode` | 1 / 2; 7 / 0 | Exact selected ID and exact tri-state Max | CV: run fixtures |
| `RequestedModel` | `model_id`, `max_mode`, `parameters` | 1 / 2; 2 / 0; 3 / 2 repeated | Same exact ID; true only for Max true; semantic `[]` | CV for ID/true/false/empty; II for absent→false |
| `ConversationAction` | `user_message_action`, `cancel_action` | 1, 3 / 2 | Current user action or cancellation | CV: request codec, `cancel-action.hex` |
| `UserMessageAction` | `user_message` | 1 / 2 | Wrap current user text | CV: descriptor + codec tests |
| `UserMessage` | `text`, `message_id`, empty `selected_context`, `mode`, `selected_context_blob`, `correlation_id` | 1, 2, 3, 4, 10, 17 / 2,2,2,0,2,2 | Text-only user turn and local synthetic correlation | CV: descriptor + codec/history tests |
| Empty `SelectedContext`; selected-context blob layout | `selected_images`; root-prompt blob IDs, `client_name` | 1 / 2 repeated; 1 / 2 repeated, 22 / 2 | Encode no images while linking the system blob and client label | CV: descriptor/manual codec + history tests |
| `ConversationStateStructure` | `root_prompt_messages_json`, `turns`, `mode`, `client_name` | 1, 8, 10, 22 / 2,2,0,2 | Blob IDs for system/history, mode, client label | CV: descriptor + history tests |
| `ConversationTurnStructure` | `agent_conversation_turn` | 1 / 2 | Historical turn wrapper | CV: descriptor + history tests |
| `AgentConversationTurnStructure` | `user_message`, `steps`, `request_id` | 1, 2, 3 / 2 | Blob IDs for historical user/steps plus synthetic ID | CV: descriptor + history tests |
| `ConversationStep` | `assistant_message`, `tool_call`, `thinking_message` | 1, 2, 3 / 2 | Canonical assistant text, host tool history, thinking | CV: descriptor + history tests/fixture note |
| `AssistantMessage`; `ThinkingMessage` | `text`; `text`, `duration_ms` | 1 / 2; 1 / 2, 2 / 0 | Historical assistant text/thinking; duration is zero | CV: descriptor + history tests |
| Historical `ToolCall` → `McpToolCall` | `mcp_tool_call` → `args`, optional `result` | 15 → 1, 2 / 2 | Canonical Atomic tool call plus matched text result | CV: descriptor + history tests |
| Historical/live `McpToolResult` | `success` or `error`; success `content`, `is_error`; content-item `text`; text/error payload | 1 or 2; 1,2; 1; 1 / nested type 2, bool type 0 | Encode one text result or typed error; never image content | CV: descriptor + tool/history tests |
| `AgentServerMessage` | `interaction_update`, `exec_server_message`, `conversation_checkpoint_update`, `kv_server_message` | 1, 2, 3, 4 / 2 | Deltas, tool bridge, optional blob/checkpoint control | CV: descriptor + codec tests |
| Checkpoint accounting | `ConversationStateStructure.token_details` → `ConversationTokenDetails.used_tokens` | 5 / 2 → 1 / 0 | Read usage evidence only; checkpoint state is not request history | CV: checkpoint codec tests |
| `InteractionUpdate` | `text_delta`, `thinking_delta`, `token_delta`, `turn_ended` | 1, 4, 8, 14 / 2 | Text/thinking/usage; `turn_ended` is ignored as terminal evidence | CV: descriptors/delta fixtures; II: terminal rule |
| `TokenDeltaUpdate` | `tokens` | 1 / 0 | Increment streamed output usage | CV: descriptor + codec tests |
| `TextDeltaUpdate`; `ThinkingDeltaUpdate` | `text` | 1 / 2 | Ordered streamed text/thinking | CV: stream fixtures |
| `AgentClientMessage` | `conversation_action`, `exec_client_message`, `kv_client_message` | 4, 2, 3 / 2 | Cancel, tool/control results, blob replies | CV: descriptor + codec tests |
| `AgentClientMessage` | `client_heartbeat` | 7 / 2 | Periodic empty heartbeat while Run is active | CV: descriptor + transport tests |
| `ExecServerMessage` | `id`, `exec_id`, `request_context_args`, `mcp_args` | 1 / 0; 15 / 2; 10, 11 / 2 | Correlation, tool-definition request, host tool call | CV: descriptor + tool tests |
| `McpArgs` | `name`, `args`, `tool_call_id`, `provider_identifier`, `tool_name` | 1,2,3,4,5 / 2 | Decode a generic Atomic tool call | CV: descriptor + tool tests |
| MCP argument map values | protobuf `Value` bytes, with raw UTF-8 fallback only on decode failure | WKT-defined / type 2 map value | Preserve generic JSON tool arguments without private ad-hoc fields | CV: protobuf JSON codec + tool tests |
| `ExecClientMessage` | `id`, `exec_id`, `request_context_result`, `mcp_result` | 1 / 0; 15,10,11 / 2 | Correlated tool-definition/text-result replies | CV: descriptor + tool tests |
| `RequestContextResult` → `RequestContextSuccess` → `RequestContext` | `success` → `request_context` → `tools` | 1 → 1 → 7 / 2 | Advertise only Atomic's current tool definitions | CV: descriptor + request-context tests |
| `McpToolDefinition` | `name`, `description`, `input_schema`, `provider_identifier`, `tool_name` | 1,2,3,4,5 / 2 | Generic host tool schema | CV: descriptor + tool tests |
| `McpResult` | `success` or `error` | 1 or 2 / 2 | Text-only host tool result | CV: descriptor + tool tests |
| Live result content | `McpSuccess.content`, `McpSuccess.is_error`, `McpToolResultContentItem.text`, `McpTextContent.text`, `McpError.error` | 1 / 2, 2 / 0, 1 / 2, 1 / 2, 1 / 2 | One text-only success item or one typed error string | CV: descriptor + tool-result tests |
| Native exec rejection | server cases 2,3,4,5,7,8,9,14,16,17,18,20,21,22,23; matching client result cases except diagnostics case 9 uses correlated `mcp_result` case 11 because `DiagnosticsResult` is empty | listed case number or 11 / 2 | Return generated typed rejection/error envelopes containing only empty identifiers and a safe constant; never execute them | CV: descriptor + all-case native-exec rejection tests |
| KV control | server/client `id`; get/set cases 2/3; `blob_id` 1; `blob_data` 1 or 2 | varint and type 2 | Serve request-local content-addressed blobs | CV: descriptor + codec tests |

`RequestContext` semantically initializes `rules` (2), `repository_info` (6), `git_repos` (11), `project_layouts` (13), `mcp_instructions` (14), `file_contents` (20), and `custom_subagents` (22) as empty alongside `tools` (7). Empty repeated/map values emit no elements; no workspace path, repository data, rule, instruction, or subagent definition is sent.

`RequestedModel.parameters` is a repeated message field. The required semantic value is the plain empty collection `[]`; protobuf therefore emits no field-3 element. An empty wrapper element would be a different value and is not sent.

The `ModelDetails.max_mode` optional bool can encode absence, false, and true. `RequestedModel.max_mode` is a non-optional proto3 bool and cannot encode absence. Atomic therefore maps authoritative absence to false only in that second representation. Absence and false remain distinct route occurrence identities everywhere else.

## Stream, history, tools, and images

Text and thinking deltas retain arrival order. Every stream requires a catalog-backed request lease; an adapter without route authority or a fabricated/stale route fails before transport, and a signal-ignoring stream returned after invalidation is closed even before turn registration. Run HTTP authentication statuses reject before the stream is accepted. `InteractionUpdate.turn_ended` is not treated as terminal. Provider `done` messages remain withheld until clean Connect terminal validation, and boundary messages after published tool calls remain ordered but withheld until the matching result writes resume delivery; malformed EOF therefore wins before either can publish an Atomic success boundary. An independent 100 ms tool-batch idle interval hands a live-open stream to the host for tool execution even when general request/read timeout `0` disables ordinary timeouts; malformed EOF/error detected in that interval wins and leaves no paused ownership. Exactly one clean Connect end-stream followed by EOF completes the Atomic stream only after the heartbeat interval is stopped, every already-started heartbeat write settles, graceful close succeeds or raw-handle abandonment completes, and lifecycle/codec run ownership is released exactly once. Bare EOF without a valid end-stream, including an empty frame iterable, is malformed/truncated protocol and rejects only after heartbeat, raw-handle, codec, and lifecycle ownership is released exactly once. Repeated or concurrent cancellation/pump-failure cleanup shares one raw-handle terminal operation, malformed runs choose one codec discard/dispose action, and cleanup cannot reclassify success as cancellation. Any later frame, error envelope, malformed/truncated frame, transport failure, timeout, cancellation, or stale generation tears down ownership before failing once through its structured path.

Every new Run reconstructs canonical user text, assistant text/thinking, host tool calls, and text tool results from Atomic messages. Historical and live-result text blocks, including empty user/assistant/thinking blocks, are preserved verbatim in order without inserted separators when image blocks are omitted. Duplicate live tool-call IDs preserve FIFO occurrence/result correlation. An orphan canonical text tool result is preserved as an assistant-text history step without synthesizing a tool call. Content-addressed blobs and process-local paused/checkpoint state may optimize an active turn, but cannot replace, truncate, or reorder canonical history. This applies to same-process continuation, persisted restart, and workflow-stage sessions.

Atomic remains the tool executor. `request_context_args = 10` receives current generic Atomic tool definitions; `mcp_args = 11` becomes an Atomic tool call; `mcp_result = 11` returns its text result. Cursor-native execution cases—including MCP-resource, screen, computer-use, and diagnostics—receive typed safe errors and are never executed locally. Diagnostics uses the correlated `mcp_result` error because its matching `DiagnosticsResult` message has no rejection field. Current user images fail at both the adapter and direct Run transport boundaries before HTTP/2 opens; live image tool results fail before the result content is transported. Historical image blocks are omitted; adjacent text is retained verbatim in order without inserted newlines.

## Sanitized deterministic fixtures

`test/unit/fixtures/cursor-v2/README.md` is the fixture manifest. Each whitespace-separated `.hex` file has one purpose: discovery duplicates/Max/empty/malformed, exact non-Max/Max/absent-Max requests, text/thinking chunks, clean terminal, cancellation, authentication/server errors, and malformed/truncated framing.

All fixture values are synthetic. The corpus contains no credential, authorization header, cookie, issuer/subject/account value, request or conversation ID, UUID, prompt, customer content, machine path, or retained private response. No fixture came from a live request or response.

## Bounded live verification

One bounded Cursor preparation attempt was run and timed out before `Run`; it yielded no successful protocol request/response capture, and no credential refresh completed. Do not repeat that consumed attempt as part of this rewrite. Any separately authorized future verification must use a new explicit authorization and must not broaden the production field set merely because a live result differs.
