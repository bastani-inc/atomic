import { tmpdir } from "node:os";
import {
	type Component,
	getOsc8LinkAtColumn,
	hyperlink,
	Text,
	type TuiAltScreen,
	VStack,
} from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { TRANSCRIPT_JUMP_TO_END_URL } from "../src/modes/interactive/components/transcript-follow-indicator.ts";
import { shouldHandleFullscreenViewportInput } from "../src/modes/interactive/interactive-mode-base.ts";
import { createFullscreenTui } from "../src/modes/interactive/interactive-tui.ts";
import { RecordingTerminal } from "./helpers/interactive-fullscreen-layout.ts";

/**
 * Upstream #7963 (`83aed2ba`): terminals that report a release with the generic
 * SGR button code 3 instead of 0. pi-tui 0.84.2 ends a selection — and
 * activates the OSC 8 link under the press — on `release && (button & 3) === 3`.
 *
 * Atomic only hands pi-tui the reports a focused overlay consumed, through
 * `forwardSelectionMouseInput`, so a generic release its own predicate rejects
 * never reaches the fixed pi-tui code: the press stays open forever and the
 * link never opens.
 */
const LINK_LABEL = "jump to end";
const TRANSCRIPT_LINE = "alpha bravo charlie delta";

/** Build an SGR mouse report. Terminal coordinates are 1-based; pi-tui's are not. */
function sgr(button: number, column: number, row: number, release = false): string {
	return `\x1b[<${button};${column + 1};${row + 1}${release ? "m" : "M"}`;
}

const PRESS = 0;
const MOTION = 32;
/** The generic release upstream #7963 describes: no button identity, code 3. */
const GENERIC_RELEASE = 3;
/** A wheel-up report; `64 | 3` is the same code carrying the wheel bit. */
const WHEEL_UP = 64;

/** An overlay that claims every input, the way a dialog claims its own clicks. */
class ClaimingOverlay implements Component {
	readonly handledInputs: string[] = [];

	render(): string[] {
		return ["dialog"];
	}

	handleInput(data: string): boolean {
		this.handledInputs.push(data);
		return true;
	}

	invalidate(): void {}
}

interface Fixture {
	tui: TuiAltScreen;
	terminal: RecordingTerminal;
	overlay: ClaimingOverlay;
	/** Internal-UI URLs `handleUrlActivation` routed, in order. */
	internalUiActions: string[];
	/** Text pi-tui copied through OSC 52, one entry per completed selection. */
	copiedText: () => string[];
	/** The rendered screen pi-tui itself reads for selection text and OSC 8 links. */
	screen: () => string[];
	stop: () => void;
}

function createFixture(): Fixture {
	const keybindings = new KeybindingsManager({});
	const terminal = new RecordingTerminal();
	terminal.columns = 60;
	terminal.rows = 12;

	const editor = new Text("editor", 0, 0);
	const internalUiActions: string[] = [];
	let tui!: TuiAltScreen;
	tui = createFullscreenTui({
		showHardwareCursor: false,
		logDirectory: tmpdir(),
		terminal,
		onInternalUiAction: (url) => {
			internalUiActions.push(url);
			return true;
		},
		shouldHandleViewportInput: (data, isMouseInput, focusedIsOverlay, focusedIsViewportSearch) =>
			shouldHandleFullscreenViewportInput(
				tui.getFocusedComponent(),
				editor,
				data,
				isMouseInput,
				focusedIsOverlay,
				keybindings,
				focusedIsViewportSearch,
			),
	});

	const transcript = new Text(
		[TRANSCRIPT_LINE, hyperlink(LINK_LABEL, TRANSCRIPT_JUMP_TO_END_URL), "epsilon zeta"].join("\n"),
		0,
		0,
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

	const overlay = new ClaimingOverlay();
	tui.showOverlay(overlay, { anchor: "bottom-center", width: "100%" });
	tui.renderNow();
	expect(tui.getFocusedComponent()).toBe(overlay);

	return {
		tui,
		terminal,
		overlay,
		internalUiActions,
		copiedText: () =>
			terminal.writes
				.flatMap((write) => [...write.matchAll(/\x1b\]52;c;([A-Za-z0-9+/=]*)\x07/g)])
				.map((match) => Buffer.from(match[1] ?? "", "base64").toString("utf8")),
		// pi-tui reads its own `previousScreen` for both the copied text and the
		// pressed OSC 8 link, so the test locates cells the same way.
		screen: () => (Reflect.get(tui, "previousScreen") as string[] | undefined) ?? [],
		stop: () => tui.stop(),
	};
}

/** Locate the screen cell carrying an OSC 8 link to `url`. */
function findLinkCell(screen: string[], url: string): { row: number; column: number } {
	for (const [row, line] of screen.entries()) {
		for (let column = 0; column < 60; column += 1) {
			if (getOsc8LinkAtColumn(line, column) === url) return { row, column };
		}
	}
	throw new Error(`no OSC 8 link to ${url} on screen`);
}

describe("generic SGR mouse release (upstream #7963)", () => {
	test("generic-sgr-release-ends-selection", () => {
		const fixture = createFixture();
		try {
			expect(fixture.screen()[0]).toContain("alpha");

			fixture.terminal.input(sgr(PRESS, 0, 0));
			fixture.terminal.input(sgr(MOTION, 5, 0));
			fixture.terminal.input(sgr(GENERIC_RELEASE, 5, 0, true));

			// The overlay claimed all three reports, so the only way pi-tui saw the
			// release is Atomic forwarding it.
			expect(fixture.overlay.handledInputs).toEqual([
				sgr(PRESS, 0, 0),
				sgr(MOTION, 5, 0),
				sgr(GENERIC_RELEASE, 5, 0, true),
			]);
			expect(fixture.copiedText()).toEqual(["alpha"]);

			// The press is closed: a further drag and release extends nothing and
			// copies nothing, because pi-tui's press state was cleared.
			fixture.terminal.input(sgr(MOTION, 20, 0));
			fixture.terminal.input(sgr(GENERIC_RELEASE, 20, 0, true));
			expect(fixture.copiedText()).toEqual(["alpha"]);
		} finally {
			fixture.stop();
		}
	});

	test("activates an OSC 8 link on a generic SGR release", () => {
		const fixture = createFixture();
		try {
			const link = findLinkCell(fixture.screen(), TRANSCRIPT_JUMP_TO_END_URL);

			fixture.terminal.input(sgr(PRESS, link.column, link.row));
			fixture.terminal.input(sgr(GENERIC_RELEASE, link.column, link.row, true));

			expect(fixture.internalUiActions).toEqual([TRANSCRIPT_JUMP_TO_END_URL]);
			// A link click is an activation, not a selection.
			expect(fixture.copiedText()).toEqual([]);
		} finally {
			fixture.stop();
		}
	});

	test("still ends a selection on a terminal that reports the left button on release", () => {
		const fixture = createFixture();
		try {
			fixture.terminal.input(sgr(PRESS, 0, 0));
			fixture.terminal.input(sgr(MOTION, 5, 0));
			fixture.terminal.input(sgr(PRESS, 5, 0, true));

			expect(fixture.copiedText()).toEqual(["alpha"]);
		} finally {
			fixture.stop();
		}
	});

	test("a release carrying modifier bits still closes the selection", () => {
		const fixture = createFixture();
		try {
			// Shift is `4`; a terminal can report it alongside the generic code.
			fixture.terminal.input(sgr(PRESS, 0, 0));
			fixture.terminal.input(sgr(MOTION, 5, 0));
			fixture.terminal.input(sgr(GENERIC_RELEASE | 4, 5, 0, true));

			expect(fixture.copiedText()).toEqual(["alpha"]);
		} finally {
			fixture.stop();
		}
	});

	test("a wheel report is never forwarded as a selection gesture", () => {
		const fixture = createFixture();
		try {
			fixture.terminal.input(sgr(PRESS, 0, 0));
			fixture.terminal.input(sgr(MOTION, 5, 0));
			// The wheel bit is set, so this is not a left-button release even
			// though its low bits read as the generic code.
			fixture.terminal.input(sgr(WHEEL_UP | GENERIC_RELEASE, 5, 0, true));
			expect(fixture.copiedText()).toEqual([]);

			// The real release still lands.
			fixture.terminal.input(sgr(GENERIC_RELEASE, 5, 0, true));
			expect(fixture.copiedText()).toEqual(["alpha"]);
		} finally {
			fixture.stop();
		}
	});
});
