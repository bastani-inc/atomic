import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import chalk from "chalk";
import { ENV_STDIN_TIMEOUT_MS, getEnvValue } from "./config.js";
import type { AgentSessionRuntimeDiagnostic } from "./core/agent-session-services.ts";
import type { SettingsManager } from "./core/settings-manager.ts";

/** How long a run waits for the first piped byte, or the end of stdin, by default. */
export const DEFAULT_STDIN_TIMEOUT_MS = 2_000;

/** The longest delay a timer holds: a longer one fires after 1 ms instead. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * `ATOMIC_STDIN_TIMEOUT_MS`: a whole number of milliseconds, at most `MAX_TIMER_DELAY_MS` (about 24.8 days); `0` waits
 * for the end of piped input.
 */
function stdinTimeoutMs(): number {
	const raw = getEnvValue(ENV_STDIN_TIMEOUT_MS)?.trim();
	if (!raw) return DEFAULT_STDIN_TIMEOUT_MS;
	const value = Number(raw);
	return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, MAX_TIMER_DELAY_MS) : DEFAULT_STDIN_TIMEOUT_MS;
}

/** What `readPipedStdin` needs of stdin. */
export type PipedInput = Readable & { readonly isTTY?: boolean; unref?(): void };

function warn(message: string): void {
	console.error(chalk.yellow(`Warning: ${message}`));
}

/**
 * Read all content from piped stdin. Returns undefined if stdin is a TTY (interactive terminal).
 *
 * A harness, an agent's shell tool or a supervisor often starts Atomic with stdin an open pipe it never writes to or
 * closes. Waiting for its end would wait forever (#4224). So when nothing, not even the end, arrives within
 * `ATOMIC_STDIN_TIMEOUT_MS`, a run that has a prompt argument starts without stdin, and reports input that arrives
 * later instead of dropping it silently. Input that has started arriving is read to its end, however slow. A run with
 * no prompt argument has nothing else to run, so it keeps waiting, and says on stderr that it is waiting.
 */
export async function readPipedStdin(options: {
	readonly hasPrompt: boolean;
	/** The stream to read; `process.stdin` unless given. */
	readonly stdin?: PipedInput;
}): Promise<string | undefined> {
	const stdin = options.stdin ?? process.stdin;
	if (stdin.isTTY) {
		return undefined;
	}
	const timeoutMs = stdinTimeoutMs();

	return new Promise((resolve) => {
		let data = "";
		let received = false;
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		// Decoded here rather than with `setEncoding`, which holds back a partial character: a first byte that arrived
		// before the deadline, as part of a character whose rest came later, would not count as input arriving.
		const decoder = new StringDecoder("utf8");
		const onData = (chunk: Buffer | string) => {
			received = true;
			data += typeof chunk === "string" ? chunk : decoder.write(chunk);
		};
		const onEnd = () => settle((data + decoder.end()).trim() || undefined);
		const settle = (value: string | undefined) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			stdin.off("data", onData);
			stdin.off("end", onEnd);
			resolve(value);
		};
		stdin.on("data", onData);
		stdin.on("end", onEnd);
		if (timeoutMs > 0) {
			timer = setTimeout(() => {
				if (received) return;
				if (!options.hasPrompt) {
					warn(
						"Waiting for input on stdin. Pass a prompt argument, or close stdin (for example with `< /dev/null`), to start without it.",
					);
					return;
				}
				settle(undefined);
				// Stop reading, but say so if input still arrives. The listener must not keep the process alive.
				stdin.once("data", () => {
					warn(
						`Input arrived on stdin after Atomic stopped waiting for it and was ignored. Set ${ENV_STDIN_TIMEOUT_MS} to wait longer, or to 0 to wait for the end of piped input.`,
					);
					stdin.pause();
				});
				stdin.unref?.();
			}, timeoutMs);
		}
		stdin.resume();
	});
}

export function collectSettingsDiagnostics(
	settingsManager: SettingsManager,
	context: string,
): AgentSessionRuntimeDiagnostic[] {
	return settingsManager.drainErrors().map(({ scope, path, error }) => ({
		type: "warning",
		message: path
			? `(${context}) Invalid settings file ${path}: ${error.message}`
			: `(${context}, ${scope} settings) ${error.message}`,
	}));
}

export function reportDiagnostics(diagnostics: readonly AgentSessionRuntimeDiagnostic[]): void {
	for (const diagnostic of diagnostics) {
		const color = diagnostic.type === "error" ? chalk.red : diagnostic.type === "warning" ? chalk.yellow : chalk.dim;
		const prefix = diagnostic.type === "error" ? "Error: " : diagnostic.type === "warning" ? "Warning: " : "";
		console.error(color(`${prefix}${diagnostic.message}`));
	}
}

export function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

type DrainableWritable = NodeJS.WritableStream & {
	destroyed?: boolean;
	writable?: boolean;
	writableEnded?: boolean;
};

function drainWritable(stream: DrainableWritable): Promise<void> {
	if (stream.destroyed || stream.writable === false || stream.writableEnded) {
		return Promise.resolve();
	}

	return new Promise((resolve) => {
		let settled = false;

		const settle = () => {
			if (settled) {
				return;
			}
			settled = true;
			stream.removeListener("error", onError);
			resolve();
		};
		const onError = () => settle();

		stream.once("error", onError);
		try {
			stream.write("", settle);
		} catch {
			settle();
		}
	});
}

export async function drainProcessStdio(): Promise<void> {
	await Promise.all([drainWritable(process.stdout), drainWritable(process.stderr)]);
}
