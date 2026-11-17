import { Terminal } from "@xterm/headless";

type ScreenListener = (lines: readonly string[], atMs: number) => void;

/**
 * The terminal the CLI paints into. Every chunk is parsed in arrival order, and listeners see the screen as it stood
 * after the chunk, stamped with the time the chunk was read: a paint is timed by the chunk that drew it.
 */
export class BenchScreen {
	readonly terminal: Terminal;
	private readonly listeners = new Set<ScreenListener>();
	private current: readonly string[] = [];

	constructor(cols: number, rows: number) {
		this.terminal = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 });
	}

	/** Terminal replies to the application's queries, which the driver writes back to it. */
	onReply(listener: (data: string) => void): void {
		this.terminal.onData(listener);
	}

	feed(chunk: string, atMs: number): void {
		if (this.overflow !== undefined) return;
		try {
			this.terminal.write(chunk, () => {
				this.current = this.capture();
				for (const listener of this.listeners) listener(this.current, atMs);
			});
		} catch (error) {
			// The terminal model fell too far behind the output to keep up: stop rather than measure a partial screen.
			this.overflow = error instanceof Error ? error : new Error(String(error));
		}
	}

	/** Why the screen stopped following the output, if it did. */
	overflow: Error | undefined;

	lines(): readonly string[] {
		return this.current;
	}

	text(): string {
		return this.current.join("\n");
	}

	subscribe(listener: ScreenListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	waitFor(predicate: (lines: readonly string[]) => boolean, timeoutMs: number, label: string): Promise<void> {
		if (predicate(this.current)) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				unsubscribe();
				const cause =
					this.overflow === undefined ? "" : ` (the screen stopped following: ${this.overflow.message})`;
				reject(new Error(`timed out after ${timeoutMs} ms waiting for ${label}${cause}\n${this.text()}`));
			}, timeoutMs);
			const unsubscribe = this.subscribe((lines) => {
				if (!predicate(lines)) return;
				clearTimeout(timer);
				unsubscribe();
				resolve();
			});
		});
	}

	private capture(): string[] {
		const buffer = this.terminal.buffer.active;
		const lines: string[] = [];
		for (let row = 0; row < this.terminal.rows; row++) {
			lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "");
		}
		return lines;
	}
}
