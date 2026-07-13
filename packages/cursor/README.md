# @bastani/cursor

First-party experimental Atomic provider for Cursor subscription models.

## Discovery and metadata

Atomic uses Cursor's browser PKCE OAuth flow and private CLI-compatible HTTP/2 protocol. Authenticated model discovery prefers `POST /aiserver.v1.AiService/AvailableModels`, whose parameter, capability, and normal/Max context fields are reverse-engineered and may vary by account, plan, region, server, and client version. If that endpoint is unavailable, malformed, or empty, Atomic falls back to generated `POST /agent.v1.AgentService/GetUsableModels` decoding.

Cursor's public Cloud Agents List Models endpoint and `Cursor.models.list()` SDK are authoritative for IDs, parameters, and presets accepted by those public surfaces, but they do not prove private CLI/IDE parity and do not document exact context/output limits. Atomic therefore treats every private live catalog as an account snapshot.

AvailableModels metadata preserves complete parameter combinations and keeps base, fast, thinking, reasoning effort, Max/long-context, and Max-only modes distinct. Only exact reasoning values carried by discovered parameter variants are exposed as Atomic levels; family names and fallback-ID suffixes do not create capabilities, explicitly unsupported levels fail instead of redirecting, and an ambiguous standalone `-max` model name is not treated as effort. Generated preset IDs escape exact parameter bytes so distinct values cannot collapse onto one route. Requests carry the discovered backend model ID in both the legacy `ModelDetails` field and the generated `RequestedModel` fields, with the selected parameters and Max state preserved without recombining presets.

Exact limits are used only when attached together to the corresponding discovered model/mode; Atomic does not independently maximize context and output fields across variants. Missing values use positive operational budgets required by Atomic's model interface and carry explicit conservative-fallback provenance—the exact Cursor limit remains unknown. Missing image metadata degrades to text-only.

Authenticated catalogs use schema-v2, credential-scoped files named `~/.atomic/agent/cursor-model-catalog.json.account-<digest>` with a 30-minute TTL. The digest is derived from the stable JWT subject claim, not from an OAuth token, and neither tokens nor account claims are persisted. A rotated token for the same account can reuse its fresh catalog; another account cannot load or overwrite that file. Legacy unscoped caches are not trusted for authenticated startup. Credential changes refresh immediately, superseded in-process requests cannot overwrite the latest account snapshot, older same-account cache writes are ignored, and future-dated timestamps are not treated as fresh. Stale discovery is awaited for `atomic --list-models`; discovery failures print a warning and retain/list the previous scoped catalog. Successful live registration does not depend on a successful cache write, and persistence failures remain available through refresh diagnostics. Every new request requires exact discovered backend routing metadata rather than silently degrading to a display ID. The bundled compatibility snapshot includes a conservative GPT-5.5 base ID but does not infer capabilities or parameter combinations from its names.

## Limitations

- Cursor's private API may change without notice, and use may conflict with Cursor terms or account policies.
- HTTP/2 requires bundled `@bastani/atomic-natives` for the current platform.
- Credentials are OAuth-only. Do not pass Cursor tokens through arguments, environment variables, logs, or proxy processes.
- Images and mixed text/image MCP results are sent only when current model metadata advertises image input. Image data must be non-empty standard base64; MIME whitespace is accepted and removed.

## Attribution

Auth and generated agent protobuf behavior derive from MIT-licensed `ndraiman/pi-cursor-provider`. The reverse-engineered AvailableModels field interpretation follows the pinned `sfiorini/pi-stef` protocol notes referenced by issue #1702; it is evidence, not a stable Cursor contract.
