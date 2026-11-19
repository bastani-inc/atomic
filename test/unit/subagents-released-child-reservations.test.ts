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
	type ReleasedChildHoldFailure,
	type ReleasedChildHoldRecovery,
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
import {
	observeSubagentChildRecord,
	subagentChildIndexEntry,
} from "../../packages/subagents/src/runs/foreground/subagent-child-card-state.js";
import {
	createSubagentChildRecordSink,
	SUBAGENT_CHILD_RELEASED_STATUS,
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
	for (const status of ["paused", "quit"])
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

test("every released and parked child of an owner is reserved in one request per broker frame, whatever their number (#4326, #5551)", async () => {
	const many = Array.from({ length: 1_201 }, () => ({}));
	const { ownerSessionId } = await ownerWith([
		...many,
		{ terminalStatus: "paused" },
		{ terminalStatus: "ok" },
		{ state: "running", terminalStatus: undefined, waitingOn: undefined },
	]);
	const { events, emitted } = bus();

	await reserveReleasedChildrenOf(events, ownerSessionId);

	// The broker refuses a frame whole: one request per frame tells which children a failure leaves without a hold.
	assert.deepEqual(
		emitted.map((request) => [
			request.channel,
			(request.data as { children: ReleasedChildReservation[] }).children.length,
		]),
		[
			[SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT, 500],
			[SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT, 500],
			[SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT, 202],
		],
		"one request per frame, not one per child",
	);
	const children = emitted.flatMap((request) => (request.data as { children: ReleasedChildReservation[] }).children);
	assert.equal(new Set(children.map((child) => child.childName)).size, 1_202);
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

	await dropReleasedChildren(events, ["a", "b"], { gone: "its owner disconnected" });
	await acknowledgeReleasedChildWake(events, "a");
	assert.deepEqual(emitted, [
		{
			channel: SUBAGENT_DROP_RELEASED_CHILDREN_EVENT,
			data: { childNames: ["a", "b"], gone: "its owner disconnected" },
		},
		{ channel: SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT, data: { childName: "a" } },
	]);
});

test.each(["another release", "an unanswered reservation"] as const)(
	"%s never hides a current wake confirmation refusal (#5641)",
	async (scenario) => {
		const { events, emitted } = bus();
		const reply = Promise.withResolvers<void>();
		events.on(SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT, (data) => {
			(data as { completion?: Promise<void> }).completion = reply.promise;
		});
		events.on(SUBAGENT_HOLD_FAILURE_EVENT, (data) => {
			(data as ReleasedChildHoldFailure).handled = true;
		});
		if (scenario === "another release")
			events.on(SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT, (data) => {
				(data as { completion?: Promise<void> }).completion = Promise.resolve();
			});
		const current = acknowledgeReleasedChildWake(events, "child", "task-2");
		const taskId = scenario === "another release" ? "task-1" : "task-2";
		await reserveReleasedChildren(events, [{ childName: "child", taskId, aliases: [], wake: true }]);
		reply.reject(new Error("No hold for task-2"));
		await current;
		assert.equal(emitted.filter(({ channel }) => channel === SUBAGENT_HOLD_FAILURE_EVENT).length, 1);
	},
);

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

test("a released child's reservation failure notice and status state its code and hint once (#5551)", async () => {
	const { ctx } = await ownerWith([{ waitingOn: [] }]);
	const { events, emitted } = bus();
	events.on(SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT, (data) => {
		(data as { completion?: Promise<void> }).completion = Promise.reject(new Error("Not connected"));
	});
	const stop = bindReleasedChildWakes({} as SubagentChildRestoreDeps, ctx, events, new AgentWakeDispatcher());
	try {
		await vi.waitFor(() =>
			assert.equal(emitted.filter((item) => item.channel === SUBAGENT_COMPLETE_EVENT).length, 1),
		);
		const notice = emitted.find((item) => item.channel === SUBAGENT_COMPLETE_EVENT)?.data as { summary: string };
		const once =
			"Sends to released subagent subagent-worker-run0-1 cannot be held (hold-failed). Check that Intercom is connected; until the reservation exists, sends to this subagent are answered as not found.";
		assert.equal(notice.summary, once);
		const status = subagentChildrenAwaitingResume(ctx);
		assert.equal(status.at(-1), `Subagent run0:0: ${once}`);
	} finally {
		stop();
	}
});

test("a failure that leaves several released subagents without a hold names each of them, in one notice (#5551)", async () => {
	const { ctx } = await ownerWith([{}, {}, { terminalStatus: "ok", waitingOn: undefined }]);
	const { events, emitted } = bus();
	events.on(SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT, (data) => {
		(data as { completion?: Promise<void> }).completion = Promise.reject(new Error("Not connected"));
	});
	const stop = bindReleasedChildWakes({} as SubagentChildRestoreDeps, ctx, events, new AgentWakeDispatcher());
	try {
		await reserveReleasedChildren(events, [
			{ childName: "subagent-worker-run0-1", aliases: [], wake: true },
			{ childName: "subagent-worker-run1-1", aliases: [], wake: true },
			{ childName: "subagent-worker-run2-1", aliases: [], wake: true },
		]);
		await vi.waitFor(() => assert.ok(emitted.some((item) => item.channel === SUBAGENT_COMPLETE_EVENT)));
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(
			emitted
				.filter((item) => item.channel === SUBAGENT_COMPLETE_EVENT)
				.map((item) => (item.data as { summary: string }).summary),
			[
				"Sends to released subagents subagent-worker-run0-1 and subagent-worker-run1-1 cannot be held (hold-failed). Check that Intercom is connected; until the reservation exists, sends to these subagents are answered as not found.",
			],
			"the one that ended on its own has nothing to hold",
		);
	} finally {
		stop();
	}
});

test("a frame that fails without naming a child is reported for its own children only, not for the frames the broker took (#5551)", async () => {
	const { events, emitted } = bus();
	const failures: ReleasedChildHoldFailure[] = [];
	const recovered: string[] = [];
	events.on(SUBAGENT_HOLD_FAILURE_EVENT, (data) => {
		const failure = data as ReleasedChildHoldFailure;
		failure.handled = true;
		failures.push(failure);
	});
	events.on(SUBAGENT_HOLD_RECOVERED_EVENT, (data) =>
		recovered.push(...(data as ReleasedChildHoldRecovery).childNames),
	);
	let requests = 0;
	events.on(SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT, (data) => {
		// The connection is lost while the second frame is asked for.
		(data as { completion?: Promise<void> }).completion =
			++requests === 2 ? Promise.reject(new Error("Not connected")) : Promise.resolve();
	});
	const names = Array.from({ length: 501 }, (_, index) => `subagent-bulk-${index}-1`);

	await reserveReleasedChildren(
		events,
		names.map((childName) => ({ childName, aliases: [], wake: true, taskId: "task-1" })),
	);

	assert.equal(emitted.filter((item) => item.channel === SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT).length, 2);
	assert.deepEqual(
		failures.map((failure) => [failure.childNames, failure.taskIds?.get(names[500] as string)]),
		[[[names[500]], "task-1"]],
	);
	assert.deepEqual(recovered, names.slice(0, 500));
});

test("a refused frame is asked for again without the refused child, and without a child a later request asked for (#5551)", async () => {
	const { events, emitted } = bus();
	const failures: ReleasedChildHoldFailure[] = [];
	events.on(SUBAGENT_HOLD_FAILURE_EVENT, (data) => {
		const failure = data as ReleasedChildHoldFailure;
		failure.handled = true;
		failures.push(failure);
	});
	const refusal = new ReleasedChildReservationError({ code: "not_owner", childName: "taken" });
	const earlierAnswer = Promise.withResolvers<void>();
	let requests = 0;
	events.on(SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT, (data) => {
		const request = data as { completion?: Promise<void> };
		request.completion = ++requests === 1 ? earlierAnswer.promise : Promise.resolve();
	});
	const reserved = () =>
		emitted
			.filter((item) => item.channel === SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT)
			.map((item) =>
				(item.data as { children: ReleasedChildReservation[] }).children.map(
					(child) => `${child.childName}:${child.wake ? "wake" : "park"}`,
				),
			);

	const earlier = reserveReleasedChildren(events, [
		{ childName: "paused-since", aliases: [], wake: true },
		{ childName: "taken", aliases: [], wake: true },
		{ childName: "other", aliases: [], wake: true },
	]);
	// Paused meanwhile: parked by a later request, which the broker takes.
	await reserveReleasedChildren(events, [{ childName: "paused-since", aliases: [], wake: false }]);
	earlierAnswer.reject(refusal);
	await earlier;

	assert.deepEqual(reserved(), [
		["paused-since:wake", "taken:wake", "other:wake"],
		["paused-since:park"],
		["other:wake"],
	]);
	assert.deepEqual(
		failures.map((failure) => failure.childNames),
		[["taken"]],
	);
});

test("a reservation that fails after its child runs again or has ended notifies nobody and logs nothing (#5551)", async () => {
	const { ctx } = await ownerWith([
		{ terminalStatus: "ok", waitingOn: undefined },
		// Woken: its running record still carries the status of its last released run.
		{ state: "running", terminalStatus: SUBAGENT_CHILD_RELEASED_STATUS, waitingOn: undefined },
	]);
	const { events, emitted } = bus();
	events.on(SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT, (data) => {
		(data as { completion?: Promise<void> }).completion = Promise.reject(
			new Error("Restoring-recipient request timeout"),
		);
	});
	const stop = bindReleasedChildWakes({} as SubagentChildRestoreDeps, ctx, events, new AgentWakeDispatcher());
	const logged = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		const before = subagentChildRecordFailures.count;
		await reserveReleasedChildren(events, [
			{ childName: "subagent-worker-run0-1", aliases: [], wake: true },
			{ childName: "subagent-worker-run1-1", aliases: [], wake: true },
		]);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(
			emitted.filter((item) => item.channel === SUBAGENT_HOLD_FAILURE_EVENT).length,
			1,
			"the failure reached the owner",
		);
		assert.deepEqual(
			emitted.filter((item) => item.channel === SUBAGENT_COMPLETE_EVENT),
			[],
			"no notice: neither child is released, so there is nothing to hold",
		);
		assert.equal(subagentChildRecordFailures.count, before, "status shows no failure");
		assert.deepEqual(logged.mock.calls, []);
	} finally {
		logged.mockRestore();
		stop();
	}
});

test.each(["one failure event", "a multi-frame reservation"] as const)(
	"%s for thousands of children finds them in one pass over the owner's records (#4326, #5551)",
	async (source) => {
		const { ctx, ownerSessionId } = await ownerWith([]);
		const { events, emitted } = bus();
		events.on(SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT, (data) => {
			(data as { completion?: Promise<void> }).completion = Promise.reject(new Error("broker gone"));
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
				const countedTarget = {
					enumerable: true,
					get: () => {
						targetReads++;
						return name;
					},
				};
				Object.defineProperty(bulk, "intercomTarget", countedTarget);
				observeSubagentChildRecord(bulk);
				// Count reads from either the index or the full record, including repeated passes for later frames.
				const indexed = subagentChildIndexEntry(bulk.childId);
				assert.ok(indexed);
				Object.defineProperty(indexed, "intercomTarget", countedTarget);
				names.push(name);
			}
			targetReads = 0;
			if (source === "one failure event") {
				events.emit(SUBAGENT_HOLD_FAILURE_EVENT, { childNames: names, error: new Error("broker gone") });
			} else {
				await reserveReleasedChildren(
					events,
					names.map((childName) => ({ childName, aliases: [], wake: true })),
				);
			}
			assert.ok(targetReads <= 2 * children, `${targetReads} target reads for ${children} failed reservations`);
			await vi.waitFor(() =>
				assert.equal(
					emitted.filter((item) => item.channel === SUBAGENT_COMPLETE_EVENT).length,
					source === "one failure event" ? 1 : 4,
				),
			);
			assert.equal(subagentChildRecordFailures.last?.code, "hold-failed");
		} finally {
			stop();
		}
	},
);

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
