/**
 * Attached stage chat: workflow-authored delivery lifecycle.
 *
 * A workflow definition auto-sending to its own retained stage must paint
 * `Working` at admission — before the public `agent_start` clears the session's
 * ordered event queue — and must hand that same visible period to the agent
 * turn without a gap. Settlement must clean up when no turn ever starts, and a
 * stale settlement must never clear a newer turn.
 *
 * cross-ref: packages/workflows/src/tui/stage-chat-view-delivery-activity.ts
 */
import { test } from "vitest";
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

function stageViewFor(
	handle: StageControlHandle,
	onRender: () => void = () => {},
	status: "running" | "completed" = "completed",
	store: ReturnType<typeof createStore> = createStore(),
	seedRun = true,
): { view: StageChatView; store: ReturnType<typeof createStore> } {
	if (seedRun) setupRun(store, "run-1", "stage-a", status);
	const view = new StageChatView({
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
	return { view, store };
}

function completedStageView(
	handle: StageControlHandle,
	onRender: () => void,
): { view: StageChatView; store: ReturnType<typeof createStore> } {
	return stageViewFor(handle, onRender, "completed");
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

test("workflow-authored delivery paints Working before the public agent_start", () => {
	const { handle, emit, emitDeliveryActivity } = makeHandle(undefined, [], "completed");
	let renderRequests = 0;
	const { view } = completedStageView(handle, () => {
		renderRequests += 1;
	});

	try {
		assert.doesNotMatch(renderText(view), /Working/);
		assert.equal(view._hasAnimationTick, false);

		renderRequests = 0;
		emitDeliveryActivity({ type: "delivery_start", deliveryId: 1 });
		assert.match(renderText(view), /Working/);
		assert.equal(view._hasAnimationTick, true);
		assert.ok(renderRequests > 0, "expected an immediate render request on admission");

		// The real turn takes over the same visible period.
		emit({ type: "agent_start" } as AgentSessionEvent);
		assert.match(renderText(view), /Working/);
		assert.equal(view._hasAnimationTick, true);

		emit({ type: "turn_end" } as AgentSessionEvent);
		emit({ type: "agent_end", messages: [] } as AgentSessionEvent);
		assert.doesNotMatch(renderText(view), /Working/);
		assert.equal(view._hasAnimationTick, false);

		// The delivery settles last; it must not resurrect or disturb the idle pane.
		emitDeliveryActivity({ type: "delivery_settled", deliveryId: 1 });
		assert.doesNotMatch(renderText(view), /Working/);
		assert.equal(view._hasAnimationTick, false);
	} finally {
		view.dispose();
	}
});

test("a delivery that starts no turn clears Working on settlement", () => {
	const { handle, emitDeliveryActivity } = makeHandle(undefined, [], "completed");
	const { view } = completedStageView(handle, () => {});

	try {
		emitDeliveryActivity({ type: "delivery_start", deliveryId: 7 });
		assert.match(renderText(view), /Working/);
		assert.equal(view._hasAnimationTick, true);

		emitDeliveryActivity({ type: "delivery_settled", deliveryId: 7 });
		assert.doesNotMatch(renderText(view), /Working/);
		assert.equal(view._hasAnimationTick, false);
	} finally {
		view.dispose();
	}
});

test("a stale delivery settlement cannot clear a newer turn", () => {
	const { handle, emit, emitDeliveryActivity } = makeHandle(undefined, [], "completed");
	const { view } = completedStageView(handle, () => {});

	try {
		emitDeliveryActivity({ type: "delivery_start", deliveryId: 1 });
		emitDeliveryActivity({ type: "delivery_start", deliveryId: 2 });
		emit({ type: "agent_start" } as AgentSessionEvent);
		assert.match(renderText(view), /Working/);

		emitDeliveryActivity({ type: "delivery_settled", deliveryId: 1 });
		assert.match(renderText(view), /Working/);
		assert.equal(view._hasAnimationTick, true);

		emit({ type: "agent_end", messages: [] } as AgentSessionEvent);
		emitDeliveryActivity({ type: "delivery_settled", deliveryId: 2 });
		assert.doesNotMatch(renderText(view), /Working/);
		assert.equal(view._hasAnimationTick, false);
	} finally {
		view.dispose();
	}
});

test("an unknown settlement id is ignored", () => {
	const { handle, emitDeliveryActivity } = makeHandle(undefined, [], "completed");
	const { view } = completedStageView(handle, () => {});

	try {
		emitDeliveryActivity({ type: "delivery_start", deliveryId: 3 });
		emitDeliveryActivity({ type: "delivery_settled", deliveryId: 99 });
		assert.match(renderText(view), /Working/);
		assert.equal(view._hasAnimationTick, true);
	} finally {
		view.dispose();
	}
});

test("compaction status keeps precedence over an accepted delivery", () => {
	const { handle, emit, emitDeliveryActivity } = makeHandle(undefined, [], "completed");
	const { view } = completedStageView(handle, () => {});

	try {
		emit({ type: "compaction_start", reason: "manual" } as AgentSessionEvent);
		assert.match(renderText(view), /Compacting context/);

		emitDeliveryActivity({ type: "delivery_start", deliveryId: 5 });
		assert.match(renderText(view), /Compacting context/);
		assert.doesNotMatch(renderText(view), /Working\.\.\./);
	} finally {
		view.dispose();
	}
});

test("disposal unsubscribes the delivery channel and stops the animation", () => {
	const { handle, emitDeliveryActivity, deliveryActivityListeners } = makeHandle(undefined, [], "completed");
	const { view } = completedStageView(handle, () => {});

	emitDeliveryActivity({ type: "delivery_start", deliveryId: 1 });
	assert.equal(deliveryActivityListeners(), 1);
	assert.equal(view._hasAnimationTick, true);

	view.dispose();
	assert.equal(deliveryActivityListeners(), 0);
	assert.equal(view._hasAnimationTick, false);
});

test("pre-turn compaction returns Working to the still-active delivery", () => {
	const { handle, emit, emitDeliveryActivity } = makeHandle(undefined, [], "completed");
	const { view } = completedStageView(handle, () => {});

	try {
		emitDeliveryActivity({ type: "delivery_start", deliveryId: 1 });
		emit({ type: "compaction_start", reason: "threshold" } as AgentSessionEvent);
		assert.match(renderText(view), /Auto-compacting/);

		emit({ type: "compaction_end", midTurn: false } as AgentSessionEvent);
		assert.match(
			renderText(view),
			/Working/,
			"expected Working to return while the workflow delivery was still active",
		);
		assert.equal(view._hasAnimationTick, true);

		emitDeliveryActivity({ type: "delivery_settled", deliveryId: 1 });
		assert.doesNotMatch(renderText(view), /Working/);
		assert.equal(view._hasAnimationTick, false);
	} finally {
		view.dispose();
	}
});

test("a compaction error stays authoritative over the active delivery's Working", () => {
	const { handle, emit, emitDeliveryActivity } = makeHandle(undefined, [], "completed");
	const { view } = completedStageView(handle, () => {});

	try {
		emitDeliveryActivity({ type: "delivery_start", deliveryId: 4 });
		emit({ type: "compaction_start", reason: "manual" } as AgentSessionEvent);
		emit({
			type: "compaction_end",
			midTurn: false,
			errorMessage: "compaction hit the hard input limit",
		} as AgentSessionEvent);

		assert.match(renderText(view), /compaction hit the hard input limit/);
		assert.doesNotMatch(renderText(view), /Working\.\.\./);

		emitDeliveryActivity({ type: "delivery_settled", deliveryId: 4 });
		assert.match(renderText(view), /compaction hit the hard input limit/);
		assert.equal(view._hasAnimationTick, false);
	} finally {
		view.dispose();
	}
});

test("a late agent_start after terminal cleanup cannot resurrect Working", () => {
	const { handle, emit, emitDeliveryActivity } = makeHandle(undefined, [], "running");
	const { view, store } = stageViewFor(handle, () => {}, "running");

	try {
		emitDeliveryActivity({ type: "delivery_start", deliveryId: 1 });
		assert.match(renderText(view), /Working/);

		completeStage(store);
		assert.doesNotMatch(renderText(view), /Working/);
		assert.equal(view._hasAnimationTick, false);

		emit({ type: "agent_start" } as AgentSessionEvent);
		assert.doesNotMatch(
			renderText(view),
			/Working/,
			"a start queued before terminal cleanup must not restart Working",
		);
		assert.equal(view._hasAnimationTick, false);

		emit({ type: "turn_start" } as AgentSessionEvent);
		assert.doesNotMatch(renderText(view), /Working/);
		assert.equal(view._hasAnimationTick, false);

		// The stale lease was invalidated, so its settlement is an unknown id.
		emitDeliveryActivity({ type: "delivery_settled", deliveryId: 1 });
		assert.doesNotMatch(renderText(view), /Working/);
		assert.equal(view._hasAnimationTick, false);
	} finally {
		view.dispose();
	}
});

test("a delivery admitted after terminal cleanup still authorizes a retained turn", () => {
	const { handle, emit, emitDeliveryActivity } = makeHandle(undefined, [], "running");
	const { view, store } = stageViewFor(handle, () => {}, "running");

	try {
		completeStage(store);
		emitDeliveryActivity({ type: "delivery_start", deliveryId: 9 });
		assert.match(renderText(view), /Working/);

		emit({ type: "agent_start" } as AgentSessionEvent);
		assert.match(renderText(view), /Working/, "post-mortem conversation admitted after cleanup must keep Working");
		assert.equal(view._hasAnimationTick, true);

		emit({ type: "agent_end", messages: [] } as AgentSessionEvent);
		emitDeliveryActivity({ type: "delivery_settled", deliveryId: 9 });
		assert.doesNotMatch(renderText(view), /Working/);
		assert.equal(view._hasAnimationTick, false);
	} finally {
		view.dispose();
	}
});

test("remounting while a delivery is active replays it onto the new view", () => {
	const { handle, deliveryActivity } = makeHandle(undefined, [], "completed");
	const store = createStore();
	setupRun(store, "run-1", "stage-a", "completed");
	const first = stageViewFor(handle, () => {}, "completed", store, false).view;
	const deliveryId = deliveryActivity.start();
	assert.match(renderText(first), /Working/);
	first.dispose();

	let renderRequests = 0;
	const second = stageViewFor(
		handle,
		() => {
			renderRequests += 1;
		},
		"completed",
		store,
		false,
	).view;

	try {
		assert.match(renderText(second), /Working/, "a view attached mid-delivery must replay the active delivery");
		assert.equal(second._hasAnimationTick, true);
		assert.ok(renderRequests > 0, "expected an immediate render request on replay");

		deliveryActivity.settle(deliveryId);
		assert.doesNotMatch(renderText(second), /Working/);
		assert.equal(second._hasAnimationTick, false);
	} finally {
		second.dispose();
	}
});

test("the terminal fence returns after a no-turn delivery settles", () => {
	const { handle, emit, emitDeliveryActivity } = makeHandle(undefined, [], "running");
	const { view, store } = stageViewFor(handle, () => {}, "running");

	try {
		completeStage(store);
		emitDeliveryActivity({ type: "delivery_start", deliveryId: 1 });
		emitDeliveryActivity({ type: "delivery_settled", deliveryId: 1 });
		assert.doesNotMatch(renderText(view), /Working/);

		emit({ type: "agent_start" } as AgentSessionEvent);
		assert.doesNotMatch(
			renderText(view),
			/Working/,
			"a start after the last post-terminal delivery settled must stay suppressed",
		);
		emit({ type: "turn_start" } as AgentSessionEvent);
		assert.doesNotMatch(renderText(view), /Working/);
		assert.equal(view._hasAnimationTick, false);
	} finally {
		view.dispose();
	}
});

test("the terminal fence returns after a completed retained turn settles", () => {
	const { handle, emit, emitDeliveryActivity } = makeHandle(undefined, [], "running");
	const { view, store } = stageViewFor(handle, () => {}, "running");

	try {
		completeStage(store);
		emitDeliveryActivity({ type: "delivery_start", deliveryId: 2 });
		emit({ type: "agent_start" } as AgentSessionEvent);
		emit({ type: "turn_start" } as AgentSessionEvent);
		assert.match(renderText(view), /∀\s+\S/, "the accepted retained turn must show Working");

		emit({ type: "turn_end" } as AgentSessionEvent);
		emit({ type: "agent_end", messages: [] } as AgentSessionEvent);
		emitDeliveryActivity({ type: "delivery_settled", deliveryId: 2 });
		assert.doesNotMatch(renderText(view), /Working/);

		emit({ type: "agent_start" } as AgentSessionEvent);
		emit({ type: "turn_start" } as AgentSessionEvent);
		assert.doesNotMatch(renderText(view), /Working/, "a start after the retained turn finished must stay suppressed");
		assert.equal(view._hasAnimationTick, false);
	} finally {
		view.dispose();
	}
});

test("settling one of several leases keeps the others authorized", () => {
	const { handle, emit, emitDeliveryActivity } = makeHandle(undefined, [], "running");
	const { view, store } = stageViewFor(handle, () => {}, "running");

	try {
		completeStage(store);
		emitDeliveryActivity({ type: "delivery_start", deliveryId: 1 });
		emitDeliveryActivity({ type: "delivery_start", deliveryId: 2 });
		emitDeliveryActivity({ type: "delivery_settled", deliveryId: 1 });

		emit({ type: "agent_start" } as AgentSessionEvent);
		assert.match(renderText(view), /Working/, "lease 2 must still authorize the turn");
		assert.equal(view._hasAnimationTick, true);

		emit({ type: "agent_end", messages: [] } as AgentSessionEvent);
		emitDeliveryActivity({ type: "delivery_settled", deliveryId: 2 });
		emit({ type: "agent_start" } as AgentSessionEvent);
		assert.doesNotMatch(renderText(view), /Working/, "the final settlement must rearm the fence");
		assert.equal(view._hasAnimationTick, false);
	} finally {
		view.dispose();
	}
});

test("unknown and invalidated settlements leave the fence untouched", () => {
	const { handle, emit, emitDeliveryActivity } = makeHandle(undefined, [], "running");
	const { view, store } = stageViewFor(handle, () => {}, "running");

	try {
		emitDeliveryActivity({ type: "delivery_start", deliveryId: 1 });
		completeStage(store);
		// Lease 1 was dropped by the transition; its settlement must not reopen it.
		emitDeliveryActivity({ type: "delivery_settled", deliveryId: 1 });
		emitDeliveryActivity({ type: "delivery_settled", deliveryId: 42 });

		emit({ type: "agent_start" } as AgentSessionEvent);
		assert.doesNotMatch(renderText(view), /Working/);
		assert.equal(view._hasAnimationTick, false);

		// A genuinely new delivery still reopens authorization.
		emitDeliveryActivity({ type: "delivery_start", deliveryId: 5 });
		emit({ type: "agent_start" } as AgentSessionEvent);
		assert.match(renderText(view), /Working/);
		assert.equal(view._hasAnimationTick, true);
	} finally {
		view.dispose();
	}
});

test("a non-terminal stage keeps ordinary agent work visible after a delivery settles", () => {
	const { handle, emit, emitDeliveryActivity } = makeHandle(undefined, [], "running");
	const { view } = stageViewFor(handle, () => {}, "running");

	try {
		emitDeliveryActivity({ type: "delivery_start", deliveryId: 1 });
		emitDeliveryActivity({ type: "delivery_settled", deliveryId: 1 });

		emit({ type: "agent_start" } as AgentSessionEvent);
		assert.match(renderText(view), /Working/, "a running stage must keep showing ordinary agent work");
		assert.equal(view._hasAnimationTick, true);
	} finally {
		view.dispose();
	}
});
