/**
 * #4319: a subagent launched from a top-level session starts within a bounded number of event-loop turns, so a main
 * thread that other work saturates slows its start in proportion to that count instead of exhausting its start
 * budget; and a start that does run out of budget fails with a SessionStartTimeoutError naming what blocked it. Real
 * in-process runner and AgentSession against a local provider; no network is contacted.
 */

import assert from "node:assert/strict";
import { AsyncLocalStorage, createHook, executionAsyncId } from "node:async_hooks";
import { pbkdf2, pbkdf2Sync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	getModel,
	type Model,
} from "@bastani/atomic-ai/compat";
import { afterEach, test, vi } from "vitest";
import { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import type { SubagentStartupHooks } from "../../packages/coding-agent/src/core/extensions/index.js";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import type { ResourceAdmission } from "../../packages/coding-agent/src/core/sdk-types.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import {
	AuthStorage,
	DefaultResourceLoader,
	isSessionStartConfigError,
	isSessionStartTimeoutError,
	ModelRuntime,
	rehydrateSessionStartError,
	type SessionStartTimeoutError,
} from "../../packages/coding-agent/src/index.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import { type AttemptOutcome, SubagentControlRuntime } from "../../packages/subagents/src/runs/inprocess/runner.js";
import {
	SATURATED_LOOP_TURN_MS,
	SESSION_START_MIN_LOOP_TURNS,
} from "../../packages/subagents/src/runs/inprocess/session-start-budget.js";
import {
	describeSubagentStart,
	type SubagentStartProgress,
} from "../../packages/subagents/src/runs/shared/start-progress.js";
import { createCandidateModelResolver } from "../../packages/subagents/src/shared/model-resolution.js";
import type { RunSyncOptions, SingleResult, TaskExecutionHooks } from "../../packages/subagents/src/shared/types.js";
import { sleep } from "../helpers/runtime.js";

/**
 * Structural cost, not a slow test: each case builds a real parent AgentSession and a real child AgentSession with
 * its resource loader and tool registry, some of them on a deliberately saturated main thread.
 */
const REAL_CHILD_SESSION_TIMEOUT_MS = 90_000;

/**
 * How long each saturated loop turn runs other work, as busy pooled roots on the same thread do. On an idle host every
 * fs request a start makes completes within the turn it waits through, so its turns are about its steps; a loaded host
 * holds requests for more turns, which adds turns but not steps.
 */
const SATURATED_TURN_MS = 20;
/**
 * The loop turns a child's steps take one after another from its launch to its first provider request, which is what a
 * saturated thread multiplies: 713 turns before #4319 (one fs read per header byte, two writes for the initial model
 * and thinking level) and 135 steps after it on this fixture, at any load. Independent ancestor probes run together
 * (#5514), so directory depth adds requests but not steps; the bound leaves room for changes to the start but not for a
 * per-byte or per-entry regression.
 */
const START_LOOP_TURN_BOUND = 200;
/**
 * How many directories below the fixture's own a nested child starts. A start that walks its parent directories one
 * request at a time takes a step for each of them; one that checks them together takes the same steps at any depth.
 * Fewer extra steps than levels tells the two apart: walking them one at a time adds about ten steps a level.
 */
const NESTED_CWD_LEVELS = 12;
/**
 * How long other work holds the thread pool a nested child's file-system requests run on, as a loaded host can: twice
 * the extra steps the depth comparison allows in saturated turns, so a count that took the turns the start waits for as
 * its own steps fails it.
 */
const HELD_THREAD_POOL_MS = 2 * NESTED_CWD_LEVELS * SATURATED_TURN_MS;
/** The fs requests a child's start makes up to its first provider request: 861 before #4319. */
const SYNCHRONOUS_CHECK_START_FS_OPERATION_BOUND = 200;
/**
 * The checks a child's start used to make synchronously, which the count did not see, now made as fs requests: 116
 * counted before and 300 after on this fixture.
 */
const ASYNCHRONOUS_CHECK_FS_OPERATIONS = 300 - 116;
const START_FS_OPERATION_BOUND = SYNCHRONOUS_CHECK_START_FS_OPERATION_BOUND + ASYNCHRONOUS_CHECK_FS_OPERATIONS;

/**
 * The start budget of a child launched against an injected stall. It runs only once the child reaches its stall (see
 * {@link holdStartBudget}), so however long a loaded host takes to bring the child there, the budget runs out while
 * the stall holds it.
 */
const STALL_START_BUDGET_MS = 2_500;
/** How long an injected stall holds its step: past the start budget, then released so cleanup completes. */
const STALL_MS = 2 * STALL_START_BUDGET_MS;
/**
 * How early a timer may fire as `performance.now()` measures it: libuv schedules timers against a millisecond loop
 * clock it reads once per loop turn.
 */
const TIMER_GRANULARITY_MS = 2;
/** How long a busy permit store keeps a child waiting for its permit before granting it. */
const ADMISSION_DELAY_MS = 300;
/** A saturated loop turn the start budget's probe reads as starvation: well past twice its 100 ms interval. */
const STARVED_TURN_MS = 300;

type StallPoint = "session_start" | "input" | "before_agent_start" | "session_recovery_restore" | "session_shutdown";
type StallHook = (point: StallPoint, signal?: AbortSignal) => Promise<void> | undefined;
const STALL_HOOK = "__atomicIssue4319Stall";
const STARTUP_HOOK = "__atomicSubagentStartupHooks";
type StartupHook = (at: string, startup: SubagentStartupHooks | undefined) => void;
const globals = globalThis as typeof globalThis & { [STALL_HOOK]?: StallHook; [STARTUP_HOOK]?: StartupHook };

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function usage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** Saturates the main thread: every loop turn first runs `turnMs` of other work. Returns how many turns ran. */
function saturate(turnMs: number): { readonly turns: () => number; readonly stop: () => void } {
	let turns = 0;
	let stopped = false;
	const spin = () => {
		if (stopped) return;
		turns++;
		const end = performance.now() + turnMs;
		while (performance.now() < end) {
			// Other work holds the thread for the whole turn.
		}
		setImmediate(spin);
	};
	setImmediate(spin);
	const stop = () => {
		stopped = true;
	};
	cleanups.push(stop);
	return { turns: () => turns, stop };
}

/** Grants its holder's own session at once and every later session after `delayMs`, as a busy permit store would. */
class DelayedAdmission implements ResourceAdmission {
	private granted = 0;
	private readonly delayMs: number;
	constructor(delayMs: number) {
		this.delayMs = delayMs;
	}
	async acquire(): Promise<() => Promise<void>> {
		if (this.granted++ > 0) await sleep(this.delayMs);
		return async () => undefined;
	}
}

/** The longest delay a timer holds: one that stands in for a held deadline never fires. */
const NEVER_MS = 2 ** 31 - 1;

/**
 * Holds the start budget of the launch about to begin until `reached` settles. A start budget arms one timer for its
 * whole timeout as the start begins: the first timer of exactly `budgetMs` armed from here on is that deadline, and it
 * is armed for its whole budget once the child reaches its stall instead. However long a loaded host takes to bring the
 * child there, its budget then runs out while the stall holds it; a budget that ends before is never armed.
 */
function holdStartBudget(budgetMs: number, reached: Promise<void> | (() => Promise<void> | undefined)): void {
	const realSetTimeout = globalThis.setTimeout;
	const realClearTimeout = globalThis.clearTimeout;
	type HeldDeadline = { readonly standIn: NodeJS.Timeout; armed?: NodeJS.Timeout; ended: boolean };
	const deadlines: HeldDeadline[] = [];
	const nextReached = typeof reached === "function" ? reached : () => (deadlines.length === 0 ? reached : undefined);
	const end = (held: HeldDeadline) => {
		held.ended = true;
		realClearTimeout(held.armed);
	};
	globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
		if (args[1] !== budgetMs) return realSetTimeout(...args);
		const target = nextReached();
		if (target === undefined) return realSetTimeout(...args);
		const held: HeldDeadline = { standIn: realSetTimeout(() => undefined, NEVER_MS).unref(), ended: false };
		deadlines.push(held);
		void target.then(() => {
			if (!held.ended) held.armed = realSetTimeout(...args);
		});
		return held.standIn;
	}) as typeof setTimeout;
	globalThis.clearTimeout = ((timer?: NodeJS.Timeout) => {
		const held = timer === undefined ? undefined : deadlines.find((entry) => entry.standIn === timer);
		if (held !== undefined) end(held);
		realClearTimeout(timer);
	}) as typeof clearTimeout;
	cleanups.push(() => {
		globalThis.setTimeout = realSetTimeout;
		globalThis.clearTimeout = realClearTimeout;
		for (const held of deadlines) end(held);
	});
}

async function startFixture(options: { readonly parentAdmission?: ResourceAdmission } = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-start-"));
	cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
	const agentDir = join(cwd, "agent");
	const model: Model<"anthropic-messages"> = {
		...getModel("anthropic", "claude-sonnet-4-5")!,
		provider: "start-fixture",
		reasoning: true,
	};
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const requests: { readonly at: number }[] = [];
	let onRequest: (() => void) | undefined;
	runtime.registerProvider(model.provider, {
		api: model.api,
		baseUrl: model.baseUrl,
		apiKey: "fixture-key",
		models: [model],
		streamSimple: (requestModel) => {
			requests.push({ at: performance.now() });
			onRequest?.();
			const stream = createAssistantMessageEventStream();
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "child done" }],
				api: model.api,
				provider: model.provider,
				model: requestModel.id,
				usage: usage(),
				stopReason: "stop",
				timestamp: Date.now(),
			};
			stream.push({ type: "done", reason: "stop", message });
			stream.end(message);
			return stream;
		},
	});
	cleanups.push(() => runtime.unregisterProvider(model.provider));
	// A top-level session: created outside any workflow, so it holds no resource admission of its own.
	const { session: parent } = await createAgentSession({
		cwd,
		agentDir,
		modelRuntime: runtime,
		model,
		thinkingLevel: "medium",
		settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, defaultThinkingLevel: "medium" }),
		sessionManager: await SessionManager.create(cwd, join(cwd, "parent-sessions")),
		builtins: { subagents: false, intercom: false, mcp: false, "web-access": false },
		tools: ["read"],
		...(options.parentAdmission ? { resourceAdmission: options.parentAdmission } : {}),
	});
	cleanups.push(() => {
		parent.dispose();
		clearSubagentControls();
	});
	const resolve = createCandidateModelResolver({
		getAvailable: () => [model],
		find: (provider, id) => (provider === model.provider && id === model.id ? model : undefined),
		hasConfiguredAuth: () => true,
	});
	const agent: AgentConfig = {
		name: "worker",
		description: "start fixture",
		systemPrompt: "",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "user",
		filePath: join(cwd, "worker.md"),
		tools: ["read"],
	};
	const launch = (
		runId: string,
		sessionStartTimeoutMs?: number,
		options: Partial<RunSyncOptions> = {},
	): Promise<SingleResult> => {
		if (stalled !== undefined && sessionStartTimeoutMs !== undefined) holdStartBudget(sessionStartTimeoutMs, stalled);
		return runSingleInProcess(cwd, agent, "reply done", {
			cwd,
			...(sessionStartTimeoutMs === undefined ? {} : { sessionStartTimeoutMs }),
			runId,
			index: 0,
			sessionDir: join(cwd, "children"),
			testSession: false,
			modelOverride: `${model.provider}/${model.id}`,
			knownModelProviders: [model.provider],
			currentModel: `${model.provider}/${model.id}`,
			currentThinkingLevel: "medium",
			availableModels: [{ provider: model.provider, id: model.id, fullId: `${model.provider}/${model.id}` }],
			resolveCandidateModel: resolve,
			getChildSessionOptions: parent.extensionRunner.createContext().getChildSessionOptions,
			...options,
		});
	};
	/** Settles once the child reaches the point an armed stall holds. */
	let stalled: Promise<void> | (() => Promise<void> | undefined) | undefined;
	/** A child-only extension, written after the parent loaded its own, that holds `point` until released. */
	const stallChildAt = (
		point: StallPoint,
		releaseAfterMs?: number,
	): {
		readonly reached: () => boolean;
		readonly held: Promise<void>;
		readonly release: () => void;
		readonly shutdown: Promise<void>;
	} => {
		let reached = false;
		const holding = Promise.withResolvers<void>();
		stalled = holding.promise;
		let shutdownVisited: () => void = () => undefined;
		const shutdown = new Promise<void>((resolve) => {
			shutdownVisited = () => resolve();
		});
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let timer: ReturnType<typeof setTimeout> | undefined;
		globals[STALL_HOOK] = (at) => {
			if (at === "session_shutdown") shutdownVisited();
			if (at !== point) return undefined;
			reached = true;
			holding.resolve();
			if (releaseAfterMs !== undefined && timer === undefined) timer = setTimeout(release, releaseAfterMs);
			return held;
		};
		cleanups.push(() => {
			clearTimeout(timer);
			release();
			delete globals[STALL_HOOK];
		});
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		writeFileSync(
			join(agentDir, "extensions", "stall.ts"),
			[
				"export default function (pi) {",
				`\tconst stall = (point) => globalThis.${STALL_HOOK}?.(point);`,
				'\tpi.on("session_start", () => stall("session_start"));',
				'\tpi.on("input", async () => { await stall("input"); return { action: "continue" }; });',
				'\tpi.on("before_agent_start", async () => { await stall("before_agent_start"); });',
				'\tpi.on("session_shutdown", () => stall("session_shutdown"));',
				'\tpi.on("session_recovery_restore", async () => { await stall("session_recovery_restore"); });',
				"}",
			].join("\n"),
		);
		return { reached: () => reached, held: holding.promise, release, shutdown };
	};
	/** A child-only extension that records, at its session_start and its first turn, the start the host gave it. */
	const recordStartupHooks = (): Array<{
		readonly at: string;
		readonly startup: boolean;
		readonly pending?: boolean;
	}> => {
		const seen: Array<{ readonly at: string; readonly startup: boolean; readonly pending?: boolean }> = [];
		globals[STARTUP_HOOK] = (at, startup) =>
			seen.push({ at, startup: startup !== undefined, ...(startup ? { pending: startup.firstTurnPending() } : {}) });
		cleanups.push(() => {
			delete globals[STARTUP_HOOK];
		});
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		writeFileSync(
			join(agentDir, "extensions", "startup.ts"),
			[
				"export default function (pi) {",
				`\tpi.on("session_start", (_event, ctx) => globalThis.${STARTUP_HOOK}?.("session_start", ctx.subagentPolicy?.startup));`,
				`\tpi.on("before_agent_start", (_event, ctx) => { globalThis.${STARTUP_HOOK}?.("before_agent_start", ctx.subagentPolicy?.startup); });`,
				"}",
			].join("\n"),
		);
		return seen;
	};
	const stallEveryStartUntilAbort = (): { readonly starts: () => number } => {
		let starts = 0;
		const reached: PromiseWithResolvers<void>[] = [];
		const shutdowns: PromiseWithResolvers<void>[] = [];
		let shutdownsSeen = 0;
		stalled = () => {
			const entry = Promise.withResolvers<void>();
			reached.push(entry);
			return entry.promise;
		};
		const releases = new Set<() => void>();
		globals[STALL_HOOK] = (at, signal) => {
			if (at === "session_shutdown") {
				shutdowns[shutdownsSeen++]?.resolve();
				return undefined;
			}
			if (at !== "session_start") return undefined;
			const attempt = starts++;
			shutdowns.push(Promise.withResolvers<void>());
			reached[attempt]?.resolve();
			return new Promise<void>((resolve) => {
				const done = () => {
					releases.delete(done);
					resolve();
				};
				if (signal?.aborted) {
					done();
					return;
				}
				releases.add(done);
				signal?.addEventListener("abort", done, { once: true });
			});
		};
		cleanups.push(async () => {
			for (const release of [...releases]) release();
			await Promise.all(shutdowns.map((entry) => entry.promise));
			delete globals[STALL_HOOK];
		});
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		writeFileSync(
			join(agentDir, "extensions", "stall.ts"),
			[
				"export default function (pi) {",
				`\tpi.on("session_start", (_event, ctx) => globalThis.${STALL_HOOK}?.("session_start", ctx.subagentPolicy?.startup?.signal));`,
				`\tpi.on("session_shutdown", () => globalThis.${STALL_HOOK}?.("session_shutdown"));`,
				"}",
			].join("\n"),
		);
		return { starts: () => starts };
	};
	return {
		cwd,
		launch,
		requests,
		stallChildAt,
		stallEveryStartUntilAbort,
		recordStartupHooks,
		onFirstRequest: (listener: () => void) => {
			onRequest = () => {
				onRequest = undefined;
				listener();
			};
		},
	};
}

function startTimeoutOf(result: SingleResult): SessionStartTimeoutError {
	assert.equal(result.status, "error", JSON.stringify(result));
	assert.ok(result.startError, JSON.stringify(result));
	const error = rehydrateSessionStartError(result.startError);
	assert.ok(isSessionStartTimeoutError(error), JSON.stringify(result.startError));
	// A start that is not retried says why after the timeout itself.
	assert.ok(result.error?.startsWith(error.message), `${result.error} names ${error.message}`);
	return error;
}

function assertMeasuredPhase(error: SessionStartTimeoutError, stepPhase: "setup" | "dispatch"): void {
	const { turns, meanTurnMs } = error.eventLoop;
	const loopWasStarved = turns < SESSION_START_MIN_LOOP_TURNS && meanTurnMs >= SATURATED_LOOP_TURN_MS;
	assert.equal(error.phase, loopWasStarved ? "event-loop" : stepPhase, JSON.stringify(error.eventLoop));
}

/**
 * Runs about `ms` of other work on every thread of the pool a start's file-system requests run on, as a loaded host
 * does: requests made meanwhile wait for it. Settles once the pool is free again.
 */
async function holdThreadPool(ms: number): Promise<void> {
	const threads = Number(process.env.UV_THREADPOOL_SIZE) || 4;
	// Each thread derives a key with as many iterations as this thread derives in `ms`.
	const sampleIterations = 20_000;
	const sampledAt = performance.now();
	pbkdf2Sync("held", "pool", sampleIterations, 32, "sha256");
	const iterations = Math.ceil((ms / Math.max(performance.now() - sampledAt, 1)) * sampleIterations);
	await Promise.all(
		Array.from(
			{ length: threads },
			() =>
				new Promise<void>((resolve, reject) =>
					pbkdf2("held", "pool", iterations, 32, "sha256", (error) => (error ? reject(error) : resolve())),
				),
		),
	);
}

/** A child's start from its launch to its first provider request, on a main thread saturated meanwhile. */
interface SaturatedStart {
	/** The loop turns it took, which a loaded host adds turns to by holding its requests. */
	readonly turns: number;
	/** The loop turns its steps take one after another: see {@link stepsOf}. */
	readonly steps: number;
}

/** Async resources whose callbacks run in the turn that queued them: promise reactions, ticks and microtasks. */
const SAME_TURN_RESOURCES: ReadonlySet<string> = new Set(["PROMISE", "TickObject", "Microtask"]);

/**
 * Follows the steps of work started in `launched`: each callback of a file-system request, timer or other resource
 * that answers in a later loop turn runs one step after the code that started it, and a promise reaction runs at the
 * later of the step that awaited the promise and the step that settled it. `current` is the step of the code running
 * now: the longest chain of turns, one waiting for the one before, that led to it. A request a loaded host holds for
 * many turns is still one step, and requests made together are one step however the host completes them, so load
 * changes the turns a start takes but never its steps.
 */
function stepsOf(launched: AsyncLocalStorage<true>): {
	readonly enable: () => void;
	readonly disable: () => void;
	readonly current: () => number;
} {
	const stepOf = new Map<number, number>();
	const promiseMadeAt = new Map<number, number>();
	const promiseSettledAt = new Map<number, number>();
	const follows = new Map<number, number>();
	const current = () => stepOf.get(executionAsyncId()) ?? 0;
	const hook = createHook({
		init(asyncId, type, triggerAsyncId) {
			if (!launched.getStore()) return;
			if (type !== "PROMISE") stepOf.set(asyncId, current() + (SAME_TURN_RESOURCES.has(type) ? 0 : 1));
			else {
				promiseMadeAt.set(asyncId, current());
				follows.set(asyncId, triggerAsyncId);
			}
		},
		promiseResolve(asyncId) {
			const step = current();
			if (step > 0) promiseSettledAt.set(asyncId, step);
		},
		before(asyncId) {
			const madeAt = promiseMadeAt.get(asyncId);
			if (madeAt === undefined) return;
			const awaited = follows.get(asyncId);
			const settledAt = Math.max(
				promiseSettledAt.get(asyncId) ?? 0,
				awaited === undefined ? 0 : (promiseSettledAt.get(awaited) ?? 0),
			);
			stepOf.set(asyncId, Math.max(madeAt, settledAt));
		},
	});
	return { enable: () => hook.enable(), disable: () => hook.disable(), current };
}

async function saturatedStart(
	fixture: Awaited<ReturnType<typeof startFixture>>,
	runId: string,
	options: Partial<RunSyncOptions> = {},
	hostLoad?: () => Promise<void>,
): Promise<SaturatedStart> {
	const loop = saturate(SATURATED_TURN_MS);
	const load = hostLoad?.();
	const launched = new AsyncLocalStorage<true>();
	const steps = stepsOf(launched);
	let firstRequest: SaturatedStart | undefined;
	const startTurns = loop.turns();
	fixture.onFirstRequest(() => {
		firstRequest = { turns: loop.turns() - startTurns, steps: steps.current() };
	});
	steps.enable();
	try {
		const result = await launched.run(true, () => fixture.launch(runId, undefined, options));
		assert.equal(result.status, "ok", JSON.stringify(result));
		assert.ok(firstRequest !== undefined, "the child reached its provider");
		return firstRequest;
	} finally {
		steps.disable();
		loop.stop();
		await load;
	}
}

test(
	"a child on a saturated main thread reaches its provider within a bounded number of loop turns (#4319)",
	async () => {
		const fixture = await startFixture();
		const { steps, turns } = await saturatedStart(fixture, "start-saturated");
		assert.ok(
			steps <= START_LOOP_TURN_BOUND,
			`the start took ${steps} steps one after another, in ${turns} saturated loop turns`,
		);
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"a child started in a deeply nested directory runs its start in no more loop turns than one started above it, however long a loaded host holds its file requests (#5514, #5612)",
	async () => {
		const fixture = await startFixture();
		const nested = join(fixture.cwd, ...Array.from({ length: NESTED_CWD_LEVELS }, (_, level) => `level-${level}`));
		mkdirSync(nested, { recursive: true });
		// Both measured starts find what the first one loaded and compiled already in place.
		await saturatedStart(fixture, "start-warm-up");
		const shallow = await saturatedStart(fixture, "start-shallow-cwd");
		// The nested start's requests wait for other work first, as on a loaded host: waiting is not a step of its own.
		const deep = await saturatedStart(fixture, "start-nested-cwd", { cwd: nested }, () =>
			holdThreadPool(HELD_THREAD_POOL_MS),
		);

		assert.ok(
			deep.steps - shallow.steps < NESTED_CWD_LEVELS,
			`the start took ${shallow.steps} steps (${shallow.turns} loop turns) in ${fixture.cwd} and ${deep.steps} steps (${deep.turns} loop turns) ${NESTED_CWD_LEVELS} directories below it`,
		);
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"a child's start makes a bounded number of fs requests up to its first provider request (#4319)",
	async () => {
		const fixture = await startFixture();
		let operations = 0;
		let atFirstRequest: number | undefined;
		const hook = createHook({
			init(_id, type) {
				if (type === "FSREQPROMISE" || type === "FSREQCALLBACK") operations++;
			},
		});
		fixture.onFirstRequest(() => {
			atFirstRequest = operations;
		});
		hook.enable();
		let result: SingleResult;
		try {
			result = await fixture.launch("start-fs-operations");
		} finally {
			hook.disable();
		}

		assert.equal(result.status, "ok", JSON.stringify(result));
		assert.ok(atFirstRequest !== undefined, "the child reached its provider");
		assert.ok(atFirstRequest <= START_FS_OPERATION_BOUND, `the start made ${atFirstRequest} fs requests`);
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"a child whose session setup stalls fails with a typed timeout in the setup phase (#4319)",
	async () => {
		const fixture = await startFixture();
		const stall = fixture.stallChildAt("session_start");
		const result = await fixture.launch("start-setup-stall", STALL_START_BUDGET_MS);
		stall.release();

		assert.ok(stall.reached(), "the child's extension startup was held");
		const error = startTimeoutOf(result);
		assertMeasuredPhase(error, "setup");
		assert.equal(error.step, "creating-session");
		assert.equal(error.timeoutMs, STALL_START_BUDGET_MS);
		assert.ok(error.elapsedMs >= STALL_START_BUDGET_MS - TIMER_GRANULARITY_MS, String(error.elapsedMs));
		assert.deepEqual(
			error.steps.map((timing) => timing.step),
			["opening-session", "loading-resources", "creating-session"],
		);
		assert.equal(error.subject, "subagent start-setup-stall/worker_1");
		assert.deepEqual(fixture.requests, [], "its task never reached the provider");
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"a child whose task is never dispatched fails with a typed timeout in the dispatch phase (#4319)",
	async () => {
		const fixture = await startFixture();
		const stall = fixture.stallChildAt("input");
		const result = await fixture.launch("start-dispatch-stall", STALL_START_BUDGET_MS);
		stall.release();

		assert.ok(stall.reached(), "the child's input handling was held");
		const error = startTimeoutOf(result);
		assertMeasuredPhase(error, "dispatch");
		assert.equal(error.step, "dispatching-task");
		assert.equal(error.steps.at(-2)?.step, "creating-session");
		assert.deepEqual(fixture.requests, [], "its task never reached the provider");
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

const nextMacrotask = () => new Promise<void>((resolve) => setImmediate(resolve));

for (const point of ["input", "before_agent_start"] as const) {
	test(
		`a child whose ${point} handler never settles reports its start timeout without waiting for cleanup (#4319)`,
		async () => {
			const fixture = await startFixture();
			const stall = fixture.stallChildAt(point);
			const launched = fixture.launch(`start-never-settles-${point}`, STALL_START_BUDGET_MS);
			await Promise.race([stall.held, launched]);
			const outcome = await launched;

			assert.ok(stall.reached(), `the child's ${point} handling was held`);
			const error = startTimeoutOf(outcome);
			assertMeasuredPhase(error, "dispatch");
			assert.equal(error.step, "dispatching-task");
			assert.deepEqual(fixture.requests, [], "its task never reached the provider");

			stall.release();
			await stall.shutdown;
			assert.deepEqual(fixture.requests, [], "the timed-out child never dispatches after its handler is released");
		},
		REAL_CHILD_SESSION_TIMEOUT_MS,
	);
}

test(
	"a child's disposal failing after its start timeout leaves the timeout as the error and keeps the failure as its cleanupCause (#4319)",
	async () => {
		const fixture = await startFixture();
		const stall = fixture.stallChildAt("input");
		const attempts: Promise<AttemptOutcome>[] = [];
		const startAttempt = SubagentControlRuntime.prototype.startAttempt;
		SubagentControlRuntime.prototype.startAttempt = function (...args) {
			const running = startAttempt.apply(this, args);
			attempts.push(running.promise);
			return running;
		};
		const disposalError = new Error("child session store closed with a pending write");
		let disposalFailed: () => void = () => undefined;
		const failedDisposal = new Promise<void>((resolve) => {
			disposalFailed = () => resolve();
		});
		const dispose = AgentSession.prototype.dispose;
		let failed = false;
		AgentSession.prototype.dispose = async function (this: AgentSession) {
			if (!stall.reached() || failed) return dispose.call(this);
			failed = true;
			await dispose.call(this);
			disposalFailed();
			throw disposalError;
		};
		cleanups.push(() => {
			SubagentControlRuntime.prototype.startAttempt = startAttempt;
			AgentSession.prototype.dispose = dispose;
		});
		const result = await fixture.launch("start-timeout-disposal-fails", STALL_START_BUDGET_MS);

		startTimeoutOf(result);
		const outcome = await attempts[0]!;
		assert.ok(outcome.status === "error");
		const { startError } = outcome;
		assert.ok(startError && isSessionStartTimeoutError(startError));
		assert.equal((startError as { cleanupCause?: unknown }).cleanupCause, undefined, "disposal is still held");
		stall.release();
		await failedDisposal;
		await nextMacrotask();
		assert.equal((startError as { cleanupCause?: unknown }).cleanupCause, disposalError);
		assert.ok(isSessionStartTimeoutError(startError));
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"a child on a main thread too saturated to turn fails with a typed timeout in the event-loop phase (#4319)",
	async () => {
		const fixture = await startFixture();
		const loop = saturate(STARVED_TURN_MS);
		const result = await fixture.launch("start-starved", STALL_START_BUDGET_MS);
		loop.stop();

		const error = startTimeoutOf(result);
		assert.equal(error.phase, "event-loop");
		assert.ok(error.eventLoop.turns < 100, JSON.stringify(error.eventLoop));
		assert.ok(error.eventLoop.meanTurnMs >= STARVED_TURN_MS, JSON.stringify(error.eventLoop));
		assert.deepEqual(fixture.requests, [], "its task never reached the provider");
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"an invalid start budget is refused before the child is admitted (#4319)",
	async () => {
		const fixture = await startFixture();
		for (const budget of [0, -1, 1.5, Number.NaN, 2 ** 31]) {
			await assert.rejects(fixture.launch("start-invalid-budget", budget), (error: unknown) => {
				assert.ok(isSessionStartConfigError(error), String(error));
				assert.equal(error.source, "sdk");
				assert.equal(error.field, "sessionStartTimeoutMs");
				return true;
			});
		}
		assert.equal(existsSync(join(fixture.cwd, "children")), false, "no child session directory was created");
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"a child reports the session it opened before its task runs (#4319)",
	async () => {
		const fixture = await startFixture();
		const opened: { sessionId: string; sessionFile: string | undefined }[] = [];
		const result = await fixture.launch("start-session-reported", undefined, {
			onChildSession: (child) => opened.push(child),
		});

		assert.equal(result.status, "ok", JSON.stringify(result));
		assert.ok(result.sessionFile);
		assert.deepEqual(
			opened.map((child) => child.sessionFile),
			[result.sessionFile],
		);
		assert.equal(typeof opened[0]?.sessionId, "string");
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"a child whose launch options cannot be read fails with that error once its session is open (#4319)",
	async () => {
		const fixture = await startFixture();
		const opened: string[] = [];
		const result = await fixture.launch("start-options-retired", undefined, {
			getChildSessionOptions: () => {
				throw new Error("parent context retired");
			},
			onChildSession: (child) => opened.push(child.sessionId),
		});

		assert.equal(result.status, "error", JSON.stringify(result));
		assert.equal(result.error, "parent context retired");
		assert.equal(result.startError, undefined);
		assert.equal(opened.length, 1, "its session was opened and reported first");
		assert.deepEqual(fixture.requests, []);
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"a child whose resources fail to load fails with that error (#4319)",
	async () => {
		const fixture = await startFixture();
		// Only the child's own load fails: a later load, as createAgentSession would make, succeeds.
		const reload = DefaultResourceLoader.prototype.reload;
		DefaultResourceLoader.prototype.reload = async () => {
			DefaultResourceLoader.prototype.reload = reload;
			throw new Error("resources unreadable");
		};
		let result: SingleResult;
		try {
			result = await fixture.launch("start-resources-unreadable");
		} finally {
			DefaultResourceLoader.prototype.reload = reload;
		}

		assert.equal(result.status, "error", JSON.stringify(result));
		assert.equal(result.error, "resources unreadable");
		assert.deepEqual(fixture.requests, []);
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"a child that waited for its permit and then stalled setting up names setup, with the wait among its steps (#4319)",
	async () => {
		const fixture = await startFixture({ parentAdmission: new DelayedAdmission(ADMISSION_DELAY_MS) });
		let stall: ReturnType<typeof fixture.stallChildAt>;
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			stall = fixture.stallChildAt("session_start");
			vi.advanceTimersByTime(STALL_MS);
		} finally {
			vi.useRealTimers();
		}
		const result = await fixture.launch("start-admitted-then-stalled", STALL_START_BUDGET_MS);
		stall.release();

		const error = startTimeoutOf(result);
		assertMeasuredPhase(error, "setup");
		assert.equal(error.step, "creating-session");
		assert.deepEqual(
			error.steps.map((timing) => timing.step),
			["opening-session", "loading-resources", "creating-session", "awaiting-admission", "creating-session"],
		);
		assert.ok(error.steps[3]!.elapsedMs >= ADMISSION_DELAY_MS - TIMER_GRANULARITY_MS, JSON.stringify(error.steps));
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"a resumed child's budget ends once its session is up, so its recovery may outlast it (#4319)",
	async () => {
		const fixture = await startFixture();
		const first = await fixture.launch("start-resumed");
		assert.equal(first.status, "ok", JSON.stringify(first));
		assert.ok(first.sessionFile);
		const stall = fixture.stallChildAt("session_recovery_restore", STALL_MS);
		const result = await fixture.launch("start-resumed", STALL_START_BUDGET_MS, {
			sessionManager: await SessionManager.open(first.sessionFile),
			resumeSession: true,
		});

		assert.ok(stall.reached(), "the child's recovery was held past its start budget");
		assert.equal(result.status, "ok", JSON.stringify(result));
		assert.equal(result.startError, undefined);
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

test("a child runs with task hooks that bind neither its transcript nor its session (#4319)", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-subagent-hooks-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const agent: AgentConfig = {
		name: "worker",
		description: "hooks fixture",
		systemPrompt: "",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "user",
		filePath: join(root, "worker.md"),
	};
	const control = new SubagentControlRuntime({ path: "parent", depth: 0 }, root);
	control.registerAgents([agent]);
	const { admitted } = await control.admitChildSession(
		{ taskName: "worker", task: "reply done", agent, cwd: root, testSession: { output: "done" } },
		{ path: "parent", depth: 0 },
	);
	assert.ok(admitted);
	const activity: string[] = [];
	const outcome = await control.runChildAttempt(
		admitted,
		{},
		{ abort: new AbortController().signal, interrupt: new AbortController().signal },
		undefined,
		{ reportActivity: (report) => activity.push(report.change.kind) },
	);

	assert.equal(outcome.status, "ok", JSON.stringify(outcome));
	assert.ok(activity.length > 0, "its activity was still reported");
});

type TestSessionTaskHooks = Parameters<SubagentControlRuntime["runChildAttempt"]>[4];
type TestSessionCleanupCallback = Parameters<SubagentControlRuntime["runChildAttempt"]>[5];

async function testSessionAttempt(
	dispose: () => void | Promise<void>,
	options: {
		readonly taskHooks?: TestSessionTaskHooks;
		readonly onCleanup?: TestSessionCleanupCallback;
		readonly terminalBeforeStart?: boolean;
		readonly failPromptWrite?: boolean;
		readonly failBeforeSession?: boolean;
	} = {},
) {
	const root = mkdtempSync(join(tmpdir(), "atomic-subagent-dispose-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const agent: AgentConfig = {
		name: "worker",
		description: "disposal fixture",
		systemPrompt: "",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "user",
		filePath: join(root, "worker.md"),
	};
	const control = new SubagentControlRuntime({ path: "parent", depth: 0 }, root);
	control.registerAgents([agent]);
	const { admitted } = await control.admitChildSession(
		{
			taskName: "worker",
			task: "reply done",
			agent,
			cwd: root,
			parent: options.failBeforeSession
				? {
						path: "parent",
						depth: 0,
						getChildSessionOptions: () => {
							throw new Error("parent context closed");
						},
					}
				: undefined,
			testSession: options.failBeforeSession
				? false
				: { output: "done", dispose, promptLogPath: options.failPromptWrite ? root : undefined },
		},
		{ path: "parent", depth: 0 },
	);
	assert.ok(admitted);
	if (options.terminalBeforeStart) {
		const previous = control.native.beginChildAttempt(admitted.identity.path);
		assert.ok(previous.token);
		control.native.finishChildAttempt(previous.token, "ok");
	}
	return control.runChildAttempt(
		admitted,
		{},
		{ abort: new AbortController().signal, interrupt: new AbortController().signal },
		undefined,
		options.taskHooks,
		options.onCleanup,
	);
}

function taskBackedAttempt(dispose: () => void | Promise<void>) {
	const bound: Parameters<NonNullable<NonNullable<TestSessionTaskHooks>["bindTranscript"]>>[0][] = [];
	let statusesCleared = 0;
	let cleanup: Parameters<NonNullable<TestSessionCleanupCallback>>[0] | undefined;
	const attempt = testSessionAttempt(dispose, {
		taskHooks: {
			reportActivity: () => undefined,
			bindTranscript: (source) => bound.push(source),
			clearExtensionStatuses: () => {
				statusesCleared++;
			},
		},
		onCleanup: (settled) => {
			cleanup = settled;
		},
	});
	return {
		attempt,
		cleanup: () => cleanup,
		statusesCleared: () => statusesCleared,
		lastBound: () => bound.at(-1),
	};
}

test("a child's result waits for its session's disposal to finish (#4319)", async () => {
	let release: () => void = () => undefined;
	const held = new Promise<void>((resolve) => {
		release = () => resolve();
	});
	let disposing: () => void = () => undefined;
	const disposalStarted = new Promise<void>((resolve) => {
		disposing = () => resolve();
	});
	let settled = false;
	const attempt = testSessionAttempt(async () => {
		disposing();
		await held;
	}).then((outcome) => {
		settled = true;
		return outcome;
	});
	await disposalStarted;
	await nextMacrotask();
	assert.equal(settled, false, "the result waits while disposal is held");
	release();
	const outcome = await attempt;
	assert.equal(outcome.status, "ok", JSON.stringify(outcome));
	assert.equal(outcome.cleanupCause, undefined);
});

test("a child whose session fails to dispose keeps its result and reports the failure as its cleanupCause (#4319)", async () => {
	const disposalError = new Error("session store closed with a pending write");
	const outcome = await testSessionAttempt(() => {
		throw disposalError;
	});

	assert.equal(outcome.status, "ok", JSON.stringify({ ...outcome, cleanupCause: undefined }));
	assert.equal(outcome.cleanupCause, disposalError);
});

test("a task-backed child's result does not wait for its held disposal, which reports reaped once it finishes (#4319)", async () => {
	let release: () => void = () => undefined;
	const held = new Promise<void>((resolve) => {
		release = () => resolve();
	});
	let disposing: () => void = () => undefined;
	const disposalStarted = new Promise<void>((resolve) => {
		disposing = () => resolve();
	});
	const run = taskBackedAttempt(async () => {
		disposing();
		await held;
	});
	await disposalStarted;
	const outcome = await Promise.race([run.attempt, nextMacrotask().then(() => "waiting" as const)]);

	assert.ok(outcome !== "waiting", "the result settled while disposal was held");
	assert.equal(outcome.status, "ok", JSON.stringify(outcome));
	assert.equal(outcome.cleanupCause, undefined);
	assert.ok(run.cleanup(), "the cleanup was handed to the task owner");
	assert.equal(run.statusesCleared(), 0, "extension statuses stay open while disposal is held");
	assert.ok(
		run.lastBound() && "subscribe" in run.lastBound()!,
		"the live transcript stays bound while disposal is held",
	);

	release();
	assert.deepEqual(await run.cleanup(), { kind: "reaped" });
	assert.equal(run.statusesCleared(), 1);
	const settled = run.lastBound();
	assert.ok(settled);
	assert.equal("subscribe" in settled, false, "the settled transcript keeps no reference to the disposed session");
	assert.ok(settled.getSessionId().length > 0);
	assert.ok(
		((await settled.loadHistory?.())?.entries ?? []).length > 0,
		"the settled transcript reads its history back",
	);
});

for (const [kind, thrown, message] of [
	["an Error", new Error("session store closed with a pending write"), "session store closed with a pending write"],
	["a non-Error value", 42, "42"],
] as const) {
	test(`a task-backed child whose disposal throws ${kind} reports it as failed cleanup and still settles its transcript (#4319)`, async () => {
		const run = taskBackedAttempt(() => Promise.reject(thrown));
		const outcome = await run.attempt;

		assert.equal(outcome.status, "ok", JSON.stringify(outcome));
		assert.equal(outcome.cleanupCause, undefined);
		assert.deepEqual(await run.cleanup(), {
			kind: "failed",
			resources: [{ resource: "agent-session", code: "CleanupFailed", message }],
		});
		assert.equal(run.statusesCleared(), 1);
		const settled = run.lastBound();
		assert.ok(settled);
		assert.equal("subscribe" in settled, false, "the settled transcript keeps no reference to the disposed session");
		assert.ok(
			((await settled.loadHistory?.())?.entries ?? []).length > 0,
			"the settled transcript reads its history back",
		);
	});
}

test("a terminal child refused before session construction has no disposal to await (#4319)", async () => {
	let disposals = 0;
	const outcome = await testSessionAttempt(
		() => {
			disposals++;
		},
		{ terminalBeforeStart: true },
	);
	assert.equal(outcome.status, "error");
	assert.equal(disposals, 0);
	assert.equal(outcome.cleanupCause, undefined);
});

test("a non-timeout dispatch failure still waits for session disposal (#4319)", async () => {
	let release: () => void = () => undefined;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let disposing: () => void = () => undefined;
	const disposalStarted = new Promise<void>((resolve) => {
		disposing = resolve;
	});
	let settled = false;
	const attempt = testSessionAttempt(
		async () => {
			disposing();
			await held;
		},
		{ failPromptWrite: true },
	).then((outcome) => {
		settled = true;
		return outcome;
	});
	await disposalStarted;
	await nextMacrotask();
	assert.equal(settled, false);
	release();
	const outcome = await attempt;
	assert.ok(outcome.status === "error");
	assert.equal(outcome.startError, undefined);
	assert.equal(outcome.cleanupCause, undefined);
});

test("a setup failure before session construction has no agent session to dispose (#4319)", async () => {
	let cleanup: Parameters<NonNullable<TestSessionCleanupCallback>>[0] | undefined;
	const outcome = await testSessionAttempt(() => assert.fail("no session was constructed"), {
		failBeforeSession: true,
		onCleanup: (result) => {
			cleanup = result;
		},
	});
	assert.ok(outcome.status === "error");
	assert.equal(outcome.startError, undefined);
	assert.equal(outcome.cleanupCause, undefined);
	assert.ok(cleanup);
	assert.deepEqual(await cleanup, { kind: "reaped" });
});

test(
	"a child whose start stalls renews its hold once before retrying and names both stalls (#5341)",
	async () => {
		const fixture = await startFixture();
		// Each start is held past its budget, then lets go of its session, so its retry may open it again.
		const stall = fixture.stallEveryStartUntilAbort();
		const reports: Array<SubagentStartProgress | undefined> = [];
		const taskExecution: TaskExecutionHooks = {
			signal: new AbortController().signal,
			reportActivity() {},
			reportStart: (progress) => reports.push(progress),
			onExecution() {},
		};
		const reload = DefaultResourceLoader.prototype.reload;
		DefaultResourceLoader.prototype.reload = async function (this: DefaultResourceLoader) {
			DefaultResourceLoader.prototype.reload = reload;
			await sleep(STALL_START_BUDGET_MS);
			return reload.call(this);
		};
		const retries: number[] = [];
		let result: SingleResult;
		try {
			result = await fixture.launch("start-stalls-twice", STALL_START_BUDGET_MS, {
				taskExecution,
				onStartRetry: async () => {
					retries.push(stall.starts());
				},
			});
		} finally {
			DefaultResourceLoader.prototype.reload = reload;
		}

		assert.deepEqual(retries, [1], "the hold is renewed once, after the first start releases and before the retry");
		assert.equal(stall.starts(), 2, "the stalled start was retried once, and only once");
		const shown = reports.flatMap((report) => (report === undefined ? [] : [describeSubagentStart(report)]));
		assert.ok(shown.length > 0, "its start was reported");
		for (const status of shown) assert.doesNotMatch(status.summary, /^running/, "never shown as merely running");
		const first = shown.filter((status) => status.attempt === 1);
		const retried = shown.filter((status) => status.attempt === 2);
		assert.ok(first.length > 0 && first.every((status) => status.state === "starting"));
		assert.ok(
			retried.length > 0 && retried.every((status) => status.state === "stalled"),
			"the retry shows the stall",
		);
		const stalledStep = retried[0]?.stalled?.step;
		assert.ok(stalledStep, "the stall names its step");
		assert.match(retried[0]!.summary, /^stalled/);

		assert.equal(result.status, "error", JSON.stringify(result));
		const error = rehydrateSessionStartError(result.startError!);
		assert.ok(isSessionStartTimeoutError(error));
		assert.match(
			result.error ?? "",
			/^Subagent did not start: its start stalled .+ and was retried once; the retry stalled /,
		);
		assert.ok(result.error?.includes(`retry stalled ${sessionStartStepTextOf(error.step)}`), result.error);
		assert.deepEqual(fixture.requests, [], "neither attempt ran a turn");
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

function sessionStartStepTextOf(step: SessionStartTimeoutError["step"]): string {
	return describeSubagentStart({ step, attempt: 1, launchedAt: 0, startedAt: 0, stepStartedAt: 0 }).stepText;
}

test(
	"a child's extensions start inside its start: their messages are context for its first turn until its task is dispatched",
	async () => {
		const fixture = await startFixture();
		const seen = fixture.recordStartupHooks();
		const result = await fixture.launch("start-hooks");

		assert.equal(result.status, "ok", JSON.stringify(result));
		assert.deepEqual(seen, [
			{ at: "session_start", startup: true, pending: true },
			{ at: "before_agent_start", startup: true, pending: false },
		]);
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"a late session's disposal must finish before its stalled start can be retried (#5341)",
	async () => {
		const fixture = await startFixture();
		const firstStart = fixture.stallChildAt("session_start");
		const originalHook = globals[STALL_HOOK]!;
		const releaseDisposal = Promise.withResolvers<void>();
		const disposals: Promise<void>[] = [];
		const dispose = AgentSession.prototype.dispose;
		const disposeSpy = vi.spyOn(AgentSession.prototype, "dispose").mockImplementation(function (this: AgentSession) {
			const pending = dispose.call(this);
			disposals.push(pending);
			return pending;
		});
		let disposing = false;
		let starts = 0;
		globals[STALL_HOOK] = (point) => {
			if (point === "session_start") starts += 1;
			if (point !== "session_shutdown") return originalHook(point);
			disposing = true;
			return releaseDisposal.promise;
		};
		try {
			const result = await fixture.launch("late-session-disposal", STALL_START_BUDGET_MS, {
				taskExecution: {
					signal: new AbortController().signal,
					reportActivity() {},
					reportStart(progress) {
						if (progress?.awaitingRelease) firstStart.release();
					},
					onExecution() {},
				},
			});
			assert.equal(disposing, true, "the abandoned session reached its held shutdown");
			assert.equal(starts, 1, "no second session starts while the abandoned session still owns resources");
			assert.match(
				result.error ?? "",
				/It was not retried: the stalled start did not let go of its session in time/,
			);
			assert.deepEqual(fixture.requests, []);
		} finally {
			firstStart.release();
			releaseDisposal.resolve();
			try {
				await Promise.all(disposals);
			} finally {
				disposeSpy.mockRestore();
			}
		}
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);
