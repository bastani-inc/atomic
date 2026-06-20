import type { Theme } from "@bastani/atomic";
import type { TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { spawn } from "child_process";
import { BaseOverlay } from "./overlay-qa-shared.js";

export class StreamingOverflowComponent extends BaseOverlay {
	private tui: TUI;
	private lines: string[] = [];
	private proc: ReturnType<typeof spawn> | null = null;
	private scrollOffset = 0;
	private maxVisibleLines = 15;
	private finished = false;
	private disposed = false;
	private done: () => void;

	constructor(tui: TUI, theme: Theme, done: () => void) {
		super(theme);
		this.tui = tui;
		this.done = done;
		this.startProcess();
	}

	private startProcess(): void {
		// Run a command that produces many lines with ANSI colors
		// Using find with -ls produces file listings, or use ls --color
		this.proc = spawn("bash", [
			"-c",
			`
			echo "Starting streaming overflow test (30+ seconds)..."
			echo "This simulates subagent output with colors, hyperlinks, and long paths"
			echo ""
			for i in $(seq 1 100); do
				# Simulate long file paths with OSC 8 hyperlinks (clickable) - tests width overflow
				DIR="/Users/example/Documents/development/atomic/packages/coding-agent/src/modes/interactive"
				FILE="\${DIR}/components/very-long-component-name-that-exceeds-width-\${i}.ts"
				echo -e "\\033]8;;file://\${FILE}\\007▶ read: \${FILE}\\033]8;;\\007"

				# Add some colored status messages with long text
				if [ $((i % 5)) -eq 0 ]; then
					echo -e "  \\033[32m✓ Successfully processed \${i} files in /Users/example/Documents/development/atomic\\033[0m"
				fi
				if [ $((i % 7)) -eq 0 ]; then
					echo -e "  \\033[33m⚠ Warning: potential issue detected at line \${i} in very-long-component-name-that-exceeds-width.ts\\033[0m"
				fi
				if [ $((i % 11)) -eq 0 ]; then
					echo -e "  \\033[31m✗ Error: file not found /some/really/long/path/that/definitely/exceeds/the/overlay/width/limit/file-\${i}.ts\\033[0m"
				fi
				sleep 0.3
			done
			echo ""
			echo -e "\\033[32m✓ Complete - 100 files processed in 30 seconds\\033[0m"
			echo "Press Esc to close"
			`,
		]);

		this.proc.stdout?.on("data", (data: Buffer) => {
			if (this.disposed) return; // Guard against callbacks after dispose
			const text = data.toString();
			const newLines = text.split("\n");
			for (const line of newLines) {
				if (line) this.lines.push(line);
			}
			// Auto-scroll to bottom
			this.scrollOffset = Math.max(0, this.lines.length - this.maxVisibleLines);
			this.tui.requestRender();
		});

		this.proc.stderr?.on("data", (data: Buffer) => {
			if (this.disposed) return; // Guard against callbacks after dispose
			this.lines.push(this.theme.fg("error", data.toString().trim()));
			this.tui.requestRender();
		});

		this.proc.on("close", () => {
			if (this.disposed) return; // Guard against callbacks after dispose
			this.finished = true;
			this.tui.requestRender();
		});
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.proc?.kill();
			this.done();
		} else if (matchesKey(data, "up")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			this.tui.requestRender(); // Trigger re-render after scroll
		} else if (matchesKey(data, "down")) {
			this.scrollOffset = Math.min(Math.max(0, this.lines.length - this.maxVisibleLines), this.scrollOffset + 1);
			this.tui.requestRender(); // Trigger re-render after scroll
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(1, width - 2);
		const padLine = (s: string) => truncateToWidth(s, innerW, "...", true);
		const border = (c: string) => th.fg("border", c);

		const result: string[] = [];
		const title = truncateToWidth(` Streaming Output (${this.lines.length} lines) `, innerW);
		const titlePad = Math.max(0, innerW - visibleWidth(title));
		result.push(border("╭") + th.fg("accent", title) + border(`${"─".repeat(titlePad)}╮`));

		// Scroll indicators
		const canScrollUp = this.scrollOffset > 0;
		const canScrollDown = this.scrollOffset < this.lines.length - this.maxVisibleLines;
		const scrollInfo = `↑${this.scrollOffset} | ↓${Math.max(0, this.lines.length - this.maxVisibleLines - this.scrollOffset)}`;

		result.push(
			border("│") + padLine(canScrollUp || canScrollDown ? th.fg("dim", ` ${scrollInfo}`) : "") + border("│"),
		);

		// Visible lines - truncate long lines to fit within border
		const visibleLines = this.lines.slice(this.scrollOffset, this.scrollOffset + this.maxVisibleLines);
		for (const line of visibleLines) {
			result.push(border("│") + padLine(` ${line}`) + border("│"));
		}

		// Pad to maxVisibleLines
		for (let i = visibleLines.length; i < this.maxVisibleLines; i++) {
			result.push(border("│") + padLine("") + border("│"));
		}

		const status = this.finished ? th.fg("success", "✓ Done") : th.fg("warning", "● Running");
		result.push(border("│") + padLine(` ${status} ${th.fg("dim", "| ↑↓ scroll | Esc close")}`) + border("│"));
		result.push(border(`╰${"─".repeat(innerW)}╯`));

		return result;
	}

	dispose(): void {
		this.disposed = true;
		this.proc?.kill();
	}
}

// Edge position test

export class AnimationDemoComponent extends BaseOverlay {
	private tui: TUI;
	private frame = 0;
	private interval: ReturnType<typeof setInterval> | null = null;
	private fps = 0;
	private lastFpsUpdate = Date.now();
	private framesSinceLastFps = 0;
	private done: () => void;

	constructor(tui: TUI, theme: Theme, done: () => void) {
		super(theme);
		this.tui = tui;
		this.done = done;
		this.startAnimation();
	}

	private startAnimation(): void {
		// Run at ~30 FPS (same as DOOM target)
		this.interval = setInterval(() => {
			this.frame++;
			this.framesSinceLastFps++;

			// Update FPS counter every second
			const now = Date.now();
			if (now - this.lastFpsUpdate >= 1000) {
				this.fps = this.framesSinceLastFps;
				this.framesSinceLastFps = 0;
				this.lastFpsUpdate = now;
			}

			this.tui.requestRender();
		}, 1000 / 30);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.dispose();
			this.done();
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(1, width - 2);
		const padLine = (s: string) => truncateToWidth(s, innerW, "...", true);
		const border = (c: string) => th.fg("border", c);

		const lines: string[] = [];
		lines.push(border(`╭${"─".repeat(innerW)}╮`));
		lines.push(border("│") + padLine(th.fg("accent", " Animation Demo (~30 FPS)")) + border("│"));
		lines.push(border("│") + padLine(``) + border("│"));
		lines.push(border("│") + padLine(` Frame: ${th.fg("accent", String(this.frame))}`) + border("│"));
		lines.push(border("│") + padLine(` FPS: ${th.fg("success", String(this.fps))}`) + border("│"));
		lines.push(border("│") + padLine(``) + border("│"));

		// Animated content - bouncing bar
		const barWidth = Math.max(12, innerW - 4); // Ensure enough space for bar
		const pos = Math.max(0, Math.floor(((Math.sin(this.frame / 10) + 1) * (barWidth - 10)) / 2));
		const bar = " ".repeat(pos) + th.fg("accent", "██████████") + " ".repeat(Math.max(0, barWidth - 10 - pos));
		lines.push(border("│") + padLine(` ${bar}`) + border("│"));

		// Spinning character
		const spinChars = ["◐", "◓", "◑", "◒"];
		const spin = spinChars[this.frame % spinChars.length];
		lines.push(border("│") + padLine(` Spinner: ${th.fg("warning", spin!)}`) + border("│"));

		// Color cycling
		const hue = (this.frame * 3) % 360;
		const rgb = hslToRgb(hue / 360, 0.8, 0.5);
		const colorBlock = `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m${"  ".repeat(10)}\x1b[0m`;
		lines.push(border("│") + padLine(` Color: ${colorBlock}`) + border("│"));

		lines.push(border("│") + padLine(``) + border("│"));
		lines.push(border("│") + padLine(th.fg("dim", " This proves overlays can handle")) + border("│"));
		lines.push(border("│") + padLine(th.fg("dim", " real-time game-like rendering.")) + border("│"));
		lines.push(border("│") + padLine(th.fg("dim", " (Atomic doom uses same approach)")) + border("│"));
		lines.push(border("│") + padLine(``) + border("│"));
		lines.push(border("│") + padLine(th.fg("dim", " Press Esc to close")) + border("│"));
		lines.push(border(`╰${"─".repeat(innerW)}╯`));

		return lines;
	}

	dispose(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
	}
}

// HSL to RGB helper for color cycling animation
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
	let r: number, g: number, b: number;
	if (s === 0) {
		r = g = b = l;
	} else {
		const hue2rgb = (p: number, q: number, t: number) => {
			if (t < 0) t += 1;
			if (t > 1) t -= 1;
			if (t < 1 / 6) return p + (q - p) * 6 * t;
			if (t < 1 / 2) return q;
			if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
			return p;
		};
		const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
		const p = 2 * l - q;
		r = hue2rgb(p, q, h + 1 / 3);
		g = hue2rgb(p, q, h);
		b = hue2rgb(p, q, h - 1 / 3);
	}
	return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

// Toggle demo - demonstrates OverlayHandle.setHidden() via onHandle callback
