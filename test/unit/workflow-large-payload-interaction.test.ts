import assert from "node:assert/strict";
import type { AgentSession } from "@bastani/atomic";
import { describe, test } from "vitest";
import type { StageControlHandle } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowInputValues } from "../../packages/workflows/src/shared/types.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import { WorkflowAttachPane } from "../../packages/workflows/src/tui/workflow-attach-pane.js";
import { ANSI_RE } from "./overlay-graph-helpers.js";

function heavyInput(reads: { count: number }): WorkflowInputValues {
	const evidence: Record<string, string> = {};
	Object.defineProperty(evidence, "occurrences", {
		enumerable: true,
		get() {
			reads.count++;
			return "x".repeat(1024);
		},
	});
	return { evidence };
}

function countPublicSnapshotCalls(store: ReturnType<typeof createStore>): { count: number } {
	const counter = { count: 0 };
	const snapshot = store.snapshot.bind(store);
	store.snapshot = () => {
		counter.count++;
		return snapshot();
	};
	return counter;
}

function countLegacySnapshotDeliveries(store: ReturnType<typeof createStore>): {
	count: number;
	unsubscribe: () => void;
} {
	const counter = { count: 0 };
	const unsubscribe = store.subscribe(() => {
		counter.count++;
	});
	return {
		get count() {
			return counter.count;
		},
		unsubscribe,
	};
}

function mousePressForText(lines: readonly string[], text: string): string {
	const plain = lines.map((line) => line.replace(ANSI_RE, ""));
	const row = plain.findIndex((line) => line.includes(text));
	assert.notEqual(row, -1, `expected rendered text ${text}`);
	const column = plain[row]!.indexOf(text);
	return `\x1b[<0;${column + 1};${row + 1}M`;
}

function handle(runId: string, stageId: string): StageControlHandle {
	return {
		runId,
		stageId,
		stageName: stageId,
		status: "running",
		sessionId: undefined,
		sessionFile: undefined,
		isStreaming: false,
		messages: [] as AgentSession["messages"],
		async ensureAttached() {},
		async prompt() {},
		async steer() {},
		async followUp() {},
		async pause() {},
		async resume() {},
		subscribe() {
			return () => {};
		},
	};
}

describe("large workflow interaction isolation", () => {
	test("graph render and mouse attachment avoid full snapshots and payload traversal", () => {
		const payloadReads = { count: 0 };
		const store = createStore();
		store.recordRunStart({
			id: "run-large",
			name: "large-workflow",
			inputs: heavyInput(payloadReads),
			status: "running",
			stages: [
				{
					id: "target-stage",
					name: "target-stage",
					status: "running",
					parentIds: [],
					toolEvents: [],
					startedAt: Date.now(),
				},
			],
			startedAt: Date.now(),
		});
		payloadReads.count = 0;
		const publicSnapshotCalls = countPublicSnapshotCalls(store);
		const attached: string[] = [];
		const view = new GraphView({
			mode: "overlay",
			runId: "run-large",
			store,
			graphTheme: deriveGraphTheme({}),
			onStageAttach: (_runId, stageId) => attached.push(stageId),
		});

		const lines = view.render(96);
		assert.equal(view.handleInput(mousePressForText(lines, "target-stage")), true);
		assert.deepEqual(attached, ["target-stage"]);
		assert.equal(publicSnapshotCalls.count, 0);
		assert.equal(payloadReads.count, 0);
		view.dispose();
	});

	test("question interaction uses projections until a legacy subscriber requests a full snapshot", async () => {
		const payloadReads = { count: 0 };
		const store = createStore();
		store.recordRunStart({
			id: "run-large",
			name: "large-workflow",
			inputs: heavyInput(payloadReads),
			status: "running",
			stages: [
				{
					id: "question-stage",
					name: "question-stage",
					status: "running",
					parentIds: [],
					toolEvents: [],
					startedAt: Date.now(),
				},
			],
			startedAt: Date.now(),
		});
		assert.equal(
			store.recordStagePendingPrompt("run-large", "question-stage", {
				id: "prompt-1",
				kind: "input",
				message: "What should the workflow use?",
				createdAt: Date.now(),
			}),
			true,
		);
		const pending = store.awaitStagePendingPrompt("run-large", "question-stage", "prompt-1");
		payloadReads.count = 0;
		const publicSnapshotCalls = countPublicSnapshotCalls(store);
		const registry = createStageControlRegistry();
		registry.register(handle("run-large", "question-stage"));
		let now = 1_000;
		const pane = new WorkflowAttachPane({
			store,
			graphTheme: deriveGraphTheme({}),
			runId: "run-large",
			initialAttachStageId: "question-stage",
			stageControlRegistry: registry,
			onClose: () => {},
			now: () => now,
		});

		const preview = pane.render(96).join("\n");
		assert.match(preview, /What should the workflow use\?/);
		for (const character of "answer") pane.handleInput(character);
		now += 201;
		assert.equal(publicSnapshotCalls.count, 0);
		assert.equal(payloadReads.count, 0);
		const legacySnapshots = countLegacySnapshotDeliveries(store);
		pane.handleInput("\r");

		assert.equal(await pending, "answer");
		assert.equal(publicSnapshotCalls.count, 0);
		assert.ok(legacySnapshots.count > 0, "a legacy subscriber must receive the mutation snapshot");
		assert.equal(payloadReads.count, legacySnapshots.count);
		legacySnapshots.unsubscribe();
		pane.dispose();
	});
});
