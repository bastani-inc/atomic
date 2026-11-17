import assert from "node:assert";
import { describe, it } from "node:test";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "../src/tui.ts";
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

const press = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}M`;
const release = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}m`;

describe("a click acts on the frame painted at the press", () => {
	it("drops the click when the overlay under the pointer moved before the release, even with the row's text unchanged", async () => {
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

		// Past the double-click window, a click on the frame as painted now lands.
		await new Promise((resolve) => setTimeout(resolve, 600));
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
});
