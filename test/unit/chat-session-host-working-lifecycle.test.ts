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
const pulseStyle = {
  ...plainStyle,
  accentBold: (text: string) => `<bold>${text}</bold>`,
};

beforeAll(() => {
  initTheme("dark", false);
});

afterEach(() => {
  if (originalReducedMotion === undefined) delete process.env.ATOMIC_REDUCED_MOTION;
  else process.env.ATOMIC_REDUCED_MOTION = originalReducedMotion;
});


test("ChatSessionHost advances the exact Atomic weight pulse every lifecycle-relative 80ms", () => {
  delete process.env.ATOMIC_REDUCED_MOTION;
  const timers = installLifecycleFakeClock();
  let renderRequests = 0;
  const host = new ChatSessionHost<never>({
    style: pulseStyle,
    editorTheme,
    requestRender: () => {
      renderRequests += 1;
    },
  });
  try {
    assert.equal(ANIMATION_FRAME_MS, 80);
    assert.equal(ATOMIC_WORKING_FRAME_MS, 80);
    host.applyAgentEvent({ type: "agent_start" } as never);

    assert.equal(renderRequests, 1, "agent_start requests one immediate paint");
    assert.deepEqual(timers.intervalDelays(), [80]);
    assert.deepEqual(timers.timeoutDelays(), [], "a genuine start bypasses event throttling");
    assert.equal(timers.intervalCount(), 1);
    assert.equal(timers.timeoutCount(), 0);
    assert.equal(workingLine(host), " ∀ Working...", "0ms regular");

    timers.advanceBy(79);
    assert.equal(workingLine(host), " ∀ Working...", "79ms regular");
    assert.equal(renderRequests, 1);
    timers.advanceBy(1);
    assert.equal(workingLine(host), " <bold>∀</bold> Working...", "80ms bold");
    assert.equal(renderRequests, 2);
    timers.advanceBy(79);
    assert.equal(workingLine(host), " <bold>∀</bold> Working...", "159ms bold");
    assert.equal(renderRequests, 2);
    timers.advanceBy(1);
    assert.equal(workingLine(host), " ∀ Working...", "160ms regular");
    assert.equal(renderRequests, 3);
    timers.advanceBy(80);
    assert.equal(renderRequests, 4, "one immediate request plus one request per tick");
  } finally {
    host.dispose();
    timers.restore();
  }
});


test("ChatSessionHost resets pulse phase and cadence on every turn start", () => {
  delete process.env.ATOMIC_REDUCED_MOTION;
  const previousRandom = Math.random;
  let selections = 0;
  Math.random = () => {
    selections += 1;
    return 0;
  };
  const timers = installLifecycleFakeClock();
  const host = new ChatSessionHost<never>({ style: pulseStyle, editorTheme });
  try {
    host.applyAgentEvent({ type: "agent_start" } as never);
    const agentTimer = timers.capturedAnimationCallbacks()[0]!;
    timers.advanceBy(80);
    assert.equal(workingLine(host), " <bold>∀</bold> Working...");

    host.applyAgentEvent({ type: "turn_start" } as never);
    assert.equal(selections, 1);
    assert.equal(workingLine(host), " ∀ Schlepping...");
    assert.equal(timers.intervalCount(), 1, "turn_start replaces rather than duplicates the timer");
    const turnTimer = timers.capturedAnimationCallbacks()[1]!;

    const beforeStaleTick = workingLine(host);
    agentTimer();
    assert.equal(workingLine(host), beforeStaleTick, "the replaced timer cannot advance the new turn");
    timers.advanceBy(79);
    assert.equal(workingLine(host), " ∀ Schlepping...");
    timers.advanceBy(1);
    assert.equal(workingLine(host), " <bold>∀</bold> Schlepping...");

    host.applyAgentEvent({ type: "turn_end" } as never);
    assert.equal(host.hasAnimationTick(), false);
    turnTimer();
    assert.equal(workingLine(host), undefined);
  } finally {
    host.dispose();
    timers.restore();
    Math.random = previousRandom;
  }
});


test("ChatSessionHost ignores callbacks from replaced timers and after disposal", () => {
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
    const replacedTick = timers.capturedAnimationCallbacks()[0]!;
    replacedTick();
    host.applyAgentEvent({ type: "auto_retry_start" } as never);
    host.applyAgentEvent({ type: "queue_update", steering: ["queued"] } as never);
    const staleEventRender = timers.capturedEventRenderCallbacks()[0]!;
    assert.deepEqual(timers.timeoutDelays(), [80]);
    host.applyAgentEvent({ type: "auto_retry_end", success: true } as never);
    host.applyAgentEvent({ type: "turn_start" } as never);
    const activeTick = timers.capturedAnimationCallbacks()[1]!;
    timers.flushEventRender();
    const baseline = renderRequests;
    const activeLine = workingLine(host);

    replacedTick();
    assert.equal(workingLine(host), activeLine);
    assert.equal(renderRequests, baseline);

    activeTick();
    assert.match(workingLine(host) ?? "", /^ ∀ /);
    assert.equal(renderRequests, baseline + 1);

    host.dispose();
    const afterDispose = renderRequests;
    activeTick();
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

test("ChatSessionHost reduced motion keeps each lifecycle at an un-emphasized identity without animation ticks", () => {
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
    assert.equal(workingLine(host), " ∀ Working...");
    assert.equal(host.hasAnimationTick(), false);
    host.applyAgentEvent({ type: "agent_start" } as never);
    host.applyAgentEvent({ type: "turn_start" } as never);
    const beforeContentEvent = renderRequests;
    host.applyAgentEvent({
      type: "message_start",
      message: { role: "assistant", content: [] },
    } as never);

    assert.equal(host.entries().length, 1, "reduced-motion content updates before its throttled paint");
    assert.match(workingLine(host) ?? "", /^ ∀ /);
    assert.equal(host.hasAnimationTick(), false);
    assert.equal(timers.intervalCount(), 0);
    assert.equal(timers.capturedAnimationCallbacks().length, 0);
    assert.deepEqual(timers.timeoutDelays(), [80]);
    timers.advanceBy(79);
    assert.equal(renderRequests, beforeContentEvent);
    timers.advanceBy(1);
    assert.equal(renderRequests, beforeContentEvent + 1, "content repaints at 80ms without animation");
    assert.match(workingLine(host) ?? "", /^ ∀ /);

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
