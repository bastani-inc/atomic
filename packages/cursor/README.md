# @bastani/cursor

First-party Atomic provider for Cursor subscription models.

## Status

This package registers `cursor` via Atomic's bundled extension provider API. `/login` shows **Cursor** and stores credentials through Atomic OAuth storage (`~/.atomic/agent/auth.json`). The login URL and PKCE polling behavior intentionally match the MIT-licensed [`ndraiman/pi-cursor-provider`](https://github.com/ndraiman/pi-cursor-provider) reference: `callbacks.onAuth({ url: loginUrl })`, no extra login warning/instruction copy, and polling `api2.cursor.sh/auth/poll` until Cursor returns tokens.

The runtime protocol is also aligned to `ndraiman/pi-cursor-provider` at commit `82fc4e73f9ae820d87b34ac36713b18989910a36`: Atomic vendors the reference `cursor-models-raw.json`, `h2-bridge.mjs`, and generated `proto/agent_pb.ts`, and builds Cursor request/control messages through `@bufbuild/protobuf` descriptors instead of hand-maintained protobuf bytes.

The unavoidable Atomic-specific integration difference is the provider surface: Atomic exposes a native `cursor-agent` `streamSimple` provider instead of the reference package's localhost OpenAI-compatible proxy. The Cursor auth/model/protocol bytes should otherwise stay reference-derived.

## Limitations

- Text input only. Vision/image content is rejected.
- Cursor's private API may change without notice.
- Credentials are OAuth-only. Do not pass Cursor tokens via command-line args, environment variables, logs, or local proxy processes.

## Attribution

Cursor auth, model fallback, HTTP/2 bridge, and generated protobuf behavior are derived from the MIT-licensed `ndraiman/pi-cursor-provider` project.
