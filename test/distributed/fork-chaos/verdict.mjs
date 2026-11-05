#!/usr/bin/env node
/**
 * Verdict on the reports of a fork chaos round (#4321): the invariant report check.ts writes, and the node-local SQLite
 * report workload.ts `local` prints. The checker, the workload and the controller all use it, so a round whose report
 * is missing, unreadable, incomplete or failing never ends as a success.
 *
 *   node test/distributed/fork-chaos/verdict.mjs <check.json>                       # exits 1 unless every invariant passed
 *   node test/distributed/fork-chaos/verdict.mjs --local <node-local-sqlite.json>   # exits 1 unless the local scenario passed
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
/** @param {string | undefined} code @param {string | undefined} phase */
export function expectedForkRetryable(code, phase) {
	return code === "journal-unavailable"
		? phase === "read" || phase === "claim"
		: code === "source-busy" || code === "copy-failed" || code === "session-unavailable";
}

/**
 * Log records that end a fork attempt. `aborted-after-write` is not one: a cancellation after the fork's write was
 * attempted ends only once the written fork is adopted (`done`) or the journal confirms it absent (`aborted`).
 */
export const ATTEMPT_TERMINALS = Object.freeze([
	"done",
	"aborted",
	"probe-ok",
	"failed-nonretryable",
	"gave-up",
	"probe-unexpected-success",
]);

/**
 * What a fork attempt does after `forkRun` rejected with its own `signal.reason`. A cancellation before any write
 * (`candidate` undefined) ends the attempt. After a write was attempted, the fork the write named is adopted when the
 * journal holds it, so the attempt never forks again; when the journal confirms it absent, the attempt ends and keeps
 * the candidate, the only fork a later-landing write could add for it.
 *
 * @param {{ readonly forkRunId: string } | undefined} candidate the fork this try began writing
 * @param {boolean | undefined} exists whether the journal holds `candidate` (unread when there is none)
 * @returns {"aborted-before-write" | "adopt-written-fork" | "aborted-write-unconfirmed"}
 */
export function abortDisposition(candidate, exists) {
	if (candidate === undefined) return "aborted-before-write";
	return exists === true ? "adopt-written-fork" : "aborted-write-unconfirmed";
}

/**
 * Folds one attempt's log records, in order, into what recovery needs: its plan, whether a terminal record ended it,
 * the fork runs its copies began, and its cancellation. The workload writes `abort-requested` (durably, before it
 * aborts the signal) with the write in progress, if any; `aborted-after-write` names the write the rejection found.
 * A copy that begins after the request becomes the cancellation's candidate, since its write may land.
 *
 * @template P
 * @param {readonly { readonly t?: unknown, readonly plan?: P, readonly forkRunId?: unknown, readonly phase?: unknown }[]} records
 * @returns {{ plan?: P, terminal: boolean, forkRunIds: Set<string>, cancelled?: { forkRunId?: string, phase?: string } }}
 */
export function foldAttempt(records) {
	/** @type {{ plan?: P, terminal: boolean, forkRunIds: Set<string>, cancelled?: { forkRunId?: string, phase?: string } }} */
	const state = { terminal: false, forkRunIds: new Set() };
	/** @param {{ readonly forkRunId?: unknown, readonly phase?: unknown }} record */
	const candidate = (record) => ({
		...(typeof record.forkRunId === "string" ? { forkRunId: record.forkRunId } : {}),
		...(typeof record.phase === "string" ? { phase: record.phase } : {}),
	});
	for (const record of records) {
		if (record.t === "intent" && record.plan !== undefined) state.plan = record.plan;
		if (record.t === "copy-begin" && typeof record.forkRunId === "string") {
			state.forkRunIds.add(record.forkRunId);
			if (state.cancelled !== undefined) state.cancelled = { forkRunId: record.forkRunId, phase: "begun" };
		}
		if (record.t === "abort-requested" || record.t === "aborted-after-write") {
			const next = candidate(record);
			state.cancelled = next.forkRunId === undefined && state.cancelled !== undefined ? state.cancelled : next;
		}
		// ATTEMPT_TERMINALS holds strings only, so a missing or non-string `t` never matches.
		if (ATTEMPT_TERMINALS.includes(/** @type {string} */ (record.t))) state.terminal = true;
	}
	return state;
}

/**
 * What recovery does with an attempt a killed process left without a terminal record. Forks of the attempt that the
 * journal holds are adopted. A cancelled attempt is never forked again: one cancelled before any write ends `aborted`
 * with no candidate; one cancelled after a write was attempted ends `aborted` with that candidate even when it is
 * absent, since the write may still land and the global sweep recovers a late fork. Only an attempt with neither a
 * held fork nor a cancellation is driven again.
 *
 * @param {{ readonly forkRunId?: string, readonly phase?: string } | undefined} cancelled the attempt's cancellation
 * @param {readonly string[]} existing the attempt's copied forks the journal holds
 * @returns {{ readonly action: "adopt", readonly forkRunIds: readonly string[] }
 *   | { readonly action: "end-aborted", readonly forkRunId?: string, readonly phase?: string }
 *   | { readonly action: "drive" }}
 */
export function redriveDecision(cancelled, existing) {
	if (existing.length > 0) return { action: "adopt", forkRunIds: [...existing] };
	if (cancelled !== undefined)
		return {
			action: "end-aborted",
			...(cancelled.forkRunId === undefined ? {} : { forkRunId: cancelled.forkRunId }),
			...(cancelled.phase === undefined ? {} : { phase: cancelled.phase }),
		};
	return { action: "drive" };
}

/**
 * The fork runs an attempt ending in `aborted` created that no cancelled write explains. Only the candidate an
 * `aborted` record names is explained: the workload and recovery put it there whenever a write was attempted before
 * the cancellation, and a cancellation before any write names none, so any fork it left is reported. Other records
 * that name a fork (`copy-begin`, `abort-requested`, `aborted-after-write`) explain nothing.
 *
 * @param {readonly { readonly t?: unknown, readonly forkRunId?: unknown }[]} records the attempt's log records
 * @param {Iterable<string>} created the fork runs the attempt's copies created
 * @returns {string[]}
 */
export function unexplainedAbortForks(records, created) {
	// A record without a string `forkRunId` adds a value no created fork id equals, so it explains nothing.
	/** @type {Set<unknown>} */
	const candidates = new Set(records.filter((record) => record.t === "aborted").map((record) => record.forkRunId));
	return [...created].filter((forkRunId) => !candidates.has(forkRunId));
}

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

/**
 * @typedef {"report-missing" | "report-invalid" | "checker-failed" | "invariants-failed" | "local-sqlite-failed"} ChaosInvariantErrorCode
 */

/** Every {@link ChaosInvariantErrorCode}. Codes are stable: never rename or reuse one. */
export const CHAOS_INVARIANT_ERROR_CODES = Object.freeze(
	/** @type {const} */ ([
		"report-missing",
		"report-invalid",
		"checker-failed",
		"invariants-failed",
		"local-sqlite-failed",
	]),
);

/** How many `cause` links {@link findChaosInvariantError} follows past the error it is given. */
export const CHAOS_ERROR_CAUSE_DEPTH = 8;

const HINTS = {
	"report-missing": "Read the checker's stderr log on node a, fix what stopped it, and run the controller again",
	"report-invalid": "Read the checker's stderr log on node a; the report must be JSON with every invariant's pass flag",
	"checker-failed": "Read the checker's stderr log on node a; a checker that exits nonzero cannot vouch for its report",
	"invariants-failed": "Open check.json and read the failed invariants' example violations before changing the fork code",
	"local-sqlite-failed":
		"Open node-local-sqlite.json and local-stderr.log on node b; each listed expectation names the report field that missed",
};

const SUBJECTS = {
	"report-missing": "no invariant report",
	"report-invalid": "invariant report is not usable",
	"checker-failed": "invariant checker exited nonzero",
	"invariants-failed": "invariants failed",
	"local-sqlite-failed": "node-local SQLite scenario failed",
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
	 * @param {{ failedInvariants?: readonly string[], missingInvariants?: readonly string[], localFailures?: readonly string[], checkerExitCode?: number | null, cause?: unknown }} [context]
	 */
	constructor(code, { failedInvariants = [], missingInvariants = [], localFailures = [], checkerExitCode, cause } = {}) {
		const details = [
			failedInvariants.length > 0 ? `failed: ${failedInvariants.join(", ")}` : undefined,
			missingInvariants.length > 0 ? `missing: ${missingInvariants.join(", ")}` : undefined,
			localFailures.length > 0 ? localFailures.join("; ") : undefined,
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
		/** @readonly Expectations of the node-local SQLite scenario that its report or process did not meet. */
		this.localFailures = Object.freeze([...localFailures]);
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
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The expectations a node-local SQLite report (workload.ts `local`) misses, each naming the report field. Empty when
 * the scenario did what it promises: the local journal forks its own run and completes it, replays only the tools
 * before the fork point, reports a run that exists only in shared storage as `source-not-found` with the join hint
 * (forkRun and listForkPoints), fails a fork on a full disk with a typed fork error and no new run, forks again once
 * the disk is freed, and leaves no partial run.
 *
 * @param {unknown} report
 * @returns {string[]}
 */
export function localSqliteFailures(report) {
	if (!isRecord(report)) return ["report is not a JSON object"];
	const failures = [];
	const expect = (ok, failure) => {
		if (!ok) failures.push(failure);
	};
	const source = isRecord(report.localSource) ? report.localSource : {};
	const fork = isRecord(report.localFork) ? report.localFork : {};
	const forkedFrom = isRecord(fork.forkedFrom) ? fork.forkedFrom : {};
	const points = Array.isArray(report.localForkPoints) ? report.localForkPoints : [];
	const tools = Array.isArray(fork.toolsExecutedInFork) ? fork.toolsExecutedInFork : [];
	expect(source.status === "completed", "localSource.status is not completed");
	expect(points.includes("child.c2") && points.includes("s3"), "localForkPoints lacks child.c2 or s3");
	expect(fork.status === "completed", "localFork.status is not completed");
	expect(
		typeof source.runId === "string" && forkedFrom.runId === source.runId && forkedFrom.stagePath === "child.c2",
		"localFork.forkedFrom is not the local source at child.c2",
	);
	expect(
		["t3", "t4"].every((tool) => tools.includes(tool)) && !["t1", "t2", "ct1"].some((tool) => tools.includes(tool)),
		"localFork.toolsExecutedInFork did not replay t1, t2 and ct1 and run t3 and t4",
	);
	for (const field of ["sharedRunViaLocalJournal", "sharedRunPointsViaLocalJournal"]) {
		const error = isRecord(report[field]) ? report[field] : {};
		expect(
			error.fork === true && error.code === "source-not-found" && error.hintJoin === true && error.storageScope === "local-only",
			`${field} is not a local-only source-not-found fork error with the join hint`,
		);
	}
	const full = isRecord(report.diskFullFork) ? report.diskFullFork : {};
	expect(full.fork === true, "diskFullFork did not fail with a typed fork error");
	expect(
		typeof report.runsBeforeDiskFull === "number" && report.runsAfterDiskFullAttempt === report.runsBeforeDiskFull,
		"runsAfterDiskFullAttempt differs from runsBeforeDiskFull",
	);
	const healed = isRecord(report.afterFreeingDisk) ? report.afterFreeingDisk : {};
	expect(healed.status === "completed", "afterFreeingDisk.status is not completed");
	expect(
		Array.isArray(report.localPartialRuns) && report.localPartialRuns.length === 0,
		"localPartialRuns is not empty",
	);
	return failures;
}

/**
 * Throws a `local-sqlite-failed` {@link ChaosInvariantError} unless the node-local SQLite workload exited 0 and its
 * report (the last line it printed) meets every expectation of {@link localSqliteFailures}.
 *
 * @param {string | undefined} reportText
 * @param {{ workloadExitCode?: number | null }} [options]
 * @returns {void}
 */
export function assertLocalSqliteReport(reportText, { workloadExitCode } = {}) {
	const localFailures = [];
	if (workloadExitCode !== undefined && workloadExitCode !== 0)
		localFailures.push(workloadExitCode === null ? "workload ended by a signal" : `workload exit ${workloadExitCode}`);
	let report;
	let cause;
	if (reportText === undefined || reportText.trim() === "") localFailures.push("no report");
	else {
		try {
			report = JSON.parse(reportText);
		} catch (error) {
			cause = error;
			localFailures.push("report is not JSON");
		}
	}
	if (report !== undefined) localFailures.push(...localSqliteFailures(report));
	if (localFailures.length > 0) throw new ChaosInvariantError("local-sqlite-failed", { localFailures, cause });
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
	const local = process.argv[2] === "--local";
	const file = process.argv[local ? 3 : 2];
	if (!file) {
		console.error("usage: node test/distributed/fork-chaos/verdict.mjs [--local] <report.json>");
		process.exit(2);
	}
	try {
		if (local) {
			assertLocalSqliteReport(readChaosReport(file));
			console.log("node-local SQLite scenario passed");
		} else {
			assertChaosInvariants(readChaosReport(file));
			console.log(`all ${CHAOS_INVARIANTS.length} invariants passed`);
		}
	} catch (error) {
		const verdict = findChaosInvariantError(error);
		if (verdict === undefined) throw error;
		console.error(verdict.message);
		process.exitCode = 1;
	}
}
