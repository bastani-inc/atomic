/**
 * How the built-in worker host provisioners run their CLIs (#4768): the executable with an argument array, never a shell,
 * bounded by a timeout and stopped, with every process it started, when the caller's signal aborts. A failure is a
 * {@link WorkerProvisionerError} whose message names the command and its exit code, and carries what the CLI wrote to
 * stderr with anything that looks like a secret redacted. It never carries the command's arguments or environment.
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { WorkerProvisionerErrorCode } from "./types.js";

/** Most bytes of stdout a CLI may print: a scale set or a namespace of thousands of hosts fits. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
/** Most characters of a CLI's stderr an error keeps. */
const MAX_DETAIL_CHARS = 600;
/** Names of environment variables and options whose values are treated as secrets. */
const SECRET_NAME = /secret|token|passw|pwd|credential|api[-_]?key|access[-_]?key|private[-_]?key|signature|sas|auth/i;
/** A secret a CLI might print: a bearer token, a JWT, or a `name=value` / `name: value` pair with a secret's name. */
const SECRET_TEXT: readonly [RegExp, string][] = [
	[/\bBearer\s+[^\s"',;]+/gi, "Bearer [redacted]"],
	[/\beyJ[\w-]+\.[\w-]+(?:\.[\w-]*)?/g, "[redacted]"],
	[
		/\b([\w-]*(?:secret|token|passw(?:or)?d?|pwd|credential|api[-_]?key|access[-_]?key|signature|sig)[\w-]*)(["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi,
		"$1$2[redacted]",
	],
];
/** Shorter values are not redacted where they appear: they would match ordinary words. */
const MIN_SECRET_LENGTH = 6;

/** A provisioner's CLI call that failed. `exitCode` is the CLI's own, when it exited. */
export class WorkerProvisionerError extends Error {
	override readonly name = "WorkerProvisionerError";
	readonly code: WorkerProvisionerErrorCode;
	readonly exitCode?: number;
	constructor(code: WorkerProvisionerErrorCode, message: string, exitCode?: number) {
		super(message);
		this.code = code;
		if (exitCode !== undefined) this.exitCode = exitCode;
	}
}

export interface CliCall {
	/** What an error calls the command, such as `az vmss scale`: never its arguments. */
	readonly label: string;
	readonly file: string;
	readonly args: readonly string[];
	readonly timeoutMs: number;
	/** Variables added to this process's environment for the call. */
	readonly env?: Readonly<Record<string, string>>;
	/** Recognizes stderr that says the CLI's credentials were refused. */
	readonly authFailure?: RegExp;
}

/** The values of `args` that follow, or are joined to, an option with a secret's name. */
function secretArguments(args: readonly string[]): string[] {
	const values: string[] = [];
	args.forEach((arg, index) => {
		const joined = /^-{1,2}([^=]+)=(.*)$/s.exec(arg);
		if (joined !== null && SECRET_NAME.test(joined[1]!)) values.push(joined[2]!);
		else if (/^-{1,2}/.test(arg) && SECRET_NAME.test(arg) && index + 1 < args.length) values.push(args[index + 1]!);
	});
	return values;
}

/** `text` with each secret value of `args` and the environment, and any text that looks like a secret, redacted. */
export function redactSecrets(text: string, args: readonly string[], env: NodeJS.ProcessEnv): string {
	const values = [
		...secretArguments(args),
		...Object.entries(env)
			.filter(([name]) => SECRET_NAME.test(name))
			.map(([, value]) => value ?? ""),
	]
		.filter((value) => value.length >= MIN_SECRET_LENGTH)
		.toSorted((a, b) => b.length - a.length);
	let redacted = text;
	for (const value of values) redacted = redacted.replaceAll(value, "[redacted]");
	for (const [pattern, replacement] of SECRET_TEXT) redacted = redacted.replace(pattern, replacement);
	return redacted;
}

/** The useful end of a CLI's stderr: its lines joined, redacted, and cut to {@link MAX_DETAIL_CHARS}. */
function detail(stderr: string, call: CliCall, env: NodeJS.ProcessEnv): string {
	const text = redactSecrets(
		stderr
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line !== "")
			.join(" "),
		call.args,
		env,
	);
	return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}…` : text;
}

/**
 * Stops every process `child` started: on POSIX it leads its own process group, which may outlive it (a grandchild that
 * holds its output open). On Windows only the child itself.
 */
function stop(child: ChildProcess): void {
	if (child.pid === undefined) return;
	try {
		if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
		else if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	} catch {
		// The group is gone already.
	}
}

/**
 * Runs `call` and resolves its stdout. Rejects with the signal's reason once `signal` aborts, and with a
 * {@link WorkerProvisionerError} when the CLI is missing, exits non-zero, or outlives `call.timeoutMs`; either way the
 * CLI's processes are killed and the promise settles at once, whatever they do with their output.
 *
 * It spawns the executable directly, as `execFile` does, but in its own process group: `execFile` does not pass
 * `detached` on, and without it a timeout would leave what the CLI started running (az runs Python).
 */
export function runCli(call: CliCall, signal: AbortSignal): Promise<string> {
	signal.throwIfAborted();
	const env = { ...process.env, ...call.env };
	return new Promise<string>((resolve, reject) => {
		let settled = false;
		const finish = (outcome: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			stop(child);
			outcome();
		};
		const child = spawn(call.file, call.args, {
			env,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			detached: process.platform !== "win32",
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let stdoutBytes = 0;
		child.stdout.on("data", (chunk: Buffer) => {
			stdoutBytes += chunk.length;
			if (stdoutBytes > MAX_OUTPUT_BYTES)
				finish(() =>
					reject(
						new WorkerProvisionerError("malformed", `${call.label} printed more than ${MAX_OUTPUT_BYTES} bytes.`),
					),
				);
			else stdout.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < 64) stderr.push(chunk);
		});
		child.on("error", (error: NodeJS.ErrnoException) =>
			finish(() =>
				reject(
					error.code === "ENOENT"
						? new WorkerProvisionerError(
								"missing-cli",
								`${call.label} failed: ${call.file} was not found. Install it on this machine, or put it on PATH.`,
							)
						: new WorkerProvisionerError("exit", `${call.label} could not start (${error.code ?? error.name}).`),
				),
			),
		);
		child.on("close", (exitCode: number | null, exitSignal: NodeJS.Signals | null) =>
			finish(() => {
				if (exitCode === 0) return resolve(Buffer.concat(stdout).toString("utf8"));
				const errorText = Buffer.concat(stderr).toString("utf8");
				const text = detail(errorText, call, env);
				const auth = call.authFailure?.test(errorText) === true;
				reject(
					new WorkerProvisionerError(
						auth ? "auth" : "exit",
						`${call.label} ${exitCode === null ? `was stopped by ${exitSignal ?? "a signal"}` : `exited with code ${exitCode}`}${text === "" ? "" : `: ${text}`}`,
						exitCode ?? undefined,
					),
				);
			}),
		);
		const onAbort = () => finish(() => reject(signal.reason));
		signal.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(
			() =>
				finish(() =>
					reject(
						new WorkerProvisionerError(
							"timeout",
							`${call.label} did not finish within ${call.timeoutMs} ms and was stopped.`,
						),
					),
				),
			call.timeoutMs,
		);
	});
}

/** `text` parsed as JSON, or a malformed-output error naming `label`. The output itself is never quoted. */
export function parseJson(label: string, text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new WorkerProvisionerError("malformed", `${label} printed output that is not JSON.`);
	}
}
