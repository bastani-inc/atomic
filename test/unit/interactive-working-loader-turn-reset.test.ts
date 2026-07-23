import { beforeAll, test } from "bun:test";
import assert from "node:assert/strict";
import { AtomicWorkingLoader } from "../../packages/coding-agent/src/modes/interactive/components/atomic-working-status.ts";
import "../../packages/coding-agent/src/modes/interactive/interactive-agent-events.ts";
import { InteractiveModeBase } from "../../packages/coding-agent/src/modes/interactive/interactive-mode-base.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { installLifecycleFakeClock } from "./chat-session-host-working-lifecycle-fixture.ts";

beforeAll(() => initTheme("catppuccin-mocha", false));

function workingLine(loader: AtomicWorkingLoader): string {
  return loader.render(64)[1]?.trimEnd() ?? "";
}

test("the real InteractiveMode turn_start path resets the default loader phase and cadence", async () => {
  const timers = installLifecycleFakeClock();
  const loader = new AtomicWorkingLoader({ requestRender() {} } as never, undefined, String, "turn one");
  const mode = {
    isInitialized: true,
    footer: { invalidate() {} },
    workingMessage: undefined,
    loadingAnimation: loader,
  } as unknown as InteractiveModeBase;
  try {
    timers.advanceBy(352);
    assert.match(workingLine(loader), /\u001b\[1m/);
    const oldTick = timers.capturedAnimationCallbacks()[0]!;

    await InteractiveModeBase.prototype.handleEvent.call(mode, { type: "turn_start" } as never);

    assert.doesNotMatch(workingLine(loader), /\u001b\[1m/);
    assert.match(workingLine(loader), /\u001b\[38;2;69;71;90m∀/);
    assert.equal(timers.intervalCount(), 1);
    oldTick();
    assert.match(workingLine(loader), /\u001b\[38;2;69;71;90m∀/, "replaced timer is stale");
    timers.advanceBy(87);
    assert.match(workingLine(loader), /\u001b\[38;2;69;71;90m∀/);
    timers.advanceBy(1);
    assert.match(workingLine(loader), /\u001b\[38;2;108;112;134m∀/);
  } finally {
    loader.stop();
    timers.restore();
  }
});

test("turn_start resets extension cadence and fences delegate callbacks after replacement and stop", async () => {
  const timers = installLifecycleFakeClock();
  let renders = 0;
  const loader = new AtomicWorkingLoader(
    { requestRender() { renders += 1; } } as never,
    String,
    String,
    "turn one",
    { frames: ["X", "Y"], intervalMs: 40 },
  );
  const mode = {
    isInitialized: true,
    footer: { invalidate() {} },
    workingMessage: undefined,
    loadingAnimation: loader,
  } as unknown as InteractiveModeBase;
  try {
    const oldTick = timers.capturedAnimationCallbacks()[0]!;
    timers.advanceBy(40);
    assert.match(workingLine(loader), /^ Y /);

    await InteractiveModeBase.prototype.handleEvent.call(mode, { type: "turn_start" } as never);

    assert.match(workingLine(loader), /^ X /);
    assert.equal(timers.intervalCount(), 1);
    const afterReset = renders;
    oldTick();
    assert.match(workingLine(loader), /^ X /);
    assert.equal(renders, afterReset, "replaced delegate callback cannot repaint");
    timers.advanceBy(39);
    assert.match(workingLine(loader), /^ X /);
    timers.advanceBy(1);
    assert.match(workingLine(loader), /^ Y /);

    const activeTick = timers.capturedAnimationCallbacks()[1]!;
    loader.stop();
    const stoppedLine = workingLine(loader);
    const afterStop = renders;
    activeTick();
    assert.equal(workingLine(loader), stoppedLine);
    assert.equal(renders, afterStop, "stopped delegate callback cannot repaint");
  } finally {
    loader.stop();
    timers.restore();
  }
});
