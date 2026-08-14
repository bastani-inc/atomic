import { tmpdir } from "node:os";
import {
	type Component,
	getKeybindings,
	ScrollView,
	setKeybindings,
	Text,
	TuiAltScreen,
	VStack,
} from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { shouldHandleFullscreenViewportInput } from "../src/modes/interactive/interactive-mode-base.ts";
import { createInteractiveTui } from "../src/modes/interactive/interactive-tui.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { RecordingTerminal } from "./helpers/interactive-fullscreen-layout.ts";

const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
/** SGR wheel reports at row 2, column 10. */
const WHEEL_UP = "\x1b[<64;10;2M";
/** pi-tui's `PAGE_SCROLL_OVERLAP`: a page moves `viewportHeight` minus this. */
const PAGE_SCROLL_OVERLAP = 4;
const TRANSCRIPT_LINES = 120;

const initialKeybindings = getKeybindings();

beforeAll(() => {
	initTheme("dark");
});

afterEach(() => {
	setKeybindings(initialKeybindings);
});

/** An overlay that takes focus and declines every key, like a mounted dialog does with viewport keys. */
class DecliningOverlay implements Component {
	handledInputs: string[] = [];

	render(): string[] {
		return ["dialog"];
	}

	handleInput(data: string): void {
		this.handledInputs.push(data);
	}

	invalidate(): void {}
}

interface Fixture {
	tui: TuiAltScreen;
	terminal: RecordingTerminal;
	transcript: ScrollView;
	overlay: DecliningOverlay;
	stop: () => void;
}

function mountFocusedOverlay(): Fixture {
	setKeybindings(new KeybindingsManager());
	const keybindings = new KeybindingsManager();
	const terminal = new RecordingTerminal();
	terminal.columns = 100;
	terminal.rows = 40;

	const editor = new Text("editor", 0, 0);
	let tui!: TuiAltScreen;
	tui = createInteractiveTui({
		showHardwareCursor: false,
		logDirectory: tmpdir(),
		terminal,
		shouldHandleViewportInput: (data, isMouseInput, focusedIsOverlay) =>
			shouldHandleFullscreenViewportInput(
				tui.getFocusedComponent(),
				editor,
				data,
				isMouseInput,
				focusedIsOverlay,
				keybindings,
			),
	}) as TuiAltScreen;

	const transcript = new ScrollView(
		new Text(Array.from({ length: TRANSCRIPT_LINES }, (_, index) => `transcript line ${index + 1}`).join("\n"), 0, 0),
		{ follow: "end", primary: true },
	);
	tui.setLayoutRoot(
		new VStack([
			{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: editor, basis: 1, shrink: 0 },
		]),
	);
	tui.setFocus(editor);
	tui.start();
	tui.renderNow();

	const overlay = new DecliningOverlay();
	tui.showOverlay(overlay, { anchor: "bottom-center", width: "100%" });
	tui.renderNow();
	expect(tui.getFocusedComponent()).toBe(overlay);

	return { tui, terminal, transcript, overlay, stop: () => tui.stop() };
}

/**
 * pi-tui 0.84.2 added `shouldDeferViewportInputToOverlay()` (upstream #7894),
 * which drops viewport keys and wheel reports whenever an overlay holds focus.
 * Atomic decided the opposite in issue #2378 / PR #2381: the focused overlay is
 * offered the input first, and whatever it declines still scrolls the
 * transcript. The two policies contradict each other, and the dependency bump
 * put pi-tui's on top of Atomic's.
 */
describe("pi-tui 0.84.2 overlay viewport deferral", () => {
	test("a focused overlay that declines PAGE_UP still pages the transcript", () => {
		const { tui, terminal, transcript, overlay, stop } = mountFocusedOverlay();
		try {
			transcript.scrollToEnd();
			tui.renderNow();
			const before = transcript.scrollTop;
			const page = Math.max(1, transcript.viewportHeight - PAGE_SCROLL_OVERLAP);
			expect(page).toBeGreaterThan(1);

			terminal.input(PAGE_UP);
			tui.renderNow();
			expect(before - transcript.scrollTop).toBe(page);
			// The overlay is still offered the key it declined; the gate does not
			// hide input from it.
			expect(overlay.handledInputs).toContain(PAGE_UP);

			terminal.input(PAGE_DOWN);
			tui.renderNow();
			expect(transcript.scrollTop).toBe(before);
		} finally {
			stop();
		}
	});

	test("a focused overlay that declines a wheel report still scrolls the transcript", () => {
		const { tui, terminal, transcript, stop } = mountFocusedOverlay();
		try {
			transcript.scrollToEnd();
			tui.renderNow();
			const before = transcript.scrollTop;

			terminal.input(WHEEL_UP);
			tui.renderNow();
			expect(transcript.scrollTop).toBe(before - 1);
		} finally {
			stop();
		}
	});

	test("Atomic's renderer neutralizes pi-tui's native overlay deferral", () => {
		const { tui, stop } = mountFocusedOverlay();
		try {
			// Read both predicates in the same state: pi-tui's own would defer,
			// Atomic's instance must not. Without this contrast the two behavioral
			// tests above would keep passing if pi-tui quietly dropped the deferral.
			const native = Reflect.get(TuiAltScreen.prototype, "shouldDeferViewportInputToOverlay") as
				| (() => boolean)
				| undefined;
			expect(typeof native).toBe("function");
			expect(native?.call(tui)).toBe(true);
			expect(
				(tui as unknown as { shouldDeferViewportInputToOverlay(): boolean }).shouldDeferViewportInputToOverlay(),
			).toBe(false);
		} finally {
			stop();
		}
	});
});
