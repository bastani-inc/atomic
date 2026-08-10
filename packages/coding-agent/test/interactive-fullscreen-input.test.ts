import {
	type Component,
	getKeybindings,
	ScrollView,
	setKeybindings,
	Text,
	TuiAltScreen,
	TuiMainScreen,
	VStack,
} from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test } from "vitest";
import { selectMovementDelta } from "../../workflows/src/tui/prompt-card-select.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { createInteractiveTui } from "../src/modes/interactive/interactive-tui.ts";
import { RecordingTerminal } from "./helpers/interactive-fullscreen-layout.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const initialKeybindings = getKeybindings();

afterEach(() => {
	setKeybindings(initialKeybindings);
});
function makeEditor(inputs: string[]): Component & { focused: boolean } {
	return {
		focused: false,
		render: () => ["editor"],
		invalidate: () => {},
		handleInput: (data: string) => inputs.push(data),
	};
}

describe("fullscreen input navigation", () => {
	test.sequential("routes transcript navigation and preserves modified editor variants", () => {
		const terminal = new RecordingTerminal();
		terminal.columns = 40;
		terminal.rows = 10;
		const tui = new TuiAltScreen(terminal);
		const transcript = new ScrollView(
			new Text(
				Array.from(
					{ length: 40 },
					(_, index) => `${OSC133_ZONE_START}transcript line ${index + 1}\x1b]133;B\x07`,
				).join("\n"),
				0,
				0,
			),
			{ follow: "end", primary: true },
		);
		const editorInputs: string[] = [];
		const editor = makeEditor(editorInputs);
		tui.setLayoutRoot(
			new VStack([
				{ component: transcript, basis: 0, grow: 1, minSize: 1 },
				{ component: editor, basis: 1, shrink: 0 },
			]),
		);
		tui.setFocus(editor);
		tui.start();
		tui.renderNow();

		try {
			const bottom = transcript.scrollTop;
			expect(bottom).toBeGreaterThan(0);

			terminal.input("\x1b[5~");
			tui.renderNow();
			expect(transcript.scrollTop).toBeLessThan(bottom);

			terminal.input("\x1bOH");
			tui.renderNow();
			expect(transcript.scrollTop).toBe(0);

			terminal.input("\x1b[6~");
			tui.renderNow();
			expect(transcript.scrollTop).toBeGreaterThan(0);

			terminal.input("\x1bOF");
			tui.renderNow();
			expect(tui.isFollowingOutput).toBe(true);
			const atBottom = transcript.scrollTop;

			const modifiedInputs = ["\x1b[1;5H", "\x1b[1;5F", "\x1b[5;5~", "\x1b[6;5~"];
			for (const input of modifiedInputs) terminal.input(input);
			tui.renderNow();
			expect(transcript.scrollTop).toBe(atBottom);
			expect(editorInputs).toEqual(modifiedInputs);
		} finally {
			tui.stop();
		}
	});

	test.sequential("supports opt-in half-page and marked-message navigation", () => {
		const originalKeybindings = getKeybindings();
		setKeybindings(
			new KeybindingsManager({
				"tui.altScreen.halfPageUp": "ctrl+u",
				"tui.altScreen.halfPageDown": "ctrl+d",
			}),
		);
		const terminal = new RecordingTerminal();
		terminal.columns = 40;
		terminal.rows = 10;
		const tui = new TuiAltScreen(terminal);
		const transcript = new ScrollView(
			new Text(
				Array.from({ length: 40 }, (_, index) => `${OSC133_ZONE_START}marked message ${index + 1}`).join("\n"),
				0,
				0,
			),
			{ follow: "end", primary: true },
		);
		const editor = makeEditor([]);
		tui.setLayoutRoot(
			new VStack([
				{ component: transcript, basis: 0, grow: 1, minSize: 1 },
				{ component: editor, basis: 1, shrink: 0 },
			]),
		);
		tui.setFocus(editor);
		tui.start();
		tui.renderNow();

		try {
			const bottom = transcript.scrollTop;
			const halfPage = Math.max(1, Math.floor(transcript.viewportHeight / 2));
			terminal.input("\x15");
			tui.renderNow();
			expect(transcript.scrollTop).toBe(bottom - halfPage);
			terminal.input("\x04");
			tui.renderNow();
			expect(transcript.scrollTop).toBe(bottom);

			terminal.input("\x1b[1;6A");
			tui.renderNow();
			expect(transcript.scrollTop).toBeLessThan(bottom);
			terminal.input("\x1b[1;6B");
			tui.renderNow();
			expect(tui.isFollowingOutput).toBe(true);
		} finally {
			tui.stop();
			setKeybindings(originalKeybindings);
		}
	});

	test.sequential("keeps workflow paging available to focused components in regular mode", () => {
		const terminal = new RecordingTerminal();
		const tui = new TuiMainScreen(terminal);
		const inputs: string[] = [];
		const stageChat = makeEditor(inputs);
		const keybindings = new KeybindingsManager();
		const promptDeltas: number[] = [];
		const promptCard = {
			focused: false,
			render: () => ["prompt card"],
			invalidate: () => {},
			handleInput: (data: string) => {
				const delta = selectMovementDelta(data, keybindings, 10);
				if (delta !== 0) promptDeltas.push(delta);
			},
		} satisfies Component & { focused: boolean };
		tui.addChild(stageChat);
		tui.addChild(promptCard);
		tui.setFocus(stageChat);
		tui.start();

		try {
			const pageInputs = ["\x1b[5~", "\x1b[6~"];
			for (const input of pageInputs) terminal.input(input);
			expect(inputs).toEqual(pageInputs);

			tui.setFocus(promptCard);
			for (const input of pageInputs) terminal.input(input);
			expect(promptDeltas).toEqual([-5, 5]);
		} finally {
			tui.stop();
		}
	});

	test.sequential("preserves workflow paging precedence in fullscreen", () => {
		const keybindings = new KeybindingsManager({
			"tui.altScreen.halfPageUp": "ctrl+u",
			"tui.altScreen.halfPageDown": "ctrl+d",
		});
		setKeybindings(keybindings);
		const terminal = new RecordingTerminal();
		terminal.columns = 40;
		terminal.rows = 10;
		const stageInputs: string[] = [];
		const stageChat = makeEditor(stageInputs);
		const promptDeltas: number[] = [];
		const promptCard = {
			focused: false,
			render: () => ["prompt card"],
			invalidate: () => {},
			handleInput: (data: string) => {
				const delta = selectMovementDelta(data, keybindings, 10);
				if (delta !== 0) promptDeltas.push(delta);
			},
		} satisfies Component & { focused: boolean };
		const mainEditor = makeEditor([]);
		const viewportActions = [
			"tui.altScreen.pageUp",
			"tui.altScreen.pageDown",
			"tui.altScreen.halfPageUp",
			"tui.altScreen.halfPageDown",
			"tui.altScreen.top",
			"tui.altScreen.bottom",
		] as const;
		let tui: TuiAltScreen;
		const shouldHandleViewportInput = (data: string): boolean => {
			if (tui.getFocusedComponent() === mainEditor) return true;
			return !viewportActions.some((action) => keybindings.matches(data, action));
		};
		tui = createInteractiveTui({
			tuiMode: "fullscreen",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
			shouldHandleViewportInput,
		}) as TuiAltScreen;
		const hostInputs: string[] = [];
		tui.addInputListener((data) => {
			hostInputs.push(data);
		});
		const transcript = new ScrollView(
			new Text(Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
			{ follow: "end", primary: true },
		);
		tui.setLayoutRoot(
			new VStack([
				{ component: transcript, basis: 0, grow: 1, minSize: 1 },
				{ component: stageChat, basis: 1, shrink: 0 },
				{ component: promptCard, basis: 1, shrink: 0 },
				{ component: mainEditor, basis: 1, shrink: 0 },
			]),
		);
		tui.setFocus(stageChat);
		tui.start();
		tui.renderNow();

		try {
			const initialTop = transcript.scrollTop;
			const stageInputsToCheck = ["\x1b[5~", "\x1b[6~", "\x1bOH", "\x1bOF", "\x15", "\x04"];
			for (const input of stageInputsToCheck) terminal.input(input);
			tui.renderNow();
			expect(transcript.scrollTop).toBe(initialTop);
			expect(stageInputs).toEqual(stageInputsToCheck);
			expect(hostInputs).toEqual(stageInputsToCheck);
			tui.setFocus(promptCard);
			const promptInputs = ["\x1b[5~", "\x1b[6~"];
			for (const input of promptInputs) terminal.input(input);
			tui.renderNow();
			expect(promptDeltas).toEqual([-5, 5]);
			expect(hostInputs).toEqual([...stageInputsToCheck, ...promptInputs]);

			tui.setFocus(mainEditor);
			terminal.input("\x1b[5~");
			tui.renderNow();
			expect(transcript.scrollTop).toBeLessThan(initialTop);
		} finally {
			tui.stop();
		}
	});
});
