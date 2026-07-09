I’m unable to write `progress.md` or `research/docs/2026-07-09-atomic-existing-lazy-patterns.md` directly because this session exposes read/search/list tools only and no file write/edit tool. Below is the research content for the requested output file.

## Pattern Examples: Atomic Existing Lazy / Deferred / Non-blocking Patterns

### Pattern 1: Startup extension deferral decision

**Found in**: `packages/coding-agent/src/main-deferred-startup.ts:35-69`  
**Used for**: Computing whether interactive startup can defer extension/resource loading and input capture.

```ts
export function computeStartupInputCaptureEnabled(input: ComputeStartupInputCaptureInput): boolean {
	if (input.parsed.resume || input.parsed.session !== undefined) return false;
	const hasTrustInputs = hasProjectTrustInputs(input.sessionCwd);
	return input.deprecationWarningCount === 0 && computeDeferExtensions({
		appMode: input.appMode,
		stdinIsTTY: input.stdinIsTTY,
		hasSessionStartEvent: false,
		help: input.parsed.help,
		listModels: input.parsed.listModels,
		shouldResolveProjectTrust: input.parsed.projectTrustOverride === undefined && hasTrustInputs,
		storedProjectTrust: hasTrustInputs ? input.projectTrustStore.get(input.sessionCwd) : null,
		resolvedExtensionPathCount: input.resolvedExtensionPathCount,
		resolvedResourcePathCount: input.resolvedResourcePathCount,
		hasSystemPromptInput: input.parsed.systemPrompt !== undefined || (input.parsed.appendSystemPrompt?.length ?? 0) > 0,
		unknownFlagCount: input.parsed.unknownFlags.size,
		provider: input.parsed.provider,
		model: input.parsed.model,
	});
}

export function computeDeferExtensions(input: ComputeDeferExtensionsInput): boolean {
	return (
		input.appMode === "interactive" &&
		input.stdinIsTTY &&
		!input.hasSessionStartEvent &&
		!input.help &&
		input.listModels === undefined &&
		(!input.shouldResolveProjectTrust || input.storedProjectTrust !== null) &&
		input.resolvedExtensionPathCount === 0 &&
		input.resolvedResourcePathCount === 0 &&
		!input.hasSystemPromptInput &&
		input.provider === undefined &&
		input.model === undefined &&
		input.unknownFlagCount === 0
	);
}
```

**Key aspects**:

- Uses a pure predicate to decide startup deferral eligibility.
- Checks interactive TTY mode, absence of explicit startup/session/model/system prompt inputs, and project trust state.
- Preserves startup behavior by disabling deferral when explicit work is requested.

---

### Pattern 2: Dynamic import entrypoint split to avoid top-level await constraints

**Found in**: `packages/coding-agent/src/cli.ts:25-30`  
**Used for**: Loading HTTP dispatcher and main application dynamically after CLI argument parsing.

```ts
// Dynamic import ensures startup args are parsed before modules that may perform
// runtime-sensitive initialization are loaded, and keeps this file compatible
// with Bun compile targets that forbid TLA anywhere in the bundled graph.
void Promise.all([import("./core/http-dispatcher.ts"), import("./main.ts")]).then(
	([{ configureHttpDispatcher }, { main }]) => {
		configureHttpDispatcher();
		main(args);
	},
);
```

**Key aspects**:

- Uses `Promise.all([...import(...)])` for parallel dynamic imports.
- Explicitly avoids top-level await in the bundled graph.
- Starts `main(args)` only after runtime setup module has loaded.

---

### Pattern 3: Bun CLI split loader dynamic import

**Found in**: `packages/coding-agent/src/bun/cli.ts:12-13`  
**Used for**: Registering Bedrock support before loading the CLI module.

```ts
// Dynamic import ensures register-bedrock runs before CLI initialization, and
// avoids top-level await in this entrypoint.
void import("./register-bedrock.ts").then(() => import("../cli.ts"));
```

**Key aspects**:

- Uses chained dynamic imports for ordered initialization.
- Keeps the entrypoint minimal.
- Uses `void` to intentionally detach the promise from the synchronous module body.

---

### Pattern 4: Single-file bundle app import via split loader

**Found in**: `packages/coding-agent/src/bun/split-loader.ts:40-45`  
**Used for**: Loading an app bundle dynamically from disk after validating its presence.

```ts
if (!existsSync(appPath)) {
	console.error(`Atomic startup error: missing app bundle at ${appPath}`);
	process.exit(1);
}

void import(pathToFileURL(appPath).href);
```

**Key aspects**:

- Performs a bounded synchronous existence check before import.
- Uses dynamic `import()` against a file URL.
- Startup errors are emitted before module loading.

---

### Pattern 5: Lazy extension virtual module loading with shared in-flight promise

**Found in**: `packages/coding-agent/src/core/extensions/loader-virtual-modules.ts:12-32`  
**Used for**: Loading virtual modules for extension runtime only when needed.

```ts
const require = createRequire(import.meta.url);
let _virtualModules: Record<string, object> | null = null;
let _virtualModulesPromise: Promise<Record<string, object>> | null = null;

async function loadVirtualModules(): Promise<Record<string, object>> {
  const [typebox, typeboxCompile, typeboxValue, piAgentCore, piTui, piAi, piAiOauth, piCodingAgent] = await Promise.all([
    import("typebox"),
    import("typebox/compile"),
    import("typebox/value"),
    import("@earendil-works/pi-agent-core"),
    import("@earendil-works/pi-tui"),
    // pi 0.80.2: the old global pi-ai API moved off the root entrypoint onto
    // `/compat` (a strict superset). Extensions still `import ... from
    // "@earendil-works/pi-ai"`, so we load the compat module here and key it
    // under the root specifier below to keep every extension working unchanged.
    import("@earendil-works/pi-ai/compat"),
    import("@earendil-works/pi-ai/oauth"),
    // NOTE: This import works because loader.ts exports are NOT re-exported from index.ts,
    // avoiding a circular dependency while preserving the package-name extension import path.
    import("../../index.ts"),
  ]);

  return {
    typebox,
    "typebox/compile": typeboxCompile,
    "typebox/value": typeboxValue,
```

**Key aspects**:

- Module-level `_virtualModules` and `_virtualModulesPromise` support memoization and in-flight promise sharing.
- Uses `Promise.all` to load multiple dynamic imports concurrently.
- Defers heavier extension virtual-module graph loading until extension loading requires it.

---

### Pattern 6: Extension module cache and native import fast path

**Found in**: `packages/coding-agent/src/core/extensions/loader-virtual-modules.ts:229-268`  
**Used for**: Extension loading with cache token validation, jiti configuration, and Windows native import tracking.

```ts
/**
 * Extension paths already evaluated via native import() in this process. Bun on
 * Windows ignores the cache-busting query on file URLs, so re-loads of these
 * paths (e.g. /reload) must go through jiti's transformed-import path to get a
 * fresh module evaluation.
 */
const nativelyImportedPaths = new Set<string>();

export async function loadExtensionModule(
  extensionPath: string,
  cacheToken?: ExtensionCacheToken,
): Promise<ExtensionFactory | undefined> {
  if (isCurrentCacheToken(cacheToken)) {
    const cachedFactory = extensionCache.get(extensionPath);
    if (cachedFactory) return cachedFactory;
  }

  const isWindows = process.platform === "win32";
  // Single-file builds (compiled binary or dev bundle) cannot alias host
  // package specifiers to files on disk: extensions must share the live
  // module instances baked into the build, so virtualModules is used instead
  // (which requires jiti's transformed-import path).
  const isSingleFileBuild = isBunBinary || isBundledBuild;
  // Windows first-load fast path: native import() (jiti's default tryNative)
  // skips per-launch transpilation of the extension module graph. Re-loads of
  // the same path fall back to transformed imports for fresh evaluation.
  const forceTransformedImports = isSingleFileBuild || (isWindows && nativelyImportedPaths.has(extensionPath));
  const jiti = createJiti(resolutionBaseUrl(import.meta.url), {
    moduleCache: false,
    ...(forceTransformedImports
      ? { fsCache: getTranspileCacheDir(), tryNative: false }
      : isWindows
        ? { fsCache: getTranspileCacheDir() }
        : {}),
    ...(isSingleFileBuild ? { virtualModules: await getVirtualModules() } : { alias: getAliases() }),
  });
  const module = await jiti.import(extensionImportSpecifier(extensionPath, cacheToken), { default: true });
  if (isWindows && !forceTransformedImports) {
    nativelyImportedPaths.add(extensionPath);
  }
```

**Key aspects**:

- Checks `extensionCache` before loading.
- Tracks paths imported natively on Windows.
- Defers `getVirtualModules()` until single-file build extension loading needs it.
- Uses jiti filesystem cache configuration for transformed imports.

---

### Pattern 7: Native search binding memoization

**Found in**: `packages/coding-agent/src/core/tools/search-native.ts:84-109`  
**Used for**: Lazily requiring optional native bindings once and caching success/failure.

```ts
let cachedLoadResult: NativeBinding | null | false = null;

export function resetNativeSearchBindingCache(): void {
	cachedLoadResult = null;
}

export function loadNativeSearchBinding(): NativeBinding | null {
	if (cachedLoadResult !== null) return cachedLoadResult || null;
	try {
		const require = createModuleRequire(import.meta.url);
		const binding = require("@bastani/atomic-natives") as Partial<NativeBinding>;
		if (typeof binding.glob !== "function" || typeof binding.grep !== "function") {
			cachedLoadResult = false;
			return null;
		}
		cachedLoadResult = binding as NativeBinding;
		return cachedLoadResult;
	} catch {
		cachedLoadResult = false;
		return null;
	}
}

export function invalidateNativeSearchCache(path?: string): void {
	loadNativeSearchBinding()?.invalidateFsScanCache?.(path ?? null);
}
```

**Key aspects**:

- Uses tri-state cache: `null` = not attempted, `false` = unavailable, object = loaded binding.
- Caches failed load attempts.
- Provides reset function for tests or reload scenarios.
- Invalidates native filesystem cache only if native binding exists.

---

### Pattern 8: Rust LazyLock env configuration and filesystem scan cache

**Found in**: `crates/atomic-natives/src/fs_cache/part_01.rs:66-132`  
**Used for**: Lazy environment-derived cache policy and global filesystem scan cache.

```rust
env_uint! {
	// Configured cache TTL in milliseconds.
	static CACHE_TTL_MS: u64 = "FS_SCAN_CACHE_TTL_MS" or 1_000 => [0, u64::MAX];
	// Configured empty-result recheck threshold in milliseconds.
	static EMPTY_RECHECK_MS: u64 = "FS_SCAN_EMPTY_RECHECK_MS" or 200 => [0, u64::MAX];
	// Configured maximum number of cache entries.
	static MAX_CACHE_ENTRIES: usize = "FS_SCAN_CACHE_MAX_ENTRIES" or 16 => [0, usize::MAX];
}

env_uint! {
	// Worker count for parallel filesystem walks. 0 lets ignore choose.
	static GREP_WORKERS: usize = "PI_GREP_WORKERS" or 4 => [0, usize::MAX];
}

pub fn cache_ttl_ms() -> u64 {
	*CACHE_TTL_MS
}

pub fn empty_recheck_ms() -> u64 {
	*EMPTY_RECHECK_MS
}

pub fn max_cache_entries() -> usize {
	*MAX_CACHE_ENTRIES
}

pub fn grep_workers() -> usize {
	*GREP_WORKERS
}

// ...

#[derive(Clone)]
struct CacheEntry {
	created_at: Instant,
	epoch: u64,
	entries: Vec<GlobMatch>,
}

static FS_CACHE: LazyLock<DashMap<CacheKey, CacheEntry>> = LazyLock::new(DashMap::new);
static FS_CACHE_EPOCH: AtomicU64 = AtomicU64::new(0);
```

**Key aspects**:

- Uses `LazyLock` for environment-derived values.
- Uses `LazyLock<DashMap<...>>` for global filesystem cache.
- Maintains an atomic epoch for invalidation.
- Cache entries store `created_at`, `epoch`, and cloned scan results.

---

### Pattern 9: TTL-based get-or-scan cache with eviction

**Found in**: `crates/atomic-natives/src/fs_cache/part_01.rs:429-473`  
**Used for**: Deferred filesystem discovery: reuse scan results when fresh, otherwise scan and store.

```rust
/// Returns scanned entries using the global TTL cache policy.
///
/// The returned [`ScanResult::cache_age_ms`] lets callers implement
/// empty-result fast recheck: if a query produces zero matches and the cache is
/// older than [`empty_recheck_ms()`], call [`force_rescan`] before returning
/// empty.
pub fn get_or_scan(
	root: &Path,
	options: ScanOptions,
	ct: &task::CancelToken,
) -> Result<ScanResult> {
	let ttl = *CACHE_TTL_MS;
	if ttl == 0 {
		// Caching disabled – always scan fresh.
		let entries = collect_entries(root, options, ct)?;
		return Ok(ScanResult { entries, cache_age_ms: 0 });
	}

	let key = CacheKey {
		root: root.to_path_buf(),
		include_hidden: options.include_hidden,
		use_gitignore: options.use_gitignore,
		skip_node_modules: options.skip_node_modules,
		detail: options.detail,
	};

	let now = Instant::now();
	if let Some(entry) = FS_CACHE.get(&key) {
		let current_epoch = cache_epoch();
		let age = now.duration_since(entry.created_at);
		if entry.epoch == current_epoch && age < Duration::from_millis(ttl) {
			return Ok(ScanResult {
				entries: entry.entries.clone(),
				cache_age_ms: age.as_millis() as u64,
			});
		}
		drop(entry);
		FS_CACHE.remove(&key);
	}

	let scan_epoch = cache_epoch();
	let entries = collect_entries(root, options, ct)?;
	FS_CACHE.insert(key, CacheEntry { created_at: Instant::now(), epoch: scan_epoch, entries: entries.clone() });
	evict_oldest();
	Ok(ScanResult { entries, cache_age_ms: 0 })
}
```

**Key aspects**:

- TTL of `0` disables caching.
- Cache key includes root and scan options.
- Stale or invalidated entries are removed before rescanning.
- Fresh scans populate cache and call eviction.

---

### Pattern 10: Empty-result fast recheck after cached discovery

**Found in**: `crates/atomic-natives/src/grep/part_05.rs:243-259`  
**Used for**: Grep filesystem discovery using cached scans, with bounded recheck for empty cached results.

```rust
let mentions_node_modules = options.glob.as_deref().is_some_and(|g| g.contains("node_modules"));
let scan_options = fs_cache::ScanOptions {
	include_hidden,
	use_gitignore,
	skip_node_modules: use_gitignore && !mentions_node_modules,
	follow_links: false,
	detail: fs_cache::ScanDetail::Minimal,
};
let entries = if use_cache {
	let scan = fs_cache::get_or_scan(&search_path, scan_options, &ct)?;
	let mut entries =
		collect_files(&search_path, &scan.entries, glob_set.as_ref(), type_filter.as_ref());
	if entries.is_empty() && scan.cache_age_ms >= fs_cache::empty_recheck_ms() {
		let fresh = fs_cache::force_rescan(&search_path, scan_options, true, &ct)?;
		entries = collect_files(&search_path, &fresh, glob_set.as_ref(), type_filter.as_ref());
	}
	Some(entries)
} else {
	None
};
```

**Key aspects**:

- Optional cache controlled by caller option.
- Uses cached scan result first.
- If result is empty and cached data is old enough, forces a fresh rescan.
- Rescan result is stored back into cache when requested.

---

### Pattern 11: Native bounded operation / cancellation token

**Found in**: `crates/atomic-natives/src/task.rs:13-60`  
**Used for**: Timeout and abort-aware blocking native tasks.

```rust
#[derive(Clone, Default)]
pub struct CancelToken {
	deadline: Option<Instant>,
	aborted: Arc<AtomicBool>,
}

impl CancelToken {
	pub fn new(timeout_ms: Option<u32>, signal: Option<Unknown>) -> Self {
		let token = Self {
			deadline: timeout_ms.map(|ms| Instant::now() + Duration::from_millis(u64::from(ms))),
			aborted: Arc::new(AtomicBool::new(false)),
		};
		if let Some(signal) = signal.and_then(|value| AbortSignal::from_unknown(value).ok()) {
			let aborted = Arc::clone(&token.aborted);
			signal.on_abort(move || aborted.store(true, Ordering::SeqCst));
		}
		token
	}

	pub fn heartbeat(&self) -> Result<()> {
		if self.aborted.load(Ordering::SeqCst) {
			return Err(Error::from_reason("Operation aborted"));
		}
		if self.deadline.is_some_and(|deadline| Instant::now() >= deadline) {
			return Err(Error::from_reason("Operation timed out"));
		}
		Ok(())
	}

	pub async fn wait(&self) {
		loop {
			if self.heartbeat().is_err() {
				return;
			}
			tokio::time::sleep(Duration::from_millis(10)).await;
		}
	}

	pub fn aborted(&self) -> bool {
		self.heartbeat().is_err()
	}
}
```

**Key aspects**:

- Converts `timeout_ms` into an `Instant` deadline.
- Wires JS `AbortSignal` to an atomic bool.
- Provides `heartbeat()` checkpoints for long-running loops.
- Provides async `wait()` polling with a 10ms sleep.

---

### Pattern 12: Grep native task dispatched through blocking wrapper with timeout token

**Found in**: `crates/atomic-natives/src/grep/part_05.rs:447-449`  
**Used for**: Running grep synchronously in native code while exposing a bounded async task to JS.

```rust
};
let ct = task::CancelToken::new(timeout_ms, signal);
task::blocking("grep", ct, move |ct| grep_sync(config, on_match.as_ref(), ct))
```

**Key aspects**:

- Builds `CancelToken` from timeout and abort signal.
- Passes token into blocking grep implementation.
- Uses native task wrapper for blocking work.

---

### Pattern 13: Async HTTP/2 timeout wrapper

**Found in**: `crates/atomic-natives/src/lib.rs:335-344`  
**Used for**: Bounded async native HTTP/2 operations.

```rust
async fn with_timeout<T, F>(timeout_ms: Option<u32>, message: &'static str, future: F) -> Result<T>
where
	F: Future<Output = Result<T>>,
{
	if let Some(timeout_ms) = timeout_ms.filter(|value| *value > 0) {
		tokio::time::timeout(Duration::from_millis(u64::from(timeout_ms)), future)
			.await
			.map_err(|_| napi_error(message))?
	} else {
		future.await
	}
}
```

**Key aspects**:

- Treats missing or non-positive timeout as unbounded.
- Uses `tokio::time::timeout`.
- Maps timeout elapsed into a NAPI error message.

---

### Pattern 14: Cancellation plus timeout race for HTTP/2 operation

**Found in**: `crates/atomic-natives/src/lib.rs:285-308`  
**Used for**: Combining operation ID cancellation with timeout.

```rust
async fn with_cancellation<T, F>(
	operation_id: Option<&str>,
	timeout_ms: Option<u32>,
	future: F,
) -> Result<T>
where
	F: Future<Output = Result<T>>,
{
	if let Some(operation_id) = operation_id {
		let (tx, rx) = oneshot::channel();
		cancellation_registry().lock().await.insert(operation_id.to_string(), tx);
		let result = tokio::select! {
			result = with_timeout(timeout_ms, "Cursor HTTP/2 native operation timed out.", future) => result,
			_ = rx => Err(napi_error("Cursor HTTP/2 native operation cancelled.")),
		};
		cancellation_registry().lock().await.remove(operation_id);
		return result;
	}
	with_timeout(timeout_ms, "Cursor HTTP/2 native operation timed out.", future).await
}
```

**Key aspects**:

- Registers cancellable operation by ID.
- Uses `tokio::select!` to race timeout-wrapped work against cancellation receiver.
- Cleans registry after completion.
- Falls back to timeout-only behavior when no operation ID is provided.

---

### Pattern 15: Background delivery loop scheduling with unref timer

**Found in**: `packages/coding-agent/src/core/async/job-manager.ts:207-215`  
**Used for**: Scheduling async job delivery without keeping the Node/Bun event loop alive.

```ts
#scheduleDeliveryLoop(delayMs: number): void {
	if (this.#disposed) return;
	if (this.#timer) clearTimeout(this.#timer);
	this.#timer = setTimeout(() => {
		this.#timer = undefined;
		void this.#runDeliveryLoop();
	}, delayMs);
	this.#timer.unref?.();
}
```

**Key aspects**:

- Clears prior timer before scheduling.
- Dispatches async work with `void`.
- Calls `unref?.()` so the timer does not keep the process alive.
- Guards against disposed manager state.

---

### Pattern 16: Session manager avoids discovery unless requested

**Found in**: `packages/coding-agent/src/main-session.ts:138-223`  
**Used for**: Deferring session listing/global discovery until specific flags require it.

```ts
export async function createSessionManager(
	parsed: Args,
	cwd: string,
	sessionDir: string | undefined,
	settingsManager: SettingsManager,
): Promise<SessionManager> {
	if (parsed.noSession || parsed.help || parsed.listModels !== undefined) {
		return SessionManager.inMemory(cwd, parsed.sessionId !== undefined ? { id: parsed.sessionId } : undefined);
	}

	if (parsed.fork) {
		if (parsed.sessionId) {
			const existingTarget = await findLocalSessionByExactId(parsed.sessionId, cwd, sessionDir);
			if (existingTarget) {
				console.error(chalk.red(`Session already exists with id '${parsed.sessionId}'`));
				process.exit(1);
			}
		}

		const resolved = await resolveSessionPath(parsed.fork, cwd, sessionDir);

		switch (resolved.type) {
			case "path":
			case "local":
			case "global":
				return forkSessionOrExit(resolved.path, cwd, sessionDir, parsed.sessionId);

			case "not_found":
				console.error(chalk.red(`No session found matching '${resolved.arg}'`));
				process.exit(1);
		}
	}

	if (parsed.session) {
		const resolved = await resolveSessionPath(parsed.session, cwd, sessionDir);
```

Continues:

```ts
	if (parsed.resume) {
		initTheme(settingsManager.getTheme(), true);
		try {
			const selectedPath = await selectSession(
				(onProgress) => SessionManager.list(cwd, sessionDir, onProgress),
				(onProgress) => SessionManager.listAll(sessionDir, onProgress),
			);
			if (!selectedPath) {
				console.log(chalk.dim("No session selected"));
				process.exit(0);
			}
			return openSessionOrExit(selectedPath, sessionDir);
		} finally {
			stopThemeWatcher();
		}
	}

	if (parsed.continue) {
		return SessionManager.continueRecent(cwd, sessionDir);
	}

	if (parsed.sessionId) {
		const existingSession = await findLocalSessionByExactId(parsed.sessionId, cwd, sessionDir);
		if (existingSession) {
			return openSessionOrExit(existingSession.path, sessionDir);
		}
	}

	return SessionManager.create(cwd, sessionDir, { id: parsed.sessionId });
}
```

**Key aspects**:

- Returns in-memory session for `--help`, `--list-models`, or `--no-session`.
- Only lists sessions when `--fork`, `--session`, `--resume`, or specific session ID paths require it.
- Global listing occurs inside `resolveSessionPath` and `selectSession` flows, not on every startup.

---

## Testing Patterns

### Test Pattern 1: Lazy attach creates SDK session on demand and caches it

**Found in**: `test/unit/stage-runner-lazy-attach.test.ts:14-33`  
**Used for**: Verifying lazy session creation and idempotent cached attach.

```ts
describe("createStageContext — lazy attach", () => {
    test("__ensureSession creates the SDK session on demand", async () => {
        const { session } = makeMockSession();
        let creates = 0;
        const agentSession: AgentSessionAdapter = {
            async create() {
                creates += 1;
                return session;
            },
        };
        const ctx = createStageContext(
            makeOpts({ adapters: { agentSession } }),
        ) as InternalStageContext;
        assert.equal(creates, 0);
        await ctx.__ensureSession();
        assert.equal(creates, 1);
        // Idempotent: a second call reuses the cached promise.
        await ctx.__ensureSession();
        assert.equal(creates, 1);
    });
```

**Key aspects**:

- Asserts no creation before explicit attach.
- Calls `__ensureSession()` once to trigger creation.
- Calls it again to verify cached promise/session reuse.

---

### Test Pattern 2: Lazy attach metadata is undefined before attach

**Found in**: `test/unit/stage-runner-lazy-attach.test.ts:35-43`  
**Used for**: Verifying pre-attach state remains uninitialized.

```ts
    test("__sessionMeta returns undefined keys before attach", () => {
        const ctx = createStageContext(
            makeOpts({ adapters: {} }),
        ) as InternalStageContext;
        assert.deepEqual(ctx.__sessionMeta(), {
            sessionId: undefined,
            sessionFile: undefined,
        });
    });
```

**Key aspects**:

- Creates context without agent session adapter.
- Reads metadata before attach.
- Asserts uninitialized session fields are `undefined`.

---

### Test Pattern 3: Pending subscribers survive lazy attach

**Found in**: `test/unit/stage-runner-lazy-attach.test.ts:45-64`  
**Used for**: Verifying event subscribers registered before lazy attach are preserved.

```ts
    test("pending subscribers fire after lazy attach", async () => {
        const { session } = makeMockSession();
        const agentSession: AgentSessionAdapter = {
            async create() {
                return session;
            },
        };
        const ctx = createStageContext(
            makeOpts({ adapters: { agentSession } }),
        ) as InternalStageContext;
        const events: string[] = [];
        ctx.subscribe((event) =>
            events.push((event as { type?: string }).type ?? ""),
        );
        await ctx.__ensureSession();
        // Now drive an event through the live session (the listener is bound
        // on attach). We can't directly emit from our mock without state,
        // so we just assert the subscriber survived attach without throwing.
        assert.equal(events.length, 0);
    });
```

**Key aspects**:

- Registers subscriber before session creation.
- Attaches lazily afterwards.
- Asserts attach completes without dropping/triggering the subscriber unexpectedly.

---

### Test Pattern 4: Detached background run returns before async prompt settles

**Found in**: `test/unit/background-runner.test.ts:91-123`  
**Used for**: Testing non-blocking detached background execution.

```ts
describe("runDetached — returns immediately", () => {
  test("accepted result returned synchronously before background completes", async () => {
    const store = createStore();
    const cancellation = createCancellationRegistry();
    const jobs = createJobTracker();
    const def = makeDelayedWorkflow("immediate-return-wf");

    let backgroundSettled = false;
    const accepted = runDetached(def, {}, {
      store,
      cancellation,
      jobs,
      adapters: {
        prompt: {
          prompt: async (text) => {
            await new Promise((resolve) => setTimeout(resolve, 100));
            backgroundSettled = true;
            return text;
          },
        },
      },
    });

    // runDetached must have returned before background settled
    assert.equal(backgroundSettled, false);
    assert.equal(accepted.action, "run");
    assert.equal(accepted.status, "running");
    assert.ok(accepted.runId);

    // Cleanup — let background finish
    const job = jobs.get(accepted.runId);
    if (job) await job.promise;
  });
```

**Key aspects**:

- Uses delayed async prompt to simulate unfinished background work.
- Calls `runDetached` synchronously.
- Immediately asserts background work has not settled.
- Awaits tracked job only for cleanup.

---

### Test Pattern 5: Intentional busy wait helper for detached dispatch checks

**Found in**: `test/unit/background-runner.test.ts:79-84`  
**Used for**: Proving detached dispatch does not run workflow code before returning.

```ts
function busyWait(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Intentional synchronous work used to prove detached dispatch does not
    // run user workflow code before returning the accepted result.
  }
}
```

**Key aspects**:

- Uses synchronous busy wait intentionally in tests.
- Documents purpose as proving detached dispatch behavior.

---

### Test Pattern 6: Cursor stream bounded timeout assertion

**Found in**: `test/unit/cursor-stream-02.test.ts:152-160`  
**Used for**: Testing timeout-bound streaming returns quickly.

```ts
const adapter = new CursorStreamAdapter({ transport, uuid: () => "run-per-request-timeout", streamReadTimeoutMs: 10_000 });
const startedAt = Date.now();

const events = await collectEventsWithTimeout(adapter.streamSimple(model(), context(), { apiKey: "access-secret", timeoutMs: 1 }), 250);

assert.equal(transport.requests[0]?.openTimeoutMs, 1);
assert.ok(Date.now() - startedAt < 250);
const terminal = events.at(-1);
assert.equal(terminal?.type, "error");
if (terminal?.type === "error") assert.match(terminal.error.errorMessage ?? "", /timed out/u);
```

**Key aspects**:

- Starts clock before streaming.
- Passes very small request timeout.
- Wraps collection in test helper timeout.
- Asserts elapsed wall time is below test bound and terminal event is timeout error.

---

### Test Pattern 7: Generic async collection timeout helper

**Found in**: `test/unit/cursor-stream-helpers.ts:45-54`  
**Used for**: Bounding async iterable tests.

```ts
export async function collectEventsWithTimeout(stream: AsyncIterable<AssistantMessageEvent>, timeoutMs = 250): Promise<AssistantMessageEvent[]> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			collectEvents(stream),
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(() => reject(new Error("timed out waiting for cursor stream to end")), timeoutMs);
			}),
		]);
	} finally {
```

**Key aspects**:

- Uses `Promise.race` between collection and timer rejection.
- Stores timer for cleanup in `finally`.
- Provides a reusable bounded async test helper.

---

## Pattern Usage in Codebase

- **Lazy startup / deferral predicates**:
  - `packages/coding-agent/src/main-deferred-startup.ts:35-69`
- **Dynamic import startup split**:
  - `packages/coding-agent/src/cli.ts:25-30`
  - `packages/coding-agent/src/bun/cli.ts:12-13`
  - `packages/coding-agent/src/bun/split-loader.ts:40-45`
- **Lazy dynamic imports for feature-specific work**:
  - `packages/coding-agent/src/core/agent-session-export.ts:113-115`
  - `packages/coding-agent/src/main.ts:79-81`
- **Memoized optional native binding**:
  - `packages/coding-agent/src/core/tools/search-native.ts:84-109`
- **Extension module caching / virtual module lazy loading**:
  - `packages/coding-agent/src/core/extensions/loader-virtual-modules.ts:12-32`
  - `packages/coding-agent/src/core/extensions/loader-virtual-modules.ts:229-268`
- **Filesystem discovery cache**:
  - `crates/atomic-natives/src/fs_cache/part_01.rs:66-132`
  - `crates/atomic-natives/src/fs_cache/part_01.rs:429-473`
  - `crates/atomic-natives/src/grep/part_05.rs:243-259`
- **Timeout / bounded native operations**:
  - `crates/atomic-natives/src/task.rs:13-60`
  - `crates/atomic-natives/src/lib.rs:285-308`
  - `crates/atomic-natives/src/lib.rs:335-344`
- **Non-blocking background scheduling**:
  - `packages/coding-agent/src/core/async/job-manager.ts:207-215`
- **Async non-blocking tests**:
  - `test/unit/stage-runner-lazy-attach.test.ts:14-64`
  - `test/unit/background-runner.test.ts:79-123`
  - `test/unit/cursor-stream-02.test.ts:152-160`
  - `test/unit/cursor-stream-helpers.ts:45-54`