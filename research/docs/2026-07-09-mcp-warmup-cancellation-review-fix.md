# MCP Startup Warmup Cancellation Review Fix

## Analysis: MCP lazy startup warmup cancellation after awaited connect

### Overview

The MCP extension initializes lazy servers without connecting them during `initializeMcp()`, then schedules a background direct-tool metadata warmup after startup. The reviewer finding maps to `packages/mcp/startup-warmup.ts`: cancellation is checked before `manager.connect()`, but not immediately after the awaited connect returns, so a warmup cancelled while the connection is in flight can still mutate stale state/cache and leave the resolved connection in the old manager.

### Entry Points

- `packages/mcp/init.ts:27` - `initializeMcp()` builds `McpExtensionState`, registers lifecycle metadata, reconstructs cached metadata, and connects only eager/keep-alive servers.
- `packages/mcp/index.ts:138` - `session_start` increments `lifecycleGeneration`, clears old state, cancels any previous startup warmup, and begins async initialization.
- `packages/mcp/index.ts:206` - schedules background direct-tools warmup with `shouldContinue: () => generation === lifecycleGeneration && state === nextState`.
- `packages/mcp/startup-warmup.ts:22` - `scheduleMcpStartupWarmup()` performs deferred background cache population for configured direct tools.
- `packages/mcp/server-manager.ts:45` - `McpServerManager.connect()` dedupes concurrent connects and stores resolved connections in the manager map.
- `test/unit/mcp-lazy-startup.test.ts:44` - current lazy startup unit tests cover initialize-time connection behavior only.

### Core Implementation

#### 1. Lazy startup initialization (`packages/mcp/init.ts:27-174`)

- `initializeMcp()` loads config at `packages/mcp/init.ts:31-32`.
- It creates a `McpServerManager`, `McpLifecycleManager`, metadata map, failure tracker, UI resource handler, consent manager, and returns them in `McpExtensionState` at `packages/mcp/init.ts:34-64`.
- It registers all configured servers with lifecycle settings at `packages/mcp/init.ts:86-97`.
- It reconstructs valid cached metadata into `state.toolMetadata` at `packages/mcp/init.ts:98-101`.
- It only connects servers whose lifecycle is `keep-alive` or `eager` at `packages/mcp/init.ts:104-124`.
- Default lazy servers are therefore not connected by `initializeMcp()` unless explicitly marked eager/keep-alive.

#### 2. Startup warmup scheduling (`packages/mcp/index.ts:196-210`)

- After `initializeMcp()` succeeds and is confirmed current, `index.ts` assigns `state = nextState` at `packages/mcp/index.ts:196`.
- It updates the status bar and registers cached direct tools at `packages/mcp/index.ts:197-205`.
- It schedules the background warmup at `packages/mcp/index.ts:206-209`.
- The warmup receives a stale-session guard: `generation === lifecycleGeneration && state === nextState` at `packages/mcp/index.ts:207`.
- The cancel handle is stored in `startupWarmupCancel` at `packages/mcp/index.ts:210`.

#### 3. Warmup cancellation ownership (`packages/mcp/index.ts:133-135`, `packages/mcp/index.ts:238-249`)

- `cancelStartupWarmup()` invokes the current warmup handle’s `cancel()` method and clears the stored cancel function at `packages/mcp/index.ts:133-135`.
- On `session_shutdown`, the adapter increments `lifecycleGeneration`, clears active state, cancels warmup, then shuts down the previous state at `packages/mcp/index.ts:238-249`.
- On a new `session_start`, it also clears state and cancels warmup before shutting down the previous state at `packages/mcp/index.ts:138-145` and `packages/mcp/index.ts:166-169`.

#### 4. Current warmup flow (`packages/mcp/startup-warmup.ts:22-77`)

- `scheduleMcpStartupWarmup()` creates a local `cancelled` boolean at `packages/mcp/startup-warmup.ts:26`.
- `shouldContinue()` combines the local cancel flag with the caller-provided guard at `packages/mcp/startup-warmup.ts:27`.
- The warmup defers to a macrotask at `packages/mcp/startup-warmup.ts:30`, then checks cancellation at `packages/mcp/startup-warmup.ts:31`.
- It skips all work when `MCP_DIRECT_TOOLS === "__none__"` at `packages/mcp/startup-warmup.ts:33-34`.
- It computes missing configured direct-tool servers from the metadata cache and filters out already-connected servers at `packages/mcp/startup-warmup.ts:36-38`.
- For each missing server, it checks cancellation before connecting at `packages/mcp/startup-warmup.ts:42`.
- It awaits `state.manager.connect(name, definition)` at `packages/mcp/startup-warmup.ts:46`.
- After that await, current code immediately:
  - handles `needs-auth` at `packages/mcp/startup-warmup.ts:47`,
  - builds metadata at `packages/mcp/startup-warmup.ts:48`,
  - mutates `state.toolMetadata` at `packages/mcp/startup-warmup.ts:49`,
  - writes metadata cache via `updateMetadataCache()` at `packages/mcp/startup-warmup.ts:50`.
- The next cancellation check is only after all parallel workers complete at `packages/mcp/startup-warmup.ts:59`.

#### 5. Server manager connection storage (`packages/mcp/server-manager.ts:45-68`)

- `connect()` returns an existing connected connection if present at `packages/mcp/server-manager.ts:52-56`.
- Otherwise it creates a connection promise at `packages/mcp/server-manager.ts:58`.
- After `await promise`, it stores the resolved connection in `this.connections` at `packages/mcp/server-manager.ts:62-63`.
- It returns the connection at `packages/mcp/server-manager.ts:64`.
- `close(name)` marks the current connection closed, deletes it from the map before async cleanup, and closes client/transport at `packages/mcp/server-manager.ts:297-307`.
- `closeAll()` snapshots current connection names and closes each at `packages/mcp/server-manager.ts:310-313`.

### Reviewer Finding Trace

The stale window is specifically between these points:

1. Warmup worker checks `shouldContinue()` before connecting at `packages/mcp/startup-warmup.ts:42`.
2. It awaits `state.manager.connect()` at `packages/mcp/startup-warmup.ts:46`.
3. `McpServerManager.connect()` stores the resolved connection in the manager map before returning at `packages/mcp/server-manager.ts:62-64`.
4. If cancellation/session replacement happens while `connect()` is awaited, the worker resumes cancelled but currently does not re-check cancellation before mutating:
   - `state.toolMetadata` at `packages/mcp/startup-warmup.ts:49`,
   - metadata cache at `packages/mcp/startup-warmup.ts:50`.
5. If shutdown already ran `closeAll()` before the in-flight connection was stored, the connection can be inserted after the shutdown snapshot because `connect()` stores it after await at `packages/mcp/server-manager.ts:62-63`, while `closeAll()` only closes names present when called at `packages/mcp/server-manager.ts:310-313`.

### Exact Code Changes Needed

#### Change 1: Add post-connect cancellation guard in `startup-warmup.ts`

Location: immediately after `packages/mcp/startup-warmup.ts:46`.

Current code:

```ts
const connection = await state.manager.connect(name, definition);
if (connection.status === "needs-auth") return { name, ok: false };
const { metadata } = buildToolMetadata(connection.tools, connection.resources, definition, name, prefix);
state.toolMetadata.set(name, metadata);
updateMetadataCache(state, name);
return { name, ok: true };
```

Needed replacement:

```ts
const connection = await state.manager.connect(name, definition);
if (!shouldContinue()) {
  if (state.manager.getConnection(name) === connection) {
    await state.manager.close(name);
  }
  return { name, ok: false };
}
if (connection.status === "needs-auth") return { name, ok: false };
const { metadata } = buildToolMetadata(connection.tools, connection.resources, definition, name, prefix);
state.toolMetadata.set(name, metadata);
updateMetadataCache(state, name);
return { name, ok: true };
```

How this works:

- The guard runs after the awaited connection resolves and before any warmup-owned state/cache mutation.
- `state.manager.getConnection(name) === connection` ensures the cleanup targets the same connection object returned to this warmup worker.
- `state.manager.close(name)` uses the existing close path at `packages/mcp/server-manager.ts:297-307`, which marks the connection closed, removes it from the map, and closes client/transport.
- Returning `{ name, ok: false }` prevents the cancelled server from being included in the warmed list consumed at `packages/mcp/startup-warmup.ts:60`.

No public API change is required for this fix. It uses existing `getConnection()` and `close()` methods from `McpServerManager` at `packages/mcp/server-manager.ts:315-317` and `packages/mcp/server-manager.ts:297-308`.

#### Change 2: No required changes in `init.ts`

`initializeMcp()` already keeps default lazy servers out of the synchronous startup path:

- It selects only `keep-alive` and `eager` servers at `packages/mcp/init.ts:104-107`.
- It connects only those selected startup servers at `packages/mcp/init.ts:113-124`.

The cancellation issue is in background warmup after initialization, not in `initializeMcp()`.

#### Change 3: No required state/lifecycle type changes

- `McpExtensionState` has no warmup handle field and does not need one; warmup ownership is local to `index.ts` via `startupWarmupCancel` at `packages/mcp/index.ts:42`.
- State shape is defined at `packages/mcp/state.ts:28-41`; no field is required to represent this cancellation.
- `McpLifecycleManager.gracefulShutdown()` already clears health checks and closes all currently known connections at `packages/mcp/lifecycle.ts:87-92`.
- The stale in-flight connection case is handled more directly by the warmup worker after the awaited `connect()` returns.

### Exact Test Changes Needed

Add a regression test to `test/unit/mcp-lazy-startup.test.ts`.

#### 1. Add imports

Current imports are at `test/unit/mcp-lazy-startup.test.ts:1-8`.

Add:

```ts
import { loadMetadataCache } from "../../packages/mcp/metadata-cache.ts";
import { scheduleMcpStartupWarmup } from "../../packages/mcp/startup-warmup.ts";
import type { McpExtensionState } from "../../packages/mcp/state.ts";
```

#### 2. Preserve and reset `MCP_DIRECT_TOOLS`

Current env preservation only covers `ATOMIC_CODING_AGENT_DIR` at `test/unit/mcp-lazy-startup.test.ts:10`.

Add:

```ts
const originalMcpDirectTools = process.env.MCP_DIRECT_TOOLS;
```

In `beforeEach()` after `test/unit/mcp-lazy-startup.test.ts:33`, add:

```ts
delete process.env.MCP_DIRECT_TOOLS;
```

In `afterEach()` after restoring `ATOMIC_CODING_AGENT_DIR` at `test/unit/mcp-lazy-startup.test.ts:39-40`, add:

```ts
if (originalMcpDirectTools === undefined) delete process.env.MCP_DIRECT_TOOLS;
else process.env.MCP_DIRECT_TOOLS = originalMcpDirectTools;
```

This keeps the warmup test deterministic because `startup-warmup.ts` exits early when `MCP_DIRECT_TOOLS === "__none__"` at `packages/mcp/startup-warmup.ts:33-34`.

#### 3. Add async flush helper

Add near the existing `pi()` helper:

```ts
async function flushWarmupTasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}
```

This lets the test wait for the deferred macrotask in `startup-warmup.ts:18-20` and the continuation after the released connect promise.

#### 4. Add regression test

Add inside `describe("MCP lazy startup", ...)` after the existing tests:

```ts
test("cancelled startup warmup closes resolved in-flight connection without mutating stale metadata", async () => {
  const definition = { command: "bun", args: ["--version"], directTools: true };
  const connections = new Map<string, {
    client: { close: () => Promise<void> };
    transport: { close: () => Promise<void> };
    definition: typeof definition;
    tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
    resources: [];
    lastUsedAt: number;
    inFlight: number;
    status: "connected" | "closed";
  }>();
  const closed: string[] = [];

  let resolveConnectStarted!: () => void;
  const connectStarted = new Promise<void>((resolve) => {
    resolveConnectStarted = resolve;
  });

  let releaseConnect!: () => void;
  const connectRelease = new Promise<void>((resolve) => {
    releaseConnect = resolve;
  });

  const manager = {
    getConnection(name: string) {
      return connections.get(name);
    },
    async connect(name: string) {
      resolveConnectStarted();
      await connectRelease;
      const connection = {
        client: { close: async () => {} },
        transport: { close: async () => {} },
        definition,
        tools: [{ name: "tool", description: "tool description", inputSchema: { type: "object" } }],
        resources: [],
        lastUsedAt: Date.now(),
        inFlight: 0,
        status: "connected" as const,
      };
      connections.set(name, connection);
      return connection;
    },
    async close(name: string) {
      const connection = connections.get(name);
      if (!connection) return;
      connection.status = "closed";
      connections.delete(name);
      closed.push(name);
      await connection.client.close();
      await connection.transport.close();
    },
  } as unknown as McpServerManager;

  const state = {
    manager,
    lifecycle: {},
    toolMetadata: new Map(),
    config: {
      mcpServers: {
        lazy: definition,
      },
    },
    failureTracker: new Map(),
    uiResourceHandler: {},
    consentManager: {},
    uiServer: null,
    completedUiSessions: [],
    openBrowser: async () => {},
  } as unknown as McpExtensionState;

  let directToolsChanged = 0;
  const warmup = scheduleMcpStartupWarmup(state, {
    onDirectToolsChanged: () => {
      directToolsChanged += 1;
    },
  });

  await connectStarted;
  warmup.cancel();
  releaseConnect();
  await flushWarmupTasks();

  assert.deepEqual(closed, ["lazy"]);
  assert.equal(connections.has("lazy"), false);
  assert.equal(state.toolMetadata.has("lazy"), false);
  assert.deepEqual(Object.keys(loadMetadataCache()?.servers ?? {}), []);
  assert.equal(directToolsChanged, 0);
});
```

Behavior covered by this test:

- The server is configured with `directTools: true`, so `getMissingConfiguredDirectToolServers()` includes it when cache is empty at `packages/mcp/direct-tools.ts:182-203`.
- The fake `connect()` starts, pauses, then returns a connected server after cancellation.
- The fixed warmup path should close the returned connection, skip `state.toolMetadata.set()`, skip `updateMetadataCache()`, and avoid direct-tool re-registration.
- On the current implementation, the test observes the stale mutation path because `startup-warmup.ts:47-50` run after cancellation.

### Data Flow After Fix

1. `index.ts` schedules warmup with a generation/state guard at `packages/mcp/index.ts:206-209`.
2. Warmup checks the guard before connecting at `packages/mcp/startup-warmup.ts:42`.
3. Warmup awaits `state.manager.connect()` at `packages/mcp/startup-warmup.ts:46`.
4. `McpServerManager.connect()` stores the resolved connection before returning at `packages/mcp/server-manager.ts:62-64`.
5. Warmup immediately checks `shouldContinue()` again.
6. If stale/cancelled:
   - warmup verifies the returned connection is still current via `getConnection()`,
   - closes it via `close()`,
   - returns `{ ok: false }`,
   - does not mutate `state.toolMetadata`,
   - does not update the metadata cache.
7. If still current:
   - warmup handles `needs-auth`,
   - builds tool metadata,
   - stores metadata in `state.toolMetadata`,
   - updates persistent metadata cache,
   - later triggers status/direct-tool refresh only if the final guard still passes.

### Public API Preservation

- `McpStartupWarmupOptions` and `McpStartupWarmupHandle` remain unchanged at `packages/mcp/startup-warmup.ts:9-16`.
- `McpServerManager.connect()`, `close()`, and `getConnection()` signatures remain unchanged at `packages/mcp/server-manager.ts:45`, `packages/mcp/server-manager.ts:297`, and `packages/mcp/server-manager.ts:315`.
- `McpExtensionState` remains unchanged at `packages/mcp/state.ts:28-41`.
- No breaking changes are needed.
