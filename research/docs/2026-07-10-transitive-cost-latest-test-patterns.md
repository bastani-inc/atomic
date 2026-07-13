I’m unable to write `/workspaces/atomic/research/docs/2026-07-10-transitive-cost-latest-test-patterns.md` because this subagent only has read/search/list tools available and no edit/write tool. Below are the findings intended for that file.

## Pattern Examples: Latest Transitive Cost Test Patterns

### Pattern 1: `footer-width.test.ts` fake `AgentSession` stub

**Found in**: `packages/coding-agent/test/footer-width.test.ts:18-70`
**Used for**: Lightweight footer/usage meter tests without constructing a real `AgentSession`.

```ts
function createSession(options: {
	sessionName: string;
	modelId?: string;
	provider?: string;
	reasoning?: boolean;
	thinkingLevel?: string;
	usage?: AssistantUsage;
	contextPercent?: number;
	contextWindow?: number;
}): AgentSession {
	const usage = options.usage;
	const entries =
		usage === undefined
			? []
			: [
					{
						type: "message",
						message: {
							role: "assistant",
							usage,
						},
					},
				];

	const session = {
		state: {
			model: {
				id: options.modelId ?? "test-model",
				provider: options.provider ?? "test",
				contextWindow: options.contextWindow ?? 200_000,
				reasoning: options.reasoning ?? false,
			},
			thinkingLevel: options.thinkingLevel ?? "off",
		},
		sessionManager: {
			getEntries: () => entries,
			getSessionName: () => options.sessionName,
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({
			contextWindow: options.contextWindow ?? 200_000,
			percent: options.contextPercent ?? 12.3,
		}),
		modelRegistry: {
			isUsingOAuth: () => false,
		},
		settingsManager: {
			getCodexFastModeSettings: () => ({ chat: false, workflow: false }),
		},
	};

	return session as unknown as AgentSession;
}
```

**Key aspects**:

- Builds only the fields used by `FooterComponent` / `UsageMeterComponent`.
- Uses `sessionManager.getEntries()` to feed assistant usage.
- Uses `getContextUsage()` for context percent/window.
- Uses `modelRegistry.isUsingOAuth()` for cost/subscription rendering behavior.
- Uses a final `as unknown as AgentSession` cast for test-only stubbing.

**Related footer tests in same file**:

- `UsageMeterComponent context color`: `packages/coding-agent/test/footer-width.test.ts:97-144`
- `FooterComponent width handling`: `packages/coding-agent/test/footer-width.test.ts:146-202`
- Cache hit rate assertion using stripped ANSI: `packages/coding-agent/test/footer-width.test.ts:162-177`
- Wide model/provider stats line width assertion: `packages/coding-agent/test/footer-width.test.ts:179-201`

```ts
it("shows the latest cache hit rate when cache usage is present", () => {
	const session = createSession({
		sessionName: "",
		usage: {
			input: 100,
			output: 10,
			cacheRead: 50,
			cacheWrite: 50,
			cost: { total: 0.001 },
		},
	});
	const usageMeter = new UsageMeterComponent(session);

	const statsText = stripAnsi(usageMeter.render(120).join("\n"));
	expect(statsText).toContain("CH25.0%");
});
```

---

### Pattern 2: Transitive usage aggregator tests for reconcile preserving unsettled/live reports

**Found in**: `test/unit/transitive-usage.test.ts:29-123`
**Used for**: Unit-testing `TransitiveUsageAggregator` directly with synthetic usage reports.

```ts
describe("TransitiveUsageAggregator", () => {
	test("incomplete reconciliation preserves live reports not found durably", () => {
		const aggregator = new TransitiveUsageAggregator("root", () => usage(10, 1));
		aggregator.attributeDescendantUsage({
			rootSessionId: "root",
			childRunId: "live",
			kind: "subagent",
			usage: usage(20, 2),
			settled: true,
		});
		aggregator.reconcile([], false);
		const result = aggregator.getTransitiveUsage();
		assert.equal(result.complete, false);
		assert.equal(result.descendants.cost.total, 2);
	});
});
```

**Key aspects**:

- Uses `new TransitiveUsageAggregator("root", () => usage(...))`.
- Calls `attributeDescendantUsage(...)` first to simulate live event-bus report.
- Calls `reconcile([], false)` to simulate incomplete durable walk.
- Asserts live report remains in descendants.
- Asserts aggregate completeness is false.

**Relevant implementation**: `packages/coding-agent/src/core/transitive-usage.ts:162-177`

```ts
reconcile(reports: DescendantUsageReport[], complete: boolean): void {
	let metadataChanged = this.walkComplete !== complete;
	this.walkComplete = complete;
	const nextKeys = new Set(reports.map((report) => report.childRunId));
	if (complete) {
		for (const key of this.descendants.keys()) {
			if (nextKeys.has(key)) continue;
			this.descendants.delete(key);
			metadataChanged = true;
		}
	}
	for (const report of reports) {
		this.attributeDescendantUsage(report);
	}
	if (metadataChanged) this.onMutation?.();
}
```

**Pattern to update for “preserving unsettled reports”**:

Existing test preserves a `settled: true` live report during incomplete reconciliation. The same direct-aggregator pattern is the exact place to add/update coverage for `settled: false` reports.

---

### Pattern 3: Session-file aliasing during incomplete reconciliation

**Found in**: `test/unit/transitive-usage.test.ts:72-96`
**Used for**: Avoiding double-counting when a live run-id report later reconciles to a durable session-id report.

```ts
test("incomplete reconciliation aliases live run-id reports by session file", () => {
	const aggregator = new TransitiveUsageAggregator("root", () => usage(10, 1));
	aggregator.attributeDescendantUsage({
		rootSessionId: "root",
		childRunId: "live-run",
		kind: "subagent",
		usage: usage(20, 2),
		settled: true,
		sessionFile: "/tmp/child-session.jsonl",
	});
	aggregator.reconcile([
		{
			rootSessionId: "root",
			childRunId: "durable-session-id",
			kind: "subagent",
			usage: usage(20, 2),
			settled: true,
			sessionFile: "/tmp/child-session.jsonl",
		},
	], false);
	const result = aggregator.getTransitiveUsage();
	assert.equal(result.complete, false);
	assert.equal(result.descendants.cost.total, 2);
	assert.deepEqual(result.breakdown.map((entry) => entry.childRunId), ["durable-session-id"]);
});
```

**Relevant implementation**: `packages/coding-agent/src/core/transitive-usage.ts:144-159`

```ts
attributeDescendantUsage(report: DescendantUsageReport): boolean {
	if (report.rootSessionId !== this.rootSessionId) return false;
	let changed = false;
	for (const [key, contribution] of this.descendants) {
		if (key === report.childRunId || !sharesSessionFileAlias(contribution, report)) continue;
		this.descendants.delete(key);
		changed = true;
	}
	const previous = this.descendants.get(report.childRunId);
	if (!sameContribution(previous, report)) {
		const sessionFiles = report.sessionFiles ? [...report.sessionFiles] : undefined;
		this.descendants.set(report.childRunId, { ...report, sessionFiles });
		changed = true;
	}
	if (changed) this.onMutation?.();
	return changed;
}
```

**Related alias helper implementation**: `packages/coding-agent/src/core/transitive-usage.ts:105-116`

```ts
function sessionFileAliases(report: DescendantUsageReport): Set<string> {
	const aliases = [report.sessionFile, ...(report.sessionFiles ?? [])];
	return new Set(aliases.filter((value): value is string => typeof value === "string" && value.length > 0));
}

function sharesSessionFileAlias(left: DescendantUsageContribution, right: DescendantUsageReport): boolean {
	const aliases = sessionFileAliases(right);
	if (aliases.size === 0) return false;
	for (const alias of sessionFileAliases(left)) {
		if (aliases.has(alias)) return true;
	}
	return false;
}
```

---

### Pattern 4: Parallel/sessionFiles aliasing coverage

**Found in**: `test/unit/transitive-usage.test.ts:98-122`
**Used for**: Testing a rollup report with multiple `sessionFiles` aliases against a later single durable session report.

```ts
test("incomplete reconciliation aliases parallel rollups by sessionFiles", () => {
	const aggregator = new TransitiveUsageAggregator("root", () => usage(10, 1));
	aggregator.attributeDescendantUsage({
		rootSessionId: "root",
		childRunId: "parallel-run",
		kind: "subagent",
		usage: usage(40, 4),
		settled: true,
		sessionFiles: ["/tmp/a.jsonl", "/tmp/b.jsonl"],
	});
	aggregator.reconcile([
		{
			rootSessionId: "root",
			childRunId: "session-a",
			kind: "subagent",
			usage: usage(20, 2),
			settled: true,
			sessionFile: "/tmp/a.jsonl",
		},
	], false);
	const result = aggregator.getTransitiveUsage();
	assert.equal(result.complete, false);
	assert.equal(result.descendants.cost.total, 2);
	assert.deepEqual(result.breakdown.map((entry) => entry.childRunId), ["session-a"]);
});
```

**Key aspects**:

- Uses `sessionFiles` on the live aggregate report.
- Reconciles with a single `sessionFile`.
- Asserts aggregate is not double-counted.
- Asserts the durable report replaces the aggregate report.

---

### Pattern 5: Nested workflow/stage rollup double-counting collection tests

**Found in**: `test/unit/transitive-usage.test.ts:125-170`
**Used for**: Testing durable descendant usage discovery from JSONL session files and `workflow.stage.end` custom entries.

```ts
describe("collectDescendantUsageReports", () => {
	test("discovers subagent session roots and workflow stage-end usage", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-transitive-"));
		try {
			const rootPath = join(dir, "root.jsonl");
			const subRoot = join(dir, basename(rootPath, ".jsonl"), "run-a");
			mkdirSync(subRoot, { recursive: true });
			const childPath = join(subRoot, "session.jsonl");
			writeSession(rootPath, "root-id", [customStageEnd("stage-session", usage(30, 3), join(dir, "stage.jsonl"))]);
			writeSession(childPath, "child-session", [assistantEntry(usage(20, 2))]);
			const result = await collectDescendantUsageReports({
				root: {
					path: rootPath,
					id: "root-id",
					cwd: dir,
					created: new Date(),
					modified: new Date(),
					messageCount: 0,
					firstMessage: "",
					allMessagesText: "",
				},
				rootSessionId: "root-id",
				listSessions: async () => [],
			});
			assert.equal(result.complete, true);
			assert.equal(result.reports.reduce((sum, report) => sum + report.usage.cost.total, 0), 5);
			assert.deepEqual(new Set(result.reports.map((report) => report.childRunId)), new Set(["child-session", "stage-session"]));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
```

**Relevant implementation**: `packages/coding-agent/src/core/transitive-usage.ts:186-237`

```ts
export async function collectDescendantUsageReports(input: {
	root: SessionInfo;
	rootSessionId: string;
	listSessions: () => Promise<SessionInfo[]>;
}): Promise<{ reports: DescendantUsageReport[]; complete: boolean }> {
	let complete = true;
	let sessions: SessionInfo[] = [];
	try {
		sessions = await input.listSessions();
	} catch {
		complete = false;
	}
	const rootPath = input.root.path;
	const byPath = new Map(sessions.map((session) => [session.path, session]));
	const discoveredPaths = new Set<string>();
	const descendants = sessions.filter((session) => isDescendantOf(session, rootPath, byPath));
	for (const session of descendants) discoveredPaths.add(session.path);
	try {
		for (const path of discoverSubagentSessionFiles(rootPath)) discoveredPaths.add(path);
	} catch {
		complete = false;
	}
	const reportsByKey = new Map<string, DescendantUsageReport>();
	for (const sessionPath of [rootPath, ...discoveredPaths]) {
		try {
			const entries = loadEntriesFromFile(sessionPath);
			if (entries.length === 0) {
				complete = false;
				continue;
			}
			const ownEntries = sessionPath === rootPath ? entries : entriesExcludingInheritedParent(entries);
			for (const report of workflowStageReportsFromEntries(ownEntries, input.rootSessionId)) {
				reportsByKey.set(report.childRunId, report);
			}
			if (sessionPath === rootPath) continue;
			const listed = byPath.get(sessionPath);
			const header = entries.find((entry) => entry.type === "session") as ({ id?: string; workflow?: { stageName?: string } } | undefined);
			const report = {
				rootSessionId: input.rootSessionId,
				childRunId: listed?.id ?? header?.id ?? sessionPath,
				kind: listed?.workflow || header?.workflow ? "workflow-stage" : "subagent",
				usage: sumAssistantUsage(ownEntries),
				settled: true,
				label: listed?.workflow?.stageName ?? header?.workflow?.stageName ?? listed?.name,
				sessionFile: sessionPath,
			} satisfies DescendantUsageReport;
			if (!reportsByKey.has(report.childRunId)) reportsByKey.set(report.childRunId, report);
		} catch {
			complete = false;
		}
	}
	return { reports: [...reportsByKey.values()], complete };
}
```

**Workflow stage-end extraction implementation**: `packages/coding-agent/src/core/transitive-usage.ts:240-258`

```ts
function workflowStageReportsFromEntries(entries: readonly FileEntry[], rootSessionId: string): DescendantUsageReport[] {
	const reports: DescendantUsageReport[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== "workflow.stage.end") continue;
		const data = entry.data as { stageId?: unknown; sessionId?: unknown; sessionFile?: unknown; usage?: unknown } | undefined;
		if (!isUsage(data?.usage)) continue;
		const sessionId = typeof data?.sessionId === "string" ? data.sessionId : undefined;
		const stageId = typeof data?.stageId === "string" ? data.stageId : undefined;
		reports.push({
			rootSessionId,
			childRunId: sessionId ?? (stageId ? `workflow-stage:${stageId}` : entry.id),
			kind: "workflow-stage",
			usage: data.usage,
			settled: true,
			label: stageId,
			sessionFile: typeof data?.sessionFile === "string" ? data.sessionFile : undefined,
		});
	}
	return reports;
}
```

**Test helper for stage-end entry**: `test/unit/transitive-usage.test.ts:329-331`

```ts
function customStageEnd(sessionId: string, entryUsage: Usage, sessionFile: string) {
	return { type: "custom", id: crypto.randomUUID(), timestamp: new Date().toISOString(), customType: "workflow.stage.end", data: { stageId: "stage-a", sessionId, sessionFile, usage: entryUsage } };
}
```

---

### Pattern 6: Workflow-stage completeness persistence / settled forwarding

**Found in**: `test/unit/transitive-usage.test.ts:246-266`
**Used for**: Testing workflow usage rollup port emits the root session id, stage session id, and `settled` flag.

```ts
describe("workflow usage rollup port", () => {
	test("uses root accessor, stage session id key, and propagated settled flag", () => {
		const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
		const port = makeUsageRollupPort({
			getSessionId: () => "root-session",
			events: { emit: (event: string, payload: Record<string, unknown>) => emitted.push({ event, payload }) },
		} as never);
		port?.emitStageRollup("stage-id", usage(7, 0.7), { sessionId: "stage-session", sessionFile: "/tmp/stage.jsonl", settled: false });
		assert.equal(emitted[0]?.event, "usage:descendant-rollup");
		assert.equal(emitted[0]?.payload["rootSessionId"], "root-session");
		assert.equal(emitted[0]?.payload["childRunId"], "stage-session");
		assert.equal(emitted[0]?.payload["settled"], false);
	});

	test("does not emit live workflow rollups without a stage session id", () => {
		const emitted: unknown[] = [];
		const port = makeUsageRollupPort({ getSessionId: () => "root", events: { emit: (_event: string, payload: Record<string, unknown>) => emitted.push(payload) } } as never);
		port?.emitStageRollup("stage-id", usage(7, 0.7), { sessionId: "" });
		assert.equal(emitted.length, 0);
	});
});
```

**Relevant workflow port implementation**: `packages/workflows/src/extension/workflow-ports.ts:43-60`

```ts
export function makeUsageRollupPort(pi: ExtensionAPI): WorkflowUsageRollupPort | undefined {
  if (typeof pi.events?.emit !== "function") return undefined;
  return {
    emitStageRollup(_stageId, usage, meta): void {
      const sessionManager = pi.sessionManager as ({ getSessionId?: () => string } | undefined);
      const rootSessionId = pi.getSessionId?.() ?? sessionManager?.getSessionId?.();
      if (!rootSessionId || !meta.sessionId) return;
      pi.events!.emit!("usage:descendant-rollup", {
        rootSessionId,
        childRunId: meta.sessionId,
        kind: "workflow-stage",
        usage,
        settled: meta.settled !== false,
        label: meta.label,
        sessionFile: meta.sessionFile,
      });
    },
  };
}
```

**Stage runtime capture/emit implementation**: `packages/workflows/src/runs/foreground/executor-stage-factory.ts:200-215`

```ts
let stageUsageSettled = true;
const recordStageUsage = (): void => {
  const transitive = innerCtx.__agentSession()?.getTransitiveUsage?.();
  if (!transitive) return;
  stageSnapshot.usage = transitive.total;
  stageUsageSettled = transitive.complete;
  input.activeStore.recordStageUsage?.(input.runId, stageId, transitive.total);
};
const emitStageRollup = (): void => {
  if (!stageSnapshot.usage || !stageSnapshot.sessionId) return;
  input.opts.usageRollup?.emitStageRollup(stageId, stageSnapshot.usage, {
    label: name,
    sessionId: stageSnapshot.sessionId,
    sessionFile: stageSnapshot.sessionFile,
    settled: stageUsageSettled,
  });
};
```

---

### Pattern 7: Subagent async placeholder / unsettled zero-usage report

**Found in**: `test/unit/transitive-usage.test.ts:237-243`
**Used for**: Testing async start emits a placeholder descendant report before completion.

```ts
test("async start emits an unsettled zero-usage descendant report", () => {
	const emitted: unknown[] = [];
	reportSubagentStarted({ events: { emit: (_event: string, payload: Record<string, unknown>) => emitted.push(payload) } } as never, "root", { id: "async-1", asyncDir: "/tmp/async-1" });
	assert.equal((emitted[0] as { childRunId?: string }).childRunId, "async-1");
	assert.equal((emitted[0] as { settled?: boolean }).settled, false);
	assert.equal((emitted[0] as { usage?: Usage }).usage?.cost.total, 0);
});
```

**Relevant implementation**: `packages/subagents/src/shared/usage-rollup.ts:132-142`

```ts
export function reportSubagentStarted(pi: ExtensionAPI, rootSessionId: string | null | undefined, payload: { id?: unknown; asyncDir?: unknown }): void {
	if (!rootSessionId || typeof payload.id !== "string") return;
	pi.events.emit(USAGE_DESCENDANT_ROLLUP_CHANNEL, {
		rootSessionId,
		childRunId: payload.id,
		kind: "subagent",
		usage: emptyAtomicUsage(),
		settled: false,
		label: "async",
		...(typeof payload.asyncDir === "string" ? { sessionFile: payload.asyncDir } : {}),
	} satisfies DescendantUsageReport);
}
```

**Extension call site**: `packages/subagents/src/extension/index.ts:417-418`

```ts
const handleStarted = (payload: unknown) => {
	handleStarted(payload);
	reportSubagentStarted(pi, state.currentRootSessionId, payload as { id?: unknown; asyncDir?: unknown });
};
```

**Alias-related implementation used by async placeholder replacement**:

- `packages/coding-agent/src/core/transitive-usage.ts:105-116` — `sessionFileAliases(...)` / `sharesSessionFileAlias(...)`
- `packages/coding-agent/src/core/transitive-usage.ts:147-150` — removes prior aliased report before upserting new report.

---

### Pattern 8: Subagent usage rollup preserving incomplete/fallback state

**Found in**: `test/unit/transitive-usage.test.ts:208-235`
**Used for**: Testing fallback usage is marked incomplete and emitted unsettled.

```ts
test("direct-only fallback is marked incomplete and emitted unsettled", () => {
	const details = {
		mode: "single" as const,
		runId: "run-1",
		results: [{
			agent: "worker",
			task: "task",
			exitCode: 0,
			usage: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.5, turns: 1 },
		}],
	};
	const rollup = usageRollupFromResults(details.results);
	assert.equal(rollup.complete, false);
	const emitted: unknown[] = [];
	reportSubagentUsageForRoot(
		{ events: { emit: (_event: string, payload: Record<string, unknown>) => emitted.push(payload) } } as never,
		"root",
		{ ...details, transitiveUsage: rollup.usage, transitiveUsageComplete: rollup.complete },
	);
	assert.equal((emitted[0] as { settled?: boolean }).settled, false);
});
```

```ts
test("foreground compaction preserves fallback incompleteness for reporting", () => {
	const missingSessionFile = join(tmpdir(), `missing-subagent-${crypto.randomUUID()}.jsonl`);
	const compacted = compactForegroundDetails({
		mode: "single",
		runId: "run-compact",
		results: [{
			agent: "worker",
			task: "task",
			exitCode: 0,
			usage: { input: 7, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.7, turns: 1 },
			sessionFile: missingSessionFile,
		}],
	});
	assert.equal(compacted.transitiveUsageComplete, false);
	assert.deepEqual(compacted.transitiveUsageSessionFiles, [missingSessionFile]);
	const emitted: unknown[] = [];
	reportSubagentUsageForRoot({ events: { emit: (_event: string, payload: Record<string, unknown>) => emitted.push(payload) } } as never, "root", compacted);
	assert.equal((emitted[0] as { settled?: boolean }).settled, false);
});
```

**Relevant implementation**: `packages/subagents/src/shared/usage-rollup.ts:114-129`

```ts
export function reportSubagentUsageForRoot(pi: ExtensionAPI, rootSessionId: string | null | undefined, details: Details): void {
	if (!rootSessionId || !details.runId || !details.transitiveUsage) return;
	const sessionFiles = details.transitiveUsageSessionFiles?.length
		? details.transitiveUsageSessionFiles
		: details.results.flatMap((result) => result.sessionFile ? [result.sessionFile] : []);
	const state = (details as Details & { state?: string }).state;
	pi.events.emit(USAGE_DESCENDANT_ROLLUP_CHANNEL, {
		rootSessionId,
		childRunId: details.runId,
		kind: "subagent",
		usage: details.transitiveUsage,
		settled: details.transitiveUsageComplete !== false && state !== "paused",
		label: details.mode === "management" ? "subagent" : details.mode,
		sessionFile: sessionFiles[0],
		sessionFiles,
	} satisfies DescendantUsageReport);
}
```

**Rollup fallback implementation**: `packages/subagents/src/shared/usage-rollup.ts:145-160`

```ts
function usageRollupFromResult(result: SingleResult): RollupUsage {
	const fileUsage = usageFromSessionTree(result.sessionFile);
	if (fileUsage) return fileUsage;
	return { usage: scalarUsageToAtomic(result.usage), complete: false, sessionFiles: result.sessionFile ? [result.sessionFile] : [] };
}

function usageRollupFromAttemptBackedResult(result: { sessionFile?: string; usage?: Usage; modelAttempts?: readonly ModelAttempt[] }): RollupUsage {
	const fileUsage = usageFromSessionTree(result.sessionFile);
	if (fileUsage) return fileUsage;
	if (result.usage) return { usage: scalarUsageToAtomic(result.usage), complete: false, sessionFiles: result.sessionFile ? [result.sessionFile] : [] };
	let total = emptyAtomicUsage();
	for (const attempt of result.modelAttempts ?? []) {
		if (attempt.usage) total = addAtomicUsage(total, scalarUsageToAtomic(attempt.usage));
	}
	return { usage: total, complete: false, sessionFiles: result.sessionFile ? [result.sessionFile] : [] };
}
```

---

### Pattern 9: Named workflow `usageRollup` forwarding

**Found in**: `packages/workflows/src/engine/run.ts:222-245`
**Used for**: Passing `usageRollup` from top-level workflow run options into both primary and named/nested workflow execution paths.

```ts
const childOpts = {
  persistence: opts.persistence,
  usageRollup: opts.usageRollup,
  onStageStart: opts.onStageStart,
  onStageEnd: durableOnStageEnd,
  onStageSession: durableOnStageSession,
  // ...
};

const workflowOpts = {
  mcp: opts.mcp,
  usageRollup: opts.usageRollup,
  cancellation: opts.cancellation,
  overlay: opts.overlay,
  config: opts.config,
  // ...
};
```

**Related runtime option declaration**: `packages/workflows/src/extension/runtime.ts:74-76`

```ts
mcp?: WorkflowMcpPort;
usageRollup?: WorkflowUsageRollupPort;
/** Workflow-native pi-intercom result/control event delivery. */
intercom?: WorkflowResultIntercomPort;
```

**Related runtime capture**: `packages/workflows/src/extension/runtime.ts:155-190`

```ts
const mcp = opts.mcp;
const usageRollup = opts.usageRollup;
const config = opts.config;
const intercom = opts.intercom;
const models = opts.models;
// ...
usageRollup,
```

**Runtime state wiring**: `packages/workflows/src/extension/extension-runtime-state.ts:66-67`

```ts
const mcpPort = makeMcpPort(pi);
const usageRollupPort = makeUsageRollupPort(pi);
```

**Runtime state forwarding examples**:

- `packages/workflows/src/extension/extension-runtime-state.ts:136-137`
- `packages/workflows/src/extension/extension-runtime-state.ts:185-186`
- `packages/workflows/src/extension/extension-runtime-state.ts:226-227`

```ts
mcp: mcpPort,
usageRollup: usageRollupPort,
```

**Related type omission lists including `usageRollup`**: `packages/workflows/src/engine/options.ts:9-10`, `packages/workflows/src/engine/options.ts:33-34`

```ts
| "persistence"
| "usageRollup"
```

```ts
| "mcp"
| "usageRollup"
```

---

### Pattern 10: Footer transitive cost rendering tests with fake session

**Found in**: `test/unit/transitive-usage.test.ts:268-319`
**Used for**: Testing footer usage line behavior with `getTransitiveUsage()` supplied by a fake session object.

```ts
describe("footer transitive cost rendering", () => {
	test("incomplete totals render a lower-bound ~ prefix and keep context percent self-only", () => {
		const selfUsage = usage(12, 1);
		const transitive = {
			self: selfUsage,
			descendants: usage(1_000, 2.5),
			total: usage(1_012, 3.5),
			complete: false,
			breakdown: [],
		};
		const session = {
			state: { model: { contextWindow: 100 } },
			modelRegistry: { isUsingOAuth: () => false },
			sessionManager: {
				getEntries: () => [{ type: "message", message: { role: "assistant", usage: selfUsage } }],
			},
			getContextUsage: () => ({ tokens: 12, contextWindow: 100, percent: 12 }),
			getTransitiveUsage: () => transitive,
		};
		const rendered = stripAnsi(getUsageLine(session as never, false, 120));
		assert.match(rendered, /↑12/);
		assert.match(rendered, /~\$3\.500/);
		assert.match(rendered, /12\.0%\/100/);
		assert.doesNotMatch(rendered, /1012%/);
	});
});
```

**Additional cases**:

- Incomplete zero-cost lower-bound dollars: `test/unit/transitive-usage.test.ts:294-304`
- Self-only zero usage with descendant total cost but context self-only: `test/unit/transitive-usage.test.ts:306-318`

---

## Exact Files/Stubs to Update

### 1. Footer fake `AgentSession`

- `packages/coding-agent/test/footer-width.test.ts:18-70`

This stub currently lacks `getTransitiveUsage()`. If footer width coverage needs transitive usage/cost rendering, this is the exact fake session factory to extend.

### 2. Main transitive usage unit tests

- `test/unit/transitive-usage.test.ts`

Relevant sections:

- Aggregator tests: `test/unit/transitive-usage.test.ts:29-123`
- Durable collection tests: `test/unit/transitive-usage.test.ts:125-170`
- Subagent rollup tests: `test/unit/transitive-usage.test.ts:172-244`
- Workflow rollup port tests: `test/unit/transitive-usage.test.ts:246-266`
- Footer transitive cost tests: `test/unit/transitive-usage.test.ts:268-319`
- JSONL helpers: `test/unit/transitive-usage.test.ts:321-335`

### 3. Aggregator implementation under test

- `packages/coding-agent/src/core/transitive-usage.ts:119-184`

Relevant methods:

- `getTransitiveUsage()`: `packages/coding-agent/src/core/transitive-usage.ts:132-142`
- `attributeDescendantUsage()`: `packages/coding-agent/src/core/transitive-usage.ts:144-159`
- `reconcile()`: `packages/coding-agent/src/core/transitive-usage.ts:162-177`
- `markIncomplete()`: `packages/coding-agent/src/core/transitive-usage.ts:179-183`

### 4. Durable report collection implementation under test

- `packages/coding-agent/src/core/transitive-usage.ts:186-237`
- `packages/coding-agent/src/core/transitive-usage.ts:240-258`

### 5. Subagent rollup implementation under test

- `packages/subagents/src/shared/usage-rollup.ts:87-160`
- `packages/subagents/src/shared/usage-rollup.ts:219-252`

Relevant functions:

- `usageRollupFromModelAttempts()`: `packages/subagents/src/shared/usage-rollup.ts:87-98`
- `reportSubagentUsageForRoot()`: `packages/subagents/src/shared/usage-rollup.ts:114-129`
- `reportSubagentStarted()`: `packages/subagents/src/shared/usage-rollup.ts:132-142`
- `usageRollupFromResult()`: `packages/subagents/src/shared/usage-rollup.ts:145-148`
- `usageRollupFromAttemptBackedResult()`: `packages/subagents/src/shared/usage-rollup.ts:151-160`
- `workflowStageUsagesFromEntries()`: `packages/subagents/src/shared/usage-rollup.ts:240-252`

### 6. Workflow rollup forwarding implementation under test

- `packages/workflows/src/extension/workflow-ports.ts:43-60`
- `packages/workflows/src/runs/foreground/executor-stage-factory.ts:200-215`
- `packages/workflows/src/engine/run.ts:222-245`
- `packages/workflows/src/extension/runtime.ts:155-190`
- `packages/workflows/src/extension/extension-runtime-state.ts:66-67`, `136-137`, `185-186`, `226-227`

## Existing Test Helpers

**Usage helper**: `test/unit/transitive-usage.test.ts:14-23`

```ts
function usage(input: number, cost: number): Usage {
	return {
		input,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}
```

**ANSI stripper**: `test/unit/transitive-usage.test.ts:25-27`

```ts
function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}
```

**Session JSONL helpers**: `test/unit/transitive-usage.test.ts:321-335`

```ts
function sessionHeader(id: string, parentSession?: string) {
	return { type: "session", id, cwd: process.cwd(), timestamp: new Date().toISOString(), ...(parentSession ? { parentSession } : {}) };
}

function assistantEntry(entryUsage: Usage) {
	return { type: "message", id: crypto.randomUUID(), timestamp: new Date().toISOString(), message: { role: "assistant", usage: entryUsage, content: [] } };
}

function customStageEnd(sessionId: string, entryUsage: Usage, sessionFile: string) {
	return { type: "custom", id: crypto.randomUUID(), timestamp: new Date().toISOString(), customType: "workflow.stage.end", data: { stageId: "stage-a", sessionId, sessionFile, usage: entryUsage } };
}

function writeSession(path: string, id: string, entries: object[], parentSession?: string) {
	writeFileSync(path, [sessionHeader(id, parentSession), ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}
```