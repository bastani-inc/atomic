import type { Theme } from "@bastani/atomic";
import type { OverlayAnchor, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";
import { BaseOverlay } from "./overlay-qa-shared.js";

export class AnchorTestComponent extends BaseOverlay {
	private anchor: OverlayAnchor;
	private done: (result: "next" | "confirm" | "cancel") => void;

	constructor(theme: Theme, anchor: OverlayAnchor, done: (result: "next" | "confirm" | "cancel") => void) {
		super(theme);
		this.anchor = anchor;
		this.done = done;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done("cancel");
		} else if (matchesKey(data, "return")) {
			this.done("confirm");
		} else if (matchesKey(data, "space") || matchesKey(data, "right")) {
			this.done("next");
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		return this.box(
			[
				"",
				` Current: ${th.fg("accent", this.anchor)}`,
				"",
				` ${th.fg("dim", "Space/→ = next anchor")}`,
				` ${th.fg("dim", "Enter = confirm")}`,
				` ${th.fg("dim", "Esc = cancel")}`,
				"",
			],
			width,
			"Anchor Test",
		);
	}
}

// Margin/offset test
export class MarginTestComponent extends BaseOverlay {
	private config: { name: string; options: OverlayOptions };
	private done: (result: "next" | "close") => void;

	constructor(
		theme: Theme,
		config: { name: string; options: OverlayOptions },
		done: (result: "next" | "close") => void,
	) {
		super(theme);
		this.config = config;
		this.done = done;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done("close");
		} else if (matchesKey(data, "space") || matchesKey(data, "right")) {
			this.done("next");
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		return this.box(
			[
				"",
				` ${th.fg("accent", this.config.name)}`,
				"",
				` ${th.fg("dim", "Space/→ = next config")}`,
				` ${th.fg("dim", "Esc = close")}`,
				"",
			],
			width,
			"Margin Test",
		);
	}
}

// Stacked overlay test
export class StackOverlayComponent extends BaseOverlay {
	private num: number;
	private position: string;
	private done: (result: string) => void;

	constructor(theme: Theme, num: number, position: string, done: (result: string) => void) {
		super(theme);
		this.num = num;
		this.position = position;
		this.done = done;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "return")) {
			this.done(`Overlay ${this.num}`);
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		// Use different colors for each overlay to show stacking
		const colors = ["error", "success", "accent"] as const;
		const color = colors[(this.num - 1) % colors.length]!;
		const innerW = Math.max(1, width - 2);
		const border = (char: string) => th.fg(color, char);
		const padLine = (s: string) => truncateToWidth(s, innerW, "...", true);
		const lines: string[] = [];

		lines.push(border(`╭${"─".repeat(innerW)}╮`));
		lines.push(border("│") + padLine(` Overlay ${th.fg("accent", `#${this.num}`)}`) + border("│"));
		lines.push(border("│") + padLine(` Layer: ${th.fg(color, this.position)}`) + border("│"));
		lines.push(border("│") + padLine("") + border("│"));
		// Add extra lines to make it taller
		for (let i = 0; i < 5; i++) {
			lines.push(border("│") + padLine(` ${"░".repeat(innerW - 2)} `) + border("│"));
		}
		lines.push(border("│") + padLine("") + border("│"));
		lines.push(border("│") + padLine(th.fg("dim", " Press Enter/Esc to close")) + border("│"));
		lines.push(border(`╰${"─".repeat(innerW)}╯`));

		return lines;
	}
}

// Streaming overflow test - spawns real process with colored output (original crash scenario)
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
export class EdgeTestComponent extends BaseOverlay {
	private done: () => void;

	constructor(theme: Theme, done: () => void) {
		super(theme);
		this.done = done;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done();
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		return this.box(
			[
				"",
				" This overlay is at the",
				" right edge of terminal.",
				"",
				` ${th.fg("dim", "Verify right border")}`,
				` ${th.fg("dim", "aligns with edge.")}`,
				"",
				` ${th.fg("dim", "Press Esc to close")}`,
				"",
			],
			width,
			"Edge Test",
		);
	}
}

// Percentage positioning test
export class PercentTestComponent extends BaseOverlay {
	private config: { name: string; row: number; col: number };
	private done: (result: "next" | "close") => void;

	constructor(
		theme: Theme,
		config: { name: string; row: number; col: number },
		done: (result: "next" | "close") => void,
	) {
		super(theme);
		this.config = config;
		this.done = done;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done("close");
		} else if (matchesKey(data, "space") || matchesKey(data, "right")) {
			this.done("next");
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		return this.box(
			[
				"",
				` ${th.fg("accent", this.config.name)}`,
				"",
				` ${th.fg("dim", "Space/→ = next")}`,
				` ${th.fg("dim", "Esc = close")}`,
				"",
			],
			width,
			"Percent Test",
		);
	}
}

// MaxHeight test - renders 20 lines, truncated to 10 by maxHeight
export class MaxHeightTestComponent extends BaseOverlay {
	private done: () => void;

	constructor(theme: Theme, done: () => void) {
		super(theme);
		this.done = done;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done();
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		// Intentionally render 21 lines - maxHeight: 10 will truncate to first 10
		// You should see header + lines 1-6, with bottom border cut off
		const contentLines: string[] = [
			th.fg("warning", " ⚠ Rendering 21 lines, maxHeight: 10"),
			th.fg("dim", " Lines 11-21 truncated (no bottom border)"),
			"",
		];

		for (let i = 1; i <= 14; i++) {
			contentLines.push(` Line ${i} of 14`);
		}

		contentLines.push("", th.fg("dim", " Press Esc to close"));

		return this.box(contentLines, width, "MaxHeight Test");
	}
}

// Responsive sidepanel - demonstrates percentage width and visibility callback
export class SidepanelComponent extends BaseOverlay {
	private tui: TUI;
	private items = ["Dashboard", "Messages", "Settings", "Help", "About"];
	private selectedIndex = 0;
	private done: () => void;

	constructor(tui: TUI, theme: Theme, done: () => void) {
		super(theme);
		this.tui = tui;
		this.done = done;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done();
		} else if (matchesKey(data, "up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.tui.requestRender();
		} else if (matchesKey(data, "down")) {
			this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + 1);
			this.tui.requestRender();
		} else if (matchesKey(data, "return")) {
			// Could trigger an action here
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(1, width - 2);
		const padLine = (s: string) => truncateToWidth(s, innerW, "...", true);
		const border = (c: string) => th.fg("border", c);
		const lines: string[] = [];

		// Header
		lines.push(border(`╭${"─".repeat(innerW)}╮`));
		lines.push(border("│") + padLine(th.fg("accent", " Responsive Sidepanel")) + border("│"));
		lines.push(border("├") + border("─".repeat(innerW)) + border("┤"));

		// Menu items
		for (let i = 0; i < this.items.length; i++) {
			const item = this.items[i]!;
			const isSelected = i === this.selectedIndex;
			const prefix = isSelected ? th.fg("accent", "→ ") : "  ";
			const text = isSelected ? th.fg("accent", item) : item;
			lines.push(border("│") + padLine(`${prefix}${text}`) + border("│"));
		}

		// Footer with responsive behavior info
		lines.push(border("├") + border("─".repeat(innerW)) + border("┤"));
		lines.push(border("│") + padLine(th.fg("warning", " ⚠ Resize terminal < 100 cols")) + border("│"));
		lines.push(border("│") + padLine(th.fg("warning", "   to see panel auto-hide")) + border("│"));
		lines.push(border("│") + padLine(th.fg("dim", " Uses visible: (w) => w >= 100")) + border("│"));
		lines.push(border("│") + padLine(th.fg("dim", " ↑↓ navigate | Esc close")) + border("│"));
		lines.push(border(`╰${"─".repeat(innerW)}╯`));

		return lines;
	}
}

// Animation demo - proves overlays can handle real-time updates like Atomic doom
