import assert from "node:assert/strict";
import { type Terminal, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { AtomicWorkingLoader } from "../src/modes/interactive/components/atomic-working-status.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

class FakeTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = true;

	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(_data: string): void {}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
}

const activeLoaders: AtomicWorkingLoader[] = [];

function createLoader(tui: TuiMainScreen): AtomicWorkingLoader {
	const loader = new AtomicWorkingLoader(tui, undefined, String, "Working");
	activeLoaders.push(loader);
	return loader;
}

beforeAll(() => {
	initTheme("dark");
});

afterEach(() => {
	for (const loader of activeLoaders.splice(0)) loader.stop();
});

test("custom editors keep the standalone working row unless they opt in", () => {
	const tui = new TuiMainScreen(new FakeTerminal());
	const editor = new CustomEditor(tui, getEditorTheme(), new KeybindingsManager());
	editor.setWorkingStatusIndicator(createLoader(tui));

	assert.equal(editor.embedWorkingStatus, false);
	assert.equal(editor.render(24)[0]?.replaceAll(/\x1b\[[0-9;]*m/g, ""), "─".repeat(24));
});

test("an opted-in editor renders Atomic's working indicator in its top border", () => {
	const tui = new TuiMainScreen(new FakeTerminal());
	const editor = new CustomEditor(tui, getEditorTheme(), new KeybindingsManager(), { embedWorkingStatus: true });
	editor.setWorkingStatusIndicator(createLoader(tui));

	const topBorder = editor.render(24)[0] ?? "";
	assert.match(topBorder.replaceAll(/\x1b\[[0-9;]*m/g, ""), /^── ∀ Working /);
	assert.equal(visibleWidth(topBorder), 24);
});

test("the embedded indicator collapses to Atomic's one-cell spinner at narrow widths", () => {
	const tui = new TuiMainScreen(new FakeTerminal());
	const editor = new CustomEditor(tui, getEditorTheme(), new KeybindingsManager(), { embedWorkingStatus: true });
	editor.setWorkingStatusIndicator(createLoader(tui));

	const topBorder = editor.render(5)[0] ?? "";
	assert.match(topBorder.replaceAll(/\x1b\[[0-9;]*m/g, ""), /∀/);
	assert.doesNotMatch(topBorder, /Working/);
	assert.equal(visibleWidth(topBorder), 5);
});
