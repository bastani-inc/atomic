# Latest review lazy-startup debug analysis

Date: 2026-07-09  
Worktree: `C:/dev/github_work/atomic-lazy-startup-worktree`  
Review artifact: `C:/Users/ALEXLA~1/AppData/Local/Temp/atomic-ralph-run-7AzjZ0/review-round-latest.json`  
Mode: read-only debugging of source/tests; no production or test files edited.

## Summary

Both latest unresolved reviewer findings still apply to the current working tree.

| Finding | Current status | Evidence |
| --- | --- | --- |
| Stale workflow warmups can publish old registries across later sessions | **Still applies** | A two-`session_start` repro with the first `refreshWorkflowResources()` held produced `refreshCalls: 1` and `/workflow list` in the second session listed `old-workflow` instead of the second session's `new-workflow`. |
| MCP cold-cache search/describe can miss lazy servers without `directTools` | **Still applies** | A fresh-cache repro with a default lazy MCP server and mocked connectable tool produced `connectCalls: 0`, no metadata, `No tools matching "find"`, and `Tool "lazy_find_repos" not found`. |

Existing focused lazy-startup tests still pass, but they do not cover these two regressions:

```bash
bun test test/unit/mcp-lazy-startup.test.ts test/unit/mcp-startup-warmup-cancellation.test.ts test/unit/workflow-lazy-startup-continuation.test.ts
# 9 pass, 0 fail
```

## 1. Stale workflow warmups publish old registries across sessions

**Status:** still applies.  
**Priority:** P2 correctness regression.  
**Public impact:** a background discovery started for one session can mutate `discoveryRef` and rebuild the workflow runtime for a later active session. The later session can then show/run workflows from stale package resources.

### Root cause

`startWorkflowDiscoveryWarmup()` only guards the notification callback with `notificationGeneration`; it does not guard the `reloadWorkflowResourcesNow()` state mutation. It also leaves the old `lazyDiscoveryPromise` active across later `session_start` events.

Relevant code:

- `packages/workflows/src/extension/extension-lifecycle.ts:60-75` handles `session_start`, awaits lightweight config, then calls `setNotificationsActive(true)` and `startWorkflowDiscoveryWarmup(...)`.
- `packages/workflows/src/extension/extension-runtime-state.ts:192-249` tracks one global `lazyDiscoveryPromise` and reload queue.
- `packages/workflows/src/extension/extension-runtime-state.ts:254-272` loads config/resources and unconditionally writes `discoveryRef.current = result` and `rebuildRuntime(result.registry)` after async work completes.
- `packages/workflows/src/extension/extension-runtime-state.ts:282-290` returns early from new warmups whenever `lazyDiscoveryPromise !== null`, even if that promise belongs to a previous session.
- `packages/workflows/src/extension/extension-runtime-state.ts:332-337` increments `notificationGeneration` only when `setNotificationsActive(...)` is called, which is too late to protect registry mutation and can be after an awaited config load in `session_start`.

### Reproduction evidence

I ran a temporary Bun repro from the worktree that:

1. Registered the workflow extension.
2. Started session A.
3. Let session A's background `refreshWorkflowResources()` start and block.
4. Started session B while session A's refresh was still pending.
5. Resolved session A's refresh with `old-workflow.ts`.
6. Ran `/workflow list` in the active session.

Observed output:

```json
{
  "refreshCalls": 1,
  "listed": [
    "publish-release",
    "release-docs",
    "old-workflow",
    "deep-research-codebase",
    "goal",
    "open-claude-design",
    "ralph"
  ]
}
```

Expected after the fix: the stale first refresh must not publish `old-workflow`; the second session should queue/use its own discovery, so `refreshCalls` should reach `2` and `/workflow list` should include `new-workflow` instead.

### Required code changes

Make workflow discovery session-generation aware and guard all async state publication, not only notifications.

Recommended implementation shape:

1. **Add a workflow discovery/session generation to runtime state** in `packages/workflows/src/extension/extension-runtime-state.ts` near the existing `notificationGeneration`/`lazyDiscoveryPromise` state:
   - e.g. `let workflowDiscoveryGeneration = 0;`
   - track which generation produced `discoveryRef.current`, e.g. `let appliedDiscoveryGeneration: number | null = null;`
   - optionally track the generation associated with `lazyDiscoveryPromise`.

2. **Expose an internal session reset method** on `WorkflowExtensionRuntimeState`, e.g. `beginWorkflowSession(): void`:
   - increment `workflowDiscoveryGeneration` immediately;
   - clear `discoveryRef.current` and `appliedDiscoveryGeneration`;
   - clear/release `lazyDiscoveryPromise` so a new session is not blocked by an old pending warmup;
   - reset the runtime registry to the bundled startup registry (`startupDiscovery.registry`) so cold paths do not read the previous session's full registry while current discovery is pending;
   - invalidate stale notification callbacks as well, either by incrementing `notificationGeneration` here or by deactivating notifications before the first awaited operation in `session_start`.

3. **Call that reset at the top of `session_start`** in `packages/workflows/src/extension/extension-lifecycle.ts:60-75`, before `await runtimeState.ensureWorkflowConfigLoaded()`. This closes the window where an old warmup can finish while the new session is still waiting on config.

4. **Pass the captured discovery generation through queued reloads**:
   - `startWorkflowDiscoveryWarmup()` should capture `const generation = workflowDiscoveryGeneration` and pass it to the queued reload.
   - `ensureWorkflowResourcesLoaded()` should only reuse `lazyDiscoveryPromise` if it belongs to the current generation; otherwise it should schedule a current-generation reload.
   - `reloadWorkflowResources()` for explicit `/workflow reload` should capture the current generation.

5. **Guard `reloadWorkflowResourcesNow()` after every awaited boundary before mutating state**:
   - after `loadWorkflowConfig()` and before `applyWorkflowConfig(...)`;
   - after `loadPackageWorkflowPaths()` / `pi.refreshWorkflowResources?.()` returns;
   - after `discoverWorkflows(...)` returns and before `discoveryRef.current = result` / `rebuildRuntime(result.registry)`.
   - If the generation is stale, return without mutating `configLoadRef`, `discoveryRef`, `runtimeRef`, status writers, or persistence for the active session.

6. **Keep the existing retry semantics** from `trackLazyDiscovery()` so failed current-generation discovery clears and can be retried.

This preserves the lazy-startup objective while ensuring old background work cannot publish stale registries into a later session.

### Focused tests to add

Add a regression test to `test/unit/workflow-lazy-startup-continuation.test.ts` near the existing lazy discovery tests:

- Create two temporary workflow files: `old-workflow.ts` and `new-workflow.ts`.
- Register the factory with `refreshWorkflowResources()` that:
  - on first call blocks on a deferred promise and eventually returns `old-workflow.ts`;
  - on second call returns `new-workflow.ts`.
- Call `session_start` once, wait until the first refresh starts, then call `session_start` again before resolving the first refresh.
- Resolve the first refresh.
- Run `/workflow list`.
- Assert:
  - `refreshCalls === 2`;
  - the list contains `new-workflow`;
  - the list does **not** contain `old-workflow`.

Optional additional assertion: use separate UI notify collectors for session A and B and assert stale session A's deferred discovery callback does not notify after session B begins.


## 2. MCP cold-cache search/describe false negatives for lazy servers without `directTools`

**Status:** still applies.  
**Priority:** P2 correctness regression.  
**Public impact:** on a fresh cache, `mcp({ search: ... })` and `mcp({ describe: ... })` can report no matches/not found for tools that are available on a configured lazy server. The user must already know to call `mcp({ connect: "server" })`, which defeats search/describe discovery.

### Root cause

The lazy-startup change removed the old cold-cache `bootstrapAll` path from `initializeMcp()` but did not add equivalent on-demand metadata hydration to public proxy info modes.

Relevant code:

- `packages/mcp/init.ts:74-107` now creates/loads the metadata cache but only connects `keep-alive` and `eager` servers during initialization. Default lazy servers with no valid cache are left without `state.toolMetadata`.
- `packages/mcp/startup-warmup.ts:35-40` schedules background warmup only for `getMissingConfiguredDirectToolServers(...)`, so lazy servers without `directTools` are never warmed.
- `packages/mcp/direct-tools.ts:182-203` confirms the warmup candidate list excludes servers unless direct tools are configured globally or per server.
- `packages/mcp/proxy-info-modes.ts:143-239` implements `executeDescribe()` and `executeSearch()` solely by scanning `state.toolMetadata`; they do not connect missing lazy servers before returning false negatives.
- `packages/mcp/index.ts:426-441` routes public `mcp` proxy `describe` and `search` calls straight to those info modes.

### Reproduction evidence

I ran a temporary Bun repro with:

- a fresh `ATOMIC_CODING_AGENT_DIR`;
- one configured default lazy server with no `directTools`;
- `McpServerManager.prototype.connect` mocked to return a connected server exposing `find_repos` if called;
- `initializeMcp()`, `scheduleMcpStartupWarmup()`, `executeSearch()`, and `executeDescribe()`.

Observed output:

```json
{
  "connectCalls": 0,
  "metadataServers": [],
  "searchText": "No tools matching \"find\"",
  "searchDetails": {
    "mode": "search",
    "matches": [],
    "count": 0,
    "query": "find"
  },
  "describeText": "Tool \"lazy_find_repos\" not found. Use mcp({ search: \"...\" }) to search.",
  "describeDetails": {
    "mode": "describe",
    "error": "tool_not_found",
    "requestedTool": "lazy_find_repos"
  }
}
```

Expected after the fix: explicit proxy search/describe should lazily connect enough uncached configured server(s), populate `state.toolMetadata`/cache through the existing metadata path, and then return the matching tool instead of a false negative.

### Required code changes

Add on-demand metadata hydration for explicit MCP proxy info paths. Startup can remain non-blocking.

Recommended implementation shape:

1. **Create a helper** in `packages/mcp/proxy-info-modes.ts` or a small new module such as `packages/mcp/proxy-metadata-hydration.ts`:
   - Inputs: `state: McpExtensionState`, optional `serverName` filter.
   - Determine configured servers whose metadata is missing, e.g. no `state.toolMetadata.has(name)`.
   - If a server filter is provided, hydrate only that server.
   - Otherwise hydrate all uncached configured servers, with bounded concurrency via `parallelLimit`.
   - Use existing `lazyConnect(state, name)` from `packages/mcp/init.ts:263-299` so failure backoff, metadata update, cache update, and status updates stay centralized.
   - Do not hydrate for invalid regex/empty search input.

2. **Make proxy info functions async where needed**:
   - `executeSearch(...)` should validate the query/regex, hydrate missing metadata (`server`-filtered when supplied), then scan `state.toolMetadata`.
   - `executeDescribe(...)` should first try current metadata; if not found, hydrate uncached servers and retry before returning `tool_not_found`. Consider accepting an optional `server` parameter and hydrating that server only when supplied.
   - `executeList(state, server)` should hydrate that explicit server before reporting `not_connected`/empty tools, so `mcp({ server: "name" })` is also not a cold-cache false negative.
   - `executeStatus(state)` should probably remain non-connecting; status display should not unexpectedly start every lazy server.

3. **Update callers for the async signatures**:
   - `packages/mcp/index.ts:436-443`: pass `params.server` to describe if supported and return/await the now-async `executeDescribe`, `executeSearch`, and `executeList` results.
   - `packages/mcp/proxy-connect.ts` imports `executeList`; its async `executeConnect()` can return `await executeList(...)` or return the promise.
   - `packages/mcp/proxy-modes.ts` can keep re-exporting the functions.

4. **Leave `scheduleMcpStartupWarmup()` direct-tool-focused unless product wants background warming for all lazy servers**. The blocking bug is the explicit user path returning false negatives; it is sufficient and safer for startup to hydrate non-direct lazy servers on search/describe/list demand.

### Focused tests to add

Add a new file such as `test/unit/mcp-proxy-cold-cache.test.ts`, or extend `test/unit/mcp-lazy-startup.test.ts` if file length stays under the repository limit.

Suggested behavior tests using a fake `McpExtensionState` and fake manager:

1. **Search hydrates an uncached lazy server without directTools**
   - `state.config.mcpServers.lazy = { command: "fake", args: [] }` with no direct tool config.
   - `state.toolMetadata` starts empty.
   - Fake `manager.connect()` stores and returns a connected server exposing `find_repos`.
   - Call `await executeSearch(state, "find")`.
   - Assert `connectCalls === 1`, result count is `1`, and details include `{ server: "lazy", tool: "lazy_find_repos" }`.

2. **Describe retries after hydration before returning not found**
   - Fresh fake state as above.
   - Call `await executeDescribe(state, "lazy_find_repos")`.
   - Assert `connectCalls === 1`, `details.server === "lazy"`, and parameters/description are returned.

3. **Server list hydrates only the requested server**
   - Configure two lazy servers.
   - Call `await executeList(state, "target")`.
   - Assert only `target` connected and its tools are listed.

4. **Invalid/empty search does not connect**
   - Empty query and invalid regex should return validation errors with `connectCalls === 0`.

Keep the existing `test/unit/mcp-lazy-startup.test.ts` assertion that `initializeMcp()` itself does not connect default lazy servers; the fix should be on explicit proxy use, not startup.

## Docs, changelog, and validation updates needed after fixes

### Docs/changelog

Update these user-facing notes so they describe the fixed behavior precisely:

- `packages/coding-agent/docs/extensions.md:56-59`
  - Keep the lazy-startup explanation, but clarify that MCP proxy search/describe/server-list hydrate uncached lazy server metadata on explicit use instead of startup.
- `packages/mcp/README.md:235` and proxy usage docs around `packages/mcp/README.md:328-339`
  - Mention that direct tools still register from cache/background warmup, while `mcp({ search })`, `mcp({ describe })`, and `mcp({ server })` lazily connect uncached configured servers when needed.
- `packages/mcp/CHANGELOG.md:8-16`
  - Add a `Fixed` entry for cold-cache proxy search/describe/list no longer returning false negatives for lazy servers without `directTools`.
- `packages/workflows/CHANGELOG.md:7-15`
  - Add a `Fixed` entry for session-generation-guarded workflow discovery warmups so stale in-flight discoveries cannot publish old registries into later sessions.
- `packages/coding-agent/CHANGELOG.md:3-8`
  - If this package is the umbrella user-facing changelog for lazy startup, add a short note that deferred workflow/MCP discovery preserves active-session correctness and explicit MCP discovery behavior.

### Validation commands

After implementing the fixes and tests, run from `C:/dev/github_work/atomic-lazy-startup-worktree`:

```bash
bun test test/unit/workflow-lazy-startup-continuation.test.ts
bun test test/unit/mcp-lazy-startup.test.ts test/unit/mcp-startup-warmup-cancellation.test.ts test/unit/mcp-proxy-cold-cache.test.ts
bun test test/unit/slash-dispatch-headless-basic.ts test/unit/slash-dispatch-resume.ts test/unit/slash-dispatch-tool-reload-resume.ts
bun run typecheck
bun run check:file-length
git diff --check main
```

If the MCP cold-cache tests are added to an existing test file instead of `test/unit/mcp-proxy-cold-cache.test.ts`, adjust the second `bun test` command accordingly.
