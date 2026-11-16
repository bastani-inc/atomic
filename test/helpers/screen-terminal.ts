import type { Terminal } from "@bastani/atomic-tui";
import type { Terminal as XtermInstance } from "@xterm/headless";
import xterm from "@xterm/headless";

const XtermTerminal = xterm.Terminal;

export class ScreenTerminal implements Terminal {
	private readonly xterm: XtermInstance;
	private inputHandler?: (data: string) => void;
	columns: number;
	rows: number;
	readonly kittyProtocolActive = true;

	constructor(columns: number, rows: number) {
		this.columns = columns;
		this.rows = rows;
		this.xterm = new XtermTerminal({
			cols: columns,
			rows,
			disableStdin: true,
			allowProposedApi: true,
		});
	}

	resize(columns: number, rows: number): void {
		this.columns = columns;
		this.rows = rows;
		this.xterm.resize(columns, rows);
	}

	start(onInput: (data: string) => void): void {
		this.inputHandler = onInput;
	}

	async drainInput(): Promise<void> {}

	stop(): void {
		this.inputHandler = undefined;
	}

	write(data: string): void {
		this.xterm.write(data);
	}

	moveBy(lines: number): void {
		if (lines > 0) this.xterm.write(`\x1b[${lines}B`);
		else if (lines < 0) this.xterm.write(`\x1b[${-lines}A`);
	}

	hideCursor(): void {
		this.xterm.write("\x1b[?25l");
	}

	showCursor(): void {
		this.xterm.write("\x1b[?25h");
	}

	clearLine(): void {
		this.xterm.write("\x1b[K");
	}

	clearFromCursor(): void {
		this.xterm.write("\x1b[J");
	}

	clearScreen(): void {
		this.xterm.write("\x1b[2J\x1b[H");
	}

	setTitle(title: string): void {
		this.xterm.write(`\x1b]0;${title}\x07`);
	}

	setProgress(): void {}
	setProgramStatus(): void {}

	sendInput(data: string): void {
		this.inputHandler?.(data);
	}

	async waitForRender(): Promise<void> {
		await new Promise<void>((resolve) => process.nextTick(resolve));
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		await new Promise<void>((resolve) => this.xterm.write("", () => resolve()));
	}

	async flushAndGetViewport(): Promise<string[]> {
		await new Promise<void>((resolve) => this.xterm.write("", () => resolve()));
		const buffer = this.xterm.buffer.active;
		const lines: string[] = [];
		for (let i = 0; i < this.xterm.rows; i++) {
			lines.push(buffer.getLine(buffer.viewportY + i)?.translateToString(true) ?? "");
		}
		return lines;
	}
}
