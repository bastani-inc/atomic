import assert from "node:assert/strict";
import { crc32, deflateSync } from "node:zlib";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	Container,
	getCapabilities,
	getKeybindings,
	type Image,
	isViewportTUI,
	resetCapabilitiesCache,
	ScrollView,
	setCapabilities,
	setCellDimensions,
	setKeybindings,
	Text,
	type TUI,
	type TuiAltScreen,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { registerContentTools } from "../../web-access/content-tools.ts";
import type { ExtensionAPI } from "../src/core/extensions/api-types.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { AtomicWorkingLoader } from "../src/modes/interactive/components/atomic-working-status.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import {
	createInteractiveTui,
	createInteractiveTuiReference,
	InteractiveMode,
} from "../src/modes/interactive/interactive-mode.ts";
import { createFullscreenTui } from "../src/modes/interactive/interactive-tui.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
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
		expect(typeof Reflect.get(tui, "openUrl")).toBe("function");
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
	test("keeps the fullscreen dock fixed and offers a clickable jump to latest while scrolled up", async () => {
		const previousKeybindings = getKeybindings();
		setKeybindings(new KeybindingsManager({ "tui.altScreen.bottom": "ctrl+j" }));
		const { context, terminal, tui, initPromise, resolveTheme, restoreOffline } = createProductionFullscreenContext({
			columns: 50,
			rows: 12,
		});

		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			tui.renderNow();

			const transcript = context.transcriptScrollView;
			if (!transcript) throw new Error("production transcript did not mount");
			const getFrame = () => getLayoutFrame(tui);
			const initial = getFrame();
			const initialTranscript = initial.root.children[0];
			const initialDock = initial.root.children[1];
			const dock = context.fullscreenLayoutRoot?.children[1];
			if (!initialTranscript || !dock) throw new Error("fullscreen layout did not render");
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
			const scrolledTranscript = scrolled.root.children[0];
			const scrolledDock = scrolled.root.children[1];
			if (!scrolledTranscript || !scrolledDock) throw new Error("fullscreen layout disappeared after scrolling");
			expect(scrolledDock.rect).toEqual(initialDock.rect);
			const scrolledDockLines = scrolled.lines.slice(
				scrolledDock.rect.y,
				scrolledDock.rect.y + scrolledDock.rect.height,
			);
			expect(scrolledDockLines.some((line) => line.includes("Jump to latest message"))).toBe(false);
			expect(terminal.writes.at(-1)).toContain("↓ Jump to latest message · ctrl+j");
			expect(terminal.writes.at(-1)).toContain(
				`\x1b[${scrolledTranscript.rect.y + scrolledTranscript.rect.height};1H`,
			);

			const indicator = " ↓ Jump to latest message · ctrl+j ";
			const indicatorColumn =
				scrolledTranscript.rect.x + Math.floor((scrolledTranscript.rect.width - indicator.length) / 2);
			const indicatorRow = scrolledTranscript.rect.y + scrolledTranscript.rect.height - 1;
			const handleIndicatorInput = Reflect.get(tui, "handleScrollToEndIndicatorMouseInput") as (
				data: string,
			) => boolean;
			const motion = `\x1b[<32;${indicatorColumn + 1};${indicatorRow + 1}M`;
			expect(handleIndicatorInput.call(tui, motion)).toBe(false);
			terminal.input(motion);
			expect(transcript.isFollowingEnd).toBe(false);

			const outsidePress = `\x1b[<0;1;${indicatorRow + 1}M`;
			terminal.input(outsidePress);
			expect(transcript.isFollowingEnd).toBe(false);

			const overlayInput = vi.fn(() => true);
			const overlay = tui.showOverlay(
				{ render: () => ["overlay"], invalidate: () => {}, handleInput: overlayInput },
				{ anchor: "bottom-center", width: "100%" },
			);
			tui.renderNow();
			const overlayPress = `\x1b[<0;${indicatorColumn + 1};${indicatorRow + 1}M`;
			terminal.input(overlayPress);
			expect(overlayInput).toHaveBeenCalledWith(overlayPress);
			expect(transcript.isFollowingEnd).toBe(false);
			overlay.hide();
			tui.renderNow();

			terminal.input(`\x1b[<0;${indicatorColumn + 1};${indicatorRow + 1}M`);
			tui.renderNow();
			const jumped = getFrame();
			const jumpedDock = jumped.root.children[1];
			if (!jumpedDock) throw new Error("fullscreen dock disappeared after jumping to the transcript end");
			expect(transcript.isFollowingEnd).toBe(true);
			expect(jumpedDock.rect).toEqual(initialDock.rect);
			expect(terminal.writes.at(-1)).not.toContain("Jump to latest message");

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
			setKeybindings(previousKeybindings);
		}
	});
	test("does not composite the jump-to-latest label onto an image row", () => {
		const terminal = new RecordingTerminal();
		terminal.columns = 50;
		terminal.rows = 12;
		const tui = createFullscreenTui({
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
		}) as TuiAltScreen;
		const transcript = new ScrollView(
			new Text(Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
			{ follow: "end", primary: true },
		);
		tui.setLayoutRoot(transcript);
		tui.start();
		try {
			tui.renderNow();
			transcript.scrollTo(0);
			tui.renderNow();
			const frame = getLayoutFrame(tui);
			const row = frame.root.rect.y + frame.root.rect.height - 1;
			const imageLine = "\x1b_Ga=p,i=1,r=1,c=1\x1b\\";
			const lines = [...frame.lines];
			lines[row] = imageLine;
			const composite = Reflect.get(tui, "compositeScrollToEndIndicator") as (
				lines: string[],
				width: number,
				height: number,
			) => string[];

			const plainLines = composite.call(tui, [...frame.lines], terminal.columns, terminal.rows);
			expect(plainLines[row]).toContain("Jump to latest message");

			expect(composite.call(tui, lines, terminal.columns, terminal.rows)[row]).toBe(imageLine);

			const staleLines = [...frame.lines];
			transcript.updateLayout(40, frame.root.rect.height - 1, () => {});
			expect(composite.call(tui, staleLines, terminal.columns, terminal.rows)).toEqual(staleLines);
		} finally {
			tui.stop();
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
	getFullscreenCopyOnSelect(): boolean | undefined;
	copyActiveFullscreenSelection(): Promise<boolean | undefined>;
}

type CopyCommandPrototype = Pick<InteractiveMode, "handleCopyCommand">;

const copyCommandPrototype: CopyCommandPrototype = InteractiveMode.prototype;

describe("pi-tui 0.84.4 fullscreen copy", () => {
	test("retains a disabled automatic selection and copies it programmatically", async () => {
		const copied: string[] = [];
		const terminal = new RecordingTerminal();
		const tui = createFullscreenTui({
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
			copyOnSelect: false,
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		tui.addChild(new Text("alpha\nbeta", 0, 0));
		tui.start();
		tui.renderNow();
		terminal.input("\x1b[<0;1;1M");
		terminal.input("\x1b[<32;4;2M");
		terminal.input("\x1b[<0;4;2m");
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(copied).toEqual([]);
		expect(tui.hasActiveSelection()).toBe(true);
		expect(await tui.copyActiveSelectionToClipboard()).toBe(true);
		expect(copied).toEqual(["alpha\nbeta"]);
		tui.stop();
	});

	test("reports programmatic selection copy failure without claiming success", async () => {
		const terminal = new RecordingTerminal();
		const tui = createFullscreenTui({
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
			copyOnSelect: false,
			copySelection: async () => false,
		});
		tui.addChild(new Text("alpha", 0, 0));
		tui.start();
		tui.renderNow();
		terminal.input("\x1b[<0;1;1M");
		terminal.input("\x1b[<32;4;1M");
		terminal.input("\x1b[<0;4;1m");
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(await tui.copyActiveSelectionToClipboard()).toBe(false);
		tui.stop();
	});
});
describe("InteractiveMode /copy confirmation", () => {
	beforeEach(() => {
		clipboardMocks.copyToClipboard.mockReset();
		clipboardMocks.copyToClipboard.mockResolvedValue(undefined);
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
			getFullscreenCopyOnSelect: () => true,
			copyActiveFullscreenSelection: vi.fn(async () => undefined),
		};
		await copyCommandPrototype.handleCopyCommand.call(context);

		expect(context.showStatus).toHaveBeenCalledWith("Copied last agent message to clipboard");
		expect(clipboardMocks.copyToClipboard).toHaveBeenCalledWith("assistant response");
		expect(context.showError).not.toHaveBeenCalled();
	});

	test("main-editor copy prefers a retained selection only when automatic copy is disabled", async () => {
		const selectionCopy = vi.fn(async () => true);
		const context: CopyCommandContext = {
			session: { getLastAssistantText: () => "assistant response" },
			ui: createInteractiveTui({
				showHardwareCursor: false,
				logDirectory: "/tmp",
				terminal: new RecordingTerminal(),
			}),
			showStatus: vi.fn(),
			showError: vi.fn(),
			getFullscreenCopyOnSelect: () => false,
			copyActiveFullscreenSelection: selectionCopy,
		};

		await copyCommandPrototype.handleCopyCommand.call(context, { preferSelection: true });

		expect(selectionCopy).toHaveBeenCalledOnce();
		expect(clipboardMocks.copyToClipboard).not.toHaveBeenCalled();
	});

	test("enabled copy-on-select and absent selections fall back to the last assistant message", async () => {
		for (const { copyOnSelect, selectionResult } of [
			{ copyOnSelect: true, selectionResult: true },
			{ copyOnSelect: false, selectionResult: undefined },
		]) {
			clipboardMocks.copyToClipboard.mockClear();
			const context: CopyCommandContext = {
				session: { getLastAssistantText: () => "assistant response" },
				ui: createInteractiveTui({
					showHardwareCursor: false,
					logDirectory: "/tmp",
					terminal: new RecordingTerminal(),
				}),
				showStatus: vi.fn(),
				showError: vi.fn(),
				getFullscreenCopyOnSelect: () => copyOnSelect,
				copyActiveFullscreenSelection: vi.fn(async () => selectionResult),
			};
			await copyCommandPrototype.handleCopyCommand.call(context, { preferSelection: true });
			expect(clipboardMocks.copyToClipboard).toHaveBeenCalledWith("assistant response");
		}
	});
});
type WorkingLoaderStopContext = {
	loadingAnimation: { stop(): void } | undefined;
	workingIndicatorEmbedded: boolean;
	setEditorWorkingStatusIndicator(indicator: undefined): boolean;
	statusContainer: Container;
	settingsManager: { getClearOnShrink(): boolean };
};
type WorkingLoaderPrototype = {
	clearWorkingLoader(this: WorkingLoaderStopContext): void;
	handleClearCommand(this: Record<string, unknown>): Promise<void>;
	stopWorkingLoader(this: WorkingLoaderStopContext): void;
	setCustomEditorComponent(this: Record<string, unknown>, factory: ((...args: never[]) => unknown) | undefined): void;
	resetExtensionUI(this: Record<string, unknown>): void;
};

const workingLoaderPrototype = InteractiveMode.prototype as unknown as WorkingLoaderPrototype;

describe("clear-on-shrink working status spacing", () => {
	test("an embedded working indicator does not reserve standalone status height", () => {
		const stop = vi.fn();
		const clearEditorIndicator = vi.fn(() => true);
		const context: WorkingLoaderStopContext = {
			loadingAnimation: { stop },
			workingIndicatorEmbedded: true,
			setEditorWorkingStatusIndicator: clearEditorIndicator,
			statusContainer: new Container(),
			settingsManager: { getClearOnShrink: () => true },
		};

		workingLoaderPrototype.stopWorkingLoader.call(context);

		expect(stop).toHaveBeenCalledOnce();
		expect(clearEditorIndicator).toHaveBeenCalledWith(undefined);
		expect(context.statusContainer.children).toHaveLength(0);
	});

	test("the new-session teardown clears an embedded indicator from the editor border", async () => {
		initTheme("dark");
		const tui = createGuardedTui();
		const editor = new CustomEditor(tui, getEditorTheme(), new KeybindingsManager(), { embedWorkingStatus: true });
		const loader = new AtomicWorkingLoader(tui, undefined, String, "Working");
		editor.setWorkingStatusIndicator(loader);
		assert.match(editor.render(40)[0] ?? "", /∀/);

		const context = {
			ensureDeferredStartupComplete: async () => {},
			loadingAnimation: loader,
			workingIndicatorEmbedded: true,
			setEditorWorkingStatusIndicator: (indicator: AtomicWorkingLoader | undefined) => {
				editor.setWorkingStatusIndicator(indicator);
				return true;
			},
			statusContainer: new Container(),
			runtimeHost: { newSession: async () => ({ cancelled: true }) },
		};

		await workingLoaderPrototype.handleClearCommand.call(context as unknown as Record<string, unknown>);

		assert.doesNotMatch(editor.render(40)[0] ?? "", /∀/);
		assert.equal(context.loadingAnimation, undefined);
	});

	test("a standalone working indicator reserves clear-on-shrink status height", () => {
		const context: WorkingLoaderStopContext = {
			loadingAnimation: { stop: vi.fn() },
			workingIndicatorEmbedded: false,
			setEditorWorkingStatusIndicator: vi.fn(() => false),
			statusContainer: new Container(),
			settingsManager: { getClearOnShrink: () => true },
		};

		workingLoaderPrototype.stopWorkingLoader.call(context);
		expect(context.statusContainer.children).toHaveLength(1);
	});

	test("switching to a non-opting custom editor remounts an active loader as a standalone row", () => {
		const loader = Object.create(AtomicWorkingLoader.prototype) as AtomicWorkingLoader;
		const statusContainer = new Container();
		const setEditorWorkingStatusIndicator = vi.fn(() => false);
		const defaultEditor = {
			onSubmit: undefined,
			onChange: undefined,
			borderColor: String,
			getPaddingX: () => 0,
			getAutocompleteMaxVisible: () => 10,
			actionHandlers: new Map<string, () => void>(),
		};
		const newEditor = {
			setText: vi.fn(),
			render: () => [],
			invalidate: () => {},
		};
		const context = {
			editorComponentFactory: undefined,
			editor: { getText: () => "draft" },
			defaultEditor,
			disposeActiveSelector: vi.fn(),
			editorContainer: new Container(),
			keybindings: {},
			ui: { setFocus: vi.fn(), requestRender: vi.fn() },
			autocompleteProvider: undefined,
			loadingAnimation: loader,
			statusContainer,
			workingIndicatorEmbedded: true,
			setEditorWorkingStatusIndicator,
		};

		workingLoaderPrototype.setCustomEditorComponent.call(
			context as unknown as Record<string, unknown>,
			(() => newEditor) as (...args: never[]) => unknown,
		);

		expect(setEditorWorkingStatusIndicator).toHaveBeenCalledWith(loader);
		expect(context.workingIndicatorEmbedded).toBe(false);
		expect(statusContainer.children).toEqual([loader]);
	});

	test("resetting extension UI uses the default Working interrupt label", () => {
		setKeybindings(KeybindingsManager.create());
		const setMessage = vi.fn();
		const context = {
			extensionSelector: undefined,
			extensionInput: undefined,
			extensionEditor: undefined,
			ui: { hideOverlay: vi.fn() },
			clearExtensionTerminalInputListeners: vi.fn(),
			setExtensionFooter: vi.fn(),
			setExtensionHeader: vi.fn(),
			clearExtensionWidgets: vi.fn(),
			footerDataProvider: { clearExtensionStatuses: vi.fn() },
			footer: { invalidate: vi.fn() },
			autocompleteProviderWrappers: ["stale"],
			setCustomEditorComponent: vi.fn(),
			setupAutocompleteProvider: vi.fn(),
			defaultEditor: { onExtensionShortcut: undefined },
			interactiveEngineShortcutHandler: vi.fn(),
			updateTerminalTitle: vi.fn(),
			defaultWorkingMessage: "Working",
			workingMessage: "custom",
			workingVisible: false,
			setWorkingIndicator: vi.fn(),
			loadingAnimation: { setMessage },
			setHiddenThinkingLabel: vi.fn(),
		};

		workingLoaderPrototype.resetExtensionUI.call(context as unknown as Record<string, unknown>);

		assert.equal(context.workingMessage, undefined);
		assert.equal(context.workingVisible, true);
		assert.deepEqual(setMessage.mock.calls, [["Working (esc Interrupt)"]]);
	});
});
