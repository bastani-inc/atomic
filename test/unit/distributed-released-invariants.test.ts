import assert from "node:assert/strict";
import { test } from "vitest";
import {
	checkReleasedInvariants,
	classifySend,
	MESSAGE_PATTERN,
	releasedMetrics,
	sendOutcomes,
} from "../distributed/harness/released-invariants.mjs";

type SenderRecord = Parameters<typeof classifySend>[0];
type Evidence = Parameters<typeof checkReleasedInvariants>[0];
type Inspection = NonNullable<Evidence["inspection"]>;
type OwnerRecord = NonNullable<Evidence["owner"]>[number];

const CHILDREN = ["c1", "c2"];

const field = (value: unknown, key: string) => Reflect.get(Object(value), key);

/** One sender's log: `k` = 1..2 to each child, every send delivered, and a final `sender-done`. */
function senderLog(name: string, at = 100): SenderRecord[] {
	const records: SenderRecord[] = [{ event: "connected", generation: 1, at }];
	for (const k of [1, 2])
		for (const child of CHILDREN) {
			const id = `${name}-${child}-${k}`;
			records.push({ event: "send-start", child, k, id, at });
			records.push({
				event: "send",
				child,
				k,
				id,
				delivered: true,
				queued: false,
				reasonCode: null,
				retries: 0,
				ms: k * 10,
				at: at + k,
			});
		}
	records.push({ event: "sender-done", at: at + 10 });
	return records;
}

function inspection(): Inspection {
	return {
		status: { children: 2, released: 2, running: 0, other: 0, wakeFailures: 0 },
		children: CHILDREN.map((child) => ({
			name: child,
			state: "terminal",
			terminalStatus: "released",
			wakeFailure: false,
			readable: true,
			messages: [1, 2].flatMap((k) =>
				["s1", "s2"].map((sender) => ({ id: `${sender}-${child}-${k}`, text: `ADT ${sender} ${child} ${k}` })),
			),
		})),
	};
}

function ownerLog(kills = 0): OwnerRecord[] {
	const records: OwnerRecord[] = [{ event: "owner-start", reopened: false, children: 2, at: 1 }];
	for (let kill = 0; kill < kills; kill++) {
		records.push({ event: "owner-start", reopened: true, children: 2, at: 50 });
		records.push({ event: "owner-rebound", children: 2, released: 2, running: 0, other: 0, wakeFailures: 0, at: 51 });
		records.push({
			event: "owner-recovery",
			children: 2,
			released: 2,
			running: 0,
			other: 0,
			wakeFailures: 0,
			at: 52,
		});
	}
	records.push({ event: "final-status", children: 2, released: 2, running: 0, other: 0, wakeFailures: 0, at: 200 });
	return records;
}

function evidence(overrides: Partial<Evidence> = {}): Evidence {
	return {
		senders: [
			{ name: "s1", records: senderLog("s1") },
			{ name: "s2", records: senderLog("s2") },
		],
		owner: ownerLog(),
		inspection: inspection(),
		children: CHILDREN,
		integrity: { shared: ["ok"], owner: ["ok"] },
		ownerKills: 0,
		...overrides,
	};
}

function result(evidenceValue: Evidence, name: string) {
	const found = checkReleasedInvariants(evidenceValue).find((item) => item.name === name);
	assert.ok(found, `${name} is checked`);
	return found;
}

function withMessages(edit: (children: Inspection["children"]) => void): Inspection {
	const value = inspection();
	edit(value.children);
	return value;
}

test("a clean run passes every released-subagent invariant (#4394)", () => {
	const tally = { missing: 0, duplicated: 0, firstMissing: null, firstDuplicated: null };
	assert.deepEqual(checkReleasedInvariants(evidence()), [
		{
			name: "evidence-complete",
			passed: true,
			expected: { senderLogs: 2, unfinishedSenders: [], unfinishedSends: 0, children: 2 },
			actual: {
				senderLogs: 2,
				unfinishedSenders: [],
				unfinishedSends: 0,
				ownerLog: true,
				inspected: 2,
				missingChildren: [],
				outcomes: 8,
			},
		},
		{
			name: "delivered-exactly-once",
			passed: true,
			expected: { missing: 0, duplicated: 0 },
			actual: { sends: 8, ...tally },
		},
		{
			name: "per-sender-order",
			passed: true,
			expected: { violations: 0, unparsed: 0 },
			actual: { violations: 0, unparsed: 0, first: null },
		},
		{ name: "no-duplicate-messages", passed: true, expected: { repeated: 0 }, actual: { repeated: 0, first: null } },
		{
			name: "queued-eventually-delivered",
			passed: true,
			expected: { missing: 0, duplicated: 0 },
			actual: { sends: 0, ...tally },
		},
		{ name: "refused-not-delivered", passed: true, expected: { arrived: 0 }, actual: { refused: 0, arrived: 0 } },
		{
			name: "non-deliveries-typed",
			passed: true,
			expected: { untypedNonDeliveries: 0, untypedFailures: 0 },
			actual: { untypedNonDeliveries: 0, untypedFailures: 0, failureNames: [] },
		},
		{
			name: "no-lost-wakes",
			passed: true,
			expected: { acceptedNotArrived: 0, wakeFailures: 0 },
			actual: { accepted: 8, acceptedNotArrived: 0, wakeFailures: 0 },
		},
		{
			name: "settled-to-released",
			passed: true,
			expected: { children: 2, released: 2, running: 0, other: 0 },
			actual: { children: 2, released: 2, running: 0, other: 0 },
		},
		{
			name: "session-integrity",
			passed: true,
			expected: { shared: ["ok"], owner: ["ok"], unreadableChildren: 0 },
			actual: { shared: ["ok"], owner: ["ok"], unreadableChildren: 0 },
		},
		{
			name: "owner-recovered",
			passed: true,
			expected: { starts: 1, rebound: 0, recovered: 0, children: 2, crashes: 0 },
			actual: {
				starts: 1,
				reopened: 0,
				rebound: 0,
				reboundChildren: [],
				recovered: 0,
				crashes: [],
				shutdownCrashes: [],
				deliveredAfterLastStart: 8,
			},
		},
	]);
});

test("without transcripts nothing passes for lack of a counterexample, even when no send was accepted (#4394)", () => {
	const refusedOnly = senderLog("s1").map((record) =>
		record.event === "send" ? { ...record, delivered: false, reasonCode: "session_not_found" } : record,
	);
	const results = checkReleasedInvariants(
		evidence({ senders: [{ name: "s1", records: refusedOnly }], inspection: undefined }),
	);
	assert.deepEqual(
		results.filter((item) => item.passed).map((item) => item.name),
		["non-deliveries-typed", "settled-to-released", "owner-recovered"],
	);
	assert.deepEqual(field(results.find((item) => item.name === "evidence-complete")?.actual, "inspected"), 0);
	const noChildren = evidence({ children: [], inspection: { ...inspection(), children: [] } });
	assert.equal(result(noChildren, "evidence-complete").passed, false);
	const swapped = evidence({ children: ["c1", "c3"] });
	assert.deepEqual(field(result(swapped, "evidence-complete").actual, "missingChildren"), ["c3"]);
	assert.equal(result(swapped, "evidence-complete").passed, false);
	const failedSend = [
		...senderLog("s1"),
		{ event: "send-start", child: "c1", k: 3, id: "f" },
		{ event: "send-failed", child: "c1", k: 3, id: "f", error: { name: "IntercomBrokerTimeoutError", code: null } },
	];
	const settledFailure = evidence({ senders: [{ name: "s1", records: failedSend }] });
	assert.equal(field(result(settledFailure, "evidence-complete").actual, "unfinishedSends"), 0);
	assert.equal(result(settledFailure, "evidence-complete").passed, true);
});

test("send outcomes are classified by what they promise about arrival (#4394)", () => {
	assert.equal(classifySend({ event: "send-failed", delivered: true }), "failed");
	assert.equal(classifySend({ event: "send", delivered: true, queued: true }), "delivered");
	assert.equal(classifySend({ event: "send", delivered: false, queued: true }), "queued");
	assert.equal(
		classifySend({ event: "send", delivered: false, queued: false, reasonCode: "session_not_found" }),
		"refused",
	);
	assert.equal(classifySend({ event: "send", delivered: false, queued: false, reasonCode: null }), "untyped");
	assert.equal(classifySend({ event: "send", delivered: false, reasonCode: "" }), "untyped");
	assert.equal(classifySend({ event: "send" }), "untyped");
	assert.deepEqual(
		sendOutcomes([
			{ name: "s9", records: [{ event: "send-start", id: "x" }, { event: "send" }, { event: "sender-done" }] },
			{ name: "s8", records: undefined },
		]),
		[{ sender: "s9", child: "", k: 0, id: "", at: 0, class: "untyped", record: { event: "send" } }],
	);
	assert.ok(MESSAGE_PATTERN.test("ADT s1 child-a 12"));
	assert.equal(MESSAGE_PATTERN.test("ADT s1 child-a 12 extra"), false);
	assert.equal(MESSAGE_PATTERN.test("prefix ADT s1 child-a 12"), false);
});

test("missing or unfinished evidence fails evidence-complete instead of shrinking the history (#4394)", () => {
	const cases: [string, Partial<Evidence>][] = [
		[
			"missing sender log",
			{
				senders: [
					{ name: "s1", records: senderLog("s1") },
					{ name: "s2", records: undefined },
				],
			},
		],
		[
			"sender without sender-done",
			{ senders: [{ name: "s1", records: senderLog("s1").filter((item) => item.event !== "sender-done") }] },
		],
		[
			"send without an outcome",
			{
				senders: [
					{ name: "s1", records: [...senderLog("s1"), { event: "send-start", child: "c1", k: 3, id: "open" }] },
				],
			},
		],
		["no owner log", { owner: undefined }],
		["no inspection", { inspection: undefined }],
		["no children", { children: [] }],
		["child missing from the inspection", { children: [...CHILDREN, "c3"] }],
		["unexpected child in the inspection", { children: ["c1"] }],
		["no outcomes", { senders: [{ name: "s1", records: [{ event: "sender-done" }] }] }],
	];
	for (const [label, overrides] of cases)
		assert.equal(result(evidence(overrides), "evidence-complete").passed, false, label);
	assert.deepEqual(
		result(
			evidence({
				senders: [
					{
						name: "s1",
						records: [...senderLog("s1").slice(0, -1), { event: "send-start", child: "c1", k: 3, id: "open" }],
					},
					{ name: "s2", records: undefined },
				],
				owner: undefined,
				children: [...CHILDREN, "c3"],
			}),
			"evidence-complete",
		).actual,
		{
			senderLogs: 1,
			unfinishedSenders: ["s1"],
			unfinishedSends: 1,
			ownerLog: false,
			inspected: 2,
			missingChildren: ["c3"],
			outcomes: 4,
		},
	);
});

test("a delivered send must arrive exactly once (#4394)", () => {
	const lost = withMessages((children) => {
		children[0]?.messages.splice(0, 1);
	});
	assert.deepEqual(result(evidence({ inspection: lost }), "delivered-exactly-once"), {
		name: "delivered-exactly-once",
		passed: false,
		expected: { missing: 0, duplicated: 0 },
		actual: { sends: 8, missing: 1, duplicated: 0, firstMissing: "s1 c1 1", firstDuplicated: null },
	});
	const twice = withMessages((children) => {
		const first = children[1]?.messages[3];
		if (first) children[1]?.messages.push(first);
	});
	assert.deepEqual(result(evidence({ inspection: twice }), "delivered-exactly-once").actual, {
		sends: 8,
		missing: 0,
		duplicated: 1,
		firstMissing: null,
		firstDuplicated: "s2 c2 2",
	});
	assert.equal(result(evidence({ inspection: twice }), "delivered-exactly-once").passed, false);
	assert.equal(result(evidence({ inspection: undefined }), "delivered-exactly-once").passed, false);
	const elsewhere = withMessages((children) => {
		const moved = children[0]?.messages.shift();
		if (moved) children[1]?.messages.push(moved);
	});
	assert.equal(result(evidence({ inspection: elsewhere }), "delivered-exactly-once").passed, false);
});

test("each sender's messages reach a child in the order it sent them (#4394)", () => {
	const swapped = withMessages((children) => {
		const messages = children[0]?.messages ?? [];
		[messages[0], messages[2]] = [messages[2] as never, messages[0] as never];
	});
	assert.deepEqual(result(evidence({ inspection: swapped }), "per-sender-order").actual, {
		violations: 1,
		unparsed: 0,
		first: "c1: s1 1 after 2",
	});
	const repeated = withMessages((children) => {
		children[0]?.messages.push({ id: "again", text: "ADT s1 c1 2" });
	});
	assert.equal(result(evidence({ inspection: repeated }), "per-sender-order").passed, false);
	const interleaved = withMessages((children) => {
		const messages = children[0]?.messages ?? [];
		[messages[1], messages[2]] = [messages[2] as never, messages[1] as never];
	});
	assert.equal(result(evidence({ inspection: interleaved }), "per-sender-order").passed, true);
	const foreign = withMessages((children) => {
		children[0]?.messages.push({ id: "other", text: "hello" });
	});
	assert.deepEqual(result(evidence({ inspection: foreign }), "per-sender-order").actual, {
		violations: 0,
		unparsed: 1,
		first: null,
	});
	assert.equal(result(evidence({ inspection: foreign }), "per-sender-order").passed, false);
	const misrouted = withMessages((children) => {
		children[0]?.messages.push({ id: "misrouted", text: "ADT s1 c2 9" });
	});
	assert.equal(field(result(evidence({ inspection: misrouted }), "per-sender-order").actual, "unparsed"), 1);
	assert.equal(result(evidence({ inspection: undefined }), "per-sender-order").passed, false);
});

test("no message id reaches a child twice, whatever its send's outcome (#4394)", () => {
	const failedTwice = withMessages((children) => {
		children[0]?.messages.push({ id: "uncertain", text: "ADT s1 c1 3" }, { id: "uncertain", text: "ADT s1 c1 3" });
	});
	assert.equal(result(evidence({ inspection: failedTwice }), "no-duplicate-messages").passed, false);
	assert.deepEqual(result(evidence({ inspection: failedTwice }), "no-duplicate-messages").actual, {
		repeated: 1,
		first: "c1 uncertain",
	});
	assert.equal(result(evidence({ inspection: undefined }), "no-duplicate-messages").passed, false);
});

test("an accepted queued send must arrive once the children settle; a refused one never (#4394)", () => {
	const queuedLog = senderLog("s1").map((record) =>
		record.event === "send" && record.child === "c2" && record.k === 2
			? { ...record, delivered: false, queued: true }
			: record,
	);
	const pass = evidence({
		senders: [
			{ name: "s1", records: queuedLog },
			{ name: "s2", records: senderLog("s2") },
		],
	});
	assert.equal(result(pass, "queued-eventually-delivered").passed, true);
	assert.equal(field(result(pass, "delivered-exactly-once").actual, "sends"), 7);
	const lost = withMessages((children) => {
		children[1]?.messages.splice(2, 1);
	});
	const failed = evidence({
		senders: [
			{ name: "s1", records: queuedLog },
			{ name: "s2", records: senderLog("s2") },
		],
		inspection: lost,
	});
	assert.equal(result(failed, "queued-eventually-delivered").passed, false);
	assert.deepEqual(result(failed, "queued-eventually-delivered").actual, {
		sends: 1,
		missing: 1,
		duplicated: 0,
		firstMissing: "s1 c2 2",
		firstDuplicated: null,
	});
	assert.equal(result(failed, "delivered-exactly-once").passed, true);
	assert.deepEqual(result(failed, "no-lost-wakes").actual, { accepted: 8, acceptedNotArrived: 1, wakeFailures: 0 });
	assert.equal(result(failed, "no-lost-wakes").passed, false);
	const doubled = withMessages((children) => {
		const message = children[1]?.messages[2];
		if (message) children[1]?.messages.push(message);
	});
	assert.equal(
		result(
			evidence({
				senders: [
					{ name: "s1", records: queuedLog },
					{ name: "s2", records: senderLog("s2") },
				],
				inspection: doubled,
			}),
			"queued-eventually-delivered",
		).passed,
		false,
	);
	assert.equal(result(evidence({ inspection: undefined }), "queued-eventually-delivered").passed, false);

	const refusedLog = senderLog("s1").map((record) =>
		record.event === "send" && record.child === "c1" && record.k === 1
			? { ...record, delivered: false, queued: false, reasonCode: "recipient_parked" }
			: record,
	);
	const refused = evidence({
		senders: [
			{ name: "s1", records: refusedLog },
			{ name: "s2", records: senderLog("s2") },
		],
	});
	assert.deepEqual(result(refused, "refused-not-delivered").actual, { refused: 1, arrived: 1 });
	assert.equal(result(refused, "refused-not-delivered").passed, false);
	const dropped = withMessages((children) => {
		children[0]?.messages.splice(0, 1);
	});
	assert.equal(
		result(
			evidence({
				senders: [
					{ name: "s1", records: refusedLog },
					{ name: "s2", records: senderLog("s2") },
				],
				inspection: dropped,
			}),
			"refused-not-delivered",
		).passed,
		true,
	);
	assert.equal(result(evidence({ inspection: undefined }), "refused-not-delivered").passed, false);
});

test("every non-delivery carries a reason code or a typed error name (#4394)", () => {
	const log = (record: SenderRecord) => evidence({ senders: [{ name: "s1", records: [...senderLog("s1"), record] }] });
	assert.deepEqual(
		result(
			log({ event: "send", child: "c1", k: 3, id: "r", delivered: false, queued: false, reasonCode: null }),
			"non-deliveries-typed",
		).actual,
		{ untypedNonDeliveries: 1, untypedFailures: 0, failureNames: [] },
	);
	assert.equal(
		result(
			log({ event: "send", child: "c1", k: 3, id: "r", delivered: false, queued: false, reasonCode: null }),
			"non-deliveries-typed",
		).passed,
		false,
	);
	assert.deepEqual(
		result(
			log({ event: "send-failed", child: "c1", k: 3, id: "f", error: { name: "Error", code: null } }),
			"non-deliveries-typed",
		).actual,
		{ untypedNonDeliveries: 0, untypedFailures: 1, failureNames: ["Error"] },
	);
	assert.equal(
		result(
			log({ event: "send-failed", child: "c1", k: 3, id: "f", error: { name: "Error", code: null } }),
			"non-deliveries-typed",
		).passed,
		false,
	);
	assert.deepEqual(
		field(
			result(log({ event: "send-failed", child: "c1", k: 3, id: "f" }), "non-deliveries-typed").actual,
			"failureNames",
		),
		[""],
	);
	assert.deepEqual(
		result(
			log({ event: "send", child: "c9", k: 1, id: "gone", delivered: false, reasonCode: "session_not_found" }),
			"refused-not-delivered",
		),
		{ name: "refused-not-delivered", passed: true, expected: { arrived: 0 }, actual: { refused: 1, arrived: 0 } },
	);
	assert.equal(
		result(log({ event: "send-failed", child: "c1", k: 3, id: "f" }), "non-deliveries-typed").passed,
		false,
	);
	const typed = log({
		event: "send-failed",
		child: "c1",
		k: 3,
		id: "f",
		error: { name: "IntercomClientDisconnectedError", code: null },
	});
	assert.deepEqual(result(typed, "non-deliveries-typed"), {
		name: "non-deliveries-typed",
		passed: true,
		expected: { untypedNonDeliveries: 0, untypedFailures: 0 },
		actual: { untypedNonDeliveries: 0, untypedFailures: 0, failureNames: ["IntercomClientDisconnectedError"] },
	});
	assert.equal(result(typed, "delivered-exactly-once").passed, true);
});

test("a recorded wake failure is a lost wake (#4394)", () => {
	const failed = withMessages((children) => {
		if (children[1]) children[1].wakeFailure = true;
	});
	assert.deepEqual(result(evidence({ inspection: failed }), "no-lost-wakes"), {
		name: "no-lost-wakes",
		passed: false,
		expected: { acceptedNotArrived: 0, wakeFailures: 0 },
		actual: { accepted: 8, acceptedNotArrived: 0, wakeFailures: 1 },
	});
	assert.equal(result(evidence({ inspection: undefined }), "no-lost-wakes").passed, false);
});

test("every child settles back to released before the owner stops (#4394)", () => {
	const final = (status: Partial<OwnerRecord>) =>
		evidence({
			owner: [
				{ event: "owner-start", reopened: false, at: 1 },
				{ event: "final-status", children: 2, released: 2, running: 0, other: 0, ...status },
			],
		});
	assert.equal(result(final({}), "settled-to-released").passed, true);
	assert.equal(result(final({ children: 3 }), "settled-to-released").passed, false);
	assert.deepEqual(result(final({ released: 1, running: 1 }), "settled-to-released").actual, {
		children: 2,
		released: 1,
		running: 1,
		other: 0,
	});
	for (const status of [{ children: 3, released: 3 }, { released: 1 }, { running: 1 }, { other: 1 }])
		assert.equal(result(final(status), "settled-to-released").passed, false, JSON.stringify(status));
	const missing = evidence({ owner: [{ event: "owner-start", reopened: false }] });
	assert.deepEqual(result(missing, "settled-to-released").actual, null);
	assert.equal(result(missing, "settled-to-released").passed, false);
	const later = evidence({
		owner: [
			{ event: "owner-start", reopened: false },
			{ event: "final-status", children: 2, released: 2, running: 0, other: 0 },
			{ event: "final-status", children: 2, released: 0, running: 2, other: 0 },
		],
	});
	assert.equal(result(later, "settled-to-released").passed, false);
	assert.deepEqual(result(evidence({ owner: [{ event: "final-status" }] }), "settled-to-released").actual, {
		children: null,
		released: null,
		running: null,
		other: null,
	});
});

test("both stores pass integrity_check and every child transcript reads back (#4394)", () => {
	assert.deepEqual(result(evidence(), "session-integrity").actual, {
		shared: ["ok"],
		owner: ["ok"],
		unreadableChildren: 0,
	});
	for (const integrity of [
		{ shared: undefined, owner: ["ok"] },
		{ shared: ["ok"], owner: undefined },
		{ shared: ["*** in database main ***"], owner: ["ok"] },
		{ shared: ["ok"], owner: ["ok", "row 3 missing"] },
		{ shared: [], owner: ["ok"] },
	])
		assert.equal(result(evidence({ integrity }), "session-integrity").passed, false, JSON.stringify(integrity));
	assert.deepEqual(result(evidence({ integrity: { shared: undefined, owner: ["ok"] } }), "session-integrity").actual, {
		shared: null,
		owner: ["ok"],
		unreadableChildren: 0,
	});
	const unreadable = withMessages((children) => {
		if (children[0]) children[0].readable = false;
	});
	assert.equal(
		field(result(evidence({ inspection: unreadable }), "session-integrity").actual, "unreadableChildren"),
		1,
	);
	assert.equal(result(evidence({ inspection: unreadable }), "session-integrity").passed, false);
	assert.equal(result(evidence({ inspection: undefined }), "session-integrity").passed, false);
});

test("the owner restarts by itself after each kill, reopens its session and rebinds every child (#4394)", () => {
	const killed = evidence({ owner: ownerLog(1), ownerKills: 1 });
	assert.deepEqual(result(killed, "owner-recovered"), {
		name: "owner-recovered",
		passed: true,
		expected: { starts: 2, rebound: 1, recovered: 1, children: 2, crashes: 0 },
		actual: {
			starts: 2,
			reopened: 1,
			rebound: 1,
			reboundChildren: [2],
			recovered: 1,
			crashes: [],
			shutdownCrashes: [],
			deliveredAfterLastStart: 8,
		},
	});
	assert.equal(result(evidence({ owner: ownerLog(0), ownerKills: 1 }), "owner-recovered").passed, false);
	assert.equal(result(evidence({ owner: ownerLog(1), ownerKills: 0 }), "owner-recovered").passed, false);
	const fresh = ownerLog(1).map((record) => (record.reopened === true ? { ...record, reopened: false } : record));
	assert.equal(field(result(evidence({ owner: fresh, ownerKills: 1 }), "owner-recovered").actual, "reopened"), 0);
	const twiceKilled = [
		...ownerLog(1).slice(0, -1),
		{ event: "owner-start", reopened: true, children: 2, at: 500 },
		{ event: "owner-rebound", children: 2, released: 2, running: 0, other: 0, at: 501 },
		{ event: "owner-recovery", children: 2, released: 2, running: 0, other: 0, at: 502 },
		...ownerLog(0).slice(-1),
	];
	assert.equal(field(result(evidence({ owner: twiceKilled, ownerKills: 2 }), "owner-recovered").actual, "starts"), 3);
	assert.equal(result(evidence({ owner: twiceKilled, ownerKills: 2 }), "owner-recovered").passed, false);
	const atRestart = ownerLog(1).map((record) =>
		record.event === "owner-start" && record.reopened ? { ...record, at: 101 } : record,
	);
	assert.equal(
		field(result(evidence({ owner: atRestart, ownerKills: 1 }), "owner-recovered").actual, "deliveredAfterLastStart"),
		4,
	);
	const queuedAfter = senderLog("s1").map((record) =>
		record.event === "send" ? { ...record, delivered: false, queued: true } : record,
	);
	assert.equal(
		field(
			result(
				evidence({ owner: ownerLog(1), ownerKills: 1, senders: [{ name: "s1", records: queuedAfter }] }),
				"owner-recovered",
			).actual,
			"deliveredAfterLastStart",
		),
		0,
	);
	const lateStart = ownerLog(0).map((record) => (record.event === "owner-start" ? { ...record, at: 10_000 } : record));
	assert.equal(result(evidence({ owner: lateStart, ownerKills: 0 }), "owner-recovered").passed, true);
	assert.deepEqual(
		field(
			result(evidence({ owner: [...ownerLog(0), { event: "uncaught" }] }), "owner-recovered").actual,
			"shutdownCrashes",
		),
		["uncaught"],
	);
	assert.equal(result(evidence({ owner: fresh, ownerKills: 1 }), "owner-recovered").passed, false);
	const partial = ownerLog(1).map((record) =>
		record.event === "owner-rebound" ? { ...record, children: 1 } : record,
	);
	assert.equal(result(evidence({ owner: partial, ownerKills: 1 }), "owner-recovered").passed, false);
	const unbound = ownerLog(1).filter((record) => record.event !== "owner-rebound");
	assert.equal(result(evidence({ owner: unbound, ownerKills: 1 }), "owner-recovered").passed, false);
	const unrecovered = ownerLog(1).filter((record) => record.event !== "owner-recovery");
	assert.equal(
		field(result(evidence({ owner: unrecovered, ownerKills: 1 }), "owner-recovered").actual, "recovered"),
		0,
	);
	assert.equal(result(evidence({ owner: unrecovered, ownerKills: 1 }), "owner-recovered").passed, false);
	const [start, final] = ownerLog(0) as [OwnerRecord, OwnerRecord];
	for (const event of ["uncaught", "fatal"]) {
		const crashed = [start, { event, error: { name: "StorageUnavailableError", code: "unavailable" } }, final];
		const outcome = result(evidence({ owner: crashed }), "owner-recovered");
		assert.deepEqual(field(outcome.actual, "crashes"), ["StorageUnavailableError"]);
		assert.deepEqual(field(outcome.actual, "shutdownCrashes"), []);
		assert.equal(outcome.passed, false);
	}
	assert.deepEqual(
		field(result(evidence({ owner: [start, { event: "uncaught" }] }), "owner-recovered").actual, "crashes"),
		["uncaught"],
	);
	const atShutdown = result(
		evidence({ owner: [...ownerLog(0), { event: "uncaught", error: { name: "Error", code: "SessionClosed" } }] }),
		"owner-recovered",
	);
	assert.equal(atShutdown.passed, true);
	const unstopped = result(evidence({ owner: [start, { event: "uncaught" }] }), "owner-recovered");
	assert.deepEqual(field(unstopped.actual, "shutdownCrashes"), [], "without a final status every crash is a crash");
	const stoppedCleanly = result(evidence({ owner: [...ownerLog(0), { event: "owner-stopped" }] }), "owner-recovered");
	assert.deepEqual(field(stoppedCleanly.actual, "shutdownCrashes"), []);
	assert.deepEqual(field(atShutdown.actual, "crashes"), []);
	assert.deepEqual(field(atShutdown.actual, "shutdownCrashes"), ["Error"]);
	const late = ownerLog(1).map((record) =>
		record.event === "owner-start" && record.reopened ? { ...record, at: 500 } : record,
	);
	assert.deepEqual(
		field(result(evidence({ owner: late, ownerKills: 1 }), "owner-recovered").actual, "deliveredAfterLastStart"),
		0,
	);
	assert.equal(result(evidence({ owner: late, ownerKills: 1 }), "owner-recovered").passed, false);
	assert.equal(result(evidence({ owner: late, ownerKills: 0 }), "owner-recovered").passed, false);
	assert.equal(result(evidence({ owner: undefined }), "owner-recovered").passed, false);
	assert.equal(result(evidence({ owner: [], ownerKills: 0 }), "owner-recovered").passed, false);
	const noTime = [{ event: "owner-start", reopened: false }, ...ownerLog(0).slice(1)];
	assert.equal(field(result(evidence({ owner: noTime }), "owner-recovered").actual, "deliveredAfterLastStart"), 0);
});

test("metrics count outcomes by class, non-deliveries by name and reconnects by sender (#4394)", () => {
	const s1 = [
		...senderLog("s1"),
		{ event: "connected", generation: 2 },
		{ event: "send", child: "c1", k: 3, id: "q", delivered: false, queued: true, retries: 1 },
		{ event: "send", child: "c1", k: 4, id: "r", delivered: false, queued: false, reasonCode: "recipient_parked" },
		{ event: "send", child: "c1", k: 5, id: "u", delivered: false, queued: false, reasonCode: null },
		{
			event: "send-failed",
			child: "c1",
			k: 6,
			id: "f",
			error: { name: "IntercomBrokerTimeoutError", code: null },
			retries: 3,
		},
		{ event: "send-failed", child: "c1", k: 7, id: "g" },
	];
	assert.deepEqual(
		releasedMetrics([
			{ name: "s1", records: s1 },
			{ name: "s2", records: undefined },
		]),
		{
			sends: 9,
			classes: { delivered: 4, queued: 1, refused: 1, untyped: 1, failed: 2 },
			nonDeliveries: [
				{ name: "recipient_parked", count: 1 },
				{ name: "IntercomBrokerTimeoutError", count: 1 },
				{ name: "unknown", count: 1 },
			],
			retried: 2,
			connections: { s1: 2, s2: 0 },
			deliveredLatencyMs: { median: 20, p90: 20, max: 20 },
		},
	);
	const timed = (ms: number[]) =>
		releasedMetrics([
			{
				name: "s1",
				records: ms.map((value, index) => ({ event: "send", id: `${index}`, delivered: true, ms: value })),
			},
		]).deliveredLatencyMs;
	assert.deepEqual(timed([100, 10, 90, 20, 80, 30, 70, 40, 60, 50]), { median: 60, p90: 100, max: 100 });
	assert.deepEqual(
		releasedMetrics([
			{
				name: "s1",
				records: [
					{ event: "send", id: "a", delivered: true, ms: 5 },
					{ event: "send", id: "b", delivered: false, queued: true, ms: 500 },
				],
			},
		]).deliveredLatencyMs,
		{ median: 5, p90: 5, max: 5 },
	);
	assert.deepEqual(timed([]), { median: null, p90: null, max: null });
	assert.deepEqual(
		releasedMetrics([{ name: "s1", records: [{ event: "send", id: "x", delivered: true }] }]).deliveredLatencyMs,
		{ median: null, p90: null, max: null },
	);
});
