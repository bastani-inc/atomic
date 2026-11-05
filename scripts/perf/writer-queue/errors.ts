export type WriterQueueBenchmarkConfigErrorCode = "invalid-option";
export type WriterQueueBenchmarkWorkerErrorCode = "worker-exited" | "worker-error" | "worker-protocol";
export type WriterQueueBenchmarkErrorCode = WriterQueueBenchmarkConfigErrorCode | WriterQueueBenchmarkWorkerErrorCode;
export type WriterQueueBenchmarkErrorName =
	| "WriterQueueBenchmarkError"
	| "WriterQueueBenchmarkConfigError"
	| "WriterQueueBenchmarkWorkerError";

export type WriterQueueBenchmarkConfigReason =
	| "unexpected-argument"
	| "unknown-flag"
	| "repeated-flag"
	| "missing-value"
	| "out-of-range"
	| "unknown-scenario"
	| "unknown-runtime"
	| "unknown-revision"
	| "missing-storage-directory"
	| "not-a-file-path"
	| "git-unavailable";

export class WriterQueueBenchmarkError extends Error {
	override readonly name: WriterQueueBenchmarkErrorName = "WriterQueueBenchmarkError";
	readonly code: WriterQueueBenchmarkErrorCode;
	readonly retryable = false as const;
	declare readonly hint?: string;
	declare readonly cleanupCause?: unknown;
	constructor(code: WriterQueueBenchmarkErrorCode, message: string, hint?: string, options?: ErrorOptions) {
		super(`${message} (${code})${hint === undefined ? "" : `. ${hint}`}`, options);
		this.code = code;
		if (hint !== undefined) this.hint = hint;
	}
}

export class WriterQueueBenchmarkConfigError extends WriterQueueBenchmarkError {
	override readonly name = "WriterQueueBenchmarkConfigError" as const;
	declare readonly code: WriterQueueBenchmarkConfigErrorCode;
	readonly source = "cli" as const;
	readonly field: string;
	readonly reason: WriterQueueBenchmarkConfigReason;
	constructor(field: string, reason: WriterQueueBenchmarkConfigReason, hint?: string, options?: ErrorOptions) {
		super("invalid-option", `Invalid benchmark option: ${field} (${reason})`, hint, options);
		this.field = field;
		this.reason = reason;
	}
}

export class WriterQueueBenchmarkWorkerError extends WriterQueueBenchmarkError {
	override readonly name = "WriterQueueBenchmarkWorkerError" as const;
	declare readonly code: WriterQueueBenchmarkWorkerErrorCode;
	readonly worker: string;
	readonly phase: string;
	readonly exitCode: number | null;
	readonly signal: string | null;
	constructor(
		code: WriterQueueBenchmarkWorkerErrorCode,
		fields: {
			readonly worker: string;
			readonly phase: string;
			readonly exitCode?: number | null;
			readonly signal?: string | null;
		},
		options?: ErrorOptions,
	) {
		const outcome =
			code === "worker-exited"
				? `exited ${fields.signal ? `on ${fields.signal}` : `with code ${fields.exitCode ?? "unknown"}`}`
				: code === "worker-error"
					? "could not run"
					: "broke the line protocol";
		super(
			code,
			`Benchmark worker ${fields.worker} ${outcome} while the benchmark waited for ${fields.phase}`,
			"Read the worker's own error printed above on stderr, fix it, and rerun",
			options,
		);
		this.worker = fields.worker;
		this.phase = fields.phase;
		this.exitCode = fields.exitCode ?? null;
		this.signal = fields.signal ?? null;
	}
}

function hasNameAndCode(value: unknown, name: string, codes: readonly string[]): boolean {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { readonly name?: unknown; readonly code?: unknown };
	return candidate.name === name && typeof candidate.code === "string" && codes.includes(candidate.code);
}

export function isWriterQueueBenchmarkConfigError(value: unknown): value is WriterQueueBenchmarkConfigError {
	return (
		value instanceof WriterQueueBenchmarkConfigError ||
		hasNameAndCode(value, "WriterQueueBenchmarkConfigError", ["invalid-option"])
	);
}

export function isWriterQueueBenchmarkWorkerError(value: unknown): value is WriterQueueBenchmarkWorkerError {
	return (
		value instanceof WriterQueueBenchmarkWorkerError ||
		hasNameAndCode(value, "WriterQueueBenchmarkWorkerError", ["worker-exited", "worker-error", "worker-protocol"])
	);
}

export function isWriterQueueBenchmarkError(value: unknown): value is WriterQueueBenchmarkError {
	return (
		value instanceof WriterQueueBenchmarkError ||
		hasNameAndCode(value, "WriterQueueBenchmarkError", [
			"invalid-option",
			"worker-exited",
			"worker-error",
			"worker-protocol",
		]) ||
		isWriterQueueBenchmarkConfigError(value) ||
		isWriterQueueBenchmarkWorkerError(value)
	);
}
