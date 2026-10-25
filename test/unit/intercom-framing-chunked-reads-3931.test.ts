/**
 * The Intercom message reader decodes frames however the socket splits them (#3931).
 *
 * A large frame (a roster or `list` reply of several megabytes) arrives in many socket chunks.
 * The reader holds the chunks of an incomplete frame and joins them once the frame is complete,
 * so it must still decode every frame, in order, when chunk boundaries fall inside the length
 * header, inside a payload, or across several frames.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { createMessageReader } from "../../packages/intercom/broker/framing.js";

function frame(message: unknown): Buffer {
	const payload = Buffer.from(JSON.stringify(message), "utf-8");
	const header = Buffer.alloc(4);
	header.writeUInt32BE(payload.length, 0);
	return Buffer.concat([header, payload]);
}

test("frames split into random socket chunks decode completely and in order (#3931)", () => {
	let state = 3931;
	const next = () => {
		state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
		return state / 4294967296;
	};
	for (let trial = 0; trial < 50; trial++) {
		const messages = Array.from({ length: 1 + Math.floor(next() * 6) }, (_, index) => ({
			index,
			text: "é".repeat(Math.floor(next() < 0.3 ? next() * 200_000 : next() * 20)),
		}));
		const stream = Buffer.concat(messages.map(frame));
		const decoded: unknown[] = [];
		const read = createMessageReader(
			(message) => decoded.push(message),
			(error) => assert.fail(error.message),
		);
		for (let offset = 0; offset < stream.length; ) {
			const size = 1 + Math.floor(next() < 0.5 ? next() * 7 : next() * 70_000);
			read(stream.subarray(offset, offset + size));
			offset += size;
		}
		assert.deepEqual(decoded, messages, `trial ${trial}`);
	}
});
