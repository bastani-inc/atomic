import assert from "node:assert/strict";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { describe, it, vi } from "vitest";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import type { GraphStageActionResult, GraphViewOpts } from "../../packages/workflows/src/tui/graph-view-types.js";
import { makeFakeKeybindings } from "../support/fake-keybindings.js";
import { defaultTheme, makeSnap, makeStage, makeStore } from "./overlay-graph-helpers.js";

const ENTER = "\r";

function failedStage(id: string): StageSnapshot {
	return { ...makeStage(id), status: "failed", error: "gate failed" };
}

function createGraphView(stages: StageSnapshot[], opts: Partial<GraphViewOpts> = {}): GraphView {
	return new GraphView({
		piKeybindings: makeFakeKeybindings(),
		mode: "overlay",
		runId: "run-1",
		store: makeStore(makeSnap(stages)),
		graphTheme: defaultTheme,
		...opts,
	});
}

function statuslineText(graph: GraphView, width = 160): string {
	const lines = graph.render(width).map((line) => stripAnsi(line));
	const index = lines.findIndex((line) => line.includes("│ GRAPH │"));
	return index < 0 ? "" : `${lines[index - 1]}\n${lines[index]}`;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("workflow graph stage action single-flight guard (#5245, #5224)", () => {
	it("ignores duplicate retry and fork presses while a stage action is pending (#5245, #5224)", async () => {
		const retryDeferred = deferred<GraphStageActionResult>();
		const forkDeferred = deferred<GraphStageActionResult>();
		const retry = vi.fn(() => retryDeferred.promise);
		const fork = vi.fn(() => forkDeferred.promise);
		const graph = createGraphView([failedStage("verify")], {
			stageActions: {
				retry,
				fork,
				forkTarget: async () => ({ ok: true, stagePath: "verify", rerunToolSteps: 0, live: false }),
			},
		});

		try {
			graph.handleInput(ENTER);
			graph.handleInput("r");
			assert.equal(retry.mock.calls.length, 1);
			assert.deepEqual(retry.mock.calls[0], ["run-1", "verify"]);
			assert.match(statuslineText(graph), /Retrying verify…/);

			graph.handleInput("r");
			graph.handleInput("f");
			assert.equal(retry.mock.calls.length, 1);
			assert.equal(fork.mock.calls.length, 0);
			assert.match(statuslineText(graph), /Retrying verify…/);

			retryDeferred.resolve({ ok: false, message: "retry refused" });
			await settle();
			assert.match(statuslineText(graph), /retry refused/);

			graph.handleInput("f");
			await settle();
			assert.equal(fork.mock.calls.length, 0);
			assert.match(statuslineText(graph), /enter fork/);
			graph.handleInput(ENTER);
			assert.equal(fork.mock.calls.length, 1);
			assert.deepEqual(fork.mock.calls[0], ["run-1", "verify"]);
			assert.match(statuslineText(graph), /Forking from verify…/);

			graph.handleInput("f");
			graph.handleInput("r");
			assert.equal(fork.mock.calls.length, 1);
			assert.equal(retry.mock.calls.length, 1);
			assert.match(statuslineText(graph), /Forking from verify…/);

			forkDeferred.resolve({ ok: true, message: "forked run-2", runId: "run-2" });
			await settle();
			assert.match(statuslineText(graph), /forked run-2/);
		} finally {
			graph.dispose();
		}
	});

	it("resets the stage action guard after rejected and synchronously thrown actions (#5245, #5224)", async () => {
		const firstRetry = deferred<GraphStageActionResult>();
		let retryAttempt = 0;
		const retry = vi.fn((): Promise<GraphStageActionResult> => {
			retryAttempt++;
			if (retryAttempt === 1) return firstRetry.promise;
			if (retryAttempt === 2) throw new Error("sync retry failure");
			return Promise.resolve({ ok: true, message: "retried verify" });
		});
		const fork = vi.fn(async () => ({ ok: true, message: "forked verify" }));
		const graph = createGraphView([failedStage("verify")], {
			stageActions: {
				retry,
				fork,
				forkTarget: async () => ({ ok: true, stagePath: "verify", rerunToolSteps: 0, live: false }),
			},
		});

		try {
			graph.handleInput(ENTER);
			graph.handleInput("r");
			graph.handleInput("f");
			assert.equal(retry.mock.calls.length, 1);
			assert.equal(fork.mock.calls.length, 0);

			firstRetry.reject(new Error("async retry failure"));
			await settle();
			assert.match(statuslineText(graph), /async retry failure/);

			graph.handleInput("r");
			assert.equal(retry.mock.calls.length, 2);
			await settle();
			assert.match(statuslineText(graph), /sync retry failure/);

			graph.handleInput("f");
			await settle();
			graph.handleInput(ENTER);
			assert.equal(fork.mock.calls.length, 1);
			await settle();
			assert.match(statuslineText(graph), /forked verify/);
		} finally {
			graph.dispose();
		}
	});
});

it("keeps the stage action receiver when invoking guarded controls (#5245, #5224)", async () => {
	const stageActions = {
		calls: [] as string[],
		async forkTarget() {
			return { ok: true as const, stagePath: "verify", rerunToolSteps: 0, live: false };
		},
		async retry(): Promise<GraphStageActionResult> {
			this.calls.push("retry");
			return { ok: false, message: "retry refused" };
		},
		async fork(): Promise<GraphStageActionResult> {
			this.calls.push("fork");
			return { ok: false, message: "fork refused" };
		},
	};
	const graph = createGraphView([failedStage("verify")], { stageActions });
	try {
		graph.handleInput(ENTER);
		graph.handleInput("r");
		await settle();
		graph.handleInput("f");
		await settle();
		graph.handleInput(ENTER);
		await settle();
		assert.deepEqual(stageActions.calls, ["retry", "fork"]);
	} finally {
		graph.dispose();
	}
});
