import assert from "node:assert/strict";
import { stripTerminalSequences, type Terminal, TuiMainScreen } from "@bastani/atomic-tui";
import { beforeAll, describe, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import {
	MainComposerKeyOverlay,
	mainComposerHintSegments,
	mainComposerKeys,
} from "../src/modes/interactive/components/main-composer-keys.ts";
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
	setProgramStatus(): void {}
}

beforeAll(() => {
	initTheme("dark");
});

const keybindings = () => new KeybindingsManager();

describe("main composer keys (#5224)", () => {
	test("the footer names the keys help shortcut without advertising an unhandled agent-focus key (#5243)", () => {
		assert.deepEqual(mainComposerHintSegments(keybindings(), { agentRows: 3 }), ["? keys"]);
		assert.deepEqual(mainComposerHintSegments(keybindings(), { agentRows: 1 }), ["? keys"]);
		assert.deepEqual(mainComposerHintSegments(keybindings(), { agentRows: 0 }), ["? keys"]);
	});

	test("an unbound action is left out of the footer, so it never names a dead key", () => {
		const unbound = {
			matches: () => false,
			getKeys: (action: string) => (action === "app.keys.help" ? [] : ["down"]),
		};
		assert.deepEqual(mainComposerHintSegments(unbound, { agentRows: 2 }), []);
	});

	test("the overlay lists interrupt only while working and never lists an unhandled agent-focus key (#5243)", () => {
		const idle = mainComposerKeys({ agentRows: 0, working: false }).map((key) => key.action ?? key.keys);
		assert.ok(!idle.includes("app.interrupt"));
		assert.ok(!idle.includes("app.agents.focus"));
		const busy = mainComposerKeys({ agentRows: 2, working: true }).map((key) => key.action ?? key.keys);
		assert.ok(busy.includes("app.interrupt"));
		assert.ok(!busy.includes("app.agents.focus"));
	});

	for (const width of [80, 160]) {
		test(`the overlay renders as a framed box at ${width} columns and closes on Esc or ?`, () => {
			let closed = 0;
			const overlay = new MainComposerKeyOverlay(
				keybindings(),
				() => ({ agentRows: 2, working: true }),
				() => {
					closed += 1;
				},
			);
			const lines = overlay.render(width).map(stripTerminalSequences);
			assert.ok(lines[0]?.startsWith("╭─ keys "), lines[0]);
			assert.ok(lines.some((line) => line.includes("interrupt the agent's turn")));
			assert.ok(lines.some((line) => line.includes("close this help")));
			overlay.handleInput("x");
			assert.equal(closed, 0);
			overlay.handleInput("\x1b");
			overlay.handleInput("?");
			assert.equal(closed, 2);
		});
	}

	test("a narrow terminal drops the overlay's frame and keeps the rows", () => {
		const overlay = new MainComposerKeyOverlay(
			keybindings(),
			() => ({ agentRows: 0, working: false }),
			() => {},
		);
		const lines = overlay.render(20).map(stripTerminalSequences);
		assert.ok(!lines[0]?.startsWith("╭"), lines[0]);
	});

	test("? on an empty prompt opens the overlay; typed after text it stays a character", () => {
		const editor = new CustomEditor(new TuiMainScreen(new FakeTerminal()), getEditorTheme(), keybindings());
		let opened = 0;
		editor.onAction("app.keys.help", () => {
			opened += 1;
		});
		editor.handleInput("?");
		assert.equal(opened, 1);
		assert.equal(editor.getText(), "");
		editor.handleInput("a");
		editor.handleInput("?");
		assert.equal(opened, 1);
		assert.equal(editor.getText(), "a?");
	});
});
