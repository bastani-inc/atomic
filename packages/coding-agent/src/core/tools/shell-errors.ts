import {
	type ErrorFieldValue,
	hasErrorIdentity,
	rehydrateErrorCause,
	type SerializedTypedError,
	serializeErrorCause,
} from "../error-contract.ts";

/** Stable codes of ShellToolError. Codes are public API: never rename or reuse one. */
export type ShellToolErrorCode = "shell-timeout";

/** What the shell was doing when its timeout hit. */
export type ShellTimeoutPhase = "running" | "draining-output";

/** The shell's own result when it exited before the deadline. */
export interface ShellExitBeforeTimeout {
	exitCode: number;
	/** Seconds from start to the shell's exit, rounded to a tenth. */
	afterSeconds: number;
}

const SHELL_TOOL_ERROR_CODES: ReadonlySet<string> = new Set<ShellToolErrorCode>(["shell-timeout"]);
const SHELL_TIMEOUT_NAMES: ReadonlySet<string> = new Set(["ShellTimeoutError"]);
const SHELL_TOOL_ERROR_NAMES: ReadonlySet<string> = new Set(["ShellToolError", "ShellTimeoutError"]);

const DRAINING_OUTPUT_HINT =
	"A process the command started in the background kept the output open. Redirect its output (`cmd > file 2>&1 &`) or run it as a background task.";
const RUNNING_HINT = "Raise `timeout` for a slow command, or run a long-lived one in the background.";

/** A built-in shell backend failed a command. Branch on `code` or the class. */
export class ShellToolError extends Error {
	override readonly name: string = "ShellToolError";
	readonly code: ShellToolErrorCode;
	readonly hint: string | undefined;
	readonly retryable: boolean;

	constructor(
		message: string,
		options: { code: ShellToolErrorCode; hint?: string; retryable: boolean; cause?: unknown },
	) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.code = options.code;
		this.hint = options.hint;
		this.retryable = options.retryable;
	}

	/** The JSON-safe facts beyond the name, code, message and hint. */
	get fields(): Record<string, ErrorFieldValue> {
		return {};
	}

	toJSON(): SerializedTypedError {
		const cause = serializeErrorCause(this.cause);
		return {
			name: this.name,
			code: this.code,
			message: this.message,
			...(this.hint === undefined ? {} : { hint: this.hint }),
			retryable: this.retryable,
			fields: this.fields,
			...(cause ? { cause } : {}),
		};
	}
}

/**
 * The local shell backend's timeout. The message stays `timeout:<seconds>`, the value custom `BashOperations`
 * throw, so code that reads that message keeps working; branch on the class or `code` instead. `phase` is
 * `"draining-output"` and `shellExit` is set when the shell itself exited before the deadline and only
 * background processes holding its stdout/stderr kept the tool waiting (pi #11613).
 */
export class ShellTimeoutError extends ShellToolError {
	override readonly name = "ShellTimeoutError" as const;
	declare readonly code: "shell-timeout";
	readonly timeoutMs: number;
	/** Time from start until the deadline fired. */
	readonly elapsedMs: number;
	readonly phase: ShellTimeoutPhase;
	readonly shellExit: ShellExitBeforeTimeout | undefined;

	constructor(options: { timeoutSeconds: number; elapsedMs: number; shellExit?: ShellExitBeforeTimeout }) {
		const phase: ShellTimeoutPhase = options.shellExit ? "draining-output" : "running";
		super(`timeout:${options.timeoutSeconds}`, {
			code: "shell-timeout",
			hint: phase === "draining-output" ? DRAINING_OUTPUT_HINT : RUNNING_HINT,
			retryable: false,
		});
		this.timeoutMs = options.timeoutSeconds * 1000;
		this.elapsedMs = options.elapsedMs;
		this.phase = phase;
		this.shellExit = options.shellExit;
	}

	get timeoutSeconds(): number {
		return this.timeoutMs / 1000;
	}

	/** The status line the bash tool appends to the command's output. */
	describe(): string {
		const status = `Command timed out after ${this.timeoutSeconds} seconds`;
		if (!this.shellExit) return status;
		// Both facts matter: the command's real result, and that its background processes were still writing
		// output when the timeout hit (pi #11613).
		return `${status}. The shell exited with code ${this.shellExit.exitCode} after ${this.shellExit.afterSeconds} seconds, but background processes it started kept writing output until the timeout.`;
	}

	override get fields(): Record<string, ErrorFieldValue> {
		return {
			timeoutMs: this.timeoutMs,
			elapsedMs: this.elapsedMs,
			phase: this.phase,
			shellExitCode: this.shellExit?.exitCode ?? null,
			shellExitAfterSeconds: this.shellExit?.afterSeconds ?? null,
		};
	}
}

/** Whether `error` is a ShellToolError, also from another realm or a rehydrated relay. */
export function isShellToolError(error: unknown): error is ShellToolError {
	return error instanceof ShellToolError || hasErrorIdentity(error, SHELL_TOOL_ERROR_NAMES, SHELL_TOOL_ERROR_CODES);
}

/** Whether `error` is a ShellTimeoutError, also from another realm or a rehydrated relay. */
export function isShellTimeoutError(error: unknown): error is ShellTimeoutError {
	return error instanceof ShellTimeoutError || hasErrorIdentity(error, SHELL_TIMEOUT_NAMES, SHELL_TOOL_ERROR_CODES);
}

/** Rebuilds a serialized ShellToolError; an unknown name becomes the family base with its name and code kept. */
export function rehydrateShellToolError(serialized: SerializedTypedError): ShellToolError {
	const { fields } = serialized;
	if (serialized.name === "ShellTimeoutError" && typeof fields.timeoutMs === "number") {
		const shellExit =
			typeof fields.shellExitCode === "number" && typeof fields.shellExitAfterSeconds === "number"
				? { exitCode: fields.shellExitCode, afterSeconds: fields.shellExitAfterSeconds }
				: undefined;
		return new ShellTimeoutError({
			timeoutSeconds: fields.timeoutMs / 1000,
			elapsedMs: typeof fields.elapsedMs === "number" ? fields.elapsedMs : fields.timeoutMs,
			...(shellExit ? { shellExit } : {}),
		});
	}
	const error = new ShellToolError(serialized.message, {
		code: serialized.code as ShellToolErrorCode,
		hint: serialized.hint,
		retryable: serialized.retryable,
		cause: rehydrateErrorCause(serialized.cause),
	});
	Object.defineProperty(error, "name", { value: serialized.name });
	return error;
}
