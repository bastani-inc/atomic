import assert from "node:assert";
import { describe, it } from "node:test";
import { HStack } from "../src/components/h-stack.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { type Component, Container, type TuiMouseEvent, type TuiMouseEventResult } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/** An overlay that records the mouse events it receives and answers the types in `handles`. */
class RecordingOverlay implements Component {
	lines: string[];
	readonly events: Array<{ type: string; y: number }> = [];
	private readonly handles: ReadonlySet<TuiMouseEvent["type"]>;

	constructor(lines: string[], handles: readonly TuiMouseEvent["type"][]) {
		this.lines = lines;
		this.handles = new Set(handles);
	}

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "move") return undefined;
		this.events.push({ type: event.type, y: event.y });
		return this.handles.has(event.type) ? { handled: true } : undefined;
	}
}

/** A child that takes the press and keeps the gesture: its drag and release come to it wherever the pointer goes. */
class CapturingChild implements Component {
	readonly events: string[] = [];
	private readonly label: string;

	constructor(label: string) {
		this.label = label;
	}

	render(): string[] {
		return [this.label];
	}

	invalidate(): void {}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "move") return undefined;
		this.events.push(event.type);
		return event.type === "press" ? { handled: true, capture: true } : { handled: true };
	}
}

const press = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}M`;
const release = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}m`;

describe("a click acts on the frame painted at the press", () => {
	it("drops the click when the overlay under the pointer moved before the release, even with the row's text unchanged (#5562)", async () => {
		const terminal = new VirtualTerminal(20, 10);
		const tui = new TuiAltScreen(terminal);
		const overlay = new RecordingOverlay(["item", "item", "item"], ["click"]);
		tui.start();
		tui.showOverlay(overlay, { anchor: "bottom-left", width: 20, nonCapturing: true });
		await terminal.waitForRender();

		// The overlay fills rows 7-9; the press lands on its second row.
		terminal.sendInput(press(1, 8));
		// It grows by a row at the top, so the same screen row is now its third.
		overlay.lines = ["item", "item", "item", "item"];
		tui.requestRender();
		await terminal.waitForRender();
		terminal.sendInput(release(1, 8));
		await terminal.waitForRender();

		assert.deepStrictEqual(
			overlay.events.filter((event) => event.type === "click"),
			[],
			"the click was aimed at the overlay's second row",
		);

		// The invalid gesture does not make the next click on the new frame a double-click.
		terminal.sendInput(press(1, 8));
		terminal.sendInput(release(1, 8));
		await terminal.waitForRender();
		assert.deepStrictEqual(
			overlay.events.filter((event) => event.type === "click"),
			[{ type: "click", y: 2 }],
			"a click on an unchanged frame still lands",
		);
		tui.stop();
	});

	it("never opens a link replaced between press and release (#5562)", async (t) => {
		const terminal = new VirtualTerminal(30, 2);
		const opened: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, { openUrl: (url) => opened.push(url) });
		let url = "https://example.com/old";
		tui.addChild({ render: () => [`\x1b]8;;${url}\x07link\x1b]8;;\x07`], invalidate: () => {} });
		tui.start();
		t.after(() => tui.stop());
		await terminal.waitForRender();
		terminal.sendInput(press(1, 0));
		url = "https://example.com/new";
		tui.requestRender();
		await terminal.waitForRender();
		terminal.sendInput(release(1, 0));
		terminal.sendInput(press(1, 0));
		terminal.sendInput(release(1, 0));
		assert.deepStrictEqual(opened, [url]);
	});

	it("gives a target that took the press its release but no click once it is no longer painted", async () => {
		const terminal = new VirtualTerminal(20, 10);
		const tui = new TuiAltScreen(terminal);
		const overlay = new RecordingOverlay(["button"], ["press", "release", "click"]);
		tui.start();
		const handle = tui.showOverlay(overlay, { anchor: "top-left", width: 20, nonCapturing: true });
		await terminal.waitForRender();

		terminal.sendInput(press(1, 0));
		handle.hide();
		await terminal.waitForRender();
		terminal.sendInput(release(1, 0));
		await terminal.waitForRender();

		// The release still reaches it, so it can end what the press started.
		assert.deepStrictEqual(
			overlay.events.map((event) => event.type),
			["press", "release"],
		);
		tui.stop();
	});

	it("still clicks a target that took the press and stayed where it was painted", async () => {
		const terminal = new VirtualTerminal(20, 10);
		const tui = new TuiAltScreen(terminal);
		const overlay = new RecordingOverlay(["button"], ["press", "release", "click"]);
		tui.start();
		tui.showOverlay(overlay, { anchor: "top-left", width: 20, nonCapturing: true });
		await terminal.waitForRender();

		terminal.sendInput(press(1, 0));
		overlay.lines = ["button pressed"];
		tui.requestRender();
		await terminal.waitForRender();
		terminal.sendInput(release(1, 0));
		await terminal.waitForRender();

		assert.deepStrictEqual(
			overlay.events.map((event) => event.type),
			["press", "release", "click"],
		);
		tui.stop();
	});

	it("gives a captured target that was replaced before the release its release but no click", async () => {
		const terminal = new VirtualTerminal(20, 10);
		const tui = new TuiAltScreen(terminal);
		const list = new Container();
		const pressed = new CapturingChild("same text");
		list.addChild(new CapturingChild("first row"));
		list.addChild(pressed);
		tui.addChild(list);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput(press(1, 1));
		// Another child that looks the same takes the pressed child's place before the release.
		const replacement = new CapturingChild("same text");
		list.children[1] = replacement;
		list.invalidate();
		tui.requestRender();
		await terminal.waitForRender();
		terminal.sendInput(release(1, 1));
		await terminal.waitForRender();

		assert.deepStrictEqual(pressed.events, ["press", "release"], "the removed child ends its gesture, unclicked");
		assert.deepStrictEqual(replacement.events, []);
		tui.stop();
	});

	it("counts a fast second click in a scroll view drawn away from the screen's left edge as a double-click when an overlay opened between them", async () => {
		const terminal = new VirtualTerminal(40, 4);
		const tui = new TuiAltScreen(terminal);
		const clickCounts: number[] = [];
		const words: Component = {
			render: () => ["alpha beta gamma"],
			invalidate: () => {},
			handleMouse: (event) => {
				if (event.type !== "click") return undefined;
				clickCounts.push(event.clickCount ?? 0);
				return { handled: true };
			},
		};
		tui.setLayoutRoot(
			new HStack([
				{ component: new Text("left", 0, 0), basis: 10, shrink: 0 },
				{ component: new ScrollView(words, { primary: true }), basis: 30, shrink: 0 },
			]),
		);
		tui.start();
		await terminal.waitForRender();

		// "beta" starts at column 16 of the screen: column 6 of the scroll view.
		terminal.sendInput(press(16, 0));
		terminal.sendInput(release(16, 0));
		await terminal.waitForRender();
		// An overlay elsewhere changes how the next press is located, not where it lands.
		tui.showOverlay(
			{ render: () => ["note"], invalidate: () => {} },
			{ row: 3, col: 34, width: 6, nonCapturing: true },
		);
		await terminal.waitForRender();
		terminal.sendInput(press(16, 0));
		terminal.sendInput(release(16, 0));
		await terminal.waitForRender();

		assert.deepStrictEqual(clickCounts, [1, 2]);
		tui.stop();
	});

	/** A renderer that copies what a double-click selects, and items that record which of them a single click reached. */
	function clickCountFixture() {
		const terminal = new VirtualTerminal(20, 4);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		// A single click reaches the item drawn there; a double-click selects and copies a word, a triple a line.
		const clicked: string[] = [];
		const item = (name: string): Component => ({
			render: () => ["same text"],
			invalidate: () => {},
			handleMouse: (event) => {
				if (event.type !== "click") return undefined;
				clicked.push(name);
				return { handled: true };
			},
		});
		const doubleClick = async () => {
			for (let click = 0; click < 2; click++) {
				terminal.sendInput(press(1, 0));
				terminal.sendInput(release(1, 0));
			}
			await terminal.waitForRender();
		};
		return { terminal, tui, copied, clicked, item, doubleClick };
	}

	it("starts counting clicks again when another item is drawn under the pointer between them", async () => {
		const { terminal, tui, copied, clicked, item, doubleClick } = clickCountFixture();
		const list = new Container();
		list.addChild(item("first"));
		tui.addChild(list);
		tui.start();
		await terminal.waitForRender();

		await doubleClick();
		// Another item that reads the same takes the row before the next two fast clicks.
		list.children[0] = item("second");
		list.invalidate();
		tui.requestRender();
		await terminal.waitForRender();
		await doubleClick();

		assert.deepStrictEqual(clicked, ["first", "second"], "each item's first click is a single click");
		assert.deepStrictEqual(copied, ["same", "same"], "each item's second click is a double-click");
		tui.stop();
	});

	it("starts counting clicks again when another item replaces the layout root between them", async () => {
		const { terminal, tui, copied, clicked, item, doubleClick } = clickCountFixture();
		tui.setLayoutRoot(item("first"));
		tui.start();
		await terminal.waitForRender();

		await doubleClick();
		// Another root that reads the same is laid out before the next two fast clicks.
		tui.setLayoutRoot(item("second"));
		tui.requestRender();
		await terminal.waitForRender();
		await doubleClick();

		assert.deepStrictEqual(clicked, ["first", "second"], "each root's first click is a single click");
		assert.deepStrictEqual(copied, ["same", "same"], "each root's second click is a double-click");
		tui.stop();
	});
});
