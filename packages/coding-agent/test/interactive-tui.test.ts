import type { Component, Terminal, TUI, TuiBase, TuiMode } from "@earendil-works/pi-tui";
import { isViewportTUI, TuiAltScreen } from "@earendil-works/pi-tui";
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

	start(onInput: (data: string) => void, _onResize: () => void): void {
		this.startCount += 1;
		this.onInput = onInput;
	}

	stop(): void {
		this.stopCount += 1;
		this.onInput = undefined;
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
});
