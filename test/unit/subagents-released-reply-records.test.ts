import assert from "node:assert/strict";
import type { DetachedToolResult, ExtensionContext } from "@bastani/atomic";
import { test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import {
	createSubagentChildRecordSink,
	readSubagentChildRecords,
	recordSubagentChildReply,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";

const result: DetachedToolResult = {
	toolCallId: "call-1",
	toolName: "intercom",
	result: { content: [{ type: "text", text: "answer" }], details: {} },
	isError: false,
};

test("a released reply is acknowledged only after its result is saved once (#4326)", async () => {
	const sessionManager = SessionManager.inMemory("/repo");
	const ctx = { sessionManager } as never as ExtensionContext;
	let fail = false;
	let appends = 0;
	const pi = {
		async appendEntry<T>(type: string, data?: T) {
			appends++;
			if (fail) throw new Error("disk full");
			await sessionManager.appendCustomEntry(type, data);
		},
	};
	const sink = createSubagentChildRecordSink(pi, ctx);
	sink.record({
		runId: "run",
		index: 0,
		agent: "worker",
		cwd: "/repo",
		state: "terminal",
		terminalStatus: "released",
		waitingOn: [
			{ toolCallId: "call-1", toolName: "intercom", replyWait: { questionId: "q-1", deadline: 100, from: "peer" } },
		],
	});
	await sink.flushed?.();
	const ownerId = sessionManager.getSessionId();
	fail = true;
	await assert.rejects(recordSubagentChildReply(pi, ownerId, "run:0", "q-1", result, 50));
	assert.equal(readSubagentChildRecords(sessionManager.getEntries()).get("run:0")?.heldToolResults, undefined);
	fail = false;
	const beforeExpired = appends;
	assert.equal(
		await recordSubagentChildReply(pi, ownerId, "run:0", "q-1", result, 100),
		false,
		"the deadline has passed even before a timeout is handled",
	);
	assert.equal(appends, beforeExpired);
	assert.equal(await recordSubagentChildReply(pi, ownerId, "run:0", "q-1", result, 50), true);
	const after = appends;
	assert.equal(await recordSubagentChildReply(pi, ownerId, "run:0", "q-1", result, 50), false);
	assert.equal(await recordSubagentChildReply(pi, ownerId, "run:0", "q-1", result, 101), false);
	assert.equal(appends, after);
	assert.deepEqual(readSubagentChildRecords(sessionManager.getEntries()).get("run:0")?.heldToolResults, [result]);
});

test("a reply to a permanently ended child is refused without appending (#4326)", async () => {
	for (const terminalStatus of ["killed", "gone", "stage-closed"]) {
		const sessionManager = SessionManager.inMemory("/repo");
		let appends = 0;
		const pi = {
			async appendEntry<T>(type: string, data?: T) {
				appends++;
				await sessionManager.appendCustomEntry(type, data);
			},
		};
		const sink = createSubagentChildRecordSink(pi, { sessionManager } as never);
		sink.record({
			runId: `run-${terminalStatus}`,
			index: 0,
			agent: "worker",
			cwd: "/repo",
			state: "terminal",
			terminalStatus,
			waitingOn: [
				{
					toolCallId: "call-1",
					toolName: "intercom",
					replyWait: { questionId: "q-1", deadline: 100, from: "peer" },
				},
			],
		});
		await sink.flushed?.();
		const before = appends;
		assert.equal(
			await recordSubagentChildReply(
				pi,
				sessionManager.getSessionId(),
				`run-${terminalStatus}:0`,
				"q-1",
				result,
				50,
			),
			false,
		);
		assert.equal(appends, before);
	}
});
