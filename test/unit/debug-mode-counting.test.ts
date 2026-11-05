import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";

const appends = vi.hoisted(() => ({ count: 0, failListingOf: undefined as string | undefined }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		appendFileSync: (...args: Parameters<typeof actual.appendFileSync>) => {
			appends.count += 1;
			return actual.appendFileSync(...args);
		},
		readdirSync: ((path: import("node:fs").PathLike, ...rest: unknown[]) => {
			if (String(path) === appends.failListingOf)
				throw Object.assign(new Error("EMFILE: injected"), { code: "EMFILE" });
			return (actual.readdirSync as (...args: unknown[]) => unknown)(path, ...rest);
		}) as typeof actual.readdirSync,
	};
});

// The setup files loaded the storage adapter with the real node:fs. Load every module this test drives afresh, in one
// module graph, so the adapter sees the mocked node:fs and every area shares one debug setting.
vi.resetModules();
const { reportModelRoutingDebug } = await import("../../packages/coding-agent/src/core/model-routing-debug.js");
const { openNodeSqliteDatabase } = await import("../../packages/coding-agent/src/core/storage/node-sqlite.js");
const { installWorkflowLifecycleNotifications } = await import(
	"../../packages/workflows/src/extension/lifecycle-notifications.js"
);
const { nextWorkflowHeartbeatBoundary } = await import(
	"../../packages/workflows/src/extension/workflow-heartbeat-scheduler.js"
);
const { poolCoordinationLine } = await import("../../packages/workflows/src/shared/pool-coordination.js");
const { LocalWorkerPool } = await import("../../packages/workflows/src/workers/local-pool.js");
const { createStore } = await import("../../packages/workflows/src/shared/store.js");
const { configurePooledWatchTrace, tracePooledWatch } = await import(
	"../../packages/workflows/src/workers/pooled-watch-trace.js"
);
const { withDebugLog } = await import("../helpers/debug-mode.js");

type DebugModeSource = "setting" | "ATOMIC_DEBUG";

afterEach(() => {
	vi.restoreAllMocks();
	appends.failListingOf = undefined;
});

const stats = { since: 0, requests: { claim: { count: 1, perSecond: 1 } }, writes: {} };

async function triggerEveryArea(agentDir: string): Promise<string | undefined> {
	reportModelRoutingDebug("routing fallback");
	configurePooledWatchTrace(join(agentDir, "journal.sqlite"), "root");
	tracePooledWatch("root.reconnect.start", { key: "k" });
	const store = createStore();
	const unsubscribe = installWorkflowLifecycleNotifications({
		store,
		config: { enabled: true, notifyOn: ["completed"] },
		sendMessage() {
			throw new Error("send failed");
		},
	});
	store.recordRunStart({
		id: "run",
		name: "run",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [],
		startedAt: 1,
	});
	store.recordRunEnd("run", "completed", {});
	unsubscribe();
	nextWorkflowHeartbeatBoundary(1_000, Number.MAX_VALUE, 1_000);
	vi.spyOn(process, "emitWarning").mockImplementation(() => {});
	const path = join(agentDir, "queue.sqlite");
	const database = await openNodeSqliteDatabase(path);
	try {
		await database.exec("CREATE TABLE items (value TEXT NOT NULL)");
		await database.transaction(async (tx) => {
			await tx.run("INSERT INTO items VALUES ('degraded')");
			mkdirSync(`${path}-writers`, { recursive: true });
			appends.failListingOf = `${path}-writers`;
		});
		appends.failListingOf = undefined;
		for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => setImmediate(resolve));
	} finally {
		await database.close();
	}
	await Reflect.apply(Reflect.get(LocalWorkerPool.prototype, "receive"), { root: "root" }, [
		{ kind: "coordination", stats },
	]);
	return poolCoordinationLine({ coordination: stats });
}

async function count(source: DebugModeSource | "off") {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	return withDebugLog(source, async (log) => {
		appends.count = 0;
		const poolLine = await triggerEveryArea(log.agentDir);
		const records = log.records();
		return {
			poolLine,
			appends: appends.count,
			records: records.length,
			areas: records.reduce<Record<string, number>>((counts, { area }) => {
				counts[area] = (counts[area] ?? 0) + 1;
				return counts;
			}, {}),
			poolEvents: records.filter(({ area }) => area === "pool").map(({ event, data }) => ({ event, data })),
			warnings: warn.mock.calls.length,
		};
	});
}

test("with debug off, no debug sink is written by any area (#4360)", async () => {
	const off = await count("off");
	assert.deepEqual(
		{ appends: off.appends, records: off.records, warnings: off.warnings, poolLine: off.poolLine },
		{ appends: 0, records: 0, warnings: 0, poolLine: undefined },
	);
});

test("with debug on, each area's event is one append to the debug log and nothing else (#4360)", async () => {
	for (const source of ["setting", "ATOMIC_DEBUG"] as const) {
		const on = await count(source);
		assert.deepEqual(on.areas, { "model-routing": 1, "pooled-watch": 1, workflow: 2, storage: 1, pool: 1 });
		assert.deepEqual(on.poolEvents, [
			{
				event: "coordination",
				data: { root: "root", summary: "pool: requests 1.0/s (claim 1.0) · writes 0.00/s" },
			},
		]);
		assert.equal(on.appends, 6, `${source}: one append per event`);
		assert.equal(on.records, 6, `${source}: every append is a debug log record`);
		assert.equal(on.warnings, 0, `${source}: debug mode prints nothing`);
		assert.notEqual(on.poolLine, undefined, `${source}: the pool line is shown`);
	}
});
