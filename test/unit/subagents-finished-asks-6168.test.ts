import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { closeFinishedChildAsks } from "../../packages/intercom/finished-asks.js";
import { ReplyTracker, restorePendingInboundAsks } from "../../packages/intercom/reply-tracker.js";
import { finishedChildAsks } from "../../packages/intercom/session-recovery.js";
import {
	answerFinishedAskRequests,
	finishedSubagentAsks,
	type SubagentHeldAsk,
} from "../../packages/subagents/src/runs/foreground/intercom-children.js";
import { SUBAGENT_OWNER_GENERATION } from "../../packages/subagents/src/runs/foreground/owner-generation.js";
import {
	observeSubagentChildRecord,
	registerSubagentChildRecordReader,
} from "../../packages/subagents/src/runs/foreground/subagent-child-card-state.js";
import type { SubagentChildRecord } from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

const ASKED_AT = 1_000;

/** An owner session whose child `name` (run `runId`, index 0) last recorded `latest`. */
function ownerWithChild(latest: Partial<SubagentChildRecord>, runId = "run1"): string {
	return ownerSessionWithChild(latest, runId).getSessionId();
}

function ownerSessionWithChild(latest: Partial<SubagentChildRecord>, runId = "run1"): SessionManager {
	const cwd = makeTempDirectory("finished-asks-");
	cleanups.push(() => removeTempDirectory(cwd));
	const owner = SessionManager.inMemory(cwd);
	registerSubagentChildRecordReader(owner, true);
	observeSubagentChildRecord({
		version: 1,
		childId: `${runId}:0`,
		runId,
		index: 0,
		agent: "worker",
		state: "terminal",
		cwd: "/repo",
		owner: { kind: "session", sessionId: owner.getSessionId() },
		intercomTarget: `subagent-worker-${runId}-1`,
		...latest,
	});
	return owner;
}

function eventBus() {
	const handlers = new Map<string, (payload: unknown) => void>();
	return {
		on(eventName: string, handler: (payload: unknown) => void) {
			handlers.set(eventName, handler);
			return () => handlers.delete(eventName);
		},
		emit(eventName: string, payload: unknown) {
			handlers.get(eventName)?.(payload);
		},
	};
}

function ask(overrides: Partial<SubagentHeldAsk> = {}): SubagentHeldAsk {
	return {
		messageId: "ask-1",
		from: { id: "child-intercom-id", name: "subagent-worker-run1-1" },
		source: { subagentRunId: "run1", subagentIndex: 0 },
		receivedAt: ASKED_AT,
		...overrides,
	};
}

const EARLIER_PROCESS = "earlier-process";
const questionCall = { toolCallId: "call-1", toolName: "contact_supervisor" };

describe("which asks came from a subagent that has ended (#6168)", () => {
	const finished: ReadonlyArray<readonly [string, Partial<SubagentChildRecord>]> = [
		["a child that ended on its own", { terminalStatus: "ok" }],
		["a child that failed", { terminalStatus: "error" }],
		["a child reported gone", { terminalStatus: "gone" }],
		[
			"a child whose question an earlier owner process still ran",
			{ terminalStatus: "ok", stillRunning: [{ ...questionCall, ownerGeneration: EARLIER_PROCESS }] },
		],
	];
	for (const [who, latest] of finished)
		test(`an ask from ${who} is finished (#6168)`, async () => {
			const owner = ownerWithChild(latest);
			assert.deepEqual(await finishedSubagentAsks(owner, [ask()]), ["ask-1"]);
		});

	const live: ReadonlyArray<readonly [string, Partial<SubagentChildRecord>]> = [
		[
			"a child released waiting on that question",
			{
				terminalStatus: "released",
				waitingOn: [{ ...questionCall, replyWait: { questionId: "ask-1", deadline: 1, from: "owner" } }],
			},
		],
		[
			"a child released waiting on a question it recorded no reply route for",
			{
				terminalStatus: "released",
				waitingOn: [questionCall],
			},
		],
		["a released child whose waits are not known", { terminalStatus: "released" }],
		[
			"a child an earlier owner process released waiting on a later question, whose reply to this one still wakes it",
			{
				terminalStatus: "released",
				ownerGeneration: EARLIER_PROCESS,
				waitingOn: [{ ...questionCall, replyWait: { questionId: "ask-2", deadline: 1, from: "owner" } }],
			},
		],
		[
			"a child released waiting on a command",
			{ terminalStatus: "released", waitingOn: [{ toolCallId: "call-3", toolName: "bash" }] },
		],
		["a paused child, whose messages are kept for it", { terminalStatus: "paused" }],
		["a quit child, whose messages are kept for it", { terminalStatus: "quit" }],
		[
			"a child running in this process, even in an attempt started after the ask by the clock",
			{ state: "running", ownerGeneration: SUBAGENT_OWNER_GENERATION, elapsedSpan: { dispatchedAt: ASKED_AT + 10 } },
		],
		["a running child whose record names no owner process", { state: "running" }],
		[
			"a child an earlier owner process ran when it asked, which a restart relaunches",
			{ state: "running", ownerGeneration: EARLIER_PROCESS, elapsedSpan: { dispatchedAt: ASKED_AT - 10 } },
		],
		[
			"a child this process still runs a question for",
			{ terminalStatus: "ok", stillRunning: [{ ...questionCall, ownerGeneration: SUBAGENT_OWNER_GENERATION }] },
		],
	];
	for (const [who, latest] of live)
		test(`an ask from ${who} stays answerable (#6168)`, async () => {
			const owner = ownerWithChild(latest);
			assert.deepEqual(await finishedSubagentAsks(owner, [ask()]), []);
		});

	test("an ask from a peer that is not this session's child is never closed (#6168)", async () => {
		const owner = ownerWithChild({ terminalStatus: "ok" });
		assert.deepEqual(
			await finishedSubagentAsks(owner, [
				ask({ from: { id: "peer", name: "another-session" }, source: undefined }),
				ask({ messageId: "ask-2", source: { subagentRunId: "another-run", subagentIndex: 0 } }),
				ask({ messageId: "ask-3", source: { subagentRunId: "run1", subagentIndex: 4 } }),
				ask({ messageId: "ask-4", from: { id: "child-intercom-id" } }),
				ask({ messageId: "ask-5", source: undefined }),
				ask({ messageId: "ask-6", source: { subagentRunId: "run1" } }),
			]),
			[],
		);
	});

	test("Intercom and Subagents agree on the question and its answer (#6168)", async () => {
		const owner = ownerWithChild({ terminalStatus: "ok" });
		const events = eventBus();
		const stop = answerFinishedAskRequests(events, () => true);
		cleanups.push(stop);
		const from = {
			id: "child-intercom-id",
			name: "subagent-worker-run1-1",
			cwd: "",
			model: "",
			pid: 0,
			startedAt: 0,
			lastActivity: 0,
		};

		const closed = await finishedChildAsks(events, owner, [
			{ from, message: { id: "ask-1", source: { subagentRunId: "run1", subagentIndex: 0 } }, receivedAt: ASKED_AT },
			{ from: { ...from, name: "another-session" }, message: { id: "ask-2" }, receivedAt: ASKED_AT },
		]);

		assert.deepEqual([...closed], ["ask-1"]);
	});

	test("a restart keeps an earlier ask of a subagent released waiting on a later question, as its reply still wakes it (#6168)", async () => {
		const owner = ownerSessionWithChild({
			terminalStatus: "released",
			ownerGeneration: EARLIER_PROCESS,
			waitingOn: [{ ...questionCall, replyWait: { questionId: "ask-2", deadline: 1, from: "owner" } }],
		});
		await owner.appendCustomEntry("intercom_session_identity", {
			sessionId: owner.getSessionId(),
			intercomSessionId: "owner-intercom-id",
		});
		const from = {
			id: "child-intercom-id",
			name: "subagent-worker-run1-1",
			cwd: "",
			model: "",
			pid: 0,
			startedAt: 0,
			lastActivity: 0,
		};
		const message = {
			id: "ask-1",
			timestamp: 1,
			expectsReply: true,
			source: { subagentRunId: "run1", subagentIndex: 0 },
			content: { text: "which file?" },
		};
		await owner.appendCustomMessageEntry("intercom_message", "which file?", true, { from, message }, true);
		const events = eventBus();
		cleanups.push(answerFinishedAskRequests(events, () => true));

		const notices = await closeFinishedChildAsks(
			{
				events,
				appendEntry: async (customType: string, data: unknown) =>
					void (await owner.appendCustomEntry(customType, data)),
			},
			{ sessionManager: owner },
		);

		assert.deepEqual(notices, []);
		const tracker = new ReplyTracker();
		restorePendingInboundAsks(tracker, owner.getBranch(), owner.getSessionId());
		assert.deepEqual(
			tracker.listPending().map((context) => context.message.id),
			["ask-1"],
		);
	});
});
