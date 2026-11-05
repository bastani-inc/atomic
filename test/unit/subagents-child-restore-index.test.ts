import assert from "node:assert/strict";
import type { ExtensionContext } from "@bastani/atomic";
import { test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { observeSubagentChildRecord } from "../../packages/subagents/src/runs/foreground/subagent-child-card-state.js";
import type { SubagentChildRecord } from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import {
	restoreSubagentChild,
	type SubagentChildRestoreDeps,
} from "../../packages/subagents/src/runs/foreground/subagent-child-restore.js";

test("a child the owner's index holds is restored from the index, not from a rescan of the session (#4326)", async () => {
	const sessionManager = SessionManager.inMemory("/repo");
	const ownerSessionId = sessionManager.getSessionId();
	const record: SubagentChildRecord = {
		version: 1,
		childId: "ri-run:0",
		runId: "ri-run",
		index: 0,
		agent: "worker",
		state: "terminal",
		terminalStatus: "ok",
		cwd: "/repo",
		owner: { kind: "session", sessionId: ownerSessionId },
	};
	observeSubagentChildRecord(record);
	const ctx = { cwd: "/repo", sessionManager } as unknown as ExtensionContext;

	const outcome = await restoreSubagentChild({} as SubagentChildRestoreDeps, ctx, "ri-run:0");

	assert.equal(outcome.kind, "terminal");
	assert.ok(outcome.kind === "terminal");
	assert.equal(outcome.record.childId, "ri-run:0");
});

test("a child neither the index nor the session knows is unrestorable (#4326)", async () => {
	const sessionManager = SessionManager.inMemory("/repo");
	const ctx = { cwd: "/repo", sessionManager } as unknown as ExtensionContext;

	const outcome = await restoreSubagentChild({} as SubagentChildRestoreDeps, ctx, "ri-missing:0");

	assert.deepEqual(outcome, {
		kind: "unrestorable",
		childId: "ri-missing:0",
		reason: "this session has no record of that subagent",
	});
});
