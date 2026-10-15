import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	isTerminalLeftMousePress,
	parseTerminalMouseInput,
	terminalMouseWheelDirection,
} from "../../packages/workflows/src/tui/mouse-input.js";

function x10(buttonCode: number, col: number, row: number): string {
	return `\x1b[M${String.fromCharCode(buttonCode + 32)}${String.fromCharCode(col + 33)}${String.fromCharCode(row + 33)}`;
}

describe("shared workflow terminal mouse parser", () => {
	test("parses zero-based SGR press and release coordinates", () => {
		assert.deepEqual(parseTerminalMouseInput("\x1b[<0;5;9M"), {
			protocol: "sgr",
			action: "press",
			buttonCode: 0,
			col: 4,
			row: 8,
		});
		assert.deepEqual(parseTerminalMouseInput("\x1b[<0;5;9m"), {
			protocol: "sgr",
			action: "release",
			buttonCode: 0,
			col: 4,
			row: 8,
		});
	});

	test("does not accept X10 mouse input", () => {
		assert.equal(parseTerminalMouseInput(x10(64, 9, 4)), null);
	});

	test("normalizes vertical and horizontal wheel directions", () => {
		const inputs = [
			["\x1b[<64;1;1M", "up"],
			["\x1b[<65;1;1M", "down"],
			["\x1b[<66;2;2M", "left"],
			["\x1b[<67;2;2M", "right"],
		] as const;
		for (const [input, direction] of inputs) {
			const event = parseTerminalMouseInput(input);
			assert.ok(event);
			assert.equal(terminalMouseWheelDirection(event), direction);
		}
	});

	test("classifies only an unmodified primary-button press as a left press", () => {
		const press = parseTerminalMouseInput("\x1b[<0;2;3M");
		const release = parseTerminalMouseInput("\x1b[<0;2;3m");
		const motion = parseTerminalMouseInput("\x1b[<32;2;3M");
		assert.ok(press && release && motion);
		assert.equal(isTerminalLeftMousePress(press), true);
		assert.equal(isTerminalLeftMousePress(release), false);
		assert.equal(isTerminalLeftMousePress(motion), false);
	});

	test("rejects partial, malformed, and concatenated sequences", () => {
		for (const input of [
			"\x1b",
			"\x1b[<64;1;1",
			"\x1b[<64;0;1M",
			"\x1b[<x;1;1M",
			`${x10(64, 1, 1)}tail`,
			"plain text",
		]) {
			assert.equal(parseTerminalMouseInput(input), null);
		}
	});
});
