I completed the read-only research, but this subagent only has read/search/find/list tools available and no write/edit tool, so I could not create `/workspaces/atomic/research/docs/2026-07-10-transitive-cost-review-fix-patterns.md` directly.

Below are the findings intended for that file.

---

# 2026-07-10 Transitive Cost Review Fix Patterns

## Pattern Examples: Forked session parent transcript baselines

### Pattern 1: Workflow task options carry `context: "fork"` and `forkFromSessionFile`

**Found in**: `test/unit/builtin-workflows-goal-02.test.ts:224-298`
**Used for**: Verifying later worker turns fork from prior worker sessions while reviewer sessions do not inherit worker history.

```ts
test("forks later worker turns from the prior worker session without forking reviewers", async () => {
    const mod = await import("../../packages/workflows/builtin/goal.js");
    const d = mod.default as unknown as WorkflowDefinition;
    const ctx = makeMockCtx(
        { objective: "Ship it", max_turns: 2 },
        { stageOutputs: goalStageOutputs() },
    );

    await d.run(ctx, { objective: "Ship it", max_turns: 2 });

    assert.equal(
        ctx.calls.taskOptions["work-turn-1"]?.[0]?.forkFromSessionFile,
        undefined,
    );
    assert.equal(
        ctx.calls.taskOptions["work-turn-2"]?.[0]?.context,
        "fork",
    );
    assert.equal(
        ctx.calls.taskOptions["work-turn-2"]?.[0]?.forkFromSessionFile,
        "/tmp/goal-work-turn-1.jsonl",
    );

    for (const reviewerName of ["reviewer-a", "reviewer-b"]) {
        assert.equal(
            ctx.calls.taskOptions[reviewerName]?.[0]?.forkFromSessionFile,
            undefined,
            reviewerName,
        );
    }
});
```

**Key aspects**:

- First worker turn has no fork source.
- Later worker turn uses `context: "fork"`.
- Later worker turn uses previous worker session file.
- Reviewer task options explicitly avoid `forkFromSessionFile`.

### Pattern 2: Repeated design workflow stages fork only matching prior stage sessions

**Found in**: `test/unit/builtin-workflows-open_claude_design-02.test.ts:58-85`
**Used for**: Verifying generate and feedback loops fork from their own previous session baselines.

```ts
test("forks generate and user-feedback loops from their prior sessions", async () => {
    const mod =
        await import("../../packages/workflows/builtin/open-claude-design.js");
    const d = mod.default as unknown as WorkflowDefinition;
    const ctx = makeMockCtx({ iterations: 2 });

    const result = await d.run(ctx, { iterations: 2 });

    const feedbackOneOptions = ctx.calls.taskOptions["user-feedback-1"]?.[0];
    assert.equal(feedbackOneOptions?.context, undefined);
    assert.equal(feedbackOneOptions?.forkFromSessionFile, undefined);

    const generateTwoOptions = ctx.calls.taskOptions["generate-2"]?.[0];
    assert.equal(generateTwoOptions?.context, "fork");
    assert.equal(generateTwoOptions?.forkFromSessionFile, "/tmp/generate-1.jsonl");

    const feedbackTwoOptions = ctx.calls.taskOptions["user-feedback-2"]?.[0];
    assert.equal(feedbackTwoOptions?.context, "fork");
    assert.equal(feedbackTwoOptions?.forkFromSessionFile, "/tmp/user-feedback-1.jsonl");

    const artifactDir = result["artifact_dir"] as string;
    rmSync(artifactDir, { recursive: true, force: true });
});
```

**Key aspects**:

- First stage in a loop starts fresh.
- Later `generate-*` stages fork from prior `generate-*` session.
- Later `user-feedback-*` stages fork from prior `user-feedback-*` session.
- Fork baselines are stage-family-specific.

### Pattern 3: Runtime stage session options convert fork metadata into `SessionManager.forkFrom`

**Found in**: `packages/workflows/src/runs/foreground/stage-runner-options.ts:19-35`
**Used for**: Applying fork or resume semantics when creating stage agent sessions.

```ts
export function buildStageSessionOptions(input: BuildStageSessionOptionsInput): AgentSessionOptions {
  const {
    context,
    forkFromSessionFile,
    resumeFromSessionFile,
    durableReplayKey: _durableReplayKey,
    sessionDir,
    gitWorktreeDir: _gitWorktreeDir,
    ...sessionOptions
  } = input.options;

  const effectiveSessionDir = sessionDir ?? defaultSessionDir;
  if (resumeFromSessionFile !== undefined) {
    sessionOptions.sessionManager = SessionManager.open(resumeFromSessionFile, effectiveSessionDir, cwd);
  } else if (context === "fork" && forkFromSessionFile !== undefined) {
    sessionOptions.sessionManager = SessionManager.forkFrom(forkFromSessionFile, cwd, effectiveSessionDir);
  } else if (effectiveSessionDir !== undefined) {
    sessionOptions.sessionManager = SessionManager.create(cwd, effectiveSessionDir);
  }
}
```

**Key aspects**:

- `resumeFromSessionFile` takes precedence over fork.
- Fork requires both `context === "fork"` and `forkFromSessionFile`.
- Forking delegates to `SessionManager.forkFrom`.
- Non-fork sessions can still use an explicit session directory.

### Pattern 4: Tool helper injects current session file as fork baseline for direct workflow requests

**Found in**: `packages/workflows/src/extension/workflow-tool-helpers.ts:25-50`
**Used for**: Supplying a parent transcript baseline when user requests forked context without an explicit file.

```ts
function directRequestsFork(args: WorkflowToolArgs): boolean {
  if (args.context === "fork") return true;
  if (
    args.task !== undefined &&
    typeof args.task === "object" &&
    args.task.context === "fork"
  ) return true;
  if (args.tasks?.some((task) => task.context === "fork")) return true;
  return (
    args.chain?.some((step) =>
      "parallel" in step
        ? step.parallel.some((task) => task.context === "fork")
        : step.context === "fork",
    ) ?? false
  );
}

export function withForkFromCurrentSession(args: WorkflowToolArgs, ctx: WorkflowToolContext): WorkflowToolArgs {
  if (!directRequestsFork(args) || args.forkFromSessionFile !== undefined) return args;
  const sessionFile = ctx.sessionManager?.getSessionFile?.();
  return typeof sessionFile === "string" && sessionFile.length > 0
    ? { ...args, forkFromSessionFile: sessionFile }
    : args;
}
```

**Key aspects**:

- Detects fork requests in top-level, single task, task array, and chain structures.
- Does not overwrite explicit `forkFromSessionFile`.
- Uses current session manager’s session file as fork source.
- Returns original args when no current session file exists.

---

## Pattern Examples: Session tree walks excluding inherited history

### Pattern 1: Descendant usage walk filters sessions by root path

**Found in**: `packages/coding-agent/src/core/transitive-usage.ts:186-236`
**Used for**: Walking descendant sessions for transitive usage rollups.

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
            for (const report of workflowStageReportsFromEntries(entries, input.rootSessionId)) {
                reportsByKey.set(report.childRunId, report);
            }
            if (sessionPath === rootPath) continue;
            const listed = byPath.get(sessionPath);
            const header = entries.find((entry) => entry.type === "session") as ({ id?: string; workflow?: { stageName?: string } } | undefined);
            const report = {
                rootSessionId: input.rootSessionId,
                childRunId: listed?.id ?? header?.id ?? sessionPath,
                kind: listed?.workflow || header?.workflow ? "workflow-stage" : "subagent",
                usage: sumAssistantUsage(entries),
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

**Key aspects**:

- Starts from an explicit root session path.
- Uses `isDescendantOf(session, rootPath, byPath)` for listed sessions.
- Adds subagent session files discovered under the root path.
- Reads workflow-stage rollups from root entries but skips summing root assistant usage as a descendant.
- Marks the walk incomplete on list/discovery/load failures.

### Pattern 2: Test creates a root session plus child session directory

**Found in**: `test/unit/transitive-usage.test.ts:124-145`
**Used for**: Verifying subagent roots and workflow stage-end entries are discovered from the session tree.

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
                root: { path: rootPath, id: "root-id", cwd: dir, created: new Date(), modified: new Date(), messageCount: 0, firstMessage: "", allMessagesText: "" },
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

**Key aspects**:

- Root session file is `root.jsonl`.
- Subagent child is placed under `<root basename>/run-a/session.jsonl`.
- Root session also contains a `workflow.stage.end` custom entry.
- Assertions combine child assistant usage and workflow-stage usage.
- `listSessions` can be empty because filesystem discovery covers subagent sessions.

### Pattern 3: Workflow stage reports are extracted only from `workflow.stage.end` entries

**Found in**: `packages/coding-agent/src/core/transitive-usage.ts:239-257`
**Used for**: Deriving workflow-stage usage from persisted custom entries.

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

**Key aspects**:

- Only custom entries with `customType === "workflow.stage.end"` are considered.
- Requires a valid usage object.
- Prefers `sessionId` for child run identity.
- Falls back to `workflow-stage:<stageId>` or entry id.
- Preserves `sessionFile` alias metadata when present.

---

## Pattern Examples: Unsettled and lower-bound rollup tests

### Pattern 1: Aggregator marks totals incomplete when initial reconciliation has not completed

**Found in**: `test/unit/transitive-usage.test.ts:55-60`
**Used for**: Representing pending or incomplete transitive usage walks.

```ts
test("pending initial reconciliation marks totals incomplete", () => {
    const aggregator = new TransitiveUsageAggregator("root", () => usage(10, 1), undefined, { initialComplete: false });
    assert.equal(aggregator.getTransitiveUsage().complete, false);
    aggregator.reconcile([], true);
    assert.equal(aggregator.getTransitiveUsage().complete, true);
});
```

**Key aspects**:

- Constructor accepts `{ initialComplete: false }`.
- `getTransitiveUsage().complete` reports false before reconciliation.
- A complete reconciliation flips completeness to true.

### Pattern 2: Incomplete reconciliation preserves live reports not found durably

**Found in**: `test/unit/transitive-usage.test.ts:62-69`
**Used for**: Maintaining lower-bound usage when durable walk is incomplete.

```ts
test("incomplete reconciliation preserves live reports not found durably", () => {
    const aggregator = new TransitiveUsageAggregator("root", () => usage(10, 1));
    aggregator.attributeDescendantUsage({ rootSessionId: "root", childRunId: "live", kind: "subagent", usage: usage(20, 2), settled: true });
    aggregator.reconcile([], false);
    const result = aggregator.getTransitiveUsage();
    assert.equal(result.complete, false);
    assert.equal(result.descendants.cost.total, 2);
});
```

**Key aspects**:

- Existing live descendant report remains after incomplete reconciliation.
- `complete` is false.
- Descendant cost remains included as a lower-bound contribution.

### Pattern 3: Incomplete reconciliation aliases live run-id reports by session file

**Found in**: `test/unit/transitive-usage.test.ts:71-95`
**Used for**: Avoiding double-counting when live report IDs differ from durable session IDs.

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

**Key aspects**:

- Live report uses `childRunId: "live-run"`.
- Durable report uses `childRunId: "durable-session-id"`.
- Same `sessionFile` aliases the two reports.
- Breakdown keeps durable identity without duplicate cost.

### Pattern 4: Parallel rollups alias by `sessionFiles`

**Found in**: `test/unit/transitive-usage.test.ts:97-121`
**Used for**: Replacing a parallel aggregate with file-derived partial reports when reconciliation is incomplete.

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

- Aggregate report contains multiple `sessionFiles`.
- File-derived report for one session replaces matching aggregate.
- Incomplete status is preserved.
- Cost reflects discovered lower-bound usage.

### Pattern 5: Footer renders incomplete totals with a lower-bound `~` prefix

**Found in**: `test/unit/transitive-usage.test.ts:166-190`
**Used for**: Displaying incomplete transitive cost as a lower-bound while keeping context self-only.

```ts
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
```

**Key aspects**:

- Incomplete total cost renders as `~$...`.
- Context percent stays based on self usage.
- Descendant tokens do not inflate context-window percentage.
- The rendered badge still shows self token count.

### Pattern 6: Zero-cost incomplete totals still render lower-bound dollars

**Found in**: `test/unit/transitive-usage.test.ts:192-202`
**Used for**: Ensuring lower-bound marker appears even when total cost is zero.

```ts
test("incomplete zero-cost totals render lower-bound dollars for non-subscription models", () => {
    const session = {
        state: { model: { contextWindow: 200 } },
        modelRegistry: { isUsingOAuth: () => false },
        sessionManager: { getEntries: () => [] },
        getContextUsage: () => ({ tokens: 0, contextWindow: 200, percent: 0 }),
        getTransitiveUsage: () => ({ self: emptyUsage(), descendants: emptyUsage(), total: emptyUsage(), complete: false, breakdown: [] }),
    };
    const rendered = stripAnsi(getUsageLine(session as never, false, 120));
    assert.match(rendered, /~\$0\.000/);
});
```

**Key aspects**:

- Incomplete zero usage still renders `~$0.000`.
- Uses non-subscription model path.
- No assistant entries required.

### Pattern 7: Aggregator implementation computes `complete` from walk state plus unsettled contributions

**Found in**: `packages/coding-agent/src/core/transitive-usage.ts:132-141`
**Used for**: Combining self and descendant usage while reflecting unsettled or incomplete rollups.

```ts
getTransitiveUsage(): TransitiveUsage {
    const self = this.getSelfUsage();
    let descendants = emptyUsage();
    let complete = this.walkComplete;
    const breakdown = [...this.descendants.values()];
    for (const contribution of breakdown) {
        descendants = addUsage(descendants, contribution.usage);
        if (!contribution.settled) complete = false;
    }
    return { self, descendants, total: addUsage(self, descendants), complete, breakdown };
}
```

**Key aspects**:

- Self usage and descendant usage remain separate.
- `complete` starts from `walkComplete`.
- Any unsettled contribution makes `complete` false.
- Total is computed as self plus descendants.

---

## Pattern Examples: Async start/completion event tests

### Pattern 1: Workflow lifecycle notification emits one completion notice

**Found in**: `test/unit/workflow-lifecycle-notifications-01.test.ts:105-108`
**Used for**: Verifying workflow completion notification behavior.

```ts
describe("installWorkflowLifecycleNotifications", () => {
  test("emits one completion notice when a run completes", () => {
    const { store, sent, options } = install();
    store.recordRunStart({ id: "run-1", name: "release", inputs: {}, status: "running", stages: [], startedAt: 1 });
```

**Key aspects**:

- Test uses store mutations to trigger lifecycle notifications.
- Starts with `recordRunStart`.
- Completion is verified through collected `sent` messages.

### Pattern 2: Async notification suppression does not suppress later unrelated completion

**Found in**: `test/unit/workflow-lifecycle-notifications-02.test.ts:116-143`
**Used for**: Ensuring async suppression is scoped to the async run.

```ts
startRun(store, "run-async-suppressed", "async suppressed");
let release!: () => void;
const gate = new Promise<void>((resolve) => {
  release = resolve;
});

/* ... */

startRun(store, "run-after-async-suppression", "after async suppression");
store.recordRunEnd("run-after-async-suppression", "completed", {});
assert.deepEqual(sent.map((message) => message.details?.runId), ["run-after-async-suppression"]);
```

**Key aspects**:

- Uses a gated async operation.
- Starts one async-suppressed run.
- Starts and completes another run afterward.
- Asserts only the later run emits notification details.

### Pattern 3: Stage-end persistence includes session, usage, replay, and child workflow metadata

**Found in**: `packages/workflows/src/shared/persistence-session-entries.ts:190-218`
**Used for**: Persisting completion events with metadata needed by restore and rollup paths.

```ts
/** Appends a `workflow.stage.end` entry. Optionally emits a custom message entry. */
export function appendStageEnd(
  api: PersistenceAPI,
  payload: StageEndPayload,
  opts?: { emitMessage?: boolean },
): void {
  if (typeof api.appendEntry !== "function") return;
  api.appendEntry("workflow.stage.end", {
    runId: payload.runId,
    stageId: payload.stageId,
    status: payload.status,
    ...(payload.durationMs !== undefined ? { durationMs: payload.durationMs } : {}),
    ...(payload.summary !== undefined ? { summary: payload.summary } : {}),
    ...(payload.error !== undefined ? { error: payload.error } : {}),
    ...(payload.failureKind !== undefined ? { failureKind: payload.failureKind } : {}),
    ...(payload.failureCode !== undefined ? { failureCode: payload.failureCode } : {}),
    ...(payload.failureRecoverability !== undefined ? { failureRecoverability: payload.failureRecoverability } : {}),
    ...(payload.failureDisposition !== undefined ? { failureDisposition: payload.failureDisposition } : {}),
    ...(payload.failureMessage !== undefined ? { failureMessage: payload.failureMessage } : {}),
    ...(payload.retryAfterMs !== undefined ? { retryAfterMs: payload.retryAfterMs } : {}),
    ...(payload.skippedReason !== undefined ? { skippedReason: payload.skippedReason } : {}),
    ...(payload.sessionId !== undefined ? { sessionId: payload.sessionId } : {}),
    ...(payload.sessionFile !== undefined ? { sessionFile: payload.sessionFile } : {}),
    ...(payload.usage !== undefined ? { usage: payload.usage } : {}),
    ...(payload.replayKey !== undefined ? { replayKey: payload.replayKey } : {}),
    ...(payload.replayedFromStageId !== undefined ? { replayedFromStageId: payload.replayedFromStageId } : {}),
    ...(payload.replayed !== undefined ? { replayed: payload.replayed } : {}),
    ...(payload.status === "completed" && payload.workflowChild !== undefined ? { workflowChild: payload.workflowChild } : {}),
  });
}
```

**Key aspects**:

- Stage completion is persisted as `workflow.stage.end`.
- Completion event can include `sessionId`, `sessionFile`, and `usage`.
- Replay metadata is included when available.
- Child workflow metadata is included only for completed stages.

### Pattern 4: Stage-start persistence includes parent IDs and replay metadata

**Found in**: `packages/workflows/src/shared/persistence-session-entries.ts:163-176`
**Used for**: Persisting start events for later restore and graph reconstruction.

```ts
/** Appends a `workflow.stage.start` entry. */
export function appendStageStart(api: PersistenceAPI, payload: StageStartPayload): void {
  if (typeof api.appendEntry !== "function") return;
  api.appendEntry("workflow.stage.start", {
    runId: payload.runId,
    stageId: payload.stageId,
    name: payload.name,
    parentIds: [...payload.parentIds],
    ...(payload.model !== undefined ? { model: payload.model } : {}),
    ...(payload.replayKey !== undefined ? { replayKey: payload.replayKey } : {}),
    ...(payload.replayedFromStageId !== undefined ? { replayedFromStageId: payload.replayedFromStageId } : {}),
    ...(payload.replayed !== undefined ? { replayed: payload.replayed } : {}),
    ts: payload.ts,
  });
}
```

**Key aspects**:

- Stage start includes `runId`, `stageId`, `name`, and `parentIds`.
- Parent IDs are copied into a new array.
- Model and replay metadata are optional.
- Timestamp is stored as `ts`.

---

## Pattern Examples: Workflow persistence restore tests

### Pattern 1: Scanning in-flight runs from persisted session entries

**Found in**: `test/unit/persistence-restore-01.test.ts:21-43`
**Used for**: Finding runs that have a `workflow.run.start` entry but no matching `workflow.run.end`.

```ts
describe("scanInFlightRuns", () => {
  test("returns empty for empty entries", () => {
    assert.equal(scanInFlightRuns([]).length, 0);
  });

  test("returns empty when all runs have ended", () => {
    const entries: SessionEntry[] = [
      { id: "e1", type: "workflow.run.start", payload: { runId: "r1", name: "wf", inputs: {}, ts: 1 } },
      { id: "e2", type: "workflow.run.end", payload: { runId: "r1", status: "completed", ts: 2 } },
    ];
    assert.equal(scanInFlightRuns(entries).length, 0);
  });

  test("returns in-flight run when run.start has no run.end", () => {
    const entries: SessionEntry[] = [
      { id: "e1", type: "workflow.run.start", payload: { runId: "r1", name: "wf", inputs: {}, ts: 100 } },
    ];
    const result = scanInFlightRuns(entries);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.runId, "r1");
    assert.equal(result[0]!.name, "wf");
    assert.equal(result[0]!.startTs, 100);
  });
});
```

**Key aspects**:

- Empty entries return no in-flight runs.
- Completed runs are excluded.
- Run with start but no end is returned.
- Run id, name, and start timestamp are restored.

### Pattern 2: Restore collects stage IDs from `workflow.stage.start`

**Found in**: `test/unit/persistence-restore-01.test.ts:56-64`
**Used for**: Reconstructing stage membership during workflow restore.

```ts
test("collects stageIds from stage.start entries for in-flight run", () => {
  const entries: SessionEntry[] = [
    { id: "e1", type: "workflow.run.start",   payload: { runId: "r1", name: "wf", inputs: {}, ts: 1 } },
    { id: "e2", type: "workflow.stage.start",  payload: { runId: "r1", stageId: "s1", name: "fetch", parentIds: [], ts: 2 } },
    { id: "e3", type: "workflow.stage.start",  payload: { runId: "r1", stageId: "s2", name: "analyze", parentIds: ["s1"], ts: 3 } },
  ];
  const result = scanInFlightRuns(entries);
  assert.deepEqual(result[0]!.stageIds, ["s1", "s2"]);
});
```

**Key aspects**:

- Stage IDs are collected from start entries.
- Parent IDs can be present in stage starts.
- Stage order follows entry order.

### Pattern 3: Restore de-duplicates duplicate stage starts

**Found in**: `test/unit/persistence-restore-01.test.ts:66-74`
**Used for**: Handling repeated persisted lifecycle entries.

```ts
test("does not duplicate stageIds from duplicate stage.start entries", () => {
  const entries: SessionEntry[] = [
    { id: "e1", type: "workflow.run.start",  payload: { runId: "r1", name: "wf", inputs: {}, ts: 1 } },
    { id: "e2", type: "workflow.stage.start", payload: { runId: "r1", stageId: "s1", name: "n", parentIds: [], ts: 2 } },
    { id: "e3", type: "workflow.stage.start", payload: { runId: "r1", stageId: "s1", name: "n", parentIds: [], ts: 2 } },
  ];
  const result = scanInFlightRuns(entries);
  assert.deepEqual(result[0]!.stageIds, ["s1"]);
});
```

**Key aspects**:

- Duplicate `workflow.stage.start` entries do not duplicate stage IDs.
- Duplicate detection is by stage id.

### Pattern 4: Restore preserves run inputs

**Found in**: `test/unit/persistence-restore-01.test.ts:76-82`
**Used for**: Reconstructing workflow inputs from persisted run-start payload.

```ts
test("preserves inputs from run.start payload", () => {
  const entries: SessionEntry[] = [
    { id: "e1", type: "workflow.run.start", payload: { runId: "r1", name: "wf", inputs: { key: "val" }, ts: 1 } },
  ];
  const result = scanInFlightRuns(entries);
  assert.equal((result[0]!.inputs as Record<string, unknown>)["key"], "val");
});
```

**Key aspects**:

- Inputs are read directly from run-start payload.
- Arbitrary object fields survive scan.

### Pattern 5: Restore applies blocked status only to descendants of failed stage

**Found in**: `test/unit/persistence-restore-03.test.ts:21-85`
**Used for**: Session tree/graph restoration from persisted blocked-run metadata.

```ts
test("restores workflow.run.blocked only onto descendants of the failed stage", () => {
  const st = createStore();
  const entries: SessionEntry[] = [
    { id: "e1", type: "workflow.run.start", payload: { runId: "r1", name: "wf", inputs: {}, ts: 1 } },
    { id: "e2", type: "workflow.stage.start", payload: { runId: "r1", stageId: "s1", name: "failed", parentIds: [], ts: 2 } },
    {
      id: "e3",
      type: "workflow.stage.end",
      payload: {
        runId: "r1",
        stageId: "s1",
        status: "failed",
        error: "rate limit",
        failureKind: "rate_limit",
        failureCode: "rate_limited",
        failureRecoverability: "recoverable",
        failureDisposition: "active_blocked",
        failureMessage: "HTTP 429",
      },
    },
    { id: "e4", type: "workflow.stage.start", payload: { runId: "r1", stageId: "s2", name: "unrelated", parentIds: [], ts: 3 } },
    { id: "e5", type: "workflow.stage.start", payload: { runId: "r1", stageId: "s3", name: "direct", parentIds: ["s1"], ts: 4 } },
    { id: "e6", type: "workflow.stage.start", payload: { runId: "r1", stageId: "s4", name: "transitive", parentIds: ["s3"], ts: 5 } },
    {
      id: "e7",
      type: "workflow.run.blocked",
      payload: {
        runId: "r1",
        failedStageId: "s1",
        error: "rate limit",
        failureKind: "rate_limit",
        failureCode: "rate_limited",
        failureMessage: "HTTP 429",
        failureRecoverability: "recoverable",
        failureDisposition: "active_blocked",
        resumable: true,
        ts: 6,
      },
    },
  ];

  restoreOnSessionStart(makeSessionManager(entries), { resumeInFlight: "never", persistRuns: true }, st);

  const run = st.runs()[0]!;
  const byId = new Map(run.stages.map((stage) => [stage.id, stage]));
  const s1 = byId.get("s1")!;
  const s2 = byId.get("s2")!;
  const s3 = byId.get("s3")!;
  const s4 = byId.get("s4")!;

  assert.equal(run.status, "running");
  assert.equal(s1.status, "failed");
  assert.equal(s2.status, "running");
  assert.equal(s2.blockedByStageId, undefined);
  assert.equal(s3.status, "blocked");
  assert.equal(s3.blockedByStageId, "s1");
  assert.equal(s4.status, "blocked");
  assert.equal(s4.blockedByStageId, "s1");
});
```

**Key aspects**:

- Failed stage remains failed.
- Unrelated stage remains running.
- Direct descendant becomes blocked.
- Transitive descendant becomes blocked.
- `blockedByStageId` points to the failed stage.

---

## Pattern Examples: Durable / DBOS checkpoint envelope tests

### Pattern 1: DBOS mock SDK stores checkpoint envelopes and supports hydration

**Found in**: `test/unit/durable-dbos-backend.test.ts:23-68`
**Used for**: Testing DBOS-backed durable behavior without real Postgres.

```ts
interface MockDbosState {
  readonly workflows: Map<string, DbosWorkflowInfo>;
  /** stepName → envelope/output for each checkpoint workflow. */
  readonly steps: Map<string, WorkflowSerializableValue>;
  readonly starts: { workflowId: string; name: string }[];
  readonly cancels: string[];
  readonly resumes: string[];
}

function createMockSdk(): DbosSdkHandle & { state: MockDbosState } {
  const state: MockDbosState = {
    workflows: new Map(),
    steps: new Map(),
    starts: [],
    cancels: [],
    resumes: [],
  };
  return {
    state,
    async launch() {},
    async shutdown() {},
    async startWorkflow(workflowId, name) {
      state.starts.push({ workflowId, name });
      if (!state.workflows.has(workflowId)) {
        state.workflows.set(workflowId, { workflowId, name, status: "PENDING", createdAt: Date.now() });
      }
    },
    async retrieveWorkflow(workflowId) { return state.workflows.get(workflowId); },
    async cancelWorkflow(workflowId) { state.cancels.push(workflowId); },
    async resumeWorkflow(workflowId) { state.resumes.push(workflowId); },
    async listAllWorkflows() { return [...state.workflows.values()]; },
    async listStepRecords(workflowId) {
      const prefix = `${workflowId}:checkpoint:`;
      const records: DbosStepRecord[] = [];
      for (const [key, output] of state.steps) {
        if (key.startsWith(prefix)) {
          records.push({ stepName: key.slice(prefix.length), output });
        }
      }
      return records;
    },
    async recordStepOutput(workflowId, stepName, output) {
      state.steps.set(`${workflowId}:checkpoint:${stepName}`, output);
    },
  };
}
```

**Key aspects**:

- Mock stores workflows and checkpoint step outputs separately.
- `listStepRecords` filters by `${workflowId}:checkpoint:`.
- `recordStepOutput` stores the DBOS step output.
- Tests can inspect raw stored envelopes.

### Pattern 2: `recordCheckpoint` stores a typed DBOS envelope

**Found in**: `test/unit/durable-dbos-backend.test.ts:114-129`
**Used for**: Verifying DBOS checkpoint metadata is not reduced to raw output.

```ts
test("recordCheckpoint stores envelope in DBOS", async () => {
  backend.registerWorkflow({ workflowId: "wf-2", name: "test", inputs: {}, createdAt: Date.now(), status: "running" });
  const hash = durableHash({ name: "fetch", args: {} });
  const cp: DurableToolCheckpoint = {
    kind: "tool", workflowId: "wf-2", checkpointId: "cp-1", name: "fetch-data", argsHash: hash, output: "result", completedAt: Date.now(),
  };
  backend.recordCheckpoint(cp);
  await backend.flush();
  assert.equal([...sdk.state.steps.keys()].filter((k) => k.includes(":checkpoint:__atomic_metadata")).length, 2);
  const stored = sdk.state.steps.get("wf-2:checkpoint:cp-1");
  assert.ok(isCheckpointEnvelope(stored));
  const env = stored as DbosCheckpointEnvelope;
  assert.equal(env.kind, "tool");
  assert.equal(env.argsHash, hash);
  assert.equal(env.output, "result");
});
```

**Key aspects**:

- Registers workflow before checkpointing.
- Uses `durableHash` for args hash.
- Calls `recordCheckpoint` then awaits `flush`.
- Stored value is asserted with `isCheckpointEnvelope`.
- Envelope includes kind, args hash, and output.

### Pattern 3: Stage checkpoint envelope round-trips timing, session, model, and replay metadata

**Found in**: `test/unit/durable-dbos-backend.test.ts:131-156`
**Used for**: Ensuring stage metadata survives encode/decode.

```ts
test("stage checkpoint envelope round-trips hydration metadata", () => {
  const cp: DurableStageCheckpoint = {
    kind: "stage", workflowId: "wf-stage-meta", checkpointId: "stage:review:1", name: "review",
    replayKey: "stage:review:1", output: { verdict: "pass" }, completedAt: 3000,
    startedAt: 1000, endedAt: 3000, durationMs: 2000, result: "review passed",
    sessionId: "sid", sessionFile: "/tmp/review.jsonl", model: "gpt-test", fastMode: true,
    attemptedModels: ["gpt-test"], modelAttempts: [{ model: "gpt-test", success: true }],
  };

  const env = encodeCheckpoint(cp);
  assert.equal(env.startedAt, 1000);
  assert.equal(env.durationMs, 2000);
  assert.equal(env.result, "review passed");
  assert.deepEqual(env.attemptedModels, ["gpt-test"]);

  const decoded = decodeToCheckpoint("wf-stage-meta", "stage:review:1", env);
  assert.ok(decoded?.kind === "stage");
  assert.equal(decoded.startedAt, 1000);
  assert.equal(decoded.endedAt, 3000);
  assert.equal(decoded.durationMs, 2000);
  assert.equal(decoded.result, "review passed");
  assert.equal(decoded.model, "gpt-test");
  assert.equal(decoded.fastMode, true);
  assert.deepEqual(decoded.attemptedModels, ["gpt-test"]);
  assert.equal(decoded.modelAttempts?.[0]?.success, true);
});
```

**Key aspects**:

- Encodes a `DurableStageCheckpoint`.
- Decodes back with `decodeToCheckpoint`.
- Checks stage timing fields.
- Checks result/session/model metadata.
- Checks attempted model metadata.

### Pattern 4: Durable cache replay hydrates persisted stage timing, result, session, and model metadata into store

**Found in**: `test/unit/durable-stage-frontier-fixes.test.ts:160-184`
**Used for**: Verifying checkpoint metadata reaches workflow graph/store snapshots.

```ts
test("cached replay hydrates persisted stage timing, result, session, and model metadata", () => {
  const store = createStore();
  store.recordRunStart({ id: WORKFLOW_ID, name: "wf", inputs: {}, status: "running", stages: [], startedAt: Date.now() });
  const completedKeys = new Map<string, string>();
  const cp: DurableCompletedStageCheckpoint = {
    kind: "stage", workflowId: WORKFLOW_ID, checkpointId: "stage:hydrate:1", name: "hydrate",
    replayKey: "stage:hydrate:1", output: { structured: true }, completedAt: 2500,
    startedAt: 1000, endedAt: 2500, durationMs: 1500, result: "persisted summary",
    sessionId: "sid", sessionFile: "/tmp/session.jsonl", model: "gpt-test", fastMode: true,
    attemptedModels: ["gpt-test"], modelAttempts: [{ model: "gpt-test", success: true }],
  };

  recordCachedStageIntoStore(store, WORKFLOW_ID, "hydrate", cp.replayKey, cp.output, completedKeys, [], cp);
  const stage = store.runs().find((r) => r.id === WORKFLOW_ID)!.stages[0]!;
  assert.equal(stage.startedAt, 1000);
  assert.equal(stage.endedAt, 2500);
  assert.equal(stage.durationMs, 1500);
  assert.equal(stage.result, "persisted summary");
  assert.equal(stage.sessionId, "sid");
  assert.equal(stage.sessionFile, "/tmp/session.jsonl");
  assert.equal(stage.model, "gpt-test");
  assert.equal(stage.fastMode, true);
  assert.deepEqual(stage.attemptedModels, ["gpt-test"]);
  assert.equal(stage.modelAttempts?.[0]?.success, true);
});
```

**Key aspects**:

- Starts a run in the workflow store.
- Builds a durable completed stage checkpoint with metadata.
- Calls `recordCachedStageIntoStore`.
- Asserts metadata is present on restored stage snapshot.

### Pattern 5: DBOS hydration ignores malformed metadata and falls back to valid metadata

**Found in**: `test/unit/durable-dbos-metadata-validation.test.ts:38-66`
**Used for**: Validation behavior around durable metadata during hydration.

```ts
test("DBOS hydration ignores malformed Atomic metadata and keeps valid metadata fallback", async () => {
  const sdk = createMockSdk();
  const session1 = new DbosDurableBackend(sdk);
  session1.registerWorkflow({ workflowId: "wf-meta-valid", name: "meta-valid", inputs: { x: 1 }, createdAt: 10, status: "running" });
  session1.recordCheckpoint({ kind: "tool", workflowId: "wf-meta-valid", checkpointId: "tool:valid", name: "meta-step", argsHash: "h-valid", output: "ok", completedAt: 11 });
  session1.setWorkflowStatus("wf-meta-valid", "paused");
  await session1.flush();
  const malformedEntries: readonly WorkflowSerializableValue[] = [
    null,
    ["not", "an", "entry"],
    "not-an-entry",
    { type: "workflow.durable.checkpoint", workflowId: 42, name: "bad", inputs: {}, status: "paused", completedCheckpoints: 9, pendingPrompts: 0, ts: 999 },
    { type: "workflow.durable.checkpoint", workflowId: "wf-meta-valid" },
  ];
  malformedEntries.forEach((entry, index) => {
    sdk.state.steps.set(`wf-meta-valid:checkpoint:__atomic_metadata:99${index}:malformed`, {
      __atomicDurableMetadata: true,
      version: 1,
      entry,
    });
  });

  const fresh = new DbosDurableBackend(sdk);
  await fresh.hydrateResumableWorkflows();
  const entry = fresh.listResumableWorkflows().find((item) => item.workflowId === "wf-meta-valid");
  assert.equal(entry?.status, "paused");
  assert.equal(entry?.name, "meta-valid");
  assert.equal(entry?.completedCheckpoints, 1);
});
```

**Key aspects**:

- Seeds valid DBOS durable state.
- Adds malformed metadata entries directly to mock DBOS step storage.
- Hydrates with a fresh backend.
- Asserts resumable workflow metadata remains valid.
- Completed checkpoint count is computed from real checkpoints.

### Pattern 6: DBOS envelope schema and encode/decode functions

**Found in**: `packages/workflows/src/durable/dbos-envelope.ts:1-14`, `packages/workflows/src/durable/dbos-envelope.ts:27-40`, `packages/workflows/src/durable/dbos-envelope.ts:64-71`, `packages/workflows/src/durable/dbos-envelope.ts:104-117`
**Used for**: Persisting full durable checkpoint metadata as DBOS step output.

```ts
/**
 * DBOS checkpoint envelope — a structured payload stored as DBOS step output so
 * a fresh process can reconstruct full durable checkpoints from DBOS alone.
 *
 * Without the envelope, `recordStepOutput` would only persist the raw output
 * value, losing checkpoint metadata (kind, checkpointId, argsHash, promptHash,
 * replayKey, etc.). That makes cross-process DBOS hydration impossible because
 * the synchronous replay reads (`getToolOutput`, `getUiResponse`,
 * `getStageOutput`) cannot reconstruct their lookup keys.
 */

export const DBOS_ENVELOPE_VERSION = 1;

const ENVELOPE_MARKER = "__dbos_checkpoint__";

export interface DbosCheckpointEnvelope extends WorkflowSerializableObject {
  readonly __dbos_checkpoint__: typeof ENVELOPE_MARKER;
  readonly v: typeof DBOS_ENVELOPE_VERSION;
  readonly kind: DurableCheckpointKind;
  readonly checkpointId: string;
  readonly name?: string;
}

export function encodeCheckpoint(cp: DurableCheckpoint): DbosCheckpointEnvelope {
  const output = checkpointOutputValue(cp);
  return {
    __dbos_checkpoint__: ENVELOPE_MARKER,
    v: DBOS_ENVELOPE_VERSION,
    kind: cp.kind,
    checkpointId: cp.checkpointId,
    ...(output !== undefined ? { output } : {}),
  };
}

/**
 * Decode a DBOS step output into a durable checkpoint.
 *
 * - Envelope payloads reconstruct the full checkpoint with original metadata.
 * - Non-envelope payloads (legacy/simple) produce a generic stage checkpoint
 */
```

**Key aspects**:

- Envelope marker is `__dbos_checkpoint__`.
- Version is `DBOS_ENVELOPE_VERSION`.
- Envelope includes checkpoint kind and ID.
- Encode preserves output when defined.
- Decode path supports envelope and legacy/simple outputs.

---

## Pattern Examples: Root session id access in workflow extension contexts

### Pattern 1: Workflow usage rollup port obtains root session ID from extension API session manager

**Found in**: `packages/workflows/src/extension/workflow-ports.ts:44-62`
**Used for**: Emitting workflow-stage descendant usage rollups with the root session ID.

```ts
export function makeUsageRollupPort(pi: ExtensionAPI): WorkflowUsageRollupPort | undefined {
  if (typeof pi.events?.emit !== "function") return undefined;
  return {
    recordStageUsage(_stageId: string, _usage: Usage): void {},
    emitStageRollup(stageId, usage, meta): void {
      const sessionManager = pi.sessionManager as ({ getSessionId?: () => string } | undefined);
      const rootSessionId = sessionManager?.getSessionId?.();
      if (!rootSessionId) return;
      pi.events!.emit!("usage:descendant-rollup", {
        rootSessionId,
        childRunId: meta?.sessionId ?? stageId,
        kind: "workflow-stage",
        usage,
        settled: true,
        label: meta?.label,
        sessionFile: meta?.sessionFile,
      });
    },
  };
}
```

**Key aspects**:

- Checks for `pi.events.emit`.
- Reads root session ID from `pi.sessionManager.getSessionId()`.
- Returns early when no root session ID exists.
- Emits `usage:descendant-rollup`.
- Includes child session id, stage label, usage, and session file.

### Pattern 2: Agent session transitive usage walk passes root session ID into collector

**Found in**: `packages/coding-agent/src/core/agent-session-transitive-usage.ts:12-39`
**Used for**: Linking a session tree walk to the current root session.

```ts
const sessionFile = this.sessionManager.getSessionFile();
const rootInfo = root ?? (sessionFile
    ? {
        path: sessionFile,
        id: this.sessionManager.getSessionId(),
        cwd: this.sessionManager.getCwd(),
        created: new Date(),
        modified: new Date(),
        messageCount: this.sessionManager.getEntries().length,
        firstMessage: "",
        allMessagesText: "",
    }
    : undefined);
if (!rootInfo) return this.getTransitiveUsage();

const listSessions = async () => {
    const local = await SessionManager.list(this.sessionManager.getCwd(), this.sessionManager.getSessionDir(), undefined, { includeInternal: true });
    const all = this.sessionManager.usesDefaultSessionDir()
        ? local
        : [...local, ...await SessionManager.list(this.sessionManager.getCwd(), undefined, undefined, { includeInternal: true })];
    return all;
};

const result = await collectDescendantUsageReports({
    root: rootInfo,
    rootSessionId: this.sessionManager.getSessionId(),
    listSessions,
});
this._transitiveUsageAggregator.reconcile(result.reports, result.complete);
return this.getTransitiveUsage();
```

**Key aspects**:

- Builds root session info from current session manager.
- Uses current session ID as `rootSessionId`.
- Lists local and default session dirs when needed.
- Passes root ID to `collectDescendantUsageReports`.
- Reconciles reports into the transitive usage aggregator.

### Pattern 3: Aggregator rejects reports for the wrong root

**Found in**: `packages/coding-agent/src/core/transitive-usage.ts:144-145`
**Used for**: Ensuring descendant rollups are attributed only to the matching root session.

```ts
attributeDescendantUsage(report: DescendantUsageReport): boolean {
    if (report.rootSessionId !== this.rootSessionId) return false;
    let changed = false;
```

**Key aspects**:

- Report root ID must equal aggregator root ID.
- Wrong-root rollups are ignored.
- Return value indicates no mutation.

### Pattern 4: Wrong-root behavior is tested

**Found in**: `test/unit/transitive-usage.test.ts:38-42`
**Used for**: Verifying root session ID gates descendant usage rollups.

```ts
test("wrong-root reports are rejected", () => {
    const aggregator = new TransitiveUsageAggregator("root", () => usage(10, 1));
    assert.equal(aggregator.attributeDescendantUsage({ rootSessionId: "other", childRunId: "child", kind: "subagent", usage: usage(20, 2), settled: true }), false);
    assert.equal(aggregator.getTransitiveUsage().descendants.cost.total, 0);
});
```

**Key aspects**:

- Aggregator root is `"root"`.
- Report root is `"other"`.
- Attribute call returns false.
- Descendant cost remains zero.

---

## Pattern Examples: Stage session id metadata tests

### Pattern 1: Stage prompt metadata propagates run ID, stage ID, and stage name

**Found in**: `test/unit/stage-runner-prompt-metadata.test.ts:21-68`
**Used for**: Testing metadata passed from stage context to prompt adapters.

```ts
describe("createStageContext — prompt metadata propagation", () => {
    test("prompt adapter receives runId from opts", async () => {
        const received: StageExecutionMeta[] = [];
        const promptAdapter: PromptAdapter = {
            async prompt(_text, meta) {
                received.push(meta!);
                return "ok";
            },
        };
        const ctx = createStageContext(
            makeOpts({ adapters: { prompt: promptAdapter }, runId: "run-001" }),
        );
        await ctx.prompt("hello");
        assert.equal(received[0]?.runId, "run-001");
    });

    test("prompt adapter receives stageId from opts", async () => {
        const received: StageExecutionMeta[] = [];
        const promptAdapter: PromptAdapter = {
            async prompt(_text, meta) {
                received.push(meta!);
                return "ok";
            },
        };
        const ctx = createStageContext(
            makeOpts({ adapters: { prompt: promptAdapter }, stageId: "s-99" }),
        );
        await ctx.prompt("hi");
        assert.equal(received[0]?.stageId, "s-99");
    });

    test("prompt adapter receives stageName from opts", async () => {
        const received: StageExecutionMeta[] = [];
        const promptAdapter: PromptAdapter = {
            async prompt(_text, meta) {
                received.push(meta!);
                return "ok";
            },
        };
        const ctx = createStageContext(
            makeOpts({
                adapters: { prompt: promptAdapter },
                stageName: "Analysis",
            }),
        );
        await ctx.prompt("analyze");
        assert.equal(received[0]?.stageName, "Analysis");
    });
});
```

**Key aspects**:

- Tests use a prompt adapter that captures metadata.
- `runId`, `stageId`, and `stageName` are tested independently.
- Metadata is passed on `ctx.prompt`.

### Pattern 2: Full prompt metadata object includes signal, stage options, and execution mode

**Found in**: `test/unit/stage-runner-prompt-metadata.test.ts:86-110`
**Used for**: Ensuring prompt metadata object has the expected complete shape.

```ts
test("prompt adapter receives full meta object in one call", async () => {
    const received: StageExecutionMeta[] = [];
    const signal = makeSignal();
    const promptAdapter: PromptAdapter = {
        async prompt(_text, meta) {
            received.push(meta!);
            return "done";
        },
    };
    const ctx = createStageContext({
        stageId: "s-42",
        stageName: "Summarise",
        runId: "r-100",
        signal,
        adapters: { prompt: promptAdapter },
    });
    await ctx.prompt("summarise this");
    assert.deepEqual(received[0], {
        runId: "r-100",
        stageId: "s-42",
        stageName: "Summarise",
        signal,
        stageOptions: undefined,
        executionMode: undefined,
    });
});
```

**Key aspects**:

- Full metadata object is asserted via `deepEqual`.
- Signal identity is preserved.
- Optional fields are explicitly `undefined`.

### Pattern 3: Stage-end persistence writes session id, session file, and usage

**Found in**: `packages/workflows/src/shared/persistence-session-entries.ts:211-213`
**Used for**: Persisting stage session metadata for restore and rollup paths.

```ts
...(payload.sessionId !== undefined ? { sessionId: payload.sessionId } : {}),
...(payload.sessionFile !== undefined ? { sessionFile: payload.sessionFile } : {}),
...(payload.usage !== undefined ? { usage: payload.usage } : {}),
```

**Key aspects**:

- `sessionId` is optional and only persisted when defined.
- `sessionFile` is optional and only persisted when defined.
- `usage` is optional and only persisted when defined.
- These fields are part of the `workflow.stage.end` entry payload.

### Pattern 4: Durable cached replay restores session id and session file into stage snapshot

**Found in**: `test/unit/durable-stage-frontier-fixes.test.ts:164-180`
**Used for**: Verifying stage session metadata survives durable replay.

```ts
const cp: DurableCompletedStageCheckpoint = {
  kind: "stage", workflowId: WORKFLOW_ID, checkpointId: "stage:hydrate:1", name: "hydrate",
  replayKey: "stage:hydrate:1", output: { structured: true }, completedAt: 2500,
  startedAt: 1000, endedAt: 2500, durationMs: 1500, result: "persisted summary",
  sessionId: "sid", sessionFile: "/tmp/session.jsonl", model: "gpt-test", fastMode: true,
  attemptedModels: ["gpt-test"], modelAttempts: [{ model: "gpt-test", success: true }],
};

recordCachedStageIntoStore(store, WORKFLOW_ID, "hydrate", cp.replayKey, cp.output, completedKeys, [], cp);
const stage = store.runs().find((r) => r.id === WORKFLOW_ID)!.stages[0]!;
assert.equal(stage.sessionId, "sid");
assert.equal(stage.sessionFile, "/tmp/session.jsonl");
assert.equal(stage.model, "gpt-test");
```

**Key aspects**:

- Checkpoint includes `sessionId` and `sessionFile`.
- Replay into store preserves both fields.
- Model metadata is restored alongside session metadata.

---

## Related Utilities and Code Locations

- `packages/coding-agent/src/core/transitive-usage.ts:119-184` — `TransitiveUsageAggregator` completeness and descendant report handling.
- `packages/coding-agent/src/core/transitive-usage.ts:186-236` — descendant session tree walk.
- `packages/coding-agent/src/core/transitive-usage.ts:239-257` — workflow stage-end usage extraction.
- `packages/coding-agent/src/core/agent-session-transitive-usage.ts:12-39` — root session info and transitive usage reconciliation.
- `packages/workflows/src/extension/workflow-ports.ts:44-62` — workflow stage usage rollup event with root session ID.
- `packages/workflows/src/shared/persistence-session-entries.ts:163-218` — stage start/end persistence payloads.
- `packages/workflows/src/runs/foreground/stage-runner-options.ts:19-35` — fork/resume session manager selection.
- `packages/workflows/src/extension/workflow-tool-helpers.ts:25-50` — direct fork request detection and current-session fork baseline injection.
- `packages/workflows/src/durable/dbos-envelope.ts:1-117` — DBOS durable checkpoint envelope encode/decode.
- `test/unit/transitive-usage.test.ts:28-217` — transitive usage aggregator, lower-bound rendering, and session walk tests.
- `test/unit/persistence-restore-01.test.ts:21-92` — workflow persistence scan tests.
- `test/unit/persistence-restore-03.test.ts:21-85` — blocked descendant restore test.
- `test/unit/durable-dbos-backend.test.ts:90-207` — DBOS backend and envelope behavior tests.
- `test/unit/durable-dbos-metadata-validation.test.ts:38-66` — malformed durable metadata hydration test.
- `test/unit/durable-stage-frontier-fixes.test.ts:160-184` — cached replay metadata hydration test.
- `test/unit/stage-runner-prompt-metadata.test.ts:21-160` — stage prompt metadata propagation tests.