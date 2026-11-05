import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import {
	createSubagentChildRecordSink,
	subagentChildRecordFailures,
	subagentChildRecordRegistrySizes,
	subagentChildRecordsAppended,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";

type Input = Parameters<ReturnType<typeof createSubagentChildRecordSink>["record"]>[0];

function input(runId: string, overrides: Partial<Input> = {}): Input {
	return { runId, index: 0, agent: "worker", state: "terminal", cwd: "/repo", ...overrides };
}

async function settle(): Promise<void> {
	for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
}

function gatedOwner() {
	const sessionManager = SessionManager.inMemory("/repo");
	const gates: Array<PromiseWithResolvers<void>> = [];
	const started: string[] = [];
	const finished: string[] = [];
	const sink = createSubagentChildRecordSink(
		{
			appendEntry: async (_type, data) => {
				const record = data as { childId: string };
				started.push(record.childId);
				const gate = Promise.withResolvers<void>();
				gates.push(gate);
				await gate.promise;
				finished.push(record.childId);
			},
		},
		{ sessionManager, orchestrationContext: undefined },
	);
	return { sink, gates, started, finished, ownerSessionId: sessionManager.getSessionId() };
}

describe("appending child records of one owner", () => {
	test("with nothing appending, no owner has a chain and no stop is requested (#4326)", () => {
		assert.deepEqual(subagentChildRecordRegistrySizes(), { appendChains: 0, stopRequests: 0 });
	});

	test("a record is appended only after the earlier ones, and the owner's chain ends with the last (#4326)", async () => {
		const { sink, gates, started, finished, ownerSessionId } = gatedOwner();

		sink.record(input("ord-a"));
		sink.record(input("ord-b"));
		await settle();
		assert.deepEqual(started, ["ord-a:0"], "the second waits for the first");
		assert.deepEqual(subagentChildRecordRegistrySizes().appendChains, 1);

		gates[0]?.resolve();
		await settle();
		assert.deepEqual(started, ["ord-a:0", "ord-b:0"]);
		assert.equal(subagentChildRecordRegistrySizes().appendChains, 1, "the first settling leaves the second's chain");

		gates[1]?.resolve();
		await subagentChildRecordsAppended(ownerSessionId);
		await settle();
		assert.deepEqual(finished, ["ord-a:0", "ord-b:0"]);
		assert.equal(subagentChildRecordRegistrySizes().appendChains, 0, "nothing is kept once everything is appended");
	});

	test("waiting for an owner's appends waits for the one in flight (#4326)", async () => {
		const { sink, gates, ownerSessionId } = gatedOwner();
		sink.record(input("wait-a"));
		await settle();
		let appended = false;
		void subagentChildRecordsAppended(ownerSessionId).then(() => {
			appended = true;
		});
		await settle();
		assert.equal(appended, false);
		gates[0]?.resolve();
		await settle();
		assert.equal(appended, true);
	});
});

describe("a record that could not be appended", () => {
	function failingSink() {
		const sessionManager = SessionManager.inMemory("/repo");
		return createSubagentChildRecordSink(
			{
				appendEntry: async () => {
					throw new Error("disk full");
				},
			},
			{ sessionManager, orchestrationContext: undefined },
		);
	}

	test("is counted with the child, its state and its terminal status when it has one (#4326)", async () => {
		const sink = failingSink();
		const before = subagentChildRecordFailures.count;
		sink.record(input("fail-a", { terminalStatus: "ok" }));
		await sink.flushed?.();
		assert.equal(subagentChildRecordFailures.count, before + 1);
		assert.deepEqual(subagentChildRecordFailures.last?.fields, {
			childId: "fail-a:0",
			state: "terminal",
			terminalStatus: "ok",
		});
		assert.equal(subagentChildRecordFailures.last?.code, "record-append-failed");
	});

	test("names no terminal status when the record has none (#4326)", async () => {
		const sink = failingSink();
		sink.record(input("fail-b", { state: "running" }));
		await sink.flushed?.();
		assert.deepEqual(subagentChildRecordFailures.last?.fields, { childId: "fail-b:0", state: "running" });
	});
});
