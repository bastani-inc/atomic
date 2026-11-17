import assert from "node:assert/strict";
import { Container } from "@bastani/atomic-tui";
import { test } from "vitest";
import {
	addChatTranscriptEntry,
	ChatTranscriptComponent,
} from "../src/modes/interactive/components/chat-transcript.ts";

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

test("a cached factory can reuse its component across widths without disposing it (#5350)", () => {
	let closed = false;
	let disposals = 0;
	const component = {
		render: () => {
			assert.equal(closed, false);
			return ["kept"];
		},
		invalidate() {},
		dispose() {
			closed = true;
			disposals++;
		},
	};
	const transcript = new ChatTranscriptComponent(
		[{ role: "tool" }],
		() => component,
		() => "stable",
	);
	assert.deepEqual(transcript.render(80), ["kept"]);
	assert.deepEqual(transcript.render(160), ["kept"]);
	assert.equal(disposals, 0);
	transcript.invalidate();
	assert.equal(disposals, 1);
});

test("one failed disposer cannot prevent the rest of a transcript from closing (#5350)", () => {
	let released = false;
	const transcript = new ChatTranscriptComponent(
		[
			{ role: "tool", bad: true },
			{ role: "tool", bad: false },
		],
		(entry) => ({
			render: () => ["value"],
			invalidate() {},
			dispose() {
				if (entry.bad) throw new Error("private cleanup detail");
				released = true;
			},
		}),
		() => "stable",
	);
	transcript.render(80);
	assert.doesNotThrow(() => transcript.invalidate());
	assert.equal(released, true);
});

test("custom entries own only one leading row and suppressed entries occupy none (#5350)", () => {
	const prose = { render: () => ["prose"], invalidate() {} };
	const card = { ownsLeadingSpacer: true, render: () => ["", "card"], invalidate() {} };
	const empty = { render: () => [] as string[], invalidate() {} };
	for (const cached of [false, true]) {
		const entries = [
			{ role: "assistant", component: prose },
			{ role: "custom", component: card },
			{ role: "custom", component: empty },
		];
		const transcript = new ChatTranscriptComponent(
			entries,
			(entry) => entry.component,
			cached ? () => "stable" : undefined,
		);
		try {
			assert.deepEqual(transcript.render(80), ["prose", "", "card"]);
		} finally {
			transcript.invalidate();
		}
	}
	const container = new Container();
	container.addChild(prose);
	addChatTranscriptEntry(container, card, "custom");
	assert.deepEqual(container.render(80), ["prose", "", "card"]);
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
