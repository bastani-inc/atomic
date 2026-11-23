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
	/** Everything the program wrote to the terminal so far, in order, as it arrived. */
	output(): string;
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

const TEST_RUNNER_MARKER_ENV_KEYS = [
	"VITEST",
	"VITEST_MODE",
	"VITEST_POOL_ID",
	"VITEST_WORKER_ID",
	"NODE_TEST_CONTEXT",
] as const;

/**
 * `PtySession` overlays `env` on top of the test runner's inherited `process.env` rather than replacing it.
 * Clear inherited test-runner markers (and Vitest's `NODE_ENV=test`) unless the caller explicitly sets them,
 * so PTY children observe a production-like environment while still honoring explicit caller overrides.
 */
export function withoutInheritedTestRunnerEnv(
	env: Record<string, string>,
	parentEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	let cleaned: Record<string, string> | undefined;
	if (!("NODE_ENV" in env) && parentEnv.NODE_ENV === "test") {
		cleaned ??= { ...env };
		cleaned.NODE_ENV = "";
	}
	for (const key of TEST_RUNNER_MARKER_ENV_KEYS) {
		if (!(key in env) && parentEnv[key] !== undefined) {
			cleaned ??= { ...env };
			cleaned[key] = "";
		}
	}
	return cleaned ?? env;
}

/**
 * On Windows an interactive session that finds the default compile cache cold runs without it and starts a helper
 * process that writes it. Test sessions keep the cache Node enables from NODE_COMPILE_CACHE instead, in the directory
 * Node would use by default, so they never start that helper. A test of the helper sets NODE_COMPILE_CACHE to "".
 */
function withSessionCompileCache(env: Record<string, string>): Record<string, string> {
	if (process.platform !== "win32" || "NODE_COMPILE_CACHE" in env || "NODE_DISABLE_COMPILE_CACHE" in env) return env;
	const temp = env.TEMP || env.TMP || `${env.SystemRoot || env.windir || "C:\\Windows"}\\temp`;
	return { ...env, NODE_COMPILE_CACHE: `${temp.replace(/\\+$/, "")}\\node-compile-cache` };
}

export function startPtyProgram(options: PtyProgramOptions): PtyProgram {
	const { PtySession } = createRequire(import.meta.url)("@bastani/atomic-natives") as {
		PtySession: new () => NativePtySession;
	};
	const session = new PtySession();
	const terminal = new Terminal({ cols: options.cols, rows: options.rows, allowProposedApi: true });
	let replyError: unknown;
	const replies = terminal.onData((data) => {
		try {
			session.write(data);
		} catch (error) {
			// The child can exit before xterm parses its last device query and before the exit reaches JS.
			// Deliver a failed reply to the next interaction that needs the PTY, not to an unrelated test's timer.
			replyError = error;
			replies.dispose();
		}
	});
	const [command = "", ...leading] = [...options.args].reverse();
	const outputChunks: string[] = [];
	const exited = session
		.start(
			{
				command,
				cwd: options.cwd,
				env: withoutInheritedTestRunnerEnv(withSessionCompileCache(options.env)),
				timeoutMs: options.timeoutMs,
				cols: options.cols,
				rows: options.rows,
				shell: options.executable,
				shellArgs: leading.reverse(),
				commandTransport: "argv",
				closeStdinAfterCommand: false,
			},
			(error, chunk) => {
				if (error === null && chunk) {
					outputChunks.push(chunk);
					terminal.write(chunk);
				}
			},
		)
		.then((result) => ({ exitCode: result.exitCode, timedOut: result.timedOut === true }))
		.finally(() => replies.dispose());
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
		write: (data) => {
			if (replyError !== undefined) throw replyError;
			session.write(data);
		},
		screen,
		output: () => outputChunks.join(""),
		async waitForScreen(predicate, timeoutMs, what) {
			const deadline = Date.now() + timeoutMs;
			while (!predicate(screen())) {
				if (replyError !== undefined) throw replyError;
				if (ended) throw new Error(`The program exited while waiting for ${what}. Screen:\n${screen()}`);
				if (Date.now() >= deadline) throw new Error(`No ${what} within ${timeoutMs} ms. Screen:\n${screen()}`);
				await sleep(SCREEN_POLL_MS);
			}
		},
		kill: () => {
			// xterm may still be parsing a device query from the last chunk after the native PTY stops.
			replies.dispose();
			if (!ended) session.kill();
		},
	};
}
