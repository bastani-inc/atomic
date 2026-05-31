import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  buildWidgetLines,
  clearLegacyResultAnimationTimer,
  currentRunningFrame,
  renderSubagentResult,
  renderWidget,
  RUNNING_ANIMATION_MS,
  stopResultAnimations,
  stopWidgetAnimation,
  syncResultAnimation,
  widgetRenderKey,
} from "../../packages/subagents/src/tui/render.js";
import type { ExtensionContext } from "@bastani/atomic";
import type { AsyncJobState, Details } from "../../packages/subagents/src/shared/types.js";

type RenderTheme = Parameters<typeof renderSubagentResult>[2];

const theme = {
  fg: (_name: string, value: string) => value,
  bg: (_name: string, value: string) => value,
  bold: (value: string) => value,
} as unknown as RenderTheme;

// Braille spinner frames used by the running glyph. Kept in sync with render.ts.
const RUNNING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_CHARS = new Set(RUNNING_FRAMES);

function withMockedNow<T>(now: number, run: () => T): T {
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    return run();
  } finally {
    Date.now = originalNow;
  }
}

function stripSpinnerChars(line: string): string {
  return [...line].filter((char) => !SPINNER_CHARS.has(char)).join("");
}

function firstSpinnerChar(text: string): string | undefined {
  for (const char of text) if (SPINNER_CHARS.has(char)) return char;
  return undefined;
}

function runningSingleResult(): AgentToolResult<Details> {
  return {
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
}

describe("subagent fast-mode UI labels (issue #1153)", () => {
  test("foreground compact result renders fast after thinking", () => {
    const result: AgentToolResult<Details> = {
      content: [{ type: "text", text: "done" }],
      details: {
        mode: "single",
        results: [{
          agent: "worker",
          task: "do work",
          exitCode: 0,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
          model: "openai/gpt-5.1-codex:medium",
          fastMode: true,
          finalOutput: "done",
        }],
      },
    };

    const text = renderSubagentResult(result, { expanded: false }, theme).render(120).join("\n");

    assert.match(text, /gpt-5\.1-codex · thinking medium · fast/);
  });

  test("foreground result omits fast when metadata is missing", () => {
    const result: AgentToolResult<Details> = {
      content: [{ type: "text", text: "done" }],
      details: {
        mode: "single",
        results: [{
          agent: "worker",
          task: "do work",
          exitCode: 0,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
          model: "openai/gpt-5.1-codex:medium",
          finalOutput: "done",
        }],
      },
    };

    const text = renderSubagentResult(result, { expanded: false }, theme).render(120).join("\n");

    assert.match(text, /gpt-5\.1-codex · thinking medium/);
    assert.doesNotMatch(text, / · fast/);
  });

  test("async widget step renders fast after thinking", () => {
    const job: AsyncJobState = {
      asyncId: "fast-run",
      asyncDir: "/tmp/fast-run",
      status: "running",
      mode: "single",
      agents: ["worker"],
      updatedAt: 10_000,
      steps: [{
        index: 0,
        agent: "worker",
        status: "running",
        model: "openai/gpt-5.1-codex",
        thinking: "medium",
        fastMode: true,
      }],
    };

    const text = withMockedNow(10_000, () => buildWidgetLines([job], theme, 120).join("\n"));

    assert.match(text, /gpt-5\.1-codex · thinking medium · fast/);
  });
});

describe("subagent running spinner animation (issue #1084)", () => {
  afterEach(() => {
    stopResultAnimations();
  });

  test("running glyph advances with wall clock (no longer frozen)", () => {
    const result = runningSingleResult();

    // Two renders exactly one animation frame apart must differ: the spinner
    // is driven by wall-clock time, not by progress data changes.
    const first = withMockedNow(10_000, () => renderSubagentResult(result, { expanded: false }, theme).render(120).join("\n"));
    const second = withMockedNow(10_000 + RUNNING_ANIMATION_MS, () => renderSubagentResult(result, { expanded: false }, theme).render(120).join("\n"));

    assert.notEqual(second, first, "running spinner should advance after one animation interval");
  });

  // NOTE: this invariant assumes the render path only consults Date.now() for
  // time (which the tests mock). If elapsed-time labels ever start reading
  // performance.now()/process.uptime(), this assertion would start to drift.
  test("renders within the same animation frame are identical (deterministic, no churn)", () => {
    const result = runningSingleResult();
    const frameStart = 10_000;

    const a = withMockedNow(frameStart, () => renderSubagentResult(result, { expanded: false }, theme).render(120).join("\n"));
    const b = withMockedNow(frameStart + RUNNING_ANIMATION_MS - 1, () => renderSubagentResult(result, { expanded: false }, theme).render(120).join("\n"));

    assert.equal(b, a, "renders inside the same animation frame must be byte-identical");
  });

  test("consecutive frames differ only in spinner glyph cells (minimal diff = no flicker)", () => {
    const result = runningSingleResult();

    const firstLines = withMockedNow(10_000, () => renderSubagentResult(result, { expanded: false }, theme).render(120));
    const secondLines = withMockedNow(10_000 + RUNNING_ANIMATION_MS, () => renderSubagentResult(result, { expanded: false }, theme).render(120));

    assert.equal(firstLines.length, secondLines.length, "line count must stay stable across animation frames");

    let changedLines = 0;
    for (let i = 0; i < firstLines.length; i++) {
      if (firstLines[i] === secondLines[i]) continue;
      changedLines++;
      // The only thing that may change between frames is the spinner glyph.
      assert.equal(
        stripSpinnerChars(firstLines[i]!),
        stripSpinnerChars(secondLines[i]!),
        `line ${i} changed in non-spinner content between animation frames`,
      );
    }
    assert.ok(changedLines > 0, "expected at least one spinner line to animate");
  });

  test("running glyph cycles through frames in order over a full period", () => {
    const result = runningSingleResult();
    const sequence: string[] = [];
    for (let frame = 0; frame <= RUNNING_FRAMES.length; frame++) {
      const out = withMockedNow(frame * RUNNING_ANIMATION_MS, () =>
        renderSubagentResult(result, { expanded: false }, theme).render(120).join("\n"));
      const glyph = firstSpinnerChar(out);
      assert.ok(glyph, `expected a spinner glyph at frame ${frame}`);
      sequence.push(glyph!);
    }
    // Every distinct frame is visited...
    assert.equal(new Set(sequence).size, RUNNING_FRAMES.length, "spinner should visit every frame");
    // ...and each step advances to the cyclic successor in RUNNING_FRAMES order.
    for (let i = 1; i < sequence.length; i++) {
      const prev = RUNNING_FRAMES.indexOf(sequence[i - 1]!);
      const cur = RUNNING_FRAMES.indexOf(sequence[i]!);
      assert.equal(cur, (prev + 1) % RUNNING_FRAMES.length, `frame ${i} did not advance by exactly one step`);
    }
  });

  test("async widget spinner advances with wall clock for running jobs", () => {
    const job: AsyncJobState = {
      asyncId: "abc123",
      asyncDir: "/tmp/abc123",
      status: "running",
      mode: "single",
      agents: ["worker"],
      updatedAt: 10_000,
      lastActivityAt: 10_000,
      toolCount: 1,
      turnCount: 2,
    };
    const first = withMockedNow(10_000, () => buildWidgetLines([job], theme, 120).join("\n"));
    const second = withMockedNow(10_000 + RUNNING_ANIMATION_MS, () => buildWidgetLines([job], theme, 120).join("\n"));
    assert.notEqual(second, first, "running async widget spinner should animate over wall-clock time");
  });

  test("currentRunningFrame advances one step per animation interval", () => {
    const f0 = currentRunningFrame(1_000_000);
    const f1 = currentRunningFrame(1_000_000 + RUNNING_ANIMATION_MS);
    const fSame = currentRunningFrame(1_000_000 + RUNNING_ANIMATION_MS - 1);
    assert.equal(f1 - f0, 1);
    assert.equal(fSame, f0);
  });
});

describe("subagent result animation timer lifecycle", () => {
  afterEach(() => {
    stopResultAnimations();
  });

  test("starts an invalidate ticker for running results and is idempotent", () => {
    const context = { state: {} as { subagentResultAnimationTimer?: ReturnType<typeof setInterval> }, invalidate: () => {} };

    syncResultAnimation(runningSingleResult(), context);
    const timer = context.state.subagentResultAnimationTimer;
    assert.ok(timer, "expected a running result to start an animation timer");

    // Calling again with a still-running result must not spawn a second timer.
    syncResultAnimation(runningSingleResult(), context);
    assert.equal(context.state.subagentResultAnimationTimer, timer, "timer should be reused while still running");
  });

  test("stops the ticker when the result is no longer running", () => {
    const context = { state: {} as { subagentResultAnimationTimer?: ReturnType<typeof setInterval> }, invalidate: () => {} };
    syncResultAnimation(runningSingleResult(), context);
    assert.ok(context.state.subagentResultAnimationTimer);

    const finished: AgentToolResult<Details> = {
      content: [{ type: "text", text: "done" }],
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
            status: "completed",
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
    syncResultAnimation(finished, context);
    assert.equal(context.state.subagentResultAnimationTimer, undefined, "completed result must stop the animation timer");
  });

  test("re-sync refreshes the invalidate callback used by the ticker", async () => {
    let firstCalls = 0;
    let secondCalls = 0;
    const state = {} as { subagentResultAnimationTimer?: ReturnType<typeof setInterval> };
    syncResultAnimation(runningSingleResult(), { state, invalidate: () => firstCalls++ });
    const timer = state.subagentResultAnimationTimer;
    // Re-sync with the same (stable) state object but a fresh invalidate closure,
    // mirroring the host handing us a new render context for the same renderable.
    syncResultAnimation(runningSingleResult(), { state, invalidate: () => secondCalls++ });
    assert.equal(state.subagentResultAnimationTimer, timer, "timer should be reused across re-sync");
    await new Promise((resolve) => setTimeout(resolve, RUNNING_ANIMATION_MS * 3 + 40));
    stopResultAnimations();
    assert.equal(firstCalls, 0, "stale invalidate must not be called after re-sync");
    assert.ok(secondCalls >= 1, `refreshed invalidate should fire, saw ${secondCalls}`);
  });

  test("invokes invalidate on each animation tick", async () => {
    let ticks = 0;
    const context = {
      state: {} as { subagentResultAnimationTimer?: ReturnType<typeof setInterval> },
      invalidate: () => {
        ticks++;
      },
    };
    syncResultAnimation(runningSingleResult(), context);
    await new Promise((resolve) => setTimeout(resolve, RUNNING_ANIMATION_MS * 3 + 40));
    stopResultAnimations();
    assert.ok(ticks >= 1, `expected the animation ticker to fire at least once, saw ${ticks}`);
  });

  test("stopResultAnimations clears all timers", () => {
    const context = { state: {} as { subagentResultAnimationTimer?: ReturnType<typeof setInterval> }, invalidate: () => {} };
    syncResultAnimation(runningSingleResult(), context);
    assert.ok(context.state.subagentResultAnimationTimer);
    stopResultAnimations();
    assert.equal(context.state.subagentResultAnimationTimer, undefined);
  });

  test("a throwing invalidate tears the ticker down instead of crashing", async () => {
    const context = {
      state: {} as { subagentResultAnimationTimer?: ReturnType<typeof setInterval> },
      invalidate: () => {
        throw new Error("This extension ctx is stale after session replacement or reload");
      },
    };
    syncResultAnimation(runningSingleResult(), context);
    assert.ok(context.state.subagentResultAnimationTimer);
    await new Promise((resolve) => setTimeout(resolve, RUNNING_ANIMATION_MS * 2 + 40));
    assert.equal(context.state.subagentResultAnimationTimer, undefined, "a throwing tick must stop and clear its own timer");
  });
});

describe("async widget animation ticker lifecycle", () => {
  afterEach(() => {
    stopWidgetAnimation();
  });

  function mockWidgetCtx(): { ctx: ExtensionContext; renders: () => number } {
    let renderCount = 0;
    const ctx = {
      hasUI: true,
      ui: {
        setWidget: () => {},
        getToolsExpanded: () => false,
        requestRender: () => {
          renderCount++;
        },
      },
    } as unknown as ExtensionContext;
    return { ctx, renders: () => renderCount };
  }

  function runningJob(): AsyncJobState {
    return {
      asyncId: "job1",
      asyncDir: "/tmp/job1",
      status: "running",
      mode: "single",
      agents: ["worker"],
      updatedAt: 10_000,
      lastActivityAt: 10_000,
      toolCount: 1,
      turnCount: 1,
    };
  }

  test("running jobs drive periodic re-renders; finished jobs stop them", async () => {
    const { ctx, renders } = mockWidgetCtx();
    renderWidget(ctx, [runningJob()]);
    await new Promise((resolve) => setTimeout(resolve, RUNNING_ANIMATION_MS * 3 + 40));
    const whileRunning = renders();
    assert.ok(whileRunning >= 1, `expected periodic widget re-renders while running, saw ${whileRunning}`);

    renderWidget(ctx, [{ ...runningJob(), status: "complete" }]);
    const afterStop = renders();
    await new Promise((resolve) => setTimeout(resolve, RUNNING_ANIMATION_MS * 3 + 40));
    assert.equal(renders(), afterStop, "widget ticker must stop once no job is running");
  });

  test("mounts the async widget belowEditor so its live line stays within the viewport (flicker-free)", () => {
    const opts: unknown[] = [];
    const ctx = {
      hasUI: true,
      ui: {
        setWidget: (_key: string, _factory: unknown, o?: unknown) => {
          opts.push(o);
        },
        getToolsExpanded: () => false,
        requestRender: () => {},
      },
    } as unknown as ExtensionContext;
    renderWidget(ctx, [runningJob()]);
    assert.deepEqual(
      opts,
      [{ placement: "belowEditor" }],
      "async widget must mount belowEditor (matches the workflow widget; avoids the above-fold flicker)",
    );
  });
});

describe("subagent render stability invariants", () => {
  afterEach(() => {
    stopResultAnimations();
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
