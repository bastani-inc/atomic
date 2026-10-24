import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import type {
	SqliteDatabase,
	SqliteExecutor,
	SqliteRow,
	SqliteValue,
} from "../../packages/coding-agent/src/core/storage/database.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { releaseDurableBackendsHeldBy } from "../../packages/workflows/src/durable/backend-process-owner.js";
import { initializeDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { prepareTargetedDurableResumable } from "../../packages/workflows/src/durable/resume-runtime.js";
import type { DurableWorkflowStatus, ResumableWorkflowEntry } from "../../packages/workflows/src/durable/types.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { testRunId } from "../helpers/run-id.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/** Enough history that folding it at open is distinguishable from reading one snapshot per run. */
const HISTORICAL_RUNS = 24;
const CHECKPOINTS_PER_RUN = 12;
/** Events of the session's interrupted run: its start and its checkpoints. */
const SESSION_RUN_EVENTS = CHECKPOINTS_PER_RUN + 1;
const HISTORICAL_STATUSES: readonly DurableWorkflowStatus[] = ["completed", "failed", "paused", "cancelled"];
const SESSION_RUN = testRunId("lazy-open-session-run");
const COMPLETED_RUN = testRunId("lazy-open-completed-run");

const completedFlow = workflow({
	name: "lazy-open-completed",
	description: "",
	inputs: {},
	outputs: {},
	async run(ctx) {
		await ctx.tool("effect", {}, async () => "saved");
		await ctx.stage("finish").prompt("finish");
		return {};
	},
});

/** Counts journal event rows the database hands to JavaScript: each one carries an event `payload`. */
function countPayloadRows(database: SqliteDatabase): { readonly database: SqliteDatabase; rows: number } {
	const counter = { database, rows: 0 };
	const observe = (executor: SqliteExecutor): SqliteExecutor => ({
		exec: (sql: string) => executor.exec(sql),
		run: (sql: string, ...params: readonly SqliteValue[]) => executor.run(sql, ...params),
		async get<T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]): Promise<T | undefined> {
			const row = await executor.get<T>(sql, ...params);
			if (row !== undefined && "payload" in row) counter.rows++;
			return row;
		},
		async all<T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]): Promise<T[]> {
			const rows = await executor.all<T>(sql, ...params);
			counter.rows += rows.filter((row) => "payload" in row).length;
			return rows;
		},
	});
	counter.database = {
		...observe(database),
		descriptor: database.descriptor,
		transaction: (callback) => database.transaction((transaction) => callback(observe(transaction))),
		close: () => database.close(),
	};
	return counter;
}

async function seedRun(backend: JournalDurableBackend, workflowId: string, status: DurableWorkflowStatus) {
	await backend.commitWorkflowRegistration({
		workflowId,
		name: "history",
		inputs: { index: workflowId },
		createdAt: 1,
		status: "running",
		invocationCwd: "/project",
	});
	for (let index = 0; index < CHECKPOINTS_PER_RUN; index++)
		await backend.commitCheckpoint({
			kind: "tool",
			workflowId,
			checkpointId: `tool-${index}`,
			name: `tool-${index}`,
			argsHash: `tool-${index}`,
			output: `output ${index} of ${workflowId}`,
			completedAt: 10 + index,
		});
	if (status !== "running") await backend.commitWorkflowStatus(workflowId, status);
	await backend.releaseWorkflow(workflowId);
}

function byId(entries: readonly ResumableWorkflowEntry[]): readonly ResumableWorkflowEntry[] {
	return [...entries].sort((left, right) => left.workflowId.localeCompare(right.workflowId));
}

describe("opening a large workflow journal (#3892)", () => {
	let directory: string;
	let path: string;
	const historicalRuns = Array.from({ length: HISTORICAL_RUNS }, (_, index) => testRunId(`lazy-open-${index}`));
	const allRuns = [...historicalRuns, COMPLETED_RUN, SESSION_RUN];
	const opened: { close(): Promise<void> }[] = [];

	async function observedJournal() {
		const counter = countPayloadRows(await openNodeSqliteDatabase(path));
		const journal = await SqlRunJournal.open(counter.database);
		opened.push({ close: () => journal.close().then(() => counter.database.close()) });
		return { journal, counter };
	}

	async function fullyFolded(): Promise<JournalDurableBackend> {
		const backend = await JournalDurableBackend.open(await openSqlRunJournal(path), { runs: allRuns });
		opened.push(backend);
		return backend;
	}

	beforeEach(async () => {
		directory = makeTempDirectory("journal-lazy-open-");
		path = join(directory, "journal.sqlite");
		const writer = await JournalDurableBackend.open(await openSqlRunJournal(path));
		for (const [index, workflowId] of historicalRuns.entries())
			await seedRun(writer, workflowId, HISTORICAL_STATUSES[index % HISTORICAL_STATUSES.length]!);
		const completed = await run(
			completedFlow,
			{},
			{
				runId: COMPLETED_RUN,
				cwd: directory,
				store: createStore(),
				durableBackend: writer,
				adapters: { prompt: { prompt: async () => "finished" } },
			},
		);
		assert.equal(completed.status, "completed");
		// The session being reopened was interrupted while running: its lease is free and it can be recovered.
		await seedRun(writer, SESSION_RUN, "running");
		await writer.close();
	});

	afterEach(async () => {
		for (const handle of opened.splice(0).reverse()) await handle.close();
		removeTempDirectory(directory);
	});

	test("opening the selected journal reads one snapshot per run, not every run's history (#3892)", async () => {
		const { journal, counter } = await observedJournal();
		const holder = {};
		opened.push({ close: () => releaseDurableBackendsHeldBy(holder) });
		const backend = await initializeDurableBackend({ journal, holder });
		assert.ok(counter.rows <= allRuns.length, `open read ${counter.rows} event rows for ${allRuns.length} runs`);

		// The resume catalog and every run's handle match a backend that folded every event.
		const full = await fullyFolded();
		const catalog = await backend.prepareWorkflowCatalog();
		const expected = await full.prepareWorkflowCatalog();
		assert.deepEqual(byId(catalog.resumable), byId(expected.resumable));
		assert.deepEqual(byId(catalog.completed), byId(expected.completed));
		assert.deepEqual([...(catalog.inspectableIds ?? [])].sort(), [...(expected.inspectableIds ?? [])].sort());
		for (const workflowId of allRuns) assert.deepEqual(backend.getWorkflow(workflowId), full.getWorkflow(workflowId));
		assert.ok(counter.rows <= allRuns.length, `the catalog read ${counter.rows} event rows`);

		// A run the session needs is hydrated on demand, reading only that run's history.
		const before = counter.rows;
		const resumable = await prepareTargetedDurableResumable(backend, [SESSION_RUN]);
		assert.deepEqual(
			resumable.map((entry) => entry.workflowId),
			[SESSION_RUN],
		);
		assert.deepEqual(backend.listCheckpoints(SESSION_RUN), full.listCheckpoints(SESSION_RUN));
		assert.ok(counter.rows - before <= SESSION_RUN_EVENTS, `hydrating one run read ${counter.rows - before} rows`);
	});

	test("an interactive session refreshing its own interrupted run reads only that run's history (#3892)", async () => {
		const { journal, counter } = await observedJournal();
		const store = createStore();
		opened.push({ close: () => releaseDurableBackendsHeldBy(store) });
		const runtime = createExtensionRuntime({ journal, store, registry: createRegistry([]) });

		const resumable = await runtime.prepareDurableResumableForIds?.([SESSION_RUN]);
		assert.deepEqual(
			resumable?.map((entry) => entry.workflowId),
			[SESSION_RUN],
		);
		const full = await fullyFolded();
		assert.deepEqual(runtime.durableBackend().listCheckpoints(SESSION_RUN), full.listCheckpoints(SESSION_RUN));
		assert.ok(
			counter.rows <= allRuns.length + SESSION_RUN_EVENTS,
			`startup read ${counter.rows} event rows for ${allRuns.length} runs`,
		);

		// The resume picker lists every run from its latest snapshot.
		const catalog = await runtime.prepareDurableCatalog?.();
		const expected = await full.prepareWorkflowCatalog();
		assert.deepEqual(byId(catalog?.resumable ?? []), byId(expected.resumable));
		assert.deepEqual(byId(catalog?.completed ?? []), byId(expected.completed));
		assert.ok(
			counter.rows <= allRuns.length + SESSION_RUN_EVENTS,
			`the resume catalog read ${counter.rows} event rows`,
		);
	});

	test("a completed run listed from its snapshot is hydrated when it is opened (#3892)", async () => {
		const { journal } = await observedJournal();
		const store = createStore();
		opened.push({ close: () => releaseDurableBackendsHeldBy(store) });
		const runtime = createExtensionRuntime({ journal, store, registry: createRegistry([]), cwd: directory });

		const catalog = await runtime.prepareDurableCatalog?.();
		assert.ok(catalog?.completed.some((entry) => entry.workflowId === COMPLETED_RUN));
		const result = await runtime.openCompletedDurableWorkflow?.(COMPLETED_RUN, catalog?.completed);
		assert.equal(result?.ok, true, result?.ok === false ? result.message : undefined);
		const restored = store.runs().find((candidate) => candidate.id === COMPLETED_RUN);
		assert.deepEqual(
			restored?.stages.map((stage) => stage.name),
			["finish"],
		);
		assert.deepEqual(
			restored?.toolNodes.map((tool) => tool.name),
			["effect"],
		);
	});
});
