import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";

const readClipboardText = vi.hoisted(() => vi.fn());

vi.mock("../src/utils/clipboard.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/clipboard.ts")>();
	return { ...actual, readClipboardText };
});

import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { createInteractiveTui } from "../src/modes/interactive/interactive-tui.ts";
import { RecordingTerminal } from "./helpers/interactive-fullscreen-layout.ts";

type RightClickPasteContext = {
	renderer: { getFocusedComponent: () => Component | undefined };
	ui: { requestRender: () => void };
};

function invokeRightClickPaste(context: RightClickPasteContext): Promise<void> {
	const prototype = InteractiveMode.prototype as unknown as {
		handleRightClickPaste(this: RightClickPasteContext): Promise<void>;
	};
	return prototype.handleRightClickPaste.call(context);
}

describe("fullscreen right-click paste", () => {
	test("passes the clipboard text to the focused component as bracketed paste", async () => {
		readClipboardText.mockResolvedValue("clipboard text");
		const handleInput = vi.fn<(data: string) => void>();
		const target = { render: () => [], invalidate: () => {}, handleInput } satisfies Component;
		const requestRender = vi.fn();
		const context: RightClickPasteContext = {
			renderer: { getFocusedComponent: () => target },
			ui: { requestRender },
		};

		await invokeRightClickPaste(context);

		expect(handleInput).toHaveBeenCalledExactlyOnceWith("\x1b[200~clipboard text\x1b[201~");
		expect(requestRender).toHaveBeenCalledExactlyOnceWith();
	});

	test("does not paste when focus changes while the clipboard is read", async () => {
		let resolveClipboard!: (text: string) => void;
		readClipboardText.mockReturnValue(
			new Promise<string>((resolve) => {
				resolveClipboard = resolve;
			}),
		);
		const handleInput = vi.fn<(data: string) => void>();
		const target = { render: () => [], invalidate: () => {}, handleInput } satisfies Component;
		const replacement = { render: () => [], invalidate: () => {} } satisfies Component;
		let focused: Component = target;
		const context: RightClickPasteContext = {
			renderer: { getFocusedComponent: () => focused },
			ui: { requestRender: vi.fn() },
		};

		const pending = invokeRightClickPaste(context);
		focused = replacement;
		resolveClipboard("clipboard text");
		await pending;

		expect(handleInput).not.toHaveBeenCalled();
		expect(context.ui.requestRender).not.toHaveBeenCalled();
	});

	test("forwards the callback to the forced fullscreen renderer", () => {
		const onRightClickPaste = vi.fn();
		const tui = createInteractiveTui({
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal: new RecordingTerminal(),
			onRightClickPaste,
		});

		expect(tui.mode).toBe("fullscreen");
		expect(Reflect.get(tui, "onRightClickPaste")).toBe(onRightClickPaste);
	});
});
