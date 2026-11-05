import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { reportModelRoutingDebug } from "../../packages/coding-agent/src/core/model-routing-debug.js";
import { installWorkflowLifecycleNotifications } from "../../packages/workflows/src/extension/lifecycle-notifications.js";
import { nextWorkflowHeartbeatBoundary } from "../../packages/workflows/src/extension/workflow-heartbeat-scheduler.js";
import { poolCoordinationLine } from "../../packages/workflows/src/shared/pool-coordination.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import {
	configurePooledWatchTrace,
	tracePooledWatch,
} from "../../packages/workflows/src/workers/pooled-watch-trace.js";
import { type DebugModeSource, withDebugLog } from "../helpers/debug-mode.js";

const appends = vi.hoisted(() => ({ count: 0 }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		appendFileSync: (...args: Parameters<typeof actual.appendFileSync>) => {
			appends.count += 1;
			return actual.appendFileSync(...args);
		},
	};
});

afterEach(() => {
	vi.restoreAllMocks();
});

const stats = { since: 0, requests: { claim: { count: 1, perSecond: 1 } }, writes: {} };

/** One trigger of every debug surface: model routing, pooled watch, workflow notices and heartbeats, the pool line. */
function triggerEveryArea(agentDir: string): { readonly writers: number; readonly poolLine: string | undefined } {
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
	return { writers: 4, poolLine: poolCoordinationLine({ coordination: stats }) };
}

async function count(source: DebugModeSource | "off") {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	return withDebugLog(source, (log) => {
		appends.count = 0;
		const { writers, poolLine } = triggerEveryArea(log.agentDir);
		return {
			writers,
			poolLine,
			appends: appends.count,
			records: log.records().length,
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
		assert.equal(on.appends, on.writers, `${source}: one append per event`);
		assert.equal(on.records, on.writers, `${source}: every append is a debug log record`);
		assert.equal(on.warnings, 0, `${source}: debug mode prints nothing`);
		assert.notEqual(on.poolLine, undefined, `${source}: the pool line is shown`);
	}
});
