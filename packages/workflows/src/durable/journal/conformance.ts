import assert from "node:assert/strict";
import {
	JournalCasConflictError,
	JournalClosedError,
	type JournalEntry,
	JournalInvalidTextError,
	type Lease,
	type RunJournal,
	RunNotFoundError,
	StaleLeaseError,
	StorageUnavailableError,
} from "./types.js";

export type RunJournalConformanceRunner = (name: string, body: () => Promise<void>) => void;
export type OpenRunJournal = () => RunJournal | Promise<RunJournal>;

export function registerRunJournalConformance(
	runner: RunJournalConformanceRunner,
	name: string,
	open: OpenRunJournal,
): void {
	const header = { runId: "run", name: "workflow", cwd: " /raw/../cwd ", createdAt: 0, status: "running" };
	async function lease(journal: RunJournal, holder = "holder"): Promise<Lease> {
		const outcome = await journal.acquire(header.runId, holder);
		assert.equal(outcome.status, "acquired");
		if (outcome.status !== "acquired") assert.fail("lease not acquired");
		return outcome.lease;
	}
	async function entries(journal: RunJournal, fromSeq?: number): Promise<JournalEntry[]> {
		const result: JournalEntry[] = [];
		for await (const entry of journal.read(header.runId, fromSeq)) result.push(entry);
		return result;
	}
	function check(label: string, body: (journal: RunJournal) => Promise<void>): void {
		runner(`${name}: ${label}`, async () => {
			const journal = await open();
			try {
				await body(journal);
			} finally {
				await journal.close();
			}
		});
	}
	check("creates once, lists in identifier order and filters raw cwd", async (journal) => {
		assert.equal(await journal.createRun(header), "created");
		assert.equal(await journal.createRun({ ...header, name: "ignored" }), "exists");
		await journal.createRun({ ...header, runId: "a", cwd: "/other" });
		assert.deepEqual(
			(await journal.listRuns()).map((run) => run.runId),
			["a", "run"],
		);
		assert.deepEqual(await journal.listRuns({ cwd: header.cwd }), [header]);
		assert.deepEqual(await journal.listRuns({ cwd: "/cwd" }), []);
	});
	check("appends dense sequences and first-writer keyed records with CAS before replay", async (journal) => {
		await journal.createRun(header);
		const held = await lease(journal);
		const first = await journal.append(held, { type: "RunStarted", payload: [2, 1, 2] }, { key: "", expectSeq: 0 });
		assert.equal(first.status, "appended");
		assert.equal(first.entry.seq, 1);
		assert.equal(first.entry.epoch, held.epoch);
		const duplicate = await journal.append(held, { type: "RunFinished", payload: null }, { key: "", expectSeq: 1 });
		assert.deepEqual(duplicate, { status: "exists", entry: first.entry });
		await assert.rejects(
			journal.append(held, { type: "RunFinished", payload: null }, { key: "", expectSeq: 0 }),
			(error: Error) => {
				assert.ok(error instanceof JournalCasConflictError);
				assert.equal(error.runId, header.runId);
				assert.equal(error.expectedSeq, 0);
				assert.equal(error.actualSeq, 1);
				return true;
			},
		);
		for (let i = 2; i <= 12; i++) await journal.append(held, { type: "SummaryRecorded", payload: i });
		assert.deepEqual(
			(await entries(journal)).map((entry) => entry.seq),
			Array.from({ length: 12 }, (_, i) => i + 1),
		);
		assert.deepEqual(
			(await entries(journal, 10)).map((entry) => entry.seq),
			[10, 11, 12],
		);
		assert.deepEqual(await journal.readKey(header.runId, ""), first.entry);
		assert.equal(await journal.readKey(header.runId, "missing"), undefined);
	});
	check("fences takeover, release and deletion while preserving epoch tombstones", async (journal) => {
		await journal.createRun(header);
		const first = await lease(journal);
		assert.deepEqual(await journal.acquire(header.runId, "other"), {
			status: "held",
			holderId: first.holderId,
			epoch: 1,
		});
		assert.deepEqual(await journal.acquire(header.runId, first.holderId), { status: "acquired", lease: first });
		assert.deepEqual(await journal.takeover(header.runId, "other", "wrong"), {
			status: "held",
			holderId: first.holderId,
			epoch: 1,
		});
		const taken = await journal.takeover(header.runId, "other", first.holderId);
		assert.equal(taken.status, "acquired");
		if (taken.status !== "acquired") assert.fail("takeover not acquired");
		assert.equal(taken.lease.epoch, 2);
		const stale = (error: Error) => {
			assert.ok(error instanceof StaleLeaseError);
			assert.equal(error.runId, header.runId);
			assert.equal(error.heldEpoch, 1);
			assert.equal(error.currentEpoch, 2);
			return true;
		};
		await assert.rejects(journal.append(first, { type: "RunStarted", payload: null }), stale);
		await assert.rejects(journal.renew(first), stale);
		await assert.rejects(journal.release(first), stale);
		await journal.renew(taken.lease);
		await journal.release(taken.lease);
		await assert.rejects(journal.renew(taken.lease), StaleLeaseError);
		const reacquired = await lease(journal);
		assert.equal(reacquired.epoch, 3);
		await journal.append(reacquired, { type: "RunStarted", payload: null }, { key: "one" });
		await journal.deleteRun(header.runId);
		assert.deepEqual(await journal.listRuns(), []);
		assert.deepEqual(await entries(journal), []);
		assert.equal(await journal.readKey(header.runId, "one"), undefined);
		await assert.rejects(journal.append(reacquired, { type: "RunStarted", payload: null }), StaleLeaseError);
		await journal.createRun(header);
		assert.equal((await lease(journal)).epoch, 4);
	});
	check("owned deletion removes the owner's run and events", async (journal) => {
		await journal.createRun(header);
		const held = await lease(journal);
		await journal.append(held, { type: "RunStarted", payload: null }, { key: "one" });
		await journal.deleteOwnedRun(held);
		assert.deepEqual(await journal.listRuns(), []);
		assert.deepEqual(await entries(journal), []);
		assert.equal(await journal.readKey(header.runId, "one"), undefined);
	});
	check("owned deletion rejects a stale lease without changing the successor", async (journal) => {
		await journal.createRun(header);
		const first = await lease(journal);
		await journal.renew(first);
		const successor = await journal.takeover(header.runId, "successor", first.holderId);
		assert.equal(successor.status, "acquired");
		if (successor.status !== "acquired") assert.fail("successor not acquired");
		await journal.append(successor.lease, { type: "StatusChanged", payload: { status: "running" } });
		const before = await entries(journal);
		await assert.rejects(journal.deleteOwnedRun(first), (error: Error) => {
			assert.ok(error instanceof StaleLeaseError);
			assert.equal(error.runId, header.runId);
			assert.equal(error.heldEpoch, first.epoch);
			assert.equal(error.currentEpoch, successor.lease.epoch);
			return true;
		});
		assert.deepEqual(await journal.listRuns(), [header]);
		assert.deepEqual(await entries(journal), before);
		await journal.renew(successor.lease);
	});
	check("owned deletion keeps its epoch tombstone when the run is recreated", async (journal) => {
		await journal.createRun(header);
		const first = await lease(journal);
		await journal.deleteOwnedRun(first);
		await journal.createRun(header);
		const recreated = await lease(journal);
		assert.equal(recreated.epoch, first.epoch + 1);
		await journal.append(recreated, { type: "RunStarted", payload: "recreated" });
		const before = await entries(journal);
		await assert.rejects(journal.deleteOwnedRun(first), (error: Error) => {
			assert.ok(error instanceof StaleLeaseError);
			assert.equal(error.runId, header.runId);
			assert.equal(error.heldEpoch, first.epoch);
			assert.equal(error.currentEpoch, recreated.epoch);
			return true;
		});
		assert.deepEqual(await entries(journal), before);
		assert.deepEqual(await journal.listRuns(), [header]);
	});
	check("reports absent runs and empty reads without inventing records", async (journal) => {
		for (const acquire of [() => journal.acquire("missing", "h"), () => journal.takeover("missing", "h", "old")]) {
			await assert.rejects(acquire(), (error: Error) => {
				assert.ok(error instanceof RunNotFoundError);
				assert.equal(error.runId, "missing");
				return true;
			});
		}
		assert.deepEqual(await entries(journal), []);
		await journal.deleteRun("missing");
		assert.equal(await journal.readKey("missing", "key"), undefined);
	});
	check("snapshots JSON and status without exposing mutable stored values", async (journal) => {
		const input = { text: "\u0000\ud800", values: [2, 1, 2], zero: -0 };
		await journal.createRun({ ...header, inputs: input });
		input.values.push(9);
		const held = await lease(journal);
		const payload = { status: "paused", text: "\u0000\udfff", values: [3, 2, 3] };
		const first = await journal.append(held, { type: "StatusChanged", payload });
		payload.values.push(9);
		assert.deepEqual(first.entry.event.payload, { status: "paused", text: "\u0000\udfff", values: [3, 2, 3] });
		await journal.append(held, { type: "StatusChanged", payload: { status: "done" } });
		assert.deepEqual((await journal.listRuns())[0], {
			...header,
			status: "done",
			inputs: { ...input, zero: 0, values: [2, 1, 2] },
		});
		const read = await entries(journal);
		(read[0]!.event.payload as { values: number[] }).values.push(9);
		assert.deepEqual((await entries(journal))[0], first.entry);
		assert.equal("key" in first.entry, false);
	});
	check("detaches original and returned headers and payloads", async (journal) => {
		const original = { ...header, inputs: { nested: { value: "original" } } };
		const expectedHeader = structuredClone(original);
		await journal.createRun(original);
		original.name = "changed";
		original.inputs.nested.value = "changed";
		const held = await lease(journal);
		const payload = { nested: { value: "original" } };
		const appended = await journal.append(held, { type: "RunStarted", payload }, { key: "entry" });
		const expectedEntry = structuredClone(appended.entry);
		payload.nested.value = "changed";
		(appended.entry.event.payload as { nested: { value: string } }).nested.value = "changed";
		const fromRead = (await entries(journal))[0]!;
		(fromRead.event.payload as { nested: { value: string } }).nested.value = "changed";
		const fromKey = await journal.readKey(header.runId, "entry");
		assert.ok(fromKey);
		(fromKey.event.payload as { nested: { value: string } }).nested.value = "changed";
		const fromList = (await journal.listRuns())[0]!;
		(fromList.inputs as { nested: { value: string } }).nested.value = "changed";
		Reflect.set(fromList, "name", "changed");
		assert.deepEqual(await journal.listRuns(), [expectedHeader]);
		assert.deepEqual(await entries(journal), [expectedEntry]);
		assert.deepEqual(await journal.readKey(header.runId, "entry"), expectedEntry);
	});
	check("rejected appends leave all rows, sequence and status unchanged", async (journal) => {
		await journal.createRun(header);
		const first = await lease(journal);
		await journal.append(first, { type: "RunStarted", payload: "first" });
		const before = await entries(journal);
		await assert.rejects(
			journal.append(first, { type: "StatusChanged", payload: { status: "failed" } }, { expectSeq: 0 }),
			JournalCasConflictError,
		);
		assert.deepEqual(await entries(journal), before);
		assert.deepEqual(await journal.listRuns(), [header]);
		await assert.rejects(
			journal.append(first, { type: "StatusChanged", payload: { status: "bad\u0000status" } }),
			JournalInvalidTextError,
		);
		assert.deepEqual(await entries(journal), before);
		assert.deepEqual(await journal.listRuns(), [header]);
		const successor = await journal.takeover(header.runId, "successor", first.holderId);
		assert.equal(successor.status, "acquired");
		if (successor.status !== "acquired") assert.fail("successor not acquired");
		await assert.rejects(
			journal.append(first, { type: "StatusChanged", payload: { status: "failed" } }),
			StaleLeaseError,
		);
		assert.deepEqual(await entries(journal), before);
		assert.deepEqual(await journal.listRuns(), [header]);
		const appended = await journal.append(successor.lease, { type: "RunFinished", payload: "next" });
		assert.equal(appended.entry.seq, 2);
	});
	for (const invalid of ["\u0000\ud800", "\ud800", "\udfff", "a\ud800b"]) {
		check(`rejects invalid identifier ${JSON.stringify(invalid)} before mutation`, async (journal) => {
			await journal.createRun(header);
			const held = await lease(journal);
			const reason = invalid.includes("\u0000") ? "nul-character" : "ill-formed-unicode";
			const operations: [
				JournalInvalidTextError["field"],
				() => Promise<object | string | undefined> | Promise<void>,
			][] = [
				["runId", () => journal.createRun({ ...header, runId: invalid })],
				["name", () => journal.createRun({ ...header, name: invalid })],
				["cwd", () => journal.listRuns({ cwd: invalid })],
				["status", () => journal.createRun({ ...header, status: invalid })],
				["holderId", () => journal.acquire(header.runId, invalid)],
				["expectedHolder", () => journal.takeover(header.runId, "h", invalid)],
				["key", () => journal.append(held, { type: "RunStarted", payload: null }, { key: invalid })],
				["status", () => journal.append(held, { type: "StatusChanged", payload: { status: invalid } })],
				["runId", () => journal.deleteRun(invalid)],
				["holderId", () => journal.release({ ...held, holderId: invalid })],
			];
			for (const [field, operation] of operations)
				await assert.rejects(operation(), (error: Error) => {
					assert.ok(error instanceof JournalInvalidTextError);
					assert.equal(error.field, field);
					assert.equal(error.reason, reason);
					return true;
				});
			assert.deepEqual(await journal.listRuns(), [header]);
			assert.deepEqual(await entries(journal), []);
		});
	}
	check("closed journals reject operations and started reads while close remains idempotent", async (journal) => {
		await journal.createRun(header);
		const held = await lease(journal);
		await journal.append(held, { type: "RunStarted", payload: "one" });
		await journal.append(held, { type: "RunFinished", payload: "two" });
		const started = journal.read(header.runId)[Symbol.asyncIterator]();
		assert.equal((await started.next()).done, false);
		await journal.close();
		await journal.close();
		const operations = [
			() => journal.createRun(header),
			() => journal.listRuns(),
			() => journal.acquire(header.runId, "holder"),
			() => journal.takeover(header.runId, "next", "holder"),
			() => journal.renew(held),
			() => journal.release(held),
			() => journal.append(held, { type: "RunFinished", payload: null }),
			() => journal.read(header.runId)[Symbol.asyncIterator]().next(),
			() => started.next(),
			() => journal.readKey(header.runId, "entry"),
			() => journal.deleteOwnedRun(held),
			() => journal.deleteRun(header.runId),
			() => journal.createRun({ ...header, runId: "\u0000" }),
			() => journal.listRuns({ cwd: "\u0000" }),
			() => journal.acquire("\u0000", "holder"),
			() => journal.takeover("\u0000", "next", "holder"),
			() => journal.renew({ ...held, holderId: "\u0000" }),
			() => journal.release({ ...held, holderId: "\u0000" }),
			() => journal.append(held, { type: "StatusChanged", payload: { status: "\u0000" } }),
			() => journal.read("\u0000")[Symbol.asyncIterator]().next(),
			() => journal.readKey(header.runId, "\u0000"),
			() => journal.deleteOwnedRun({ ...held, holderId: "\u0000" }),
			() => journal.deleteRun("\u0000"),
		];
		for (const operation of operations)
			await assert.rejects(operation(), (error: Error) => {
				assert.ok(error instanceof StorageUnavailableError);
				assert.ok(error.cause instanceof JournalClosedError);
				assert.ok(error.path.length > 0);
				return true;
			});
	});
}
