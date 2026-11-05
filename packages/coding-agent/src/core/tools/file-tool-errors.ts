import {
	hasErrorIdentity,
	rehydrateErrorCause,
	type SerializedErrorCause,
	serializeErrorCause,
} from "../error-contract.ts";

/**
 * Typed failures of the `edit` and `write` tools.
 *
 * Messages are the model-facing text upstream pi's tools return, kept verbatim so a model sees the same wording
 * here as in pi. Branch on `code` or the class instead: messages are not an API.
 */

/** Why an `edit` call failed. Codes are public API: never rename or reuse one. */
export type EditToolErrorCode =
	| "edits-empty"
	| "old-text-empty"
	| "text-not-found"
	| "text-not-unique"
	| "edits-overlap"
	| "no-change"
	| "target-inaccessible";

export type EditInputErrorCode = Extract<EditToolErrorCode, "edits-empty" | "old-text-empty">;
export type EditMatchErrorCode = Extract<
	EditToolErrorCode,
	"text-not-found" | "text-not-unique" | "edits-overlap" | "no-change"
>;
export type EditTargetErrorCode = Extract<EditToolErrorCode, "target-inaccessible">;

/** Why a `write` to a resource selector failed. Codes are public API: never rename or reuse one. */
export type WriteSelectorErrorCode =
	| "sqlite-query-parameters"
	| "sqlite-not-found"
	| "conflict-target-required"
	| "conflict-side-read-only"
	| "conflict-markers-not-found"
	| "conflict-target-invalid"
	| "conflict-id-not-found"
	| "unsupported-scheme";

const EDIT_TOOL_ERROR_HINTS: Readonly<Record<EditToolErrorCode, string>> = {
	"edits-empty": "Pass at least one { oldText, newText } replacement in edits.",
	"old-text-empty": "Give every oldText at least one character copied from the current file.",
	"text-not-found": "Read the file again and copy oldText exactly, including whitespace and newlines.",
	"text-not-unique": "Add surrounding lines to oldText until it matches exactly one location.",
	"edits-overlap": "Merge the overlapping edits into one edit, or target disjoint regions.",
	"no-change": "Make newText differ from oldText, or drop the edit.",
	"target-inaccessible": "Check that the file exists and is readable and writable, then retry.",
};

const WRITE_SELECTOR_ERROR_HINTS: Readonly<Record<WriteSelectorErrorCode, string>> = {
	"sqlite-query-parameters": "Write to a table or row selector without query parameters, such as db.sqlite:table:1.",
	"sqlite-not-found": "Check the database path; it must name an existing SQLite file.",
	"conflict-target-required": "Write to conflict://<id> or conflict://*.",
	"conflict-side-read-only": "Write the resolution to conflict://<id> or conflict://*; sides are read-only.",
	"conflict-markers-not-found": "Read conflict://* to list current conflicts; there are none under this directory.",
	"conflict-target-invalid": "Write to conflict://<id> with a numeric id from conflict://*, or to conflict://*.",
	"conflict-id-not-found": "Read conflict://* again and use one of the ids it lists.",
	"unsupported-scheme": "Write to a file path, an archive member, a SQLite selector, conflict:// or local://.",
};

const EDIT_INPUT_CODES: ReadonlySet<string> = new Set<EditInputErrorCode>(["edits-empty", "old-text-empty"]);
const EDIT_MATCH_CODES: ReadonlySet<string> = new Set<EditMatchErrorCode>([
	"text-not-found",
	"text-not-unique",
	"edits-overlap",
	"no-change",
]);
const EDIT_TARGET_CODES: ReadonlySet<string> = new Set<EditTargetErrorCode>(["target-inaccessible"]);
const EDIT_TOOL_CODES: ReadonlySet<string> = new Set([...EDIT_INPUT_CODES, ...EDIT_MATCH_CODES, ...EDIT_TARGET_CODES]);
const WRITE_SELECTOR_CODES: ReadonlySet<string> = new Set(Object.keys(WRITE_SELECTOR_ERROR_HINTS));
const ABORTED_CODES: ReadonlySet<string> = new Set(["aborted"]);

/** JSON-safe facts about a failed edit. Never carries file content. */
export interface EditToolErrorFields {
	/** The path as the caller passed it. */
	readonly path: string;
	/** Index of the failing entry in `edits`. */
	readonly editIndex?: number;
	/** Number of entries in `edits`. */
	readonly totalEdits?: number;
	/** How many times the failing `oldText` occurs. */
	readonly occurrences?: number;
	/** Index of the earlier edit that `editIndex` overlaps. */
	readonly overlapsEditIndex?: number;
	/** The filesystem error code of the access check, such as `ENOENT` or `EACCES`. */
	readonly errnoCode?: string;
}

/** JSON-safe facts about a failed selector write. */
export interface WriteSelectorErrorFields {
	/** The selector as the caller passed it. */
	readonly path: string;
	/** The conflict id a `conflict://` write named. */
	readonly conflictId?: string;
}

/** An `edit` call failed before changing the file. Every edit failure is non-retryable without a new call. */
export class EditToolError extends Error {
	override readonly name: string = "EditToolError";
	readonly code: EditToolErrorCode;
	readonly hint: string;
	readonly retryable = false;
	readonly fields: EditToolErrorFields;

	constructor(code: EditToolErrorCode, message: string, fields: EditToolErrorFields, options?: ErrorOptions) {
		super(message, options);
		this.code = code;
		this.hint = EDIT_TOOL_ERROR_HINTS[code];
		this.fields = fields;
	}
}

/** The `edit` arguments cannot describe a replacement: no edits, or an empty `oldText`. */
export class EditInputError extends EditToolError {
	override readonly name = "EditInputError";
	declare readonly code: EditInputErrorCode;

	constructor(code: EditInputErrorCode, message: string, fields: EditToolErrorFields, options?: ErrorOptions) {
		super(code, message, fields, options);
	}
}

/** An `oldText` is missing, ambiguous, overlaps another edit, or the edits change nothing. */
export class EditMatchError extends EditToolError {
	override readonly name = "EditMatchError";
	declare readonly code: EditMatchErrorCode;

	constructor(code: EditMatchErrorCode, message: string, fields: EditToolErrorFields, options?: ErrorOptions) {
		super(code, message, fields, options);
	}
}

/** The file to edit cannot be read and written. `cause` is the filesystem error. */
export class EditTargetError extends EditToolError {
	override readonly name = "EditTargetError";
	declare readonly code: EditTargetErrorCode;

	constructor(code: EditTargetErrorCode, message: string, fields: EditToolErrorFields, options?: ErrorOptions) {
		super(code, message, fields, options);
	}
}

/** A `write` to an archive, SQLite, `conflict://` or URL selector was refused before writing. */
export class WriteSelectorError extends Error {
	override readonly name: string = "WriteSelectorError";
	readonly code: WriteSelectorErrorCode;
	readonly hint: string;
	readonly retryable = false;
	readonly fields: WriteSelectorErrorFields;

	constructor(
		code: WriteSelectorErrorCode,
		message: string,
		fields: WriteSelectorErrorFields,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.code = code;
		this.hint = WRITE_SELECTOR_ERROR_HINTS[code];
		this.fields = fields;
	}
}

/**
 * An `edit` or `write` stopped because its signal aborted. This is a cancellation, not a failure: `cause` is the
 * signal's `reason`, and `name` is `AbortError` so generic cancellation checks recognise it.
 */
export class FileToolAbortedError extends Error {
	override readonly name = "AbortError";
	readonly code = "aborted";
	readonly retryable = false;

	constructor(reason?: unknown) {
		super("Operation aborted", reason === undefined ? undefined : { cause: reason });
	}
}

function hasNameAndCode(error: unknown, name: string, codes: ReadonlySet<string>): boolean {
	return hasErrorIdentity(error, new Set([name]), codes);
}

/** True for any {@link EditToolError}, including one from another realm or a structural copy. */
export function isEditToolError(error: unknown): error is EditToolError {
	return (
		error instanceof EditToolError ||
		isEditInputError(error) ||
		isEditMatchError(error) ||
		isEditTargetError(error) ||
		hasNameAndCode(error, "EditToolError", EDIT_TOOL_CODES)
	);
}

export function isEditInputError(error: unknown): error is EditInputError {
	return error instanceof EditInputError || hasNameAndCode(error, "EditInputError", EDIT_INPUT_CODES);
}

export function isEditMatchError(error: unknown): error is EditMatchError {
	return error instanceof EditMatchError || hasNameAndCode(error, "EditMatchError", EDIT_MATCH_CODES);
}

export function isEditTargetError(error: unknown): error is EditTargetError {
	return error instanceof EditTargetError || hasNameAndCode(error, "EditTargetError", EDIT_TARGET_CODES);
}

export function isWriteSelectorError(error: unknown): error is WriteSelectorError {
	return error instanceof WriteSelectorError || hasNameAndCode(error, "WriteSelectorError", WRITE_SELECTOR_CODES);
}

export function isFileToolAbortedError(error: unknown): error is FileToolAbortedError {
	return error instanceof FileToolAbortedError || hasNameAndCode(error, "AbortError", ABORTED_CODES);
}

export type { SerializedErrorCause };

/** An {@link EditToolError} or {@link WriteSelectorError} as JSON. */
export interface SerializedFileToolError {
	readonly name: string;
	readonly code: string;
	readonly message: string;
	readonly hint: string;
	readonly fields: EditToolErrorFields | WriteSelectorErrorFields;
	readonly cause?: SerializedErrorCause;
}

export function serializeFileToolError(error: EditToolError | WriteSelectorError): SerializedFileToolError {
	const cause = serializeErrorCause(error.cause);
	return {
		name: error.name,
		code: error.code,
		message: error.message,
		hint: error.hint,
		fields: { ...error.fields },
		...(cause ? { cause } : {}),
	};
}

function causeOptions(value: SerializedFileToolError): ErrorOptions | undefined {
	const cause = rehydrateErrorCause(value.cause);
	return cause ? { cause } : undefined;
}

function keepForeignIdentity<T extends Error>(error: T, value: SerializedFileToolError): T {
	if (error.name !== value.name) Object.defineProperty(error, "name", { value: value.name });
	return error;
}

/**
 * Rebuild a serialized {@link EditToolError} as the same class. A name or code this version does not know becomes
 * an `EditToolError` that keeps the original `name`, `code` and `hint`.
 */
export function rehydrateEditToolError(value: SerializedFileToolError): EditToolError {
	const options = causeOptions(value);
	const fields = value.fields as EditToolErrorFields;
	if (value.name === "EditInputError" && EDIT_INPUT_CODES.has(value.code))
		return new EditInputError(value.code as EditInputErrorCode, value.message, fields, options);
	if (value.name === "EditMatchError" && EDIT_MATCH_CODES.has(value.code))
		return new EditMatchError(value.code as EditMatchErrorCode, value.message, fields, options);
	if (value.name === "EditTargetError" && EDIT_TARGET_CODES.has(value.code))
		return new EditTargetError(value.code as EditTargetErrorCode, value.message, fields, options);
	const base = new EditToolError(value.code as EditToolErrorCode, value.message, fields, options);
	Object.defineProperty(base, "hint", { value: value.hint });
	return keepForeignIdentity(base, value);
}

/**
 * Rebuild a serialized {@link WriteSelectorError}. A name or code this version does not know keeps the original
 * `name`, `code` and `hint`.
 */
export function rehydrateWriteSelectorError(value: SerializedFileToolError): WriteSelectorError {
	const error = new WriteSelectorError(
		value.code as WriteSelectorErrorCode,
		value.message,
		value.fields as WriteSelectorErrorFields,
		causeOptions(value),
	);
	Object.defineProperty(error, "hint", { value: value.hint });
	return keepForeignIdentity(error, value);
}
