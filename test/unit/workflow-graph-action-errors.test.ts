import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test } from "vitest";
import { createGraphStageActions } from "../../packages/workflows/src/extension/workflow-graph-stage-actions.js";
import { captureWorkflowOwnerResources } from "../../packages/workflows/src/extension/workflow-owner-resources.js";
import {
	createStageControlRegistry,
	type StageControlStatus,
} from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import type {
	GraphForkTargetResult,
	GraphStageActionResult,
} from "../../packages/workflows/src/tui/graph-view-types.js";
import { defaultTheme, makeSnap, makeStage, makeStore } from "./overlay-graph-helpers.js";

function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

test("synchronous fork lookups keep their receiver and release the busy state after a failure (#5234)", async () => {
	const actions = {
		attempts: 0,
		forkTarget(): Promise<GraphForkTargetResult> {
			this.attempts++;
			if (this.attempts === 1) throw Object.create(null);
			return Promise.resolve({ ok: true, stagePath: "verify", rerunToolSteps: 0, live: false });
		},
		fork: async () => ({ ok: true, message: "forked" }),
	};
	const graph = new GraphView({
		mode: "overlay",
		runId: "run-1",
		store: makeStore(makeSnap([{ ...makeStage("verify"), status: "failed" }])),
		graphTheme: defaultTheme,
		stageActions: actions,
	});
	try {
		graph.handleInput("\r");
		assert.doesNotThrow(() => graph.handleInput("f"));
		await settle();
		assert.equal(actions.attempts, 1);
		assert.ok(graph.render(160).join("\n").includes("<unprintable thrown value>"));
		graph.handleInput("f");
		await settle();
		assert.equal(actions.attempts, 2);
		assert.ok(stripVTControlCharacters(graph.render(160).join("\n")).includes("enter confirm"));
	} finally {
		graph.dispose();
	}
});

test("stop callbacks keep their receiver when dispatched from the graph (#5234)", async () => {
	const actions = {
		stops: 0,
		stop(): Promise<GraphStageActionResult> {
			this.stops++;
			return Promise.resolve({ ok: true, message: "stopped" });
		},
	};
	const graph = new GraphView({
		mode: "overlay",
		runId: "run-1",
		store: makeStore(makeSnap([{ ...makeStage("worker"), status: "running" }])),
		graphTheme: defaultTheme,
		stageActions: actions,
	});
	try {
		graph.handleInput("x");
		assert.doesNotThrow(() => graph.handleInput("x"));
		await settle();
		assert.equal(actions.stops, 1);
	} finally {
		graph.dispose();
	}
});

test("graph action resource failures always resolve to an error result (#5234)", async () => {
	const bad = Object.create(null);
	const store = new Proxy(createStore(), {
		get() {
			throw bad;
		},
	});
	const actions = createGraphStageActions({
		owner: { ...captureWorkflowOwnerResources(), store },
		runtime: () => {
			throw bad;
		},
		context: () => undefined,
	});
	for (const request of [
		() => actions.stop!("missing", "stage"),
		() => actions.retry!("missing", "stage"),
		() => actions.fork!("missing", "stage"),
		() => actions.forkTarget!("missing", "stage"),
		() => actions.pauseRun!("missing"),
		() => actions.resumeRun!("missing"),
		() => actions.quitRun!("missing"),
	]) {
		const outcome = await request();
		assert.equal(outcome.ok, false);
		assert.equal(outcome.message, "<unprintable thrown value>");
	}
});

test("graph retry, fork and forkTarget await ensureWorkflowResourcesLoaded before reading runtime and warn on discovery failure (#5234)", async () => {
	const order: string[] = [];
	const warnings: Array<{ message: string; type?: string }> = [];
	let releaseLoad!: () => void;
	const loadGate = new Promise<void>((resolve) => {
		releaseLoad = resolve;
	});
	let loaded = false;
	const actions = createGraphStageActions({
		owner: captureWorkflowOwnerResources(),
		ensureWorkflowResourcesLoaded: async () => {
			order.push("ensure:start");
			await loadGate;
			loaded = true;
			order.push("ensure:end");
		},
		runtime: () => {
			order.push(`runtime:${loaded}`);
			return loaded
				? ({
						resumeFailedRun: async () => ({ ok: true as const, runId: "run-1", message: "resumed" }),
					} as never)
				: undefined;
		},
		context: () => ({
			hasUI: true,
			ui: {
				notify: (message, type) => {
					warnings.push({ message, type });
				},
			},
		}),
	});
	const pendingRetry = actions.retry!("run-1", "stage-1");
	await settle();
	assert.deepEqual(order, ["ensure:start"]);
	releaseLoad();
	const retryResult = await pendingRetry;
	assert.deepEqual(retryResult, { ok: true, runId: "run-1", message: "resumed" });
	assert.deepEqual(order, ["ensure:start", "ensure:end", "runtime:true"]);

	const failingActions = createGraphStageActions({
		owner: captureWorkflowOwnerResources(),
		ensureWorkflowResourcesLoaded: async () => {
			throw new Error("broken workflow file");
		},
		runtime: () => undefined,
		context: () => ({
			hasUI: true,
			ui: {
				notify: (message, type) => {
					warnings.push({ message, type });
				},
			},
		}),
	});
	const forkOutcome = await failingActions.fork!("run-1", "stage-1");
	const targetOutcome = await failingActions.forkTarget!("run-1", "stage-1");
	assert.equal(forkOutcome.ok, false);
	assert.equal(targetOutcome.ok, false);
	assert.equal(warnings.length, 2);
	assert.equal(warnings[0]?.type, "warning");
	assert.match(warnings[0]?.message ?? "", /broken workflow file/);
	assert.equal(warnings[1]?.type, "warning");

	const store = createStore();
	const stageControlRegistry = createStageControlRegistry();
	store.recordRunStart({
		id: "run-live",
		name: "deploy",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [{ id: "stage-1", name: "build", status: "running", parentIds: [], toolEvents: [] }],
		startedAt: 1,
	});
	const owner = { ...captureWorkflowOwnerResources(), store, stageControlRegistry };
	let currentStatus: StageControlStatus = "running";
	stageControlRegistry.register({
		runId: "run-live",
		stageId: "stage-1",
		stageName: "build",
		get status() {
			return currentStatus;
		},
		sessionId: undefined,
		sessionFile: undefined,
		isStreaming: false,
		messages: [],
		async ensureAttached() {},
		async prompt() {},
		async steer() {},
		async followUp() {},
		pause: async () => {
			currentStatus = "paused";
		},
		resume: async () => {
			currentStatus = "running";
			return undefined;
		},
		subscribe: () => () => {},
	});
	const liveActions = createGraphStageActions({
		owner,
		runtime: () =>
			({
				resumeFailedRun: async () => ({ ok: true as const, runId: "run-live", message: "Resumed blocked run" }),
				resumeDurableWorkflow: async () => ({ ok: true as const, runId: "run-live", message: "Resumed quit run" }),
			}) as never,
		context: () => ({ hasUI: true }),
	});
	const pausedOutcome = await liveActions.pauseRun!("run-live");
	assert.equal(pausedOutcome.ok, true);
	assert.equal(store.run("run-live")?.status, "paused");

	const resumedOutcome = await liveActions.resumeRun!("run-live");
	assert.equal(resumedOutcome.ok, true);
	assert.equal(store.run("run-live")?.status, "running");

	const quitOutcome = await liveActions.quitRun!("run-live");
	assert.equal(quitOutcome.ok, true);
	assert.equal(store.run("run-live")?.exitReason, "quit");
});

test.each([
	{ name: "null prototype", error: () => Object.create(null) },
	{
		name: "throwing message",
		error: () =>
			Object.defineProperty(new Error(), "message", {
				get() {
					throw new Error("message trap");
				},
			}),
	},
	{
		name: "throwing conversion",
		error: () => ({
			[Symbol.toPrimitive]() {
				throw new Error("conversion trap");
			},
		}),
	},
	{
		name: "revoked proxy",
		error: () => {
			const revocable = Proxy.revocable({}, {});
			revocable.revoke();
			return revocable.proxy;
		},
	},
])("a rejected stage action with $name becomes a notice instead of another rejection (#5234)", async ({ error }) => {
	const graph = new GraphView({
		mode: "overlay",
		runId: "run-1",
		store: makeStore(makeSnap([{ ...makeStage("verify"), status: "failed" }])),
		graphTheme: defaultTheme,
		stageActions: {
			retry: async () => {
				throw error();
			},
		},
	});
	try {
		graph.handleInput("\r");
		graph.handleInput("r");
		await settle();
		assert.ok(graph.render(160).join("\n").includes("<unprintable thrown value>"));
	} finally {
		graph.dispose();
	}
});
