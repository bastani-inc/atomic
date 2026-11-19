import assert from "node:assert/strict";
import type { ExtensionContext } from "@bastani/atomic";
import { describe, test } from "vitest";
import type { VerbatimCompactionDetails } from "../../packages/coding-agent/src/core/compaction/compaction-types.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import {
	holdSubagentChildRecord,
	indexSubagentChildOwner,
	keepSubagentChildRecord,
	loadSubagentChildRecord,
	observeSubagentChildRecord,
	SUBAGENT_CHILD_RECORD_TYPE,
	subagentChildIndexEntry,
	subagentChildIndexSize,
	subagentChildRecordForTarget,
	subagentChildRecordNeedsRead,
	subagentChildRecordOf,
	subagentChildRecordsOf,
	subagentChildStandingsOf,
} from "../../packages/subagents/src/runs/foreground/subagent-child-card-state.js";
import {
	holdSubagentChildMessages,
	type SubagentChildRecord,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";

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

/** A `/clear`: nothing before it stays in its session's window. */
const CLEARED: VerbatimCompactionDetails = {
	strategy: "verbatim-lines",
	promptVersion: 7,
	parameters: { query: "clear" },
	form: "cleared",
	stats: {
		linesBefore: 1,
		linesDeleted: 1,
		linesKept: 0,
		rangeCount: 1,
		tokensBefore: 10,
		tokensAfter: 5,
		percentReduction: 50,
	},
};

describe("a child whose records a clear moved out of its owner's window (#5554)", () => {
	test("is read from the owner's session on demand, and an action on it acts as on the record it read", async () => {
		const sessionManager = SessionManager.inMemory("/repo");
		const sessionId = sessionManager.getSessionId();
		const finished = record({
			childId: "cs-cleared:0",
			runId: "cs-cleared",
			owner: { kind: "session", sessionId },
			state: "terminal",
			terminalStatus: "ok",
			taskId: "task-cleared",
			task: "the task only its record keeps",
			intercomTarget: "subagent-cs-cleared",
			intercomGroup: "lane",
		});
		await sessionManager.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, finished);
		indexSubagentChildOwner({ sessionManager });
		const appends: unknown[] = [];
		const pi = { appendEntry: async (_type: string, data: unknown) => void appends.push(data) };

		await sessionManager.appendCompaction("clear", null, 10, {
			strategy: "verbatim-lines",
			promptVersion: 7,
			parameters: { query: "clear" },
			form: "cleared",
			stats: {
				linesBefore: 1,
				linesDeleted: 1,
				linesKept: 0,
				rangeCount: 1,
				tokensBefore: 10,
				tokensAfter: 5,
				percentReduction: 50,
			},
		});
		assert.equal(sessionManager.getEntry(subagentChildIndexEntry("cs-cleared:0")?.entryId ?? ""), undefined);

		const [standing] = subagentChildStandingsOf(sessionId);
		assert.deepEqual(
			{ ...standing },
			{
				childId: "cs-cleared:0",
				runId: "cs-cleared",
				index: 0,
				agent: "worker",
				state: "terminal",
				cwd: "/repo",
				taskId: "task-cleared",
				terminalStatus: "ok",
				intercomTarget: "subagent-cs-cleared",
				intercomGroup: "lane",
			},
			"a reconnect reports it ended, with its group, without reading it",
		);
		assert.equal(subagentChildRecordNeedsRead(sessionId, "cs-cleared:0"), true);
		assert.deepEqual(await loadSubagentChildRecord(sessionId, "cs-cleared:0"), finished);
		assert.equal(await holdSubagentChildMessages(pi, sessionId, "cs-cleared:0", ["late"]), "not-held");
		assert.deepEqual(appends, [], "a finished child holds nothing");
	});

	test("an action lets go of the record it held without taking it from another action or a wake that keeps it", async () => {
		const sessionManager = SessionManager.inMemory("/repo");
		const sessionId = sessionManager.getSessionId();
		const childId = "cs-held:0";
		const finished = record({
			childId,
			runId: "cs-held",
			owner: { kind: "session", sessionId },
			state: "terminal",
			terminalStatus: "ok",
			task: "the task only its record keeps",
		});
		await sessionManager.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, finished);
		indexSubagentChildOwner({ sessionManager });
		await sessionManager.appendCompaction("clear", null, 10, CLEARED);
		assert.equal(subagentChildRecordNeedsRead(sessionId, childId), true);

		// Two actions at once, as two resumes: the record stays until the last of them lets it go.
		const first = await holdSubagentChildRecord(sessionId, childId);
		const second = await holdSubagentChildRecord(sessionId, childId);
		assert.deepEqual(first?.record, finished);
		assert.equal(second?.record, first?.record, "the second action finds the record the first read");
		first?.release();
		first?.release();
		assert.deepEqual(subagentChildRecordOf(sessionId, childId), finished, "a release counts once");
		second?.release();
		assert.equal(subagentChildRecordNeedsRead(sessionId, childId), true, "let go once no action holds it");

		// A wake keeps the record an action read until the child's next observation, after the action lets it go.
		const action = await holdSubagentChildRecord(sessionId, childId);
		assert.equal(keepSubagentChildRecord(sessionId, childId), undefined, "nothing to read: the action read it");
		action?.release();
		assert.deepEqual(subagentChildRecordOf(sessionId, childId), finished);
	});
});
