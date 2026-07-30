// @ts-nocheck

import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { Container, getKeybindings, setKeybindings } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { AtomicWorkingLoader } from "../../packages/coding-agent/src/modes/interactive/components/atomic-working-status.ts";
import "../../packages/coding-agent/src/modes/interactive/interactive-agent-events.ts";
import { InteractiveModeBase } from "../../packages/coding-agent/src/modes/interactive/interactive-mode-base.ts";
import { setThemeInstance } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { loadTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme-loading.ts";
import { installLifecycleFakeClock } from "./chat-session-host-working-lifecycle-fixture.ts";

const previousKeybindings = getKeybindings();

beforeAll(() => {
	setThemeInstance(loadTheme("dark", "truecolor"));
	setKeybindings(new KeybindingsManager());
});
afterAll(() => setKeybindings(previousKeybindings));

const compactionResult = {
	compactedText: "[User]: retained",
	firstKeptEntryId: "m1",
	tokensBefore: 100,
	parameters: { compression_ratio: 0.5, preserve_recent: 2, query: "task" },
	promptVersion: 3,
	rung: "planned",
	stats: {
		linesBefore: 4,
		linesDeleted: 1,
		linesKept: 3,
		rangeCount: 1,
		tokensBefore: 100,
		tokensAfter: 50,
		percentReduction: 50,
	},
};

interface Harness {
	readonly mode: InteractiveModeBase;
	status(): string;
	renders(): number;
	readonly statuses: string[];
	readonly errors: string[];
}

function makeHarness(): Harness {
	const statusContainer = new Container();
	const chatContainer = new Container();
	const statuses: string[] = [];
	const errors: string[] = [];
	let renders = 0;
	const ui = {
		requestRender: () => {
			renders += 1;
		},
		terminal: { setProgress: () => {} },
	};
	let mode: InteractiveModeBase;
	mode = {
		isInitialized: true,
		footer: { invalidate() {} },
		ui,
		workingVisible: true,
		workingMessage: undefined,
		loadingAnimation: undefined,
		autoCompactionLoader: undefined,
		autoCompactionEscapeHandler: undefined,
		autoCompactionEscapeHandlerSaved: false,
		defaultEditor: { onEscape: () => {} },
		statusContainer,
		chatContainer,
		pendingTools: new Map(),
		compactionQueuedMessages: [],
		settingsManager: {
			getShowTerminalProgress: () => false,
			getClearOnShrink: () => false,
		},
		session: { abortCompaction() {} },
		createWorkingLoader: () => new AtomicWorkingLoader(ui, undefined, String, mode.workingMessage ?? "Working..."),
		stopWorkingLoader: InteractiveModeBase.prototype.stopWorkingLoader,
		showWorkingLoaderNow: InteractiveModeBase.prototype.showWorkingLoaderNow,
		rebuildChatFromMessages: () => {},
		addCompactionBoundaryToChat: () => {},
		flushCompactionQueue: () => Promise.resolve(),
		checkShutdownRequested: () => Promise.resolve(),
		showStatus: (text: string) => statuses.push(text),
		showError: (text: string) => errors.push(text),
	} as unknown as InteractiveModeBase;
	return {
		mode,
		status: () => stripVTControlCharacters(statusContainer.render(80).join("\n")),
		renders: () => renders,
		statuses,
		errors,
	};
}

function emit(mode: InteractiveModeBase, event: object): Promise<void> {
	return InteractiveModeBase.prototype.handleEvent.call(mode, event as never);
}

const compactionStart = { type: "compaction_start", reason: "threshold", midTurn: true };

function midTurnEnd(overrides: object = {}): object {
	return {
		type: "compaction_end",
		reason: "threshold",
		aborted: false,
		willRetry: false,
		midTurn: true,
		...overrides,
	};
}

test("post-tool compaction keeps its factual status across the interposed turn_start", async () => {
	const timers = installLifecycleFakeClock();
	const harness = makeHarness();
	try {
		await emit(harness.mode, { type: "turn_end" });
		const beforeStart = harness.renders();

		await emit(harness.mode, compactionStart);

		assert.ok(harness.renders() > beforeStart, "compaction_start requests an immediate paint");
		assert.match(harness.status(), /Auto-compacting\.\.\. \(esc Cancel\)/);
		assert.doesNotMatch(harness.status(), /Working\.\.\./);

		// Agent-core opens the follow-up turn before the transform gate emits
		// compaction_end, so the interposed turn_start must not take the surface.
		await emit(harness.mode, { type: "turn_start" });

		assert.match(harness.status(), /Auto-compacting\.\.\./, "compaction status survives turn_start");
		assert.doesNotMatch(harness.status(), /Working\.\.\.|Schlepping\.\.\./);
		assert.equal(harness.mode.loadingAnimation, undefined, "generic Working must not claim the surface");
		assert.notEqual(harness.mode.autoCompactionLoader, undefined);

		await emit(harness.mode, midTurnEnd({ result: compactionResult }));

		assert.equal(harness.mode.autoCompactionLoader, undefined);
		assert.notEqual(harness.mode.loadingAnimation, undefined, "the same stream resumes with Working");
		assert.doesNotMatch(harness.status(), /Auto-compacting/);
		assert.match(harness.status(), /∀ /, "a live working indicator is mounted again");

		await emit(harness.mode, { type: "agent_end" });
		assert.equal(harness.mode.loadingAnimation, undefined);
		assert.equal(timers.intervalCount(), 0, "no loader timer outlives the run");
	} finally {
		harness.mode.loadingAnimation?.stop();
		harness.mode.autoCompactionLoader?.stop();
		timers.restore();
	}
});

test("a successful post-tool no-op compaction restores Working without user input", async () => {
	const timers = installLifecycleFakeClock();
	const harness = makeHarness();
	try {
		await emit(harness.mode, { type: "turn_end" });
		await emit(harness.mode, compactionStart);

		// No compactable region and the context still fits: core reports success
		// with no result and continues the same stream.
		await emit(harness.mode, midTurnEnd({ result: undefined }));

		assert.equal(harness.mode.autoCompactionLoader, undefined);
		assert.notEqual(harness.mode.loadingAnimation, undefined, "successful no-op still resumes Working");
		assert.match(harness.status(), /∀ /);
		assert.doesNotMatch(harness.status(), /Auto-compacting/);

		await emit(harness.mode, { type: "turn_start" });
		assert.equal(timers.intervalCount(), 1, "turn_start reuses the restored loader");
	} finally {
		harness.mode.loadingAnimation?.stop();
		harness.mode.autoCompactionLoader?.stop();
		timers.restore();
	}
});

test("aborted and failed post-tool compaction leave no active indicator", async () => {
	for (const [end, expectAborted] of [
		[midTurnEnd({ aborted: true }), true],
		[midTurnEnd({ errorMessage: "Auto-compaction failed: provider" }), false],
	] as const) {
		const timers = installLifecycleFakeClock();
		const harness = makeHarness();
		try {
			await emit(harness.mode, { type: "turn_end" });
			await emit(harness.mode, compactionStart);
			await emit(harness.mode, { type: "turn_start" });
			await emit(harness.mode, end);

			assert.equal(harness.mode.autoCompactionLoader, undefined);
			assert.equal(harness.mode.loadingAnimation, undefined);
			assert.doesNotMatch(harness.status(), /Auto-compacting|∀ /);
			assert.equal(timers.intervalCount(), 0, "no animation timer survives a terminal compaction");
			if (expectAborted) assert.deepEqual(harness.statuses, ["Auto-compaction cancelled"]);
		} finally {
			harness.mode.loadingAnimation?.stop();
			harness.mode.autoCompactionLoader?.stop();
			timers.restore();
		}
	}
});

test("an ordinary turn_start still mounts Working when no compaction owns the surface", async () => {
	const timers = installLifecycleFakeClock();
	const harness = makeHarness();
	try {
		await emit(harness.mode, { type: "turn_start" });

		assert.notEqual(harness.mode.loadingAnimation, undefined);
		assert.match(harness.status(), /∀ /);
		assert.equal(timers.intervalCount(), 1);
	} finally {
		harness.mode.loadingAnimation?.stop();
		timers.restore();
	}
});
