/**
 * Local-worker pool load gate (#3903, #3996), run by test/integration/workflow-pool-load-gate.test.ts.
 *
 * A root host drives a LocalWorkerPool with 150 concurrent protocol stub workers
 * (test/fixtures/pool-load-stub-worker.mjs). Every stub claims one pooled child
 * and, for a sustained window, produces the traffic of a busy agent stage:
 * heartbeats (renew, control, activity, usage), tool checkpoints, the root
 * pending-stage route of an Intercom-capable stage (served by an isolated broker),
 * and session appends with some entries over 100 KB, then only heartbeats. The gate asserts
 * that the root's main thread, which also handles input and rendering in the
 * interactive TUI, keeps its event-loop lag under fixed bounds while the workers
 * start, under sustained traffic, and under heartbeats alone, and that heartbeats
 * grow the journal with the number of workers rather than with elapsed time.
 *
 * With `watches: 1`, the root also holds a live view of one pooled stage (#3996) for the
 * whole traffic window while that stage streams session events, and the gate asserts that
 * only the watched stage sent any. With `watches: 0`, no stub sends one.
 *
 * The measured numbers are printed on every run, pass or fail. Under an agent
 * shell, add `--reporter=default`: vitest's agent reporter hides passing output.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { initTheme } from "@bastani/atomic";
import { TestSqliteDatabase } from "../../packages/coding-agent/test/helpers/sqlite.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createWorkflowObservation } from "../../packages/workflows/src/extension/workflow-observation.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import {
	installStoreWidget,
	installToolExecutionHooks,
} from "../../packages/workflows/src/tui/store-widget-installer.js";
import { WorkflowAttachPane } from "../../packages/workflows/src/tui/workflow-attach-pane.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import {
	acquirePooledStage,
	type PooledStageLease,
} from "../../packages/workflows/src/workers/pooled-stage-sources.js";
import { WORKER_HEARTBEAT_INTERVAL_MS } from "../../packages/workflows/src/workers/protocol.js";
import { IntercomBrokerFixture } from "./intercom-broker-fixture.js";
import { testRunId } from "./run-id.js";
import {
	fileExistsSync,
	makeDirectorySync,
	makeTempDirectory,
	readDirectorySync,
	readTextSync,
	removeTempDirectory,
	sleep,
	writeTextSync,
} from "./runtime.js";

/** Concurrent stub workers, one pooled child each. */
const WORKERS = 150;
/** Full traffic: heartbeats plus tool checkpoints and session appends. */
const SUSTAINED_TRAFFIC_MS = 20_000;
/** Heartbeats only, to measure what renewals alone add to the journal. */
const QUIET_HEARTBEAT_MS = 10_000;
/** Lets commits already in flight when traffic stops land before the quiet window. */
const QUIET_SETTLE_MS = 3_000;
/** Mean interval between one stub's session appends (jittered 0.5x to 1.5x). */
const APPEND_INTERVAL_MS = 2_000;
/** Mean interval between one stub's tool checkpoints (jittered 0.5x to 1.5x). */
const TOOL_INTERVAL_MS = 5_000;
/** Every LARGE_ENTRY_EVERY-th session append carries one entry of LARGE_ENTRY_BYTES. */
const LARGE_ENTRY_EVERY = 16;
const LARGE_ENTRY_BYTES = 128 * 1024;

/**
 * Main-thread lag bounds, asserted separately over worker startup (pool start until every
 * worker is active), the sustained traffic window, and the heartbeat-only window.
 */
const MAIN_THREAD_LAG_P99_BOUND_MS = 100;
const MAIN_THREAD_LAG_MAX_BOUND_MS = 250;
/** Event-loop delay sampling resolution; reported lag excludes this interval. */
const LAG_RESOLUTION_MS = 5;
/** Journal growth allowed per worker over the whole heartbeat-only window, independent of its length. */
const HEARTBEAT_GROWTH_ROWS_PER_WORKER = 1;
const HEARTBEAT_GROWTH_BYTES_PER_WORKER = 256;

/** Structural costs: an Intercom broker, 150 worker processes, then sustained windows and completion. */
const BROKER_STARTUP_TIMEOUT_MS = 60_000;
const WORKER_STARTUP_TIMEOUT_MS = 120_000;
const ACTIVATION_TIMEOUT_MS = 120_000;

/** The mounted attach pane renders a frame this often, as the TUI does while it animates. */
const PANE_FRAME_MS = 100;
const PANE_WIDTH = 200;
/** A watched stage's stream: a batch every STAGE_EVENT_BATCH_MS, as a real worker's stage watch sends. */
const STAGE_EVENT_BATCH_MS = 50;
const STAGE_EVENTS_PER_BATCH = 8;
/** The streamed partial message grows to about this size, then starts over. */
const STAGE_PARTIAL_BYTES = 4_096;

interface LagWindow {
	readonly durationMs: number;
	readonly samples: number;
	readonly p50Ms: number;
	readonly p99Ms: number;
	readonly maxMs: number;
}

function measureLag(): () => LagWindow {
	const histogram = monitorEventLoopDelay({ resolution: LAG_RESOLUTION_MS });
	const startedAt = performance.now();
	histogram.enable();
	return () => {
		histogram.disable();
		const lag = (nanoseconds: number) => Math.round(Math.max(0, nanoseconds / 1e6 - LAG_RESOLUTION_MS) * 10) / 10;
		return {
			durationMs: Math.round(performance.now() - startedAt),
			samples: histogram.count,
			p50Ms: lag(histogram.percentile(50)),
			p99Ms: lag(histogram.percentile(99)),
			maxMs: lag(histogram.max),
		};
	};
}

interface TableFootprint {
	readonly rows: number;
	readonly bytes: number;
}

/** Row count and stored value length of every journal table, read from a separate connection. */
function journalFootprint(path: string): Record<string, TableFootprint> {
	const database = new TestSqliteDatabase(path);
	try {
		database.run("PRAGMA query_only=ON");
		const tables: Record<string, TableFootprint> = {};
		const names = database
			.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
			.all()
			.map((row) => String(row.name));
		for (const name of names) {
			const columns = database
				.query(`PRAGMA table_info("${name}")`)
				.all()
				.map((column) => `COALESCE(LENGTH("${String(column.name)}"), 0)`);
			const row = database
				.query(`SELECT COUNT(*) AS count, COALESCE(SUM(${columns.join(" + ")}), 0) AS bytes FROM "${name}"`)
				.get();
			tables[name] = { rows: Number(row?.count ?? 0), bytes: Number(row?.bytes ?? 0) };
		}
		return tables;
	} finally {
		database.close();
	}
}

function footprintGrowth(before: Record<string, TableFootprint>, after: Record<string, TableFootprint>) {
	const byTable: Record<string, TableFootprint> = {};
	let rows = 0;
	let bytes = 0;
	for (const [name, end] of Object.entries(after)) {
		const start = before[name] ?? { rows: 0, bytes: 0 };
		const growth = { rows: end.rows - start.rows, bytes: end.bytes - start.bytes };
		rows += growth.rows;
		bytes += growth.bytes;
		if (growth.rows !== 0 || growth.bytes !== 0) byTable[name] = growth;
	}
	return { rows, bytes, byTable };
}

interface StubStats {
	readonly commits: number;
	readonly toolCheckpoints: number;
	readonly appends: number;
	readonly largeAppends: number;
	readonly appendedBytes: number;
	readonly renewals: number;
	readonly quietRenewals: number;
	readonly activities: number;
	readonly maxCommitMs: number;
	readonly routeMs: number;
	readonly stageEventBatches: number;
	readonly stageEvents: number;
}

/** An Intercom broker inside the test directory, so the root's pending-stage routes never reach a real one. */
async function startIsolatedBroker(directory: string): Promise<IntercomBrokerFixture> {
	const broker = new IntercomBrokerFixture(join(directory, "agent"));
	broker.overrideAgentDir();
	try {
		const { getJitiCliPath } = await import("../../packages/intercom/broker/spawn.js");
		const { getBrokerSocketPath } = await import("../../packages/intercom/broker/paths.js");
		const intercomPath = fileURLToPath(new URL("../../packages/intercom", import.meta.url));
		broker.trackBroker(
			spawn(process.execPath, [getJitiCliPath(intercomPath), join(intercomPath, "broker/broker.ts")], {
				env: process.env,
				stdio: "ignore",
			}),
		);
		const deadline = performance.now() + BROKER_STARTUP_TIMEOUT_MS;
		while (!fileExistsSync(getBrokerSocketPath())) {
			broker.assertRunning();
			if (performance.now() > deadline) throw new Error("Intercom broker did not start");
			await sleep(25);
		}
		return broker;
	} catch (error) {
		await broker.cleanup();
		throw error;
	}
}

/** Runs the gate; `watches` is the number of pooled stages the root watches during traffic. */
export async function runPoolLoadGate(watches: 0 | 1, options: { readonly pane?: boolean } = {}): Promise<void> {
	// With `pane`, the interactive attach pane stays mounted for the whole fan-out, rendering
	// the graph at the TUI's frame rate, and the watched stage is opened in its chat (#3996).
	if (options.pane === true) initTheme("dark", false);
	const directory = makeTempDirectory("pool-load-gate-");
	const broker = await startIsolatedBroker(directory);
	const path = join(directory, "journal.sqlite");
	const phaseFile = join(directory, "load-phase");
	const activeDirectory = join(directory, "active");
	const statsDirectory = join(directory, "stats");
	const failureLog = join(directory, "stub-failures.log");
	writeTextSync(phaseFile, "traffic");
	writeTextSync(
		join(directory, "load-config.json"),
		JSON.stringify({
			phaseFile,
			activeDirectory,
			statsDirectory,
			failureLog,
			heartbeatMs: WORKER_HEARTBEAT_INTERVAL_MS,
			appendIntervalMs: APPEND_INTERVAL_MS,
			toolIntervalMs: TOOL_INTERVAL_MS,
			largeEvery: LARGE_ENTRY_EVERY,
			largeEntryBytes: LARGE_ENTRY_BYTES,
			stageEventBatchMs: STAGE_EVENT_BATCH_MS,
			stageEventsPerBatch: STAGE_EVENTS_PER_BATCH,
			stagePartialBytes: STAGE_PARTIAL_BYTES,
		}),
	);
	const journal = await resolveRunJournal({ journal: { path } });
	const backend = await JournalDurableBackend.open(journal);
	const childPath = fileURLToPath(new URL("../fixtures/pool-load-child.ts", import.meta.url));
	const child = await loadWorkerDefinition({
		path: childPath,
		exportName: "child",
		digest: await definitionDigest(childPath),
	});
	const pool = new LocalWorkerPool(backend, {
		journalPath: path,
		workers: WORKERS,
		definitions: [{ definition: child, path: childPath, exportName: "child" }],
		startupTimeoutMs: WORKER_STARTUP_TIMEOUT_MS,
		workerEntry: fileURLToPath(new URL("../fixtures/pool-load-stub-worker.mjs", import.meta.url)),
	});
	const parent = workflow({
		name: "pool-load-gate-root",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			await Promise.all(Array.from({ length: WORKERS }, (_, index) => ctx.workflow(child, { inputs: { index } })));
			return {};
		},
	});
	const activeWorkers = () => {
		try {
			return readDirectorySync(activeDirectory).length;
		} catch {
			return 0;
		}
	};
	const stubFailures = () => {
		try {
			return readTextSync(failureLog, "utf8").split("\n").filter(Boolean).slice(0, 5);
		} catch {
			return [];
		}
	};
	const assertLag = (name: string, window: LagWindow) => {
		assert.ok(
			window.p99Ms < MAIN_THREAD_LAG_P99_BOUND_MS,
			`${name}: main-thread lag p99 ${window.p99Ms} ms exceeds ${MAIN_THREAD_LAG_P99_BOUND_MS} ms (max ${window.maxMs} ms over ${window.durationMs} ms)`,
		);
		assert.ok(
			window.maxMs < MAIN_THREAD_LAG_MAX_BOUND_MS,
			`${name}: main-thread lag max ${window.maxMs} ms exceeds ${MAIN_THREAD_LAG_MAX_BOUND_MS} ms (p99 ${window.p99Ms} ms over ${window.durationMs} ms)`,
		);
	};
	const store = createStore();
	const rootRunId = testRunId(`pool-load-gate-root-${watches}${options.pane === true ? "-pane" : ""}`);
	const pane =
		options.pane === true
			? new WorkflowAttachPane({
					store,
					graphTheme: deriveGraphTheme({}),
					runId: rootRunId,
					stageControlRegistry: createStageControlRegistry(),
					onClose: () => {},
				})
			: undefined;
	// The interactive root also keeps the BACKGROUND widget, the tool-execution hooks and the
	// workflow activity bridge subscribed to the same store (#4009); the pane variant mounts them too.
	let activityChanges = 0;
	const disposeRootSurfaces =
		options.pane === true
			? (() => {
					const disposeWidget = installStoreWidget(
						{ ui: { setWidget: () => {}, requestRender: () => {} } },
						store,
					);
					installToolExecutionHooks({ events: { on: () => {} } }, store);
					const observation = createWorkflowObservation(
						store,
						{
							publishSnapshot: (input) => void structuredClone(input),
							publishChanged: (root) => {
								structuredClone(root);
								activityChanges++;
							},
							publishRemoved: () => {},
							publishLifecycle: (event) => void structuredClone(event),
							publishHeartbeat: () => {},
							dispose: () => {},
						},
						"pool-load-gate",
					);
					return () => {
						observation.dispose();
						disposeWidget();
					};
				})()
			: undefined;
	let frames = 0;
	let slowestFrameMs = 0;
	const frameTimer =
		pane === undefined
			? undefined
			: setInterval(() => {
					const began = performance.now();
					pane.render(PANE_WIDTH);
					const took = performance.now() - began;
					if (took > slowestFrameMs) slowestFrameMs = took;
					frames++;
				}, PANE_FRAME_MS);
	let watch: { readonly lease: PooledStageLease; events: number } | undefined;
	const startedAt = performance.now();
	const stopStartupLag = measureLag();
	let settled = false;
	const execution = run(parent, {}, { runId: rootRunId, cwd: directory, store, durableBackend: backend })
		.then(
			(result) => ({ status: result.status, error: result.error }),
			(error: Error) => ({ status: "rejected", error: error.message }),
		)
		.finally(() => {
			settled = true;
		});
	try {
		const activationDeadline = performance.now() + ACTIVATION_TIMEOUT_MS;
		while (activeWorkers() < WORKERS && !settled && performance.now() < activationDeadline) await sleep(250);
		const activation = { activeWorkers: activeWorkers(), ms: Math.round(performance.now() - startedAt) };
		const startupLag = stopStartupLag();
		if (activation.activeWorkers < WORKERS) {
			const outcome = settled ? await execution : { status: "running", error: undefined };
			const partial = {
				workers: WORKERS,
				activation,
				mainThreadLag: { startup: startupLag },
				run: outcome,
				stubFailures: stubFailures(),
			};
			console.log(`[pool-load-gate #3903 watches=${watches}] ${JSON.stringify(partial, null, 2)}`);
			assertLag("worker startup window", startupLag);
			assert.fail(
				`only ${activation.activeWorkers} of ${WORKERS} workers became active in ${activation.ms} ms; run: ${JSON.stringify(outcome)}`,
			);
		}

		const stopTrafficLag = measureLag();
		if (watches === 1) {
			const target = store
				.runs()
				.flatMap((candidate) =>
					candidate.stages
						.filter((stage) => stage.workerExecution !== undefined && stage.status === "running")
						.map((stage) => ({ runId: candidate.id, stageId: stage.id })),
				)
				.at(0);
			assert.ok(target !== undefined, "no pooled stage to watch");
			if (pane !== undefined) {
				// The stage chat opens the watch, as Enter on the graph node does.
				pane.retarget(rootRunId, target.stageId, target.runId);
				while (!pane._hasChatView) await sleep(25);
			}
			const lease = await acquirePooledStage(store, target.runId, target.stageId);
			assert.ok(lease !== undefined, "the pooled stage did not open a live view");
			const opened = { lease, events: 0 };
			lease.handle.subscribe(() => {
				opened.events++;
			});
			watch = opened;
		}
		await sleep(SUSTAINED_TRAFFIC_MS);
		watch?.lease.release();
		const trafficLag = stopTrafficLag();

		writeTextSync(phaseFile, "settle");
		await sleep(QUIET_SETTLE_MS);
		const before = journalFootprint(path);
		writeTextSync(phaseFile, "quiet");
		const stopQuietLag = measureLag();
		await sleep(QUIET_HEARTBEAT_MS);
		const quietLag = stopQuietLag();
		writeTextSync(phaseFile, "settle");
		const after = journalFootprint(path);
		const stopCompletionLag = measureLag();
		writeTextSync(phaseFile, "finish");

		const outcome = await execution;
		// Every child completes within moments of the others: the run-end burst of #4009.
		const completionLag = stopCompletionLag();
		makeDirectorySync(statsDirectory, { recursive: true });
		const stats = readDirectorySync(statsDirectory).map(
			(name) => JSON.parse(readTextSync(join(statsDirectory, name), "utf8")) as StubStats,
		);
		const total = (key: keyof StubStats) => stats.reduce((sum, entry) => sum + entry[key], 0);
		const heartbeatGrowth = { ...footprintGrowth(before, after), renewals: total("quietRenewals") };
		const report = {
			workers: WORKERS,
			watches,
			pane:
				options.pane === true
					? { frames, widthColumns: PANE_WIDTH, slowestFrameMs: Math.round(slowestFrameMs), activityChanges }
					: undefined,
			watchedEventsReceived: watch?.events ?? 0,
			stubsStreamingStageEvents: stats.filter((entry) => entry.stageEvents > 0).length,
			stageEventsSent: total("stageEvents"),
			activation,
			windows: { sustainedTrafficMs: SUSTAINED_TRAFFIC_MS, quietHeartbeatMs: QUIET_HEARTBEAT_MS },
			mainThreadLag: { startup: startupLag, traffic: trafficLag, quiet: quietLag, completion: completionLag },
			heartbeatGrowth,
			traffic: {
				stubsReporting: stats.length,
				commits: total("commits"),
				toolCheckpoints: total("toolCheckpoints"),
				sessionAppends: total("appends"),
				largeAppends: total("largeAppends"),
				appendedBytes: total("appendedBytes"),
				renewals: total("renewals"),
				activityPublications: total("activities"),
				slowestCommitMs: Math.max(0, ...stats.map((entry) => entry.maxCommitMs)),
				slowestRouteMs: Math.max(0, ...stats.map((entry) => entry.routeMs)),
			},
			journalAtQuietEnd: after,
			run: outcome,
			stubFailures: stubFailures(),
		};
		console.log(`[pool-load-gate #3903 watches=${watches}] ${JSON.stringify(report, null, 2)}`);

		assertLag("worker startup window", startupLag);
		assertLag("sustained traffic window", trafficLag);
		assertLag("heartbeat-only window", quietLag);
		assertLag("completion window", completionLag);
		assert.ok(
			heartbeatGrowth.renewals > WORKERS * HEARTBEAT_GROWTH_ROWS_PER_WORKER,
			`the quiet window carried only ${heartbeatGrowth.renewals} renewals, too few to tell per-renewal rows from per-worker state`,
		);
		assert.ok(
			heartbeatGrowth.rows <= WORKERS * HEARTBEAT_GROWTH_ROWS_PER_WORKER,
			`${heartbeatGrowth.renewals} renewals added ${heartbeatGrowth.rows} journal rows; bound is ${WORKERS * HEARTBEAT_GROWTH_ROWS_PER_WORKER}`,
		);
		assert.ok(
			heartbeatGrowth.bytes <= WORKERS * HEARTBEAT_GROWTH_BYTES_PER_WORKER,
			`${heartbeatGrowth.renewals} renewals added ${heartbeatGrowth.bytes} journal bytes; bound is ${WORKERS * HEARTBEAT_GROWTH_BYTES_PER_WORKER}`,
		);
		assert.deepEqual(stubFailures(), [], "a stub worker failed");
		assert.deepEqual(outcome, { status: "completed", error: undefined });
		assert.equal(stats.length, WORKERS);
		assert.ok(stats.every((entry) => entry.appends > 0 && entry.toolCheckpoints > 0));
		assert.ok(total("largeAppends") > 0, "no session append carried a large entry");
		assert.equal(
			stats.filter((entry) => entry.stageEvents > 0).length,
			watches,
			"only a watched stage sends session events",
		);
		if (watches === 1) assert.ok((watch?.events ?? 0) > 0, "the watched stage's events never reached the root");
	} finally {
		clearInterval(frameTimer);
		pane?.dispose();
		disposeRootSurfaces?.();
		writeTextSync(phaseFile, "finish");
		await pool.close();
		await backend.close();
		await broker.cleanup();
		removeTempDirectory(directory);
	}
}
