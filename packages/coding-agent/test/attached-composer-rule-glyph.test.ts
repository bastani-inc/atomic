import assert from "node:assert/strict";
import { visibleWidth } from "@bastani/atomic-tui";
import { describe, test } from "vitest";
import { renderComposerRule } from "../src/modes/interactive/components/composer-rule.ts";
import { applyAttachedComposer } from "../src/modes/interactive/components/input-label.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const accent = (text: string) => `\x1b[36m${text}\x1b[39m`;
const style = { accent, text: (text: string) => text, dim: (text: string) => `\x1b[2m${text}\x1b[22m` };
const plain = (text: string) => stripAnsi(text);
/** The rule glyphs of a composer line: every character that is not part of its label or overflow note. */
const ruleGlyphs = (line: string) =>
	new Set(
		plain(line)
			.replace(/ [^─━]* /gu, "")
			.split(""),
	);

describe("subagent and stage chat composers draw the main chat's rules", () => {
	const width = 80;
	const editor = (top = "─".repeat(width), bottom = "─".repeat(width)) => [top, "❯ ", bottom];

	test("a labelled attached composer's top rule reads exactly like the main composer's labelled rule", () => {
		const label = "worker · fixing a race · 2m";
		const [top] = applyAttachedComposer(style, label, "Message worker…", editor());
		assert.equal(plain(top!), renderComposerRule(width, { color: (text) => text, label }));
		assert.deepEqual(ruleGlyphs(top!), new Set(["─"]));
	});

	test("the attached composer's bottom rule is the main composer's light rule", () => {
		const lines = applyAttachedComposer(style, "worker · fixing a race", undefined, editor());
		assert.equal(plain(lines[2]!), "─".repeat(width));
	});

	test("an attached composer without a label, or too narrow for one, keeps light rules", () => {
		for (const [label, columns] of [
			[undefined, width],
			["worker · fixing a race", 39],
		] as const) {
			const lines = applyAttachedComposer(style, label, undefined, ["─".repeat(columns), "❯ ", "─".repeat(columns)]);
			assert.equal(plain(lines[0]!), "─".repeat(columns));
			assert.equal(plain(lines[2]!), "─".repeat(columns));
		}
	});

	test("an overflowing attached draft keeps light rules around its notes", () => {
		const above = `${"─".repeat(34)} ↑ 3 more ${"─".repeat(36)}`;
		const below = `${"─".repeat(33)} ↓ 12 more ${"─".repeat(36)}`;
		const lines = applyAttachedComposer(style, "worker · fixing a race", undefined, editor(above, below));
		for (const line of [lines[0]!, lines[2]!]) {
			assert.equal(visibleWidth(line), width);
			assert.deepEqual(ruleGlyphs(line), new Set(["─"]), plain(line));
		}
		assert.ok(plain(lines[0]!).includes("↑ 3 more"));
		assert.ok(plain(lines[2]!).includes("↓ 12 more"));
	});

	test("the attached composer's rules keep their accent colour", () => {
		const lines = applyAttachedComposer(style, "worker · fixing a race", undefined, editor());
		assert.ok(lines[0]!.startsWith("\x1b[36m"), JSON.stringify(lines[0]));
		assert.ok(lines[2]!.startsWith("\x1b[36m"), JSON.stringify(lines[2]));
	});
});
