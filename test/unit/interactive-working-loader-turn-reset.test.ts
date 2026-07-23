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
    assert.match(workingLine(loader), /\u001b\[38;2;112;117;159m∀/);
    assert.equal(timers.intervalCount(), 1);
    oldTick();
    assert.match(workingLine(loader), /\u001b\[38;2;112;117;159m∀/, "replaced timer is stale");
    timers.advanceBy(87);
    assert.match(workingLine(loader), /\u001b\[38;2;112;117;159m∀/);
    timers.advanceBy(1);
    assert.match(workingLine(loader), /\u001b\[38;2;127;132;156m∀/);
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

test("turn_end removes the main Atomic loader and fences its 88ms callback before the next turn", async () => {
  const timers = installLifecycleFakeClock();
  let renders = 0;
  const children: object[] = [];
  const ui = { requestRender() { renders += 1; } } as never;
  let mode: InteractiveModeBase;
  const createWorkingLoader = (): AtomicWorkingLoader =>
    new AtomicWorkingLoader(ui, undefined, String, mode.workingMessage ?? "Working...");
  mode = {
    isInitialized: true,
    footer: { invalidate() {} },
    ui,
    workingVisible: true,
    workingMessage: undefined,
    loadingAnimation: undefined,
    settingsManager: { getClearOnShrink: () => false },
    statusContainer: {
      clear() { children.length = 0; },
      addChild(child: object) { children.push(child); },
    },
    createWorkingLoader,
    stopWorkingLoader: InteractiveModeBase.prototype.stopWorkingLoader,
    showWorkingLoaderNow: InteractiveModeBase.prototype.showWorkingLoaderNow,
  } as unknown as InteractiveModeBase;
  mode.loadingAnimation = createWorkingLoader();
  children.push(mode.loadingAnimation);

  try {
    await InteractiveModeBase.prototype.handleEvent.call(mode, { type: "turn_start" } as never);
    assert.equal(timers.intervalCount(), 1);
    const completedTurnTick = timers.capturedAnimationCallbacks().at(-1)!;
    const beforeEnd = renders;

    await InteractiveModeBase.prototype.handleEvent.call(mode, { type: "turn_end" } as never);

    assert.equal(mode.loadingAnimation, undefined);
    assert.equal(timers.intervalCount(), 0);
    assert.equal(renders, beforeEnd + 1, "turn_end requests one immediate cleanup repaint");
    completedTurnTick();
    assert.equal(renders, beforeEnd + 1, "completed-turn callback cannot repaint");

    await InteractiveModeBase.prototype.handleEvent.call(mode, { type: "turn_start" } as never);
    const nextLoader = mode.loadingAnimation as AtomicWorkingLoader;
    assert.match(workingLine(nextLoader), /\u001b\[38;2;112;117;159m∀/);
    assert.equal(timers.intervalCount(), 1);
    const afterRestart = renders;
    completedTurnTick();
    assert.equal(renders, afterRestart, "prior-turn callback stays fenced after restart");
    timers.advanceBy(87);
    assert.equal(renders, afterRestart);
    timers.advanceBy(1);
    assert.equal(renders, afterRestart + 1);
    assert.match(workingLine(nextLoader), /\u001b\[38;2;127;132;156m∀/);
  } finally {
    mode.loadingAnimation?.stop();
    timers.restore();
  }
});

test("turn_end removes a delegated extension loader and fences its callback before the next turn", async () => {
  const timers = installLifecycleFakeClock();
  let renders = 0;
  const children: object[] = [];
  const ui = { requestRender() { renders += 1; } } as never;
  const indicator = { frames: ["X", "Y"], intervalMs: 137 };
  let mode: InteractiveModeBase;
  const createWorkingLoader = (): AtomicWorkingLoader =>
    new AtomicWorkingLoader(ui, String, String, mode.workingMessage ?? "Working...", indicator);
  mode = {
    isInitialized: true,
    footer: { invalidate() {} },
    ui,
    workingVisible: true,
    workingMessage: undefined,
    loadingAnimation: undefined,
    settingsManager: { getClearOnShrink: () => false },
    statusContainer: {
      clear() { children.length = 0; },
      addChild(child: object) { children.push(child); },
    },
    createWorkingLoader,
    stopWorkingLoader: InteractiveModeBase.prototype.stopWorkingLoader,
    showWorkingLoaderNow: InteractiveModeBase.prototype.showWorkingLoaderNow,
  } as unknown as InteractiveModeBase;
  mode.loadingAnimation = createWorkingLoader();
  children.push(mode.loadingAnimation);

  try {
    await InteractiveModeBase.prototype.handleEvent.call(mode, { type: "turn_start" } as never);
    assert.match(workingLine(mode.loadingAnimation as AtomicWorkingLoader), /^ X /);
    assert.equal(timers.intervalCount(), 1);
    assert.equal(timers.intervalDelays().at(-1), 137);
    const completedTurnTick = timers.capturedAnimationCallbacks().at(-1)!;
    const beforeEnd = renders;

    await InteractiveModeBase.prototype.handleEvent.call(mode, { type: "turn_end" } as never);

    assert.equal(mode.loadingAnimation, undefined);
    assert.equal(timers.intervalCount(), 0);
    assert.equal(renders, beforeEnd + 1, "turn_end requests one immediate delegated cleanup repaint");
    completedTurnTick();
    assert.equal(renders, beforeEnd + 1, "completed delegated callback cannot repaint");

    await InteractiveModeBase.prototype.handleEvent.call(mode, { type: "turn_start" } as never);
    const nextLoader = mode.loadingAnimation as AtomicWorkingLoader;
    assert.match(workingLine(nextLoader), /^ X /);
    assert.equal(timers.intervalCount(), 1);
    assert.equal(timers.intervalDelays().at(-1), 137);
    const afterRestart = renders;
    completedTurnTick();
    assert.equal(renders, afterRestart, "prior delegated callback stays fenced after restart");
    timers.advanceBy(136);
    assert.match(workingLine(nextLoader), /^ X /);
    assert.equal(renders, afterRestart);
    timers.advanceBy(1);
    assert.match(workingLine(nextLoader), /^ Y /);
    assert.equal(renders, afterRestart + 1);
  } finally {
    mode.loadingAnimation?.stop();
    timers.restore();
  }
});
