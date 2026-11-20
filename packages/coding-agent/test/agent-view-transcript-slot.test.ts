/**
 * The single chat screen's transcript area (S-A): the viewed subagent's transcript is drawn where the main transcript
 * is, on Atomic's fullscreen renderer over a recording terminal, with the production input route. Main's own layout
 * root comes back as it was.
 */
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage } from "@bastani/atomic-ai/compat";
import {
	type Component,
	getKeybindings,
	MULTI_CLICK_INTERVAL_MS,
	ScrollView,
	setKeybindings,
	Text,
	type TuiAltScreen,
	VStack,
	WindowedContainer,
} from "@bastani/atomic-tui";
import { afterEach, beforeEach, describe, test } from "vitest";
import { taskFixture } from "../../../test/helpers/task-projection.ts";
import { taskTranscriptEnvironment } from "../../../test/helpers/task-transcript-environment.ts";
import type { AgentSessionEvent } from "../src/core/agent-session.js";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type { TaskId } from "../src/core/tasks/contracts.js";
import type { TaskTranscriptSource } from "../src/core/tasks/supervisor.js";
import { ownerTaskViewSource } from "../src/core/tasks/task-view-source.js";
import { AgentViewSwitcher } from "../src/modes/interactive/agent-view/agent-view-switcher.ts";
import { openLocalAgentViewPort } from "../src/modes/interactive/agent-view/local-port.ts";
import { installTranscriptSlot } from "../src/modes/interactive/agent-view/transcript-slot.ts";
import { dismissedTasks } from "../src/modes/interactive/components/task-dismissal.ts";
import {
	type InteractiveModeBase,
	isFullscreenViewportAction,
	shouldHandleFullscreenViewportInput,
} from "../src/modes/interactive/interactive-mode-base.ts";
import { createFullscreenTui } from "../src/modes/interactive/interactive-tui.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { RecordingTerminal } from "./helpers/interactive-fullscreen-layout.ts";

const WIDTH = 80;
const ROWS = 20;
const PAGE_UP = "\x1b[5~";
const flush = async () => {
	for (let i = 0; i < 8; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

let previousKeys: ReturnType<typeof getKeybindings>;
beforeEach(() => {
	initTheme("dark");
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
});
afterEach(() => setKeybindings(previousKeys));

function assistant(text: string, extra: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "fixture",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
		...extra,
	};
}

/** The main screen as InteractiveModeBase lays it out: a primary scroll view over the transcript, above the dock. */
function mainScreen() {
	const terminal = new RecordingTerminal();
	terminal.columns = WIDTH;
	terminal.rows = ROWS;
	const keybindings = new KeybindingsManager();
	const editor = new Text("❯ prompt", 0, 0);
	let switcher: AgentViewSwitcher | undefined;
	const tui: TuiAltScreen = createFullscreenTui({
		showHardwareCursor: false,
		logDirectory: tmpdir(),
		terminal,
		// InteractiveModeBase's gate: while a subagent is shown its transcript takes the scroll keys.
		shouldHandleViewportInput: (data, isMouseInput, focusedIsOverlay, focusedIsViewportSearch) =>
			!(switcher?.viewed.kind === "agent" && !isMouseInput && isFullscreenViewportAction(data, keybindings)) &&
			shouldHandleFullscreenViewportInput(
				tui.getFocusedComponent(),
				editor,
				data,
				isMouseInput,
				focusedIsOverlay,
				keybindings,
				focusedIsViewportSearch,
			),
	}) as TuiAltScreen;
	const document = new WindowedContainer();
	for (let line = 1; line <= 40; line++) document.addChild(new Text(`main line ${line}`, 0, 0));
	const scroll = new ScrollView(document, { follow: "end", primary: true, overscroll: "chain" });
	const dock = new VStack([
		{ component: editor, basis: "auto" },
		{ component: new Text("footer", 0, 0), basis: "auto" },
	]);
	const root = new VStack([
		{ component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
	]);
	tui.setLayoutRoot(root);
	tui.setFocus(editor);
	tui.start();
	const notices: string[] = [];
	const mode = {
		ui: tui,
		fullscreenDock: dock,
		fullscreenLayoutRoot: root,
		documentContainer: document,
		chatContainer: document,
		transcriptScrollView: scroll,
		editor,
		keybindings,
		addTuiInputListener: (listener: Parameters<TuiAltScreen["addInputListener"]>[0]) => tui.addInputListener(listener),
		onTuiRendererChange: () => () => {},
		showStatus: (message: string) => notices.push(`main status: ${message}`),
		showWarning: (message: string) => notices.push(`main warning: ${message}`),
		showError: (message: string) => notices.push(`main error: ${message}`),
		jumpToTranscriptEnd: () => scroll.scrollToEnd(),
	} as unknown as InteractiveModeBase;
	const screen = () => {
		tui.renderNow();
		return tui.getScreenLines().map((line) => stripVTControlCharacters(line).trimEnd());
	};
	return {
		terminal,
		tui,
		mode,
		root,
		scroll,
		document,
		notices,
		screen,
		bind: (next: AgentViewSwitcher) => {
			switcher = next;
			return installTranscriptSlot(mode, next);
		},
	};
}

/** A background subagent whose live session has `lines` numbered assistant lines, streaming through `emit`. */
async function liveSubagent(lines: number) {
	const fixture = taskFixture();
	await fixture.start("Investigate the lock");
	const session = SessionManager.inMemory();
	await session.appendMessage({ role: "user", content: "Investigate the lock", timestamp: 0 });
	await session.appendMessage(
		assistant(Array.from({ length: lines }, (_, index) => `sub line ${index + 1}`).join("\n\n")),
	);
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	let running = true;
	const transcript: TaskTranscriptSource = Object.assign(session, {
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		isRunning: () => running,
	});
	fixture.runners[0]!.context.bindTranscript(transcript);
	return {
		fixture,
		source: ownerTaskViewSource(fixture.store),
		taskId: fixture.store.tasks[0]!.ref.taskId,
		emit: (event: AgentSessionEvent) => {
			for (const listener of [...listeners]) listener(event);
		},
		stop: () => {
			running = false;
		},
	};
}

function localSwitcher(ui: ReturnType<typeof mainScreen>, sub: Awaited<ReturnType<typeof liveSubagent>>) {
	const watchers = new Set<() => void>();
	const switcher = new AgentViewSwitcher(
		(taskId) =>
			openLocalAgentViewPort({
				source: sub.source,
				taskId,
				env: taskTranscriptEnvironment({ tui: ui.tui, keybindings: ui.mode.keybindings }),
				requestRender: () => ui.tui.requestRender(),
				watch: (listener) => {
					watchers.add(listener);
					return () => watchers.delete(listener);
				},
			}),
		(message) => ui.notices.push(`switcher: ${message}`),
	);
	return { switcher, panelChanged: () => [...watchers].forEach((listener) => listener()) };
}

const has = (lines: readonly string[], pattern: RegExp) => lines.some((line) => pattern.test(line));

describe("the viewed subagent's transcript in the main transcript area", () => {
	test("draws the subagent's live transcript above the same prompt and footer, then gives main back exactly", async () => {
		const ui = mainScreen();
		const sub = await liveSubagent(30);
		const { switcher } = localSwitcher(ui, sub);
		const uninstall = ui.bind(switcher);
		try {
			// The reader parks main above its end.
			ui.screen();
			ui.terminal.input(PAGE_UP);
			const parked = ui.screen();
			const parkedTop = ui.scroll.scrollTop;
			assert.ok(has(parked, /main line/) && !has(parked, /main line 40$/), parked.join("\n"));

			assert.equal(await switcher.view(sub.taskId), true);
			const viewing = ui.screen();
			assert.ok(has(viewing, /sub line 30$/), viewing.join("\n"));
			assert.ok(!has(viewing, /main line/), "main's transcript is not drawn while the subagent is shown");
			assert.deepEqual(viewing.slice(-2), ["❯ prompt", "footer"], "the dock stays where it was");

			// Main goes on while the subagent is shown: rows arrive below the reader's place.
			ui.document.addChild(new Text("main line 41", 0, 0));
			sub.emit({ type: "message_start", message: assistant("") } as AgentSessionEvent);
			sub.emit({
				type: "message_update",
				message: assistant("streamed while shown"),
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "streamed while shown" },
			} as unknown as AgentSessionEvent);
			await flush();
			assert.ok(has(ui.screen(), /streamed while shown/), "the subagent's stream is followed live");

			assert.equal(await switcher.view(undefined), true);
			assert.equal(Reflect.get(ui.tui, "layoutRoot"), ui.root, "main's own layout root object is back");
			assert.equal(ui.scroll.scrollTop, parkedTop, "main's place is kept");
			assert.deepEqual(ui.screen(), parked, "main shows exactly what it showed before");
		} finally {
			uninstall();
			ui.tui.stop();
			await sub.fixture.dispose();
		}
	});

	test("scroll keys and the wheel move the subagent's transcript and never main's", async () => {
		const ui = mainScreen();
		const sub = await liveSubagent(30);
		const { switcher } = localSwitcher(ui, sub);
		const uninstall = ui.bind(switcher);
		try {
			ui.screen();
			const mainTop = ui.scroll.scrollTop;
			await switcher.view(sub.taskId);
			const following = ui.screen();
			assert.ok(has(following, /sub line 30$/), following.join("\n"));
			ui.terminal.input(PAGE_UP);
			await flush();
			const paged = ui.screen();
			assert.ok(!has(paged, /sub line 30$/) && has(paged, /sub line/), paged.join("\n"));
			assert.equal(ui.scroll.scrollTop, mainTop, "PgUp did not move main");

			// Wheel turns down over the transcript area scroll it back to its end, a line a turn.
			const row = paged.findIndex((line) => /sub line/.test(line));
			for (let turn = 0; turn < 20; turn++) ui.terminal.input(`\x1b[<65;5;${row + 1}M`);
			await flush();
			assert.ok(has(ui.screen(), /sub line 30$/), ui.screen().join("\n"));
			assert.equal(ui.scroll.scrollTop, mainTop, "the wheel did not move main");
		} finally {
			uninstall();
			ui.tui.stop();
			await sub.fixture.dispose();
		}
	});

	test("a finished subagent stays shown with its last rows; a dismissed one gives the screen back to main at once", async () => {
		const ui = mainScreen();
		const sub = await liveSubagent(5);
		const { switcher, panelChanged } = localSwitcher(ui, sub);
		const uninstall = ui.bind(switcher);
		try {
			await switcher.view(sub.taskId);
			sub.stop();
			await sub.fixture.settle();
			await flush();
			const finished = ui.screen();
			assert.equal(switcher.viewed.kind, "agent");
			assert.ok(has(finished, /sub line 5$/), finished.join("\n"));

			dismissedTasks(sub.source).add(sub.taskId);
			panelChanged();
			assert.equal(switcher.viewed.kind, "main", "the same tick");
			const back = ui.screen();
			assert.ok(has(back, /main line 40$/) && !has(back, /sub line/), back.join("\n"));
		} finally {
			uninstall();
			ui.tui.stop();
			await sub.fixture.dispose();
		}
	});

	test("the screen's notices show under the subagent's transcript while it is shown, and main's otherwise", async () => {
		const ui = mainScreen();
		const sub = await liveSubagent(5);
		const { switcher } = localSwitcher(ui, sub);
		const uninstall = ui.bind(switcher);
		try {
			await switcher.view(sub.taskId);
			ui.mode.showWarning("only for the shown subagent");
			ui.mode.showStatus("first status");
			ui.mode.showStatus("second status");
			const lines = ui.screen();
			const warning = lines.findIndex((line) => line === " Warning: only for the shown subagent");
			assert.notEqual(warning, -1, lines.join("\n"));
			assert.equal(lines[warning + 1], " second status", "a status replaces the status before it");
			assert.equal(lines[warning + 2], "❯ prompt");
			assert.deepEqual(ui.notices, []);
			await switcher.view(undefined);
			ui.mode.showWarning("for main");
			assert.deepEqual(ui.notices, ["main warning: for main"]);
			assert.ok(!has(ui.screen(), /only for the shown subagent/));
		} finally {
			uninstall();
			ui.tui.stop();
			await sub.fixture.dispose();
		}
	});

	test("a click on a block of the shown transcript expands it", async () => {
		const ui = mainScreen();
		const fixture = taskFixture();
		await fixture.start("Run the build");
		const session = SessionManager.inMemory();
		await session.appendMessage({ role: "user", content: "Run the build", timestamp: 0 });
		await session.appendMessage(
			assistant("", {
				content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "make" } }],
				stopReason: "toolUse",
			}),
		);
		await session.appendMessage({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "bash",
			content: [{ type: "text", text: Array.from({ length: 12 }, (_, i) => `build line ${i + 1}`).join("\n") }],
			isError: false,
			timestamp: 2,
		});
		fixture.runners[0]!.context.bindTranscript(Object.assign(session, { subscribe: () => () => {} }));
		const source = ownerTaskViewSource(fixture.store);
		const switcher = new AgentViewSwitcher(
			(taskId: TaskId) =>
				openLocalAgentViewPort({
					source,
					taskId,
					env: taskTranscriptEnvironment({ tui: ui.tui, keybindings: ui.mode.keybindings }),
					requestRender: () => ui.tui.requestRender(),
				}),
			() => {},
		);
		const uninstall = ui.bind(switcher);
		try {
			await switcher.view(fixture.store.tasks[0]!.ref.taskId);
			const before = ui.screen();
			assert.ok(!has(before, /build line 1$/), before.join("\n"));
			const row = before.findIndex((line) => /build line 12$/.test(line));
			assert.notEqual(row, -1, before.join("\n"));
			const column = before[row]!.indexOf("build") + 1;
			ui.terminal.input(`\x1b[<0;${column};${row + 1}M`);
			ui.terminal.input(`\x1b[<0;${column};${row + 1}m`);
			await new Promise((resolve) => setTimeout(resolve, MULTI_CLICK_INTERVAL_MS + 50));
			await flush();
			assert.ok(has(ui.screen(), /build line 1$/), ui.screen().join("\n"));
		} finally {
			uninstall();
			ui.tui.stop();
			await fixture.dispose();
		}
	});
});

export type { Component };
