import assert from "node:assert/strict";
import { beforeEach, describe, test } from "vitest";
import {
	acknowledgeReleasedChildWake,
	dropReleasedChildren,
	releasedChildHoldFailures,
	releasedChildReservation,
	reserveReleasedChildren,
	reserveReleasedChildTargets,
	SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT,
} from "../../packages/subagents/src/runs/foreground/released-child-reservations.js";
import {
	SUBAGENT_CHILD_RELEASED_STATUS,
	type SubagentChildRecord,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import type { IntercomEventBus } from "../../packages/subagents/src/shared/types.js";

interface Emission {
	readonly channel: string;
	readonly data: object;
}

function bus(failure?: Error) {
	const emitted: Emission[] = [];
	const events: IntercomEventBus = {
		on: () => () => undefined,
		emit(channel, data) {
			emitted.push({ channel, data: data as object });
			if (failure !== undefined) (data as { completion?: Promise<void> }).completion = Promise.reject(failure);
		},
	};
	return { events, emitted };
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

beforeEach(() => {
	releasedChildHoldFailures.count = 0;
	delete releasedChildHoldFailures.last;
});

describe("releasedChildReservation", () => {
	test("a reservation has no group key unless the record has an intercom group (#4326)", () => {
		assert.deepEqual(releasedChildReservation(record()), {
			childName: "subagent-worker-run-1",
			aliases: ["child-session"],
			wake: true,
		});
	});

	test("a released record that is not terminal is not reserved (#4326)", () => {
		assert.equal(releasedChildReservation(record({ state: "running" })), undefined);
		assert.equal(releasedChildReservation(record({ state: "running", intercomTarget: undefined })), undefined);
	});

	test("a waiting record without a terminal status is not parked (#4326)", () => {
		assert.equal(releasedChildReservation(record({ terminalStatus: undefined })), undefined);
	});
});

describe("reserveReleasedChildTargets", () => {
	test("the group is sent only when the launch has one (#4326)", async () => {
		const withGroup = bus();
		await reserveReleasedChildTargets(
			{ intercomEvents: withGroup.events, intercomSessionName: "w", intercomGroup: "lane" },
			"s",
			"i",
		);
		assert.deepEqual(withGroup.emitted, [
			{
				channel: SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT,
				data: { children: [{ childName: "w", group: "lane", aliases: ["s", "i"], wake: true }] },
			},
		]);
		const withoutGroup = bus();
		await reserveReleasedChildTargets(
			{ intercomEvents: withoutGroup.events, intercomSessionName: "w" },
			undefined,
			"i",
		);
		assert.deepEqual(withoutGroup.emitted[0]?.data, {
			children: [{ childName: "w", aliases: ["i"], wake: true }],
		});
	});
});

describe("hold failures", () => {
	const failure = new Error("broker down");
	const reservation = (childName: string) => ({ childName, aliases: [], wake: true });

	test("one reserved child is named in the failure, several are not (#4326)", async () => {
		await reserveReleasedChildren(bus(failure).events, [reservation("a")]);
		assert.equal(releasedChildHoldFailures.count, 1);
		assert.deepEqual(releasedChildHoldFailures.last?.fields, { childName: "a" });
		assert.equal(releasedChildHoldFailures.last?.cause, failure);
		await reserveReleasedChildren(bus(failure).events, [reservation("a"), reservation("b")]);
		assert.equal(releasedChildHoldFailures.count, 2);
		assert.deepEqual(releasedChildHoldFailures.last?.fields, {});
	});

	test("one dropped child is named in the failure, several are not (#4326)", async () => {
		await dropReleasedChildren(bus(failure).events, ["a"]);
		assert.equal(releasedChildHoldFailures.count, 1);
		assert.deepEqual(releasedChildHoldFailures.last?.fields, { childName: "a" });
		await dropReleasedChildren(bus(failure).events, ["a", "b"]);
		assert.equal(releasedChildHoldFailures.count, 2);
		assert.deepEqual(releasedChildHoldFailures.last?.fields, {});
	});

	test("a failed wake acknowledgement is recorded with the child name (#4326)", async () => {
		await acknowledgeReleasedChildWake(bus(failure).events, "a");
		assert.equal(releasedChildHoldFailures.count, 1);
		assert.deepEqual(releasedChildHoldFailures.last?.fields, { childName: "a" });
	});
});
