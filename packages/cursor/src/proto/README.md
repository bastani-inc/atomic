# Cursor protocol notes

This directory contains the isolated Cursor protobuf protocol codec and protocol notes. The codec is intentionally minimal and hand-maintained for the message fields Atomic currently uses; generated protobufs can replace or augment it here without touching provider registration.

Known private endpoints (adapted from the MIT-licensed `ndraiman/pi-cursor-provider` project, without copying the proxy implementation):

- Browser login: `https://cursor.com/loginDeepControl?challenge=<pkce>&uuid=<uuid>&mode=login&redirectTarget=cli`
- Login poll: `https://api2.cursor.sh/auth/poll?uuid=<uuid>&verifier=<verifier>`
- Refresh: `POST https://api2.cursor.sh/auth/exchange_user_api_key`
- Model discovery: `POST https://api2.cursor.sh/agent.v1.AgentService/GetUsableModels`
- Agent stream: `POST https://api2.cursor.sh/agent.v1.AgentService/Run`

Centralized headers live in `src/config.ts`, including `x-cursor-client-version: cli-2026.01.09-231024f`, `x-cursor-client-type: cli`, and `x-ghost-mode: true`. `src/transport.ts` is the only module that should construct Cursor RPC headers or HTTP/2 Connect frames.

`src/transport.ts` exposes an injectable HTTP/2 client and protocol codec seam plus buffered Connect frame helpers. Production defaults use `CursorProtobufProtocolCodec`; unit-test transport doubles live under `test/unit/` so the bundled provider does not export mock protocol surfaces. Run requests write the initial Connect frame before response headers, and stream handles install response/data/error/close listeners eagerly to avoid missed terminal events.

Field provenance (from `ndraiman/pi-cursor-provider` vendored `proto/agent_pb.ts` commit `82fc4e7`, itself derived from MIT `opencode-cursor`):

- `AgentClientMessage.run_request = 1`
- `AgentClientMessage.exec_client_message = 2`
- `AgentClientMessage.conversation_action = 4`
- `AgentRunRequest.conversation_state = 1`, `action = 2`, `model_details = 3`, `conversation_id = 5`; `conversation_id` is the stable Atomic session/conversation id when available, while request ids remain per-call tracing/message-id seeds. Cursor also has `custom_system_prompt = 8`, but Atomic intentionally does not emit it because Cursor maps it to an allowlisted/unsupported `--system-prompt` option; system prompts are carried through `ConversationStateStructure.root_prompt_messages_json = 1` as a blob id instead.
- `AgentRunRequest.mcp_tools = 4` exists in the private schema, but Atomic does not emit it in the initial `Run` request. Tool definitions are returned when Cursor sends an `exec_server_message.request_context_args = 10` control message on the active stream.
- `McpTools.mcp_tools = 1` repeats `McpToolDefinition` messages inside the request-context response payload.
- `McpToolDefinition.name = 1`, `description = 2`, `input_schema = 3` (JSON schema encoded as `google.protobuf.Value` bytes), `provider_identifier = 4`, `tool_name = 5`
- `ConversationStateStructure.root_prompt_messages_json = 1`, `turns = 8`; both values are content-addressed blob ids. Cursor fetches the blob payloads by sending `AgentServerMessage.kv_server_message = 4` / `get_blob_args = 2`, and Atomic replies with `AgentClientMessage.kv_client_message = 3` / `get_blob_result = 2` on the same stream.
- `ConversationAction.user_message_action = 1`, `cancel_action = 3`
- `UserMessageAction.user_message = 1`; `UserMessage.text = 1`, `message_id = 2`
- `ModelDetails.model_id = 1`, `thinking_details = 2`, `display_name = 4`, `max_mode = 7`
- `AgentServerMessage.interaction_update = 1`, `exec_server_message = 2`, `conversation_checkpoint_update = 3`, `kv_server_message = 4`
- `InteractionUpdate.text_delta = 1`, `thinking_delta = 4`, `token_delta = 8`, `turn_ended = 14`
- `ExecServerMessage.exec_id = 15`, `request_context_args = 10`, `mcp_args = 11`; `request_context_args` is an internal control message that Atomic answers with tool definitions, and only `mcp_args` becomes an Atomic tool call. `McpArgs.name = 1`, `args = 2`, `tool_call_id = 3`, `provider_identifier = 4`, `tool_name = 5`. `McpArgs.args` values are `bytes`; Atomic first decodes them as protobuf `Value` payloads and then falls back to strict raw UTF-8 strings so Cursor string arguments such as file paths do not fail the tool-call boundary. Historical tool-call arguments sent back to Cursor are encoded as per-argument protobuf `Value` map entries. This remains an inferred private-wire-format boundary: a raw string whose bytes exactly match a structurally valid protobuf `Value` could still be interpreted as typed data, so revalidate this behavior when updating the protocol.
- `ExecClientMessage.id = 1`, `mcp_result = 11`, `exec_id = 15`; Atomic writes these frames back to the same paused Run stream for active tool results rather than encoding tool results as user-message text. Historical completed tool calls are reconstructed as one MCP tool-call step containing both `mcp_args` and `mcp_result`, so tool results are not sent as prefixed transcript text.

Paused Cursor tool streams are owned by the conversation-state store while Atomic executes tools. The store installs abort cleanup and an unref'd idle timer so one-shot CLI/workflow runs can exit and abandoned tool turns are cancelled.

Manual smoke-test procedure after Cursor releases:

1. Sign in to the current Cursor CLI/app and capture a successful `api2.cursor.sh` model discovery or agent `Run` request.
2. Update `CURSOR_CLIENT_VERSION` in `src/config.ts` from the captured `x-cursor-client-version` header if it changed.
3. In Atomic, run `/login`, select **Cursor (experimental)**, complete browser auth, then confirm `/model` lists `cursor/<model-id>` entries from live discovery.
4. Select a Cursor model and run one chat turn plus one tool-using turn; verify the process exits cleanly for a one-shot/noninteractive run.
5. Re-run the Cursor unit tests and update field notes above for any changed protobuf paths.

If Cursor changes the private protocol, add or generate updated protobuf message definitions here and keep generated code isolated from provider registration/stream mapping. Do not introduce a localhost OpenAI-compatible proxy or child-process bridge.
