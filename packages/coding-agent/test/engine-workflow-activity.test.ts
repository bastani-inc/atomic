import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import type {
	WorkflowActivityFrame,
	WorkflowActivityObserver,
	WorkflowRootActivity,
} from "../src/core/extensions/workflow-events.js";
import { forwardWorkflowActivity } from "../src/modes/interactive-engine/engine-workflow-activity.js";
import {
	type InteractiveEngineMessage,
	parseInteractiveEngineMessage,
	serializeInteractiveEngineMessage,
} from "../src/modes/interactive-engine/protocol.js";

const cursor = { epoch: "e", revision: 1 };
const root = (overrides: Partial<WorkflowRootActivity> = {}): WorkflowRootActivity => ({
	rootRunId: "run",
	ownerSessionId: "owner",
	state: "working",
	reason: "executing",
	activeExecutionCount: 1,
	actionableBlockCount: 0,
	needsAttention: false,
	graph: { nodes: [] },
	...overrides,
});

function harness() {
	let observer: WorkflowActivityObserver | undefined;
	let disposed = false;
	const session = {
		workflows: {
			observe: (next: WorkflowActivityObserver) => {
				observer = next;
				return {
					dispose: () => {
						disposed = true;
					},
				};
			},
		},
	} as unknown as AgentSession;
	const sent: InteractiveEngineMessage[] = [];
	const dispose = forwardWorkflowActivity(session, (message) => sent.push(message));
	return {
		sent,
		dispose,
		isDisposed: () => disposed,
		emit: (frame: WorkflowActivityFrame) => observer?.(frame),
	};
}

test("forwards workflow activity to the host without graphs and skips graph-only changes (#3556)", () => {
	const { sent, emit } = harness();
	emit({ kind: "snapshot", cursor, availability: "ready", roots: [root()] });
	emit({ kind: "changed", cursor, root: root({ graph: { nodes: [] }, activeExecutionCount: 1 }) });
	emit({
		kind: "changed",
		cursor,
		root: root({ state: "blocked", reason: "awaiting_input", actionableBlockCount: 1 }),
	});
	emit({ kind: "removed", cursor, rootRunId: "run" });
	emit({ kind: "snapshot", cursor, availability: "unavailable" });
	const { graph: _graph, ...summary } = root();
	assert.deepEqual(
		sent.map((message) => (message.type === "engine_workflow_activity" ? message.frame.kind : message.type)),
		["snapshot", "changed", "removed", "snapshot"],
	);
	const [first] = sent;
	assert.deepEqual(
		first?.type === "engine_workflow_activity" &&
			first.frame.kind === "snapshot" &&
			"roots" in first.frame &&
			first.frame.roots,
		[summary],
	);
});

test("stops forwarding once disposed (#3556)", () => {
	const { dispose, isDisposed } = harness();
	dispose();
	assert.equal(isDisposed(), true);
});

test("round-trips workflow activity frames through the engine protocol and rejects malformed ones (#3556)", () => {
	const { graph: _graph, ...summary } = root({ state: "blocked", reason: "awaiting_input", needsAttention: true });
	const frames: WorkflowActivityFrame[] = [
		{ kind: "snapshot", cursor, availability: "ready", roots: [summary] },
		{ kind: "snapshot", cursor, availability: "recovering" },
		{ kind: "changed", cursor, root: summary },
		{ kind: "removed", cursor, rootRunId: "run" },
	];
	for (const frame of frames) {
		const message: InteractiveEngineMessage = { type: "engine_workflow_activity", frame };
		assert.deepEqual(parseInteractiveEngineMessage(serializeInteractiveEngineMessage(message)), message);
	}
	const malformed = [
		{ kind: "changed", cursor, root: { ...summary, state: "sleeping" } },
		{ kind: "changed", cursor, root: { ...summary, needsAttention: "yes" } },
		{ kind: "snapshot", cursor, availability: "ready" },
		{ kind: "removed", cursor },
		{ kind: "other", cursor },
	];
	for (const frame of malformed) {
		assert.equal(
			parseInteractiveEngineMessage(JSON.stringify({ type: "engine_workflow_activity", frame })),
			undefined,
		);
	}
});
