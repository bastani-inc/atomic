/** @jsxImportSource @opentui/react */

import { test, expect, describe, afterEach } from "bun:test";
import type { CapturedSpan } from "@opentui/core";
import { PanelStore } from "../../../src/sdk/components/orchestrator-panel-store.ts";
import { NodeCard } from "../../../src/sdk/components/node-card.tsx";
import type { LayoutNode } from "../../../src/sdk/components/layout.ts";
import { NODE_H } from "../../../src/sdk/components/layout.ts";
import { renderReact, TestProviders, TEST_THEME, type ReactTestSetup } from "./test-helpers.tsx";

let testSetup: ReactTestSetup | null = null;

afterEach(() => {
  testSetup?.renderer.destroy();
  testSetup = null;
});

function makeLayoutNode(overrides: Partial<LayoutNode> = {}): LayoutNode {
  return {
    name: "test-node",
    status: "pending",
    parents: [],
    startedAt: null,
    endedAt: null,
    children: [],
    depth: 0,
    x: 0,
    y: 0,
    ...overrides,
  };
}

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

describe("NodeCard", () => {
  test("renders pending node with dash for duration", async () => {
    const store = new PanelStore();
    const node = makeLayoutNode({ name: "my-session", status: "pending" });

    testSetup = await renderReact(
      <TestProviders store={store}>
        <NodeCard node={node} focused={false} pulsePhase={0} displayH={NODE_H} />
      </TestProviders>,
      { width: 60, height: 10 },
    );
    await testSetup.renderOnce();
    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("my-session");
    expect(frame).toContain("\u2014"); // em dash for no duration
  });

  test("renders running node with duration", async () => {
    const store = new PanelStore();
    const now = Date.now();
    const node = makeLayoutNode({
      name: "worker",
      status: "running",
      startedAt: now - 65000, // 1m 05s ago
    });

    testSetup = await renderReact(
      <TestProviders store={store}>
        <NodeCard node={node} focused={false} pulsePhase={0} displayH={NODE_H} />
      </TestProviders>,
      { width: 60, height: 10 },
    );
    await testSetup.renderOnce();
    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("worker");
    expect(frame).toContain("1m");
  });

  test("renders complete node with final duration", async () => {
    const store = new PanelStore();
    const node = makeLayoutNode({
      name: "done-node",
      status: "complete",
      startedAt: 1000,
      endedAt: 6000, // 5 seconds
    });

    testSetup = await renderReact(
      <TestProviders store={store}>
        <NodeCard node={node} focused={false} pulsePhase={0} displayH={NODE_H} />
      </TestProviders>,
      { width: 60, height: 10 },
    );
    await testSetup.renderOnce();
    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("done-node");
    expect(frame).toContain("0m 05s");
  });

  test("renders error node", async () => {
    const store = new PanelStore();
    const node = makeLayoutNode({
      name: "err-node",
      status: "error",
      error: "timeout",
      startedAt: 1000,
      endedAt: 3000,
    });

    testSetup = await renderReact(
      <TestProviders store={store}>
        <NodeCard node={node} focused={false} pulsePhase={0} displayH={NODE_H} />
      </TestProviders>,
      { width: 60, height: 10 },
    );
    await testSetup.renderOnce();
    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("err-node");
  });

  test("renders focused node", async () => {
    const store = new PanelStore();
    const node = makeLayoutNode({ name: "focused-node", status: "pending" });

    testSetup = await renderReact(
      <TestProviders store={store}>
        <NodeCard node={node} focused={true} pulsePhase={0} displayH={NODE_H} />
      </TestProviders>,
      { width: 60, height: 10 },
    );
    await testSetup.renderOnce();
    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("focused-node");
  });

  test("awaiting_input node renders 'waiting for response' text", async () => {
    const store = new PanelStore();
    const node = makeLayoutNode({
      name: "hil-node",
      status: "awaiting_input",
      startedAt: Date.now() - 5000,
    });

    testSetup = await renderReact(
      <TestProviders store={store}>
        <NodeCard node={node} focused={false} pulsePhase={0} displayH={6} />
      </TestProviders>,
      { width: 60, height: 12 },
    );
    await testSetup.renderOnce();
    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("hil-node");
    expect(frame).toContain("waiting for response");
  });

  test("awaiting_input node renders '↵ enter to respond' hint", async () => {
    const store = new PanelStore();
    const node = makeLayoutNode({
      name: "hil-node",
      status: "awaiting_input",
      startedAt: Date.now() - 5000,
    });

    testSetup = await renderReact(
      <TestProviders store={store}>
        <NodeCard node={node} focused={false} pulsePhase={0} displayH={6} />
      </TestProviders>,
      { width: 60, height: 12 },
    );
    await testSetup.renderOnce();
    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("enter to respond");
  });

  test("awaiting_input node at different pulse phases renders without error", async () => {
    const store = new PanelStore();
    const node = makeLayoutNode({
      name: "hil-pulse",
      status: "awaiting_input",
      startedAt: Date.now(),
    });

    // Phase 0
    testSetup = await renderReact(
      <TestProviders store={store}>
        <NodeCard node={node} focused={false} pulsePhase={0} displayH={6} />
      </TestProviders>,
      { width: 60, height: 12 },
    );
    await testSetup.renderOnce();
    expect(testSetup.captureCharFrame()).toContain("hil-pulse");
    testSetup.renderer.destroy();

    // Phase 16 (half cycle)
    testSetup = await renderReact(
      <TestProviders store={store}>
        <NodeCard node={node} focused={true} pulsePhase={16} displayH={6} />
      </TestProviders>,
      { width: 60, height: 12 },
    );
    await testSetup.renderOnce();
    expect(testSetup.captureCharFrame()).toContain("hil-pulse");
  });

  test("running node at different pulse phases renders without error", async () => {
    const store = new PanelStore();
    const node = makeLayoutNode({ name: "pulse-test", status: "running", startedAt: Date.now() });

    // Test at phase 0
    testSetup = await renderReact(
      <TestProviders store={store}>
        <NodeCard node={node} focused={false} pulsePhase={0} displayH={NODE_H} />
      </TestProviders>,
      { width: 60, height: 10 },
    );
    await testSetup.renderOnce();
    expect(testSetup.captureCharFrame()).toContain("pulse-test");
    testSetup.renderer.destroy();

    // Test at phase 16 (half cycle)
    testSetup = await renderReact(
      <TestProviders store={store}>
        <NodeCard node={node} focused={true} pulsePhase={16} displayH={NODE_H} />
      </TestProviders>,
      { width: 60, height: 10 },
    );
    await testSetup.renderOnce();
    expect(testSetup.captureCharFrame()).toContain("pulse-test");
  });

  test("running node fills interior with graph background", async () => {
    const store = new PanelStore();
    const now = Date.now();
    const node = makeLayoutNode({
      name: "worker",
      status: "running",
      startedAt: now - 65000,
    });

    testSetup = await renderReact(
      <TestProviders store={store}>
        <NodeCard node={node} focused={false} pulsePhase={0} displayH={NODE_H} />
      </TestProviders>,
      { width: 60, height: 10 },
    );
    await testSetup.renderOnce();

    const durationSpan = findSpanContaining(testSetup, "1m");
    expect(durationSpan).toBeDefined();
    if (!durationSpan) throw new Error("Expected running node duration span");
    expect(spanHex(durationSpan.bg)).toBe(TEST_THEME.background);
  });

  test("focused running node does not tint interior with warning color", async () => {
    const store = new PanelStore();
    const now = Date.now();
    const node = makeLayoutNode({
      name: "focused-worker",
      status: "running",
      startedAt: now - 65000,
    });

    testSetup = await renderReact(
      <TestProviders store={store}>
        <NodeCard node={node} focused={true} pulsePhase={16} displayH={NODE_H} />
      </TestProviders>,
      { width: 60, height: 10 },
    );
    await testSetup.renderOnce();

    const durationSpan = findSpanContaining(testSetup, "1m");
    expect(durationSpan).toBeDefined();
    if (!durationSpan) throw new Error("Expected focused running node duration span");
    expect(spanHex(durationSpan.fg)).toBe(TEST_THEME.warning);
    expect(spanHex(durationSpan.bg)).toBe(TEST_THEME.background);
  });

  test("running node border keeps explicit graph background", async () => {
    const store = new PanelStore();
    const node = makeLayoutNode({
      name: "worker",
      status: "running",
      startedAt: Date.now() - 65000,
    });

    testSetup = await renderReact(
      <TestProviders store={store}>
        <NodeCard node={node} focused={true} pulsePhase={16} displayH={NODE_H} />
      </TestProviders>,
      { width: 60, height: 10 },
    );
    await testSetup.renderOnce();

    const borderSpan = findSpanContaining(testSetup, "worker");
    expect(borderSpan).toBeDefined();
    if (!borderSpan) throw new Error("Expected running node border/title span");
    expect(spanHex(borderSpan.bg)).toBe(TEST_THEME.background);
  });
});
