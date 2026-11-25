import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { DetachedToolCall, DetachedToolResult } from "@bastani/atomic";
import { Agent } from "@bastani/atomic-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream } from "@bastani/atomic-ai/compat";
import { stripTerminalSequences } from "@bastani/atomic-tui";
import { afterEach, test, vi } from "vitest";
import {
	AgentWakeDispatcher,
	agentWakeDispatcher,
} from "../../packages/coding-agent/src/core/agent-wake-dispatcher.js";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.js";
import {
	bindBuiltinChildRecordSession,
	installBuiltinChildRecordWriter,
} from "../../packages/coding-agent/src/core/extensions/builtin-subagent-record-writer.js";
import { createExtensionRuntime } from "../../packages/coding-agent/src/core/extensions/loader-runtime.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { FINISHED_TASK_RETENTION } from "../../packages/coding-agent/src/core/tasks/eviction-error.js";
import { taskHostStateSizesForTesting } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import {
	RELEASED_CHILD_REPLY_EVENT,
	type ReleasedChildReplyRequest,
} from "../../packages/intercom/released-reply-wait.js";
import { renderSubagentToolResult } from "../../packages/subagents/src/extension/tool-rendering.js";
import { SUBAGENT_SUPERVISOR_AUTHORIZATION_EVENT } from "../../packages/subagents/src/intercom/supervisor-authorization.js";
import { isReleasedChildError } from "../../packages/subagents/src/runs/foreground/released-child-errors.js";
import {
	endedChildMark,
	releasedChildReservation,
	reserveReleasedChildrenOf,
} from "../../packages/subagents/src/runs/foreground/released-child-reservations.js";
import {
	bindResumeDispatcher,
	releasedChildWakeDecided,
	resumeReleasedChild,
	resumeWaiterCount,
	settleReleasedChildRelaunch,
} from "../../packages/subagents/src/runs/foreground/released-child-resume.js";
import {
	bindReleasedChildWakes,
	RELEASED_CHILD_WAKE_FAILURE_LABEL,
} from "../../packages/subagents/src/runs/foreground/released-child-wakes.js";
import {
	handleReleasedChildWakes,
	interruptedStillRunningResult,
	SUBAGENT_OWNER_GENERATION,
	SUBAGENT_RELEASE_AFTER_MS,
	SUBAGENT_RELEASED_WAKE_PROMPT,
	SUBAGENT_STILL_RUNNING_RESULT,
	subagentWakeKey,
} from "../../packages/subagents/src/runs/foreground/released-children.js";
import {
	bindSubagentChildCards,
	observeSubagentChildRecord,
	subagentChildRecordOf,
} from "../../packages/subagents/src/runs/foreground/subagent-child-card-state.js";
import { bindSubagentChildOwner } from "../../packages/subagents/src/runs/foreground/subagent-child-owner.js";
import {
	createSubagentChildRecordSink,
	currentWakeFailure,
	isSubagentChildRecord,
	readSubagentChildRecords,
	recordSubagentChildHeldToolResults,
	SUBAGENT_CHILD_RECORD_TYPE,
	SUBAGENT_CHILD_RELEASED_STATUS,
	type SubagentChildRecord,
	subagentChildRecordsAppended,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import {
	restoreSubagentChild,
	SUBAGENT_AWAIT_INTERCOM_PEER_EVENT,
	SUBAGENT_RESERVE_RESTORING_CHILD_EVENT,
} from "../../packages/subagents/src/runs/foreground/subagent-child-restore.js";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import {
	SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT,
	subagentChildrenAwaitingResume,
} from "../../packages/subagents/src/runs/foreground/subagent-run-control.js";
import { createExecutionScheduler } from "../../packages/subagents/src/runs/shared/parallel-utils.js";
import * as worktrees from "../../packages/subagents/src/runs/shared/worktree.js";
import * as artifactStorage from "../../packages/subagents/src/shared/artifacts.js";
import type { RunSyncOptions, SubagentToolResult } from "../../packages/subagents/src/shared/types.js";
import { heldAsArrived } from "../helpers/held-tool-results.js";
import { sleep } from "../helpers/runtime.js";
import { drained, waitForWakeCompletion } from "../helpers/wake-completion.js";
import { theme } from "./subagents-render-stability-helpers.js";
import {
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
	RELEASED_CALL,
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

test("wait and status do not report a hold on a removed worktree when a dirty sibling resumes (#5600)", async () => {
	const h = harness();
	initGitRepository(h.cwd);
	const first = Promise.withResolvers<void>();
	const last = Promise.withResolvers<void>();
	const resumed = Promise.withResolvers<void>();
	h.finishOn.set("pause-this", first);
	h.finishOn.set("finish-this", last);
	h.finishOn.set(SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT, resumed);
	const [a, b] = await launchWorktreeRun(h, ["pause-this", "finish-this"]);
	assert.ok(a && b?.taskId);
	let resumedId: string | undefined;
	try {
		await h.waitForLatest(a.childId, (record) => !!record.childSessionId);
		await h.waitForLatest(b.childId, (record) => !!record.childSessionId);
		writeFileSync(join(a.cwd, "draft.txt"), "still editing\n");
		await h.call({ action: "pause", id: a.childId });
		await h.waitForLatest(a.childId, (record) => record.terminalStatus === "paused");
		last.resolve();
		await settled(h, b.taskId);
		await waitForWorktreeCleanup(h, b);

		resumedId = resumedTaskId(await h.call({ action: "resume", id: a.childId }));
		await h.waitForLatest(a.childId, (record) => record.taskId === resumedId && !!record.childSessionId);
		assert.equal(taskExecutionKind(h, resumedId), "running");
		assert.equal(existsSync(a.cwd), true);
		assert.equal(existsSync(b.cwd), false);
		for (const action of ["wait", "status"] as const) {
			const reply = text(await h.call({ action, id: b.taskId }));
			assert.match(reply, /\(completed, 8 bytes\):[\s\S]*finished$/);
			assert.doesNotMatch(reply, /worktree kept until/i);
		}
	} finally {
		first.resolve();
		last.resolve();
		resumed.resolve();
		if (resumedId) await settled(h, resumedId);
	}
});

test("waiting for a finished child checks a batch sweep already started by its sibling (#5600)", async () => {
	const h = harness();
	initGitRepository(h.cwd);
	const first = Promise.withResolvers<void>(),
		last = Promise.withResolvers<void>();
	h.finishOn.set("first-child", first);
	h.finishOn.set("last-child", last);
	const [a, b] = await launchWorktreeRun(h, ["first-child", "last-child"]);
	assert.ok(a?.taskId && b?.taskId);
	await h.waitForLatest(a.childId, (record) => !!record.childSessionId);
	first.resolve();
	await settled(h, a.taskId);
	const held = await h.call({ action: "wait", id: a.taskId });
	assert.match(text(held), /worktree kept until the other children in this batch finish/i);
	const reached = Promise.withResolvers<void>(),
		proceed = Promise.withResolvers<void>();
	const capture = worktrees.diffWorktrees;
	const gate = vi.spyOn(worktrees, "diffWorktrees").mockImplementation(async (...args) => {
		reached.resolve();
		await proceed.promise;
		return capture(...args);
	});
	try {
		last.resolve();
		await reached.promise;
		const turn = new AbortController();
		const interrupted = h.call({ action: "wait", id: a.taskId }, turn.signal);
		setImmediate(() => turn.abort());
		const escaped = await answeredWithin(interrupted);
		assert.ok(escaped, "Esc ends a waiting observation even after the host task settled");
		assert.match(text(escaped), /worktree cleanup.*background/i);
		const observing = h.call({ action: "wait", id: a.taskId });
		setImmediate(proceed.resolve);
		const reply = await observing;
		assert.equal(existsSync(a.cwd), false, "the already-running batch sweep finished before wait replied");
		assert.doesNotMatch(text(reply), /worktree kept until/i);
	} finally {
		proceed.resolve();
		gate.mockRestore();
		last.resolve();
		await settled(h, b.taskId);
		await waitForWorktreeCleanup(h, a);
	}
});

function listedWorktrees(h: Harness): string[] {
	return gitOutput(h.cwd, ["worktree", "list", "--porcelain"])
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length).trimEnd());
}

function launchCard(h: Harness, launch: SubagentToolResult, args: Parameters<Harness["call"]>[0], expanded: boolean) {
	initTheme("dark", false);
	const card = renderSubagentToolResult(launch, { expanded, isPartial: false }, theme, {
		state: {},
		toolCallId: "launch",
		args,
		invalidate() {},
		getTaskRecord: (id) => h.host.taskRecords(new Set([id]))[0],
	});
	return () => card.render(160).map(stripTerminalSequences).join("\n");
}

test("a batch whose children failed to start reports only their errors after both worktrees are removed (#5600)", async () => {
	const h = harness();
	initGitRepository(h.cwd);
	const reasons = ["First authorization timed out", "Second authorization timed out"];
	const requests: PromiseWithResolvers<never>[] = [];
	const emit = h.deps.pi.events.emit.bind(h.deps.pi.events);
	const auth = vi.spyOn(h.deps.pi.events, "emit").mockImplementation((channel, data) => {
		if (channel !== SUBAGENT_SUPERVISOR_AUTHORIZATION_EVENT) return emit(channel, data);
		const request = Promise.withResolvers<never>();
		requests.push(request);
		(data as { completion?: Promise<never> }).completion = request.promise;
	});
	const args = { tasks: ["first", "second"].map((task) => ({ agent: "worker", task })), worktree: true };
	try {
		const pending = h.call(args);
		await vi.waitFor(() => assert.equal(requests.length, 2), { timeout: RECORD_WAIT_MS });
		const checkouts = listedWorktrees(h);
		assert.equal(checkouts.length, 3);
		requests[0]!.reject(new Error(reasons[0]));
		await new Promise<void>((resolve) => setImmediate(resolve)); // The second reservation still holds both trees.
		requests[1]!.reject(new Error(reasons[1]));
		const launch = await pending;
		assert.equal(launch.isError, true);
		assert.equal(h.runs.length, 0);
		assert.equal(listedWorktrees(h).length, 1);
		assert.equal(checkouts.filter((path) => existsSync(path)).length, 1);
		const response = launch.details?.taskResponse;
		assert.ok(response?.kind === "parallel");
		assert.deepEqual(
			response.slots.map(({ outcome }) => outcome),
			reasons.map((message) => ({
				kind: "unstarted",
				reason: { kind: "rejected", error: { code: "SpawnFailed", message } },
			})),
		);
		for (const observed of [text(launch), launchCard(h, launch, args, true)()]) {
			for (const reason of reasons) assert.ok(observed.includes(reason), observed);
			assert.doesNotMatch(observed, /worktree kept until/i);
		}
	} finally {
		auth.mockRestore();
	}
});

test("a failed launch reports the worktree hold separately and drops it when its sibling finishes (#5600)", async () => {
	const h = harness();
	initGitRepository(h.cwd);
	bindSubagentChildCards(h.ctx);
	const reason = "Launch not authorized";
	h.host.updateBinding({
		authorizeLaunch(intent) {
			if (intent.task === "refused") throw new Error(reason);
		},
	});
	const finish = Promise.withResolvers<void>();
	h.finishOn.set("admitted", finish);
	const args = { tasks: ["refused", "admitted"].map((task) => ({ agent: "worker", task })), worktree: true };
	const hold = /Worktree kept until the other children in this batch finish\./;
	try {
		const launch = await h.call(args);
		assert.notEqual(launch.isError, true, text(launch));
		const response = launch.details?.taskResponse;
		assert.ok(response?.kind === "parallel");
		const sibling = response.slots[1]?.outcome;
		assert.ok(sibling?.kind === "admitted");
		const checkouts = listedWorktrees(h);
		assert.equal(checkouts.length, 3);
		const cards = [false, true].map((expanded) => launchCard(h, launch, args, expanded));
		assert.match(text(launch), hold);
		for (const paint of cards) assert.match(paint(), hold);
		finish.resolve();
		await settled(h, sibling.observation.taskId);
		assert.equal(listedWorktrees(h).length, 1);
		assert.equal(checkouts.filter((path) => existsSync(path)).length, 1);
		for (const paint of cards) {
			const replay = paint();
			assert.match(replay, /Launch not authorized/);
			assert.match(replay, /Done/);
			assert.doesNotMatch(replay, hold);
		}
		assert.deepEqual(response.slots[0]?.outcome, {
			kind: "unstarted",
			reason: { kind: "rejected", error: { code: "SpawnFailed", message: reason } },
		});
	} finally {
		finish.resolve();
	}
});

test("the original launch card shows the answers after the last sibling releases the batch worktrees (#5600)", async () => {
	const h = harness();
	initGitRepository(h.cwd);
	bindSubagentChildCards(h.ctx);
	initTheme("dark", false);
	const first = Promise.withResolvers<void>();
	const last = Promise.withResolvers<void>();
	h.finishOn.set("first-to-finish", first);
	h.finishOn.set("last-to-finish", last);
	const args = {
		tasks: ["first-to-finish", "last-to-finish"].map((task) => ({ agent: "worker", task })),
		worktree: true,
	};
	const launch = await h.call(args);
	assert.notEqual(launch.isError, true, text(launch));
	try {
		const [a, b] = await vi.waitFor(
			() => {
				const records = [...readSubagentChildRecords(h.sessionManager.getEntries()).values()].sort(
					(a, b) => a.index - b.index,
				);
				assert.equal(records.filter((record) => record.childSessionId).length, 2);
				return records;
			},
			{ timeout: RECORD_WAIT_MS },
		);
		assert.ok(a?.taskId && b?.taskId);
		writeFileSync(join(a.cwd, "first-result.txt"), "first child's deliverable\n");
		first.resolve();
		await settled(h, a.taskId);
		assert.ok(existsSync(a.cwd));
		last.resolve();
		await settled(h, b.taskId);
		assert.equal(existsSync(a.cwd) || existsSync(b.cwd), false);
		const card = renderSubagentToolResult(launch, { expanded: true, isPartial: false }, theme, {
			state: {},
			toolCallId: "launch",
			args,
			invalidate() {},
			getTaskRecord: (id) => h.host.taskRecords(new Set([id]))[0],
		})
			.render(160)
			.map(stripTerminalSequences)
			.join("\n");
		assert.equal(occurrences(card, "Done"), 2);
		assert.equal(occurrences(card, "finished"), 2);
		assert.doesNotMatch(card, /worktree kept until the other children in this batch finish/i);
		for (const action of ["wait", "status"] as const) {
			const reply = text(await h.call({ action, id: a.taskId }));
			assert.doesNotMatch(reply, /worktree kept until/i);
			assert.match(reply, /\(completed, 8 bytes\):[\s\S]*finished$/);
			assert.match(reply, /"byteCount":"8"/, "the output reference counts only the child's answer");
		}
	} finally {
		first.resolve();
		last.resolve();
	}
});

test(
	"coalesced SDK calls return only their own answers while Git is saving a worktree patch (#5600)",
	async () => {
		const h = harness({
			ownerless: true,
			answer: (task) => (task.includes("first-child") ? "answer alpha" : "answer beta"),
		});
		initGitRepository(h.cwd);
		const first = Promise.withResolvers<void>();
		const last = Promise.withResolvers<void>();
		h.finishOn.set("first-child", first);
		h.finishOn.set("last-child", last);
		const { execute } = createSubagentExecutor(h.deps);
		const signal = new AbortController().signal;
		const replies = Promise.all(
			["first-child", "last-child"].map((task) =>
				execute(task, { agent: "worker", task, worktree: true }, signal, undefined, h.ctx),
			),
		);
		let filter: ReturnType<typeof holdGitFilter> | undefined;
		try {
			const [a, b] = await vi.waitFor(
				() => {
					const records = [...readSubagentChildRecords(h.sessionManager.getEntries()).values()].sort(
						(a, b) => a.index - b.index,
					);
					assert.equal(records.filter((record) => record.childSessionId).length, 2);
					return records;
				},
				{ timeout: RECORD_WAIT_MS },
			);
			assert.ok(a && b);
			assert.equal(a.runId, b.runId);
			filter = holdGitFilter(h.cwd, "*.slow");
			writeFileSync(join(a.cwd, "result.slow"), "save this edit\n");
			first.resolve();
			await h.waitForLatest(a.childId, (record) => record.state === "terminal");
			last.resolve();
			await filter.started();
			const results = await replies;
			filter.release();
			await waitForWorktreeCleanup(h, a);
			await waitForWorktreeCleanup(h, b);
			for (const [index, reply] of results.entries()) {
				assert.deepEqual(
					reply.details.results.map((child) => child.finalOutput),
					[index ? "answer beta" : "answer alpha"],
				);
				// The first child released its hold while its sibling ran. Only the last child's
				// public result is still pending when this observation hits its cleanup deadline.
				assert.match(text(reply), index ? /^0\/1 succeeded/ : /^1\/1 succeeded/);
				assert.match(text(reply), /worktree cleanup continues in the background/i);
				assert.match(text(reply), index ? /answer beta/ : /answer alpha/);
				assert.doesNotMatch(text(reply), index ? /answer alpha/ : /answer beta/);
			}
		} finally {
			filter?.release();
			first.resolve();
			last.resolve();
			await replies;
		}
	},
	LAUNCH_QUIT_RESUME_TIMEOUT_MS,
);

test("an SDK foreground batch reports when its child's worktree sweep is still running (#5600)", async () => {
	const h = harness({ ownerless: true });
	initGitRepository(h.cwd);
	const done = Promise.withResolvers<void>();
	h.finishOn.set("sdk-sweeping", done);
	const batch = h.call({ tasks: [{ agent: "worker", task: "sdk-sweeping" }], worktree: true });
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
	const capture = worktrees.diffWorktrees;
	const reached = Promise.withResolvers<void>(),
		proceed = Promise.withResolvers<void>();
	const gate = vi.spyOn(worktrees, "diffWorktrees").mockImplementation(async (...args) => {
		reached.resolve();
		await proceed.promise;
		return capture(...args);
	});
	try {
		const quitting = h.call({ action: "quit", id: child.childId });
		await reached.promise;
		const [reply, stopped] = await Promise.all([batch, quitting]);
		assert.match(text(stopped), /worktree cleanup.*background/i);
		assert.match(text(reply), /worktree cleanup.*background/i);
		assert.equal(reply.details.results[0]?.status, "continued");
		assert.equal(h.latest(child.childId)?.state, "running");
	} finally {
		proceed.resolve();
		gate.mockRestore();
		done.resolve();
		await waitForWorktreeCleanup(h, child);
	}
});

test("an SDK foreground batch reports its children's final worktree state, not a hold from when the first one finished (#5600)", async () => {
	const h = harness({ ownerless: true });
	initGitRepository(h.cwd);
	const first = Promise.withResolvers<void>(),
		second = Promise.withResolvers<void>();
	h.finishOn.set("first-to-finish", first);
	h.finishOn.set("second-to-finish", second);
	const batch = h.call({
		tasks: [
			{ agent: "worker", task: "first-to-finish" },
			{ agent: "worker", task: "second-to-finish" },
		],
		worktree: true,
	});
	try {
		const [a, b] = await vi.waitFor(
			() => {
				const records = [...readSubagentChildRecords(h.sessionManager.getEntries()).values()].sort(
					(left, right) => left.index - right.index,
				);
				assert.equal(records.filter((record) => record.childSessionId).length, 2);
				return records;
			},
			{ timeout: RECORD_WAIT_MS },
		);
		assert.ok(a && b);
		writeFileSync(join(a.cwd, "first-result.txt"), "first child's deliverable\n");
		first.resolve();
		await h.waitForLatest(a.childId, (record) => record.state === "terminal");
		second.resolve();
		const reply = text(await batch);
		assert.equal(existsSync(a.cwd) || existsSync(b.cwd), false, "both worktrees are gone at reply");
		assert.match(reply, /^2\/2 succeeded/);
		assert.match(reply, /Worktree Changes[\s\S]*first-result\.txt/);
		assert.doesNotMatch(reply, /worktree kept until the other children in this batch finish/i);
	} finally {
		first.resolve();
		second.resolve();
		await batch;
	}
});

test("a filter helper can use finishing without waiting for the child's completed task (#5600)", async () => {
	const h = harness();
	initGitRepository(h.cwd);
	const done = Promise.withResolvers<void>();
	h.finishOn.set("filtered", done);
	const [child] = await launchWorktreeRun(h, ["filtered"]);
	assert.ok(child?.taskId);
	const taskId = child.taskId;
	await h.waitForLatest(child.childId, (record) => !!record.childSessionId);
	const filter = holdGitFilter(h.cwd, "*.slow");
	writeFileSync(join(child.cwd, "deliverable.slow"), "preserve this edit\n");
	const phases: unknown[] = [];
	const events = h.deps.pi.events;
	const emit = events.emit.bind(events);
	const observer = vi.spyOn(events, "emit").mockImplementation((channel, data) => {
		emit(channel, data);
		if (channel === "subagent:finishing") phases.push(data);
	});
	const completion = settled(h, taskId);
	done.resolve();
	try {
		await filter.started();
		assert.deepEqual(phases, [{ runId: child.runId, index: child.index, taskId, cwd: child.cwd, status: "ok" }]);
		assert.equal(filter.phase(), "finishing");
		const saved = h.sessionManager
			.getEntries()
			.filter(isSubagentChildRecord)
			.findLast((entry) => entry.data?.taskId === taskId);
		assert.equal(
			saved?.data?.terminalStatus,
			"ok",
			"a restart has the original outcome and never relaunches the child",
		);
		assert.notEqual(taskExecutionKind(h, taskId), "settled");
		assert.equal(h.latest(child.childId)?.state, "running");
		const script = createSubagentExecutor(h.deps);
		const scriptContext = { ...h.ctx, parentToolCallId: "codemode" };
		const scriptWait = (budgetMs: number) =>
			script.execute(
				"script-wait",
				{ action: "wait", id: taskId, budgetMs },
				new AbortController().signal,
				undefined,
				scriptContext,
			);
		const pending = JSON.parse(text(await scriptWait(0)));
		assert.equal(pending.outcome, "running");
		assert.match(pending.worktreeNote, /cleanup continues in the background/i);
		const status = await script.execute(
			"script-status",
			{ action: "status", id: taskId },
			new AbortController().signal,
			undefined,
			scriptContext,
		);
		const [scriptChild] = JSON.parse(text(status)).children;
		assert.equal(scriptChild.state, "finishing");
		assert.equal(scriptChild.resumable, false);
		const lateStop = h.host.cancelTask(taskId as TaskId, "user");
		filter.release();
		await completion;
		assert.equal(existsSync(child.cwd), false);
		const stopped = await lateStop;
		assert.ok(
			stopped.ok && stopped.value.decision !== "cancellation-requested",
			"a finished runner cannot be killed during Git",
		);
		const published = await h.host.waitForTask(taskId as TaskId);
		assert.ok(published.ok && published.value.kind === "settled" && published.value.result.kind === "completed");
		const scriptReply = JSON.parse(text(await scriptWait(0)));
		assert.equal(scriptReply.outcome, "settled");
		assert.equal(scriptReply.result.output, "finished");
		assert.equal(scriptReply.worktreeNote, undefined);
		assert.match(readFileSync(savedPatches(child)[0]!, "utf8"), /\+preserve this edit/);
	} finally {
		filter.release();
		await completion;
		await waitForWorktreeCleanup(h, child);
		observer.mockRestore();
	}
});

test("closing the owner during Git leaves the child finishing without holding the session open (#5600)", async () => {
	const h = harness();
	initGitRepository(h.cwd);
	const done = Promise.withResolvers<void>();
	h.finishOn.set("close-during-capture", done);
	const [a] = await launchWorktreeRun(h, ["close-during-capture"]);
	assert.ok(a?.taskId);
	await h.waitForLatest(a.childId, (record) => !!record.childSessionId);
	const filter = holdGitFilter(h.cwd, "*.slow");
	writeFileSync(join(a.cwd, "result.slow"), "keep this answer\n");
	const terminal = settled(h, a.taskId);
	done.resolve();
	await filter.started();
	const closing = h.host.close("session-close");
	try {
		const closed = await answeredWithin(closing);
		assert.ok(closed?.ok, "the owner's session closes while Git is still waiting");
		const finishing = closed.value.tasks.find((task) => task.taskId === a.taskId);
		assert.equal(finishing?.decision, "already-finishing");
		assert.notEqual(finishing?.execution.kind, "settled");
		assert.ok(existsSync(a.cwd));
	} finally {
		filter.release();
		await Promise.all([closing, terminal]);
	}
	assert.equal(existsSync(a.cwd), false);
});

function rejectChildInput(h: Harness, prepare?: (cwd: string) => void) {
	const refused = Promise.withResolvers<{ childId: string; error: Error; span: RunSyncOptions["elapsedSpan"] }>();
	const storage = vi.spyOn(artifactStorage, "getArtifactsDir").mockResolvedValue(join(h.cwd, "artifacts"));
	cleanups.push(async () => {
		storage.mockRestore();
	});
	const runSync = h.deps.runtime!.runSync!;
	const { execute } = createSubagentExecutor({
		...h.deps,
		runtime: {
			...h.deps.runtime,
			async runSync(cwd, agents, agent, task, options) {
				if (!task.includes("refuse-input")) return runSync(cwd, agents, agent, task, options);
				assert.ok(options.artifactsDir && options.cwd);
				const paths = artifactStorage.getArtifactPaths(options.artifactsDir, options.runId, agent, options.index);
				mkdirSync(paths.inputPath, { recursive: true });
				prepare?.(options.cwd);
				try {
					return await runSync(cwd, agents, agent, task, options);
				} catch (error) {
					assert.ok(error instanceof Error);
					refused.resolve({
						childId: `${options.runId}:${options.index}`,
						error,
						span: options.elapsedSpan && { ...options.elapsedSpan },
					});
					throw error;
				}
			},
		},
	});
	return {
		launch: (...tasks: string[]) =>
			execute(
				"input",
				{ tasks: tasks.map((task) => ({ agent: "worker", task })), worktree: true },
				new AbortController().signal,
				undefined,
				h.ctx,
			),
		refused: refused.promise,
	};
}

for (const sibling of ["finishes", "hands off"] as const)
	test(`an SDK startup rejection keeps its original reason when a sibling ${sibling} (#5600)`, async () => {
		const h = harness({ ownerless: true });
		initGitRepository(h.cwd);
		const done = Promise.withResolvers<void>();
		h.finishOn.set("live-sibling", done);
		const sdk = rejectChildInput(h);
		const batch = sdk.launch("refuse-input", "live-sibling");
		const { childId, error } = await sdk.refused;
		const failed = await h.waitForLatest(childId, (r) => r.terminalStatus === "error");
		try {
			if (sibling === "finishes") done.resolve();
			else {
				await h.waitForLatest(`${failed.runId}:1`, (r) => !!r.childSessionId);
				const handoff = h.runs.find((r) => r.task.includes("live-sibling"))?.options.onIntercomDetachCommit;
				assert.ok(handoff);
				handoff();
			}
			const reply = await batch;
			const rejection = reply.details.results[0]?.taskResponse;
			assert.match(error.message, /EISDIR|EPERM/);
			assert.deepEqual(rejection, {
				kind: "unstarted",
				reason: { kind: "rejected", error: { code: "SpawnFailed", message: error.message } },
			});
			const hold = /worktree kept until/i;
			assert.equal(hold.test(text(reply)), sibling === "hands off");
			const args = {
				tasks: ["refuse-input", "live-sibling"].map((task) => ({ agent: "worker", task })),
				worktree: true,
			};
			const cards = [false, true].map((expanded) => launchCard(h, reply, args, expanded));
			for (const paint of cards) assert.equal(hold.test(paint()), sibling === "hands off");
			done.resolve();
			await waitForWorktreeCleanup(h, failed);
			for (const paint of cards) assert.doesNotMatch(paint(), hold);
		} finally {
			done.resolve();
			await batch;
			await waitForWorktreeCleanup(h, failed);
		}
	});

test("an admitted host failure keeps the original error after its sibling releases the worktrees (#5600)", async () => {
	const h = harness();
	initGitRepository(h.cwd);
	const done = Promise.withResolvers<void>();
	h.finishOn.set("live-sibling", done);
	const host = rejectChildInput(h);
	const launch = host.launch("refuse-input", "live-sibling");
	try {
		await launch;
		const { childId, error } = await host.refused;
		assert.match(error.message, /EISDIR|EPERM/);
		const failed = await h.waitForLatest(childId, (r) => r.terminalStatus === "error");
		assert.ok(failed.taskId);
		const held = await h.call({ action: "wait", id: failed.taskId });
		done.resolve();
		await waitForWorktreeCleanup(h, failed);
		const replay = await h.call({ action: "wait", id: failed.taskId });
		for (const reply of [replay, held]) {
			const response = reply.details.taskResponse;
			assert.ok(response?.kind === "admitted" && response.observation.kind === "settled");
			assert.deepEqual(response.observation.result, {
				kind: "failed",
				code: "RunnerFailed",
				message: error.message,
			});
		}
		assert.match(text(held), /worktree kept until/i);
		assert.doesNotMatch(text(replay), /worktree kept until/i);
	} finally {
		done.resolve();
		await launch;
	}
});

test("an SDK input write failure stops the execution clock before Git captures the worktree (#5600)", async () => {
	const h = harness({ ownerless: true });
	initGitRepository(h.cwd);
	const filter = holdGitFilter(h.cwd, "*.slow");
	const sdk = rejectChildInput(h, (cwd) => writeFileSync(join(cwd, "edited.slow"), "save this edit\n"));
	const batch = sdk.launch("refuse-input");
	try {
		const { childId, error, span } = await sdk.refused;
		assert.match(error.message, /EISDIR|EPERM/);
		await filter.started();
		const duringCleanup = Date.now();
		await vi.waitFor(() => assert.ok(Date.now() > duringCleanup));
		filter.release();
		await batch;
		const record = await h.waitForLatest(childId, (r) => r.terminalStatus === "error");
		assert.deepEqual(record.elapsedSpan, span, "publication preserves the runner's original span");
		assert.ok(record.elapsedSpan && record.elapsedMs !== undefined);
		assert.ok(
			record.elapsedMs <= duringCleanup - record.elapsedSpan.dispatchedAt,
			`recorded ${record.elapsedMs} ms, but Git was already running ${duringCleanup - record.elapsedSpan.dispatchedAt} ms after dispatch`,
		);
	} finally {
		filter.release();
		await batch;
	}
});

/** Whether a woken run reads `result` in its late-result notice, never as a message. */
function readsLate(
	run: { readonly task: string; readonly options: RunSyncOptions } | undefined,
	result: DetachedToolResult,
): boolean {
	return run?.options.resumeLateToolResults?.some((late) => isDeepStrictEqual(late, result)) === true;
}

function waitResult(text: string) {
	return {
		toolCallId: RELEASED_CALL.toolCallId,
		toolName: RELEASED_CALL.toolName,
		result: { content: [{ type: "text" as const, text }], details: undefined },
		isError: false,
	};
}

test("a background child released while it waits is recorded released, settles as a resumable stop, and stays addressable (#4326)", async () => {
	const h = harness();
	h.releaseOriginal = true;
	const taskId = await h.admit("release1", undefined, { intercomEvents: h.deps.pi.events });
	await settled(h, taskId);
	const released = await h.waitForLatest("release1:0", (record) => record.state === "terminal");

	assert.equal(released.terminalStatus, SUBAGENT_CHILD_RELEASED_STATUS);
	assert.deepEqual(released.waitingOn, [RELEASED_CALL]);
	const observed = await h.host.waitForTask(taskId);
	assert.ok(observed.ok && observed.value.kind === "settled");
	assert.deepEqual(
		observed.value.kind === "settled" && observed.value.result.kind === "cancelled"
			? observed.value.result.cause
			: undefined,
		"pause",
	);
	assert.equal(h.runs[0]?.options.releaseWhenWaiting?.afterMs, SUBAGENT_RELEASE_AFTER_MS);
	await h.waitForLatest("release1:0", () => h.releasedChildRequests.length > 0);
	assert.deepEqual(h.releasedChildRequests, [
		{
			reserve: [
				{
					childName: "subagent-worker-release1",
					group: "lane-group",
					aliases: [released.childSessionId],
					wake: true,
				},
			],
		},
	]);
	assert.deepEqual([h.holds, h.authorizations], [[], []], "no capability was minted for a released child");

	const status = subagentChildrenAwaitingResume(h.ctx, "release1:0");
	assert.equal(status.length, 1);
	assert.match(status[0] ?? "", /released · waiting on wait_for_ci \(ci-1\)/);
});

test("pause and quit of a released child only record the stop; resume continues it (#4326)", async () => {
	const h = harness();
	h.releaseOriginal = true;
	await settled(h, await h.admit("release2"));
	await h.waitForLatest("release2:0", (record) => record.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS);
	const runsBefore = h.runs.length;

	const paused = await h.call({ action: "pause", id: "release2:0" });
	assert.notEqual(paused.isError, true, text(paused));
	assert.equal(paused.details.runControl?.children[0]?.state, "paused");
	assert.match(text(paused), /Paused released worker/);
	assert.equal(
		(await h.waitForLatest("release2:0", (record) => record.terminalStatus === "paused")).terminalStatus,
		"paused",
	);

	const quit = await h.call({ action: "quit", id: "release2:0" });
	assert.notEqual(quit.isError, true, text(quit));
	assert.equal(
		(await h.waitForLatest("release2:0", (record) => record.terminalStatus === "quit")).terminalStatus,
		"quit",
	);
	assert.equal(h.runs.length, runsBefore, "stopping a released child runs nothing");

	const resumed = await h.call({ action: "resume", id: "release2:0", message: "carry on" });
	assert.notEqual(resumed.isError, true, text(resumed));
	await settled(h, resumedTaskId(resumed));
	assert.equal(h.runs.at(-1)?.task, "carry on");
	assert.equal(h.runs.at(-1)?.options.resumeSession, true);
	assert.deepEqual(
		h.runs.at(-1)?.options.resumeToolResults,
		[],
		"a stopped released child still continues the turn it waited in",
	);
});

/** More released children than an owner keeps finished tasks for, so a record kept per released child fails. */
const RELEASED_PAST_RETENTION = FINISHED_TASK_RETENTION + 16;

/** Hundreds of real child sessions, each released and its native task settled, one after another. */
const RELEASED_PAST_RETENTION_TIMEOUT_MS = 120_000;

/** How long the owner's host may take to evict the last released children's records once their cleanup is reaped. */
const RETENTION_CONVERGE_MS = 20_000;

test(
	"released children keep no task record past the owner's retention, and the earliest still resumes (#4326)",
	async () => {
		const h = harness();
		h.releaseOriginal = true;
		const { owner } = h.host.ownerBinding;
		const processWide = taskHostStateSizesForTesting(owner);
		for (let index = 0; index < RELEASED_PAST_RETENTION; index++) {
			await settled(h, await h.admit(`retained${index}`));
			await h.waitForLatest(
				`retained${index}:0`,
				(record) => record.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS,
			);
		}

		const deadline = Date.now() + RETENTION_CONVERGE_MS;
		while (taskHostStateSizesForTesting(owner).tasks > FINISHED_TASK_RETENTION) {
			assert.ok(Date.now() < deadline, `not converged: ${JSON.stringify(taskHostStateSizesForTesting(owner))}`);
			await sleep(10);
		}
		assert.deepEqual(taskHostStateSizesForTesting(owner), {
			tasks: FINISHED_TASK_RETENTION,
			settledTasks: FINISHED_TASK_RETENTION,
			quarantinedTasks: 0,
			unconfirmedCleanups: 0,
			permits: 0,
			commandStarts: 0,
			requestedModels: processWide.requestedModels,
			launchHeartbeats: processWide.launchHeartbeats,
			executionTimeouts: processWide.executionTimeouts,
			// A retained released child keeps what it waits on for its notice; an evicted one keeps nothing (#5031).
			releases: FINISHED_TASK_RETENTION,
			launchers: 0,
			launchedAt: 0,
		});

		const resumed = await h.call({ action: "resume", id: "retained0:0", message: "carry on" });
		assert.notEqual(resumed.isError, true, text(resumed));
		await settled(h, resumedTaskId(resumed));
		assert.equal(h.runs.at(-1)?.task, "carry on");
		assert.equal(h.runs.at(-1)?.options.resumeSession, true);
	},
	RELEASED_PAST_RETENTION_TIMEOUT_MS,
);

test("pause and quit with all: true include released children (#4326)", async () => {
	const h = harness();
	h.releaseOriginal = true;
	await settled(h, await h.admit("release3"));
	await h.waitForLatest("release3:0", (record) => record.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS);
	const paused = await h.call({ action: "pause", all: true });
	assert.notEqual(paused.isError, true, text(paused));
	assert.deepEqual(
		paused.details.runControl?.children.map((child) => [child.childId, child.state]),
		[["release3:0", "paused"]],
	);
});

test("a tool result wakes a released child through the dispatcher once, and a paused one keeps it for resume (#4326)", async () => {
	const h = harness();
	h.releaseOriginal = true;
	await settled(h, await h.admit("release4"));
	await h.waitForLatest("release4:0", (record) => record.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS);
	const dispatcher = new AgentWakeDispatcher();
	const stop = bindReleasedChildWakes(h.deps, h.ctx, h.deps.pi.events, dispatcher);
	cleanups.push(async () => stop());
	h.releaseOriginal = false;
	const key = subagentWakeKey(h.sessionManager.getSessionId(), "release4:0");
	const result = waitResult("CI green");

	const first = dispatcher.deliver(key, { id: "tool-result:ci-1", kind: "tool-result", toolResult: result });
	const again = dispatcher.deliver(key, { id: "tool-result:ci-1", kind: "tool-result", toolResult: result });
	await Promise.all([first, again]);

	const wakes = h.runs.filter((run) => readsLate(run, result));
	assert.equal(wakes.length, 1, "one wake, however often the same result is delivered");
	assert.equal(wakes[0]?.options.resumeSession, true);
	assert.equal(
		wakes[0]?.options.resumeFollowUps,
		undefined,
		"a wake by a result alone is not prompted to read anything",
	);
	assert.deepEqual(wakes[0]?.options.resumeToolResults, []);
	const woken = await h.waitForLatest(
		"release4:0",
		(record) => record.state === "terminal" && record.terminalStatus === "ok",
	);
	assert.deepEqual(woken.heldToolResults ?? [], []);
	assert.deepEqual(dispatcher.stats().keys, 0);

	h.releaseOriginal = true;
	await settled(h, await h.admit("release4b"));
	await h.waitForLatest("release4b:0", (record) => record.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS);
	h.releaseOriginal = false;
	await h.call({ action: "pause", id: "release4b:0" });
	await h.waitForLatest("release4b:0", (record) => record.terminalStatus === "paused");
	const runsWhilePaused = h.runs.length;
	const late = waitResult("second run green");
	await dispatcher.deliver(subagentWakeKey(h.sessionManager.getSessionId(), "release4b:0"), {
		id: "tool-result:late",
		kind: "tool-result",
		toolResult: late,
	});
	assert.equal(h.runs.length, runsWhilePaused, "a paused child is not woken");
	assert.deepEqual(heldAsArrived(h.latest("release4b:0")?.heldToolResults), [late]);
	assert.deepEqual(
		heldAsArrived(subagentChildRecordOf(h.sessionManager.getSessionId(), "release4b:0")?.heldToolResults),
		[late],
		"the child's index entry reads the record that holds the result",
	);

	const resumed = await h.call({ action: "resume", id: "release4b:0", message: "go on" });
	await settled(h, resumedTaskId(resumed));
	assert.ok(readsLate(h.runs.at(-1), late), "resume delivers the held result in its notice");
	assert.equal(h.runs.at(-1)?.task, "go on");
	assert.equal(h.runs.at(-1)?.options.resumeFollowUps, undefined);
	assert.equal(h.runs.at(-1)?.options.resumeNote?.text, SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT);
	const cleared = await h.waitForLatest(
		"release4b:0",
		(record) =>
			record.state === "terminal" && record.terminalStatus === "ok" && (record.heldToolResults ?? []).length === 0,
	);
	assert.deepEqual(cleared.heldToolResults, [], "the result the resumed run took is no longer held");
});

test("an Intercom wake restores a released child with the wake prompt; a live or ended child is not woken by it (#4326)", async () => {
	const h = harness();
	h.releaseOriginal = true;
	await settled(h, await h.admit("release5"));
	await h.waitForLatest("release5:0", (record) => record.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS);
	h.releaseOriginal = false;
	const dispatcher = new AgentWakeDispatcher();
	const unbind = bindReleasedChildWakes(h.deps, h.ctx, h.deps.pi.events, dispatcher);
	cleanups.push(async () => unbind());
	const key = subagentWakeKey(h.sessionManager.getSessionId(), "release5:0");

	await dispatcher.deliver(key, { id: "intercom:1", kind: "intercom" });
	assert.deepEqual(h.runs.at(-1)?.options.resumeNote, { kind: "wake", text: SUBAGENT_RELEASED_WAKE_PROMPT });
	assert.equal(h.runs.at(-1)?.task, "");
	await h.waitForLatest("release5:0", (record) => record.terminalStatus === "ok");
	const runs = h.runs.length;
	await dispatcher.deliver(key, { id: "intercom:2", kind: "intercom" });
	assert.equal(h.runs.length, runs, "a message for a child that is not released wakes nothing");
});

test("quit with all: true quits released children and leaves a woken child that settled out (#4326)", async () => {
	const h = harness();
	h.releaseOriginal = true;
	await settled(h, await h.admit("release6"));
	await settled(h, await h.admit("release6b"));
	await h.waitForLatest("release6b:0", (record) => record.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS);
	h.releaseOriginal = false;
	await settled(h, resumedTaskId(await h.call({ action: "resume", id: "release6b:0", message: "finish" })));
	await h.waitForLatest("release6b:0", (record) => record.state === "terminal" && record.terminalStatus === "ok");
	const quit = await h.call({ action: "quit", all: true });
	assert.deepEqual(
		quit.details.runControl?.children.map((child) => child.childId),
		["release6:0"],
	);
	assert.match(text(quit), /Quit released worker \(release6:0/);
	assert.doesNotMatch(text(quit), /release6b/, "a settled child is not a quit target");
});

test("a woken released child is running, not released: status leaves it out and pause stops its run (#4326)", async () => {
	const h = harness();
	h.releaseOriginal = true;
	await settled(h, await h.admit("release7"));
	await h.waitForLatest("release7:0", (record) => record.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS);
	h.releaseOriginal = false;
	h.resumedRunsWait = true;
	await h.call({ action: "resume", id: "release7:0", message: "keep going" });
	await h.waitForLatest("release7:0", (record) => record.state === "running");
	assert.deepEqual(subagentChildrenAwaitingResume(h.ctx, "release7:0"), []);
	const paused = await h.call({ action: "pause", id: "release7:0" });
	assert.doesNotMatch(text(paused), /released/);
	await h.waitForLatest("release7:0", (record) => record.state === "terminal" && record.terminalStatus === "paused");
});

test("status names every call a released child waits on, and shows one stored without them as waiting (#4326)", async () => {
	const h = harness();
	const base: SubagentChildRecord = {
		version: 1,
		runId: "stored",
		agent: "worker",
		state: "terminal",
		terminalStatus: SUBAGENT_CHILD_RELEASED_STATUS,
		cwd: h.cwd,
		owner: { kind: "session", sessionId: h.sessionManager.getSessionId() },
		childId: "stored:0",
		index: 0,
	};
	await h.sessionManager.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, {
		...base,
		waitingOn: [RELEASED_CALL, { toolCallId: "deploy-2", toolName: "deploy" }],
	});
	await h.sessionManager.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, {
		...base,
		childId: "stored:1",
		index: 1,
	});
	await h.sessionManager.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, {
		...base,
		childId: "stored:2",
		index: 2,
		terminalStatus: "ok",
	});
	const lines = subagentChildrenAwaitingResume(h.ctx);
	assert.equal(lines.length, 2, lines.join("\n"));
	assert.match(lines[0] ?? "", /released · waiting on wait_for_ci \(ci-1\), deploy \(deploy-2\); it holds nothing/);
	assert.match(lines[1] ?? "", /released · waiting; it holds nothing/);
	// A released child is not paused and needs no resume (#5031).
	assert.match(
		lines[0] ?? "",
		/it holds nothing and is not paused: it wakes by itself when that finishes.*needs no resume/,
	);
	assert.deepEqual(subagentChildrenAwaitingResume(h.ctx, "no-such-child:0"), []);
});

test("a wake holds its child's key until the woken run settles, even when an owner message yields the wait (#4326)", async () => {
	const h = harness();
	h.releaseOriginal = true;
	await settled(h, await h.admit("release8"));
	await h.waitForLatest("release8:0", (record) => record.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS);
	h.releaseOriginal = false;
	const gate = Promise.withResolvers<void>();
	h.finishOn.set(SUBAGENT_RELEASED_WAKE_PROMPT, gate);
	const dispatcher = new AgentWakeDispatcher();
	const unbind = bindReleasedChildWakes(h.deps, h.ctx, h.deps.pi.events, dispatcher);
	cleanups.push(async () => unbind());
	let handled = false;
	const wake = dispatcher
		.deliver(subagentWakeKey(h.sessionManager.getSessionId(), "release8:0"), { id: "intercom:1", kind: "intercom" })
		.then(() => {
			handled = true;
		});
	await h.waitForLatest("release8:0", (record) => record.state === "running");
	h.host.yieldTaskWaits("intercom-coordination");
	await sleep(50);
	assert.equal(handled, false, "the wake is handled only once the woken run settles");
	assert.equal(dispatcher.stats().running, 1);
	gate.resolve();
	await wake;
	assert.equal(h.latest("release8:0")?.terminalStatus, "ok");
});

test("a released child that can no longer be restored fails its wake with the reason (#4326)", async () => {
	const h = harness();
	h.releaseOriginal = true;
	await settled(h, await h.admit("release9"));
	await h.waitForLatest("release9:0", (record) => record.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS);
	h.releaseOriginal = false;
	h.agentDefined = false;
	const dispatcher = new AgentWakeDispatcher();
	const unbind = bindReleasedChildWakes(h.deps, h.ctx, h.deps.pi.events, dispatcher);
	cleanups.push(async () => unbind());
	const runs = h.runs.length;
	await assert.rejects(
		dispatcher.deliver(subagentWakeKey(h.sessionManager.getSessionId(), "release9:0"), {
			id: "intercom:1",
			kind: "intercom",
		}),
		(error: Error & { code?: string; cause?: Error }) => {
			assert.equal(error.code, "wake-failed");
			assert.ok(isReleasedChildError(error.cause));
			assert.deepEqual([error.cause.code, error.cause.fields.childId], ["child-unrestorable", "release9:0"]);
			assert.match(error.cause.fields.reason ?? "", /worker/);
			return true;
		},
	);
	assert.equal(h.runs.length, runs, "nothing ran");
});

test("pause with all: true pauses released children and leaves one already paused alone (#4326)", async () => {
	const h = harness();
	h.releaseOriginal = true;
	await settled(h, await h.admit("release12"));
	await settled(h, await h.admit("release12b"));
	await h.waitForLatest("release12b:0", (record) => record.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS);
	await h.call({ action: "pause", id: "release12b:0" });
	await h.waitForLatest("release12b:0", (record) => record.terminalStatus === "paused");
	const paused = await h.call({ action: "pause", all: true });
	assert.deepEqual(
		paused.details.runControl?.children.map((child) => child.childId),
		["release12:0"],
	);
	assert.doesNotMatch(text(paused), /already paused/);
});

function settledCall(result: ReturnType<typeof waitResult>): DetachedToolCall {
	return { toolCallId: result.toolCallId, toolName: result.toolName, result: Promise.resolve(result), abort() {} };
}

test("waiting for a dispatcher to drain outlasts 1,000 event-loop turns (#4535)", async () => {
	const dispatcher = new AgentWakeDispatcher();
	const finish = Promise.withResolvers<void>();
	dispatcher.handle("slow", () => finish.promise);
	const delivery = dispatcher.deliver("slow:child", { id: "wake", kind: "intercom" });
	const draining = drained(dispatcher);
	// Keep a real wake pending beyond the old polling budget, without relying on CPU speed.
	for (let turn = 0; turn < 1_001; turn++) await new Promise((resolve) => setImmediate(resolve));
	finish.resolve();
	await delivery;
	assert.equal(await draining, 0, "wait for completion, not a fixed number of turns");
});

test("a result already settled when its child is released wakes it once, after the released record, with nothing left held (#4326)", async () => {
	const h = harness();
	const dispatcher = new AgentWakeDispatcher();
	h.wakeDispatcher = dispatcher;
	const stop = bindReleasedChildWakes(h.deps, h.ctx, h.deps.pi.events, dispatcher);
	cleanups.push(async () => stop());
	const green = waitResult("CI green");
	h.releaseOriginal = true;
	h.releasedCalls = [settledCall(green)];

	await settled(h, await h.admit("handoff1"));
	h.releaseOriginal = false;
	const woken = await h.waitForLatest(
		"handoff1:0",
		(record) => record.state === "terminal" && record.terminalStatus === "ok",
	);

	const wakeRuns = h.runs.filter((run) => run.task !== ORIGINAL_TASK);
	assert.equal(wakeRuns.length, 1, "one wake, not stranded and not repeated");
	assert.ok(readsLate(wakeRuns[0], green), "the wake brought the result");
	assert.deepEqual(woken.heldToolResults ?? [], [], "nothing is left held once the wake took the result");
	assert.ok(woken.taskId);
	await settled(h, woken.taskId);
	assert.equal(await drained(dispatcher), 0, "the wake's key is dropped once the woken run settled");
});

test("a result held while its child still ran wakes the child once it is released, and is then no longer held (#4326)", async () => {
	const h = harness();
	const dispatcher = new AgentWakeDispatcher();
	h.wakeDispatcher = dispatcher;
	const stop = bindReleasedChildWakes(h.deps, h.ctx, h.deps.pi.events, dispatcher);
	cleanups.push(async () => stop());
	h.releaseOriginal = true;
	h.releaseGate = Promise.withResolvers<void>();
	const taskId = await h.admit("drain1");
	await h.waitForLatest("drain1:0", (record) => record.state === "running" && record.launchLeafId !== undefined);
	const green = waitResult("CI green");

	await dispatcher.deliver(subagentWakeKey(h.sessionManager.getSessionId(), "drain1:0"), {
		id: "tool-result:ci-1",
		kind: "tool-result",
		toolResult: green,
	});
	assert.deepEqual(
		heldAsArrived(h.latest("drain1:0")?.heldToolResults),
		[green],
		"a running child keeps the result for later",
	);
	assert.equal(h.latest("drain1:0")?.state, "running");

	h.releaseOriginal = false;
	h.releaseGate.resolve();
	await settled(h, taskId);
	const woken = await h.waitForLatest(
		"drain1:0",
		(record) =>
			record.state === "terminal" && record.terminalStatus === "ok" && (record.heldToolResults ?? []).length === 0,
	);
	assert.ok(woken.taskId);
	await settled(h, woken.taskId);
	assert.equal(await drained(dispatcher), 0);
	assert.equal(h.runs.filter((run) => run.task !== ORIGINAL_TASK).length, 1, "woken once");
});

test("pause and quit park a released child at the broker: held sends no longer wake its owner (#4326)", async () => {
	const h = harness();
	h.releaseOriginal = true;
	await settled(h, await h.admit("park1", undefined, { intercomEvents: h.deps.pi.events }));
	const released = await h.waitForLatest(
		"park1:0",
		(record) => record.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS,
	);
	await h.waitForLatest("park1:0", () => h.releasedChildRequests.length > 0);
	const parked = (status: string) => ({
		reserve: [
			{
				childName: "subagent-worker-park1",
				group: "lane-group",
				aliases: [released.childSessionId],
				wake: status === "released",
			},
		],
	});

	await h.call({ action: "pause", id: "park1:0" });
	await h.waitForLatest("park1:0", (record) => record.terminalStatus === "paused");
	assert.deepEqual(h.releasedChildRequests.at(-1), parked("paused"));
	assert.equal(h.releasedChildRequests.length, 2, "one request to reserve it, one to park it");

	await h.call({ action: "quit", id: "park1:0" });
	await h.waitForLatest("park1:0", (record) => record.terminalStatus === "quit");
	assert.equal(h.releasedChildRequests.length, 2, "quitting a child already parked leaves the broker as it is");
});

test("an Intercom wake tells the broker the owner is waking the child, once per wake (#4326)", async () => {
	const h = harness();
	h.releaseOriginal = true;
	await settled(h, await h.admit("ack1"));
	await h.waitForLatest("ack1:0", (record) => record.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS);
	h.releaseOriginal = false;
	const dispatcher = new AgentWakeDispatcher();
	const unbind = bindReleasedChildWakes(h.deps, h.ctx, h.deps.pi.events, dispatcher);
	cleanups.push(async () => unbind());

	await dispatcher.deliver(subagentWakeKey(h.sessionManager.getSessionId(), "ack1:0"), {
		id: "intercom:1",
		kind: "intercom",
	});
	assert.deepEqual(
		h.releasedChildRequests.filter((request) => "acknowledge" in request),
		[{ acknowledge: "subagent-worker-ack1" }],
	);
});

async function releasedWithWakes(h: Harness, runId: string): Promise<AgentWakeDispatcher> {
	const dispatcher = agentWakeDispatcher();
	const stop = bindReleasedChildWakes(h.deps, h.ctx, h.deps.pi.events, dispatcher);
	cleanups.push(async () => stop());
	h.wakeDispatcher = dispatcher;
	h.releaseOriginal = true;
	await settled(h, await h.admit(runId));
	await h.waitForLatest(`${runId}:0`, (record) => record.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS);
	h.releaseOriginal = false;
	return dispatcher;
}

function clearedOk(record: SubagentChildRecord): boolean {
	return record.state === "terminal" && record.terminalStatus === "ok" && (record.heldToolResults ?? []).length === 0;
}

function taskHeartbeatMs(h: Harness, taskId: string): number | undefined {
	const watched = h.host.watchOwnerTasks();
	assert.ok(watched.ok);
	try {
		const task = watched.value.snapshot.tasks.find((candidate) => candidate.ref.taskId === taskId);
		assert.ok(task, `task ${taskId} is recorded`);
		return task.heartbeatMs;
	} finally {
		watched.value.dispose();
	}
}

for (const heartbeatMs of [0, 120_000]) {
	test(`a released child launched with heartbeatMs ${heartbeatMs} keeps that cadence when a result wakes it (#4856)`, async () => {
		const h = harness();
		h.launchHeartbeatMs = heartbeatMs;
		const dispatcher = await releasedWithWakes(h, `heartbeat-${heartbeatMs}`);
		const childId = `heartbeat-${heartbeatMs}:0`;
		const released = h.latest(childId);
		assert.ok(released?.taskId);
		assert.equal(taskHeartbeatMs(h, released.taskId), heartbeatMs);

		await dispatcher.deliver(subagentWakeKey(h.sessionManager.getSessionId(), childId), {
			id: "tool-result:ci-1",
			kind: "tool-result",
			toolResult: waitResult("CI green"),
		});
		const woken = await h.waitForLatest(childId, (record) => record.taskId !== released.taskId && clearedOk(record));
		assert.ok(woken.taskId);
		assert.equal(taskHeartbeatMs(h, woken.taskId), heartbeatMs, "the wake relaunches on the launch's cadence");
	});
}

test("results a woken child is given stay held in its record until its run saved them (#4326)", async () => {
	const h = harness();
	await releasedWithWakes(h, "heldwake1");
	await h.call({ action: "pause", id: "heldwake1:0" });
	await h.waitForLatest("heldwake1:0", (record) => record.terminalStatus === "paused");
	const green = waitResult("CI green");
	await recordSubagentChildHeldToolResults(h.deps.pi, h.sessionManager.getSessionId(), "heldwake1:0", [green]);
	const gate = Promise.withResolvers<void>();
	h.finishOn.set("CI green", gate);

	const resumed = await h.call({ action: "resume", id: "heldwake1:0", message: "go on" });
	const taskId = resumedTaskId(resumed);
	await h.waitForLatest(
		"heldwake1:0",
		(record) => record.state === "running" && record.taskId === taskId && record.launchLeafId !== undefined,
	);
	assert.deepEqual(h.runs.at(-1)?.options.wakeToolResultIds, ["ci-1"]);

	gate.resolve();
	await settled(h, taskId);
	const done = await h.waitForLatest("heldwake1:0", clearedOk);
	assert.equal(done.taskId, taskId);
	// The records the owner saved, in order: the resumed run starts holding the result, and lets it go only after.
	const ofResumedRun = h.sessionManager
		.getEntries()
		.flatMap((entry) =>
			entry.type === "custom" &&
			entry.customType === SUBAGENT_CHILD_RECORD_TYPE &&
			(entry.data as SubagentChildRecord).childId === "heldwake1:0" &&
			(entry.data as SubagentChildRecord).taskId === taskId
				? [entry.data as SubagentChildRecord]
				: [],
		);
	assert.deepEqual(
		heldAsArrived(ofResumedRun[0]?.heldToolResults),
		[green],
		"still held when its run starts, before it saved it",
	);
	assert.deepEqual(ofResumedRun.at(-1)?.heldToolResults, [], "let go once its run saved it");
	assert.equal(h.runs.filter((run) => readsLate(run, green)).length, 1);
});

test("a result that arrives while a resumed child runs is kept, and wakes it once that run has ended (#4326)", async () => {
	const h = harness();
	const dispatcher = await releasedWithWakes(h, "during1");
	const gate = Promise.withResolvers<void>();
	h.finishOn.set("keep going", gate);
	const resumed = await h.call({ action: "resume", id: "during1:0", message: "keep going" });
	const taskId = resumedTaskId(resumed);
	await h.waitForLatest("during1:0", (record) => record.state === "running" && record.taskId === taskId);
	const green = waitResult("CI green");

	await dispatcher.deliver(subagentWakeKey(h.sessionManager.getSessionId(), "during1:0"), {
		id: "tool-result:ci-1",
		kind: "tool-result",
		toolResult: green,
	});
	assert.deepEqual(
		heldAsArrived(h.latest("during1:0")?.heldToolResults),
		[green],
		"a running child keeps the result for later",
	);
	gate.resolve();
	await settled(h, taskId);

	const woken = await h.waitForLatest("during1:0", (record) => record.taskId !== taskId && clearedOk(record));
	assert.ok(woken.taskId);
	await settled(h, woken.taskId);
	assert.equal(await drained(dispatcher), 0);
	assert.equal(h.runs.filter((run) => readsLate(run, green)).length, 1, "woken once, with it");
	assert.deepEqual(h.latest("during1:0")?.heldToolResults, []);
});

test("messages a released child had queued and not read are delivered once, in order, when it wakes (#4326)", async () => {
	const h = harness();
	const queued = ["Check the flaky test too.", "Then rerun lint."];
	h.releasedPendingMessages = queued;
	const dispatcher = await releasedWithWakes(h, "queuedwake1");
	const released = h.latest("queuedwake1:0");
	assert.deepEqual(released?.heldMessages, {
		taskId: released?.taskId,
		messages: queued,
		taskExpands: false,
		withoutWakePrompt: true,
		withoutLateResults: true,
		withoutContinuations: true,
	});
	const green = waitResult("CI green");

	await dispatcher.deliver(subagentWakeKey(h.sessionManager.getSessionId(), "queuedwake1:0"), {
		id: "tool-result:ci-1",
		kind: "tool-result",
		toolResult: green,
	});
	assert.ok(readsLate(h.runs.at(-1), green));
	assert.deepEqual(
		[h.runs.at(-1)?.task, ...(h.runs.at(-1)?.options.resumeFollowUps ?? [])],
		queued,
		"no wake prompt follows the messages it reads",
	);
	await h.waitForLatest("queuedwake1:0", clearedOk);

	const again = await h.call({ action: "resume", id: "queuedwake1:0", message: "one more thing" });
	await settled(h, resumedTaskId(again));
	const delivered = h.runs.filter((run) =>
		[run.task, ...(run.options.resumeFollowUps ?? [])].includes("Check the flaky test too."),
	);
	assert.equal(delivered.length, 1, "the queued messages are not delivered again");
});

test("a wake waits until the child's previous run has closed its session before it reopens it (#4326)", async () => {
	const h = harness();
	const dispatcher = await releasedWithWakes(h, "closing1");
	const gate = Promise.withResolvers<void>();
	h.finishOn.set("wrap up", gate);
	h.disposeGate = Promise.withResolvers<void>();
	const resumed = await h.call({ action: "resume", id: "closing1:0", message: "wrap up" });
	gate.resolve();
	await settled(h, resumedTaskId(resumed));
	const runsBeforeWake = h.runs.length;
	let runsWhenClosed = -1;
	void h.disposeGate.promise.then(() => {
		runsWhenClosed = h.runs.length;
	});

	const wake = dispatcher.deliver(subagentWakeKey(h.sessionManager.getSessionId(), "closing1:0"), {
		id: "tool-result:ci-1",
		kind: "tool-result",
		toolResult: waitResult("CI green"),
	});
	try {
		await h.waitForLatest("closing1:0", (record) =>
			(record.heldToolResults ?? []).some((held) => held.toolCallId === "ci-1"),
		);
	} finally {
		h.disposeGate.resolve();
	}
	await waitForWakeCompletion(wake, "the wake after the previous session closes");
	assert.equal(runsWhenClosed, runsBeforeWake, "no wake ran before the previous run's session closed");
	assert.equal(h.runs.length, runsBeforeWake + 1);
});

async function untilNotices(h: Harness, count: number): Promise<number> {
	const NOTICE_DELIVERY_SETTLE_MS = 250;
	const deadline = Date.now() + NOTICE_DELIVERY_SETTLE_MS;
	while (h.notices.length < count && Date.now() < deadline) await sleep(10);
	return h.notices.length;
}

test("a wake that cannot restore its child keeps what it carried in the child's record with a typed failure, tells the owner once, and resume then delivers it once (#4326)", async () => {
	const h = harness();
	const dispatcher = agentWakeDispatcher();
	const stop = bindReleasedChildWakes(h.deps, h.ctx, h.deps.pi.events, dispatcher);
	cleanups.push(async () => stop());
	h.wakeDispatcher = dispatcher;
	h.agentDefined = false;
	const green = waitResult("CI green");
	h.releaseOriginal = true;
	h.releasedCalls = [settledCall(green)];
	await settled(h, await h.admit("wakefail1"));
	h.releaseOriginal = false;

	const failed = await h.waitForLatest("wakefail1:0", (record) => record.wakeFailure?.reported === true);
	assert.equal(failed.terminalStatus, SUBAGENT_CHILD_RELEASED_STATUS);
	assert.deepEqual(heldAsArrived(failed.heldToolResults), [green], "the result the failed wake carried is kept");
	assert.deepEqual([failed.wakeFailure?.code, failed.wakeFailure?.taskId], ["child-unrestorable", failed.taskId]);
	assert.match(failed.wakeFailure?.reason ?? "", /worker/);
	assert.match(failed.wakeFailure?.hint ?? "", /"resume"/);
	await waitForWakeCompletion(h.firstNotice, "the owner's wake-failure notice");
	assert.equal(h.notices.length, 1);
	assert.deepEqual(
		[h.notices[0]?.noticeLabel, h.notices[0]?.status, h.notices[0]?.agent],
		[RELEASED_CHILD_WAKE_FAILURE_LABEL, "error", "worker"],
	);
	assert.match(String(h.notices[0]?.summary), /\(child-unrestorable\)/);

	void dispatcher
		.deliver(subagentWakeKey(h.sessionManager.getSessionId(), "wakefail1:0"), { id: "intercom:2", kind: "intercom" })
		.catch((error) => dispatcher.reportUnobservedFailure(error));
	assert.equal(await drained(dispatcher), 0);
	await subagentChildRecordsAppended(h.sessionManager.getSessionId());
	// Failure reporting emits notices after dispatcher/record completion. Give a duplicate time to arrive.
	assert.equal(await untilNotices(h, 2), 1, "the owner is told once, however often the wake fails");
	const status = await h.call({ action: "status", id: "wakefail1:0" });
	assert.match(
		text(status),
		/released · waiting on wait_for_ci \(ci-1\);[^\n]*Its last wake failed: [^\n]*\(child-unrestorable\)/,
	);

	h.agentDefined = true;
	const resumed = await h.call({ action: "resume", id: "wakefail1:0" });
	await settled(h, resumedTaskId(resumed));
	const done = await h.waitForLatest("wakefail1:0", clearedOk);
	assert.equal(currentWakeFailure(done), undefined, "a run that took the results clears the failure");
	assert.equal(h.runs.filter((run) => readsLate(run, green)).length, 1);
});

async function releasedByEarlierProcess(
	h: Harness,
	runId: string,
	extra: Partial<SubagentChildRecord> = {},
): Promise<SubagentChildRecord> {
	h.releaseOriginal = true;
	await settled(h, await h.admit(runId));
	const released = await h.waitForLatest(
		`${runId}:0`,
		(record) => record.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS,
	);
	h.releaseOriginal = false;
	assert.equal(released.ownerGeneration, SUBAGENT_OWNER_GENERATION);
	const earlier: SubagentChildRecord = { ...released, ownerGeneration: "earlier-process", ...extra };
	await h.sessionManager.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, earlier);
	observeSubagentChildRecord(earlier);
	return earlier;
}

function bindProcessWakes(h: Harness): AgentWakeDispatcher {
	const dispatcher = agentWakeDispatcher();
	h.wakeDispatcher = dispatcher;
	const stop = bindReleasedChildWakes(h.deps, h.ctx, h.deps.pi.events, dispatcher);
	cleanups.push(async () => stop());
	return dispatcher;
}

for (const toolName of ["intercom", "contact_supervisor"] as const) {
	test(`an owner restart keeps a released ${toolName} question and wakes it at its original deadline (#4326)`, async () => {
		const h = harness();
		const runId = `restart-${toolName}`;
		await releasedByEarlierProcess(h, runId, {
			waitingOn: [
				{
					toolCallId: "ask-1",
					toolName,
					replyWait: { questionId: "question-1", deadline: Date.now() - 1, from: "peer" },
				},
			],
		});
		const dispatcher = bindProcessWakes(h);
		await h.waitForLatest(`${runId}:0`, clearedOk);
		await dispatcher.whenIdle();
		assert.equal(
			h.runs.filter((run) => run.options.redispatchDetachedCalls).length,
			0,
			"the question is not sent again",
		);
		// #4751: an intercom ask has no reply timeout; its released wait ends and the ask stays pending.
		const deadlineText =
			toolName === "intercom"
				? 'No reply from "peer" yet; stopped waiting'
				: 'No reply from "peer" within 10 minutes';
		assert.equal(h.runs.filter((run) => readsOf(run).includes(deadlineText)).length, 1);
	});
}

test("an owner that restarts starts each call its released children waited on again, once, releases them again on this process, and the new call's result wakes them (#4326)", async () => {
	const h = harness();
	const earlier = await releasedByEarlierProcess(h, "restart1");
	const redispatched = Promise.withResolvers<DetachedToolResult>();
	h.redispatchCalls = [{ ...RELEASED_CALL, result: redispatched.promise, abort() {} }];

	const dispatcher = bindProcessWakes(h);
	const again = await h.waitForLatest(
		"restart1:0",
		(record) =>
			record.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS &&
			record.ownerGeneration === SUBAGENT_OWNER_GENERATION,
	);
	assert.notEqual(again.taskId, earlier.taskId);
	assert.deepEqual(again.waitingOn, [RELEASED_CALL]);
	const redispatches = h.runs.filter((run) => run.options.redispatchDetachedCalls);
	assert.equal(redispatches.length, 1);
	assert.deepEqual(
		[redispatches[0]?.options.resumeToolResults, redispatches[0]?.options.resumeFollowUps],
		[undefined, undefined],
		"nothing is answered or prompted: only the call starts again",
	);

	const green = waitResult("CI green after the restart");
	redispatched.resolve(green);
	const woken = await h.waitForLatest("restart1:0", (record) => record.taskId !== again.taskId && clearedOk(record));
	assert.ok(woken.taskId);
	await settled(h, woken.taskId);
	assert.equal(await drained(dispatcher), 0);
	assert.equal(h.runs.filter((run) => readsLate(run, green)).length, 1);
	assert.equal(h.runs.filter((run) => run.options.redispatchDetachedCalls).length, 1, "started again once");
});

test("a child of the earlier process whose call result is already held is woken with it instead of starting the call again (#4326)", async () => {
	const h = harness();
	const green = waitResult("CI green before the restart");
	await releasedByEarlierProcess(h, "heldrestart1", { heldToolResults: [green] });

	bindProcessWakes(h);
	await h.waitForLatest("heldrestart1:0", clearedOk);
	assert.equal(h.runs.filter((run) => run.options.redispatchDetachedCalls).length, 0);
	assert.equal(h.runs.filter((run) => readsLate(run, green)).length, 1);
});

function wakeWith(h: Harness, dispatcher: AgentWakeDispatcher, childId: string, output: string): void {
	void dispatcher
		.deliver(subagentWakeKey(h.sessionManager.getSessionId(), childId), {
			id: `tool-result:${childId}`,
			kind: "tool-result",
			toolResult: waitResult(output),
		})
		.catch((error) => dispatcher.reportUnobservedFailure(error));
}

async function releasedMember(
	h: Harness,
	runId: string,
	index: number,
	schedule: ReturnType<typeof createExecutionScheduler>,
): Promise<SubagentChildRecord> {
	h.releaseOriginal = true;
	await settled(
		h,
		await h.admit(runId, schedule, { index, intercomSessionName: `subagent-worker-${runId}-${index}` }),
	);
	const released = await h.waitForLatest(
		`${runId}:${index}`,
		(record) => record.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS,
	);
	h.releaseOriginal = false;
	return released;
}

function wokenRuns(h: Harness, runId: string, index: number): Harness["runs"] {
	return h.runs.filter(
		(run) => run.options.runId === runId && (run.options.index ?? 0) === index && run.task !== ORIGINAL_TASK,
	);
}

test("a released child woken while a sibling holds its run's only slot waits for that sibling to finish (#4856)", async () => {
	const h = harness();
	const dispatcher = bindProcessWakes(h);
	const schedule = createExecutionScheduler(1);
	const a = await releasedMember(h, "conc-live", 0, schedule);
	const b = await h.admit("conc-live", schedule, { index: 1, intercomSessionName: "subagent-worker-conc-live-1" });
	await h.waitForLatest("conc-live:1", (record) => record.launchLeafId !== undefined);

	wakeWith(h, dispatcher, "conc-live:0", "CI green for A");
	await sleep(150);
	assert.deepEqual(wokenRuns(h, "conc-live", 0), [], "A waits while B holds the run's only slot");

	await h.call({ action: "quit", id: "conc-live:1" });
	await settled(h, b);
	const woken = await h.waitForLatest("conc-live:0", (record) => record.taskId !== a.taskId && clearedOk(record));
	assert.ok(woken.taskId);
	assert.equal(wokenRuns(h, "conc-live", 0).length, 1, "A starts once B frees the slot");
});

test("released children of one run woken with no sibling running still take its concurrency limit's slots one at a time (#4856)", async () => {
	const h = harness();
	const dispatcher = bindProcessWakes(h);
	const schedule = createExecutionScheduler(1);
	await releasedMember(h, "conc-idle", 0, schedule);
	await releasedMember(h, "conc-idle", 1, schedule);
	const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()] as const;
	h.finishOn.set("CI green for 0", gates[0]);
	h.finishOn.set("CI green for 1", gates[1]);

	wakeWith(h, dispatcher, "conc-idle:0", "CI green for 0");
	wakeWith(h, dispatcher, "conc-idle:1", "CI green for 1");
	const started = () => [0, 1].filter((index) => wokenRuns(h, "conc-idle", index).length > 0);
	const deadline = Date.now() + RECORD_WAIT_MS;
	while (started().length === 0 && Date.now() < deadline) await sleep(10);
	await sleep(150);
	const [first] = started();
	assert.equal(started().length, 1, "one woken child runs; the other waits for the run's only slot");
	assert.ok(first !== undefined);

	gates[first]?.resolve();
	gates[1 - first]?.resolve();
	for (const index of [0, 1])
		await h.waitForLatest(
			`conc-idle:${index}`,
			(record) => wokenRuns(h, "conc-idle", index).length === 1 && clearedOk(record),
		);
});

test("a woken child waiting for its run's slot leaves parallel.runningCapacity to another run's woken child, which starts at once (#4856)", async () => {
	const h = harness();
	h.deps.config.parallel = { runningCapacity: 1 };
	const dispatcher = bindProcessWakes(h);
	const runA = createExecutionScheduler(1);
	await releasedMember(h, "hol-a", 0, runA);
	const a1 = await h.admit("hol-a", runA, { index: 1, intercomSessionName: "subagent-worker-hol-a-1" });
	await h.waitForLatest("hol-a:1", (record) => record.launchLeafId !== undefined);
	await releasedMember(h, "hol-b", 0, createExecutionScheduler(1));

	wakeWith(h, dispatcher, "hol-a:0", "CI green for A");
	await sleep(150);
	assert.deepEqual(wokenRuns(h, "hol-a", 0), [], "A waits while its sibling holds its run's only slot");
	wakeWith(h, dispatcher, "hol-b:0", "CI green for B");
	await h.waitForLatest("hol-b:0", () => wokenRuns(h, "hol-b", 0).length === 1);
	assert.deepEqual(wokenRuns(h, "hol-a", 0), [], "A still waits for its run");

	await h.call({ action: "quit", id: "hol-a:1" });
	await settled(h, a1);
	await h.waitForLatest("hol-a:0", (record) => wokenRuns(h, "hol-a", 0).length === 1 && clearedOk(record));
	await h.waitForLatest("hol-b:0", (record) => clearedOk(record));
	await dispatcher.whenIdle();
	assert.equal(dispatcher.stats().running, 0);
});

/** A detached call of the child's last turn whose process died with the earlier owner (#4848). */
const DETACHED_BASH = { toolCallId: "bash-1", toolName: "bash" } as const;

const ASK_CALL = { toolCallId: "ask-1", toolName: "intercom" } as const;

/** End the child's own session on a turn whose calls have no results yet, as a released child's does. */
async function endChildSessionOnCalls(
	record: SubagentChildRecord,
	calls: ReadonlyArray<{ toolCallId: string; toolName: string }>,
): Promise<void> {
	assert.ok(record.childSessionFile);
	const session = await SessionManager.open(record.childSessionFile, undefined, record.cwd);
	await session.appendMessage({
		role: "assistant",
		content: calls.map((call) => ({
			type: "toolCall" as const,
			id: call.toolCallId,
			name: call.toolName,
			arguments: {},
		})),
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	});
}

function resultText(result: DetachedToolResult | undefined): string {
	return (result?.result.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

function assertInterruptedByRestart(results: readonly DetachedToolResult[] | undefined): void {
	const bash = results?.find((result) => result.toolCallId === DETACHED_BASH.toolCallId);
	assert.ok(bash, `the detached call is answered: ${JSON.stringify(results)}`);
	assert.equal(bash.toolName, DETACHED_BASH.toolName);
	assert.equal(bash.isError, true);
	assert.match(resultText(bash), /interrupted when Atomic restarted/);
	assert.match(resultText(bash), /re-run it if/i);
	assert.doesNotMatch(resultText(bash), /still running/);
}

test("after an owner restart, a reply to a released child's ask wakes it with the reply and its detached bash call reported interrupted, never still running (#4848)", async () => {
	const h = harness();
	const runId = "restart-ask-bash";
	const earlier = await releasedByEarlierProcess(h, runId, {
		waitingOn: [
			{ ...ASK_CALL, replyWait: { questionId: "question-1", deadline: Date.now() + 60_000, from: "peer" } },
			DETACHED_BASH,
		],
	});
	await endChildSessionOnCalls(earlier, [ASK_CALL, DETACHED_BASH]);
	const events = createEventBus();
	const dispatcher = agentWakeDispatcher();
	h.wakeDispatcher = dispatcher;
	const stop = bindReleasedChildWakes(h.deps, h.ctx, events, dispatcher);
	cleanups.push(async () => stop());
	await dispatcher.whenIdle();
	assert.equal(h.runs.filter((run) => run.options.redispatchDetachedCalls).length, 0, "the ask is not sent again");

	const reply: ReleasedChildReplyRequest = {
		childName: `subagent-worker-${runId}`,
		replyTo: "question-1",
		message: { id: "reply-1", timestamp: Date.now(), replyTo: "question-1", content: { text: "ship it" } },
	};
	events.emit(RELEASED_CHILD_REPLY_EVENT, reply);
	assert.equal(await reply.completion, true);
	const woken = await h.waitForLatest(
		`${runId}:0`,
		(record) => record.taskId !== earlier.taskId && record.state === "terminal",
	);
	assert.ok(woken.taskId);
	await settled(h, woken.taskId);
	// It continued the turn with both results and finished, and its record no longer holds the reply.
	await h.waitForLatest(`${runId}:0`, (record) => record.taskId === woken.taskId && clearedOk(record));

	const wake = h.runs.find((run) => run.options.resumeToolResults !== undefined);
	assert.ok(wake, "the reply wakes the child");
	const results = wake.options.resumeToolResults ?? [];
	assert.deepEqual(
		results.map((result) => result.toolCallId),
		[ASK_CALL.toolCallId, DETACHED_BASH.toolCallId],
	);
	assert.match(resultText(results[0]), /ship it/);
	assertInterruptedByRestart(results);
	assert.equal(
		h.runs.filter((run) => JSON.stringify(run).includes("still running in the background")).length,
		0,
		"no call is reported still running",
	);
});

test("after an owner restart, a resume before the ask's reply keeps the ask waiting and reports only the detached call interrupted (#4848)", async () => {
	const h = harness();
	const runId = "restart-ask-pending";
	const earlier = await releasedByEarlierProcess(h, runId, {
		waitingOn: [
			{ ...ASK_CALL, replyWait: { questionId: "question-2", deadline: Date.now() + 60_000, from: "peer" } },
			DETACHED_BASH,
		],
	});
	await endChildSessionOnCalls(earlier, [ASK_CALL, DETACHED_BASH]);
	bindProcessWakes(h);

	const resumed = await h.call({ action: "resume", id: `${runId}:0`, message: "carry on" });
	const taskId = resumedTaskId(resumed);
	await settled(h, taskId);
	// It continued the turn with those results and finished, holding none of them.
	await h.waitForLatest(`${runId}:0`, (record) => record.taskId === taskId && clearedOk(record));

	const run = h.runs.find((item) => item.options.resumeToolResults !== undefined);
	assert.ok(run);
	const results = run.options.resumeToolResults ?? [];
	const ask = results.find((result) => result.toolCallId === ASK_CALL.toolCallId);
	assert.equal(
		resultText(ask),
		SUBAGENT_STILL_RUNNING_RESULT,
		"the question's reply still arrives through the broker",
	);
	assert.equal(ask?.isError, false);
	assertInterruptedByRestart(results);
});

test("after an owner restart, a paused released child waiting only on a detached call gets it reported interrupted on its resume (#4848)", async () => {
	const h = harness();
	const runId = "restart-paused-bash";
	const earlier = await releasedByEarlierProcess(h, runId, { waitingOn: [DETACHED_BASH], terminalStatus: "paused" });
	await endChildSessionOnCalls(earlier, [DETACHED_BASH]);
	bindProcessWakes(h);

	const resumed = await h.call({ action: "resume", id: `${runId}:0`, message: "carry on" });
	const taskId = resumedTaskId(resumed);
	await settled(h, taskId);
	// It continued the turn with those results and finished, holding none of them.
	await h.waitForLatest(`${runId}:0`, (record) => record.taskId === taskId && clearedOk(record));

	const run = h.runs.find((item) => item.options.resumeToolResults !== undefined);
	assert.ok(run, "the resume continues the turn the call was made in");
	assert.equal(run.options.resumeToolResults?.length, 1);
	assertInterruptedByRestart(run.options.resumeToolResults);
});

test("binding the owner again in the process that released its children starts nothing again (#4326)", async () => {
	const h = harness();
	const dispatcher = await releasedWithWakes(h, "samegen1");
	const runs = h.runs.length;

	bindProcessWakes(h);
	assert.equal(await drained(dispatcher), 0);
	assert.equal(h.runs.length, runs);
	assert.equal(h.latest("samegen1:0")?.ownerGeneration, SUBAGENT_OWNER_GENERATION);
});

test("an owner restart starts the calls of its earlier released children at most parallel.runningCapacity at a time (#4326)", async () => {
	const h = harness();
	h.deps.config.parallel = { runningCapacity: 1 };
	await releasedByEarlierProcess(h, "throttle1");
	await releasedByEarlierProcess(h, "throttle2");
	h.redispatchGate = Promise.withResolvers<void>();

	const dispatcher = bindProcessWakes(h);
	const deadline = Date.now() + RECORD_WAIT_MS;
	while (h.redispatching.active === 0 && Date.now() < deadline) await sleep(10);
	assert.equal(h.redispatching.active, 1, "the first child's call starts again");
	const { running, queued } = dispatcher.stats();
	assert.deepEqual({ running, queued }, { running: 1, queued: 1 }, "the second child waits for the first");
	h.redispatchGate.resolve();

	for (const childId of ["throttle1:0", "throttle2:0"])
		await h.waitForLatest(childId, (record) => record.ownerGeneration === SUBAGENT_OWNER_GENERATION);
	assert.equal(h.redispatching.most, 1);
	assert.equal(h.runs.filter((run) => run.options.redispatchDetachedCalls).length, 2);
});

test("status reports a failed child-record append to its owner, not another owner (#4326)", async () => {
	const owner = harness();
	const other = harness();
	const sink = createSubagentChildRecordSink(
		{
			appendEntry: async () => {
				throw new Error("disk full");
			},
		},
		owner.ctx,
	);
	sink.record({ runId: "record-failure", index: 0, agent: "worker", state: "running", cwd: "/repo" });
	await sink.flushed?.();
	const otherSink = createSubagentChildRecordSink(
		{
			appendEntry: async () => {
				throw new Error("disk full");
			},
		},
		other.ctx,
	);
	otherSink.record({ runId: "other-record-failure", index: 0, agent: "worker", state: "running", cwd: "/repo" });
	await otherSink.flushed?.();
	const lines = subagentChildrenAwaitingResume(owner.ctx);
	assert.equal(lines.length, 1);
	assert.match(lines[0] ?? "", /record-append-failed/);
	assert.match(lines[0] ?? "", /record-failure:0/);
	assert.match(lines[0] ?? "", /session store/);
	assert.match(subagentChildrenAwaitingResume(other.ctx)[0] ?? "", /other-record-failure:0/);
	assert.deepEqual(subagentChildrenAwaitingResume(owner.ctx), []);
	assert.deepEqual(subagentChildrenAwaitingResume(other.ctx), []);
});

test("resume of a child a wake is running is refused at once, not queued until that run ends (#5485)", async () => {
	const h = harness();
	const dispatcher = await releasedWithWakes(h, "race-resume");
	const gate = Promise.withResolvers<void>();
	h.finishOn.set("CI green", gate);
	const green = waitResult("CI green");
	const wake = dispatcher.deliver(subagentWakeKey(h.sessionManager.getSessionId(), "race-resume:0"), {
		id: "tool-result:ci-1",
		kind: "tool-result",
		toolResult: green,
	});
	try {
		const woken = await h.waitForLatest(
			"race-resume:0",
			(record) => record.state === "running" && record.taskId !== undefined,
		);
		const refused = await answeredWithin(
			h.call({ action: "resume", id: "race-resume:0", message: "follow up after CI" }),
		);
		assert.ok(refused, "resume answers while the woken run still runs");
		assert.equal(refused.isError, true);
		assert.match(text(refused), new RegExp(`already running as task ${woken.taskId}; pause or quit it first`));
		assert.equal(resumeWaiterCount(), 0, "nothing waits behind the woken run");
	} finally {
		gate.resolve();
	}
	await wake;
	assert.equal(await drained(dispatcher), 0);
	assert.equal(
		h.runs.filter((run) => readsOf(run).includes("follow up after CI")).length,
		0,
		"a refused resume never runs",
	);
	// Once its run has ended, resume continues it with the message, once.
	const response = await h.call({ action: "resume", id: "race-resume:0", message: "follow up after CI" });
	assert.equal(response.isError, undefined, text(response));
	await settled(h, resumedTaskId(response));
	assert.equal(h.runs.filter((run) => readsOf(run).includes("CI green")).length, 1);
	assert.equal(h.runs.filter((run) => readsOf(run).includes("follow up after CI")).length, 1);
});

/** Deliver a result that wakes `childId`, whose woken run then waits for `gate`. */
function wakeWithResult(
	h: Harness,
	dispatcher: AgentWakeDispatcher,
	childId: string,
	gate: PromiseWithResolvers<void>,
) {
	h.finishOn.set("CI green", gate);
	return dispatcher.deliver(subagentWakeKey(h.sessionManager.getSessionId(), childId), {
		id: "tool-result:ci-1",
		kind: "tool-result",
		toolResult: waitResult("CI green"),
	});
}

/** Assert `resume` answers with a refusal while the child's woken run goes on, and nothing waits behind that run. */
async function refusedWhileWokenRunRuns(
	h: Harness,
	dispatcher: AgentWakeDispatcher,
	childId: string,
	resume: Promise<SubagentToolResult>,
) {
	const woken = await h.waitForLatest(childId, (record) => record.state === "running" && record.taskId !== undefined);
	const answered = await answeredWithin(resume);
	assert.ok(answered, "resume answers while the woken run still runs");
	assert.equal(answered.isError, true);
	assert.match(text(answered), new RegExp(`already running as task ${woken.taskId}; pause or quit it first`));
	assert.equal(resumeWaiterCount(), 0, "nothing waits behind the woken run");
	assert.equal(dispatcher.stats().queued, 0, "the resume was never queued behind the wake");
}

test("resume the moment a wake has taken its batch, before the wake reads the child's record, is refused while the woken run goes on (#5485)", async () => {
	const h = harness();
	const dispatcher = await releasedWithWakes(h, "taken-batch");
	const gate = Promise.withResolvers<void>();
	// The dispatcher hands the wake its batch at once; the handler then reads the child's latest record.
	const wake = wakeWithResult(h, dispatcher, "taken-batch:0", gate);
	const resume = h.call({ action: "resume", id: "taken-batch:0", message: "right after the wake" });
	try {
		await refusedWhileWokenRunRuns(h, dispatcher, "taken-batch:0", resume);
	} finally {
		gate.resolve();
	}
	await wake;
	assert.equal(
		h.runs.filter((run) => readsOf(run).includes("right after the wake")).length,
		0,
		"a refused resume never runs",
	);
});

test("resume while a wake waits for an earlier record of its owner to be saved is refused while the woken run goes on (#5485)", async () => {
	const h = harness();
	const dispatcher = await releasedWithWakes(h, "slow-append");
	// Another child's record of the same owner is still being saved, so the wake waits before it reads the record.
	const saved = Promise.withResolvers<void>();
	const pi = h.deps.pi as unknown as { appendEntry(type: string, data?: unknown): Promise<void> };
	createSubagentChildRecordSink(
		{
			appendEntry: async (type: string, data?: unknown) => {
				await saved.promise;
				await pi.appendEntry(type, data);
			},
		},
		h.ctx,
	).record({ runId: "slow-other", index: 0, agent: "worker", state: "running", cwd: h.cwd });
	const gate = Promise.withResolvers<void>();
	const wake = wakeWithResult(h, dispatcher, "slow-append:0", gate);
	await sleep(50);
	assert.equal(dispatcher.stats().running, 1, "the wake holds its batch");
	const resume = h.call({ action: "resume", id: "slow-append:0", message: "while the record saves" });
	await sleep(50);
	saved.resolve();
	try {
		await refusedWhileWokenRunRuns(h, dispatcher, "slow-append:0", resume);
	} finally {
		gate.resolve();
	}
	await wake;
	assert.equal(
		h.runs.filter((run) => readsOf(run).includes("while the record saves")).length,
		0,
		"a refused resume never runs",
	);
});

/** Begin a real owner-ordered sibling save. Calling the returned function releases it and waits for persistence. */
function blockSiblingSave(h: Harness): () => Promise<void> {
	const save = Promise.withResolvers<void>();
	const sink = createSubagentChildRecordSink(
		{
			async appendEntry(type, data) {
				await save.promise;
				await h.sessionManager.appendCustomEntry(type, data);
			},
		},
		h.ctx,
	);
	sink.record({ runId: "sibling", index: 0, agent: "worker", state: "running", cwd: h.cwd });
	return async () => {
		save.resolve();
		await sink.flushed?.();
	};
}

test("resume resolves unsaved live launches by their owner's identifiers, even when two children share a name (#5560)", async () => {
	const first = harness();
	const second = harness();
	const outside = harness();
	Object.assign(outside.ctx, { getAgentTaskHost: () => first.host }); // A different session sharing the task host.
	const saves = [blockSiblingSave(first), blockSiblingSave(second)];
	try {
		const name = "shared-worker";
		const a = await first.admit("first", undefined, { intercomSessionName: name });
		const b = await second.admit("second", undefined, { intercomSessionName: name });
		for (const [h, runId, taskId] of [
			[first, "first", a],
			[second, "second", b],
		] as const) {
			assert.equal(h.latest(`${runId}:0`), undefined);
			for (const id of [taskId, name, runId, `${runId}:0`]) {
				const result = await h.call({ action: "resume", id });
				assert.equal(
					text(result),
					`worker (${runId}:0, ${name}) is already running as task ${taskId}; pause or quit it first.`,
				);
			}
		}
		assert.match(text(await outside.call({ action: "resume", id: name })), /Unknown subagent/);
		assert.match(text(await outside.call({ action: "resume", id: a })), /Unknown subagent/);
		assert.match(text(await first.call({ action: "resume", id: "second:0" })), /Unknown subagent/);
		await first.admit("first", undefined, { index: 1, intercomSessionName: "another-worker" });
		assert.match(text(await first.call({ action: "resume", id: "first" })), /Run first launched 2 children/);
	} finally {
		await Promise.all(saves.map((save) => save()));
	}
	await first.waitForLatest("first:0", (record) => record.launchLeafId !== undefined);
	await first.call({ action: "quit", id: "first:0" });
	const retried = await first.call({ action: "resume", id: "shared-worker", message: "retry" });
	await settled(first, resumedTaskId(retried));
	assert.equal(first.runs.at(-1)?.task, "retry", "a settled lease never causes a stale live refusal");
});

test("Esc ends a pending resume while its sibling's record is still being saved (#5560)", async () => {
	const h = harness();
	const childId = "paused:0";
	const dispatcher = await releasedWithWakes(h, "paused");
	await h.call({ action: "pause", id: childId });
	// The wake finds a paused child and decides not to run it. Resume must still check its latest state.
	const key = subagentWakeKey(h.sessionManager.getSessionId(), childId);
	const wake = dispatcher.deliver(key, { id: "message", kind: "intercom" });
	const turn = new AbortController();
	const resume = h.call({ action: "resume", id: childId, message: "never sent" }, turn.signal);
	const finishSave = blockSiblingSave(h);
	try {
		await wake;
		await new Promise<void>((resolve) => setImmediate(resolve));
		turn.abort();
		const result = await answeredWithin(resume);
		assert.ok(result, "resume answers before the sibling's save is released");
		assert.equal(result.isError, true);
		assert.match(text(result), /Interrupted.*nothing was sent/);
		assert.equal(h.latest("sibling:0"), undefined);
	} finally {
		await finishSave();
	}
	assert.equal(
		h.sessionManager
			.getEntries()
			.filter((entry) => isSubagentChildRecord(entry) && (entry.data as SubagentChildRecord).childId === "sibling:0")
			.length,
		1,
		"the pending sibling record is saved exactly once",
	);
	assert.equal(await drained(dispatcher), 0);
	assert.equal(h.latest(childId)?.terminalStatus, "paused");
	assert.equal(h.runs.length, 1, "the withdrawn resume never runs");
});

test("resume refuses an already live child before a sibling save finishes, without waiting for Esc (#5560)", async () => {
	const h = harness();
	const childId = "woken:0";
	const dispatcher = await releasedWithWakes(h, "woken");
	const finish = Promise.withResolvers<void>();
	const wake = wakeWithResult(h, dispatcher, childId, finish);
	try {
		const woken = await h.waitForLatest(childId, (r) => r.state === "running" && r.taskId !== undefined);
		await releasedChildWakeDecided(subagentWakeKey(h.sessionManager.getSessionId(), childId));
		const finishSave = blockSiblingSave(h);
		try {
			const refusal = await answeredWithin(h.call({ action: "resume", id: childId, message: "never sent" }));
			assert.ok(refusal, "the running child is refused without Esc or the sibling's save");
			assert.match(text(refusal), new RegExp(`already running as task ${woken.taskId}; pause or quit it first`));
			assert.equal(h.latest("sibling:0"), undefined);
		} finally {
			await finishSave();
		}
	} finally {
		finish.resolve();
		await wake;
	}
	assert.equal(h.runs.length, 2, "only the original run and its wake ran");
});

let replacementControl:
	| Promise<typeof import("../../packages/subagents/src/runs/foreground/subagent-run-control.js")>
	| undefined;

// Every harness launches with the original imports. One separate module evaluation models its replacement in all cases.
function reloadedRunControl() {
	if (!replacementControl) {
		vi.resetModules();
		replacementControl = import("../../packages/subagents/src/runs/foreground/subagent-run-control.js");
	}
	return replacementControl;
}

for (const ownerless of [false, true]) {
	test(`a pending resume refuses a new ${ownerless ? "SDK" : "hosted"} task before its record save or registration finishes (#5560)`, async () => {
		const h = harness({ ownerless });
		const childId = "registering:0";
		const dispatcher = await releasedWithWakes(h, "registering");
		const starting = gateRestoreOf(h, "subagent-worker-registering");
		const save = Promise.withResolvers<void>();
		const saving = Promise.withResolvers<void>();
		const append = h.deps.pi.appendEntry.bind(h.deps.pi);
		h.deps.pi.appendEntry = async (type, data) => {
			const row = data as SubagentChildRecord | undefined;
			if (type === SUBAGENT_CHILD_RECORD_TYPE && row?.childId === childId && row.state === "running") {
				saving.resolve();
				await save.promise;
			}
			await append(type, data);
		};
		const peer = Promise.withResolvers<boolean>();
		const registering = Promise.withResolvers<void>();
		const emit = h.deps.pi.events.emit.bind(h.deps.pi.events);
		h.deps.pi.events.emit = (channel, data) => {
			emit(channel, data);
			if (channel === SUBAGENT_AWAIT_INTERCOM_PEER_EVENT) {
				(data as { completion?: Promise<boolean> }).completion = peer.promise;
				registering.resolve();
			}
		};
		const finish = Promise.withResolvers<void>();
		const wake = wakeWithResult(h, dispatcher, childId, finish);
		try {
			await starting.reached;
			const resume = h.call({ action: "resume", id: childId, message: "never sent" });
			starting.gate.resolve();
			await saving.promise;
			const result = await answeredWithin(resume);
			assert.ok(result, "resume refuses the running child before its record save or registration");
			assert.equal(h.latest(childId)?.terminalStatus, SUBAGENT_CHILD_RELEASED_STATUS);
			// Reopening the owner's view still sees the old durable row. It must not hide the admitted task.
			bindSubagentChildCards(h.ctx);
			const newTaskId = extractRunningTaskId(text(result));
			assert.ok(newTaskId);
			const byTask = await h.call({ action: "resume", id: newTaskId });
			assert.equal(text(byTask), text(result), "the task ID is addressable before its first durable record");
			const foreign = harness({ ownerless });
			assert.match(text(await foreign.call({ action: "resume", id: newTaskId })), /Unknown subagent/);
			const replacement = await reloadedRunControl();
			const generationResult = await replacement.controlSubagentChildren(
				h.deps,
				h.ctx,
				{ action: "resume", id: newTaskId },
				AbortSignal.abort(),
			);
			assert.equal(text(generationResult), text(result), "a replacement module observes the original task handle");
			const plain = await answeredWithin(h.call({ action: "resume", id: childId }));
			assert.ok(plain, "reloading the owner did not leave resume waiting for the pending save");
			assert.equal(text(plain), text(result));
			const next = await h.call({ action: "resume", id: childId }, AbortSignal.abort());
			assert.equal(text(next), text(result));
			save.resolve();
			await registering.promise;
			assert.match(
				text(result),
				new RegExp(`already running as task ${h.latest(childId)?.taskId}; pause or quit it first`),
			);
		} finally {
			starting.gate.resolve();
			save.resolve();
			peer.resolve(true);
			finish.resolve();
			await wake;
		}
		await h.waitForLatest(childId, (record) => record.terminalStatus === "ok");
		assert.equal(h.runs.length, 2);
	});
}

for (const source of ["wake", "direct resume"] as const) {
	test(`a replacement control waits for the previous generation's ${source} to admit the child instead of reopening it twice (#5560)`, async () => {
		const h = harness();
		const childId = "generation:0";
		const dispatcher = await releasedWithWakes(h, "generation");
		await settled(h, resumedTaskId(await h.call({ action: "resume", id: childId, message: "finish up" })));
		await h.waitForLatest(childId, (record) => record.terminalStatus === "ok");
		const starting = gateRestoreOf(h, "subagent-worker-generation");
		const finish = Promise.withResolvers<void>();
		const before = h.runs.length;
		h.finishOn.set("previous caller", finish);
		const original =
			source === "wake"
				? wakeWithResult(h, dispatcher, childId, finish)
				: h.call({ action: "resume", id: childId, message: "previous caller" });
		try {
			await starting.reached;
			const replacement = await reloadedRunControl();
			const pending = replacement.controlSubagentChildren(h.deps, h.ctx, {
				action: "resume",
				id: childId,
				message: "never delivered",
			});
			starting.gate.resolve();
			const answer = await answeredWithin(pending);
			assert.ok(answer, "the replacement caller doesn't wait for the woken run");
			assert.match(text(answer), /is already running as task/);
		} finally {
			starting.gate.resolve();
			finish.resolve();
			await original;
		}
		await h.waitForLatest(childId, (record) => record.terminalStatus === "ok");
		assert.equal(h.runs.length, before + 1, "one admission for the child");
	});
}

test("a resume queued on a child's wake key is refused as soon as a wake relaunches the child, never left behind its run (#5485)", async () => {
	const h = harness();
	const dispatcher = await releasedWithWakes(h, "queued-behind");
	const gate = Promise.withResolvers<void>();
	const wake = wakeWithResult(h, dispatcher, "queued-behind:0", gate);
	// Queued straight onto the child's wake key, behind the batch the wake has already taken.
	const queued = resumeReleasedChild(h.sessionManager.getSessionId(), "queued-behind:0", {
		prompt: "queued note",
		message: "queued note",
	});
	assert.ok(queued);
	const answer = queued.then(
		() => assert.fail("a resume queued behind a relaunch must not run"),
		(error: unknown) => ({ content: [{ type: "text" as const, text: String(error) }] }) as SubagentToolResult,
	);
	try {
		const woken = await h.waitForLatest(
			"queued-behind:0",
			(record) => record.state === "running" && record.taskId !== undefined,
		);
		const refusal = await answeredWithin(answer);
		assert.ok(refusal, "the queued resume is answered while the woken run goes on");
		assert.match(text(refusal), new RegExp(`already running as task ${woken.taskId}`));
		assert.equal(resumeWaiterCount(), 0);
	} finally {
		gate.resolve();
	}
	await wake;
	assert.equal(await drained(dispatcher), 0);
	assert.equal(
		h.runs.filter((run) => readsOf(run).includes("queued note")).length,
		0,
		"the refused resume never runs",
	);
});

test("resume during a wake that has not relaunched its child yet waits only for that relaunch, then refuses the running child (#5485)", async () => {
	const h = harness();
	const dispatcher = await releasedWithWakes(h, "relaunching");
	const wrapUp = Promise.withResolvers<void>();
	h.finishOn.set("wrap up", wrapUp);
	// The wake below reopens the child only once this run's session has closed.
	h.disposeGate = Promise.withResolvers<void>();
	const resumed = await h.call({ action: "resume", id: "relaunching:0", message: "wrap up" });
	wrapUp.resolve();
	await settled(h, resumedTaskId(resumed));
	const green = Promise.withResolvers<void>();
	h.finishOn.set("CI green", green);
	const wake = dispatcher.deliver(subagentWakeKey(h.sessionManager.getSessionId(), "relaunching:0"), {
		id: "tool-result:ci-1",
		toolResult: waitResult("CI green"),
		kind: "tool-result",
	});
	try {
		await h.waitForLatest("relaunching:0", (record) =>
			(record.heldToolResults ?? []).some((held) => held.toolCallId === "ci-1"),
		);
		let answered = false;
		const resume = h.call({ action: "resume", id: "relaunching:0", message: "one more thing" }).finally(() => {
			answered = true;
		});
		await sleep(100);
		assert.equal(answered, false, "resume waits while the wake decides whether the child runs again");
		h.disposeGate.resolve();
		const refused = await answeredWithin(resume);
		assert.ok(refused, "resume answers once the wake has relaunched the child, while that run goes on");
		const woken = h.latest("relaunching:0");
		assert.equal(woken?.state, "running");
		assert.equal(refused.isError, true);
		assert.match(text(refused), new RegExp(`already running as task ${woken?.taskId}; pause or quit it first`));
		assert.equal(resumeWaiterCount(), 0);
	} finally {
		h.disposeGate.resolve();
		green.resolve();
	}
	await waitForWakeCompletion(wake, "the wake's run");
	assert.equal(
		h.runs.filter((run) => readsOf(run).includes("one more thing")).length,
		0,
		"a refused resume never runs",
	);
});

test("resume messages batched behind a wake slot are delivered once in arrival order (#4326)", async () => {
	const h = harness();
	h.deps.config.parallel = { runningCapacity: 1 };
	const dispatcher = agentWakeDispatcher();
	const stop = bindReleasedChildWakes(h.deps, h.ctx, h.deps.pi.events, dispatcher);
	cleanups.push(async () => stop());
	h.wakeDispatcher = dispatcher;
	await releasedChildren(h, ["batch-slot", "batch-resume"]);
	const owner = h.sessionManager.getSessionId();
	const gate = Promise.withResolvers<void>();
	// Another child's woken run holds the only wake slot, so both resumes wait for it, in one batch.
	const wake = wakeWithResult(h, dispatcher, "batch-slot:0", gate);
	await h.waitForLatest("batch-slot:0", (record) => record.state === "running" && record.taskId !== undefined);
	const first = resumeReleasedChild(owner, "batch-resume:0", { prompt: "first note", message: "first note" });
	const second = resumeReleasedChild(owner, "batch-resume:0", { prompt: "second note", message: "second note" });
	assert.ok(first && second);
	assert.equal(resumeWaiterCount(), 2);
	gate.resolve();
	await wake;
	const [a, b] = await Promise.all([first, second]);
	assert.equal(a.kind, "restored");
	assert.equal(b.kind, "restored");
	assert.equal(resumeWaiterCount(), 0);
	const run = h.runs.find((item) => item.task === "first note");
	assert.ok(run);
	assert.deepEqual(run.options.resumeFollowUps, ["second note"]);
});

test("a failed released-child resume rejects with a typed error and leaves no admission waiter (#4326)", async () => {
	const h = harness();
	await releasedWithWakes(h, "resume-fails");
	h.agentDefined = false;
	const pending = resumeReleasedChild(h.sessionManager.getSessionId(), "resume-fails:0", { prompt: "continue" });
	assert.ok(pending);
	await assert.rejects(pending, (error: Error) => isReleasedChildError(error) && error.code === "child-unrestorable");
	assert.equal(resumeWaiterCount(), 0);
});

test("a concurrent direct restoration preserves the later resume message and tool result (#4326)", async () => {
	const h = harness();
	await releasedWithWakes(h, "restore-race");
	const gate = Promise.withResolvers<void>();
	h.finishOn.set("first wake", gate);
	const first = await restoreSubagentChild(h.deps, h.ctx, "restore-race:0", { prompt: "first wake" });
	assert.equal(first.kind, "restored");
	const green = waitResult("CI green");
	const second = restoreSubagentChild(h.deps, h.ctx, "restore-race:0", {
		prompt: "later resume",
		message: "later resume",
		toolResults: [green],
	});
	gate.resolve();
	const result = await second;
	assert.equal(result.kind, "restored");
	if (result.kind === "restored") await settled(h, result.taskId);
	assert.equal(h.runs.filter((run) => readsOf(run).includes("first wake")).length, 1);
	assert.equal(h.runs.filter((run) => readsOf(run).includes("CI green")).length, 1);
	assert.equal(
		h.runs.filter((run) => run.options.resumeFollowUps?.includes("later resume") || run.task === "later resume")
			.length,
		1,
	);
});

test("an SDK wake reopening during reload saves through its replacement owner (#5609)", async () => {
	const h = harness({ ownerless: true });
	const dispatcher = await releasedWithWakes(h, "sdk-reload");
	const id = "sdk-reload:0";
	let retired = false;
	const old = new Proxy(h.ctx, {
		get(target, key) {
			assert.ok(!retired, `access to retired owner: ${String(key)}`);
			return Reflect.get(target, key);
		},
	});
	const staleWrites: string[] = [];
	const first = {
		...h.deps,
		pi: {
			...h.deps.pi,
			appendEntry: async (type: string, data?: unknown) => {
				if (retired) staleWrites.push(type);
				await h.deps.pi.appendEntry(type, data);
			},
		},
	};
	const retireOwner = bindSubagentChildOwner(first.pi, old);
	const unbind = bindReleasedChildWakes(first, old, first.pi.events, dispatcher);
	const opening = gateRestoreOf(h, "subagent-worker-sdk-reload");
	const finish = Promise.withResolvers<void>();
	const wake = wakeWithResult(h, dispatcher, id, finish);
	try {
		await opening.reached;
		const retireSuccessor = bindSubagentChildOwner(h.deps.pi, h.ctx);
		const successor = bindReleasedChildWakes(h.deps, h.ctx, h.deps.pi.events, dispatcher);
		cleanups.push(async () => {
			successor();
			retireSuccessor();
		});
		retireOwner();
		unbind();
		retired = true;
		opening.gate.resolve();
		await wake;
		const running = h.latest(id);
		assert.equal(running?.state, "running");
		assert.ok(running.taskId);
		const refused = await h.call({ action: "resume", id });
		assert.match(text(refused), new RegExp(`already running as task ${running.taskId}`));
		assert.equal(h.runs.filter((run) => readsOf(run).includes("CI green")).length, 1);
		assert.deepEqual(staleWrites, []);
	} finally {
		opening.gate.resolve();
		finish.resolve();
		unbind();
	}
});

test("a wake saves an accepted task to the original owner's store if it retires before admission returns (#5609)", async () => {
	const h = harness();
	const id = "closed-wake:0";
	const dispatcher = await releasedWithWakes(h, "closed-wake");
	const runtime = createExtensionRuntime();
	const session = { sessionManager: h.sessionManager, _disposed: false };
	bindBuiltinChildRecordSession(runtime, session);
	installBuiltinChildRecordWriter(h.deps.pi, () => runtime);
	const retire = bindSubagentChildOwner(h.deps.pi, h.ctx);
	const sink = createSubagentChildRecordSink(h.deps.pi, h.ctx);
	const unbind = bindReleasedChildWakes(h.deps, h.ctx, h.deps.pi.events, dispatcher);
	const start = h.host.startAgentTask.bind(h.host);
	const finish = Promise.withResolvers<void>();
	let admitted: string | undefined;
	h.host.startAgentTask = async (intent, operation, _runner, schedule) => {
		const receipt = await start(
			intent,
			operation,
			() => ({
				result: finish.promise.then(() => ({ kind: "cancelled", cause: "user" })),
				cleanup: finish.promise.then(() => ({ kind: "reaped" })),
			}),
			schedule,
		);
		assert.ok(receipt.ok);
		admitted = receipt.value.taskId;
		retire();
		return receipt;
	};
	const wake = wakeWithResult(h, dispatcher, id, finish);
	try {
		await releasedChildWakeDecided(subagentWakeKey(h.sessionManager.getSessionId(), id));
		finish.resolve();
		await wake;
		const saved = (await h.sessionManager.getSessionStore().load(h.sessionManager.getSessionId())).entries
			.filter(isSubagentChildRecord)
			.filter(
				(entry) => entry.data?.childId === id && entry.data.taskId === admitted && entry.data.state === "running",
			);
		assert.equal(saved.length, 1);
		session._disposed = true;
		const failure = vi.spyOn(console, "error").mockImplementation(() => {});
		sink.record({ runId: "disposed", index: 0, agent: "worker", cwd: h.cwd, state: "running" });
		await sink.flushed?.();
		assert.match(String(failure.mock.calls[0]?.[1]), /no longer owns its writer/);
		failure.mockRestore();
		assert.equal(h.latest("disposed:0"), undefined);
		assert.match(subagentChildrenAwaitingResume(h.ctx, "disposed:0").join(""), /record-append-failed/);
	} finally {
		finish.resolve();
		unbind();
		retire();
	}
});

test("disposing an older extension generation leaves the newer resume handler bound (#4326)", async () => {
	const h = harness();
	const dispatcher = await releasedWithWakes(h, "reload-resume");
	const owner = h.sessionManager.getSessionId();
	const old = bindReleasedChildWakes(h.deps, h.ctx, h.deps.pi.events, dispatcher);
	const current = bindReleasedChildWakes(h.deps, h.ctx, h.deps.pi.events, dispatcher);
	old();
	cleanups.push(async () => current());
	const pending = resumeReleasedChild(owner, "reload-resume:0", { prompt: "continue after reload" });
	assert.ok(pending);
	const outcome = await pending;
	assert.equal(outcome.kind, "restored");
	assert.equal(resumeWaiterCount(), 0);
});

async function releasedChildren(h: Harness, runIds: readonly string[]): Promise<void> {
	h.releaseOriginal = true;
	for (const runId of runIds) {
		await settled(h, await h.admit(runId));
		await h.waitForLatest(`${runId}:0`, (record) => record.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS);
	}
	h.releaseOriginal = false;
}

test("a manual resume waits behind the wakes already using parallel.runningCapacity, and counts only until it is admitted (#4326)", async () => {
	const h = harness();
	h.deps.config.parallel = { runningCapacity: 1 };
	const dispatcher = agentWakeDispatcher();
	const stop = bindReleasedChildWakes(h.deps, h.ctx, h.deps.pi.events, dispatcher);
	cleanups.push(async () => stop());
	h.wakeDispatcher = dispatcher;
	await releasedChildren(h, ["slot-a", "slot-b"]);
	const owner = h.sessionManager.getSessionId();
	const wakeGate = Promise.withResolvers<void>();
	h.finishOn.set("CI green", wakeGate);
	const ranResumed = () => h.runs.filter((run) => readsOf(run).includes("go second")).length;

	const wake = dispatcher.deliver(subagentWakeKey(owner, "slot-a:0"), {
		id: "tool-result:ci-1",
		kind: "tool-result",
		toolResult: waitResult("CI green"),
	});
	await h.waitForLatest("slot-a:0", (record) => record.state === "running" && record.launchLeafId !== undefined);
	const resumed = h.call({ action: "resume", id: "slot-b:0", message: "go second" });
	const deadline = Date.now() + RECORD_WAIT_MS;
	while (dispatcher.stats().queued === 0 && ranResumed() === 0 && Date.now() < deadline) await sleep(10);

	assert.equal(ranResumed(), 0, "the resume waits while a wake holds the only slot");
	assert.deepEqual(
		{ running: dispatcher.stats().running, queued: dispatcher.stats().queued },
		{ running: 1, queued: 1 },
	);
	wakeGate.resolve();
	await wake;
	const response = await resumed;
	assert.equal(response.isError, undefined);
	await settled(h, resumedTaskId(response));
	assert.equal(await drained(dispatcher), 0);
});

/** A scripted model reply: `content` with `stopReason`. */
function parentReply(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]) {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
	queueMicrotask(() => stream.push({ type: "done", reason: stopReason === "toolUse" ? "toolUse" : "stop", message }));
	return stream;
}

/** The parent's turn: its model calls the subagent tool with `params` once, through the real turn loop, then stops. */
function parentTurn(h: Harness, params: Parameters<Harness["call"]>[0]): Agent {
	let replies = 0;
	const agent = new Agent({
		initialState: {
			systemPrompt: "parent",
			tools: [
				{
					name: "subagent",
					label: "subagent",
					description: "subagent",
					parameters: { type: "object", additionalProperties: true } as never,
					execute: (_id, args, signal) => h.call(args as typeof params, signal),
				},
			],
		},
		streamFn: () =>
			replies++ === 0
				? parentReply(
						[
							{
								type: "toolCall",
								id: "parent-call",
								name: "subagent",
								arguments: { ...params } as Record<string, never>,
							},
						],
						"toolUse",
					)
				: parentReply([{ type: "text", text: "done" }], "stop"),
	});
	void agent.prompt("go").catch(() => {});
	return agent;
}

function parentToolResultText(agent: Agent): string {
	const result = agent.state.messages.find((message) => message.role === "toolResult");
	assert.ok(result?.role === "toolResult", "the interrupted call has a result");
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

test("interrupting the parent's turn ends a resume still waiting for a wake slot, and withdraws it so the child never runs it (#5485)", async () => {
	const h = harness();
	h.deps.config.parallel = { runningCapacity: 1 };
	const dispatcher = agentWakeDispatcher();
	const stop = bindReleasedChildWakes(h.deps, h.ctx, h.deps.pi.events, dispatcher);
	cleanups.push(async () => stop());
	h.wakeDispatcher = dispatcher;
	await releasedChildren(h, ["turn-a", "turn-b"]);
	const owner = h.sessionManager.getSessionId();
	const wakeGate = Promise.withResolvers<void>();
	h.finishOn.set("CI green", wakeGate);
	const wake = dispatcher.deliver(subagentWakeKey(owner, "turn-a:0"), {
		id: "tool-result:ci-1",
		kind: "tool-result",
		toolResult: waitResult("CI green"),
	});
	try {
		await h.waitForLatest("turn-a:0", (record) => record.state === "running" && record.launchLeafId !== undefined);
		const turn = parentTurn(h, { action: "resume", id: "turn-b:0", message: "never sent" });
		const deadline = Date.now() + RECORD_WAIT_MS;
		while (dispatcher.stats().queued === 0 && Date.now() < deadline) await sleep(10);
		assert.equal(dispatcher.stats().queued, 1, "the resume waits for the only wake slot");

		turn.abort();
		assert.ok(await settlesWithin(turn.waitForIdle()), "the interrupted turn ends while the resume still waits");
		assert.match(parentToolResultText(turn), /Interrupted before .*turn-b:0.* took the resume: it was withdrawn/);
		assert.equal(resumeWaiterCount(), 0);
	} finally {
		wakeGate.resolve();
	}
	await wake;
	assert.equal(await drained(dispatcher), 0);
	assert.equal(
		h.runs.filter((run) => readsOf(run).includes("never sent")).length,
		0,
		"the withdrawn resume never runs",
	);
	assert.equal(h.latest("turn-b:0")?.terminalStatus, SUBAGENT_CHILD_RELEASED_STATUS, "the child stays released");
});

for (const action of ["pause", "quit"] as const) {
	test(`interrupting the parent's turn ends a ${action} still waiting for a plain child with just the stop and status guidance (#5485, #5600)`, async () => {
		const h = harness();
		const stuck = Promise.withResolvers<void>();
		h.stuckOn.set(ORIGINAL_TASK, stuck);
		const childId = `stuck-${action}:0`;
		const taskId = await h.admit(`stuck-${action}`);
		try {
			await h.waitForLatest(childId, (record) => record.taskId === taskId);
			const turn = parentTurn(h, { action, id: childId });
			const deadline = Date.now() + RECORD_WAIT_MS;
			while (taskExecutionKind(h, taskId) !== "cancelling" && Date.now() < deadline) await sleep(10);
			assert.equal(taskExecutionKind(h, taskId), "cancelling", `the ${action} waits for the child to stop`);

			turn.abort();
			assert.ok(
				await settlesWithin(turn.waitForIdle()),
				`the interrupted turn ends while the ${action} still waits`,
			);
			assert.equal(
				parentToolResultText(turn),
				`Interrupted before ${action} finished: the stop was requested and goes on. subagent({ action: "status", id: "${childId}" }) shows where the child stands.`,
			);
		} finally {
			stuck.resolve();
		}
		const stopped = await h.waitForLatest(childId, (record) => record.state === "terminal");
		assert.equal(stopped.terminalStatus, action === "pause" ? "paused" : "quit", `the ${action} took effect`);
	});
}

test("interrupting the parent's turn while its resume waits for a wake to reopen the child answers at once and sends nothing (#5485)", async () => {
	const h = harness();
	const dispatcher = await releasedWithWakes(h, "deciding");
	const wrapUp = Promise.withResolvers<void>();
	h.finishOn.set("wrap up", wrapUp);
	// The wake below reopens the child only once this run's session has closed.
	h.disposeGate = Promise.withResolvers<void>();
	const resumed = await h.call({ action: "resume", id: "deciding:0", message: "wrap up" });
	wrapUp.resolve();
	await settled(h, resumedTaskId(resumed));
	const green = Promise.withResolvers<void>();
	const wake = wakeWithResult(h, dispatcher, "deciding:0", green);
	try {
		await h.waitForLatest("deciding:0", (record) =>
			(record.heldToolResults ?? []).some((held) => held.toolCallId === "ci-1"),
		);
		const turn = parentTurn(h, { action: "resume", id: "deciding:0", message: "never sent while deciding" });
		await sleep(100);
		turn.abort();
		assert.ok(await settlesWithin(turn.waitForIdle()), "the interrupted turn ends while the wake still decides");
		assert.match(
			parentToolResultText(turn),
			/was being reopened, before it could be resumed: nothing was sent to it/,
		);
	} finally {
		h.disposeGate.resolve();
		green.resolve();
	}
	await waitForWakeCompletion(wake, "the wake's run");
	assert.equal(h.runs.filter((run) => readsOf(run).includes("never sent while deciding")).length, 0);
});

test("interrupting the parent's turn while its resume reopens a finished child says the resume goes on, and it does (#5485)", async () => {
	const h = harness();
	await releasedWithWakes(h, "direct");
	const wrapUp = Promise.withResolvers<void>();
	h.finishOn.set("wrap up", wrapUp);
	// The next resume reopens the child only once this run's session has closed.
	h.disposeGate = Promise.withResolvers<void>();
	const resumed = await h.call({ action: "resume", id: "direct:0", message: "wrap up" });
	wrapUp.resolve();
	await settled(h, resumedTaskId(resumed));
	const turn = parentTurn(h, { action: "resume", id: "direct:0", message: "goes on anyway" });
	await sleep(300);
	turn.abort();
	try {
		assert.ok(await settlesWithin(turn.waitForIdle()), "the interrupted turn ends while the child is reopened");
		assert.match(parentToolResultText(turn), /was being resumed: the resume had begun and goes on with your message/);
	} finally {
		h.disposeGate.resolve();
	}
	const deadline = Date.now() + RECORD_WAIT_MS;
	while (h.runs.filter((run) => readsOf(run).includes("goes on anyway")).length === 0 && Date.now() < deadline)
		await sleep(20);
	assert.equal(
		h.runs.filter((run) => readsOf(run).includes("goes on anyway")).length,
		1,
		"the begun resume runs once",
	);
});

test("interrupting the parent's turn after a wake took its resume says the resume goes on, and it does (#5485)", async () => {
	const h = harness();
	h.deps.config.parallel = { runningCapacity: 1 };
	const dispatcher = agentWakeDispatcher();
	const stop = bindReleasedChildWakes(h.deps, h.ctx, h.deps.pi.events, dispatcher);
	cleanups.push(async () => stop());
	h.wakeDispatcher = dispatcher;
	await releasedChildren(h, ["taken-a", "taken-b"]);
	const owner = h.sessionManager.getSessionId();
	const slotGate = Promise.withResolvers<void>();
	// taken-a's woken run holds the only wake slot; taken-b's result and the resume wait for it in one batch.
	const wakeA = wakeWithResult(h, dispatcher, "taken-a:0", slotGate);
	await h.waitForLatest("taken-a:0", (record) => record.state === "running" && record.launchLeafId !== undefined);
	const wakeB = dispatcher.deliver(subagentWakeKey(owner, "taken-b:0"), {
		id: "tool-result:ci-b",
		kind: "tool-result",
		toolResult: waitResult("B result"),
	});
	// Hold the resume once its wake has taken it: saving the results it carries blocks.
	const saved = Promise.withResolvers<void>();
	const reached = Promise.withResolvers<void>();
	const pi = h.deps.pi as unknown as { appendEntry(type: string, data?: SubagentChildRecord): Promise<void> };
	const append = pi.appendEntry.bind(pi);
	let armed = true;
	pi.appendEntry = async (type, data) => {
		if (armed && data?.childId === "taken-b:0" && (data.heldToolResults ?? []).length > 0) {
			armed = false;
			reached.resolve();
			await saved.promise;
		}
		await append(type, data);
	};
	const turn = parentTurn(h, { action: "resume", id: "taken-b:0", message: "taken message" });
	const deadline = Date.now() + RECORD_WAIT_MS;
	while (dispatcher.stats().queued < 2 && Date.now() < deadline) await sleep(10);
	assert.equal(dispatcher.stats().queued, 2, "taken-b's result and the resume wait for the slot");
	slotGate.resolve();
	await reached.promise;
	turn.abort();
	try {
		assert.ok(await settlesWithin(turn.waitForIdle()), "the interrupted turn ends");
		assert.match(parentToolResultText(turn), /the resume had begun and goes on with your message/);
	} finally {
		saved.resolve();
	}
	await wakeA;
	await wakeB;
	const end = Date.now() + RECORD_WAIT_MS;
	const ran = () =>
		h.runs.filter((run) => JSON.stringify([run.task, run.options.resumeFollowUps]).includes("taken message")).length;
	while (ran() === 0 && Date.now() < end) await sleep(20);
	assert.equal(ran(), 1, "the taken resume runs once");
});

test("a resume from a turn that was already interrupted sends nothing to a released child (#5485)", async () => {
	const h = harness();
	const dispatcher = await releasedWithWakes(h, "pre-aborted");
	const interrupted = new AbortController();
	interrupted.abort();
	const result = await h.call({ action: "resume", id: "pre-aborted:0", message: "never sent" }, interrupted.signal);
	assert.equal(result.isError, true);
	assert.match(text(result), /took the resume: it was withdrawn/);
	assert.equal(await drained(dispatcher), 0);
	assert.equal(resumeWaiterCount(), 0);
	assert.equal(h.runs.filter((run) => readsOf(run).includes("never sent")).length, 0, "the child never runs it");
	assert.equal(h.latest("pre-aborted:0")?.terminalStatus, SUBAGENT_CHILD_RELEASED_STATUS, "the child stays released");
});

test("a resume from an already interrupted turn leaves a paused child untouched (#5560)", async () => {
	const h = harness();
	const { record } = await h.launch("pre-aborted-direct");
	await h.call({ action: "pause", id: record.childId });
	const request = { action: "resume", id: record.childId, message: "follow up" } as const;
	const cancelled = await h.call(request, AbortSignal.abort());
	assert.equal(cancelled.isError, true);
	assert.match(text(cancelled), /withdrawn.*does not run it or get your message/);
	assert.equal(h.latest(record.childId)?.terminalStatus, "paused");
	await settled(h, resumedTaskId(await h.call(request)));
	assert.deepEqual(
		h.runs.map((run) => run.task),
		[ORIGINAL_TASK, "follow up"],
	);
});

test("a resume while a wake that did not reopen the child still finishes queues behind that wake, never running the child beside it (#5485)", async () => {
	const h = harness();
	// A child that finished: a result that reaches it later wakes it.
	const { record } = await h.launch("finishing");
	await h.call({ action: "pause", id: record.childId });
	await h.waitForLatest(record.childId, (latest) => latest.terminalStatus === "paused");
	await settled(h, resumedTaskId(await h.call({ action: "resume", id: record.childId, message: "finish up" })));
	await h.waitForLatest(record.childId, (latest) => latest.state === "terminal" && latest.terminalStatus === "ok");
	const owner = h.sessionManager.getSessionId();
	const key = subagentWakeKey(owner, "finishing:0");
	const dispatcher = new AgentWakeDispatcher();
	const decided = Promise.withResolvers<void>();
	const finishing = Promise.withResolvers<void>();
	const resumes: string[] = [];
	const stopHandling = handleReleasedChildWakes(
		h.ctx,
		{
			// This wake decides not to reopen the child, then takes a while to finish.
			wake: async () => {
				settleReleasedChildRelaunch(key);
				decided.resolve();
				await finishing.promise;
			},
			hold: async () => {},
			resume: async (record, request) => {
				resumes.push(request.message ?? "");
				return restoreSubagentChild(h.deps, h.ctx, record.childId, request);
			},
		},
		dispatcher,
	);
	const unbind = bindResumeDispatcher(owner, dispatcher);
	cleanups.push(async () => {
		finishing.resolve();
		stopHandling();
		unbind();
	});
	const wake = dispatcher.deliver(key, {
		id: "tool-result:late",
		kind: "tool-result",
		toolResult: waitResult("late result"),
	});
	await decided.promise;
	const resume = h.call({ action: "resume", id: "finishing:0", message: "after the wake" });
	await sleep(100);
	assert.equal(
		h.runs.filter((run) => readsOf(run).includes("after the wake")).length,
		0,
		"the resume waits for the wake to finish instead of reopening the child beside it",
	);
	finishing.resolve();
	const response = await resume;
	assert.equal(response.isError, undefined, text(response));
	assert.deepEqual(resumes, ["after the wake"], "the resume ran through the wake key, after the wake");
	await settled(h, resumedTaskId(response));
	await wake;
});

test("a wake saves the results it carries in the child's record before the child is restored, and the record no longer holds them once its run saved them (#4326)", async () => {
	const h = harness();
	const dispatcher = await releasedWithWakes(h, "save-first");
	const owner = h.sessionManager.getSessionId();
	const green = waitResult("CI green");
	const heldWhenRestoreBegan: Array<readonly DetachedToolResult[] | undefined> = [];
	const emit = h.deps.pi.events.emit.bind(h.deps.pi.events);
	h.deps.pi.events.emit = (channel: string, data: object) => {
		if (channel === SUBAGENT_RESERVE_RESTORING_CHILD_EVENT)
			heldWhenRestoreBegan.push(heldAsArrived(h.latest("save-first:0")?.heldToolResults));
		emit(channel, data);
	};
	const gate = Promise.withResolvers<void>();
	h.finishOn.set("CI green", gate);

	const woken = dispatcher.deliver(subagentWakeKey(owner, "save-first:0"), {
		id: "tool-result:ci-1",
		kind: "tool-result",
		toolResult: green,
	});
	await h.waitForLatest("save-first:0", (record) => record.state === "running" && record.launchLeafId !== undefined);
	gate.resolve();
	await woken;
	const done = await h.waitForLatest("save-first:0", clearedOk);
	await settled(h, done.taskId ?? "");

	assert.deepEqual(heldWhenRestoreBegan, [[green]], "stored before the child is reopened");
	// The records the owner saved, in order: the woken run starts holding the result, and lets it go only after.
	const saved = h.sessionManager
		.getEntries()
		.flatMap((entry) =>
			entry.type === "custom" &&
			entry.customType === SUBAGENT_CHILD_RECORD_TYPE &&
			(entry.data as SubagentChildRecord).childId === "save-first:0"
				? [entry.data as SubagentChildRecord]
				: [],
		);
	const ofWokenRun = saved.filter((record) => record.taskId === done.taskId);
	assert.deepEqual(
		heldAsArrived(ofWokenRun[0]?.heldToolResults),
		[green],
		"still held when its run starts, before it saved it",
	);
	assert.deepEqual(ofWokenRun.at(-1)?.heldToolResults, [], "let go once its run saved it");
	assert.equal(h.runs.filter((run) => readsLate(run, green)).length, 1);
});

/** Hold the supervisor capability a restore of `childName` asks for until `gate` settles: a restore stopped mid-way. */
function gateRestoreOf(h: Harness, childName: string) {
	const gate = Promise.withResolvers<void>();
	const reached = Promise.withResolvers<void>();
	const events = h.deps.pi.events as unknown as { emit(channel: string, data: object): void };
	const emit = events.emit.bind(events);
	let armed = true;
	events.emit = (channel, data) => {
		emit(channel, data);
		const request = data as { childName?: string; completion?: Promise<object> };
		if (!armed || channel !== SUBAGENT_SUPERVISOR_AUTHORIZATION_EVENT || request.childName !== childName) return;
		armed = false;
		const granted = request.completion;
		request.completion = gate.promise.then(() => granted as Promise<object>);
		reached.resolve();
	};
	return { gate, reached: reached.promise };
}

for (const action of ["pause", "quit"] as const) {
	const status = action === "pause" ? "paused" : "quit";
	test(`${action} during a released child's in-flight wake relaunches nothing and keeps its result for resume (#4845)`, async () => {
		const h = harness();
		const runId = `inflight-${action}`;
		const dispatcher = await releasedWithWakes(h, runId);
		const { gate, reached } = gateRestoreOf(h, `subagent-worker-${runId}`);
		const runsBefore = h.runs.length;
		const green = waitResult("CI green");
		const wake = dispatcher.deliver(subagentWakeKey(h.sessionManager.getSessionId(), `${runId}:0`), {
			id: "tool-result:ci-1",
			kind: "tool-result",
			toolResult: green,
		});
		await reached;

		const stopped = h.call({ action, id: `${runId}:0` });
		gate.resolve();
		const result = await stopped;
		await wake;

		assert.notEqual(result.isError, true, text(result));
		assert.equal(result.details.runControl?.children[0]?.state, status);
		assert.equal(h.runs.length, runsBefore, "the wake relaunched nothing");
		const latest = h.latest(`${runId}:0`);
		assert.equal(latest?.state, "terminal");
		assert.equal(latest?.terminalStatus, status);
		assert.deepEqual(heldAsArrived(latest?.heldToolResults), [green], "the wake's result is held for resume");
		const reserved = h.holds.flatMap((hold) => ("reserve" in hold ? [hold.reserve] : []));
		assert.ok(reserved.length > 0, "the restore held sends to the child");
		for (const capability of reserved)
			assert.ok(
				h.holds.some((hold) => "release" in hold && hold.release === capability),
				"the restore that relaunched nothing released its hold",
			);

		const resumed = await h.call({ action: "resume", id: `${runId}:0`, message: "go on" });
		await settled(h, resumedTaskId(resumed));
		assert.equal(h.runs.length, runsBefore + 1);
		assert.ok(readsLate(h.runs.at(-1), green), "resume delivers the held result once");
		assert.equal(h.runs.at(-1)?.task, "go on");
	});
}

for (const action of ["pause", "quit"] as const) {
	test(`${action} all holds a released child's result when it arrives during a later live stop (#5600)`, async () => {
		const h = harness();
		const runId = "released-first";
		const childId = `${runId}:0`;
		const dispatcher = await releasedWithWakes(h, runId);
		const later = await h.launch("later-live");
		const before = h.runs.length;
		const green = waitResult("CI green");
		duringCancelOf(h, later.taskId, () =>
			dispatcher.deliver(subagentWakeKey(h.sessionManager.getSessionId(), childId), {
				id: "tool-result:ci-1",
				kind: "tool-result",
				toolResult: green,
			}),
		);
		await h.call({ action, all: true });
		assert.equal(h.runs.length, before, "a result arriving after the child's stop does not wake it");
		assert.equal(h.latest(childId)?.terminalStatus, action === "pause" ? "paused" : "quit");
		assert.deepEqual(heldAsArrived(h.latest(childId)?.heldToolResults), [green]);
	});
}

test("pause with all: true stops the run a released child's wake started while a busy sibling was stopped first (#4845)", async () => {
	const h = harness();
	const dispatcher = agentWakeDispatcher();
	const unbind = bindReleasedChildWakes(h.deps, h.ctx, h.deps.pi.events, dispatcher);
	cleanups.push(async () => unbind());
	h.wakeDispatcher = dispatcher;
	const sibling = await h.launch("busy-sibling");
	h.releaseOriginal = true;
	const releasedTask = await h.admit("woken-meanwhile");
	await settled(h, releasedTask);
	await h.waitForLatest("woken-meanwhile:0", (record) => record.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS);
	h.releaseOriginal = false;
	const runGate = Promise.withResolvers<void>();
	h.finishOn.set("CI green", runGate);
	cleanups.push(async () => runGate.resolve());
	let wokenTask: string | undefined;
	duringCancelOf(h, sibling.taskId, async () => {
		void dispatcher.deliver(subagentWakeKey(h.sessionManager.getSessionId(), "woken-meanwhile:0"), {
			id: "tool-result:ci-1",
			kind: "tool-result",
			toolResult: waitResult("CI green"),
		});
		const running = await h.waitForLatest(
			"woken-meanwhile:0",
			(record) => record.state === "running" && record.taskId !== releasedTask,
		);
		wokenTask = running.taskId;
	});

	const paused = await h.call({ action: "pause", all: true });

	assert.notEqual(paused.isError, true, text(paused));
	assert.ok(wokenTask);
	assert.deepEqual(
		paused.details.runControl?.children.map((child) => [child.childId, child.state]),
		[
			["busy-sibling:0", "paused"],
			["woken-meanwhile:0", "paused"],
		],
	);
	const latest = await h.waitForLatest(
		"woken-meanwhile:0",
		(record) => record.state === "terminal" && record.terminalStatus === "paused" && record.taskId === wokenTask,
	);
	assert.equal(latest.taskId, wokenTask, "the record names the run the wake started, which pause stopped");
	await settled(h, wokenTask);
});

test("quit with all: true keeps a result held for a paused child while a sibling was stopped first, and resume delivers it (#4845)", async () => {
	const h = harness();
	const dispatcher = agentWakeDispatcher();
	const unbind = bindReleasedChildWakes(h.deps, h.ctx, h.deps.pi.events, dispatcher);
	cleanups.push(async () => unbind());
	h.wakeDispatcher = dispatcher;
	const sibling = await h.launch("quit-sibling");
	h.releaseOriginal = true;
	await settled(h, await h.admit("held-meanwhile"));
	await h.waitForLatest("held-meanwhile:0", (record) => record.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS);
	h.releaseOriginal = false;
	await h.call({ action: "pause", id: "held-meanwhile:0" });
	await h.waitForLatest("held-meanwhile:0", (record) => record.terminalStatus === "paused");
	const key = subagentWakeKey(h.sessionManager.getSessionId(), "held-meanwhile:0");
	const green = waitResult("CI green");
	await dispatcher.deliver(key, { id: "tool-result:ci-1", kind: "tool-result", toolResult: green });
	await h.waitForLatest("held-meanwhile:0", (record) => (record.heldToolResults ?? []).length === 1);
	const deployed = { ...waitResult("deploy done"), toolCallId: "deploy-2", toolName: "deploy" };
	duringCancelOf(h, sibling.taskId, async () => {
		await dispatcher.deliver(key, { id: "tool-result:deploy-2", kind: "tool-result", toolResult: deployed });
	});
	const runsBefore = h.runs.length;

	const quit = await h.call({ action: "quit", all: true });

	assert.notEqual(quit.isError, true, text(quit));
	const latest = h.latest("held-meanwhile:0");
	assert.equal(latest?.terminalStatus, "quit");
	assert.deepEqual(
		heldAsArrived(latest?.heldToolResults),
		[green, deployed],
		"quit keeps the result held while it stopped the sibling",
	);
	assert.equal(h.runs.length, runsBefore, "a paused child is not woken by the result");

	const resumed = await h.call({ action: "resume", id: "held-meanwhile:0", message: "go on" });
	await settled(h, resumedTaskId(resumed));
	const run = h.runs.at(-1);
	assert.deepEqual(run?.options.resumeLateToolResults, [green, deployed], "resume delivers each held result once");
	assert.equal(run?.task, "go on");
	assert.equal(run?.options.resumeFollowUps, undefined);
	assert.equal(run?.options.resumeNote?.text, SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT);
});

test("a child woken from its release and then paused while it waits on nothing is stopped, not parked at the broker (#4845)", async () => {
	const h = harness();
	const dispatcher = await releasedWithWakes(h, "rewoken");
	const runGate = Promise.withResolvers<void>();
	h.finishOn.set("CI green", runGate);
	cleanups.push(async () => runGate.resolve());
	void dispatcher.deliver(subagentWakeKey(h.sessionManager.getSessionId(), "rewoken:0"), {
		id: "tool-result:ci-1",
		kind: "tool-result",
		toolResult: waitResult("CI green"),
	});
	const woken = await h.waitForLatest("rewoken:0", (record) => record.state === "running");
	assert.deepEqual(woken.waitingOn ?? [], [], "the woken run waits on nothing yet");

	const paused = await h.call({ action: "pause", id: "rewoken:0" });
	assert.notEqual(paused.isError, true, text(paused));
	const latest = await h.waitForLatest(
		"rewoken:0",
		(record) => record.state === "terminal" && record.terminalStatus === "paused" && record.taskId === woken.taskId,
	);

	assert.deepEqual(latest.waitingOn ?? [], [], "the calls its earlier run waited on are no longer waited on");
	assert.equal(releasedChildReservation(latest), undefined, "the broker does not hold sends to it");
	assert.equal(endedChildMark(latest)?.outcome, "stopped", "a send to it is told it is stopped");
	const requests = h.releasedChildRequests.length;
	await reserveReleasedChildrenOf(h.deps.pi.events, h.sessionManager.getSessionId());
	assert.deepEqual(h.releasedChildRequests.slice(requests), [], "a reconnect reserves nothing for it");
});

test("pause while a wake still saves the result it carries neither wakes the child nor tells the broker it wakes (#4845)", async () => {
	const h = harness();
	const dispatcher = await releasedWithWakes(h, "saving");
	const saved = Promise.withResolvers<void>();
	const reached = Promise.withResolvers<void>();
	const pi = h.deps.pi as unknown as { appendEntry(type: string, data?: SubagentChildRecord): Promise<void> };
	const append = pi.appendEntry.bind(pi);
	let armed = true;
	pi.appendEntry = async (type, data) => {
		if (armed && data?.childId === "saving:0" && (data.heldToolResults ?? []).length > 0) {
			armed = false;
			reached.resolve();
			await saved.promise;
		}
		await append(type, data);
	};
	const runsBefore = h.runs.length;
	const acknowledged = () => h.releasedChildRequests.filter((request) => "acknowledge" in request).length;
	const acknowledgedBefore = acknowledged();
	const green = waitResult("CI green");
	const wake = dispatcher.deliver(subagentWakeKey(h.sessionManager.getSessionId(), "saving:0"), {
		id: "tool-result:ci-1",
		kind: "tool-result",
		toolResult: green,
	});
	await reached.promise;

	const paused = h.call({ action: "pause", id: "saving:0" });
	saved.resolve();
	const result = await paused;
	await wake;

	assert.notEqual(result.isError, true, text(result));
	assert.equal(h.runs.length, runsBefore, "the wake relaunched nothing");
	assert.equal(acknowledged(), acknowledgedBefore, "the broker is not told the child wakes");
	assert.equal(h.latest("saving:0")?.terminalStatus, "paused");
	assert.deepEqual(heldAsArrived(h.latest("saving:0")?.heldToolResults), [green]);
});

for (const action of ["pause", "quit"] as const) {
	test(`a released child ${action === "pause" ? "paused" : "quit"}, resumed and released again is woken by its next result exactly once (#4845)`, async () => {
		const h = harness();
		const runId = `again-${action}`;
		const dispatcher = await releasedWithWakes(h, runId);
		const stopped = await h.call({ action, id: `${runId}:0` });
		assert.notEqual(stopped.isError, true, text(stopped));
		h.releaseOn.add("release once more");
		const resumed = await h.call({ action: "resume", id: `${runId}:0`, message: "release once more" });
		await settled(h, resumedTaskId(resumed));
		const released = await h.waitForLatest(
			`${runId}:0`,
			(record) =>
				record.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS && record.taskId === resumedTaskId(resumed),
		);
		h.releaseOn.clear();
		const runsBefore = h.runs.length;

		await dispatcher.deliver(subagentWakeKey(h.sessionManager.getSessionId(), `${runId}:0`), {
			id: "tool-result:ci-1",
			kind: "tool-result",
			toolResult: waitResult("CI green"),
		});

		assert.equal(h.runs.length, runsBefore + 1, "the earlier stop does not keep the wake from relaunching it");
		assert.equal(h.runs.filter((run) => readsOf(run).includes("CI green")).length, 1);
		await h.waitForLatest(
			`${runId}:0`,
			(record) => record.state === "terminal" && record.terminalStatus === "ok" && record.taskId !== released.taskId,
		);
	});
}

test("a restore told to refuse its relaunch runs nothing, reports the child's latest record and releases its hold (#4845)", async () => {
	const h = harness();
	await releasedWithWakes(h, "refused");
	const latest = h.latest("refused:0");
	assert.ok(latest);
	const runsBefore = h.runs.length;
	const outcome = await restoreSubagentChild(h.deps, h.ctx, "refused:0", { prompt: "go" }, () => latest);
	assert.deepEqual(outcome, { kind: "terminal", record: latest });
	assert.equal(h.runs.length, runsBefore);
	const reserved = h.holds.flatMap((hold) => ("reserve" in hold ? [hold.reserve] : []));
	assert.ok(reserved.length > 0);
	for (const capability of reserved)
		assert.ok(h.holds.some((hold) => "release" in hold && hold.release === capability));
});

test("pause of a released child whose resume is starting it stops the resumed run (#4845)", async () => {
	const h = harness();
	await releasedWithWakes(h, "resuming");
	h.resumedRunsWait = true;
	const { gate, reached } = gateRestoreOf(h, "subagent-worker-resuming");
	const resume = h.call({ action: "resume", id: "resuming:0", message: "keep going" });
	await reached;

	const paused = h.call({ action: "pause", id: "resuming:0" });
	gate.resolve();
	const resumed = await resume;
	const result = await paused;

	assert.notEqual(resumed.isError, true, text(resumed));
	assert.notEqual(result.isError, true, text(result));
	const taskId = resumedTaskId(resumed);
	assert.deepEqual(
		result.details.runControl?.children.map((child) => [child.childId, child.state, child.taskId]),
		[["resuming:0", "paused", taskId]],
	);
	assert.doesNotMatch(text(result), /released/, "it is stopped as the running child it now is");
	await settled(h, taskId);
	await h.waitForLatest(
		"resuming:0",
		(record) => record.state === "terminal" && record.terminalStatus === "paused" && record.taskId === taskId,
	);
});

test("a result batched with a resume is kept for the child when the resumed run is paused before saving it (#5012)", async () => {
	const h = harness();
	const dispatcher = await releasedWithWakes(h, "resume-batch");
	const owner = h.sessionManager.getSessionId();
	const childId = "resume-batch:0";
	const key = subagentWakeKey(owner, childId);
	const released = h.latest(childId);
	assert.ok(released);
	await endChildSessionOnCalls(released, [RELEASED_CALL]);
	const resumedRun = Promise.withResolvers<void>();
	h.finishOn.set("resume note", resumedRun);
	const green = waitResult("CI green");
	// A wake that asks for nothing is being handled, so the result and the resume behind it arrive in one batch.
	const idle = dispatcher.deliver(key, { id: "redispatch:none", kind: "tool-result" });
	const result = dispatcher.deliver(key, { id: "tool-result:ci-1", kind: "tool-result", toolResult: green });
	const resumed = resumeReleasedChild(owner, childId, { prompt: "resume note", message: "resume note" });
	assert.ok(resumed);
	await idle;
	const outcome = await resumed;
	assert.equal(outcome.kind, "restored", JSON.stringify(outcome));
	await result;
	assert.equal(h.runs.length, 2, "one run takes the resume and the result together");
	assert.deepEqual(h.runs.at(-1)?.options.resumeToolResults, [green]);
	// The resumed run is paused before it saved the result.
	await h.waitForLatest(childId, (record) => record.state === "running");
	await h.call({ action: "pause", id: childId });
	const paused = await h.waitForLatest(childId, (record) => record.terminalStatus === "paused");
	h.finishOn.clear();

	await h.call({ action: "resume", id: childId });
	// That run continues the turn with the result and finishes, and the record no longer holds it.
	await h.waitForLatest(
		childId,
		(record) => h.runs.length === 3 && record.taskId !== paused.taskId && clearedOk(record),
	);

	assert.deepEqual(h.runs.at(-1)?.options.resumeToolResults, [green], "the resume after the pause hands it over");
});

test("a released child of the earlier process told a call is still running starts its waited call again once and hears of the lost call once (#5014)", async () => {
	const h = harness();
	const deploy = { toolCallId: "deploy-2", toolName: "wait_for_deploy" };
	await releasedByEarlierProcess(h, "restart-still", {
		stillRunning: [{ ...deploy, ownerGeneration: "earlier-process" }],
	});
	const redispatched = Promise.withResolvers<DetachedToolResult>();
	h.redispatchCalls = [{ ...RELEASED_CALL, result: redispatched.promise, abort() {} }];
	const lost = interruptedStillRunningResult(deploy);
	const toldLost = () => h.runs.filter((run) => readsLate(run, lost));

	const dispatcher = bindProcessWakes(h);
	const heard = await h.waitForLatest("restart-still:0", (record) => toldLost().length > 0 && clearedOk(record));
	assert.ok(heard.taskId);
	await settled(h, heard.taskId);
	await dispatcher.whenIdle();
	assert.equal(h.runs.filter((run) => run.options.redispatchDetachedCalls).length, 1, "its call starts again once");

	const green = waitResult("CI green after the restart");
	redispatched.resolve(green);
	await h.waitForLatest(
		"restart-still:0",
		(record) => h.runs.some((run) => readsLate(run, green)) && clearedOk(record),
	);
	await dispatcher.whenIdle();
	assert.equal(toldLost().length, 1, "the lost call is reported once");
	assert.equal(h.runs.filter((run) => run.options.redispatchDetachedCalls).length, 1);
});
