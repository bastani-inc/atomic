import { createModuleRequire } from "../../utils/module-require.ts";
import { getShellConfig, getShellEnv } from "../../utils/shell.ts";

const NATIVE_PACKAGE = "@bastani/atomic-natives";

interface NativePtyRunResult {
	exitCode?: number;
	exit_code?: number;
	cancelled?: boolean;
	timedOut?: boolean;
	timed_out?: boolean;
}

interface NativePtySession {
	start(
		options: {
			command: string;
			cwd?: string;
			env?: Record<string, string>;
			timeoutMs?: number;
			cols?: number;
			rows?: number;
			shell?: string;
			shellArgs?: string[];
			commandTransport?: "argv" | "stdin";
			closeStdinAfterCommand?: boolean;
		},
		onChunk?: (error: Error | null, chunk: string) => void,
	): Promise<NativePtyRunResult>;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	kill(): void;
}

interface NativePtyBinding {
	PtySession: new () => NativePtySession;
}

type NativeLoadResult =
	| { ok: true; binding: NativePtyBinding }
	| { ok: false; error: Error };

let cachedLoadResult: NativeLoadResult | undefined;

export function resetNativePtyBindingCache(): void {
	cachedLoadResult = undefined;
}

function loadNativePtyBinding(): NativeLoadResult {
	if (cachedLoadResult) return cachedLoadResult;
	try {
		const loaded = createModuleRequire(import.meta.url)(NATIVE_PACKAGE) as Partial<NativePtyBinding>;
		if (typeof loaded.PtySession !== "function") {
			cachedLoadResult = { ok: false, error: new Error(`Native package ${NATIVE_PACKAGE} is missing PtySession.`) };
			return cachedLoadResult;
		}
		cachedLoadResult = { ok: true, binding: loaded as NativePtyBinding };
		return cachedLoadResult;
	} catch (error) {
		cachedLoadResult = {
			ok: false,
			error: new Error(`Native PTY package ${NATIVE_PACKAGE} is unavailable for ${process.platform}-${process.arch}: ${error instanceof Error ? error.message : String(error)}`),
		};
		return cachedLoadResult;
	}
}

export interface NativePtyExecOptions {
	onData: (data: Buffer) => void;
	signal?: AbortSignal;
	timeout?: number;
	env?: NodeJS.ProcessEnv;
	shellPath?: string;
	cols?: number;
	rows?: number;
}

export async function executeNativePty(command: string, cwd: string, options: NativePtyExecOptions): Promise<{ exitCode: number | null }> {
	const loaded = loadNativePtyBinding();
	if (!loaded.ok) throw loaded.error;
	if (options.signal?.aborted) throw new Error("aborted");
	const shellConfig = getShellConfig(options.shellPath);
	const session = new loaded.binding.PtySession();
	const onAbort = () => {
		try { session.kill(); } catch {}
	};
	if (options.signal) options.signal.addEventListener("abort", onAbort, { once: true });
	try {
		const result = await session.start({
			command,
			cwd,
			env: { ...getShellEnv(), ...(options.env ?? {}), TERM: "xterm-256color" },
			timeoutMs: options.timeout !== undefined ? Math.max(1, Math.floor(options.timeout * 1000)) : undefined,
			cols: options.cols ?? 120,
			rows: options.rows ?? 40,
			shell: shellConfig.shell,
			shellArgs: shellConfig.args,
			commandTransport: shellConfig.commandTransport,
			closeStdinAfterCommand: shellConfig.commandTransport === "stdin",
		}, (_error, chunk) => {
			if (chunk) options.onData(Buffer.from(chunk));
		});
		if (options.signal?.aborted || result.cancelled) throw new Error("aborted");
		if (result.timedOut ?? result.timed_out) throw new Error(`timeout:${options.timeout}`);
		return { exitCode: result.exitCode ?? result.exit_code ?? null };
	} finally {
		if (options.signal) options.signal.removeEventListener("abort", onAbort);
	}
}
