# Cursor protocol notes

This directory intentionally contains protocol notes instead of generated protobuf code in iteration 1.

Known private endpoints (adapted from the MIT-licensed `ndraiman/pi-cursor-provider` project, without copying the proxy implementation):

- Browser login: `https://cursor.com/loginDeepControl?challenge=<pkce>&uuid=<uuid>&mode=login&redirectTarget=cli`
- Login poll: `https://api2.cursor.sh/auth/poll?uuid=<uuid>&verifier=<verifier>`
- Refresh: `POST https://api2.cursor.sh/auth/exchange_user_api_key`
- Model discovery: `POST https://api2.cursor.sh/agent.v1.AgentService/GetUsableModels`
- Agent stream: `POST https://api2.cursor.sh/agent.v1.AgentService/Run`

Centralized headers live in `src/config.ts`, including `x-cursor-client-version: cli-2026.01.09-231024f`, `x-cursor-client-type: cli`, and `x-ghost-mode: true`. `src/transport.ts` is the only module that should construct Cursor RPC headers or future HTTP/2 Connect frames.

Before enabling live transport, add or generate minimal protobuf message definitions here, keep generated code isolated from provider registration/stream mapping, and extend fake-transport tests with byte-framing coverage. Do not introduce a localhost OpenAI-compatible proxy or child-process bridge.
