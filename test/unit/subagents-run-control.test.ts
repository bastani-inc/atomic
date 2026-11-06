import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession, DetachedToolCall, DetachedToolResult, ExtensionContext } from "@bastani/atomic";
import { afterEach, test } from "vitest";
import {
	AgentWakeDispatcher,
	agentWakeDispatcher,
} from "../../packages/coding-agent/src/core/agent-wake-dispatcher.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import { formatTaskCompletion } from "../../packages/coding-agent/src/core/tasks/completion.js";
import type { Sequence, TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { WorkflowStageAdmissionBoundary } from "../../packages/coding-agent/src/core/workflow-stage-admission.js";
import {
	formatReleasedReply,
	RELEASED_REPLY_FORMAT_EVENT,
	type ReleasedReplyFormatRequest,
} from "../../packages/intercom/released-reply-format.js";
import type { AgentConfig, AgentScope } from "../../packages/subagents/src/agents/agents.js";
import { INTERCOM_BRIDGE_MARKER } from "../../packages/subagents/src/intercom/intercom-bridge.js";
import { SUBAGENT_SUPERVISOR_AUTHORIZATION_EVENT } from "../../packages/subagents/src/intercom/supervisor-authorization.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import { takeStoppedQueuedOwnerlessChild } from "../../packages/subagents/src/runs/foreground/ownerless-children.js";
import { isReleasedChildError } from "../../packages/subagents/src/runs/foreground/released-child-errors.js";
import {
	type ReleasedChildReservation,
	SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT,
	SUBAGENT_DROP_RELEASED_CHILDREN_EVENT,
	SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT,
} from "../../packages/subagents/src/runs/foreground/released-child-reservations.js";
import {
	resumeReleasedChild,
	resumeWaiterCount,
} from "../../packages/subagents/src/runs/foreground/released-child-resume.js";
import {
	bindReleasedChildWakes,
	RELEASED_CHILD_WAKE_FAILURE_LABEL,
} from "../../packages/subagents/src/runs/foreground/released-child-wakes.js";
import {
	lateToolResultMessage,
	SUBAGENT_OWNER_GENERATION,
	SUBAGENT_RELEASE_AFTER_MS,
	SUBAGENT_RELEASED_WAKE_PROMPT,
	subagentWakeKey,
} from "../../packages/subagents/src/runs/foreground/released-children.js";
import {
	observeSubagentChildRecord,
	subagentChildCardRecord,
} from "../../packages/subagents/src/runs/foreground/subagent-child-card-state.js";
import {
	createSubagentChildRecordSink,
	currentWakeFailure,
	isSubagentChildRecord,
	readSubagentChildRecords,
	recordSubagentChildHeldToolResults,
	SUBAGENT_CHILD_RECORD_TYPE,
	SUBAGENT_CHILD_RELEASED_STATUS,
	SUBAGENT_CHILD_STAGE_CLOSED_STATUS,
	SUBAGENT_CHILD_STAGE_PAUSED_STATUS,
	type SubagentChildRecord,
	subagentChildRecordsAppended,
	WORKFLOW_STAGE_CLOSED_FOR_GOOD_STATE,
	WORKFLOW_STAGE_END_CHILDREN_STATE,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import {
	restoreSubagentChild,
	restoreSubagentChildren,
	SUBAGENT_AWAIT_INTERCOM_PEER_EVENT,
	SUBAGENT_RELEASE_RESTORING_CHILD_EVENT,
	SUBAGENT_RESERVE_RESTORING_CHILD_EVENT,
	type SubagentReleaseRestoringChildRequest,
	type SubagentReserveRestoringChildRequest,
	subagentChildRestoreNotices,
} from "../../packages/subagents/src/runs/foreground/subagent-child-restore.js";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import type { ExecutorDeps } from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import {
	resumeAwaitingSubagentChildren,
	SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT,
	subagentChildrenAwaitingResume,
} from "../../packages/subagents/src/runs/foreground/subagent-run-control.js";
import {
	runAgentTask,
	takeStoppedQueuedSubagentChild,
} from "../../packages/subagents/src/runs/foreground/task-execution.js";
import { createExecutionScheduler } from "../../packages/subagents/src/runs/shared/parallel-utils.js";
import { createForkContextResolver } from "../../packages/subagents/src/shared/fork-context.js";
import {
	type RunSyncOptions,
	type SingleResult,
	SUBAGENT_COMPLETE_EVENT,
	type SubagentToolResult,
	type TestSessionQueue,
} from "../../packages/subagents/src/shared/types.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { createCancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { quitRun } from "../../packages/workflows/src/runs/background/quit.js";
import { killRun, pauseRun, resumeRun } from "../../packages/workflows/src/runs/background/status.js";
import { run as runWorkflow } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import {
	WORKFLOW_STAGE_CLOSED_FOR_GOOD_STATE as WORKFLOWS_STAGE_CLOSED_FOR_GOOD_STATE,
	WORKFLOW_STAGE_END_CHILDREN_STATE as WORKFLOWS_STAGE_END_CHILDREN_STATE,
} from "../../packages/workflows/src/runs/foreground/stage-runner-controller.js";
import { createStore as createWorkflowStore } from "../../packages/workflows/src/shared/store.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

const ORIGINAL_TASK = "original task";
/** The detached call a released child waits on in these tests. */
const RELEASED_CALL = { toolCallId: "ci-1", toolName: "wait_for_ci" } as const;
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

/** A user agent with the project agent's name: the default scope shadows it with the project one. */
const userAgent: AgentConfig = {
	...agent,
	source: "user",
	filePath: "user/worker.md",
	systemPrompt: "Work as the user",
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
	/** End the owning session's lifetime, as disposing an SDK session does, then reopen it with a new one. */
	closeOwnerSessionAndReopen(): void;
	readonly ctx: ExtensionContext;
	/** Every child run: the prompt it received, its options, and the agent definition it ran. */
	readonly runs: Array<{ task: string; options: RunSyncOptions; agent: AgentConfig | undefined }>;
	readonly authorizations: string[];
	/** What Intercom was asked to do for released children, in order. */
	readonly releasedChildRequests: Array<
		| { reserve: ReleasedChildReservation[] }
		| { drop: string[]; gone?: string; refusal?: string }
		| { acknowledge: string }
	>;
	readonly holds: Array<
		{ reserve: string; aliases: readonly string[]; dormant?: true } | { release: string; gone?: string }
	>;
	/** How the next child run settles once its prompt runs; the original launch always waits until stopped. */
	settleAs: "ok" | "error";
	/** Whether the original launch completes normally when it is stopped, as a child finishing just before the stop does. */
	completesWhenStopped: boolean;
	/** Whether resumed runs also wait until stopped, instead of settling once their prompt runs. */
	resumedRunsWait: boolean;
	/** Whether the original launch ends released, waiting on a detached `wait_for_ci` call (#4326). */
	releaseOriginal: boolean;
	/** The still-running calls a stubbed released outcome hands back, and the dispatcher their results wake through. */
	releasedCalls: DetachedToolCall[];
	wakeDispatcher?: AgentWakeDispatcher;
	/** When set, a stubbed released outcome is returned only once this settles. */
	releaseGate?: PromiseWithResolvers<void>;
	releasedPendingMessages?: string[];
	disposeGate?: PromiseWithResolvers<void>;
	readonly notices: Array<Record<string, string | number>>;
	redispatchCalls: DetachedToolCall[];
	redispatchGate?: PromiseWithResolvers<void>;
	readonly redispatching: { active: number; most: number };
	/** Receives each child run's stub session, to queue steering and follow-up messages as an SDK caller does. */
	onSession?: (session: TestSessionQueue) => void;
	/** Whether the worker agent is still defined; resume looks it up again. */
	agentDefined: boolean;
	/** The agent definitions discovery finds, from every source; a project agent shadows a user one of its name. */
	agents: AgentConfig[];
	/** Runs whose prompt contains a key wait until its gate resolves, then complete; checked before the rules above. */
	readonly finishOn: Map<string, PromiseWithResolvers<void>>;
	call(params: Parameters<ReturnType<typeof createSubagentExecutor>["execute"]>[1]): Promise<SubagentToolResult>;
	launch(runId: string): Promise<{ record: SubagentChildRecord; taskId: TaskId }>;
	/** Admit a child through `schedule`, as a parallel launch does, without waiting for it to start. */
	admit(
		runId: string,
		schedule?: (dispatch: () => Promise<void>) => void,
		options?: Partial<RunSyncOptions>,
		launchAgent?: AgentConfig,
	): Promise<TaskId>;
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

function harness(options: { stage?: boolean; ownerless?: boolean } = {}): Harness {
	const cwd = makeTempDirectory("subagent-run-control-");
	let host = newHost();
	const stageState = options.stage ? new Map<string, object>() : undefined;
	const stageBoundary = options.stage ? new WorkflowStageAdmissionBoundary() : undefined;
	const sessionManager = SessionManager.inMemory(cwd);
	let ownerLifetime = new AbortController();
	const runs: Harness["runs"] = [];
	const authorizations: string[] = [];
	const holds: Harness["holds"] = [];
	const releasedChildRequests: Harness["releasedChildRequests"] = [];
	const notices: Harness["notices"] = [];
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
			if (channel === RELEASED_REPLY_FORMAT_EVENT) {
				const request = data as ReleasedReplyFormatRequest;
				request.result = formatReleasedReply(request);
			}
			if (channel === SUBAGENT_RESERVE_RESTORING_CHILD_EVENT) {
				const request = data as SubagentReserveRestoringChildRequest;
				holds.push({
					reserve: request.capability,
					aliases: request.aliases,
					...(request.dormant === true ? { dormant: true as const } : {}),
				});
				request.completion = Promise.resolve();
			}
			if (channel === SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT)
				releasedChildRequests.push({ reserve: (data as { children: ReleasedChildReservation[] }).children });
			if (channel === SUBAGENT_DROP_RELEASED_CHILDREN_EVENT) {
				const request = data as { childNames: string[]; gone?: string; refusal?: string };
				releasedChildRequests.push({
					drop: request.childNames,
					...(request.gone === undefined ? {} : { gone: request.gone }),
					...(request.refusal === undefined ? {} : { refusal: request.refusal }),
				});
			}
			if (channel === SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT)
				releasedChildRequests.push({ acknowledge: (data as { childName: string }).childName });
			if (channel === SUBAGENT_COMPLETE_EVENT) notices.push(data as Record<string, string | number>);
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
		closeOwnerSessionAndReopen() {
			ownerLifetime.abort();
			ownerLifetime = new AbortController();
		},
		ctx: {
			cwd,
			get sessionSignal() {
				return ownerLifetime.signal;
			},
			mode: "tui",
			hasUI: false,
			ui: {},
			sessionManager,
			// Without a task host the session is an SDK session that launches subagents directly.
			...(options.ownerless ? {} : { getAgentTaskHost: () => host }),
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
		releasedChildRequests,
		holds,
		settleAs: "ok",
		completesWhenStopped: false,
		resumedRunsWait: false,
		releaseOriginal: false,
		releasedCalls: [],
		notices,
		redispatchCalls: [],
		redispatching: { active: 0, most: 0 },
		agentDefined: true,
		agents: [agent],
		finishOn: new Map(),
		call: (params) => executor.execute("run-control", params, new AbortController().signal, undefined, state.ctx),
		async launch(runId) {
			const taskId = await state.admit(runId);
			const record = await state.waitForLatest(`${runId}:0`, (candidate) => candidate.launchLeafId !== undefined);
			return { record, taskId };
		},
		async admit(runId, schedule, extra, launchAgent = agent) {
			const response = await runAgentTask({
				host,
				cwd,
				agents: [launchAgent],
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
				...(state.wakeDispatcher ? { wakeDispatcher: state.wakeDispatcher } : {}),
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
		runs.push({ task, options, agent: agents.find((candidate) => candidate.name === agentName) });
		const original = task === ORIGINAL_TASK;
		if (options.redispatchDetachedCalls) {
			state.redispatching.active += 1;
			state.redispatching.most = Math.max(state.redispatching.most, state.redispatching.active);
			await state.redispatchGate?.promise;
			const reopened = await runSync(parentCwd, agents, agentName, task, {
				...options,
				redispatchDetachedCalls: false,
				skipTaskPrompt: true,
				testSession: { output: "" },
			});
			state.redispatching.active -= 1;
			const calls = state.redispatchCalls;
			return {
				...reopened,
				status: "interrupted",
				interrupted: true,
				released: { waitingOn: calls.map(({ toolCallId, toolName }) => ({ toolCallId, toolName })), calls },
				...(options.resumeFollowUps?.length ? { pendingMessages: options.resumeFollowUps } : {}),
			};
		}
		if (original && state.releaseOriginal) {
			const waiting = await runSync(parentCwd, agents, agentName, task, {
				...options,
				testSession: { output: "waiting" },
			});
			await state.releaseGate?.promise;
			return {
				...waiting,
				status: "interrupted",
				interrupted: true,
				released: { waitingOn: [RELEASED_CALL], calls: state.releasedCalls },
				...(state.releasedPendingMessages ? { pendingMessages: state.releasedPendingMessages } : {}),
			};
		}
		const gate = [...state.finishOn].find(([marker]) => task.includes(marker))?.[1];
		const onSession = state.onSession ? { onSession: state.onSession } : {};
		const disposeGate = state.disposeGate;
		const dispose = gate && disposeGate ? { dispose: () => disposeGate.promise } : {};
		const result = await runSync(parentCwd, agents, agentName, task, {
			...options,
			testSession: gate
				? { output: "finished", promptGate: gate.promise, abortResolvesPrompt: true, ...onSession, ...dispose }
				: original || state.resumedRunsWait
					? { output: "partial", promptGate: neverReleased.promise, abortResolvesPrompt: true, ...onSession }
					: { output: "resumed", ...onSession },
		});
		if (original && state.completesWhenStopped && result.interrupted)
			return { ...result, status: "ok", interrupted: false, pendingMessages: undefined };
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
		discoverAgents: (_cwd, scope) => ({ agents: state.agentDefined ? discoverInScope(state.agents, scope) : [] }),
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

/** Discovery as the default scope does it: a project agent shadows a user agent of the same name in `both`. */
function discoverInScope(agents: readonly AgentConfig[], scope: AgentScope): AgentConfig[] {
	const found = new Map<string, AgentConfig>();
	for (const source of ["builtin", "user", "project"] as const) {
		if (source !== "builtin" && scope !== "both" && scope !== source) continue;
		for (const candidate of agents) if (candidate.source === source) found.set(candidate.name, candidate);
	}
	return [...found.values()];
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

test("a paused child resumed without a message is told to redo or continue the step the pause interrupted (#3996)", async () => {
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
		h.runs.at(-1)?.task ?? "",
		/^Continue where you left off\. If a pause interrupted a command or step you were running, redo or continue that step as needed\./,
	);
});

const QUIT_PARITY_RUN_ID = "quitparity1";
const QUIT_PARITY_CHILD_ID = `${QUIT_PARITY_RUN_ID}:0`;
const QUIT_PARITY_RESUME_CALL = `{ action: "resume", id: "${QUIT_PARITY_CHILD_ID}"`;
const PAUSED_AWAITING_RESUME = /paused · awaiting resume/;
const ENDED_FOR_GOOD_WORDING = /This execution has ended|Do not restart it|parent-handoff/;

test("quit reports a child paused and awaiting resume with its resume call, as a workflow quit does, and status keeps listing it so across a restart", async () => {
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
	assert.equal(
		WORKFLOW_STAGE_END_CHILDREN_STATE,
		WORKFLOWS_STAGE_END_CHILDREN_STATE,
		"the workflows extension ends a blocked stage's children through the state subagents sets",
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
	assert.equal(
		"cause" in observed.value.result ? observed.value.result.cause : "",
		"pause",
		"a workflow quit pauses its stage's subagents with the typed resumable pause cause",
	);
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

for (const [owner, cause] of [
	["an interrupted workflow stage", "stage-close"],
	["a session Atomic exited or switched away from", "session-close"],
] as const) {
	test(`a child of ${owner} keeps its queued messages, and reopening delivers them once, in order (#3784)`, async () => {
		const h = harness({ stage: cause === "stage-close" });
		const live = Promise.withResolvers<TestSessionQueue>();
		h.onSession = (session) => live.resolve(session);
		const { record } = await h.launch(`held-${cause}`);
		h.onSession = undefined;
		const session = await live.promise;
		const steer = "STEER: report the permission error only";
		const followUp = "FOLLOWUP: include the failing command";
		await session.steer(steer);
		await session.followUp(followUp);

		await h.closeOwnerAndReopen(cause);
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

test("status lists only the children this session launched, by ids quit takes, and quit stops each one it lists", async () => {
	const own = harness();
	// Another session in the same process, such as a workflow stage, with a child of its own.
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
	beforeRestore?: () => void,
): Promise<{ task: string; options: RunSyncOptions; agent: AgentConfig | undefined; taskId: string }> {
	await h.admit(runId, undefined, options, launchAgent);
	const record = await h.waitForLatest(`${runId}:0`, (candidate) => candidate.launchLeafId !== undefined);
	await h.closeOwnerAndReopen("session-close");
	await sleep(50);
	assert.equal(h.latest(record.childId)?.state, "running", "closing its owner records nothing terminal");
	beforeRestore?.();
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
		.find((record) => record.childId === childId && record.taskId === taskId && record.launchLeafId !== undefined);
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
	const startsOfB = () => h.runs.filter((run) => run.task.includes("slot-b-marker"));

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
	const delivered = transcript(finished);
	assert.equal(occurrences(delivered, steer), 1, "the held steer is delivered exactly once");
	assert.equal(occurrences(delivered, followUp), 1, "the held follow-up is delivered exactly once");
	assert.ok(delivered.indexOf(steer) < delivered.indexOf(followUp), "in the order it queued them");

	const again = await h.call({ action: "resume", id: running.childId });
	assert.notEqual(again.isError, true, text(again));
	const againTask = resumedTaskId(again);
	const after = transcript(
		await h.waitForLatest(
			running.childId,
			(candidate) => candidate.taskId === againTask && candidate.state === "terminal",
		),
	);
	assert.equal(occurrences(after, steer), 1, "a later resume does not deliver the steer again");
	assert.equal(occurrences(after, followUp), 1, "a later resume does not deliver the follow-up again");
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
	assert.match(text(resumed), /agent "worker" \(project\) is no longer defined/);
	await sleep(100);
	assert.equal(readFileSync(trackedEdit, "utf8"), "edited by A\n", "the tracked edit survives the failed resume");
	assert.equal(readFileSync(untrackedDraft, "utf8"), "draft by A\n", "the untracked draft survives the failed resume");
	assert.equal(gitOutput(h.cwd, ["branch", "--list", branch]).replace(/^[*+ ]+/, ""), branch, "its branch survives");
});

function savedPatches(record: SubagentChildRecord): string[] {
	const diffsDir = record.worktree?.diffsDir;
	assert.ok(diffsDir, "the child record names where its run saves its patches");
	if (!existsSync(diffsDir)) return [];
	return readdirSync(diffsDir)
		.filter((file) => new RegExp(`^task-${record.index}-worker(\\.\\d+)?\\.patch$`).test(file))
		.map((file) => join(diffsDir, file))
		.sort();
}

/**
 * A restored file as Git checks it out on this machine: with `core.autocrlf=true` (Git for Windows' default) the
 * restored text has CRLF line endings, like every other file of the recreated worktree.
 */
function readCheckedOut(file: string): string {
	return readFileSync(file, "utf8").replaceAll("\r\n", "\n");
}

test("resuming a completed worktree child starts from its saved edits, and no execution's patch overwrites an earlier one (#3784)", async () => {
	const h = harness();
	initGitRepository(h.cwd);
	const firstDone = Promise.withResolvers<void>();
	const resumedDone = Promise.withResolvers<void>();
	h.finishOn.set("task-a-marker", firstDone);
	h.finishOn.set("task-b-marker", firstDone);
	h.finishOn.set(SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT, resumedDone);
	const [childA, childB] = await launchWorktreeRun(h, ["task-a-marker", "task-b-marker"]);
	assert.ok(childA && childB);
	const diffsDir = childA.worktree?.diffsDir;
	if (diffsDir) cleanups.push(async () => rmSync(diffsDir, { recursive: true, force: true }));
	await h.waitForLatest(childA.childId, (candidate) => !!candidate.childSessionId);
	await h.waitForLatest(childB.childId, (candidate) => !!candidate.childSessionId);
	writeFileSync(join(childA.cwd, "seed.txt"), "edited by A\n");
	writeFileSync(join(childA.cwd, "draft.md"), "draft by A\n");

	firstDone.resolve();
	await settled(h, childA.taskId as string);
	await settled(h, childB.taskId as string);
	await waitUntilRemoved(childA.cwd);
	assert.equal(existsSync(childA.cwd), false, "the completed run removed its worktree");
	const [firstPatch] = savedPatches(childA);
	assert.ok(firstPatch, "the first execution's edits were saved as a patch");
	const firstContent = readFileSync(firstPatch, "utf8");
	assert.match(firstContent, /draft by A/);

	const resumed = await h.call({ action: "resume", id: childA.childId });
	assert.notEqual(resumed.isError, true, text(resumed));
	const resumedTask = resumedTaskId(resumed);
	await h.waitForLatest(childA.childId, (candidate) => candidate.taskId === resumedTask && !!candidate.childSessionId);
	assert.equal(readCheckedOut(join(childA.cwd, "seed.txt")), "edited by A\n", "the earlier tracked edit is back");
	assert.equal(readCheckedOut(join(childA.cwd, "draft.md")), "draft by A\n", "the earlier draft is back");
	writeFileSync(join(childA.cwd, "second.md"), "second pass by A\n");

	resumedDone.resolve();
	await settled(h, resumedTask);
	await waitUntilRemoved(childA.cwd);
	const patches = savedPatches(childA);
	assert.equal(patches.length, 2, `one patch per execution: ${patches.join(", ")}`);
	assert.equal(readFileSync(firstPatch, "utf8"), firstContent, "the first execution's patch is not overwritten");
	const latest = readFileSync(patches.find((patch) => patch !== firstPatch)!, "utf8");
	assert.match(latest, /edited by A/, "the resumed execution's patch keeps the earlier tracked edit");
	assert.match(latest, /draft by A/, "the resumed execution's patch keeps the earlier draft");
	assert.match(latest, /second pass by A/, "the resumed execution's patch has its own edits");
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

test("resumeInFlight auto resumes a subagent quit before a restart without asking (#3827)", async () => {
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
	assert.equal(relaunch.task, SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT);
	assert.equal(relaunch.options.resumeSession, true);
	assert.equal(relaunch.options.sessionManager?.getSessionId(), quit.childSessionId);
	assert.equal(ui.notices.length, 1);
	assert.equal(ui.notices[0]?.type, "info");
});

test("resumeInFlight never resumes subagents owned by a workflow stage (#3827)", async () => {
	const h = harness({ stage: true });
	const quit = await quitChild(h, "stage1");
	const { ctx, ui } = startupContext(h);
	const runsBefore = h.runs.length;

	await resumeAwaitingSubagentChildren(h.deps, ctx, "auto", () => true);

	assert.deepEqual(ui, { confirms: [], notices: [] });
	assert.equal(h.runs.length, runsBefore);
	assert.equal(h.latest(quit.childId)?.terminalStatus, "quit");
});

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
	const steer = "/workflow attach run-1";
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
		assert.deepEqual(relaunch.options.resumeFollowUps, [
			"/review src/held.ts",
			SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT,
		]);
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

	const wakes = h.runs.filter((run) => run.task === lateToolResultMessage(result));
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
	assert.deepEqual(h.latest("release4b:0")?.heldToolResults, [late]);
	assert.deepEqual(
		subagentChildCardRecord("release4b:0", h.latest("release4b:0")?.taskId ?? "")?.heldToolResults,
		[late],
		"the child's card shows the result it holds",
	);

	const resumed = await h.call({ action: "resume", id: "release4b:0", message: "go on" });
	await settled(h, resumedTaskId(resumed));
	assert.equal(h.runs.at(-1)?.task, lateToolResultMessage(late));
	assert.deepEqual(h.runs.at(-1)?.options.resumeFollowUps, ["go on", SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT]);
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
	assert.equal(h.runs.at(-1)?.task, SUBAGENT_RELEASED_WAKE_PROMPT);
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

const DRAIN_TURNS = 1_000;

async function drained(dispatcher: AgentWakeDispatcher): Promise<number> {
	for (let turn = 0; turn < DRAIN_TURNS && dispatcher.stats().keys > 0; turn++)
		await new Promise((resolve) => setImmediate(resolve));
	return dispatcher.stats().keys;
}

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
	assert.equal(wakeRuns[0]?.task, lateToolResultMessage(green), "the wake brought the result");
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
	assert.deepEqual(h.latest("drain1:0")?.heldToolResults, [green], "a running child keeps the result for later");
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

test("results a woken child is given stay held in its record until its run has them (#4326)", async () => {
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
	const running = await h.waitForLatest(
		"heldwake1:0",
		(record) => record.state === "running" && record.taskId === taskId && record.launchLeafId !== undefined,
	);
	assert.deepEqual(running.heldToolResults, [green], "the result is still held while the run has not read it");
	assert.deepEqual(h.runs.at(-1)?.options.wakeToolResultIds, ["ci-1"]);

	gate.resolve();
	await settled(h, taskId);
	const done = await h.waitForLatest("heldwake1:0", clearedOk);
	assert.equal(done.taskId, taskId);
	assert.equal(h.runs.filter((run) => run.task === lateToolResultMessage(green)).length, 1);
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
	assert.deepEqual(h.latest("during1:0")?.heldToolResults, [green], "a running child keeps the result for later");
	gate.resolve();
	await settled(h, taskId);

	const woken = await h.waitForLatest("during1:0", (record) => record.taskId !== taskId && clearedOk(record));
	assert.ok(woken.taskId);
	await settled(h, woken.taskId);
	assert.equal(await drained(dispatcher), 0);
	assert.equal(h.runs.filter((run) => run.task === lateToolResultMessage(green)).length, 1, "woken once, with it");
	assert.deepEqual(h.latest("during1:0")?.heldToolResults, []);
});

test("messages a released child had queued and not read are delivered once, in order, when it wakes (#4326)", async () => {
	const h = harness();
	const queued = ["Check the flaky test too.", "Then rerun lint."];
	h.releasedPendingMessages = queued;
	const dispatcher = await releasedWithWakes(h, "queuedwake1");
	const released = h.latest("queuedwake1:0");
	assert.deepEqual(released?.heldMessages, { taskId: released?.taskId, messages: queued, taskExpands: false });
	const green = waitResult("CI green");

	await dispatcher.deliver(subagentWakeKey(h.sessionManager.getSessionId(), "queuedwake1:0"), {
		id: "tool-result:ci-1",
		kind: "tool-result",
		toolResult: green,
	});
	assert.equal(h.runs.at(-1)?.task, lateToolResultMessage(green));
	assert.deepEqual(h.runs.at(-1)?.options.resumeFollowUps, [...queued, SUBAGENT_RELEASED_WAKE_PROMPT]);
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
	for (let turn = 0; turn < DRAIN_TURNS && h.runs.length === runsBeforeWake; turn++)
		await new Promise((resolve) => setImmediate(resolve));
	h.disposeGate.resolve();
	await wake;

	assert.equal(runsWhenClosed, runsBeforeWake, "no wake ran before the previous run's session closed");
	assert.equal(h.runs.length, runsBeforeWake + 1);
});

async function untilNotices(h: Harness, count: number): Promise<number> {
	for (let turn = 0; turn < DRAIN_TURNS && h.notices.length < count; turn++)
		await new Promise((resolve) => setImmediate(resolve));
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
	assert.deepEqual(failed.heldToolResults, [green], "the result the failed wake carried is kept");
	assert.deepEqual([failed.wakeFailure?.code, failed.wakeFailure?.taskId], ["child-unrestorable", failed.taskId]);
	assert.match(failed.wakeFailure?.reason ?? "", /worker/);
	assert.match(failed.wakeFailure?.hint ?? "", /"resume"/);
	assert.equal(await untilNotices(h, 1), 1);
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
	assert.equal(h.runs.filter((run) => run.task === lateToolResultMessage(green)).length, 1);
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
		assert.equal(h.runs.filter((run) => run.task.includes('No reply from "peer" within 10 minutes')).length, 1);
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
	assert.equal(h.runs.filter((run) => run.task === lateToolResultMessage(green)).length, 1);
	assert.equal(h.runs.filter((run) => run.options.redispatchDetachedCalls).length, 1, "started again once");
});

test("a child of the earlier process whose call result is already held is woken with it instead of starting the call again (#4326)", async () => {
	const h = harness();
	const green = waitResult("CI green before the restart");
	await releasedByEarlierProcess(h, "heldrestart1", { heldToolResults: [green] });

	bindProcessWakes(h);
	await h.waitForLatest("heldrestart1:0", clearedOk);
	assert.equal(h.runs.filter((run) => run.options.redispatchDetachedCalls).length, 0);
	assert.equal(h.runs.filter((run) => run.task === lateToolResultMessage(green)).length, 1);
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

test("a resume arriving during a released child's wake is queued and delivered after that wake (#4326)", async () => {
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
	await h.waitForLatest("race-resume:0", (record) => record.state === "running" && record.taskId !== undefined);
	const resume = h.call({ action: "resume", id: "race-resume:0", message: "follow up after CI" });
	gate.resolve();
	await wake;
	const response = await resume;
	assert.equal(response.isError, undefined);
	assert.equal(resumeWaiterCount(), 0);
	await settled(h, resumedTaskId(response));
	assert.equal(h.runs.filter((run) => run.task.includes("CI green")).length, 1);
	assert.equal(h.runs.filter((run) => run.task.includes("follow up after CI")).length, 1);
});

test("resume messages batched behind a wake are delivered once in arrival order (#4326)", async () => {
	const h = harness();
	const dispatcher = await releasedWithWakes(h, "batch-resume");
	const owner = h.sessionManager.getSessionId();
	const gate = Promise.withResolvers<void>();
	h.finishOn.set("CI green", gate);
	const wake = dispatcher.deliver(subagentWakeKey(owner, "batch-resume:0"), {
		id: "tool-result:ci-1",
		kind: "tool-result",
		toolResult: waitResult("CI green"),
	});
	await h.waitForLatest("batch-resume:0", (record) => record.state === "running" && record.taskId !== undefined);
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
	assert.equal(h.runs.filter((run) => run.task.includes("first wake")).length, 1);
	assert.equal(h.runs.filter((run) => run.task.includes("CI green")).length, 1);
	assert.equal(
		h.runs.filter((run) => run.options.resumeFollowUps?.includes("later resume") || run.task === "later resume")
			.length,
		1,
	);
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
	const ranResumed = () => h.runs.filter((run) => run.task.includes("go second")).length;

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

test("a wake saves the results it carries in the child's record before the child is restored, and the record no longer holds them once its run has them (#4326)", async () => {
	const h = harness();
	const dispatcher = await releasedWithWakes(h, "save-first");
	const owner = h.sessionManager.getSessionId();
	const green = waitResult("CI green");
	const heldWhenRestoreBegan: Array<readonly DetachedToolResult[] | undefined> = [];
	const emit = h.deps.pi.events.emit.bind(h.deps.pi.events);
	h.deps.pi.events.emit = (channel: string, data: object) => {
		if (channel === SUBAGENT_RESERVE_RESTORING_CHILD_EVENT)
			heldWhenRestoreBegan.push(h.latest("save-first:0")?.heldToolResults);
		emit(channel, data);
	};
	const gate = Promise.withResolvers<void>();
	h.finishOn.set("CI green", gate);

	const woken = dispatcher.deliver(subagentWakeKey(owner, "save-first:0"), {
		id: "tool-result:ci-1",
		kind: "tool-result",
		toolResult: green,
	});
	const running = await h.waitForLatest(
		"save-first:0",
		(record) => record.state === "running" && record.launchLeafId !== undefined,
	);

	assert.deepEqual(heldWhenRestoreBegan, [[green]], "stored before the child is reopened");
	assert.deepEqual(running.heldToolResults, [green], "still held while its run has not read it");
	gate.resolve();
	await woken;
	const done = await h.waitForLatest("save-first:0", clearedOk);
	await settled(h, done.taskId ?? "");
	assert.equal(h.runs.filter((run) => run.task === lateToolResultMessage(green)).length, 1);
});
