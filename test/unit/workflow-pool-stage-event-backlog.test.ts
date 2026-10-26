/**
 * A watch's held events are accounted for in time linear in what arrives (#3996).
 */
import assert from "node:assert/strict";
import type { AgentSessionEvent } from "@bastani/atomic";
import { afterEach, test, vi } from "vitest";
import { StageEventBacklog } from "../../packages/workflows/src/workers/stage-watch-coalesce.js";

afterEach(() => {
	vi.restoreAllMocks();
});

/** One streamed delta, carrying the partial message so far as real `message_update` events do. */
function delta(seq: number, text: string, sofar: string) {
	const partial = { role: "assistant", content: [{ type: "text", text: sofar }] };
	return {
		seq,
		event: {
			type: "message_update",
			message: partial,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text, partial },
		} as never as AgentSessionEvent,
	};
}

test("holding a long streamed message serializes for its size accounting a bounded amount, not once per delta (#3996)", () => {
	const DELTAS = 4_096;
	const DELTA = "x".repeat(128);
	const original = JSON.stringify;
	const firstEvent = original(delta(1, DELTA, DELTA)).length;
	let serialized = 0;
	vi.spyOn(JSON, "stringify").mockImplementation((value: Parameters<typeof JSON.stringify>[0]) => {
		const text = original(value);
		serialized += text.length;
		return text;
	});
	const backlog = new StageEventBacklog({ events: 2_000, bytes: Number.MAX_SAFE_INTEGER });
	let sofar = "";
	for (let seq = 1; seq <= DELTAS; seq++) {
		sofar += DELTA;
		assert.ok(backlog.push([delta(seq, DELTA, sofar)]));
	}
	const streamed = DELTAS * DELTA.length;
	assert.equal(backlog.length, 1, "every delta merged into one held event");
	assert.ok(
		serialized <= firstEvent,
		`size accounting serialized ${serialized} characters for ${streamed} streamed; it must not grow with the deltas`,
	);
	assert.ok(backlog.bytes >= streamed, "the accounted size still covers the merged text");
	assert.equal(
		backlog
			.drain()
			.map(
				({ event }) => (event as never as { assistantMessageEvent: { delta: string } }).assistantMessageEvent.delta,
			)
			.join(""),
		sofar,
	);
});
