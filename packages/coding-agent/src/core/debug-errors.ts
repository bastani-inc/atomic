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
	constructor(source: DebugSettingSource, value: unknown) {
		const received = value === null ? "null" : typeof value;
		const hint = "Pass true or false.";
		super(
			"invalid-setting",
			`Invalid debug setting: enabled is ${received}, not a boolean (invalid-setting). ${hint}`,
			hint,
		);
		this.source = source;
		this.received = received;
	}
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
