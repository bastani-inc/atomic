import assert from "node:assert";
import { describe, it } from "node:test";
import { Text } from "../src/components/text.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { visibleWidth } from "../src/utils.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

describe("Text", () => {
	it("keeps its wrapped lines when the same text is set again", () => {
		const text = new Text("hello world", 0, 0);
		const lines = text.render(5);
		text.setText("hello world");
		assert.strictEqual(text.render(5), lines);
	});

	it("renders a grapheme cluster wider than the terminal within its width", () => {
		// One grapheme cluster 201 columns wide: a consonant and 200 spacing vowel signs.
		const wideCluster = `\u0915${"\u093e".repeat(200)}`;
		for (const width of [80, 1]) {
			const text = new Text(`ab ${wideCluster} cd`, 0, 0);
			for (const line of text.render(width)) {
				assert.ok(visibleWidth(line) <= width, `width ${width}: line is ${visibleWidth(line)} columns`);
			}

			const tui = new TuiMainScreen(new VirtualTerminal(width, 10));
			tui.addChild(text);
			try {
				assert.doesNotThrow(() => tui.renderNow(), `width ${width}`);
			} finally {
				tui.stop();
			}
		}
	});
});
