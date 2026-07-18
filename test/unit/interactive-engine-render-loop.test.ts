/**
 * Regression test for the host⇄engine remote tool-card render ping-pong that
 * presented as "TUI flickers when workflow quit/pause runs while a stage is
 * streaming".
 *
 * Mechanism: the host `RemoteToolExecutionComponent` re-sends
 * `engine_tool_render` whenever it is marked dirty by an
 * `engine_custom_invalidate` from the engine child. The child's
 * `EngineRenderService` used to dispose and recreate the
 * `ToolExecutionComponent` on every request, and re-seeding the fresh
 * component (`markExecutionStarted()` / `setArgsComplete()`) unconditionally
 * called `ui.requestRender()` on the throwaway render TUI. That render wrote
 * through `RenderTerminal.write()`, which emits `engine_custom_invalidate`
 * back to the host — so every render request produced another render request,
 * forever (~58 Hz full-repaint flicker fighting the streaming turn).
 *
 * The fix reuses the cached render record per componentId and makes the
 * seeding setters idempotent, so the loop converges after at most one
 * invalidate-driven round trip while legitimate async invalidations (e.g.
 * image conversion) still propagate.
 */

import { beforeAll, describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.ts";
import { EngineRenderService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-render-service.ts";
import {
  type InteractiveEngineMessage,
  type JsonObject,
  parseInteractiveEngineMessage,
  serializeInteractiveEngineFrame,
} from "../../packages/coding-agent/src/modes/interactive-engine/protocol.ts";
import type { ToolExecutionComponent } from "../../packages/coding-agent/src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";

beforeAll(() => {
  initTheme("dark");
});

const COMPONENT_ID = "remote_renderer_flicker_test";
type RenderableToolResult = Parameters<ToolExecutionComponent["updateResult"]>[0];

interface Harness {
  service: EngineRenderService;
  send(requestId: number, overrides?: { result?: RenderableToolResult; isPartial?: boolean }): void;
  waitForFrame(requestId: number): Promise<string[]>;
  settleInvalidates(windowMs: number): Promise<number>;
}

function makeSessionStub(): AgentSession {
  const stub = {
    getToolDefinition: () => undefined,
    sessionManager: { getCwd: () => process.cwd() },
  };
  return stub as unknown as AgentSession;
}

function makeHarness(): Harness {
  const messages: InteractiveEngineMessage[] = [];
  const service = new EngineRenderService((line) => {
    const parsed = parseInteractiveEngineMessage(line.trim());
    if (parsed) messages.push(parsed);
  });
  service.bindSession(makeSessionStub());

  const countInvalidates = (): number =>
    messages.filter((m) => m.type === "engine_custom_invalidate" && m.componentId === COMPONENT_ID).length;
  let consumedInvalidates = 0;

  return {
    service,
    send: (requestId, overrides = {}) => {
      const handled = service.handleLine(
        serializeInteractiveEngineFrame({
          type: "engine_tool_render",
          componentId: COMPONENT_ID,
          requestId,
          width: 80,
          // Unknown tool name → deterministic generic fallback rendering
          // (tool name + args JSON + text output), no tool-specific renderer.
          toolName: "flicker_probe_tool",
          toolCallId: "call_flicker_probe",
          args: { command: "echo hi" },
          result: overrides.result ? (JSON.parse(JSON.stringify(overrides.result)) as JsonObject) : undefined,
          executionStarted: true,
          argsComplete: true,
          isPartial: overrides.isPartial ?? true,
          expanded: false,
          showImages: false,
          imageWidthCells: 60,
        }).trim(),
      );
      assert.equal(handled, true, "engine_tool_render must be handled by EngineRenderService");
    },
    waitForFrame: async (requestId) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const frame = messages.find((m) => m.type === "engine_custom_frame" && m.requestId === requestId);
        if (frame && frame.type === "engine_custom_frame") return frame.lines;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`Timed out waiting for engine_custom_frame requestId=${requestId}`);
    },
    settleInvalidates: async (windowMs) => {
      // Count every invalidate that arrived since the previous settle call
      // (including ones that landed while waiting for the frame), then wait
      // for the window to expire so late TUI-timer renders are captured too.
      await new Promise((resolve) => setTimeout(resolve, windowMs));
      const total = countInvalidates();
      const fresh = total - consumedInvalidates;
      consumedInvalidates = total;
      return fresh;
    },
  };
}

describe("EngineRenderService remote tool render loop", () => {
  test("re-rendering the same tool card converges instead of ping-ponging", async () => {
    const harness = makeHarness();
    try {
      let requestId = 1;
      harness.send(requestId);
      await harness.waitForFrame(requestId);

      // Simulate the host: every engine_custom_invalidate marks the remote
      // component dirty, which re-sends the identical engine_tool_render on
      // the next frame. A converging renderer goes quiet after at most one
      // invalidate-driven round trip (the initial seeding render); the buggy
      // renderer emits a fresh invalidate for every request, forever.
      let rerenderRounds = 0;
      const maxRounds = 4;
      while (rerenderRounds < maxRounds) {
        // Window comfortably exceeds TUI.MIN_RENDER_INTERVAL_MS (16ms).
        const invalidates = await harness.settleInvalidates(120);
        if (invalidates === 0) break;
        rerenderRounds++;
        harness.send(++requestId);
        await harness.waitForFrame(requestId);
      }

      assert.ok(
        rerenderRounds <= 1,
        `remote tool renderer did not converge: ${rerenderRounds} invalidate-driven re-render rounds (render ping-pong / TUI flicker)`,
      );
    } finally {
      harness.service.dispose();
    }
  });

  test("a reused tool card still picks up new state (result update)", async () => {
    const harness = makeHarness();
    try {
      harness.send(1);
      const initial = await harness.waitForFrame(1);
      assert.ok(!initial.join("\n").includes("RESULT_MARKER_XYZ"), "result marker must not render before the result exists");

      harness.send(2, {
        result: {
          content: [{ type: "text", text: "RESULT_MARKER_XYZ" }],
          isError: false,
        } as RenderableToolResult,
        isPartial: false,
      });
      const updated = await harness.waitForFrame(2);
      assert.ok(
        updated.join("\n").includes("RESULT_MARKER_XYZ"),
        "re-render with a result must surface the new output (no stale cached frame)",
      );
    } finally {
      harness.service.dispose();
    }
  });
});
