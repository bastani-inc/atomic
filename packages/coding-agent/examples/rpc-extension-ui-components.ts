import { type Component, Input, matchesKey, SelectList, TUI } from "@earendil-works/pi-tui";

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const MAGENTA = "\x1b[35m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

export class OutputLog implements Component {
	private lines: string[] = [];
	private maxLines = 1000;
	private visibleLines = 0;

	setVisibleLines(n: number): void {
		this.visibleLines = n;
	}

	append(line: string): void {
		this.lines.push(line);
		if (this.lines.length > this.maxLines) {
			this.lines = this.lines.slice(-this.maxLines);
		}
	}

	appendRaw(text: string): void {
		if (this.lines.length === 0) {
			this.lines.push(text);
		} else {
			this.lines[this.lines.length - 1] += text;
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (this.lines.length === 0) return [""];
		const n = this.visibleLines > 0 ? this.visibleLines : this.lines.length;
		return this.lines.slice(-n).map((l) => l.slice(0, width));
	}
}

// ============================================================================
// Loading indicator: "Agent: Working." -> ".." -> "..." -> "."
// ============================================================================

export class LoadingIndicator implements Component {
	private dots = 1;
	private intervalId: NodeJS.Timeout | null = null;
	private tui: TUI | null = null;

	start(tui: TUI): void {
		this.tui = tui;
		this.dots = 1;
		this.intervalId = setInterval(() => {
			this.dots = (this.dots % 3) + 1;
			this.tui?.requestRender();
		}, 400);
	}

	stop(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	invalidate(): void {}

	render(_width: number): string[] {
		return [`${BLUE}${BOLD}Agent:${RESET} ${DIM}Working${".".repeat(this.dots)}${RESET}`];
	}
}

// ============================================================================
// Prompt input: label + single-line input
// ============================================================================

export class PromptInput implements Component {
	readonly input: Input;
	onCtrlD?: () => void;

	constructor() {
		this.input = new Input();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+d")) {
			this.onCtrlD?.();
			return;
		}
		this.input.handleInput(data);
	}

	invalidate(): void {
		this.input.invalidate();
	}

	render(width: number): string[] {
		return [`${GREEN}${BOLD}You:${RESET}`, ...this.input.render(width)];
	}
}

// ============================================================================
// Dialog components: replace the prompt input during interactive requests
// ============================================================================

export class SelectDialog implements Component {
	private list: SelectList;
	private title: string;
	onSelect?: (value: string) => void;
	onCancel?: () => void;

	constructor(title: string, options: string[]) {
		this.title = title;
		const items = options.map((o) => ({ value: o, label: o }));
		this.list = new SelectList(items, Math.min(items.length, 8), {
			selectedPrefix: (t) => `${MAGENTA}${t}${RESET}`,
			selectedText: (t) => `${MAGENTA}${t}${RESET}`,
			description: (t) => `${DIM}${t}${RESET}`,
			scrollInfo: (t) => `${DIM}${t}${RESET}`,
			noMatch: (t) => `${YELLOW}${t}${RESET}`,
		});
		this.list.onSelect = (item) => this.onSelect?.(item.value);
		this.list.onCancel = () => this.onCancel?.();
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
	}

	invalidate(): void {
		this.list.invalidate();
	}

	render(width: number): string[] {
		return [
			`${MAGENTA}${BOLD}${this.title}${RESET}`,
			...this.list.render(width),
			`${DIM}Up/Down, Enter to select, Esc to cancel${RESET}`,
		];
	}
}

export class InputDialog implements Component {
	private dialogInput: Input;
	private title: string;
	onCtrlD?: () => void;

	constructor(title: string, prefill?: string) {
		this.title = title;
		this.dialogInput = new Input();
		if (prefill) this.dialogInput.setValue(prefill);
	}

	set onSubmit(fn: ((value: string) => void) | undefined) {
		this.dialogInput.onSubmit = fn;
	}

	set onEscape(fn: (() => void) | undefined) {
		this.dialogInput.onEscape = fn;
	}

	get inputComponent(): Input {
		return this.dialogInput;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+d")) {
			this.onCtrlD?.();
			return;
		}
		this.dialogInput.handleInput(data);
	}

	invalidate(): void {
		this.dialogInput.invalidate();
	}

	render(width: number): string[] {
		return [
			`${MAGENTA}${BOLD}${this.title}${RESET}`,
			...this.dialogInput.render(width),
			`${DIM}Enter to submit, Esc to cancel${RESET}`,
		];
	}
}

