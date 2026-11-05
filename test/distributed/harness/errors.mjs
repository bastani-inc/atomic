// @ts-check
/**
 * The distributed harness's error family. Every failure the harness reports is a `DistributedTestError` with a stable
 * `code`, safe structured `fields`, a separate `hint`, an explicit `retryable` flag and a preserved `cause`. Errors
 * cross the controller/node boundary as JSON (`serializeDistributedError`) and come back as the same class
 * (`rehydrateDistributedError`). Fields carry names, ids and counts only: never tokens, keys or file contents.
 *
 * | Class | code | When |
 * | --- | --- | --- |
 * | DistributedConfigError | invalid-config | A CLI flag or topology field is invalid; nothing was provisioned |
 * | DistributedPrerequisiteError | missing-prerequisite | A tool, login or control network the run needs is absent |
 * | DistributedCommandError | command-failed | An az, ssh or node-agent command exited unsuccessfully |
 * | DistributedTimeoutError | timeout | A phase exceeded its budget |
 * | DistributedProvisionError | provision-failed | A resource could not be created or reached its desired state |
 * | DistributedSecurityError | security-check-failed | The pre-test network and database security gate failed |
 * | DistributedFaultError | fault-failed | A chaos profile could not be applied, observed or recovered |
 * | DistributedInvariantError | invariant-violated | A machine-checked invariant failed |
 * | DistributedFeatureUnavailableError | feature-unavailable | The ref under test lacks a suite's feature (a skip) |
 * | DistributedScenarioPendingError | scenario-pending | The ref has the feature but the suite's scenarios are not written yet (a skip) |
 * | DistributedTeardownError | teardown-incomplete | Cleanup left resources or could not prove their absence |
 */

/** @typedef {string | number | boolean | null | readonly FieldValue[] | { readonly [key: string]: FieldValue }} FieldValue */
/** @typedef {Readonly<Record<string, FieldValue>>} ErrorFields */
/**
 * @typedef {"invalid-config" | "missing-prerequisite" | "command-failed" | "timeout" | "provision-failed"
 *   | "security-check-failed" | "fault-failed" | "invariant-violated" | "feature-unavailable" | "scenario-pending" | "teardown-incomplete"} DistributedErrorCode
 */
/**
 * @typedef {{ name: string, code: string, message: string, hint?: string, retryable: boolean, fields: ErrorFields,
 *   cause?: SerializedError, errors?: SerializedError[], cleanupCause?: SerializedError }} SerializedError
 */

/** How deep cause chains are followed when serializing or searching. */
export const MAX_CAUSE_DEPTH = 8;

export class DistributedTestError extends Error {
	/** @type {string} */
	name = "DistributedTestError";

	/**
	 * @param {{ code: string, summary: string, hint?: string, fields?: ErrorFields, retryable?: boolean, cause?: unknown }} init
	 */
	constructor({ code, summary, hint, fields = {}, retryable = false, cause }) {
		super(
			`${summary} (${code}).${hint === undefined ? "" : ` ${hint}`}`,
			cause === undefined ? undefined : { cause },
		);
		/** @type {string} */
		this.code = code;
		/** @type {string | undefined} */
		this.hint = hint;
		/** @type {ErrorFields} */
		this.fields = fields;
		/** @type {boolean} */
		this.retryable = retryable;
		/** @type {unknown} */
		this.cleanupCause = undefined;
	}
}

export class DistributedConfigError extends DistributedTestError {
	name = "DistributedConfigError";
	/**
	 * @param {{ source: "cli" | "topology" | "env" | "replay", field: string,
	 *   reason: "unknown-flag" | "missing-value" | "required" | "invalid-value" | "unknown-name" | "invalid-json" | "unreadable", expected: string,
	 *   actual?: FieldValue }} init
	 */
	constructor({ source, field, reason, expected, actual = null }) {
		super({
			code: "invalid-config",
			summary: `Invalid distributed-test configuration: ${source} ${field} is ${reason}`,
			hint: reason === "unknown-flag" ? `Remove ${field}; expected ${expected}.` : `Set ${field} to ${expected}.`,
			fields: { source, field, reason, expected, actual },
		});
	}
}

export class DistributedPrerequisiteError extends DistributedTestError {
	name = "DistributedPrerequisiteError";
	/** @param {{ missing: readonly { what: string, why: string, fix: string }[], cause?: unknown }} init */
	constructor({ missing, cause }) {
		super({
			code: "missing-prerequisite",
			summary: `Distributed test prerequisites are missing: ${missing.map((item) => item.what).join(", ")}`,
			hint: `Fix: ${missing.map((item) => item.fix).join("; ")}.`,
			fields: { missing: missing.map((item) => ({ ...item })) },
			cause,
		});
	}
}

export class DistributedCommandError extends DistributedTestError {
	name = "DistributedCommandError";
	/**
	 * @param {{ tool: string, operation: string, exitCode: number | null, signal: string | null, retryable?: boolean,
	 *   detail?: string, cause?: unknown }} init
	 */
	constructor({ tool, operation, exitCode, signal, retryable = false, detail = "", cause }) {
		super({
			code: "command-failed",
			summary: `${tool} ${operation} failed with ${signal === null ? `exit ${exitCode}` : `signal ${signal}`}`,
			hint: `Inspect the redacted ${tool} output in the run log and rerun the step.`,
			fields: { tool, operation, exitCode, signal, detail },
			retryable,
			cause,
		});
	}
}

export class DistributedTimeoutError extends DistributedTestError {
	name = "DistributedTimeoutError";
	/** @param {{ phase: string, timeoutMs: number, elapsedMs: number, retryable?: boolean, cause?: unknown }} init */
	constructor({ phase, timeoutMs, elapsedMs, retryable = false, cause }) {
		super({
			code: "timeout",
			summary: `${phase} timed out after ${elapsedMs} ms (budget ${timeoutMs} ms)`,
			hint: `Check the target's reachability and raise the ${phase} budget only if the step is legitimately slow.`,
			fields: { phase, timeoutMs, elapsedMs },
			retryable,
			cause,
		});
	}
}

export class DistributedProvisionError extends DistributedTestError {
	name = "DistributedProvisionError";
	/** @param {{ step: string, resource: string, detail?: string, cause?: unknown }} init */
	constructor({ step, resource, detail = "", cause }) {
		super({
			code: "provision-failed",
			summary: `Provisioning ${resource} failed during ${step}`,
			hint: "The run tears down what it created; check quota and region capacity, then rerun.",
			fields: { step, resource, detail },
			cause,
		});
	}
}

export class DistributedSecurityError extends DistributedTestError {
	name = "DistributedSecurityError";
	/** @param {{ violations: readonly { check: string, subject: string, detail: string }[] }} init */
	constructor({ violations }) {
		super({
			code: "security-check-failed",
			summary: `The security gate found ${violations.length} violation(s): ${[...new Set(violations.map((v) => v.check))].join(", ")}`,
			hint: "No scenario ran and the run was torn down; fix the network or database configuration named in the violations.",
			fields: { violations: violations.map((violation) => ({ ...violation })) },
		});
	}
}

export class DistributedFaultError extends DistributedTestError {
	name = "DistributedFaultError";
	/** @param {{ profile: string, stage: "apply" | "observe" | "recover", target: string, detail?: string, cause?: unknown }} init */
	constructor({ profile, stage, target, detail = "", cause }) {
		super({
			code: "fault-failed",
			summary: `Chaos profile ${profile} could not ${stage} on ${target}`,
			hint: "Check the target's kernel and tool support recorded in the environment facts.",
			fields: { profile, stage, target, detail },
			cause,
		});
	}
}

export class DistributedInvariantError extends DistributedTestError {
	name = "DistributedInvariantError";
	/** @param {{ invariant: string, scenario: string, expected: FieldValue, actual: FieldValue }} init */
	constructor({ invariant, scenario, expected, actual }) {
		super({
			code: "invariant-violated",
			summary: `Invariant ${invariant} failed in ${scenario}`,
			hint: "Compare expected and actual in the evidence report; this is a finding against the ref under test.",
			fields: { invariant, scenario, expected, actual },
		});
	}
}

export class DistributedFeatureUnavailableError extends DistributedTestError {
	name = "DistributedFeatureUnavailableError";
	/** @param {{ suite: string, issue: string, capability: string }} init */
	constructor({ suite, issue, capability }) {
		super({
			code: "feature-unavailable",
			summary: `Suite ${suite} needs ${capability} from ${issue}, which the ref under test does not provide`,
			hint: `Run the suite against a ref that contains ${issue}.`,
			fields: { suite, issue, capability },
		});
	}
}

export class DistributedScenarioPendingError extends DistributedTestError {
	name = "DistributedScenarioPendingError";
	/** @param {{ suite: string, issue: string, capability: string }} init */
	constructor({ suite, issue, capability }) {
		super({
			code: "scenario-pending",
			summary: `Suite ${suite} found ${capability} from ${issue}, but its scenarios are not written yet`,
			hint: `Add the ${suite} scenarios in test/distributed/harness/suites.mjs together with ${issue}.`,
			fields: { suite, issue, capability },
		});
	}
}

export class DistributedTeardownError extends DistributedTestError {
	name = "DistributedTeardownError";
	/** @param {{ runId: string, remaining: readonly string[], errors: readonly unknown[] }} init */
	constructor({ runId, remaining, errors }) {
		super({
			code: "teardown-incomplete",
			summary: `Teardown of run ${runId} left ${remaining.length} resource(s) and ${errors.length} failure(s)`,
			hint: `Rerun \`node test/distributed/sweep.mjs --run-id ${runId}\` after fixing the failures.`,
			fields: { runId, remaining: [...remaining] },
			retryable: true,
		});
		/** @type {readonly unknown[]} */
		this.errors = [...errors];
	}
}

const CLASSES = {
	DistributedTestError,
	DistributedConfigError,
	DistributedPrerequisiteError,
	DistributedCommandError,
	DistributedTimeoutError,
	DistributedProvisionError,
	DistributedSecurityError,
	DistributedFaultError,
	DistributedInvariantError,
	DistributedFeatureUnavailableError,
	DistributedScenarioPendingError,
	DistributedTeardownError,
};
/** @type {Readonly<Record<string, string>>} */
const CODES = {
	DistributedConfigError: "invalid-config",
	DistributedPrerequisiteError: "missing-prerequisite",
	DistributedCommandError: "command-failed",
	DistributedTimeoutError: "timeout",
	DistributedProvisionError: "provision-failed",
	DistributedSecurityError: "security-check-failed",
	DistributedFaultError: "fault-failed",
	DistributedInvariantError: "invariant-violated",
	DistributedFeatureUnavailableError: "feature-unavailable",
	DistributedScenarioPendingError: "scenario-pending",
	DistributedTeardownError: "teardown-incomplete",
};

/**
 * @param {unknown} value
 * @returns {value is { name: string, code: string }}
 */
function hasNameAndCode(value) {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, "name") === "string" &&
		typeof Reflect.get(value, "code") === "string"
	);
}

/**
 * @param {unknown} value
 * @returns {value is DistributedTestError}
 */
export function isDistributedTestError(value) {
	return (
		value instanceof DistributedTestError ||
		(hasNameAndCode(value) && value.name.startsWith("Distributed") && value.name.endsWith("Error"))
	);
}

/**
 * @param {string} name
 * @returns {(value: unknown) => boolean}
 */
function guard(name) {
	const Class = /** @type {Record<string, Function>} */ (CLASSES)[name];
	return (value) =>
		value instanceof Class || (hasNameAndCode(value) && value.name === name && value.code === CODES[name]);
}

export const isDistributedConfigError = guard("DistributedConfigError");
export const isDistributedPrerequisiteError = guard("DistributedPrerequisiteError");
export const isDistributedCommandError = guard("DistributedCommandError");
export const isDistributedTimeoutError = guard("DistributedTimeoutError");
export const isDistributedProvisionError = guard("DistributedProvisionError");
export const isDistributedSecurityError = guard("DistributedSecurityError");
export const isDistributedFaultError = guard("DistributedFaultError");
export const isDistributedInvariantError = guard("DistributedInvariantError");
export const isDistributedFeatureUnavailableError = guard("DistributedFeatureUnavailableError");
export const isDistributedTeardownError = guard("DistributedTeardownError");
export const isDistributedScenarioPendingError = guard("DistributedScenarioPendingError");

/**
 * Whether anything in the error's cause chain may be retried.
 * @param {unknown} error
 */
export function isRetryableDistributedError(error) {
	let current = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null; depth++) {
		if (isDistributedTestError(current) && current.retryable === true) return true;
		current = Reflect.get(current, "cause");
	}
	return false;
}

/**
 * Whether the value is a cancellation: an AbortError, or the reason an AbortSignal was aborted with.
 * @param {unknown} error
 * @param {AbortSignal} [signal]
 */
export function isCancellation(error, signal) {
	if (signal?.aborted === true && error === signal.reason) return true;
	return typeof error === "object" && error !== null && Reflect.get(error, "name") === "AbortError";
}

/**
 * Keeps `primary` and records `cleanup` beside it, so a cleanup failure never replaces the original failure.
 * @template T
 * @param {T} primary
 * @param {unknown} cleanup
 * @returns {T}
 */
export function attachCleanupFailure(primary, cleanup) {
	if (typeof primary === "object" && primary !== null) {
		Object.defineProperty(primary, "cleanupCause", {
			value: cleanup,
			enumerable: false,
			writable: true,
			configurable: true,
		});
	}
	return primary;
}

/**
 * JSON form of any thrown value, bounded in depth and safe against cycles.
 * @param {unknown} error
 * @param {number} [depth]
 * @param {Set<unknown>} [seen]
 * @returns {SerializedError}
 */
export function serializeDistributedError(error, depth = 0, seen = new Set()) {
	if (typeof error !== "object" || error === null) {
		return { name: "NonError", code: "non-error", message: String(error), retryable: false, fields: {} };
	}
	seen.add(error);
	const name = String(Reflect.get(error, "name") ?? "Error");
	const code = Reflect.get(error, "code");
	const hint = Reflect.get(error, "hint");
	const fields = Reflect.get(error, "fields");
	/** @type {SerializedError} */
	const out = {
		name,
		code: typeof code === "string" ? code : "unclassified",
		message: String(Reflect.get(error, "message") ?? ""),
		retryable: Reflect.get(error, "retryable") === true,
		fields: typeof fields === "object" && fields !== null ? /** @type {ErrorFields} */ (fields) : {},
	};
	if (typeof hint === "string") out.hint = hint;
	/** @param {unknown} value */
	const nested = (value) =>
		depth + 1 >= MAX_CAUSE_DEPTH || seen.has(value)
			? { name: "TruncatedCause", code: "truncated", message: "cause chain truncated", retryable: false, fields: {} }
			: serializeDistributedError(value, depth + 1, seen);
	const cause = Reflect.get(error, "cause");
	if (cause !== undefined) out.cause = nested(cause);
	const cleanup = Reflect.get(error, "cleanupCause");
	if (cleanup !== undefined) out.cleanupCause = nested(cleanup);
	const errors = Reflect.get(error, "errors");
	if (Array.isArray(errors)) out.errors = errors.map((item) => nested(item));
	return out;
}

/**
 * The same class on this side of a process boundary. Unknown names become the family base, keeping name and code.
 * @param {SerializedError} json
 * @returns {Error}
 */
export function rehydrateDistributedError(json) {
	const Class = Object.hasOwn(CLASSES, json.name)
		? /** @type {Record<string, Function>} */ (CLASSES)[json.name]
		: DistributedTestError;
	/** @type {DistributedTestError} */
	const error = Object.create(Class.prototype);
	for (const [key, value] of Object.entries({
		message: json.message,
		name: json.name,
		code: json.code,
		hint: json.hint,
		fields: json.fields,
		retryable: json.retryable,
		stack: `${json.name}: ${json.message}`,
	})) {
		Object.defineProperty(error, key, { value, writable: true, configurable: true, enumerable: key !== "stack" });
	}
	if (json.cause !== undefined) {
		Object.defineProperty(error, "cause", {
			value: rehydrateDistributedError(json.cause),
			writable: true,
			configurable: true,
		});
	}
	if (json.cleanupCause !== undefined) attachCleanupFailure(error, rehydrateDistributedError(json.cleanupCause));
	if (json.errors !== undefined)
		Object.assign(error, { errors: json.errors.map((item) => rehydrateDistributedError(item)) });
	return error;
}
