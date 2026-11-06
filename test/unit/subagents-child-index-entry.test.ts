import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@bastani/atomic";
import { afterEach, describe, test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import registerSubagentExtension from "../../packages/subagents/src/extension/index.js";
import {
	isReleasedChildError,
	type ReleasedChildError,
} from "../../packages/subagents/src/runs/foreground/released-child-errors.js";
import {
	bindSubagentChildCards,
	findAppendedSubagentChildRecord,
	isUnsavedSubagentChildRecord,
	observeSubagentChildRecord,
	registerSubagentChildRecordReader,
	settleSubagentChildRecord,
	subagentChildCardStateSizes,
	subagentChildIndexEntry,
	subagentChildRecordOf,
	watchSubagentChildCard,
} from "../../packages/subagents/src/runs/foreground/subagent-child-card-state.js";
import {
	createSubagentChildRecordSink,
	endWorkflowRunStageSubagentChildren,
	readSubagentChildRecords,
	recordSubagentChildGone,
	recordSubagentChildReply,
	recordSubagentChildStatus,
	SUBAGENT_CHILD_RECORD_TYPE,
	type SubagentChildRecord,
	type SubagentChildRecordInput,
	saveUnsavedSubagentChildRecords,
	subagentChildRecordFailures,
	subagentChildRecordsAppended,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import { collectGarbage, MAX_COLLECTION_ROUNDS } from "../helpers/collect-garbage.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

/** How far up from a session's leaf a just-appended record is looked for; one further is kept in memory instead. */
const APPENDED_ENTRY_SEARCH_DEPTH = 32;

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

function session(): SessionManager {
	const cwd = makeTempDirectory("child-index-entry-");
	cleanups.push(() => removeTempDirectory(cwd));
	return SessionManager.inMemory(cwd);
}

function record(
	owner: SessionManager | string,
	overrides: Partial<SubagentChildRecord> & Pick<SubagentChildRecord, "childId">,
): SubagentChildRecord {
	const [runId = overrides.childId] = overrides.childId.split(":");
	return {
		version: 1,
		runId,
		index: 0,
		agent: "worker",
		state: "running",
		cwd: "/repo",
		owner: { kind: "session", sessionId: typeof owner === "string" ? owner : owner.getSessionId() },
		...overrides,
	};
}

function input(overrides: Partial<SubagentChildRecordInput> & Pick<SubagentChildRecordInput, "runId">) {
	return { index: 0, agent: "worker", state: "running" as const, cwd: "/repo", ...overrides };
}

function writingHost(at: SessionManager) {
	return {
		appendEntry: async (customType: string, data?: unknown) => {
			await at.appendCustomEntry(customType, data);
		},
	};
}

const SUBAGENT_RELEASED = "released";

function isChildEntry(entry: SessionEntry, childId: string): boolean {
	return (
		entry.type === "custom" &&
		entry.customType === SUBAGENT_CHILD_RECORD_TYPE &&
		(entry.data as SubagentChildRecord).childId === childId
	);
}

/** Register the subagents extension on `at`'s session; returns what starts it, as a subagent at depth 1. */
function startExtension(at: SessionManager, policy: { readonly depth: number }): () => void {
	const handlers = new Map<string, (event: { reason?: string }, ctx: ExtensionContext) => unknown>();
	const pi = {
		events: { on: () => () => {}, emit() {} },
		appendEntry: async (customType: string, data?: unknown) => {
			await at.appendCustomEntry(customType, data);
		},
		getSessionName: () => "session",
		registerTool: () => {},
		registerCommand: () => {},
		registerMessageRenderer: () => {},
		on: (event: string, handler: (event: { reason?: string }, ctx: ExtensionContext) => unknown) => {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	registerSubagentExtension(pi);
	const ctx = {
		cwd: at.getCwd(),
		mode: "tui",
		hasUI: false,
		ui: {},
		sessionManager: at,
		modelRegistry: { getAvailable: () => [], getAll: () => [], find: () => undefined },
		subagentPolicy: {
			depth: policy.depth,
			managementActions: "full",
			fanoutAuthorized: false,
			inheritProjectContext: false,
			inheritSkills: false,
		},
	} as unknown as ExtensionContext;
	cleanups.push(() => void handlers.get("session_shutdown")?.({ reason: "quit" }, ctx));
	return () => void handlers.get("session_start")?.({ reason: "new" }, ctx);
}

function unreadable(fields: ReleasedChildError["fields"]) {
	return (error: Error) => {
		assert.ok(isReleasedChildError(error));
		assert.equal(error.code, "child-record-unreadable");
		assert.equal(error.retryable, false);
		assert.deepEqual(error.fields, fields);
		return true;
	};
}

describe("a released child's index entry (#4395)", () => {
	test("an entry whose session holds no such entry throws child-record-unreadable naming where it looked", () => {
		const owner = session();
		const ownerSessionId = owner.getSessionId();
		registerSubagentChildRecordReader(owner);
		observeSubagentChildRecord(record(owner, { childId: "ix-gone:0" }), false, {
			entryId: "deadbeef",
			sessionId: ownerSessionId,
		});

		assert.throws(
			() => subagentChildRecordOf(ownerSessionId, "ix-gone:0"),
			unreadable({ childId: "ix-gone:0", ownerSessionId, sessionId: ownerSessionId, entryId: "deadbeef" }),
		);
	});

	test("an entry recorded in a session that is not open in this process throws child-record-unreadable", async () => {
		const owner = session();
		const ownerSessionId = owner.getSessionId();
		const elsewhere = record(owner, { childId: "ix-closed:0" });
		const entryId = await owner.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, elsewhere);
		observeSubagentChildRecord(elsewhere, false, { entryId, sessionId: "closed-session" });

		assert.equal(subagentChildIndexEntry("ix-closed:0")?.recordedIn, "closed-session");
		assert.throws(
			() => subagentChildRecordOf(ownerSessionId, "ix-closed:0"),
			unreadable({ childId: "ix-closed:0", ownerSessionId, sessionId: "closed-session", entryId }),
		);
	});

	test("a saved record is read from its entry, and the index keeps no copy of it", async () => {
		const owner = session();
		const ownerSessionId = owner.getSessionId();
		const sink = createSubagentChildRecordSink(writingHost(owner), {
			sessionManager: owner,
			orchestrationContext: undefined,
		});
		sink.record(input({ runId: "ix-saved", taskId: "task-1", launch: { task: "a long task" } }));
		sink.record(input({ runId: "ix-saved", taskId: "task-1", state: "terminal", terminalStatus: "released" }));
		await sink.flushed?.();

		const entry = subagentChildIndexEntry("ix-saved:0");
		assert.ok(entry?.entryId);
		assert.equal(entry.recordedIn, undefined, "an owner's own record names no other session");
		const saved = owner.getEntry(entry.entryId) as SessionEntry & { data: SubagentChildRecord };
		assert.equal(subagentChildRecordOf(ownerSessionId, "ix-saved:0"), saved.data, "read from the session entry");
		assert.deepEqual(saved.data.launch, { task: "a long task" }, "each record is the child's complete record");
		assert.equal(saved.data.terminalStatus, "released");
	});

	test("a child another owner launched under the same id replaces the entry instead of merging into it", () => {
		const first = session();
		const second = session();
		observeSubagentChildRecord(record(first, { childId: "ix-reused:0", launch: { task: "first owner's task" } }));
		const replaced = observeSubagentChildRecord(record(second, { childId: "ix-reused:0" }));

		assert.equal(replaced.launch, undefined);
		assert.equal(subagentChildRecordOf(second.getSessionId(), "ix-reused:0")?.launch, undefined);
		assert.equal(subagentChildRecordOf(first.getSessionId(), "ix-reused:0"), undefined);
	});

	test("a fork's copy of another session's child is read from the fork's own session", async () => {
		const fork = session();
		const original = "ix-original-session";
		const copied = record(original, { childId: "ix-copied:0", taskId: "task-copied" });
		const entryId = await fork.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, copied);
		bindSubagentChildCards({ sessionManager: fork });

		const entry = subagentChildIndexEntry("ix-copied:0");
		assert.deepEqual(
			{ entryId: entry?.entryId, recordedIn: entry?.recordedIn, copied: entry?.copied },
			{ entryId, recordedIn: fork.getSessionId(), copied: true },
		);
		assert.equal(subagentChildRecordOf(original, "ix-copied:0"), copied);
	});

	test("a copy never replaces the owner's own entry", async () => {
		const owner = session();
		const fork = session();
		observeSubagentChildRecord(record(owner, { childId: "ix-own:0", state: "terminal", terminalStatus: "ok" }));
		await fork.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, record(owner, { childId: "ix-own:0" }));
		bindSubagentChildCards({ sessionManager: fork });

		assert.equal(subagentChildIndexEntry("ix-own:0")?.copied, undefined);
		assert.equal(subagentChildRecordOf(owner.getSessionId(), "ix-own:0")?.terminalStatus, "ok");
	});
	test("the entry keeps the child's identity, state and where its record is, and nothing of its history", async () => {
		const owner = session();
		const ownerSessionId = owner.getSessionId();
		const sink = createSubagentChildRecordSink(writingHost(owner), {
			sessionManager: owner,
			orchestrationContext: undefined,
		});
		sink.record(
			input({
				runId: "ix-shape",
				agentSource: "project",
				forked: true,
				state: "terminal",
				taskId: "task-shape",
				childSessionId: "child-shape",
				childSessionFile: "/sessions/child-shape.jsonl",
				launchModel: "faux/model",
				launchThinkingLevel: "high",
				launchLeafId: null,
				intercomTarget: "subagent-worker-shape",
				intercomGroup: "lane",
				orchestratorTarget: "parent",
				terminalStatus: "released",
				heldMessages: { taskId: "task-shape", messages: ["held"] },
				launch: { task: "the task" },
				inherited: { model: "faux/model" },
				namedModel: "faux/model",
				requestedModel: "faux/model",
				waitingOn: [{ toolCallId: "ci-1", toolName: "wait_for_ci" }],
				releasedIntercomId: "intercom-shape",
				heldToolResults: [],
				ownerGeneration: "generation",
			}),
		);
		await sink.flushed?.();

		const entry = subagentChildIndexEntry("ix-shape:0");
		assert.deepEqual(entry, {
			childId: "ix-shape:0",
			runId: "ix-shape",
			index: 0,
			agent: "worker",
			ownerSessionId,
			state: "terminal",
			cwd: "/repo",
			taskId: "task-shape",
			terminalStatus: "released",
			childSessionId: "child-shape",
			childSessionFile: "/sessions/child-shape.jsonl",
			intercomTarget: "subagent-worker-shape",
			entryId: entry?.entryId,
		});
		assert.ok(entry?.entryId);
		const bare = record(owner, { childId: "ix-bare:0" });
		const bareEntryId = await owner.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, bare);
		observeSubagentChildRecord(bare, false, { entryId: bareEntryId, sessionId: ownerSessionId });
		assert.deepEqual(subagentChildIndexEntry("ix-bare:0"), {
			childId: "ix-bare:0",
			runId: "ix-bare",
			index: 0,
			agent: "worker",
			ownerSessionId,
			state: "running",
			cwd: "/repo",
			entryId: bareEntryId,
		});
	});

	test("an entry pointing at another child's record or at an entry that is no child record is unreadable", async () => {
		const owner = session();
		const ownerSessionId = owner.getSessionId();
		registerSubagentChildRecordReader(owner);
		const otherEntryId = await owner.appendCustomEntry(
			SUBAGENT_CHILD_RECORD_TYPE,
			record(owner, { childId: "ix-other:0" }),
		);
		const foreignEntryId = await owner.appendCustomEntry("other", { childId: "ix-pointed:0" });
		for (const entryId of [otherEntryId, foreignEntryId]) {
			observeSubagentChildRecord(record(owner, { childId: "ix-pointed:0" }), false, {
				entryId,
				sessionId: ownerSessionId,
			});
			assert.throws(
				() => subagentChildRecordOf(ownerSessionId, "ix-pointed:0"),
				unreadable({ childId: "ix-pointed:0", ownerSessionId, sessionId: ownerSessionId, entryId }),
			);
		}
	});

	test("a newer record of a child whose saved record cannot be read is indexed as written", () => {
		const owner = session();
		const ownerSessionId = owner.getSessionId();
		observeSubagentChildRecord(record(owner, { childId: "ix-lost:0", launch: { task: "unreadable" } }), false, {
			entryId: "lost0001",
			sessionId: "closed-elsewhere",
		});
		const newer = observeSubagentChildRecord(record(owner, { childId: "ix-lost:0", state: "terminal" }));

		assert.equal(newer.launch, undefined);
		assert.equal(subagentChildRecordOf(ownerSessionId, "ix-lost:0"), newer);
	});
});

describe("saving a child's latest record as one entry (#4395)", () => {
	test("partial records an older Atomic wrote are saved once as one complete record per child, then indexed", async () => {
		const owner = session();
		const ownerSessionId = owner.getSessionId();
		await owner.appendCustomEntry(
			SUBAGENT_CHILD_RECORD_TYPE,
			record(owner, { childId: "ix-legacy:0", taskId: "task-legacy", launch: { task: "legacy task" } }),
		);
		await owner.appendCustomEntry(
			SUBAGENT_CHILD_RECORD_TYPE,
			record(owner, { childId: "ix-legacy:0", state: "terminal", terminalStatus: "released" }),
		);
		const folded = readSubagentChildRecords(owner.getEntries(), ownerSessionId).get("ix-legacy:0");
		const otherOwner = record("ix-other-owner", { childId: "ix-legacy-other:0" });
		observeSubagentChildRecord(otherOwner);
		bindSubagentChildCards({ sessionManager: owner });

		assert.equal(subagentChildIndexEntry("ix-legacy:0")?.entryId, undefined, "its latest entry is partial");
		assert.deepEqual(subagentChildRecordOf(ownerSessionId, "ix-legacy:0"), folded);

		await saveUnsavedSubagentChildRecords(writingHost(owner), ownerSessionId);

		const entryId = subagentChildIndexEntry("ix-legacy:0")?.entryId;
		assert.ok(entryId);
		assert.deepEqual((owner.getEntry(entryId) as SessionEntry & { data: SubagentChildRecord }).data, folded);
		assert.ok(isUnsavedSubagentChildRecord(otherOwner), "another owner's record is not saved in this session");
		const entries = owner.getEntries().length;
		await saveUnsavedSubagentChildRecords(writingHost(owner), ownerSessionId);
		bindSubagentChildCards({ sessionManager: owner });
		assert.equal(owner.getEntries().length, entries, "nothing more to save, and a later bind finds it complete");
		assert.equal(subagentChildIndexEntry("ix-legacy:0")?.entryId, entryId);
	});

	test("a record whose append the host defers stays in memory until a later record of the child is saved", async () => {
		const owner = session();
		const ownerSessionId = owner.getSessionId();
		const context = { sessionManager: owner, orchestrationContext: undefined };
		const deferred = createSubagentChildRecordSink({ appendEntry: async () => undefined }, context);
		deferred.record(input({ runId: "ix-deferred", taskId: "task-deferred" }));
		await deferred.flushed?.();

		assert.equal(subagentChildIndexEntry("ix-deferred:0")?.entryId, undefined);
		assert.equal(subagentChildRecordOf(ownerSessionId, "ix-deferred:0")?.taskId, "task-deferred");

		const writing = createSubagentChildRecordSink(writingHost(owner), context);
		writing.record(input({ runId: "ix-deferred", state: "terminal", terminalStatus: "released" }));
		await writing.flushed?.();

		const entryId = subagentChildIndexEntry("ix-deferred:0")?.entryId;
		assert.ok(entryId);
		const saved = (owner.getEntry(entryId) as SessionEntry & { data: SubagentChildRecord }).data;
		assert.deepEqual([saved.taskId, saved.terminalStatus], ["task-deferred", "released"]);
	});

	test(`a record is found up to ${APPENDED_ENTRY_SEARCH_DEPTH - 1} entries below the leaf, and not further`, async () => {
		const owner = session();
		registerSubagentChildRecordReader(owner);
		const found = observeSubagentChildRecord(record(owner, { childId: "ix-depth-a:0" }));
		const foundEntryId = await owner.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, found);
		for (let later = 0; later < APPENDED_ENTRY_SEARCH_DEPTH - 1; later++) await owner.appendCustomEntry("other", {});
		assert.deepEqual(findAppendedSubagentChildRecord(found), {
			entryId: foundEntryId,
			sessionId: owner.getSessionId(),
		});

		await owner.appendCustomEntry("other", {});
		assert.equal(findAppendedSubagentChildRecord(found), undefined);
		settleSubagentChildRecord(found);
		assert.equal(isUnsavedSubagentChildRecord(found), true);
	});

	test("a record a newer one of its child replaced is not indexed once its own append resolves", async () => {
		const owner = session();
		registerSubagentChildRecordReader(owner);
		const older = observeSubagentChildRecord(record(owner, { childId: "ix-newer:0" }));
		const newer = observeSubagentChildRecord(record(owner, { childId: "ix-newer:0", state: "terminal" }));
		await owner.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, older);
		settleSubagentChildRecord(older);

		assert.equal(subagentChildIndexEntry("ix-newer:0")?.entryId, undefined);
		assert.equal(isUnsavedSubagentChildRecord(newer), true);
		assert.equal(subagentChildRecordOf(owner.getSessionId(), "ix-newer:0"), newer);
	});

	test("a session's own reader is kept over a later one, and binding the session replaces it", async () => {
		const owner = session();
		const ownerSessionId = owner.getSessionId();
		const saved = record(owner, { childId: "ix-reader:0" });
		const entryId = await owner.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, saved);
		const empty: Parameters<typeof registerSubagentChildRecordReader>[0] = {
			getSessionId: () => ownerSessionId,
			getEntry: () => undefined,
			getLeafEntry: () => undefined,
		};
		registerSubagentChildRecordReader(owner, true);
		registerSubagentChildRecordReader(empty);
		observeSubagentChildRecord(saved, false, { entryId, sessionId: ownerSessionId });
		assert.equal(subagentChildRecordOf(ownerSessionId, "ix-reader:0"), saved);

		registerSubagentChildRecordReader(empty, true);
		assert.throws(() => subagentChildRecordOf(ownerSessionId, "ix-reader:0"), isReleasedChildError);
	});

	test("a reader that fails is not taken for one that does not hold the record", async () => {
		const owner = session();
		const ownerSessionId = owner.getSessionId();
		registerSubagentChildRecordReader(
			{
				getSessionId: () => ownerSessionId,
				getEntry: () => {
					throw new RangeError("store failed");
				},
				getLeafEntry: () => undefined,
			},
			true,
		);
		observeSubagentChildRecord(record(owner, { childId: "ix-failing:0" }), false, {
			entryId: "e1",
			sessionId: ownerSessionId,
		});

		assert.throws(() => observeSubagentChildRecord(record(owner, { childId: "ix-failing:0" })), RangeError);
	});
	test("a record already being saved is not saved again", async () => {
		const owner = session();
		const ownerSessionId = owner.getSessionId();
		const sink = createSubagentChildRecordSink(writingHost(owner), {
			sessionManager: owner,
			orchestrationContext: undefined,
		});
		sink.record(input({ runId: "ix-once" }));
		await saveUnsavedSubagentChildRecords(writingHost(owner), ownerSessionId);

		const saved = owner.getEntries().filter((entry) => isChildEntry(entry, "ix-once:0"));
		assert.equal(saved.length, 1);
		assert.equal(subagentChildIndexEntry("ix-once:0")?.entryId, saved[0]?.id);
	});

	test("a record that cannot be saved is counted as a failed save of its child, with the store's error", async () => {
		const owner = session();
		const ownerSessionId = owner.getSessionId();
		await owner.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, record(owner, { childId: "ix-full:0", taskId: "t" }));
		await owner.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, record(owner, { childId: "ix-full:0" }));
		bindSubagentChildCards({ sessionManager: owner });
		const before = subagentChildRecordFailures.count;
		const diskFull = new Error("disk full");

		await saveUnsavedSubagentChildRecords(
			{
				appendEntry: async () => {
					throw diskFull;
				},
			},
			ownerSessionId,
		);

		assert.equal(subagentChildRecordFailures.count, before + 1);
		assert.deepEqual(
			[subagentChildRecordFailures.last?.code, subagentChildRecordFailures.last?.fields.childId],
			["record-append-failed", "ix-full:0"],
		);
		assert.equal(subagentChildRecordFailures.last?.cause, diskFull);
	});

	test("a session that fails while its just-saved record is looked for counts as a failed save", async () => {
		const owner = session();
		const lookupFailed = new Error("leaf unavailable");
		const failing = {
			getSessionId: () => owner.getSessionId(),
			getEntries: () => owner.getEntries(),
			getEntry: (id: string) => owner.getEntry(id),
			getLeafEntry: () => {
				throw lookupFailed;
			},
		} as unknown as ExtensionContext["sessionManager"];
		registerSubagentChildRecordReader(failing, true);
		const before = subagentChildRecordFailures.count;
		const sink = createSubagentChildRecordSink(writingHost(owner), {
			sessionManager: failing,
			orchestrationContext: undefined,
		});
		sink.record(input({ runId: "ix-lookup" }));
		await sink.flushed?.();

		assert.equal(subagentChildRecordFailures.count, before + 1);
		assert.equal(subagentChildRecordFailures.last?.code, "record-append-failed");
		assert.equal(subagentChildRecordFailures.last?.cause, lookupFailed);
	});

	test("status, gone and reply records point the index at the entries they are saved as", async () => {
		const owner = session();
		const ownerSessionId = owner.getSessionId();
		registerSubagentChildRecordReader(owner, true);
		const host = writingHost(owner);
		const base = record(owner, {
			childId: "ix-later:0",
			state: "terminal",
			terminalStatus: "released",
			taskId: "task-later",
			waitingOn: [
				{
					toolCallId: "ask-1",
					toolName: "intercom",
					replyWait: { questionId: "q-1", deadline: Date.now() + 60_000, from: "peer" },
				},
			],
		});
		observeSubagentChildRecord(base);
		const latestEntryId = () => owner.getLeafEntry()?.id;

		await recordSubagentChildStatus(host, base, "paused");
		assert.equal(subagentChildIndexEntry("ix-later:0")?.entryId, latestEntryId());
		assert.equal(subagentChildIndexEntry("ix-later:0")?.terminalStatus, "paused");

		await recordSubagentChildStatus(host, base, SUBAGENT_RELEASED);
		const reply = {
			toolCallId: "ask-1",
			toolName: "intercom",
			result: { content: [{ type: "text" as const, text: "yes" }], details: undefined },
			isError: false,
		};
		assert.equal(await recordSubagentChildReply(host, ownerSessionId, "ix-later:0", "q-1", reply, Date.now()), true);
		assert.equal(subagentChildIndexEntry("ix-later:0")?.entryId, latestEntryId());
		assert.deepEqual(subagentChildRecordOf(ownerSessionId, "ix-later:0")?.heldToolResults, [reply]);

		await recordSubagentChildGone(host, base);
		assert.equal(subagentChildIndexEntry("ix-later:0")?.entryId, latestEntryId());
		assert.equal(subagentChildIndexEntry("ix-later:0")?.terminalStatus, "gone");
		assert.equal(isUnsavedSubagentChildRecord(subagentChildRecordOf(ownerSessionId, "ix-later:0") as never), false);
	});

	test("children a dormant stage's ended run closes are indexed by the entries saved in the stage's session", async () => {
		const store = new MemorySessionStore();
		const cwd = makeTempDirectory("child-index-stage-");
		cleanups.push(() => removeTempDirectory(cwd));
		const parent = await SessionManager.create(store, cwd);
		const stage = await SessionManager.create(store, cwd);
		const stageSessionId = stage.getSessionId();
		await stage.appendCustomEntry(
			SUBAGENT_CHILD_RECORD_TYPE,
			record(stageSessionId, { childId: "ix-stage:0", taskId: "task-stage", launch: { task: "stage task" } }),
		);

		await endWorkflowRunStageSubagentChildren({ sessionManager: parent }, [stageSessionId]);

		const reopened = await SessionManager.open(store, stageSessionId);
		const closed = reopened
			.getEntries()
			.filter((entry) => isChildEntry(entry, "ix-stage:0"))
			.at(-1);
		const entry = subagentChildIndexEntry("ix-stage:0");
		assert.deepEqual(
			[entry?.entryId, entry?.terminalStatus, entry?.recordedIn],
			[closed?.id, "stage-closed", undefined],
		);
		assert.equal(isUnsavedSubagentChildRecord((closed as SessionEntry & { data: SubagentChildRecord }).data), false);
		await store.close();
	});
});

describe("what the index keeps besides entries (#4395)", () => {
	test("a card's watcher goes with the card", async () => {
		const before = subagentChildCardStateSizes().watchers;
		let card: object | undefined = {};
		watchSubagentChildCard(card, () => {}, "ix-watched:0", undefined);
		watchSubagentChildCard(card, () => {}, "ix-watched:0", undefined);
		assert.equal(subagentChildCardStateSizes().watchers, before + 1);

		card = undefined;
		for (let round = 0; round < MAX_COLLECTION_ROUNDS && subagentChildCardStateSizes().watchers > before; round++)
			await collectGarbage(1);
		assert.equal(subagentChildCardStateSizes().watchers, before);
	});

	test("a subagent's own session adds nothing to the child index when it starts", () => {
		const childSession = session();
		const start = startExtension(childSession, { depth: 1 });
		const before = subagentChildCardStateSizes();

		start();

		assert.deepEqual(subagentChildCardStateSizes(), before);
	});

	test("a session started at the top level saves one complete record of each child an older Atomic recorded", async () => {
		const owner = session();
		const ownerSessionId = owner.getSessionId();
		await owner.appendCustomEntry(
			SUBAGENT_CHILD_RECORD_TYPE,
			record(owner, { childId: "ix-started:0", taskId: "task-started", launch: { task: "started task" } }),
		);
		await owner.appendCustomEntry(
			SUBAGENT_CHILD_RECORD_TYPE,
			record(owner, { childId: "ix-started:0", state: "terminal", terminalStatus: "ok" }),
		);
		const folded = readSubagentChildRecords(owner.getEntries(), ownerSessionId).get("ix-started:0");

		startExtension(owner, { depth: 0 })();
		await subagentChildRecordsAppended(ownerSessionId);

		const entryId = subagentChildIndexEntry("ix-started:0")?.entryId;
		assert.ok(entryId);
		assert.deepEqual((owner.getEntry(entryId) as SessionEntry & { data: SubagentChildRecord }).data, folded);
	});
});
