import assert from "node:assert/strict";
import { test } from "vitest";
import {
	atLeastOnceReplays,
	checkJournalInvariants,
	latencyStats,
	UNTYPED_ERROR_NAMES,
} from "../distributed/harness/invariants.mjs";

type Observed = {
	seq: number;
	epoch: number;
	key: string | null;
	index: number | null;
	digest: string | null;
	type: string;
};
type Probe = { holder: string; epoch: number; outcome: "rejected" | "appended"; error?: { name: string } };
const entry = (seq: number, epoch: number, index: number): Observed => ({
	seq,
	epoch,
	key: `cp-${String(index).padStart(6, "0")}`,
	index,
	digest: `d${index}`,
	type: "CheckpointRecorded",
});
const ack = (seq: number, epoch: number, index: number, status = "appended") => ({
	event: "ack",
	key: `cp-${String(index).padStart(6, "0")}`,
	index,
	seq,
	epoch,
	status,
	digest: `d${index}`,
	holder: "h",
});
const healthy = () => ({
	entries: [entry(1, 1, 0), entry(2, 1, 1), entry(3, 2, 2), entry(4, 2, 3)],
	records: [
		ack(1, 1, 0),
		ack(2, 1, 1),
		{ event: "error", error: { name: "StorageUnavailableError", code: "unavailable" } },
		ack(3, 2, 2),
		ack(3, 2, 2, "exists"),
		ack(4, 2, 3),
		{ event: "done" },
	],
	fencing: [{ holder: "w1", epoch: 1, outcome: "rejected", error: { name: "StaleLeaseError" } }] as Probe[],
	integrity: ["ok"],
	expectations: { minAcks: 4, requireCompletion: true },
});
const byName = (results: ReturnType<typeof checkJournalInvariants>) =>
	Object.fromEntries(results.map((result) => [result.name, result]));

test("a healthy history passes every invariant with explicit expected and actual values", () => {
	const results = checkJournalInvariants(healthy());
	assert.deepEqual(
		results.map((result) => [result.name, result.passed]),
		[
			["evidence-complete", true],
			["acknowledged-checkpoints-present", true],
			["no-duplicate-checkpoints", true],
			["no-lost-checkpoints", true],
			["sequence-strictly-increasing", true],
			["lease-fencing-holds", true],
			["stale-writers-rejected", true],
			["journal-integrity", true],
			["failures-are-typed", true],
			["recovered-without-intervention", true],
		],
	);
	const named = byName(results);
	assert.deepEqual(named["evidence-complete"].actual, {
		journalRead: true,
		writerRecords: true,
		integrity: true,
		acks: 5,
	});
	assert.deepEqual(named["acknowledged-checkpoints-present"].actual, {
		missing: 0,
		mismatched: 0,
		acknowledged: 4,
		firstMissing: null,
	});
	assert.deepEqual(named["no-lost-checkpoints"].actual, { gaps: 0, checkpoints: 4, last: 3 });
	assert.deepEqual(named["lease-fencing-holds"].actual, { epochRegressions: 0, epochs: [1, 2] });
	assert.deepEqual(named["stale-writers-rejected"].actual, { probes: 1, rejected: 1 });
	assert.deepEqual(named["failures-are-typed"].actual, { untyped: 0, names: ["StorageUnavailableError"] });
	assert.deepEqual(named["journal-integrity"].expected, ["ok"]);
	assert.equal(named["recovered-without-intervention"].actual, "completed");
});

test("missing evidence can never pass", () => {
	const none = byName(
		checkJournalInvariants({
			entries: undefined,
			records: undefined,
			fencing: [],
			integrity: undefined,
			expectations: { minAcks: 0, requireCompletion: true },
		}),
	);
	assert.equal(none["evidence-complete"].passed, false);
	assert.deepEqual(none["evidence-complete"].actual, {
		journalRead: false,
		writerRecords: false,
		integrity: false,
		acks: 0,
	});
	assert.equal(none["journal-integrity"].passed, false);
	assert.equal(none["journal-integrity"].actual, null);
	assert.equal(none["recovered-without-intervention"].passed, false);
	const few = healthy();
	few.expectations.minAcks = 6;
	assert.equal(byName(checkJournalInvariants(few))["evidence-complete"].passed, false);
	for (const missing of ["entries", "records", "integrity"] as const) {
		const input = { ...healthy(), [missing]: undefined };
		assert.equal(byName(checkJournalInvariants(input))["evidence-complete"].passed, false, missing);
	}
	const exact = healthy();
	exact.expectations.minAcks = 5;
	assert.equal(byName(checkJournalInvariants(exact))["evidence-complete"].passed, true);
});

test("detects a lost acknowledged checkpoint and a payload or position mismatch", () => {
	const lost = healthy();
	lost.entries = lost.entries.filter((item) => item.index !== 1);
	const named = byName(checkJournalInvariants(lost));
	assert.equal(named["acknowledged-checkpoints-present"].passed, false);
	assert.deepEqual(named["acknowledged-checkpoints-present"].actual, {
		missing: 1,
		mismatched: 0,
		acknowledged: 4,
		firstMissing: "cp-000001",
	});
	assert.equal(named["no-lost-checkpoints"].passed, false);
	for (const field of ["digest", "seq", "epoch"] as const) {
		const changed = healthy();
		changed.entries = changed.entries.map((item) =>
			item.index === 2 ? { ...item, [field]: field === "digest" ? "other" : 99 } : item,
		);
		const result = byName(checkJournalInvariants(changed))["acknowledged-checkpoints-present"];
		assert.equal(result.passed, false, field);
		assert.equal((result.actual as { mismatched: number }).mismatched, 2, field);
	}
});

test("detects duplicates, gaps, sequence and epoch regressions", () => {
	const duplicate = healthy();
	duplicate.entries.push({ ...entry(5, 2, 3) });
	const dup = byName(checkJournalInvariants(duplicate));
	assert.equal(dup["no-duplicate-checkpoints"].passed, false);
	assert.deepEqual(dup["no-duplicate-checkpoints"].actual, { duplicates: 1, firstDuplicate: "cp-000003" });
	const gap = healthy();
	gap.entries = [entry(1, 1, 0), entry(2, 1, 2)];
	gap.records = [ack(1, 1, 0), ack(2, 1, 2), { event: "done" }];
	gap.expectations.minAcks = 1;
	assert.deepEqual(byName(checkJournalInvariants(gap))["no-lost-checkpoints"].actual, {
		gaps: 1,
		checkpoints: 2,
		last: 2,
	});
	const late = healthy();
	late.entries = [entry(1, 1, 1), entry(2, 1, 2)];
	assert.equal(byName(checkJournalInvariants(late))["no-lost-checkpoints"].passed, false);
	const sequence = healthy();
	sequence.entries = [entry(2, 1, 0), entry(2, 1, 1)];
	assert.deepEqual(
		[
			byName(checkJournalInvariants(sequence))["sequence-strictly-increasing"].passed,
			byName(checkJournalInvariants(sequence))["sequence-strictly-increasing"].actual,
		],
		[false, 1],
	);
	const descending = healthy();
	descending.entries = [entry(3, 1, 0), entry(2, 1, 1)];
	assert.equal(byName(checkJournalInvariants(descending))["sequence-strictly-increasing"].passed, false);
	const regression = healthy();
	regression.entries = [entry(1, 2, 0), entry(2, 1, 1), entry(3, 2, 2)];
	const fencing = byName(checkJournalInvariants(regression))["lease-fencing-holds"];
	assert.equal(fencing.passed, false);
	assert.deepEqual(fencing.actual, { epochRegressions: 1, epochs: [2, 1] });
	const keyless = healthy();
	keyless.entries = [
		...keyless.entries,
		{ seq: 9, epoch: 2, key: null, index: null, digest: null, type: "StatusChanged" },
	];
	assert.deepEqual(
		checkJournalInvariants(keyless).map((result) => result.passed),
		Array(10).fill(true),
	);
});

test("detects accepted stale writers, corrupt journals and untyped failures", () => {
	const accepted = healthy();
	accepted.fencing = [{ holder: "w1", epoch: 1, outcome: "appended" }];
	assert.deepEqual(byName(checkJournalInvariants(accepted))["stale-writers-rejected"].actual, {
		probes: 1,
		rejected: 0,
	});
	const wrongError = healthy();
	wrongError.fencing = [{ holder: "w1", epoch: 1, outcome: "rejected", error: { name: "StorageUnavailableError" } }];
	assert.equal(byName(checkJournalInvariants(wrongError))["stale-writers-rejected"].passed, false);
	for (const integrity of [["*** in database main ***"], ["ok", "ok"], []]) {
		assert.equal(
			byName(checkJournalInvariants({ ...healthy(), integrity }))["journal-integrity"].passed,
			false,
			JSON.stringify(integrity),
		);
	}
	for (const name of UNTYPED_ERROR_NAMES) {
		const untyped = healthy();
		untyped.records.push({ event: "error", error: { name, code: null as never } });
		const result = byName(checkJournalInvariants(untyped))["failures-are-typed"];
		assert.equal(result.passed, false, name);
		assert.equal((result.actual as { untyped: number }).untyped, 1);
	}
	assert.deepEqual(
		[...UNTYPED_ERROR_NAMES],
		["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "NonError", "AggregateError"],
	);
	const stalled = healthy();
	stalled.records = stalled.records.filter((record) => record.event !== "done");
	assert.deepEqual(
		[
			byName(checkJournalInvariants(stalled))["recovered-without-intervention"].passed,
			byName(checkJournalInvariants(stalled))["recovered-without-intervention"].actual,
		],
		[false, "no completion"],
	);
	stalled.expectations.requireCompletion = false;
	assert.ok(!checkJournalInvariants(stalled).some((result) => result.name === "recovered-without-intervention"));
});

test("counts at-least-once replays and summarizes latency in a window", () => {
	assert.equal(atLeastOnceReplays(healthy().records), 1);
	assert.equal(atLeastOnceReplays([{ event: "error", status: "exists" }]), 0);
	const records = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((ms, index) => ({
		event: "ack",
		ms,
		at: 1000 + index,
	}));
	assert.deepEqual(latencyStats(records, { from: 1000, to: 1009 }), { count: 10, median: 60, p10: 20, p90: 100 });
	assert.deepEqual(latencyStats(records, { from: 1002, to: 1004 }), { count: 3, median: 40, p10: 30, p90: 50 });
	assert.deepEqual(latencyStats(records, { from: 2000, to: 3000 }), { count: 0, median: null, p10: null, p90: null });
	assert.deepEqual(
		latencyStats(
			[
				{ event: "error", ms: 5, at: 1 },
				{ event: "ack", at: 1 },
				{ event: "ack", ms: 7 },
			],
			{ from: 0, to: 10 },
		),
		{ count: 0, median: null, p10: null, p90: null },
	);
	assert.deepEqual(latencyStats([{ event: "ack", ms: 3, at: 5 }], { from: 5, to: 5 }), {
		count: 1,
		median: 3,
		p10: 3,
		p90: 3,
	});
});

test("every invariant states its expected and actual values exactly", () => {
	assert.deepEqual(checkJournalInvariants(healthy()), [
		{
			name: "evidence-complete",
			passed: true,
			expected: { journalRead: true, writerRecords: true, integrity: true, minAcks: 4 },
			actual: { journalRead: true, writerRecords: true, integrity: true, acks: 5 },
		},
		{
			name: "acknowledged-checkpoints-present",
			passed: true,
			expected: { missing: 0, mismatched: 0, acknowledged: 4 },
			actual: { missing: 0, mismatched: 0, acknowledged: 4, firstMissing: null },
		},
		{
			name: "no-duplicate-checkpoints",
			passed: true,
			expected: { duplicates: 0 },
			actual: { duplicates: 0, firstDuplicate: null },
		},
		{
			name: "no-lost-checkpoints",
			passed: true,
			expected: { gaps: 0 },
			actual: { gaps: 0, checkpoints: 4, last: 3 },
		},
		{ name: "sequence-strictly-increasing", passed: true, expected: 0, actual: 0 },
		{
			name: "lease-fencing-holds",
			passed: true,
			expected: { epochRegressions: 0 },
			actual: { epochRegressions: 0, epochs: [1, 2] },
		},
		{
			name: "stale-writers-rejected",
			passed: true,
			expected: { probes: 1, rejected: 1 },
			actual: { probes: 1, rejected: 1 },
		},
		{ name: "journal-integrity", passed: true, expected: ["ok"], actual: ["ok"] },
		{
			name: "failures-are-typed",
			passed: true,
			expected: { untyped: 0 },
			actual: { untyped: 0, names: ["StorageUnavailableError"] },
		},
		{
			name: "recovered-without-intervention",
			passed: true,
			expected: "a writer completed after the last fault",
			actual: "completed",
		},
	]);
});

test("edge cases: keyless records, unordered indexes, probes without errors", () => {
	const keyless = healthy();
	keyless.records = [
		...keyless.records,
		{ event: "ack", index: 9, seq: 9, epoch: 2, status: "appended", digest: "x" } as never,
	];
	assert.deepEqual(byName(checkJournalInvariants(keyless))["acknowledged-checkpoints-present"].actual, {
		missing: 1,
		mismatched: 0,
		acknowledged: 5,
		firstMissing: "",
	});
	const twoKeyless = healthy();
	twoKeyless.entries = [
		...twoKeyless.entries,
		{ seq: 5, epoch: 2, key: null, index: null, digest: null, type: "StatusChanged" },
		{ seq: 6, epoch: 2, key: null, index: null, digest: null, type: "StatusChanged" },
	];
	assert.equal(byName(checkJournalInvariants(twoKeyless))["no-duplicate-checkpoints"].passed, true);
	const unordered = healthy();
	unordered.entries = [entry(1, 1, 1), entry(2, 1, 0), entry(3, 2, 3), entry(4, 2, 2)];
	unordered.records = [];
	unordered.expectations.minAcks = 0;
	assert.deepEqual(byName(checkJournalInvariants(unordered))["no-lost-checkpoints"].actual, {
		gaps: 0,
		checkpoints: 4,
		last: 3,
	});
	const tens = healthy();
	tens.entries = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].reverse().map((index, position) => entry(position + 1, 1, index));
	assert.deepEqual(byName(checkJournalInvariants(tens))["no-lost-checkpoints"].actual, {
		gaps: 0,
		checkpoints: 11,
		last: 10,
	});
	const bare = healthy();
	bare.fencing = [{ holder: "w1", epoch: 1, outcome: "rejected" }];
	assert.equal(byName(checkJournalInvariants(bare))["stale-writers-rejected"].passed, false);
	const accepted = healthy();
	accepted.fencing = [{ holder: "w1", epoch: 1, outcome: "appended", error: { name: "StaleLeaseError" } }];
	assert.equal(byName(checkJournalInvariants(accepted))["stale-writers-rejected"].passed, false);
	const corrupt = healthy();
	corrupt.integrity = ["row 3 missing from index"];
	assert.deepEqual(byName(checkJournalInvariants(corrupt))["journal-integrity"].actual, ["row 3 missing from index"]);
	const unnamed = healthy();
	unnamed.records = [...unnamed.records, { event: "error", error: {} as never }];
	assert.deepEqual(byName(checkJournalInvariants(unnamed))["failures-are-typed"].actual, {
		untyped: 0,
		names: ["StorageUnavailableError", ""],
	});
	const noRecords = byName(checkJournalInvariants({ ...healthy(), records: undefined }));
	assert.deepEqual(noRecords["failures-are-typed"].actual, { untyped: 0, names: [] });
	assert.equal(noRecords["recovered-without-intervention"].passed, false);
});

test("latency statistics sort their inputs and ignore unusable records", () => {
	const shuffled = [50, 10, 40, 20, 30].map((ms, index) => ({ event: "ack", ms, at: index }));
	assert.deepEqual(latencyStats(shuffled, { from: 0, to: 10 }), { count: 5, median: 30, p10: 10, p90: 50 });
	assert.deepEqual(
		latencyStats(
			[
				{ event: "ack", ms: 5, at: 1 },
				{ event: "ack", ms: "7" as never, at: 1 },
				{ event: "ack", ms: 9, at: "1" as never },
			],
			{ from: 0, to: 10 },
		),
		{
			count: 1,
			median: 5,
			p10: 5,
			p90: 5,
		},
	);
});

test("missing writer records or journal entries are reported, never filled in", () => {
	const noRecords = checkJournalInvariants({
		...healthy(),
		records: undefined,
		expectations: { minAcks: 0, requireCompletion: false },
	});
	assert.equal(noRecords[0].passed, false);
	const noEntries = byName(checkJournalInvariants({ ...healthy(), entries: undefined }));
	assert.deepEqual(noEntries["no-lost-checkpoints"].actual, { gaps: 0, checkpoints: 0, last: null });
	assert.deepEqual(noEntries["no-duplicate-checkpoints"].actual, { duplicates: 0, firstDuplicate: null });
	const emptyKey = healthy();
	emptyKey.entries = [
		...emptyKey.entries,
		{ seq: 9, epoch: 2, key: "", index: null, digest: "stored", type: "CheckpointRecorded" },
	];
	emptyKey.records = [
		...emptyKey.records,
		{ event: "ack", seq: 9, epoch: 2, status: "appended", digest: "acknowledged" } as never,
	];
	assert.deepEqual(byName(checkJournalInvariants(emptyKey))["acknowledged-checkpoints-present"].actual, {
		missing: 0,
		mismatched: 1,
		acknowledged: 5,
		firstMissing: null,
	});
});
