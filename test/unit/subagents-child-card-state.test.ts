import assert from "node:assert/strict";
import type { ExtensionContext } from "@bastani/atomic";
import { describe, test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import {
	indexSubagentChildOwner,
	observeSubagentChildRecord,
	SUBAGENT_CHILD_RECORD_TYPE,
	subagentChildIndexSize,
	subagentChildRecordForTarget,
	subagentChildRecordOf,
	subagentChildRecordsOf,
} from "../../packages/subagents/src/runs/foreground/subagent-child-card-state.js";
import type { SubagentChildRecord } from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";

function record(overrides: Partial<SubagentChildRecord> = {}): SubagentChildRecord {
	return {
		version: 1,
		childId: "cs-run:0",
		runId: "cs-run",
		index: 0,
		agent: "worker",
		state: "running",
		cwd: "/repo",
		owner: { kind: "session", sessionId: "cs-owner" },
		...overrides,
	};
}

describe("the child index", () => {
	test("a child is found by its id only for the owner that launched it (#4326)", () => {
		observeSubagentChildRecord(record({ childId: "cs-a:0", runId: "cs-a" }));
		assert.equal(subagentChildRecordOf("cs-owner", "cs-a:0")?.childId, "cs-a:0");
		assert.equal(subagentChildRecordOf("cs-other", "cs-a:0"), undefined);
		assert.equal(subagentChildRecordOf("cs-owner", "cs-a:missing"), undefined);
	});

	test("a record with no owner belongs to nobody and does not break lookups or listings (#4326)", () => {
		const { owner: _owner, ...ownerless } = record({ childId: "cs-b:0", runId: "cs-b" });
		observeSubagentChildRecord(ownerless as SubagentChildRecord);
		assert.equal(subagentChildRecordOf("cs-owner", "cs-b:0"), undefined);
		assert.ok(!subagentChildRecordsOf("cs-owner").some((candidate) => candidate.childId === "cs-b:0"));
	});

	test("children are listed per owner (#4326)", () => {
		observeSubagentChildRecord(
			record({ childId: "cs-c:0", runId: "cs-c", owner: { kind: "session", sessionId: "cs-o2" } }),
		);
		observeSubagentChildRecord(
			record({ childId: "cs-c:1", runId: "cs-c", index: 1, owner: { kind: "session", sessionId: "cs-o2" } }),
		);
		assert.deepEqual(
			subagentChildRecordsOf("cs-o2")
				.map((candidate) => candidate.childId)
				.sort(),
			["cs-c:0", "cs-c:1"],
		);
		assert.deepEqual(subagentChildRecordsOf("cs-nobody"), []);
	});

	test("a child is found by its Intercom target only for its owner, and a record without a target indexes none (#4326)", () => {
		observeSubagentChildRecord(record({ childId: "cs-d:0", runId: "cs-d", intercomTarget: "subagent-cs-d" }));
		observeSubagentChildRecord(record({ childId: "cs-d:1", runId: "cs-d", index: 1 }));
		assert.equal(subagentChildRecordForTarget("cs-owner", "subagent-cs-d")?.childId, "cs-d:0");
		assert.equal(subagentChildRecordForTarget("cs-other", "subagent-cs-d"), undefined);
		assert.equal(subagentChildRecordForTarget("cs-owner", "subagent-unknown"), undefined);
		assert.equal(subagentChildRecordForTarget("cs-owner", undefined as never), undefined);
	});

	test("the index counts one entry per child (#4326)", () => {
		const before = subagentChildIndexSize();
		observeSubagentChildRecord(record({ childId: "cs-e:0", runId: "cs-e" }));
		observeSubagentChildRecord(record({ childId: "cs-e:0", runId: "cs-e", state: "terminal" }));
		assert.equal(subagentChildIndexSize(), before + 1);
	});
});

describe("indexing an owner session", () => {
	test("a session is read once, however often it is indexed (#4326)", async () => {
		const sessionManager = SessionManager.inMemory("/repo");
		const sessionId = sessionManager.getSessionId();
		await sessionManager.appendCustomEntry(
			SUBAGENT_CHILD_RECORD_TYPE,
			record({ childId: "cs-f:0", runId: "cs-f", owner: { kind: "session", sessionId } }),
		);
		let reads = 0;
		const ctx = {
			sessionManager: {
				getSessionId: () => sessionId,
				getEntries: () => {
					reads += 1;
					return sessionManager.getEntries();
				},
				getEntry: (id: string) => sessionManager.getEntry(id),
				getLeafEntry: () => sessionManager.getLeafEntry(),
			},
		} as Pick<ExtensionContext, "sessionManager">;

		indexSubagentChildOwner(ctx);
		indexSubagentChildOwner(ctx);
		indexSubagentChildOwner(ctx);

		assert.equal(reads, 1);
		assert.equal(subagentChildRecordOf(sessionId, "cs-f:0")?.childId, "cs-f:0");
	});
});
