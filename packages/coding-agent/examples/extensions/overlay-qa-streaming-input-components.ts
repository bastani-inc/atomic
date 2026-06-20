import type { Theme } from "@bastani/atomic";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { Input, matchesKey } from "@earendil-works/pi-tui";
import { BaseOverlay, sleep } from "./overlay-qa-shared.js";

export class StreamingInputController extends BaseOverlay {
	private tui: TUI;
	private panels: StreamingInputPanel[] = [];
	private handles: OverlayHandle[] = [];
	private focusIndex = -1; // -1 = controller focused, 0-2 = panel focused
	private streamLines: string[] = [];
	private streamInterval: ReturnType<typeof setInterval> | null = null;
	private lineCount = 0;
	private done: () => void;

	constructor(tui: TUI, theme: Theme, done: () => void) {
		super(theme);
		this.tui = tui;
		this.done = done;

		// Create 3 input panels as non-capturing overlays
		const colors = ["error", "success", "accent"] as const;
		const labels = ["Panel A", "Panel B", "Panel C"];

		for (let i = 0; i < 3; i++) {
			const panel = new StreamingInputPanel(
				theme,
				labels[i]!,
				colors[i]!,
				() => this.cycleFocus(),
				() => this.close(),
			);
			const handle = this.tui.showOverlay(panel, {
				nonCapturing: true,
				row: 1 + i * 9,
				col: 2,
				width: 35,
			});
			panel.handle = handle;
			this.panels.push(panel);
			this.handles.push(handle);
		}

		// Start with controller focused (focusIndex = -1)

		// Start simulated streaming
		this.streamInterval = setInterval(() => {
			this.lineCount++;
			const timestamp = new Date().toLocaleTimeString();
			this.streamLines.push(`[${timestamp}] Streaming line ${this.lineCount}...`);
			if (this.streamLines.length > 8) {
				this.streamLines.shift();
			}
			this.tui.requestRender();
		}, 500);
	}

	private cycleFocus(): void {
		// Unfocus current panel if any
		if (this.focusIndex >= 0 && this.focusIndex < this.handles.length) {
			this.handles[this.focusIndex]!.unfocus();
		}

		// Cycle: -1 (controller) → 0 → 1 → 2 → -1 ...
		this.focusIndex++;
		if (this.focusIndex >= this.handles.length) {
			this.focusIndex = -1; // Back to controller
		}

		// Focus new panel if any
		if (this.focusIndex >= 0) {
			this.handles[this.focusIndex]!.focus();
		}

		this.tui.requestRender();
	}

	private close(): void {
		if (this.streamInterval) {
			clearInterval(this.streamInterval);
			this.streamInterval = null;
		}
		for (const handle of this.handles) handle.hide();
		this.handles = [];
		this.panels = [];
		this.done();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.close();
		} else if (matchesKey(data, "tab")) {
			this.cycleFocus();
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const focusedLabel =
			this.focusIndex === -1
				? th.fg("success", "Controller (this panel)")
				: (this.panels[this.focusIndex]?.label ?? "?");

		const lines = [
			"",
			` Current focus: ${th.fg("accent", focusedLabel)}`,
			"",
			" Simulated streaming output:",
			th.fg("dim", " ─".repeat((width - 2) / 2)),
		];

		for (const line of this.streamLines) {
			lines.push(` ${th.fg("dim", line)}`);
		}

		while (lines.length < 12) {
			lines.push("");
		}

		lines.push(th.fg("dim", " ─".repeat((width - 2) / 2)));
		lines.push("");
		lines.push(` Three ${th.fg("accent", "nonCapturing")} input panels on the left.`);
		lines.push(" Tab cycles: Controller → Panel A → B → C → Controller");
		lines.push(" Type in each panel to test input routing.");
		lines.push("");
		lines.push(th.fg("dim", " Tab = cycle focus | Esc = close all"));
		lines.push("");

		return this.box(lines, width, "Streaming + Input Test");
	}

	override dispose(): void {
		this.close();
	}
}

export class StreamingInputPanel implements Component {
	handle: OverlayHandle | null = null;
	private theme: Theme;
	private typed = "";
	readonly label: string;
	private color: "error" | "success" | "accent";
	private onTab: () => void;
	private onClose: () => void;

	constructor(
		theme: Theme,
		label: string,
		color: "error" | "success" | "accent",
		onTab: () => void,
		onClose: () => void,
	) {
		this.theme = theme;
		this.label = label;
		this.color = color;
		this.onTab = onTab;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "tab")) {
			this.onTab();
		} else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		} else if (matchesKey(data, "backspace")) {
			this.typed = this.typed.slice(0, -1);
		} else if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.typed += data;
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const focused = this.handle?.isFocused() ?? false;
		const innerW = Math.max(1, width - 2);
		const border = (c: string) => th.fg(this.color, c);
		const padLine = (s: string) => {
			const w = visibleWidth(s);
			return s + " ".repeat(Math.max(0, innerW - w));
		};

		const inputDisplay = this.typed.length > 0 ? this.typed : th.fg("dim", "(type here)");
		const truncatedInput = truncateToWidth(` > ${inputDisplay}`, innerW, "...", true);

		const lines: string[] = [];
		lines.push(border(`╭${"─".repeat(innerW)}╮`));
		lines.push(border("│") + padLine(` ${th.fg("accent", this.label)}`) + border("│"));
		lines.push(border("│") + padLine("") + border("│"));
		if (focused) {
			lines.push(border("│") + padLine(th.fg("success", " ● FOCUSED")) + border("│"));
			lines.push(border("│") + padLine(th.fg("dim", " (receiving input)")) + border("│"));
		} else {
			lines.push(border("│") + padLine(th.fg("dim", " ○ unfocused")) + border("│"));
			lines.push(border("│") + padLine("") + border("│"));
		}
		lines.push(border("│") + padLine(truncatedInput) + border("│"));
		lines.push(border("│") + padLine("") + border("│"));
		lines.push(border("│") + padLine(th.fg("dim", " Tab | Esc")) + border("│"));
		lines.push(border(`╰${"─".repeat(innerW)}╯`));

		return lines;
	}

	invalidate(): void {}
}
