import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { getGraphemeSegmenter, getWordSegmenter, visibleWidth } from "../src/utils.ts";

describe("visibleWidth", () => {
	it("measures styled ASCII without counting escape sequences", () => {
		assert.strictEqual(visibleWidth("\x1b[38;5;4mhello\x1b[39m world"), 11);
		assert.strictEqual(visibleWidth("\x1b]8;;https://example.com\x07link\x1b]8;;\x07"), 4);
		assert.strictEqual(visibleWidth("\x1b]133;A\x1b\\prompt"), 6);
		assert.strictEqual(visibleWidth("\x1b_pi:c\x07cursor"), 6);
	});

	it("counts tabs as three columns in styled text", () => {
		assert.strictEqual(visibleWidth("\x1b[1ma\tb\x1b[22m"), 5);
	});

	it("measures styled non-ASCII text", () => {
		assert.strictEqual(visibleWidth("\x1b[31m日本\x1b[39m ok"), 7);
		assert.strictEqual(visibleWidth("\x1b[31m─→\x1b[39m"), 2);
	});

	it("treats unterminated escape sequences as zero-width control characters", () => {
		assert.strictEqual(visibleWidth("\x1b[31"), 3);
		assert.strictEqual(visibleWidth("a\x1b"), 1);
	});

	it("matches RGI_Emoji width across the entire Dingbats block and keeps segmenters singleton", () => {
		const rgi = /^\p{RGI_Emoji}$/v;
		for (let cp = 0x2700; cp <= 0x27bf; cp++) {
			const ch = String.fromCodePoint(cp);
			assert.strictEqual(
				visibleWidth(ch),
				rgi.test(ch) ? 2 : 1,
				`U+${cp.toString(16).toUpperCase()} width mismatch`,
			);
			const withVs16 = `${ch}\uFE0F`;
			if (rgi.test(withVs16)) {
				assert.strictEqual(visibleWidth(withVs16), 2, `U+${cp.toString(16).toUpperCase()}+FE0F width mismatch`);
			}
		}
		assert.strictEqual(visibleWidth("❯ "), 2);
		assert.strictEqual(getGraphemeSegmenter(), getGraphemeSegmenter());
		assert.strictEqual(getWordSegmenter(), getWordSegmenter());
	});

	it("defers Intl.Segmenter construction at import time and skips RGI_Emoji regex on U+276F prompt glyph", () => {
		const indexUrl = new URL("../src/index.ts", import.meta.url).href;
		const script = `
			let segmenterCalls = 0;
			const OrigSegmenter = Intl.Segmenter;
			Intl.Segmenter = class extends OrigSegmenter {
				constructor(...args) { segmenterCalls++; super(...args); }
			};
			let rgiTested = false;
			const origTest = RegExp.prototype.test;
			RegExp.prototype.test = function(s) {
				if (this.source.includes("RGI_Emoji")) rgiTested = true;
				return origTest.call(this, s);
			};
			const tui = await import(${JSON.stringify(indexUrl)});
			const atImport = segmenterCalls;
			const w = tui.visibleWidth("❯ ");
			process.stdout.write(JSON.stringify({ atImport, afterPrompt: segmenterCalls, rgiTested, w }));
		`;
		const out = JSON.parse(
			execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }),
		) as { atImport: number; afterPrompt: number; rgiTested: boolean; w: number };
		assert.strictEqual(out.w, 2);
		assert.strictEqual(out.atImport, 0);
		assert.strictEqual(out.rgiTested, false);
	});
});
