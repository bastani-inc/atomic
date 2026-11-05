// @ts-check
/**
 * Machine-checked invariants over explicit observations. Each checker returns `{ name, passed, expected, actual }`;
 * missing evidence is a failure, never a pass.
 */

import { DistributedInvariantError } from "./errors.mjs";

/**
 * @typedef {{ seq: number, epoch: number, key: string | null, index: number | null, digest: string | null, type?: string }} JournalObservation
 * @typedef {{ event: string, key?: string, index?: number, seq?: number, epoch?: number, status?: string, digest?: string, holder?: string,
 *   at?: number, ms?: number, by?: string | null, error?: { name: string, code: string | null } }} WriterRecord
 * @typedef {{ holder: string, epoch: number, outcome: "rejected" | "appended", error?: { name: string } }} FencingProbe
 * @typedef {{ name: string, passed: boolean, expected: import("./errors.mjs").FieldValue, actual: import("./errors.mjs").FieldValue }} InvariantResult
 */

/** Error names that say nothing about what failed. */
export const UNTYPED_ERROR_NAMES = Object.freeze([
	"Error",
	"TypeError",
	"RangeError",
	"SyntaxError",
	"ReferenceError",
	"NonError",
	"AggregateError",
]);

/**
 * @param {{ entries: readonly JournalObservation[] | undefined, records: readonly WriterRecord[] | undefined,
 *   fencing: readonly FencingProbe[], integrity: readonly string[] | undefined, expectations: { minAcks: number, requireCompletion: boolean } }} observations
 * @returns {InvariantResult[]}
 */
export function checkJournalInvariants({ entries, records, fencing, integrity, expectations }) {
	/** @type {InvariantResult[]} */
	const results = [];
	const acks = (records ?? []).filter((record) => record.event === "ack");
	results.push({
		name: "evidence-complete",
		passed:
			entries !== undefined &&
			records !== undefined &&
			integrity !== undefined &&
			acks.length >= expectations.minAcks,
		expected: { journalRead: true, writerRecords: true, integrity: true, minAcks: expectations.minAcks },
		actual: {
			journalRead: entries !== undefined,
			writerRecords: records !== undefined,
			integrity: integrity !== undefined,
			acks: acks.length,
		},
	});
	const journal = entries ?? [];
	/** @type {Map<string, JournalObservation[]>} */
	const byKey = new Map();
	for (const entry of journal) {
		if (entry.key === null) continue;
		byKey.set(entry.key, [...(byKey.get(entry.key) ?? []), entry]);
	}
	const ackedKeys = [...new Set(acks.map((ack) => ack.key ?? ""))];
	const missing = ackedKeys.filter((key) => !byKey.has(key));
	const mismatched = acks.filter((ack) => {
		const stored = byKey.get(ack.key ?? "")?.[0];
		return (
			stored !== undefined && (stored.digest !== ack.digest || stored.seq !== ack.seq || stored.epoch !== ack.epoch)
		);
	});
	results.push({
		name: "acknowledged-checkpoints-present",
		passed: missing.length === 0 && mismatched.length === 0,
		expected: { missing: 0, mismatched: 0, acknowledged: ackedKeys.length },
		actual: {
			missing: missing.length,
			mismatched: mismatched.length,
			acknowledged: ackedKeys.length,
			firstMissing: missing[0] ?? null,
		},
	});
	const duplicates = [...byKey.entries()].filter(([, list]) => list.length > 1).map(([key]) => key);
	results.push({
		name: "no-duplicate-checkpoints",
		passed: duplicates.length === 0,
		expected: { duplicates: 0 },
		actual: { duplicates: duplicates.length, firstDuplicate: duplicates[0] ?? null },
	});
	const indexes = journal
		.map((entry) => entry.index)
		.filter((index) => index !== null)
		.sort((a, b) => /** @type {number} */ (a) - /** @type {number} */ (b));
	const gaps = indexes.filter((index, position) => index !== position).length;
	results.push({
		name: "no-lost-checkpoints",
		passed: gaps === 0,
		expected: { gaps: 0 },
		actual: { gaps, checkpoints: indexes.length, last: indexes.at(-1) ?? null },
	});
	let seqViolations = 0;
	let epochViolations = 0;
	for (let position = 1; position < journal.length; position++) {
		if (journal[position].seq <= journal[position - 1].seq) seqViolations++;
		if (journal[position].epoch < journal[position - 1].epoch) epochViolations++;
	}
	results.push({
		name: "sequence-strictly-increasing",
		passed: seqViolations === 0,
		expected: 0,
		actual: seqViolations,
	});
	results.push({
		name: "lease-fencing-holds",
		passed: epochViolations === 0,
		expected: { epochRegressions: 0 },
		actual: { epochRegressions: epochViolations, epochs: [...new Set(journal.map((entry) => entry.epoch))] },
	});
	const accepted = fencing.filter((probe) => probe.outcome !== "rejected" || probe.error?.name !== "StaleLeaseError");
	results.push({
		name: "stale-writers-rejected",
		passed: accepted.length === 0,
		expected: { probes: fencing.length, rejected: fencing.length },
		actual: { probes: fencing.length, rejected: fencing.length - accepted.length },
	});
	results.push({
		name: "journal-integrity",
		passed: integrity !== undefined && integrity.length === 1 && integrity[0] === "ok",
		expected: ["ok"],
		actual: integrity === undefined ? null : [...integrity],
	});
	const untyped = (records ?? []).filter(
		(record) => record.error !== undefined && UNTYPED_ERROR_NAMES.includes(record.error.name),
	);
	results.push({
		name: "failures-are-typed",
		passed: untyped.length === 0,
		expected: { untyped: 0 },
		actual: {
			untyped: untyped.length,
			names: [
				...new Set(
					(records ?? []).filter((record) => record.error !== undefined).map((record) => record.error?.name ?? ""),
				),
			],
		},
	});
	if (expectations.requireCompletion) {
		const done = (records ?? []).some((record) => record.event === "done");
		results.push({
			name: "recovered-without-intervention",
			passed: done,
			expected: "a writer completed after the last fault",
			actual: done ? "completed" : "no completion",
		});
	}
	return results;
}

/**
 * Replays at the at-least-once boundary: acknowledgements whose append found the key already stored.
 * @param {readonly WriterRecord[]} records
 */
export function atLeastOnceReplays(records) {
	return records.filter((record) => record.event === "ack" && record.status === "exists").length;
}

/**
 * Median and spread of acknowledged append latencies in a time window.
 * @param {readonly WriterRecord[]} records
 * @param {{ from: number, to: number }} window
 */
export function latencyStats(records, { from, to }) {
	const values = records
		.filter(
			(record) =>
				record.event === "ack" &&
				typeof record.ms === "number" &&
				typeof record.at === "number" &&
				record.at >= from &&
				record.at <= to,
		)
		.map((record) => /** @type {number} */ (record.ms))
		.sort((a, b) => a - b);
	if (values.length === 0) return { count: 0, median: null, p10: null, p90: null };
	const at = (/** @type {number} */ q) => values[Math.floor(q * values.length)];
	return { count: values.length, median: at(0.5), p10: at(0.1), p90: at(0.9) };
}

/**
 * One typed failure per failed invariant, for the report's failure list.
 * @param {readonly InvariantResult[]} results
 * @param {string} scenario
 */
export function invariantFailures(results, scenario) {
	return results
		.filter((result) => !result.passed)
		.map(
			(result) =>
				new DistributedInvariantError({
					invariant: result.name,
					scenario,
					expected: result.expected,
					actual: result.actual,
				}),
		);
}
