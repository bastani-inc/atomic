import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { durableWorkflowRunSnapshots } from "../../packages/workflows/src/durable/completed-catalog.js";
import { openCompletedDurableWorkflow } from "../../packages/workflows/src/durable/completed-inspection.js";
import { bindStoreDurableBackend } from "../../packages/workflows/src/durable/store-backend.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import {
	registerPendingStageIntercomBridge,
	TERMINAL_INVOCATION_ROUTE_RETENTION,
} from "../../packages/workflows/src/extension/pending-stage-intercom.js";
import { claimExternalRunRoute } from "../../packages/workflows/src/shared/external-run-routes.js";
import { restoreOnSessionStart, type SessionEntry } from "../../packages/workflows/src/shared/persistence-restore.js";
import { createStore, type Store } from "../../packages/workflows/src/shared/store.js";
import { JournalTestBackend } from "../helpers/journal-backend.js";
import { testRunId } from "../helpers/run-id.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function observeRoutes(store: Store, notify?: () => Promise<boolean>) {
	const routed = new Set<string>();
	const bridge = registerPendingStageIntercomBridge(
		{
			events: {
				emit(event, payload) {
					if (event === "atomic:workflow-pending-stage-route") {
						routed.add(String(payload.runId));
						payload.completion = Promise.resolve();
					} else if (event === "atomic:workflow-pending-stage-route-retired") routed.delete(String(payload.runId));
					else if (notify && event === "atomic:workflow-pending-stage-undeliverable") {
						payload.handled = true;
						payload.completion = notify();
					}
				},
			},
		},
		store,
	);
	cleanups.push(bridge);
	return { routed, bridge };
}

async function startRuns() {
	const backend = await createMemoryTestBackend();
	cleanups.push(() => backend.close());
	const store = createStore();
	bindStoreDurableBackend(store, backend);
	const ids = Array.from({ length: TERMINAL_INVOCATION_ROUTE_RETENTION + 1 }, (_, i) => testRunId(`finish-${i}`));
	for (const [i, id] of ids.entries()) {
		await backend.commitWorkflowRegistration({
			workflowId: id,
			name: id,
			inputs: {},
			status: "running",
			createdAt: i + 1,
		});
		store.recordRunStart({
			id,
			name: id,
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [],
			startedAt: i + 1,
		});
	}
	return { backend, store, ids };
}

test("the last invocation to finish keeps its routes when a batch finishes in reverse launch order (#5561)", async () => {
	const { store, ids } = await startRuns();
	const { routed, bridge } = observeRoutes(store);
	await bridge.flush();
	assert.deepEqual(routed, new Set(ids));
	const finishing = ids.toReversed();
	for (const id of finishing) store.recordRunStart({ ...store.run(id)!, status: "completed", endedAt: 100 });
	await bridge.flush();
	assert.deepEqual(routed, new Set(finishing.slice(1)));
});

test("a run that resumes and finishes between announcements gets a new place in the finished window (#5561)", async () => {
	const { ids, store } = await startRuns();
	const { routed, bridge } = observeRoutes(store);
	for (const id of ids) store.recordRunEnd(id, "failed");
	await bridge.flush();
	assert.deepEqual(routed, new Set(ids.slice(1)));
	const resumed = ids[0]!;
	store.batch(() => {
		store.recordRunStart({ ...store.run(resumed)!, status: "running", endedAt: undefined });
		store.recordRunEnd(resumed, "completed");
	});
	await bridge.flush();
	assert.deepEqual(routed, new Set([...ids.slice(2), resumed]));
	// When a retained run reopens it is live, not one of the 32 terminal invocations.
	store.recordRunStart({ ...store.run(resumed)!, status: "running", endedAt: undefined });
	await bridge.flush();
	assert.deepEqual(routed, new Set(ids));
});

test("a local route handed to an external owner is withdrawn without withdrawing a sibling (#5561)", async () => {
	const { ids, store } = await startRuns();
	const { routed, bridge } = observeRoutes(store);
	for (const id of ids) store.recordRunEnd(id, "failed");
	await bridge.flush();
	const moved = ids.at(-1)!;
	const owner = { notifyUndeliverable: async () => false, deliversQueued: () => false };
	for (const full of [false, true]) {
		const release = claimExternalRunRoute(store, moved, owner);
		try {
			if (full) bridge.refresh();
			else store.recordRunStart({ ...store.run(moved)! });
			await bridge.flush();
			assert.deepEqual(
				routed,
				new Set(ids.slice(0, -1)),
				"local routes exclude the external owner and backfill the window",
			);
		} finally {
			release();
		}
		bridge.refresh();
		assert.deepEqual(routed, new Set(ids.slice(1)), "a locally owned invocation is reachable again");
	}
});

test("settling an older finisher's notice never displaces a newer finisher (#5561)", async () => {
	const { ids, store, backend } = await startRuns();
	const inspected = Promise.withResolvers<void>();
	const receipt = Promise.withResolvers<boolean>();
	const { routed, bridge } = observeRoutes(store, () => {
		inspected.resolve();
		return receipt.promise;
	});
	const first = ids.at(-1)!;
	store.recordStageStart(first, { id: "pending", name: "pending", status: "pending", parentIds: [], toolEvents: [] });
	const group = `workflow:${first}`;
	assert.ok(
		(
			await store.queueStageMessage(
				{
					runId: first,
					stageKey: "pending",
					from: { id: "sender", group },
					message: { id: "waiting", timestamp: 1, content: { text: "hello" } },
					queuedAt: new Date().toISOString(),
				},
				group,
				group,
				backend,
			)
		)?.ok,
	);
	for (const id of ids.toReversed()) store.recordRunEnd(id, "failed");
	const sweep = bridge.flush();
	await inspected.promise;
	try {
		assert.deepEqual(routed, new Set(ids));
	} finally {
		receipt.resolve(true);
		await sweep;
	}
	await bridge.flush();
	assert.deepEqual(routed, new Set(ids.slice(0, -1)));
});

test("older session entries with the same end time retain the latest end entries, including a resumed run (#5561)", async () => {
	const { ids, backend } = await startRuns();
	const finishing = ids.toReversed();
	const start = (id: string): SessionEntry => ({
		id,
		type: "workflow.run.start",
		payload: { runId: id, name: id, inputs: {}, ts: 1 },
	});
	const end = (id: string): SessionEntry => ({
		id,
		type: "workflow.run.end",
		payload: { runId: id, status: "failed", ts: 10 },
	});
	const resumed = finishing[0]!;
	const entries = [...ids.map(start), ...finishing.map(end), start(resumed), end(resumed)];
	const restored = createStore();
	bindStoreDurableBackend(restored, backend);
	restoreOnSessionStart({ getEntries: () => entries }, { persistRuns: true, resumeInFlight: "never" }, restored);
	assert.deepEqual(observeRoutes(restored).routed, new Set([...finishing.slice(2), resumed]));
});

test("restoring finished runs keeps their original finish order, not journal arrival or inspection order (#5561)", async () => {
	const backend = await JournalTestBackend.create();
	const store = createStore();
	const entries: SessionEntry[] = [];
	const lateEnds: SessionEntry[] = [];
	const finishing = Array.from({ length: TERMINAL_INVOCATION_ROUTE_RETENTION + 1 }, (_, i) =>
		testRunId(`restored-${i}`),
	);
	const firstStarted = finishing.at(-1)!;
	const release = Promise.withResolvers<void>();
	const flow = workflow({
		name: "finish-order",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			if (ctx.runId === firstStarted) await release.promise;
			await ctx.tool("step", {}, async () => "done");
			return {};
		},
	});
	const started = Promise.withResolvers<void>();
	const launch = (id: string) =>
		run(
			flow,
			{},
			{
				runId: id,
				store,
				adapters: {},
				durableBackend: backend,
				persistence: {
					appendEntry(type, payload) {
						const entry = JSON.parse(JSON.stringify({ id: `${type}-${id}`, type, payload })) as SessionEntry;
						if (type === "workflow.run.end") lateEnds.unshift(entry);
						else entries.push(entry);
						if (type === "workflow.run.start" && id === firstStarted) started.resolve();
					},
				},
			},
		);
	const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
	const longRun = launch(firstStarted);
	try {
		await started.promise;
		for (const id of finishing.slice(0, -1)) {
			const result = await launch(id);
			assert.equal(result.status, "completed", result.error);
		}
	} finally {
		release.resolve();
		try {
			assert.equal((await longRun).status, "completed");
		} finally {
			clock.mockRestore();
		}
	}
	const reopened = await backend.reopen();
	const fromJournal = createStore();
	bindStoreDurableBackend(fromJournal, reopened);
	for (const id of finishing.toReversed()) {
		await reopened.hydrateWorkflow(id);
		for (const snapshot of durableWorkflowRunSnapshots(reopened, reopened.getWorkflow(id)!))
			fromJournal.recordRunStart(snapshot);
	}
	const fromSession = createStore();
	bindStoreDurableBackend(fromSession, reopened);
	restoreOnSessionStart(
		{ getEntries: () => [...entries, ...lateEnds] },
		{ persistRuns: true, resumeInFlight: "never" },
		fromSession,
	);
	for (const [source, restored] of [
		["journal", fromJournal],
		["session", fromSession],
	] as const) {
		const { routed, bridge } = observeRoutes(restored);
		assert.deepEqual(routed, new Set(finishing.slice(1)), source);
		// The next finish must follow the restored window, even if the host's clock has moved backwards.
		const resumed = finishing[0]!;
		restored.recordRunStart({ ...restored.run(resumed)!, status: "running", endedAt: undefined });
		const earlierClock = vi.spyOn(Date, "now").mockReturnValue(2);
		try {
			restored.recordRunEnd(resumed, "failed");
		} finally {
			earlierClock.mockRestore();
		}
		await bridge.flush();
		const kept = new Set([...finishing.slice(2), resumed]);
		assert.deepEqual(routed, kept, source);
		if (source === "journal") {
			// A later journal write is not a new finish. Opening the retired run from its own journal must not
			// promote it even when this host now uses a different default journal.
			const retired = finishing[1]!;
			await reopened.persistPendingStageMessages(retired, []);
			const other = await createMemoryTestBackend();
			cleanups.push(() => other.close());
			bindStoreDurableBackend(restored, other);
			const sessionStore = new MemorySessionStore();
			cleanups.push(() => sessionStore.close());
			const opened = await openCompletedDurableWorkflow(
				retired,
				{ durableBackend: reopened, store: restored, sessionStore },
				reopened.listCompletedWorkflows(),
			);
			assert.ok(opened.ok, opened.message);
			await bridge.flush();
			assert.deepEqual(routed, kept, "inspecting a finished run from another journal is not a new finish");
		}
	}
});
