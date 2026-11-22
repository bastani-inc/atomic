import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentViewStatus } from "../src/modes/interactive/agent-view/contracts.ts";
import {
	parseInteractiveEngineMessage,
	serializeInteractiveEngineMessage,
} from "../src/modes/interactive-engine/protocol.ts";

const status: AgentViewStatus = {
	taskId: "task-1" as AgentViewStatus["taskId"],
	agentKey: "task-1",
	name: "worker",
	ruleLabel: "worker",
	placeholder: "Message @worker…",
	state: "running",
	busy: true,
	paused: false,
	retrying: false,
	queued: { steering: [], followUp: [] },
	heldPrompt: false,
	gone: false,
};

function parsed(value: object) {
	return parseInteractiveEngineMessage(
		serializeInteractiveEngineMessage({
			type: "engine_agent_view_status",
			viewId: "v1",
			status: value as AgentViewStatus,
		}).trim(),
	);
}

test("a subagent view's status carries the queued messages shown but not seen saved, and a status without them is read as before", () => {
	assert.deepEqual(parsed({ ...status, unsaved: ["shown"] }), {
		type: "engine_agent_view_status",
		viewId: "v1",
		status: { ...status, unsaved: ["shown"] },
	});
	assert.deepEqual(parsed(status), { type: "engine_agent_view_status", viewId: "v1", status });
	assert.equal(parsed({ ...status, unsaved: [3] }), undefined, "a malformed list is not a status");
});

test("a subagent view's status carries the receipts of what it took, and receipts not as an engine writes them are left out", () => {
	const receipts = { sessionId: "child", taken: [{ id: "r1", after: 4, local: true }, null] };
	assert.deepEqual(parsed({ ...status, unsaved: ["shown"], receipts }), {
		type: "engine_agent_view_status",
		viewId: "v1",
		status: { ...status, unsaved: ["shown"], receipts },
	});
	// Its messages are then reported as unconfirmed, as an engine without receipts has them.
	assert.deepEqual(parsed({ ...status, unsaved: ["shown"], receipts: { sessionId: "child", taken: [{ id: 3 }] } }), {
		type: "engine_agent_view_status",
		viewId: "v1",
		status: { ...status, unsaved: ["shown"] },
	});
});

test("a subagent view's status carries its session identity across the protocol, and malformed identity fields are stripped", () => {
	assert.deepEqual(parsed({ ...status, sessionId: "child-1", sessionFile: "/tmp/child-1.jsonl" }), {
		type: "engine_agent_view_status",
		viewId: "v1",
		status: { ...status, sessionId: "child-1", sessionFile: "/tmp/child-1.jsonl" },
	});
	// Malformed identity fields fall back safely to notice-only without rejecting the status update.
	assert.deepEqual(parsed({ ...status, sessionId: 42, sessionFile: "/tmp/child-1.jsonl" }), {
		type: "engine_agent_view_status",
		viewId: "v1",
		status,
	});
	assert.deepEqual(parsed({ ...status, sessionId: "child-1", sessionFile: 99 }), {
		type: "engine_agent_view_status",
		viewId: "v1",
		status,
	});
});

test("engine_agent_queue_invalidated parses valid child invalidation reasons and rejects malformed frames", () => {
	const raw = serializeInteractiveEngineMessage({
		type: "engine_agent_queue_invalidated",
		sessionId: "child-1",
		sessionFile: "/tmp/child-1.jsonl",
		reason: "sent-elsewhere",
	} as never).trim();
	assert.deepEqual(parseInteractiveEngineMessage(raw), {
		type: "engine_agent_queue_invalidated",
		sessionId: "child-1",
		sessionFile: "/tmp/child-1.jsonl",
		reason: "sent-elsewhere",
	});
	assert.equal(
		parseInteractiveEngineMessage(
			JSON.stringify({ type: "engine_agent_queue_invalidated", sessionId: "child-1", reason: "unknown" }),
		),
		undefined,
	);
});
