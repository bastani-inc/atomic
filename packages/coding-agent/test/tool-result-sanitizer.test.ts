import assert from "node:assert/strict";
import { it } from "vitest";
import { getTextOutput } from "../src/core/tools/render-utils.ts";

// PR #2700: CPU time excludes scheduler delays on loaded runners. The allowance
// is deliberately far above a linear scan but below repeated suffix rescanning.
const SANITIZER_CPU_BUDGET_US = 1_000_000;

it("renders repeated unterminated control strings without quadratic CPU work or raw-data edits", () => {
	for (const [unit, visible] of [
		["\x9d", ""],
		["\x1b]", "]"],
		["\x1bP", ""],
		["\x1bX", "X"],
		["\x1b^", "^"],
		["\x1b_", "_"],
		["\x90", ""],
		["\x98", ""],
		["\x9e", ""],
		["\x9f", ""],
		["\x1b]\x9d\x1bP\x90", "]"],
	] as const) {
		const text = `${unit.repeat(640_000)}! plain tail`;
		const result = { content: [{ type: "text", text }] };
		const start = process.cpuUsage();
		const displayed = getTextOutput(result, false);
		const cpu = process.cpuUsage(start);
		assert.ok(
			cpu.user + cpu.system < SANITIZER_CPU_BUDGET_US,
			`${JSON.stringify(unit)} used ${cpu.user + cpu.system}us CPU`,
		);
		assert.equal(displayed, `${visible.repeat(640_000)}! plain tail`);
		assert.equal(result.content[0].text, text);
	}
});

it("removes complete ESC/C1 strings through each BEL/ST and preserves unterminated noncontrol text", () => {
	// PR #2700: includes nested introducers, multiline bodies, and adjacent strings.
	for (const start of ["\x1b]", "\x1bP", "\x1bX", "\x1b^", "\x1b_", "\x90", "\x98", "\x9d", "\x9e", "\x9f"]) {
		for (const end of ["\x07", "\x1b\\", "\x9c"]) {
			const text = `before${start}hidden\n\x1b]\x90body${end}middle${start}hidden${end}after\x1b]! tail\x9d!\x7f\r\t\n`;
			const result = { content: [{ type: "text", text }] };
			const raw = JSON.stringify(result);
			assert.equal(getTextOutput(result, false), "beforemiddleafter]! tail!\t\n");
			assert.equal(JSON.stringify(result), raw);
		}
	}
});
