import assert from "node:assert/strict";
import { stripTerminalSequences, type Terminal, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, test } from "vitest";
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

function createLoader(
	tui: TuiMainScreen,
	message = "Working",
	indicator?: { frames?: string[]; intervalMs?: number },
): AtomicWorkingLoader {
	const loader = new AtomicWorkingLoader(tui, undefined, String, message, indicator);
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

test("the embedded Atomic spinner preserves its animated frame styling", () => {
	const tui = new TuiMainScreen(new FakeTerminal());
	const editor = new CustomEditor(tui, getEditorTheme(), new KeybindingsManager(), { embedWorkingStatus: true });
	const loader = createLoader(tui);
	editor.setWorkingStatusIndicator(loader);

	const borders = Array.from({ length: 10 }, (_, frame) => {
		Reflect.set(loader, "frame", frame);
		return editor.render(40)[0] ?? "";
	});

	assert.ok(new Set(borders).size > 1, "embedded spinner frames must retain Atomic's color/bold animation");
	assert.equal(new Set(borders.map(stripTerminalSequences)).size, 1, "the one-cell Atomic glyph remains stable");
});

describe("extension-supplied working indicator text", () => {
	for (const [name, message, indicator] of [
		["multiline message", "Deploying\nstack", undefined],
		["multiline custom frame", "Working", { frames: ["a\nb"] }],
		["message with terminal controls", "Deploying\u0000\tstack", undefined],
	] as const) {
		test(`${name} cannot crash the embedded editor render`, () => {
			const tui = new TuiMainScreen(new FakeTerminal());
			const editor = new CustomEditor(tui, getEditorTheme(), new KeybindingsManager(), {
				embedWorkingStatus: true,
			});
			editor.setWorkingStatusIndicator(createLoader(tui, message, indicator));

			const border = editor.render(40)[0] ?? "";
			assert.equal(visibleWidth(border), 40);
			assert.doesNotMatch(stripTerminalSequences(border), /[\x00-\x1f\x7f]/);
		});
	}

	for (const message of ["Working ", ""] as const) {
		test(`spinner-only fallback excludes the label for ${JSON.stringify(message)}`, () => {
			const tui = new TuiMainScreen(new FakeTerminal());
			const editor = new CustomEditor(tui, getEditorTheme(), new KeybindingsManager(), {
				embedWorkingStatus: true,
			});
			editor.setWorkingStatusIndicator(createLoader(tui, message));

			const border = editor.render(5)[0] ?? "";
			assert.equal(stripTerminalSequences(border), "───∀─");
			assert.equal(visibleWidth(border), 5);
		});
	}
});

test("working overflow preserves the idle label position and exact border widths", () => {
	const tui = new TuiMainScreen(new FakeTerminal());
	const editor = new CustomEditor(tui, getEditorTheme(), new KeybindingsManager(), { embedWorkingStatus: true });
	editor.setText(Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n"));

	const idleBorders = new Map<number, string>();
	for (let width = 8; width <= 120; width += 1) {
		const border = editor.render(width)[0] ?? "";
		idleBorders.set(width, stripTerminalSequences(border));
		assert.equal(visibleWidth(border), width, `idle border width ${width}`);
	}

	let intactOverflowLabels = 0;
	editor.setWorkingStatusIndicator(createLoader(tui));
	for (let width = 8; width <= 120; width += 1) {
		const border = editor.render(width)[0] ?? "";
		const plain = stripTerminalSequences(border);
		const idle = idleBorders.get(width) ?? "";
		assert.equal(visibleWidth(border), width, `working border width ${width}`);
		const idleLabel = /↑ \d+ more/.exec(idle);
		if (!idleLabel) continue;
		intactOverflowLabels += 1;
		assert.ok(plain.includes(idleLabel[0]), `overflow label at width ${width}`);
		assert.equal(plain.indexOf("↑"), idle.indexOf("↑"), `overflow label position at width ${width}`);
	}
	assert.ok(intactOverflowLabels > 0, "the sweep must exercise an intact overflow label");
});
