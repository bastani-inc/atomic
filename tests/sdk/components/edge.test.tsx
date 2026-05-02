/** @jsxImportSource @opentui/react */

import { test, expect, describe, afterEach } from "bun:test";
import type { CapturedSpan } from "@opentui/core";
import { Edge } from "../../../src/sdk/components/edge.tsx";
import { renderReact, TEST_THEME, type ReactTestSetup } from "./test-helpers.tsx";

let testSetup: ReactTestSetup | null = null;

afterEach(() => {
  testSetup?.renderer.destroy();
  testSetup = null;
});

function spanHex(color: CapturedSpan["bg"]): string {
  const [r, g, b] = color.toInts();
  return "#" + [r, g, b].map((part) => part.toString(16).padStart(2, "0")).join("");
}

function findSpanContaining(setup: ReactTestSetup, text: string): CapturedSpan | undefined {
  return setup
    .captureSpans()
    .lines.flatMap((line) => line.spans)
    .find((span) => span.text.includes(text));
}

describe("Edge", () => {
  test("renders straight vertical connector text", async () => {
    testSetup = await renderReact(
      <Edge
        text="│"
        col={5}
        row={2}
        width={1}
        height={1}
        color={TEST_THEME.borderActive}
        backgroundColor={TEST_THEME.background}
      />,
      { width: 40, height: 10 },
    );
    await testSetup.renderOnce();
    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("│");
  });

  test("renders branching connector with horizontal bar", async () => {
    const branchText = "╭──┬──╮";
    testSetup = await renderReact(
      <Edge
        text={branchText}
        col={0}
        row={0}
        width={7}
        height={1}
        color={TEST_THEME.borderActive}
        backgroundColor={TEST_THEME.background}
      />,
      { width: 40, height: 10 },
    );
    await testSetup.renderOnce();
    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("─");
  });

  test("renders multiline connector text", async () => {
    const text = "│\n╰──╮";
    testSetup = await renderReact(
      <Edge
        text={text}
        col={0}
        row={0}
        width={4}
        height={2}
        color={TEST_THEME.text}
        backgroundColor={TEST_THEME.background}
      />,
      { width: 40, height: 10 },
    );
    await testSetup.renderOnce();
    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("│");
  });

  test("paints connector text with graph background", async () => {
    testSetup = await renderReact(
      <Edge
        text="│"
        col={5}
        row={2}
        width={1}
        height={1}
        color={TEST_THEME.warning}
        backgroundColor={TEST_THEME.background}
      />,
      { width: 40, height: 10 },
    );
    await testSetup.renderOnce();

    const span = findSpanContaining(testSetup, "│");
    expect(span).toBeDefined();
    if (!span) throw new Error("Expected connector span");
    expect(spanHex(span.bg)).toBe(TEST_THEME.background);
  });
});
