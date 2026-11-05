// @ts-check
/**
 * Bounded execution of `az`, `ssh`, `scp` and `crabbox` with argument arrays (never a local shell), typed failures,
 * cancellation through `AbortSignal`, and a redacted command log.
 */
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import {
	attachConcurrentFailures,
	DistributedCommandError,
	DistributedTimeoutError,
	isRetryableDistributedError,
} from "./errors.mjs";

/**
 * @typedef {{ log?: string, secrets: Set<string> }} CommandContext
 * @typedef {{ operation: string, timeoutMs: number, signal?: AbortSignal, input?: string | Buffer,
 *   retryableExitCodes?: readonly number[], allowExitCodes?: readonly number[], cwd?: string }} CommandOptions
 * @typedef {{ exitCode: number, stdout: string, stderr: string, elapsedMs: number }} CommandResult
 */

/**
 * Replaces every registered secret, and anything that looks like a bearer token or JWT, with a marker.
 * @param {string} text
 * @param {Iterable<string>} secrets
 */
export function redact(text, secrets) {
	let out = text;
	for (const secret of secrets) if (secret.length >= 8) out = out.split(secret).join("[redacted]");
	return out
		.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted-jwt]")
		.replace(/(authorization:\s*bearer\s+)\S+/gi, "$1[redacted]")
		.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted-private-key]");
}

/**
 * @param {CommandContext} context
 * @param {string} line
 */
function logLine(context, line) {
	if (context.log !== undefined)
		appendFileSync(context.log, `${new Date().toISOString()} ${redact(line, context.secrets)}\n`);
}

/**
 * Runs one command. Exit codes in `allowExitCodes` (and 0) succeed; others throw `DistributedCommandError`, retryable
 * when listed in `retryableExitCodes`. A timeout throws `DistributedTimeoutError`; an abort rejects with the signal's
 * reason, untouched.
 * @param {CommandContext} context
 * @param {string} tool
 * @param {readonly string[]} args
 * @param {CommandOptions} options
 * @returns {Promise<CommandResult>}
 */
export function runCommand(context, tool, args, options) {
	const { operation, timeoutMs, signal, input, retryableExitCodes = [], allowExitCodes = [], cwd } = options;
	if (signal?.aborted) return Promise.reject(signal.reason);
	const started = performance.now();
	logLine(context, `$ ${tool} ${args.join(" ")}  # ${operation}`);
	return new Promise((resolve, reject) => {
		const child = spawn(tool, args, { cwd, detached: true });
		const killGroup = () => {
			try {
				process.kill(-(/** @type {number} */ (child.pid)), "SIGKILL");
			} catch (error) {
				logLine(
					context,
					`kill of ${tool} ${operation} found no process group: ${Reflect.get(/** @type {object} */ (error), "code")}`,
				);
			}
		};
		/** @type {Buffer[]} */
		const stdout = [];
		/** @type {Buffer[]} */
		const stderr = [];
		let settled = false;
		/** @type {unknown} */
		let interruption;
		const timer = setTimeout(() => {
			interruption = new DistributedTimeoutError({
				phase: operation,
				timeoutMs,
				elapsedMs: Math.round(performance.now() - started),
			});
			killGroup();
		}, timeoutMs);
		const onAbort = (/** @type {Event} */ event) => {
			interruption = /** @type {AbortSignal} */ (event.target).reason;
			killGroup();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (chunk) => stdout.push(chunk));
		child.stderr.on("data", (chunk) => stderr.push(chunk));
		/** @param {() => void} action */
		const finish = (action) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			action();
		};
		child.on("error", (cause) =>
			finish(() =>
				reject(
					new DistributedCommandError({
						tool,
						operation,
						exitCode: null,
						signal: null,
						detail: "spawn failed",
						cause,
					}),
				),
			),
		);
		child.on("close", (code, killSignal) =>
			finish(() => {
				const elapsedMs = Math.round(performance.now() - started);
				const out = Buffer.concat(stdout).toString("utf8");
				const err = Buffer.concat(stderr).toString("utf8");
				logLine(
					context,
					`= ${tool} ${operation} exit=${code ?? killSignal} ${elapsedMs}ms${err.trim() === "" ? "" : `\n  stderr: ${err.trim().slice(-2000)}`}`,
				);
				if (interruption !== undefined) return reject(interruption);
				if (code === 0 || (code !== null && allowExitCodes.includes(code)))
					return resolve({ exitCode: code, stdout: out, stderr: err, elapsedMs });
				reject(
					new DistributedCommandError({
						tool,
						operation,
						exitCode: code,
						signal: killSignal,
						retryable: code !== null && retryableExitCodes.includes(code),
						detail: redact(err.trim().split("\n").slice(-3).join(" | ").slice(0, 400), context.secrets),
					}),
				);
			}),
		);
		child.stdin.on("error", (error) =>
			logLine(context, `stdin of ${tool} ${operation} closed early: ${Reflect.get(error, "code")}`),
		);
		child.stdin.end(input);
	});
}

/**
 * Runs an `az` command with `-o json` and parses its output.
 * @template T
 * @param {CommandContext} context
 * @param {readonly string[]} args
 * @param {CommandOptions} options
 * @returns {Promise<T>}
 */
export async function azJson(context, args, options) {
	const result = await runCommand(context, "az", [...args, "-o", "json", "--only-show-errors"], options);
	const text = result.stdout.trim();
	if (text === "") return /** @type {T} */ (/** @type {unknown} */ (null));
	try {
		return JSON.parse(text);
	} catch (cause) {
		throw new DistributedCommandError({
			tool: "az",
			operation: options.operation,
			exitCode: 0,
			signal: null,
			detail: "output was not JSON",
			cause,
		});
	}
}

/**
 * Retries `action` while it fails retryably, waiting `delayMs` between attempts.
 * @template T
 * @param {() => Promise<T>} action
 * @param {{ attempts: number, delayMs: number, signal?: AbortSignal }} options
 * @returns {Promise<T>}
 */
export async function retrying(action, { attempts, delayMs, signal }) {
	for (let attempt = 1; ; attempt++) {
		try {
			return await action();
		} catch (error) {
			if (attempt >= attempts || !isRetryableDistributedError(error) || signal?.aborted) throw error;
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}
}

/**
 * Quotes one word for a POSIX shell on the remote side of `ssh`.
 * @param {string} word
 */
export function shellQuote(word) {
	return /^[A-Za-z0-9_./:=@%+,-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * Waits for every operation to settle before failing with the first rejection, so no create is still in flight when
 * the caller starts tearing down. The other rejections are attached to it as `concurrentFailures`.
 * @template T
 * @param {readonly Promise<T>[]} operations
 * @returns {Promise<T[]>}
 */
export async function settleAll(operations) {
	const settled = await Promise.allSettled(operations);
	const reasons = settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
	if (reasons.length > 0) throw attachConcurrentFailures(reasons[0], reasons.slice(1));
	return settled.map((result) => /** @type {PromiseFulfilledResult<T>} */ (result).value);
}
