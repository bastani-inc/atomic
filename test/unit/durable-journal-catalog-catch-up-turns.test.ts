/**
 * The first workflow-catalog read in a process brings every run of the journal up to date. With the local SQLite store
 * each statement runs synchronously and resolves in a microtask, so before #5480 that whole catch-up ran in one turn of
 * the event loop: seconds on a large journal, with no timer, abort or budget able to run until it ended. These tests
 * hold the catch-up to bounded turns, and hold what it builds to what a one-shot read of the same journal builds.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { setImmediate } from "node:timers";
import { afterEach, beforeEach, test } from "vitest";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import type { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import type {
	JournalEntry,
	RunHeader,
	RunJournalSeedEvent,
} from "../../packages/workflows/src/durable/journal/types.js";
import { createDurableResumeRuntime } from "../../packages/workflows/src/extension/runtime-durable-resume.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { PendingStageMessage } from "../../packages/workflows/src/shared/store-types.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { assertLag, measureLag } from "../helpers/event-loop-lag.js";
import { testRunId } from "../helpers/run-id.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/** Runs whose latest snapshot carries a pending-stage change, so catching them up reads and folds their whole history. */
const LARGE_HISTORY_RUNS = 48;
/** Checkpoints in each of those runs: the large journal folds about 48 × 2,500 = 120,000 events. */
const LARGE_HISTORY_CHECKPOINTS = 2_500;
/** Runs whose latest snapshot is complete on its own, so catching them up reads only that snapshot. */
const SNAPSHOT_RUNS = 24;
const SNAPSHOT_CHECKPOINTS = 20;
/**
 * Turns of the event loop that other work must get while the large journal catches up. Bounded turns give it hundreds;
 * a catch-up that never yields gives it none until it has finished.
 */
const MIN_TURNS_DURING_LARGE_CATCH_UP = 20;
/** Seeding 120,000 events and folding them twice (once one-shot) is structural cost, not a slow catch-up. */
const LARGE_JOURNAL_TEST_TIMEOUT_MS = 120_000;
/** Checkpoints in one long run: folding them in one turn would hold it for tens of milliseconds. */
const LONG_HISTORY_CHECKPOINTS = 20_000;
/** Writing a run of 20,000 checkpoints through a backend and folding it three times is structural cost. */
const LONG_HISTORY_TEST_TIMEOUT_MS = 120_000;
/** Runs, and checkpoints per run, of the journal the equivalence tests read; each run's read spans several turns. */
const HISTORY_RUNS = 6;
const HISTORY_CHECKPOINTS = 1_500;

const TEMPLATE_RUN_ID = testRunId("catalog-catch-up-template");

function pendingMessage(runId: string, index: number): PendingStageMessage {
	const id = `message-${index}`;
	return {
		id,
		runId,
		stageKey: `workflow:${runId}/worker-${index}/**`,
		targetPath: `workflow:${runId}/worker-${index}/**`,
		from: { id: "planner", name: "planner" },
		message: { id, timestamp: 1, content: { text: id } },
		queuedAt: "2026-11-18T00:00:00.000Z",
		admissionOrder: index,
		status: "queued",
		sticky: true,
		deliveries: [],
		deliveryCount: 0,
	};
}

interface RunTemplate {
	readonly header: RunHeader;
	readonly events: readonly RunJournalSeedEvent[];
}

/**
 * A run's journal as the backend writes it. With pending-stage messages, the run's later snapshots write those messages
 * as a change to the earlier ones, so a catch-up must read the run's whole history to fold its latest snapshot.
 */
async function writeTemplate(kind: "history" | "snapshot", checkpoints: number): Promise<RunTemplate> {
	const journal = new MemoryRunJournal();
	const writer = await JournalDurableBackend.open(journal);
	try {
		await writer.commitWorkflowRegistration({
			workflowId: TEMPLATE_RUN_ID,
			name: `catch-up-${kind}`,
			inputs: { kind },
			createdAt: 1,
			status: "running",
		});
		if (kind === "history")
			await writer.persistPendingStageMessages(TEMPLATE_RUN_ID, [pendingMessage(TEMPLATE_RUN_ID, 1)]);
		for (let index = 0; index < checkpoints; index++)
			await checkpoint(writer, TEMPLATE_RUN_ID, `step-${index}`, 1_000 + index);
		if (kind === "history") {
			await writer.persistPendingStageMessages(TEMPLATE_RUN_ID, [
				pendingMessage(TEMPLATE_RUN_ID, 1),
				pendingMessage(TEMPLATE_RUN_ID, 2),
			]);
			await writer.commitWorkflowStatus(TEMPLATE_RUN_ID, "completed");
		}
		const events: RunJournalSeedEvent[] = [];
		for await (const entry of journal.read(TEMPLATE_RUN_ID))
			events.push({ event: entry.event, ...(entry.key === undefined ? {} : { key: entry.key }) });
		const header = await journal.getRun(TEMPLATE_RUN_ID);
		assert.ok(header);
		return { header, events };
	} finally {
		await writer.close();
	}
}

/** Writes `template` as run `runId`, in one transaction, as a journal holds it after the run wrote it. */
async function seedRun(journal: SqlRunJournal, template: RunTemplate, runId: string): Promise<void> {
	const text = JSON.stringify(template).replaceAll(TEMPLATE_RUN_ID, runId);
	const { header, events } = JSON.parse(text) as RunTemplate;
	assert.equal(await journal.createRunWithEvents(header, events), "created");
}

async function checkpoint(
	backend: JournalDurableBackend,
	workflowId: string,
	checkpointId: string,
	completedAt = Date.now(),
): Promise<void> {
	await backend.commitCheckpoint({
		kind: "tool",
		workflowId,
		checkpointId,
		name: checkpointId,
		argsHash: checkpointId,
		output: `output of ${checkpointId}`,
		completedAt,
	});
}

interface ObservedRead {
	readonly runId: string;
	readonly fromSeq: number;
	events: number;
	done: boolean;
}

/**
 * Records each run read. `pauseAfter(runId)` hands back a promise to wait for before the read of `runId` goes on with
 * its next event, so a test can let another writer commit while that run is being read.
 */
function observeReads(
	journal: SqlRunJournal,
	pauseAfter: (read: ObservedRead) => Promise<void> | undefined = () => undefined,
): ObservedRead[] {
	const read = journal.read.bind(journal);
	const reads: ObservedRead[] = [];
	journal.read = async function* (runId: string, fromSeq?: number): AsyncIterable<JournalEntry> {
		const observed: ObservedRead = { runId, fromSeq: fromSeq ?? 1, events: 0, done: false };
		reads.push(observed);
		for await (const entry of read(runId, fromSeq)) {
			observed.events++;
			yield entry;
			await pauseAfter(observed);
		}
		observed.done = true;
	};
	return reads;
}

/** Counts every call of the journal's change token: one per catalog catch-up that ran. */
function countChangeTokens(journal: SqlRunJournal): { count: number } {
	const changeToken = journal.changeToken.bind(journal);
	const counter = { count: 0 };
	journal.changeToken = () => {
		counter.count++;
		return changeToken();
	};
	return counter;
}

/** Calls `onTurn` on every turn of the event loop until `stop()`, counting the turns and the longest wait for one. */
function everyTurn(onTurn: () => void = () => {}): { turns: number; longestWaitMs: number; stop(): void } {
	let running = true;
	let last = performance.now();
	const ticker = {
		turns: 0,
		longestWaitMs: 0,
		stop() {
			running = false;
			ticker.longestWaitMs = Math.max(ticker.longestWaitMs, Math.round(performance.now() - last));
		},
	};
	const tick = () => {
		if (!running) return;
		const now = performance.now();
		ticker.longestWaitMs = Math.max(ticker.longestWaitMs, Math.round(now - last));
		last = now;
		ticker.turns++;
		onTurn();
		setImmediate(tick);
	};
	setImmediate(tick);
	return ticker;
}

let directory: string;
let path: string;
let historyTemplate: RunTemplate;
let snapshotTemplate: RunTemplate;
const backends: JournalDurableBackend[] = [];

async function openBackend(journal?: SqlRunJournal, runs?: readonly string[]): Promise<JournalDurableBackend> {
	const backend = await JournalDurableBackend.open(journal ?? (await openSqlRunJournal(path)), {
		...(runs === undefined ? {} : { runs }),
	});
	backends.push(backend);
	return backend;
}

/** Seeds the journal at `path`; returns the ids of the runs that need their history and of the others. */
async function seedJournal(
	historyRuns: number,
	historyCheckpoints: number,
): Promise<{ readonly history: readonly string[]; readonly snapshot: readonly string[] }> {
	historyTemplate = await writeTemplate("history", historyCheckpoints);
	snapshotTemplate = await writeTemplate("snapshot", SNAPSHOT_CHECKPOINTS);
	const journal = await openSqlRunJournal(path);
	const history = Array.from({ length: historyRuns }, (_, index) => testRunId(`catch-up-history-${index}`));
	const snapshot = Array.from({ length: SNAPSHOT_RUNS }, (_, index) => testRunId(`catch-up-snapshot-${index}`));
	try {
		for (const runId of history) await seedRun(journal, historyTemplate, runId);
		for (const runId of snapshot) await seedRun(journal, snapshotTemplate, runId);
	} finally {
		await journal.close();
	}
	return { history, snapshot };
}

function byWorkflowId<Entry extends { readonly workflowId: string }>(entries: readonly Entry[]): Entry[] {
	return [...entries].sort((left, right) => (left.workflowId < right.workflowId ? -1 : 1));
}

/** Holds `reader`'s catalog and every run's handle to what a backend that reads the whole journal at once builds. */
async function assertMatchesOneShotRead(reader: JournalDurableBackend, runIds: readonly string[]): Promise<void> {
	const oneShot = await openBackend();
	const [caughtUp, read] = [await reader.prepareWorkflowCatalog(), await oneShot.prepareWorkflowCatalog()];
	assert.deepEqual(byWorkflowId(caughtUp.resumable), byWorkflowId(read.resumable));
	assert.deepEqual(byWorkflowId(caughtUp.completed), byWorkflowId(read.completed));
	assert.deepEqual(byWorkflowId(caughtUp.completedAll ?? []), byWorkflowId(read.completedAll ?? []));
	for (const runId of runIds) assert.deepEqual(reader.getWorkflow(runId), oneShot.getWorkflow(runId), runId);
}

beforeEach(() => {
	directory = makeTempDirectory("journal-catalog-catch-up-");
	path = join(directory, "journal.sqlite");
});

afterEach(async () => {
	for (const backend of backends.splice(0).reverse()) await backend.close();
	removeTempDirectory(directory);
});

test(
	"catching up a large journal's catalog gives the event loop a turn at bounded intervals (#5480)",
	async () => {
		const { history, snapshot } = await seedJournal(LARGE_HISTORY_RUNS, LARGE_HISTORY_CHECKPOINTS);
		const reader = await openBackend(undefined, []);
		const lag = measureLag();
		const ticker = everyTurn();
		const started = performance.now();
		try {
			await reader.hydrateResumableWorkflows();
		} finally {
			ticker.stop();
		}
		const elapsedMs = Math.round(performance.now() - started);
		assert.ok(
			ticker.turns >= MIN_TURNS_DURING_LARGE_CATCH_UP,
			`other work got ${ticker.turns} turns while the catalog caught up over ${elapsedMs} ms, waiting up to ${ticker.longestWaitMs} ms for one`,
		);
		assertLag("catalog catch-up", lag());
		assert.equal(reader.listCompletedWorkflows().length, history.length);
		assert.equal(reader.listResumableWorkflows().length, snapshot.length);
	},
	LARGE_JOURNAL_TEST_TIMEOUT_MS,
);

test("an event appended while the catalog catches up is folded once, as a one-shot read folds it (#5480)", async () => {
	const { history, snapshot } = await seedJournal(HISTORY_RUNS, HISTORY_CHECKPOINTS);
	const writer = await openBackend(undefined, []);
	// The read of the second large run waits for the writer's commit to that run, made while the catalog catches up.
	const target = history[1]!;
	let appendedToTarget: Promise<void> | undefined;
	const journal = await openSqlRunJournal(path);
	const reads = observeReads(journal, (read) => (read.runId === target ? appendedToTarget : undefined));
	const reader = await openBackend(journal, []);
	const appends: Promise<void>[] = [];
	let appendedMidRead = false;
	const ticker = everyTurn(() => {
		const current = reads.at(-1);
		if (appendedToTarget === undefined && current?.runId === target && current.events > 0 && !current.done) {
			appendedMidRead = true;
			appendedToTarget = checkpoint(writer, target, "appended-mid-read");
			// One run already read, and one not read yet.
			appends.push(appendedToTarget, checkpoint(writer, history[0]!, "appended-after-read"));
			appends.push(checkpoint(writer, history.at(-1)!, "appended-before-read"));
			appends.push(writer.commitWorkflowStatus(snapshot[0]!, "failed"));
		}
	});
	try {
		await reader.hydrateResumableWorkflows();
	} finally {
		ticker.stop();
	}
	assert.ok(appendedMidRead, "the writer committed while a run's history was being read");
	await Promise.all(appends);
	// A second catch-up folds what the first one could not have seen, and nothing it already folded.
	await reader.hydrateResumableWorkflows();
	await assertMatchesOneShotRead(reader, [...history, ...snapshot]);
	for (const runId of [target, history[0]!, history.at(-1)!]) {
		const ids = reader.listCheckpoints(runId).map((recorded) => recorded.checkpointId);
		assert.equal(new Set(ids).size, ids.length, `${runId} folded a checkpoint twice`);
		assert.equal(ids.length, HISTORY_CHECKPOINTS + 1, runId);
	}
});

test("callers that ask for the catalog before its catch-up starts share that one catch-up (#5480)", async () => {
	const { history, snapshot } = await seedJournal(HISTORY_RUNS, HISTORY_CHECKPOINTS);
	const journal = await openSqlRunJournal(path);
	const tokens = countChangeTokens(journal);
	const reads = observeReads(journal);
	const reader = await openBackend(journal, []);
	await Promise.all([
		reader.hydrateResumableWorkflows(),
		reader.prepareWorkflowCatalog(),
		reader.hydrateResumableWorkflows(),
	]);
	assert.equal(tokens.count, 1, "one catch-up served all three callers");
	assert.deepEqual(
		reads.map(({ runId }) => runId).sort(),
		[...history].sort(),
		"each run that needs its history was read once",
	);
	await assertMatchesOneShotRead(reader, [...history, ...snapshot]);
});

test("a caller that asks after a catch-up started gets the events committed before it asked (#5480)", async () => {
	const { history, snapshot } = await seedJournal(HISTORY_RUNS, HISTORY_CHECKPOINTS);
	const writer = await openBackend(undefined, []);
	const journal = await openSqlRunJournal(path);
	const reads = observeReads(journal);
	const reader = await openBackend(journal, []);
	let late: Promise<void> | undefined;
	const ticker = everyTurn(() => {
		// Once the first run is caught up, commit to it and only then ask for the catalog again.
		if (late === undefined && reads[0]?.done === true) {
			late = checkpoint(writer, history[0]!, "committed-before-asking").then(() =>
				reader.hydrateResumableWorkflows(),
			);
		}
	});
	try {
		await reader.hydrateResumableWorkflows();
		assert.ok(late, "the late caller asked while the first catch-up was running");
		await late;
	} finally {
		ticker.stop();
	}
	assert.equal(reader.getWorkflow(history[0]!)?.completedCheckpoints, HISTORY_CHECKPOINTS + 1);
	await assertMatchesOneShotRead(reader, [...history, ...snapshot]);
});

test("aborting a catalog catch-up stops it between turns and a later catch-up finishes it (#5480)", async () => {
	const { history, snapshot } = await seedJournal(HISTORY_RUNS, HISTORY_CHECKPOINTS);
	const journal = await openSqlRunJournal(path);
	const reads = observeReads(journal);
	const reader = await openBackend(journal, []);
	const controller = new AbortController();
	let readsWhenAborted: number | undefined;
	const ticker = everyTurn(() => {
		if (readsWhenAborted === undefined && reads.some((read) => read.done)) {
			readsWhenAborted = reads.length;
			controller.abort(new Error("caller gave up"));
		}
	});
	try {
		await assert.rejects(reader.hydrateResumableWorkflows({ signal: controller.signal }), /caller gave up/);
	} finally {
		ticker.stop();
	}
	assert.ok(readsWhenAborted !== undefined && readsWhenAborted < history.length, "aborted before every run was read");
	// A run is finished when the catch-up folded it. A long history's staged fold runs over turns after its read ends,
	// so a run whose read ended may still be left as it was, and is caught up later.
	const finished = history.filter((runId) => reader.getWorkflow(runId) !== undefined);
	const readWhole = new Set(reads.filter((read) => read.done).map(({ runId }) => runId));
	// The catch-up stopped where it was: it read no run after the abort, and it left no run half folded.
	assert.ok(reads.length <= readsWhenAborted!);
	for (const runId of finished) {
		assert.ok(readWhole.has(runId), `${runId} was folded before its history was read`);
		assert.equal(reader.getWorkflow(runId)?.completedCheckpoints, HISTORY_CHECKPOINTS, runId);
	}
	reads.length = 0;
	await reader.hydrateResumableWorkflows();
	assert.deepEqual(
		reads.map(({ runId }) => runId).sort(),
		history.filter((runId) => !finished.includes(runId)).sort(),
		"the later catch-up read only the runs the aborted one had not finished",
	);
	await assertMatchesOneShotRead(reader, [...history, ...snapshot]);
});

test("aborting resume by a listed prefix stops reading and publishing unrelated runs (#5480, #5569)", async () => {
	const { history, snapshot } = await seedJournal(3, HISTORY_CHECKPOINTS);
	const journal = await openSqlRunJournal(path);
	const reader = await openBackend(journal, []);
	const runtime = createDurableResumeRuntime({
		store: createStore(),
		registry: createRegistry(),
		runtimeCwd: directory,
		baseRunOpts: () => ({}),
		ensureReady: async () => reader,
	});
	const target = snapshot[0]!;
	assert.deepEqual(
		(await runtime.prepareDurableResumableForIds!([target])).map((row) => row.workflowId),
		[target],
	);
	const published = () => history.filter((id) => reader.getWorkflow(id) !== undefined);
	assert.deepEqual(published(), []);

	const controller = new AbortController();
	const reason = new Error("cancel prefix resume");
	const reads = observeReads(journal, () => {
		controller.abort(reason);
		return undefined;
	});
	await assert.rejects(
		runtime.resumeDurableWorkflow(target.slice(0, 8), { signal: controller.signal }),
		(e) => e === reason,
	);

	// A caller can return before the abandoned scan stops. Sample its work when the next catalog read starts,
	// before that read can publish or read any history of its own.
	const changeToken = journal.changeToken.bind(journal);
	let afterAbort: { events: number; published: string[] } | undefined;
	journal.changeToken = () => {
		afterAbort = {
			events: reads.filter((r) => history.includes(r.runId)).reduce((n, r) => n + r.events, 0),
			published: published(),
		};
		return changeToken();
	};
	await reader.hydrateResumableWorkflows();
	assert.ok(afterAbort);
	assert.deepEqual(afterAbort.published, []);
	// The first event triggers the abort; at most one more may be in flight when the read observes it.
	assert.ok(afterAbort.events <= 2, `read ${afterAbort.events} unrelated events`);
});

test("one caller giving up does not stop the catch-up another caller is waiting for (#5480)", async () => {
	const { history, snapshot } = await seedJournal(HISTORY_RUNS, HISTORY_CHECKPOINTS);
	const journal = await openSqlRunJournal(path);
	const reads = observeReads(journal);
	const reader = await openBackend(journal, []);
	const controller = new AbortController();
	const ticker = everyTurn(() => {
		if (!controller.signal.aborted && reads.length > 0) controller.abort(new Error("caller gave up"));
	});
	try {
		const [abandoned, waited] = await Promise.allSettled([
			reader.hydrateResumableWorkflows({ signal: controller.signal }),
			reader.hydrateResumableWorkflows(),
		]);
		assert.equal(abandoned.status, "rejected");
		assert.equal(waited.status, "fulfilled");
	} finally {
		ticker.stop();
	}
	assert.deepEqual(reads.map(({ runId }) => runId).sort(), [...history].sort());
	await assertMatchesOneShotRead(reader, [...history, ...snapshot]);
});

test(
	"rebuilding a long history folds it over several turns, and readers see the run change in one step (#5480)",
	async () => {
		const { history } = await seedJournal(1, LONG_HISTORY_CHECKPOINTS);
		const runId = history[0]!;
		const journal = await openSqlRunJournal(path);
		const reads = observeReads(journal);
		const reader = await openBackend(journal, []);
		await reader.hydrateResumableWorkflows();
		const before = reader.getWorkflow(runId)?.completedCheckpoints;
		assert.equal(before, LONG_HISTORY_CHECKPOINTS);
		const writer = await openBackend(undefined, []);
		await checkpoint(writer, runId, "after-first-read");
		reads.length = 0;
		const seen = new Set<number | undefined>();
		let turnsAfterRead = 0;
		const ticker = everyTurn(() => {
			seen.add(reader.getWorkflow(runId)?.completedCheckpoints);
			if (reads[0]?.done === true) turnsAfterRead++;
		});
		try {
			await reader.hydrateWorkflow(runId);
		} finally {
			ticker.stop();
		}
		assert.ok(turnsAfterRead > 0, "the event loop turned while the read history was folded");
		assert.deepEqual(
			[...seen].filter((count) => count !== before && count !== LONG_HISTORY_CHECKPOINTS + 1),
			[],
			"readers saw the run only as it was before the rebuild and as it is after it",
		);
		assert.equal(reader.getWorkflow(runId)?.completedCheckpoints, LONG_HISTORY_CHECKPOINTS + 1);
		await assertMatchesOneShotRead(reader, [runId]);
		const oneShot = await openBackend(undefined, [runId]);
		assert.deepEqual(reader.listCheckpoints(runId), oneShot.listCheckpoints(runId));
	},
	LONG_HISTORY_TEST_TIMEOUT_MS,
);
