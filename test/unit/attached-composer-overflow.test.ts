import assert from "node:assert/strict";
import { visibleWidth } from "@bastani/atomic-tui";
import { test } from "vitest";
import { applyAttachedComposer } from "../../packages/coding-agent/src/modes/interactive/components/input-label.ts";

const style = { accent: (text: string) => text, text: (text: string) => text, dim: (text: string) => text };
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

test("attached composer preserves its label and rules when the draft overflows below (#5239)", () => {
	const width = 80;
	const overflow = `${"─".repeat(33)} ↓ 12 more ${"─".repeat(36)}`;
	assert.equal(visibleWidth(overflow), width);
	const lines = applyAttachedComposer(style, "worker · fixing a race", undefined, [
		"─".repeat(width),
		"❯ first draft line",
		"  second draft line",
		overflow,
		"autocomplete result",
	]);
	assert.match(plain(lines[0]!), /^─+ worker · fixing a race ─$/u);
	assert.match(plain(lines[3]!), /^─+ ↓ 12 more ─+$/u);
	assert.equal(visibleWidth(lines[3]!), width);
	assert.equal(lines[4], "autocomplete result");
});

test("attached composer sanitizes untrusted labels and placeholders in every overflow branch (#5239)", () => {
	const hostile = "worker\x1b]52;c;secret\x07\x1b[2J\nnext";
	for (const top of [
		"─".repeat(80),
		...["↑", "↓"].map((arrow) => `${"─".repeat(34)} ${arrow} 2 more ${"─".repeat(36)}`),
	]) {
		const lines = applyAttachedComposer(style, hostile, `Message ${hostile}…`, [top, "❯", "─".repeat(80)]);
		for (const line of lines) {
			assert.doesNotMatch(plain(line), /[\x00-\x1f\x7f-\x9f]/u);
			assert.doesNotMatch(plain(line), /secret/u);
			assert.ok(visibleWidth(line) <= 80);
		}
		assert.match(plain(lines[0]!), /workernext|worker next/u);
		const overflow = top.match(/[↑↓] 2 more/u)?.[0];
		if (overflow) assert.ok(plain(lines[0]!).includes(overflow));
		assert.match(plain(lines[1]!), /Message worker/u);
	}
});
