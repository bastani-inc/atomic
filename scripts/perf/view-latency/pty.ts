import { createRequire } from "node:module";

/** A terminal the driver types into; every chunk of output arrives with the time it was read. */
export interface BenchPty {
	write(data: string): void;
	kill(): void;
	readonly exited: Promise<number | null>;
}

export interface StartPtyOptions {
	readonly argv: readonly string[];
	readonly cwd: string;
	readonly env: Record<string, string>;
	readonly cols: number;
	readonly rows: number;
	readonly now: () => number;
	readonly onData: (chunk: string, atMs: number) => void;
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
	): Promise<{ readonly exitCode?: number }>;
	write(data: string): void;
	kill(): void;
}

/**
 * Bun's own PTY on POSIX: writes reach the child at once. Windows has none, so it uses the native ConPTY session,
 * whose writer drains at most every 16 ms while the child prints nothing; that adds the same delay to every view.
 */
export function startPty(options: StartPtyOptions): BenchPty {
	return process.platform === "win32" ? startNativePty(options) : startBunPty(options);
}

function startBunPty(options: StartPtyOptions): BenchPty {
	const decoder = new TextDecoder();
	const proc = Bun.spawn([...options.argv], {
		cwd: options.cwd,
		env: options.env,
		terminal: {
			cols: options.cols,
			rows: options.rows,
			data(_terminal, data) {
				options.onData(decoder.decode(data, { stream: true }), options.now());
			},
		},
	});
	return {
		write: (data) => proc.terminal?.write(data),
		kill: () => proc.kill("SIGKILL"),
		exited: proc.exited.then((code) => code),
	};
}

function startNativePty(options: StartPtyOptions): BenchPty {
	const binding = createRequire(import.meta.url)("@bastani/atomic-natives") as {
		readonly PtySession: new () => NativePtySession;
	};
	const session = new binding.PtySession();
	const quoted = options.argv.map((arg) => (/[\s"]/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg)).join(" ");
	const exited = session
		.start(
			{
				command: quoted,
				cwd: options.cwd,
				env: options.env,
				timeoutMs: 0,
				cols: options.cols,
				rows: options.rows,
				shell: process.env.ComSpec ?? "cmd.exe",
				shellArgs: ["/d", "/s", "/c"],
				commandTransport: "argv",
				closeStdinAfterCommand: false,
			},
			(error, chunk) => {
				if (!error && chunk) options.onData(chunk, options.now());
			},
		)
		.then((result) => result.exitCode ?? null);
	return { write: (data) => session.write(data), kill: () => session.kill(), exited };
}
