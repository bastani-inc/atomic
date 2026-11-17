import assert from "node:assert/strict";
import { test } from "vitest";
import { ChatTranscriptComponent } from "../../packages/coding-agent/src/modes/interactive/components/chat-transcript.js";
import type { ClickExpandableBlock } from "../../packages/coding-agent/src/modes/interactive/components/transcript-block-clicks.js";

interface Entry {
	readonly role: "tool";
	readonly name: string;
}

/** A block whose first row is its header, then two rows of output. */
function block(name: string): ClickExpandableBlock {
	let expanded = false;
	return {
		expandsOnClick: true,
		isExpanded: () => expanded,
		setExpanded: (value) => {
			expanded = value;
		},
		headerRows: () => [0],
		render: () => [`● ${name}`, `  ${name} output 1`, `  ${name} output 2`],
		invalidate: () => {},
	};
}

test("a click names the entry that was drawn on the row, even after earlier entries arrived before the next draw", () => {
	const entries: Entry[] = [
		{ role: "tool", name: "alpha" },
		{ role: "tool", name: "beta" },
	];
	const transcript = new ChatTranscriptComponent<Entry>(
		entries,
		(entry) => block(entry.name),
		(entry) => entry.name,
	);
	const painted = transcript.render(40);
	const row = painted.findIndex((line) => line.includes("● beta"));
	assert.notEqual(row, -1, painted.join("\n"));

	// An earlier page of history arrives before the transcript is drawn again.
	entries.unshift({ role: "tool", name: "earlier" });

	const clicked = transcript.clickedEntries(40, row);
	assert.deepEqual(
		clicked?.entries.map((entry) => entry.name),
		["beta"],
		"the click acts on the block the reader saw on that row",
	);
	assert.equal(clicked?.expand, true);
});

test("a click on a row of a frame drawn at another width names nothing", () => {
	const entries: Entry[] = [{ role: "tool", name: "alpha" }];
	const transcript = new ChatTranscriptComponent<Entry>(
		entries,
		(entry) => block(entry.name),
		(entry) => entry.name,
	);
	transcript.render(40);
	assert.equal(transcript.clickedEntries(60, 0), undefined);
	assert.deepEqual(
		transcript.clickedEntries(40, 0)?.entries.map((entry) => entry.name),
		["alpha"],
	);
});
