import {
	findInCauseChain,
	rehydrateErrorCause,
	type SerializedErrorCause,
	serializeErrorCause,
} from "../../error-contract.ts";

export type BlueprintErrorFieldValue =
	| string
	| number
	| boolean
	| null
	| readonly BlueprintErrorFieldValue[]
	| { readonly [key: string]: BlueprintErrorFieldValue };
export type BlueprintErrorFields = { readonly [key: string]: BlueprintErrorFieldValue };

/** Which layer a blueprint belongs to: the global file, a repository root, or an included workspace. */
export type BlueprintScope = "global" | "repository" | "workspace";
/** The sections whose steps a build runs. `knowledge` is never run. */
export type BlueprintSection = "initialize" | "maintenance" | "post-build";

export type BlueprintInvalidErrorCode = "blueprint-invalid";
export type BlueprintStepFailedErrorCode = "blueprint-step-failed";
export type BlueprintStepTimedOutErrorCode = "blueprint-step-timed-out";
export type BlueprintUsesUnsupportedErrorCode = "blueprint-uses-unsupported";
export type BlueprintBuildFailedErrorCode = "blueprint-build-failed";
export type BlueprintErrorCode =
	| BlueprintInvalidErrorCode
	| BlueprintStepFailedErrorCode
	| BlueprintStepTimedOutErrorCode
	| BlueprintUsesUnsupportedErrorCode
	| BlueprintBuildFailedErrorCode;
export type BlueprintErrorName =
	| "BlueprintError"
	| "BlueprintInvalidError"
	| "BlueprintStepFailedError"
	| "BlueprintStepTimedOutError"
	| "BlueprintUsesUnsupportedError"
	| "BlueprintBuildFailedError";

/**
 * Why a blueprint file is invalid. `yaml-syntax` is a file that is not YAML; `not-a-mapping` a document that is not a
 * mapping; the rest name the Devin rule that was broken.
 */
export type BlueprintInvalidReason =
	| "yaml-syntax"
	| "not-a-mapping"
	| "invalid-shell"
	| "invalid-field"
	| "uses-in-maintenance"
	| "run-and-uses"
	| "missing-run-or-uses"
	| "with-without-uses"
	| "invalid-uses-reference"
	| "duplicate-platform"
	| "nested-includes"
	| "include-parent-path"
	| "duplicate-include"
	| "post-build-not-global";

/** Where one step of a blueprint sits, for the errors that name a failing step. */
export interface BlueprintStepLocation {
	readonly blueprint: string;
	readonly scope: BlueprintScope;
	readonly section: BlueprintSection;
	/** Zero-based position within the section. */
	readonly index: number;
	/** The step's `name`, or `<section> step <n>` when it has none. */
	readonly step: string;
}

/**
 * Base of every failure a blueprint can cause. Resuming never throws these: a build records them in its outcome so a
 * resume continues with a warning. Branch on `code` or the class, never on `message`. `fields` holds the same
 * JSON-safe facts as the typed properties.
 */
export class BlueprintError extends Error {
	override readonly name: BlueprintErrorName = "BlueprintError";
	readonly code: BlueprintErrorCode;
	readonly hint: string;
	readonly retryable: boolean = false;
	readonly fields: BlueprintErrorFields;

	constructor(code: BlueprintErrorCode, summary: string, hint: string, fields: BlueprintErrorFields, cause?: Error) {
		super(`${summary} (${code}). ${hint}`, cause === undefined ? undefined : { cause });
		this.code = code;
		this.hint = hint;
		this.fields = Object.freeze({ ...fields });
		Object.assign(this, fields);
	}
}

export interface BlueprintInvalidErrorFields {
	/** The blueprint file. */
	readonly blueprint: string;
	readonly scope: BlueprintScope;
	readonly reason: BlueprintInvalidReason;
	/** The rule that was broken: Devin's own wording for the rules it words, else a short description. */
	readonly rule: string;
	/** The section, include entry or field that broke it, when there is one. */
	readonly subject: string | null;
}

/** A blueprint file breaks the schema or a validation rule. The blueprint's setup is skipped; the resume continues. */
export class BlueprintInvalidError extends BlueprintError {
	override readonly name = "BlueprintInvalidError" as const;
	declare readonly code: BlueprintInvalidErrorCode;
	declare readonly blueprint: string;
	declare readonly scope: BlueprintScope;
	declare readonly reason: BlueprintInvalidReason;
	declare readonly rule: string;
	declare readonly subject: string | null;

	constructor(fields: BlueprintInvalidErrorFields, cause?: Error) {
		super(
			"blueprint-invalid",
			`The ${fields.scope} blueprint ${fields.blueprint} is invalid: ${fields.rule}${fields.subject === null ? "" : ` (${fields.subject})`}`,
			"Fix the blueprint; the next build picks the change up.",
			{ ...fields },
			cause,
		);
	}
}

export interface BlueprintStepFailedErrorFields extends BlueprintStepLocation {
	readonly exitStatus: number | null;
	readonly signal: string | null;
	/** The step's captured output; null when its log could not be created, so the step was not started. */
	readonly logPath: string | null;
}

/** A step exited non-zero, was stopped by a signal or could not be started. The rest of its blueprint did not run. */
export class BlueprintStepFailedError extends BlueprintError {
	override readonly name = "BlueprintStepFailedError" as const;
	declare readonly code: BlueprintStepFailedErrorCode;
	declare readonly blueprint: string;
	declare readonly scope: BlueprintScope;
	declare readonly section: BlueprintSection;
	declare readonly index: number;
	declare readonly step: string;
	declare readonly exitStatus: number | null;
	declare readonly signal: string | null;
	declare readonly logPath: string | null;

	constructor(fields: BlueprintStepFailedErrorFields, cause?: Error) {
		const outcome =
			fields.signal !== null
				? `was stopped by ${fields.signal}`
				: fields.exitStatus === null
					? "could not be started"
					: `exited with status ${fields.exitStatus}`;
		super(
			"blueprint-step-failed",
			`The ${fields.section} step "${fields.step}" of the ${fields.scope} blueprint ${fields.blueprint} ${outcome}`,
			fields.logPath === null
				? "Make the build directory under the agent directory writable, then the next build runs the step again."
				: `Check the build log ${fields.logPath} for the exact error, then fix the environment and the blueprint; the next build runs it again.`,
			{ ...fields },
			cause,
		);
	}
}

export interface BlueprintStepTimedOutErrorFields extends BlueprintStepLocation {
	readonly logPath: string;
	readonly timeoutMs: number;
	readonly elapsedMs: number;
	/** The section that was running. */
	readonly phase: BlueprintSection;
}

/** A step did not finish within its timeout (3 hours) and was stopped. The rest of its blueprint did not run. */
export class BlueprintStepTimedOutError extends BlueprintError {
	override readonly name = "BlueprintStepTimedOutError" as const;
	declare readonly code: BlueprintStepTimedOutErrorCode;
	declare readonly blueprint: string;
	declare readonly scope: BlueprintScope;
	declare readonly section: BlueprintSection;
	declare readonly index: number;
	declare readonly step: string;
	declare readonly logPath: string;
	declare readonly timeoutMs: number;
	declare readonly elapsedMs: number;
	declare readonly phase: BlueprintSection;

	constructor(fields: BlueprintStepTimedOutErrorFields, cause?: Error) {
		super(
			"blueprint-step-timed-out",
			`The ${fields.section} step "${fields.step}" of the ${fields.scope} blueprint ${fields.blueprint} did not finish within ${fields.timeoutMs} ms`,
			`Check the build log ${fields.logPath}, make the step finish sooner or non-interactive, then fix the blueprint; the next build runs it again.`,
			{ ...fields },
			cause,
		);
	}
}

/** Why a `uses` step cannot run here. */
export type BlueprintUsesUnsupportedReason =
	| "docker-action"
	| "unknown-action-type"
	| "action-not-found"
	| "action-fetch-failed"
	| "action-metadata-invalid"
	| "node-unavailable"
	| "required-input-missing"
	| "unsupported-expression";

export interface BlueprintUsesUnsupportedErrorFields extends BlueprintStepLocation {
	/** The `github.com/<owner>/<repo>[/<subpath>]@<ref>` reference. */
	readonly uses: string;
	readonly reason: BlueprintUsesUnsupportedReason;
	/** A short, credential-free explanation. */
	readonly detail: string;
	readonly logPath: string;
}

const USES_REMEDIATION: Record<BlueprintUsesUnsupportedReason, string> = {
	"docker-action": "Replace the action with a `run` step, or use a Node.js or composite action",
	"unknown-action-type": "Replace the action with a `run` step, or use a Node.js or composite action",
	"required-input-missing": "Add the missing input under `with`",
	"action-not-found": "Check the `github.com/<owner>/<repo>@<ref>` reference and that the action has an action.yml",
	"action-fetch-failed": "Check the `github.com/<owner>/<repo>@<ref>` reference and the network access to GitHub",
	"action-metadata-invalid": "Pin a ref whose action.yml is valid",
	"node-unavailable": "Install Node.js and put it on PATH",
	"unsupported-expression": "Pass the value through `with` instead of the unsupported expression, or use a `run` step",
};

/** A `uses` step names an action that Atomic cannot run (Docker, or one it cannot fetch or read). */
export class BlueprintUsesUnsupportedError extends BlueprintError {
	override readonly name = "BlueprintUsesUnsupportedError" as const;
	declare readonly code: BlueprintUsesUnsupportedErrorCode;
	declare readonly blueprint: string;
	declare readonly scope: BlueprintScope;
	declare readonly section: BlueprintSection;
	declare readonly index: number;
	declare readonly step: string;
	declare readonly uses: string;
	declare readonly reason: BlueprintUsesUnsupportedReason;
	declare readonly detail: string;
	declare readonly logPath: string;

	constructor(fields: BlueprintUsesUnsupportedErrorFields, cause?: Error) {
		super(
			"blueprint-uses-unsupported",
			`The ${fields.section} step "${fields.step}" of the ${fields.scope} blueprint ${fields.blueprint} cannot run ${fields.uses}: ${fields.detail}`,
			`${USES_REMEDIATION[fields.reason]}; details are in ${fields.logPath}.`,
			{ ...fields },
			cause,
		);
	}
}

/** What a build was doing when it failed for a reason that is not a step. */
export type BlueprintBuildPhase = "read-blueprint" | "ledger" | "environment" | "unknown";

export interface BlueprintBuildFailedErrorFields {
	readonly phase: BlueprintBuildPhase;
	/** A short, credential-free explanation. */
	readonly detail: string;
}

const PHASE_ACTIVITY: Record<BlueprintBuildPhase, string> = {
	"read-blueprint": "reading a blueprint",
	ledger: "reading or writing the build ledger",
	environment: "preparing the build environment",
	unknown: "running",
};

/**
 * The build machinery itself failed (a blueprint file or the build ledger could not be read or written), not a step.
 * The resume continues without the build.
 */
export class BlueprintBuildFailedError extends BlueprintError {
	override readonly name = "BlueprintBuildFailedError" as const;
	declare readonly code: BlueprintBuildFailedErrorCode;
	declare readonly phase: BlueprintBuildPhase;
	declare readonly detail: string;

	constructor(fields: BlueprintBuildFailedErrorFields, cause?: Error) {
		super(
			"blueprint-build-failed",
			`The blueprint build stopped while ${PHASE_ACTIVITY[fields.phase]}: ${fields.detail}`,
			"Check that the agent directory is readable and writable; the next resume builds again.",
			{ ...fields },
			cause,
		);
	}
}

const CODES: Record<BlueprintErrorName, readonly BlueprintErrorCode[]> = {
	BlueprintError: [],
	BlueprintInvalidError: ["blueprint-invalid"],
	BlueprintStepFailedError: ["blueprint-step-failed"],
	BlueprintStepTimedOutError: ["blueprint-step-timed-out"],
	BlueprintUsesUnsupportedError: ["blueprint-uses-unsupported"],
	BlueprintBuildFailedError: ["blueprint-build-failed"],
};
const ALL_CODES = new Set(Object.values(CODES).flat());

function structurallyIs(value: unknown, name: BlueprintErrorName): boolean {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { readonly name?: unknown; readonly code?: unknown };
	if (name === "BlueprintError") {
		return (
			typeof candidate.name === "string" &&
			candidate.name in CODES &&
			ALL_CODES.has(candidate.code as BlueprintErrorCode)
		);
	}
	return candidate.name === name && CODES[name].includes(candidate.code as BlueprintErrorCode);
}

export function isBlueprintError(value: unknown): value is BlueprintError {
	return value instanceof BlueprintError || structurallyIs(value, "BlueprintError");
}
export function isBlueprintInvalidError(value: unknown): value is BlueprintInvalidError {
	return value instanceof BlueprintInvalidError || structurallyIs(value, "BlueprintInvalidError");
}
export function isBlueprintStepFailedError(value: unknown): value is BlueprintStepFailedError {
	return value instanceof BlueprintStepFailedError || structurallyIs(value, "BlueprintStepFailedError");
}
export function isBlueprintStepTimedOutError(value: unknown): value is BlueprintStepTimedOutError {
	return value instanceof BlueprintStepTimedOutError || structurallyIs(value, "BlueprintStepTimedOutError");
}
export function isBlueprintUsesUnsupportedError(value: unknown): value is BlueprintUsesUnsupportedError {
	return value instanceof BlueprintUsesUnsupportedError || structurallyIs(value, "BlueprintUsesUnsupportedError");
}

export function isBlueprintBuildFailedError(value: unknown): value is BlueprintBuildFailedError {
	return value instanceof BlueprintBuildFailedError || structurallyIs(value, "BlueprintBuildFailedError");
}

/** The first error in `error`'s cause chain, itself included, that `guard` accepts. */
export function findBlueprintError<T extends BlueprintError>(
	error: unknown,
	guard: (value: unknown) => value is T = isBlueprintError as (value: unknown) => value is T,
): T | undefined {
	return findInCauseChain(error, guard);
}

/** A {@link BlueprintError} as it crosses a worker, RPC or broker boundary. */
export interface SerializedBlueprintError {
	readonly name: string;
	readonly code: string;
	readonly message: string;
	readonly hint: string;
	readonly retryable: boolean;
	readonly fields: BlueprintErrorFields;
	readonly cause?: SerializedErrorCause;
}

/** The JSON form of `error`, with its cause chain bounded and free of stack traces. */
export function serializeBlueprintError(error: BlueprintError): SerializedBlueprintError {
	const cause = serializeErrorCause(error.cause);
	return {
		name: error.name,
		code: error.code,
		message: error.message,
		hint: error.hint,
		retryable: error.retryable,
		fields: error.fields,
		...(cause === undefined ? {} : { cause }),
	};
}

type Rehydrator = (fields: BlueprintErrorFields, cause?: Error) => BlueprintError;
const REHYDRATORS: Record<Exclude<BlueprintErrorName, "BlueprintError">, Rehydrator> = {
	BlueprintInvalidError: (fields, cause) =>
		new BlueprintInvalidError(fields as unknown as BlueprintInvalidErrorFields, cause),
	BlueprintStepFailedError: (fields, cause) =>
		new BlueprintStepFailedError(fields as unknown as BlueprintStepFailedErrorFields, cause),
	BlueprintStepTimedOutError: (fields, cause) =>
		new BlueprintStepTimedOutError(fields as unknown as BlueprintStepTimedOutErrorFields, cause),
	BlueprintUsesUnsupportedError: (fields, cause) =>
		new BlueprintUsesUnsupportedError(fields as unknown as BlueprintUsesUnsupportedErrorFields, cause),
	BlueprintBuildFailedError: (fields, cause) =>
		new BlueprintBuildFailedError(fields as unknown as BlueprintBuildFailedErrorFields, cause),
};

/**
 * The error {@link serializeBlueprintError} produced, rebuilt after it crossed a process boundary as the same class.
 * An unknown `name` or `code` rebuilds it as a {@link BlueprintError} that keeps the original `name`, `code`,
 * `message`, `hint`, `retryable` and `fields`.
 */
export function rehydrateBlueprintError(form: SerializedBlueprintError, cause?: Error): BlueprintError {
	const rebuiltCause = cause ?? rehydrateErrorCause(form.cause);
	const name = form.name as BlueprintErrorName;
	if (
		name !== "BlueprintError" &&
		Object.hasOwn(REHYDRATORS, name) &&
		CODES[name].includes(form.code as BlueprintErrorCode)
	) {
		return REHYDRATORS[name as Exclude<BlueprintErrorName, "BlueprintError">](form.fields, rebuiltCause);
	}
	const error = Object.create(BlueprintError.prototype) as BlueprintError;
	Object.defineProperties(error, {
		name: { value: form.name, enumerable: false, configurable: true },
		message: { value: form.message, enumerable: false, configurable: true },
		code: { value: form.code, enumerable: true },
		hint: { value: form.hint, enumerable: true },
		retryable: { value: form.retryable, enumerable: true },
		fields: { value: Object.freeze({ ...form.fields }), enumerable: true },
		...(rebuiltCause === undefined ? {} : { cause: { value: rebuiltCause, enumerable: false, configurable: true } }),
	});
	return error;
}
