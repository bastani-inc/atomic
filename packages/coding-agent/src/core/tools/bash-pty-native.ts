import { setTimeout as poll } from "node:timers/promises";
import { createChildProcessEnvironment } from "../../utils/child-process.ts";
import { createModuleRequire } from "../../utils/module-require.ts";
import { getShellConfig, getShellEnv, type ShellConfig } from "../../utils/shell.ts";
import type { OperationId, TaskId, WaitOutcome, WaitPolicy } from "../tasks/contracts.js";
import type { OwnerLease, TaskLease, TaskSupervisor, WaitLease } from "../tasks/supervisor.js";
import { OutputAccumulator, type OutputAccumulatorOptions } from "./output-accumulator.ts";
import { completeUtf8PrefixLength } from "./persisted-output-file.ts";

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

type NativeLoadResult = { ok: true; binding: NativePtyBinding } | { ok: false; error: Error };

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
			error: new Error(
				`Native PTY package ${NATIVE_PACKAGE} is unavailable for ${process.platform}-${process.arch}: ${error instanceof Error ? error.message : String(error)}`,
			),
		};
		return cachedLoadResult;
	}
}

export interface SupervisedCommandOwner {
	supervisor: TaskSupervisor;
	owner: OwnerLease;
	waitForTask?: (
		taskId: TaskId,
		budgetMs?: number,
		onRegistered?: (wait: WaitLease) => void,
	) => ReturnType<TaskSupervisor["waitForTaskId"]>;
	/** Narrow a shared owner to the tasks this binding launched. */
	ownsTask?: (taskId: TaskId) => boolean;
	onCommandStarted?: (taskId: TaskId) => void;
}

export function lookupOwnedTask(context: SupervisedCommandOwner, id: string): TaskLease {
	const taskId = id as TaskId;
	const task = context.supervisor.lookupTask(context.owner, taskId);
	if (!task.ok) throw new Error(`${task.error.code}: ${task.error.message}`);
	if (context.ownsTask && !context.ownsTask(taskId)) throw new Error("UnknownTask: task was not launched here");
	return task.value;
}
export interface SupervisedCommandResult {
	exitCode: number | null;
	observation?: WaitOutcome;
}

// Bind progress to the task capability, not a tool instance or replaceable session binding.
const yieldedOutputOffsets = new WeakMap<TaskLease, string>();

export async function waitForSupervisedCommand(
	context: SupervisedCommandOwner | undefined,
	id: string,
	budgetMs?: number,
	signal?: AbortSignal,
	outputOptions?: OutputAccumulatorOptions,
) {
	if (!context) throw new Error("Shell task wait requires a supported task owner");
	if (signal?.aborted) throw new Error("aborted");
	const task = lookupOwnedTask(context, id);
	let lease: WaitLease | undefined;
	const abort = () => {
		if (lease) context.supervisor.disposeTaskWait(lease);
	};
	signal?.addEventListener("abort", abort, { once: true });
	const output = new OutputAccumulator(outputOptions);
	try {
		const registered = (wait: WaitLease) => {
			lease = wait;
			if (signal?.aborted) abort();
		};
		const observed = await (context.waitForTask
			? context.waitForTask(id as TaskId, budgetMs, registered)
			: context.supervisor.waitForTaskId(context.owner, id as TaskId, budgetMs, registered));
		if (signal?.aborted) throw new Error("aborted");
		if (!observed.ok) throw new Error(`${observed.error.code}: ${observed.error.message}`);
		let offset: string | undefined =
			observed.value.kind === "yielded" ? (yieldedOutputOffsets.get(task) ?? "0") : "0";
		let nextOffset: string;
		do {
			const page = await context.supervisor.readTaskOutput(task, { start: offset, maximumBytes: 8192 });
			if (!page.ok) throw new Error(`${page.error.code}: ${page.error.message}`);
			const segments = [
				...page.value.chunks.map((chunk) => ({ offsets: chunk.offsets, bytes: Buffer.from(chunk.bytes) })),
				...page.value.omittedRanges.map((offsets) => ({
					offsets,
					bytes: Buffer.from(`\n[Output omitted: bytes ${offsets.start}-${offsets.end}]\n`),
				})),
			].sort((a, b) => (BigInt(a.offsets.start) < BigInt(b.offsets.start) ? -1 : 1));
			const bytes = Buffer.concat(segments.map((segment) => segment.bytes));
			const completeBytes = observed.value.kind === "yielded" ? completeUtf8PrefixLength(bytes) : bytes.length;
			output.append(bytes.subarray(0, completeBytes));
			// Re-read an incomplete UTF-8 suffix next time, including at the current live tail.
			nextOffset = page.value.nextOffset ?? segments.at(-1)?.offsets.end ?? offset;
			nextOffset = (BigInt(nextOffset) - BigInt(bytes.length - completeBytes)).toString();
			if (page.value.nextOffset !== undefined && observed.value.kind === "yielded")
				output.append(Buffer.from("\n[Additional output not shown; wait again to retrieve retained output.]\n"));
			offset = observed.value.kind === "yielded" ? undefined : page.value.nextOffset;
		} while (offset !== undefined);
		output.finish();
		const snapshot = output.snapshot({ persistIfTruncated: true });
		await output.closeTempFile();
		if (observed.value.kind === "yielded" && BigInt(nextOffset) > BigInt(yieldedOutputOffsets.get(task) ?? "0"))
			yieldedOutputOffsets.set(task, nextOffset);
		const terminal = observed.value.kind === "settled" ? observed.value.result : undefined;
		return {
			content: [
				{
					type: "text" as const,
					text: `${snapshot.content || "(no output)"}${snapshot.truncation.truncated ? "\n[Output truncated.]" : ""}\n\n${JSON.stringify(observed.value)}${snapshot.fullOutputPath ? `\nFull output: ${snapshot.fullOutputPath}` : ""}`,
				},
			],
			details: {
				observation: observed.value,
				...(terminal && "exitCode" in terminal ? { exitCode: terminal.exitCode } : {}),
				...(snapshot.truncation.truncated
					? { truncation: snapshot.truncation, fullOutputPath: snapshot.fullOutputPath }
					: {}),
			},
		};
	} finally {
		signal?.removeEventListener("abort", abort);
		await output.closeTempFile();
	}
}

export function validateBashWait(wait: WaitPolicy | undefined, ownerSupported = true): void {
	if (wait === undefined) return;
	if (
		!wait ||
		typeof wait !== "object" ||
		(wait.kind !== "background" && wait.kind !== "foreground") ||
		Object.keys(wait).some((key) => key !== "kind" && (wait.kind !== "foreground" || key !== "budgetMs")) ||
		(wait.kind === "foreground" &&
			wait.budgetMs !== undefined &&
			(typeof wait.budgetMs !== "number" || !Number.isFinite(wait.budgetMs) || wait.budgetMs < 0))
	)
		throw new Error("Invalid bash wait: expected background or foreground with a finite non-negative budgetMs");
	if (wait.kind === "background" && !ownerSupported)
		throw new Error("Background bash observation requires a supported task owner");
}

export async function executeSupervisedCommand(
	command: string,
	cwd: string,
	options: NativePtyExecOptions,
	pty: boolean,
): Promise<SupervisedCommandResult> {
	validateBashWait(options.wait, !!options.taskOwner);
	if (options.signal?.aborted) throw new Error("aborted");
	const context = options.taskOwner;
	if (!context) throw new Error("Supervised command requires its task owner");
	const shell = options.shellConfig ?? getShellConfig(options.shellPath);
	if (process.platform === "win32" && shell.commandTransport === "stdin")
		throw new Error("ContainmentUnavailable: run Atomic inside WSL to supervise Linux guest commands");
	const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
	const invocation = [shell.shell, ...shell.args].map(quote).join(" ");
	const environment = createChildProcessEnvironment(
		pty ? { TERM: "xterm-256color" } : undefined,
		options.env ?? getShellEnv(),
	);
	// Windows names are case-insensitive. Resolve ordered JS overrides before
	// crossing into the unordered native map, including explicit removals.
	const launchEnvironment = new Map<string, [string, string | undefined]>();
	for (const [key, value] of Object.entries(environment))
		launchEnvironment.set(process.platform === "win32" ? key.toUpperCase() : key, [key, value]);
	// The native command door merges env overrides. Clear omitted inherited shell
	// variables before invoking the configured shell, without embedding env values
	// (which may be secrets) into the retained command text.
	const omitted = Object.keys(process.env).filter(
		(key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && environment[key] === undefined,
	);
	const clearInherited = omitted.length ? `unset ${omitted.map(quote).join(" ")}; ` : "";
	const launch =
		shell.commandTransport === "stdin"
			? `printf %s ${quote(command)} | ${invocation}`
			: `exec ${invocation} ${quote(command)}`;
	const started = await context.supervisor.startCommandTask(
		context.owner,
		{
			kind: "command",
			command: process.platform === "win32" ? command : clearInherited + launch,
			description: options.commandDescription ?? command,
			cwd,
			env: Object.fromEntries(
				[...launchEnvironment.values()].filter((entry): entry is [string, string] => entry[1] !== undefined),
			),
			...(process.platform === "win32"
				? { shell: { program: shell.shell, args: shell.args }, inheritEnv: false }
				: {}),
			terminal: pty ? { kind: "pty", columns: options.cols ?? 120, rows: options.rows ?? 40 } : { kind: "pipe" },
			...(options.timeout === undefined ? {} : { executionTimeoutMs: options.timeout * 1000 }),
		},
		crypto.randomUUID() as OperationId,
	);
	if (!started.ok) throw new Error(`${started.error.code}: ${started.error.message}`);
	const task = started.value;
	context.onCommandStarted?.(context.supervisor.taskReference(task).taskId);
	const abort = () => {
		void context.supervisor.cancelTask(task, "user");
	};
	options.signal?.addEventListener("abort", abort, { once: true });
	if (options.signal?.aborted) abort();
	let done = false;
	let offset = "0";
	const observation = context.supervisor.initialObservation(task, options.wait).finally(() => {
		done = true;
	});
	const drain = async () => {
		const page = await context.supervisor.readTaskOutput(task, { start: offset, maximumBytes: 8192 });
		if (!page.ok) throw new Error(page.error.message);
		const segments = [
			...page.value.chunks.map((chunk) => ({ offsets: chunk.offsets, bytes: Buffer.from(chunk.bytes) })),
			...page.value.omittedRanges.map((offsets) => ({
				offsets,
				bytes: Buffer.from(`\n[Output omitted: bytes ${offsets.start}-${offsets.end}]\n`),
			})),
		].sort((a, b) => (BigInt(a.offsets.start) < BigInt(b.offsets.start) ? -1 : 1));
		for (const segment of segments) {
			options.onData(segment.bytes);
			offset = segment.offsets.end;
		}
		if (page.value.nextOffset !== undefined) offset = page.value.nextOffset;
		return page.value.nextOffset !== undefined;
	};
	try {
		while (!done) {
			if (!(await drain())) await poll(10);
		}
		const result = await observation;
		if (!result.ok) throw new Error(result.error.message);
		if (result.value.kind === "yielded") {
			await drain();
			return { exitCode: null, observation: result.value };
		}
		while (await drain()) {
			/* Terminal output is finite; no live producer extends this drain. */
		}
		const terminal = result.value.result;
		if (terminal.kind === "cancelled")
			throw new Error(terminal.cause === "execution-timeout" ? `timeout:${options.timeout}` : "aborted");
		if (terminal.kind === "failed") throw new Error(`${terminal.code}: ${terminal.message}`);
		return { exitCode: terminal.exitCode ?? null };
	} finally {
		options.signal?.removeEventListener("abort", abort);
	}
}

export interface NativePtyExecOptions {
	onData: (data: Buffer) => void;
	signal?: AbortSignal;
	timeout?: number;
	wait?: WaitPolicy;
	env?: NodeJS.ProcessEnv;
	shellPath?: string;
	shellConfig?: ShellConfig;
	commandDescription?: string;
	cols?: number;
	rows?: number;
	taskOwner?: SupervisedCommandOwner;
}

export async function executeNativePty(
	command: string,
	cwd: string,
	options: NativePtyExecOptions,
): Promise<SupervisedCommandResult> {
	validateBashWait(options.wait, !!options.taskOwner);
	if (options.taskOwner) return executeSupervisedCommand(command, cwd, options, true);
	const loaded = loadNativePtyBinding();
	if (!loaded.ok) throw loaded.error;
	if (options.signal?.aborted) throw new Error("aborted");
	const shellConfig = options.shellConfig ?? getShellConfig(options.shellPath);
	const session = new loaded.binding.PtySession();
	const onAbort = () => {
		try {
			session.kill();
		} catch {}
	};
	if (options.signal) options.signal.addEventListener("abort", onAbort, { once: true });
	try {
		const result = await session.start(
			{
				command,
				cwd,
				env: Object.fromEntries(
					Object.entries(
						createChildProcessEnvironment(
							{ TERM: "xterm-256color" },
							{ ...getShellEnv(), ...(options.env ?? {}) },
						),
					).filter((entry): entry is [string, string] => entry[1] !== undefined),
				),
				timeoutMs: options.timeout !== undefined ? Math.max(1, Math.floor(options.timeout * 1000)) : undefined,
				cols: options.cols ?? 120,
				rows: options.rows ?? 40,
				shell: shellConfig.shell,
				shellArgs: shellConfig.args,
				commandTransport: shellConfig.commandTransport,
				closeStdinAfterCommand: shellConfig.commandTransport === "stdin",
			},
			(_error, chunk) => {
				if (chunk) options.onData(Buffer.from(chunk));
			},
		);
		if (options.signal?.aborted || result.cancelled) throw new Error("aborted");
		if (result.timedOut ?? result.timed_out) throw new Error(`timeout:${options.timeout}`);
		return { exitCode: result.exitCode ?? result.exit_code ?? null };
	} finally {
		if (options.signal) options.signal.removeEventListener("abort", onAbort);
	}
}
