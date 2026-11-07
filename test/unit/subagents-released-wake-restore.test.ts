import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DetachedToolResult, ExtensionContext } from "@bastani/atomic";
import { afterEach, test, vi } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SessionSpillError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type { TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { WorkflowStageAdmissionBoundary } from "../../packages/coding-agent/src/core/workflow-stage-admission.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agents.js";
import { SUBAGENT_SUPERVISOR_AUTHORIZATION_EVENT } from "../../packages/subagents/src/intercom/supervisor-authorization.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import {
	lateToolResultMessage,
	SUBAGENT_RELEASE_AFTER_MS,
	SUBAGENT_RELEASED_WAKE_PROMPT,
	SUBAGENT_STILL_RUNNING_RESULT,
} from "../../packages/subagents/src/runs/foreground/released-children.js";
import { registerRunWorktrees, runWorktreeRecord } from "../../packages/subagents/src/runs/foreground/run-worktrees.js";
import {
	createSubagentChildRecordSink,
	readSubagentChildRecords,
	recordSubagentChildHeldToolResults,
	recordSubagentChildStatus,
	SUBAGENT_CHILD_RECORD_TYPE,
	SUBAGENT_CHILD_RELEASED_STATUS,
	SUBAGENT_CHILD_STAGE_PAUSED_STATUS,
	type SubagentChildRecord,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import {
	awaitSubagentChildRestoration,
	restoreSubagentChild,
	restoreSubagentChildren,
	SUBAGENT_AWAIT_INTERCOM_PEER_EVENT,
	SUBAGENT_RELEASE_RESTORING_CHILD_EVENT,
	SUBAGENT_RESERVE_RESTORING_CHILD_EVENT,
	SUBAGENT_RESUME_CONTINUATION_PROMPT,
	type SubagentChildRestoreOutcome,
	type SubagentReleaseRestoringChildRequest,
	type SubagentReserveRestoringChildRequest,
} from "../../packages/subagents/src/runs/foreground/subagent-child-restore.js";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import type { ExecutorDeps } from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import { runAgentTask } from "../../packages/subagents/src/runs/foreground/task-execution.js";
import { cleanupWorktrees, createWorktrees } from "../../packages/subagents/src/runs/shared/worktree.js";
import type { RunSyncOptions, SingleResult, SubagentToolResult } from "../../packages/subagents/src/shared/types.js";
import { runGitChecked } from "../../packages/workflows/src/runs/shared/worktree-git.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";

const ORIGINAL_TASK = "original task";
const WAIT_CALL = { toolCallId: "ci-1", toolName: "wait_for_ci" } as const;
const RECORD_WAIT_MS = 5_000;
const KEPT_SETTLE_MS = 150;

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

type OriginalLaunch = "waits" | "completes" | "released" | "released-on-stop";

interface Harness {
	readonly cwd: string;
	readonly sessionManager: SessionManager;
	readonly ctx: ExtensionContext;
	readonly deps: ExecutorDeps;
	readonly runs: Array<{ task: string; options: RunSyncOptions }>;
	readonly holds: Array<{ reserve: string; dormant?: true } | { release: string }>;
	readonly stageState?: Map<string, object>;
	host: AgentTaskHost;
	original: OriginalLaunch;
	originalGate?: PromiseWithResolvers<void>;
	closeOwnerAndReopen(cause: "session-close" | "stage-close"): Promise<void>;
	call(params: Parameters<ReturnType<typeof createSubagentExecutor>["execute"]>[1]): Promise<SubagentToolResult>;
	admit(runId: string, options?: Partial<RunSyncOptions>): Promise<TaskId>;
	latest(childId: string): SubagentChildRecord | undefined;
	waitForLatest(childId: string, accept: (record: SubagentChildRecord) => boolean): Promise<SubagentChildRecord>;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function newHost(): AgentTaskHost {
	return new AgentTaskHost({
		scope: { kind: "session", sessionId: `wake-restore-${randomUUID()}` },
		authorizeLaunch() {},
	});
}

function harness(options: { stage?: boolean } = {}): Harness {
	const cwd = makeTempDirectory("subagent-wake-restore-");
	let host = newHost();
	const stageState = options.stage ? new Map<string, object>() : undefined;
	const stageBoundary = options.stage ? new WorkflowStageAdmissionBoundary() : undefined;
	const sessionManager = SessionManager.inMemory(cwd);
	const runs: Harness["runs"] = [];
	const holds: Harness["holds"] = [];
	let authorizations = 0;
	const events = {
		on: () => () => {},
		emit(channel: string, data: object) {
			if (channel === SUBAGENT_SUPERVISOR_AUTHORIZATION_EVENT) {
				const request = data as { childName: string; completion?: Promise<object> };
				authorizations += 1;
				request.completion = Promise.resolve({
					capability: `fresh-capability-${authorizations}`,
					supervisorSessionId: "parent",
					childName: request.childName,
				});
			}
			if (channel === SUBAGENT_AWAIT_INTERCOM_PEER_EVENT)
				(data as { completion?: Promise<boolean> }).completion = Promise.resolve(true);
			if (channel === SUBAGENT_RESERVE_RESTORING_CHILD_EVENT) {
				const request = data as SubagentReserveRestoringChildRequest;
				holds.push({
					reserve: request.capability,
					...(request.dormant === true ? { dormant: true as const } : {}),
				});
				request.completion = Promise.resolve();
			}
			if (channel === SUBAGENT_RELEASE_RESTORING_CHILD_EVENT) {
				const request = data as SubagentReleaseRestoringChildRequest;
				holds.push({ release: request.capability });
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
		get host() {
			return host;
		},
		set host(next: AgentTaskHost) {
			host = next;
		},
		get deps() {
			return deps;
		},
		...(stageState ? { stageState } : {}),
		original: "waits",
		async closeOwnerAndReopen(cause) {
			await host.close(cause);
			host = newHost();
		},
		sessionManager,
		ctx: {
			cwd,
			sessionSignal: new AbortController().signal,
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
		holds,
		call: (params) => executor.execute("run-control", params, new AbortController().signal, undefined, state.ctx),
		async admit(runId, extra) {
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
					...extra,
				},
				wait: { kind: "background" },
				recordChild: createSubagentChildRecordSink(pi, state.ctx),
				runtime: { runSync: runtime },
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
		if (task !== ORIGINAL_TASK) {
			const { resumeToolResults: _results, skipTaskPrompt: _skip, ...rest } = options;
			return runSync(parentCwd, agents, agentName, task, { ...rest, testSession: { output: "resumed" } });
		}
		if (state.original === "completes")
			return runSync(parentCwd, agents, agentName, task, {
				...options,
				testSession: { output: "done", ...(state.originalGate ? { promptGate: state.originalGate.promise } : {}) },
			});
		if (state.original === "waits")
			return runSync(parentCwd, agents, agentName, task, {
				...options,
				testSession: { output: "partial", promptGate: neverReleased.promise, abortResolvesPrompt: true },
			});
		const waiting = await runSync(parentCwd, agents, agentName, task, {
			...options,
			testSession:
				state.original === "released-on-stop"
					? { output: "waiting", promptGate: neverReleased.promise, abortResolvesPrompt: true }
					: { output: "waiting", ...(state.originalGate ? { promptGate: state.originalGate.promise } : {}) },
		});
		return { ...waiting, status: "interrupted", interrupted: true, released: { waitingOn: [WAIT_CALL], calls: [] } };
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
		discoverAgents: () => ({ agents: [agent] }),
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

async function settled(h: Harness, taskId: string): Promise<void> {
	const observed = await h.host.waitForTask(taskId as TaskId);
	assert.ok(observed.ok && observed.value.kind === "settled", JSON.stringify(observed));
}

async function restored(
	h: Harness,
	childId: string,
	resume: Parameters<typeof restoreSubagentChild>[3],
): Promise<RunSyncOptions & { task: string }> {
	const outcome = await restoreSubagentChild(h.deps, h.ctx, childId, resume);
	assert.equal(outcome.kind, "restored", JSON.stringify(outcome));
	assert.ok(outcome.kind === "restored");
	await settled(h, outcome.taskId);
	const run = h.runs.at(-1);
	assert.ok(run);
	return { ...run.options, task: run.task };
}

function waitResult(output: string): DetachedToolResult {
	return {
		toolCallId: WAIT_CALL.toolCallId,
		toolName: WAIT_CALL.toolName,
		result: { content: [{ type: "text", text: output }], details: undefined },
		isError: false,
	};
}

const stillRunning: DetachedToolResult = {
	toolCallId: WAIT_CALL.toolCallId,
	toolName: WAIT_CALL.toolName,
	result: { content: [{ type: "text", text: SUBAGENT_STILL_RUNNING_RESULT }], details: undefined },
	isError: false,
};

async function releasedChild(h: Harness, runId: string): Promise<SubagentChildRecord> {
	h.original = "released";
	await settled(h, await h.admit(runId));
	return h.waitForLatest(`${runId}:0`, (record) => record.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS);
}

async function endSessionOnPendingCall(record: SubagentChildRecord): Promise<void> {
	assert.ok(record.childSessionFile);
	const session = await SessionManager.open(record.childSessionFile, undefined, record.cwd);
	await session.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id: WAIT_CALL.toolCallId, name: WAIT_CALL.toolName, arguments: { run: "7" } }],
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

async function appendRecord(h: Harness, record: SubagentChildRecord): Promise<void> {
	await h.sessionManager.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, record);
}

test("a released child whose session ends on its pending call is woken by that call's result alone: its turn continues and nothing is prompted (#4326)", async () => {
	const h = harness();
	const record = await endedOnPendingCall(h, "wake-alone");
	const result = waitResult("CI is green");

	const run = await restored(h, record.childId, {
		prompt: SUBAGENT_RELEASED_WAKE_PROMPT,
		toolResults: [result],
		promptless: true,
	});

	assert.deepEqual(run.resumeToolResults, [result], "the result is recorded as the call's result");
	assert.equal(run.skipTaskPrompt, true, "the continued turn is the whole run");
	assert.equal(run.resumeFollowUps, undefined);
	assert.equal(run.task, SUBAGENT_RELEASED_WAKE_PROMPT);
	assert.equal(run.resumeSession, true);
	assert.equal(h.latest(record.childId)?.terminalStatus, "ok");
	assert.deepEqual(h.latest(record.childId)?.heldToolResults ?? [], [], "nothing is left held after the wake took it");
});

async function endedOnPendingCall(h: Harness, runId: string): Promise<SubagentChildRecord> {
	const record = await releasedChild(h, runId);
	await endSessionOnPendingCall(record);
	return record;
}

test("a result that comes after its call was answered reaches a woken child as a message it reads literally, with no prompt of its own (#4326)", async () => {
	const h = harness();
	const record = await releasedChild(h, "wake-late");
	const late = waitResult("/deploy now");

	const run = await restored(h, record.childId, {
		prompt: SUBAGENT_RELEASED_WAKE_PROMPT,
		toolResults: [late],
		promptless: true,
	});

	assert.equal(run.task, lateToolResultMessage(late));
	assert.equal(run.resumeTaskLiteral, true);
	assert.equal(run.resumeFollowUps, undefined, "a wake by results alone is not told to read anything");
	assert.deepEqual(run.resumeToolResults, []);
	assert.equal(run.skipTaskPrompt, undefined, "the late message is the prompt");
});

test("a late result and a message wake the child together: the result is read first, then the wake prompt (#4326)", async () => {
	const h = harness();
	const record = await releasedChild(h, "wake-both");
	const late = waitResult("deployed");

	const run = await restored(h, record.childId, { prompt: SUBAGENT_RELEASED_WAKE_PROMPT, toolResults: [late] });

	assert.equal(run.task, lateToolResultMessage(late));
	assert.deepEqual(run.resumeFollowUps, [SUBAGENT_RELEASED_WAKE_PROMPT]);
	assert.equal(run.resumeTaskLiteral, true);
	assert.equal(run.skipTaskPrompt, undefined);
});

const stoppedAfterRelease = [
	{
		name: "released, with no call recorded",
		expected: [stillRunning],
		prepare: async (h: Harness, record: SubagentChildRecord) => {
			await appendRecord(h, { ...record, waitingOn: [] });
		},
	},
	{
		name: "paused while waiting on a call",
		expected: [stillRunning],
		prepare: async (h: Harness, record: SubagentChildRecord) => {
			await recordSubagentChildStatus(h.deps.pi, record, "paused");
		},
	},
	{
		name: "paused holding the result of its call",
		expected: [waitResult("held green")],
		prepare: async (h: Harness, record: SubagentChildRecord) => {
			await recordSubagentChildStatus(h.deps.pi, record, "paused");
			await recordSubagentChildHeldToolResults(h.deps.pi, record.owner.sessionId, record.childId, [
				waitResult("held green"),
			]);
		},
	},
] as const;

for (const stopped of stoppedAfterRelease) {
	test(`a child ${stopped.name} is woken by a message with its pending call answered first (#4326)`, async () => {
		const h = harness();
		const record = await endedOnPendingCall(h, "wake-plan");
		await stopped.prepare(h, record);

		const run = await restored(h, record.childId, { prompt: SUBAGENT_RELEASED_WAKE_PROMPT });

		assert.deepEqual(run.resumeToolResults, stopped.expected);
		assert.equal(run.task, SUBAGENT_RELEASED_WAKE_PROMPT);
		assert.equal(run.skipTaskPrompt, undefined, "a message is prompted after the turn continues");
	});
}

test("a child paused while running, with no release behind it, is resumed by its own recovery and not given tool results (#4326)", async () => {
	const h = harness();
	h.original = "waits";
	await h.admit("plain-pause");
	await h.waitForLatest("plain-pause:0", (candidate) => candidate.launchLeafId !== undefined);
	await h.call({ action: "pause", id: "plain-pause:0" });
	const record = await h.waitForLatest("plain-pause:0", (candidate) => candidate.terminalStatus === "paused");
	await endSessionOnPendingCall(record);

	const run = await restored(h, record.childId, { prompt: "carry on" });

	assert.equal(run.resumeToolResults, undefined);
	assert.equal(run.skipTaskPrompt, undefined);
	assert.equal(run.task, "carry on");
});

test("a child restored after a restart reads the results held for it as messages before its continuation prompt (#4326)", async () => {
	const h = harness();
	h.original = "waits";
	await h.admit("restart-held");
	const running = await h.waitForLatest("restart-held:0", (candidate) => candidate.launchLeafId !== undefined);
	await h.closeOwnerAndReopen("session-close");
	await h.waitForLatest(
		"restart-held:0",
		(candidate) => candidate.state === "running" && candidate.childSessionFile !== undefined,
	);
	const held = waitResult("finished while Atomic was closed");
	await recordSubagentChildHeldToolResults(h.deps.pi, running.owner.sessionId, running.childId, [held]);

	const outcomes: SubagentChildRestoreOutcome[] = await restoreSubagentChildren(h.deps, h.ctx);

	const [outcome] = outcomes;
	assert.equal(outcome?.kind, "restored", JSON.stringify(outcomes));
	assert.ok(outcome?.kind === "restored");
	await settled(h, outcome.taskId);
	const run = h.runs.at(-1);
	assert.equal(run?.task, lateToolResultMessage(held));
	assert.deepEqual(run?.options.resumeFollowUps, [SUBAGENT_RESUME_CONTINUATION_PROMPT]);
	assert.equal(run?.options.resumeTaskLiteral, true);
	assert.deepEqual(run?.options.resumeToolResults, []);
	assert.equal(run?.options.skipTaskPrompt, undefined);
});

test("a restart's restore whose read of a child's history fails in a way that passes leaves the child as it was, for the next restore (#4502)", async () => {
	const h = harness();
	h.original = "waits";
	await h.admit("restart-transient");
	await h.waitForLatest("restart-transient:0", (candidate) => candidate.launchLeafId !== undefined);
	await h.closeOwnerAndReopen("session-close");
	await h.waitForLatest(
		"restart-transient:0",
		(candidate) => candidate.state === "running" && candidate.childSessionFile !== undefined,
	);
	const record = h.latest("restart-transient:0") as SubagentChildRecord;
	let fail!: (error: Error) => void;
	const open = vi.spyOn(SessionManager, "open").mockImplementationOnce(
		() =>
			new Promise((_resolve, reject) => {
				fail = reject;
			}),
	);

	const restoring = restoreSubagentChildren(h.deps, h.ctx);
	await vi.waitFor(() => assert.equal(open.mock.calls.length, 1));
	const send = awaitSubagentChildRestoration(
		record.owner.sessionId,
		h.sessionManager.getEntries(),
		record.childSessionId ?? record.intercomTarget ?? "",
		10_000,
	);
	fail(new SessionSpillError("spill-read-failed", { directory: "d", sessionId: "s", bytes: 1, errno: "EMFILE" }));
	assert.deepEqual(await restoring, [], "left out, not reported gone");
	assert.match((await send) ?? "", /could not be restored just now: .*spill-read-failed.*try again shortly/);
	open.mockRestore();
	assert.equal(h.latest("restart-transient:0")?.state, "running");

	const [outcome] = await restoreSubagentChildren(h.deps, h.ctx);
	assert.equal(outcome?.kind, "restored");
	assert.ok(outcome?.kind === "restored");
	await settled(h, outcome.taskId);
});

test("a restart's restore whose read of a child's history fails for good reports the child gone (#4502)", async () => {
	const h = harness();
	h.original = "waits";
	await h.admit("restart-lost");
	await h.waitForLatest("restart-lost:0", (candidate) => candidate.launchLeafId !== undefined);
	await h.closeOwnerAndReopen("session-close");
	await h.waitForLatest(
		"restart-lost:0",
		(candidate) => candidate.state === "running" && candidate.childSessionFile !== undefined,
	);
	vi.spyOn(SessionManager, "open").mockRejectedValueOnce(
		new SessionSpillError("spill-missing", { directory: "d", sessionId: "s", bytes: 1, errno: "ENOENT" }),
	);

	const [outcome, ...others] = await restoreSubagentChildren(h.deps, h.ctx);
	vi.restoreAllMocks();
	assert.deepEqual(others, []);
	assert.equal(outcome?.kind, "unrestorable");
	assert.match(outcome?.kind === "unrestorable" ? outcome.reason : "", /spill-missing/);
});

test("a background child with an owner is released while it waits, after the default delay (#4326)", async () => {
	const h = harness();
	await h.admit("policy-default");
	await h.waitForLatest("policy-default:0", (record) => record.launchLeafId !== undefined);

	const policy = h.runs[0]?.options.releaseWhenWaiting;
	assert.deepEqual(policy, { afterMs: SUBAGENT_RELEASE_AFTER_MS });
});

test("a release policy its launch gave is kept (#4326)", async () => {
	const h = harness();
	const own = { afterMs: 5 };

	await h.admit("policy-own", { releaseWhenWaiting: own });
	await h.waitForLatest("policy-own:0", (record) => record.launchLeafId !== undefined);

	assert.equal(h.runs[0]?.options.releaseWhenWaiting, own);
});

test("a foreground child is never released while it waits: its parent's turn is awaiting it (#4326)", async () => {
	const h = harness();
	const policies: Array<RunSyncOptions["releaseWhenWaiting"]> = [];
	const runtime = async (...args: Parameters<typeof runSync>): Promise<SingleResult> => {
		const [parentCwd, agents, agentName, task, options] = args;
		policies.push(options.releaseWhenWaiting);
		return runSync(parentCwd, agents, agentName, task, { ...options, testSession: { output: "done" } });
	};
	for (const wait of [{ kind: "foreground" }, { kind: "background" }] as const) {
		const response = await runAgentTask({
			host: h.host,
			cwd: h.cwd,
			agents: [agent],
			agent: "worker",
			task: ORIGINAL_TASK,
			options: {
				cwd: h.cwd,
				runId: `policy-${wait.kind}`,
				index: 0,
				sessionDir: join(h.cwd, "children", wait.kind),
			},
			wait,
			recordChild: createSubagentChildRecordSink(h.deps.pi, h.ctx),
			runtime: { runSync: runtime },
		});
		assert.ok(response.kind === "admitted");
		await settled(h, response.observation.taskId);
	}

	assert.deepEqual(policies, [undefined, { afterMs: SUBAGENT_RELEASE_AFTER_MS }]);
});

test("a child launched with no owner record, or one with no owning session, is never released and still runs (#4326)", async () => {
	const h = harness();
	const policies: Array<RunSyncOptions["releaseWhenWaiting"]> = [];
	const runtime = async (...args: Parameters<typeof runSync>): Promise<SingleResult> => {
		const [parentCwd, agents, agentName, task, options] = args;
		policies.push(options.releaseWhenWaiting);
		return runSync(parentCwd, agents, agentName, task, { ...options, testSession: { output: "done" } });
	};
	for (const [label, recordChild] of [
		["without a record", undefined],
		["without an owner", { record() {} }],
	] as const) {
		const response = await runAgentTask({
			host: h.host,
			cwd: h.cwd,
			agents: [agent],
			agent: "worker",
			task: ORIGINAL_TASK,
			options: { cwd: h.cwd, runId: `policy-${label}`, index: 0, sessionDir: join(h.cwd, "children", label) },
			wait: { kind: "background" },
			...(recordChild ? { recordChild } : {}),
			runtime: { runSync: runtime },
		});
		assert.ok(response.kind === "admitted");
		const observed = await h.host.waitForTask(response.observation.taskId as TaskId);
		assert.ok(observed.ok && observed.value.kind === "settled");
		assert.equal(observed.value.result.kind, "completed", `${label}: the child ran to completion`);
	}

	assert.deepEqual(policies, [undefined, undefined]);
});

test("a child that completes normally under a release policy completes and is recorded as finished, not released (#4326)", async () => {
	const h = harness();
	h.original = "completes";

	const taskId = await h.admit("completes");
	const observed = await h.host.waitForTask(taskId);

	assert.ok(observed.ok && observed.value.kind === "settled");
	assert.equal(observed.value.result.kind, "completed");
	const record = await h.waitForLatest("completes:0", (candidate) => candidate.state === "terminal");
	assert.equal(record.terminalStatus, "ok");
	assert.equal(record.waitingOn, undefined);
	assert.deepEqual(
		h.holds.filter((hold) => "dormant" in hold),
		[],
		"nothing of it is kept addressable while it waits",
	);
});

test("a child released just as pause stops it is paused, not released (#4326)", async () => {
	const h = harness();
	h.original = "released-on-stop";
	await h.admit("stop-race");
	await h.waitForLatest("stop-race:0", (record) => record.launchLeafId !== undefined);

	const paused = await h.call({ action: "pause", id: "stop-race:0" });

	assert.notEqual(paused.isError, true, text(paused));
	assert.match(text(paused), /Paused worker/);
	const record = await h.waitForLatest("stop-race:0", (candidate) => candidate.state === "terminal");
	assert.equal(record.terminalStatus, "paused");
	assert.equal(record.waitingOn, undefined);
	assert.deepEqual(
		h.holds.filter((hold) => "dormant" in hold),
		[],
	);
});

function repositoryWithSeed(): string {
	const root = makeTempDirectory("subagent-wake-worktree-");
	cleanups.push(() => removeTempDirectory(root));
	runGitChecked(root, ["init", "-b", "main"]);
	runGitChecked(root, ["config", "user.name", "Atomic Test"]);
	runGitChecked(root, ["config", "user.email", "atomic@example.com"]);
	runGitChecked(root, ["config", "core.autocrlf", "false"]);
	writeFileSync(join(root, "seed.txt"), "seed\n");
	runGitChecked(root, ["add", "seed.txt"]);
	runGitChecked(root, ["commit", "--no-gpg-sign", "-m", "initial"]);
	return root;
}

async function childWithDirtyWorktree(h: Harness, runId: string) {
	const repo = repositoryWithSeed();
	const setup = createWorktrees(repo, runId, 1);
	const worktree = setup.worktrees[0];
	assert.ok(worktree);
	const run = registerRunWorktrees(runId, setup);
	cleanups.push(() => cleanupWorktrees(setup));
	h.originalGate = Promise.withResolvers<void>();
	const taskId = await h.admit(runId, { cwd: worktree.agentCwd });
	run.release();
	await h.waitForLatest(`${runId}:0`, (record) => record.launchLeafId !== undefined);
	assert.equal(runWorktreeRecord(runId, 0)?.path, worktree.path);
	const draft = join(worktree.agentCwd, "draft.md");
	writeFileSync(draft, "unsaved work\n");
	return { taskId, worktree, draft };
}

test("a released child's worktree with unsaved work is kept for its wake (#4326)", async () => {
	const h = harness();
	h.original = "released";
	const { taskId, draft } = await childWithDirtyWorktree(h, "wt-released");

	h.originalGate?.resolve();
	await settled(h, taskId);
	await h.waitForLatest("wt-released:0", (record) => record.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS);
	await sleep(KEPT_SETTLE_MS);

	assert.equal(existsSync(draft), true, "the draft is still there for the woken child");
});

test("a child that finishes normally does not keep its worktree (#4326)", async () => {
	const h = harness();
	h.original = "completes";
	const { taskId, worktree, draft } = await childWithDirtyWorktree(h, "wt-finished");
	h.originalGate?.resolve();
	await settled(h, taskId);
	await h.waitForLatest("wt-finished:0", (record) => record.terminalStatus === "ok");
	const deadline = Date.now() + RECORD_WAIT_MS;
	while (existsSync(worktree.path) && Date.now() < deadline) await sleep(10);

	assert.equal(existsSync(draft), false, "a finished child's worktree goes with its run");
});

test("the worktree of a child its owner's session closed on keeps its unsaved work for its restoration (#4326)", async () => {
	const h = harness();
	h.original = "waits";
	const { draft } = await childWithDirtyWorktree(h, "wt-owner-closed");

	await h.closeOwnerAndReopen("session-close");
	await sleep(KEPT_SETTLE_MS);

	assert.equal(existsSync(draft), true);
});

test("the worktree of a child its workflow stage paused keeps its unsaved work for the stage's resume (#4326)", async () => {
	const h = harness({ stage: true });
	h.original = "waits";
	const { taskId, draft } = await childWithDirtyWorktree(h, "wt-stage-paused");

	await h.host.pauseTasks();
	await settled(h, taskId);
	await h.waitForLatest("wt-stage-paused:0", (record) => record.terminalStatus === SUBAGENT_CHILD_STAGE_PAUSED_STATUS);
	await sleep(KEPT_SETTLE_MS);

	assert.equal(existsSync(draft), true);
});
