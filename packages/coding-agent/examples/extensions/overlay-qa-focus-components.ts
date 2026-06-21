import type { Theme } from "@bastani/atomic";
import type { OverlayHandle, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import { Input, matchesKey } from "@earendil-works/pi-tui";
import { BaseOverlay } from "./overlay-qa-shared.js";

export type FocusPanelColor = "error" | "success" | "accent";
export type FocusPanelConfig = { label: string; color: FocusPanelColor; options: OverlayOptions };
export type FocusPanelEntry = { panel: FocusPanel; handle: OverlayHandle };

const FOCUS_PANEL_CONFIGS = [
	{ label: "Alpha", color: "error", options: { row: 2, col: 4, width: 34 } },
	{ label: "Beta", color: "success", options: { row: 5, col: 28, width: 34 } },
	{ label: "Gamma", color: "accent", options: { row: 8, col: 52, width: 34 } },
] satisfies FocusPanelConfig[];

export class FocusDemoController extends BaseOverlay {
	private readonly tui: TUI;
	private entries: FocusPanelEntry[] = [];
	private readonly done: () => void;
	private closed = false;

	constructor(tui: TUI, theme: Theme, done: () => void) {
		super(theme);
		this.tui = tui;
		this.done = done;

		for (const config of FOCUS_PANEL_CONFIGS) {
			const panel = new FocusPanel({ theme, config, controller: this });
			const handle = this.tui.showOverlay(panel, { nonCapturing: true, ...config.options });
			this.entries.push({ panel, handle });
		}

		this.focusFirstOpenPanel();
	}

	focusNext(current: FocusPanel, direction: 1 | -1 = 1): void {
		const openEntries = this.openEntries();
		const currentOpenPosition = openEntries.findIndex((entry) => entry.panel === current);
		if (currentOpenPosition === -1) throw new Error(`Panel ${current.label} is not open`);
		const nextOpenPosition = (currentOpenPosition + direction + openEntries.length) % openEntries.length;
		this.focusEntryAt(openEntries, nextOpenPosition);
	}

	dismiss(panel: FocusPanel): void {
		const openEntries = this.openEntries();
		const currentOpenPosition = openEntries.findIndex((candidate) => candidate.panel === panel);
		if (currentOpenPosition === -1) return;
		const entry = openEntries[currentOpenPosition];
		if (!entry) throw new Error(`Invalid focus panel index ${currentOpenPosition}`);
		const remainingEntries = openEntries.filter((candidate) => candidate.panel !== panel);

		entry.panel.closed = true;
		entry.handle.hide();
		if (remainingEntries.length === 0) {
			this.close();
			return;
		}

		this.focusEntryAt(remainingEntries, currentOpenPosition % remainingEntries.length);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.hidePanels();
		this.done();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.close();
		} else if (matchesKey(data, "tab")) {
			this.focusFirstOpenPanel();
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const focused = this.entries.find((entry) => entry.handle.isFocused())?.panel.label ?? "Controller";
		return this.box(
			[
				"",
				` Current focus: ${th.fg("accent", focused)}`,
				"",
				" Three overlapping panels above are",
				` ${th.fg("accent", "nonCapturing")} overlays controlled with`,
				" raw OverlayHandle.focus()/hide().",
				"",
				" Type in the focused panel's input.",
				" Focused panel renders on top.",
				"",
				th.fg("dim", " Tab/Shift+Tab = cycle panels"),
				th.fg("dim", " Esc/Ctrl+D = dismiss panel"),
				th.fg("dim", " Ctrl+C = close all"),
				"",
			],
			width,
			"Focus + Input Demo",
		);
	}

	override dispose(): void {
		if (this.closed) return;
		this.closed = true;
		this.hidePanels();
	}

	private focusFirstOpenPanel(): void {
		const firstOpen = this.openEntries()[0];
		if (firstOpen) {
			firstOpen.handle.focus();
			this.tui.requestRender();
		}
	}

	private focusEntryAt(entries: FocusPanelEntry[], index: number): void {
		const entry = entries[index];
		if (!entry) throw new Error(`Invalid focus panel index ${index}`);
		entry.handle.focus();
		this.tui.requestRender();
	}

	private hidePanels(): void {
		for (const entry of this.entries) {
			if (!entry.panel.closed) {
				entry.panel.closed = true;
				entry.handle.hide();
			}
		}
		this.entries = [];
	}

	private openEntries(): FocusPanelEntry[] {
		return this.entries.filter((entry) => !entry.panel.closed);
	}
}

export class FocusPanel extends BaseOverlay {
	focused = false;
	closed = false;
	readonly label: string;
	private readonly color: FocusPanelColor;
	private readonly controller: FocusDemoController;
	private readonly input = new Input();
	private inputs: string[] = [];

	constructor({
		theme,
		config,
		controller,
	}: {
		theme: Theme;
		config: FocusPanelConfig;
		controller: FocusDemoController;
	}) {
		super(theme);
		this.label = config.label;
		this.color = config.color;
		this.controller = controller;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "tab")) {
			this.controller.focusNext(this);
		} else if (matchesKey(data, "shift+tab")) {
			this.controller.focusNext(this, -1);
		} else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+d")) {
			this.controller.dismiss(this);
		} else if (matchesKey(data, "ctrl+c")) {
			this.controller.close();
		} else if (matchesKey(data, "return")) {
			this.inputs.push("Enter");
		} else if (matchesKey(data, "up")) {
			this.inputs.push("↑");
		} else if (matchesKey(data, "down")) {
			this.inputs.push("↓");
		} else if (matchesKey(data, "left")) {
			this.input.handleInput(data);
			this.inputs.push("←");
		} else if (matchesKey(data, "right")) {
			this.input.handleInput(data);
			this.inputs.push("→");
		} else if (matchesKey(data, "backspace")) {
			this.input.handleInput(data);
			this.inputs.push("Backspace");
		} else {
			this.input.handleInput(data);
			this.inputs.push(JSON.stringify(data));
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(1, width - 2);
		const border = (c: string) => th.fg(this.focused ? this.color : "dim", c);
		const padLine = (s: string) => truncateToWidth(s, innerW, "...", true);
		const recent = this.inputs.length === 0 ? "(none)" : this.inputs.slice(-6).join(" ");
		const lines: string[] = [];

		this.input.focused = this.focused;
		const [inputLine = ""] = this.input.render(Math.max(1, innerW - 8));
		lines.push(border(`╭${"─".repeat(innerW)}╮`));
		lines.push(
			border("│") +
				padLine(
					` ${th.fg(this.color, this.label)} ${this.focused ? th.fg("success", "FOCUSED") : th.fg("dim", "visible")}`,
				) +
				border("│"),
		);
		lines.push(border("│") + padLine("") + border("│"));
		lines.push(border("│") + padLine(` Input: ${inputLine}`) + border("│"));
		lines.push(border("│") + padLine(` Keys: ${recent}`) + border("│"));
		lines.push(border("│") + padLine(th.fg("dim", " Tab/Shift+Tab focus")) + border("│"));
		lines.push(border("│") + padLine(th.fg("dim", " Esc/Ctrl+D dismiss")) + border("│"));
		lines.push(border(`╰${"─".repeat(innerW)}╯`));

		return lines;
	}
}

// === Streaming input panel test (/overlay-streaming) ===

