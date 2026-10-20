import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession, ExtensionContext } from "@bastani/atomic";
import { afterEach, test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type { TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { WorkflowStageAdmissionBoundary } from "../../packages/coding-agent/src/core/workflow-stage-admission.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agents.js";
import { SUBAGENT_SUPERVISOR_AUTHORIZATION_EVENT } from "../../packages/subagents/src/intercom/supervisor-authorization.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import {
	createSubagentChildRecordSink,
	readSubagentChildRecords,
	SUBAGENT_CHILD_RECORD_TYPE,
	SUBAGENT_CHILD_STAGE_CLOSED_STATUS,
	SUBAGENT_CHILD_STAGE_PAUSED_STATUS,
	type SubagentChildRecord,
	WORKFLOW_STAGE_CLOSED_FOR_GOOD_STATE,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import {
	restoreSubagentChildren,
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
import { createExecutionScheduler } from "../../packages/subagents/src/runs/shared/parallel-utils.js";
import type {
	RunSyncOptions,
	SingleResult,
	SubagentToolResult,
	TestSessionQueue,
} from "../../packages/subagents/src/shared/types.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { createCancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { quitRun } from "../../packages/workflows/src/runs/background/quit.js";
import { killRun, pauseRun, resumeRun } from "../../packages/workflows/src/runs/background/status.js";
import { run as runWorkflow } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { WORKFLOW_STAGE_CLOSED_FOR_GOOD_STATE as WORKFLOWS_STAGE_CLOSED_FOR_GOOD_STATE } from "../../packages/workflows/src/runs/foreground/stage-runner-controller.js";
import { createStore as createWorkflowStore } from "../../packages/workflows/src/shared/store.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

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
	host: AgentTaskHost;
	readonly deps: ExecutorDeps;
	/** The owner's workflow-stage extension state, for a harness whose owner is a workflow stage. */
	readonly stageState?: Map<string, object>;
	/** The owner's workflow-stage generation boundary; a stage session closes it when its generation ends. */
	readonly stageBoundary?: WorkflowStageAdmissionBoundary;
	/** Close the owner's tasks as Atomic exiting, switching sessions, or a stage generation closing does, then reopen it. */
	closeOwnerAndReopen(cause: "session-close" | "stage-close"): Promise<void>;
	readonly sessionManager: SessionManager;
	readonly ctx: ExtensionContext;
	/** Every child run: the prompt it received and its options. */
	readonly runs: Array<{ task: string; options: RunSyncOptions }>;
	readonly authorizations: string[];
	readonly holds: Array<{ reserve: string; aliases: readonly string[] } | { release: string; gone?: string }>;
	/** How the next child run settles once its prompt runs; the original launch always waits until stopped. */
	settleAs: "ok" | "error";
	/** Whether resumed runs also wait until stopped, instead of settling once their prompt runs. */
	resumedRunsWait: boolean;
	/** Receives each child run's stub session, to queue steering and follow-up messages as an SDK caller does. */
	onSession?: (session: TestSessionQueue) => void;
	/** Whether the worker agent is still defined; resume looks it up again. */
	agentDefined: boolean;
	/** Runs whose prompt contains a key wait until its gate resolves, then complete; checked before the rules above. */
	readonly finishOn: Map<string, PromiseWithResolvers<void>>;
	call(params: Parameters<ReturnType<typeof createSubagentExecutor>["execute"]>[1]): Promise<SubagentToolResult>;
	launch(runId: string): Promise<{ record: SubagentChildRecord; taskId: TaskId }>;
	/** Admit a child through `schedule`, as a parallel launch does, without waiting for it to start. */
	admit(runId: string, schedule?: (dispatch: () => Promise<void>) => void): Promise<TaskId>;
	latest(childId: string): SubagentChildRecord | undefined;
	waitForLatest(childId: string, accept: (record: SubagentChildRecord) => boolean): Promise<SubagentChildRecord>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function newHost(): AgentTaskHost {
	return new AgentTaskHost({
		scope: { kind: "session", sessionId: `run-control-${randomUUID()}` },
		authorizeLaunch() {},
	});
}

function harness(options: { stage?: boolean } = {}): Harness {
	const cwd = makeTempDirectory("subagent-run-control-");
	let host = newHost();
	const stageState = options.stage ? new Map<string, object>() : undefined;
	const stageBoundary = options.stage ? new WorkflowStageAdmissionBoundary() : undefined;
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
		get deps() {
			return deps;
		},
		...(stageState ? { stageState } : {}),
		...(stageBoundary ? { stageBoundary } : {}),
		async closeOwnerAndReopen(cause) {
			await host.close(cause);
			host = newHost();
			state.host = host;
		},
		sessionManager,
		ctx: {
			cwd,
			mode: "tui",
			hasUI: false,
			ui: {},
			sessionManager,
			getAgentTaskHost: () => host,
			...(stageState
				? {
						orchestrationContext: {
							kind: "workflow-stage",
							workflowRunId: "wf-run",
							workflowStageId: "stage-1",
							workflowStageName: "build",
							constraints: { disableWorkflowTool: true },
							messageAdmission: {
								extensionState: stageState,
								boundary: stageBoundary,
								isOpen: () => stageBoundary?.isOpen() === true,
							},
						},
					}
				: {}),
			modelRegistry: { getAvailable: () => [], getAll: () => [], find: () => undefined },
			model: undefined,
			thinkingLevel: undefined,
		} as unknown as ExtensionContext,
		runs,
		authorizations,
		holds,
		settleAs: "ok",
		resumedRunsWait: false,
		agentDefined: true,
		finishOn: new Map(),
		call: (params) => executor.execute("run-control", params, new AbortController().signal, undefined, state.ctx),
		async launch(runId) {
			const taskId = await state.admit(runId);
			const record = await state.waitForLatest(`${runId}:0`, (candidate) => candidate.launchLeafId !== undefined);
			return { record, taskId };
		},
		async admit(runId, schedule) {
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
				...(schedule ? { schedule } : {}),
			});
			assert.equal(response.kind, "admitted");
			assert.ok(response.kind === "admitted");
			return response.observation.taskId as TaskId;
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
		const gate = [...state.finishOn].find(([marker]) => task.includes(marker))?.[1];
		const onSession = state.onSession ? { onSession: state.onSession } : {};
		const result = await runSync(parentCwd, agents, agentName, task, {
			...options,
			testSession: gate
				? { output: "finished", promptGate: gate.promise, abortResolvesPrompt: true, ...onSession }
				: original || state.resumedRunsWait
					? { output: "partial", promptGate: neverReleased.promise, abortResolvesPrompt: true, ...onSession }
					: { output: "resumed", ...onSession },
		});
		return !original && state.settleAs === "error" ? { ...result, status: "error", error: "boom" } : result;
	};
	const deps: ExecutorDeps = {
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
		discoverAgents: () => ({ agents: state.agentDefined ? [agent] : [] }),
		runtime: { runSync: runtime },
	};
	const executor = createSubagentExecutor(deps);
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
	assert.deepEqual(
		relaunch.options.resumeFollowUps,
		[SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT],
		"the paused turn continues after the steer",
	);
	const childTranscript = transcript(final);
	assert.equal(occurrences(childTranscript, message), 1);
	assert.equal(occurrences(childTranscript, JSON.stringify(ORIGINAL_TASK)), 1);
	assert.equal(occurrences(childTranscript, SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT), 1);
	assert.ok(
		childTranscript.indexOf(message) < childTranscript.indexOf(SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT),
		"the steer is delivered before the continuation",
	);
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

	assert.deepEqual(h.runs.at(-1)?.options.resumeFollowUps, [SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT]);

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
});

test("resume without a message continues a finished child with the continuation prompt", async () => {
	const h = harness();
	const { record, taskId } = await h.launch("idle1");
	await h.call({ action: "quit", id: record.childId });
	await settled(h, taskId);
	await settled(h, resumedTaskId(await h.call({ action: "resume", id: record.childId, message: "wrap up" })));
	await h.waitForLatest(record.childId, (candidate) => candidate.terminalStatus === "ok");

	const result = await h.call({ action: "resume", id: record.childId });
	assert.notEqual(result.isError, true, text(result));
	await settled(h, resumedTaskId(result));
	assert.equal(h.runs.at(-1)?.task, SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT);
	assert.equal(h.runs.at(-1)?.options.resumeFollowUps, undefined);
	assert.equal(h.runs.at(-1)?.options.sessionManager?.getSessionId(), record.childSessionId);
});

test("a workflow stage generation closing for good ends its children, and resume names why (#3760)", async () => {
	assert.equal(
		WORKFLOW_STAGE_CLOSED_FOR_GOOD_STATE,
		WORKFLOWS_STAGE_CLOSED_FOR_GOOD_STATE,
		"subagents reads the state the workflows extension sets",
	);
	const h = harness({ stage: true });
	const { record, taskId } = await h.launch("stage1");
	assert.equal(record.owner.kind, "workflow-stage");
	h.stageState?.set(WORKFLOW_STAGE_CLOSED_FOR_GOOD_STATE, { closedForGood: true });
	const closing = h.host;
	await h.closeOwnerAndReopen("stage-close");
	const observed = await closing.waitForTask(taskId);
	assert.ok(!observed.ok || observed.value.kind === "settled");
	const ended = await h.waitForLatest(record.childId, (candidate) => candidate.state === "terminal");
	assert.equal(ended.terminalStatus, SUBAGENT_CHILD_STAGE_CLOSED_STATUS);

	const result = await h.call({ action: "resume", id: record.childId });
	assert.equal(result.isError, true);
	assert.match(text(result), /is terminal and cannot be resumed: its workflow stage ended/);
	assert.deepEqual(await restoreSubagentChildren(h.deps, h.ctx), [], "stage resume never restores it either");
	assert.equal(h.runs.length, 1);
});

test("a workflow stage pause keeps its children resumable, never killed, and resume continues them (#3760)", async () => {
	const h = harness({ stage: true });
	const { record, taskId } = await h.launch("stagepause1");
	await h.host.pauseTasks();
	const observed = await h.host.waitForTask(taskId);
	assert.ok(observed.ok && observed.value.kind === "settled");
	assert.notEqual(
		"cause" in observed.value.result ? observed.value.result.cause : "",
		"user",
		"a stage pause is not a user cancellation",
	);
	const paused = await h.waitForLatest(record.childId, (candidate) => candidate.state === "terminal");
	assert.equal(paused.terminalStatus, SUBAGENT_CHILD_STAGE_PAUSED_STATUS);

	h.host.resumeTasks();
	const result = await h.call({ action: "resume", id: record.childId });
	assert.notEqual(result.isError, true, text(result));
	assert.match(text(result), /Resumed worker \(stagepause1:0/);
	await settled(h, resumedTaskId(result));
	assert.equal(h.runs.at(-1)?.task, SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT);
	assert.equal(h.runs.at(-1)?.options.sessionManager?.getSessionId(), record.childSessionId);
});

test("children of a workflow stage paused by a quit, Atomic exit or session switch are restored when the stage resumes (#3760)", async () => {
	const h = harness({ stage: true });
	const { record } = await h.launch("stagequit1");
	await h.host.pauseTasks();
	await h.waitForLatest(record.childId, (candidate) => candidate.state === "terminal");
	await h.closeOwnerAndReopen("stage-close");
	assert.equal(h.latest(record.childId)?.terminalStatus, SUBAGENT_CHILD_STAGE_PAUSED_STATUS);

	const [outcome] = await restoreSubagentChildren(h.deps, h.ctx);
	assert.equal(outcome?.kind, "restored", JSON.stringify(outcome));
	assert.ok(outcome?.kind === "restored");
	await settled(h, outcome.taskId);
	assert.equal(h.runs.length, 2);
	assert.equal(h.runs.at(-1)?.options.runId, "stagequit1");
	assert.equal(h.runs.at(-1)?.options.sessionManager?.getSessionId(), record.childSessionId);
});

interface StageRun {
	readonly runId: string;
	readonly store: ReturnType<typeof createWorkflowStore>;
	readonly registry: ReturnType<typeof createStageControlRegistry>;
	readonly cancellation: ReturnType<typeof createCancellationRegistry>;
	readonly execution: ReturnType<typeof runWorkflow>;
	/** Let the stage's current prompt finish, so the stage completes. */
	finish(): void;
}

/** Run a one-stage workflow whose stage session is the harness owner: same orchestration context, boundary and task host. */
async function startStageRun(h: Harness, runId: string): Promise<StageRun> {
	const backend = await createMemoryTestBackend();
	setDurableBackend(backend);
	cleanups.push(async () => setDurableBackend(undefined));
	const boundary = h.stageBoundary;
	assert.ok(boundary);
	const promptStarted = Promise.withResolvers<void>();
	const finishStage = Promise.withResolvers<void>();
	let rejectPrompt: ((reason: Error) => void) | undefined;
	let streaming = false;
	const session: StageSessionRuntime = {
		async prompt() {
			streaming = true;
			promptStarted.resolve();
			try {
				await new Promise<void>((resolve, reject) => {
					rejectPrompt = reject;
					void finishStage.promise.then(resolve);
				});
			} finally {
				streaming = false;
			}
		},
		async steer() {},
		async followUp() {},
		subscribe: () => () => {},
		sessionFile: undefined,
		sessionId: `${runId}-stage-session`,
		async setModel() {},
		setThinkingLevel() {},
		cycleModel: async () => undefined,
		cycleThinkingLevel: async () => undefined,
		agent: undefined as unknown as AgentSession["agent"],
		model: undefined,
		thinkingLevel: "medium",
		messages: [] as AgentSession["messages"],
		get isStreaming() {
			return streaming;
		},
		navigateTree: async () => ({ cancelled: false }),
		compact: (async () => ({})) as unknown as StageSessionRuntime["compact"],
		abortCompaction() {},
		async abort() {
			rejectPrompt?.(new Error("AbortError"));
		},
		dispose() {},
		getLastAssistantText: () => "done",
		pauseTasks: () => h.host.pauseTasks(),
		resumeTasks: () => h.host.resumeTasks(),
		// As AgentSession does: the stage generation's admission boundary seals, then closes.
		sealWorkflowStageGeneration: () => boundary.seal(),
		closeWorkflowStageGeneration: () => boundary.close(),
	};
	// The stage's subagents extension shares this stage session's orchestration context and task host.
	const stageSession = Object.assign(session, {
		modelRuntime: {},
		state: { messages: [] },
		sessionManager: {},
		getContextUsage: () => undefined,
		orchestrationContext: h.ctx.orchestrationContext,
	});
	const store = createWorkflowStore();
	const registry = createStageControlRegistry();
	const cancellation = createCancellationRegistry();
	const execution = runWorkflow(
		workflow({
			name: "stage-subagents",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.stage("build").prompt("launch a worker");
				return {};
			},
		}),
		{},
		{
			runId,
			store,
			stageControlRegistry: registry,
			cancellation,
			durableBackend: backend,
			adapters: { agentSession: { create: async () => stageSession } },
		},
	);
	await promptStarted.promise;
	return { runId, store, registry, cancellation, execution, finish: () => finishStage.resolve() };
}

test("a workflow quit pauses the stage, keeps its subagent resumable, and a finished stage then closes it for good (#3760)", async () => {
	const h = harness({ stage: true });
	const { record, taskId } = await h.launch("wfquit1");
	const stage = await startStageRun(h, "wfquit-run");
	const controls = { store: stage.store, stageControlRegistry: stage.registry };

	assert.equal((await quitRun(stage.runId, controls)).ok, true);
	const observed = await h.host.waitForTask(taskId);
	assert.ok(observed.ok && observed.value.kind === "settled");
	assert.equal("cause" in observed.value.result ? observed.value.result.cause : "", "parent-handoff");
	const quit = await h.waitForLatest(record.childId, (candidate) => candidate.state === "terminal");
	assert.equal(quit.terminalStatus, SUBAGENT_CHILD_STAGE_PAUSED_STATUS, "a quit stage subagent is never killed");
	assert.equal(h.stageState?.has(WORKFLOW_STAGE_CLOSED_FOR_GOOD_STATE), false);

	assert.equal((await resumeRun(stage.runId, { ...controls, message: "continue" })).ok, true);
	const resumed = await h.call({ action: "resume", id: record.childId });
	assert.notEqual(resumed.isError, true, text(resumed));
	await settled(h, resumedTaskId(resumed));
	stage.finish();
	assert.equal((await stage.execution).status, "completed");
	assert.equal(h.stageState?.has(WORKFLOW_STAGE_CLOSED_FOR_GOOD_STATE), true, "the finished stage closed for good");
	const ended = await h.waitForLatest(
		record.childId,
		(candidate) => candidate.terminalStatus === SUBAGENT_CHILD_STAGE_CLOSED_STATUS,
	);
	assert.equal(ended.state, "terminal", "a child resumed and completed before the stage ended ends with it");
	const refused = await h.call({ action: "resume", id: record.childId });
	assert.equal(refused.isError, true);
	assert.match(text(refused), /is terminal and cannot be resumed: its workflow stage ended/);
});

test("a stage-paused subagent ends with its workflow stage when the resumed stage finishes, and resume names why (#3760)", async () => {
	const h = harness({ stage: true });
	const { record } = await h.launch("stagedone1");
	const stage = await startStageRun(h, "stagedone-run");
	const controls = { store: stage.store, stageControlRegistry: stage.registry };

	assert.equal((await pauseRun(stage.runId, controls)).ok, true);
	const paused = await h.waitForLatest(record.childId, (candidate) => candidate.state === "terminal");
	assert.equal(paused.terminalStatus, SUBAGENT_CHILD_STAGE_PAUSED_STATUS);
	assert.equal((await resumeRun(stage.runId, { ...controls, message: "continue" })).ok, true);
	await sleep(50);
	assert.equal(h.stageState?.has(WORKFLOW_STAGE_CLOSED_FOR_GOOD_STATE), false, "the resumed stage is still running");
	assert.equal(h.latest(record.childId)?.terminalStatus, SUBAGENT_CHILD_STAGE_PAUSED_STATUS);
	stage.finish();
	assert.equal((await stage.execution).status, "completed");

	const ended = await h.waitForLatest(
		record.childId,
		(candidate) => candidate.terminalStatus !== paused.terminalStatus,
	);
	assert.equal(ended.state, "terminal");
	assert.equal(ended.terminalStatus, SUBAGENT_CHILD_STAGE_CLOSED_STATUS);
	const result = await h.call({ action: "resume", id: record.childId });
	assert.equal(result.isError, true);
	assert.match(text(result), /is terminal and cannot be resumed: its workflow stage ended/);
	assert.deepEqual(await restoreSubagentChildren(h.deps, h.ctx), [], "stage resume never restores it either");
	assert.equal(h.runs.length, 1);
});

test("a stage-paused subagent of a quit workflow ends with its stage when the run is then killed (#3760)", async () => {
	const h = harness({ stage: true });
	const { record } = await h.launch("stagekill1");
	const stage = await startStageRun(h, "stagekill-run");

	assert.equal((await quitRun(stage.runId, { store: stage.store, stageControlRegistry: stage.registry })).ok, true);
	const quit = await h.waitForLatest(record.childId, (candidate) => candidate.state === "terminal");
	assert.equal(quit.terminalStatus, SUBAGENT_CHILD_STAGE_PAUSED_STATUS);
	assert.equal((await killRun(stage.runId, { store: stage.store, cancellation: stage.cancellation })).ok, true);
	assert.equal((await stage.execution).status, "killed");

	const ended = await h.waitForLatest(record.childId, (candidate) => candidate.terminalStatus !== quit.terminalStatus);
	assert.equal(ended.terminalStatus, SUBAGENT_CHILD_STAGE_CLOSED_STATUS);
	const result = await h.call({ action: "resume", id: record.childId });
	assert.equal(result.isError, true);
	assert.match(text(result), /is terminal and cannot be resumed: its workflow stage ended/);
});

test("a workflow stage closing for good ends every subagent it launched, quit ones included, and resume names why (#3760)", async () => {
	const h = harness({ stage: true });
	const settledAs = async (runId: string, status: "ok" | "error") => {
		const { record, taskId } = await h.launch(runId);
		await h.call({ action: "quit", id: record.childId });
		await settled(h, taskId);
		h.settleAs = status;
		await settled(h, resumedTaskId(await h.call({ action: "resume", id: record.childId, message: "finish" })));
		await h.waitForLatest(record.childId, (candidate) => candidate.terminalStatus === status);
		h.settleAs = "ok";
		return record;
	};
	const completed = await settledAs("stageend-ok", "ok");
	const failed = await settledAs("stageend-error", "error");
	const paused = (await h.launch("stageend-paused")).record;
	const quit = (await h.launch("stageend-quit")).record;
	assert.notEqual((await h.call({ action: "pause", id: paused.childId })).isError, true);
	assert.notEqual((await h.call({ action: "quit", id: quit.childId })).isError, true);
	await h.waitForLatest(paused.childId, (candidate) => candidate.terminalStatus === "paused");
	await h.waitForLatest(quit.childId, (candidate) => candidate.terminalStatus === "quit");
	const stage = await startStageRun(h, "stageend-run");
	stage.finish();
	assert.equal((await stage.execution).status, "completed");
	const runsBefore = h.runs.length;

	for (const child of [completed, failed, paused, quit]) {
		const ended = await h.waitForLatest(
			child.childId,
			(candidate) => candidate.terminalStatus === SUBAGENT_CHILD_STAGE_CLOSED_STATUS,
		);
		assert.equal(ended.state, "terminal");
		const result = await h.call({ action: "resume", id: child.childId });
		assert.equal(result.isError, true, text(result));
		assert.equal(
			text(result),
			`worker (${child.childId}, subagent-worker-${child.runId}) is terminal and cannot be resumed: its workflow stage ended (the stage finished, or its run ended or was cancelled). Launch a fresh subagent if its work is still needed.`,
		);
	}
	assert.equal(h.runs.length, runsBefore, "no refused child was relaunched");
});

for (const [owner, cause] of [
	["an interrupted workflow stage", "stage-close"],
	["a session Atomic exited or switched away from", "session-close"],
] as const) {
	test(`a quit child of ${owner} stays quit and resumable when it is reopened (#3760)`, async () => {
		const h = harness({ stage: cause === "stage-close" });
		const { record, taskId } = await h.launch(`quitkeep-${cause}`);
		await h.call({ action: "quit", id: record.childId });
		await settled(h, taskId);
		await h.waitForLatest(record.childId, (candidate) => candidate.terminalStatus === "quit");
		await h.closeOwnerAndReopen(cause);
		await sleep(50);
		assert.equal(h.latest(record.childId)?.terminalStatus, "quit");

		const resumed = await h.call({ action: "resume", id: record.childId });
		assert.notEqual(resumed.isError, true, text(resumed));
		await settled(h, resumedTaskId(resumed));
		assert.equal(h.runs.at(-1)?.options.sessionManager?.getSessionId(), record.childSessionId);
	});
}

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
		assert.equal("cause" in observed.value.result ? observed.value.result.cause : "", "parent-handoff");
		const latest = await h.waitForLatest(
			record.childId,
			(candidate) => candidate.taskId === resumedTask && candidate.state === "terminal",
		);
		assert.equal(latest.terminalStatus, action === "pause" ? "paused" : "quit");
	}
});
test("a child still queued when its workflow stage closes for good ends with the stage, and resume names why (#3760)", async () => {
	const h = harness({ stage: true });
	const schedule = createExecutionScheduler(1);
	await h.admit("closedq-sibling", schedule);
	await h.admit("closedq", schedule);
	await h.waitForLatest("closedq-sibling:0", (candidate) => candidate.launchLeafId !== undefined);
	h.stageState?.set(WORKFLOW_STAGE_CLOSED_FOR_GOOD_STATE, { closedForGood: true });
	await h.closeOwnerAndReopen("stage-close");

	const ended = await h.waitForLatest("closedq:0", (candidate) => candidate.state === "terminal");
	assert.equal(ended.terminalStatus, SUBAGENT_CHILD_STAGE_CLOSED_STATUS);
	const result = await h.call({ action: "resume", id: "closedq:0" });
	assert.equal(result.isError, true);
	assert.match(text(result), /is terminal and cannot be resumed: its workflow stage ended/);
	assert.deepEqual(
		h.runs.filter((run) => run.options.runId === "closedq"),
		[],
		"the queued child never started",
	);
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

test("quit and pause treat a child its resumed workflow stage paused as already paused; quit keeps it resumable until the stage closes for good (#3760)", async () => {
	const h = harness({ stage: true });
	const byId = (await h.launch("stagequitid")).record;
	const byAll = (await h.launch("stagequitall")).record;
	const stage = await startStageRun(h, "stagequit-run");
	const controls = { store: stage.store, stageControlRegistry: stage.registry };
	assert.equal((await pauseRun(stage.runId, controls)).ok, true);
	for (const child of [byId, byAll])
		await h.waitForLatest(
			child.childId,
			(candidate) => candidate.terminalStatus === SUBAGENT_CHILD_STAGE_PAUSED_STATUS,
		);
	assert.equal((await resumeRun(stage.runId, { ...controls, message: "continue" })).ok, true);

	const paused = await h.call({ action: "pause", id: byId.childId });
	assert.notEqual(paused.isError, true, text(paused));
	assert.equal(text(paused), `worker (${byId.childId}, subagent-worker-stagequitid) is already paused.`);
	assert.equal(paused.details.runControl?.children[0]?.state, "paused");

	const quitById = await h.call({ action: "quit", id: byId.childId });
	assert.notEqual(quitById.isError, true, text(quitById));
	assert.match(text(quitById), /Quit paused worker \(stagequitid:0.*stays resumable/);
	const quitAll = await h.call({ action: "quit", all: true });
	assert.notEqual(quitAll.isError, true, text(quitAll));
	assert.deepEqual(
		quitAll.details.runControl?.children.map((child) => [child.childId, child.state]),
		[[byAll.childId, "quit"]],
		"quit all: true includes the stage-paused child; the one already quit is left as it is",
	);
	for (const child of [byId, byAll]) assert.equal(h.latest(child.childId)?.terminalStatus, "quit");

	assert.equal((await quitRun(stage.runId, controls)).ok, true);
	assert.equal((await resumeRun(stage.runId, { ...controls, message: "continue" })).ok, true);
	for (const child of [byId, byAll])
		assert.equal(h.latest(child.childId)?.terminalStatus, "quit", "a /workflow quit and resume keep quit children");

	stage.finish();
	assert.equal((await stage.execution).status, "completed");
	const runsBefore = h.runs.length;
	for (const child of [byId, byAll]) {
		await h.waitForLatest(
			child.childId,
			(candidate) => candidate.terminalStatus === SUBAGENT_CHILD_STAGE_CLOSED_STATUS,
		);
		const refused = await h.call({ action: "resume", id: child.childId });
		assert.equal(refused.isError, true, text(refused));
		assert.match(text(refused), /is terminal and cannot be resumed: its workflow stage ended/);
	}
	assert.equal(h.runs.length, runsBefore, "no quit child of the closed stage was relaunched");
});

for (const [owner, cause] of [
	["an interrupted workflow stage", "stage-close"],
	["a session Atomic exited or switched away from", "session-close"],
] as const) {
	test(`children of ${owner} stay running and are restored when it is reopened (#3760)`, async () => {
		const h = harness({ stage: cause === "stage-close" });
		const { record } = await h.launch(`keep-${cause}`);
		await h.closeOwnerAndReopen(cause);
		await sleep(50);
		assert.equal(h.latest(record.childId)?.state, "running", "closing the owner records nothing terminal");

		const [outcome] = await restoreSubagentChildren(h.deps, h.ctx);
		assert.equal(outcome?.kind, "restored", JSON.stringify(outcome));
		assert.ok(outcome?.kind === "restored");
		await settled(h, outcome.taskId);
		assert.equal(h.runs.at(-1)?.options.runId, `keep-${cause}`);
		assert.equal(h.runs.at(-1)?.options.sessionManager?.getSessionId(), record.childSessionId);
	});
}

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

function initGitRepository(root: string): void {
	const git = (args: string[]) => {
		const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
	};
	git(["init", "--quiet"]);
	git(["config", "user.name", "Atomic Fixture"]);
	git(["config", "user.email", "fixture@example.invalid"]);
	git(["config", "commit.gpgSign", "false"]);
	writeFileSync(join(root, "seed.txt"), "seed\n");
	git(["add", "seed.txt"]);
	git(["commit", "--quiet", "-m", "initial"]);
}

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
		wait: { kind: "background" },
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
	const removedBy = Date.now() + RECORD_WAIT_MS;
	while (existsSync(childA.cwd) && Date.now() < removedBy) await sleep(10);
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
		wait: { kind: "background" },
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
	const removedBy = Date.now() + RECORD_WAIT_MS;
	while (existsSync(childA.cwd) && Date.now() < removedBy) await sleep(10);
	assert.equal(existsSync(childA.cwd), false, "the worktree is removed once the resumed child finished");
});

function gitOutput(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim();
}

async function launchWorktreeRun(
	h: Harness,
	markers: readonly string[],
	extra: { concurrency?: number } = {},
): Promise<SubagentChildRecord[]> {
	const launched = await h.call({
		tasks: markers.map((marker) => ({ agent: "worker", task: marker })),
		worktree: true,
		wait: { kind: "background" },
		...extra,
	});
	assert.notEqual(launched.isError, true, text(launched));
	const runs = () =>
		[...readSubagentChildRecords(h.sessionManager.getEntries()).values()].sort(
			(left, right) => left.index - right.index,
		);
	const deadline = Date.now() + RECORD_WAIT_MS;
	while (runs().length < markers.length && Date.now() < deadline) await sleep(10);
	assert.equal(runs().length, markers.length);
	return runs();
}

async function waitUntilRemoved(path: string): Promise<void> {
	const removedBy = Date.now() + RECORD_WAIT_MS;
	while (existsSync(path) && Date.now() < removedBy) await sleep(10);
}

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
	await waitUntilRemoved(childA.cwd);
	assert.equal(existsSync(childA.cwd), false, "the worktree is removed once the resumed child finished");
});

test("a clean paused worktree child's worktree is removed when its session closes, and resume recreates it from the run's base (#3760 run control)", async () => {
	const h = harness();
	initGitRepository(h.cwd);
	const base = gitOutput(h.cwd, ["rev-parse", "HEAD"]);
	const resumedDone = Promise.withResolvers<void>();
	h.finishOn.set("task-a-marker", Promise.withResolvers<void>());
	h.finishOn.set("task-b-marker", Promise.withResolvers<void>());
	h.finishOn.set(SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT, resumedDone);
	const [childA, childB] = await launchWorktreeRun(h, ["task-a-marker", "task-b-marker"]);
	assert.ok(childA && childB);
	await h.waitForLatest(childA.childId, (candidate) => !!candidate.childSessionId);
	await h.waitForLatest(childB.childId, (candidate) => !!candidate.childSessionId);

	await h.call({ action: "pause", id: childA.childId });
	await h.waitForLatest(childA.childId, (candidate) => candidate.terminalStatus === "paused");
	await h.closeOwnerAndReopen("session-close");
	await waitUntilRemoved(childA.cwd);
	await waitUntilRemoved(childB.cwd);
	assert.equal(existsSync(childA.cwd), false, "the clean paused child's worktree is removed");
	assert.equal(existsSync(childB.cwd), false, "the clean interrupted sibling's worktree is removed");

	const resumed = await h.call({ action: "resume", id: childA.childId });
	assert.notEqual(resumed.isError, true, text(resumed));
	const resumedTask = resumedTaskId(resumed);
	await h.waitForLatest(childA.childId, (candidate) => candidate.taskId === resumedTask && !!candidate.childSessionId);
	assert.equal(existsSync(childA.cwd), true, "resume recreated the worktree");
	assert.equal(gitOutput(childA.cwd, ["rev-parse", "HEAD"]), base, "it is recreated at the run's base");

	resumedDone.resolve();
	await settled(h, resumedTask);
	await waitUntilRemoved(childA.cwd);
	assert.equal(existsSync(childA.cwd), false, "the recreated worktree is removed once the resumed child finished");
});

test("a dirty paused worktree child's worktree is kept when its session closes, and resume continues in it (#3760 run control)", async () => {
	const h = harness();
	initGitRepository(h.cwd);
	const resumedDone = Promise.withResolvers<void>();
	h.finishOn.set("task-a-marker", Promise.withResolvers<void>());
	h.finishOn.set("task-b-marker", Promise.withResolvers<void>());
	h.finishOn.set(SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT, resumedDone);
	const [childA, childB] = await launchWorktreeRun(h, ["task-a-marker", "task-b-marker"]);
	assert.ok(childA && childB);
	await h.waitForLatest(childA.childId, (candidate) => !!candidate.childSessionId);
	await h.waitForLatest(childB.childId, (candidate) => !!candidate.childSessionId);
	const draft = join(childA.cwd, "draft.md");
	writeFileSync(draft, "draft by A\n");

	await h.call({ action: "pause", id: childA.childId });
	await h.waitForLatest(childA.childId, (candidate) => candidate.terminalStatus === "paused");
	await h.closeOwnerAndReopen("session-close");
	await waitUntilRemoved(childB.cwd);
	assert.equal(existsSync(childB.cwd), false, "the clean sibling's worktree is removed");
	assert.equal(readFileSync(draft, "utf8"), "draft by A\n", "the paused child's uncommitted work is kept");

	const resumed = await h.call({ action: "resume", id: childA.childId });
	assert.notEqual(resumed.isError, true, text(resumed));
	const resumedTask = resumedTaskId(resumed);
	await h.waitForLatest(childA.childId, (candidate) => candidate.taskId === resumedTask && !!candidate.childSessionId);
	assert.equal(readFileSync(draft, "utf8"), "draft by A\n", "the resumed child continues in its worktree");

	resumedDone.resolve();
	await settled(h, resumedTask);
	await waitUntilRemoved(childA.cwd);
	assert.equal(existsSync(childA.cwd), false, "the worktree is removed once the resumed child finished");
});

test("a resume that cannot restart a paused worktree child keeps its dirty worktree, edits, draft and branch (#3784)", async () => {
	const h = harness();
	initGitRepository(h.cwd);
	const siblingDone = Promise.withResolvers<void>();
	h.finishOn.set("task-a-marker", Promise.withResolvers<void>());
	h.finishOn.set("task-b-marker", siblingDone);
	const [childA, childB] = await launchWorktreeRun(h, ["task-a-marker", "task-b-marker"]);
	assert.ok(childA && childB);
	const running = await h.waitForLatest(childA.childId, (candidate) => !!candidate.childSessionId);
	const branch = running.worktree?.branch;
	assert.ok(branch, "the child record names its worktree branch");
	const trackedEdit = join(childA.cwd, "seed.txt");
	const untrackedDraft = join(childA.cwd, "draft.md");
	writeFileSync(trackedEdit, "edited by A\n");
	writeFileSync(untrackedDraft, "draft by A\n");

	await h.call({ action: "pause", id: childA.childId });
	await h.waitForLatest(childA.childId, (candidate) => candidate.terminalStatus === "paused");
	siblingDone.resolve();
	await settled(h, childB.taskId as string);
	await waitUntilRemoved(childB.cwd);
	assert.equal(existsSync(childB.cwd), false, "the run returned and removed its clean worktree");

	h.agentDefined = false;
	const resumed = await h.call({ action: "resume", id: childA.childId });
	assert.equal(resumed.isError, true, text(resumed));
	assert.match(text(resumed), /agent "worker" is no longer defined/);
	await sleep(100);
	assert.equal(readFileSync(trackedEdit, "utf8"), "edited by A\n", "the tracked edit survives the failed resume");
	assert.equal(readFileSync(untrackedDraft, "utf8"), "draft by A\n", "the untracked draft survives the failed resume");
	assert.equal(gitOutput(h.cwd, ["branch", "--list", branch]).replace(/^[*+ ]+/, ""), branch, "its branch survives");
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
	const order = [steer, followUp, "then wrap up", SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT].map((message) =>
		delivered.indexOf(message),
	);
	assert.ok(
		order.every((position, index) => position >= 0 && (index === 0 || position > order[index - 1]!)),
		`held messages first, in order, then the message and the continuation: ${order.join(", ")}`,
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
	const running = await waitForRecord((candidate) => candidate.state === "running" && !!candidate.childSessionFile);
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
	const delivered = transcript(finished);
	assert.equal(occurrences(delivered, steer), 1, "the held steer is delivered exactly once");
	assert.equal(occurrences(delivered, followUp), 1, "the held follow-up is delivered exactly once");
	assert.equal(occurrences(delivered, "then wrap up"), 1, "the resume message is delivered exactly once");
	const order = [steer, followUp, "then wrap up"].map((message) => delivered.indexOf(message));
	assert.ok(order[0]! < order[1]! && order[1]! < order[2]!, `held messages first, in order: ${order.join(", ")}`);
});
