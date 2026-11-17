import assert from "node:assert/strict";
import { stripTerminalSequences } from "@bastani/atomic-tui";
import { beforeAll, describe, test } from "vitest";
import {
	jumpToLatestLabel,
	jumpToLatestPill,
	NewMessageCounter,
	pinnedPromptLine,
} from "../src/modes/interactive/components/jump-to-latest.ts";
import { TranscriptFollowIndicator } from "../src/modes/interactive/components/transcript-follow-indicator.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => {
	initTheme("dark");
});

describe("jump to latest (#5224)", () => {
	test("the pill counts new messages, or offers the bottom when nothing is new", () => {
		assert.equal(jumpToLatestLabel(0, "ctrl+end"), "↓ jump to bottom · ctrl+end");
		assert.equal(jumpToLatestLabel(1, "ctrl+end"), "↓ 1 new message · ctrl+end");
		assert.equal(jumpToLatestLabel(3, "ctrl+end"), "↓ 3 new messages · ctrl+end");
		assert.equal(jumpToLatestLabel(3, ""), "↓ 3 new messages");
	});

	test("the pill is one highlighted line without corner marks, the same in the main chat and in stage chats and subagent views (#5224)", () => {
		const main = stripTerminalSequences(jumpToLatestPill(3, "ctrl+end"));
		assert.equal(main, " ↓ 3 new messages · ctrl+end ");
		const indicator = new TranscriptFollowIndicator({
			isFollowing: () => false,
			keyLabel: () => "ctrl+end",
			newCount: () => 3,
		});
		for (const width of [160, 80]) {
			const [row] = indicator.render(width).map((line) => stripTerminalSequences(line));
			assert.equal(row?.trim(), main.trim());
			assert.equal(row?.indexOf("↓"), Math.floor((width - main.length) / 2) + 1, `centred at ${width}`);
		}
		const narrow = indicator.render(20).map((line) => stripTerminalSequences(line));
		assert.equal(narrow.length, 1);
		assert.ok(narrow[0]?.startsWith("↓"), "a viewport too narrow for the padding shows the label alone");
		assert.ok((narrow[0]?.length ?? 0) <= 20);
	});

	test("the counter counts only what arrived after the reader stopped following", () => {
		const counter = new NewMessageCounter();
		counter.observe(true, 10);
		counter.observe(true, 12);
		assert.equal(counter.count, 0);
		counter.observe(false, 12);
		assert.equal(counter.count, 0);
		counter.observe(false, 15);
		assert.equal(counter.count, 3);
		counter.observe(true, 15);
		assert.equal(counter.count, 0);
		counter.observe(false, 16);
		assert.equal(counter.count, 1);
	});

	test("a transcript that shrinks or is replaced while scrolled up keeps counted arrivals (#5243)", () => {
		const counter = new NewMessageCounter();
		counter.observe(false, 20);
		counter.observe(false, 4);
		assert.equal(counter.count, 0);
		counter.observe(false, 6);
		assert.equal(counter.count, 2);
		counter.observe(false, 5);
		assert.equal(counter.count, 2);
		counter.observe(false, 2);
		assert.equal(counter.count, 2);
		counter.observe(false, 3);
		assert.equal(counter.count, 3);
		counter.replaced(12);
		assert.equal(counter.count, 3);
		counter.observe(false, 13);
		assert.equal(counter.count, 4);
		counter.reset();
		assert.equal(counter.count, 0);
	});

	for (const width of [80, 160]) {
		test(`the transcript pill names the new messages at ${width} columns`, () => {
			const indicator = new TranscriptFollowIndicator({
				isFollowing: () => false,
				keyLabel: () => "ctrl+end",
				newCount: () => 3,
			});
			assert.match(stripTerminalSequences(indicator.render(width)[0] ?? ""), /↓ 3 new messages · ctrl\+end/);
		});
	}

	test("pinnedPromptLine strips OSC 8 hyperlinks whose URLs contain commas or parentheses (#5243)", () => {
		const row = " \x1b]8;;https://example.com/a,b(1)\x1b\\the docs\x1b]8;;\x1b\\ say the parser fails ";
		const rendered = pinnedPromptLine(row);
		assert.equal(stripTerminalSequences(rendered), "↑ the docs say the parser fails");
		assert.equal(rendered.includes("\x1b\\"), false);
		assert.equal(rendered.includes("example.com"), false);
	});
});
