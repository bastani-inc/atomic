# Cursor protocol notes

This directory contains the isolated Cursor protobuf protocol codec and vendored generated protobuf descriptors. The codec intentionally follows the MIT-licensed [`ndraiman/pi-cursor-provider`](https://github.com/ndraiman/pi-cursor-provider) implementation at commit `82fc4e73f9ae820d87b34ac36713b18989910a36`: request and control messages are built with the generated `agent_pb.ts` descriptors and `@bufbuild/protobuf`, not with hand-maintained field concatenation.

Known private endpoints:

- Browser login: `https://cursor.com/loginDeepControl?challenge=<pkce>&uuid=<uuid>&mode=login&redirectTarget=cli`
- Login poll: `https://api2.cursor.sh/auth/poll?uuid=<uuid>&verifier=<verifier>`
- Refresh: `POST https://api2.cursor.sh/auth/exchange_user_api_key`
- Model discovery: `POST https://api2.cursor.sh/agent.v1.AgentService/GetUsableModels`
- Agent stream: `POST https://api2.cursor.sh/agent.v1.AgentService/Run`

`src/transport.ts` exposes an injectable HTTP/2 client and protocol codec seam plus buffered Connect frame helpers. Production defaults use `CursorProtobufProtocolCodec` and the Rust/N-API HTTP/2 native binding in `@bastani/atomic-natives` (`crates/atomic-natives`) because Bun's `node:http2` behavior is not reliable against Cursor's private API.

Protocol behavior intentionally copied from the reference provider:

- `AgentClientMessage.run_request = 1`, `exec_client_message = 2`, `kv_client_message = 3`, `conversation_action = 4`, `client_heartbeat = 7`.
- Run requests use generated `AgentRunRequest`, `ConversationStateStructure`, `ConversationAction`, `UserMessage`, and `ModelDetails` messages.
- `UserMessage.message_id`, `UserMessage.correlation_id`, and reconstructed historical turn request ids are UUIDs generated the same way as the reference provider.
- Conversation ids are deterministic UUIDs derived from the hashed conversation key (`conv:<session-or-first-user-text>`), matching the reference provider rather than sending raw Atomic session ids to Cursor.
- Static fallback models are the reference `cursor-models-raw.json`; live model discovery is opportunistic and only replaces the registered catalog when Cursor returns usable models. Cursor's model-discovery protobuf carries no context-window or output-token fields, so the provider preserves any positive limits and otherwise resolves them from Atomic's bundled `@earendil-works/pi-ai` model catalog by Cursor model ID (with a conservative estimate for unmatched Cursor-only models and a 1,000,000-token floor for explicit `1M` Cursor labels); this only sets limits and does not change catalog membership.
- Tool definitions are returned in response to `ExecServerMessage.request_context_args = 10`; `McpArgs` messages become Atomic tool calls and active tool results are sent back as generated `ExecClientMessage.mcp_result` frames.
- Checkpoint and blob-store state is persisted per Cursor conversation id and discarded on Cursor end-stream errors such as `not_found`.
- `InteractionUpdate.turn_ended` is non-terminal; the stream closes on the Connect stream ending.

Manual smoke-test procedure after Cursor releases:

1. Sign in to the current Cursor CLI/app and capture a successful `api2.cursor.sh` model discovery or agent `Run` request.
2. Update `CURSOR_CLIENT_VERSION` in `src/config.ts` from the captured `x-cursor-client-version` header if it changed.
3. In Atomic, run `/login`, select **Cursor (Experimental)**, complete browser auth, then confirm `/model` lists `cursor/<model-id>` entries from live discovery.
4. Select a Cursor model and run one chat turn plus one tool-using turn; verify the process exits cleanly for a one-shot/noninteractive run.
5. Re-run the Cursor unit tests and update these notes for any changed protobuf paths.

If Cursor changes the private protocol, update the vendored generated protobuf descriptors from the reference/source protocol before changing the codec behavior.
