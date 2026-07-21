// @ts-nocheck
import { afterEach, beforeAll, test } from "bun:test";
import assert from "node:assert/strict";
import { ChatSessionHost } from "../../packages/coding-agent/src/index.ts";
import {
  ATOMIC_WORKING_FRAME_MS,
} from "../../packages/coding-agent/src/modes/interactive/components/atomic-working-status.ts";
import { ANIMATION_FRAME_MS } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host-utils.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import {
  editorTheme,
  installLifecycleFakeClock,
  plainStyle,
  workingLine,
} from "./chat-session-host-working-lifecycle-fixture.ts";

const originalReducedMotion = process.env.ATOMIC_REDUCED_MOTION;

beforeAll(() => {
  initTheme("dark", false);
});

afterEach(() => {
  if (originalReducedMotion === undefined) delete process.env.ATOMIC_REDUCED_MOTION;
  else process.env.ATOMIC_REDUCED_MOTION = originalReducedMotion;
});

test("ChatSessionHost starts ordinary Atomic work at frame zero independent of wall clock", () => {
  delete process.env.ATOMIC_REDUCED_MOTION;
  const previousNow = Date.now;
  Date.now = () => 720;
  const host = new ChatSessionHost<never>({ style: plainStyle, editorTheme });
  try {
    host.applyAgentEvent({ type: "agent_start" } as never);
    assert.equal(workingLine(host), " ⠁ Working...");
  } finally {
    host.dispose();
    Date.now = previousNow;
  }
});


test("ChatSessionHost advances the exact Atomic cycle every lifecycle-relative 80ms", () => {
  delete process.env.ATOMIC_REDUCED_MOTION;
  const timers = installLifecycleFakeClock();
  let renderRequests = 0;
  const host = new ChatSessionHost<never>({
    style: plainStyle,
    editorTheme,
    requestRender: () => {
      renderRequests += 1;
    },
  });
  try {
    assert.equal(ANIMATION_FRAME_MS, 80);
    assert.equal(ATOMIC_WORKING_FRAME_MS, 80);
    host.applyAgentEvent({ type: "agent_start" } as never);

    assert.equal(renderRequests, 1, "agent_start requests one immediate frame-zero paint");
    assert.deepEqual(timers.intervalDelays(), [80]);
    assert.deepEqual(timers.timeoutDelays(), [], "a genuine start bypasses event throttling");
    assert.equal(timers.intervalCount(), 1);
    assert.equal(timers.timeoutCount(), 0);
    assert.equal(workingLine(host), " ⠁ Working...", "0ms");

    timers.advanceBy(79);
    assert.equal(workingLine(host), " ⠁ Working...", "79ms");
    assert.equal(renderRequests, 1);
    timers.advanceBy(1);
    assert.equal(workingLine(host), " ⠑ Working...", "80ms");
    assert.equal(renderRequests, 2);
    timers.advanceBy(79);
    assert.equal(workingLine(host), " ⠑ Working...", "159ms");
    assert.equal(renderRequests, 2);
    timers.advanceBy(241);
    assert.equal(workingLine(host), " ⣵ Working...", "400ms");
    assert.equal(renderRequests, 6);
    timers.advanceBy(399);
    assert.equal(workingLine(host), " ⠑ Working...", "799ms");
    assert.equal(renderRequests, 10);
    timers.advanceBy(1);
    assert.equal(workingLine(host), " ⠁ Working...", "800ms");
    assert.equal(renderRequests, 11, "one immediate request plus one request per tick");
  } finally {
    host.dispose();
    timers.restore();
  }
});


test("ChatSessionHost resets each literal turn once and stops between turns", () => {
  delete process.env.ATOMIC_REDUCED_MOTION;
  const previousRandom = Math.random;
  let selections = 0;
  Math.random = () => {
    selections += 1;
    return 0;
  };
  const timers = installLifecycleFakeClock();
  let renderRequests = 0;
  const host = new ChatSessionHost<never>({
    style: plainStyle,
    editorTheme,
    requestRender: () => {
      renderRequests += 1;
    },
  });
  try {
    host.applyAgentEvent({ type: "agent_start" } as never);
    assert.equal(renderRequests, 1);
    timers.animationTick();
    timers.animationTick();
    assert.equal(workingLine(host), " ⠕ Working...");

    const beforeFirstTurn = renderRequests;
    host.applyAgentEvent({ type: "turn_start" } as never);
    assert.equal(renderRequests, beforeFirstTurn + 1, "turn_start requests frame zero exactly once");
    assert.equal(timers.timeoutCount(), 0);
    assert.equal(selections, 1);
    assert.equal(workingLine(host), " ⠁ Schlepping...");
    assert.equal(timers.intervalCount(), 1);
    timers.animationTick();
    assert.equal(selections, 1);
    assert.equal(workingLine(host), " ⠑ Schlepping...");

    const beforeTurnEnd = renderRequests;
    host.applyAgentEvent({ type: "turn_end" } as never);
    assert.equal(renderRequests, beforeTurnEnd + 1, "turn_end cleanup repaints exactly once");
    assert.equal(timers.timeoutCount(), 0);
    assert.equal(host.hasAnimationTick(), false);
    assert.equal(workingLine(host), undefined);

    const beforeNextTurn = renderRequests;
    host.applyAgentEvent({ type: "turn_start" } as never);
    assert.equal(renderRequests, beforeNextTurn + 1);
    assert.equal(timers.timeoutCount(), 0);
    assert.equal(selections, 2);
    assert.equal(workingLine(host), " ⠁ Schlepping...");
    assert.equal(host.hasAnimationTick(), true);
  } finally {
    host.dispose();
    timers.restore();
    Math.random = previousRandom;
  }
});


test("ChatSessionHost ignores stale prior-generation and disposed callbacks", () => {
  delete process.env.ATOMIC_REDUCED_MOTION;
  const timers = installLifecycleFakeClock();
  let renderRequests = 0;
  const host = new ChatSessionHost<never>({
    style: plainStyle,
    editorTheme,
    requestRender: () => {
      renderRequests += 1;
    },
  });
  try {
    host.applyAgentEvent({ type: "agent_start" } as never);
    const firstGenerationTick = timers.capturedAnimationCallbacks()[0]!;
    firstGenerationTick();
    host.applyAgentEvent({ type: "auto_retry_start" } as never);
    host.applyAgentEvent({ type: "queue_update", steering: ["queued"] } as never);
    const staleEventRender = timers.capturedEventRenderCallbacks()[0]!;
    assert.deepEqual(timers.timeoutDelays(), [80]);
    host.applyAgentEvent({ type: "auto_retry_end", success: true } as never);
    host.applyAgentEvent({ type: "turn_start" } as never);
    const currentGenerationTick = timers.capturedAnimationCallbacks()[1]!;
    timers.flushEventRender();
    const baseline = renderRequests;
    const resetLine = workingLine(host);

    firstGenerationTick();
    assert.equal(workingLine(host), resetLine);
    assert.equal(renderRequests, baseline);

    currentGenerationTick();
    assert.match(workingLine(host) ?? "", /^ ⠑ /);
    assert.equal(renderRequests, baseline + 1);

    host.dispose();
    const afterDispose = renderRequests;
    currentGenerationTick();
    staleEventRender();
    host.applyAgentEvent({ type: "agent_start" } as never);
    assert.equal(renderRequests, afterDispose);
    assert.equal(timers.intervalCount(), 0);
    assert.equal(workingLine(host), undefined);
  } finally {
    host.dispose();
    timers.restore();
  }
});


test("ChatSessionHost terminal cleanup stops ordinary and compaction animation while preserving factual copy", () => {
  delete process.env.ATOMIC_REDUCED_MOTION;
  const cases = [
    [{ type: "agent_end", messages: [] }, undefined],
    [{ type: "model_fallback_end", success: false, from: "a", to: "b", finalError: "fallback auth failed" }, "fallback auth failed"],
    [{ type: "auto_retry_end", success: false, attempt: 2, finalError: "retry exhausted" }, undefined],
    [{ type: "agent_continue_error", source: "post_compaction", errorMessage: "provider failed" }, "provider failed"],
  ] as const;

  for (const [terminalEvent, factualCopy] of cases) {
    const timers = installLifecycleFakeClock();
    const host = new ChatSessionHost<never>({
      style: plainStyle,
      editorTheme,
      isStreaming: () => true,
    });
    try {
      host.applyAgentEvent({ type: "agent_start" } as never);
      host.applyAgentEvent({ type: "turn_start" } as never);
      host.applyAgentEvent({ type: "compaction_start", reason: "manual" } as never);
      assert.equal(host.hasAnimationTick(), true);

      host.applyAgentEvent(terminalEvent as never);
      assert.equal(host.hasAnimationTick(), false, terminalEvent.type);
      assert.equal(timers.intervalCount(), 0, terminalEvent.type);
      assert.deepEqual(host.renderWorkingStatus(64), [], terminalEvent.type);
      const body = host.renderBody(80, 8).join("\n");
      assert.doesNotMatch(body, /Working\.\.\.|Schlepping\.\.\./);
      if (factualCopy) assert.equal((body.match(new RegExp(factualCopy, "g")) ?? []).length, 1);
    } finally {
      host.dispose();
      timers.restore();
    }
  }

  const timers = installLifecycleFakeClock();
  const host = new ChatSessionHost<never>({
    style: plainStyle,
    editorTheme,
    isStreaming: () => true,
  });
  try {
    host.applyAgentEvent({ type: "agent_start" } as never);
    host.applyAgentEvent({ type: "compaction_start", reason: "threshold" } as never);
    host.clearBusyForTerminalWorkflowStage();
    assert.equal(host.hasAnimationTick(), false);
    assert.equal(timers.intervalCount(), 0);
    assert.deepEqual(host.renderWorkingStatus(64), []);
  } finally {
    host.dispose();
    timers.restore();
  }
});

test("ChatSessionHost reduced motion settles each lifecycle at the completed A without animation ticks", () => {
  process.env.ATOMIC_REDUCED_MOTION = "1";
  const timers = installLifecycleFakeClock();
  let renderRequests = 0;
  const host = new ChatSessionHost<never>({
    style: plainStyle,
    editorTheme,
    isStreaming: () => true,
    requestRender: () => {
      renderRequests += 1;
    },
  });
  try {
    assert.equal(workingLine(host), " ⣵ Working...");
    assert.equal(host.hasAnimationTick(), false);
    host.applyAgentEvent({ type: "agent_start" } as never);
    host.applyAgentEvent({ type: "turn_start" } as never);
    const beforeContentEvent = renderRequests;
    host.applyAgentEvent({
      type: "message_start",
      message: { role: "assistant", content: [] },
    } as never);

    assert.equal(host.entries().length, 1, "reduced-motion content updates before its throttled paint");
    assert.match(workingLine(host) ?? "", /^ ⣵ /);
    assert.equal(host.hasAnimationTick(), false);
    assert.equal(timers.intervalCount(), 0);
    assert.equal(timers.capturedAnimationCallbacks().length, 0);
    assert.deepEqual(timers.timeoutDelays(), [80]);
    timers.advanceBy(79);
    assert.equal(renderRequests, beforeContentEvent);
    timers.advanceBy(1);
    assert.equal(renderRequests, beforeContentEvent + 1, "content repaints at 80ms without animation");
    assert.match(workingLine(host) ?? "", /^ ⣵ /);

    host.applyAgentEvent({ type: "turn_end" } as never);
    assert.deepEqual(host.renderWorkingStatus(64), []);
    assert.equal(host.hasAnimationTick(), false);
  } finally {
    host.dispose();
    timers.restore();
  }
});

test("ChatSessionHost stops lifecycle animation on failed or cancelled compaction and preserves its factual status", () => {
  delete process.env.ATOMIC_REDUCED_MOTION;
  for (const [event, factualCopy] of [
    [
      { type: "compaction_end", reason: "threshold", aborted: false, willRetry: false, errorMessage: "Auto-compaction failed: provider" },
      "Auto-compaction failed: provider",
    ],
    [
      { type: "compaction_end", reason: "manual", aborted: true, willRetry: false, errorMessage: "Operation cancelled" },
      "Operation cancelled",
    ],
  ] as const) {
    const timers = installLifecycleFakeClock();
    const host = new ChatSessionHost<never>({ style: plainStyle, editorTheme });
    try {
      host.applyAgentEvent({ type: "agent_start" } as never);
      host.applyAgentEvent({ type: "turn_start" } as never);
      host.applyAgentEvent({ type: "compaction_start", reason: event.reason } as never);
      host.applyAgentEvent(event as never);

      assert.equal(host.hasAnimationTick(), false);
      assert.equal(timers.intervalCount(), 0);
      assert.deepEqual(host.renderWorkingStatus(64), []);
      const body = host.renderBody(80, 8).join("\n");
      assert.equal((body.match(new RegExp(factualCopy, "g")) ?? []).length, 1);
      assert.doesNotMatch(body, /Working\.\.\.|Schlepping\.\.\./);
    } finally {
      host.dispose();
      timers.restore();
    }
  }
});
