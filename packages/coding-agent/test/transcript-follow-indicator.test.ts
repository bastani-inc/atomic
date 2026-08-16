import { stripTerminalSequences, type TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import {
	TRANSCRIPT_JUMP_TO_END_URL,
	TranscriptFollowIndicator,
} from "../src/modes/interactive/components/transcript-follow-indicator.ts";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.ts";
import "../src/modes/interactive/interactive-transcript-follow.ts";
import {
	createInteractiveTui,
	handleFocusedOverlayInternalUiAction,
	handleUrlActivation,
} from "../src/modes/interactive/interactive-tui.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { openBrowser } from "../src/utils/open-browser.ts";
import { RecordingTerminal } from "./helpers/interactive-fullscreen-layout.ts";

vi.mock("../src/utils/open-browser.ts", () => ({ openBrowser: vi.fn() }));

beforeAll(() => initTheme("dark"));
const OSC8_MARKER = "\x1b]8;;";
const BG_MARKER = "\x1b[48;";
describe("TranscriptFollowIndicator", () => {
	test("is hidden while the transcript follows its end", () => {
		const indicator = new TranscriptFollowIndicator({ isFollowing: () => true, keyLabel: () => "End" });

		expect(indicator.render(80)).toEqual([]);
	});

	test("renders a centered linked highlight row with the live key label", () => {
		const indicator = new TranscriptFollowIndicator({ isFollowing: () => false, keyLabel: () => "Ctrl+End" });
		const highlight = " Jump to bottom (Ctrl+End) ↓ ";
		const highlightWidth = visibleWidth(highlight);
		for (const width of [80, 41]) {
			const rows = indicator.render(width);
			expect(rows).toHaveLength(1);
			const centered = " ".repeat(Math.floor((width - highlightWidth) / 2)) + highlight;
			expect(stripTerminalSequences(rows[0]!)).toBe(centered);
			expect(visibleWidth(rows[0]!)).toBeLessThanOrEqual(width);
		}

		const rows = indicator.render(80);
		expect(rows[0]).toContain(OSC8_MARKER);
		expect(rows[0]).toContain(TRANSCRIPT_JUMP_TO_END_URL);
		expect(rows[0]).toContain("Ctrl+End");
		expect(rows[0]).not.toContain("┌");
		expect(rows[0]).toContain(BG_MARKER);
	});

	test("truncates the row to a narrow viewport and omits an empty key suffix", () => {
		const indicator = new TranscriptFollowIndicator({ isFollowing: () => false, keyLabel: () => "" });
		const rows = indicator.render(8);
		expect(rows).toHaveLength(1);
		expect(visibleWidth(rows[0]!)).toBeLessThanOrEqual(8);
		expect(stripTerminalSequences(rows[0]!)).toContain("J");
		expect(rows[0]).not.toContain("()");

		for (const width of [0, 1, 2, 3, 4]) {
			const narrowRows = indicator.render(width);
			expect(narrowRows).toHaveLength(1);
			expect(visibleWidth(narrowRows[0]!)).toBeLessThanOrEqual(width);
		}
	});

	test("keeps the highlight unbroken across the truncation ellipsis", () => {
		const indicator = new TranscriptFollowIndicator({ isFollowing: () => false, keyLabel: () => "End" });
		const row = indicator.render(20)[0] ?? "";

		expect(row).toContain("...");
		for (const segment of row.split("\x1b[0m").slice(1)) {
			expect(segment.startsWith(BG_MARKER)).toBe(true);
		}
	});
});

describe("handleUrlActivation", () => {
	test("routes the transcript jump URL internally without opening a browser", () => {
		const onInternalUiAction = vi.fn();
		const openUrl = vi.fn();

		handleUrlActivation(TRANSCRIPT_JUMP_TO_END_URL, { onInternalUiAction, openUrl });

		expect(onInternalUiAction).toHaveBeenCalledExactlyOnceWith(TRANSCRIPT_JUMP_TO_END_URL);
		expect(openUrl).not.toHaveBeenCalled();
	});

	test("lets a focused overlay claim the jump before the host transcript", () => {
		const onInternalUiAction = vi.fn();
		const overlayInput = vi.fn(() => true);
		let tui: TuiAltScreen;
		tui = createInteractiveTui({
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal: new RecordingTerminal(),
			onInternalUiAction,
			onOverlayInternalUiAction: (url) => handleFocusedOverlayInternalUiAction(tui, url),
		}) as TuiAltScreen;
		const overlay = tui.showOverlay({
			render: () => [],
			invalidate: () => {},
			handleInput: overlayInput,
			handlesInternalUiAction: true,
		});
		const openUrl = Reflect.get(tui, "openUrl");
		if (typeof openUrl !== "function") throw new Error("fullscreen TUI did not expose its URL handler");

		openUrl(TRANSCRIPT_JUMP_TO_END_URL);

		expect(overlayInput).toHaveBeenCalledExactlyOnceWith(TRANSCRIPT_JUMP_TO_END_URL);
		expect(onInternalUiAction).not.toHaveBeenCalled();
		overlay.hide();
		tui.stop();
	});

	test("falls back to the host transcript when an overlay declines the jump", () => {
		const onInternalUiAction = vi.fn();
		const overlayInput = vi.fn(() => false);
		let tui: TuiAltScreen;
		tui = createInteractiveTui({
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal: new RecordingTerminal(),
			onInternalUiAction,
			onOverlayInternalUiAction: (url) => handleFocusedOverlayInternalUiAction(tui, url),
		}) as TuiAltScreen;
		const overlay = tui.showOverlay({
			render: () => [],
			invalidate: () => {},
			handleInput: overlayInput,
			handlesInternalUiAction: true,
		});
		const openUrl = Reflect.get(tui, "openUrl");
		if (typeof openUrl !== "function") throw new Error("fullscreen TUI did not expose its URL handler");

		openUrl(TRANSCRIPT_JUMP_TO_END_URL);

		expect(overlayInput).toHaveBeenCalledExactlyOnceWith(TRANSCRIPT_JUMP_TO_END_URL);
		expect(onInternalUiAction).toHaveBeenCalledExactlyOnceWith(TRANSCRIPT_JUMP_TO_END_URL);
		overlay.hide();
		tui.stop();
	});

	test("does not offer the jump to an overlay that did not opt in", () => {
		const onInternalUiAction = vi.fn();
		const overlayInput = vi.fn(() => true);
		let tui: TuiAltScreen;
		tui = createInteractiveTui({
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal: new RecordingTerminal(),
			onInternalUiAction,
			onOverlayInternalUiAction: (url) => handleFocusedOverlayInternalUiAction(tui, url),
		}) as TuiAltScreen;
		const overlay = tui.showOverlay({ render: () => [], invalidate: () => {}, handleInput: overlayInput });
		const openUrl = Reflect.get(tui, "openUrl");
		if (typeof openUrl !== "function") throw new Error("fullscreen TUI did not expose its URL handler");

		openUrl(TRANSCRIPT_JUMP_TO_END_URL);

		expect(overlayInput).not.toHaveBeenCalled();
		expect(onInternalUiAction).toHaveBeenCalledExactlyOnceWith(TRANSCRIPT_JUMP_TO_END_URL);
		overlay.hide();
		tui.stop();
	});

	test("waits for an asynchronous overlay claim before using the host fallback", async () => {
		const onInternalUiAction = vi.fn();
		let resolveClaim!: (handled: boolean) => void;
		const claim = new Promise<boolean>((resolve) => {
			resolveClaim = resolve;
		});
		handleUrlActivation(TRANSCRIPT_JUMP_TO_END_URL, {
			onOverlayInternalUiAction: () => claim,
			onInternalUiAction,
			openUrl: vi.fn(),
		});
		expect(onInternalUiAction).not.toHaveBeenCalled();

		resolveClaim(true);
		await claim;
		await Promise.resolve();
		expect(onInternalUiAction).not.toHaveBeenCalled();
	});

	test("opens non-internal URLs in the browser", () => {
		const onInternalUiAction = vi.fn();
		const openUrl = vi.fn();

		handleUrlActivation("https://example.com", { onInternalUiAction, openUrl });

		expect(openUrl).toHaveBeenCalledExactlyOnceWith("https://example.com");
		expect(onInternalUiAction).not.toHaveBeenCalled();
	});

	test("drops unknown atomic-ui URLs", () => {
		const onInternalUiAction = vi.fn();
		const openUrl = vi.fn();

		handleUrlActivation("atomic-ui://transcript/unknown", { onInternalUiAction, openUrl });

		expect(onInternalUiAction).not.toHaveBeenCalled();
		expect(openUrl).not.toHaveBeenCalled();
	});

	test("normalizes a case-insensitive internal scheme before forwarding it", () => {
		const onInternalUiAction = vi.fn();
		const openUrl = vi.fn();

		handleUrlActivation("ATOMIC-UI://transcript/jump-to-end", { onInternalUiAction, openUrl });

		expect(onInternalUiAction).toHaveBeenCalledExactlyOnceWith(TRANSCRIPT_JUMP_TO_END_URL);
		expect(openUrl).not.toHaveBeenCalled();
	});

	test("offers a mixed-case activation to an overlay as the canonical URL", () => {
		const onInternalUiAction = vi.fn();
		const overlayInput = vi.fn(() => true);
		let tui: TuiAltScreen;
		tui = createInteractiveTui({
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal: new RecordingTerminal(),
			onInternalUiAction,
			onOverlayInternalUiAction: (url) => handleFocusedOverlayInternalUiAction(tui, url),
		}) as TuiAltScreen;
		const overlay = tui.showOverlay({
			render: () => [],
			invalidate: () => {},
			handleInput: overlayInput,
			handlesInternalUiAction: true,
		});
		const openUrl = Reflect.get(tui, "openUrl");
		if (typeof openUrl !== "function") throw new Error("fullscreen TUI did not expose its URL handler");

		openUrl("ATOMIC-UI://transcript/jump-to-end");

		expect(overlayInput).toHaveBeenCalledExactlyOnceWith(TRANSCRIPT_JUMP_TO_END_URL);
		expect(onInternalUiAction).not.toHaveBeenCalled();
		overlay.hide();
		tui.stop();
	});
	test.each(["atomic-ui://[", "atomic-ui://a[b", "atomic-ui://tra nscript/jump-to-end", "ATOMIC-UI://tra nscript/x"])(
		"drops malformed internal URLs without invoking either handler: %s",
		(url) => {
			const onInternalUiAction = vi.fn();
			const openUrl = vi.fn();

			handleUrlActivation(url, { onInternalUiAction, openUrl });

			expect(onInternalUiAction).not.toHaveBeenCalled();
			expect(openUrl).not.toHaveBeenCalled();
		},
	);

	test("preserves browser routing for unparseable non-internal URLs", () => {
		const onInternalUiAction = vi.fn();
		const openUrl = vi.fn();

		handleUrlActivation("not a url", { onInternalUiAction, openUrl });

		expect(openUrl).toHaveBeenCalledExactlyOnceWith("not a url");
		expect(onInternalUiAction).not.toHaveBeenCalled();
	});

	test("wires fullscreen URL activation to the browser and internal action callback", () => {
		const onInternalUiAction = vi.fn();
		const tui = createInteractiveTui({
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal: new RecordingTerminal(),
			onInternalUiAction,
		});
		const openUrl = Reflect.get(tui, "openUrl");
		if (typeof openUrl !== "function") throw new Error("fullscreen TUI did not expose its URL handler");

		const browser = vi.mocked(openBrowser);
		browser.mockClear();
		openUrl("https://example.com");
		expect(browser).toHaveBeenCalledExactlyOnceWith("https://example.com");

		openUrl(TRANSCRIPT_JUMP_TO_END_URL);
		expect(onInternalUiAction).toHaveBeenCalledExactlyOnceWith(TRANSCRIPT_JUMP_TO_END_URL);
		expect(browser).toHaveBeenCalledExactlyOnceWith("https://example.com");
	});
});

describe("jumpToTranscriptEnd", () => {
	test("is safe without a transcript viewport and remains idempotent", () => {
		const requestRender = vi.fn();
		const context = {
			transcriptScrollView: undefined,
			ui: { requestRender },
		};

		expect(() => InteractiveModeBase.prototype.jumpToTranscriptEnd.call(context as never)).not.toThrow();
		const scrollToEnd = vi.fn();
		context.transcriptScrollView = { scrollToEnd } as never;

		InteractiveModeBase.prototype.jumpToTranscriptEnd.call(context as never);
		InteractiveModeBase.prototype.jumpToTranscriptEnd.call(context as never);

		expect(scrollToEnd).toHaveBeenCalledTimes(2);
		expect(requestRender).toHaveBeenCalledTimes(3);
	});
});
