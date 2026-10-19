import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import { afterEach, test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type { TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agents.js";
import { SUBAGENT_SUPERVISOR_AUTHORIZATION_EVENT } from "../../packages/subagents/src/intercom/supervisor-authorization.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import {
	createSubagentChildRecordSink,
	readSubagentChildRecords,
	SUBAGENT_CHILD_RECORD_TYPE,
	type SubagentChildRecord,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import {
	SUBAGENT_AWAIT_INTERCOM_PEER_EVENT,
	SUBAGENT_RELEASE_RESTORING_CHILD_EVENT,
	SUBAGENT_RESERVE_RESTORING_CHILD_EVENT,
	type SubagentReleaseRestoringChildRequest,
	type SubagentReserveRestoringChildRequest,
} from "../../packages/subagents/src/runs/foreground/subagent-child-restore.js";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import type { ExecutorDeps } from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import { SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT } from "../../packages/subagents/src/runs/foreground/subagent-run-control.js";
import { runAgentTask } from "../../packages/subagents/src/runs/foreground/task-execution.js";
import type { RunSyncOptions, SingleResult, SubagentToolResult } from "../../packages/subagents/src/shared/types.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";

const ORIGINAL_TASK = "original task";
const RECORD_WAIT_MS = 5_000;

const agent: AgentConfig = {
	name: "worker",
	description: "worker",
	source: "project",
	filePath: "worker.md",
	systemPrompt: "Work",
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
};

interface Harness {
	readonly cwd: string;
	readonly host: AgentTaskHost;
	readonly sessionManager: SessionManager;
	readonly ctx: ExtensionContext;
	/** Every child run: the prompt it received and its options. */
	readonly runs: Array<{ task: string; options: RunSyncOptions }>;
	readonly authorizations: string[];
	readonly holds: Array<{ reserve: string; aliases: readonly string[] } | { release: string; gone?: string }>;
	/** How the next child run settles once its prompt runs; the original launch always waits until stopped. */
	settleAs: "ok" | "error";
	call(params: Parameters<ReturnType<typeof createSubagentExecutor>["execute"]>[1]): Promise<SubagentToolResult>;
	launch(runId: string): Promise<{ record: SubagentChildRecord; taskId: TaskId }>;
	latest(childId: string): SubagentChildRecord | undefined;
	waitForLatest(childId: string, accept: (record: SubagentChildRecord) => boolean): Promise<SubagentChildRecord>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function harness(): Harness {
	const cwd = makeTempDirectory("subagent-run-control-");
	const host = new AgentTaskHost({
		scope: { kind: "session", sessionId: `run-control-${randomUUID()}` },
		authorizeLaunch() {},
	});
	const sessionManager = SessionManager.inMemory(cwd);
	const runs: Harness["runs"] = [];
	const authorizations: string[] = [];
	const holds: Harness["holds"] = [];
	const events = {
		on: () => () => {},
		emit(channel: string, data: object) {
			if (channel === SUBAGENT_SUPERVISOR_AUTHORIZATION_EVENT) {
				const request = data as { childName: string; completion?: Promise<object> };
				authorizations.push(request.childName);
				request.completion = Promise.resolve({
					capability: `fresh-capability-${authorizations.length}`,
					supervisorSessionId: "parent",
					childName: request.childName,
				});
			}
			if (channel === SUBAGENT_AWAIT_INTERCOM_PEER_EVENT)
				(data as { completion?: Promise<boolean> }).completion = Promise.resolve(true);
			if (channel === SUBAGENT_RESERVE_RESTORING_CHILD_EVENT) {
				const request = data as SubagentReserveRestoringChildRequest;
				holds.push({ reserve: request.capability, aliases: request.aliases });
				request.completion = Promise.resolve();
			}
			if (channel === SUBAGENT_RELEASE_RESTORING_CHILD_EVENT) {
				const request = data as SubagentReleaseRestoringChildRequest;
				holds.push({ release: request.capability, ...(request.gone === undefined ? {} : { gone: request.gone }) });
				request.completion = Promise.resolve();
			}
		},
	};
	const pi = {
		events,
		appendEntry: async (customType: string, data?: SubagentChildRecord) => {
			await sessionManager.appendCustomEntry(customType, data);
		},
		getSessionName: () => "parent",
	} as unknown as ExecutorDeps["pi"];
	const neverReleased = Promise.withResolvers<void>();
	const state: Harness = {
		cwd,
		host,
		sessionManager,
		ctx: {
			cwd,
			mode: "tui",
			hasUI: false,
			ui: {},
			sessionManager,
			getAgentTaskHost: () => host,
			modelRegistry: { getAvailable: () => [], getAll: () => [], find: () => undefined },
			model: undefined,
			thinkingLevel: undefined,
		} as unknown as ExtensionContext,
		runs,
		authorizations,
		holds,
		settleAs: "ok",
		call: (params) => executor.execute("run-control", params, new AbortController().signal, undefined, state.ctx),
		async launch(runId) {
			const response = await runAgentTask({
				host,
				cwd,
				agents: [agent],
				agent: "worker",
				task: ORIGINAL_TASK,
				options: {
					cwd,
					runId,
					index: 0,
					sessionDir: join(cwd, "children", runId),
					intercomSessionName: `subagent-worker-${runId}`,
					intercomGroup: "lane-group",
					orchestratorIntercomTarget: "parent",
				},
				wait: { kind: "background" },
				recordChild: createSubagentChildRecordSink(pi, state.ctx),
				runtime: { runSync: runtime },
			});
			assert.equal(response.kind, "admitted");
			assert.ok(response.kind === "admitted");
			const record = await state.waitForLatest(`${runId}:0`, (candidate) => candidate.launchLeafId !== undefined);
			return { record, taskId: response.observation.taskId as TaskId };
		},
		latest: (childId) => readSubagentChildRecords(sessionManager.getEntries()).get(childId),
		async waitForLatest(childId, accept) {
			const deadline = Date.now() + RECORD_WAIT_MS;
			while (Date.now() < deadline) {
				const record = state.latest(childId);
				if (record && accept(record)) return record;
				await sleep(10);
			}
			throw new Error(
				`child ${childId} never reached the expected record: ${JSON.stringify(state.latest(childId))}`,
			);
		},
	};
	const runtime = async (...args: Parameters<typeof runSync>): Promise<SingleResult> => {
		const [parentCwd, agents, agentName, task, options] = args;
		runs.push({ task, options });
		const original = task === ORIGINAL_TASK;
		const result = await runSync(parentCwd, agents, agentName, task, {
			...options,
			testSession: original
				? { output: "partial", promptGate: neverReleased.promise, abortResolvesPrompt: true }
				: { output: "resumed" },
		});
		return !original && state.settleAs === "error" ? { ...result, status: "error", error: "boom" } : result;
	};
	const executor = createSubagentExecutor({
		pi,
		state: {
			baseCwd: cwd,
			currentSessionId: "parent",
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
		runtime: { runSync: runtime },
	});
	cleanups.push(async () => {
		neverReleased.resolve();
		await host.close("session-close");
		removeTempDirectory(cwd);
	});
	return state;
}

function text(result: SubagentToolResult): string {
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

function transcript(record: SubagentChildRecord): string {
	assert.ok(record.childSessionFile);
	return readFileSync(record.childSessionFile, "utf8");
}

function occurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

async function settled(h: Harness, taskId: string): Promise<void> {
	const observed = await h.host.waitForTask(taskId as TaskId);
	assert.ok(observed.ok && observed.value.kind === "settled", JSON.stringify(observed));
}

function resumedTaskId(result: SubagentToolResult): string {
	const taskId = result.details.runControl?.children[0]?.taskId;
	assert.ok(taskId, text(result));
	return taskId;
}

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
		{ kind: "cancelled", cause: "parent-handoff" },
		"pause is never an owner cancellation",
	);
	const latest = await h.waitForLatest(record.childId, (candidate) => candidate.state === "terminal");
	assert.equal(latest.terminalStatus, "paused");
	assert.deepEqual(h.holds, [{ reserve: "fresh-capability-1", aliases: [record.childSessionId] }]);

	const again = await h.call({ action: "pause", id: record.childId });
	assert.notEqual(again.isError, true);
	assert.match(text(again), /is already paused/);
});

test("resume with a message continues a paused child in the same run identity and delivers the message once", async () => {
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
	const childTranscript = transcript(final);
	assert.equal(occurrences(childTranscript, message), 1);
	assert.equal(occurrences(childTranscript, ORIGINAL_TASK), 1);
	assert.equal(occurrences(childTranscript, SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT), 0);
});

test("quit stops a running child gracefully and resume without a message continues where it left off", async () => {
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
	assert.equal(h.runs.at(-1)?.task, SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT);
	assert.equal(h.runs.at(-1)?.options.supervisorAuthorization?.capability, "fresh-capability-1");
	const final = await h.waitForLatest(
		record.childId,
		(candidate) => candidate.taskId === newTaskId && candidate.state === "terminal",
	);
	assert.equal(occurrences(transcript(final), SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT), 1);
});

test("quitting an already-paused child keeps it resumable and resume then succeeds", async () => {
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
});

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

test("resume continues completed and failed children in the same run identity", async () => {
	const h = harness();
	const { record, taskId } = await h.launch("done1");
	await h.call({ action: "quit", id: record.childId });
	await settled(h, taskId);

	const first = await h.call({ action: "resume", id: record.childId, message: "finish up" });
	await settled(h, resumedTaskId(first));
	const completed = await h.waitForLatest(record.childId, (candidate) => candidate.terminalStatus === "ok");

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
	const childTranscript = transcript(completed);
	for (const message of ["finish up", "try the edge case", "once more"])
		assert.equal(occurrences(childTranscript, message), 1);
});

test("resume refuses a child that is still running", async () => {
	const h = harness();
	const { record } = await h.launch("live1");
	const result = await h.call({ action: "resume", id: record.childId });
	assert.equal(result.isError, true);
	assert.match(text(result), /already running/);
});

test("resume reports an unknown child id as an error", async () => {
	const h = harness();
	const result = await h.call({ action: "resume", id: "no-such-child" });
	assert.equal(result.isError, true);
	assert.match(text(result), /Unknown subagent 'no-such-child'/);
	assert.equal(h.runs.length, 0);
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
