import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test } from "vitest";
import { createGraphStageActions } from "../../packages/workflows/src/extension/workflow-graph-stage-actions.js";
import { captureWorkflowOwnerResources } from "../../packages/workflows/src/extension/workflow-owner-resources.js";
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
		assert.ok(stripVTControlCharacters(graph.render(160).join("\n")).includes("enter fork"));
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
	]) {
		const outcome = await request();
		assert.equal(outcome.ok, false);
		assert.equal(outcome.message, "<unprintable thrown value>");
	}
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
