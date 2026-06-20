import type { Theme } from "@bastani/atomic";
import type { Component, OverlayHandle, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import { Input, matchesKey } from "@earendil-works/pi-tui";
import { BaseOverlay, sleep } from "./overlay-qa-shared.js";


export type ToggleHandleAccessor = () => OverlayHandle | null;

export class ToggleDemoComponent extends BaseOverlay {
	private readonly getToggleHandle: ToggleHandleAccessor;
	private tui: TUI;
	private toggleCount = 0;
	private isToggling = false;
	private done: () => void;

	constructor(tui: TUI, theme: Theme, done: () => void, getToggleHandle: ToggleHandleAccessor) {
		super(theme);
		this.tui = tui;
		this.done = done;
		this.getToggleHandle = getToggleHandle;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done();
			return;
		}
		const handle = this.getToggleHandle();
		if (matchesKey(data, "t") && handle && !this.isToggling) {
			// Demonstrate toggle by hiding for 1 second then showing again
			// (In real usage, a global keybinding would control visibility)
			this.isToggling = true;
			this.toggleCount++;
			handle.setHidden(true);

			// Auto-restore after 1 second to demonstrate the API
			setTimeout(() => {
				const current = this.getToggleHandle();
				if (current) {
					current.setHidden(false);
					this.isToggling = false;
					this.tui.requestRender();
				}
			}, 1000);
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		return this.box(
			[
				"",
				th.fg("accent", " Toggle Demo"),
				"",
				" This overlay demonstrates the",
				" onHandle callback API.",
				"",
				` Toggle count: ${th.fg("accent", String(this.toggleCount))}`,
				"",
				th.fg("dim", " Press 't' to hide for 1 second"),
				th.fg("dim", " (demonstrates setHidden API)"),
				"",
				th.fg("dim", " In real usage, a global keybinding"),
				th.fg("dim", " would toggle visibility externally."),
				"",
				th.fg("dim", " Press Esc to close"),
				"",
			],
			width,
			"Toggle Demo",
		);
	}
}

// === Non-capturing passive overlay demo ===

export class PassiveDemoController extends BaseOverlay {
	focused = false;
	private tui: TUI;
	private typed = "";
	private timerComponent: TimerPanel;
	private timerHandle: OverlayHandle | null = null;
	private interval: ReturnType<typeof setInterval> | null = null;
	private inputCount = 0;
	private lastInputDebug = "";
	private done: () => void;

	constructor(tui: TUI, theme: Theme, done: () => void) {
		super(theme);
		this.tui = tui;
		this.done = done;
		this.timerComponent = new TimerPanel(theme);
		this.timerHandle = this.tui.showOverlay(this.timerComponent, {
			nonCapturing: true,
			anchor: "top-right",
			width: 22,
			margin: { top: 1, right: 2 },
		});
		this.interval = setInterval(() => {
			this.timerComponent.tick();
			this.tui.requestRender();
		}, 1000);
	}

	handleInput(data: string): void {
		this.inputCount++;
		this.lastInputDebug = `len=${data.length} c0=${data.charCodeAt(0)}`;
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.cleanup();
			this.done();
		} else if (matchesKey(data, "backspace")) {
			this.typed = this.typed.slice(0, -1);
		} else if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.typed += data;
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const display = this.typed.length > 0 ? this.typed : th.fg("dim", "(type here)");
		return this.box(
			[
				"",
				` ${th.fg("dim", `focused=${this.focused} inputs=${this.inputCount}`)}`,
				` ${th.fg("dim", `last: ${this.lastInputDebug || "none"}`)}`,
				"",
				` > ${display}`,
				"",
				th.fg("dim", " Type to prove input goes here."),
				th.fg("dim", " Press Esc to close both."),
				"",
			],
			width,
			"Non-Capturing Demo",
		);
	}

	private cleanup(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
		this.timerHandle?.hide();
		this.timerHandle = null;
	}

	override dispose(): void {
		this.cleanup();
	}
}

export class TimerPanel extends BaseOverlay {
	private seconds = 0;

	tick(): void {
		this.seconds++;
	}

	render(width: number): string[] {
		const th = this.theme;
		const mins = Math.floor(this.seconds / 60);
		const secs = this.seconds % 60;
		const time = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
		return this.box([` ${th.fg("accent", time)}`, th.fg("dim", " nonCapturing: true")], width, "Timer");
	}
}

// === Focus cycling demo ===

