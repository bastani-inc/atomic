import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DetachedToolCall, ExtensionContext } from "@bastani/atomic";
import { vi } from "vitest";
import type { AgentWakeDispatcher } from "../../packages/coding-agent/src/core/agent-wake-dispatcher.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type { TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import {
	formatReleasedReply,
	RELEASED_REPLY_FORMAT_EVENT,
	type ReleasedReplyFormatRequest,
} from "../../packages/intercom/released-reply-format.js";
import type { AgentConfig, AgentScope } from "../../packages/subagents/src/agents/agents.js";
import { SUBAGENT_SUPERVISOR_AUTHORIZATION_EVENT } from "../../packages/subagents/src/intercom/supervisor-authorization.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import { lateToolResultText } from "../../packages/subagents/src/runs/foreground/late-tool-result-notice.js";
import {
	type ReleasedChildReservation,
	SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT,
	SUBAGENT_DROP_RELEASED_CHILDREN_EVENT,
	SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT,
} from "../../packages/subagents/src/runs/foreground/released-child-reservations.js";
import {
	currentChildWorktreeNote,
	finishingWorktreeStatus,
} from "../../packages/subagents/src/runs/foreground/run-worktrees.js";
import {
	createSubagentChildRecordSink,
	readSubagentChildRecords,
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
import { runAgentTask } from "../../packages/subagents/src/runs/foreground/task-execution.js";
import {
	type RunSyncOptions,
	type SingleResult,
	SUBAGENT_COMPLETE_EVENT,
	type SubagentToolResult,
	type TestSessionQueue,
} from "../../packages/subagents/src/shared/types.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";

export const ORIGINAL_TASK = "original task";

/** The detached call a released child waits on in these tests. */
export const RELEASED_CALL = { toolCallId: "ci-1", toolName: "wait_for_ci" } as const;

/**
 * How long a poll waits for a child's record or worktree to reach a state. Each step behind it is a real in-process
 * child session starting, reopening or ending, which took over 15 s on Windows with two suites running at once. The
 * polls end as soon as the state is reached, so the ceiling costs a passing test nothing.
 */
export const RECORD_WAIT_MS = 20_000;

/** A launch, a quit and a resume of a real in-process child session, each awaited through {@link RECORD_WAIT_MS}. */
export const LAUNCH_QUIT_RESUME_TIMEOUT_MS = 3 * RECORD_WAIT_MS;

export const agent: AgentConfig = {
	name: "worker",
	description: "worker",
	source: "project",
	filePath: "worker.md",
	systemPrompt: "Work",
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
};

export interface Harness {
	readonly cwd: string;
	host: AgentTaskHost;
	readonly deps: ExecutorDeps;
	/** Close the owner's tasks as Atomic exiting, or switching sessions does, then reopen it. */
	closeOwnerAndReopen(cause: "session-close"): Promise<void>;
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
	/** The hold of each starting child, as its capability and how long it holds sends. */
	readonly startHolds: Array<{ readonly reserve: string; readonly holdMs: number }>;
	readonly holds: Array<{ reserve: string; aliases: readonly string[] } | { release: string; gone?: string }>;
	/** How the next child run settles once its prompt runs; the original launch always waits until stopped. */
	settleAs: "ok" | "error";
	/** Whether the original launch completes normally when it is stopped, as a child finishing just before the stop does. */
	completesWhenStopped: boolean;
	/** Whether resumed runs also wait until stopped, instead of settling once their prompt runs. */
	resumedRunsWait: boolean;
	/** Whether the original launch ends released, waiting on a detached `wait_for_ci` call (#4326). */
	releaseOriginal: boolean;
	/** Runs whose prompt contains one of these also end released, waiting on the same call. */
	readonly releaseOn: Set<string>;
	/** The task heartbeat cadence `admit` launches with; omitted uses the owner default. */
	launchHeartbeatMs?: number;
	/** The still-running calls a stubbed released outcome hands back, and the dispatcher their results wake through. */
	releasedCalls: DetachedToolCall[];
	wakeDispatcher?: AgentWakeDispatcher;
	/** When set, a stubbed released outcome is returned only once this settles. */
	releaseGate?: PromiseWithResolvers<void>;
	releasedPendingMessages?: string[];
	disposeGate?: PromiseWithResolvers<void>;
	readonly notices: Array<Record<string, string | number>>;
	readonly firstNotice: Promise<void>;
	redispatchCalls: DetachedToolCall[];
	redispatchGate?: PromiseWithResolvers<void>;
	readonly redispatching: { active: number; most: number };
	/** Receives each child run's stub session, to queue steering and follow-up messages as an SDK caller does. */
	onSession?: (session: TestSessionQueue) => void;
	/** Whether the worker agent is still defined; resume looks it up again. */
	agentDefined: boolean;
	/** When set, looking up agents fails with it, as agent definitions that cannot be read do. */
	agentDiscoveryError?: Error;
	/** The agent definitions discovery finds, from every source; a project agent shadows a user one of its name. */
	agents: AgentConfig[];
	/** Runs whose prompt contains a key wait until its gate resolves, then complete; checked before the rules above. */
	readonly finishOn: Map<string, PromiseWithResolvers<void>>;
	/** Runs whose prompt contains a key ignore a stop until its gate resolves, as a child stuck in a tool call does. */
	readonly stuckOn: Map<string, PromiseWithResolvers<void>>;
	/** Runs that read this marker fail: their execution throws. */
	readonly throwOn: Set<string>;
	/** Call the subagent tool as the parent's model does, in a turn that `signal`, when given, interrupts. */
	call(
		params: Parameters<ReturnType<typeof createSubagentExecutor>["execute"]>[1],
		signal?: AbortSignal,
	): Promise<SubagentToolResult>;
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

export const cleanups: Array<() => Promise<void>> = [];

export async function runCleanups(): Promise<void> {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}

function newHost(): AgentTaskHost {
	return new AgentTaskHost({
		scope: { kind: "session", sessionId: `run-control-${randomUUID()}` },
		authorizeLaunch() {},
	});
}

export function harness(options: { ownerless?: boolean; answer?: (task: string) => string } = {}): Harness {
	const answer = options.answer;
	const cwd = makeTempDirectory("subagent-run-control-");
	let host = newHost();
	const sessionManager = SessionManager.inMemory(cwd);
	let ownerLifetime = new AbortController();
	const runs: Harness["runs"] = [];
	const authorizations: string[] = [];
	const holds: Harness["holds"] = [];
	const startHolds: Harness["startHolds"] = [];
	const releasedChildRequests: Harness["releasedChildRequests"] = [];
	const notices: Harness["notices"] = [];
	const firstNotice = Promise.withResolvers<void>();
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
				if (request.holdMs !== undefined) startHolds.push({ reserve: request.capability, holdMs: request.holdMs });
				// A launch holds sends to its starting child until it registers; run control's holds are the subject here.
				if (request.holdMs === undefined || request.aliases.length > 0)
					holds.push({
						reserve: request.capability,
						aliases: request.aliases,
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
			if (channel === SUBAGENT_COMPLETE_EVENT) {
				notices.push(data as Record<string, string | number>);
				firstNotice.resolve();
			}
			if (channel === SUBAGENT_RELEASE_RESTORING_CHILD_EVENT) {
				const request = data as SubagentReleaseRestoringChildRequest;
				holds.push({ release: request.capability, ...(request.gone === undefined ? {} : { gone: request.gone }) });
				request.completion = Promise.resolve();
			}
		},
	};
	const atomic = {
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
			modelRegistry: { getAvailable: () => [], getAll: () => [], find: () => undefined },
			model: undefined,
			thinkingLevel: undefined,
		} as unknown as ExtensionContext,
		runs,
		authorizations,
		releasedChildRequests,
		holds,
		startHolds,
		settleAs: "ok",
		completesWhenStopped: false,
		resumedRunsWait: false,
		releaseOriginal: false,
		releaseOn: new Set(),
		releasedCalls: [],
		notices,
		firstNotice: firstNotice.promise,
		redispatchCalls: [],
		redispatching: { active: 0, most: 0 },
		agentDefined: true,
		agents: [agent],
		finishOn: new Map(),
		stuckOn: new Map(),
		throwOn: new Set(),
		call: (params, signal = new AbortController().signal) =>
			executor.execute("run-control", params, signal, undefined, state.ctx),
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
				recordChild: createSubagentChildRecordSink(atomic, state.ctx),
				runtime: { runSync: runtime },
				...(state.launchHeartbeatMs === undefined ? {} : { heartbeatMs: state.launchHeartbeatMs }),
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
		const reads = readsOf({ task, options });
		await [...state.stuckOn].find(([marker]) => reads.includes(marker))?.[1].promise;
		const failure = [...state.throwOn].find((marker) => reads.includes(marker));
		if (failure !== undefined) throw new Error(`run failed on ${failure}`);
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
		if (original ? state.releaseOriginal : [...state.releaseOn].some((marker) => reads.includes(marker))) {
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
		const gate = [...state.finishOn].find(([marker]) => reads.includes(marker))?.[1];
		// The scripted session saves the tool results a woken or resumed run carries before its prompt gate, as a real
		// session saves them before it continues their turn, so that gate cannot hold such a run before it saved them: a
		// gated one waits before it starts instead, where it has saved none of them, until its gate opens or it is stopped
		// (#5012).
		if (gate && options.resumeToolResults?.length) await openedOrStopped(gate.promise, options.signal);
		const onSession = state.onSession ? { onSession: state.onSession } : {};
		const disposeGate = state.disposeGate;
		const dispose = gate && disposeGate ? { dispose: () => disposeGate.promise } : {};
		const result = await runSync(parentCwd, agents, agentName, task, {
			...options,
			testSession: gate
				? {
						output: answer?.(task) ?? "finished",
						promptGate: gate.promise,
						abortResolvesPrompt: true,
						...onSession,
						...dispose,
					}
				: original || state.resumedRunsWait
					? { output: "partial", promptGate: neverReleased.promise, abortResolvesPrompt: true, ...onSession }
					: { output: "resumed", ...onSession },
		});
		if (original && state.completesWhenStopped && result.interrupted)
			return { ...result, status: "ok", interrupted: false, pendingMessages: undefined };
		return !original && state.settleAs === "error" ? { ...result, status: "error", error: "boom" } : result;
	};
	const deps: ExecutorDeps = {
		pi: atomic,
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
		discoverAgents: (_cwd, scope) => {
			if (state.agentDiscoveryError) throw state.agentDiscoveryError;
			return { agents: state.agentDefined ? discoverInScope(state.agents, scope) : [] };
		},
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

/** Settles once `gate` opens or `signal` aborts, as a run's stop aborts it. */
function openedOrStopped(gate: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		signal?.addEventListener("abort", () => resolve(), { once: true });
		void gate.then(resolve);
	});
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

export function text(result: SubagentToolResult): string {
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

export function extractRunningTaskId(message: string): string | undefined {
	const prefix = "already running as task ";
	let searchFrom = 0;
	while (searchFrom < message.length) {
		const start = message.indexOf(prefix, searchFrom);
		if (start === -1) return undefined;
		const idStart = start + prefix.length;
		const end = message.indexOf(";", idStart);
		if (end === -1) return undefined;
		if (end > idStart) return message.slice(idStart, end);
		searchFrom = end + 1;
	}
	return undefined;
}

export function occurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

export async function settled(h: Harness, taskId: string): Promise<void> {
	const observed = await h.host.waitForTask(taskId as TaskId);
	assert.ok(observed.ok && observed.value.kind === "settled", JSON.stringify(observed));
}

export function resumedTaskId(result: SubagentToolResult): string {
	const taskId = result.details.runControl?.children[0]?.taskId;
	assert.ok(taskId, text(result));
	return taskId;
}

export function initGitRepository(root: string): void {
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

const execFileAsync = promisify(execFile);

const WORKTREE_CLEANUP_POLL_MS = 25;

export function gitOutput(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim();
}

async function gitOutputAsync(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", windowsHide: true });
	return stdout.trim();
}

export async function launchWorktreeRun(
	h: Harness,
	markers: readonly string[],
	extra: { concurrency?: number } = {},
): Promise<SubagentChildRecord[]> {
	const launched = await h.call({
		tasks: markers.map((marker) => ({ agent: "worker", task: marker })),
		worktree: true,
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

/**
 * Wait for the in-process worktree sweep to settle, then verify asynchronously that Git removed the branch.
 * Polling with synchronous `gitOutput` inside `vi.waitFor` blocks the same event loop that drives the sweep,
 * and returning as soon as the branch ref disappears can race the exiting `git branch -D` process on Windows.
 */
export async function waitForWorktreeCleanup(h: Harness, child: SubagentChildRecord): Promise<void> {
	const branch = child.worktree?.branch;
	assert.ok(branch, "the child record names its worktree branch");
	await vi.waitFor(
		async () => {
			assert.equal(currentChildWorktreeNote(child.runId, child.index), undefined);
			assert.equal(finishingWorktreeStatus(child), undefined);
			assert.equal(await gitOutputAsync(h.cwd, ["branch", "--list", branch]), "");
		},
		{
			timeout: RECORD_WAIT_MS,
			interval: WORKTREE_CLEANUP_POLL_MS,
		},
	);
}

export function savedPatches(record: SubagentChildRecord): string[] {
	const diffsDir = record.worktree?.diffsDir;
	assert.ok(diffsDir, "the child record names where its run saves its patches");
	if (!existsSync(diffsDir)) return [];
	return readdirSync(diffsDir)
		.filter((file) => new RegExp(`^task-${record.index}-worker(\\.\\d+)?\\.patch$`).test(file))
		.map((file) => join(diffsDir, file))
		.sort();
}

// A successful clean filter that waits for the test to release it, once, before copying stdin to stdout.
export function holdGitFilter(cwd: string, pattern: string) {
	const marker = join(cwd, ".git", "filter-started").replaceAll("\\", "/");
	const release = join(cwd, ".git", "filter-release").replaceAll("\\", "/");
	writeFileSync(join(cwd, ".git", "info", "attributes"), `${pattern} filter=hold\n`);
	gitOutput(cwd, [
		"config",
		"filter.hold.clean",
		`printf '%s' "$ATOMIC_SUBAGENT_WORKTREE_PHASE" > '${marker}'; while ! test -f '${release}'; do sleep 0.1; done; cat`,
	]);
	return {
		started: () => vi.waitFor(() => assert.ok(existsSync(marker)), { timeout: RECORD_WAIT_MS, interval: 10 }),
		phase: () => readFileSync(marker, "utf8"),
		release: () => writeFileSync(release, "release"),
	};
}

/** What a run gives the child to read: its task, then the late results and notices it delivers with its turn. */
export function readsOf(run: { readonly task: string; readonly options: RunSyncOptions }): string {
	return [
		run.options.resumeNote?.text ?? "",
		run.task,
		...(run.options.resumeLateToolResults ?? []).map(lateToolResultText),
		...(run.options.resumeNotices ?? []).map((notice) => notice.content),
	].join("\n");
}

/** How long a resume of a running child may take to answer; a resume queued behind that child's run never does. */
const RESUME_ANSWER_MS = 5_000;

/** `call`'s result, or undefined when it has not answered within {@link RESUME_ANSWER_MS}. */
export async function answeredWithin<T>(call: Promise<T>): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			call,
			new Promise<undefined>((resolve) => {
				timer = setTimeout(() => resolve(undefined), RESUME_ANSWER_MS);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** Whether `promise` settles within {@link RESUME_ANSWER_MS}. */
export async function settlesWithin(promise: Promise<unknown>): Promise<boolean> {
	return (await answeredWithin(promise.then(() => ({}) as SubagentToolResult))) !== undefined;
}

export function taskExecutionKind(h: Harness, taskId: string): string | undefined {
	const watched = h.host.watchOwnerTasks();
	assert.ok(watched.ok);
	try {
		return watched.value.snapshot.tasks.find((task) => task.ref.taskId === taskId)?.execution.kind;
	} finally {
		watched.value.dispose();
	}
}

/** Run `during` when run control cancels `taskId`, before the cancel goes ahead: a sibling stopped first. */
export function duringCancelOf(h: Harness, taskId: string, during: () => Promise<void>): void {
	const cancel = h.host.cancelTask.bind(h.host);
	h.host.cancelTask = (async (id: TaskId, ...rest: unknown[]) => {
		if (String(id) === taskId) await during();
		return (cancel as (...args: unknown[]) => unknown)(id, ...rest);
	}) as typeof h.host.cancelTask;
}
