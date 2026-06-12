# Cursor protocol notes

This directory contains the isolated Cursor protobuf protocol codec and protocol notes. The codec is intentionally minimal and hand-maintained for the message fields Atomic currently uses; generated protobufs can replace or augment it here without touching provider registration.

Known private endpoints (adapted from the MIT-licensed `ndraiman/pi-cursor-provider` project, without copying the proxy implementation):

- Browser login: `https://cursor.com/loginDeepControl?challenge=<pkce>&uuid=<uuid>&mode=login&redirectTarget=cli`
- Login poll: `https://api2.cursor.sh/auth/poll?uuid=<uuid>&verifier=<verifier>`
- Refresh: `POST https://api2.cursor.sh/auth/exchange_user_api_key`
- Model discovery: `POST https://api2.cursor.sh/agent.v1.AgentService/GetUsableModels`
- Agent stream: `POST https://api2.cursor.sh/agent.v1.AgentService/Run`

Centralized headers live in `src/config.ts`, including `x-cursor-client-version: cli-2026.01.09-231024f`, `x-cursor-client-type: cli`, and `x-ghost-mode: true`. `src/transport.ts` is the only module that should construct Cursor RPC headers or HTTP/2 Connect frames.

`src/transport.ts` now exposes an injectable HTTP/2 client and protocol codec seam plus buffered Connect frame helpers. Production defaults use `CursorProtobufProtocolCodec`; `JsonCursorProtocolCodec` is retained only for explicit test fixtures. If Cursor changes the private protocol, add or generate updated protobuf message definitions here and keep generated code isolated from provider registration/stream mapping. Do not introduce a localhost OpenAI-compatible proxy or child-process bridge.
