import { crc32, deflateSync } from "node:zlib";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	getCapabilities,
	type Image,
	isViewportTUI,
	resetCapabilitiesCache,
	ScrollView,
	setCapabilities,
	setCellDimensions,
	Text,
	type TUI,
	type TuiAltScreen,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { registerContentTools } from "../../web-access/content-tools.ts";
import type { ExtensionAPI } from "../src/core/extensions/api-types.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
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

const clipboardMocks = vi.hoisted(() => ({
	copyToClipboard: vi.fn<(text: string) => Promise<void>>(),
	readClipboardText: vi.fn<() => Promise<string | null>>(),
}));

vi.mock("../src/utils/clipboard.ts", () => clipboardMocks);

function pngChunk(type: string, body: Buffer): Buffer {
	const header = Buffer.alloc(8);
	header.writeUInt32BE(body.length, 0);
	header.write(type, 4, "ascii");
	const checksum = Buffer.alloc(4);
	checksum.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), body])), 0);
	return Buffer.concat([header, body, checksum]);
}

function createPng(width: number, height: number): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 0;
	const raw = Buffer.alloc((width + 1) * height);
	for (let row = 0; row < height; row += 1) {
		raw.fill(row % 256, row * (width + 1) + 1, (row + 1) * (width + 1));
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", deflateSync(raw)),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

function registerFetchContentTool(): ToolDefinition {
	const tools: ToolDefinition[] = [];
	const extensionApi: Pick<ExtensionAPI, "registerTool" | "appendEntry"> = {
		registerTool: (tool: ToolDefinition) => tools.push(tool),
		appendEntry: () => {},
	};
	registerContentTools(extensionApi as ExtensionAPI, {
		maxInlineContent: 100_000,
		stripThumbnails: (results) => results,
		formatFullResults: () => "",
	});
	const tool = tools.find(({ name }) => name === "fetch_content");
	if (!tool) throw new Error("content-tools did not register fetch_content");
	return tool;
}

function withTtyState(stdinIsTTY: boolean, stdoutIsTTY: boolean, callback: () => void): void {
	const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
	const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
	Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: stdinIsTTY });
	Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: stdoutIsTTY });
	try {
		callback();
	} finally {
		if (stdinDescriptor) Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
		else Reflect.deleteProperty(process.stdin, "isTTY");
		if (stdoutDescriptor) Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
		else Reflect.deleteProperty(process.stdout, "isTTY");
	}
}

function createGuardedTui() {
	return createInteractiveTui({ showHardwareCursor: false, logDirectory: "/tmp" });
}

describe("interactive TUI renderer", () => {
	test("always selects the alternate-screen renderer with link activation and alternate-screen bytes", () => {
		const terminal = new RecordingTerminal();
		const tui = createInteractiveTui({
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
		});

		expect(tui.mode).toBe("fullscreen");
		expect(Reflect.get(tui, "openUrl")).toBe(openBrowser);
		expect(isViewportTUI(tui)).toBe(true);

		tui.start();
		expect(terminal.writes.some((write) => write.includes("\x1b[?1049h"))).toBe(true);
		tui.stop();
		expect(terminal.writes.some((write) => write.includes("\x1b[?1049l"))).toBe(true);
	});
	test("uses fullscreen for an interactive TTY session", () => {
		const previousCi = process.env.CI;
		const previousTerm = process.env.TERM;
		delete process.env.CI;
		process.env.TERM = "xterm-256color";
		try {
			withTtyState(true, true, () => {
				expect(createGuardedTui().mode).toBe("fullscreen");
			});
		} finally {
			if (previousCi === undefined) delete process.env.CI;
			else process.env.CI = previousCi;
			if (previousTerm === undefined) delete process.env.TERM;
			else process.env.TERM = previousTerm;
		}
	});
	test("uses the main-screen fallback when stdout is not a TTY", () => {
		withTtyState(true, false, () => {
			expect(createGuardedTui()).toBeInstanceOf(TuiMainScreen);
		});
	});
	test("uses the main-screen fallback for TERM=dumb", () => {
		const previousTerm = process.env.TERM;
		process.env.TERM = "dumb";
		try {
			expect(
				createInteractiveTui({
					showHardwareCursor: false,
					logDirectory: "/tmp",
					terminal: new RecordingTerminal(),
				}),
			).toBeInstanceOf(TuiMainScreen);
		} finally {
			if (previousTerm === undefined) delete process.env.TERM;
			else process.env.TERM = previousTerm;
		}
	});
	test("uses the main-screen fallback in CI even when stdio has TTYs", () => {
		const previousCi = process.env.CI;
		const previousTerm = process.env.TERM;
		process.env.CI = "true";
		process.env.TERM = "xterm-256color";
		try {
			withTtyState(true, true, () => {
				expect(createGuardedTui()).toBeInstanceOf(TuiMainScreen);
			});
		} finally {
			if (previousCi === undefined) delete process.env.CI;
			else process.env.CI = previousCi;
			if (previousTerm === undefined) delete process.env.TERM;
			else process.env.TERM = previousTerm;
		}
	});
	test("treats any nonempty unconventional CI value as CI (Greptile P1: CI=github-actions)", () => {
		const previousCi = process.env.CI;
		const previousTerm = process.env.TERM;
		process.env.CI = "github-actions";
		process.env.TERM = "xterm-256color";
		try {
			withTtyState(true, true, () => {
				expect(createGuardedTui()).toBeInstanceOf(TuiMainScreen);
			});
		} finally {
			if (previousCi === undefined) delete process.env.CI;
			else process.env.CI = previousCi;
			if (previousTerm === undefined) delete process.env.TERM;
			else process.env.TERM = previousTerm;
		}
	});
	test("honors explicit CI opt-outs (CI=false, CI=0) on a real TTY", () => {
		const previousCi = process.env.CI;
		const previousTerm = process.env.TERM;
		process.env.TERM = "xterm-256color";
		try {
			for (const optOut of ["false", "0", ""]) {
				process.env.CI = optOut;
				withTtyState(true, true, () => {
					expect(createGuardedTui()).not.toBeInstanceOf(TuiMainScreen);
				});
			}
		} finally {
			if (previousCi === undefined) delete process.env.CI;
			else process.env.CI = previousCi;
			if (previousTerm === undefined) delete process.env.TERM;
			else process.env.TERM = previousTerm;
		}
	});
	test("pins pi-tui's private mouse-sequence predicate used by fullscreen routing", () => {
		const tui = createInteractiveTui({
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal: new RecordingTerminal(),
		});
		const piTuiPrototype = Object.getPrototypeOf(Object.getPrototypeOf(tui));
		expect(typeof Reflect.get(piTuiPrototype, "isMouseSequence")).toBe("function");
	});
	test("falls back to keyboard routing if pi-tui removes its mouse predicate", () => {
		const terminal = new RecordingTerminal();
		const tui = createInteractiveTui({
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
			shouldHandleViewportInput: () => true,
		}) as TuiAltScreen;
		Object.defineProperty(tui, "isMouseSequence", { value: undefined });
		const transcript = new ScrollView(
			new Text(Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
			{ follow: "end", primary: true },
		);
		tui.setLayoutRoot(transcript);

		tui.start();
		try {
			tui.renderNow();
			const initialScrollTop = transcript.scrollTop;
			expect(() => terminal.input("\x1b[<64;1;1M")).not.toThrow();
			expect(transcript.scrollTop).toBe(initialScrollTop - 1);
		} finally {
			tui.stop();
		}
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

	test("stops the forced fullscreen renderer without a regular-mode replacement", () => {
		const terminal = new RecordingTerminal();
		const renderer = createInteractiveTui({
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
		});
		const context = Object.assign(Object.create(InteractiveMode.prototype), {
			renderer,
			ui: renderer,
		}) as unknown as InteractiveMode;

		renderer.start();
		context.stopInteractiveTui();

		expect(renderer.mode).toBe("fullscreen");
		expect([terminal.startCount, terminal.stopCount]).toEqual([1, 1]);
		expect(terminal.cursorVisible).toBe(true);
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
	test.sequential("clips a real fetch_content Kitty image at the sticky dock and reuses its upload", async () => {
		setCellDimensions({ widthPx: 9, heightPx: 18 });
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		expect(getCapabilities().images).toBe("kitty");
		const { context, terminal, tui, initPromise, resolveTheme, restoreOffline } = createProductionFullscreenContext({
			columns: 80,
			rows: 24,
			transcriptLines: 0,
		});
		const imageBytes = createPng(360, 720);
		const imageData = imageBytes.toString("base64");

		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			tui.renderNow();
			const fetchContent = registerFetchContentTool();
			const content: Pick<AgentToolResult<never>, "content">["content"] = [
				{ type: "image", data: imageData, mimeType: "image/png" },
				{ type: "text", text: "Frame at 0:01" },
			];
			const component = new ToolExecutionComponent(
				"fetch_content",
				"tool-frame-1",
				{ url: "file:///clip.mp4", timestamp: "0:01" },
				{ showImages: true, imageWidthCells: 60 },
				fetchContent,
				tui,
				process.cwd(),
			);
			component.updateResult(
				{
					content,
					details: {
						urls: ["file:///clip.mp4"],
						urlCount: 1,
						successful: 1,
						totalChars: 14,
						title: "Clip frame",
						hasImage: true,
						imageCount: 1,
					},
					isError: false,
				},
				false,
			);

			const rawImageLine = component.render(terminal.columns).find((line) => line.includes("\x1b_G"));
			expect(rawImageLine).toBeDefined();
			if (!rawImageLine) return;
			const rawRows = Number(/(?:^|,)r=(\d+)(?:,|;)/.exec(rawImageLine)?.[1]);
			expect(rawRows).toBeGreaterThan(0);

			const transcript = context.transcriptScrollView;
			if (!transcript) throw new Error("production transcript did not mount");
			context.documentContainer.addChild(component);
			transcript.scrollTo(0);
			const firstWriteStart = terminal.writes.length;
			tui.renderNow();
			const firstWrite = terminal.writes.slice(firstWriteStart).join("");
			const firstFrameWrites = terminal.writes.join("");
			const frame = getLayoutFrame(tui);
			const transcriptBox = frame.root.children[0];
			const dockBox = frame.root.children[1];
			if (!transcriptBox || !dockBox) throw new Error("fullscreen dock did not render");
			expect(dockBox.rect.y).toBe(terminal.rows - dockBox.rect.height);
			expect(rawRows).toBeGreaterThan(transcriptBox.rect.height);
			expect(firstWrite).toContain("f=100");
			expect(firstWrite).toContain(imageData);
			expect(firstFrameWrites).toContain("\x1b_Ga=d,d=A,q=2\x1b\\");
			expect(firstFrameWrites).toContain("\x1b[2J");
			const croppedImageLine = frame.lines.find((line) => line.includes("\x1b_G"));
			expect(croppedImageLine).toBeDefined();
			if (!croppedImageLine) return;
			const croppedRows = Number(/(?:^|,)r=(\d+)(?:,|;)/.exec(croppedImageLine)?.[1]);
			expect(croppedRows).toBe(transcriptBox.rect.height);
			expect(croppedRows).toBeLessThan(rawRows);
			expect(frame.lines.slice(dockBox.rect.y).some((line) => line.includes("\x1b_G"))).toBe(false);

			const imageComponentsBefore = Reflect.get(component, "imageComponents") as Image[];
			expect(imageComponentsBefore).toHaveLength(1);
			const imageComponent = imageComponentsBefore[0];
			if (!imageComponent) throw new Error("Kitty image component did not mount");
			const imageId = imageComponent.getImageId();
			expect(imageId).toBeDefined();

			const isolatedReseedWriteStart = terminal.writes.length;
			component.updateArgs({ url: "file:///clip.mp4", timestamp: "0:01" });
			component.updateResult({ content: [...content], isError: false }, false);
			component.setExpanded(false);
			component.setShowImages(true);
			component.setImageWidthCells(60);
			tui.renderNow();
			const isolatedReseedWrite = terminal.writes.slice(isolatedReseedWriteStart).join("");
			const imageComponentsAfter = Reflect.get(component, "imageComponents") as Image[];
			expect(imageComponentsAfter[0]).toBe(imageComponent);
			expect(imageComponent.getImageId()).toBe(imageId);
			expect(isolatedReseedWrite).not.toContain(imageData);

			const secondWriteStart = terminal.writes.length;
			terminal.resize(terminal.columns, terminal.rows - 2);
			tui.renderNow();
			const secondWrite = terminal.writes.slice(secondWriteStart).join("");
			expect(secondWrite).toContain("\x1b_Ga=p,q=2");
			expect(secondWrite).toContain("\x1b_Ga=d,d=a,q=2\x1b\\");
			expect(secondWrite).not.toContain("\x1b_Ga=d,d=A,q=2\x1b\\");
			expect(secondWrite).not.toContain(imageData);
		} finally {
			resolveTheme();
			await initPromise;
			tui.stop();
			restoreOffline();
			resetCapabilitiesCache();
		}
	});
});

interface CopyCommandContext {
	session: { getLastAssistantText(): string | undefined };
	ui: ReturnType<typeof createInteractiveTui>;
	showStatus(message: string): void;
	showError(message: string): void;
}

type CopyCommandPrototype = Pick<InteractiveMode, "handleCopyCommand">;

const copyCommandPrototype: CopyCommandPrototype = InteractiveMode.prototype;

describe("InteractiveMode copy confirmation", () => {
	beforeEach(() => {
		clipboardMocks.copyToClipboard.mockReset();
		clipboardMocks.copyToClipboard.mockResolvedValue(undefined);
	});

	test("flashes the copy shortcut confirmation in fullscreen mode", async () => {
		const ui = createInteractiveTui({
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal: new RecordingTerminal(),
		});
		const flash = vi.spyOn(ui as TuiAltScreen, "flash");
		const context: CopyCommandContext = {
			session: { getLastAssistantText: () => "assistant response" },
			ui,
			showStatus: vi.fn(),
			showError: vi.fn(),
		};

		await copyCommandPrototype.handleCopyCommand.call(context, { flashConfirmation: true });

		expect(clipboardMocks.copyToClipboard).toHaveBeenCalledWith("assistant response");
		expect(flash).toHaveBeenCalledWith("Copied!");
		expect(context.showStatus).not.toHaveBeenCalled();
		expect(context.showError).not.toHaveBeenCalled();
	});

	test("keeps slash-command copy confirmation in the status line", async () => {
		const context: CopyCommandContext = {
			session: { getLastAssistantText: () => "assistant response" },
			ui: createInteractiveTui({
				showHardwareCursor: false,
				logDirectory: "/tmp",
				terminal: new RecordingTerminal(),
			}),
			showStatus: vi.fn(),
			showError: vi.fn(),
		};

		await copyCommandPrototype.handleCopyCommand.call(context);

		expect(context.showStatus).toHaveBeenCalledWith("Copied last agent message to clipboard");
		expect(context.showError).not.toHaveBeenCalled();
	});
});
