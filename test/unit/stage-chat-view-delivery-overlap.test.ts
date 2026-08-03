/**
 * Attached stage chat: overlapping delivery leases across a pre-turn compaction.
 *
 * A pre-turn `compaction_end` clears the host's Working lifecycle, so the view
 * reasserts one fresh lifecycle generation and writes it into every active
 * delivery lease. Two overlapping leases then alias the same generation, and
 * settling the first one must not clear a period the second still owns.
 *
 * These use real `StageDeliveryActivity` leases gated on resolvers, so
 * settlement order is explicit and no assertion depends on a sleep.
 *
 * cross-ref: packages/workflows/src/tui/stage-chat-view-delivery-activity.ts
 */
import { test } from "vitest";
import type { StageDeliveryActivity } from "../../packages/workflows/src/runs/foreground/stage-delivery-activity.js";
import {
	type AgentSessionEvent,
	assert,
	createStore,
	deriveGraphTheme,
	makeHandle,
	StageChatView,
	type StageControlHandle,
	setupRun,
	stripAnsi,
} from "./stage-chat-view-helpers.js";

function renderText(view: StageChatView): string {
	return stripAnsi(view.render(96).join("\n"));
}

function isWorking(view: StageChatView): boolean {
	return /Working/.test(renderText(view));
}

function stageViewFor(
	handle: StageControlHandle,
	store: ReturnType<typeof createStore>,
	onRender: () => void = () => {},
): StageChatView {
	return new StageChatView({
		store,
		graphTheme: deriveGraphTheme({}),
		runId: "run-1",
		stageId: "stage-a",
		workflowName: "test-wf",
		handle,
		onDetach: () => {},
		onClose: () => {},
		requestRender: onRender,
	});
}

function completeStage(store: ReturnType<typeof createStore>): void {
	const stage = store.runs()[0]!.stages[0]!;
	store.recordStageEnd("run-1", {
		...stage,
		status: "completed",
		endedAt: Date.now(),
		durationMs: 1,
	});
}

/** A real delivery lease held open until its gate resolves. */
function gatedLease(activity: StageDeliveryActivity): {
	release: () => Promise<void>;
} {
	const gate = Promise.withResolvers<void>();
	const lease = activity.runWithLease(() => gate.promise);
	return {
		release: async () => {
			gate.resolve();
			await lease;
		},
	};
}

function compactBeforeTurn(emit: (event: AgentSessionEvent) => void): void {
	emit({ type: "compaction_start", reason: "threshold" } as AgentSessionEvent);
	emit({ type: "compaction_end", midTurn: false } as AgentSessionEvent);
}

test("settling one of two leases sharing a reconciled generation keeps Working", async () => {
	const { handle, emit, deliveryActivity } = makeHandle(undefined, [], "completed");
	const store = createStore();
	setupRun(store, "run-1", "stage-a", "completed");
	let renderRequests = 0;
	const view = stageViewFor(handle, store, () => {
		renderRequests += 1;
	});

	try {
		const a = gatedLease(deliveryActivity);
		const b = gatedLease(deliveryActivity);
		compactBeforeTurn(emit);
		assert.equal(isWorking(view), true, "the reasserted lifecycle must repaint Working");
		assert.equal(view._hasAnimationTick, true);

		renderRequests = 0;
		await a.release();
		assert.equal(isWorking(view), true, "lease B still owns the reconciled generation, so Working must stay");
		assert.equal(view._hasAnimationTick, true);
		assert.equal(renderRequests, 0, "dropping an internal map entry must not request a render on its own");

		await b.release();
		assert.equal(isWorking(view), false, "the final correlated settlement must clear Working");
		assert.equal(view._hasAnimationTick, false);
		assert.ok(renderRequests > 0, "the final settlement must request a render");
	} finally {
		view.dispose();
	}
});

test("reversed settlement order clears the shared generation only on the last lease", async () => {
	const { handle, emit, deliveryActivity } = makeHandle(undefined, [], "completed");
	const store = createStore();
	setupRun(store, "run-1", "stage-a", "completed");
	const view = stageViewFor(handle, store);

	try {
		const a = gatedLease(deliveryActivity);
		const b = gatedLease(deliveryActivity);
		compactBeforeTurn(emit);

		await b.release();
		assert.equal(isWorking(view), true, "lease A still owns the reconciled generation");
		assert.equal(view._hasAnimationTick, true);

		await a.release();
		assert.equal(isWorking(view), false);
		assert.equal(view._hasAnimationTick, false);
	} finally {
		view.dispose();
	}
});

test("a third overlapping lease holds the shared generation past two settlements", async () => {
	const { handle, emit, deliveryActivity } = makeHandle(undefined, [], "completed");
	const store = createStore();
	setupRun(store, "run-1", "stage-a", "completed");
	const view = stageViewFor(handle, store);

	try {
		const a = gatedLease(deliveryActivity);
		const b = gatedLease(deliveryActivity);
		const c = gatedLease(deliveryActivity);
		compactBeforeTurn(emit);

		await b.release();
		assert.equal(isWorking(view), true);
		await a.release();
		assert.equal(isWorking(view), true, "lease C still owns the reconciled generation");
		assert.equal(view._hasAnimationTick, true);

		await c.release();
		assert.equal(isWorking(view), false);
		assert.equal(view._hasAnimationTick, false);
	} finally {
		view.dispose();
	}
});

test("unknown and stale settlements cannot clear a shared reconciled generation", async () => {
	const { handle, emit, emitDeliveryActivity, deliveryActivity } = makeHandle(undefined, [], "completed");
	const store = createStore();
	setupRun(store, "run-1", "stage-a", "completed");
	const view = stageViewFor(handle, store);

	try {
		const a = gatedLease(deliveryActivity);
		const b = gatedLease(deliveryActivity);
		compactBeforeTurn(emit);

		emitDeliveryActivity({ type: "delivery_settled", deliveryId: 4242 });
		assert.equal(isWorking(view), true, "an unknown id must not clear the shared generation");
		assert.equal(view._hasAnimationTick, true);

		await a.release();
		// Lease A already settled: replaying its id is now an unknown settlement.
		emitDeliveryActivity({ type: "delivery_settled", deliveryId: 1 });
		assert.equal(isWorking(view), true, "a replayed settlement must not clear lease B's period");
		assert.equal(view._hasAnimationTick, true);

		await b.release();
		assert.equal(isWorking(view), false);
		assert.equal(view._hasAnimationTick, false);
	} finally {
		view.dispose();
	}
});

test("the terminal fence returns only after the last shared-generation lease settles", async () => {
	const { handle, emit, deliveryActivity } = makeHandle(undefined, [], "running");
	const store = createStore();
	setupRun(store, "run-1", "stage-a", "running");
	const view = stageViewFor(handle, store);

	try {
		completeStage(store);
		const a = gatedLease(deliveryActivity);
		const b = gatedLease(deliveryActivity);
		compactBeforeTurn(emit);
		assert.equal(isWorking(view), true);

		await a.release();
		emit({ type: "agent_start" } as AgentSessionEvent);
		assert.equal(isWorking(view), true, "lease B still authorizes retained work");
		assert.equal(view._hasAnimationTick, true);

		emit({ type: "agent_end", messages: [] } as AgentSessionEvent);
		await b.release();
		assert.equal(isWorking(view), false);
		assert.equal(view._hasAnimationTick, false);

		emit({ type: "agent_start" } as AgentSessionEvent);
		emit({ type: "turn_start" } as AgentSessionEvent);
		assert.equal(isWorking(view), false, "a start after the last retained lease settled must stay fenced");
		assert.equal(view._hasAnimationTick, false);
	} finally {
		view.dispose();
	}
});

test("distinct lease generations keep their existing independent settlement", async () => {
	const { handle, deliveryActivity } = makeHandle(undefined, [], "completed");
	const store = createStore();
	setupRun(store, "run-1", "stage-a", "completed");
	const view = stageViewFor(handle, store);

	try {
		// No compaction, so each lease owns its own generation and B's is current.
		const a = gatedLease(deliveryActivity);
		const b = gatedLease(deliveryActivity);
		assert.equal(isWorking(view), true);

		await b.release();
		assert.equal(isWorking(view), false, "settling the current distinct generation must still clear it");
		assert.equal(view._hasAnimationTick, false);

		// A's stale token must reach the host fence and stay a no-op.
		await a.release();
		assert.equal(isWorking(view), false);
		assert.equal(view._hasAnimationTick, false);
	} finally {
		view.dispose();
	}
});
