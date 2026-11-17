import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeAll, describe, test, vi } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { postgresDialect } from "../../packages/coding-agent/src/core/storage/dialect.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { storedEventPayload } from "../../packages/workflows/src/durable/journal/internal.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { ShardedRunJournal } from "../../packages/workflows/src/durable/journal/sharded-run-journal.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { RUN_EVENT_TYPES } from "../../packages/workflows/src/durable/journal/types.js";
import { RUN_USAGE_CHECKPOINT_NAME } from "../../packages/workflows/src/durable/run-timing.js";
import {
	DURABLE_STAGE_TOPOLOGY_VERSION,
	type DurableStageCheckpoint,
} from "../../packages/workflows/src/durable/types.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { createWorkflowResumeProvider } from "../../packages/workflows/src/extension/workflow-resume-provider.js";
import { stageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { configureCurrentTestStoreBackend as setDurableBackend } from "../helpers/store-backend.js";

const definition = workflow({
	name: "goal",
	description: "Payload-free cold overview",
	inputs: {},
	outputs: {},
	run: async () => ({}),
});

const closers: Array<() => Promise<void>> = [];
const dirs: string[] = [];

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

afterEach(async () => {
	vi.restoreAllMocks();
	stageControlRegistry.clear();
	store.clear();
	setDurableBackend(undefined);
	while (closers.length > 0) await closers.pop()!().catch(() => undefined);
	for (const dir of dirs.splice(0)) removeTempDirectory(dir);
});

describe("payload-free cold workflow overview checkpoints (#5256)", () => {
	test("stores large stage checkpoints with an overview stub in wf_events and skips chunk reads on cold /resume while keeping full hydration exact", async () => {
		const dir = makeTempDirectory("cold-overview-stub-");
		dirs.push(dir);
		const path = join(dir, "journal.sqlite");
		const runId = "a1b2c3d4-1111-4222-8333-444444444444";
		const now = Date.now();
		const largeOutput = `STAGE_OUTPUT_PAYLOAD_${"x".repeat(16_384)}`;
		const largeResult = `STAGE_RESULT_PAYLOAD_${"y".repeat(16_384)}`;

		const writer = await JournalDurableBackend.open(await openSqlRunJournal(path));
		closers.push(() => writer.close());
		await writer.commitWorkflowRegistration({
			workflowId: runId,
			name: definition.name,
			label: "ship overview stub",
			inputs: {},
			createdAt: now - 120_000,
			updatedAt: now - 60_000,
			status: "running",
			completedCheckpoints: 0,
			pendingPrompts: 0,
			resumable: true,
			invocationCwd: process.cwd(),
		});
		await writer.commitCheckpoint({
			workflowId: runId,
			kind: "stage",
			checkpointId: "stage:implement",
			replayKey: "stage:implement",
			name: "implement",
			sessionId: "sess-stage-1",
			output: largeOutput,
			result: largeResult,
			startedAt: now - 120_000,
			endedAt: now - 60_000,
			durationMs: 60_000,
			completedAt: now - 60_000,
			modelAttempts: [
				{
					model: "claude-sonnet-4-6",
					success: true,
					usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: 0.25 },
				},
			],
			topology: {
				version: DURABLE_STAGE_TOPOLOGY_VERSION,
				stageId: "implement",
				parentIds: [],
				order: 1,
				sourceOrder: 1,
				status: "completed",
			},
		});
		await writer.commitWorkflowStatus(runId, "paused", 0, true);
		await writer.close();

		const rawDb = new DatabaseSync(path, { readOnly: true });
		try {
			const row = rawDb
				.prepare("SELECT payload, chunks FROM wf_events WHERE run_id = ? AND key LIKE '%stage:implement%'")
				.get(runId) as { payload: string; chunks: number } | undefined;
			assert.ok(row, "expected recorded stage checkpoint row");
			assert.ok(Number(row.chunks) > 0, "large stage checkpoint must store full JSON in wf_event_chunks");
			assert.ok(row.payload.length < 4096, `expected compact stub in wf_events, got ${row.payload.length} chars`);
			assert.equal(row.payload.includes("STAGE_OUTPUT_PAYLOAD_"), false);
			assert.equal(row.payload.includes("STAGE_RESULT_PAYLOAD_"), false);
			const parsedStub = JSON.parse(row.payload) as Record<string, unknown>;
			assert.equal(parsedStub.overviewStub, 1);
			assert.equal(parsedStub.output, null);
			assert.equal(parsedStub.sessionId, "sess-stage-1");
		} finally {
			rawDb.close();
		}

		const chunkQueries: string[] = [];
		const baseDb = await openNodeSqliteDatabase(path);
		closers.push(() => baseDb.close());
		const originalGet = baseDb.get.bind(baseDb);
		vi.spyOn(baseDb, "get").mockImplementation((async (sql: string, ...params: unknown[]) => {
			if (sql.includes("wf_event_chunks")) chunkQueries.push(sql);
			return originalGet(sql, ...(params as never[]));
		}) as typeof baseDb.get);
		const coldJournal = await SqlRunJournal.open(baseDb);
		closers.push(() => coldJournal.close());
		const coldBackend = await JournalDurableBackend.open(coldJournal, { runs: [], ownsJournal: false });
		closers.push(() => coldBackend.close());
		setDurableBackend(coldBackend);

		const runtime = createExtensionRuntime({ definitions: [definition], store });
		const provider = createWorkflowResumeProvider({
			pi: {},
			overlay: { open: () => undefined, toggle: () => undefined, close: () => undefined },
			runtimeForContext: () => runtime,
			ensureWorkflowResourcesLoaded: () => undefined,
			context: () => ({ hasUI: true, cwd: process.cwd(), ui: { notify: () => undefined } }),
		});

		const rows = await provider.listResumeEntries();
		const listed = rows.find((entry) => entry.id === runId);
		assert.ok(listed);
		assert.match(listed.detail ?? "", /paused · stage 1\/1 implement · .+ · 2m · \$0\.25/);
		assert.deepEqual(chunkQueries, [], "cold overview listing must not read wf_event_chunks");

		const overview = await coldBackend.readRunOverviewCheckpoints(runId);
		const stageOverview = overview.find((cp) => cp.kind === "stage");
		assert.ok(stageOverview && stageOverview.kind === "stage");
		assert.equal(stageOverview.output, null);

		await coldBackend.hydrateWorkflow(runId);
		const hydrated = coldBackend
			.listCheckpoints(runId)
			.find((cp): cp is DurableStageCheckpoint => cp.kind === "stage" && cp.checkpointId === "stage:implement");
		assert.ok(hydrated);
		assert.equal(hydrated.output, largeOutput);
		assert.equal(hydrated.result, largeResult);
		assert.ok(chunkQueries.length > 0, "full workflow hydration reads wf_event_chunks");

		const snapshotMeta = [
			{
				id: "snap-1",
				root: "/repo",
				worktree: "/repo",
				head: "0123456789abcdef0123456789abcdef01234567",
				branch: "feat/ship",
				createdAt: now,
				chain: [{ tree: "fedcba9876543210fedcba9876543210fedcba98", patch: "patch-hash-1" }],
			},
		];
		const withSnapshots: DurableStageCheckpoint = {
			workflowId: runId,
			kind: "stage",
			checkpointId: "stage:snap",
			replayKey: "stage:snap",
			name: "snap",
			output: largeOutput,
			completedAt: now,
			worktreeSnapshots: snapshotMeta as unknown as NonNullable<DurableStageCheckpoint["worktreeSnapshots"]>,
		};
		const storedSnap = storedEventPayload(
			RUN_EVENT_TYPES.checkpointRecorded,
			JSON.stringify(withSnapshots),
			withSnapshots,
		);
		assert.ok(storedSnap.chunks.length > 0);
		assert.deepEqual(
			(JSON.parse(storedSnap.payload) as { worktreeSnapshots?: unknown }).worktreeSnapshots,
			snapshotMeta,
		);
	});

	test("forwards overview mode through ShardedRunJournal, strips legacy inline stage outputs in SQLite, and guards Postgres jsonb casts inside CASE", async () => {
		const shardRoot = makeTempDirectory("cold-overview-sharded-");
		dirs.push(shardRoot);
		const runId = "b2c3d4e5-1111-4222-8333-444444444444";
		const now = Date.now();
		const inlineLargeOutput = `LEGACY_INLINE_OUTPUT_${"z".repeat(16_384)}`;

		const shardedWriter = await ShardedRunJournal.open({ directory: shardRoot, openShard: openSqlRunJournal });
		closers.push(() => shardedWriter.close());
		const writerBackend = await JournalDurableBackend.open(shardedWriter, { ownsJournal: false });
		closers.push(() => writerBackend.close());
		await writerBackend.commitWorkflowRegistration({
			workflowId: runId,
			name: definition.name,
			inputs: {},
			createdAt: now - 60_000,
			updatedAt: now - 30_000,
			status: "running",
			completedCheckpoints: 0,
			pendingPrompts: 0,
			resumable: true,
			invocationCwd: process.cwd(),
		});
		await writerBackend.commitCheckpoint({
			workflowId: runId,
			kind: "stage",
			checkpointId: "stage:plan",
			replayKey: "stage:plan",
			name: "plan",
			output: inlineLargeOutput,
			startedAt: now - 60_000,
			endedAt: now - 30_000,
			durationMs: 30_000,
			completedAt: now - 30_000,
			topology: {
				version: DURABLE_STAGE_TOPOLOGY_VERSION,
				stageId: "plan",
				parentIds: [],
				order: 1,
				sourceOrder: 1,
				status: "completed",
			},
		});
		await writerBackend.commitWorkflowStatus(runId, "paused", 0, true);
		const shardPath = shardedWriter.shardOf(runId)!.path;
		await writerBackend.close();
		await shardedWriter.close();

		const rawShard = new DatabaseSync(shardPath);
		try {
			const legacyPayload = JSON.stringify({
				kind: "stage",
				workflowId: runId,
				checkpointId: "stage:legacy",
				replayKey: "stage:legacy",
				name: "legacy",
				output: inlineLargeOutput,
				result: inlineLargeOutput,
				startedAt: now - 25_000,
				endedAt: now - 10_000,
				durationMs: 15_000,
				completedAt: now - 10_000,
				topology: {
					version: DURABLE_STAGE_TOPOLOGY_VERSION,
					stageId: "legacy",
					parentIds: ["plan"],
					order: 2,
					sourceOrder: 2,
					status: "completed",
				},
			});
			rawShard
				.prepare(
					"INSERT INTO wf_events(run_id, seq, epoch, key, type, payload, at, chunks) VALUES (?, 99, 1, ?, 'CheckpointRecorded', ?, ?, 0)",
				)
				.run(runId, JSON.stringify(["CheckpointRecorded", "stage", "stage:legacy"]), legacyPayload, now - 10_000);
			const legacyChunkedStageFull = JSON.stringify({
				kind: "stage",
				workflowId: runId,
				checkpointId: "stage:legacy-chunked",
				replayKey: "stage:legacy-chunked",
				name: "legacy-chunked",
				output: "chunked-stage-output",
				startedAt: now - 9_000,
				endedAt: now - 6_000,
				durationMs: 3_000,
				completedAt: now - 6_000,
				topology: {
					version: DURABLE_STAGE_TOPOLOGY_VERSION,
					stageId: "legacy-chunked",
					parentIds: ["legacy"],
					order: 3,
					sourceOrder: 3,
					status: "completed",
				},
			});
			rawShard
				.prepare(
					"INSERT INTO wf_events(run_id, seq, epoch, key, type, payload, at, chunks) VALUES (?, 100, 1, ?, 'CheckpointRecorded', ?, ?, 1)",
				)
				.run(
					runId,
					JSON.stringify(["CheckpointRecorded", "stage", "stage:legacy-chunked"]),
					JSON.stringify({
						kind: "stage",
						workflowId: runId,
						checkpointId: "stage:legacy-chunked",
						name: "legacy-chunked",
						replayKey: "stage:legacy-chunked",
						completedAt: now - 6_000,
					}),
					now - 6_000,
				);
			rawShard
				.prepare("INSERT INTO wf_event_chunks(run_id, seq, idx, data) VALUES (?, 100, 0, ?)")
				.run(runId, Buffer.from(legacyChunkedStageFull, "utf8"));
			const usagePayload = JSON.stringify({
				kind: "tool",
				workflowId: runId,
				checkpointId: "run-usage:chunked",
				name: RUN_USAGE_CHECKPOINT_NAME,
				argsHash: RUN_USAGE_CHECKPOINT_NAME,
				output: {
					accounting: {
						tokens: 1_200,
						cost: 3.5,
						baseline: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
						perCounter: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				},
				completedAt: now - 5_000,
			});
			rawShard
				.prepare(
					"INSERT INTO wf_events(run_id, seq, epoch, key, type, payload, at, chunks) VALUES (?, 101, 1, ?, 'CheckpointRecorded', ?, ?, 1)",
				)
				.run(
					runId,
					JSON.stringify(["CheckpointRecorded", "tool", "run-usage:chunked"]),
					JSON.stringify({
						kind: "tool",
						workflowId: runId,
						checkpointId: "run-usage:chunked",
						name: RUN_USAGE_CHECKPOINT_NAME,
						completedAt: now - 5_000,
					}),
					now - 5_000,
				);
			rawShard
				.prepare("INSERT INTO wf_event_chunks(run_id, seq, idx, data) VALUES (?, 101, 0, ?)")
				.run(runId, Buffer.from(usagePayload, "utf8"));
			rawShard
				.prepare(
					"INSERT INTO wf_events(run_id, seq, epoch, key, type, payload, at, chunks) VALUES (?, 102, 1, NULL, 'StatusChanged', (SELECT payload FROM wf_events WHERE run_id = ? AND type = 'StatusChanged' ORDER BY seq DESC LIMIT 1), ?, 0)",
				)
				.run(runId, runId, now - 5_000);
		} finally {
			rawShard.close();
		}

		const parsedStrings: string[] = [];
		const originalParse = JSON.parse;
		vi.spyOn(JSON, "parse").mockImplementation(((
			text: string,
			reviver?: (this: unknown, key: string, value: unknown) => unknown,
		) => {
			if (typeof text === "string" && text.includes("LEGACY_INLINE_OUTPUT_")) parsedStrings.push(text);
			return originalParse(text, reviver);
		}) as typeof JSON.parse);

		const coldSharded = await ShardedRunJournal.open({ directory: shardRoot, openShard: openSqlRunJournal });
		closers.push(() => coldSharded.close());
		const coldBackend = await JournalDurableBackend.open(coldSharded, { runs: [], ownsJournal: false });
		closers.push(() => coldBackend.close());
		await coldBackend.prepareWorkflowCatalog();

		const overviews = await coldBackend.readRunOverviewCheckpoints(runId);
		const stageOverviews = overviews.filter((cp): cp is DurableStageCheckpoint => cp.kind === "stage");
		assert.equal(stageOverviews.length, 3);
		const legacyChunkedOverview = stageOverviews.find((cp) => cp.checkpointId === "stage:legacy-chunked");
		assert.ok(legacyChunkedOverview);
		assert.equal(legacyChunkedOverview.output, null);
		assert.equal(legacyChunkedOverview.topology?.stageId, "legacy-chunked");
		const usageCheckpoint = overviews.find((cp) => cp.kind === "tool" && cp.checkpointId === "run-usage:chunked");
		assert.ok(usageCheckpoint && usageCheckpoint.kind === "tool");
		assert.equal((usageCheckpoint.output as { accounting?: { cost?: number } })?.accounting?.cost, 3.5);
		assert.deepEqual(
			parsedStrings,
			[],
			"cold overview read through ShardedRunJournal must neither read chunks nor parse legacy inline stage outputs",
		);
		for (const cp of overviews) {
			if (cp.kind === "stage") assert.equal(cp.output, null);
		}

		const executedSql: string[] = [];
		const pgDb = await openNodeSqliteDatabase(":memory:");
		closers.push(() => pgDb.close());
		const pgJournal = await SqlRunJournal.open(pgDb);
		closers.push(() => pgJournal.close());
		Object.defineProperty(pgJournal, "dialect", { value: postgresDialect });
		vi.spyOn(pgDb, "all").mockImplementation(async (sql: string) => {
			executedSql.push(sql);
			return [];
		});
		vi.spyOn(pgDb, "get").mockImplementation(async () => ({ meta_version: 2 }));
		await Array.fromAsync(SqlRunJournal.readKeyRange(pgJournal, runId, "a", "z", { overview: true }));
		assert.equal(executedSql.length, 1);
		assert.match(
			executedSql[0]!,
			/pg_input_is_valid\(payload, 'jsonb'\) THEN CASE WHEN \(\(payload\)::jsonb ->> 'kind'\) = 'stage'/,
		);
		assert.doesNotMatch(executedSql[0]!, /json_remove\(/);
	});
});
