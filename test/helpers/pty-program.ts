import { createRequire } from "node:module";
import { Terminal } from "@xterm/headless";
import { sleep } from "./runtime.js";

interface NativePtySession {
	start(
		options: {
			readonly command: string;
			readonly cwd: string;
			readonly env: Record<string, string>;
			readonly timeoutMs: number;
			readonly cols: number;
			readonly rows: number;
			readonly shell: string;
			readonly shellArgs: readonly string[];
			readonly commandTransport: "argv";
			readonly closeStdinAfterCommand: false;
		},
		onChunk: (error: Error | null, chunk: string) => void,
	): Promise<{ readonly exitCode?: number; readonly timedOut?: boolean }>;
	write(data: string): void;
	kill(): void;
}

export interface PtyExit {
	readonly exitCode: number | undefined;
	readonly timedOut: boolean;
}

export interface PtyProgram {
	readonly exited: Promise<PtyExit>;
	write(data: string): void;
	screen(): string;
	waitForScreen(predicate: (screen: string) => boolean, timeoutMs: number, what: string): Promise<void>;
	kill(): void;
}

export interface PtyProgramOptions {
	readonly executable: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: Record<string, string>;
	readonly timeoutMs: number;
	readonly cols: number;
	readonly rows: number;
}

const SCREEN_POLL_MS = 50;

export function startPtyProgram(options: PtyProgramOptions): PtyProgram {
	const { PtySession } = createRequire(import.meta.url)("@bastani/atomic-natives") as {
		PtySession: new () => NativePtySession;
	};
	const session = new PtySession();
	const terminal = new Terminal({ cols: options.cols, rows: options.rows, allowProposedApi: true });
	terminal.onData((data) => session.write(data));
	const [command = "", ...leading] = [...options.args].reverse();
	const exited = session
		.start(
			{
				command,
				cwd: options.cwd,
				env: options.env,
				timeoutMs: options.timeoutMs,
				cols: options.cols,
				rows: options.rows,
				shell: options.executable,
				shellArgs: leading.reverse(),
				commandTransport: "argv",
				closeStdinAfterCommand: false,
			},
			(error, chunk) => {
				if (error === null && chunk) terminal.write(chunk);
			},
		)
		.then((result) => ({ exitCode: result.exitCode, timedOut: result.timedOut === true }));
	const screen = () => {
		const buffer = terminal.buffer.active;
		const lines: string[] = [];
		for (let row = 0; row < terminal.rows; row++) {
			lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "");
		}
		return lines.join("\n");
	};
	let ended = false;
	void exited.then(() => {
		ended = true;
	});
	return {
		exited,
		write: (data) => session.write(data),
		screen,
		async waitForScreen(predicate, timeoutMs, what) {
			const deadline = Date.now() + timeoutMs;
			while (!predicate(screen())) {
				if (ended) throw new Error(`The program exited while waiting for ${what}. Screen:\n${screen()}`);
				if (Date.now() >= deadline) throw new Error(`No ${what} within ${timeoutMs} ms. Screen:\n${screen()}`);
				await sleep(SCREEN_POLL_MS);
			}
		},
		kill: () => {
			if (!ended) session.kill();
		},
	};
}
