import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { clearLegacyResultAnimationTimer, renderSubagentResult, syncResultAnimation, widgetRenderKey } from "../../packages/subagents/src/tui/render.js";
import type { AsyncJobState, Details } from "../../packages/subagents/src/shared/types.js";

type RenderTheme = Parameters<typeof renderSubagentResult>[2];

const theme = {
  fg: (_name: string, value: string) => value,
  bg: (_name: string, value: string) => value,
  bold: (value: string) => value,
} as unknown as RenderTheme;

function withMockedNow<T>(now: number, run: () => T): T {
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    return run();
  } finally {
    Date.now = originalNow;
  }
}

describe("subagent render stability", () => {
  test("running result glyph is progress-driven, not wall-clock-driven", () => {
    const result: AgentToolResult<Details> = {
      content: [{ type: "text", text: "running" }],
      details: {
        mode: "single",
        results: [{
          agent: "worker",
          task: "do work",
          exitCode: 0,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
          progress: {
            agent: "worker",
            index: 0,
            status: "running",
            task: "do work",
            durationMs: 2_000,
            toolCount: 1,
            tokens: 10,
            recentTools: [],
            recentOutput: [],
          },
        }],
      },
    };

    const first = withMockedNow(10_000, () => renderSubagentResult(result, { expanded: false }, theme).render(120).join("\n"));
    const second = withMockedNow(10_080, () => renderSubagentResult(result, { expanded: false }, theme).render(120).join("\n"));

    assert.equal(second, first);
  });

  test("running result animation advances without progress changes", async () => {
    const result: AgentToolResult<Details> = {
      content: [{ type: "text", text: "running" }],
      details: {
        mode: "single",
        results: [{
          agent: "worker",
          task: "do work",
          exitCode: 0,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
          progress: {
            agent: "worker",
            index: 0,
            status: "running",
            task: "do work",
            durationMs: 2_000,
            toolCount: 1,
            tokens: 10,
            recentTools: [],
            recentOutput: [],
          },
        }],
      },
    };
    let invalidations = 0;
    const context = {
      state: {} as { subagentResultAnimationTimer?: ReturnType<typeof setInterval> },
      invalidate: () => { invalidations++; },
    };

    const first = renderSubagentResult(result, { expanded: false }, theme).render(120).join("\n");
    syncResultAnimation(result, context);
    try {
      await new Promise<void>((resolve, reject) => {
        const poll = setInterval(() => {
          if (invalidations === 0) return;
          clearTimeout(deadline);
          clearInterval(poll);
          resolve();
        }, 10);
        const deadline = setTimeout(() => {
          clearInterval(poll);
          reject(new Error("animation timer did not invalidate"));
        }, 250);
      });
      const second = renderSubagentResult(result, { expanded: false }, theme).render(120).join("\n");

      assert.notEqual(second, first);
    } finally {
      clearLegacyResultAnimationTimer(context);
    }
  });

  test("widget render key is stable when only wall clock changes", () => {
    const job: AsyncJobState = {
      asyncId: "abc123",
      asyncDir: "/tmp/abc123",
      status: "running",
      mode: "single",
      agents: ["worker"],
      updatedAt: 10_000,
      toolCount: 1,
      turnCount: 2,
    };

    const first = withMockedNow(10_000, () => widgetRenderKey(job));
    const second = withMockedNow(10_080, () => widgetRenderKey(job));

    assert.equal(second, first);
  });

  test("clears legacy result animation timers", () => {
    let fired = false;
    const timer = setInterval(() => {
      fired = true;
    }, 10_000);
    const context: { state: { subagentResultAnimationTimer?: ReturnType<typeof setInterval> } } = {
      state: { subagentResultAnimationTimer: timer },
    };

    clearLegacyResultAnimationTimer(context);

    assert.equal(context.state.subagentResultAnimationTimer, undefined);
    assert.equal(fired, false);
  });
});
