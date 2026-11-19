/**
 * A subagent's chat asks on every frame whether its child is stopped or read-only. Each answer reads the child records
 * of the session that launched it; the session's entries are folded once per session state, not once per question.
 */

import assert from "node:assert/strict";
import { SessionManager } from "@bastani/atomic";
import { test, vi } from "vitest";
import {
	SUBAGENT_CHILD_RECORD_TYPE,
	type SubagentChildRecord,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.ts";
import { subagentChildOfTask } from "../../packages/subagents/src/runs/foreground/subagent-run-control.ts";

/** A long owner session: folding it per frame was the cost. */
const OWNER_ENTRIES = 5_000;
/** Frames of an open subagent chat, each asking about its child. */
const FRAMES = 200;

test("a subagent chat's per-frame child lookups fold the owner session once per session state", async () => {
	const manager = SessionManager.inMemory("/project");
	for (let index = 0; index < OWNER_ENTRIES; index++) {
		await manager.appendMessage({ role: "user", content: `turn ${index}`, timestamp: index });
	}
	const record = (taskId: string, state: SubagentChildRecord["state"]): SubagentChildRecord => ({
		version: 1,
		childId: "run-1:0",
		runId: "run-1",
		index: 0,
		agent: "worker",
		state,
		cwd: "/project",
		owner: { kind: "session", sessionId: manager.getSessionId() },
		taskId,
		...(state === "terminal" ? { terminalStatus: "killed" } : {}),
	});
	await manager.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, record("task-1", "running"));
	const ctx = { sessionManager: manager } as unknown as Parameters<typeof subagentChildOfTask>[0];
	const reads = vi.spyOn(manager, "getEntries");

	for (let frame = 0; frame < FRAMES; frame++) {
		assert.deepEqual(subagentChildOfTask(ctx, "task-1"), { childId: "run-1:0" });
	}
	assert.equal(reads.mock.calls.length, 1, "an unchanged session is folded once");

	await manager.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, record("task-1", "terminal"));
	for (let frame = 0; frame < FRAMES; frame++) {
		assert.equal(subagentChildOfTask(ctx, "task-1")?.readOnlyReason !== undefined, true);
	}
	assert.equal(reads.mock.calls.length, 2, "an appended record is read on the next question");
});

test("a session manager without sequence, leaf or history accessors still answers from its current entries", () => {
	const entries: Array<{ type: string; id: string; customType?: string; data?: unknown }> = [];
	const manager = { getSessionId: () => "owner-session", getEntries: () => entries };
	const record = (taskId: string, state: SubagentChildRecord["state"]): SubagentChildRecord => ({
		version: 1,
		childId: "run-1:0",
		runId: "run-1",
		index: 0,
		agent: "worker",
		state,
		cwd: "/project",
		owner: { kind: "session", sessionId: "owner-session" },
		taskId,
		...(state === "terminal" ? { terminalStatus: "killed" } : {}),
	});
	const append = (data: SubagentChildRecord) =>
		entries.push({ type: "custom", id: `entry-${entries.length}`, customType: SUBAGENT_CHILD_RECORD_TYPE, data });
	const ctx = { sessionManager: manager } as unknown as Parameters<typeof subagentChildOfTask>[0];

	append(record("task-1", "running"));
	assert.deepEqual(subagentChildOfTask(ctx, "task-1"), { childId: "run-1:0" });

	append(record("task-1", "terminal"));
	assert.equal(subagentChildOfTask(ctx, "task-1")?.readOnlyReason !== undefined, true);
});
