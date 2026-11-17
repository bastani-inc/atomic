import assert from "node:assert/strict";
import { test } from "vitest";
import { ChatTranscriptComponent } from "../src/modes/interactive/components/chat-transcript.ts";

test("renderer-owned repaint preserves the cached component until its data changes (#5224)", () => {
	const entry = { role: "tool", version: 0 };
	let value = 0;
	let builds = 0;
	let disposals = 0;
	const transcript = new ChatTranscriptComponent(
		[entry],
		() => {
			const build = ++builds;
			return {
				render: () => [`build ${build}: ${value}`],
				invalidate() {},
				dispose() {
					disposals++;
				},
			};
		},
		(current) => String(current.version),
	);
	try {
		assert.deepEqual(transcript.render(80), ["build 1: 0"]);
		value = 1;
		transcript.requestEntryRender(entry);
		assert.deepEqual(transcript.render(80), ["build 1: 1"]);
		assert.equal(builds, 1);
		assert.equal(disposals, 0);
		entry.version++;
		assert.deepEqual(transcript.render(80), ["build 2: 1"]);
		assert.equal(disposals, 1);
	} finally {
		transcript.invalidate();
	}
	assert.equal(disposals, 2);
});

test("uncached transcript repaint disposes replaced components but not reused instances (#5224)", () => {
	let disposals = 0;
	const transcript = new ChatTranscriptComponent([{ role: "tool" }], () => ({
		render: () => ["value"],
		invalidate() {},
		dispose() {
			disposals++;
		},
	}));
	transcript.render(80);
	transcript.render(80);
	assert.equal(disposals, 1);
	transcript.invalidate();
	assert.equal(disposals, 2);
	const reused = {
		render: () => ["same"],
		invalidate() {},
		dispose() {
			disposals++;
		},
	};
	const stable = new ChatTranscriptComponent([{ role: "tool" }], () => reused);
	stable.render(80);
	stable.render(80);
	assert.equal(disposals, 2);
	stable.invalidate();
	assert.equal(disposals, 3);
});

test("a transcript keeps every row of a large expanded block (#5224)", () => {
	const count = 150_000;
	const transcript = new ChatTranscriptComponent(
		[{ role: "tool" }],
		() => ({ render: () => Array<string>(count).fill("row"), invalidate() {} }),
		() => "stable",
	);
	try {
		const rows = transcript.render(80);
		assert.equal(rows.length, count);
		assert.equal(rows.at(-1), "row");
	} finally {
		transcript.invalidate();
	}
});
