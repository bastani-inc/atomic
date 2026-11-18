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
	kill(): void;
}

export interface PtyProcess {
	readonly exited: Promise<{ readonly exitCode: number | null; readonly timedOut: boolean }>;
	write(data: string): void;
	kill(): void;
}

export interface StartPtyOptions {
	/**
	 * A shell command line, run by `cmd /d /s /c` on Windows and `/bin/sh -c` elsewhere; or a program and its
	 * arguments, started without a shell and each argument passed as given, whatever spaces or quotes it holds.
	 */
	readonly command: string | readonly [program: string, first: string, ...rest: string[]];
	readonly cwd: string;
	readonly env: Record<string, string>;
	readonly timeoutMs: number;
	readonly cols: number;
	readonly rows: number;
	readonly onChunk: (chunk: string, atNs: bigint) => void;
}

/**
 * Runs a command in a real pseudo-terminal through Atomic's own native PTY (ConPTY on Windows, a Unix PTY
 * elsewhere), the terminal an interactive user's `atomic` runs in.
 */
export function startPty(options: StartPtyOptions): PtyProcess {
	const loaded = createRequire(import.meta.url)("@bastani/atomic-natives") as {
		readonly PtySession?: new () => NativePtySession;
	};
	if (typeof loaded.PtySession !== "function") throw new Error("@bastani/atomic-natives does not export PtySession");
	const session = new loaded.PtySession();
	const windows = process.platform === "win32";
	// The native PTY runs `shell` with `shellArgs`, then `command` as one more argument.
	const launch =
		typeof options.command === "string"
			? {
					shell: windows ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh",
					shellArgs: windows ? ["/d", "/s", "/c"] : ["-c"],
					command: options.command,
				}
			: {
					shell: options.command[0],
					shellArgs: options.command.slice(1, -1),
					command: options.command[options.command.length - 1]!,
				};
	const exited = session
		.start(
			{
				command: launch.command,
				cwd: options.cwd,
				env: options.env,
				timeoutMs: options.timeoutMs,
				cols: options.cols,
				rows: options.rows,
				shell: launch.shell,
				shellArgs: launch.shellArgs,
				commandTransport: "argv",
				closeStdinAfterCommand: false,
			},
			(_error, chunk) => {
				if (chunk) options.onChunk(chunk, process.hrtime.bigint());
			},
		)
		.then((result) => ({
			exitCode: result.exitCode ?? result.exit_code ?? null,
			timedOut: result.timedOut ?? result.timed_out ?? false,
		}));
	return { exited, write: (data) => session.write(data), kill: () => session.kill() };
}
