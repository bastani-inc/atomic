import assert from "node:assert/strict";
import { Container } from "@bastani/atomic-tui";
import { beforeAll, test } from "vitest";
import { AtomicWorkingLoader } from "../../packages/coding-agent/src/modes/interactive/components/atomic-working-status.ts";
import "../../packages/coding-agent/src/modes/interactive/interactive-agent-events.ts";
import { WorkingRunMeter } from "../../packages/coding-agent/src/modes/interactive/components/working-run-meter.ts";
import { InteractiveModeBase } from "../../packages/coding-agent/src/modes/interactive/interactive-mode-base.ts";
import { ProgramStatusReporter } from "../../packages/coding-agent/src/modes/interactive/program-status-reporter.js";
import { setThemeInstance } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { loadTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme-loading.ts";
import { useAnsiColorEnvironment } from "../helpers/ansi-color-env.ts";
import { installLifecycleFakeClock } from "./chat-session-host-working-lifecycle-fixture.ts";

/** The loader phase assertions below match on truecolor escape sequences. */
useAnsiColorEnvironment();

beforeAll(() => setThemeInstance(loadTheme("catppuccin-mocha", "truecolor")));

function workingLine(loader: AtomicWorkingLoader): string {
	return loader.render(64)[1]?.trimEnd() ?? "";
}

test("the real InteractiveMode turn_start path resets the default loader phase and cadence", async () => {
	const timers = installLifecycleFakeClock();
	const loader = new AtomicWorkingLoader({ requestRender() {} } as never, undefined, String, "turn one");
	const mode = {
		isInitialized: true,
		footer: { invalidate() {} },
		programStatus: new ProgramStatusReporter(
			() => ({ setProgramStatus() {} }) as never,
			() => undefined,
		),
		workingMessage: undefined,
		workingRunMeter: new WorkingRunMeter(),
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
		{
			requestRender() {
				renders += 1;
			},
		} as never,
		String,
		String,
		"turn one",
		{ frames: ["X", "Y"], intervalMs: 40 },
	);
	const mode = {
		isInitialized: true,
		footer: { invalidate() {} },
		programStatus: new ProgramStatusReporter(
			() => ({ setProgramStatus() {} }) as never,
			() => undefined,
		),
		workingMessage: undefined,
		workingRunMeter: new WorkingRunMeter(),
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

test("turn_end holds the main Atomic loader still, fencing its 88ms callback, until the next turn restarts it", async () => {
	const timers = installLifecycleFakeClock();
	let renders = 0;
	const statusContainer = new Container();
	const ui = {
		requestRender() {
			renders += 1;
		},
	} as never;
	let mode: InteractiveModeBase;
	const createWorkingLoader = (): AtomicWorkingLoader =>
		new AtomicWorkingLoader(ui, undefined, String, mode.workingMessage ?? "Working...");
	mode = {
		isInitialized: true,
		footer: { invalidate() {} },
		programStatus: new ProgramStatusReporter(
			() => ({ setProgramStatus() {} }) as never,
			() => undefined,
		),
		ui,
		workingVisible: true,
		workingMessage: undefined,
		workingRunMeter: new WorkingRunMeter(),
		loadingAnimation: undefined,
		settingsManager: { getClearOnShrink: () => false },
		statusContainer,
		createWorkingLoader,
		stopWorkingLoader: InteractiveModeBase.prototype.stopWorkingLoader,
		showWorkingLoaderNow: InteractiveModeBase.prototype.showWorkingLoaderNow,
	} as unknown as InteractiveModeBase;
	mode.loadingAnimation = createWorkingLoader();
	statusContainer.addChild(mode.loadingAnimation);

	try {
		await InteractiveModeBase.prototype.handleEvent.call(mode, { type: "turn_start" } as never);
		assert.equal(timers.intervalCount(), 1);
		const completedTurnTick = timers.capturedAnimationCallbacks().at(-1)!;
		const beforeEnd = renders;

		const heldLoader = mode.loadingAnimation as AtomicWorkingLoader;
		const drawn = statusContainer.render(64);

		await InteractiveModeBase.prototype.handleEvent.call(mode, { type: "turn_end" } as never);

		assert.equal(mode.loadingAnimation, heldLoader, "the row stays mounted between turns");
		assert.equal(heldLoader.betweenTurns, true);
		assert.equal(timers.intervalCount(), 0);
		assert.equal(renders, beforeEnd, "nothing on screen changed, so nothing repaints");
		completedTurnTick();
		assert.equal(renders, beforeEnd, "completed-turn callback cannot repaint");
		timers.advanceBy(880);
		assert.deepEqual(statusContainer.render(64), drawn, "the held row stays exactly as drawn");

		await InteractiveModeBase.prototype.handleEvent.call(mode, { type: "turn_start" } as never);
		const nextLoader = mode.loadingAnimation as AtomicWorkingLoader;
		assert.equal(nextLoader, heldLoader, "the next turn restarts the same row");
		assert.equal(nextLoader.betweenTurns, false);
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

test("turn_end holds a delegated extension loader on its last frame, fencing its callback, until the next turn", async () => {
	const timers = installLifecycleFakeClock();
	let renders = 0;
	const statusContainer = new Container();
	const ui = {
		requestRender() {
			renders += 1;
		},
	} as never;
	const indicator = { frames: ["X", "Y"], intervalMs: 137 };
	let mode: InteractiveModeBase;
	const createWorkingLoader = (): AtomicWorkingLoader =>
		new AtomicWorkingLoader(ui, String, String, mode.workingMessage ?? "Working...", indicator);
	mode = {
		isInitialized: true,
		footer: { invalidate() {} },
		programStatus: new ProgramStatusReporter(
			() => ({ setProgramStatus() {} }) as never,
			() => undefined,
		),
		ui,
		workingVisible: true,
		workingMessage: undefined,
		workingRunMeter: new WorkingRunMeter(),
		loadingAnimation: undefined,
		settingsManager: { getClearOnShrink: () => false },
		statusContainer,
		createWorkingLoader,
		stopWorkingLoader: InteractiveModeBase.prototype.stopWorkingLoader,
		showWorkingLoaderNow: InteractiveModeBase.prototype.showWorkingLoaderNow,
	} as unknown as InteractiveModeBase;
	mode.loadingAnimation = createWorkingLoader();
	statusContainer.addChild(mode.loadingAnimation);

	try {
		await InteractiveModeBase.prototype.handleEvent.call(mode, { type: "turn_start" } as never);
		assert.match(workingLine(mode.loadingAnimation as AtomicWorkingLoader), /^ X /);
		assert.equal(timers.intervalCount(), 1);
		assert.equal(timers.intervalDelays().at(-1), 137);
		const completedTurnTick = timers.capturedAnimationCallbacks().at(-1)!;
		timers.advanceBy(137);
		assert.match(workingLine(mode.loadingAnimation as AtomicWorkingLoader), /^ Y /);
		const heldLoader = mode.loadingAnimation as AtomicWorkingLoader;
		const beforeHeld = renders;

		await InteractiveModeBase.prototype.handleEvent.call(mode, { type: "turn_end" } as never);

		assert.equal(mode.loadingAnimation, heldLoader, "the row stays mounted between turns");
		assert.equal(timers.intervalCount(), 0);
		assert.equal(renders, beforeHeld, "nothing on screen changed, so nothing repaints");
		timers.advanceBy(137 * 3);
		assert.match(workingLine(heldLoader), /^ Y /, "the custom indicator keeps its last frame");
		const heldLine = workingLine(heldLoader);
		heldLoader.setMessage("changed between turns");
		assert.equal(workingLine(heldLoader), heldLine, "the held row keeps the ended turn's message");
		completedTurnTick();
		assert.equal(renders, beforeHeld, "completed delegated callback cannot repaint");

		await InteractiveModeBase.prototype.handleEvent.call(mode, { type: "turn_start" } as never);
		const nextLoader = mode.loadingAnimation as AtomicWorkingLoader;
		assert.equal(nextLoader, heldLoader, "the next turn restarts the same row");
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
