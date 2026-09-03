# Changelog

This package is a Bastani fork of `@earendil-works/pi-ai`. Upstream history at the audited Pi `main` sync point (`4e69b0c28060f0f02fbe38bfa7c21a2e2eb25057`) lives in [earendil-works/pi](https://github.com/earendil-works/pi/blob/4e69b0c28060f0f02fbe38bfa7c21a2e2eb25057/packages/ai/CHANGELOG.md).

## [Unreleased]

### Added

- Added Anthropic per-turn effort persistence, deterministic historical effort markers, and signed-thinking mismatch recovery for supported Claude models across Anthropic Messages transports, including OpenRouter.
- Added `compat.vllmPriority` to the OpenAI Completions compatibility options. When set, it is sent as the top-level `priority` request field; lower values are handled earlier and the vLLM server default is `0`, so it only takes effect when vLLM runs with `--scheduling-policy priority`. Setting it on a background or batch model defers that model's long prefills behind interactive sessions. Off by default and never set on the generated catalog ([#9004](https://github.com/earendil-works/pi/pull/9004)).
- `Model.fastRoute` and the `ModelFastRoute` type. This optional field marks a model as the fast-inference variant of another model and carries the upstream routing it needs: the base model it pairs with, the model ID to send upstream, and an optional OpenAI-style `serviceTier`. Presence of this field — never a `-fast` name suffix — is what gives a model fast semantics.

### Changed

- **Breaking:** the OpenAI Responses and ChatGPT Codex Responses adapters now default `service_tier` from `model.fastRoute?.serviceTier` when a request supplies no explicit `serviceTier` option, and use that resolved tier for serialization, response-tier resolution, and cost multiplication alike. A fast model variant therefore routes correctly through `Models.stream`/`complete`, `streamSimple`/`completeSimple`, and a provider's stream functions taken directly — previously only a caller that injected the option got the tier, so every other caller was billed and served at normal tier with no warning. An explicit per-request `serviceTier` still wins; note that pi-ai's `buildBaseOptions` whitelist drops that option on the `*Simple` path, so there the model's own tier is the effective one. New export: `resolveRequestedServiceTier` from `api/openai-responses-shared`.
- **Breaking:** the OpenAI Responses and ChatGPT Codex Responses adapters now serialize `model` as `model.fastRoute?.upstreamModelId ?? model.id`. A fast variant therefore routes to its base upstream model while the model object — and so the assistant message the adapter emits, its `model` field, and everything downstream that reads it — keeps the canonical `-fast` identity. Callers that previously handed these adapters a pre-substituted model should hand them the canonical model instead.
- **Breaking:** the `service_tier` cost multiplier in both adapters now keys on `model.fastRoute?.baseModelId ?? model.id`. Without this, `gpt-5.5-fast` would have been priced at the generic 2x priority rate instead of gpt-5.5's 2.5x once the adapters started receiving the canonical model.
- **Breaking:** `githubCopilotProvider().filterModels` no longer strips every model ID ending in `-fast` from the selectable list. It now exposes a model carrying `fastRoute` only when the OAuth credential's `fastModelIds` advertises that exact ID, and treats a Copilot-owned model that merely ends in `-fast` as an ordinary picker model gated by `availableModelIds`.

### Fixed

- Fixed native Anthropic Messages requests sending the interleaved-thinking beta when thinking was disabled, and preserved request-start thinking-drop diagnostics when a later provider report is empty or the stream fails.
- Fixed GitHub Copilot Claude Fable requests to use the Anthropic Messages adapter so selected reasoning levels are sent. The generated Copilot catalog now routes `claude-fable-*` alongside the other Claude 4.x/5.x entries ([#8961](https://github.com/earendil-works/pi/issues/8961)).
- Fixed the generated Fireworks catalog to serve every GLM model through the OpenAI-compatible completions API. Previously only the `glm-5p2` family took that route and newer GLM entries such as `glm-5p3` were generated against the Anthropic-compatible endpoint ([#8978](https://github.com/earendil-works/pi/issues/8978)).

## [0.9.18-alpha.5] - 2026-09-01

### Added

- Added first-class Claude Fable 5.1 (`claude-fable-5-1`) support to the generated catalogs, for the providers Atomic has a matching runtime integration for. Each entry carries the model's 1,000,000-token context window, 128,000-token maximum output, and that provider's own pricing, including the reduced $0.25 per million cache read (a quarter of Claude Fable 5's rate) and the US-only inference premium on the Amazon Bedrock `us.` profile. Adaptive thinking is always on, `off` is denied, and exactly the five efforts Anthropic publishes — `low`, `medium`, `high`, `xhigh`, `max` — are selectable, with the `high` default preserved. Provider catalogs move independently of releases, so the exact mirror set tracks them rather than being fixed here; a provider "latest" alias may also route to Fable 5.1 without naming it.
- Added the published server-side fallback targets for Claude Fable 5.1. Requests now send `fallbacks` naming Claude Opus 4.8 and Claude Opus 5, so a classifier refusal can be retried server-side and can redeem the prompt-cache fallback credit.
- Added `compat.enforcesPreservedThinkingBinding`, `compat.delegatesThinkingModelBinding`, and `compat.supportsForcedToolChoice` to the Anthropic Messages compatibility options, and `compat.supportsForcedToolChoice` plus `compat.supportsTemperature` to the Amazon Bedrock ones, so a provider can declare that its API adjudicates thinking-block signatures, that its model runs Anthropic's conversation check, and whether its model accepts forced tool use or a `temperature`.
- Added visibility for thinking blocks the Anthropic API drops. When a response reports `input_transformations`, the assistant message now carries an `anthropic_input_transformations` diagnostic with the dropped-block count, the reasons (`prefix_binding_mismatch` or `model_binding_mismatch`), and the block paths, instead of the drop being silent. Both report sites are read: `message_start`, and the final `message_delta` after a mid-stream server-side fallback.
- Added `compat.supportsTemperature` to the OpenAI-completions compatibility options, mirroring the field the Anthropic Messages compat already had, so a model that rejects the `temperature` request field can be marked as such on that API too.
- Added a public `FallbackContent` block (`{ type: "fallback", fromModel, toModel }`) to `AssistantMessage.content`. Anthropic's server-side fallback marks a mid-stream handoff with a `fallback` content block, and clients must echo it back in place because the API validates the surrounding thinking blocks against its position. It is public content rather than a stream-only event for exactly that reason.
- Added PDF document input. `DocumentContent` is a new public content block on `UserMessage.content`, and `Model.input` can now contain `"pdf"`. The Anthropic Messages path emits a base64 `document` block and the Amazon Bedrock Converse path emits a `DocumentBlock` with decoded bytes and a sanitized, neutral `name`, as AWS requires. PDF is a platform capability rather than a per-model one — "All active models support PDF processing", routed through the same vision path as images — so `"pdf"` is gated on the **API** that can serialize a document, not on the model: Claude entries on Anthropic and Amazon Bedrock gain it, and every other mirror keeps `["text", "image"]`. A document sent to a model without it is replaced by a visible placeholder, and token estimation measures the encoded payload rather than counting it as an image. `DocumentContent.mimeType` is the literal `"application/pdf"` rather than a free `string`, because that is the only media type either serializer implements — both hardcode PDF instead of reading the field — and a request carrying any other value is now rejected by name instead of being sent mislabelled. Widening that union later is non-breaking; adding a second format is not a media-type swap, since Anthropic needs a structurally different source variant for plain text and has no variant at all for Bedrock's office and markup formats.

### Fixed

- `NO_PROXY` now matches a root domain and its subdomains consistently, and understands bracketed IPv6 hosts, bare IPv6 hosts, port-scoped entries, and a bare `*` entry anywhere in the list. Previously an entry such as `example.com` did not exempt `api.example.com`, and `[2001:db8::1]` was parsed as a host/port pair ([#8737](https://github.com/earendil-works/pi/pull/8737)).
- Added a `supportsMaxOutputTokens` compatibility flag to `OpenAIResponsesCompat` (default `true`). Setting it to `false` omits `max_output_tokens` from openai-responses requests, for Codex-protocol gateways that reject the parameter with a 400 ([#8941](https://github.com/earendil-works/pi/pull/8941)).
- Fixed Claude Fable 5 and Claude Fable 5.1 sending `temperature` on the Anthropic Messages API. Anthropic rejects non-default `temperature`, `top_p`, and `top_k` on both models with a 400 on every request, whether or not thinking is on, so both are now generated with `supportsTemperature: false` and the field is omitted.
- Fixed Claude Fable 5 and Claude Fable 5.1 still sending `temperature` on Amazon Bedrock, OpenRouter, and GitHub Copilot. The Bedrock Converse and OpenAI-completions request builders emitted the field unconditionally, so every Claude Fable mirror on those APIs sent a parameter the model rejects — including OpenRouter's `~anthropic/claude-fable-latest` alias, whose id names no version. All Claude Fable entries on those two APIs are now generated with `supportsTemperature: false`, matching what the Anthropic Messages path already did for the same family, and both request builders honour it. OpenRouter's own `supported_parameters` for those entries also omits `temperature`. Models outside the Claude Fable family are unchanged.
- Fixed Claude Fable 5.1 sessions failing with a 400 `invalid_request_error` when a thinking block was replayed behind a changed conversation prefix. Anthropic enforces that check by default for organizations created on or after 2026-08-31, so a dynamic system prompt, a tool-set change, or a model switch could break an otherwise healthy session. Requests for that model now send the `thinking-binding-controls-2026-08-01` beta header with `thinking.block_binding.prefix_mismatch_behavior: "drop_block"`, so the API drops the affected thinking blocks and answers the turn. The field accompanies the header on every request for that model, including turns with no reasoning level, where the header alone would have left the behavior at its rejecting `"error"` default.
- Fixed mid-conversation model switches discarding reasoning that the target model was allowed to read. First-party Anthropic models now replay another Claude model's signed `thinking` and `redacted_thinking` blocks unchanged and let the API decide which ones the target model may use, instead of rewriting them into visible assistant text. Switching up to Claude Fable 5.1 keeps the conversation's reasoning; switching down to an earlier Claude model has the API drop it server-side. Assistant text, tool calls, and tool results are preserved in both directions. The change is scoped to `provider: "anthropic"` on the `anthropic-messages` API; Amazon Bedrock, Google Vertex, and Anthropic-compatible proxies are unchanged.
- Fixed forced tool use being sent to Claude Fable 5.1, which rejects it on every request, whichever platform serves it. The Anthropic, Amazon Bedrock, and OpenAI-completions entry points all accept a forced tool choice, so a caller could construct a request the model cannot honor. A model marked `supportsForcedToolChoice: false` now **rejects the request with an error** naming the model and Anthropic's documented remedy, rather than sending it. An earlier revision of this branch silently substituted `{"type": "auto"}`; that discarded an explicit caller instruction and is no longer done. On a gateway the old behavior was worse than a provider error, because OpenRouter drops parameters a model does not support, so the forced choice vanished and the response looked normal. `auto` and `none` are never altered, and every other model passes forced choices through unchanged. The guard is keyed on the versioned Claude Fable 5.1 model id across all three APIs, rather than on `provider: "anthropic"`, because the rejection is a property of the model rather than of Anthropic's endpoint; it therefore covers every mirror a provider currently publishes without naming a count, since those catalogs move. It is deliberately **not** applied to Claude Fable 5, which accepts forced tool use, nor to an unversioned "latest" alias whose target cannot be known from its id. On the OpenAI-completions path the check now covers all four forcing shapes in OpenAI's wider tool-choice union — `"required"`, a named `function`, a named `custom` tool, and `allowed_tools` with `mode: "required"` — where it previously tested only the first two. `allowed_tools` with `mode: "auto"` constrains the candidate set rather than forcing a call and still passes through untouched.
- Fixed Claude Fable 5.1 offering a `minimal` thinking level that Anthropic does not publish for it. The generated thinking-level map was sparse on the Anthropic, opencode, Vercel AI Gateway, and Amazon Bedrock entries, and an unmapped level is treated as available, so six levels were selectable instead of five. `minimal` is now denied explicitly, leaving exactly `low`, `medium`, `high`, `xhigh`, and `max`. The OpenRouter entries already carried a full map and are unaffected. Claude Fable 5 has the same sparse map and is deliberately left alone here.
- Fixed `samplingParams` reopening the sampling fields a model rejects. On the OpenAI-completions adapter that object is merged last so its keys override the named request fields, which meant a caller could reintroduce `temperature` on a model generated with `supportsTemperature: false` — and `top_p` and `top_k`, which are never named fields there, could only ever arrive that way. Those three keys are now stripped after the merge, so a model-level `samplingParams` default is covered too. Precedence is otherwise unchanged: every other custom key still overrides, and models without the restriction are untouched.
- Fixed mid-stream server-side fallback being silently discarded. When a classifier declined partway through a response, the `fallback` content block marking the handoff was dropped on the floor by the streaming dispatch, the message stayed attributed to the requested model, and usage was therefore costed at that model's rates instead of the model that actually produced the answer. The marker is now recorded in place, the message is re-attributed to the serving model, and cost is recomputed from the fallback target's own rates. Replay follows Anthropic's documented rules: the marker is echoed exactly where it appeared, **including onto the wire**, and `thinking`, `redacted_thinking`, and unexecuted client-side tool calls before it are dropped, because a request that echoes thinking from both sides of the boundary is rejected. A tool result whose call was dropped at the boundary is dropped with it, since an unmatched `tool_result` is rejected in turn. A decline before any output and a sticky-routed later turn were already correct and are unchanged.
- Fixed earlier fallback attempts being billed as free. Anthropic bills every attempt that produced output at the rates of the model that ran it, and reports them in `usage.iterations`, while the top-level usage describes only the attempt that produced the returned message. Those earlier attempts are now added to `usage.cost` at their own model's rates. An attempt that declined before producing any output is not billed, matching the documented rule, and the serving attempt is not counted twice. Token counts are deliberately not summed across models, which the documentation forbids.
- Fixed the Amazon Bedrock forced-tool-choice guard running after the early returns in `convertToolConfig`, so a forced choice paired with an empty or absent tool list was discarded in silence instead of rejected. The validation now runs before both returns. `toolChoice: "none"` is unaffected, since `none` is never a forced choice.
- Fixed Anthropic OAuth requests for Claude Fable 5.1 being rejected with a 400 `claude_code_version_too_old`. The OAuth path impersonates Claude Code, and Anthropic gates newer models on the `claude-cli/<version>` user agent alone; the pinned `2.1.75` predated Fable 5.1's floor, so every OAuth turn for that model failed with "version 2.1.251 or newer is required" regardless of the betas or other identity headers sent. The advertised version is now `2.1.251`, the exact published minimum the API accepts, bisected against the live endpoint rather than read off the error text. It is a strict capability superset of the old value: every Claude model this package ships answers normally at the new version. API-key requests are unaffected, since only the OAuth branch sends a Claude Code user agent.
- Fixed a `fallback` content block corrupting the content indices that follow it when a response is replayed through the faux provider. The block was skipped without occupying its slot in the streamed `partial.content`, so every later block was addressed one position short: a `[text, fallback, text]` message aborted the stream with an error and lost its second text block, and a tool call after a fallback was announced at an index holding something else. The marker now occupies its slot and simply receives no stream event, matching how the real Anthropic path already records it, so `contentIndex` continues to address `partial.content` directly for consumers that index it.


## [0.9.16] - 2026-08-29

Cumulative release of the `0.9.16-alpha.5` – `0.9.16-alpha.11` prereleases. The summary below covers the user-visible outcome of that work; the per-change detail remains in the prerelease sections below.

### Added

- Added the Meta Muse Image and Recraft V4 Styles, V4 Styles Pro, V4 Styles Pro Vector, and V4 Styles Vector image models to the generated OpenRouter catalog.
- Added the DeepSeek V4 Flash Vision experimental model to generated catalogs.

### Fixed

- Fixed fragmented Mistral tool calls splitting when continuation chunks omit the tool-call ID ([#8387](https://github.com/earendil-works/pi/issues/8387)).
- Fixed Cloudflare AI Gateway typing and mirrored supported Workers AI models through its compatibility endpoint.
- Fixed OpenAI-compatible Chat Completions reasoning streams to concatenate incremental reasoning deltas instead of replacing earlier content ([#8605](https://github.com/earendil-works/pi/pull/8605)).
- Fixed OpenRouter reasoning controls by deriving `off` support and available effort levels from model metadata, preventing reasoning-mandatory models from receiving `effort: "none"` ([#8454](https://github.com/earendil-works/pi/issues/8454)).
- Fixed OpenAI-compatible Chat Completions requests sending `tool_choice` without tools, which gateways can reject during compaction ([#8607](https://github.com/earendil-works/pi/issues/8607)).
- Fixed OpenAI-compatible Chat Completions ignoring an explicitly requested `toolChoice` when no tools are defined ([#8649](https://github.com/earendil-works/pi/issues/8649), [#8638](https://github.com/earendil-works/pi/issues/8638)).
- Fixed OpenAI-compatible streaming rewriting `thinkingSignature` on every `reasoning_details` delta. Replay metadata is buffered during streaming and serialized once when the thinking block is finalized, including on the error path ([#8671](https://github.com/earendil-works/pi/issues/8671)).

## [0.9.16-alpha.11] - 2026-08-28

### Added

- Added the Meta Muse Image and Recraft V4 Styles, V4 Styles Pro, V4 Styles Pro Vector, and V4 Styles Vector image models to the generated OpenRouter catalog.

## [0.9.16-alpha.10] - 2026-08-28

### Fixed

- Fixed fragmented Mistral tool calls splitting when continuation chunks omit the tool-call ID ([#8387](https://github.com/earendil-works/pi/issues/8387)).

## [0.9.16-alpha.5] - 2026-08-26

### Added

- Added the DeepSeek V4 Flash Vision experimental model to generated catalogs.

### Fixed

- Fixed Cloudflare AI Gateway typing and mirrored supported Workers AI models through its compatibility endpoint.
- Fixed OpenAI-compatible Chat Completions reasoning streams to concatenate incremental reasoning deltas instead of replacing earlier content ([#8605](https://github.com/earendil-works/pi/pull/8605)).
- Fixed OpenRouter reasoning controls by deriving `off` support and available effort levels from model metadata, preventing reasoning-mandatory models from receiving `effort: "none"` ([#8454](https://github.com/earendil-works/pi/issues/8454)).
- Fixed OpenAI-compatible Chat Completions requests sending `tool_choice` without tools, which gateways can reject during compaction ([#8607](https://github.com/earendil-works/pi/issues/8607)).
- Fixed OpenAI-compatible Chat Completions ignoring an explicitly requested `toolChoice` when no tools are defined ([#8649](https://github.com/earendil-works/pi/issues/8649), [#8638](https://github.com/earendil-works/pi/issues/8638)).
- Fixed OpenAI-compatible streaming rewriting `thinkingSignature` on every `reasoning_details` delta. Replay metadata is buffered during streaming and serialized once when the thinking block is finalized, including on the error path ([#8671](https://github.com/earendil-works/pi/issues/8671)).

## [0.9.15] - 2026-08-21

Cumulative release of the `0.9.15-alpha.1` prerelease. The summary below covers the user-visible outcome of that work; the per-change detail remains in the prerelease section below.

### Breaking Changes

- Built-in xAI models now use the OpenAI Responses API only; Completions is no longer registered on the xAI provider.
- Renamed the exported `GoogleThinkingLevel` type to `GoogleApiThinkingLevel` and added `ResolvedGoogleThinkingLevel` for normalized adapter levels.

### Added

- Added provider-neutral `toolChoice` on simple stream requests.
- Generalized OpenAI Completions thinking-token budget fields through `thinkingTokenBudgetField`, with `supportsThinkingTokenBudget` retained as the vLLM alias.
- Added pi's runtime `User-Agent` to Anthropic, Azure Responses, Google, Vertex, Mistral, OpenAI Completions, and OpenAI Responses requests.

### Changed

- `@bastani/pi-ai` now generates its models.dev catalog during package builds and uses the generated catalog for offline compilation.
- Vendored and rebranded the package as `@bastani/pi-ai` in the Atomic monorepo, with later tagged Atomic releases publishing it through trusted publishing.
- Moved `COPILOT_GITHUB_TOKEN` env-token host routing into the exported `@bastani/pi-ai/providers/github-copilot-env` module ([#2522](https://github.com/bastani-inc/atomic/issues/2522)).

### Fixed

- Fixed raw `COPILOT_GITHUB_TOKEN` chat authentication by sending `Copilot-Integration-Id: copilot-developer-cli`, while preserving exchanged OAuth-token behavior ([#2522](https://github.com/bastani-inc/atomic/issues/2522)).
- Fixed Amazon Bedrock Converse Stream and `pi-messages` dropping static custom-model headers; caller headers still override model headers and `null` still suppresses a static header.
- Fixed stalled OpenAI Completions, OpenAI Responses, Anthropic Messages, `pi-messages`, Mistral, and Codex provider streams by applying idle deadlines that abort the request and surface retryable transport errors. Native Codex WebSocket streams now use `streamDeadlineMs` rather than the HTTP timeout ([#2553](https://github.com/bastani-inc/atomic/issues/2553)).
- Ported upstream fixes for Copilot throttling, Kimi cache reads, DeepSeek thinking levels, Google thinking maps, Bedrock headers and reasoning, model catalogs, Anthropic fallback pricing, Azure tool choice, Z.AI effort metadata, and OpenAI reasoning replay. Cerebras now defaults to `gpt-oss-120b`, and the unused OpenTelemetry dependency was removed.

## [0.9.15-alpha.1] - 2026-08-21

### Breaking Changes

- Built-in xAI models now use the OpenAI Responses API only. Completions is no longer registered on the xAI provider.

- Renamed the exported `GoogleThinkingLevel` type to `GoogleApiThinkingLevel` and added `ResolvedGoogleThinkingLevel` for normalized adapter levels.

### Added

- Added provider-neutral `toolChoice` on simple stream requests.
- Generalized OpenAI Completions thinking-token budget fields (`thinkingTokenBudgetField`, with `supportsThinkingTokenBudget` as the vLLM alias).
- Send pi's runtime `User-Agent` on Anthropic, Azure Responses, Google, Vertex, Mistral, OpenAI Completions, and OpenAI Responses requests.

### Changed

- `@bastani/pi-ai` `build` now runs `generate-models` then `build:offline`, matching upstream. Catalog JSON under `src/providers/data/` is generated from models.dev at build time and is no longer committed.

- Vendored into the Atomic monorepo as `packages/ai` and rebranded the published package to `@bastani/pi-ai`. The first npm version must be published by hand so trusted publishing can be attached; later tagged Atomic releases publish it from `publish.yml`.

- Moved `COPILOT_GITHUB_TOKEN` env-token host routing into the exported `@bastani/pi-ai/providers/github-copilot-env` module ([#2522](https://github.com/bastani-inc/atomic/issues/2522)).

### Fixed

- Fixed raw `COPILOT_GITHUB_TOKEN` Copilot chat authentication by sending `Copilot-Integration-Id: copilot-developer-cli`; exchanged OAuth tokens containing a `tid=` segment retain their existing behavior ([#2522](https://github.com/bastani-inc/atomic/issues/2522)).
- Fixed the Amazon Bedrock Converse Stream and `pi-messages` APIs dropping a custom model's static `headers`: both now merge `model.headers` beneath caller `options.headers`, matching every other API implementation, with `null` caller values still suppressing a static header.
- Fixed GitHub Copilot requests on the default `transport: "auto"` hanging forever after a response-body decompression failure such as `Library error: zlib error: incorrect header check`. The stalled body never rejected the adapter's async iterator, so the attempt never settled and retry/model fallback never advanced. Provider streams for the `openai-completions`, `openai-responses`, and `anthropic-messages` APIs are now wrapped in an idle stream deadline that closes the source iterator and settles the attempt as a retryable transport error, and the transient-error classifier recognises zlib, `incorrect header check`, decompression, and `Library error:` wrapper text ([#2553](https://github.com/bastani-inc/atomic/issues/2553)).
- Fixed the idle stream deadline leaving the stalled provider request open: expiry now aborts an attempt-local signal, combined with the caller's signal, so the underlying HTTP request and socket are torn down before retry or model fallback starts instead of accumulating abandoned connections. The caller's own signal semantics are unchanged, the deadline error still surfaces as the retryable transport failure, and deadlines above the platform's 32-bit timer limit no longer clamp to an immediate timeout ([#2553](https://github.com/bastani-inc/atomic/issues/2553)).
- Fixed idle stream deadlines for the native `pi-messages`, Mistral conversations, and Codex SSE transports: each now threads the deadline-owned abort signal through the request and bounds the decoded event loop, so a stalled response settles and closes its body instead of remaining pending ([#2553](https://github.com/bastani-inc/atomic/issues/2553)).
- Fixed the native Codex `transport: "auto"` WebSocket path using the HTTP `timeoutMs` as its idle limit: connected streams now use the effective `streamDeadlineMs`, so a configured stream deadline triggers idle recovery without waiting for the unrelated HTTP timeout ([#2553](https://github.com/bastani-inc/atomic/issues/2553)).
- Ported unreleased `@earendil-works/pi-ai` `fix(ai)` commits from `earendil-works/pi` main after v0.84.2:
	- GitHub Copilot login now updates only known tool-capable models with unconfigured policies, runs those updates sequentially, and retries throttled `/models` and policy requests within a bounded delay ([#7850](https://github.com/earendil-works/pi/issues/7850), [#8254](https://github.com/earendil-works/pi/pull/8254)).
	- Kimi OpenAI-compatible usage now treats top-level `cached_tokens` as cache reads ([#8119](https://github.com/earendil-works/pi/pull/8119), [#8075](https://github.com/earendil-works/pi/issues/8075)).
	- DeepSeek V4 Flash on OpenCode and OpenCode Go exposes a `low` thinking level ([#8181](https://github.com/earendil-works/pi/pull/8181)).
	- Google Generative AI and Vertex AI honor `thinkingLevelMap` on custom models ([#8135](https://github.com/earendil-works/pi/issues/8135)).
	- Amazon Bedrock `onResponse` forwards raw Smithy response headers ([#8243](https://github.com/earendil-works/pi/pull/8243), [#8234](https://github.com/earendil-works/pi/issues/8234)).
	- Xiaomi catalog generation drops shut-down MiMo V2 model names ([#8187](https://github.com/earendil-works/pi/issues/8187)).
	- China ZAI Coding Plan uses the `zhipuai-coding-plan` catalog, including GLM-4.6V, and PAYG-equivalent usage estimates ([#8220](https://github.com/earendil-works/pi/issues/8220)).
	- Qwen Token Plan Individual includes `deepseek-v4-pro-0813` ([#8194](https://github.com/earendil-works/pi/issues/8194)).
	- Anthropic server-side refusal fallbacks are declared in model metadata and priced from the returned fallback model, not stream options ([#8258](https://github.com/earendil-works/pi/pull/8258), [#8319](https://github.com/earendil-works/pi/pull/8319), [#8352](https://github.com/earendil-works/pi/pull/8352), [#8285](https://github.com/earendil-works/pi/issues/8285)).
	- Azure OpenAI Responses forwards `toolChoice`.
	- Baseten GLM-5.2 declares image input.
	- Bedrock round-trips non-Anthropic redacted reasoning ([#8314](https://github.com/earendil-works/pi/pull/8314)).
	- Z.AI reasoning effort metadata is derived from models.dev options, preserving GLM-5.2 `none` and exposing GLM-5.3 low/high/max ([#8336](https://github.com/earendil-works/pi/issues/8336)).
	- OpenAI-compatible Chat Completions preserves and resends assistant-level `reasoning_details` via `thinkingSignature` ([#8246](https://github.com/earendil-works/pi/pull/8246), [#7994](https://github.com/earendil-works/pi/issues/7994)).
- Removed the unused `@opentelemetry/api` dependency from `@bastani/pi-ai`.
- Cerebras default model is now `gpt-oss-120b`.
