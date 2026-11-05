import { dirname } from "node:path";

/** Every code of the {@link DebugError} family. */
export type DebugErrorCode = "debug-log-unwritable" | "invalid-setting";

/** Where a debug setting came from: the RPC `set_debug` command, or a direct `setDebugSetting` call. */
export type DebugSettingSource = "rpc" | "sdk";

/** The family of debug output errors. */
export class DebugError extends Error {
	override readonly name: string = "DebugError";
	readonly code: DebugErrorCode;
	/** What to do about it, without the rest of the message. */
	readonly hint: string;
	readonly retryable: boolean = false;
	constructor(code: DebugErrorCode, message: string, hint: string, options?: ErrorOptions) {
		super(message, options);
		this.code = code;
		this.hint = hint;
	}
	/** The facts this error carries, as JSON-safe text. */
	fields(): Readonly<Record<string, string>> {
		return {};
	}
}

/** A debug log file could not be written. Atomic keeps running; that debug output is lost. */
export class DebugLogUnwritableError extends DebugError {
	override readonly name = "DebugLogUnwritableError" as const;
	declare readonly code: "debug-log-unwritable";
	override readonly retryable = false as const;
	readonly path: string;
	constructor(path: string, options?: ErrorOptions) {
		const hint = `Make ${dirname(path)} writable, or turn debug mode off.`;
		super(
			"debug-log-unwritable",
			`Debug log is not writable: ${path} (debug-log-unwritable). ${hint}`,
			hint,
			options,
		);
		this.path = path;
	}
	override fields(): Readonly<Record<string, string>> {
		return { path: this.path };
	}
}

/** The facts a {@link DebugConfigError} carries. */
export interface DebugConfigErrorFields {
	readonly source: DebugSettingSource;
	/** The type of the value received, never the value itself. */
	readonly received: string;
}

/** The debug setting was given something other than `true` or `false`. Nothing changed. */
export class DebugConfigError extends DebugError {
	override readonly name = "DebugConfigError" as const;
	declare readonly code: "invalid-setting";
	override readonly retryable = false as const;
	readonly source: DebugSettingSource;
	readonly field = "enabled" as const;
	/** The type of the value received, never the value itself. */
	readonly received: string;
	constructor({ source, received }: DebugConfigErrorFields) {
		const hint = "Pass true or false.";
		super(
			"invalid-setting",
			`Invalid debug setting: enabled is ${received}, not a boolean (invalid-setting). ${hint}`,
			hint,
		);
		this.source = source;
		this.received = received;
	}
	override fields(): Readonly<Record<string, string>> {
		return { source: this.source, field: this.field, received: this.received };
	}
}

/** A cause outside the {@link DebugError} family, as it crosses a process boundary: its name and message only. */
export interface SerializedErrorCause {
	readonly name: string;
	readonly message: string;
}

/** A {@link DebugError} as it crosses a process boundary. */
export interface SerializedDebugError {
	readonly name: string;
	readonly code: string;
	readonly message: string;
	readonly hint: string;
	readonly retryable: boolean;
	readonly fields: Readonly<Record<string, string>>;
	readonly cause?: SerializedDebugError | SerializedErrorCause;
}

const MAX_CAUSE_DEPTH = 8;

/** `error` as JSON-safe data, its cause chain cut after eight errors. {@link rehydrateDebugError} reverses it. */
export function serializeDebugError(error: DebugError, depth = 0): SerializedDebugError {
	const serialized = {
		name: error.name,
		code: error.code,
		message: error.message,
		hint: error.hint,
		retryable: error.retryable,
		fields: error.fields(),
	};
	const { cause } = error;
	if (cause === undefined || depth + 1 >= MAX_CAUSE_DEPTH) return serialized;
	if (cause instanceof DebugError) return { ...serialized, cause: serializeDebugError(cause, depth + 1) };
	const other = cause instanceof Error ? cause : new Error(String(cause));
	return { ...serialized, cause: { name: other.name, message: other.message } };
}

/** A {@link DebugError} whose class this process does not know; it keeps the name, code and fields it arrived with. */
class ForeignDebugError extends DebugError {
	override readonly name: string;
	override readonly retryable: boolean;
	private readonly carried: Readonly<Record<string, string>>;
	constructor(serialized: SerializedDebugError, options?: ErrorOptions) {
		super(serialized.code as DebugErrorCode, serialized.message, serialized.hint, options);
		this.name = serialized.name;
		this.retryable = serialized.retryable;
		this.carried = serialized.fields;
	}
	override fields(): Readonly<Record<string, string>> {
		return this.carried;
	}
}

function rehydrateCause(cause: SerializedDebugError | SerializedErrorCause): Error {
	if ("code" in cause) return rehydrateDebugError(cause);
	const error = new Error(cause.message);
	error.name = cause.name;
	return error;
}

/** The error {@link serializeDebugError} described, as the same class with the same fields. */
export function rehydrateDebugError(serialized: SerializedDebugError): DebugError {
	const options = serialized.cause === undefined ? undefined : { cause: rehydrateCause(serialized.cause) };
	const { path, source, received } = serialized.fields;
	if (serialized.name === "DebugLogUnwritableError" && path !== undefined)
		return new DebugLogUnwritableError(path, options);
	if (serialized.name === "DebugConfigError" && (source === "rpc" || source === "sdk") && received !== undefined)
		return new DebugConfigError({ source, received });
	return new ForeignDebugError(serialized, options);
}

const DEBUG_ERROR_NAMES: ReadonlySet<unknown> = new Set(["DebugError", "DebugLogUnwritableError", "DebugConfigError"]);
const DEBUG_LOG_UNWRITABLE_NAMES: ReadonlySet<unknown> = new Set(["DebugLogUnwritableError"]);
const DEBUG_CONFIG_NAMES: ReadonlySet<unknown> = new Set(["DebugConfigError"]);

function hasStructure(value: unknown, names: ReadonlySet<unknown>, code?: DebugErrorCode): boolean {
	if (typeof value !== "object" || value === null) return false;
	const fields = value as { readonly name?: unknown; readonly code?: unknown };
	return names.has(fields.name) && typeof fields.code === "string" && (code === undefined || fields.code === code);
}

/** Whether `value` is a {@link DebugError}, also one that crossed a realm or process boundary. */
export function isDebugError(value: unknown): value is DebugError {
	return value instanceof DebugError || hasStructure(value, DEBUG_ERROR_NAMES);
}

/** Whether `value` is a {@link DebugLogUnwritableError}, also one that crossed a realm or process boundary. */
export function isDebugLogUnwritableError(value: unknown): value is DebugLogUnwritableError {
	return (
		value instanceof DebugLogUnwritableError ||
		hasStructure(value, DEBUG_LOG_UNWRITABLE_NAMES, "debug-log-unwritable")
	);
}

/** Whether `value` is a {@link DebugConfigError}, also one that crossed a realm or process boundary. */
export function isDebugConfigError(value: unknown): value is DebugConfigError {
	return value instanceof DebugConfigError || hasStructure(value, DEBUG_CONFIG_NAMES, "invalid-setting");
}
