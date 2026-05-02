/** @jsxImportSource @opentui/react */

import { test, expect, describe, afterEach } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { OrchestratorPanel } from "../../../src/sdk/components/orchestrator-panel.tsx";
import { ErrorBoundary } from "../../../src/sdk/components/error-boundary.tsx";
import { renderReact, TEST_THEME } from "./test-helpers.tsx";

let panel: OrchestratorPanel | null = null;
let testSetup: Awaited<ReturnType<typeof createTestRenderer>> | null = null;

afterEach(() => {
  panel?.destroy();
  panel = null;
  testSetup?.renderer.destroy();
  testSetup = null;
});

async function createPanel() {
  testSetup = await createTestRenderer({ width: 80, height: 24 });
  panel = OrchestratorPanel.createWithRenderer(testSetup.renderer, {
    tmuxSession: "test-session",
  });
  return { panel, testSetup };
}

describe("OrchestratorPanel", () => {
  test("createWithRenderer creates an instance without throwing", async () => {
    const { panel: p } = await createPanel();
    expect(p).toBeInstanceOf(OrchestratorPanel);
  });

  test("createWithRenderer applies the UI background to the renderer", async () => {
    testSetup = await createTestRenderer({ width: 80, height: 24 });
    const backgroundCapture: {
      value: Parameters<typeof testSetup.renderer.setBackgroundColor>[0] | null;
    } = { value: null };
    const originalSetBackgroundColor = testSetup.renderer.setBackgroundColor.bind(testSetup.renderer);
    testSetup.renderer.setBackgroundColor = (color) => {
      backgroundCapture.value = color;
      originalSetBackgroundColor(color);
    };

    panel = OrchestratorPanel.createWithRenderer(testSetup.renderer, {
      tmuxSession: "test-session",
    });

    expect(backgroundCapture.value).toBe(TEST_THEME.background);
    expect(Reflect.get(testSetup.renderer, "forceFullRepaintRequested")).toBe(true);
  });

  test("showWorkflowInfo does not throw", async () => {
    const { panel: p } = await createPanel();
    expect(() =>
      p.showWorkflowInfo("wf", "claude", [
        { name: "s1", parents: [] },
        { name: "s2", parents: ["s1"] },
      ], "do stuff"),
    ).not.toThrow();
  });

  test("sessionStart does not throw", async () => {
    const { panel: p } = await createPanel();
    p.showWorkflowInfo("wf", "claude", [{ name: "s1", parents: [] }], "p");
    expect(() => p.sessionStart("s1")).not.toThrow();
  });

  test("sessionSuccess does not throw", async () => {
    const { panel: p } = await createPanel();
    p.showWorkflowInfo("wf", "claude", [{ name: "s1", parents: [] }], "p");
    p.sessionStart("s1");
    expect(() => p.sessionSuccess("s1")).not.toThrow();
  });

  test("sessionError does not throw", async () => {
    const { panel: p } = await createPanel();
    p.showWorkflowInfo("wf", "claude", [{ name: "s1", parents: [] }], "p");
    p.sessionStart("s1");
    expect(() => p.sessionError("s1", "timeout")).not.toThrow();
  });

  test("showCompletion does not throw", async () => {
    const { panel: p } = await createPanel();
    p.showWorkflowInfo("wf", "claude", [{ name: "s1", parents: [] }], "p");
    expect(() => p.showCompletion("wf", "/tmp/t")).not.toThrow();
  });

  test("showFatalError does not throw", async () => {
    const { panel: p } = await createPanel();
    p.showWorkflowInfo("wf", "claude", [], "p");
    expect(() => p.showFatalError("catastrophic")).not.toThrow();
  });

  test("waitForExit marks completion and returns a promise", async () => {
    const { panel: p } = await createPanel();
    p.showWorkflowInfo("wf", "claude", [], "p");

    const exitPromise = p.waitForExit();
    expect(exitPromise).toBeInstanceOf(Promise);

    // The promise should be pending until externally resolved
    // Simulate external resolution (e.g. from Ctrl+C handler)
    let resolved = false;
    exitPromise.then(() => { resolved = true; });

    // Not yet resolved
    await Bun.sleep(10);
    expect(resolved).toBe(false);
  });

  test("destroy is idempotent", async () => {
    const { panel: p } = await createPanel();
    p.destroy();
    expect(() => p.destroy()).not.toThrow();
    // Prevent afterEach from double-destroying
    panel = null;
  });

  test("sessionAwaitingInput does not throw", async () => {
    const { panel: p } = await createPanel();
    p.showWorkflowInfo("wf", "claude", [{ name: "s1", parents: [] }], "p");
    p.sessionStart("s1");
    expect(() => p.sessionAwaitingInput("s1")).not.toThrow();
  });

  test("sessionResumed does not throw", async () => {
    const { panel: p } = await createPanel();
    p.showWorkflowInfo("wf", "claude", [{ name: "s1", parents: [] }], "p");
    p.sessionStart("s1");
    p.sessionAwaitingInput("s1");
    expect(() => p.sessionResumed("s1")).not.toThrow();
  });

  test("full lifecycle: create → workflow → start → complete → destroy", async () => {
    const { panel: p } = await createPanel();
    p.showWorkflowInfo("lifecycle-test", "copilot", [
      { name: "a", parents: [] },
      { name: "b", parents: [] },
      { name: "c", parents: ["a", "b"] },
    ], "test prompt");

    p.sessionStart("a");
    p.sessionSuccess("a");
    p.sessionStart("b");
    p.sessionError("b", "failed");
    p.showFatalError("b failed");
    p.destroy();
    panel = null;

    // If we get here without throwing, the full lifecycle works
    expect(true).toBe(true);
  });

  describe("ErrorBoundary fallback", () => {
    function ThrowingChild(): never {
      throw new Error("component exploded");
    }

    test("renders fallback with error message when child throws", async () => {
      const originalError = console.error;
      console.error = () => {};

      const setup = await renderReact(
        <ErrorBoundary
          fallback={(err) => (
            <box
              width="100%"
              height="100%"
              justifyContent="center"
              alignItems="center"
              backgroundColor={TEST_THEME.background}
            >
              <text>
                <span fg={TEST_THEME.error}>
                  {`Fatal render error: ${err.message}`}
                </span>
              </text>
            </box>
          )}
        >
          <ThrowingChild />
        </ErrorBoundary>,
        { width: 80, height: 10 },
      );
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Fatal render error: component exploded");
      setup.renderer.destroy();

      console.error = originalError;
    });
  });
});
