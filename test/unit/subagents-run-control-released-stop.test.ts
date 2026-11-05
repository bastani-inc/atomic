import assert from "node:assert/strict";
import type { ExtensionContext } from "@bastani/atomic";
import { test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT } from "../../packages/subagents/src/runs/foreground/released-child-reservations.js";
import {
	SUBAGENT_CHILD_RECORD_TYPE,
	SUBAGENT_CHILD_RELEASED_STATUS,
	type SubagentChildRecord,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import type { SubagentChildRestoreDeps } from "../../packages/subagents/src/runs/foreground/subagent-child-restore.js";
import { controlSubagentChildren } from "../../packages/subagents/src/runs/foreground/subagent-run-control.js";

async function stopReleased(waitingOn: SubagentChildRecord["waitingOn"], runId: string) {
	const sessionManager = SessionManager.inMemory("/repo");
	const sessionId = sessionManager.getSessionId();
	const record: SubagentChildRecord = {
		version: 1,
		childId: `${runId}:0`,
		runId,
		index: 0,
		agent: "worker",
		state: "terminal",
		terminalStatus: SUBAGENT_CHILD_RELEASED_STATUS,
		cwd: "/repo",
		owner: { kind: "session", sessionId },
		intercomTarget: `subagent-worker-${runId}`,
		childSessionId: `${runId}-session`,
		...(waitingOn ? { waitingOn } : {}),
	};
	await sessionManager.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, record);
	const emitted: Array<{ channel: string; data: { children?: Array<{ childName: string; wake: boolean }> } }> = [];
	const deps = {
		pi: {
			events: {
				on: () => () => undefined,
				emit: (channel: string, data: object) => emitted.push({ channel, data }),
			},
			appendEntry: async (type: string, data?: SubagentChildRecord) => {
				await sessionManager.appendCustomEntry(type, data);
			},
			getSessionName: () => "parent",
		},
	} as unknown as SubagentChildRestoreDeps;
	const ctx = { cwd: "/repo", sessionManager } as unknown as ExtensionContext;
	const result = await controlSubagentChildren(deps, ctx, { action: "pause", id: record.childId });
	return { result, emitted };
}

test("pausing a released child that waits on a call parks it at the broker (#4326)", async () => {
	const { result, emitted } = await stopReleased([{ toolCallId: "ci-1", toolName: "wait_for_ci" }], "rc-parked");
	assert.notEqual(result.isError, true);
	assert.deepEqual(
		emitted
			.filter((event) => event.channel === SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT)
			.map((event) => event.data.children),
		[[{ childName: "subagent-worker-rc-parked", aliases: ["rc-parked-session"], wake: false }]],
	);
});

test("pausing a released child that waits on nothing reserves nothing (#4326)", async () => {
	const { result, emitted } = await stopReleased([], "rc-nothing");
	assert.notEqual(result.isError, true);
	assert.deepEqual(
		emitted.filter((event) => event.channel === SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT),
		[],
	);
});
