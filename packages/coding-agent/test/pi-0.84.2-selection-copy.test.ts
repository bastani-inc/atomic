import { tmpdir } from "node:os";
import { Text, type TuiAltScreen, VStack } from "@bastani/atomic-tui";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createFullscreenTui } from "../src/modes/interactive/interactive-tui.ts";
import { RecordingTerminal } from "./helpers/interactive-fullscreen-layout.ts";

const clipboardMocks = vi.hoisted(() => ({
	copyToClipboard: vi.fn<(text: string) => Promise<void>>(),
	readClipboardText: vi.fn<() => Promise<string | null>>(),
}));

vi.mock("../src/utils/clipboard.ts", () => clipboardMocks);

/**
 * Upstream #8110 (`4caa3c44`): selection copy must go through the host
 * clipboard and report the honest outcome. The old bare-OSC-52 path flashed
 * "Copied!" unconditionally even on terminals whose clipboard never received
 * the text. Atomic adapts pi-tui's fullscreen copy route to preserve the
 * host diagnostic while retaining the boolean success contract.
 */
const TRANSCRIPT_LINE = "alpha bravo charlie";

/** Build an SGR mouse report. Terminal coordinates are 1-based; pi-tui's are not. */
function sgr(button: number, column: number, row: number, release = false): string {
	return `\x1b[<${button};${column + 1};${row + 1}${release ? "m" : "M"}`;
}

const PRESS = 0;
const MOTION = 32;

function createFixture(copySelection?: (text: string) => Promise<boolean | string>): {
	tui: TuiAltScreen;
	terminal: RecordingTerminal;
} {
	const terminal = new RecordingTerminal();
	terminal.columns = 60;
	terminal.rows = 12;
	const tui = createFullscreenTui({
		showHardwareCursor: false,
		logDirectory: tmpdir(),
		terminal,
		copySelection,
	});
	tui.setLayoutRoot(
		new VStack([
			{ component: new Text(TRANSCRIPT_LINE, 0, 0), basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: new Text("editor", 0, 0), basis: 1, shrink: 0 },
		]),
	);
	tui.start();
	tui.renderNow();
	return { tui, terminal };
}

function dragSelect(fixture: { terminal: RecordingTerminal }): void {
	fixture.terminal.input(sgr(PRESS, 0, 0));
	fixture.terminal.input(sgr(MOTION, 5, 0));
	fixture.terminal.input(sgr(PRESS, 5, 0, true));
}

/** Flush the microtasks between pi-tui's async copy and its flash. */
async function flushCopy(): Promise<void> {
	await new Promise<void>((resolve) => {
		setTimeout(resolve, 0);
	});
}

function renderedScreen(tui: TuiAltScreen): string {
	return ((Reflect.get(tui, "previousScreen") as string[] | undefined) ?? []).join("\n");
}

beforeEach(() => {
	clipboardMocks.copyToClipboard.mockReset();
	clipboardMocks.readClipboardText.mockReset();
});

afterEach(() => {
	vi.restoreAllMocks();
});

test("8110-selection-copy-reports-failure", async () => {
	clipboardMocks.copyToClipboard.mockRejectedValue(new Error("no clipboard available"));
	const fixture = createFixture();
	const flash = vi.spyOn(fixture.tui, "flash");
	try {
		dragSelect(fixture);
		await flushCopy();
		fixture.tui.renderNow();

		expect(clipboardMocks.copyToClipboard).toHaveBeenCalledWith("alpha");
		const screen = renderedScreen(fixture.tui);
		expect(screen).toContain("no clipboard available");
		expect(screen).not.toContain("Copied!");
		expect(flash).toHaveBeenCalledWith("no clipboard available", 5000);
		// The host path owns the write: no bare OSC 52 fallback may flash a
		// false success next to the honest failure message.
		expect(fixture.terminal.writes.join("")).not.toMatch(/\x1b\]52;c;/);
	} finally {
		fixture.tui.stop();
	}
});

test("a successful host copy flashes Copied without writing OSC 52", async () => {
	clipboardMocks.copyToClipboard.mockResolvedValue(undefined);
	const fixture = createFixture();
	try {
		dragSelect(fixture);
		await flushCopy();
		fixture.tui.renderNow();

		expect(clipboardMocks.copyToClipboard).toHaveBeenCalledWith("alpha");
		expect(renderedScreen(fixture.tui)).toContain("Copied!");
		expect(fixture.terminal.writes.join("")).not.toMatch(/\x1b\]52;c;/);
	} finally {
		fixture.tui.stop();
	}
});

test.each([true, false, "backend unavailable"] as const)(
	"copy callback %s keeps boolean return and notification contract",
	async (result) => {
		const fixture = createFixture(async () => result);
		try {
			const flash = vi.spyOn(fixture.tui, "flash");
			const copy = Reflect.get(fixture.tui, "copyTextToClipboard") as (text: string) => Promise<boolean>;
			expect(await copy.call(fixture.tui, "alpha")).toBe(result === true);
			expect(flash).toHaveBeenCalledWith(
				result === true ? "Copied!" : result === false ? "Copy failed" : result,
				result === true ? undefined : 5000,
			);
			fixture.tui.renderNow();
			expect(renderedScreen(fixture.tui)).toContain(
				result === true ? "Copied!" : result === false ? "Copy failed" : result,
			);
		} finally {
			fixture.tui.stop();
		}
	},
);
