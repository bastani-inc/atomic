import assert from "node:assert/strict";
import { visibleWidth } from "@bastani/atomic-tui";
import { describe, test } from "vitest";
import { renderComposerRule } from "../src/modes/interactive/components/composer-rule.ts";

const plain = (text: string) => text;

describe("composer rule (#5224)", () => {
	test("a rule without a label is one glyph per column", () => {
		assert.equal(renderComposerRule(10, { color: plain }), "─".repeat(10));
		assert.equal(renderComposerRule(10, { color: plain, heavy: true }), "━".repeat(10));
	});

	test("a label sits right-aligned with a space on each side and one glyph after it", () => {
		const rule = renderComposerRule(60, { color: plain, label: "shipping fix-first" });
		assert.equal(visibleWidth(rule), 60);
		assert.ok(rule.endsWith(" shipping fix-first ─"), rule);
		assert.ok(rule.startsWith("──"), rule);
	});

	test("the heavy accent variant names the attached target the same way", () => {
		const rule = renderComposerRule(80, { color: plain, heavy: true, label: "debugger · #5220 spawn lock · 18m" });
		assert.equal(visibleWidth(rule), 80);
		assert.ok(rule.endsWith(" debugger · #5220 spawn lock · 18m ━"), rule);
	});

	test("a label longer than the rule is shortened with an ellipsis and keeps the width", () => {
		const rule = renderComposerRule(42, { color: plain, label: "x".repeat(100) });
		assert.equal(visibleWidth(rule), 42);
		assert.ok(rule.includes("…"), rule);
		assert.ok(rule.endsWith(" ─"), rule);
	});

	test("a rule narrower than 40 columns carries no label", () => {
		assert.equal(renderComposerRule(39, { color: plain, label: "title" }), "─".repeat(39));
	});

	test("the label keeps its own styling while the glyphs take the rule colour", () => {
		const colour = (text: string) => `<${text}>`;
		const rule = renderComposerRule(50, { color: colour, label: { plain: "title", styled: "[title]" } });
		assert.ok(rule.endsWith("[title]< ─>"), rule);
	});
});
