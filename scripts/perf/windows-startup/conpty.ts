import { createRequire } from "node:module";

interface NativePtyRunResult {
	readonly exitCode?: number;
	readonly exit_code?: number;
	readonly cancelled?: boolean;
	readonly timedOut?: boolean;
	readonly timed_out?: boolean;
}

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
	): Promise<NativePtyRunResult>;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	kill(): void;
}

interface NativePtyBinding {
	readonly PtySession: new () => NativePtySession;
}

export interface ConptyProcess {
	readonly exited: Promise<{
		readonly exitCode: number | null;
		readonly timedOut: boolean;
		readonly cancelled: boolean;
	}>;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	kill(): void;
}

export interface StartConptyOptions {
	readonly command: string;
	readonly cwd: string;
	readonly env: Record<string, string>;
	readonly timeoutMs: number;
	readonly onChunk: (chunk: string, atNs: bigint) => void;
	readonly onChunkError?: (error: Error) => void;
}

export function startConpty(options: StartConptyOptions): ConptyProcess {
	if (process.platform !== "win32") throw new Error("The Windows startup benchmark requires Windows ConPTY");
	const loaded = createRequire(import.meta.url)("@bastani/atomic-natives") as Partial<NativePtyBinding>;
	if (typeof loaded.PtySession !== "function") throw new Error("@bastani/atomic-natives does not export PtySession");
	const session = new loaded.PtySession();
	const exited = session
		.start(
			{
				command: options.command,
				cwd: options.cwd,
				env: options.env,
				timeoutMs: options.timeoutMs,
				cols: 120,
				rows: 40,
				shell: process.env.ComSpec ?? "cmd.exe",
				shellArgs: ["/d", "/s", "/c"],
				commandTransport: "argv",
				closeStdinAfterCommand: false,
			},
			(error, chunk) => {
				if (error) options.onChunkError?.(error);
				if (chunk) options.onChunk(chunk, process.hrtime.bigint());
			},
		)
		.then((result) => ({
			exitCode: result.exitCode ?? result.exit_code ?? null,
			timedOut: result.timedOut ?? result.timed_out ?? false,
			cancelled: result.cancelled ?? false,
		}));
	return {
		exited,
		write: (data) => session.write(data),
		resize: (cols, rows) => session.resize(cols, rows),
		kill: () => session.kill(),
	};
}
