# @bastani/cursor

First-party experimental Atomic provider for Cursor subscription models.

## Discovery, routing, and cache

Atomic uses Cursor's browser PKCE OAuth flow and private CLI-compatible HTTP/2 protocol. `POST /agent.v1.AgentService/GetUsableModels` is the sole authority for the authenticated account's runnable model existence, exact executable IDs, display data, and Max state. Atomic registers one model row for each exact returned `model_id` and sends the selected ID unchanged in both `ModelDetails.model_id` and `RequestedModel.model_id`.

`POST /aiserver.v1.AiService/AvailableModels` is a separate, best-effort metadata call for image capability only. Atomic joins its metadata to a GetUsable route only through unambiguous exact identity/variant evidence from the same authenticated account. AvailableModels cannot add or remove executable rows, choose a route, supply Max state or request parameters, or block text usage. Missing, false, or ambiguous image metadata leaves the route text-only; model-family names are not used to infer image support.

Max comes exclusively from GetUsable and is encoded in both request model structures. `RequestedModel.parameters` is always empty. Atomic does not expand AvailableModels tuples, synthesize picker or backend routes, translate a reasoning selector into another route, or resolve legacy aliases. An old or unavailable Cursor ID in settings, a CLI command, a workflow, or a restored session fails clearly and must be reselected from the current authenticated catalog; Atomic does not substitute a nearest effort, static model, AvailableModels row, another Cursor model, or another provider.

Authenticated catalogs use schema-v3, account-scoped files named `~/.atomic/agent/cursor-model-catalog.json.account-<digest>` with a 30-minute TTL. They contain only exact GetUsable-derived routes and optional same-account image flags. The digest is derived from the stable JWT subject claim, not from an OAuth token, and neither tokens nor account claims are persisted. Schema-v1, schema-v2, unscoped, and parameterized caches are ignored rather than migrated. A rotated token for the same account may reuse a fresh snapshot; another account cannot load or overwrite it. A fresh same-account v3 snapshot may keep its GetUsable-derived routes available during a temporary GetUsable failure, but stale snapshots, AvailableModels data, and static rows never become executable fallback.

Credential changes refresh immediately, superseded or out-of-order requests cannot overwrite the latest account snapshot, and future-dated timestamps are not treated as fresh. A first-time `/login` succeeds only after authenticated discovery registers a usable catalog for that credential scope. Discovery participates in shutdown cancellation, its failures are redacted, `atomic --list-models` waits for a required refresh, and a successful live registration does not depend on best-effort cache persistence.

## Limitations

- Cursor is experimental. Its private API may change without notice, and use may conflict with Cursor terms or account policies.
- The rewrite intentionally breaks older experimental Cursor model IDs and cache formats. Open `/model` and reselect an exact route returned for the authenticated account.
- HTTP/2 requires bundled `@bastani/atomic-natives` for the current platform.
- Credentials are OAuth-only. Do not pass Cursor tokens through arguments, environment variables, logs, or proxy processes.
- Current-turn user images and live mixed text/image MCP results are sent only when unambiguous current-account metadata advertises image input. Image data must be non-empty standard base64; MIME whitespace is accepted and removed. Unsupported or invalid image input is rejected locally.
- Reconstructing an image sent in an earlier turn and structured clipboard attachments remain follow-up [#1807](https://github.com/bastani-inc/atomic/issues/1807). Assistant-generated images are out of scope.

## Attribution

Auth and generated agent protobuf behavior derive from MIT-licensed `ndraiman/pi-cursor-provider`. The optional reverse-engineered AvailableModels identity/image interpretation follows the pinned `sfiorini/pi-stef` protocol notes referenced by issue #1702; it is evidence for conservative metadata enrichment, not a runnable-catalog authority or stable Cursor contract.
