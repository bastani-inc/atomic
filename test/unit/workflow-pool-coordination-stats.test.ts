import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { afterEach, test, vi } from "vitest";
import { observeSqlPoolTransactions, sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import { buildWorkflowStatusListing } from "../../packages/workflows/src/extension/workflow-status-summary.js";
import { renderWorkflowToolContent } from "../../packages/workflows/src/extension/workflow-tool-content.js";
import { formatPoolCoordination } from "../../packages/workflows/src/shared/pool-coordination.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { PoolCoordinationStats, RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { renderStatusList } from "../../packages/workflows/src/tui/status-list.js";
import { visibleWidth } from "../../packages/workflows/src/tui/text-helpers.js";
import { PoolCoordinationCounters } from "../../packages/workflows/src/workers/pool-coordination-stats.js";
import { withDebugLog } from "../helpers/debug-mode.js";

afterEach(() => {
	vi.useRealTimers();
});

test("coordination counters count requests by kind and writes by the task that submitted them (#4313)", async () => {
	vi.useFakeTimers({ toFake: ["Date"], now: 10_000 });
	const counters = new PoolCoordinationCounters();
	counters.request("heartbeat");
	counters.request("heartbeat");
	counters.request("claim");
	await counters.within("heartbeat", async () => {
		counters.write();
		await nextTurn();
		counters.write();
	});
	const later = counters.within("claim", () => nextTurn().then(() => counters.write()));
	counters.write();
	await later;
	vi.setSystemTime(14_000);
	const stats = counters.sample();
	assert.deepEqual(stats, {
		since: 10_000,
		requests: { heartbeat: { count: 2, perSecond: 0.5 }, claim: { count: 1, perSecond: 0.25 } },
		writes: {
			heartbeat: { count: 2, perSecond: 0.5 },
			other: { count: 1, perSecond: 0.25 },
			claim: { count: 1, perSecond: 0.25 },
		},
	});
});

test("coordination counters report only what changed since the last changed-only sample (#4313)", () => {
	vi.useFakeTimers({ toFake: ["Date"], now: 0 });
	const counters = new PoolCoordinationCounters();
	assert.equal(counters.sample(true), undefined, "nothing counted yet");
	assert.deepEqual(counters.sample(), { since: 0, requests: {}, writes: {} }, "a full sample is always taken");
	counters.request("activity");
	assert.equal(counters.sample(true)?.requests.activity?.count, 1);
	assert.equal(counters.sample(true), undefined, "unchanged since the sample before");
	counters.write();
	assert.equal(counters.sample(true)?.writes.other?.count, 1);
	assert.equal(counters.sample(false, 0)?.requests.activity?.perSecond, 1_000, "rates never divide by zero");
});

const stats: PoolCoordinationStats = {
	since: 0,
	requests: {
		heartbeat: { count: 30, perSecond: 0.4 },
		commit: { count: 600, perSecond: 8.12 },
		activity: { count: 220, perSecond: 3 },
		claim: { count: 2, perSecond: 0.025 },
	},
	writes: { commit: { count: 200, perSecond: 2.7 }, heartbeat: { count: 30, perSecond: 0.4 } },
};

test("a pool's status line names the busiest kinds of requests and writes per second (#4313)", () => {
	assert.equal(
		formatPoolCoordination(stats),
		"pool: requests 12/s (commit 8.1, activity 3.0, heartbeat 0.40, …) · writes 3.1/s (commit 2.7, heartbeat 0.40)",
	);
	assert.equal(
		formatPoolCoordination({ since: 0, requests: {}, writes: {} }),
		"pool: requests 0.00/s · writes 0.00/s",
	);
	assert.equal(
		formatPoolCoordination({
			since: 0,
			requests: { heartbeat: { count: 3, perSecond: 1 } },
			writes: { heartbeat: { count: 30, perSecond: 10 } },
		}),
		"pool: requests 1.0/s (heartbeat 1.0) · writes 10/s (heartbeat 10)",
	);
	const three = { a: { count: 1, perSecond: 3 }, b: { count: 1, perSecond: 2 }, c: { count: 1, perSecond: 1 } };
	assert.equal(
		formatPoolCoordination({ since: 0, requests: three, writes: {} }),
		"pool: requests 6.0/s (a 3.0, b 2.0, c 1.0) · writes 0.00/s",
		"no ellipsis when every kind is named",
	);
});

test("transaction observation leaves a journal without pool storage alone (#4313)", () => {
	let observed = 0;
	const journal = new MemoryRunJournal();
	observeSqlPoolTransactions(journal, () => {
		observed++;
	});
	assert.equal(observed, 0);
	assert.equal(sqlPoolStorage(journal), undefined, "no pool storage was made up for it");
});

function rootRun(): RunSnapshot {
	return {
		id: "root",
		name: "pooled-root",
		inputs: {},
		status: "running",
		stages: [],
		toolNodes: [],
		startedAt: 0,
	};
}

test("the root run's pool snapshot reaches the store, and the status list in debug mode (#4313, #4360)", async () => {
	const store = createStore();
	store.recordRunStart(rootRun());
	const changes: unknown[] = [];
	const unsubscribe = store.subscribeInvalidation((changed) => {
		changes.push(changed);
	});
	store.recordRunPool?.("root", { coordination: stats });
	store.recordRunPool?.("missing", { coordination: stats });
	unsubscribe();
	assert.deepEqual(changes, [[{ runId: "root" }]], "only a run the store holds changes, and only that run");
	assert.deepEqual(store.run("root")?.pool, { coordination: stats });
	assert.deepEqual(store.graphSnapshot().runs[0]?.pool, { coordination: stats }, "status views read it");
	const hidden = renderStatusList(store.graphSnapshot().runs, { width: 200, now: 0 });
	assert.ok(!hidden.includes("pool:"), "the pool line is a debug surface, hidden by default");
	await withDebugLog("setting", () => assertPoolLines(store));
});

function assertPoolLines(store: ReturnType<typeof createStore>): void {
	const listed = renderStatusList(store.graphSnapshot().runs, { width: 200, now: 0 });
	assert.ok(listed.includes("pool: requests 12/s (commit 8.1, activity 3.0, heartbeat 0.40, …)"), listed);
	const plain = renderStatusList([rootRun()], { width: 200, now: 0 });
	assert.ok(!plain.includes("pool:"), "a root without a pool");
	assert.equal(
		listed.split("\n").length,
		plain.split("\n").length + 1,
		"the pool takes one line, and only with a pool",
	);
	const narrow = renderStatusList(store.graphSnapshot().runs, { width: 60, now: 0 });
	assert.ok(narrow.includes("pool: requests 12/s"), narrow);
	for (const line of narrow.split("\n")) assert.ok(visibleWidth(line) <= 60, `"${line}" overflows a 60-column list`);
	const poolLine = narrow.split("\n").find((line) => line.includes("pool:"));
	assert.match(
		stripVTControlCharacters(poolLine ?? ""),
		/… +│$/,
		"the pool line is cut to the card's width, inside its margin",
	);
}

test("the workflow tool's status action shows one pool line for a root with a local pool in debug mode (#4313, #4360)", async () => {
	const pooled: RunSnapshot = { ...rootRun(), pool: { coordination: stats } };
	const plain: RunSnapshot = { ...rootRun(), id: "plain", name: "plain-root" };
	const listing = buildWorkflowStatusListing([pooled, plain], "all", 10);
	assert.deepEqual(
		listing.runs.map((run) => run.pool),
		[{ coordination: stats }, undefined],
	);
	assert.equal("pool" in listing.runs[1]!, false, "a root without a pool has no pool field");
	const content = () => renderWorkflowToolContent({ action: "status", ...listing }, { action: "status" });
	const poolLines = () =>
		content()
			.split("\n")
			.filter((line) => line.trimStart().startsWith("pool:"));
	const hidden = content();
	assert.deepEqual(poolLines(), [], "hidden by default");
	assert.equal(hidden.includes("undefined"), false, "and leaves no empty line behind");
	await withDebugLog("ATOMIC_DEBUG", () => {
		assert.deepEqual(poolLines(), [
			"    pool: requests 12/s (commit 8.1, activity 3.0, heartbeat 0.40, …) · writes 3.1/s (commit 2.7, heartbeat 0.40)",
		]);
		assert.equal(content().split("\n").length, hidden.split("\n").length + 1, "one line, for the root with a pool");
	});
});
