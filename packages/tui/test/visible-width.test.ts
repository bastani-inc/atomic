import assert from "node:assert";
import { describe, it } from "node:test";
import { isOnLabelCell, visibleWidth } from "../src/utils.ts";

describe("label cells", () => {
	it("distinguishes pale or colored button text from concealed text and blank padding (#5696)", () => {
		for (const color of ["38;5;8", "38;2;8;150;20"]) {
			assert.equal(isOnLabelCell(`\x1b[${color}m[ 保存 ]\x1b[0m`, 3), true);
		}
		const label = "\x1b[8mX\x1b[28m\u2800   [ Save ]";
		assert.equal(isOnLabelCell(label, 0), false);
		assert.equal(isOnLabelCell(label, 3), false);
		assert.equal(isOnLabelCell(label, 7), true);
	});
});

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
});
