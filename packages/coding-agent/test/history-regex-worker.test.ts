import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { SessionEntry } from "../src/core/session-manager-types.js";
import { renderRawEntryInWorker } from "../src/core/tools/history-regex-worker.js";

const PREVIEW_CHARS = 10;
const WORKER_TIMEOUT_MS = 20_000;
const AT = Date.parse("2026-11-01T00:00:00.000Z");

async function preview(entry: SessionEntry): Promise<string | undefined> {
	const raw = new TextEncoder().encode(JSON.stringify(entry));
	const rendered = await renderRawEntryInWorker([raw], PREVIEW_CHARS, WORKER_TIMEOUT_MS);
	assert.ok(!("timedOut" in rendered));
	return rendered.outline.item?.preview;
}

function userEntry(content: string | { readonly type: "text"; readonly text: string }[]): SessionEntry {
	return {
		type: "message",
		id: "u1",
		parentId: null,
		timestamp: new Date(AT).toISOString(),
		message: { role: "user", content, timestamp: AT },
	};
}

describe("outline previews of large entries (#5250)", () => {
	it("cuts a preview before a character that does not fit, never inside it (#5250)", async () => {
		assert.equal(
			await preview(userEntry(`${"a".repeat(PREVIEW_CHARS - 1)}😀 tail`)),
			`${"a".repeat(PREVIEW_CHARS - 1)}…`,
		);
		assert.equal(
			await preview(userEntry(`${"a".repeat(PREVIEW_CHARS - 2)}😀 tail`)),
			`${"a".repeat(PREVIEW_CHARS - 2)}😀…`,
		);
	});

	it("keeps a preview well formed when collapsed whitespace pulls an early cut into view (#5250)", async () => {
		const spaced = `${" ".repeat(PREVIEW_CHARS * 4 - 1)}😀 tail`;
		const previews = [
			await preview(userEntry(spaced)),
			await preview(userEntry([{ type: "text", text: spaced }])),
			await preview({
				type: "compaction",
				id: "c1",
				parentId: null,
				timestamp: new Date(AT).toISOString(),
				summary: spaced,
				firstKeptEntryId: "u1",
				tokensBefore: 1,
			}),
		];
		for (const text of previews) {
			assert.equal(typeof text, "string");
			assert.equal(text!.isWellFormed(), true, JSON.stringify(text));
		}
	});

	it("renders an entry whose raw chunks repeat one buffer, handing each buffer over once (#5250)", async () => {
		const encoder = new TextEncoder();
		const head = encoder.encode('{"type":"message",');
		const gap = new Uint8Array([0x20, 0x0a, 0x20]);
		const middle = encoder.encode('"id":"u1","parentId":null,');
		const tail = encoder.encode(
			`"timestamp":"${new Date(AT).toISOString()}","message":{"role":"user","content":"shared gap","timestamp":${AT}}}`,
		);
		const rendered = await renderRawEntryInWorker([head, gap, middle, gap, tail], PREVIEW_CHARS, WORKER_TIMEOUT_MS);
		assert.ok(!("timedOut" in rendered));
		assert.equal(rendered.outline.item?.preview, "shared gap");
		assert.match(new TextDecoder().decode(rendered.renderedUtf8), /user\nshared gap$/);
		for (const chunk of [head, gap, middle, tail]) assert.equal(chunk.byteLength, 0);
	});

	it("collapses leading whitespace while cutting so a turn after >288 blanks keeps its preview (#5250)", async () => {
		const leadingBlanks = `${" \n\t ".repeat(80)}real question after blank lines`;
		const raw = new TextEncoder().encode(JSON.stringify(userEntry(leadingBlanks)));
		const rendered = await renderRawEntryInWorker([raw], 72, WORKER_TIMEOUT_MS);
		assert.ok(!("timedOut" in rendered));
		assert.equal(rendered.outline.item?.preview, "real question after blank lines");

		const blockRaw = new TextEncoder().encode(
			JSON.stringify(
				userEntry([
					{ type: "text", text: " \n".repeat(160) },
					{ type: "text", text: leadingBlanks },
				]),
			),
		);
		const blockRendered = await renderRawEntryInWorker([blockRaw], 72, WORKER_TIMEOUT_MS);
		assert.ok(!("timedOut" in blockRendered));
		assert.equal(blockRendered.outline.item?.preview, "real question after blank lines");
	});
});
