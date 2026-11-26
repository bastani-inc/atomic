import assert from "node:assert/strict";
import { test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import {
	dropStoredNotes,
	storedEntryNotes,
	storedRows,
	storedSeqOf,
} from "../../packages/coding-agent/src/core/storage/session/stored-entries.js";
import { sleep } from "../helpers/runtime.js";

/** Longer than the stores stay busy before a fingerprint is taken in the background, with room for a loaded machine. */
const FINGERPRINTS_TAKEN_MS = 500;

/** An entry as a store parses it from the JSON it stored, and that JSON. */
function read(id: string, text: string): { entry: SessionEntry & { message: { content: string } }; json: string } {
	const json = JSON.stringify({
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-11-26T00:00:00.000Z",
		message: { role: "user", content: text, timestamp: 1 },
	});
	return { entry: JSON.parse(json), json };
}

test("a fork finds the entries the background took the fingerprints of, in order and out of it (#6560)", async () => {
	const rows = ["one", "two", "three"].map((id) => read(id, id));
	const note = storedEntryNotes({}, "background", "g");
	for (const [index, row] of rows.entries()) note(row.entry, index + 1, row.json);

	await sleep(FINGERPRINTS_TAKEN_MS);
	const stored = storedRows("background", "g")!;
	assert.deepEqual(
		rows.map((row, index) => stored.seqOf(row.entry, index)),
		[1, 2, 3],
	);
	assert.equal(stored.seqOf(rows[2]!.entry, 0), 3, "past a row the fork does not carry");
	assert.equal(stored.seqOf(rows[0]!.entry, 1), undefined, "a segment names rows in increasing order");
	assert.equal(stored.seqOf(structuredClone(rows[1]!.entry), 1), 2, "a copy with the same JSON");
});

test("a fork finds a noted entry where it is stored, whether or not its fingerprint was taken yet (#6560)", async () => {
	const store = {};
	const kept = read("kept", `kept ${"k".repeat(100_000)}`);
	const edited = read("edited", "edited");
	const note = storedEntryNotes(store, "s", "g1");
	note(kept.entry, 7, kept.json);
	note(edited.entry, 8, edited.json);

	assert.equal(storedSeqOf(kept.entry, "s", "g1"), 7);
	assert.equal(storedSeqOf(kept.entry, "s", "g2"), undefined, "another generation");
	assert.equal(storedSeqOf(kept.entry, "t", "g1"), undefined, "another session");
	assert.equal(storedSeqOf(kept.entry, "s", undefined), undefined, "no generation");
	// An edit in place before the fingerprint is taken.
	edited.entry.message.content = "edited in place";
	assert.equal(storedSeqOf(edited.entry, "s", "g1"), undefined);

	await sleep(FINGERPRINTS_TAKEN_MS);
	assert.equal(storedSeqOf(kept.entry, "s", "g1"), 7);
	assert.equal(storedSeqOf(edited.entry, "s", "g1"), undefined);
	// An edit in place after it, of the same length.
	kept.entry.message.content = kept.entry.message.content.replace("kept", "kepT");
	assert.equal(storedSeqOf(kept.entry, "s", "g1"), undefined);
	kept.entry.message.content = kept.entry.message.content.replace("kepT", "kept");
	assert.equal(storedSeqOf(kept.entry, "s", "g1"), 7, "the same JSON again");
});

test("a store's close drops its notes whose fingerprint is not taken, and no other store's (#6560)", () => {
	const closing = {};
	const open = {};
	const dropped = read("dropped", "dropped");
	const other = read("other", "other");
	storedEntryNotes(closing, "s", "g")(dropped.entry, 1, dropped.json);
	storedEntryNotes(open, "s", "g")(other.entry, 2, other.json);

	dropStoredNotes(closing);

	assert.equal(storedSeqOf(dropped.entry, "s", "g"), undefined, "its entry is copied, as one no store noted");
	assert.equal(storedSeqOf(other.entry, "s", "g"), 2);
});
