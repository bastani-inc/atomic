import assert from "node:assert/strict";
import { test } from "vitest";
import { collectGarbage } from "../../../../test/helpers/collect-garbage.js";
import type { SessionEntry } from "../../src/core/session-manager.js";
import { encodedForkRow } from "../../src/core/storage/session/fork-row-bytes.js";
import type { OversizedSessionEntry, SessionStore } from "../../src/core/storage/session/types.js";

/** A saved row served in chunks of the given size, so tokens, escapes and UTF-8 sequences straddle reads. */
function savedRow(bytes: Uint8Array, chunk: number, onRead?: (end: number) => Promise<void>) {
	const reference: OversizedSessionEntry = {
		kind: "oversized",
		sessionId: "s",
		epoch: "e",
		seq: 1,
		bytes: bytes.length,
	};
	const store = {
		descriptor: { adapter: "test", location: "test" },
		readRange: () => Promise.reject(new Error("rows are not decoded to copy them")),
		readEntrySizes: () => Promise.reject(new Error("rows are not decoded to copy them")),
		async readEntryChunk(ref: OversizedSessionEntry, offset: number) {
			assert.equal(ref, reference);
			const end = Math.min(offset + chunk, bytes.length);
			await onRead?.(end);
			return bytes.subarray(offset, end);
		},
	} as unknown as SessionStore;
	return { store, reference };
}

const entry = { type: "message", id: "x", parentId: "root" } as unknown as SessionEntry;

async function copied(source: string, edits: Record<string, string | null>, chunk: number) {
	const { store, reference } = savedRow(Buffer.from(source), chunk);
	const encoded = await encodedForkRow(store, { entry, reference, edits });
	const parts: Uint8Array[] = [];
	for await (const part of encoded.chunks()) parts.push(Buffer.from(part));
	const bytes = Buffer.concat(parts);
	assert.equal(bytes.length, encoded.size, `announced size with ${chunk}-byte reads`);
	return bytes.toString("utf8");
}

test("a forked raw row changes only its top-level links, whatever the read boundaries (#5594)", async () => {
	const same = (s: string): [string, string] => [s, s];
	// [saved bytes, copied bytes] of each field.
	const fields: [string, string][] = [
		same('{"type":"message","id":"x",'),
		['"parentId":"old-1",', '"parentId":"root",'],
		same(String.raw`"note":"a } brace, \"parentId\":\"no\", \\ é€😀 \ud83d\ude00",`),
		[String.raw` "parent\u0049d" : "old-2",`, String.raw` "parent\u0049d" : "root",`],
		same('"meta":{"parentId":"nested","firstKeptEntryId":"nested"},'),
		same(String.raw`"\u0070arentIdX":1,"parentI":2,"pärentId":3,"\ud83d\ude00":4,"😀":5,`),
		['"firstKeptEntryId":null,', '"firstKeptEntryId":"kept",'],
		['"parentId":{"deep":["}",{"parentId":1}]},', '"parentId":"root",'],
		same(String.raw`"end":"\\"}`),
	];
	const source = fields.map(([s]) => s).join("");
	const expected = fields.map(([, e]) => e).join("");
	const missing = String.raw`{"type":"label","id":"y","parentId":"old","n":"é\"}"}`;
	for (let chunk = 1; chunk <= Buffer.byteLength(source); chunk++) {
		assert.equal(await copied(source, { parentId: "root", firstKeptEntryId: "kept" }, chunk), expected);
		assert.equal(
			await copied(missing, { parentId: "root", firstKeptEntryId: "kept" }, chunk),
			String.raw`{"type":"label","id":"y","parentId":"root","n":"é\"}","firstKeptEntryId":"kept"}`,
		);
	}
});

test("a forked raw row with duplicated links across reads keeps constant scratch space (#5594)", async () => {
	const copies = 150_000;
	const source = Buffer.from(`{"type":"message","id":"x",${'"parentId":"old",'.repeat(copies)}"end":"😀"}`);
	const expected = Buffer.from(`{"type":"message","id":"x",${'"parentId":"root",'.repeat(copies)}"end":"😀"}`);
	let baseline = 0,
		peak = 0;
	const sample = async () => {
		await collectGarbage(3);
		peak = Math.max(peak, process.memoryUsage().heapUsed - baseline);
	};
	// An odd read size puts duplicated keys and values across read boundaries.
	const { store, reference } = savedRow(source, 4093, async (end) => {
		if (end === source.length) await sample();
	});
	await collectGarbage(3);
	baseline = process.memoryUsage().heapUsed;
	const encoded = await encodedForkRow(store, { entry, reference, edits: { parentId: "root" } });
	await sample();
	assert.equal(encoded.size, expected.length);
	let at = 0;
	for await (const part of encoded.chunks()) {
		assert.ok(expected.subarray(at, at + part.length).equals(part), `copied bytes differ at ${at}`);
		at += part.length;
	}
	assert.equal(at, expected.length);
	assert.ok(peak < 4 * 1024 * 1024, `scratch reached ${peak} bytes for ${copies} duplicated links`);
});
