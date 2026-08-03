/**
 * Unit tests for the handle-owned queued-user-message projection (issue #2074).
 *
 * Verifies:
 *  - each `queue_update` replaces both lists rather than merging, which is what
 *    keeps a rehydrated chat and a detached graph badge in step with the
 *    session as entries are consumed;
 *  - duplicates, text, and per-queue order survive verbatim;
 *  - unrelated events and malformed payloads leave the snapshot alone;
 *  - the snapshot replayed when a session is attached reports only a queue that
 *    session is really holding, copied rather than aliased.
 *
 * cross-ref: src/runs/foreground/stage-queued-user-messages.ts
 */

import assert from "node:assert/strict";
import type { AgentSessionEvent } from "@bastani/atomic";
import { describe, test } from "vitest";
import {
	StageQueuedUserMessageBuffer,
	stageQueuedUserMessageCount,
	stageSessionQueueUpdateEvent,
} from "../../packages/workflows/src/runs/foreground/stage-queued-user-messages.js";

function queueUpdate(steering: readonly unknown[], followUp: readonly unknown[]): AgentSessionEvent {
	return { type: "queue_update", steering, followUp } as unknown as AgentSessionEvent;
}

describe("StageQueuedUserMessageBuffer", () => {
	test("starts empty", () => {
		const buffer = new StageQueuedUserMessageBuffer();
		assert.deepEqual(buffer.snapshot(), { steering: [], followUp: [] });
		assert.equal(stageQueuedUserMessageCount(buffer.snapshot()), 0);
	});

	test("replaces both lists on every update instead of merging", () => {
		const buffer = new StageQueuedUserMessageBuffer();
		buffer.record(queueUpdate(["first", "second"], ["later"]));
		assert.deepEqual(buffer.snapshot(), {
			steering: ["first", "second"],
			followUp: ["later"],
		});
		assert.equal(stageQueuedUserMessageCount(buffer.snapshot()), 3);

		// Consumption publishes the reduced snapshot before the user message starts.
		buffer.record(queueUpdate(["second"], ["later"]));
		assert.deepEqual(buffer.snapshot(), { steering: ["second"], followUp: ["later"] });
		assert.equal(stageQueuedUserMessageCount(buffer.snapshot()), 2);

		buffer.record(queueUpdate([], []));
		assert.deepEqual(buffer.snapshot(), { steering: [], followUp: [] });
	});

	test("preserves duplicates, raw text, and order", () => {
		const buffer = new StageQueuedUserMessageBuffer();
		buffer.record(queueUpdate(["  keep  spacing ", "same", "same"], ["same"]));
		assert.deepEqual(buffer.snapshot(), {
			steering: ["  keep  spacing ", "same", "same"],
			followUp: ["same"],
		});
	});

	test("ignores unrelated events", () => {
		const buffer = new StageQueuedUserMessageBuffer();
		buffer.record(queueUpdate(["queued"], []));
		buffer.record({ type: "agent_start" } as unknown as AgentSessionEvent);
		buffer.record({ type: "message_start", message: { role: "user" } } as unknown as AgentSessionEvent);
		assert.deepEqual(buffer.snapshot(), { steering: ["queued"], followUp: [] });
	});

	test("drops non-string entries and tolerates missing arrays", () => {
		const buffer = new StageQueuedUserMessageBuffer();
		buffer.record(queueUpdate(["text", 7, null], ["ok", { nested: true }]));
		assert.deepEqual(buffer.snapshot(), { steering: ["text"], followUp: ["ok"] });

		buffer.record({ type: "queue_update" } as unknown as AgentSessionEvent);
		assert.deepEqual(buffer.snapshot(), { steering: [], followUp: [] });
	});

	test("clear resets the snapshot", () => {
		const buffer = new StageQueuedUserMessageBuffer();
		buffer.record(queueUpdate(["queued"], ["later"]));
		buffer.clear();
		assert.deepEqual(buffer.snapshot(), { steering: [], followUp: [] });
	});

	test("counts an absent snapshot as zero", () => {
		assert.equal(stageQueuedUserMessageCount(undefined), 0);
	});
});

describe("stageSessionQueueUpdateEvent", () => {
	test("reports the queue a session is already holding", () => {
		const event = stageSessionQueueUpdateEvent({
			getSteeringMessages: () => ["redirect", "redirect"],
			getFollowUpMessages: () => ["afterwards"],
		});
		assert.deepEqual(event, {
			type: "queue_update",
			steering: ["redirect", "redirect"],
			followUp: ["afterwards"],
		});
	});

	test("copies the session's lists instead of aliasing them", () => {
		const steering = ["redirect"];
		const event = stageSessionQueueUpdateEvent({
			getSteeringMessages: () => steering,
			getFollowUpMessages: () => [],
		});
		steering.push("later");
		assert.deepEqual((event as unknown as { steering: readonly string[] }).steering, ["redirect"]);
	});

	test("is absent for an empty queue and for a runtime that exposes none", () => {
		assert.equal(
			stageSessionQueueUpdateEvent({ getSteeringMessages: () => [], getFollowUpMessages: () => [] }),
			undefined,
		);
		assert.equal(stageSessionQueueUpdateEvent({}), undefined);
		assert.equal(stageSessionQueueUpdateEvent({ getSteeringMessages: () => ["orphan"] }), undefined);
	});

	test("feeds the buffer the one update the session never re-publishes", () => {
		const buffer = new StageQueuedUserMessageBuffer();
		const event = stageSessionQueueUpdateEvent({
			getSteeringMessages: () => ["redirect"],
			getFollowUpMessages: () => ["afterwards"],
		});
		assert.notEqual(event, undefined);
		if (event === undefined) return;
		buffer.record(event);
		assert.deepEqual(buffer.snapshot(), { steering: ["redirect"], followUp: ["afterwards"] });
	});
});
