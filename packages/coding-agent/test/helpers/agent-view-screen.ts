/**
 * The main screen as InteractiveModeBase lays it out (a primary scroll view over the transcript above the dock), on
 * Atomic's fullscreen renderer over a recording terminal, and a live background subagent, for the single chat screen's
 * transcript-area tests.
 */
import { tmpdir } from "node:os";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage } from "@bastani/atomic-ai/compat";
import { ScrollView, Text, type TuiAltScreen, VStack, WindowedContainer } from "@bastani/atomic-tui";
import { taskFixture } from "../../../../test/helpers/task-projection.ts";
import type { AgentSessionEvent } from "../../src/core/agent-session.js";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { TaskTranscriptSource } from "../../src/core/tasks/supervisor.js";
import { ownerTaskViewSource } from "../../src/core/tasks/task-view-source.js";
import type { AgentViewSwitcher } from "../../src/modes/interactive/agent-view/agent-view-switcher.ts";
import { installTranscriptSlot } from "../../src/modes/interactive/agent-view/transcript-slot.ts";
import {
	type InteractiveModeBase,
	isFullscreenViewportAction,
	shouldHandleFullscreenViewportInput,
} from "../../src/modes/interactive/interactive-mode-base.ts";
import { createFullscreenTui } from "../../src/modes/interactive/interactive-tui.ts";
import { RecordingTerminal } from "./interactive-fullscreen-layout.ts";

export const WIDTH = 80;
export const ROWS = 20;
export const PAGE_UP = "\x1b[5~";
export const flush = async () => {
	for (let i = 0; i < 8; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

export function assistant(text: string, extra: Partial<AssistantMessage> = {}): AssistantMessage {
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
export function mainScreen() {
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
		addTuiInputListener: (listener: Parameters<TuiAltScreen["addInputListener"]>[0]) =>
			tui.addInputListener(listener),
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
			mode.agentView = next;
			return installTranscriptSlot(mode, next);
		},
	};
}

/** A background subagent whose live session has `lines` numbered assistant lines, streaming through `emit`. */
export async function liveSubagent(lines: number) {
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

export const has = (lines: readonly string[], pattern: RegExp) => lines.some((line) => pattern.test(line));
