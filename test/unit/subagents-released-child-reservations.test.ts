import assert from "node:assert/strict";
import type { ExtensionContext } from "@bastani/atomic";
import { test, vi } from "vitest";
import { AgentWakeDispatcher } from "../../packages/coding-agent/src/core/agent-wake-dispatcher.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { ReleasedChildReservationError } from "../../packages/intercom/broker/released-child-errors.js";
import {
	acknowledgeReleasedChildWake,
	dropReleasedChildren,
	INTERCOM_CONNECTED_EVENT,
	type ReleasedChildReservation,
	releasedChildReservation,
	reserveReleasedChildren,
	reserveReleasedChildrenOf,
	SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT,
	SUBAGENT_DROP_RELEASED_CHILDREN_EVENT,
	SUBAGENT_HOLD_FAILURE_EVENT,
	SUBAGENT_HOLD_RECOVERED_EVENT,
	SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT,
} from "../../packages/subagents/src/runs/foreground/released-child-reservations.js";
import { bindReleasedChildWakes } from "../../packages/subagents/src/runs/foreground/released-child-wakes.js";
import { observeSubagentChildRecord } from "../../packages/subagents/src/runs/foreground/subagent-child-card-state.js";
import {
	createSubagentChildRecordSink,
	SUBAGENT_CHILD_RELEASED_STATUS,
	SUBAGENT_CHILD_STAGE_PAUSED_STATUS,
	type SubagentChildRecord,
	subagentChildRecordFailures,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import type { SubagentChildRestoreDeps } from "../../packages/subagents/src/runs/foreground/subagent-child-restore.js";
import { subagentChildrenAwaitingResume } from "../../packages/subagents/src/runs/foreground/subagent-run-control.js";
import type { IntercomEventBus } from "../../packages/subagents/src/shared/types.js";
import { SUBAGENT_COMPLETE_EVENT } from "../../packages/subagents/src/shared/types.js";

function bus() {
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
			if (channel !== SUBAGENT_HOLD_RECOVERED_EVENT) emitted.push({ channel, data: data as object });
			for (const handler of listeners.get(channel) ?? []) handler(data as object);
		},
	};
	return { events, emitted, listeners };
}

function record(overrides: Partial<SubagentChildRecord> = {}): SubagentChildRecord {
	return {
		version: 1,
		childId: "run:0",
		runId: "run",
		index: 0,
		agent: "worker",
		state: "terminal",
		terminalStatus: SUBAGENT_CHILD_RELEASED_STATUS,
		cwd: "/repo",
		owner: { kind: "session", sessionId: "owner" },
		intercomTarget: "subagent-worker-run-1",
		childSessionId: "child-session",
		waitingOn: [{ toolCallId: "ci-1", toolName: "wait_for_ci" }],
		...overrides,
	};
}

test("a released child is reserved to wake its owner, a child stopped while it waited is parked, and no other child is reserved (#4326)", () => {
	assert.deepEqual(releasedChildReservation(record({ releasedIntercomId: "icom-1", intercomGroup: "lane" })), {
		childName: "subagent-worker-run-1",
		group: "lane",
		aliases: ["child-session", "icom-1"],
		wake: true,
	});
	for (const status of ["paused", "quit", SUBAGENT_CHILD_STAGE_PAUSED_STATUS])
		assert.equal(releasedChildReservation(record({ terminalStatus: status }))?.wake, false, status);
	assert.equal(releasedChildReservation(record({ terminalStatus: "paused", waitingOn: [] })), undefined);
	assert.equal(releasedChildReservation(record({ terminalStatus: "ok" })), undefined);
	assert.equal(releasedChildReservation(record({ state: "running", terminalStatus: undefined })), undefined);
	assert.equal(releasedChildReservation(record({ intercomTarget: undefined })), undefined);
	assert.deepEqual(releasedChildReservation(record({ childSessionId: undefined }))?.aliases, []);
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
		} = record({
			runId: `run${index}`,
			index: 0,
			intercomTarget: `subagent-worker-run${index}-1`,
			childSessionId: `child-${index}`,
			...overrides,
		});
		sink.record(input);
	}
	await sink.flushed?.();
	return { ctx, ownerSessionId };
}

test("every released and parked child of an owner is reserved in one request, whatever their number (#4326)", async () => {
	const many = Array.from({ length: 1_201 }, () => ({}));
	const { ownerSessionId } = await ownerWith([
		...many,
		{ terminalStatus: "paused" },
		{ terminalStatus: "ok" },
		{ state: "running", terminalStatus: undefined, waitingOn: undefined },
	]);
	const { events, emitted } = bus();

	await reserveReleasedChildrenOf(events, ownerSessionId);

	assert.equal(emitted.length, 1, "one request, not one per child");
	const [request] = emitted;
	assert.ok(request);
	const children = (request.data as { children: ReleasedChildReservation[] }).children;
	assert.equal(request.channel, SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT);
	assert.equal(children.length, 1_202);
	assert.equal(children.filter((child) => child.wake).length, 1_201);
	assert.equal(children.filter((child) => !child.wake).length, 1);
});

test("a binding reserves the owner's released children when it starts and again at every reconnect, and stops with it (#4326)", async () => {
	const { ctx, ownerSessionId } = await ownerWith([{}, { terminalStatus: "quit" }]);
	const { events, emitted, listeners } = bus();
	const reserves = () => emitted.filter((entry) => entry.channel === SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT);

	const stop = bindReleasedChildWakes({} as SubagentChildRestoreDeps, ctx, events, new AgentWakeDispatcher());
	assert.equal(reserves().length, 1, "at start");
	const [atStart] = reserves();
	assert.ok(atStart);
	assert.equal((atStart.data as { children: unknown[] }).children.length, 2, ownerSessionId);

	for (const handler of listeners.get(INTERCOM_CONNECTED_EVENT) ?? []) handler({ sessionId: "icom" });
	assert.equal(reserves().length, 2, "after a reconnect the broker has forgotten them");

	stop();
	assert.equal((listeners.get(INTERCOM_CONNECTED_EVENT) ?? []).length, 0);
});

test("dropping and acknowledging name the children, and a request to nobody changes nothing (#4326)", async () => {
	const { events, emitted } = bus();
	await reserveReleasedChildren(events, []);
	await dropReleasedChildren(events, []);
	assert.equal(emitted.length, 0);

	await dropReleasedChildren(events, ["a", "b"], { gone: "its stage ended" });
	await acknowledgeReleasedChildWake(events, "a");
	assert.deepEqual(emitted, [
		{ channel: SUBAGENT_DROP_RELEASED_CHILDREN_EVENT, data: { childNames: ["a", "b"], gone: "its stage ended" } },
		{ channel: SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT, data: { childName: "a" } },
	]);
});

test("a broker refusal of a released child's reservation appears in status and notifies the owner once (#4326)", async () => {
	const { ctx } = await ownerWith([{ waitingOn: [] }]);
	const { events, emitted } = bus();
	const refusal = new ReleasedChildReservationError({ code: "not_owner", childName: "subagent-worker-run0-1" });
	let rejectReservation = true;
	events.on(SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT, (data) => {
		(data as { completion?: Promise<void> }).completion = rejectReservation
			? Promise.reject(refusal)
			: Promise.resolve();
	});
	const stop = bindReleasedChildWakes({} as SubagentChildRestoreDeps, ctx, events, new AgentWakeDispatcher());
	try {
		await vi.waitFor(() =>
			assert.equal(emitted.filter((item) => item.channel === SUBAGENT_COMPLETE_EVENT).length, 1),
		);
		assert.equal(subagentChildRecordFailures.last?.code, "hold-failed");
		assert.equal(subagentChildRecordFailures.last?.cause, refusal);
		assert.equal(subagentChildRecordFailures.last?.fields.childId, "run0:0");
		const status = subagentChildrenAwaitingResume(ctx).join("\n");
		assert.match(status, /run0:0.*hold-failed/);
		assert.match(status, /Intercom/);
		events.emit(INTERCOM_CONNECTED_EVENT, {});
		await vi.waitFor(() =>
			assert.equal(emitted.filter((item) => item.channel === SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT).length, 2),
		);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(emitted.filter((item) => item.channel === SUBAGENT_COMPLETE_EVENT).length, 1);
		rejectReservation = false;
		events.emit(INTERCOM_CONNECTED_EVENT, {});
		await new Promise((resolve) => setImmediate(resolve));
		rejectReservation = true;
		events.emit(INTERCOM_CONNECTED_EVENT, {});
		await vi.waitFor(() =>
			assert.equal(emitted.filter((item) => item.channel === SUBAGENT_COMPLETE_EVENT).length, 2),
		);
	} finally {
		stop();
	}
});

test("a failed reservation of thousands of children finds them by name in one pass over the owner's records (#4326)", async () => {
	const { ctx, ownerSessionId } = await ownerWith([]);
	const { events, emitted } = bus();
	events.on(SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT, (data) => {
		(data as { completion?: Promise<void> }).completion = Promise.resolve();
	});
	const stop = bindReleasedChildWakes({} as SubagentChildRestoreDeps, ctx, events, new AgentWakeDispatcher());
	try {
		const children = 2_000;
		let targetReads = 0;
		const names: string[] = [];
		for (let index = 0; index < children; index++) {
			const name = `subagent-bulk-${index}`;
			const bulk = record({
				childId: `bulk:${index}`,
				runId: "bulk",
				index,
				owner: { kind: "session", sessionId: ownerSessionId },
			});
			Object.defineProperty(bulk, "intercomTarget", {
				enumerable: true,
				get: () => {
					targetReads++;
					return name;
				},
			});
			observeSubagentChildRecord(bulk);
			names.push(name);
		}
		targetReads = 0;
		events.emit(SUBAGENT_HOLD_FAILURE_EVENT, { childNames: names, error: new Error("broker gone") });
		assert.ok(targetReads <= 2 * children, `${targetReads} target reads for ${children} failed reservations`);
		await vi.waitFor(() =>
			assert.equal(emitted.filter((item) => item.channel === SUBAGENT_COMPLETE_EVENT).length, 1),
		);
		assert.equal(subagentChildRecordFailures.last?.code, "hold-failed");
	} finally {
		stop();
	}
});

for (const operation of ["drop", "acknowledge"] as const) {
	test(`a failed ${operation} reports hold-failed to the owner (#4326)`, async () => {
		const { ctx } = await ownerWith([{ waitingOn: [] }]);
		const { events, emitted } = bus();
		const refusal = new ReleasedChildReservationError({ code: "not_owner", childName: "subagent-worker-run0-1" });
		const channel =
			operation === "drop" ? SUBAGENT_DROP_RELEASED_CHILDREN_EVENT : SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT;
		events.on(channel, (data) => {
			(data as { completion?: Promise<void> }).completion = Promise.reject(refusal);
		});
		const stop = bindReleasedChildWakes({} as SubagentChildRestoreDeps, ctx, events, new AgentWakeDispatcher());
		try {
			await new Promise((resolve) => setImmediate(resolve));
			if (operation === "drop") await dropReleasedChildren(events, ["subagent-worker-run0-1"]);
			else await acknowledgeReleasedChildWake(events, "subagent-worker-run0-1");
			assert.equal(subagentChildRecordFailures.last?.cause, refusal);
			assert.match(subagentChildrenAwaitingResume(ctx).join("\n"), /run0:0.*hold-failed/);
			assert.equal(emitted.filter((item) => item.channel === SUBAGENT_COMPLETE_EVENT).length, 1);
		} finally {
			stop();
		}
	});
}

test("a reservation, drop or acknowledgement after the launching session closed throws nothing and reports nothing (#4326)", async () => {
	const sessionClosed = () => Object.assign(new Error("SessionClosed"), { code: "SessionClosed" });
	const closed: IntercomEventBus = {
		on: () => () => {},
		emit() {
			throw sessionClosed();
		},
	};
	const refusedThenClosed: IntercomEventBus = {
		on: () => () => {},
		emit(channel, data) {
			if (channel === SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT) {
				(data as { completion?: Promise<void> }).completion = Promise.reject(new Error("broker refused"));
				return;
			}
			throw sessionClosed();
		},
	};
	const reported = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		const child = { childName: "gone-child", aliases: [], wake: true };
		await reserveReleasedChildren(closed, [child]);
		await dropReleasedChildren(closed, ["gone-child"]);
		await acknowledgeReleasedChildWake(closed, "gone-child");
		await reserveReleasedChildren(refusedThenClosed, [child]);
		assert.equal(reported.mock.calls.length, 0);
	} finally {
		reported.mockRestore();
	}
});
