import type { Component, Terminal, TUI, TuiBase, TuiMode } from "@earendil-works/pi-tui";
import { Container, isViewportTUI, ScrollView, Text, TuiAltScreen, VStack } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import { registerStartupInputListeners } from "../src/modes/interactive/interactive-input-handling.ts";
import {
	createInteractiveTui,
	createInteractiveTuiReference,
	InteractiveMode,
} from "../src/modes/interactive/interactive-mode.ts";
import { openBrowser } from "../src/utils/open-browser.ts";

class RecordingTerminal implements Terminal {
	columns = 40;
	rows = 8;
	kittyProtocolActive = true;
	startCount = 0;
	stopCount = 0;
	cursorVisible = true;
	readonly writes: string[] = [];
	private onInput: ((data: string) => void) | undefined;
	private onResize: (() => void) | undefined;

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.startCount += 1;
		this.onInput = onInput;
		this.onResize = onResize;
	}

	stop(): void {
		this.stopCount += 1;
		this.onInput = undefined;
		this.onResize = undefined;
	}

	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(_lines: number): void {}
	hideCursor(): void {
		this.cursorVisible = false;
	}
	showCursor(): void {
		this.cursorVisible = true;
	}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}

	input(data: string): void {
		this.onInput?.(data);
	}

	resize(columns: number, rows: number): void {
		this.columns = columns;
		this.rows = rows;
		this.onResize?.();
	}
}

describe("interactive TUI renderer", () => {
	test("selects the alternate-screen renderer with link activation and alternate-screen bytes", () => {
		const regular = createInteractiveTui({
			tuiMode: "regular",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal: new RecordingTerminal(),
		});
		const fullscreenTerminal = new RecordingTerminal();
		const fullscreen = createInteractiveTui({
			tuiMode: "fullscreen",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal: fullscreenTerminal,
		});

		expect(regular.mode).toBe("regular");
		expect(isViewportTUI(regular)).toBe(false);
		expect(fullscreen.mode).toBe("fullscreen");
		expect(Reflect.get(fullscreen, "openUrl")).toBe(openBrowser);
		expect(isViewportTUI(fullscreen)).toBe(true);

		fullscreen.start();
		expect(fullscreenTerminal.writes.some((write) => write.includes("\x1b[?1049h"))).toBe(true);
		fullscreen.stop();
		expect(fullscreenTerminal.writes.some((write) => write.includes("\x1b[?1049l"))).toBe(true);
	});

	test("routes captured methods to a replacement renderer", () => {
		const regularRequestRender = vi.fn();
		const fullscreenRequestRender = vi.fn();
		let renderer = { requestRender: regularRequestRender } as unknown as TUI;
		const tui = createInteractiveTuiReference(() => renderer);
		const requestRender = tui.requestRender;

		requestRender();
		renderer = { requestRender: fullscreenRequestRender } as unknown as TUI;
		requestRender();

		expect(regularRequestRender).toHaveBeenCalledOnce();
		expect(fullscreenRequestRender).toHaveBeenCalledOnce();
	});

	test("does not recurse when a stable method wraps itself", () => {
		const renderer = { render: (width: number) => [`width: ${width}`] } as unknown as TUI;
		const tui = createInteractiveTuiReference(() => renderer);
		const originalRender = tui.render;
		tui.render = (width: number) => originalRender(width);

		expect(tui.render(80)).toEqual(["width: 80"]);
	});

	test("switches renderers without losing host components, focus, or input listeners", async () => {
		const terminal = new RecordingTerminal();
		const renderer = createInteractiveTui({
			tuiMode: "regular",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
		});
		const themeController = { rebindTui: vi.fn() };
		const matchesClear = vi.fn<(candidate: string, action: string) => boolean>(() => false);
		const session = {
			isStreaming: false,
			isCompacting: false,
			settingsManager: { getShowTerminalProgress: () => false },
		};
		const context = Object.assign(Object.create(InteractiveMode.prototype), {
			renderer,
			ui: undefined as unknown as TUI,
			mainScreenRenderState: undefined,
			options: { tuiMode: "regular" as TuiMode },
			runtimeHost: { services: { agentDir: "/tmp" }, session },
			themeController,
			tuiInputSubscriptions: new Set(),
			extensionTerminalInputSubscriptions: new Set(),
			tuiRendererChangeListeners: new Set(),
			keybindings: { matches: matchesClear },
		}) as unknown as InteractiveMode;
		const stableUi = createInteractiveTuiReference(() => Reflect.get(context, "renderer") as TUI);
		context.ui = stableUi;
		const render = vi.fn(() => ["content"]);
		const component = {
			focused: false,
			render,
			invalidate: vi.fn(),
		} as Component & { focused: boolean };
		context.fullscreenLayoutRoot = component;
		const onRendererChange = vi.fn();
		context.onTuiRendererChange(onRendererChange);
		const inputListener = vi.fn();

		registerStartupInputListeners(context);
		const inputSubscription = { handler: inputListener, unsubscribe: stableUi.addInputListener(inputListener) };
		context.tuiInputSubscriptions.add(inputSubscription);
		expect(context.tuiInputSubscriptions.size).toBe(3);
		renderer.addChild(component);
		renderer.setFocus(component);
		renderer.start();

		expect(context.switchTuiMode("fullscreen", false)).toBe(true);

		expect(stableUi.mode).toBe("fullscreen");
		expect(stableUi instanceof TuiAltScreen).toBe(true);
		expect(stableUi.children).toEqual([component]);
		expect((stableUi as TuiBase).getFocusedComponent()).toBe(component);
		expect(component.focused).toBe(true);
		expect(themeController.rebindTui).toHaveBeenCalledOnce();
		expect(onRendererChange).toHaveBeenCalledOnce();
		expect([terminal.startCount, terminal.stopCount]).toEqual([2, 1]);

		terminal.input("x");
		expect(inputListener).toHaveBeenCalledWith("x");
		expect(matchesClear).toHaveBeenCalledWith("x", "app.clear");

		context.stopInteractiveTui();

		expect(stableUi.mode).toBe("regular");
		// Shutdown stops the replacement renderer without starting the terminal again.
		expect([terminal.startCount, terminal.stopCount]).toEqual([2, 3]);
		expect(terminal.cursorVisible).toBe(true);

		const rendersAtShutdown = render.mock.calls.length;
		stableUi.requestRender(true);
		await new Promise<void>((resolve) => process.nextTick(resolve));
		expect(render).toHaveBeenCalledTimes(rendersAtShutdown);
	});
	test("keeps the fullscreen dock fixed while the transcript scrolls and resizes", () => {
		type LayoutFrame = {
			root: { children: Array<{ rect: { y: number; height: number } }> };
			lines: string[];
		};

		const terminal = new RecordingTerminal();
		terminal.columns = 24;
		terminal.rows = 6;
		const document = new Container();
		for (let index = 1; index <= 10; index += 1) {
			document.addChild(new Text(`line ${index}`, 0, 0));
		}
		const transcript = new ScrollView(document, { follow: "end", primary: true, overscroll: "chain" });
		const editor = new Text("editor", 0, 0);
		const footer = new Text("footer", 0, 0);
		const dock = new VStack([editor, footer]);
		const root = new VStack([
			{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
		]);
		const tui = new TuiAltScreen(terminal);
		const context = Object.assign(Object.create(InteractiveMode.prototype), {
			fullscreenLayoutRoot: root,
		}) as unknown as InteractiveMode;

		context.mountInteractiveTui(tui, [document, editor, footer]);
		tui.start();
		tui.renderNow();

		const getFrame = (): LayoutFrame => {
			const frame = (tui as unknown as { currentLayout?: LayoutFrame }).currentLayout;
			if (!frame) throw new Error("fullscreen layout did not render");
			return frame;
		};
		const initial = getFrame();
		const initialDock = initial.root.children[1];
		if (!initialDock) throw new Error("fullscreen dock did not render");
		expect(initialDock.rect.height).toBe(2);
		expect(initialDock.rect.y).toBe(4);
		expect(initial.lines.at(-2)).toContain("editor");
		expect(initial.lines.at(-1)).toContain("footer");
		const initialScrollTop = transcript.scrollTop;
		expect(initialScrollTop).toBeGreaterThan(0);

		// The wheel lands on the footer, but the primary transcript handles it.
		terminal.input("\x1b[<64;1;6M");
		tui.renderNow();
		expect(transcript.scrollTop).toBe(initialScrollTop - 1);
		const scrolled = getFrame();
		const scrolledDock = scrolled.root.children[1];
		if (!scrolledDock) throw new Error("fullscreen dock disappeared after scrolling");
		expect(scrolledDock.rect).toEqual(initialDock.rect);
		expect(scrolled.lines.at(-2)).toContain("editor");
		expect(scrolled.lines.at(-1)).toContain("footer");

		terminal.resize(30, 8);
		tui.renderNow();
		const resized = getFrame();
		const resizedDock = resized.root.children[1];
		if (!resizedDock) throw new Error("fullscreen dock disappeared after resize");
		expect(resizedDock.rect.height).toBe(2);
		expect(resizedDock.rect.y).toBe(6);
		expect(resized.lines.at(-2)).toContain("editor");
		expect(resized.lines.at(-1)).toContain("footer");
		expect(transcript.viewportHeight).toBe(6);
		tui.stop();
	});
});
