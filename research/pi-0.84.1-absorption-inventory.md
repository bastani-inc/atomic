# pi v0.84.1 breaking-change absorption inventory

Reconnaissance for the `pi-0.84.1/adopt-upstream` layer. This document maps every
breaking change from `@earendil-works/pi-*` v0.83.0 → v0.84.1 onto the exact Atomic
call sites, states the clean-break edit, and names the gate that proves it.

**No source file, manifest, or lockfile is modified by this document.**

## Install blocker (why this layer stalled at reconnaissance)

The committed `.npmrc` sets `min-release-age=2`, which npm applies as **2 days**.
Every `@earendil-works/pi-*@0.84.1` was published inside that window, so resolution
fails:

```
npm error code ETARGET
npm error notarget No matching version found for @earendil-works/pi-agent-core@0.84.1
npm error notarget with a date before 8/5/2026, 8:59:11 AM.
```

| package | 0.84.1 published | 0.84.0 published |
| --- | --- | --- |
| `@earendil-works/pi-client` | 2026-08-07T05:56:17Z | 2026-08-06T10:51:18Z |
| `@earendil-works/pi-protocol` | 2026-08-07T05:56:27Z | 2026-08-06T10:51:15Z |
| `@earendil-works/pi-telemetry` | 2026-08-07T05:56:40Z | 2026-08-06T10:50:53Z |
| `@earendil-works/pi-tui` | 2026-08-07T05:59:51Z | 2026-08-06T11:08:55Z |
| `@earendil-works/pi-agent-core` | 2026-08-07T06:01:20Z | 2026-08-06T11:09:53Z |
| `@earendil-works/pi-ai` | 2026-08-07T06:03:23Z | 2026-08-06T11:11:50Z |

The latest of these is `pi-ai`, so the set becomes installable at
**2026-08-09T06:03:23Z**. 0.84.0 is blocked as well; only ≤0.83.0 resolves today.

Overriding the gate (`--before`, `min-release-age=0`, `--force`, editing `.npmrc`,
hand-editing `package-lock.json`) is forbidden by the layer contract, so the
dependency commit is held **atomic**: manifest ranges are not committed without a
regenerated lock, because `npm install --package-lock-only` cannot resolve and
`npm run check` (`check:shrinkwrap`) would go red.

Not blocked by the gate, verified by probe:

- `grok-mermaid@0.2.2` — published 2026-08-04T18:13:46Z, installs cleanly.
- `undici@8.9.0` — published 2026-07-24T12:32:49Z, and already pinned at `8.9.0`
  in `packages/coding-agent/package.json:109`.

## Sources

Upstream monorepo checkout `/Users/tonystark/Documents/projects/atomic-pi-0.84.0-upstream`,
tags `v0.83.0` / `v0.84.0` / `v0.84.1`. It is a partial clone with no working tree;
a few v0.83.0 blobs are absent from the object database, but `git show`, `git grep`,
and `git diff v0.83.0..v0.84.1` all resolve for every path cited here.

npm-name → upstream-directory mapping (verified in each `package.json`):

| npm package | upstream path |
| --- | --- |
| `@earendil-works/pi-agent-core` | `packages/agent` |
| `@earendil-works/pi-ai` | `packages/ai` |
| `@earendil-works/pi-tui` | `packages/tui` |
| `@earendil-works/pi-client` | `packages/client` |
| `@earendil-works/pi-protocol` | `packages/protocol` |
| `@earendil-works/pi-telemetry` | `packages/telemetry` |

`packages/coding-agent` in that checkout is upstream's own consumer and is the
worked example for each absorption below.

---

## Break 1 — `ModelsStreamTransforms` → `ModelsRequestTransforms`

**Upstream delta.** `git show v0.84.1:packages/ai/src/models.ts` line 78 defines
`ModelsRequestTransforms`; v0.83.0 line 58 defined `ModelsStreamTransforms`. The
member is unchanged:

```ts
export interface ModelsRequestTransforms {
	/** Transform fully assembled model/auth/request headers before provider dispatch. */
	transformHeaders?: (headers: ProviderHeaders) => ProviderHeaders | Promise<ProviderHeaders>;
}
```

v0.84.1 also adds `ModelsDeferredFetchOptions` / `ModelsDeferredCancelOptions`
(`models.ts:85-86`) built on the same interface. The old name is **gone**, not
aliased — `packages/ai/CHANGELOG.md:13` records the rename.

**Atomic call sites.** Three, all in one file:

- `packages/coding-agent/src/core/model-runtime-streaming.ts:13` — type import
- `packages/coding-agent/src/core/model-runtime-streaming.ts:51` — `prepareRequest` parameter
- `packages/coding-agent/src/core/model-runtime-streaming.ts:85` — `as` cast in `stream()`

**Clean-break edit.** Rename all three occurrences. No alias, no re-export.

**Divergence note.** Upstream keeps this logic inside `model-runtime.ts`
(`v0.84.1:packages/coding-agent/src/core/model-runtime.ts:29,573,618`); Atomic
extracted it into `model-runtime-streaming.ts`. That extraction is an Atomic
divergence and must be preserved — port the rename into Atomic's file layout
rather than collapsing the file back into `model-runtime.ts`.

**Proving gate.** `npm run check` (`tsc --noEmit`).

---

## Break 2 — `getApiKeyAndHeaders()` returns `ProviderHeaders` with `string | null`

**Upstream delta.** The `ProviderHeaders` type itself did **not** change:
`packages/ai/src/types.ts:107` (v0.83.0) and `:110` (v0.84.1) both read
`export type ProviderHeaders = Record<string, string | null>`.

What changed is coding-agent's `ResolvedRequestAuth`. Upstream v0.83.0
(`packages/coding-agent/src/core/model-registry.ts:6-13`):

```ts
export type ResolvedRequestAuth =
	| { ok: true; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> }
	| { ok: false; error: string };
```

Upstream v0.84.1 (`packages/coding-agent/src/core/model-registry.ts:17-25`):

```ts
export type ResolvedRequestAuth =
	| {
			ok: true;
			apiKey?: string;
			headers?: ProviderHeaders;
			baseUrl?: string;
			env?: Record<string, string>;
	  }
	| { ok: false; error: string };
```

Two deltas: `headers` widens from `Record<string, string>` to `ProviderHeaders`
(admitting `null` deletion markers), and `baseUrl?: string` is added. The v0.84.1
implementation populates `baseUrl` conditionally
(`model-registry.ts:76`: `...(resolution.auth.baseUrl ? { baseUrl: resolution.auth.baseUrl } : {})`).

**Atomic call sites.** Atomic's `packages/coding-agent/src/core/model-registry.ts:6-13`
is byte-identical to upstream v0.83.0 — this is a clean adoption target with no Atomic
divergence layered on top. The narrowing lives at:

- `packages/coding-agent/src/core/model-registry.ts:10` — `headers?: Record<string, string>;`

Consumers of the returned `headers` (none of which filter or strip — verified
pass-through):

- `packages/web-access/summary-review.ts:184` (return type already `ProviderHeaders`), `:197`, `:204`, `:211`, `:216`, `:250`, `:259`
- `packages/web-access/web-search-summary.ts:16` (return type already `ProviderHeaders`), `:20`, `:25`, `:37`, `:51`
- `packages/mcp/sampling-handler.ts:150`
- `packages/coding-agent/src/core/model-registry.ts:52` — the method itself
- Examples: `packages/coding-agent/examples/extensions/qna.ts:80`, `summarize.ts:169`, `handoff.ts:82`

**Clean-break edit.** Change `model-registry.ts:10` to `headers?: ProviderHeaders;`,
add `ProviderHeaders` to the `@earendil-works/pi-ai` type import at
`model-registry.ts:1`, and add `baseUrl?: string`. Do **not** add a null-stripping
filter anywhere. Both `web-access` modules already declare their locals as
`ProviderHeaders` and assign `auth.headers` straight through, so they need no edit
for the widening — but they must be re-read to confirm no `Object.entries` filter is
introduced.

**Collision risk.** Low. The two `web-access` modules are raw-TS companion packages;
edits there must not introduce a build step.

**Proving gate.** `npm run check`; `npm run test --workspace=@bastani/atomic` for
`packages/coding-agent/test/pi-0.82.1-auth.test.ts:74` which asserts on the exact
resolved-auth object shape.

---

## Break 3 — `message_update` emits delta-only events on the wire

**This is the highest-risk item in the layer.**

**Upstream delta.** The *core* event is unchanged. `v0.84.1:packages/agent/src/types.ts:438`
still reads:

```ts
| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
```

The change is at the **JSON/RPC serialization boundary**. v0.84.1 **adds**
`packages/coding-agent/src/modes/json-event.ts` (confirmed `A` in
`git diff --name-status v0.83.0..v0.84.1`), which drops the cumulative `message`
snapshot and the `partial` field:

```ts
type WithoutPartial<T> = T extends { partial: unknown } ? Omit<T, "partial"> : T;

type ToJsonEvent<T> = T extends { type: "message_update"; assistantMessageEvent: infer TAssistantMessageEvent }
	? { type: "message_update"; assistantMessageEvent: WithoutPartial<TAssistantMessageEvent> }
	: T;

/** Session event shape emitted by the JSON and RPC stdout protocols. */
export type JsonAgentSessionEvent = ToJsonEvent<AgentSessionEvent>;

/**
 * Remove cumulative assistant snapshots from streaming wire events.
 * `message_start` provides the initial message, deltas build it, and
 * `message_end` provides the final authoritative message.
 */
export function toJsonEvent(event: AgentSessionEvent): JsonAgentSessionEvent { /* ... */ }
```

Upstream wires it in at three points: `modes/index.ts:6` (re-export of the type),
`modes/print-mode.ts:13`, and `modes/rpc/rpc-mode.ts:30` + `:356`
(`output(toJsonEvent(event))`). `modes/rpc/rpc-client.ts:14` imports the type.

**Atomic call sites.** Atomic already carries the delta on the in-process event —
`packages/coding-agent/src/core/agent-session-events.ts:427-432` builds
`{ type, message, assistantMessageEvent }`, and
`packages/coding-agent/src/core/extensions/agent-events.ts:88-92` declares
`MessageUpdateEvent` with all three fields. Those match upstream and need no change.

What Atomic lacks is the wire-boundary conversion, and what Atomic *adds* is two
coalescing buffers that upstream does not have:

- `packages/coding-agent/src/modes/rpc/rpc-output-buffer.ts:19-27`
- `packages/coding-agent/src/modes/rpc/rpc-event-buffer.ts:13-24`

Both key every `message_update` to the **single constant key `"message"`** and
`Map.set` it, so within each 16 ms window only the **last** update survives:

```ts
const key = event.type === "message_update" ? "message" : ...;
this.updates.set(key, event);
this.timer ??= setTimeout(() => this.flush(), 16);
```

That is sound **only** while `message_update` carries the cumulative `message`
snapshot, because the surviving last event still contains everything. Under the
0.84.1 delta-only wire contract the dropped events are **the only carrier of their
own text**, so coalescing silently loses assistant output. This is a real
correctness regression, not a typecheck failure — `tsc` will not catch it.

Related event-type locations that must stay consistent:

- `packages/coding-agent/src/core/extensions/api-types.ts:111` — `on("message_update", ...)` overload
- `packages/coding-agent/src/modes/interactive/interactive-agent-events.ts:177`
- `packages/coding-agent/src/modes/interactive/components/chat-session-host-events.ts:341,446,452`
- `packages/coding-agent/src/modes/interactive/components/chat-message-renderer.ts:173,230`
- `packages/coding-agent/src/modes/index.ts` — Atomic's mode barrel, the correct home for the `JsonAgentSessionEvent` re-export (it already re-exports the RPC types at lines 9-16)

**Where the delta contract belongs in Atomic.** Atomic has no `modes/json-event.ts`.
`AgentSessionEvent` lives in `packages/coding-agent/src/core/agent-session.ts`
(exported at `:62`), exactly as upstream, so upstream's file drops in at
`packages/coding-agent/src/modes/json-event.ts` with its import path unchanged
(`../core/agent-session.ts`). Re-export the type from
`packages/coding-agent/src/modes/index.ts` to mirror upstream `modes/index.ts:6`.

**Clean-break edit.**

1. Add `packages/coding-agent/src/modes/json-event.ts` mirroring upstream exactly.
2. Re-export `JsonAgentSessionEvent` from `packages/coding-agent/src/modes/index.ts`.
3. Apply `toJsonEvent` at Atomic's stdout boundaries, mirroring upstream's
   `output(toJsonEvent(event))`.
4. **Stop coalescing `message_update` in both buffers.** Deltas must be emitted in
   order, every one of them. Keep the `tool:${toolCallId}` coalescing, which is
   still cumulative and therefore still safe. The contract explicitly forbids
   "cumulative message reconstruction in RPC buffers", so the fix is pass-through,
   **not** re-accumulating a snapshot inside the buffer.

**Divergence note.** `rpc-output-buffer.ts` and `rpc-event-buffer.ts` do not exist
upstream (`git ls-tree v0.84.1 packages/coding-agent/src/modes/rpc/` lists only
`jsonl.ts`, `rpc-client.ts`, `rpc-mode.ts`, `rpc-types.ts`). They are fork-owned
throughput optimizations, so there is no upstream diff to copy — the change has to
be reasoned about against the new contract.

**Proving gate.** `npm run test --workspace=@bastani/atomic`. Mirror upstream's
regression test `test/suite/regressions/7290-json-stream-linear.test.ts`, which
asserts session events keep `message`/`partial` while JSON events drop both, and
that payload bytes scale linearly (`largeBytes / smallBytes < 2.2`). Add a focused
buffer test asserting that N distinct `text_delta` updates in one 16 ms window
produce N emitted records, concatenating to the full text — that test fails against
today's coalescing buffers and passes after the fix.

---

## Break 4 — `ModelRegistry.refresh()` returns `ModelsRefreshResult`

**Upstream delta.** The pi-ai `Models.refresh` signature is **not** new in 0.84.1 —
`refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult>` already
existed at `v0.83.0:packages/ai/src/models.ts:147`. Two things did change:

`ModelsRefreshOptions` gains `providers` (`v0.84.1:packages/ai/src/models.ts:64-71`):

```ts
export interface ModelsRefreshOptions {
	allowNetwork?: boolean;
	/** Restrict refresh to these provider IDs. Unknown and static providers are ignored. */
	providers?: readonly string[];
	force?: boolean;
	signal?: AbortSignal;
}

export interface ModelsRefreshResult {
	aborted: boolean;
	errors: ReadonlyMap<string, Error>;
}
```

And upstream's coding-agent `ModelRegistry` facade changed from
`async refresh(): Promise<void>` (v0.83.0 `model-registry.ts:28-30`) to
(v0.84.1 `model-registry.ts:40-42`):

```ts
refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult> {
	return this.runtime.refresh(options);
}
```

**Atomic call sites.** Atomic's `ModelRuntime` is **already on the new signature** —
`packages/coding-agent/src/core/model-runtime.ts:457` reads
`async refresh(options: ModelsRefreshOptions = {}): Promise<ModelsRefreshResult>`.
Only the facade is stale:

- `packages/coding-agent/src/core/model-registry.ts:28-30` — `async refresh(): Promise<void>`

There is also a defensive shim to remove at `model-runtime.ts:465-470`:

```ts
// Published pi-ai builds before ModelsStore returned void and accepted a provider ID.
// The fallback keeps source-mode CLI tests working without rebuilding workspace dependencies.
const result = ((await this.models.refresh(refreshOptions)) as ModelsRefreshResult | undefined) ?? {
	aborted: refreshOptions.signal?.aborted ?? false,
	errors: new Map(),
};
```

Under 0.84.1 the result is guaranteed, so the `as ... | undefined` cast and the `??`
fallback are exactly the kind of compatibility path the clean-break rule removes.

Callers of the facade (unaffected, `options` is optional):

- `packages/coding-agent/src/extensions/llama/index.ts:53` — `await ctx.modelRegistry.refresh()`

`ModelRuntime.refresh` callers that already pass options and would benefit from
handling `errors`/`aborted`:

- `model-runtime.ts:132,345,354,359,486,524,532`
- `packages/coding-agent/src/core/agent-session-services.ts:181`
- `packages/coding-agent/src/core/sdk.ts:87`
- `packages/coding-agent/src/main.ts:612`
- `packages/coding-agent/src/modes/interactive/interactive-model-catalog-startup.ts:21`
- `packages/coding-agent/src/modes/interactive/interactive-auth-login.ts:28`
- `packages/coding-agent/src/modes/interactive/interactive-model-routing.ts:57,145`
- `packages/coding-agent/src/modes/interactive/components/model-selector.ts:164`
- `packages/coding-agent/src/modes/rpc/rpc-command-handler.ts:199`
- `packages/coding-agent/src/modes/interactive-engine/remote-model-catalog.ts:39`
- `packages/coding-agent/src/package-manager-cli.ts:99`

**Registry test suites in scope** (18 files, the "~15" of the contract):

```
packages/coding-agent/test/model-registry-api-key-resolution.suite.ts
packages/coding-agent/test/model-registry-base-url-overrides.suite.ts
packages/coding-agent/test/model-registry-cost-tiers.suite.ts
packages/coding-agent/test/model-registry-custom-models.suite.ts
packages/coding-agent/test/model-registry-dynamic-providers.suite.ts
packages/coding-agent/test/model-registry-fixtures.ts
packages/coding-agent/test/model-registry-hot-reload.test.ts
packages/coding-agent/test/model-registry-model-overrides.suite.ts
packages/coding-agent/test/model-registry-provider-membership.suite.ts
packages/coding-agent/test/model-registry-provider-runtime-ownership.suite.ts
packages/coding-agent/test/model-registry-refresh-credential-resolution.test.ts
packages/coding-agent/test/model-registry.test.ts
packages/coding-agent/test/model-runtime-auth-options.test.ts
packages/coding-agent/test/model-runtime-cloudflare-compat.test.ts
packages/coding-agent/test/model-runtime-modify-models-compat.test.ts
packages/coding-agent/test/model-runtime-refresh-bounds.test.ts
packages/coding-agent/test/model-runtime-test-utils.ts
packages/coding-agent/test/sdk-shared-model-registry.test.ts
```

**Clean-break edit.** Adopt upstream's facade body verbatim; delete the
`model-runtime.ts:465-470` cast/fallback; have callers that need it inspect
`result.errors` and `result.aborted`. No wrapper preserving the old `Promise<void>`.

**Proving gate.** `npm run check`; `npm run test --workspace=@bastani/atomic`.

---

## Break 5 — `ModelRuntime.setRuntimeApiKey()` takes auth-cancellation options

**Upstream delta.** v0.83.0 `packages/coding-agent/src/core/model-runtime.ts:400`
took refresh options and refreshed inline. v0.84.1 `:536-547` takes
`AuthOperationOptions`, enqueues the credential operation under an operation signal,
and **does not refresh the catalog**:

```ts
setRuntimeApiKey(providerId: string, apiKey: string, options: AuthOperationOptions = {}): Promise<void> {
	const signal = operationSignal(options.signal);
	return this.enqueueCredentialOperation(providerId, signal, async () => {
		this.credentials.setRuntimeApiKey(providerId, apiKey);
		await this.synchronizeCredentialState(providerId, "setRuntimeApiKey", { type: "api_key", key: apiKey }, signal);
	});
}
```

v0.84.1 also adds the operation-kind union at `model-runtime.ts:91`
(`CredentialSynchronizationOperation = "login" | "logout" | "setRuntimeApiKey" | "removeRuntimeApiKey"`),
and upstream's own caller at `main.ts:815` correspondingly drops the
`{ allowNetwork: false }` argument it passed at v0.83.0 `main.ts:764`.

**Atomic call sites.**

- `packages/coding-agent/src/core/model-runtime.ts:347-355` — the definition, still
  `refreshOptions: ModelsRefreshOptions = {}` and still calling `await this.refresh(refreshOptions)`
- `packages/coding-agent/src/core/model-runtime.ts:357-360` — `removeRuntimeApiKey`, same pattern
- `packages/coding-agent/src/core/runtime-credentials.ts:21` — `setRuntimeApiKey(providerId, apiKey): void`, the inner store (upstream `runtime-credentials.ts:12` is identical; **no change needed**)
- `packages/coding-agent/src/main-runtime-api-key.ts:3,11` — passes `{ allowNetwork: false }`
- Tests: `packages/coding-agent/test/main-runtime-api-key.test.ts:7,18`, `runtime-credentials.test.ts:10,23,24,35`, `model-registry-refresh-credential-resolution.test.ts:94`, `model-registry-provider-runtime-ownership.suite.ts:150`, `model-auth-compatibility.test.ts:264,273`
- Examples: `packages/coding-agent/examples/sdk/09-api-keys-and-oauth.ts:31`, `12-full-control.ts:25`

**Clean-break edit.** Change the parameter to auth-cancellation options and remove
the inline `refresh`. Callers that need catalog freshness call
`refresh({ providers: [providerId], signal })` separately — `providers` is the new
0.84.1 option from Break 4, which is what makes the split efficient. Update
`main-runtime-api-key.ts:11` to stop passing `{ allowNetwork: false }` and add an
explicit refresh only if the CLI path actually needs a fresh catalog. No defaulted
compatibility parameter.

**Proving gate.** `npm run check`; `npm run test --workspace=@bastani/atomic`
(`main-runtime-api-key.test.ts` asserts the exact argument tuple at `:18` and will
need updating in lockstep).

---

## Break 6 — provider refresh context: `context.stored` + `context.publish()`

**Upstream delta.** `RefreshModelsContext` in `packages/ai/src/models.ts`:

v0.83.0 `:34-44`:

```ts
export interface RefreshModelsContext {
	credential?: Credential;
	/** Persistent model storage scoped to this provider ID. */
	store: ProviderModelsStore;
	allowNetwork: boolean;
	force?: boolean;
	signal?: AbortSignal;
}
```

v0.84.1 `:46-62`:

```ts
export interface RefreshModelsContext {
	credential?: Credential;
	/** Immutable provider-scoped catalog snapshot captured before this refresh phase. */
	stored?: Readonly<ModelsStoreEntry>;
	/**
	 * Generation-checked publication. Persistence policy remains provider-owned;
	 * the update runs synchronously only after the selected persistence mutation.
	 */
	publish(publication: ModelsPublication): Promise<boolean>;
	allowNetwork: boolean;
	force?: boolean;
	/** Always present, including when the public refresh caller omits its optional signal. */
	signal: AbortSignal;
}
```

Three deltas: `store` is **removed** in favour of the read-only `stored` snapshot;
`publish()` is added and returns `false` when a newer generation superseded this
refresh; and `signal` becomes **required**, so `context.signal?.aborted` narrows to
`context.signal.aborted`. `packages/ai/CHANGELOG.md` carries a full before/after
migration for handwritten `refreshModels`, including the rule that `publish()` omits
`persist` to leave storage alone, takes a `ModelsStoreEntry` to write, or
`persist: null` to delete.

**Atomic handwritten `refreshModels` implementations.** Two:

- `packages/coding-agent/src/core/remote-catalog-provider.ts:55-91` — reads
  `await context.store.read()` at `:58`, guards on `context.signal?.aborted` at `:60`,
  and mutates the `dynamicModels` closure at `:59` before any publication
- `packages/coding-agent/src/extensions/llama/provider.ts:113-127` — reads
  `await context.store.read()` at `:114`, mutates the `models` closure at `:116`,
  guards `context.signal?.aborted` at `:122`, writes via
  `await context.store.write({ models, checkedAt: Date.now() })` at `:127`

Both follow exactly the "Before" shape in the upstream changelog and both need the
generation-guarded rewrite.

Type declarations that mention the context and must stay in sync:

- `packages/coding-agent/src/core/provider-composer-internal.ts:62`
- `packages/coding-agent/src/core/extensions/provider-types.ts:35`
- `packages/coding-agent/src/core/provider-composer.ts:113-118` — the composer that
  chains `base?.refreshModels` then `extension.refreshModels`; it forwards the
  context object and so inherits the shape change

Tests constructing a context literal (each will need `stored`/`publish` instead of
`store`): `remote-catalog-provider.test.ts` (13 call sites), `remote-catalog-etag.test.ts`
(`:62,66,84,106,109`), `llama-extension.test.ts:117,126`,
`model-registry-dynamic-providers.suite.ts:367,385` (these two read `{ store }` directly),
`package-command-model-refresh.test.ts:70,113`,
`model-registry-refresh-credential-resolution.test.ts:18,39,68,98,121`,
`model-registry-provider-runtime-ownership.suite.ts:152,171`,
`model-auth-compatibility.test.ts:294`, `model-runtime-modify-models-compat.test.ts:150`,
`rpc-oauth-login.test.ts:100,101,109`.

**Clean-break edit.** Rewrite both implementations per the changelog: restore from
`context.stored` inside a `publish({ update })` and bail when it returns `false`;
after the network fetch, bail on `context.signal.aborted` and then
`publish({ persist: {...}, update: () => {...} })`. Drop the `?.` on `signal`.

**Collision risk.** `remote-catalog-provider.ts` holds Atomic's ETag/304
revalidation logic (`:70-73`) and its `inflightRefresh` de-duplication (`:56`) —
both are Atomic divergences with dedicated tests (`remote-catalog-etag.test.ts`) and
must survive the rewrite. The comment at `:70-72` ("Only revalidate when a cached
body backs the validator, so a 304 can never leave the overlay empty") encodes a
fixed bug; preserve that invariant when `stored` replaces `store.read()`.

**Proving gate.** `npm run check`; `npm run test --workspace=@bastani/atomic`,
specifically `remote-catalog-provider.test.ts`, `remote-catalog-etag.test.ts`,
`llama-extension.test.ts`.

---

## Break 7 — OAuth `refreshToken(credentials, signal)` honors the abort signal

**Upstream delta.** `packages/ai/src/auth/types.ts`, `OAuthAuth.refresh`:

- v0.83.0 `:202` — `refresh(credential: OAuthCredential, signal?: AbortSignal): Promise<OAuthCredential>;`
- v0.84.1 `:222` — `refresh(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential>;`

The signal becomes **required**. `packages/ai/CHANGELOG.md` frames this as
"Required provider login, API-key check/resolution, and OAuth refresh implementations
to accept a concrete abort signal", and lists the motivating fix: "Bounded OAuth
token refreshes so stalled requests release the credential-store lock" (#7508).

**Atomic call sites.** This surface is **fork-owned** — upstream has no
`provider-composer-internal.ts` (`git ls-tree v0.84.1 packages/coding-agent/src/core/`
lists only `provider-composer.ts`), so there is no upstream diff to copy and the
adaptation must be written against the new pi-ai contract.

- `packages/coding-agent/src/core/provider-composer-internal.ts:33` —
  `refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;` in
  `ExtensionOAuthConfig`, no signal parameter
- `packages/coding-agent/src/core/provider-composer-internal.ts:244` — the adapter
  `refresh: async (credential) => ({ ...(await config.refreshToken(credential)), type: "oauth" })`,
  which drops the incoming signal on the floor
- `packages/coding-agent/src/core/extensions/provider-types.ts:47` — the public
  extension-facing declaration, same shape
- `packages/coding-agent/src/core/extensions/api-types.ts:305` — doc comment
  showing `async refreshToken(credentials) { ... }`, must be updated so the
  documented example matches the new signature

Extension examples that implement it:
`packages/coding-agent/examples/extensions/custom-provider-gitlab-duo/index.ts:395`,
`custom-provider-anthropic/index.ts:506`.

Tests supplying `refreshToken`: `model-runtime-modify-models-compat.test.ts:187`,
`rpc-oauth-login.test.ts:32,228,406,482`,
`model-registry-provider-runtime-ownership.suite.ts:26`,
`model-auth-compatibility.test.ts:242,291`,
`model-registry-dynamic-providers.suite.ts:40,171`,
`suite/agent-session-auth.test.ts:37`, `model-runtime-auth-options.test.ts:242`.

**Adjacent break, not in the contract list — `ProviderAuthInteraction`.** v0.84.1
adds `packages/ai/src/auth/types.ts:164`:

```ts
export type ProviderAuthInteraction = AuthInteraction & { signal: AbortSignal };
```

and changes both login members to take it (`:175` `ApiKeyAuth.login?`, `:216`
`OAuthAuth.login`). `AuthInteraction` itself still exists (`:156`), so Atomic's type
imports keep resolving — but anything Atomic passes *into* a provider `login()` now
needs a `signal`. Affected:

- `packages/coding-agent/src/core/model-runtime.ts:7,416` — `login(providerId, type, interaction: AuthInteraction)`
- `packages/coding-agent/src/core/oauth-login.ts:1,73` — `createAuthInteraction(...): AuthInteraction`
- `packages/coding-agent/src/core/provider-composer-internal.ts:6,309` — `(async (interaction: AuthInteraction) => ...)`
- `packages/coding-agent/src/core/agent-session-runtime-auth.ts:5,20`
- `packages/coding-agent/src/modes/rpc/rpc-oauth-interaction.ts:8,24`

This is a genuine compile break that the ten-item list does not mention. Absorb it in
the same commit as Break 7, since it is the same "concrete abort signal" changelog
bullet.

**Clean-break edit.** Add the required `signal` parameter to both fork-owned
declarations and thread the incoming signal through the `:244` adapter into
`config.refreshToken(credential, signal)`. Widen the interaction types to
`ProviderAuthInteraction` where a provider consumes them. No defaulted parameter and
no overload preserving the one-argument form.

**Proving gate.** `npm run check`; `npm run test --workspace=@bastani/atomic`
(`rpc-oauth-login.test.ts` is the densest coverage).

---

## Break 8 — v4 lane-based session exports — **near-null result for Atomic**

**Upstream delta.** `packages/agent/src/index.ts` replaced six session re-exports
with a barrel. v0.83.0 lines 32-37:

```
export * from "./harness/session/jsonl-repo.ts";
export * from "./harness/session/jsonl-storage.ts";
export * from "./harness/session/memory-repo.ts";
export * from "./harness/session/memory-storage.ts";
export * from "./harness/session/repo-utils.ts";
export * from "./harness/session/session.ts";
```

v0.84.1 lines 79-82:

```
export * from "./harness/result.ts";
export * from "./harness/session/index.ts";
export * from "./harness/session/search.ts";
```

The package `exports` map also gains a subpath (verified in both `package.json`
files):

| tag | subpaths |
| --- | --- |
| v0.83.0 | `.`, `./node`, `./package.json` |
| v0.84.1 | `.`, `./node`, `./session/testing`, `./package.json` |

Note the direction: v0.83.0 had **no** experimental subpath to lose, and v0.84.1
*adds* `./session/testing`.

**Atomic call sites.** Effectively none.

- `SessionRepo`, `SessionStorage`, `JsonlSessionRepo`, `InMemorySessionRepo` — **zero**
  occurrences anywhere under `packages/` (ripgrep, excluding `node_modules`).
- Experimental / `session/testing` subpath imports — **zero** occurrences.
- `AgentHarness` — one consumer,
  `packages/coding-agent/test/pi-0.82.1-direct-fixes.test.ts:5` (named import from
  `@earendil-works/pi-agent-core`) asserting `typeof AgentHarness === "function"` at
  `:115-116`. `AgentHarness` reaches the barrel through
  `export * from "./harness/agent-harness.ts"` in **both** tags (v0.83.0 index line 6,
  v0.84.1 index line 46), so the **named import keeps working** — the "now the default
  export" framing does not break Atomic's import form.

**Atomic's `experimental` is unrelated.** `packages/coding-agent/src/index.ts:119`
and `src/core/index.ts:31` export `areExperimentalFeaturesEnabled` from Atomic's own
`./core/experimental.ts`, and `test/experimental.test.ts` covers that local flag
helper. This is **not** a pi subpath re-export and must be left alone.

**Clean-break edit.** None required. Verify after install that
`test/pi-0.82.1-direct-fixes.test.ts` still resolves `AgentHarness`, and do **not**
add re-exports of the removed repo APIs.

**Proving gate.** `npm run check`; `npm run test --workspace=@bastani/atomic`.

---

## Break 9 — `FileSystem.renameFile()` — **null result for Atomic**

**Atomic call sites.** Ripgrep across all of `packages/` (excluding `node_modules`)
finds **zero** occurrences of `renameFile` and **zero** occurrences of the identifier
`FileSystem`. Atomic defines no custom harness filesystem, so there is no
implementation to add.

**Clean-break edit.** None. Explicitly do not add a default `renameFile` mixin.

**Proving gate.** `npm run check` — if a pi type does require the member on some
object literal Atomic passes, `tsc` surfaces it after install; today there is no such
literal.

**Caveat.** This is the one break that cannot be fully confirmed without the 0.84.1
typings, because a newly *required* interface member only shows up when the new
`.d.ts` is present. The zero-occurrence result is strong evidence it is a no-op, but
re-run the check after install before closing it.

---

## Break 10 — dependency manifest delta (exact edit set, not applied)

Two corrections to the layer brief, both verified by reading the manifests:

1. **The five companion packages carry pi packages only in `peerDependencies`.**
   Their `dependencies` blocks contain no `@earendil-works/pi-*` entries at all, so
   there is no dependencies-side edit for them.
2. **`undici` is already at the target.** `packages/coding-agent/package.json:109`
   already reads `"undici": "8.9.0"`, matching upstream
   `v0.84.1:packages/coding-agent/package.json:65`. Item 4 is a no-op unless the
   lock regeneration surfaces a transitive conflict, in which case pi's pin wins.

### `packages/coding-agent/package.json` — `dependencies`

| line | current | target |
| --- | --- | --- |
| 83 | `"@earendil-works/pi-agent-core": "^0.83.0"` | `"^0.84.1"` |
| 84 | `"@earendil-works/pi-ai": "^0.83.0"` | `"^0.84.1"` |
| 85 | `"@earendil-works/pi-tui": "^0.83.0"` | `"^0.84.1"` |
| — | *(absent)* | add `"@earendil-works/pi-client": "^0.84.1"` |
| — | *(absent)* | add `"@earendil-works/pi-protocol": "^0.84.1"` |
| — | *(absent)* | add `"grok-mermaid": "0.2.2"` (exact, no caret) |
| 109 | `"undici": "8.9.0"` | unchanged |

Upstream reference for the three additions:
`v0.84.1:packages/coding-agent/package.json:48,49,56`.

### `peerDependencies` — five companion packages

| package | line | key |
| --- | --- | --- |
| `packages/subagents` | 41 | `@earendil-works/pi-agent-core` |
| `packages/subagents` | 42 | `@earendil-works/pi-ai` |
| `packages/subagents` | 43 | `@earendil-works/pi-tui` |
| `packages/mcp` | 35 | `@earendil-works/pi-ai` |
| `packages/mcp` | 36 | `@earendil-works/pi-tui` |
| `packages/intercom` | 47 | `@earendil-works/pi-tui` |
| `packages/web-access` | 34 | `@earendil-works/pi-tui` |
| `packages/workflows` | 86 | `@earendil-works/pi-tui` |

All eight move `^0.83.0` → `^0.84.1`. The adjacent `peerDependenciesMeta`
`{ "optional": true }` blocks and the `"@bastani/atomic": "*"` peer entries are
untouched.

### Regeneration and verification

```sh
npm install --package-lock-only --ignore-scripts
npm run shrinkwrap:coding-agent
```

Then assert: no `^0.83.0` or `0.84.0` pi reference anywhere, and
`@earendil-works/pi-{agent-core,ai,tui,telemetry,client,protocol}` each resolve to a
single `0.84.1` instance (`pi-telemetry` arrives transitively — it is a direct
dependency of neither manifest, but v0.84.1 `packages/agent/src/index.ts:3-34`
re-exports its types, so it must be present and deduped).

**`grok-mermaid` is deliberately unreferenced in this layer.** Upstream's only
consumer is `src/modes/interactive/components/mermaid.ts` (`git grep grok-mermaid
v0.84.1` returns exactly that file plus the manifest), and Mermaid rendering is an
explicitly excluded feature port. Adding the pin per contract item 3 therefore
introduces a dependency with no importer until the Mermaid layer lands. Flagging it
because an unused-dependency check would report it, and because a reviewer seeing an
unimported package should know it is intentional.

**Versionless manifests preserved.** All `packages/*/package.json` stay at the
`0.0.0` placeholder; none of the edits above touch a `version` field.

**Proving gate.** `npm run check` (`check:shrinkwrap` compares the regenerated
shrinkwrap against the committed one); `npm run test:ci-contracts`.

---

## Summary of null and near-null results

| break | Atomic impact |
| --- | --- |
| 8 — session v4 / `AgentHarness` | Near-null. Zero `SessionRepo`/`SessionStorage` uses; `AgentHarness` named import survives unchanged. |
| 9 — `FileSystem.renameFile()` | Null. Zero `FileSystem` and zero `renameFile` occurrences in `packages/`. |
| 4 — `refresh()` result | Partial. `ModelRuntime` already returns `ModelsRefreshResult`; only the `ModelRegistry` facade and a defensive cast remain. |
| 2 — `ProviderHeaders` | Narrow. One type line in `model-registry.ts`; `web-access` already passes headers through untouched. |
| 10 — `undici` | Null. Already pinned at `8.9.0`. |

## Compatibility paths pi itself keeps

One, and it should be mirrored rather than removed: `AuthInteraction` still exists at
`v0.84.1:packages/ai/src/auth/types.ts:156` and `ProviderAuthInteraction` is defined
as an intersection on top of it (`:164`). Atomic's `AuthInteraction` type imports
therefore stay valid; only the values flowing into provider `login()` need the added
`signal`. Do not delete Atomic's `AuthInteraction` imports in the name of a clean
break — upstream kept the base type deliberately.

No other compat path survives upstream: `ModelsStreamTransforms`, `context.store`,
and the six session re-exports are all removed outright.

## Ordered commit plan

Each commit carries an `Assistant-model: <model>` trailer, on
`pi-0.84.1/adopt-upstream` only. No PR, no push. Commits 2-9 cannot begin until the
release-age gate clears at 2026-08-09T06:03:23Z, because none of them can be
typechecked before the 0.84.1 typings are installed.

1. `chore(deps): adopt pi 0.84.1 across the workspace` — the Break 10 edit set plus
   the regenerated `package-lock.json` and coding-agent shrinkwrap. Atomic; not
   split from the lock.
2. `refactor(model-runtime)!: rename ModelsStreamTransforms to ModelsRequestTransforms` — Break 1.
3. `fix(model-registry)!: return ProviderHeaders from getApiKeyAndHeaders` — Break 2.
4. `feat(modes)!: emit delta-only message_update on the JSON and RPC wire` — Break 3,
   including the two buffers and the mirrored regression test. The largest and
   riskiest commit; keep it alone.
5. `refactor(model-registry)!: return ModelsRefreshResult from refresh` — Break 4,
   including removal of the defensive cast and the registry-suite updates.
6. `refactor(model-runtime)!: take auth-cancellation options in setRuntimeApiKey` — Break 5.
7. `refactor(providers)!: adopt context.stored and generation-checked publish` — Break 6.
8. `refactor(auth)!: thread abort signals through OAuth refresh and login` — Break 7,
   including the `ProviderAuthInteraction` adjacency.
9. `test: confirm session and filesystem surfaces need no absorption` — Breaks 8 and 9,
   only if the post-install check surfaces anything; otherwise fold the verification
   note into commit 1 and skip.
