# @bastani/cursor

First-party Atomic provider for Cursor subscription models.

## Status

This package registers `cursor` via Atomic's bundled extension provider API. `/login` shows **Cursor** and stores credentials through Atomic OAuth storage (`~/.atomic/agent/auth.json`). The login URL and PKCE polling behavior intentionally match the MIT-licensed [`ndraiman/pi-cursor-provider`](https://github.com/ndraiman/pi-cursor-provider) reference: `callbacks.onAuth({ url: loginUrl })`, no extra login warning/instruction copy, and polling `api2.cursor.sh/auth/poll` until Cursor returns tokens.

The runtime protocol is also aligned to `ndraiman/pi-cursor-provider` at commit `82fc4e73f9ae820d87b34ac36713b18989910a36`: Atomic vendors the reference `cursor-models-raw.json` and generated `proto/agent_pb.ts`, and builds Cursor request/control messages through `@bufbuild/protobuf` descriptors instead of hand-maintained protobuf bytes. HTTP/2 itself is handled by the generated `@bastani/atomic-natives` Rust/N-API package rather than a separate local proxy.

The unavoidable Atomic-specific integration difference is the provider surface: Atomic exposes a native `cursor-agent` `streamSimple` provider instead of the reference package's localhost OpenAI-compatible proxy. The Cursor auth/model/protocol bytes should otherwise stay reference-derived.

## Limitations

- Text input and current user-message image input are enabled by default, including multiple images attached to the same current user message.
- Experimental user-image transport keeps model metadata text-only, uses a serialization-level internal guard, strictly validates base64/data URL payloads, and sends only final user-message image blocks through Cursor's local private protobuf `selectedImages[].data` path. Historical user image blocks are tolerated in chat history but are serialized as text-only history on later turns. That protobuf path is undocumented and unvalidated against live Cursor remote behavior; Cursor documents image support on other product/API surfaces, which do not validate this local private protobuf transport. Remote Cursor may fail or ignore images, and tool-result images remain rejected.
- Cursor's private API may change without notice.
- HTTP/2 transport requires the bundled `@bastani/atomic-natives` Rust/N-API native client for the current platform.
- Credentials are OAuth-only. Do not pass Cursor tokens via command-line args, environment variables, logs, or local proxy processes.

## Attribution

Cursor auth, model fallback, and generated protobuf behavior are derived from the MIT-licensed `ndraiman/pi-cursor-provider` project.
