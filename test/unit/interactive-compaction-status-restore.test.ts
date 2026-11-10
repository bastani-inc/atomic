// @ts-nocheck

import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { Container, getKeybindings, setKeybindings, Text } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { AtomicWorkingLoader } from "../../packages/coding-agent/src/modes/interactive/components/atomic-working-status.ts";
import "../../packages/coding-agent/src/modes/interactive/interactive-agent-events.ts";
import "../../packages/coding-agent/src/modes/interactive/interactive-extension-runtime.ts";
import { InteractiveModeBase } from "../../packages/coding-agent/src/modes/interactive/interactive-mode-base.ts";
import { ProgramStatusReporter } from "../../packages/coding-agent/src/modes/interactive/program-status-reporter.js";
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
	promptVersion: 6,
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

type CompactionReason = "manual" | "threshold" | "overflow";

interface SessionState {
	isCompacting: boolean;
	compactionReason: CompactionReason | undefined;
	isStreaming: boolean;
	abortCompaction(): void;
}

interface Harness {
	readonly mode: InteractiveModeBase;
	readonly session: SessionState;
	status(): string;
	renders(): number;
	statusChildren(): readonly object[];
}

function makeHarness(): Harness {
	const statusContainer = new Container();
	const chatContainer = new Container();
	let renders = 0;
	const ui = {
		requestRender: () => {
			renders += 1;
		},
		terminal: { setProgress: () => {} },
	};
	const session: SessionState = {
		isCompacting: false,
		compactionReason: undefined,
		isStreaming: false,
		abortCompaction() {},
	};
	const mode = {
		isInitialized: true,
		footer: { invalidate() {} },
		programStatus: new ProgramStatusReporter(
			() => ({ setProgramStatus() {} }) as never,
			() => undefined,
		),
		ui,
		workingVisible: true,
		workingMessage: undefined,
		workingIndicatorEmbedded: false,
		loadingAnimation: undefined,
		autoCompactionLoader: undefined,
		autoCompactionEscapeHandler: undefined,
		autoCompactionEscapeHandlerSaved: false,
		manualCompactionTakeoverPending: false,
		defaultEditor: { onEscape: () => {} },
		statusContainer,
		chatContainer,
		pendingTools: new Map(),
		compactionQueuedMessages: [],
		settingsManager: {
			getShowTerminalProgress: () => false,
			getClearOnShrink: () => false,
		},
		session,
		createWorkingLoader: () => new AtomicWorkingLoader(ui, undefined, String, "Working..."),
		clearWorkingLoader: InteractiveModeBase.prototype.clearWorkingLoader,
		stopWorkingLoader: InteractiveModeBase.prototype.stopWorkingLoader,
		showWorkingLoaderNow: InteractiveModeBase.prototype.showWorkingLoaderNow,
		setWorkingVisible: InteractiveModeBase.prototype.setWorkingVisible,
		rebuildChatFromMessages: () => {},
		addCompactionBoundaryToChat: () => {},
		flushCompactionQueue: () => Promise.resolve(),
		checkShutdownRequested: () => Promise.resolve(),
		showStatus: () => {},
		showError: () => {},
	} as unknown as InteractiveModeBase;
	Object.defineProperty(mode, "compactionActive", {
		get: () => session.isCompacting || mode.manualCompactionTakeoverPending,
	});
	return {
		mode,
		session,
		status: () => stripVTControlCharacters(statusContainer.render(100).join("\n")),
		renders: () => renders,
		statusChildren: () => statusContainer.children,
	};
}

function emit(mode: InteractiveModeBase, event: object): Promise<void> {
	return InteractiveModeBase.prototype.handleEvent.call(mode, event as never);
}

async function startCompaction(harness: Harness, reason: CompactionReason, midTurn = false): Promise<void> {
	harness.session.isCompacting = true;
	harness.session.compactionReason = reason;
	await emit(harness.mode, { type: "compaction_start", reason, ...(midTurn ? { midTurn: true } : {}) });
}

/** The core emits `compaction_end` while the session still reports compaction, then clears it in `finally`. */
async function endCompaction(harness: Harness, reason: CompactionReason, midTurn = false): Promise<void> {
	await emit(harness.mode, {
		type: "compaction_end",
		reason,
		result: compactionResult,
		aborted: false,
		willRetry: false,
		...(midTurn ? { midTurn: true } : {}),
	});
	harness.session.isCompacting = false;
	harness.session.compactionReason = undefined;
}

function hideThenRestoreWorkingRow(mode: InteractiveModeBase): void {
	mode.setWorkingVisible(false);
	mode.setWorkingVisible(true);
}

function releaseTimers(harness: Harness): void {
	harness.mode.loadingAnimation?.stop();
	harness.mode.autoCompactionLoader?.stop();
}

const labels: ReadonlyArray<readonly [CompactionReason, RegExp]> = [
	["manual", /Compacting context\.\.\. \(esc Cancel\)/],
	["threshold", /Auto-compacting\.\.\. \(esc Cancel\)/],
	["overflow", /Context overflow detected\. Auto-compacting\.\.\. \(esc Cancel\)/],
];

test("#4625: hiding and restoring the Working row keeps each compaction reason's indicator and cancel hint", async () => {
	for (const [reason, label] of labels) {
		const timers = installLifecycleFakeClock();
		const harness = makeHarness();
		try {
			await startCompaction(harness, reason);
			const loader = harness.mode.autoCompactionLoader;
			assert.match(harness.status(), label, `${reason}: indicator mounted by compaction_start`);

			harness.mode.setWorkingVisible(false);
			assert.match(harness.status(), label, `${reason}: hiding the Working row leaves the indicator`);

			harness.mode.setWorkingVisible(true);
			assert.match(harness.status(), label, `${reason}: restoring the Working row keeps the indicator`);
			assert.doesNotMatch(harness.status(), /Working\.\.\./);
			assert.equal(harness.mode.autoCompactionLoader, loader, `${reason}: the same loader stays in use`);
			assert.equal(harness.statusChildren().filter((child) => child === loader).length, 1);
			assert.equal(timers.intervalCount(), 1, `${reason}: one animation timer, none leaked`);
		} finally {
			releaseTimers(harness);
			timers.restore();
		}
	}
});

test("#4625: a compaction that ends while the Working row is hidden leaves nothing behind on return", async () => {
	for (const [reason] of labels) {
		const timers = installLifecycleFakeClock();
		const harness = makeHarness();
		const escapeBefore = harness.mode.defaultEditor.onEscape;
		try {
			await startCompaction(harness, reason);
			harness.mode.setWorkingVisible(false);
			assert.notEqual(harness.mode.defaultEditor.onEscape, escapeBefore, "Esc cancels the compaction meanwhile");

			await endCompaction(harness, reason);
			harness.mode.setWorkingVisible(true);

			assert.doesNotMatch(harness.status(), /ompacting|\(esc Cancel\)|Working\.\.\./, reason);
			assert.equal(harness.mode.autoCompactionLoader, undefined, reason);
			assert.equal(harness.mode.loadingAnimation, undefined, reason);
			assert.equal(harness.mode.defaultEditor.onEscape, escapeBefore, `${reason}: Esc handler restored`);
			assert.equal(timers.intervalCount(), 0, `${reason}: no animation timer outlives the compaction`);
		} finally {
			releaseTimers(harness);
			timers.restore();
		}
	}
});

test("#4625: a compaction that starts while the Working row is hidden shows its indicator on return", async () => {
	const timers = installLifecycleFakeClock();
	const harness = makeHarness();
	try {
		harness.mode.setWorkingVisible(false);
		await startCompaction(harness, "threshold");
		harness.mode.setWorkingVisible(true);

		assert.match(harness.status(), /Auto-compacting\.\.\. \(esc Cancel\)/);
		assert.equal(timers.intervalCount(), 1);
	} finally {
		releaseTimers(harness);
		timers.restore();
	}
});

test("#4625: repeated hide and restore cycles mount one indicator and one timer", async () => {
	const timers = installLifecycleFakeClock();
	const harness = makeHarness();
	try {
		await startCompaction(harness, "manual");
		const loader = harness.mode.autoCompactionLoader;
		for (let cycle = 0; cycle < 3; cycle++) hideThenRestoreWorkingRow(harness.mode);
		harness.mode.setWorkingVisible(true);

		assert.equal(harness.statusChildren().filter((child) => child === loader).length, 1);
		assert.equal(harness.status().match(/Compacting context/g)?.length, 1);
		assert.equal(timers.intervalCount(), 1);
	} finally {
		releaseTimers(harness);
		timers.restore();
	}
});

test("#4625: post-tool compaction keeps its indicator, not generic Working, when the Working row returns", async () => {
	const timers = installLifecycleFakeClock();
	const harness = makeHarness();
	try {
		harness.session.isStreaming = true;
		await emit(harness.mode, { type: "agent_start" });
		await emit(harness.mode, { type: "turn_start" });
		await startCompaction(harness, "threshold", true);
		await emit(harness.mode, { type: "turn_start" });
		assert.match(harness.status(), /Auto-compacting\.\.\. \(esc Cancel\)/);

		hideThenRestoreWorkingRow(harness.mode);

		assert.match(harness.status(), /Auto-compacting\.\.\. \(esc Cancel\)/);
		assert.doesNotMatch(harness.status(), /Working\.\.\./);
		assert.equal(harness.mode.loadingAnimation, undefined, "generic Working must not claim the surface");

		await endCompaction(harness, "threshold", true);
		assert.doesNotMatch(harness.status(), /Auto-compacting/);
		assert.notEqual(harness.mode.loadingAnimation, undefined, "the same stream resumes with Working");
		assert.match(harness.status(), /∀ /);
	} finally {
		releaseTimers(harness);
		timers.restore();
	}
});

test("#4625: restoring the Working row still mounts it for a streaming turn when nothing compacts", async () => {
	const timers = installLifecycleFakeClock();
	const harness = makeHarness();
	try {
		harness.session.isStreaming = true;
		harness.mode.setWorkingVisible(false);
		assert.equal(harness.mode.loadingAnimation, undefined);
		assert.equal(harness.status(), "");

		harness.mode.setWorkingVisible(true);

		assert.notEqual(harness.mode.loadingAnimation, undefined);
		assert.match(harness.status(), /∀ .*Working\.\.\./);
		assert.equal(timers.intervalCount(), 1);

		harness.session.isStreaming = false;
		harness.mode.setWorkingVisible(false);
		harness.mode.setWorkingVisible(true);
		assert.equal(harness.status(), "");
	} finally {
		releaseTimers(harness);
		timers.restore();
	}
});

test("#4625: a manual takeover handoff keeps the indicator across a Working row round trip", async () => {
	const timers = installLifecycleFakeClock();
	const harness = makeHarness();
	try {
		await startCompaction(harness, "threshold");
		await emit(harness.mode, {
			type: "compaction_end",
			reason: "threshold",
			aborted: true,
			willRetry: false,
			manualTakeoverPending: true,
		});
		harness.session.isCompacting = false;
		harness.session.compactionReason = undefined;
		assert.equal(harness.mode.manualCompactionTakeoverPending, true);
		assert.match(harness.status(), /Auto-compacting\.\.\./, "handoff keeps the automatic indicator");

		hideThenRestoreWorkingRow(harness.mode);

		assert.match(harness.status(), /Auto-compacting\.\.\. \(esc Cancel\)/);
		assert.equal(timers.intervalCount(), 1);
	} finally {
		releaseTimers(harness);
		timers.restore();
	}
});

test("#4625: an indicator whose compaction the session no longer reports is not brought back", async () => {
	const timers = installLifecycleFakeClock();
	const harness = makeHarness();
	try {
		await startCompaction(harness, "threshold");
		harness.session.isCompacting = false;
		harness.session.compactionReason = undefined;

		hideThenRestoreWorkingRow(harness.mode);

		assert.doesNotMatch(harness.status(), /Auto-compacting/);
		assert.equal(harness.statusChildren().length, 0);
	} finally {
		releaseTimers(harness);
		timers.restore();
	}
});

test("#4625: hiding and restoring the Working row each request a repaint", async () => {
	const timers = installLifecycleFakeClock();
	const harness = makeHarness();
	try {
		await startCompaction(harness, "manual");

		const beforeHide = harness.renders();
		harness.mode.setWorkingVisible(false);
		const afterHide = harness.renders();
		harness.mode.setWorkingVisible(true);

		assert.ok(afterHide > beforeHide, "hiding repaints");
		assert.ok(harness.renders() > afterHide, "restoring repaints");
	} finally {
		releaseTimers(harness);
		timers.restore();
	}
});

test("#4625: restoring the Working row for a streaming turn replaces stale status rows", async () => {
	const timers = installLifecycleFakeClock();
	const harness = makeHarness();
	try {
		harness.session.isStreaming = true;
		harness.mode.statusContainer.addChild(new Text("stale status row", 0, 0));

		harness.mode.setWorkingVisible(true);

		assert.doesNotMatch(harness.status(), /stale status row/);
		assert.match(harness.status(), /∀ .*Working\.\.\./);
	} finally {
		releaseTimers(harness);
		timers.restore();
	}
});

test("#4625: restoring the Working row leaves it to the editor when the editor embeds the indicator", async () => {
	const timers = installLifecycleFakeClock();
	const harness = makeHarness();
	try {
		harness.session.isStreaming = true;
		harness.mode.setEditorWorkingStatusIndicator = () => true;

		harness.mode.setWorkingVisible(true);

		assert.equal(harness.mode.workingIndicatorEmbedded, true);
		assert.notEqual(harness.mode.loadingAnimation, undefined);
		assert.equal(harness.statusChildren().length, 0, "an embedded indicator is not mounted in the status container");
	} finally {
		releaseTimers(harness);
		timers.restore();
	}
});
