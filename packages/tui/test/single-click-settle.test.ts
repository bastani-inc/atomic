import assert from "node:assert";
import { describe, it } from "node:test";
import { Text } from "../src/components/text.ts";
import { type Component, Container, type TuiMouseEventResult } from "../src/tui.ts";
import { MULTI_CLICK_INTERVAL_MS, TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const press = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}M`;
const release = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}m`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A renderer that copies what a double-click selects, over rows whose single click acts only once it is known not to
 * start a double- or triple-click. `capture` makes each row take its press, as a component that owns its gesture does.
 */
function settleFixture(options: { readonly capture?: boolean } = {}) {
	const terminal = new VirtualTerminal(30, 4);
	const copied: string[] = [];
	const tui = new TuiAltScreen(terminal, undefined, undefined, {
		copySelection: async (text) => {
			copied.push(text);
			return true;
		},
	});
	const acted: string[] = [];
	const clicks: string[] = [];
	const row = (name: string): Component => ({
		render: () => [`${name} words here`],
		invalidate: () => {},
		handleMouse: (event): TuiMouseEventResult | undefined => {
			if (options.capture && event.type === "press") return { handled: true, capture: true };
			if (event.type !== "click" || (event.clickCount ?? 1) !== 1) return undefined;
			clicks.push(name);
			return { handled: true, whenSingleClick: () => acted.push(name) };
		},
	});
	const list = new Container();
	list.addChild(row("first"));
	list.addChild(row("second"));
	tui.addChild(list);
	const click = (x: number, y: number) => {
		terminal.sendInput(press(x, y));
		terminal.sendInput(release(x, y));
	};
	return { terminal, tui, copied, acted, clicks, click };
}

describe("a single click's action waits until it cannot become a double-click", () => {
	it("runs once the multi-click interval has passed since the press, and not before", async () => {
		const { terminal, tui, acted, clicks, click } = settleFixture();
		tui.start();
		await terminal.waitForRender();

		click(1, 0);
		await terminal.waitForRender();
		assert.deepStrictEqual(clicks, ["first"], "the click reached the row at once");
		assert.deepStrictEqual(acted, [], "its action waits for the multi-click interval");

		await sleep(MULTI_CLICK_INTERVAL_MS / 2);
		assert.deepStrictEqual(acted, []);
		await sleep(MULTI_CLICK_INTERVAL_MS / 2 + 50);
		assert.deepStrictEqual(acted, ["first"], "with no second press the click was a single click");
		await sleep(MULTI_CLICK_INTERVAL_MS);
		assert.deepStrictEqual(acted, ["first"], "the action runs once");
		tui.stop();
	});

	it("never runs for a double- or triple-click, which still select a word and a line", async () => {
		const { terminal, tui, copied, acted, click } = settleFixture();
		tui.start();
		await terminal.waitForRender();

		click(8, 0);
		click(8, 0);
		await terminal.waitForRender();
		await sleep(MULTI_CLICK_INTERVAL_MS + 100);
		assert.deepStrictEqual(acted, [], "a double-click is not a single click");
		assert.deepStrictEqual(copied, ["words"]);

		click(8, 1);
		click(8, 1);
		click(8, 1);
		await terminal.waitForRender();
		await sleep(MULTI_CLICK_INTERVAL_MS + 100);
		assert.deepStrictEqual(acted, [], "a triple-click is not a single click");
		assert.deepStrictEqual(copied, ["words", "words", "second words here"]);
		tui.stop();
	});

	it("keeps a click's action when a quick second click lands elsewhere, and runs both", async () => {
		const { terminal, tui, acted, click } = settleFixture();
		tui.start();
		await terminal.waitForRender();

		click(1, 0);
		click(1, 1);
		await terminal.waitForRender();
		assert.deepStrictEqual(acted, []);
		await sleep(MULTI_CLICK_INTERVAL_MS + 100);
		assert.deepStrictEqual(acted, ["first", "second"]);
		tui.stop();
	});

	it("waits the same way for a component that takes its press", async () => {
		const { terminal, tui, acted, clicks, click } = settleFixture({ capture: true });
		tui.start();
		await terminal.waitForRender();

		click(1, 0);
		await terminal.waitForRender();
		assert.deepStrictEqual(clicks, ["first"]);
		assert.deepStrictEqual(acted, []);
		await sleep(MULTI_CLICK_INTERVAL_MS + 100);
		assert.deepStrictEqual(acted, ["first"]);

		click(1, 1);
		click(1, 1);
		await terminal.waitForRender();
		await sleep(MULTI_CLICK_INTERVAL_MS + 100);
		assert.deepStrictEqual(acted, ["first"], "the second click made it a double-click");
		tui.stop();
	});

	it("drops a waiting action when the renderer stops", async () => {
		const { terminal, tui, acted, click } = settleFixture();
		tui.start();
		await terminal.waitForRender();

		click(1, 0);
		await terminal.waitForRender();
		tui.stop();
		await sleep(MULTI_CLICK_INTERVAL_MS + 100);
		assert.deepStrictEqual(acted, []);
	});

	it("never runs when a dialog takes focus before the click settles", async () => {
		const { terminal, tui, acted, clicks, click } = settleFixture();
		tui.start();
		await terminal.waitForRender();

		click(1, 0);
		await terminal.waitForRender();
		assert.deepStrictEqual(clicks, ["first"]);
		tui.showOverlay(new Text("Stop everything?", 0, 0), { anchor: "bottom-right", width: 18 });
		await terminal.waitForRender();
		await sleep(MULTI_CLICK_INTERVAL_MS + 100);
		assert.deepStrictEqual(acted, [], "the dialog took the click's action away from the row behind it");
		tui.stop();
	});
});
