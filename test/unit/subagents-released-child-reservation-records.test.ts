import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	acknowledgeReleasedChildWake,
	dropReleasedChildren,
	releasedChildReservation,
	reserveReleasedChildren,
	reserveReleasedChildTargets,
	SUBAGENT_HOLD_FAILURE_EVENT,
	SUBAGENT_HOLD_RECOVERED_EVENT,
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
			if (channel === SUBAGENT_HOLD_FAILURE_EVENT) (data as { handled?: boolean }).handled = true;
			else if (channel !== SUBAGENT_HOLD_RECOVERED_EVENT && failure !== undefined)
				(data as { completion?: Promise<void> }).completion = Promise.reject(failure);
			if (channel === SUBAGENT_HOLD_RECOVERED_EVENT) emitted.pop();
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

	test("reserve, drop and acknowledgement failures preserve all affected names and the broker error (#4326)", async () => {
		const { events, emitted } = bus(failure);
		await reserveReleasedChildren(events, [reservation("a"), reservation("b")]);
		await dropReleasedChildren(events, ["a", "b"]);
		await acknowledgeReleasedChildWake(events, "a");
		const failures = emitted.filter((item) => item.channel === SUBAGENT_HOLD_FAILURE_EVENT);
		assert.deepEqual(
			failures.map((item) => (item.data as { childNames: readonly string[] }).childNames),
			[["a", "b"], ["a", "b"], ["a"]],
		);
		for (const item of failures) assert.equal((item.data as { error: Error }).error, failure);
	});
});
