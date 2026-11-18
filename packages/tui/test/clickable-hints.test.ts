import assert from "node:assert";
import { describe, it } from "node:test";
import { clickableHint, clickableKeysHint, commandHintAction, keyHintAction } from "../src/clickable-hints.ts";
import { keyInputData, matchesKey } from "../src/keys.ts";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/** A terminal that keeps every write, so a test can tell what reached it. */
class RecordingVirtualTerminal extends VirtualTerminal {
	readonly writes: string[] = [];
	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

/** A focused view that draws `lines` and records the keys it receives and the mouse events it is offered. */
class KeyView implements Component {
	lines: string[];
	readonly keys: string[] = [];
	readonly mouse: string[] = [];
	private readonly takesPresses: boolean;

	constructor(lines: string[], takesPresses = false) {
		this.lines = lines;
		this.takesPresses = takesPresses;
	}

	render(): string[] {
		return this.lines;
	}

	handleInput(data: string): void {
		this.keys.push(data);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "move") return undefined;
		this.mouse.push(`${event.type}@${event.y}`);
		return this.takesPresses ? { handled: true } : undefined;
	}

	invalidate(): void {}
}

const press = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}M`;
const drag = (x: number, y: number) => `\x1b[<32;${x + 1};${y + 1}M`;
const release = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}m`;
const DOUBLE_CLICK_GAP_MS = 600;

async function mount(lines: string[], takesPresses = false) {
	const terminal = new RecordingVirtualTerminal(40, 6);
	const tui = new TuiAltScreen(terminal);
	const view = new KeyView(lines, takesPresses);
	tui.addChild(view);
	tui.setFocus(view);
	tui.start();
	await terminal.waitForRender();
	const click = async (x: number, y: number) => {
		terminal.sendInput(press(x, y));
		terminal.sendInput(release(x, y));
		await terminal.waitForRender();
	};
	return { terminal, tui, view, click };
}

/** The keys `view` received, by the key id each one matches. */
function keysOf(view: KeyView, ...ids: Parameters<typeof matchesKey>[1][]): string[] {
	return view.keys.map((data) => ids.find((id) => matchesKey(data, id)) ?? JSON.stringify(data));
}

describe("a click on a key hint runs its key", () => {
	it("feeds the hint's key to the focused view, and never writes the hint markers to the terminal", async () => {
		const { terminal, view, click, tui } = await mount([clickableHint("esc cancel", keyHintAction("escape"))]);
		await click(5, 0);
		assert.deepStrictEqual(keysOf(view, "escape"), ["escape"]);
		assert.ok(!terminal.writes.join("").includes("\x1b_pi:h"), "the hint markers stay inside the renderer");
		assert.strictEqual(tui.getScreenLines()[0]?.includes("\x1b_pi"), false);
		assert.strictEqual(terminal.getViewport()[0]?.trimEnd(), "esc cancel");
		tui.stop();
	});

	it("acts by the half clicked on a hint that names two keys", async () => {
		const hint = clickableKeysHint(
			[
				{ text: "↑/", key: "up" },
				{ text: "↓", key: "down" },
			],
			" select",
		);
		const { view, click, tui } = await mount([`  ${hint}`]);
		await click(2, 0); // ↑
		await new Promise((resolve) => setTimeout(resolve, DOUBLE_CLICK_GAP_MS));
		await click(4, 0); // ↓
		await new Promise((resolve) => setTimeout(resolve, DOUBLE_CLICK_GAP_MS));
		await click(8, 0); // select
		assert.deepStrictEqual(keysOf(view, "up", "down"), ["up", "down", "down"]);
		tui.stop();
	});

	it("runs once for a double click, and not at all for a drag, which selects the hint's text", async () => {
		const { terminal, view, click, tui } = await mount([clickableHint("enter select", keyHintAction("enter"))]);
		await click(2, 0);
		await click(2, 0);
		assert.deepStrictEqual(keysOf(view, "enter"), ["enter"], "the second click of a double click selects the word");

		await new Promise((resolve) => setTimeout(resolve, DOUBLE_CLICK_GAP_MS));
		terminal.sendInput(press(1, 0));
		terminal.sendInput(drag(8, 0));
		terminal.sendInput(release(8, 0));
		await terminal.waitForRender();
		assert.deepStrictEqual(keysOf(view, "enter"), ["enter"], "a drag selects text and runs nothing");
		assert.strictEqual(tui.hasActiveSelection(), true);
		tui.stop();
	});

	it("takes a press on a hint ahead of the view that drew it, and leaves every other cell to the view", async () => {
		const { view, click, tui } = await mount(
			["enter is plain text here", clickableHint("esc close", keyHintAction("escape"))],
			true,
		);
		await click(1, 0);
		assert.deepStrictEqual(view.keys, [], "text that only reads like a hint runs nothing");
		assert.ok(view.mouse.includes("press@0"), "the view keeps its own presses");
		await new Promise((resolve) => setTimeout(resolve, DOUBLE_CLICK_GAP_MS));
		await click(1, 1);
		assert.deepStrictEqual(keysOf(view, "escape"), ["escape"]);
		assert.ok(!view.mouse.includes("press@1"), "the hint took its press");
		tui.stop();
	});

	it("runs only the hints of the layer that holds the keys: a focused overlay's, not those drawn beneath it", async () => {
		const { view, click, tui, terminal } = await mount([clickableHint("esc interrupt", keyHintAction("escape"))]);
		const dialog = new KeyView(["", clickableHint("enter confirm", keyHintAction("enter"))]);
		tui.showOverlay(dialog, { anchor: "bottom-left", width: 20 });
		await terminal.waitForRender();
		await click(1, 0);
		assert.deepStrictEqual(view.keys, []);
		assert.deepStrictEqual(dialog.keys, [], "a hint beneath the dialog names a key the dialog does not offer");
		await new Promise((resolve) => setTimeout(resolve, DOUBLE_CLICK_GAP_MS));
		await click(1, 5);
		assert.deepStrictEqual(keysOf(dialog, "enter"), ["enter"]);
		tui.stop();
	});

	it("hands a slash command to the command handler", async () => {
		const { click, tui } = await mount([clickableHint("/tasks to manage", commandHintAction("/tasks"))]);
		const commands: string[] = [];
		tui.setHintCommandHandler((command) => commands.push(command));
		await click(3, 0);
		assert.deepStrictEqual(commands, ["/tasks"]);
		tui.stop();
	});
});

describe("keyInputData", () => {
	it("encodes a key as input that matches it", () => {
		for (const key of [
			"escape",
			"enter",
			"ctrl+o",
			"pageUp",
			"pageDown",
			"up",
			"left",
			"?",
			"x",
			"shift+tab",
			"ctrl+x",
		] as const) {
			const data = keyInputData(key);
			assert.ok(data !== undefined && matchesKey(data, key), key);
		}
	});
});
