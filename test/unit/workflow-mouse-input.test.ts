import { describe, test } from "bun:test";
import assert from "node:assert/strict";
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

  test("parses complete legacy X10 input", () => {
    assert.deepEqual(parseTerminalMouseInput(x10(64, 9, 4)), {
      protocol: "x10",
      action: "press",
      buttonCode: 64,
      col: 9,
      row: 4,
    });
  });

  test("normalizes vertical and horizontal wheel directions", () => {
    const inputs = [
      ["\x1b[<64;1;1M", "up"],
      ["\x1b[<65;1;1M", "down"],
      [x10(66, 1, 1), "left"],
      [x10(67, 1, 1), "right"],
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
