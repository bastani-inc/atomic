import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
	agentWakeDispatcher,
	currentWorktreeRootMappings,
	type DetachedToolResult,
	type ExtensionContext,
	type WorktreeRootMapping,
	withWorktreeRootMappings,
} from "@bastani/atomic";
import { afterEach, test, vi } from "vitest";
import { renameWithRetry } from "../../packages/coding-agent/src/core/rename-retry.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SessionSpillError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type { TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { WorkflowStageAdmissionBoundary } from "../../packages/coding-agent/src/core/workflow-stage-admission.js";
import { captureWorktreeSnapshot } from "../../packages/coding-agent/src/core/worktree-snapshot/capture.js";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../../packages/coding-agent/src/core/worktree-snapshot/settings.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agents.js";
import { SUBAGENT_SUPERVISOR_AUTHORIZATION_EVENT } from "../../packages/subagents/src/intercom/supervisor-authorization.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import { bindReleasedChildWakes } from "../../packages/subagents/src/runs/foreground/released-child-wakes.js";
import {
	interruptedStillRunningResult,
	lateToolResultMessage,
	SUBAGENT_INTERRUPTED_BY_RESTART_RESULT,
	SUBAGENT_OWNER_GENERATION,
	SUBAGENT_RELEASE_AFTER_MS,
	SUBAGENT_RELEASED_WAKE_PROMPT,
	SUBAGENT_STILL_RUNNING_RESULT,
} from "../../packages/subagents/src/runs/foreground/released-children.js";
import { registerRunWorktrees, runWorktreeRecord } from "../../packages/subagents/src/runs/foreground/run-worktrees.js";
import {
	indexSubagentChildOwner,
	observeSubagentChildRecord,
} from "../../packages/subagents/src/runs/foreground/subagent-child-card-state.js";
import {
	createSubagentChildRecordSink,
	holdInterruptedStillRunningCalls,
	readSubagentChildRecords,
	recordSubagentChildHeldToolResults,
	recordSubagentChildStatus,
	SUBAGENT_CHILD_RECORD_TYPE,
	SUBAGENT_CHILD_RELEASED_STATUS,
	SUBAGENT_CHILD_STAGE_PAUSED_STATUS,
	type SubagentChildRecord,
	type SubagentChildWaitingCall,
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
import { runAgentTask, taskToolResult } from "../../packages/subagents/src/runs/foreground/task-execution.js";
import { cleanupWorktrees, createWorktrees } from "../../packages/subagents/src/runs/shared/worktree.js";
import type { RunSyncOptions, SingleResult, SubagentToolResult } from "../../packages/subagents/src/shared/types.js";
import { runGitChecked } from "../../packages/workflows/src/runs/shared/worktree-git.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";
import { subagentLaunchCard } from "../helpers/subagent-launch-card.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

useTemporaryAgentDir();

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
	readonly runs: Array<{ task: string; options: RunSyncOptions; scope: readonly WorktreeRootMapping[] }>;
	readonly holds: Array<{ reserve: string; dormant?: true } | { release: string }>;
	readonly stageState?: Map<string, object>;
	host: AgentTaskHost;
	original: OriginalLaunch;
	originalGate?: PromiseWithResolvers<void>;
	/** Holds a woken run open, before ("before-save") or after ("after-save") its results are saved, until resolved. */
	wokenGate?: {
		gate: PromiseWithResolvers<void>;
		at: "before-start" | "before-save" | "after-save";
		/** Resolved once a woken run held before its session starts waits on `gate`. */
		held?: PromiseWithResolvers<void>;
	};
	/** The calls the original launch is released waiting on. */
	releasedWaits: readonly SubagentChildWaitingCall[];
	/** When set, a woken run that is not stopped ends in an error, before it reports the results it saved. */
	wokenFails?: true;
	/** When set, a woken run that is not stopped is released again, waiting on these calls. */
	wokenReleasedOn?: readonly SubagentChildWaitingCall[];
	/** Every tool result a woken run saved into the child's transcript, in order. */
	readonly saved: DetachedToolResult[];
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

function harness(options: { stage?: boolean; sessionManager?: SessionManager } = {}): Harness {
	const cwd = makeTempDirectory("subagent-wake-restore-");
	let host = newHost();
	const stageState = options.stage ? new Map<string, object>() : undefined;
	const stageBoundary = options.stage ? new WorkflowStageAdmissionBoundary() : undefined;
	const sessionManager = options.sessionManager ?? SessionManager.inMemory(cwd);
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
		saved: [],
		releasedWaits: [WAIT_CALL],
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
		runs.push({ task, options, scope: currentWorktreeRootMappings() });
		if (task !== ORIGINAL_TASK) {
			const { resumeToolResults: results, skipTaskPrompt: _skip, ...rest } = options;
			// As the real runner: a woken run's results are saved into its transcript only once nothing stopped it first, and
			// then toolResultsSaved reports them.
			const saveResults = () => {
				if (!results?.length) return;
				state.saved.push(...results);
				options.taskExecution?.toolResultsSaved?.(results.map((result) => result.toolCallId));
			};
			const woken = state.wokenGate;
			// A promptless wake's run writes nothing into the child's transcript before the results it continues its turn
			// with, but this stand-in's session prompts its task as a user turn before its gate. Held before its session
			// starts, a stop leaves the transcript as the real run leaves it, whenever the stop comes.
			const holdsBeforeSession =
				woken?.at === "before-start" || (woken?.at === "before-save" && options.skipTaskPrompt === true);
			if (woken && holdsBeforeSession) {
				woken.held?.resolve();
				await new Promise<void>((resolve) => {
					void woken.gate.promise.then(resolve);
					options.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
			}
			if (woken?.at === "before-start" || (holdsBeforeSession && options.signal?.aborted)) {
				// Stopped before its session sent anything: what it was given stays unread, as the runner reports it.
				return {
					agent: agentName,
					task,
					exitCode: 1,
					status: "interrupted",
					interrupted: true,
					messages: [],
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					pendingMessages: [task, ...(rest.resumeFollowUps ?? [])],
				} as SingleResult;
			}
			if (woken) {
				if (woken.at === "after-save") saveResults();
				const out = await runSync(parentCwd, agents, agentName, task, {
					...rest,
					testSession: { output: "resumed", promptGate: woken.gate.promise, abortResolvesPrompt: true },
				});
				// A run that fails as it continues its turn never gets to report what it saved.
				if (woken.at === "before-save" && out.status !== "interrupted" && !state.wokenFails) saveResults();
				if (out.status === "interrupted") return out;
				if (state.wokenFails) return { ...out, status: "error", error: "boom" };
				if (state.wokenReleasedOn === undefined) return out;
				return {
					...out,
					status: "interrupted",
					interrupted: true,
					released: { waitingOn: [...state.wokenReleasedOn], calls: [] },
				};
			}
			saveResults();
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
		return {
			...waiting,
			status: "interrupted",
			interrupted: true,
			released: { waitingOn: [...state.releasedWaits], calls: [] },
		};
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

test("a stage's original launch card opened during a wake counts from the new dispatch (#5570)", async () => {
	const h = harness({ stage: true });
	h.original = "released";
	h.originalGate = Promise.withResolvers<void>();
	const first = await h.admit("elapsed-wake");
	const launch = await h.host.observeAgentLaunch(first, { kind: "background" });
	assert.ok(launch.ok);
	const receipt = taskToolResult({ kind: "admitted", observation: launch.value }, h.host);
	h.originalGate.resolve();
	await settled(h, first);
	const old = await h.waitForLatest("elapsed-wake:0", (r) => r.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS);
	h.wokenGate = { at: "before-start", gate: Promise.withResolvers<void>(), held: Promise.withResolvers<void>() };
	const woken = await restoreSubagentChild(h.deps, h.ctx, old.childId, { prompt: "continue" });
	assert.ok(woken.kind === "restored");
	await h.wokenGate.held!.promise;
	const row = () => h.host.taskRecords().find((task) => task.ref.taskId === woken.taskId);
	const origin = row()?.elapsedSpan?.dispatchedAt;
	assert.ok(origin !== undefined);
	const clock = vi.spyOn(Date, "now").mockReturnValue(origin + 7400);
	const card = subagentLaunchCard(h.cwd, { agent: agent.name, task: ORIGINAL_TASK });
	try {
		card.updateResult({ ...receipt, isError: false });
		assert.equal(row()?.metrics?.elapsedMs, 7400);
		assert.match(stripVTControlCharacters(card.render(120).join("\n")), /Running[^\n]*7s/);
	} finally {
		card.dispose();
		clock.mockRestore();
		h.wokenGate.gate.resolve();
		await settled(h, woken.taskId);
	}
});

async function endSessionOnPendingCall(
	record: SubagentChildRecord,
	calls: readonly SubagentChildWaitingCall[] = [WAIT_CALL],
): Promise<void> {
	assert.ok(record.childSessionFile);
	const session = await SessionManager.open(record.childSessionFile, undefined, record.cwd);
	await session.appendMessage({
		role: "assistant",
		content: calls.map((call) => ({
			type: "toolCall" as const,
			id: call.toolCallId,
			name: call.toolName,
			arguments: { run: "7" },
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

test("a paused child whose latest record is in a copy of its owner's session no longer open is resumed from the owner's own session", async () => {
	const h = harness();
	h.original = "waits";
	await h.admit("lost-copy-pause");
	await h.waitForLatest("lost-copy-pause:0", (candidate) => candidate.launchLeafId !== undefined);
	await h.call({ action: "pause", id: "lost-copy-pause:0" });
	const record = await h.waitForLatest("lost-copy-pause:0", (candidate) => candidate.terminalStatus === "paused");
	await endSessionOnPendingCall(record);
	indexSubagentChildOwner(h.ctx);
	// Since, its latest record was saved by a copy of the owner's session that is not open in this process any more.
	observeSubagentChildRecord(record, false, { entryId: "entry-of-a-closed-copy", sessionId: record.owner.sessionId });

	const run = await restored(h, record.childId, { prompt: "carry on" });

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
	assert.deepEqual(record.waitingOn ?? [], [], "it waits on nothing");
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
	assert.deepEqual(record.waitingOn ?? [], [], "it waits on nothing");
	assert.deepEqual(
		h.holds.filter((hold) => "dormant" in hold),
		[],
	);
});

async function repositoryWithSeed(): Promise<string> {
	const root = makeTempDirectory("subagent-wake-worktree-");
	cleanups.push(() => removeTempDirectory(root));
	await runGitChecked(root, ["init", "-b", "main"]);
	await runGitChecked(root, ["config", "user.name", "Atomic Test"]);
	await runGitChecked(root, ["config", "user.email", "atomic@example.com"]);
	await runGitChecked(root, ["config", "core.autocrlf", "false"]);
	writeFileSync(join(root, "seed.txt"), "seed\n");
	await runGitChecked(root, ["add", "seed.txt"]);
	await runGitChecked(root, ["commit", "--no-gpg-sign", "-m", "initial"]);
	return root;
}

async function childWithDirtyWorktree(h: Harness, runId: string) {
	const repo = await repositoryWithSeed();
	const setup = await createWorktrees(repo, runId, 1);
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
	return { taskId, worktree, draft, repo };
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
	const { taskId, worktree, draft, repo } = await childWithDirtyWorktree(h, "wt-finished");
	h.originalGate?.resolve();
	await settled(h, taskId);
	await h.waitForLatest("wt-finished:0", (record) => record.terminalStatus === "ok");
	// The run forgets its worktrees only once its sweep removed every one of them, branch included. Git is not run here
	// before then: on Windows a read of the repository's config while the sweep deletes the branch fails.
	const deadline = Date.now() + RECORD_WAIT_MS;
	while (runWorktreeRecord("wt-finished", 0) !== undefined && Date.now() < deadline) await sleep(10);

	assert.equal(runWorktreeRecord("wt-finished", 0), undefined, "the run's sweep finished");
	assert.equal(existsSync(draft), false, "a finished child's worktree goes with its run");
	assert.equal(existsSync(worktree.path), false);
	assert.equal(
		execFileSync("git", ["branch", "--list", worktree.branch], { cwd: repo, encoding: "utf8" }).trim(),
		"",
		"its branch goes with it",
	);
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

const restoreOf = (from: string, to: string): WorktreeRootMapping => ({
	from,
	to,
	snapshotId: "s".repeat(64),
	tree: "t".repeat(40),
	restoredAt: "2026-11-07T00:00:00.000Z",
});

test("a released child woken outside the work it was launched in still follows that work's restores (#4329)", async () => {
	const h = harness();
	const launchRestore = restoreOf("/node-a/repo", join(h.cwd, "restored-for-the-launch"));

	const record = await withWorktreeRootMappings([launchRestore], () => releasedChild(h, "wake-scope"));

	assert.deepEqual(record.worktreeRootMappings, [launchRestore]);
	assert.deepEqual(
		h.runs[0]?.scope,
		[launchRestore],
		"the original launch ran inside the restores it was launched in",
	);
	assert.deepEqual(currentWorktreeRootMappings(), [], "the test itself is outside any work");
	await restored(h, record.childId, { prompt: SUBAGENT_RELEASED_WAKE_PROMPT });
	assert.deepEqual(h.runs.at(-1)?.scope, [launchRestore]);
	assert.deepEqual(h.latest(record.childId)?.worktreeRootMappings, [launchRestore], "a later wake keeps them too");
});

/** An owner session in a database store, which keeps the snapshot blobs a restore reads, as shared storage does. */
async function sqlOwner(): Promise<SessionManager> {
	const directory = makeTempDirectory("subagent-wake-owner-");
	const database = await openNodeSqliteDatabase(join(directory, "sessions.sqlite"));
	const store = await SqlSessionStore.open(database);
	cleanups.push(async () => {
		await store.close();
		await database.close();
		removeTempDirectory(directory);
	});
	return SessionManager.create(store, directory);
}

/** The owner records that its checkout `from` was restored into `to`, as a resume on another machine does. */
async function ownerRestores(h: Harness, sandbox: GitSandbox, from: string, to: string): Promise<WorktreeRootMapping> {
	const { clone } = await sandbox.remoteWithClone("owner-repo", { "README.md": "owner\n" });
	const capture = await captureWorktreeSnapshot(clone, {
		settings: DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
		blobs: h.sessionManager.getSessionStore().snapshotBlobs,
	});
	if (capture.status !== "captured") throw new Error(capture.status);
	await h.sessionManager.appendWorktreeSnapshot(clone, capture.snapshot.id, capture.snapshot);
	const mapping = { ...restoreOf(from, to), snapshotId: capture.snapshot.id, tree: capture.snapshot.tree };
	await h.sessionManager.appendWorktreeSnapshot(to, mapping.snapshotId, undefined, mapping);
	return mapping;
}

test("a woken child follows the restores its owner recorded since, over those of its launch, for the same checkout (#4329)", async () => {
	const sandbox = new GitSandbox();
	cleanups.push(() => sandbox.dispose());
	const h = harness({ sessionManager: await sqlOwner() });
	const launched = restoreOf("/node-a/repo", "/node-a/old-worktree");
	const record = await withWorktreeRootMappings([launched], () => releasedChild(h, "wake-owner-scope"));
	const ownerRestore = await ownerRestores(h, sandbox, "/node-a/repo", join(h.cwd, "restored-for-the-owner"));

	await restored(h, record.childId, { prompt: SUBAGENT_RELEASED_WAKE_PROMPT });

	assert.deepEqual(h.runs.at(-1)?.scope, [ownerRestore]);
});

test("a child whose directory is gone here continues in the worktree its owner restored for it (#4329)", async () => {
	const sandbox = new GitSandbox();
	cleanups.push(() => sandbox.dispose());
	const h = harness({ sessionManager: await sqlOwner() });
	const recorded = makeTempDirectory("subagent-wake-node-a-");
	const worktree = makeTempDirectory("subagent-wake-node-b-");
	cleanups.push(() => removeTempDirectory(worktree));
	h.original = "released";
	await settled(h, await h.admit("wake-moved", { cwd: recorded }));
	const record = await h.waitForLatest(
		"wake-moved:0",
		(candidate) => candidate.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS,
	);
	assert.equal(record.cwd, recorded);
	removeTempDirectory(recorded);

	const gone = await restoreSubagentChild(h.deps, h.ctx, record.childId, { prompt: "carry on" });
	assert.equal(gone.kind, "unrestorable", "without a restore of its directory it cannot continue");
	assert.match(gone.kind === "unrestorable" ? gone.reason : "", /working directory no longer exists/);

	await ownerRestores(h, sandbox, recorded, worktree);
	const run = await restored(h, record.childId, { prompt: "carry on" });

	assert.equal(run.cwd, worktree);
	assert.equal(run.sessionManager?.getCwd(), worktree);
});

/** A released child that worked in a checkout of its own, in the owner's database, whose snapshot it recorded. */
async function childWorkedInCheckout(
	h: Harness,
	sandbox: GitSandbox,
	runId: string,
	edit: string,
): Promise<{ record: SubagentChildRecord; clone: string }> {
	const { clone } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n" });
	const store = h.sessionManager.getSessionStore();
	const child = await SessionManager.create(store, clone);
	await child.appendMessage({ role: "user", content: "edit", timestamp: 1 });
	sandbox.write(join(clone, "README.md"), edit);
	const capture = await captureWorktreeSnapshot(clone, {
		settings: DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
		blobs: store.snapshotBlobs,
	});
	if (capture.status !== "captured") throw new Error(capture.status);
	await child.appendWorktreeSnapshot(clone, capture.snapshot.id, capture.snapshot);
	const released = await releasedChild(h, runId);
	const record = { ...released, cwd: clone, childSessionId: child.getSessionId(), childSessionFile: undefined };
	await appendRecord(h, record);
	return { record, clone };
}

test("a child whose own checkout is gone here is restored from its own snapshot before it continues (#4329)", async () => {
	const sandbox = new GitSandbox();
	cleanups.push(() => sandbox.dispose());
	const h = harness({ sessionManager: await sqlOwner() });
	const { record, clone } = await childWorkedInCheckout(
		h,
		sandbox,
		"wake-own-checkout",
		"edited by the child on node A\n",
	);
	await renameWithRetry(clone, sandbox.path("node-a-offline"));

	const run = await restored(h, record.childId, { prompt: "carry on" });

	const worktree = run.cwd;
	assert.ok(worktree !== undefined && worktree !== clone && existsSync(worktree), String(worktree));
	assert.equal(readFileSync(join(worktree, "README.md"), "utf8"), "edited by the child on node A\n");
	assert.equal(run.sessionManager?.getCwd(), worktree);
	assert.deepEqual(
		run.sessionManager?.getWorktreeRootMappings().map((mapping) => [mapping.from, mapping.to]),
		[[clone, worktree]],
	);
});

test("a child woken again continues in the worktree it was restored into, which is not restored again (#4329)", async () => {
	const sandbox = new GitSandbox();
	cleanups.push(() => sandbox.dispose());
	const h = harness({ sessionManager: await sqlOwner() });
	const { record, clone } = await childWorkedInCheckout(h, sandbox, "wake-twice", "edited by the child on node A\n");
	await renameWithRetry(clone, sandbox.path("node-a-offline"));
	const first = await restored(h, record.childId, { prompt: "carry on" });
	// Its record still names the directory it was recorded in, as when the restore was not recorded with it.
	await appendRecord(h, { ...h.latest(record.childId)!, cwd: clone });

	const second = await restored(h, record.childId, { prompt: "carry on again" });

	assert.equal(second.cwd, first.cwd);
	assert.equal(second.sessionManager?.getCwd(), first.cwd);
	assert.equal(second.sessionManager?.getWorktreeRootMappings().length, 1, "restored once");
});

test("a child whose own checkout is still here as it worked in it keeps it, with no Git involved in moving it (#4329)", async () => {
	const sandbox = new GitSandbox();
	cleanups.push(() => sandbox.dispose());
	const h = harness({ sessionManager: await sqlOwner() });
	const { record, clone } = await childWorkedInCheckout(h, sandbox, "wake-own-here", "edited by the child\n");
	sandbox.write(join(clone, "later.txt"), "written after the release\n");

	const run = await restored(h, record.childId, { prompt: "carry on" });

	assert.equal(run.cwd, clone);
	assert.deepEqual(run.sessionManager?.getWorktreeRootMappings(), []);
	assert.equal(readFileSync(join(clone, "later.txt"), "utf8"), "written after the release\n");
});

test("a woken child follows only the well-formed restores its record holds (#4329)", async () => {
	const h = harness();
	const valid = restoreOf("/node-a/repo", join(h.cwd, "restored-for-the-launch"));
	const record = await withWorktreeRootMappings([valid], () => releasedChild(h, "wake-damaged"));
	const { restoredAt: _a, ...withoutRestoredAt } = restoreOf("/a", "/b");
	const { tree: _b, ...withoutTree } = restoreOf("/c", "/d");
	const { snapshotId: _c, ...withoutSnapshot } = restoreOf("/e", "/f");
	const { to: _d, ...withoutTo } = restoreOf("/g", "/h");
	const damaged = [
		valid,
		null,
		{ ...restoreOf("/i", "/j"), from: 42 },
		withoutTo,
		withoutSnapshot,
		withoutTree,
		withoutRestoredAt,
	] as unknown as SubagentChildRecord["worktreeRootMappings"];
	await appendRecord(h, { ...record, worktreeRootMappings: damaged });

	await restored(h, record.childId, { prompt: SUBAGENT_RELEASED_WAKE_PROMPT });

	assert.deepEqual(h.runs.at(-1)?.scope, [valid]);
});

test("a woken child whose record holds something other than a list of restores follows none (#4329)", async () => {
	const h = harness();
	const record = await withWorktreeRootMappings([restoreOf("/node-a/repo", "/node-b/repo")], () =>
		releasedChild(h, "wake-not-a-list"),
	);
	await appendRecord(h, {
		...record,
		worktreeRootMappings: "oops" as unknown as SubagentChildRecord["worktreeRootMappings"],
	});

	await restored(h, record.childId, { prompt: SUBAGENT_RELEASED_WAKE_PROMPT });

	assert.deepEqual(h.runs.at(-1)?.scope, []);
});

test("a child launched outside any restores records none, and one launched inside records exactly those (#4329)", async () => {
	const h = harness();
	const plain = await releasedChild(h, "launch-plain");
	assert.equal("worktreeRootMappings" in plain, false);
	const restore = restoreOf("/node-a/repo", "/node-b/repo");

	const scoped = await withWorktreeRootMappings([restore], () => releasedChild(h, "launch-scoped"));

	assert.deepEqual(scoped.worktreeRootMappings, [restore]);
});

test("a woken child whose agent is no longer defined is reported unrestorable, naming the agent (#4329)", async () => {
	const h = harness();
	const record = await releasedChild(h, "wake-agent-gone");
	await appendRecord(h, { ...record, agent: "ghost" });

	const outcome = await restoreSubagentChild(h.deps, h.ctx, record.childId, { prompt: "carry on" });

	assert.equal(outcome.kind, "unrestorable");
	assert.equal(outcome.kind === "unrestorable" ? outcome.reason : "", 'agent "ghost" (project) is no longer defined');
});

test("a woken child recorded without its agent's source names only the agent when it is no longer defined (#4329)", async () => {
	const h = harness();
	const record = await releasedChild(h, "wake-agent-gone-no-source");
	await appendRecord(h, { ...record, agent: "ghost", agentSource: undefined });

	const outcome = await restoreSubagentChild(h.deps, h.ctx, record.childId, { prompt: "carry on" });

	assert.equal(outcome.kind === "unrestorable" ? outcome.reason : "", 'agent "ghost" is no longer defined');
});

test("a child that never started and whose directory is gone here is reported unrestorable, naming the directory (#4329)", async () => {
	const h = harness();
	const record = await releasedChild(h, "wake-never-started");
	const gone = join(h.cwd, "no-such-directory");
	await appendRecord(h, {
		...record,
		cwd: gone,
		childSessionId: undefined,
		childSessionFile: undefined,
		launch: { task: ORIGINAL_TASK },
	});

	const outcome = await restoreSubagentChild(h.deps, h.ctx, record.childId, { prompt: "carry on" });

	assert.equal(outcome.kind, "unrestorable");
	assert.equal(
		outcome.kind === "unrestorable" ? outcome.reason : "",
		`its working directory no longer exists: ${gone}`,
	);
});

/**
 * Wake a released child waiting on ci-1 with ci-1's result, as the wake handler does: the result is held in its record
 * first, then the child is relaunched. Its woken run stays open at `at` until the returned gate is resolved.
 */
async function wokenByResult(
	h: Harness,
	runId: string,
	result: DetachedToolResult,
	at: "before-start" | "before-save" | "after-save",
): Promise<{ record: SubagentChildRecord; gate: PromiseWithResolvers<void>; held: Promise<void> }> {
	const record = await releasedChild(h, runId);
	await endSessionOnPendingCall(record, h.releasedWaits);
	await recordSubagentChildHeldToolResults(h.deps.pi, record.owner.sessionId, record.childId, [result]);
	const gate = Promise.withResolvers<void>();
	const held = Promise.withResolvers<void>();
	h.wokenGate = { gate, at, held };
	const outcome = await restoreSubagentChild(h.deps, h.ctx, record.childId, {
		prompt: SUBAGENT_RELEASED_WAKE_PROMPT,
		toolResults: [result],
		promptless: true,
	});
	assert.equal(outcome.kind, "restored", JSON.stringify(outcome));
	assert.ok(outcome.kind === "restored");
	await h.waitForLatest(record.childId, (latest) => latest.state === "running" && latest.taskId === outcome.taskId);
	return { record, gate, held: held.promise };
}

/** Stop the child with `action`, then resume it and let the resumed run finish. */
async function stopThenResume(h: Harness, childId: string, action: "pause" | "quit"): Promise<void> {
	await h.call({ action, id: childId });
	await h.waitForLatest(childId, (latest) => latest.terminalStatus === (action === "pause" ? "paused" : "quit"));
	h.wokenGate = undefined;
	const runsBefore = h.runs.length;
	await h.call({ action: "resume", id: childId });
	await h.waitForLatest(childId, (latest) => h.runs.length > runsBefore && latest.terminalStatus === "ok");
}

function savedCopies(h: Harness, output: string): number {
	return h.saved.filter((saved) => text({ content: saved.result.content } as SubagentToolResult) === output).length;
}

for (const action of ["pause", "quit"] as const)
	test(`a woken child ${action === "pause" ? "paused" : "quit"} before it saved its wake's result receives that result exactly once when resumed (#5012)`, async () => {
		const h = harness();
		const output = `CI is green (${action})`;
		const { record } = await wokenByResult(h, `wake-${action}-unsaved`, waitResult(output), "before-save");

		await stopThenResume(h, record.childId, action);

		assert.equal(savedCopies(h, output), 1, "the result reaches the child's transcript once, through its resume");
		assert.deepEqual(
			h.latest(record.childId)?.heldToolResults ?? [],
			[],
			"nothing is left held once it was delivered",
		);
	});

test("a woken child paused after it saved its wake's result is not given that result again when resumed (#5012)", async () => {
	const h = harness();
	const output = "CI is green (saved)";
	const { record } = await wokenByResult(h, "wake-pause-saved", waitResult(output), "after-save");

	await stopThenResume(h, record.childId, "pause");

	assert.equal(savedCopies(h, output), 1, "the result saved before the pause is not delivered again");
	const resumed = h.runs.at(-1);
	assert.ok(resumed);
	assert.doesNotMatch(
		JSON.stringify([resumed.task, resumed.options.resumeFollowUps, resumed.options.resumeToolResults]),
		/CI is green \(saved\)/,
	);
});

const DEPLOY_CALL = { toolCallId: "deploy-2", toolName: "wait_for_deploy" } as const;
const LINT_CALL = { toolCallId: "lint-3", toolName: "wait_for_lint" } as const;

function interruptedDeploy(): DetachedToolResult {
	return {
		...DEPLOY_CALL,
		result: { content: [{ type: "text", text: SUBAGENT_INTERRUPTED_BY_RESTART_RESULT }], details: undefined },
		isError: true,
	};
}

/** A released child waiting on ci-1 and deploy-2 is woken by ci-1's result alone: deploy-2 is told "still running". */
async function wokenWhileDeployRuns(
	h: Harness,
	runId: string,
	at: "before-save" | "after-save",
): Promise<{
	record: SubagentChildRecord;
	gate: PromiseWithResolvers<void>;
	held: Promise<void>;
	woken: RunSyncOptions;
}> {
	h.releasedWaits = [WAIT_CALL, DEPLOY_CALL];
	const woke = await wokenByResult(h, runId, waitResult("ci-1 green"), at);
	const woken = h.runs.at(-1)?.options;
	assert.ok(woken);
	assert.deepEqual(
		woken.resumeToolResults?.map((result) => [
			result.toolCallId,
			text({ content: result.result.content } as SubagentToolResult),
		]),
		[
			["ci-1", "ci-1 green"],
			["deploy-2", SUBAGENT_STILL_RUNNING_RESULT],
		],
	);
	return { ...woke, woken };
}

/** Write what a woken run saves: its results, as its session's resumeDetachedTurn does. */
async function saveIntoTranscript(record: SubagentChildRecord, results: readonly DetachedToolResult[]): Promise<void> {
	assert.ok(record.childSessionFile);
	const session = await SessionManager.open(record.childSessionFile, undefined, record.cwd);
	for (const result of results)
		await session.appendMessage({
			role: "toolResult",
			toolCallId: result.toolCallId,
			toolName: result.toolName,
			content: result.result.content,
			isError: result.isError,
			timestamp: Date.now(),
		} as Parameters<SessionManager["appendMessage"]>[0]);
}

/** Atomic restarts: the child's records were written by an earlier owner process, whose detached calls died with it. */
async function restartOwner(h: Harness, childId: string, whileClosed?: () => Promise<void>): Promise<void> {
	await h.closeOwnerAndReopen("session-close");
	// What its sessions wrote before the restart, written once nothing of the earlier process has them open.
	await whileClosed?.();
	const latest = await h.waitForLatest(childId, (record) => record.childSessionFile !== undefined);
	const earlier: SubagentChildRecord = {
		...latest,
		ownerGeneration: "earlier-process",
		...(latest.stillRunning
			? { stillRunning: latest.stillRunning.map((call) => ({ ...call, ownerGeneration: "earlier-process" })) }
			: {}),
	};
	await appendRecord(h, earlier);
	observeSubagentChildRecord(earlier);
}

/** How many times the child's runs were given `message`, as their task or a follow-up. */
function toldTimes(h: Harness, message: string): number {
	return h.runs.filter((run) => run.task === message || run.options.resumeFollowUps?.includes(message)).length;
}

function told(run: RunSyncOptions & { task: string }): string {
	return JSON.stringify([run.task, run.resumeFollowUps, run.resumeToolResults]);
}

test("a call a wake answered still running is reported interrupted when Atomic restarts before the woken child saved its results (#5014)", async () => {
	const h = harness();
	const { record } = await wokenWhileDeployRuns(h, "still-running-unsaved", "before-save");

	await restartOwner(h, record.childId);
	h.wokenGate = undefined;
	const [outcome] = await restoreSubagentChildren(h.deps, h.ctx);
	assert.equal(outcome?.kind, "restored", JSON.stringify(outcome));
	const run = h.runs.at(-1);
	assert.ok(run);

	assert.deepEqual(run.options.resumeToolResults, [waitResult("ci-1 green"), interruptedDeploy()]);
	assert.deepEqual(run.options.stillRunning, [], "deploy-2 is no longer tracked once it is reported interrupted");
});

test("a woken run that waits as long as it likes before saving its results has written nothing the restore reads as an answer (#5014)", async () => {
	const h = harness();
	const { record, held } = await wokenWhileDeployRuns(h, "still-running-waits", "before-save");
	// Under load the restart came after the woken run's session had started: wait for the run to wait, then restart.
	await held;
	assert.ok(record.childSessionFile);
	const transcript = (
		await SessionManager.open(record.childSessionFile, undefined, record.cwd)
	).buildSessionProjection().messages;
	assert.equal(transcript.at(-1)?.role, "assistant", "a promptless wake writes nothing before the results it saves");

	await restartOwner(h, record.childId);
	h.wokenGate = undefined;
	const [outcome] = await restoreSubagentChildren(h.deps, h.ctx);
	assert.equal(outcome?.kind, "restored", JSON.stringify(outcome));
	const run = h.runs.at(-1);
	assert.ok(run);

	assert.deepEqual(run.options.resumeToolResults, [waitResult("ci-1 green"), interruptedDeploy()]);
	assert.deepEqual(run.options.stillRunning, [], "deploy-2 is no longer tracked once it is reported interrupted");
});

test("a call a wake answered still running is reported interrupted when Atomic restarts after the woken child saved its results (#5014)", async () => {
	const h = harness();
	const { record, woken } = await wokenWhileDeployRuns(h, "still-running-saved", "after-save");

	await restartOwner(h, record.childId, () => saveIntoTranscript(record, woken.resumeToolResults ?? []));
	h.wokenGate = undefined;
	const [outcome] = await restoreSubagentChildren(h.deps, h.ctx);
	assert.equal(outcome?.kind, "restored", JSON.stringify(outcome));
	const run = h.runs.at(-1);
	assert.ok(run);

	assert.equal(
		run.task,
		lateToolResultMessage(interruptedDeploy()),
		"the restored child reads first that deploy-2 died with the restart",
	);
	assert.equal(toldTimes(h, lateToolResultMessage(interruptedDeploy())), 1);
	assert.doesNotMatch(
		told({ ...run.options, task: run.task }),
		/ci-1 green/,
		"ci-1's saved result is not given again",
	);
});

test("a call a wake answered still running is reported interrupted after a restart even when the child was released again for another call (#5014)", async () => {
	const h = harness();
	h.wokenReleasedOn = [LINT_CALL];
	const { record, gate, woken } = await wokenWhileDeployRuns(h, "still-running-rereleased", "after-save");
	gate.resolve();
	const released = await h.waitForLatest(
		record.childId,
		(latest) =>
			latest.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS && latest.waitingOn?.[0]?.toolCallId === "lint-3",
	);
	h.wokenReleasedOn = undefined;
	h.wokenGate = undefined;

	await restartOwner(h, record.childId, async () => {
		await saveIntoTranscript(record, woken.resumeToolResults ?? []);
		await endSessionOnPendingCall(released, [LINT_CALL]);
	});
	const lint: DetachedToolResult = { ...waitResult("lint clean"), ...LINT_CALL };
	const run = await restored(h, record.childId, {
		prompt: SUBAGENT_RELEASED_WAKE_PROMPT,
		toolResults: [lint],
		promptless: true,
	});

	assert.deepEqual(run.resumeToolResults, [lint]);
	assert.equal(run.task, lateToolResultMessage(interruptedDeploy()));
	assert.equal(toldTimes(h, lateToolResultMessage(interruptedDeploy())), 1);
});

test("a child that finished after a wake told it a call is still running is woken after a restart to learn the call was interrupted (#5014)", async () => {
	const h = harness();
	const { record, gate, woken } = await wokenWhileDeployRuns(h, "still-running-finished", "after-save");
	gate.resolve();
	await h.waitForLatest(record.childId, (latest) => latest.state === "terminal" && latest.terminalStatus === "ok");
	h.wokenGate = undefined;
	await restartOwner(h, record.childId, () => saveIntoTranscript(record, woken.resumeToolResults ?? []));

	const dispatcher = agentWakeDispatcher();
	const stop = bindReleasedChildWakes(h.deps, h.ctx, h.deps.pi.events, dispatcher);
	cleanups.push(async () => stop());
	const interrupted = lateToolResultMessage(interruptedDeploy());
	const done = await h.waitForLatest(
		record.childId,
		(latest) => toldTimes(h, interrupted) > 0 && latest.state === "terminal" && latest.terminalStatus === "ok",
	);
	await dispatcher.whenIdle();

	assert.equal(toldTimes(h, interrupted), 1);
	assert.deepEqual(done.heldToolResults ?? [], [], "nothing is left held once the child was told");
	assert.deepEqual(done.stillRunning ?? [], [], "the interrupted call is no longer tracked as running");
});

test("a woken child whose run saved its results and then lost its owner is not given them again when restored (#5012)", async () => {
	const h = harness();
	const result = waitResult("ci-1 green: run /deploy now");
	const { record } = await wokenByResult(h, "saved-then-closed", result, "before-save");
	// Its session saved the result, and Atomic closed while the turn it continued still ran.
	await h.closeOwnerAndReopen("session-close");
	await saveIntoTranscript(record, [result]);
	await h.waitForLatest(record.childId, (latest) => latest.state === "running");
	h.wokenGate = undefined;

	const [outcome] = await restoreSubagentChildren(h.deps, h.ctx);
	assert.equal(outcome?.kind, "restored", JSON.stringify(outcome));
	const run = h.runs.at(-1);
	assert.ok(run);

	assert.doesNotMatch(told({ ...run.options, task: run.task }), /run \/deploy now/);
	assert.deepEqual(h.latest(record.childId)?.heldToolResults ?? [], [], "nothing already delivered stays held");
});

test("a woken child whose run saved its results and then failed is not given them again by its next wake (#5012)", async () => {
	const h = harness();
	h.wokenFails = true;
	const result = waitResult("ci-1 green: run /deploy now");
	const { record, gate } = await wokenByResult(h, "saved-then-failed", result, "before-save");
	gate.resolve();
	const failed = await h.waitForLatest(record.childId, (latest) => latest.terminalStatus === "error");
	assert.ok(failed.taskId);
	await settled(h, failed.taskId);
	// It had saved the result before it failed.
	await saveIntoTranscript(record, [result]);
	h.wokenFails = undefined;
	h.wokenGate = undefined;

	const run = await restored(h, record.childId, { prompt: "a new message", message: "a new message" });

	assert.doesNotMatch(told(run), /run \/deploy now/);
	assert.deepEqual(h.latest(record.childId)?.heldToolResults ?? [], []);
});

test("a result for a call the child was told is still running still reaches it, as a message (#5012)", async () => {
	const h = harness();
	const record = await endedOnPendingCall(h, "late-after-still-running");
	await saveIntoTranscript(record, [stillRunning]);
	const late = waitResult("/deploy now");

	const run = await restored(h, record.childId, {
		prompt: SUBAGENT_RELEASED_WAKE_PROMPT,
		toolResults: [late],
		promptless: true,
	});

	assert.equal(run.task, lateToolResultMessage(late));
});

test("a late result the child already read as a message is not given to it again (#5012)", async () => {
	const h = harness();
	const record = await endedOnPendingCall(h, "late-already-read");
	await saveIntoTranscript(record, [stillRunning]);
	const late = waitResult("/deploy now");
	assert.ok(record.childSessionFile);
	const session = await SessionManager.open(record.childSessionFile, undefined, record.cwd);
	await session.appendMessage({ role: "user", content: lateToolResultMessage(late), timestamp: Date.now() });
	await recordSubagentChildHeldToolResults(h.deps.pi, record.owner.sessionId, record.childId, [late]);

	const run = await restored(h, record.childId, { prompt: "a new message", message: "a new message" });

	assert.doesNotMatch(told(run), /deploy now/);
	assert.deepEqual(h.latest(record.childId)?.heldToolResults ?? [], []);
});

test("a restart turns only the calls an earlier owner process told still running into held interrupted results, keeping any real result (#5014)", async () => {
	const h = harness();
	const record = await releasedChild(h, "convert-still-running");
	const current = { toolCallId: "build-4", toolName: "wait_for_build", ownerGeneration: "this-process" };
	const lint: DetachedToolResult = { ...waitResult("lint clean"), ...LINT_CALL };
	const marked: SubagentChildRecord = {
		...record,
		heldToolResults: [lint],
		stillRunning: [
			{ ...DEPLOY_CALL, ownerGeneration: "earlier-process" },
			{ ...LINT_CALL, ownerGeneration: "earlier-process" },
			current,
		],
	};
	await appendRecord(h, marked);
	observeSubagentChildRecord(marked);

	const held = await holdInterruptedStillRunningCalls(
		h.deps.pi,
		record.owner.sessionId,
		record.childId,
		"this-process",
		interruptedStillRunningResult,
	);

	assert.deepEqual(held?.heldToolResults, [lint, interruptedDeploy()]);
	assert.deepEqual(held?.stillRunning, [current]);
	assert.equal(
		await holdInterruptedStillRunningCalls(
			h.deps.pi,
			record.owner.sessionId,
			record.childId,
			"this-process",
			interruptedStillRunningResult,
		),
		undefined,
		"nothing is written once nothing is left to report",
	);
});

test("a wake keeps tracking the calls the child was told are still running until their results reach it (#5014)", async () => {
	const h = harness();
	const record = await releasedChild(h, "track-still-running");
	await endSessionOnPendingCall(record, [WAIT_CALL, LINT_CALL]);
	const build = { toolCallId: "build-4", toolName: "wait_for_build" } as const;
	const tracked: SubagentChildRecord = {
		...record,
		// lint-3 was told so before too: its call is still pending, so this wake tells it again.
		stillRunning: [
			{ ...DEPLOY_CALL, ownerGeneration: SUBAGENT_OWNER_GENERATION },
			{ ...LINT_CALL, ownerGeneration: SUBAGENT_OWNER_GENERATION },
			{ ...build, ownerGeneration: SUBAGENT_OWNER_GENERATION },
		],
	};
	await appendRecord(h, tracked);
	observeSubagentChildRecord(tracked);
	const deployed: DetachedToolResult = { ...waitResult("deployed"), ...DEPLOY_CALL };

	const run = await restored(h, record.childId, {
		prompt: SUBAGENT_RELEASED_WAKE_PROMPT,
		toolResults: [waitResult("ci-1 green"), deployed],
		promptless: true,
	});

	assert.deepEqual(run.stillRunning, [
		{ ...build, ownerGeneration: SUBAGENT_OWNER_GENERATION },
		{ ...LINT_CALL, ownerGeneration: SUBAGENT_OWNER_GENERATION },
	]);
	assert.deepEqual(h.latest(record.childId)?.stillRunning, run.stillRunning);
});

test("a late result a woken child was stopped before reading reaches it once when resumed (#5012)", async () => {
	const h = harness();
	const record = await releasedChild(h, "late-unread");
	await endSessionOnPendingCall(record);
	await saveIntoTranscript(record, [stillRunning]);
	const late = waitResult("/deploy now");
	await recordSubagentChildHeldToolResults(h.deps.pi, record.owner.sessionId, record.childId, [late]);
	h.wokenGate = { gate: Promise.withResolvers<void>(), at: "before-start" };
	const outcome = await restoreSubagentChild(h.deps, h.ctx, record.childId, {
		prompt: SUBAGENT_RELEASED_WAKE_PROMPT,
		toolResults: [late],
		promptless: true,
	});
	assert.equal(outcome.kind, "restored", JSON.stringify(outcome));
	assert.ok(outcome.kind === "restored");
	await h.waitForLatest(record.childId, (latest) => latest.state === "running" && latest.taskId === outcome.taskId);

	await stopThenResume(h, record.childId, "pause");

	const run = h.runs.at(-1);
	assert.ok(run);
	const message = lateToolResultMessage(late);
	assert.equal(told({ ...run.options, task: run.task }).split(JSON.stringify(message).slice(1, -1)).length - 1, 1);
});

for (const saved of [false, true])
	test(`a still-running call is reported interrupted once when the owner's wakes are bound as its child is restored, ${saved ? "after" : "before"} the woken child saved its results (#5014)`, async () => {
		const h = harness();
		const { record, woken } = await wokenWhileDeployRuns(
			h,
			`still-running-bound-${saved}`,
			saved ? "after-save" : "before-save",
		);
		await restartOwner(h, record.childId, async () => {
			if (saved) await saveIntoTranscript(record, woken.resumeToolResults ?? []);
		});
		h.wokenGate = undefined;

		// Starting up binds the owner's wakes, which report the call, while its restore reads the child's record.
		const dispatcher = agentWakeDispatcher();
		const stop = bindReleasedChildWakes(h.deps, h.ctx, h.deps.pi.events, dispatcher);
		cleanups.push(async () => stop());
		const [outcome] = await restoreSubagentChildren(h.deps, h.ctx);
		assert.equal(outcome?.kind, "restored", JSON.stringify(outcome));
		assert.ok(outcome?.kind === "restored");
		await settled(h, outcome.taskId);
		await dispatcher.whenIdle();
		const run = h.runs.at(-1);
		assert.ok(run);

		if (saved) assert.equal(run.task, lateToolResultMessage(interruptedDeploy()));
		else assert.deepEqual(run.options.resumeToolResults, [waitResult("ci-1 green"), interruptedDeploy()]);
		assert.equal(
			h.runs.filter((item) =>
				told({ ...item.options, task: item.task }).includes("interrupted when Atomic restarted"),
			).length,
			1,
			"told once",
		);
	});
