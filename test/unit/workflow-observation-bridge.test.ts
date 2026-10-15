import assert from "node:assert/strict";
import { test } from "vitest";
import { WorkflowActivityHub } from "../../packages/coding-agent/src/core/extensions/workflow-activity-hub.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import {
	createWorkflowLifecycleNotificationState,
	installWorkflowLifecycleNotifications,
} from "../../packages/workflows/src/extension/lifecycle-notifications.js";
import { createWorkflowObservation } from "../../packages/workflows/src/extension/workflow-observation.js";
import { quitRun } from "../../packages/workflows/src/runs/background/quit.js";
import { pauseRun, resumeRun } from "../../packages/workflows/src/runs/background/status.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";

// #2891: activity observes execution rather than notification delivery.
test("tool-only execution publishes working then idle without notifications", async () => {
	const store = createStore();
	const hub = new WorkflowActivityHub();
	const observation = createWorkflowObservation(store, hub.registerWorkflowActivityPublisher(), "owner");
	const stopNotices = installWorkflowLifecycleNotifications({
		store,
		state: createWorkflowLifecycleNotificationState(),
		config: { enabled: false, notifyOn: [] },
		sendMessage: () => assert.fail("disabled notifications must remain silent"),
	});
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const result = run(
		workflow({
			name: "observed-tool",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.tool("hold", {}, async () => {
					entered.resolve();
					await release.promise;
					return "done";
				});
				return {};
			},
		}),
		{},
		{ store, durableBackend: new InMemoryDurableBackend() },
	);
	try {
		await entered.promise;
		const frame = hub.getSnapshotFrame();
		assert.equal(frame.availability, "ready");
		assert.ok(frame.availability === "ready");
		assert.equal(frame.roots[0]?.state, "working");
		assert.equal(frame.roots[0]?.activeExecutionCount, 1);
	} finally {
		release.resolve();
		await result;
	}
	const frame = hub.getSnapshotFrame();
	assert.ok(frame.availability === "ready");
	assert.equal(frame.roots[0]?.state, "idle");
	assert.equal(store.runs()[0]?.stages.length, 0);
	assert.equal(store.runs()[0]?.toolNodes?.length, 1);
	observation.dispose();
	stopNotices();
});

// #2891: prompt parking is attention, not execution ownership.
for (const parallel of [false, true]) {
	test(`live HIL observes attention with parallel execution ${parallel}`, async () => {
		const store = createStore();
		const hub = new WorkflowActivityHub();
		const observation = createWorkflowObservation(store, hub.registerWorkflowActivityPublisher(), "owner");
		const waiting = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const unsubscribe = store.subscribe(() => {
			if (store.runs().some((item) => item.stages.some((stage) => stage.pendingPrompt))) waiting.resolve();
		});
		const result = run(
			workflow({
				name: `hil-${parallel}`,
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					const sibling = parallel
						? ctx.tool("sibling", {}, async () => {
								await release.promise;
								return "done";
							})
						: Promise.resolve();
					await ctx.ui.confirm("Continue?");
					await ctx.tool("after-answer", {}, async () => {
						entered.resolve();
						await release.promise;
						return "done";
					});
					await sibling;
					return {};
				},
			}),
			{},
			{ store, durableBackend: new InMemoryDurableBackend(), usePromptNodesForUi: true },
		);
		try {
			await waiting.promise;
			const frame = hub.getSnapshotFrame();
			assert.ok(frame.availability === "ready");
			assert.equal(frame.roots[0]?.state, parallel ? "working" : "blocked");
			assert.equal(frame.roots[0]?.needsAttention, true);
			const current = store.runs()[0]!;
			const stage = current.stages.find((item) => item.pendingPrompt)!;
			store.resolveStagePendingPrompt(current.id, stage.id, stage.pendingPrompt!.id, true);
			await entered.promise;
			const answered = hub.getSnapshotFrame();
			assert.ok(answered.availability === "ready");
			assert.equal(answered.roots[0]?.state, "working");
			assert.equal(answered.roots[0]?.needsAttention, false);
		} finally {
			release.resolve();
			await result;
			unsubscribe();
			observation.dispose();
		}
	});
}

// #2891: control requests describe draining work, independently of terminal notices.
test("pause is idle and quit remains working until its tool drains", async () => {
	const store = createStore();
	const hub = new WorkflowActivityHub();
	const actions: string[] = [];
	hub.bindDispatcher(async (event) => {
		if (event.type === "workflow_lifecycle" && event.target.kind === "run" && event.target.action)
			actions.push(event.target.action);
	});
	const observation = createWorkflowObservation(store, hub.registerWorkflowActivityPublisher(), "owner");
	const body = Promise.withResolvers<void>();
	const admitted = Promise.withResolvers<void>();
	const toolEntered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const result = run(
		workflow({
			name: "control",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				admitted.resolve();
				await body.promise;
				await ctx.tool("drain", {}, async () => {
					toolEntered.resolve();
					await release.promise;
					return "done";
				});
				return {};
			},
		}),
		{},
		{ store, durableBackend: new InMemoryDurableBackend() },
	);
	await admitted.promise;
	const id = store.runs()[0]!.id;
	try {
		assert.equal((await pauseRun(id, { store })).ok, true);
		const paused = hub.getSnapshotFrame();
		assert.ok(paused.availability === "ready");
		assert.equal(paused.roots[0]?.state, "idle");
		assert.equal(paused.roots[0]?.reason, "paused");
		await resumeRun(id, { store, actor: "user" });
		await pauseRun(id, { store });
		await resumeRun(id, { store });
		body.resolve();
		await toolEntered.promise;
		const quitting = quitRun(id, { store, actor: "user" });
		const stopping = hub.getSnapshotFrame();
		assert.ok(stopping.availability === "ready");
		assert.equal(stopping.roots[0]?.state, "working");
		assert.equal(stopping.roots[0]?.reason, "stopping");
		release.resolve();
		await quitting;
		await result;
		const done = hub.getSnapshotFrame();
		assert.ok(done.availability === "ready");
		assert.equal(done.roots[0]?.state, "idle");
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(actions, ["pause", "resume", "pause", "resume", "quit"]);
	} finally {
		body.resolve();
		release.resolve();
		await result;
		observation.dispose();
	}
});

// #2891: stop ownership ends with the run; a re-execution under the same id starts unowned.
test("re-running a quit run id publishes executing rather than stopping", async () => {
	const store = createStore();
	const hub = new WorkflowActivityHub();
	const observation = createWorkflowObservation(store, hub.registerWorkflowActivityPublisher(), "owner");
	const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
	const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
	let attempt = 0;
	const definition = workflow({
		name: "rerun",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			const index = attempt++;
			await ctx.tool("hold", {}, async () => {
				entered[index]!.resolve();
				await gates[index]!.promise;
				return "done";
			});
			return {};
		},
	});
	const first = run(definition, {}, { store, durableBackend: new InMemoryDurableBackend() });
	await entered[0]!.promise;
	const id = store.runs()[0]!.id;
	try {
		const quitting = quitRun(id, { store, actor: "user" });
		gates[0]!.resolve();
		await quitting;
		await first;
		const done = hub.getSnapshotFrame();
		assert.ok(done.availability === "ready");
		assert.equal(done.roots[0]?.state, "idle");
		store.removeRun(id);
		const second = run(definition, {}, { store, durableBackend: new InMemoryDurableBackend(), runId: id });
		try {
			await entered[1]!.promise;
			const rerun = hub.getSnapshotFrame();
			assert.ok(rerun.availability === "ready");
			assert.equal(rerun.roots[0]?.state, "working");
			assert.equal(rerun.roots[0]?.reason, "executing");
		} finally {
			gates[1]!.resolve();
			await second;
		}
		const finished = hub.getSnapshotFrame();
		assert.ok(finished.availability === "ready");
		assert.equal(finished.roots[0]?.state, "idle");
	} finally {
		for (const gate of gates) gate.resolve();
		observation.dispose();
	}
});

// #2891: stop ownership belongs to a live executor; requests against a settled or hydrated run own nothing.
for (const shape of ["repeated quit after drain", "hydrated run without an executor"] as const) {
	test(`${shape} leaves no stop ownership for a same-id re-execution`, async () => {
		const store = createStore();
		const hub = new WorkflowActivityHub();
		const observation = createWorkflowObservation(store, hub.registerWorkflowActivityPublisher(), "owner");
		const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		let attempt = 0;
		const definition = workflow({
			name: "rerun-after-rejected-stop",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const index = attempt++;
				await ctx.tool("hold", {}, async () => {
					entered[index]!.resolve();
					await gates[index]!.promise;
					return "done";
				});
				return {};
			},
		});
		let id: string;
		try {
			if (shape === "repeated quit after drain") {
				const first = run(definition, {}, { store, durableBackend: new InMemoryDurableBackend() });
				await entered[0]!.promise;
				id = store.runs()[0]!.id;
				const quitting = quitRun(id, { store, actor: "user" });
				gates[0]!.resolve();
				await quitting;
				await first;
				await quitRun(id, { store, actor: "user" });
			} else {
				id = "hydrated";
				attempt = 1;
				store.recordRunStart({
					id,
					name: "hydrated",
					inputs: {},
					toolNodes: [],
					stages: [],
					status: "running",
					startedAt: 1,
				});
				const quit = await quitRun(id, { store, actor: "user" });
				assert.equal(quit.ok, false);
				const pause = await pauseRun(id, { store });
				assert.equal(pause.ok, false);
			}
			const settled = hub.getSnapshotFrame();
			assert.ok(settled.availability === "ready");
			assert.equal(settled.roots[0]?.state, "idle");
			store.removeRun(id);
			const second = run(definition, {}, { store, durableBackend: new InMemoryDurableBackend(), runId: id });
			try {
				await entered[1]!.promise;
				const rerun = hub.getSnapshotFrame();
				assert.ok(rerun.availability === "ready");
				assert.equal(rerun.roots[0]?.state, "working");
				assert.equal(rerun.roots[0]?.reason, "executing");
			} finally {
				gates[1]!.resolve();
				await second;
			}
			const finished = hub.getSnapshotFrame();
			assert.ok(finished.availability === "ready");
			assert.equal(finished.roots[0]?.state, "idle");
		} finally {
			for (const gate of gates) gate.resolve();
			observation.dispose();
		}
	});
}

// #2891: settled failures retain attention without inventing a pending user decision.
test("settled workflow failure is idle with attention", async () => {
	const store = createStore();
	const hub = new WorkflowActivityHub();
	const observation = createWorkflowObservation(store, hub.registerWorkflowActivityPublisher(), "owner");
	await run(
		workflow({
			name: "failure",
			description: "",
			inputs: {},
			outputs: {},
			run: async () => {
				throw new Error("failure");
			},
		}),
		{},
		{ store, durableBackend: new InMemoryDurableBackend() },
	);
	const frame = hub.getSnapshotFrame();
	assert.ok(frame.availability === "ready");
	assert.equal(frame.roots[0]?.state, "idle");
	assert.equal(frame.roots[0]?.reason, "quiescent");
	assert.equal(frame.roots[0]?.needsAttention, true);
	assert.equal(frame.roots[0]?.actionableBlockCount, 0);
	observation.dispose();
});

// #2891: an accepted request abort is a request, not proof of settlement.
test("caller cancellation publishes stopping while its admitted tool drains", async () => {
	const store = createStore();
	const hub = new WorkflowActivityHub();
	const observation = createWorkflowObservation(store, hub.registerWorkflowActivityPublisher(), "owner");
	const controller = new AbortController();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const execution = run(
		workflow({
			name: "abort",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.tool("held", {}, async () => {
					entered.resolve();
					await release.promise;
					return "done";
				});
				return {};
			},
		}),
		{},
		{ store, durableBackend: new InMemoryDurableBackend(), signal: controller.signal },
	);
	await entered.promise;
	try {
		controller.abort();
		const frame = hub.getSnapshotFrame();
		assert.ok(frame.availability === "ready");
		assert.equal(frame.roots[0]?.state, "working");
		assert.equal(frame.roots[0]?.reason, "stopping");
	} finally {
		release.resolve();
		await execution;
		observation.dispose();
	}
});

// #2891: cancellation never masquerades as a human answer.
test("aborted HIL publishes a cancelled prompt lifecycle", async () => {
	const store = createStore();
	const hub = new WorkflowActivityHub();
	const statuses: string[] = [];
	hub.bindDispatcher(async (event) => {
		if (event.type === "workflow_lifecycle" && event.target.kind === "prompt") statuses.push(event.target.status);
	});
	const observation = createWorkflowObservation(store, hub.registerWorkflowActivityPublisher(), "owner");
	const controller = new AbortController();
	const waiting = Promise.withResolvers<void>();
	const unsubscribe = store.subscribe(() => {
		if (store.runs().some((item) => item.stages.some((stage) => stage.pendingPrompt))) waiting.resolve();
	});
	const execution = run(
		workflow({
			name: "cancel-prompt",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.ui.confirm("Continue?");
				return {};
			},
		}),
		{},
		{ store, durableBackend: new InMemoryDurableBackend(), signal: controller.signal, usePromptNodesForUi: true },
	);
	await waiting.promise;
	controller.abort();
	await execution;
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(statuses, ["opened", "cancelled"]);
	unsubscribe();
	observation.dispose();
});

// #2912: an already-aborted caller still has an observable accepted kill request.
test("pre-aborted caller publishes exactly one kill after run registration", async () => {
	const store = createStore();
	const hub = new WorkflowActivityHub();
	const actions: string[] = [];
	hub.bindDispatcher(async (event) => {
		if (event.type === "workflow_lifecycle" && event.target.kind === "run" && event.target.action)
			actions.push(event.target.action);
	});
	const observation = createWorkflowObservation(store, hub.registerWorkflowActivityPublisher(), "owner");
	const controller = new AbortController();
	controller.abort();
	try {
		await run(
			workflow({ name: "pre-aborted", description: "", inputs: {}, outputs: {}, run: async () => ({}) }),
			{},
			{ store, durableBackend: new InMemoryDurableBackend(), signal: controller.signal },
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(actions, ["kill"]);
	} finally {
		observation.dispose();
	}
});
