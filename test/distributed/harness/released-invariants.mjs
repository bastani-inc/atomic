// @ts-check
/**
 * Invariants of the `idle-density` suite (#4394) over the raw evidence its node driver recorded: every sender's
 * outcome log, the owner's log, and the transcripts of the released children read back after the owner stopped.
 * Each checker returns `{ name, passed, expected, actual }`; missing evidence is a failure, never a pass.
 */

import { UNTYPED_ERROR_NAMES } from "./invariants.mjs";

/**
 * @typedef {import("./invariants.mjs").InvariantResult} InvariantResult
 * @typedef {{ name: string, code: string | null }} ErrorName
 * @typedef {{ event: string, at?: number, child?: string, k?: number, id?: string, delivered?: boolean, queued?: boolean,
 *   reason?: string | null, reasonCode?: string | null, retries?: number, ms?: number, generation?: number, error?: ErrorName }} SenderRecord
 * @typedef {{ event: string, at?: number, reopened?: boolean, children?: number, released?: number, running?: number,
 *   other?: number, wakeFailures?: number, error?: ErrorName }} OwnerRecord
 * @typedef {{ name: string, state: string, terminalStatus: string | null, wakeFailure: boolean, readable: boolean,
 *   messages: { id: string, text: string }[] }} InspectedChild
 * @typedef {{ status: { children: number, released: number, running: number, other: number, wakeFailures: number },
 *   children: InspectedChild[] }} Inspection
 * @typedef {"delivered" | "queued" | "refused" | "untyped" | "failed"} SendClass
 * @typedef {{ sender: string, child: string, k: number, id: string, at: number, class: SendClass, record: SenderRecord }} SendOutcome
 * @typedef {{ senders: readonly { name: string, records: readonly SenderRecord[] | undefined }[],
 *   owner: readonly OwnerRecord[] | undefined, inspection: Inspection | undefined, children: readonly string[],
 *   integrity: { shared: readonly string[] | undefined, owner: readonly string[] | undefined }, ownerKills: number }} ReleasedEvidence
 */

/** The text a sender gives its `k`-th message to a child: `ADT <sender> <child> <k>`. */
export const MESSAGE_PATTERN = /^ADT (\S+) (\S+) (\d+)$/;

/**
 * What a send outcome promises about arrival: `delivered` and `queued` were accepted and must arrive exactly once; a
 * refusal carries a `reasonCode` and must not arrive; a false result with neither is `untyped`, whether the broker
 * refused it or could not tell; a thrown send is `failed`, whose arrival is uncertain.
 * @param {SenderRecord} record a `send` or `send-failed` record
 * @returns {SendClass}
 */
export function classifySend(record) {
	if (record.event === "send-failed") return "failed";
	if (record.delivered === true) return "delivered";
	if (record.queued === true) return "queued";
	return typeof record.reasonCode === "string" && record.reasonCode !== "" ? "refused" : "untyped";
}

/**
 * Every completed send of every sender, classified.
 * @param {ReleasedEvidence["senders"]} senders
 * @returns {SendOutcome[]}
 */
export function sendOutcomes(senders) {
	return senders.flatMap(({ name, records }) =>
		(records === undefined ? [] : records)
			.filter((record) => record.event === "send" || record.event === "send-failed")
			.map((record) => ({
				sender: name,
				child: record.child ?? "",
				k: record.k ?? 0,
				id: record.id ?? "",
				at: record.at ?? 0,
				class: classifySend(record),
				record,
			})),
	);
}

/**
 * How many times each message id arrived, per child.
 * @param {Inspection | undefined} inspection
 * @returns {Map<string, Map<string, number>>}
 */
function arrivalsByChild(inspection) {
	/** @type {Map<string, Map<string, number>>} */
	const arrivals = new Map();
	for (const child of inspection?.children ?? []) {
		/** @type {Map<string, number>} */
		const ids = new Map();
		for (const message of child.messages) ids.set(message.id, (ids.get(message.id) ?? 0) + 1);
		arrivals.set(child.name, ids);
	}
	return arrivals;
}

/**
 * Sends of `classes` that did not arrive exactly once, by the number of times they did arrive.
 * @param {readonly SendOutcome[]} outcomes
 * @param {Map<string, Map<string, number>>} arrivals
 * @param {readonly SendClass[]} classes
 */
function arrivalTally(outcomes, arrivals, classes) {
	const selected = outcomes.filter((outcome) => classes.includes(outcome.class));
	const times = selected.map((outcome) => arrivals.get(outcome.child)?.get(outcome.id) ?? 0);
	const missing = selected.filter((_, index) => times[index] === 0);
	const duplicated = selected.filter((_, index) => times[index] > 1);
	return {
		sends: selected.length,
		missing: missing.length,
		duplicated: duplicated.length,
		firstMissing: missing[0] === undefined ? null : `${missing[0].sender} ${missing[0].child} ${missing[0].k}`,
		firstDuplicated:
			duplicated[0] === undefined ? null : `${duplicated[0].sender} ${duplicated[0].child} ${duplicated[0].k}`,
	};
}

/**
 * Sends logged as started without a logged outcome.
 * @param {readonly SenderRecord[]} records
 */
function unfinishedSends(records) {
	const finished = new Set(
		records.filter((record) => record.event === "send" || record.event === "send-failed").map((record) => record.id),
	);
	return records.filter((record) => record.event === "send-start" && !finished.has(record.id)).length;
}

/**
 * Per child and sender, the positions where a message's `k` did not exceed the previous one in transcript order.
 * @param {Inspection | undefined} inspection
 */
function orderViolations(inspection) {
	let violations = 0;
	let unparsed = 0;
	/** @type {string | null} */
	let first = null;
	for (const child of inspection?.children ?? []) {
		/** @type {Map<string, number>} */
		const last = new Map();
		for (const message of child.messages) {
			const match = MESSAGE_PATTERN.exec(message.text);
			if (match === null || match[2] !== child.name) {
				unparsed++;
				continue;
			}
			const [, sender, , k] = match;
			const previous = last.get(sender) ?? 0;
			if (Number(k) <= previous) {
				violations++;
				first ??= `${child.name}: ${sender} ${k} after ${previous}`;
			}
			last.set(sender, Math.max(previous, Number(k)));
		}
	}
	return { violations, unparsed, first };
}

/**
 * The suite's invariants.
 * @param {ReleasedEvidence} evidence
 * @returns {InvariantResult[]}
 */
export function checkReleasedInvariants(evidence) {
	const { senders, owner, inspection, children, integrity, ownerKills } = evidence;
	/** @type {InvariantResult[]} */
	const results = [];
	const outcomes = sendOutcomes(senders);
	const arrivals = arrivalsByChild(inspection);
	const inspectedChildren = inspection?.children ?? [];
	const ownerRecords = owner === undefined ? [] : owner;
	const inspected = new Set(inspectedChildren.map((child) => child.name));
	const senderLogs = senders.filter((item) => item.records !== undefined).length;
	const unfinishedSenders = senders
		.filter((item) => item.records !== undefined && !item.records.some((record) => record.event === "sender-done"))
		.map((item) => item.name);
	const unfinished = senders.reduce(
		(sum, item) => sum + (item.records === undefined ? 0 : unfinishedSends(item.records)),
		0,
	);
	const missingChildren = children.filter((name) => !inspected.has(name));
	results.push({
		name: "evidence-complete",
		passed:
			senderLogs === senders.length &&
			unfinishedSenders.length === 0 &&
			unfinished === 0 &&
			owner !== undefined &&
			children.length > 0 &&
			missingChildren.length === 0 &&
			inspected.size === children.length &&
			outcomes.length > 0,
		expected: { senderLogs: senders.length, unfinishedSenders: [], unfinishedSends: 0, children: children.length },
		actual: {
			senderLogs,
			unfinishedSenders,
			unfinishedSends: unfinished,
			ownerLog: owner !== undefined,
			inspected: inspected.size,
			missingChildren,
			outcomes: outcomes.length,
		},
	});
	const delivered = arrivalTally(outcomes, arrivals, ["delivered"]);
	results.push({
		name: "delivered-exactly-once",
		passed: inspection !== undefined && delivered.missing === 0 && delivered.duplicated === 0,
		expected: { missing: 0, duplicated: 0 },
		actual: delivered,
	});
	const order = orderViolations(inspection);
	results.push({
		name: "per-sender-order",
		passed: inspection !== undefined && order.violations === 0 && order.unparsed === 0,
		expected: { violations: 0, unparsed: 0 },
		actual: order,
	});
	const repeated = [...arrivals].flatMap(([child, ids]) =>
		[...ids].filter(([, times]) => times > 1).map(([id]) => `${child} ${id}`),
	);
	results.push({
		name: "no-duplicate-messages",
		passed: inspection !== undefined && repeated.length === 0,
		expected: { repeated: 0 },
		actual: { repeated: repeated.length, first: repeated[0] ?? null },
	});
	const queued = arrivalTally(outcomes, arrivals, ["queued"]);
	results.push({
		name: "queued-eventually-delivered",
		passed: inspection !== undefined && queued.missing === 0 && queued.duplicated === 0,
		expected: { missing: 0, duplicated: 0 },
		actual: queued,
	});
	const refused = outcomes.filter((outcome) => outcome.class === "refused");
	const refusedArrived = refused.filter((outcome) => (arrivals.get(outcome.child)?.get(outcome.id) ?? 0) > 0);
	results.push({
		name: "refused-not-delivered",
		passed: inspection !== undefined && refusedArrived.length === 0,
		expected: { arrived: 0 },
		actual: { refused: refused.length, arrived: refusedArrived.length },
	});
	const untypedNonDeliveries = outcomes.filter((outcome) => outcome.class === "untyped").length;
	const untypedFailures = outcomes.filter(
		(outcome) => outcome.class === "failed" && UNTYPED_ERROR_NAMES.includes(outcome.record.error?.name ?? "Error"),
	).length;
	const failureNames = [
		...new Set(
			outcomes.filter((outcome) => outcome.class === "failed").map((outcome) => outcome.record.error?.name ?? ""),
		),
	];
	results.push({
		name: "non-deliveries-typed",
		passed: untypedNonDeliveries === 0 && untypedFailures === 0,
		expected: { untypedNonDeliveries: 0, untypedFailures: 0 },
		actual: { untypedNonDeliveries, untypedFailures, failureNames },
	});
	const accepted = arrivalTally(outcomes, arrivals, ["delivered", "queued"]);
	const wakeFailures = inspectedChildren.filter((child) => child.wakeFailure).length;
	results.push({
		name: "no-lost-wakes",
		passed: inspection !== undefined && accepted.missing === 0 && wakeFailures === 0,
		expected: { acceptedNotArrived: 0, wakeFailures: 0 },
		actual: { accepted: accepted.sends, acceptedNotArrived: accepted.missing, wakeFailures },
	});
	const final = ownerRecords.findLast((record) => record.event === "final-status");
	results.push({
		name: "settled-to-released",
		passed:
			final !== undefined &&
			final.children === children.length &&
			final.released === children.length &&
			final.running === 0 &&
			final.other === 0,
		expected: { children: children.length, released: children.length, running: 0, other: 0 },
		actual:
			final === undefined
				? null
				: {
						children: final.children ?? null,
						released: final.released ?? null,
						running: final.running ?? null,
						other: final.other ?? null,
					},
	});
	const unreadable = inspectedChildren.filter((child) => !child.readable).length;
	/** @param {readonly string[] | undefined} result */
	const ok = (result) => result !== undefined && result.length === 1 && result[0] === "ok";
	results.push({
		name: "session-integrity",
		passed: ok(integrity.shared) && ok(integrity.owner) && inspection !== undefined && unreadable === 0,
		expected: { shared: ["ok"], owner: ["ok"], unreadableChildren: 0 },
		actual: {
			shared: integrity.shared === undefined ? null : [...integrity.shared],
			owner: integrity.owner === undefined ? null : [...integrity.owner],
			unreadableChildren: unreadable,
		},
	});
	const starts = ownerRecords.filter((record) => record.event === "owner-start");
	const rebinds = ownerRecords.filter((record) => record.event === "owner-rebound");
	const restarts = starts.slice(1);
	const stoppedAt = ownerRecords.findIndex((record) => record.event === "final-status");
	const running = stoppedAt === -1 ? ownerRecords : ownerRecords.slice(0, stoppedAt);
	const stopping = stoppedAt === -1 ? [] : ownerRecords.slice(stoppedAt + 1);
	/** @param {OwnerRecord} record */
	const crash = (record) => record.event === "uncaught" || record.event === "fatal";
	const crashes = running.filter(crash);
	const shutdownCrashes = stopping.filter(crash);
	const lastStart = starts.at(-1)?.at ?? Number.POSITIVE_INFINITY;
	const deliveredAfter = outcomes.filter((outcome) => outcome.class === "delivered" && outcome.at > lastStart).length;
	results.push({
		name: "owner-recovered",
		passed:
			starts.length === 1 + ownerKills &&
			restarts.every((record) => record.reopened === true) &&
			rebinds.length === ownerKills &&
			rebinds.every((record) => record.children === children.length) &&
			crashes.length === 0 &&
			(ownerKills === 0 || deliveredAfter > 0),
		expected: { starts: 1 + ownerKills, rebound: ownerKills, children: children.length, crashes: 0 },
		actual: {
			starts: starts.length,
			reopened: restarts.filter((record) => record.reopened === true).length,
			rebound: rebinds.length,
			reboundChildren: rebinds.map((record) => record.children ?? null),
			crashes: crashes.map((record) => record.error?.name ?? record.event),
			shutdownCrashes: shutdownCrashes.map((record) => record.error?.name ?? record.event),
			deliveredAfterLastStart: deliveredAfter,
		},
	});
	return results;
}

/**
 * Outcome counts, latency and reconnects for the report.
 * @param {ReleasedEvidence["senders"]} senders
 */
export function releasedMetrics(senders) {
	const outcomes = sendOutcomes(senders);
	/** @type {Record<SendClass, number>} */
	const classes = { delivered: 0, queued: 0, refused: 0, untyped: 0, failed: 0 };
	for (const outcome of outcomes) classes[outcome.class]++;
	/** @type {Map<string, number>} */
	const reasons = new Map();
	for (const outcome of outcomes) {
		const key =
			outcome.class === "failed"
				? (outcome.record.error?.name ?? "unknown")
				: outcome.class === "refused"
					? String(outcome.record.reasonCode)
					: undefined;
		if (key !== undefined) reasons.set(key, (reasons.get(key) ?? 0) + 1);
	}
	const latencies = outcomes
		.filter((outcome) => outcome.class === "delivered" && typeof outcome.record.ms === "number")
		.map((outcome) => /** @type {number} */ (outcome.record.ms))
		.sort((a, b) => a - b);
	const at = (/** @type {number} */ q) =>
		latencies.length === 0 ? null : latencies[Math.floor(q * latencies.length)];
	return {
		sends: outcomes.length,
		classes,
		nonDeliveries: [...reasons].map(([name, count]) => ({ name, count })),
		retried: outcomes.filter((outcome) => (outcome.record.retries ?? 0) > 0).length,
		connections: Object.fromEntries(
			senders.map(({ name, records }) => [
				name,
				records === undefined ? 0 : records.filter((record) => record.event === "connected").length,
			]),
		),
		deliveredLatencyMs: { median: at(0.5), p90: at(0.9), max: latencies.at(-1) ?? null },
	};
}
