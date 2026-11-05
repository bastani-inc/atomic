#!/usr/bin/env node
/**
 * Verdict on the invariant report check.ts writes for a fork chaos round (#4321). The checker and the controller both
 * use it, so a round whose report is missing, unreadable, incomplete or failing never ends as a success.
 *
 *   node test/distributed/fork-chaos/verdict.mjs <check.json>   # exits 1 unless every invariant passed
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The invariants every report must carry, each with `pass: true`, for the round to pass. */
export const CHAOS_INVARIANTS = Object.freeze([
	"sourcesUntouched",
	"noCorruption",
	"atomicForkRuns",
	"noLostOrDuplicatedWork",
	"noWrongTreeReplay",
	"fencing",
	"typedErrors",
	"recovery",
]);

/** @typedef {"report-missing" | "report-invalid" | "checker-failed" | "invariants-failed"} ChaosInvariantErrorCode */

/** Every {@link ChaosInvariantErrorCode}. Codes are stable: never rename or reuse one. */
export const CHAOS_INVARIANT_ERROR_CODES = Object.freeze(
	/** @type {const} */ (["report-missing", "report-invalid", "checker-failed", "invariants-failed"]),
);

/** How many `cause` links {@link findChaosInvariantError} follows past the error it is given. */
export const CHAOS_ERROR_CAUSE_DEPTH = 8;

const HINTS = {
	"report-missing": "Read the checker's stderr log on node a, fix what stopped it, and run the controller again",
	"report-invalid": "Read the checker's stderr log on node a; the report must be JSON with every invariant's pass flag",
	"checker-failed": "Read the checker's stderr log on node a; a checker that exits nonzero cannot vouch for its report",
	"invariants-failed": "Open check.json and read the failed invariants' example violations before changing the fork code",
};

const SUBJECTS = {
	"report-missing": "no invariant report",
	"report-invalid": "invariant report is not usable",
	"checker-failed": "invariant checker exited nonzero",
	"invariants-failed": "invariants failed",
};

/**
 * A fork chaos round did not prove its invariants. Never retryable: the round has to be fixed and run again.
 * The report file is the only thing that crosses a process boundary; each process builds this error from it.
 */
export class ChaosInvariantError extends Error {
	/** @readonly */
	name = /** @type {const} */ ("ChaosInvariantError");
	/** @readonly */
	retryable = /** @type {const} */ (false);

	/**
	 * @param {ChaosInvariantErrorCode} code
	 * @param {{ failedInvariants?: readonly string[], missingInvariants?: readonly string[], checkerExitCode?: number | null, cause?: unknown }} [context]
	 */
	constructor(code, { failedInvariants = [], missingInvariants = [], checkerExitCode, cause } = {}) {
		const details = [
			failedInvariants.length > 0 ? `failed: ${failedInvariants.join(", ")}` : undefined,
			missingInvariants.length > 0 ? `missing: ${missingInvariants.join(", ")}` : undefined,
			checkerExitCode === undefined
				? undefined
				: checkerExitCode === null
					? "checker ended by a signal"
					: `checker exit ${checkerExitCode}`,
		].filter((detail) => detail !== undefined);
		const subject = details.length > 0 ? `${SUBJECTS[code]} (${details.join("; ")})` : SUBJECTS[code];
		super(`Fork chaos round did not pass: ${subject} (${code}). ${HINTS[code]}.`, cause === undefined ? {} : { cause });
		/** @readonly Why the round did not pass. */
		this.code = code;
		/** @readonly What to do next. */
		this.hint = HINTS[code];
		/** @readonly Invariants whose `pass` is `false`. */
		this.failedInvariants = Object.freeze([...failedInvariants]);
		/** @readonly Invariants absent from the report or without a boolean `pass`. */
		this.missingInvariants = Object.freeze([...missingInvariants]);
		/** @readonly The checker's exit status when known; `null` when a signal ended it. */
		this.checkerExitCode = checkerExitCode;
	}
}

/**
 * Returns the first {@link ChaosInvariantError} in `error`'s cause chain, following at most
 * {@link CHAOS_ERROR_CAUSE_DEPTH} links. A value from another realm or module copy counts when its `name` is
 * `ChaosInvariantError` and its `code` is one of {@link CHAOS_INVARIANT_ERROR_CODES}.
 *
 * @param {unknown} error
 * @returns {ChaosInvariantError | undefined}
 */
export function findChaosInvariantError(error) {
	let current = error;
	for (let depth = 0; depth <= CHAOS_ERROR_CAUSE_DEPTH; depth++) {
		if (typeof current !== "object" || current === null) return undefined;
		if (current instanceof ChaosInvariantError) return current;
		const candidate = /** @type {{ name?: unknown, code?: unknown, cause?: unknown }} */ (current);
		if (
			candidate.name === "ChaosInvariantError" &&
			CHAOS_INVARIANT_ERROR_CODES.includes(/** @type {ChaosInvariantErrorCode} */ (candidate.code))
		)
			return /** @type {ChaosInvariantError} */ (current);
		current = candidate.cause;
	}
	return undefined;
}

/**
 * Whether `error` or one of its causes, within {@link CHAOS_ERROR_CAUSE_DEPTH} links, is a {@link ChaosInvariantError}.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isChaosInvariantError(error) {
	return findChaosInvariantError(error) !== undefined;
}

/**
 * Throws a {@link ChaosInvariantError} unless `reportText` is a report in which every invariant of
 * {@link CHAOS_INVARIANTS} has `pass: true` and the checker, when its exit status is given, exited 0.
 *
 * @param {string | undefined} reportText
 * @param {{ checkerExitCode?: number | null }} [options]
 * @returns {void}
 */
export function assertChaosInvariants(reportText, { checkerExitCode } = {}) {
	if (reportText === undefined || reportText.trim() === "") throw new ChaosInvariantError("report-missing", { checkerExitCode });
	let report;
	try {
		report = JSON.parse(reportText);
	} catch (cause) {
		throw new ChaosInvariantError("report-invalid", { checkerExitCode, cause });
	}
	const invariants = typeof report === "object" && report !== null ? report.invariants : undefined;
	const entries = typeof invariants === "object" && invariants !== null ? invariants : {};
	const missingInvariants = CHAOS_INVARIANTS.filter((name) => typeof entries[name]?.pass !== "boolean");
	const failedInvariants = CHAOS_INVARIANTS.filter((name) => entries[name]?.pass === false);
	if (failedInvariants.length > 0)
		throw new ChaosInvariantError("invariants-failed", { failedInvariants, missingInvariants, checkerExitCode });
	if (missingInvariants.length > 0) throw new ChaosInvariantError("report-invalid", { missingInvariants, checkerExitCode });
	if (checkerExitCode !== undefined && checkerExitCode !== 0) throw new ChaosInvariantError("checker-failed", { checkerExitCode });
}

/**
 * The report at `file`, or `undefined` when there is none; any other read failure is a `report-invalid`
 * {@link ChaosInvariantError} with the read error as its cause.
 *
 * @param {string} file
 * @returns {string | undefined}
 */
export function readChaosReport(file) {
	try {
		return readFileSync(file, "utf8");
	} catch (cause) {
		if (/** @type {NodeJS.ErrnoException} */ (cause).code === "ENOENT") return undefined;
		throw new ChaosInvariantError("report-invalid", { cause });
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const file = process.argv[2];
	if (!file) {
		console.error("usage: node test/distributed/fork-chaos/verdict.mjs <check.json>");
		process.exit(2);
	}
	try {
		assertChaosInvariants(readChaosReport(file));
		console.log(`all ${CHAOS_INVARIANTS.length} invariants passed`);
	} catch (error) {
		const verdict = findChaosInvariantError(error);
		if (verdict === undefined) throw error;
		console.error(verdict.message);
		process.exitCode = 1;
	}
}
