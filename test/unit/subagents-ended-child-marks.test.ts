import assert from "node:assert/strict";
import type { ExtensionContext } from "@bastani/atomic";
import { afterEach, test, vi } from "vitest";
import { AgentWakeDispatcher } from "../../packages/coding-agent/src/core/agent-wake-dispatcher.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SUBAGENT_ENDED_OUTCOMES } from "../../packages/intercom/broker/recipient-gone-errors.js";
import {
	SUBAGENT_MARK_ENDED_CHILDREN_EVENT as INTERCOM_MARK_ENDED_CHILDREN_EVENT,
	isMarkEndedChildrenRequest,
} from "../../packages/intercom/session-recovery.js";
import {
	type EndedChildMark,
	endedChildMark,
	INTERCOM_CONNECTED_EVENT,
	markEndedChildren,
	markEndedChildrenOf,
	SUBAGENT_MARK_ENDED_CHILDREN_EVENT,
} from "../../packages/subagents/src/runs/foreground/released-child-reservations.js";
import { bindReleasedChildWakes } from "../../packages/subagents/src/runs/foreground/released-child-wakes.js";
import {
	createSubagentChildRecordSink,
	SUBAGENT_CHILD_RELEASED_STATUS,
	SUBAGENT_CHILD_STAGE_CLOSED_STATUS,
	SUBAGENT_CHILD_STAGE_PAUSED_STATUS,
	type SubagentChildRecord,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import type { SubagentChildRestoreDeps } from "../../packages/subagents/src/runs/foreground/subagent-child-restore.js";
import type { IntercomEventBus } from "../../packages/subagents/src/shared/types.js";

afterEach(() => {
	vi.restoreAllMocks();
});

const CHILD_SESSION_ID = "01a1c1d9-bebd-73e1-a79d-668cf0bd43b8";

function bus(answer?: (data: { completion?: Promise<void> }) => void) {
	const emitted: Array<{ channel: string; data: object }> = [];
	const listeners = new Map<string, Array<(data: object) => void>>();
	const events: IntercomEventBus = {
		on(channel, handler) {
			listeners.set(channel, [...(listeners.get(channel) ?? []), handler]);
			return () =>
				listeners.set(
					channel,
					(listeners.get(channel) ?? []).filter((candidate) => candidate !== handler),
				);
		},
		emit(channel, data) {
			emitted.push({ channel, data: data as object });
			if (channel === SUBAGENT_MARK_ENDED_CHILDREN_EVENT) answer?.(data as { completion?: Promise<void> });
			for (const handler of listeners.get(channel) ?? []) handler(data as object);
		},
	};
	return { events, emitted, listeners };
}

function record(overrides: Partial<SubagentChildRecord> = {}): SubagentChildRecord {
	return {
		version: 1,
		childId: "aabcf28b:0",
		runId: "aabcf28b",
		index: 0,
		agent: "worker",
		state: "terminal",
		terminalStatus: "ok",
		cwd: "/repo",
		owner: { kind: "session", sessionId: "owner" },
		intercomTarget: "subagent-worker-aabcf28b-1",
		childSessionId: CHILD_SESSION_ID,
		...overrides,
	};
}

test("a child whose last run ended is reported with why, its ids and the id resume takes (#4639)", () => {
	assert.deepEqual(endedChildMark(record({ intercomGroup: "workflow:run", releasedIntercomId: "icom-1" })), {
		childName: "subagent-worker-aabcf28b-1",
		group: "workflow:run",
		aliases: [CHILD_SESSION_ID, "icom-1"],
		outcome: "completed",
		childId: "aabcf28b:0",
	});
	const outcomes = Object.fromEntries(
		[
			"ok",
			"error",
			"interrupted",
			"paused",
			"quit",
			SUBAGENT_CHILD_STAGE_PAUSED_STATUS,
			"killed",
			SUBAGENT_CHILD_STAGE_CLOSED_STATUS,
		].map((status) => [status, endedChildMark(record({ terminalStatus: status }))?.outcome]),
	);
	assert.deepEqual(outcomes, {
		ok: "completed",
		error: "failed",
		interrupted: "stopped",
		paused: "stopped",
		quit: "stopped",
		[SUBAGENT_CHILD_STAGE_PAUSED_STATUS]: "stopped",
		killed: "cancelled",
		[SUBAGENT_CHILD_STAGE_CLOSED_STATUS]: "cancelled",
	});
	assert.deepEqual(endedChildMark(record({ childSessionId: undefined }))?.aliases, []);
	assert.equal("group" in (endedChildMark(record()) ?? {}), false, "no group key unless the record has one");
});

test("the subagents and intercom packages agree on the report's event and outcomes (#4639)", () => {
	assert.equal(SUBAGENT_MARK_ENDED_CHILDREN_EVENT, "subagent:mark-ended-children");
	assert.equal(INTERCOM_MARK_ENDED_CHILDREN_EVENT, SUBAGENT_MARK_ENDED_CHILDREN_EVENT);
	const reported = new Set(
		["ok", "error", "paused", "killed"].map((status) => endedChildMark(record({ terminalStatus: status }))?.outcome),
	);
	assert.deepEqual([...reported].sort(), [...SUBAGENT_ENDED_OUTCOMES].sort());
	const mark = endedChildMark(record({ intercomGroup: "lane" })) as EndedChildMark;
	assert.ok(isMarkEndedChildrenRequest({ children: [mark] }), "what Subagents reports, Intercom accepts");
	assert.ok(isMarkEndedChildrenRequest({ children: [] }));
	for (const invalid of [
		undefined,
		null,
		"x",
		{},
		{ children: {} },
		{ children: [null] },
		{ children: ["x"] },
		{ children: [{ childName: "a", outcome: 3 }] },
		{ children: [{ childName: "a", outcome: "completed", aliases: ["x", 1] }] },
		{ children: [{ childName: "a", outcome: "completed", group: 1 }] },
		{ children: [{ childName: "a", outcome: "completed", childId: 1 }] },
	])
		assert.equal(isMarkEndedChildrenRequest(invalid), false, JSON.stringify(invalid));
	assert.ok(isMarkEndedChildrenRequest({ children: [{ childName: "a", outcome: "stopped", aliases: ["x"] }] }));
});

test("a running, released, parked, gone or unnamed child is not reported ended (#4639)", () => {
	assert.equal(endedChildMark(record({ state: "running" })), undefined);
	assert.equal(endedChildMark(record({ intercomTarget: undefined })), undefined);
	assert.equal(endedChildMark(record({ terminalStatus: SUBAGENT_CHILD_RELEASED_STATUS })), undefined);
	assert.equal(endedChildMark(record({ terminalStatus: "gone" })), undefined);
	assert.equal(endedChildMark(record({ terminalStatus: undefined })), undefined);
	const parked = record({ terminalStatus: "quit", waitingOn: [{ toolCallId: "ci-1", toolName: "wait_for_ci" }] });
	assert.equal(endedChildMark(parked), undefined, "a child stopped while it waited is held for, not refused");
});

test("ended children are reported in one request, and an empty report sends nothing (#4639)", async () => {
	const { events, emitted } = bus();
	await markEndedChildren(events, []);
	assert.deepEqual(emitted, []);
	const mark = endedChildMark(record()) as EndedChildMark;
	await markEndedChildren(events, [mark]);
	assert.deepEqual(emitted, [{ channel: SUBAGENT_MARK_ENDED_CHILDREN_EVENT, data: { children: [mark] } }]);
});

test("a failed report is logged once, and a report to a closed launching session is dropped quietly (#4639)", async () => {
	const logged = vi.spyOn(console, "error").mockImplementation(() => {});
	const mark = endedChildMark(record()) as EndedChildMark;
	const failing = bus((data) => {
		data.completion = Promise.reject(new Error("broker refused"));
	});
	await markEndedChildren(failing.events, [mark, { ...mark, childName: "subagent-worker-other-1" }]);
	assert.equal(logged.mock.calls.length, 1);
	assert.equal(
		String(logged.mock.calls[0]?.[0]),
		"Subagent end report failed (subagent-worker-aabcf28b-1, subagent-worker-other-1); sends to them answer Session not found: broker refused",
	);

	const closed = bus((data) => {
		data.completion = Promise.reject(Object.assign(new Error("session closed"), { code: "SessionClosed" }));
	});
	await markEndedChildren(closed.events, [mark]);
	assert.equal(logged.mock.calls.length, 1);
});

async function ownerWith(records: Array<Partial<SubagentChildRecord>>) {
	const sessionManager = SessionManager.inMemory("/repo");
	const ctx = { sessionManager } as unknown as ExtensionContext;
	const ownerSessionId = sessionManager.getSessionId();
	const sink = createSubagentChildRecordSink(
		{ appendEntry: async (type, data) => void (await sessionManager.appendCustomEntry(type, data)) },
		ctx,
	);
	for (const [index, overrides] of records.entries()) {
		const {
			childId: _childId,
			owner: _owner,
			version: _version,
			...input
		} = record({ runId: `run${index}`, index: 0, intercomTarget: `subagent-worker-run${index}-1`, ...overrides });
		sink.record(input);
	}
	await sink.flushed?.();
	return { ctx, ownerSessionId };
}

test("every ended child of an owner is reported in one request, at start and after each reconnect (#4639)", async () => {
	const { ctx, ownerSessionId } = await ownerWith([
		{ terminalStatus: "ok" },
		{ terminalStatus: "killed" },
		{ terminalStatus: SUBAGENT_CHILD_RELEASED_STATUS, waitingOn: [{ toolCallId: "c", toolName: "bash" }] },
		{ state: "running", terminalStatus: undefined },
	]);
	const direct = bus();
	await markEndedChildrenOf(direct.events, ownerSessionId);
	assert.equal(direct.emitted.length, 1);
	const children = (direct.emitted[0]!.data as { children: EndedChildMark[] }).children;
	assert.deepEqual(
		children.map((child) => [child.childName, child.outcome, child.childId]),
		[
			["subagent-worker-run0-1", "completed", "run0:0"],
			["subagent-worker-run1-1", "cancelled", "run1:0"],
		],
	);

	const { events, emitted, listeners } = bus();
	const marks = () => emitted.filter((entry) => entry.channel === SUBAGENT_MARK_ENDED_CHILDREN_EVENT);
	const stop = bindReleasedChildWakes({} as SubagentChildRestoreDeps, ctx, events, new AgentWakeDispatcher());
	assert.equal(marks().length, 1, "at start");
	for (const handler of listeners.get(INTERCOM_CONNECTED_EVENT) ?? []) handler({ sessionId: "icom" });
	assert.equal(marks().length, 2, "after a reconnect the broker has forgotten them");
	stop();
});
