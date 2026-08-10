import type { Component, TUI, TuiBase, TuiMode } from "@earendil-works/pi-tui";
import { isViewportTUI, TuiAltScreen } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import { registerStartupInputListeners } from "../src/modes/interactive/interactive-input-handling.ts";
import {
	createInteractiveTui,
	createInteractiveTuiReference,
	InteractiveMode,
} from "../src/modes/interactive/interactive-mode.ts";
import { openBrowser } from "../src/utils/open-browser.ts";
import {
	createProductionFullscreenContext,
	getLayoutFrame,
	RecordingTerminal,
} from "./helpers/interactive-fullscreen-layout.ts";

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
	test("keeps the fullscreen dock fixed while the transcript scrolls and resizes", async () => {
		const { context, terminal, tui, initPromise, resolveTheme, restoreOffline } = createProductionFullscreenContext({
			columns: 24,
			rows: 12,
		});

		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			tui.renderNow();

			const transcript = context.transcriptScrollView;
			if (!transcript) throw new Error("production transcript did not mount");
			const getFrame = () => getLayoutFrame(tui);
			const initial = getFrame();
			const initialDock = initial.root.children[1];
			const dock = context.fullscreenLayoutRoot?.children[1];
			if (!dock) throw new Error("fullscreen dock did not render");
			expect(initialDock.component).toBe(dock);
			expect(initialDock.rect.height).toBe(dock.render(terminal.columns).length);
			expect(initialDock.rect.y).toBe(terminal.rows - initialDock.rect.height);
			const initialDockLines = initial.lines.slice(initialDock.rect.y, initialDock.rect.y + initialDock.rect.height);
			expect(initialDockLines.some((line) => line.includes("editor"))).toBe(true);
			expect(initialDockLines.at(-1)).toContain("footer");
			const initialScrollTop = transcript.scrollTop;
			expect(initialScrollTop).toBeGreaterThan(0);

			// The wheel lands on the footer, but the primary transcript handles it.
			terminal.input(`\x1b[<64;1;${terminal.rows}M`);
			tui.renderNow();
			expect(transcript.scrollTop).toBe(initialScrollTop - 1);
			const scrolled = getFrame();
			const scrolledDock = scrolled.root.children[1];
			if (!scrolledDock) throw new Error("fullscreen dock disappeared after scrolling");
			expect(scrolledDock.rect).toEqual(initialDock.rect);
			expect(
				scrolled.lines.slice(scrolledDock.rect.y, scrolledDock.rect.y + scrolledDock.rect.height).at(-1),
			).toContain("footer");

			terminal.resize(30, 8);
			tui.renderNow();
			const resized = getFrame();
			const resizedDock = resized.root.children[1];
			if (!resizedDock) throw new Error("fullscreen dock disappeared after resize");
			expect(resizedDock.rect.height).toBe(initialDock.rect.height);
			expect(resizedDock.rect.y).toBe(terminal.rows - resizedDock.rect.height);
			expect(resized.lines.slice(resizedDock.rect.y, resizedDock.rect.y + resizedDock.rect.height).at(-1)).toContain(
				"footer",
			);
			expect(transcript.viewportHeight).toBe(terminal.rows - resizedDock.rect.height);
		} finally {
			resolveTheme();
			await initPromise;
			tui.stop();
			restoreOffline();
		}
	});
});
