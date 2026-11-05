/** Where an admission setting came from: `RunOpts.admission`, or `workflows.admission` in settings. */
export type WorkflowAdmissionSource = "sdk" | "settings";

/** `user-limits-need-one-journal`: the default journal store keeps each root on its own shard. `user-database-mismatch`: `userDatabase` is not the run's journal file. */
export type WorkflowAdmissionConfigErrorCode = "user-limits-need-one-journal" | "user-database-mismatch";

/** Every code of the {@link WorkflowAdmissionError} family. */
export type WorkflowAdmissionErrorCode = WorkflowAdmissionConfigErrorCode;

/** Why `userDatabase` is not the run's journal file. */
export type WorkflowAdmissionMismatchReason = "unsupported-journal" | "missing" | "other-file";

const WORKFLOW_ADMISSION_ERROR_NAMES: ReadonlySet<unknown> = new Set([
	"WorkflowAdmissionError",
	"WorkflowAdmissionConfigError",
]);
const CONFIG_ERROR_NAMES: ReadonlySet<unknown> = new Set(["WorkflowAdmissionConfigError"]);
const CONFIG_ERROR_CODES: ReadonlySet<unknown> = new Set<WorkflowAdmissionConfigErrorCode>([
	"user-limits-need-one-journal",
	"user-database-mismatch",
]);
const MAX_CAUSE_DEPTH = 8;

/** The family of resource admission errors. Catch it, or a concrete class, and branch on `code`. */
export class WorkflowAdmissionError extends Error {
	override readonly name: string = "WorkflowAdmissionError";
	readonly code: WorkflowAdmissionErrorCode;
	/** What to do about it, without the rest of the message. */
	readonly hint: string;
	readonly retryable: boolean = false;
	constructor(code: WorkflowAdmissionErrorCode, message: string, hint: string, options?: ErrorOptions) {
		super(message, options);
		this.code = code;
		this.hint = hint;
	}
}

export interface WorkflowAdmissionConfigErrorFields {
	readonly code: WorkflowAdmissionConfigErrorCode;
	readonly source: WorkflowAdmissionSource;
	/** `user-database-mismatch`: why `userDatabase` is refused. */
	readonly reason?: WorkflowAdmissionMismatchReason;
	/** `user-database-mismatch`: the `userDatabase` given, if any. */
	readonly userDatabase?: string;
	/** `user-database-mismatch`: the run's journal file, when it is one. */
	readonly journalPath?: string;
}

const MISMATCH_TEXT: Readonly<Record<WorkflowAdmissionMismatchReason, string>> = {
	"unsupported-journal": "the run's journal is not a default-prefix local SQLite file",
	missing: "it is not set",
	"other-file": "it is not the run's journal file",
};

/**
 * `admission.userLimits` cannot be enforced for this run's journal. It is thrown before the run is placed in the
 * journal, so nothing was written for it. Not retryable: change the settings the hint names.
 */
export class WorkflowAdmissionConfigError extends WorkflowAdmissionError {
	override readonly name = "WorkflowAdmissionConfigError" as const;
	declare readonly code: WorkflowAdmissionConfigErrorCode;
	override readonly retryable = false as const;
	readonly source: WorkflowAdmissionSource;
	/** The setting's full path: `admission.userLimits` for the SDK, `workflows.admission.userLimits` for settings. */
	readonly field: string;
	readonly reason: WorkflowAdmissionMismatchReason | undefined;
	readonly userDatabase: string | undefined;
	readonly journalPath: string | undefined;
	constructor(fields: WorkflowAdmissionConfigErrorFields) {
		const prefix = fields.source === "settings" ? "workflows." : "";
		const field = `${prefix}admission.userLimits`;
		const hint = `Set ${prefix === "" ? "RunOpts.journal" : "workflows.journal.path"} to one SQLite file and ${prefix}admission.userDatabase to the same absolute path, or remove ${field}.`;
		const subject =
			fields.code === "user-limits-need-one-journal"
				? "the default journal store keeps each root on its own shard"
				: `${prefix}admission.userDatabase is refused: ${MISMATCH_TEXT[fields.reason ?? "other-file"]}`;
		super(fields.code, `Cannot enforce ${field}: ${subject} (${fields.code}). ${hint}`, hint);
		this.source = fields.source;
		this.field = field;
		this.reason = fields.reason;
		this.userDatabase = fields.userDatabase;
		this.journalPath = fields.journalPath;
	}
}

function hasStructure(value: unknown, names: ReadonlySet<unknown>, codes?: ReadonlySet<unknown>): boolean {
	if (value === null || value === undefined) return false;
	const { name, code } = value as { readonly name?: unknown; readonly code?: unknown };
	return names.has(name) && typeof code === "string" && (codes === undefined || codes.has(code));
}

/** Whether `value` is a {@link WorkflowAdmissionError}, also one that crossed a realm or process boundary. */
export function isWorkflowAdmissionError(value: unknown): value is WorkflowAdmissionError {
	return value instanceof WorkflowAdmissionError || hasStructure(value, WORKFLOW_ADMISSION_ERROR_NAMES);
}

/** Whether `value` is a {@link WorkflowAdmissionConfigError}, also one that crossed a realm or process boundary. */
export function isWorkflowAdmissionConfigError(value: unknown): value is WorkflowAdmissionConfigError {
	return value instanceof WorkflowAdmissionConfigError || hasStructure(value, CONFIG_ERROR_NAMES, CONFIG_ERROR_CODES);
}

/** The first {@link WorkflowAdmissionError} in `error`'s cause chain, looking at most eight errors deep. */
export function findWorkflowAdmissionError(error: unknown): WorkflowAdmissionError | undefined {
	let current = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null; depth++) {
		if (isWorkflowAdmissionError(current)) return current;
		current = (current as { readonly cause?: unknown }).cause;
	}
	return undefined;
}
