import { type ChildProcess, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
	isWriterQueueBenchmarkError,
	WriterQueueBenchmarkConfigError,
	WriterQueueBenchmarkWorkerError,
} from "./errors.js";

export function parseFlags(argv: readonly string[], known: readonly string[]): ReadonlyMap<string, string> {
	const flags = new Map<string, string>();
	const supported = known.map((name) => `--${name}`).join(", ");
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index]!;
		if (!flag.startsWith("--"))
			throw new WriterQueueBenchmarkConfigError(
				flag,
				"unexpected-argument",
				`Pass options as flag value pairs: ${supported}`,
			);
		const name = flag.slice(2);
		if (!known.includes(name))
			throw new WriterQueueBenchmarkConfigError(flag, "unknown-flag", `Supported flags: ${supported}`);
		if (flags.has(name)) throw new WriterQueueBenchmarkConfigError(flag, "repeated-flag", `Pass ${flag} once`);
		const text = argv[index + 1];
		if (text === undefined || text.startsWith("--"))
			throw new WriterQueueBenchmarkConfigError(flag, "missing-value", `Pass a value after ${flag}`);
		flags.set(name, text);
	}
	return flags;
}

export interface NumberRule {
	readonly min: number;
	readonly integer?: boolean;
	readonly unit: string;
}

export function parseNumber(flag: string, text: string, rule: NumberRule): number {
	const value = text.trim() === "" ? Number.NaN : Number(text);
	if (!Number.isFinite(value) || value < rule.min || (rule.integer === true && !Number.isInteger(value)))
		throw new WriterQueueBenchmarkConfigError(
			flag,
			"out-of-range",
			`Pass ${flag} as ${rule.integer === true ? "a whole" : "a finite"} number of ${rule.unit}, ${rule.min} or more`,
		);
	return value;
}

export function parseNumberList(flag: string, text: string, rule: NumberRule): readonly number[] {
	return text.split(",").map((item) => parseNumber(flag, item, rule));
}

function git(args: readonly string[], cwd: string): number | null {
	const result = spawnSync("git", [...args], { cwd, stdio: "ignore" });
	if (result.error !== undefined)
		throw new WriterQueueBenchmarkConfigError(
			"git",
			"git-unavailable",
			"Install git and put it on PATH; the benchmark reads the baseline revision from it",
			{ cause: result.error },
		);
	return result.status;
}

export function verifyBaseline(flag: string, revision: string, directory: string, cwd: string): void {
	if (git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${revision}^{commit}`], cwd) !== 0)
		throw new WriterQueueBenchmarkConfigError(
			flag,
			"unknown-revision",
			`Pass ${flag} as a commit, tag, or branch that exists in this checkout`,
		);
	if (git(["cat-file", "-e", "--end-of-options", `${revision}:${directory}`], cwd) !== 0)
		throw new WriterQueueBenchmarkConfigError(
			flag,
			"missing-storage-directory",
			`Pass ${flag} as a revision that already has the storage sources; ${revision} does not`,
		);
}

export function verifyOutputPath(flag: string, path: string): string {
	const target = resolve(path);
	const parent = dirname(target);
	if (
		(existsSync(target) && statSync(target).isDirectory()) ||
		(existsSync(parent) && !statSync(parent).isDirectory())
	)
		throw new WriterQueueBenchmarkConfigError(
			flag,
			"not-a-file-path",
			`Pass ${flag} as a file path whose parent is a directory`,
		);
	return target;
}

export function reportFailure(error: unknown): void {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	if (process.env.ATOMIC_PERF_DEBUG === "1" && error instanceof Error && error.stack !== undefined)
		process.stderr.write(`${error.stack}\n`);
	if (isWriterQueueBenchmarkError(error) && error.cleanupCause !== undefined)
		process.stderr.write(`Cleanup after the failure also failed: ${String(error.cleanupCause)}\n`);
	process.exitCode = 1;
}

export async function withCleanup<T>(work: () => Promise<T>, cleanup: () => Promise<void> | void): Promise<T> {
	let result: T;
	try {
		result = await work();
	} catch (error) {
		try {
			await cleanup();
		} catch (cleanupCause) {
			if (Object.isExtensible(error) && !("cleanupCause" in (error as object)))
				Object.defineProperty(error, "cleanupCause", { value: cleanupCause });
			else process.stderr.write(`Cleanup after the failure also failed: ${String(cleanupCause)}\n`);
		}
		throw error;
	}
	await cleanup();
	return result;
}

interface PendingRead {
	readonly phase: string;
	readonly resolve: (line: string) => void;
	readonly reject: (error: unknown) => void;
}

const OUTPUT_CLOSE_GRACE_MS = 250;

export class WorkerChannel {
	readonly label: string;
	private readonly child: ChildProcess;
	private buffered = "";
	private readonly queued: string[] = [];
	private readonly waiting: PendingRead[] = [];
	private end: { readonly code: number | null; readonly signal: string | null } | undefined;
	private cause: unknown;
	private outputClosed = false;
	private outputGrace: ReturnType<typeof setTimeout> | undefined;
	private readonly closed: Promise<void>;

	constructor(child: ChildProcess, label: string) {
		this.child = child;
		this.label = label;
		let finish: () => void = () => undefined;
		this.closed = new Promise((resolve) => {
			finish = resolve;
		});
		child.stdout!.setEncoding("utf8");
		child.stdout!.on("data", (chunk: string) => this.receive(chunk));
		child.stdout!.on("end", () => this.outputEnded());
		child.stdout!.on("error", (cause) => {
			this.cause ??= cause;
			this.outputEnded();
		});
		child.stdin!.on("error", (cause) => {
			this.cause ??= cause;
		});
		child.once("error", (cause) => {
			this.cause ??= cause;
		});
		child.once("close", (code, signal) => {
			clearTimeout(this.outputGrace);
			this.end = { code, signal };
			for (const pending of this.waiting.splice(0)) pending.reject(this.failure(pending.phase));
			finish();
		});
	}

	get pid(): number | undefined {
		return this.child.pid;
	}

	private receive(chunk: string): void {
		this.buffered += chunk;
		for (let end = this.buffered.indexOf("\n"); end !== -1; end = this.buffered.indexOf("\n")) {
			const line = this.buffered.slice(0, end);
			this.buffered = this.buffered.slice(end + 1);
			const next = this.waiting.shift();
			if (next === undefined) this.queued.push(line);
			else next.resolve(line);
		}
	}

	private outputEnded(): void {
		this.outputGrace ??= setTimeout(() => {
			this.outputClosed = true;
			for (const pending of this.waiting.splice(0)) pending.reject(this.failure(pending.phase));
		}, OUTPUT_CLOSE_GRACE_MS);
	}

	private failure(phase: string): WriterQueueBenchmarkWorkerError {
		const options = this.cause === undefined ? undefined : { cause: this.cause };
		if (this.child.pid === undefined)
			return new WriterQueueBenchmarkWorkerError("worker-error", { worker: this.label, phase }, options);
		if (this.end === undefined)
			return new WriterQueueBenchmarkWorkerError("worker-protocol", { worker: this.label, phase }, options);
		return new WriterQueueBenchmarkWorkerError(
			"worker-exited",
			{ worker: this.label, phase, exitCode: this.end.code, signal: this.end.signal },
			options,
		);
	}

	next(phase: string): Promise<string> {
		const line = this.queued.shift();
		if (line !== undefined) return Promise.resolve(line);
		if (this.end !== undefined || this.outputClosed) return Promise.reject(this.failure(phase));
		return new Promise((resolve, reject) => this.waiting.push({ phase, resolve, reject }));
	}

	assertRunning(phase: string): void {
		if (this.end !== undefined || this.outputClosed) throw this.failure(phase);
	}

	send(line: string): void {
		this.child.stdin!.end(`${line}\n`);
	}

	async finished(phase: string): Promise<void> {
		await this.closed;
		if (this.end!.code !== 0) throw this.failure(phase);
	}

	async stop(): Promise<void> {
		this.child.kill("SIGKILL");
		await this.closed;
	}
}
