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
  rawWorkingLine,
  workingLine,
} from "./chat-session-host-working-lifecycle-fixture.ts";

const originalReducedMotion = process.env.ATOMIC_REDUCED_MOTION;
const pulseStyle = {
  ...plainStyle,
  workingIndicatorPalette: () => ({
    dark: "#101010",
    lift: "#1c2c3c",
    muted: "#2d537a",
    accent: "#4080c0",
    bright: "#a1beda",
    peak: "#f0f0f0",
  }),
};

function renderedRgb(host: ChatSessionHost<never>): string | undefined {
  const match = /\u001b\[38;2;(\d+);(\d+);(\d+)m/.exec(rawWorkingLine(host) ?? "");
  return match ? `#${match.slice(1).map((value) => Number(value).toString(16).padStart(2, "0")).join("")}` : undefined;
}

function isBold(host: ChatSessionHost<never>): boolean {
  return (rawWorkingLine(host) ?? "").includes("\u001b[1m");
}

beforeAll(() => {
  initTheme("dark", false);
});

afterEach(() => {
  if (originalReducedMotion === undefined) delete process.env.ATOMIC_REDUCED_MOTION;
  else process.env.ATOMIC_REDUCED_MOTION = originalReducedMotion;
});


test("ChatSessionHost advances the exact luminous ramp every lifecycle-relative 88ms", () => {
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
  const assertPhase = (color: string, bold: boolean, label: string): void => {
    assert.equal(workingLine(host), " ∀ Working...", label);
    assert.equal(renderedRgb(host), color, `${label} color`);
    assert.equal(isBold(host), bold, `${label} weight`);
  };
  try {
    assert.equal(ANIMATION_FRAME_MS, 80, "unrelated canonical loader cadence stays unchanged");
    assert.equal(ATOMIC_WORKING_FRAME_MS, 88);
    host.applyAgentEvent({ type: "agent_start" } as never);
    assert.equal(renderRequests, 1, "agent_start requests one immediate paint");
    assert.deepEqual(timers.intervalDelays(), [88]);
    assert.deepEqual(timers.timeoutDelays(), [], "a genuine start bypasses event throttling");
    assert.equal(timers.intervalCount(), 1);
    assertPhase("#101010", false, "0ms deep neutral");
    timers.advanceBy(88);
    assertPhase("#1c2c3c", false, "88ms lifting");
    timers.advanceBy(176);
    assertPhase("#4080c0", false, "264ms accent");
    timers.advanceBy(88);
    assertPhase("#a1beda", true, "352ms bright");
    timers.advanceBy(88);
    assertPhase("#f0f0f0", true, "440ms peak");
    timers.advanceBy(176);
    assertPhase("#4080c0", false, "616ms falling accent");
    timers.advanceBy(264);
    assertPhase("#101010", false, "880ms wrapped deep neutral");
    assert.equal(renderRequests, 11, "one immediate request plus one request per tick");
  } finally {
    host.dispose();
    timers.restore();
  }
});

test("ChatSessionHost preserves caller-owned accent styling without a palette", () => {
  delete process.env.ATOMIC_REDUCED_MOTION;
  const timers = installLifecycleFakeClock();
  const host = new ChatSessionHost<never>({
    style: {
      ...plainStyle,
      accent: (text) => `<red>${text}</red>`,
      accentBold: (text) => `<red-bold>${text}</red-bold>`,
    },
    editorTheme,
  });
  try {
    host.applyAgentEvent({ type: "agent_start" } as never);
    timers.advanceBy(264);
    assert.equal(rawWorkingLine(host), " <red>∀</red> Working...");
    timers.advanceBy(88);
    assert.equal(rawWorkingLine(host), " <red-bold>∀</red-bold> Working...");
  } finally {
    host.dispose();
    timers.restore();
  }
});


test("ChatSessionHost resets luminous phase and cadence on every turn start", () => {
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
    timers.advanceBy(352);
    assert.equal(isBold(host), true);

    host.applyAgentEvent({ type: "turn_start" } as never);
    assert.equal(selections, 1);
    assert.equal(workingLine(host), " ∀ Schlepping...");
    assert.equal(renderedRgb(host), "#101010", "turn reset returns to deep neutral");
    assert.equal(isBold(host), false, "turn reset returns to regular weight");
    assert.equal(timers.intervalCount(), 1, "turn_start replaces rather than duplicates the timer");
    const turnTimer = timers.capturedAnimationCallbacks()[1]!;

    const beforeStaleTick = rawWorkingLine(host);
    agentTimer();
    assert.equal(rawWorkingLine(host), beforeStaleTick, "the replaced timer cannot advance the new turn");
    timers.advanceBy(87);
    assert.equal(renderedRgb(host), "#101010");
    timers.advanceBy(1);
    assert.equal(renderedRgb(host), "#1c2c3c");
    assert.equal(isBold(host), false);

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
