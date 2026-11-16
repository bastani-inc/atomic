import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test } from "vitest";
import {
	ChatTranscriptComponent,
	ScrollableComponentViewport,
} from "../../packages/coding-agent/src/modes/interactive/components/chat-transcript.js";

const USER_MARK = "\x1b]133;A;atomic=user\x07";

test("a distant pinned prompt refreshes each transcript entry once per frame (#5243)", () => {
	for (const hasPrompt of [true, false]) {
		const entries = Array.from({ length: 20_000 }, (_, index) => ({
			role: index === 0 && hasPrompt ? ("user" as const) : ("assistant" as const),
			text: index === 0 && hasPrompt ? `${USER_MARK}task prompt` : `row-${index}`,
		}));
		let cacheReads = 0;
		const transcript = new ChatTranscriptComponent(
			entries,
			(entry) => ({ render: () => [entry.text], invalidate() {} }),
			(entry) => {
				cacheReads++;
				return entry.text;
			},
		);
		const viewport = new ScrollableComponentViewport(undefined, { pinnedPrompt: (text) => `PIN ${text}` });
		viewport.setComponents([transcript]);
		viewport.setVisibleRows(10);
		viewport.render(80);
		viewport.scrollTo(19_950);
		cacheReads = 0;
		const frame = viewport.render(80).map(stripVTControlCharacters);
		assert.equal(frame[0], hasPrompt ? "PIN task prompt" : "row-19950");
		assert.ok(cacheReads <= entries.length, `read ${cacheReads} cache keys for ${entries.length} entries`);
		viewport.dispose();
	}
});

test("reading a long windowed transcript returns every row without overflowing (#5243)", () => {
	const lines = Array.from({ length: 200_000 }, (_, index) => `row-${index}`);
	const viewport = new ScrollableComponentViewport();
	const component = {
		supportsRowWindow: true,
		rowCount: () => lines.length,
		renderRows: (_width: number, start: number, end: number) => lines.slice(start, end),
		render: () => lines,
		invalidate() {},
	};
	viewport.setComponents([component]);
	try {
		assert.deepEqual(viewport.renderRows(80, 0, lines.length), lines);
	} finally {
		viewport.dispose();
	}
});

test("cached pinned prompts match rendered rows after edits, splices and width changes (#5243)", () => {
	const entries = [
		{ role: "user" as const, lines: [USER_MARK, " ", "\x1b[31mfirst prompt\x1b[0m"] },
		{ role: "assistant" as const, lines: Array.from({ length: 20 }, (_, row) => `answer-${row}`) },
		{ role: "user" as const, lines: [`${USER_MARK}second prompt`, "second line"] },
		{ role: "assistant" as const, lines: ["\x1b]133;A\x07answer zone", ...Array(20).fill("tail")] },
	];
	const makeViewport = (cached: boolean) => {
		const transcript = new ChatTranscriptComponent(
			entries,
			(entry) => ({
				render: (width) => entry.lines.flatMap((line) => (width < 30 ? [line, "wrapped"] : [line])),
				invalidate() {},
			}),
			cached ? (entry) => entry.lines.join("\n") : undefined,
		);
		const viewport = new ScrollableComponentViewport(undefined, { pinnedPrompt: (text) => `PIN ${text}` });
		viewport.setComponents([transcript]);
		viewport.setVisibleRows(6);
		return viewport;
	};
	const cached = makeViewport(true);
	const rendered = makeViewport(false);
	const compare = () => {
		for (const width of [40, 20, 40]) {
			cached.render(width);
			rendered.render(width);
			for (let start = 0; start <= rendered.getMaxScroll(); start++) {
				cached.scrollTo(start);
				rendered.scrollTo(start);
				assert.deepEqual(cached.render(width), rendered.render(width), `width=${width}, start=${start}`);
			}
		}
	};
	try {
		compare();
		entries[0]!.lines = [`${USER_MARK}edited prompt`];
		compare();
		entries.unshift({ role: "user", lines: [`${USER_MARK}earlier prompt`] });
		compare();
		entries.splice(1, 2);
		compare();
		entries.length = 0;
		compare();
		entries.push({ role: "user", lines: [`${USER_MARK}replacement`, ...Array(12).fill("later")] });
		cached.invalidate();
		rendered.invalidate();
		compare();
	} finally {
		cached.dispose();
		rendered.dispose();
	}
});
