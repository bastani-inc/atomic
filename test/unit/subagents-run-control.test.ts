import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext, SessionStore } from "@bastani/atomic";
import { afterEach, test, vi } from "vitest";
import type { VerbatimCompactionDetails } from "../../packages/coding-agent/src/core/compaction/compaction-types.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { formatTaskCompletion } from "../../packages/coding-agent/src/core/tasks/completion.js";
import type { Sequence, TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import type { PeerResumeOutcome, PeerResumeRequest } from "../../packages/intercom/session-recovery.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agents.js";
import { INTERCOM_BRIDGE_MARKER } from "../../packages/subagents/src/intercom/intercom-bridge.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import { takeStoppedQueuedOwnerlessChild } from "../../packages/subagents/src/runs/foreground/ownerless-children.js";
import {
	markEndedChildrenOf,
	SUBAGENT_MARK_ENDED_CHILDREN_EVENT,
} from "../../packages/subagents/src/runs/foreground/released-child-reservations.js";
import { SUBAGENT_RELEASED_WAKE_PROMPT } from "../../packages/subagents/src/runs/foreground/released-children.js";
import { holdRunWorktree, registerRunWorktrees } from "../../packages/subagents/src/runs/foreground/run-worktrees.js";
import {
	bindSubagentChildCards,
	subagentChildCardRecord,
	subagentChildCardTask,
	subagentChildIndexEntry,
	subagentChildRecordNeedsRead,
	subagentChildRecordOf,
	subagentChildRecordsMerging,
	watchSubagentChildCard,
} from "../../packages/subagents/src/runs/foreground/subagent-child-card-state.js";
import {
	isSubagentChildRecord,
	readSubagentChildRecords,
	SUBAGENT_CHILD_RECORD_TYPE,
	type SubagentChildRecord,
	saveUnsavedSubagentChildRecords,
	takeSubagentChildStop,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import {
	holdRunningSubagentChildren,
	restoreSubagentChildren,
	SUBAGENT_RESERVE_RESTORING_CHILD_EVENT,
	type SubagentReserveRestoringChildRequest,
	subagentChildRestoreNotices,
} from "../../packages/subagents/src/runs/foreground/subagent-child-restore.js";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import type { ExecutorDeps } from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import {
	resumeAwaitingSubagentChildren,
	SUBAGENT_PEER_RESUME_EVENT,
	SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT,
	subagentChildOfTask,
	subagentChildrenAwaitingResume,
	subagentMessageWakePrompt,
	wakeSubagentChildForMessage,
} from "../../packages/subagents/src/runs/foreground/subagent-run-control.js";
import {
	queuedResumeStart,
	takeStoppedQueuedSubagentChild,
} from "../../packages/subagents/src/runs/foreground/task-execution.js";
import { createExecutionScheduler } from "../../packages/subagents/src/runs/shared/parallel-utils.js";
import { subagentStartHoldMs } from "../../packages/subagents/src/runs/shared/start-progress.js";
import * as worktrees from "../../packages/subagents/src/runs/shared/worktree.js";
import * as artifactStorage from "../../packages/subagents/src/shared/artifacts.js";
import { createForkContextResolver } from "../../packages/subagents/src/shared/fork-context.js";
import type { RunSyncOptions, TestSessionQueue } from "../../packages/subagents/src/shared/types.js";
import { collectGarbage } from "../helpers/collect-garbage.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";
import {
	agent,
	answeredWithin,
	cleanups,
	duringCancelOf,
	extractRunningTaskId,
	gitOutput,
	type Harness,
	harness,
	holdGitFilter,
	initGitRepository,
	LAUNCH_QUIT_RESUME_TIMEOUT_MS,
	launchWorktreeRun,
	ORIGINAL_TASK,
	occurrences,
	RECORD_WAIT_MS,
	readsOf,
	resumedTaskId,
	runCleanups,
	savedPatches,
	settled,
	settlesWithin,
	taskExecutionKind,
	text,
	waitForWorktreeCleanup,
} from "./subagents-run-control-helpers.js";

afterEach(runCleanups);

/** A user agent with the project agent's name: the default scope shadows it with the project one. */
const userAgent: AgentConfig = {
	...agent,
	source: "user",
	filePath: "user/worker.md",
	systemPrompt: "Work as the user",
};

function transcript(record: SubagentChildRecord): string {
	assert.ok(record.childSessionFile);
	return readFileSync(record.childSessionFile, "utf8");
}

/** A child's whole session as its lines: its own file, or its entries in its parent's store, where a launch keeps it. */
async function storedTranscript(record: SubagentChildRecord, store: SessionStore): Promise<string> {
	if (record.childSessionFile) return transcript(record);
	assert.ok(record.childSessionId);
	return (await store.load(record.childSessionId)).entries.map((entry) => JSON.stringify(entry)).join("\n");
}

test("a launch aborted during artifact preparation creates no child storage or authorization (#5285)", async () => {
	const h = harness();
	const controller = new AbortController();
	const entered = Promise.withResolvers<void>();
	const artifacts = Promise.withResolvers<string>();
	const readArtifacts = vi.spyOn(artifactStorage, "getArtifactsDir").mockImplementation(() => {
		entered.resolve();
		return artifacts.promise;
	});
	try {
		const sessionDir = join(h.cwd, "not-created-after-close");
		const pending = h.call({ agent: "worker", task: "do not start", sessionDir }, controller.signal);
		await entered.promise;
		controller.abort();
		artifacts.resolve(join(h.cwd, "artifacts"));
		const result = await pending;

		assert.equal(result.isError, true);
		assert.equal(existsSync(sessionDir), false, "closed preparation never creates its session root");
		assert.deepEqual(h.authorizations, [], "closed preparation requests no supervisor authorization");
		assert.deepEqual(h.runs, []);
		assert.equal(h.deps.state.foregroundControls.size, 0);
	} finally {
		artifacts.resolve(join(h.cwd, "artifacts"));
		readArtifacts.mockRestore();
	}
});

test("an artifact preparation failure returns a subagent tool error (#5285)", async () => {
	const h = harness();
	const readArtifacts = vi
		.spyOn(artifactStorage, "getArtifactsDir")
		.mockRejectedValue(new Error("artifact storage unavailable"));
	try {
		const result = await h.call({ agent: "worker", task: "do not start" });
		assert.equal(result.isError, true);
		assert.match(text(result), /artifact storage unavailable/);
		assert.deepEqual(h.runs, []);
		assert.equal(h.deps.state.foregroundControls.size, 0);
	} finally {
		readArtifacts.mockRestore();
	}
});

test("pause stops a running child resumably and holds sends to it until resume", async () => {
	const h = harness();
	const { record, taskId } = await h.launch("pause1");

	const paused = await h.call({ action: "pause", id: record.childId });
	assert.notEqual(paused.isError, true, text(paused));
	assert.match(text(paused), /Paused worker \(pause1:0, subagent-worker-pause1\)/);
	assert.deepEqual(paused.details.runControl, {
		action: "pause",
		children: [
			{
				childId: "pause1:0",
				runId: "pause1",
				index: 0,
				agent: "worker",
				state: "paused",
				taskId,
				intercomTarget: "subagent-worker-pause1",
				childSessionId: record.childSessionId,
				childSessionFile: record.childSessionFile,
			},
		],
	});
	const observed = await h.host.waitForTask(taskId);
	assert.ok(observed.ok && observed.value.kind === "settled");
	assert.deepEqual(
		{ kind: observed.value.result.kind, cause: "cause" in observed.value.result ? observed.value.result.cause : "" },
		{ kind: "cancelled", cause: "pause" },
		"pause is a typed resumable stop, never an owner cancellation",
	);
	const latest = await h.waitForLatest(record.childId, (candidate) => candidate.state === "terminal");
	assert.equal(latest.terminalStatus, "paused");
	assert.deepEqual(h.holds, [{ reserve: "fresh-capability-1", aliases: [record.childSessionId] }]);

	const again = await h.call({ action: "pause", id: record.childId });
	assert.notEqual(again.isError, true);
	assert.match(text(again), /is already paused/);
});

test("pause of a child that completes before the stop takes effect reports it completed and holds nothing (#3784)", async () => {
	const h = harness();
	h.completesWhenStopped = true;
	const { record } = await h.launch("race1");

	const paused = await h.call({ action: "pause", id: record.childId });
	assert.equal(paused.isError, true, text(paused));
	assert.match(text(paused), /worker \(race1:0, subagent-worker-race1\) completed \(ok\) before it could be paused/);
	assert.doesNotMatch(text(paused), /Paused/);
	assert.deepEqual(paused.details.runControl?.children, []);
	assert.equal(h.latest(record.childId)?.terminalStatus, "ok");
	assert.deepEqual(
		h.holds.filter((hold) => "reserve" in hold),
		[],
		"no Intercom hold is parked for a completed child",
	);
});

test("pause of an SDK session's child that completes before the stop takes effect reports it completed (#3784)", async () => {
	const h = harness({ ownerless: true });
	h.completesWhenStopped = true;
	const launch = h.call({ agent: "worker", task: ORIGINAL_TASK, context: "fresh" });
	const deadline = Date.now() + RECORD_WAIT_MS;
	let running: SubagentChildRecord | undefined;
	while (!running?.childSessionId && Date.now() < deadline) {
		[running] = readSubagentChildRecords(h.sessionManager.getEntries()).values();
		await sleep(10);
	}
	assert.ok(running?.childSessionId, "the child started");

	const paused = await h.call({ action: "pause", id: running.childId });
	await launch;
	assert.equal(paused.isError, true, text(paused));
	assert.match(text(paused), /completed \(ok\) before it could be paused/);
	assert.equal(h.latest(running.childId)?.terminalStatus, "ok");
	assert.deepEqual(
		h.holds.filter((hold) => "reserve" in hold),
		[],
	);
});

test(
	"resume with a message continues a paused child in the same run identity and delivers the message once",
	async () => {
		const h = harness();
		const { record } = await h.launch("steer1");
		await h.call({ action: "pause", id: record.childId });
		await h.waitForLatest(record.childId, (candidate) => candidate.terminalStatus === "paused");

		const message = "Focus on the failing test first.";
		const resumed = await h.call({ action: "resume", id: "subagent-worker-steer1", message });
		assert.notEqual(resumed.isError, true, text(resumed));
		assert.equal(resumed.details.runControl?.message, message);
		assert.equal(resumed.details.runControl?.children[0]?.state, "running");
		assert.equal(resumed.details.runControl?.children[0]?.childId, "steer1:0");
		const newTaskId = resumedTaskId(resumed);
		assert.notEqual(newTaskId, record.taskId);
		await settled(h, newTaskId);

		const relaunch = h.runs.at(-1)!;
		assert.equal(relaunch.task, message);
		assert.equal(relaunch.options.runId, "steer1");
		assert.equal(relaunch.options.index, 0);
		assert.equal(relaunch.options.resumeSession, true);
		assert.equal(relaunch.options.resumeToolResults, undefined, "a child that waited on nothing continues no turn");
		assert.equal(relaunch.options.sessionManager?.getSessionId(), record.childSessionId);
		assert.equal(relaunch.options.intercomSessionName, "subagent-worker-steer1");
		assert.equal(relaunch.options.intercomGroup, "lane-group");
		assert.equal(
			relaunch.options.supervisorAuthorization?.capability,
			"fresh-capability-1",
			"resume takes over the hold pause placed, under its fresh capability",
		);
		assert.deepEqual(h.authorizations, ["subagent-worker-steer1"]);
		assert.equal(h.runs.filter((run) => run.task === message).length, 1);
		const final = await h.waitForLatest(
			record.childId,
			(candidate) => candidate.taskId === newTaskId && candidate.state === "terminal",
		);
		assert.equal(final.terminalStatus, "ok");
		assert.equal(final.childSessionId, record.childSessionId);
		assert.equal(relaunch.options.resumeFollowUps, undefined, "nothing is queued behind the steer");
		assert.deepEqual(
			relaunch.options.resumeNote,
			{ kind: "resume", text: SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT },
			"the paused turn continues with the steer, as its resume note says",
		);
		const childTranscript = transcript(final);
		assert.equal(occurrences(childTranscript, message), 1);
		assert.equal(occurrences(childTranscript, JSON.stringify(ORIGINAL_TASK)), 1);
		assert.equal(occurrences(childTranscript, SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT), 1);
	},
	LAUNCH_QUIT_RESUME_TIMEOUT_MS,
);

test(
	"quit stops a running child gracefully and resume without a message continues where it left off",
	async () => {
		const h = harness();
		const { record, taskId } = await h.launch("quit1");

		const quit = await h.call({ action: "quit", id: "quit1" });
		assert.notEqual(quit.isError, true, text(quit));
		assert.match(text(quit), /Quit worker .*stays resumable/);
		assert.equal(quit.details.runControl?.children[0]?.state, "quit");
		await settled(h, taskId);
		const stopped = await h.waitForLatest(record.childId, (candidate) => candidate.state === "terminal");
		assert.equal(stopped.terminalStatus, "quit");
		assert.deepEqual(h.holds, [], "quit holds nothing for the stopped child");

		const resumed = await h.call({ action: "resume", id: record.childId });
		assert.notEqual(resumed.isError, true, text(resumed));
		assert.equal(resumed.details.runControl?.message, undefined);
		const newTaskId = resumedTaskId(resumed);
		await settled(h, newTaskId);
		assert.deepEqual(h.runs.at(-1)?.options.resumeNote, {
			kind: "resume",
			text: SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT,
		});
		assert.equal(h.runs.at(-1)?.task, "", "no message from the user continues it");
		assert.equal(h.runs.at(-1)?.options.supervisorAuthorization?.capability, "fresh-capability-1");
		assert.deepEqual(
			h.startHolds,
			[{ reserve: "fresh-capability-1", holdMs: subagentStartHoldMs(undefined) }],
			"sends to the resumed child wait for it through its start",
		);
		const final = await h.waitForLatest(
			record.childId,
			(candidate) => candidate.taskId === newTaskId && candidate.state === "terminal",
		);
		assert.equal(occurrences(transcript(final), SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT), 1);
	},
	LAUNCH_QUIT_RESUME_TIMEOUT_MS,
);

test(
	"a paused child resumed without a message is told to redo or continue the step the pause interrupted (#3996)",
	async () => {
		const h = harness();
		const { record, taskId } = await h.launch("pausestep1");
		const paused = await h.call({ action: "pause", id: record.childId });
		assert.notEqual(paused.isError, true, text(paused));
		await settled(h, taskId);
		await h.waitForLatest(record.childId, (candidate) => candidate.state === "terminal");
		const resumed = await h.call({ action: "resume", id: record.childId });
		assert.notEqual(resumed.isError, true, text(resumed));
		await settled(h, resumedTaskId(resumed));
		assert.match(
			h.runs.at(-1)?.options.resumeNote?.text ?? "",
			/^Continue where you left off\. If a pause interrupted a command or step you were running, redo or continue that step as needed\./,
		);
	},
	LAUNCH_QUIT_RESUME_TIMEOUT_MS,
);

const QUIT_PARITY_RUN_ID = "quitparity1";

const QUIT_PARITY_CHILD_ID = `${QUIT_PARITY_RUN_ID}:0`;

const QUIT_PARITY_RESUME_CALL = `{ action: "resume", id: "${QUIT_PARITY_CHILD_ID}"`;

const PAUSED_AWAITING_RESUME = /paused · awaiting resume/;

const ENDED_FOR_GOOD_WORDING = /This execution has ended|Do not restart it|parent-handoff/;

test(
	"quit reports a child paused and awaiting resume with its resume call, and status keeps listing it so across a restart",
	async () => {
		const h = harness();
		const { record, taskId } = await h.launch(QUIT_PARITY_RUN_ID);

		const quit = await h.call({ action: "quit", id: QUIT_PARITY_CHILD_ID });
		assert.notEqual(quit.isError, true, text(quit));
		assert.match(text(quit), PAUSED_AWAITING_RESUME);
		assert.ok(text(quit).includes(QUIT_PARITY_RESUME_CALL), text(quit));
		const observed = await h.host.waitForTask(taskId);
		assert.ok(observed.ok && observed.value.kind === "settled");
		assert.deepEqual(observed.value.result.kind === "cancelled" ? observed.value.result.cause : "", "quit");
		await h.waitForLatest(record.childId, (candidate) => candidate.terminalStatus === "quit");

		const watched = h.host.watchOwnerTasks();
		assert.ok(watched.ok);
		const task = watched.value.snapshot.tasks.find((candidate) => candidate.ref.taskId === taskId);
		watched.value.dispose();
		assert.ok(task?.execution.kind === "settled");
		const notice = formatTaskCompletion(
			{
				completionId: "quit-parity",
				ownerId: task.ref.ownerId,
				taskId,
				terminalSequence: "1" as Sequence,
				result: task.execution.result,
				display: false,
			},
			task,
		);
		assert.match(notice, /^Subagent worker quit · paused, awaiting resume/);
		assert.ok(notice.includes(QUIT_PARITY_RESUME_CALL), notice);
		assert.doesNotMatch(notice, ENDED_FOR_GOOD_WORDING);

		const statusLists = async (when: string) => {
			for (const params of [
				{ action: "status", id: QUIT_PARITY_CHILD_ID },
				{ action: "status", id: taskId },
				{ action: "status" },
			] as const) {
				const status = await h.call(params);
				assert.notEqual(status.isError, true, `${when}: ${text(status)}`);
				assert.match(
					text(status),
					/worker \(quitparity1:0, subagent-worker-quitparity1\) quit · paused · awaiting resume/,
				);
				assert.ok(text(status).includes(QUIT_PARITY_RESUME_CALL), `${when}: ${text(status)}`);
				if (params.id !== taskId) assert.doesNotMatch(text(status), /cancelled|stopped/i);
			}
		};
		await statusLists("before the restart");
		const taskStatus = await h.call({ action: "status", id: taskId });
		assert.match(
			text(taskStatus),
			/^worker \(quitparity1:0, subagent-worker-quitparity1\) quit · paused · awaiting resume/,
		);
		assert.match(
			text(taskStatus),
			/Output of task-[\w-]+ \(paused · awaiting resume, \d+ bytes\):\nFull output: /,
			"status by task id keeps the child's retained output",
		);

		await h.closeOwnerAndReopen("session-close");
		const outcomes = await restoreSubagentChildren(h.deps, h.ctx);
		assert.deepEqual(outcomes, [], "a quit child is not relaunched at startup: it waits for resume");
		await statusLists("after the restart");
		const resumed = await h.call({ action: "resume", id: QUIT_PARITY_CHILD_ID });
		assert.notEqual(resumed.isError, true, text(resumed));
		await settled(h, resumedTaskId(resumed));
	},
	LAUNCH_QUIT_RESUME_TIMEOUT_MS,
);

test(
	"quitting an already-paused child keeps it resumable and resume then succeeds",
	async () => {
		const h = harness();
		const { record } = await h.launch("pq1");
		await h.call({ action: "pause", id: record.childId });
		await h.waitForLatest(record.childId, (candidate) => candidate.terminalStatus === "paused");

		const quit = await h.call({ action: "quit", id: record.childId });
		assert.notEqual(quit.isError, true, text(quit));
		assert.match(text(quit), /stays resumable/);
		assert.equal(quit.details.runControl?.children[0]?.state, "quit");
		assert.equal(h.latest(record.childId)?.terminalStatus, "quit");
		await sleep(0);
		assert.deepEqual(
			h.holds,
			[{ reserve: "fresh-capability-1", aliases: [record.childSessionId] }, { release: "fresh-capability-1" }],
			"quit ends the pause hold without calling the child gone",
		);

		const resumed = await h.call({ action: "resume", id: record.childId, message: "pick it back up" });
		assert.notEqual(resumed.isError, true, text(resumed));
		await settled(h, resumedTaskId(resumed));
		assert.equal(h.runs.at(-1)?.task, "pick it back up");
	},
	LAUNCH_QUIT_RESUME_TIMEOUT_MS,
);

test("pause and quit with all: true act on every running child this session launched", async () => {
	const h = harness();
	const first = await h.launch("all1");
	const second = await h.launch("all2");

	const paused = await h.call({ action: "pause", all: true });
	assert.notEqual(paused.isError, true, text(paused));
	assert.deepEqual(paused.details.runControl?.children.map((child) => child.childId).sort(), ["all1:0", "all2:0"]);
	await Promise.all([settled(h, first.taskId), settled(h, second.taskId)]);

	const quit = await h.call({ action: "quit", all: true });
	assert.notEqual(quit.isError, true, text(quit));
	assert.deepEqual(quit.details.runControl?.children.map((child) => [child.childId, child.state]).sort(), [
		["all1:0", "quit"],
		["all2:0", "quit"],
	]);
	assert.equal((await h.call({ action: "resume", all: true })).isError, true);
});

const LAUNCH_QUIT_TWO_RESUMES_TIMEOUT_MS = 4 * RECORD_WAIT_MS;

const LAUNCH_QUIT_THREE_RESUMES_TIMEOUT_MS = 5 * RECORD_WAIT_MS;

test(
	"resume continues completed and failed children in the same run identity",
	async () => {
		const h = harness();
		const { record, taskId } = await h.launch("done1");
		await h.call({ action: "quit", id: record.childId });
		await settled(h, taskId);

		const first = await h.call({ action: "resume", id: record.childId, message: "finish up" });
		await settled(h, resumedTaskId(first));
		const completed = await h.waitForLatest(record.childId, (candidate) => candidate.terminalStatus === "ok");

		assert.equal(h.runs.at(-1)?.options.resumeFollowUps, undefined);
		assert.equal(h.runs.at(-1)?.options.resumeNote?.text, SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT);

		h.settleAs = "error";
		const second = await h.call({ action: "resume", id: record.childId, message: "try the edge case" });
		assert.notEqual(second.isError, true, text(second));
		const failedTaskId = resumedTaskId(second);
		await settled(h, failedTaskId);
		const failed = await h.waitForLatest(
			record.childId,
			(candidate) => candidate.taskId === failedTaskId && candidate.state === "terminal",
		);
		assert.equal(failed.terminalStatus, "error");

		h.settleAs = "ok";
		const third = await h.call({ action: "resume", id: record.childId, message: "once more" });
		assert.notEqual(third.isError, true, text(third));
		await settled(h, resumedTaskId(third));
		for (const run of h.runs.slice(1)) {
			assert.equal(run.options.runId, "done1");
			assert.equal(run.options.index, 0);
			assert.equal(run.options.sessionManager?.getSessionId(), completed.childSessionId);
		}
		for (const run of h.runs.slice(2)) assert.equal(run.options.resumeFollowUps, undefined, run.task);
		const childTranscript = transcript(completed);
		for (const message of ["finish up", "try the edge case", "once more"])
			assert.equal(occurrences(childTranscript, message), 1);
		assert.equal(
			occurrences(childTranscript, SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT),
			1,
			"only the interrupted turn is continued; a settled child gets exactly one fresh prompt per message",
		);
	},
	LAUNCH_QUIT_THREE_RESUMES_TIMEOUT_MS,
);

test(
	"resume without a message continues a finished child with the continuation prompt",
	async () => {
		const h = harness();
		const { record, taskId } = await h.launch("idle1");
		await h.call({ action: "quit", id: record.childId });
		await settled(h, taskId);
		await settled(h, resumedTaskId(await h.call({ action: "resume", id: record.childId, message: "wrap up" })));
		await h.waitForLatest(record.childId, (candidate) => candidate.terminalStatus === "ok");

		const result = await h.call({ action: "resume", id: record.childId });
		assert.notEqual(result.isError, true, text(result));
		await settled(h, resumedTaskId(result));
		assert.equal(h.runs.at(-1)?.options.resumeNote?.text, SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT);
		assert.equal(h.runs.at(-1)?.task, "");
		assert.equal(h.runs.at(-1)?.options.resumeFollowUps, undefined);
		assert.equal(h.runs.at(-1)?.options.sessionManager?.getSessionId(), record.childSessionId);
	},
	LAUNCH_QUIT_TWO_RESUMES_TIMEOUT_MS,
);

test(`a quit child of a session Atomic exited or switched away from stays quit and resumable when it is reopened (#3760)`, async () => {
	const h = harness();
	const { record, taskId } = await h.launch(`quitkeep-session-close`);
	await h.call({ action: "quit", id: record.childId });
	await settled(h, taskId);
	await h.waitForLatest(record.childId, (candidate) => candidate.terminalStatus === "quit");
	await h.closeOwnerAndReopen("session-close");
	await sleep(50);
	assert.equal(h.latest(record.childId)?.terminalStatus, "quit");

	const resumed = await h.call({ action: "resume", id: record.childId });
	assert.notEqual(resumed.isError, true, text(resumed));
	await settled(h, resumedTaskId(resumed));
	assert.equal(h.runs.at(-1)?.options.sessionManager?.getSessionId(), record.childSessionId);
});

test("pause and quit right after resume stop the resumed child, not its previous record (#3760)", async () => {
	for (const [action, target] of [
		["pause", "id"],
		["pause", "all"],
		["quit", "id"],
		["quit", "all"],
	] as const) {
		const h = harness();
		const runId = `again-${action}-${target}`;
		const { record, taskId } = await h.launch(runId);
		await h.call({ action: "quit", id: record.childId });
		await settled(h, taskId);
		await h.waitForLatest(record.childId, (candidate) => candidate.terminalStatus === "quit");
		h.resumedRunsWait = true;
		const resumedTask = resumedTaskId(await h.call({ action: "resume", id: record.childId }));

		const stopped = await h.call(target === "id" ? { action, id: record.childId } : { action, all: true });
		assert.notEqual(stopped.isError, true, text(stopped));
		assert.match(text(stopped), action === "pause" ? /^Paused worker/ : /^Quit worker/);
		assert.deepEqual(
			stopped.details.runControl?.children.map((child) => [child.childId, child.taskId, child.state]),
			[[record.childId, resumedTask, action === "pause" ? "paused" : "quit"]],
		);
		const observed = await h.host.waitForTask(resumedTask as TaskId);
		assert.ok(observed.ok && observed.value.kind === "settled", `${action} ${target}: the resumed task stopped`);
		assert.equal(
			"cause" in observed.value.result ? observed.value.result.cause : "",
			action === "pause" ? "pause" : "quit",
		);
		const latest = await h.waitForLatest(
			record.childId,
			(candidate) => candidate.taskId === resumedTask && candidate.state === "terminal",
		);
		assert.equal(latest.terminalStatus, action === "pause" ? "paused" : "quit");
	}
});

test("pause and quit reach a parallel child still queued behind its concurrency limit; it never starts until resume starts it (#3760)", async () => {
	for (const [action, target] of [
		["pause", "all"],
		["quit", "all"],
		["pause", "id"],
	] as const) {
		const h = harness();
		const schedule = createExecutionScheduler(1);
		const runId = `queued-${action}-${target}`;
		const childId = `${runId}:0`;
		const runningTask = await h.admit(`${runId}-sibling`, schedule);
		const queuedTask = await h.admit(runId, schedule);
		await h.waitForLatest(`${runId}-sibling:0`, (candidate) => candidate.launchLeafId !== undefined);
		const startsOf = () => h.runs.filter((run) => run.options.runId === runId);
		assert.equal(startsOf().length, 0, "the child waits behind its sibling");
		const status = action === "pause" ? "paused" : "quit";

		const stopped = await h.call(target === "id" ? { action, id: childId } : { action, all: true });
		assert.notEqual(stopped.isError, true, `${action} ${target}: ${text(stopped)}`);
		assert.deepEqual(
			stopped.details.runControl?.children
				.filter((child) => child.childId === childId)
				.map((child) => [child.taskId, child.state]),
			[[queuedTask, status]],
			`${action} ${target} reaches the queued child`,
		);
		assert.equal(h.latest(childId)?.state, "terminal");
		assert.equal(h.latest(childId)?.terminalStatus, status);

		if (target === "id") await h.call({ action: "quit", id: `${runId}-sibling:0` });
		await settled(h, runningTask);
		await sleep(50);
		assert.equal(startsOf().length, 0, `${action} ${target}: the child did not start once its slot freed`);
		assert.equal(h.latest(childId)?.terminalStatus, status);

		const resumed = await h.call({ action: "resume", id: childId });
		assert.notEqual(resumed.isError, true, `${action} ${target}: ${text(resumed)}`);
		const resumedTask = resumedTaskId(resumed);
		assert.notEqual(resumedTask, queuedTask);
		const started = await h.waitForLatest(
			childId,
			(candidate) => candidate.taskId === resumedTask && candidate.childSessionId !== undefined,
		);
		assert.equal(started.state, "running");
		assert.deepEqual(
			startsOf().map((run) => run.task),
			[ORIGINAL_TASK],
			"resume starts the child on its original task",
		);
	}
});

test(`children of a session Atomic exited or switched away from stay running and are restored when it is reopened (#3760)`, async () => {
	const h = harness();
	const { record } = await h.launch(`keep-session-close`);
	await h.closeOwnerAndReopen("session-close");
	await sleep(50);
	assert.equal(h.latest(record.childId)?.state, "running", "closing the owner records nothing terminal");

	const [outcome] = await restoreSubagentChildren(h.deps, h.ctx);
	assert.equal(outcome?.kind, "restored", JSON.stringify(outcome));
	assert.ok(outcome?.kind === "restored");
	await settled(h, outcome.taskId);
	assert.equal(h.runs.at(-1)?.options.runId, `keep-session-close`);
	assert.equal(h.runs.at(-1)?.options.sessionManager?.getSessionId(), record.childSessionId);
});

test(`a child of a session Atomic exited or switched away from keeps its queued messages, and reopening delivers them once, in order (#3784)`, async () => {
	const h = harness();
	const live = Promise.withResolvers<TestSessionQueue>();
	h.onSession = (session) => live.resolve(session);
	const { record } = await h.launch(`held-session-close`);
	h.onSession = undefined;
	const session = await live.promise;
	const steer = "STEER: report the permission error only";
	const followUp = "FOLLOWUP: include the failing command";
	await session.steer(steer);
	await session.followUp(followUp);

	await h.closeOwnerAndReopen("session-close");
	const kept = await h.waitForLatest(record.childId, (candidate) => candidate.heldMessages !== undefined);
	assert.equal(kept.state, "running", "closing its owner records nothing terminal");
	assert.deepEqual(kept.heldMessages?.messages, [steer, followUp], "it keeps what it had queued and not read");

	const [outcome] = await restoreSubagentChildren(h.deps, h.ctx);
	assert.equal(outcome?.kind, "restored", JSON.stringify(outcome));
	assert.ok(outcome?.kind === "restored");
	await settled(h, outcome.taskId);
	const finished = await h.waitForLatest(
		record.childId,
		(candidate) => candidate.taskId === outcome.taskId && candidate.state === "terminal",
	);
	assert.equal(finished.terminalStatus, "ok", "the reopened owner restores it");
	const delivered = transcript(finished);
	assert.equal(occurrences(delivered, steer), 1, "the held steer is delivered exactly once");
	assert.equal(occurrences(delivered, followUp), 1, "the held follow-up is delivered exactly once");
	assert.ok(delivered.indexOf(steer) < delivered.indexOf(followUp), "in the order it queued them");

	const again = resumedTaskId(await h.call({ action: "resume", id: record.childId }));
	await settled(h, again);
	const after = transcript(
		await h.waitForLatest(
			record.childId,
			(candidate) => candidate.taskId === again && candidate.state === "terminal",
		),
	);
	assert.equal(occurrences(after, steer), 1, "a later resume does not deliver the steer again");
	assert.equal(occurrences(after, followUp), 1, "a later resume does not deliver the follow-up again");
});

test("resume refuses a child that is still running", async () => {
	const h = harness();
	const { record } = await h.launch("live1");
	const result = await h.call({ action: "resume", id: record.childId });
	assert.equal(result.isError, true);
	assert.match(text(result), /already running/);
});

test("two resumes of one paused child at once: one resumes it, the other is refused while that run goes on, never queued behind it (#5485)", async () => {
	const h = harness();
	const { record } = await h.launch("double1");
	await h.call({ action: "pause", id: record.childId });
	await h.waitForLatest(record.childId, (latest) => latest.state === "terminal" && latest.terminalStatus === "paused");
	h.resumedRunsWait = true;
	const answers = await Promise.all([
		answeredWithin(h.call({ action: "resume", id: record.childId, message: "first note" })),
		answeredWithin(h.call({ action: "resume", id: record.childId, message: "second note" })),
	]);
	assert.ok(
		answers.every((answer) => answer !== undefined),
		"both resumes answer while the resumed run goes on",
	);
	const refused = answers.filter((answer) => answer?.isError === true);
	assert.equal(refused.length, 1, answers.map((answer) => (answer ? text(answer) : "none")).join("\n"));
	const refusedMessage = text(refused[0]!);
	const refusedTaskId = extractRunningTaskId(refusedMessage);
	assert.ok(
		refusedTaskId !== undefined &&
			refusedMessage.includes(`already running as task ${refusedTaskId}; pause or quit it first`),
		refusedMessage,
	);
	assert.equal(
		h.runs.filter((run) => readsOf(run).includes("first note") || readsOf(run).includes("second note")).length,
		1,
		"one resumed run",
	);
});

test("resume reports an unknown child id as an error", async () => {
	const h = harness();
	const result = await h.call({ action: "resume", id: "no-such-child" });
	assert.equal(result.isError, true);
	assert.match(text(result), /Unknown subagent 'no-such-child'/);
	assert.equal(h.runs.length, 0);
});

/** A child of `h` that ran and completed on its own: quit, then resumed with a message it finishes. */
async function completedChild(h: Harness, runId: string): Promise<SubagentChildRecord> {
	const { record, taskId } = await h.launch(runId);
	await h.call({ action: "quit", id: record.childId });
	await settled(h, taskId);
	await settled(h, resumedTaskId(await h.call({ action: "resume", id: record.childId, message: "wrap up" })));
	return h.waitForLatest(record.childId, (candidate) => candidate.terminalStatus === "ok");
}

/** Answer each peer resume `h` asks Intercom for with `outcome`, recording the requests. */
function answerPeerResumes(h: Harness, outcome: PeerResumeOutcome): PeerResumeRequest[] {
	const requests: PeerResumeRequest[] = [];
	const events = h.deps.pi.events as { emit: (channel: string, data: object) => void };
	const emit = events.emit.bind(events);
	events.emit = (channel, data) => {
		if (channel === SUBAGENT_PEER_RESUME_EVENT) {
			const request = data as PeerResumeRequest;
			requests.push(request);
			request.completion = Promise.resolve(outcome);
			return;
		}
		emit(channel, data);
	};
	return requests;
}

test(
	"a message from another agent resumes a completed child as its owner's resume does, naming the sender (#5999)",
	async () => {
		const h = harness();
		const completed = await completedChild(h, "wake1");
		const runsBefore = h.runs.length;
		const answers: unknown[][] = [];
		const result = await wakeSubagentChildForMessage(
			h.deps,
			h.ctx,
			completed.childId,
			"subagent-sibling",
			(...args) => answers.push(args.filter((arg) => arg !== undefined)),
		);
		assert.deepEqual(answers, [[true]]);
		assert.ok(result !== undefined && result.isError !== true, result && text(result));
		await settled(h, resumedTaskId(result));
		assert.equal(h.runs.length, runsBefore + 1, "one resumed run");
		const run = h.runs.at(-1)!;
		assert.equal(run.task, subagentMessageWakePrompt("subagent-sibling"));
		assert.match(run.task, /^You were resumed because subagent-sibling sent you an Intercom message/);
		assert.equal(run.options.runId, "wake1", "it resumes as the same child, under the session that launched it");
		assert.equal(run.options.sessionManager?.getSessionId(), completed.childSessionId);
	},
	LAUNCH_QUIT_TWO_RESUMES_TIMEOUT_MS,
);

test("a message does not resume a child cancelled for good, nor run a running one again (#5999)", async () => {
	const h = harness();
	const { record, taskId } = await h.launch("wakekilled1");
	const live: unknown[][] = [];
	await wakeSubagentChildForMessage(h.deps, h.ctx, record.childId, "peer", (...args) =>
		live.push(args.filter((arg) => arg !== undefined)),
	);
	assert.deepEqual(live, [[true]], "a running child takes the message when it registers; nothing else runs");
	assert.equal(h.runs.length, 1);

	assert.ok((await h.host.cancelTask(taskId, "user")).ok);
	await settled(h, taskId);
	await h.waitForLatest(record.childId, (candidate) => candidate.terminalStatus === "killed");
	const killed: unknown[][] = [];
	await wakeSubagentChildForMessage(h.deps, h.ctx, record.childId, "peer", (...args) =>
		killed.push(args.filter((arg) => arg !== undefined)),
	);
	assert.deepEqual(killed, [
		[
			false,
			"it cannot be resumed: it was cancelled for good (an owner or batch cancellation, or the removed kill action)",
		],
	]);
	assert.equal(h.runs.length, 1, "nothing was resumed");
});

test("resume of a subagent another session launched is a message to it that asks to wake it (#5999)", async () => {
	const h = harness();
	const requests = answerPeerResumes(h, { kind: "resuming" });
	const resumed = await h.call({ action: "resume", id: "subagent-worker-sibling-1", message: "check the edge case" });
	assert.notEqual(resumed.isError, true, text(resumed));
	assert.match(
		text(resumed),
		/^subagent-worker-sibling-1 had finished, so it is being resumed by the session that launched it/,
	);
	assert.deepEqual(
		requests.map(({ to, message }) => ({ to, message })),
		[{ to: "subagent-worker-sibling-1", message: "check the edge case" }],
	);
	assert.equal(h.runs.length, 0, "this session runs nothing: the session that launched it does");
});

test("resume of another session's subagent keeps resume's refusals for an unknown or a running one (#5999)", async () => {
	const unknown = harness();
	answerPeerResumes(unknown, { kind: "unknown" });
	const notFound = await unknown.call({ action: "resume", id: "no-such-child" });
	assert.equal(notFound.isError, true);
	assert.equal(text(notFound), "Unknown subagent 'no-such-child': this session launched no such child.");

	const running = harness();
	answerPeerResumes(running, { kind: "running", name: "subagent-worker-busy-1" });
	const refused = await running.call({ action: "resume", id: "subagent-worker-busy-1" });
	assert.equal(refused.isError, true);
	assert.equal(
		text(refused),
		"subagent-worker-busy-1 is running, so there is nothing to resume; send it a message with the intercom tool instead.",
	);

	const paused = harness();
	answerPeerResumes(paused, { kind: "paused" });
	const kept = await paused.call({ action: "resume", id: "subagent-worker-paused-1", message: "when you are back" });
	assert.notEqual(kept.isError, true);
	assert.match(
		text(kept),
		/was paused or quit by the session that launched it, so it is not resumed for your message/,
	);
});

test("status lists only the children this session launched, by ids quit takes, and quit stops each one it lists", async () => {
	const own = harness();
	// Another session in the same process, with a child of its own.
	const other = harness();
	await other.launch("foreignstatus1");
	const { record } = await own.launch("ownstatus1");

	const listed = text(await own.call({ action: "status" }));
	assert.doesNotMatch(listed, /foreignstatus1/, "a child another session launched is not this session's to control");
	const line = listed.split("\n").find((candidate) => candidate.includes("worker_1"));
	assert.match(line ?? "", /^ownstatus1\/worker_1 — running \(loaded\) · id ownstatus1:0$/, listed);

	const byChildId = await own.call({ action: "status", id: record.childId });
	assert.notEqual(byChildId.isError, true, text(byChildId));
	assert.match(text(byChildId), /Status: running/);

	const quitByPath = await own.call({ action: "quit", id: "ownstatus1/worker_1" });
	assert.notEqual(quitByPath.isError, true, text(quitByPath));
	assert.match(text(quitByPath), /Quit worker \(ownstatus1:0/);
	const quitForeign = await own.call({ action: "quit", id: "foreignstatus1/worker_1" });
	assert.equal(quitForeign.isError, true);
	assert.match(text(quitForeign), /this session launched no such child/);
});

test("resume refuses a child cancelled for good by its owner", async () => {
	const h = harness();
	const { record, taskId } = await h.launch("cancel1");
	assert.ok((await h.host.cancelTask(taskId, "user")).ok);
	await settled(h, taskId);
	await h.waitForLatest(record.childId, (candidate) => candidate.terminalStatus === "killed");

	const result = await h.call({ action: "resume", id: record.childId });
	assert.equal(result.isError, true);
	assert.match(text(result), /is terminal and cannot be resumed: it was cancelled for good/);
	assert.equal(h.runs.length, 1);
});

for (const [status, reason] of [
	["killed", /cancelled for good/],
	["gone", /did not survive a restart and was reported gone/],
] as const) {
	test(`resume refuses a pre-existing ${status} record as terminal (#3760)`, async () => {
		const h = harness();
		const record: SubagentChildRecord = {
			version: 1,
			childId: `old-${status}:0`,
			runId: `old-${status}`,
			index: 0,
			agent: "worker",
			state: "terminal",
			cwd: h.cwd,
			owner: { kind: "session", sessionId: h.sessionManager.getSessionId() },
			taskId: "task-old",
			terminalStatus: status,
		};
		await h.sessionManager.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, record);

		const result = await h.call({ action: "resume", id: record.childId });
		assert.equal(result.isError, true);
		assert.match(text(result), /is terminal and cannot be resumed/);
		assert.match(text(result), reason);
		assert.deepEqual(result.details.runControl, { action: "resume", children: [] });
		assert.equal(h.runs.length, 0);
	});
}

test("a resumed queued child waits for its run's concurrency slot, as its original launch did (#3760 run control)", async () => {
	const h = harness();
	const schedule = createExecutionScheduler(1);
	const runningTask = await h.admit("slot-a", schedule);
	await h.admit("slot-b", schedule);
	await h.waitForLatest("slot-a:0", (candidate) => candidate.launchLeafId !== undefined);
	const startsOfB = () => h.runs.filter((run) => run.options.runId === "slot-b");

	const paused = await h.call({ action: "pause", id: "slot-b:0" });
	assert.notEqual(paused.isError, true, text(paused));
	const resumed = await h.call({ action: "resume", id: "slot-b:0" });
	assert.notEqual(resumed.isError, true, text(resumed));
	await sleep(100);
	assert.deepEqual(startsOfB(), [], "the resumed child waits while its sibling holds the only slot");

	await h.call({ action: "quit", id: "slot-a:0" });
	await settled(h, runningTask);
	const resumedTask = resumedTaskId(resumed);
	await h.waitForLatest("slot-b:0", (candidate) => candidate.taskId === resumedTask && !!candidate.childSessionId);
	assert.equal(startsOfB().length, 1, "it starts once its sibling releases the slot");
});

for (const action of ["pause", "quit"] as const) {
	test(`a queued child ${action === "pause" ? "paused" : "quit"} before it started is started fresh by resume after a restart, under the same identity (#3784)`, async () => {
		const h = harness();
		const schedule = createExecutionScheduler(1);
		const runId = `fresh-${action}`;
		const childId = `${runId}:0`;
		const runningTask = await h.admit(`${runId}-sibling`, schedule);
		const queuedTask = await h.admit(runId, schedule, { skills: ["review"], outputMode: "inline" });
		await h.waitForLatest(`${runId}-sibling:0`, (candidate) => candidate.launchLeafId !== undefined);
		const stopped = await h.call({ action, id: childId });
		assert.notEqual(stopped.isError, true, text(stopped));
		await h.call({ action: "quit", id: `${runId}-sibling:0` });
		await settled(h, runningTask);
		const record = h.latest(childId);
		assert.equal(record?.childSessionId, undefined, "the child never started");
		assert.doesNotMatch(JSON.stringify(record), /capability/, "no supervisor capability is persisted");
		// Atomic restarts: nothing of the launch is left in this process but the child's records.
		assert.ok(takeStoppedQueuedSubagentChild(queuedTask));

		const resumed = await h.call({ action: "resume", id: childId, message: "also check the docs" });
		assert.notEqual(resumed.isError, true, text(resumed));
		const resumedTask = resumedTaskId(resumed);
		const started = await h.waitForLatest(
			childId,
			(candidate) => candidate.taskId === resumedTask && candidate.childSessionId !== undefined,
		);
		assert.equal(started.intercomTarget, `subagent-worker-${runId}`);
		assert.equal(started.intercomGroup, "lane-group");
		const starts = h.runs.filter((run) => run.options.runId === runId);
		assert.deepEqual(
			starts.map((run) => run.task),
			[`${ORIGINAL_TASK}\n\nalso check the docs`],
			"it starts on its original task, with the message after it",
		);
		const [start] = starts;
		assert.equal(start?.options.index, 0);
		assert.equal(start?.options.resumeSession, undefined, "it is a new launch, not a reopened session");
		assert.equal(start?.options.sessionDir, join(h.cwd, "children", runId));
		assert.deepEqual(start?.options.skills, ["review"]);
		assert.equal(start?.options.intercomSessionName, `subagent-worker-${runId}`);
		assert.ok(start?.options.supervisorAuthorization, "it gets fresh supervisor authorization");
		await settled(h, resumedTask);
	});
}

test("a child still queued when Atomic exited is started fresh when its session reopens (#3784)", async () => {
	const h = harness();
	const schedule = createExecutionScheduler(1);
	await h.admit("fresh-exit-sibling", schedule);
	const queuedTask = await h.admit("fresh-exit", schedule);
	await h.waitForLatest("fresh-exit-sibling:0", (candidate) => candidate.launchLeafId !== undefined);
	await h.closeOwnerAndReopen("session-close");
	await sleep(50);
	assert.equal(h.latest("fresh-exit:0")?.state, "running", "closing its owner records nothing terminal");
	assert.ok(takeStoppedQueuedSubagentChild(queuedTask));

	const outcomes = await restoreSubagentChildren(h.deps, h.ctx);
	const outcome = outcomes.find(
		(candidate) => candidate.kind === "restored" && candidate.record.runId === "fresh-exit",
	);
	assert.ok(outcome?.kind === "restored", JSON.stringify(outcomes));
	await h.waitForLatest(
		"fresh-exit:0",
		(candidate) => candidate.taskId === outcome.taskId && !!candidate.childSessionId,
	);
	assert.deepEqual(
		h.runs.filter((run) => run.options.runId === "fresh-exit").map((run) => run.task),
		[ORIGINAL_TASK],
	);
});

test("a queued child of an SDK session without a task host paused before it started is started fresh by resume after a restart (#3784)", async () => {
	const h = harness({ ownerless: true });
	const siblingDone = Promise.withResolvers<void>();
	h.finishOn.set("fresh-a-marker", siblingDone);
	h.finishOn.set("fresh-b-marker", Promise.withResolvers<void>());
	cleanups.push(async () => siblingDone.resolve());
	const launched = h.call({
		tasks: [
			{ agent: "worker", task: "fresh-a-marker" },
			{ agent: "worker", task: "fresh-b-marker" },
		],
		concurrency: 1,
	});
	const children = () =>
		[...readSubagentChildRecords(h.sessionManager.getEntries()).values()].sort(
			(left, right) => left.index - right.index,
		);
	const deadline = Date.now() + RECORD_WAIT_MS;
	while (children().length < 2 && Date.now() < deadline) await sleep(10);
	const [childA, childB] = children();
	assert.ok(childA && childB?.taskId);
	await h.waitForLatest(childA.childId, (candidate) => !!candidate.childSessionId);
	const paused = await h.call({ action: "pause", id: childB.childId });
	assert.notEqual(paused.isError, true, text(paused));
	siblingDone.resolve();
	await launched;
	assert.ok(takeStoppedQueuedOwnerlessChild(childB.taskId), "Atomic restarts and forgets the queued launch");
	h.finishOn.clear();

	const resumed = await h.call({ action: "resume", id: childB.childId, message: "also check the docs" });
	assert.notEqual(resumed.isError, true, text(resumed));
	const resumedTask = resumedTaskId(resumed);
	const finished = await h.waitForLatest(
		childB.childId,
		(candidate) => candidate.taskId === resumedTask && candidate.state === "terminal",
	);
	assert.equal(finished.terminalStatus, "ok");
	const starts = h.runs.filter((run) => run.options.runId === childB.runId && run.options.index === childB.index);
	assert.equal(starts.length, 1);
	assert.match(starts[0]!.task, /fresh-b-marker[\s\S]*\n\nalso check the docs$/);
	assert.equal(starts[0]!.options.resumeSession, undefined);
});

/** Give the owner a conversation and branch a forked child's session from it, as a `context: "fork"` launch does. */
async function forkFromParentConversation(h: Harness): Promise<SessionManager> {
	await h.sessionManager.appendMessage({ role: "user", content: "parent-only context", timestamp: Date.now() });
	const forked = await createForkContextResolver(h.sessionManager, "fork").sessionManagerForIndex(0);
	assert.ok(forked);
	return forked;
}

test("a forked queued child paused before it started is resumed after a restart on its parent's conversation (#3784)", async () => {
	const h = harness();
	const schedule = createExecutionScheduler(1);
	const runId = "fresh-fork";
	const childId = `${runId}:0`;
	const runningTask = await h.admit(`${runId}-sibling`, schedule);
	const forked = await forkFromParentConversation(h);
	const queuedTask = await h.admit(runId, schedule, { sessionManager: forked });
	await h.waitForLatest(`${runId}-sibling:0`, (candidate) => candidate.launchLeafId !== undefined);
	const paused = await h.call({ action: "pause", id: childId });
	assert.notEqual(paused.isError, true, text(paused));
	await h.call({ action: "quit", id: `${runId}-sibling:0` });
	await settled(h, runningTask);
	assert.ok(takeStoppedQueuedSubagentChild(queuedTask), "Atomic restarts and forgets the queued launch");

	const resumed = await h.call({ action: "resume", id: childId });
	assert.notEqual(resumed.isError, true, text(resumed));
	const resumedTask = resumedTaskId(resumed);
	const started = await h.waitForLatest(
		childId,
		(candidate) => candidate.taskId === resumedTask && candidate.childSessionId !== undefined,
	);
	assert.equal(started.childSessionId, forked.getSessionId(), "it starts on the branch its launch prepared");
	const [start] = h.runs.filter((run) => run.options.runId === runId);
	assert.equal(start?.task, ORIGINAL_TASK);
	assert.equal(start?.options.resumeSession, undefined, "it is a new launch on the branch, not a resumed session");
	const child = await SessionManager.open(h.sessionManager.getSessionStore(), forked.getSessionId(), h.cwd);
	assert.match(JSON.stringify(child.buildSessionContext().messages), /parent-only context/);
	// It runs its original task, which the harness holds until it is stopped.
	await h.call({ action: "quit", id: childId });
	await settled(h, resumedTask);
});

test("a forked queued child of an SDK session paused before it started is resumed after a restart on its parent's conversation (#3784)", async () => {
	const h = harness({ ownerless: true });
	await h.sessionManager.appendMessage({ role: "user", content: "parent-only context", timestamp: Date.now() });
	const siblingDone = Promise.withResolvers<void>();
	h.finishOn.set("fork-a-marker", siblingDone);
	h.finishOn.set("fork-b-marker", Promise.withResolvers<void>());
	cleanups.push(async () => siblingDone.resolve());
	const launched = h.call({
		tasks: [
			{ agent: "worker", task: "fork-a-marker" },
			{ agent: "worker", task: "fork-b-marker" },
		],
		concurrency: 1,
		context: "fork",
	});
	const children = () =>
		[...readSubagentChildRecords(h.sessionManager.getEntries()).values()].sort(
			(left, right) => left.index - right.index,
		);
	const deadline = Date.now() + RECORD_WAIT_MS;
	while (children().length < 2 && Date.now() < deadline) await sleep(10);
	const [childA, childB] = children();
	assert.ok(childA && childB?.taskId);
	await h.waitForLatest(childA.childId, (candidate) => !!candidate.childSessionId);
	const paused = await h.call({ action: "pause", id: childB.childId });
	assert.notEqual(paused.isError, true, text(paused));
	siblingDone.resolve();
	await launched;
	assert.ok(takeStoppedQueuedOwnerlessChild(childB.taskId), "Atomic restarts and forgets the queued launch");
	h.finishOn.clear();

	const resumed = await h.call({ action: "resume", id: childB.childId });
	assert.notEqual(resumed.isError, true, text(resumed));
	const resumedTask = resumedTaskId(resumed);
	const finished = await h.waitForLatest(
		childB.childId,
		(candidate) => candidate.taskId === resumedTask && candidate.state === "terminal",
	);
	assert.equal(finished.terminalStatus, "ok");
	assert.ok(finished.childSessionId);
	const child = await SessionManager.open(h.sessionManager.getSessionStore(), finished.childSessionId, h.cwd);
	assert.match(JSON.stringify(child.buildSessionContext().messages), /parent-only context/);
});

test("a forked queued child whose prepared branch is gone after a restart fails to resume, never starting on a fresh context (#3784)", async () => {
	const h = harness();
	const schedule = createExecutionScheduler(1);
	const runId = "fresh-fork-lost";
	const childId = `${runId}:0`;
	const runningTask = await h.admit(`${runId}-sibling`, schedule);
	const forked = await forkFromParentConversation(h);
	const queuedTask = await h.admit(runId, schedule, { sessionManager: forked });
	await h.waitForLatest(`${runId}-sibling:0`, (candidate) => candidate.launchLeafId !== undefined);
	const paused = await h.call({ action: "pause", id: childId });
	assert.notEqual(paused.isError, true, text(paused));
	await h.call({ action: "quit", id: `${runId}-sibling:0` });
	await settled(h, runningTask);
	assert.ok(takeStoppedQueuedSubagentChild(queuedTask), "Atomic restarts and forgets the queued launch");
	await h.sessionManager.getSessionStore().delete(forked.getSessionId());

	const resumed = await h.call({ action: "resume", id: childId });
	assert.equal(resumed.isError, true, text(resumed));
	assert.match(text(resumed), /could not be resumed: .*forked from its parent's conversation/);
	assert.deepEqual(
		h.runs.filter((run) => run.options.runId === runId),
		[],
		"it never starts without the context it was launched with",
	);
});

/** Launch a child that starts, then close its owner as Atomic exiting does and restore it as reopening the session does. */
async function restoreStartedChild(
	h: Harness,
	runId: string,
	options: Partial<RunSyncOptions>,
	launchAgent?: AgentConfig,
	beforeRestore?: () => void | Promise<void>,
): Promise<{ task: string; options: RunSyncOptions; agent: AgentConfig | undefined; taskId: string }> {
	await h.admit(runId, undefined, options, launchAgent);
	const record = await h.waitForLatest(`${runId}:0`, (candidate) => candidate.launchLeafId !== undefined);
	await h.closeOwnerAndReopen("session-close");
	await sleep(50);
	assert.equal(h.latest(record.childId)?.state, "running", "closing its owner records nothing terminal");
	await beforeRestore?.();
	const [outcome] = await restoreSubagentChildren(h.deps, h.ctx);
	assert.ok(outcome?.kind === "restored", JSON.stringify(outcome));
	const restarted = h.runs.at(-1);
	assert.ok(restarted);
	assert.equal(restarted.options.sessionManager?.getSessionId(), record.childSessionId, "it reopens its own session");
	assert.equal(restarted.options.resumeSession, true);
	await settled(h, outcome.taskId);
	return { ...restarted, taskId: outcome.taskId };
}

/** Pause a child still queued behind a sibling, forget it as a restart does, and resume it from its records. */
async function resumeQueuedChildAfterRestart(
	h: Harness,
	runId: string,
	options: Partial<RunSyncOptions>,
	launchAgent?: AgentConfig,
	beforeResume?: () => void,
): Promise<{ task: string; options: RunSyncOptions; agent: AgentConfig | undefined; taskId: string }> {
	const schedule = createExecutionScheduler(1);
	const childId = `${runId}:0`;
	const runningTask = await h.admit(`${runId}-sibling`, schedule);
	const queuedTask = await h.admit(runId, schedule, options, launchAgent);
	await h.waitForLatest(`${runId}-sibling:0`, (candidate) => candidate.launchLeafId !== undefined);
	const paused = await h.call({ action: "pause", id: childId });
	assert.notEqual(paused.isError, true, text(paused));
	await h.call({ action: "quit", id: `${runId}-sibling:0` });
	await settled(h, runningTask);
	assert.ok(takeStoppedQueuedSubagentChild(queuedTask), "Atomic restarts and forgets the queued launch");
	beforeResume?.();
	const resumed = await h.call({ action: "resume", id: childId });
	assert.notEqual(resumed.isError, true, text(resumed));
	const resumedTask = resumedTaskId(resumed);
	await h.waitForLatest(childId, (candidate) => candidate.taskId === resumedTask && !!candidate.childSessionId);
	const [start] = h.runs.filter((run) => run.options.runId === runId);
	assert.ok(start);
	assert.equal(start.options.resumeSession, undefined, "it is a new launch");
	// It runs its original task, which the harness holds until it is stopped.
	await h.call({ action: "quit", id: childId });
	await settled(h, resumedTask);
	return { ...start, taskId: resumedTask };
}

test("a relaunched child names its owner's live Intercom id and holds sends for its start (#5341)", async () => {
	const h = harness();
	h.deps.config.sessionStartTimeoutMs = 60_000;
	const holdsAtRetry: number[] = [];
	const restarted = await restoreStartedChild(h, "restored-supervisor", {}, undefined, async () => {
		h.deps.state!.ownIntercomSession = {
			sessionId: h.sessionManager.getSessionId(),
			intercomSessionId: "restored-owner-intercom-id",
		};
		await holdRunningSubagentChildren(h.deps.pi.events, h.ctx);
		const runtime = h.deps.runtime!;
		const runSync = runtime.runSync!;
		runtime.runSync = async (...args) => {
			holdsAtRetry.push(h.startHolds.length);
			await args[4].onStartRetry?.();
			holdsAtRetry.push(h.startHolds.length);
			return runSync(...args);
		};
	});
	assert.deepEqual(holdsAtRetry, [1, 2], "retrying the relaunch renews its starting hold before the next start");
	assert.equal(restarted.options.orchestratorIntercomTarget, "restored-owner-intercom-id");
	assert.match(restarted.agent?.systemPrompt ?? "", /restored-owner-intercom-id/);
	assert.deepEqual(
		h.startHolds,
		Array.from({ length: 2 }, () => ({
			reserve: restarted.options.supervisorAuthorization!.capability,
			holdMs: subagentStartHoldMs(60_000),
		})),
	);
});

test("a started child of a user agent a project agent of the same name shadows is restored with the user agent (#3784)", async () => {
	const h = harness();
	h.agents = [userAgent, agent];
	const restarted = await restoreStartedChild(h, "started-user-agent", {}, userAgent);
	assert.equal(restarted.agent?.source, "user");
	assert.match(restarted.agent?.systemPrompt ?? "", /^Work as the user/);
});

test("a never-started queued child of a user agent a project agent of the same name shadows starts with the user agent (#3784)", async () => {
	const h = harness();
	h.agents = [userAgent, agent];
	const start = await resumeQueuedChildAfterRestart(h, "queued-user-agent", {}, userAgent);
	assert.equal(start.agent?.source, "user");
	assert.match(start.agent?.systemPrompt ?? "", /^Work as the user/);
});

test("a forked started child restored under the fork-only Intercom bridge keeps its bridge instructions (#3784)", async () => {
	const h = harness();
	h.deps.config.intercomBridge = { mode: "fork-only" };
	const forked = await forkFromParentConversation(h);
	const restarted = await restoreStartedChild(h, "started-fork-bridge", { sessionManager: forked });
	assert.ok(restarted.agent?.systemPrompt?.includes(INTERCOM_BRIDGE_MARKER), restarted.agent?.systemPrompt);
	assert.ok(restarted.options.orchestratorIntercomTarget, "it is told its orchestrator's Intercom target");
});

test("a forked never-started queued child started under the fork-only Intercom bridge gets its bridge instructions (#3784)", async () => {
	const h = harness();
	h.deps.config.intercomBridge = { mode: "fork-only" };
	const forked = await forkFromParentConversation(h);
	const start = await resumeQueuedChildAfterRestart(h, "queued-fork-bridge", { sessionManager: forked });
	assert.ok(start.agent?.systemPrompt?.includes(INTERCOM_BRIDGE_MARKER), start.agent?.systemPrompt);
	assert.ok(start.options.orchestratorIntercomTarget, "it is told its orchestrator's Intercom target");
});

const sonnet = { provider: "anthropic", id: "claude-sonnet", reasoning: true };

const haiku = { provider: "anthropic", id: "claude-haiku", reasoning: true };

/** The owner's model registry with these models usable, as the reopened session finds them. */
function usableModels(h: Harness, models: ReadonlyArray<{ provider: string; id: string; reasoning: boolean }>): void {
	Object.assign(h.ctx, {
		modelRegistry: {
			getAvailable: () => [...models],
			getAll: () => [...models],
			find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
			hasConfiguredAuth: () => true,
		},
	});
}

/** The owner switches to another model and thinking level, as `/model` and the thinking toggle do. */
function ownerSwitchesTo(h: Harness, model: { provider: string; id: string }, thinkingLevel: string): void {
	Object.assign(h.ctx, { model, thinkingLevel });
}

/** What the child's launch with this task id started on, as its own record says. */
function startedOn(h: Harness, childId: string, taskId: string): { model?: string; thinking?: string } {
	const started = h.sessionManager
		.getEntries()
		.filter(isSubagentChildRecord)
		.map((entry) => entry.data as SubagentChildRecord)
		.findLast(
			(record) => record.childId === childId && record.taskId === taskId && record.launchLeafId !== undefined,
		);
	assert.ok(started, `the launch of ${childId} as ${taskId} never recorded what it started on`);
	return {
		...(started.launchModel ? { model: started.launchModel } : {}),
		...(started.launchThinkingLevel ? { thinking: started.launchThinkingLevel } : {}),
	};
}

/** What the parent was on when it admitted the child; a child that pins no model of its own inherits both. */
const admittedOnSonnetHigh: Partial<RunSyncOptions> = {
	currentModel: "anthropic/claude-sonnet",
	currentThinkingLevel: "high",
	preferredModelProvider: "anthropic",
};

test("a never-started queued child starts after a restart on the model and thinking level its parent had when it was admitted (#3784)", async () => {
	const h = harness();
	usableModels(h, [sonnet, haiku]);
	const start = await resumeQueuedChildAfterRestart(h, "queued-inherited-model", admittedOnSonnetHigh, undefined, () =>
		ownerSwitchesTo(h, haiku, "low"),
	);
	assert.deepEqual(startedOn(h, "queued-inherited-model:0", start.taskId), {
		model: "anthropic/claude-sonnet",
		thinking: "high",
	});
});

test("a never-started queued child of an SDK session starts after a restart on the model and thinking level its parent had when it was admitted (#3784)", async () => {
	const h = harness({ ownerless: true });
	usableModels(h, [sonnet, haiku]);
	ownerSwitchesTo(h, sonnet, "high");
	const siblingDone = Promise.withResolvers<void>();
	h.finishOn.set("model-a-marker", siblingDone);
	h.finishOn.set("model-b-marker", Promise.withResolvers<void>());
	cleanups.push(async () => siblingDone.resolve());
	const launched = h.call({
		tasks: [
			{ agent: "worker", task: "model-a-marker" },
			{ agent: "worker", task: "model-b-marker" },
		],
		concurrency: 1,
	});
	const children = () =>
		[...readSubagentChildRecords(h.sessionManager.getEntries()).values()].sort(
			(left, right) => left.index - right.index,
		);
	const deadline = Date.now() + RECORD_WAIT_MS;
	while (children().length < 2 && Date.now() < deadline) await sleep(10);
	const [childA, childB] = children();
	assert.ok(childA && childB?.taskId);
	await h.waitForLatest(childA.childId, (candidate) => candidate.launchLeafId !== undefined);
	const paused = await h.call({ action: "pause", id: childB.childId });
	assert.notEqual(paused.isError, true, text(paused));
	siblingDone.resolve();
	await launched;
	assert.ok(takeStoppedQueuedOwnerlessChild(childB.taskId), "Atomic restarts and forgets the queued launch");
	h.finishOn.clear();
	ownerSwitchesTo(h, haiku, "low");

	const resumed = await h.call({ action: "resume", id: childB.childId });
	assert.notEqual(resumed.isError, true, text(resumed));
	const resumedTask = resumedTaskId(resumed);
	await h.waitForLatest(
		childB.childId,
		(candidate) => candidate.taskId === resumedTask && candidate.state === "terminal",
	);
	assert.deepEqual(startedOn(h, childB.childId, resumedTask), { model: "anthropic/claude-sonnet", thinking: "high" });
});

test("a never-started queued child whose inherited model is no longer usable after a restart fails to resume, never starting on its parent's new model (#3784)", async () => {
	const h = harness();
	usableModels(h, [sonnet, haiku]);
	const schedule = createExecutionScheduler(1);
	const runId = "queued-inherited-model-gone";
	const childId = `${runId}:0`;
	const runningTask = await h.admit(`${runId}-sibling`, schedule);
	const queuedTask = await h.admit(runId, schedule, admittedOnSonnetHigh);
	await h.waitForLatest(`${runId}-sibling:0`, (candidate) => candidate.launchLeafId !== undefined);
	await h.call({ action: "pause", id: childId });
	await h.call({ action: "quit", id: `${runId}-sibling:0` });
	await settled(h, runningTask);
	assert.ok(takeStoppedQueuedSubagentChild(queuedTask), "Atomic restarts and forgets the queued launch");
	usableModels(h, [haiku]);
	ownerSwitchesTo(h, haiku, "low");

	const resumed = await h.call({ action: "resume", id: childId });
	assert.equal(resumed.isError, true, text(resumed));
	assert.match(text(resumed), /anthropic\/claude-sonnet.*no longer available/);
	assert.deepEqual(
		h.runs.filter((run) => run.options.runId === runId),
		[],
		"it never starts on a model it was not admitted with",
	);
});

test("a started child restored after a restart keeps its own model and thinking level, and falls back to the model it was admitted with, not its parent's new one (#3784)", async () => {
	const h = harness();
	usableModels(h, [sonnet, haiku]);
	const restarted = await restoreStartedChild(h, "started-inherited-model", admittedOnSonnetHigh, undefined, () =>
		ownerSwitchesTo(h, haiku, "low"),
	);
	assert.deepEqual(startedOn(h, "started-inherited-model:0", restarted.taskId), {
		model: "anthropic/claude-sonnet",
		thinking: "high",
	});
	assert.equal(restarted.options.currentModel, "anthropic/claude-sonnet");
});

test("restoring a compacted forked child keeps launch-relative model changes without loading its transcript (#5249)", async () => {
	const h = harness();
	usableModels(h, [sonnet, haiku]);
	await h.sessionManager.appendModelChange(sonnet.provider, sonnet.id);
	await h.sessionManager.appendThinkingLevelChange("high");
	const forked = await forkFromParentConversation(h);
	let childId: string | undefined;
	const original = SessionManager.prototype.loadFullHistory;
	const hydrate = vi.spyOn(SessionManager.prototype, "loadFullHistory").mockImplementation(function (
		this: SessionManager,
	) {
		if (this.getSessionId() === childId) throw new Error("compacted child history must stay unloaded");
		return original.call(this);
	});
	try {
		const restarted = await restoreStartedChild(
			h,
			"compacted-model",
			{ ...admittedOnSonnetHigh, sessionManager: forked },
			undefined,
			async () => {
				const record = h.latest("compacted-model:0");
				assert.ok(record?.childSessionId);
				assert.equal(record.launchLeafId, forked.getLeafId());
				const source = record.childSessionFile
					? await SessionManager.open(record.childSessionFile, undefined, record.cwd)
					: await SessionManager.open(h.sessionManager.getSessionStore(), record.childSessionId, record.cwd);
				await source.appendMessage({ role: "user", content: "old turn", timestamp: 1 });
				await source.appendModelChange(haiku.provider, haiku.id);
				await source.appendThinkingLevelChange("low");
				await source.appendCompaction("summary", null, 100, {
					strategy: "verbatim-lines",
					promptVersion: 7,
					parameters: { query: "" },
					stats: {
						linesBefore: 1,
						linesDeleted: 1,
						linesKept: 0,
						rangeCount: 1,
						tokensBefore: 100,
						tokensAfter: 10,
						percentReduction: 90,
					},
					form: "cleared",
				});
				childId = source.getSessionId();
			},
		);
		assert.deepEqual(startedOn(h, "compacted-model:0", restarted.taskId), {
			model: `${haiku.provider}/${haiku.id}`,
			thinking: "low",
		});

		await h.sessionManager.appendModelChange(haiku.provider, haiku.id);
		await h.sessionManager.appendThinkingLevelChange("low");
		const inheritedFork = await forkFromParentConversation(h);
		const inheritedRestarted = await restoreStartedChild(
			h,
			"compacted-inherited-model",
			{ ...admittedOnSonnetHigh, sessionManager: inheritedFork },
			undefined,
			async () => {
				const record = h.latest("compacted-inherited-model:0");
				assert.ok(record?.childSessionId);
				const { launchLeafSeq: _seq, ...legacyRecord } = record;
				await h.sessionManager.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, {
					...legacyRecord,
					launchModel: `${sonnet.provider}/${sonnet.id}`,
					launchThinkingLevel: "high",
				});
				const source = record.childSessionFile
					? await SessionManager.open(record.childSessionFile, undefined, record.cwd)
					: await SessionManager.open(h.sessionManager.getSessionStore(), record.childSessionId, record.cwd);
				await source.appendMessage({ role: "user", content: "old turn", timestamp: 1 });
				await source.appendCompaction("summary", null, 100, {
					strategy: "verbatim-lines",
					promptVersion: 7,
					parameters: { query: "" },
					stats: {
						linesBefore: 1,
						linesDeleted: 1,
						linesKept: 0,
						rangeCount: 1,
						tokensBefore: 100,
						tokensAfter: 10,
						percentReduction: 90,
					},
					form: "cleared",
				});
				childId = source.getSessionId();
			},
		);
		assert.deepEqual(startedOn(h, "compacted-inherited-model:0", inheritedRestarted.taskId), {
			model: `${sonnet.provider}/${sonnet.id}`,
			thinking: "high",
		});
	} finally {
		hydrate.mockRestore();
	}
});

const PARTIAL_HISTORY_METHODS = [
	"getEntrySeq",
	"findEntrySeq",
	"getLastSeq",
	"getHeldTail",
	"getOmittedHistoryTotals",
] as const;

function withoutPartialHistoryMethods<T>(run: () => Promise<T>): Promise<T> {
	const saved = new Map<string, PropertyDescriptor | undefined>();
	for (const name of PARTIAL_HISTORY_METHODS) {
		saved.set(name, Object.getOwnPropertyDescriptor(SessionManager.prototype, name));
		Reflect.deleteProperty(SessionManager.prototype, name);
	}
	return run().finally(() => {
		for (const [name, descriptor] of saved) {
			if (descriptor) Object.defineProperty(SessionManager.prototype, name, descriptor);
		}
	});
}

test("launching and restoring subagent children tolerate a SessionManager without getEntrySeq or findEntrySeq (#5316)", async () => {
	const h = harness();
	usableModels(h, [sonnet, haiku]);
	await withoutPartialHistoryMethods(async () => {
		assert.equal("getEntrySeq" in h.sessionManager, false);
		assert.equal("findEntrySeq" in h.sessionManager, false);

		await h.sessionManager.appendModelChange(sonnet.provider, sonnet.id);
		await h.sessionManager.appendThinkingLevelChange("high");
		const forked = await forkFromParentConversation(h);
		const forkedRestarted = await restoreStartedChild(
			h,
			"no-entry-seq-forked",
			{ ...admittedOnSonnetHigh, sessionManager: forked },
			undefined,
			async () => {
				const record = h.latest("no-entry-seq-forked:0");
				assert.ok(record?.childSessionId);
				assert.equal(record.launchLeafId, forked.getLeafId());
				assert.equal(record.launchLeafSeq, forked.getEntries().length);
				const source = record.childSessionFile
					? await SessionManager.open(record.childSessionFile, undefined, record.cwd)
					: await SessionManager.open(h.sessionManager.getSessionStore(), record.childSessionId, record.cwd);
				await source.appendModelChange(haiku.provider, haiku.id);
				await source.appendThinkingLevelChange("low");
			},
		);
		assert.deepEqual(startedOn(h, "no-entry-seq-forked:0", forkedRestarted.taskId), {
			model: `${haiku.provider}/${haiku.id}`,
			thinking: "low",
		});

		const freshRestarted = await restoreStartedChild(
			h,
			"no-entry-seq-fresh",
			admittedOnSonnetHigh,
			undefined,
			async () => {
				const record = h.latest("no-entry-seq-fresh:0");
				assert.ok(record?.childSessionId);
				assert.equal(record.launchLeafId, null);
				assert.equal(record.launchLeafSeq, 0);
				const source = record.childSessionFile
					? await SessionManager.open(record.childSessionFile, undefined, record.cwd)
					: await SessionManager.open(h.sessionManager.getSessionStore(), record.childSessionId, record.cwd);
				await source.appendModelChange(haiku.provider, haiku.id);
				await source.appendThinkingLevelChange("low");
			},
		);
		assert.deepEqual(startedOn(h, "no-entry-seq-fresh:0", freshRestarted.taskId), {
			model: `${haiku.provider}/${haiku.id}`,
			thinking: "low",
		});

		await h.sessionManager.appendModelChange(haiku.provider, haiku.id);
		await h.sessionManager.appendThinkingLevelChange("low");
		const legacyInheritedFork = await forkFromParentConversation(h);
		const legacyInheritedRestarted = await restoreStartedChild(
			h,
			"no-entry-seq-legacy-inherited",
			{ ...admittedOnSonnetHigh, sessionManager: legacyInheritedFork },
			undefined,
			async () => {
				const record = h.latest("no-entry-seq-legacy-inherited:0");
				assert.ok(record?.childSessionId);
				const { launchLeafSeq: _seq, ...legacyRecord } = record;
				await h.sessionManager.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, {
					...legacyRecord,
					launchModel: `${sonnet.provider}/${sonnet.id}`,
					launchThinkingLevel: "high",
				});
			},
		);
		assert.deepEqual(startedOn(h, "no-entry-seq-legacy-inherited:0", legacyInheritedRestarted.taskId), {
			model: `${sonnet.provider}/${sonnet.id}`,
			thinking: "high",
		});

		await h.sessionManager.appendModelChange(sonnet.provider, sonnet.id);
		await h.sessionManager.appendThinkingLevelChange("high");
		const legacyChangedFork = await forkFromParentConversation(h);
		const legacyChangedRestarted = await restoreStartedChild(
			h,
			"no-entry-seq-legacy-changed",
			{ ...admittedOnSonnetHigh, sessionManager: legacyChangedFork },
			undefined,
			async () => {
				const record = h.latest("no-entry-seq-legacy-changed:0");
				assert.ok(record?.childSessionId);
				const { launchLeafSeq: _seq, ...legacyRecord } = record;
				await h.sessionManager.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, {
					...legacyRecord,
					launchModel: `${sonnet.provider}/${sonnet.id}`,
					launchThinkingLevel: "high",
				});
				const source = record.childSessionFile
					? await SessionManager.open(record.childSessionFile, undefined, record.cwd)
					: await SessionManager.open(h.sessionManager.getSessionStore(), record.childSessionId, record.cwd);
				await source.appendModelChange(haiku.provider, haiku.id);
				await source.appendThinkingLevelChange("low");
			},
		);
		assert.deepEqual(startedOn(h, "no-entry-seq-legacy-changed:0", legacyChangedRestarted.taskId), {
			model: `${haiku.provider}/${haiku.id}`,
			thinking: "low",
		});

		await h.sessionManager.appendModelChange(sonnet.provider, sonnet.id);
		await h.sessionManager.appendThinkingLevelChange("high");
		const siblingBranchFork = await forkFromParentConversation(h);
		const siblingBranchRestarted = await restoreStartedChild(
			h,
			"no-entry-seq-sibling-branch",
			{ ...admittedOnSonnetHigh, sessionManager: siblingBranchFork },
			undefined,
			async () => {
				const record = h.latest("no-entry-seq-sibling-branch:0");
				assert.ok(record?.childSessionId);
				const { launchLeafSeq: _seq, ...legacyRecord } = record;
				await h.sessionManager.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, {
					...legacyRecord,
					launchModel: `${sonnet.provider}/${sonnet.id}`,
					launchThinkingLevel: "high",
				});
				const source = record.childSessionFile
					? await SessionManager.open(record.childSessionFile, undefined, record.cwd)
					: await SessionManager.open(h.sessionManager.getSessionStore(), record.childSessionId, record.cwd);
				const firstEntry = source.getEntries()[0];
				assert.ok(firstEntry);
				await source.recordBranch(firstEntry.id);
				await source.appendModelChange(haiku.provider, haiku.id);
				await source.appendThinkingLevelChange("low");
			},
		);
		assert.deepEqual(startedOn(h, "no-entry-seq-sibling-branch:0", siblingBranchRestarted.taskId), {
			model: `${haiku.provider}/${haiku.id}`,
			thinking: "low",
		});
	});

	const compactedParent = await SessionManager.create(h.sessionManager.getSessionStore(), h.cwd);
	for (let index = 0; index < 13; index += 1) {
		await compactedParent.appendMessage({ role: "user", content: `pre-${index}`, timestamp: index + 1 });
	}
	await compactedParent.appendModelChange(sonnet.provider, sonnet.id);
	await compactedParent.appendThinkingLevelChange("high");
	await compactedParent.appendCompaction("summary", null, 100, {
		strategy: "verbatim-lines",
		promptVersion: 7,
		parameters: { query: "" },
		stats: {
			linesBefore: 13,
			linesDeleted: 13,
			linesKept: 0,
			rangeCount: 1,
			tokensBefore: 100,
			tokensAfter: 10,
			percentReduction: 90,
		},
		form: "cleared",
	});
	await compactedParent.appendMessage({ role: "user", content: "after compaction", timestamp: 20 });
	const tailFork = await SessionManager.open(
		h.sessionManager.getSessionStore(),
		compactedParent.getSessionId(),
		h.cwd,
		{ history: "tail" },
	);
	assert.equal(tailFork.hasFullHistory(), false);
	const tailForkWithoutGetEntrySeq = new Proxy(tailFork, {
		getPrototypeOf: () => Object.prototype,
		has: (target, prop) => (prop === "getEntrySeq" ? false : Reflect.has(target, prop)),
		get: (target, prop: keyof SessionManager) => {
			if (prop === "getEntrySeq") return undefined;
			const value = target[prop];
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const tailForkRestarted = await restoreStartedChild(
		h,
		"no-entry-seq-partial-tail-fork",
		{
			currentModel: `${haiku.provider}/${haiku.id}`,
			currentThinkingLevel: "high",
			preferredModelProvider: haiku.provider,
			sessionManager: tailForkWithoutGetEntrySeq,
		},
		{ ...agent, model: `${haiku.provider}/${haiku.id}:high` },
		async () => {
			const record = h.latest("no-entry-seq-partial-tail-fork:0");
			assert.ok(record?.childSessionId);
			assert.equal(record.launchLeafSeq, 17);
			const source = await SessionManager.open(
				h.sessionManager.getSessionStore(),
				record.childSessionId,
				record.cwd,
			);
			await source.appendCompaction("child summary", null, 100, {
				strategy: "verbatim-lines",
				promptVersion: 7,
				parameters: { query: "" },
				stats: {
					linesBefore: 1,
					linesDeleted: 1,
					linesKept: 0,
					rangeCount: 1,
					tokensBefore: 100,
					tokensAfter: 10,
					percentReduction: 90,
				},
				form: "cleared",
			});
		},
	);
	assert.deepEqual(startedOn(h, "no-entry-seq-partial-tail-fork:0", tailForkRestarted.taskId), {
		model: `${haiku.provider}/${haiku.id}`,
		thinking: "high",
	});

	const getEntrySeqDescriptor = Object.getOwnPropertyDescriptor(SessionManager.prototype, "getEntrySeq");
	Reflect.deleteProperty(SessionManager.prototype, "getEntrySeq");
	try {
		const tailForkNoGetEntrySeqOnHost = await SessionManager.open(
			h.sessionManager.getSessionStore(),
			compactedParent.getSessionId(),
			h.cwd,
			{ history: "tail" },
		);
		assert.equal(tailForkNoGetEntrySeqOnHost.hasFullHistory(), false);
		assert.equal(tailForkNoGetEntrySeqOnHost.getEntries().length, 5);
		const tailRestoreNoGetEntrySeq = await restoreStartedChild(
			h,
			"no-entry-seq-partial-tail-restore",
			{
				currentModel: `${haiku.provider}/${haiku.id}`,
				currentThinkingLevel: "high",
				preferredModelProvider: haiku.provider,
				sessionManager: tailForkNoGetEntrySeqOnHost,
			},
			{ ...agent, model: `${haiku.provider}/${haiku.id}:high` },
			async () => {
				const record = h.latest("no-entry-seq-partial-tail-restore:0");
				assert.ok(record?.childSessionId);
				assert.equal(record.launchLeafSeq, 21);
				const source = await SessionManager.open(
					h.sessionManager.getSessionStore(),
					record.childSessionId,
					record.cwd,
				);
				await source.appendCompaction("child summary", null, 100, {
					strategy: "verbatim-lines",
					promptVersion: 7,
					parameters: { query: "" },
					stats: {
						linesBefore: 1,
						linesDeleted: 1,
						linesKept: 0,
						rangeCount: 1,
						tokensBefore: 100,
						tokensAfter: 10,
						percentReduction: 90,
					},
					form: "cleared",
				});
			},
		);
		assert.deepEqual(startedOn(h, "no-entry-seq-partial-tail-restore:0", tailRestoreNoGetEntrySeq.taskId), {
			model: `${haiku.provider}/${haiku.id}`,
			thinking: "high",
		});
	} finally {
		if (getEntrySeqDescriptor) Object.defineProperty(SessionManager.prototype, "getEntrySeq", getEntrySeqDescriptor);
	}
});

test("a never-started queued child admitted outside any Intercom group stays out of the group its parent joined later (#3784)", async () => {
	const h = harness();
	usableModels(h, [sonnet]);
	const start = await resumeQueuedChildAfterRestart(
		h,
		"queued-no-group",
		{ ...admittedOnSonnetHigh, intercomGroup: undefined },
		undefined,
		() => Object.assign(h.ctx, { subagentPolicy: { intercomGroup: "joined-later" } }),
	);
	assert.equal(start.options.intercomGroup, undefined);
});

test("a resumed worktree child keeps its worktree while a sibling finishes, and it is removed once the child finishes (#3760 run control)", async () => {
	const h = harness();
	initGitRepository(h.cwd);
	const siblingDone = Promise.withResolvers<void>();
	const resumedDone = Promise.withResolvers<void>();
	h.finishOn.set("task-a-marker", Promise.withResolvers<void>());
	h.finishOn.set("task-b-marker", siblingDone);
	h.finishOn.set(SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT, resumedDone);
	const launched = await h.call({
		tasks: [
			{ agent: "worker", task: "task-a-marker" },
			{ agent: "worker", task: "task-b-marker" },
		],
		worktree: true,
	});
	assert.notEqual(launched.isError, true, text(launched));
	const runs = () => [...readSubagentChildRecords(h.sessionManager.getEntries()).values()];
	const deadline = Date.now() + RECORD_WAIT_MS;
	while (runs().filter((record) => record.childSessionId).length < 2 && Date.now() < deadline) await sleep(10);
	const [childA, childB] = runs().sort((left, right) => left.index - right.index);
	assert.ok(childA && childB);
	assert.notEqual(childA.cwd, h.cwd, "child A runs in its own worktree");
	const trackedEdit = join(childA.cwd, "seed.txt");
	const untrackedDraft = join(childA.cwd, "draft.md");
	writeFileSync(trackedEdit, "edited by A\n");
	writeFileSync(untrackedDraft, "draft by A\n");

	const paused = await h.call({ action: "pause", id: childA.childId });
	assert.notEqual(paused.isError, true, text(paused));
	await h.waitForLatest(childA.childId, (candidate) => candidate.terminalStatus === "paused");
	const resumed = await h.call({ action: "resume", id: childA.childId });
	assert.notEqual(resumed.isError, true, text(resumed));
	const resumedTask = resumedTaskId(resumed);
	await h.waitForLatest(childA.childId, (candidate) => candidate.taskId === resumedTask && !!candidate.childSessionId);

	siblingDone.resolve();
	await settled(h, childB.taskId as string);
	await h.waitForLatest(childB.childId, (candidate) => candidate.state === "terminal");
	await sleep(100);
	assert.equal(readFileSync(trackedEdit, "utf8"), "edited by A\n", "the resumed child's tracked edit survives");
	assert.equal(readFileSync(untrackedDraft, "utf8"), "draft by A\n", "the resumed child's untracked draft survives");
	writeFileSync(join(childA.cwd, "after.md"), "A keeps writing\n");

	resumedDone.resolve();
	await settled(h, resumedTask);
	await waitForWorktreeCleanup(h, childA);
	assert.equal(existsSync(childA.cwd), false, "the worktree is removed once its last live child finished");
});

test("a paused worktree child keeps its uncommitted work after every sibling finished, and resume continues in it (#3760 run control)", async () => {
	const h = harness();
	initGitRepository(h.cwd);
	const siblingDone = Promise.withResolvers<void>();
	h.finishOn.set("task-a-marker", Promise.withResolvers<void>());
	h.finishOn.set("task-b-marker", siblingDone);
	const launched = await h.call({
		tasks: [
			{ agent: "worker", task: "task-a-marker" },
			{ agent: "worker", task: "task-b-marker" },
		],
		worktree: true,
	});
	assert.notEqual(launched.isError, true, text(launched));
	const runs = () => [...readSubagentChildRecords(h.sessionManager.getEntries()).values()];
	const deadline = Date.now() + RECORD_WAIT_MS;
	while (runs().filter((record) => record.childSessionId).length < 2 && Date.now() < deadline) await sleep(10);
	const [childA, childB] = runs().sort((left, right) => left.index - right.index);
	assert.ok(childA && childB);
	const untrackedDraft = join(childA.cwd, "draft.md");
	writeFileSync(untrackedDraft, "draft by A\n");

	await h.call({ action: "pause", id: childA.childId });
	await h.waitForLatest(childA.childId, (candidate) => candidate.terminalStatus === "paused");
	siblingDone.resolve();
	await settled(h, childB.taskId as string);
	await sleep(100);
	assert.equal(readFileSync(untrackedDraft, "utf8"), "draft by A\n", "the paused child's draft survives");

	const resumed = await h.call({ action: "resume", id: childA.childId });
	assert.notEqual(resumed.isError, true, text(resumed));
	await settled(h, resumedTaskId(resumed));
	await waitForWorktreeCleanup(h, childA);
	assert.equal(existsSync(childA.cwd), false, "the worktree is removed once the resumed child finished");
});

test("stopping a queued worktree child releases its reservation without waiting for dispatch (#5600)", async () => {
	const h = harness();
	initGitRepository(h.cwd);
	const runId = randomUUID();
	const setup = await worktrees.createWorktrees(h.cwd, runId, 1);
	const batch = registerRunWorktrees(runId, setup);
	batch.beginLaunches();
	const scheduled = Promise.withResolvers<() => Promise<void>>();
	const child = setup.worktrees[0]!;
	const taskId = await h.admit(runId, scheduled.resolve, { cwd: child.path });
	try {
		const stopped = await h.call({ action: "quit", id: `${runId}:0` });
		assert.notEqual(stopped.isError, true, text(stopped));
		await settled(h, taskId);
		assert.equal(h.runs.length, 0, "no child session ran in the worktree");
		assert.equal(existsSync(child.path), false, "the queued reservation no longer keeps the sole worktree");
		assert.match(text(stopped), /never started.*worktree/i);
	} finally {
		await (await scheduled.promise)();
		await batch.release();
		await waitForWorktreeCleanup(h, await h.waitForLatest(`${runId}:0`, (record) => record.state === "terminal"));
	}
});

test("a queued worktree child resumed behind its cancelled dispatch starts in its worktree after the sibling finishes (#3760 run control)", async () => {
	const h = harness();
	initGitRepository(h.cwd);
	const siblingDone = Promise.withResolvers<void>();
	const queuedDone = Promise.withResolvers<void>();
	h.finishOn.set("task-b-marker", siblingDone);
	h.finishOn.set("task-a-marker", queuedDone);
	const [childB, childA] = await launchWorktreeRun(h, ["task-b-marker", "task-a-marker"], { concurrency: 1 });
	assert.ok(childA && childB);
	await h.waitForLatest(childB.childId, (candidate) => !!candidate.childSessionId);

	const paused = await h.call({ action: "pause", id: childA.childId });
	assert.notEqual(paused.isError, true, text(paused));
	await h.waitForLatest(childA.childId, (candidate) => candidate.terminalStatus === "paused");
	const resumed = await h.call({ action: "resume", id: childA.childId });
	assert.notEqual(resumed.isError, true, text(resumed));
	const resumedTask = resumedTaskId(resumed);

	siblingDone.resolve();
	await settled(h, childB.taskId as string);
	const started = await h.waitForLatest(
		childA.childId,
		(candidate) => candidate.taskId === resumedTask && (!!candidate.childSessionId || candidate.state === "terminal"),
	);
	assert.equal(started.state, "running", `the resumed child started: ${JSON.stringify(started)}`);
	assert.equal(existsSync(childA.cwd), true, "its worktree still exists while it runs");

	queuedDone.resolve();
	await settled(h, resumedTask);
	assert.equal(
		(await h.waitForLatest(childA.childId, (candidate) => candidate.state === "terminal")).terminalStatus,
		"ok",
	);
	await waitForWorktreeCleanup(h, childA);
	assert.equal(existsSync(childA.cwd), false, "the worktree is removed once the resumed child finished");
});

test("a resumed queued child of an SDK session without a task host waits for its run's concurrency slot (#3784)", async () => {
	const h = harness({ ownerless: true });
	const siblingDone = Promise.withResolvers<void>();
	const queuedDone = Promise.withResolvers<void>();
	h.finishOn.set("slot-a-marker", siblingDone);
	h.finishOn.set("slot-b-marker", queuedDone);
	cleanups.push(async () => {
		siblingDone.resolve();
		queuedDone.resolve();
	});
	// Without a task host the parallel call returns once its children settled.
	const launched = h.call({
		tasks: [
			{ agent: "worker", task: "slot-a-marker" },
			{ agent: "worker", task: "slot-b-marker" },
		],
		concurrency: 1,
	});
	const children = () =>
		[...readSubagentChildRecords(h.sessionManager.getEntries()).values()].sort(
			(left, right) => left.index - right.index,
		);
	const deadline = Date.now() + RECORD_WAIT_MS;
	while (children().length < 2 && Date.now() < deadline) await sleep(10);
	const [childA, childB] = children();
	assert.ok(childA && childB);
	await h.waitForLatest(childA.childId, (candidate) => !!candidate.childSessionId);
	const startsOfB = () => h.runs.filter((run) => readsOf(run).includes("slot-b-marker"));

	const paused = await h.call({ action: "pause", id: childB.childId });
	assert.notEqual(paused.isError, true, text(paused));
	await h.waitForLatest(childB.childId, (candidate) => candidate.terminalStatus === "paused");
	const resumed = await h.call({ action: "resume", id: childB.childId });
	assert.notEqual(resumed.isError, true, text(resumed));
	const resumedTask = resumedTaskId(resumed);
	await sleep(100);
	assert.deepEqual(startsOfB(), [], "the resumed child waits while its sibling holds the only slot");

	siblingDone.resolve();
	const started = await h.waitForLatest(
		childB.childId,
		(candidate) => candidate.taskId === resumedTask && (!!candidate.childSessionId || candidate.state === "terminal"),
	);
	assert.equal(started.state, "running", `the resumed child started: ${JSON.stringify(started)}`);
	assert.equal(startsOfB().length, 1, "it starts once its sibling releases the slot");
	queuedDone.resolve();
	await launched;
});

test("a resumed paused child of an SDK session without a task host waits for its run's concurrency slot; paused, it holds none (#3784)", async () => {
	const h = harness({ ownerless: true });
	const firstDone = Promise.withResolvers<void>();
	const secondDone = Promise.withResolvers<void>();
	h.finishOn.set("slot-a-marker", firstDone);
	h.finishOn.set("slot-b-marker", secondDone);
	cleanups.push(async () => {
		firstDone.resolve();
		secondDone.resolve();
	});
	const launched = h.call({
		tasks: [
			{ agent: "worker", task: "slot-a-marker" },
			{ agent: "worker", task: "slot-b-marker" },
		],
		concurrency: 1,
	});
	const children = () =>
		[...readSubagentChildRecords(h.sessionManager.getEntries()).values()].sort(
			(left, right) => left.index - right.index,
		);
	const deadline = Date.now() + RECORD_WAIT_MS;
	while (children().length < 2 && Date.now() < deadline) await sleep(10);
	const [childA, childB] = children();
	assert.ok(childA && childB);
	await h.waitForLatest(childA.childId, (candidate) => !!candidate.childSessionId);
	const startsOfA = () => h.runs.filter((run) => run.options.runId === childA.runId && run.options.index === 0);

	const paused = await h.call({ action: "pause", id: childA.childId });
	assert.notEqual(paused.isError, true, text(paused));
	await h.waitForLatest(childB.childId, (candidate) => !!candidate.childSessionId);
	const resumed = await h.call({ action: "resume", id: childA.childId });
	assert.notEqual(resumed.isError, true, text(resumed));
	const resumedTask = resumedTaskId(resumed);
	await sleep(100);
	assert.equal(startsOfA().length, 1, "the resumed child waits while its sibling holds the only slot");

	secondDone.resolve();
	const finished = await h.waitForLatest(
		childA.childId,
		(candidate) => candidate.taskId === resumedTask && candidate.state === "terminal",
	);
	assert.equal(finished.terminalStatus, "ok");
	assert.equal(startsOfA().length, 2, "it starts once its sibling releases the slot");
	await launched;
});

test("a child an SDK session without a task host resumed keeps running across that session's close: reopening restores it, and its queued messages arrive once, in order (#3784)", async () => {
	const h = harness({ ownerless: true });
	h.resumedRunsWait = true;
	const launch = h.call({ agent: "worker", task: ORIGINAL_TASK, context: "fresh" });
	const firstRecord = async () => {
		const deadline = Date.now() + RECORD_WAIT_MS;
		while (Date.now() < deadline) {
			const [record] = readSubagentChildRecords(h.sessionManager.getEntries()).values();
			if (record?.childSessionId) return record;
			await sleep(10);
		}
		throw new Error("the child never started");
	};
	const running = await firstRecord();
	const paused = await h.call({ action: "pause", id: running.childId });
	assert.notEqual(paused.isError, true, text(paused));
	await launch;

	const live = Promise.withResolvers<TestSessionQueue>();
	h.onSession = (session) => live.resolve(session);
	const resumed = await h.call({ action: "resume", id: running.childId });
	assert.notEqual(resumed.isError, true, text(resumed));
	const resumedTask = resumedTaskId(resumed);
	const session = await live.promise;
	h.onSession = undefined;
	await h.waitForLatest(
		running.childId,
		(candidate) => candidate.taskId === resumedTask && !!candidate.childSessionId,
	);
	const steer = "STEER: report the permission error only";
	const followUp = "FOLLOWUP: include the failing command";
	await session.steer(steer);
	await session.followUp(followUp);
	const starts = h.runs.length;

	h.closeOwnerSessionAndReopen();
	const kept = await h.waitForLatest(
		running.childId,
		(candidate) => candidate.taskId === resumedTask && candidate.heldMessages !== undefined,
	);
	assert.equal(kept.state, "running", "closing its owner records nothing terminal");
	assert.deepEqual(kept.heldMessages?.messages, [steer, followUp], "it keeps what it had queued and not read");
	await sleep(100);
	assert.equal(h.runs.length, starts, "nothing runs for it after its owner closed");

	h.resumedRunsWait = false;
	const [outcome] = await restoreSubagentChildren(h.deps, h.ctx);
	assert.equal(outcome?.kind, "restored", JSON.stringify(outcome));
	assert.ok(outcome?.kind === "restored");
	const finished = await h.waitForLatest(
		running.childId,
		(candidate) => candidate.taskId === outcome.taskId && candidate.state === "terminal",
	);
	assert.equal(finished.terminalStatus, "ok", "the reopened session restores it");
	const store = h.sessionManager.getSessionStore();
	const delivered = await storedTranscript(finished, store);
	assert.equal(occurrences(delivered, steer), 1, "the held steer is delivered exactly once");
	assert.equal(occurrences(delivered, followUp), 1, "the held follow-up is delivered exactly once");
	assert.ok(delivered.indexOf(steer) < delivered.indexOf(followUp), "in the order it queued them");

	const again = await h.call({ action: "resume", id: running.childId });
	assert.notEqual(again.isError, true, text(again));
	const againTask = resumedTaskId(again);
	const after = await storedTranscript(
		await h.waitForLatest(
			running.childId,
			(candidate) => candidate.taskId === againTask && candidate.state === "terminal",
		),
		store,
	);
	assert.equal(occurrences(after, steer), 1, "a later resume does not deliver the steer again");
	assert.equal(occurrences(after, followUp), 1, "a later resume does not deliver the follow-up again");
});

for (const action of ["pause", "quit"] as const)
	test.each([false, true])(
		`${action} all keeps a sibling's answer while an earlier native stop is still settling (worktree: %s, #5600)`,
		async (managed) => {
			const h = harness();
			if (managed) initGitRepository(h.cwd);
			const first = Promise.withResolvers<void>();
			const second = Promise.withResolvers<void>();
			h.stuckOn.set("opening-session", first);
			h.finishOn.set("finishing-sibling", second);
			if (managed) await launchWorktreeRun(h, ["opening-session"]);
			else await h.call({ agent: "worker", task: "opening-session" });
			await vi.waitFor(() => assert.ok(h.runs.some((run) => readsOf(run).includes("opening-session"))));
			const [earlier] = readSubagentChildRecords(h.sessionManager.getEntries()).values();
			assert.ok(earlier?.taskId);
			await h.call({ agent: "worker", task: "finishing-sibling" });
			const later = await vi.waitFor(
				() => {
					const row = [...readSubagentChildRecords(h.sessionManager.getEntries()).values()].find(
						(r) => r.childId !== earlier.childId && r.childSessionId,
					);
					assert.ok(row);
					return row;
				},
				{ timeout: RECORD_WAIT_MS },
			);
			const stop = h.call({ action, all: true });
			try {
				await vi.waitFor(() => assert.equal(taskExecutionKind(h, earlier.taskId!), "cancelling"));
				second.resolve();
				const finished = await h.waitForLatest(later.childId, (r) => r.state === "terminal");
				assert.equal(taskExecutionKind(h, earlier.taskId), "cancelling");
				assert.equal(finished.terminalStatus, "ok");
			} finally {
				first.resolve();
				second.resolve();
				await stop;
			}
		},
	);

for (const action of ["pause", "quit"] as const)
	test(`${action} all stops a plain child before waiting for a different child's Git cleanup (#5600)`, async () => {
		const h = harness();
		initGitRepository(h.cwd);
		const first = Promise.withResolvers<void>();
		const second = Promise.withResolvers<void>();
		h.finishOn.set("managed-child", first);
		h.finishOn.set("plain-child", second);
		const [managed] = await launchWorktreeRun(h, ["managed-child"]);
		assert.ok(managed?.taskId);
		await h.waitForLatest(managed.childId, (record) => !!record.childSessionId);
		const launch = await h.call({ agent: "worker", task: "plain-child" });
		assert.notEqual(launch.isError, true, text(launch));
		const plain = await vi.waitFor(
			() => {
				const row = [...readSubagentChildRecords(h.sessionManager.getEntries()).values()].find(
					(r) => r.childId !== managed.childId && r.childSessionId,
				);
				assert.ok(row?.taskId);
				return row;
			},
			{ timeout: RECORD_WAIT_MS },
		);
		const file = join(managed.cwd, "seed.txt");
		writeFileSync(file, readFileSync(file, "utf8").replace("seed", "tide"));
		utimesSync(file, 0, 0); // Same byte length, different mtime: git status must inspect its contents.
		const filter = holdGitFilter(h.cwd, "seed.txt");
		const stop = h.call({ action, all: true });
		try {
			await filter.started();
			second.resolve();
			const stopped = await h.waitForLatest(plain.childId, (r) => r.state === "terminal");
			assert.equal(stopped.terminalStatus, action === "pause" ? "paused" : "quit");
		} finally {
			filter.release();
			first.resolve();
			second.resolve();
			await stop;
		}
	});

test.each(["acknowledged", "pending"] as const)(
	"pause-all starts a %s reservation at finishing, without bypassing its acknowledgement (#5600)",
	async (ack) => {
		const h = harness();
		initGitRepository(h.cwd);
		const first = Promise.withResolvers<void>();
		const second = Promise.withResolvers<void>();
		h.finishOn.set("managed-first", first);
		h.finishOn.set("plain-peer", second);
		const [managed] = await launchWorktreeRun(h, ["managed-first"]);
		assert.ok(managed?.taskId);
		const a = await h.waitForLatest(managed.childId, (record) => !!record.childSessionId);
		await h.call({ agent: "worker", task: "plain-peer" });
		const b = await vi.waitFor(
			() => {
				const plain = [...readSubagentChildRecords(h.sessionManager.getEntries()).values()].find(
					(record) => record.childId !== a.childId && record.childSessionId,
				);
				assert.ok(plain?.taskId);
				return plain;
			},
			{ timeout: RECORD_WAIT_MS },
		);
		const seed = join(a.cwd, "seed.txt");
		writeFileSync(seed, readFileSync(seed, "utf8").replace("seed", "tide"));
		utimesSync(seed, 0, 0);
		const filter = holdGitFilter(h.cwd, "seed.txt");
		const phase = Promise.withResolvers<void>(),
			broker = Promise.withResolvers<void>();
		let requested = false;
		const events = h.deps.pi.events,
			emit = events.emit.bind(events);
		const watcher = vi.spyOn(events, "emit").mockImplementation((channel, data) => {
			emit(channel, data);
			if (channel === "subagent:finishing" && (data as { taskId: string }).taskId === a.taskId) phase.resolve();
			if (channel !== SUBAGENT_RESERVE_RESTORING_CHILD_EVENT) return;
			const request = data as SubagentReserveRestoringChildRequest;
			if (request.holdMs !== undefined || !request.aliases.includes(a.childSessionId!)) return;
			requested = true;
			request.completion = Promise.all([phase.promise, broker.promise]).then(() => {});
		});
		const stopping = h.call({ action: "pause", all: true });
		try {
			await filter.started();
			await vi.waitFor(() => assert.ok(requested), { timeout: RECORD_WAIT_MS });
			if (ack === "acknowledged") {
				broker.resolve();
				await vi.waitFor(() => assert.notEqual(taskExecutionKind(h, b.taskId!), "running"));
			}
			second.resolve();
			const result = await h.waitForLatest(b.childId, (r) => r.state === "terminal");
			assert.equal(result.terminalStatus, ack === "acknowledged" ? "paused" : "ok");
			assert.notEqual(taskExecutionKind(h, managed.taskId), "settled");
		} finally {
			phase.resolve();
			broker.resolve();
			filter.release();
			first.resolve();
			second.resolve();
			await stopping;
			watcher.mockRestore();
		}
	},
);

test("pausing after an SDK handoff preserves local settings and staged and unstaged edits in the retained worktree (#5600)", async () => {
	const h = harness({ ownerless: true });
	initGitRepository(h.cwd);
	const settings = join(".atomic", "settings.local.json");
	mkdirSync(join(h.cwd, ".atomic"), { recursive: true });
	writeFileSync(join(h.cwd, settings), '{"theme":"light"}');
	const done = Promise.withResolvers<void>();
	h.finishOn.set("handoff", done);
	const launch = h.call({ tasks: [{ agent: "worker", task: "handoff" }], worktree: true });
	try {
		const child = await vi.waitFor(
			() => {
				const row = [...readSubagentChildRecords(h.sessionManager.getEntries()).values()].find(
					(r) => r.childSessionId,
				);
				assert.ok(row);
				return row;
			},
			{ timeout: RECORD_WAIT_MS },
		);
		const file = join(child.cwd, "seed.txt");
		writeFileSync(file, "staged draft\n");
		gitOutput(child.cwd, ["add", "seed.txt"]);
		writeFileSync(file, "unstaged edit\n");
		assert.equal(readFileSync(join(child.cwd, settings), "utf8"), '{"theme":"light"}');
		writeFileSync(join(child.cwd, settings), '{"theme":"dark"}');
		assert.ok(h.runs[0]?.options.onIntercomDetachCommit);
		h.runs[0].options.onIntercomDetachCommit();
		assert.ok((await launch).details.results[0]?.detached);
		const staged = gitOutput(child.cwd, ["show", ":seed.txt"]);
		assert.equal(staged.trim(), "staged draft");
		const paused = await h.call({ action: "pause", id: child.childId });
		assert.notEqual(paused.isError, true, text(paused));
		assert.equal(gitOutput(child.cwd, ["show", ":seed.txt"]), staged);
		assert.equal(readFileSync(file, "utf8"), "unstaged edit\n");
		assert.equal(readFileSync(join(child.cwd, settings), "utf8"), '{"theme":"dark"}');
		h.finishOn.set("read settings", done);
		const resumed = await h.call({ action: "resume", id: child.childId, message: "read settings" });
		assert.notEqual(resumed.isError, true, text(resumed));
		try {
			await vi.waitFor(() => assert.ok(h.runs.some((run) => readsOf(run).includes("read settings"))));
			assert.equal(readFileSync(join(child.cwd, settings), "utf8"), '{"theme":"dark"}');
		} finally {
			done.resolve();
			await waitForWorktreeCleanup(h, child);
		}
	} finally {
		done.resolve();
		await launch;
	}
});

test("an SDK pause waits for its worktree sweep without waiting on the foreground batch reply (#5600)", async () => {
	const h = harness({ ownerless: true });
	initGitRepository(h.cwd);
	const finish = Promise.withResolvers<void>();
	h.finishOn.set("sdk-swept", finish);
	const batch = h.call({ tasks: [{ agent: "worker", task: "sdk-swept" }], worktree: true });
	try {
		const child = await vi.waitFor(
			() => {
				const record = [...readSubagentChildRecords(h.sessionManager.getEntries()).values()].find(
					(r) => r.childSessionId,
				);
				assert.ok(record);
				return record;
			},
			{ timeout: RECORD_WAIT_MS },
		);
		const paused = await h.call({ action: "pause", id: child.childId });
		assert.notEqual(paused.isError, true, text(paused));
		assert.equal(existsSync(child.cwd), false, "the SDK stop replies after the sweep, not before the batch returns");
	} finally {
		finish.resolve();
		await batch;
	}
});

for (const waiting of ["Esc", "deadline"] as const)
	test(`${waiting} releases a pause waiting on worktree cleanup with a note, without stopping the sweep (#5600)`, async () => {
		const h = harness();
		initGitRepository(h.cwd);
		h.finishOn.set("stalled-cleanup", Promise.withResolvers<void>());
		const [child] = await launchWorktreeRun(h, ["stalled-cleanup"]);
		assert.ok(child?.taskId);
		await h.waitForLatest(child.childId, (record) => !!record.childSessionId);
		const reached = Promise.withResolvers<void>(),
			proceed = Promise.withResolvers<void>();
		const check = worktrees.worktreeHasUnsavedWork;
		const gate = vi.spyOn(worktrees, "worktreeHasUnsavedWork").mockImplementation(async (...args) => {
			reached.resolve();
			await proceed.promise;
			return check(...args);
		});
		const turn = new AbortController();
		const stop = h.call({ action: "pause", id: child.childId }, turn.signal);
		try {
			await reached.promise;
			if (waiting === "Esc") {
				const watched = h.host.watchOwnerTasks();
				assert.ok(watched.ok);
				try {
					assert.notEqual(
						watched.value.snapshot.tasks.find((t) => t.ref.taskId === child.taskId)?.execution.kind,
						"settled",
					);
				} finally {
					watched.value.dispose();
				}
				assert.equal(h.latest(child.childId)?.state, "running");
				turn.abort();
				assert.ok(await settlesWithin(stop), "Esc must not wait for the sweep deadline");
			}
			const reply = await stop;
			assert.match(text(reply), /worktree cleanup.*background/i);
			assert.equal(reply.isError === true, waiting === "Esc");
			assert.equal(existsSync(child.cwd), true);
			assert.notEqual(taskExecutionKind(h, child.taskId), "settled");
			assert.equal(h.latest(child.childId)?.state, "running");
			if (waiting === "deadline") {
				assert.equal(reply.details.runControl?.children[0]?.state, "finishing");
				assert.doesNotMatch(text(reply), /^Paused /m);
			}
		} finally {
			proceed.resolve();
			gate.mockRestore();
			await settled(h, child.taskId);
			await waitForWorktreeCleanup(h, child);
		}
	});

for (const action of ["completion", "pause", "quit", "pause after completion"] as const)
	test(`${action} reports only after the child's worktree sweep (#5600)`, async () => {
		const h = harness();
		initGitRepository(h.cwd);
		const finish = Promise.withResolvers<void>();
		h.finishOn.set("last-worker", finish);
		const [child] = await launchWorktreeRun(h, ["last-worker"]);
		assert.ok(child?.taskId);
		await h.waitForLatest(child.childId, (record) => !!record.childSessionId);
		if (action === "completion") {
			finish.resolve();
			await settled(h, child.taskId);
		} else if (action === "pause after completion") {
			duringCancelOf(h, child.taskId, async () => {
				finish.resolve();
				await settled(h, child.taskId!);
			});
			assert.match(text(await h.call({ action: "pause", id: child.childId })), /completed \(ok\)/);
		} else {
			const reply = await h.call({ action, id: child.childId });
			assert.notEqual(reply.isError, true, text(reply));
		}
		const existedAtReply = existsSync(child.cwd);
		await waitForWorktreeCleanup(h, child);
		assert.equal(existedAtReply, false, "the last child's clean worktree is gone at reply, not afterwards");
	});

test("pausing a worktree child that finished on its own as the pause reached it leaves no park or stop behind: its edits are saved and its worktree removed (#5172)", async () => {
	const h = harness();
	initGitRepository(h.cwd);
	h.finishOn.set("task-a-marker", Promise.withResolvers<void>());
	const finisherDone = Promise.withResolvers<void>();
	h.finishOn.set("task-b-marker", finisherDone);
	const [childA, childB] = await launchWorktreeRun(h, ["task-a-marker", "task-b-marker"]);
	assert.ok(childA && childB);
	const diffsDir = childB.worktree?.diffsDir;
	if (diffsDir) cleanups.push(async () => rmSync(diffsDir, { recursive: true, force: true }));
	await h.waitForLatest(childA.childId, (candidate) => !!candidate.childSessionId);
	await h.waitForLatest(childB.childId, (candidate) => !!candidate.childSessionId);
	writeFileSync(join(childB.cwd, "draft.md"), "draft by B\n");
	// A sibling execution still holds the run's worktrees, so how B's worktree goes is decided once it lets go.
	const releaseSibling = holdRunWorktree(childB.runId, childA.index);
	// While pause stops child A, child B finishes on its own, so the cancel pause sends it finds it already settled.
	duringCancelOf(h, childA.taskId as string, async () => {
		finisherDone.resolve();
		await settled(h, childB.taskId as string);
	});
	const cancelTask = h.host.cancelTask.bind(h.host);
	const decisions = new Map<string, string>();
	h.host.cancelTask = (async (taskId: TaskId, cause: Parameters<typeof cancelTask>[1]) => {
		const cancelled = await cancelTask(taskId, cause);
		if (cancelled.ok) decisions.set(taskId, cancelled.value.decision);
		return cancelled;
	}) as typeof h.host.cancelTask;

	const paused = await h.call({ action: "pause", all: true });
	assert.equal(decisions.get(childB.taskId as string), "already-settled", "the race this covers happened");
	assert.match(text(paused), /Paused worker \(\w+:0,/);
	assert.match(text(paused), /completed \(ok\) before it could be paused/);
	assert.equal(h.latest(childB.childId)?.terminalStatus, "ok");
	assert.equal(takeSubagentChildStop(childB.taskId as string), undefined, "no stop request is left for it");
	assert.equal(existsSync(childB.cwd), true, "the sibling still holds the run's worktrees");
	await releaseSibling();
	assert.equal(existsSync(childB.cwd), false, "its worktree is removed as any finished child's is, not kept parked");
	const [patch] = savedPatches(childB);
	assert.ok(patch, "its edits were saved as a patch");
	assert.match(readFileSync(patch, "utf8"), /draft by B/);
});

test("a pause its task host refuses leaves no stop request behind (#5172)", async () => {
	const h = harness();
	const { record, taskId } = await h.launch("refused1");
	h.host.cancelTask = (async () => ({
		ok: false,
		error: { code: "UnknownTask", message: "the task host refused the cancel" },
	})) as typeof h.host.cancelTask;

	const paused = await h.call({ action: "pause", id: record.childId });
	assert.equal(paused.isError, true, text(paused));
	assert.match(text(paused), /Could not pause .*the task host refused the cancel/);
	assert.equal(takeSubagentChildStop(taskId), undefined, "no stop request is left for it");
});

test("pause keeps the steering and follow-up messages a running child queued, and resume delivers them once, in order, before its message (#3784)", async () => {
	const h = harness();
	const live = Promise.withResolvers<TestSessionQueue>();
	h.onSession = (session) => live.resolve(session);
	const { record } = await h.launch("held1");
	h.onSession = undefined;
	const session = await live.promise;
	const steer = "STEER: report the permission error only";
	const followUp = "FOLLOWUP: include the failing command";
	await session.steer(steer);
	await session.followUp(followUp);

	const paused = await h.call({ action: "pause", id: record.childId });
	assert.notEqual(paused.isError, true, text(paused));
	await h.waitForLatest(record.childId, (candidate) => candidate.terminalStatus === "paused");
	const resumed = await h.call({ action: "resume", id: record.childId, message: "then wrap up" });
	assert.notEqual(resumed.isError, true, text(resumed));
	const resumedTask = resumedTaskId(resumed);
	await settled(h, resumedTask);
	const finished = await h.waitForLatest(
		record.childId,
		(candidate) => candidate.taskId === resumedTask && candidate.state === "terminal",
	);
	assert.equal(finished.terminalStatus, "ok");
	const delivered = transcript(finished);
	const order = [steer, followUp, "then wrap up"].map((message) => delivered.indexOf(message));
	assert.ok(
		order.every((position, index) => position >= 0 && (index === 0 || position > order[index - 1]!)),
		`held messages first, in order, then the message: ${order.join(", ")}`,
	);
	assert.equal(
		occurrences(delivered, SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT),
		1,
		"its resume note says to continue, once",
	);

	await settled(h, resumedTaskId(await h.call({ action: "resume", id: record.childId })));
	await h.waitForLatest(
		record.childId,
		(candidate) => candidate.taskId !== resumedTask && candidate.state === "terminal",
	);
	const after = transcript(h.latest(record.childId)!);
	assert.equal(occurrences(after, steer), 1, "the held steer is delivered exactly once");
	assert.equal(occurrences(after, followUp), 1, "the held follow-up is delivered exactly once");
});

test("an SDK session without a task host can pause, resume, quit and resume again its subagent, with queued messages replayed once (#3784)", async () => {
	const cwd = makeTempDirectory("subagent-ownerless-");
	const sessionManager = SessionManager.inMemory(cwd);
	const neverReleased = Promise.withResolvers<void>();
	const live = Promise.withResolvers<TestSessionQueue>();
	const tasks: string[] = [];
	const runSyncFor = async (...args: Parameters<typeof runSync>) => {
		const [parentCwd, agents, agentName, task, options] = args;
		tasks.push(task);
		// The original launch and the first resume run until stopped; the second resume finishes.
		const waits = tasks.length <= 2;
		return runSync(parentCwd, agents, agentName, task, {
			...options,
			testSession: waits
				? {
						output: "partial",
						promptGate: neverReleased.promise,
						abortResolvesPrompt: true,
						...(tasks.length === 1 ? { onSession: (session: TestSessionQueue) => live.resolve(session) } : {}),
					}
				: { output: "resumed" },
		});
	};
	const sdkSession = () => {
		const deps: ExecutorDeps = {
			pi: {
				events: { on: () => () => {}, emit() {} },
				getSessionName: () => "parent",
				appendEntry: async (customType: string, data?: SubagentChildRecord) => {
					await sessionManager.appendCustomEntry(customType, data);
				},
			} as unknown as ExecutorDeps["pi"],
			state: {
				baseCwd: cwd,
				currentSessionId: sessionManager.getSessionId(),
				subagentInProgress: false,
				foregroundControls: new Map(),
				lastForegroundControlId: null,
				pendingForegroundControlNotices: new Map(),
				lastUiContext: null,
			},
			config: {},
			tempArtifactsDir: join(cwd, "artifacts"),
			getSubagentSessionRoot: () => join(cwd, "sessions"),
			expandTilde: (value) => value,
			discoverAgents: () => ({ agents: [agent] }),
			runtime: { runSync: runSyncFor },
		};
		// No getAgentTaskHost: an SDK session that launches subagents directly.
		const ctx = {
			cwd,
			mode: "tui",
			hasUI: false,
			ui: {},
			sessionManager,
			modelRegistry: { getAvailable: () => [], getAll: () => [], find: () => undefined },
		} as unknown as ExtensionContext;
		const executor = createSubagentExecutor(deps);
		return (params: Parameters<typeof executor.execute>[1]) =>
			executor.execute("ownerless", params, new AbortController().signal, undefined, ctx);
	};
	cleanups.push(async () => {
		neverReleased.resolve();
		removeTempDirectory(cwd);
	});
	const records = () => [...readSubagentChildRecords(sessionManager.getEntries()).values()];
	const waitForRecord = async (accept: (record: SubagentChildRecord) => boolean) => {
		const deadline = Date.now() + RECORD_WAIT_MS;
		while (Date.now() < deadline) {
			const found = records().find(accept);
			if (found) return found;
			await sleep(10);
		}
		throw new Error(`no child record matched: ${JSON.stringify(records())}`);
	};
	const call = sdkSession();

	const launch = call({ agent: "worker", task: ORIGINAL_TASK, context: "fresh" });
	const running = await waitForRecord((candidate) => candidate.state === "running" && !!candidate.childSessionId);
	const steer = "STEER: report the permission error only";
	const followUp = "FOLLOWUP: include the failing command";
	const session = await live.promise;
	await session.steer(steer);
	await session.followUp(followUp);

	const paused = await call({ action: "pause", id: running.childId });
	assert.notEqual(paused.isError, true, text(paused));
	await launch;
	const pausedRecord = await waitForRecord((candidate) => candidate.terminalStatus === "paused");
	assert.deepEqual(pausedRecord.heldMessages?.messages, [steer, followUp], "pause keeps what the child had queued");

	const resumed = await call({ action: "resume", id: running.childId, message: "then wrap up" });
	assert.notEqual(resumed.isError, true, text(resumed));
	const firstResume = resumedTaskId(resumed);
	await waitForRecord((candidate) => candidate.taskId === firstResume && candidate.state === "running");
	const quit = await call({ action: "quit", all: true });
	assert.notEqual(quit.isError, true, text(quit));
	assert.equal(quit.details.runControl?.children.length, 1, text(quit));
	await waitForRecord((candidate) => candidate.taskId === firstResume && candidate.terminalStatus === "quit");

	// A new extension instance over the same session, as after reopening it: only the child records carry the child.
	const again = await sdkSession()({ action: "resume", id: running.childId });
	assert.notEqual(again.isError, true, text(again));
	const secondResume = resumedTaskId(again);
	const finished = await waitForRecord(
		(candidate) => candidate.taskId === secondResume && candidate.state === "terminal",
	);
	assert.equal(finished.terminalStatus, "ok");
	const delivered = await storedTranscript(finished, sessionManager.getSessionStore());
	assert.equal(occurrences(delivered, steer), 1, "the held steer is delivered exactly once");
	assert.equal(occurrences(delivered, followUp), 1, "the held follow-up is delivered exactly once");
	assert.equal(occurrences(delivered, "then wrap up"), 1, "the resume message is delivered exactly once");
	const order = [steer, followUp, "then wrap up"].map((message) => delivered.indexOf(message));
	assert.ok(order[0]! < order[1]! && order[1]! < order[2]!, `held messages first, in order: ${order.join(", ")}`);
});

interface StartupUi {
	readonly confirms: Array<{ title: string; message: string }>;
	readonly notices: Array<{ message: string; type: string }>;
}

function startupContext(
	h: Harness,
	options: { hasUI?: boolean; answer?: boolean | Error; confirm?: boolean } = {},
): { ctx: ExtensionContext; ui: StartupUi } {
	const ui: StartupUi = { confirms: [], notices: [] };
	const hasUI = options.hasUI ?? true;
	const ctx = Object.assign(Object.create(h.ctx) as ExtensionContext, {
		hasUI,
		ui: {
			...(options.confirm === false
				? {}
				: {
						confirm: async (title: string, message: string) => {
							ui.confirms.push({ title, message });
							if (options.answer instanceof Error) throw options.answer;
							return options.answer ?? true;
						},
					}),
			notify: (message: string, type: string) => ui.notices.push({ message, type }),
		},
	});
	return { ctx, ui };
}

async function quitChild(h: Harness, runId: string): Promise<SubagentChildRecord> {
	const { record } = await h.launch(runId);
	const quit = await h.call({ action: "quit", id: record.childId });
	assert.notEqual(quit.isError, true, text(quit));
	return h.waitForLatest(record.childId, (candidate) => candidate.terminalStatus === "quit");
}

async function waitForResumed(h: Harness, quit: SubagentChildRecord): Promise<SubagentChildRecord> {
	return h.waitForLatest(
		quit.childId,
		(candidate) => candidate.taskId !== quit.taskId && candidate.state === "terminal",
	);
}

test("resumeInFlight never leaves a quit subagent awaiting resume without asking (#3827)", async () => {
	const h = harness();
	const quit = await quitChild(h, "never1");
	const { ctx, ui } = startupContext(h);
	const runsBefore = h.runs.length;

	await resumeAwaitingSubagentChildren(h.deps, ctx, "never", () => true);

	assert.deepEqual(ui, { confirms: [], notices: [] });
	assert.equal(h.runs.length, runsBefore, "nothing was relaunched");
	assert.equal(h.latest(quit.childId)?.terminalStatus, "quit");
	assert.match(
		text(await h.call({ action: "status" })),
		/Awaiting resume:\n.*never1:0.*quit · paused · awaiting resume/,
	);
});

test("resumeInFlight ask resumes every quit or paused subagent after one confirmation (#3827)", async () => {
	const h = harness();
	const quit = await quitChild(h, "ask1");
	const { record: running } = await h.launch("ask2");
	await h.call({ action: "pause", id: running.childId });
	const paused = await h.waitForLatest(running.childId, (candidate) => candidate.terminalStatus === "paused");
	const { ctx, ui } = startupContext(h, { answer: true });

	await resumeAwaitingSubagentChildren(h.deps, ctx, "ask", () => true);

	assert.equal(ui.confirms.length, 1, "one confirmation for all of them");
	assert.equal(ui.confirms[0]?.title, "Resume interrupted subagents?");
	assert.match(ui.confirms[0]?.message ?? "", /^2 interrupted subagent\(s\) can resume from their own sessions:\n/);
	assert.ok(
		ui.confirms[0]?.message.includes(`- worker (${quit.childId}, subagent-worker-ask1)`),
		"names the quit child",
	);
	assert.ok(
		ui.confirms[0]?.message.includes(`- worker (${paused.childId}, subagent-worker-ask2)`),
		"names the paused child",
	);
	assert.match(ui.confirms[0]?.message ?? "", /\nResume now\? Choose No/);
	const resumed = await waitForResumed(h, quit);
	assert.equal(resumed.terminalStatus, "ok");
	assert.equal(resumed.childSessionId, quit.childSessionId, "it continued from its own session");
	assert.equal((await waitForResumed(h, paused)).terminalStatus, "ok");
	assert.deepEqual(
		ui.notices.map((notice) => notice.type),
		["info", "info"],
	);
	assert.match(ui.notices[0]?.message ?? "", /^Resumed worker \(ask1:0, subagent-worker-ask1\) from its own session/);
	assert.match(ui.notices[1]?.message ?? "", /^Resumed worker \(ask2:0, subagent-worker-ask2\) from its own session/);
});

test("resumeInFlight ask leaves subagents awaiting resume when declined (#3827)", async () => {
	const h = harness();
	const quit = await quitChild(h, "decline1");
	const { ctx, ui } = startupContext(h, { answer: false });
	const runsBefore = h.runs.length;

	await resumeAwaitingSubagentChildren(h.deps, ctx, "ask", () => true);

	assert.equal(ui.confirms.length, 1);
	assert.deepEqual(ui.notices, []);
	assert.equal(h.runs.length, runsBefore);
	assert.equal(h.latest(quit.childId)?.terminalStatus, "quit");
	assert.match(text(await h.call({ action: "status" })), /Awaiting resume:\n.*decline1:0/);
	const manual = await h.call({ action: "resume", id: quit.childId });
	assert.notEqual(manual.isError, true, text(manual));
});

test("resumeInFlight ask falls back to never without a UI (#3827)", async () => {
	for (const options of [{ hasUI: false }, { confirm: false }]) {
		const h = harness();
		const quit = await quitChild(h, "noui1");
		const { ctx, ui } = startupContext(h, options);
		const runsBefore = h.runs.length;

		await resumeAwaitingSubagentChildren(h.deps, ctx, "ask", () => true);

		assert.deepEqual(ui, { confirms: [], notices: [] });
		assert.equal(h.runs.length, runsBefore);
		assert.equal(h.latest(quit.childId)?.terminalStatus, "quit");
	}
});

test(
	"resumeInFlight auto resumes a subagent quit before a restart without asking (#3827)",
	async () => {
		const h = harness();
		const quit = await quitChild(h, "auto1");
		await h.closeOwnerAndReopen("session-close");
		const { ctx, ui } = startupContext(h);

		await resumeAwaitingSubagentChildren(h.deps, ctx, "auto", () => true);

		assert.deepEqual(ui.confirms, []);
		const resumed = await waitForResumed(h, quit);
		assert.equal(resumed.terminalStatus, "ok");
		assert.equal(resumed.childSessionId, quit.childSessionId);
		const relaunch = h.runs.at(-1)!;
		assert.equal(relaunch.options.resumeNote?.text, SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT);
		assert.equal(relaunch.task, "");
		assert.equal(relaunch.options.resumeSession, true);
		assert.equal(relaunch.options.sessionManager?.getSessionId(), quit.childSessionId);
		assert.equal(ui.notices.length, 1);
		assert.equal(ui.notices[0]?.type, "info");
	},
	LAUNCH_QUIT_RESUME_TIMEOUT_MS,
);

test("resumeInFlight leaves children another session launched alone (#3827)", async () => {
	const h = harness();
	const quit = await quitChild(h, "foreign1");
	const { ctx, ui } = startupContext(h);
	const forked = Object.assign(Object.create(ctx) as ExtensionContext, {
		sessionManager: Object.assign(Object.create(h.sessionManager) as SessionManager, {
			getSessionId: () => "forked-session",
		}),
	});
	const runsBefore = h.runs.length;

	await resumeAwaitingSubagentChildren(h.deps, forked, "auto", () => true);

	assert.deepEqual(ui, { confirms: [], notices: [] });
	assert.equal(h.runs.length, runsBefore);
	assert.equal(h.latest(quit.childId)?.terminalStatus, "quit");
});

test("resumeInFlight reports a subagent that cannot resume and never throws (#3827)", async () => {
	const h = harness();
	await quitChild(h, "broken1");
	h.agentDefined = false;
	const { ctx, ui } = startupContext(h);

	await resumeAwaitingSubagentChildren(h.deps, ctx, "auto", () => true);

	assert.equal(ui.notices.length, 1);
	assert.equal(ui.notices[0]?.type, "warning");
	assert.match(ui.notices[0]?.message ?? "", /could not be resumed: agent "worker" \(project\) is no longer defined/);
});

test("resumeInFlight warns when the confirmation fails and never throws (#3827)", async () => {
	const h = harness();
	const quit = await quitChild(h, "failed1");
	const { ctx, ui } = startupContext(h, { answer: new Error("dialog closed") });

	await resumeAwaitingSubagentChildren(h.deps, ctx, "ask", () => true);

	assert.equal(ui.notices.length, 1);
	assert.equal(ui.notices[0]?.type, "warning");
	assert.match(ui.notices[0]?.message ?? "", /^Subagent startup resume failed: Error: dialog closed/);
	assert.equal(h.latest(quit.childId)?.terminalStatus, "quit");
});

test("resumeInFlight stops resuming once its session is no longer current (#3827)", async () => {
	const h = harness();
	const quit = await quitChild(h, "stale1");
	const { ctx, ui } = startupContext(h);
	const runsBefore = h.runs.length;

	await resumeAwaitingSubagentChildren(h.deps, ctx, "auto", () => false);

	assert.deepEqual(ui, { confirms: [], notices: [] });
	assert.equal(h.runs.length, runsBefore);
	assert.equal(h.latest(quit.childId)?.terminalStatus, "quit");
});

test("a resume's message is delivered as written, whether or not the child had held messages (#4027)", async () => {
	const h = harness();
	const { record } = await h.launch("literal1");
	await h.call({ action: "pause", id: record.childId });
	await h.waitForLatest(record.childId, (candidate) => candidate.terminalStatus === "paused");
	const message = "/review src/app.ts";
	const resumed = await h.call({ action: "resume", id: record.childId, message });
	assert.notEqual(resumed.isError, true, text(resumed));
	await settled(h, resumedTaskId(resumed));
	const relaunch = h.runs.at(-1)!;
	assert.equal(relaunch.task, message);
	assert.equal(relaunch.options.resumeTaskLiteral, true, "a resume's own message is never expanded or run");

	const live = Promise.withResolvers<TestSessionQueue>();
	h.onSession = (session) => live.resolve(session);
	const held = (await h.launch("literal2")).record;
	h.onSession = undefined;
	const session = await live.promise;
	const steer = "/workflows run-1";
	await session.steer(steer);
	await h.closeOwnerAndReopen("session-close");
	await h.waitForLatest(held.childId, (candidate) => candidate.heldMessages !== undefined);
	const [outcome] = await restoreSubagentChildren(h.deps, h.ctx);
	assert.ok(outcome?.kind === "restored", JSON.stringify(outcome));
	await settled(h, outcome.taskId);
	const restored = h.runs.at(-1)!;
	assert.equal(restored.task, steer, "the held steer comes first");
	assert.equal(
		restored.options.resumeTaskLiteral,
		true,
		"a message the child had already received is delivered as written, not prompted as a new task",
	);
});

test("a held original task the child never read is prompted as its launch would prompt it (#4027)", async () => {
	// `taskExpands` absent is a record written before Atomic recorded it: its first held message keeps the handling it
	// had then, prompted as a task.
	for (const taskExpands of [true, false, undefined]) {
		const h = harness();
		const runId = `heldtask-${String(taskExpands)}`;
		const { record } = await h.launch(runId);
		await h.call({ action: "pause", id: record.childId });
		const paused = await h.waitForLatest(record.childId, (candidate) => candidate.terminalStatus === "paused");
		// The record a child stopped before its prompt ran leaves: its unread task, then a follow-up. (The harness's own
		// ORIGINAL_TASK never settles, so the unread task here is another original task text.)
		const unreadTask = "/review src/unread-task.ts";
		await h.sessionManager.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, {
			...paused,
			heldMessages: {
				taskId: paused.taskId,
				messages: [unreadTask, "/review src/held.ts"],
				...(taskExpands === undefined ? {} : { taskExpands }),
			},
		});
		const resumed = await h.call({ action: "resume", id: record.childId });
		assert.notEqual(resumed.isError, true, text(resumed));
		await settled(h, resumedTaskId(resumed));
		const relaunch = h.runs.at(-1)!;
		assert.equal(relaunch.task, unreadTask);
		assert.equal(relaunch.options.resumeTaskLiteral, taskExpands === false ? true : undefined, String(taskExpands));
		assert.deepEqual(relaunch.options.resumeFollowUps, ["/review src/held.ts"]);
		assert.equal(relaunch.options.resumeNote?.text, SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT);
	}
});

/** Three children of one run that may run one at a time: index 1 waits for the run's capacity, index 2 is queued. */
async function capacityWaitingChildren(h: Harness, runId: string): Promise<void> {
	const schedule = createExecutionScheduler(2);
	await h.admit(runId, schedule, { runningCapacity: 1 });
	await h.admit(runId, schedule, { runningCapacity: 1, index: 1 });
	await h.admit(runId, schedule, { runningCapacity: 1, index: 2 });
	await h.waitForLatest(`${runId}:0`, (candidate) => candidate.launchLeafId !== undefined);
}

async function runsOf(h: Harness, runId: string, index: number, count: number): Promise<Harness["runs"]> {
	const deadline = Date.now() + RECORD_WAIT_MS;
	for (;;) {
		const runs = h.runs.filter((run) => run.options.runId === runId && run.options.index === index);
		if (runs.length >= count || Date.now() >= deadline) return runs;
		await sleep(10);
	}
}

test("a child paused while it waits for its run's capacity, before its session exists, resumes with its task once (#4027)", async () => {
	const h = harness();
	await capacityWaitingChildren(h, "capwait");
	const paused = await h.call({ action: "pause", id: "capwait:1" });
	assert.notEqual(paused.isError, true, text(paused));
	const stopped = await h.waitForLatest("capwait:1", (candidate) => candidate.terminalStatus === "paused");
	assert.equal(stopped.childSessionId, undefined, "it stopped before its session existed");
	assert.deepEqual(stopped.heldMessages?.messages, [ORIGINAL_TASK], "it holds the task it never read");

	const resumed = await h.call({ action: "resume", id: "capwait:1" });
	assert.notEqual(resumed.isError, true, text(resumed));
	assert.match(text(resumed), /^Started worker \(capwait:1, subagent-worker-capwait\) fresh with its task as task /);
	assert.doesNotMatch(text(resumed), /from its own session|delivered after its task/, "it had no session to resume");
	// It waits for a slot in its run, as its launch did; pausing the child holding the other slot gives it one.
	assert.notEqual((await h.call({ action: "pause", id: "capwait:2" })).isError, true);
	const [, relaunch] = await runsOf(h, "capwait", 1, 2);
	assert.equal(relaunch?.task, ORIGINAL_TASK, "it starts with its task");
	assert.equal(relaunch?.options.resumeFollowUps, undefined, "and is not sent its task a second time");
});

test("a queued child stopped while it waits for its run's capacity is restored with its task once (#4027)", async () => {
	const h = harness();
	await capacityWaitingChildren(h, "capqueued");
	// Pausing the child that holds the second slot dispatches the queued one, which then waits for capacity.
	assert.notEqual((await h.call({ action: "pause", id: "capqueued:1" })).isError, true);
	await runsOf(h, "capqueued", 2, 1);
	await h.closeOwnerAndReopen("session-close");
	const kept = await h.waitForLatest("capqueued:2", (candidate) => candidate.heldMessages !== undefined);
	assert.deepEqual(kept.heldMessages?.messages, [ORIGINAL_TASK]);

	const outcomes = await restoreSubagentChildren(h.deps, h.ctx);
	const restoredOutcome = outcomes.find(
		(outcome) => outcome.kind === "restored" && outcome.record.childId === "capqueued:2",
	);
	assert.ok(restoredOutcome, JSON.stringify(outcomes));
	const [notice] = subagentChildRestoreNotices([restoredOutcome]);
	assert.match(notice ?? "", /started fresh with its task/);
	assert.doesNotMatch(notice ?? "", /from its own session/);
	const [, restored] = await runsOf(h, "capqueued", 2, 2);
	assert.equal(restored?.task, ORIGINAL_TASK);
	assert.equal(restored?.options.resumeFollowUps, undefined, "its held task is its launch task, not sent again");
});

/** A `/clear` boundary: the session's window starts after it, and nothing before it is kept in the window. */
const CLEAR: VerbatimCompactionDetails = {
	strategy: "verbatim-lines",
	promptVersion: 7,
	parameters: { query: "clear" },
	form: "cleared",
	stats: {
		linesBefore: 2,
		linesDeleted: 1,
		linesKept: 1,
		rangeCount: 1,
		tokensBefore: 100,
		tokensAfter: 50,
		percentReduction: 50,
	},
};

function childRecordsIn(manager: SessionManager): SubagentChildRecord[] {
	return manager.getEntries().flatMap((entry) => (isSubagentChildRecord(entry) && entry.data ? [entry.data] : []));
}

/** What a reader of the parent sees of a finished child: run control's answers, its chat binding and its launch card. */
async function finishedChildViews(h: Harness, ctx: ExtensionContext, child: SubagentChildRecord, launchTaskId: string) {
	const call = (params: Parameters<Harness["call"]>[0]) =>
		createSubagentExecutor(h.deps).execute("run-control", params, new AbortController().signal, undefined, ctx);
	const card = subagentChildCardRecord(child.childId, launchTaskId);
	// What a reconnect tells the broker of the parent's ended children, so a send to one is answered with how it ended.
	const ended: unknown[] = [];
	await markEndedChildrenOf(
		{
			on: () => () => {},
			emit(channel: string, data: unknown) {
				if (channel !== SUBAGENT_MARK_ENDED_CHILDREN_EVENT) return;
				ended.push((data as { children: unknown }).children);
				(data as { completion?: Promise<void> }).completion = Promise.resolve();
			},
		} as never,
		ctx.sessionManager.getSessionId(),
	);
	return {
		ended,
		pause: text(await call({ action: "pause", id: child.childId })),
		quitByName: text(await call({ action: "quit", id: child.intercomTarget })),
		status: text(await call({ action: "status", id: child.childId })),
		awaiting: subagentChildrenAwaitingResume(ctx),
		launchChat: subagentChildOfTask(ctx, launchTaskId),
		latestChat: subagentChildOfTask(ctx, child.taskId!),
		card: card && {
			childId: card.childId,
			state: card.state,
			terminalStatus: card.terminalStatus,
			taskId: card.taskId,
			elapsedMs: card.elapsedMs,
		},
	};
}

async function cardTaskOf(childId: string, taskId: string): Promise<string | undefined> {
	const deadline = Date.now() + RECORD_WAIT_MS;
	for (;;) {
		const card = subagentChildCardRecord(childId, taskId);
		const task = card && subagentChildCardTask(card);
		if (task !== undefined || Date.now() > deadline) return task;
		await sleep(5);
	}
}

test(
	"a finished child whose records a clear moved out of the window answers, shows and resumes as before the clear (#5554)",
	async () => {
		const h = harness();
		const { record, taskId: launchTaskId } = await h.launch("cleared1");
		await h.call({ action: "quit", id: record.childId });
		await settled(h, launchTaskId);
		const finishing = await h.call({ action: "resume", id: record.childId, message: "finish up" });
		await settled(h, resumedTaskId(finishing));
		const finished = await h.waitForLatest(record.childId, (candidate) => candidate.terminalStatus === "ok");
		const before = await finishedChildViews(h, h.ctx, finished, launchTaskId);
		assert.match(before.pause, /worker \(cleared1:0, subagent-worker-cleared1\) is not running \(ok\)/);
		assert.deepEqual(before.ended, [
			[
				{
					childName: "subagent-worker-cleared1",
					group: "lane-group",
					aliases: [finished.childSessionId],
					outcome: "completed",
					childId: record.childId,
					messages: "wake",
				},
			],
		]);
		assert.equal(await cardTaskOf(record.childId, launchTaskId), ORIGINAL_TASK);

		await h.sessionManager.appendCompaction("clear", null, 10, CLEAR);
		assert.deepEqual(childRecordsIn(h.sessionManager), [], "the window keeps no record of the finished child");
		assert.deepEqual(
			h.sessionManager.getArchivedChildCatalog().map((child) => child.childId),
			[record.childId],
		);
		assert.deepEqual(await finishedChildViews(h, h.ctx, finished, launchTaskId), before, "after the clear");

		// Reopened, as a resume of the parent opens it: only its window and its catalog of finished children.
		const reopened = await SessionManager.open(h.sessionManager.getSessionStore(), h.sessionManager.getSessionId());
		assert.deepEqual(childRecordsIn(reopened), []);
		const reopenedCtx = { ...h.ctx, sessionManager: reopened } as ExtensionContext;
		bindSubagentChildCards(reopenedCtx);
		assert.deepEqual(await finishedChildViews(h, reopenedCtx, finished, launchTaskId), before, "after reopening");
		assert.equal(await cardTaskOf(record.childId, launchTaskId), ORIGINAL_TASK);

		const resumed = await createSubagentExecutor(h.deps).execute(
			"run-control",
			{ action: "resume", id: record.childId, message: "one more check" },
			new AbortController().signal,
			undefined,
			reopenedCtx,
		);
		assert.notEqual(resumed.isError, true, text(resumed));
		assert.match(
			text(resumed),
			/^Resumed worker \(cleared1:0, subagent-worker-cleared1\) from its own session as task .*, with your message as its new prompt\./,
		);
		const resumedTaskIdAfterClear = resumedTaskId(resumed);
		await settled(h, resumedTaskIdAfterClear);
		const run = h.runs.at(-1);
		assert.equal(run?.options.runId, "cleared1");
		assert.equal(run?.options.sessionManager?.getSessionId(), finished.childSessionId);
		assert.equal(occurrences(transcript(finished), "one more check"), 1);
		// The harness's parent writes through the session it opened first; both are the same saved session.
		const latest = await h.waitForLatest(record.childId, (candidate) => candidate.taskId === resumedTaskIdAfterClear);
		assert.equal(latest.terminalStatus, "ok");
		// Its new records keep what only its earlier, cleared records named: a resumed run records what changed.
		const saved = childRecordsIn(h.sessionManager).filter((candidate) => candidate.childId === record.childId);
		assert.equal(saved.at(-1)?.taskId, resumedTaskIdAfterClear);
		assert.equal(saved.at(-1)?.task, ORIGINAL_TASK, "the latest saved record is whole on its own");
		assert.deepEqual(saved.at(-1)?.inherited, finished.inherited);

		// The window holds its newer records while the catalog still names the cleared one: indexing the session again
		// reads the child as those newer records say, and saves nothing again.
		const owner = h.sessionManager.getSessionId();
		assert.ok(h.sessionManager.getArchivedChildCatalog().some((child) => child.childId === record.childId));
		bindSubagentChildCards(h.ctx);
		await subagentChildRecordsMerging(owner);
		await saveUnsavedSubagentChildRecords(h.deps.pi, owner);
		assert.deepEqual(subagentChildRecordOf(owner, record.childId), saved.at(-1));
		assert.equal(childRecordsIn(h.sessionManager).length, saved.length);
	},
	LAUNCH_QUIT_THREE_RESUMES_TIMEOUT_MS,
);

test(
	"a finished child's record read for an action that does not record it again is let go once that action answers (#5554)",
	async () => {
		const h = harness();
		const { record, taskId: launchTaskId } = await h.launch("letgo1");
		await h.call({ action: "quit", id: record.childId });
		await settled(h, launchTaskId);
		const finishing = await h.call({ action: "resume", id: record.childId, message: "finish up" });
		await settled(h, resumedTaskId(finishing));
		const finished = await h.waitForLatest(record.childId, (candidate) => candidate.terminalStatus === "ok");
		await h.sessionManager.appendCompaction("clear", null, 10, CLEAR);
		assert.deepEqual(childRecordsIn(h.sessionManager), [], "the window keeps no record of the finished child");
		const owner = h.sessionManager.getSessionId();
		// Each full record an action reads from the session after the clear, held weakly.
		const read: WeakRef<object>[] = [];
		const readArchived = h.sessionManager.readArchivedChildRecord.bind(h.sessionManager);
		h.sessionManager.readArchivedChildRecord = async (entryId) => {
			const entry = await readArchived(entryId);
			if (entry?.type === "custom" && typeof entry.data === "object" && entry.data !== null)
				read.push(new WeakRef(entry.data));
			return entry;
		};
		const uncollected = async () => {
			await collectGarbage();
			return read.filter((ref) => ref.deref() !== undefined).length;
		};

		const pause = await h.call({ action: "pause", id: record.childId });
		assert.match(text(pause), /worker \(letgo1:0, subagent-worker-letgo1\) is not running \(ok\)/);
		assert.equal(read.length, 1, "pause read the finished child's full record");
		assert.equal(await uncollected(), 0, "the record pause read is not kept once it answered");
		assert.equal(subagentChildRecordNeedsRead(owner, record.childId), true, "it is read again when next asked for");

		const interrupted = new AbortController();
		interrupted.abort();
		const refused = await h.call({ action: "resume", id: record.childId, message: "not now" }, interrupted.signal);
		assert.equal(refused.isError, true);
		assert.match(
			text(refused),
			/^Interrupted before worker \(letgo1:0, subagent-worker-letgo1\) took the resume: it was withdrawn/,
		);
		assert.equal(read.length, 2, "the refused resume read the record again");
		assert.equal(await uncollected(), 0, "the record a refused resume read is not kept once it answered");
		assert.equal(subagentChildRecordNeedsRead(owner, record.childId), true);

		// A resume that runs it again reads it once more, and its new records are merged over that record.
		const resumed = await h.call({ action: "resume", id: record.childId, message: "one more check" });
		assert.notEqual(resumed.isError, true, text(resumed));
		const resumedTask = resumedTaskId(resumed);
		await settled(h, resumedTask);
		await h.waitForLatest(record.childId, (candidate) => candidate.taskId === resumedTask);
		const saved = childRecordsIn(h.sessionManager).filter((candidate) => candidate.childId === record.childId);
		assert.equal(saved.at(-1)?.terminalStatus, "ok");
		assert.equal(saved.at(-1)?.task, ORIGINAL_TASK, "the latest saved record is whole on its own");
		assert.deepEqual(saved.at(-1)?.inherited, finished.inherited);
	},
	LAUNCH_QUIT_THREE_RESUMES_TIMEOUT_MS,
);

test("a launch card in another session reads only where its owner's children stand, never the owner's history (#5554)", async () => {
	const h = harness();
	const store = h.sessionManager.getSessionStore();
	const owner = await SessionManager.create(store, h.cwd);
	const ownerSessionId = owner.getSessionId();
	const finished: SubagentChildRecord = {
		version: 1,
		childId: "elsewhere1:0",
		runId: "elsewhere1",
		index: 0,
		agent: "worker",
		state: "terminal",
		terminalStatus: "ok",
		elapsedMs: 1234,
		cwd: h.cwd,
		owner: { kind: "session", sessionId: ownerSessionId },
		taskId: "task-elsewhere",
		task: "work done elsewhere",
		launch: { task: "a long launch prompt the card never shows" },
	};
	await owner.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, finished);
	await owner.appendMessage({ role: "user", content: "later history", timestamp: Date.now() });
	bindSubagentChildCards(h.ctx);
	const loads = vi.spyOn(store, "load");
	try {
		watchSubagentChildCard({}, () => {}, finished.childId, ownerSessionId);
		const deadline = Date.now() + RECORD_WAIT_MS;
		while (subagentChildIndexEntry(finished.childId) === undefined && Date.now() < deadline) await sleep(5);
		assert.deepEqual(subagentChildIndexEntry(finished.childId), {
			childId: finished.childId,
			runId: finished.runId,
			index: 0,
			agent: "worker",
			ownerSessionId,
			state: "terminal",
			elapsedMs: 1234,
			cwd: h.cwd,
			taskId: "task-elsewhere",
			terminalStatus: "ok",
			entryId: subagentChildIndexEntry(finished.childId)?.entryId,
		});
		assert.equal(subagentChildCardRecord(undefined, "task-elsewhere")?.childId, finished.childId);
		assert.equal(loads.mock.calls.length, 0, "the owner's history is never loaded for a card");
	} finally {
		loads.mockRestore();
	}
});

for (const ownerless of [true, false])
	test(`a resumed child${ownerless ? " of a session without a task host" : ""}, stopped while it waited for its run's slot, reads the message it is resumed with next`, async () => {
		const h = harness(ownerless ? { ownerless: true } : {});
		const bGate = Promise.withResolvers<void>();
		const aGate = Promise.withResolvers<void>();
		h.finishOn.set("slot-b-task", bGate);
		h.finishOn.set("slot-a-task", aGate);
		cleanups.push(async () => {
			aGate.resolve();
			bGate.resolve();
		});
		const launched = h.call({
			tasks: [
				{ agent: "worker", task: "slot-b-task" },
				{ agent: "worker", task: "slot-a-task" },
			],
			concurrency: 1,
		});
		const children = () =>
			[...readSubagentChildRecords(h.sessionManager.getEntries()).values()].sort(
				(left, right) => left.index - right.index,
			);
		const deadline = Date.now() + RECORD_WAIT_MS;
		while (children().length < 2 && Date.now() < deadline) await sleep(10);
		const [childB, childA] = children();
		assert.ok(childA && childB);
		await h.waitForLatest(childB.childId, (candidate) => !!candidate.childSessionId);
		await h.call({ action: "pause", id: childB.childId });
		await h.waitForLatest(childA.childId, (candidate) => !!candidate.childSessionId && candidate.state === "running");
		const startsOfB = () =>
			h.runs.filter((run) => run.options.runId === childB.runId && run.options.index === childB.index);
		// Resumed without a message, it waits behind its sibling for the run's only slot, and is paused there.
		await h.call({ action: "resume", id: childB.childId });
		await h.call({ action: "pause", id: childB.childId });
		const resumed = h.call({ action: "resume", id: childB.childId, message: "then check the edge case" });
		// Its earlier resume, which it never ran, is over: this one does not wait for it.
		const answered = await Promise.race([resumed.then(() => true), sleep(RECORD_WAIT_MS).then(() => false)]);
		assert.ok(answered, "the resume answers while its sibling still holds the slot");
		aGate.resolve();
		const until = Date.now() + RECORD_WAIT_MS;
		while (startsOfB().length < 2 && Date.now() < until) await sleep(10);
		bGate.resolve();
		await Promise.race([launched, sleep(RECORD_WAIT_MS)]);

		const run = startsOfB().at(-1);
		assert.ok(run, "it starts");
		assert.ok(
			run.task.includes("then check the edge case"),
			`its message is its prompt: ${JSON.stringify(run.task)}`,
		);
		assert.notEqual(run.options.skipTaskPrompt, true, "and is prompted");
	});

test("a child stopped while it waited for its run's slot and resumed with a message starts on it, its task first if it had one to prompt", () => {
	const options = { cwd: "/repo", runId: "slot", resumeTaskLiteral: true } as RunSyncOptions;
	assert.deepEqual(queuedResumeStart("the task", options, undefined), { task: "the task", options });
	assert.deepEqual(queuedResumeStart("the task", options, "and this"), { task: "the task\n\nand this", options });
	// A start its note or continued results begin prompts no task: the message is its prompt, as written.
	for (const start of [
		{ task: "", options: { ...options, skipTaskPrompt: true } },
		{ task: SUBAGENT_RELEASED_WAKE_PROMPT, options: { ...options, resumeTaskFallback: true } },
	])
		assert.deepEqual(queuedResumeStart(start.task, start.options, "and this"), {
			task: "and this",
			options: { ...start.options, skipTaskPrompt: false, resumeTaskFallback: false, resumeTaskLiteral: true },
		});
	// Why it runs again is still read with the message; that it was woken is not: the message starts its turn (#6161).
	const resumeNote = { kind: "resume", text: SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT } as const;
	assert.deepEqual(queuedResumeStart("", { ...options, skipTaskPrompt: true, resumeNote }, "and this"), {
		task: "and this",
		options: { ...options, resumeNote, skipTaskPrompt: false, resumeTaskFallback: false, resumeTaskLiteral: true },
	});
	assert.deepEqual(
		queuedResumeStart(
			"",
			{ ...options, skipTaskPrompt: true, resumeNote: { kind: "wake", text: SUBAGENT_RELEASED_WAKE_PROMPT } },
			"and this",
		),
		{
			task: "and this",
			options: { ...options, skipTaskPrompt: false, resumeTaskFallback: false, resumeTaskLiteral: true },
		},
	);
	// A start that runs its detached calls again prompts nothing: the message waits for its wake, after what it held.
	const redispatch = {
		...options,
		redispatchDetachedCalls: true,
		resumeTaskFallback: true,
		resumeFollowUps: ["held"],
	} satisfies RunSyncOptions;
	assert.deepEqual(queuedResumeStart(SUBAGENT_RELEASED_WAKE_PROMPT, redispatch, "and this"), {
		task: SUBAGENT_RELEASED_WAKE_PROMPT,
		options: { ...redispatch, resumeFollowUps: ["held", "and this"] },
	});
});

test("a resumed child whose run failed can be resumed again", async () => {
	const h = harness();
	const first = Promise.withResolvers<void>();
	h.finishOn.set("failing-run-task", first);
	cleanups.push(async () => first.resolve());
	const launched = h.call({ agent: "worker", task: "failing-run-task" });
	const children = () => [...readSubagentChildRecords(h.sessionManager.getEntries()).values()];
	const deadline = Date.now() + RECORD_WAIT_MS;
	while (children().length < 1 && Date.now() < deadline) await sleep(10);
	const [child] = children();
	assert.ok(child);
	await h.waitForLatest(child.childId, (candidate) => !!candidate.childSessionId);
	await h.call({ action: "pause", id: child.childId });
	h.throwOn.add("first resume message");
	await h.call({ action: "resume", id: child.childId, message: "first resume message" });
	await h.waitForLatest(child.childId, (candidate) => candidate.terminalStatus === "error");

	const again = h.call({ action: "resume", id: child.childId, message: "second resume message" });

	// Its failed relaunch is over: this resume does not wait for it.
	const answered = await Promise.race([again.then(() => true), sleep(RECORD_WAIT_MS).then(() => false)]);
	assert.ok(answered, "the resume answers");
	const until = Date.now() + RECORD_WAIT_MS;
	while (!h.runs.some((run) => run.task.includes("second resume message")) && Date.now() < until) await sleep(10);
	assert.ok(
		h.runs.some((run) => run.task.includes("second resume message")),
		"and starts it",
	);
	first.resolve();
	await Promise.race([launched, sleep(RECORD_WAIT_MS)]);
});

test("a launched child paused while it waits for its run's slot keeps the hold on what is sent to it until it starts", async () => {
	const h = harness();
	const aGate = Promise.withResolvers<void>();
	const qGate = Promise.withResolvers<void>();
	h.finishOn.set("hold-a-task", aGate);
	h.finishOn.set("hold-q-task", qGate);
	cleanups.push(async () => {
		aGate.resolve();
		qGate.resolve();
	});
	const launched = h.call({
		tasks: [
			{ agent: "worker", task: "hold-a-task" },
			{ agent: "worker", task: "hold-q-task" },
		],
		concurrency: 1,
	});
	const children = () =>
		[...readSubagentChildRecords(h.sessionManager.getEntries()).values()].sort(
			(left, right) => left.index - right.index,
		);
	const deadline = Date.now() + RECORD_WAIT_MS;
	while (children().length < 2 && Date.now() < deadline) await sleep(10);
	const [childA, childQ] = children();
	assert.ok(childA && childQ);
	await h.waitForLatest(childA.childId, (candidate) => !!candidate.childSessionId && candidate.state === "running");
	const startHolds = h.startHolds.map((hold) => hold.reserve);

	await h.call({ action: "pause", id: childQ.childId });

	const released = h.holds.filter((hold) => "release" in hold && startHolds.includes(hold.release));
	assert.deepEqual(released, [], "its pause releases no start hold, so what is sent to it waits for it");
	aGate.resolve();
	qGate.resolve();
	await Promise.race([launched, sleep(RECORD_WAIT_MS)]);
});
