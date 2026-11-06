import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DetachedToolCall, type DetachedToolResult, SessionManager } from "@bastani/atomic";
import { describe, test, vi } from "vitest";
import {
	SessionNotFoundError,
	StorageUnavailableError,
} from "../../packages/coding-agent/src/core/storage/session/errors.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { StageIdleReleaser } from "../../packages/workflows/src/runs/foreground/stage-idle-release.js";
import type { StageAdapters } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import type { StageWaitHooks } from "../../packages/workflows/src/runs/foreground/stage-runner-types.js";
import {
	StageWakeDispatcher,
	stageWakeKey,
} from "../../packages/workflows/src/runs/foreground/stage-wake-dispatcher.js";
import { RESUME_CONTINUATION_PROMPT } from "../../packages/workflows/src/shared/resume-continuation.js";
import type { StageStartupPhase, StageStartupSnapshot } from "../../packages/workflows/src/shared/stage-startup.js";
import {
	STAGE_WAIT_RETRY_ATTEMPTS,
	STAGE_WAIT_RETRY_BUDGET_MS,
} from "../../packages/workflows/src/shared/stage-wait.js";
import {
	findStageWaitError,
	isStageRehydrationError,
	isStageReleaseError,
	StageRehydrationError,
	StageReleaseError,
} from "../../packages/workflows/src/shared/stage-wait-errors.js";
import type { StageOptions } from "../../packages/workflows/src/shared/types.js";
import { isRetryableWorkflowError } from "../../packages/workflows/src/shared/workflow-infrastructure-error.js";
import {
	createStageContext,
	type InternalStageContext,
	makeMockSession,
	makeOpts,
	type StageSessionCreateOptions,
	type StageSessionRuntime,
} from "./stage-runner-helpers.js";

const RUN_ID = "run-controller";
const STAGE_ID = "stage-controller";
const STAGE_NAME = "implement";
/** The longest a test waits for something timer-driven; a mutant that never fires fails here, not at the suite timeout. */
const EVENTUALLY_MS = 3_000;

/** What a fake session may be given on top of the runner's session surface. */
type FakeSessionFields = Partial<StageSessionRuntime> & {
	clearQueue?: () => { steering: string[]; followUp: string[] };
};

async function until(predicate: () => boolean): Promise<void> {
	for (let round = 0; round < 2_000 && !predicate(); round++) await new Promise((resolve) => setImmediate(resolve));
	assert.ok(predicate(), "condition never held");
}

async function eventually(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + EVENTUALLY_MS;
	while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.ok(predicate(), "condition did not hold in time");
}

async function settles<T>(promise: Promise<T>, ms = 100): Promise<{ done: false } | { done: true; value: T }> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise.then((value) => ({ done: true as const, value })),
			new Promise<{ done: false }>((resolve) => {
				timer = setTimeout(() => resolve({ done: false }), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** The fake long tool: one call per id, finished (or failed) only by the test; records what aborted it and why. */
class Ci {
	readonly calls = new Map<
		string,
		{ readonly deferred: PromiseWithResolvers<DetachedToolResult>; aborts: unknown[] }
	>();

	call(toolCallId: string, options: { readonly settled?: boolean } = {}): DetachedToolCall {
		const deferred = Promise.withResolvers<DetachedToolResult>();
		const record = { deferred, aborts: [] as unknown[] };
		this.calls.set(toolCallId, record);
		if (options.settled === true) this.finish(toolCallId);
		return {
			toolCallId,
			toolName: "wait_for_ci",
			result: deferred.promise,
			abort: (reason) => {
				record.aborts.push(reason);
			},
		};
	}

	finish(toolCallId: string): void {
		this.calls.get(toolCallId)?.deferred.resolve({
			toolCallId,
			toolName: "wait_for_ci",
			result: { content: [{ type: "text", text: `${toolCallId} passed` }], details: undefined },
			isError: false,
		});
	}

	aborts(toolCallId: string): unknown[] {
		return this.calls.get(toolCallId)?.aborts ?? [];
	}
}

interface RigConfig {
	/** The wait policy the stage's hooks carry; `undefined` keeps every wait resident. Default: release at once. */
	readonly policy?: { readonly afterMs: number } | undefined;
	/** No wait hooks at all, as for a stage that was never given the capability. */
	readonly noHooks?: boolean;
	/** False: no session store, so no caller-owned session manager exists to reopen from. Default true. */
	readonly withStore?: boolean;
	readonly signal?: AbortSignal;
	readonly stageOptions?: StageOptions;
	/** The calls a session's `prompt()` leaves detached; default none. */
	readonly detachOnPrompt?: (sessionNumber: number, text: string, ci: Ci) => DetachedToolCall[];
	/** Fields of the fake session, by session number. */
	readonly customize?: (sessionNumber: number, log: string[], ci: Ci) => FakeSessionFields;
	/** Fails the creation of the session with this number. */
	readonly failCreation?: (sessionNumber: number) => Error | undefined;
	readonly store?: MemorySessionStore;
	/** A stage given no options at all. */
	readonly bare?: boolean;
	/** Fails the `enter` hook with this value, as a host whose bookkeeping failed would. */
	readonly enterFails?: unknown;
	/** Runs inside the adapter's `create`, before the session is built, with the stage's startup reporter. */
	readonly onCreate?: (
		sessionNumber: number,
		reportStartupPhase: (phase: StageStartupPhase) => void,
		ctx: () => InternalStageContext,
	) => Promise<void> | void;
}

interface Rig {
	readonly ctx: InternalStageContext;
	/** Hooks, session creations and everything a session did, in the order it happened. */
	readonly log: string[];
	readonly ci: Ci;
	readonly dispatcher: StageWakeDispatcher;
	readonly store: MemorySessionStore;
	readonly residents: StageReleaseError[];
	readonly createOptions: StageSessionCreateOptions[];
	/** Startup snapshots the stage reported, in order. */
	readonly startups: StageStartupSnapshot[];
	/** Subscriptions each session still holds, by session number. */
	readonly subscriptions: Map<number, number>;
	created(): number;
}

function imagesNote(images: readonly object[] | undefined): string {
	return images === undefined ? "" : `:images=${JSON.stringify(images)}`;
}

function names(log: readonly string[], prefix: string): string[] {
	return log.filter((entry) => entry.startsWith(prefix));
}

function makeRig(config: RigConfig = {}): Rig {
	const log: string[] = [];
	const ci = new Ci();
	const store = config.store ?? new MemorySessionStore();
	const residents: StageReleaseError[] = [];
	const createOptions: StageSessionCreateOptions[] = [];
	const subscriptions = new Map<number, number>();
	const startups: StageStartupSnapshot[] = [];
	const dispatcher = new StageWakeDispatcher(RUN_ID, config.signal);
	// The stage factory opens a stage's mailbox when the stage starts.
	dispatcher.open({ runId: RUN_ID, stageId: STAGE_ID, wakeKey: stageWakeKey(RUN_ID, STAGE_ID) });
	let created = 0;
	let contextRef: InternalStageContext | undefined;
	const policy = "policy" in config ? config.policy : { afterMs: 0 };
	const hooks: StageWaitHooks = {
		policy,
		dispatcher,
		wakeKey: stageWakeKey(RUN_ID, STAGE_ID),
		async enter(wait) {
			log.push(`enter:${wait.kind}`);
			if (config.enterFails !== undefined) throw config.enterFails;
		},
		async recordResults(wait, results) {
			log.push(`record:${wait.kind}:${results.map((result) => result.toolCallId).join(",")}`);
		},
		resultsInTranscript() {
			log.push("resultsInTranscript");
		},
		async leave(wait) {
			log.push(`leave:${wait.kind}`);
		},
		async reopenFailed(wait) {
			log.push(`reopenFailed:${wait.kind}`);
		},
		async rehydrated(wait) {
			log.push(`rehydrated:${wait.kind}`);
		},
		resident(reason) {
			residents.push(reason);
		},
	};
	const adapters: StageAdapters = {
		...(config.withStore === false ? {} : { sessionStore: store }),
		agentSession: {
			async create(options, meta) {
				created += 1;
				const number = created;
				await config.onCreate?.(
					number,
					(phase) => meta?.onStartupPhase?.(phase),
					() => contextRef!,
				);
				const failure = config.failCreation?.(number);
				if (failure !== undefined) throw failure;
				createOptions.push(options);
				log.push(`create#${number}`);
				const manager = options.sessionManager as SessionManager | undefined;
				let detached: DetachedToolCall[] = [];
				subscriptions.set(number, 0);
				const { session } = makeMockSession({
					sessionId: manager?.getSessionId() ?? `session-${number}`,
					async prompt(text: string) {
						log.push(`prompt#${number}:${text}`);
						detached = config.detachOnPrompt?.(number, text, ci) ?? [];
					},
					async steer(text: string, images?: readonly object[], options?: { expandPromptTemplates?: boolean }) {
						log.push(`steer#${number}:${text}:${JSON.stringify(options)}${imagesNote(images)}`);
					},
					async followUp(text: string, images?: readonly object[], options?: { expandPromptTemplates?: boolean }) {
						log.push(`followUp#${number}:${text}:${JSON.stringify(options)}${imagesNote(images)}`);
					},
					subscribe() {
						subscriptions.set(number, (subscriptions.get(number) ?? 0) + 1);
						return () => {
							subscriptions.set(number, (subscriptions.get(number) ?? 0) - 1);
						};
					},
					async setModel(model: unknown) {
						log.push(`setModel#${number}:${String((model as { id?: string }).id ?? model)}`);
					},
					dispose() {
						log.push(`dispose#${number}`);
					},
					setToolDetachment(detachment: { readonly afterMs: number } | undefined) {
						log.push(`setToolDetachment#${number}:${JSON.stringify(detachment)}`);
					},
					takeDetachedToolCalls() {
						const taken = detached;
						detached = [];
						return taken;
					},
					async resumeDetachedTurn(results: readonly DetachedToolResult[]) {
						log.push(`resume#${number}:${results.map((result) => result.toolCallId).join(",")}`);
					},
					...config.customize?.(number, log, ci),
				});
				return session;
			},
		},
	};
	const ctx = createStageContext(
		makeOpts({
			runId: RUN_ID,
			stageId: STAGE_ID,
			stageName: STAGE_NAME,
			adapters,
			...(config.signal === undefined ? {} : { signal: config.signal }),
			...(config.noHooks === true ? {} : { waiting: hooks }),
			onStartupChange: (snapshot) => startups.push(snapshot),
			...(config.bare === true
				? {}
				: {
						stageOptions: {
							...(config.withStore === false ? {} : { sessionStore: store }),
							...(config.stageOptions ?? {}),
						},
					}),
		}),
	) as InternalStageContext;
	contextRef = ctx;
	return {
		ctx,
		log,
		ci,
		dispatcher,
		store,
		residents,
		createOptions,
		startups,
		subscriptions,
		created: () => created,
	};
}

/** Starts a prompt that detaches one call `c1` and waits until the stage reached the wait (or ran on resident). */
function detachingOne(): NonNullable<RigConfig["detachOnPrompt"]> {
	return (number, text, ci) => (number === 1 && text === "go" ? [ci.call("c1")] : []);
}

async function persistedSession(store: MemorySessionStore): Promise<string> {
	const manager = await SessionManager.create(store, process.cwd());
	return manager.getSessionId();
}

describe("a stage that detaches a call and waits released (#4309)", () => {
	test("the session is released while the stage waits, and the same turn continues from a reopened session", async () => {
		const rig = makeRig({ detachOnPrompt: detachingOne() });

		const turn = rig.ctx.prompt("go");
		await until(() => rig.log.includes("enter:tool"));

		// No session is live and its subscriptions are gone; the stage is parked with the run's dispatcher.
		assert.equal(rig.subscriptions.get(1), 0);
		assert.deepEqual(names(rig.log, "dispose#"), ["dispose#1"]);
		assert.equal(rig.ctx.__isReleased?.(), true);
		assert.equal(rig.ctx.sessionId, rig.createOptions[0]?.sessionManager?.getSessionId());
		assert.deepEqual(
			rig.dispatcher.entries().map((entry) => [entry.runId, entry.stageId, entry.reason]),
			[[RUN_ID, STAGE_ID, "tool"]],
		);
		assert.equal(rig.created(), 1);

		rig.ci.finish("c1");
		await turn;

		assert.equal(rig.ctx.__isReleased?.(), false);
		assert.equal(rig.dispatcher.size, 0);
		assert.deepEqual(
			rig.log.filter((entry) => /^(enter|leave|rehydrated):/.test(entry)),
			["enter:tool", "leave:tool", "rehydrated:tool"],
		);
		assert.deepEqual(names(rig.log, "prompt#"), ["prompt#1:go"]);
		assert.deepEqual(names(rig.log, "resume#"), ["resume#2:c1"]);
		assert.equal(rig.created(), 2);
		// The reopened session is the same stored session, and it is subscribed again.
		assert.equal(
			rig.createOptions[1]?.sessionManager?.getSessionId(),
			rig.createOptions[0]?.sessionManager?.getSessionId(),
		);
		assert.ok((rig.subscriptions.get(2) ?? 0) > 0);
		// The session was told to detach calls running past the policy's threshold, once, before its first prompt.
		assert.deepEqual(names(rig.log, "setToolDetachment#"), [
			'setToolDetachment#1:{"afterMs":0}',
			'setToolDetachment#2:{"afterMs":0}',
		]);
	});

	test("a threshold of zero releases even a call that already has its result", async () => {
		const rig = makeRig({
			policy: { afterMs: 0 },
			detachOnPrompt: (number, text, ci) =>
				number === 1 && text === "go" ? [ci.call("c1", { settled: true })] : [],
		});

		await rig.ctx.prompt("go");

		assert.deepEqual(
			rig.log.filter((entry) => /^(enter|leave|rehydrated):/.test(entry)),
			["enter:tool", "leave:tool", "rehydrated:tool"],
		);
		assert.equal(rig.created(), 2);
	});

	test("a stage without a wait policy keeps the session while a call it was handed runs", async () => {
		const sessionId = "unused";
		void sessionId;
		const rig = makeRig({ policy: undefined, detachOnPrompt: detachingOne() });

		const turn = rig.ctx.prompt("go");
		await until(() => rig.ci.calls.has("c1"));
		// No policy: the session is never told to detach calls, and the stage never gives its session up.
		assert.equal(names(rig.log, "setToolDetachment#").length, 0);
		rig.ci.finish("c1");
		await turn;
		assert.equal(names(rig.log, "enter:").length, 0);
		assert.equal(rig.created(), 1);
	});
});

interface ResumedRigConfig extends Omit<RigConfig, "stageOptions" | "store"> {
	/** `undefined`: the transcript ends on no detachable turn; the method is absent from the session. */
	readonly pendingTurn?: boolean;
	/** The calls the reopened transcript ends on without a result. */
	readonly redispatch?: (ci: Ci) => DetachedToolCall[];
	/** The stage's durable replay key, under which the run keeps results its previous process recorded. */
	readonly durableReplayKey?: string;
}

/** A stage resumed over a stored session, as after the process that ran it died. */
async function makeResumedRig(
	config: ResumedRigConfig = {},
): Promise<Rig & { readonly queries: { pending: number; redispatched: number } }> {
	const store = new MemorySessionStore();
	const resumeFromSessionId = await persistedSession(store);
	const queries = { pending: 0, redispatched: 0 };
	const rig = makeRig({
		...config,
		store,
		stageOptions: {
			resumeFromSessionId,
			...(config.durableReplayKey === undefined ? {} : { durableReplayKey: config.durableReplayKey }),
		},
		customize: (number, log, ci) => ({
			...(config.pendingTurn === undefined
				? {}
				: {
						hasPendingDetachedTurn() {
							queries.pending += 1;
							return number === 1 && config.pendingTurn === true;
						},
					}),
			redispatchDetachedToolCalls() {
				queries.redispatched += 1;
				log.push(`redispatch#${number}`);
				return number === 1 ? (config.redispatch?.(ci) ?? []) : [];
			},
			...config.customize?.(number, log, ci),
		}),
	});
	return { ...rig, queries };
}

describe("a stage resumed on a transcript that ends on a detachable turn (#4309)", () => {
	test("calls without a result start again, wait past the threshold released, and the turn continues with no new prompt", async () => {
		const rig = await makeResumedRig({
			policy: { afterMs: 20 },
			pendingTurn: true,
			redispatch: (ci) => [ci.call("c1")],
		});
		const startedAt = Date.now();

		const turn = rig.ctx.prompt("the original prompt");
		await eventually(() => rig.log.includes("enter:tool"));

		assert.ok(Date.now() - startedAt >= 15, "the stage released before the threshold");
		assert.equal(rig.created(), 1);
		rig.ci.finish("c1");
		await turn;

		assert.deepEqual(names(rig.log, "prompt#"), []);
		assert.deepEqual(names(rig.log, "redispatch#"), ["redispatch#1"]);
		assert.deepEqual(names(rig.log, "resume#"), ["resume#2:c1"]);
		assert.equal(rig.created(), 2);
	});

	test("a call that finishes before the threshold is waited for inline: the session stays and no timer outlives the call", async () => {
		const timeoutsBefore = process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;
		const rig = await makeResumedRig({
			policy: { afterMs: 60_000 },
			pendingTurn: true,
			redispatch: (ci) => [ci.call("c1")],
		});

		const turn = rig.ctx.prompt("the original prompt");
		await until(() => rig.ci.calls.has("c1"));
		rig.ci.finish("c1");
		await turn;

		assert.equal(names(rig.log, "enter:").length, 0);
		assert.equal(rig.created(), 1);
		assert.deepEqual(names(rig.log, "resume#"), ["resume#1:c1"]);
		assert.ok(process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length <= timeoutsBefore);
	});

	test("a threshold of zero releases at once", async () => {
		const rig = await makeResumedRig({
			policy: { afterMs: 0 },
			pendingTurn: true,
			redispatch: (ci) => [ci.call("c1", { settled: true })],
		});

		await rig.ctx.prompt("the original prompt");

		assert.deepEqual(
			rig.log.filter((entry) => /^(enter|leave|rehydrated):/.test(entry)),
			["enter:tool", "leave:tool", "rehydrated:tool"],
		);
		assert.deepEqual(names(rig.log, "resume#"), ["resume#2:c1"]);
	});

	test("with no wait policy the stage keeps its session for the whole wait", async () => {
		const rig = await makeResumedRig({
			policy: undefined,
			pendingTurn: true,
			redispatch: (ci) => [ci.call("c1")],
		});

		const turn = rig.ctx.prompt("the original prompt");
		await until(() => rig.ci.calls.has("c1"));
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal((await settles(turn, 20)).done, false);
		rig.ci.finish("c1");
		await turn;

		assert.equal(names(rig.log, "enter:").length, 0);
		assert.equal(rig.created(), 1);
		assert.deepEqual(names(rig.log, "resume#"), ["resume#1:c1"]);
	});

	test("a stage with no wait hooks waits for the calls where it is", async () => {
		const rig = await makeResumedRig({
			noHooks: true,
			pendingTurn: true,
			redispatch: (ci) => [ci.call("c1")],
		});

		const turn = rig.ctx.prompt("the original prompt");
		await until(() => rig.ci.calls.has("c1"));
		rig.ci.finish("c1");
		await turn;

		assert.equal(rig.created(), 1);
		assert.deepEqual(names(rig.log, "resume#"), ["resume#1:c1"]);
	});

	test("aborting the run during a resident wait rejects the prompt with the reason and aborts the calls with it", async () => {
		const controller = new AbortController();
		const rig = await makeResumedRig({
			signal: controller.signal,
			policy: undefined,
			pendingTurn: true,
			redispatch: (ci) => [ci.call("c1"), ci.call("c2")],
		});
		const reason = new Error("workflow killed by the user");

		const turn = rig.ctx.prompt("the original prompt");
		await until(() => rig.ci.calls.has("c2"));
		controller.abort(reason);

		await assert.rejects(turn, (error) => error === reason);
		assert.deepEqual(rig.ci.aborts("c1"), [reason]);
		assert.deepEqual(rig.ci.aborts("c2"), [reason]);
		assert.deepEqual(names(rig.log, "resume#"), []);
	});

	test("a reason that is no Error or string aborts the calls with a workflow-killed abort", async () => {
		const controller = new AbortController();
		const rig = await makeResumedRig({
			signal: controller.signal,
			policy: undefined,
			pendingTurn: true,
			redispatch: (ci) => [ci.call("c1")],
		});

		const turn = rig.ctx.prompt("the original prompt");
		await until(() => rig.ci.calls.has("c1"));
		controller.abort(42);

		await assert.rejects(turn);
		const [reason] = rig.ci.aborts("c1");
		assert.ok(reason instanceof DOMException);
		assert.equal(reason.name, "AbortError");
		assert.equal(reason.message, "workflow killed");
	});

	test("a transcript whose calls all have results continues the turn at once, without starting a call or prompting", async () => {
		const rig = await makeResumedRig({ pendingTurn: true, redispatch: () => [] });

		await rig.ctx.prompt("the original prompt");

		assert.deepEqual(names(rig.log, "prompt#"), []);
		assert.deepEqual(names(rig.log, "resume#"), ["resume#1:"]);
		assert.equal(names(rig.log, "enter:").length, 0);
		assert.equal(rig.created(), 1);
	});

	test("a transcript that ends on no detachable turn takes the stage's prompt, and a session that cannot tell does too", async () => {
		for (const pendingTurn of [false, undefined]) {
			const rig = await makeResumedRig({ pendingTurn, redispatch: (ci) => [ci.call("never")] });

			await rig.ctx.prompt("the original prompt");

			assert.deepEqual(names(rig.log, "prompt#"), ["prompt#1:the original prompt"]);
			assert.deepEqual(names(rig.log, "resume#"), []);
			assert.deepEqual(names(rig.log, "redispatch#"), []);
		}
	});

	test("the transcript is examined once, on the first prompt only", async () => {
		const rig = await makeResumedRig({ pendingTurn: false });

		await rig.ctx.prompt("first");
		await rig.ctx.prompt("second");

		assert.equal(rig.queries.pending, 1);
		assert.deepEqual(names(rig.log, "prompt#"), ["prompt#1:first", "prompt#1:second"]);
	});

	test("a stage that was not resumed never looks for a detached turn", async () => {
		let asked = 0;
		const rig = makeRig({
			customize: () => ({
				hasPendingDetachedTurn() {
					asked += 1;
					return true;
				},
			}),
		});

		await rig.ctx.prompt("go");

		assert.equal(asked, 0);
		assert.deepEqual(names(rig.log, "prompt#"), ["prompt#1:go"]);
	});
});

const REPLAY_KEY = "task:implement:1";

/** A transcript that ends on an assistant turn calling the long tool with `toolCallIds`, none answered yet. */
function endsOnCalls(...toolCallIds: string[]): StageSessionRuntime["messages"] {
	return [
		{
			role: "assistant",
			content: toolCallIds.map((id) => ({ type: "toolCall", id, name: "wait_for_ci", arguments: {} })),
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
			timestamp: 0,
		},
	];
}

function recordedResult(toolCallId: string, text: string): DetachedToolResult {
	return {
		toolCallId,
		toolName: "wait_for_ci",
		result: { content: [{ type: "text", text }], details: undefined },
		isError: false,
	};
}

describe("a resumed stage whose previous process recorded the results it was woken with (#4309)", () => {
	test("continues the turn from the recorded results and starts no call again (#4309)", async () => {
		const continuedWith: DetachedToolResult[] = [];
		const rig = await makeResumedRig({
			pendingTurn: true,
			durableReplayKey: REPLAY_KEY,
			redispatch: (ci) => [ci.call("c1")],
			customize: (number) =>
				number === 1
					? {
							messages: endsOnCalls("c1"),
							async resumeDetachedTurn(results: readonly DetachedToolResult[]) {
								continuedWith.push(...results);
							},
						}
					: {},
		});
		rig.dispatcher.keepResultsForResume(REPLAY_KEY, [recordedResult("c1", "ci passed before the stop")]);

		await rig.ctx.prompt("the original prompt");

		assert.deepEqual(names(rig.log, "redispatch#"), []);
		assert.equal(rig.ci.calls.size, 0);
		assert.deepEqual(names(rig.log, "prompt#"), []);
		assert.deepEqual(
			continuedWith.map((result) => [result.toolCallId, result.result.content]),
			[["c1", [{ type: "text", text: "ci passed before the stop" }]]],
		);
		// The run hands recorded results out once.
		assert.equal(rig.dispatcher.takeResultsForResume(REPLAY_KEY), undefined);
	});

	test("starts the calls again when the recorded results do not answer every call the transcript waits on (#4309)", async () => {
		const rig = await makeResumedRig({
			policy: undefined,
			pendingTurn: true,
			durableReplayKey: REPLAY_KEY,
			redispatch: (ci) => [ci.call("c2", { settled: true })],
			customize: (number) => (number === 1 ? { messages: endsOnCalls("c2") } : {}),
		});
		rig.dispatcher.keepResultsForResume(REPLAY_KEY, [recordedResult("c1", "an earlier wait's result")]);

		await rig.ctx.prompt("the original prompt");

		assert.deepEqual(names(rig.log, "redispatch#"), ["redispatch#1"]);
		assert.deepEqual([...rig.ci.calls.keys()], ["c2"]);
		assert.deepEqual(names(rig.log, "resume#"), ["resume#1:c2"]);
	});
});

/** Starts the stage's one detaching prompt and returns once the stage has given its session up. */
async function waitingRig(config: RigConfig = {}): Promise<{ readonly rig: Rig; readonly turn: Promise<unknown> }> {
	const rig = makeRig({ detachOnPrompt: detachingOne(), ...config });
	const turn = rig.ctx.prompt("go");
	turn.catch(() => {});
	await until(() => rig.log.includes("enter:tool"));
	return { rig, turn };
}

describe("control of a stage while it waits released (#4309)", () => {
	test("input sent to a stage waiting on a tool is held whole, in order, and reaches the reopened session with its images and options before the turn continues (#4309)", async () => {
		const { rig, turn } = await waitingRig({
			customize: (number) =>
				number === 1 ? { clearQueue: () => ({ steering: ["queued steer"], followUp: ["queued follow-up"] }) } : {},
		});
		let notified = 0;
		let prepared = 0;

		const steered = await rig.ctx.__sendUserMessage(
			"steer text",
			{ deliverAs: "steer" },
			() => {
				notified += 1;
			},
			{
				beforePreparation: () => {
					prepared += 1;
				},
			},
		);
		const followed = await rig.ctx.__sendUserMessage([
			{ type: "text", text: "part one" },
			{ type: "image", data: "aGk=", mimeType: "image/png" },
			{ type: "text", text: "part two" },
		]);
		const expanded = await rig.ctx.__sendUserMessage("/skill:review", { expandPromptTemplates: true });
		await rig.ctx.steer("direct steer");
		await rig.ctx.followUp("direct follow-up");

		assert.equal(steered, "steer");
		assert.equal(followed, "followUp");
		assert.equal(expanded, "followUp");
		assert.equal(notified, 1);
		// The sender's own checks ran when the input was held, not when the stage woke.
		assert.equal(prepared, 1);
		assert.deepEqual(names(rig.log, "steer#2").concat(names(rig.log, "followUp#2")), []);
		rig.ci.finish("c1");
		await turn;

		const delivered = rig.log.filter((entry) => /^(steer|followUp|resume)#2/.test(entry));
		assert.deepEqual(delivered, [
			'steer#2:queued steer:{"expandPromptTemplates":false}',
			'followUp#2:queued follow-up:{"expandPromptTemplates":false}',
			'steer#2:steer text:{"expandPromptTemplates":false}',
			'followUp#2:part one\npart two:{"expandPromptTemplates":false}:images=[{"type":"image","data":"aGk=","mimeType":"image/png"}]',
			'followUp#2:/skill:review:{"expandPromptTemplates":true}',
			"steer#2:direct steer:undefined",
			"followUp#2:direct follow-up:undefined",
			"resume#2:c1",
		]);
		assert.deepEqual(names(rig.log, "steer#1").concat(names(rig.log, "followUp#1")), []);
	});

	test("a message to an idle stage that starts a turn carries a call that turn detached through its wait", async () => {
		const rig = makeRig({
			detachOnPrompt: (number, text, ci) => (number === 1 && text === "hello" ? [ci.call("c1")] : []),
		});

		const sent = rig.ctx.__sendUserMessage("hello");
		await until(() => rig.log.includes("enter:tool"));
		assert.equal((await settles(sent, 20)).done, false);
		rig.ci.finish("c1");

		assert.equal(await sent, "prompt");
		assert.deepEqual(names(rig.log, "resume#"), ["resume#2:c1"]);
	});

	test("a message that joins a running turn leaves the calls to that turn's own prompt", async () => {
		const rig = makeRig({
			customize: (number, _log, ci) => ({
				isStreaming: true,
				takeDetachedToolCalls: () => (number === 1 ? [ci.call("held-by-the-running-turn")] : []),
			}),
		});

		const sent = await settles(rig.ctx.__sendUserMessage("also this", { deliverAs: "steer" }), 200);

		assert.deepEqual(sent, { done: true, value: "steer" });
		assert.equal(names(rig.log, "enter:").length, 0);
	});

	test("a caller that needs the session while the stage waits gets the reopened one once the stage wakes", async () => {
		const { rig, turn } = await waitingRig();

		const model = rig.ctx.setModel({ id: "other-model" } as never);
		assert.equal((await settles(model, 30)).done, false);
		assert.equal(rig.created(), 1);
		rig.ci.finish("c1");
		await turn;
		await model;

		assert.deepEqual(names(rig.log, "setModel#"), ["setModel#2:other-model"]);
		assert.equal(rig.created(), 2);
	});

	test("a caller waiting for the session fails with the reason when the wait ends in an abort", async () => {
		const { rig, turn } = await waitingRig();
		const model = rig.ctx.setModel({ id: "other-model" } as never);
		model.catch(() => {});

		await rig.ctx.abort();

		const failure = await turn.then(
			() => undefined,
			(error: unknown) => error,
		);
		assert.ok(failure instanceof DOMException);
		assert.equal(failure.name, "AbortError");
		assert.equal(failure.message, "stage aborted");
		await assert.rejects(model, (error) => error === failure);
		assert.deepEqual(rig.ci.aborts("c1"), [failure]);
		assert.equal(rig.ctx.__isReleased?.(), false);
		assert.equal(rig.dispatcher.size, 0);
		assert.deepEqual(names(rig.log, "leave:"), []);
	});

	test("disposing a waiting stage ends its wait with the disposal and aborts the calls with it", async () => {
		const { rig, turn } = await waitingRig();

		await rig.ctx.__dispose();

		const failure = await turn.then(
			() => undefined,
			(error: unknown) => error,
		);
		assert.ok(failure instanceof Error);
		assert.match(failure.message, /session has been disposed/);
		assert.deepEqual(rig.ci.aborts("c1"), [failure]);
		assert.equal(rig.dispatcher.size, 0);
	});

	test("aborting the run ends the wait with the run's reason, drops the stage's own listener while it waits, and aborts the calls", async () => {
		const controller = new AbortController();
		const reason = new Error("run killed");
		const beforeStage = getEventListeners(controller.signal, "abort").length;
		const rig = makeRig({ signal: controller.signal, detachOnPrompt: detachingOne() });
		const dispatcherListener = 1;
		const turn = rig.ctx.prompt("go");
		turn.catch(() => {});
		await until(() => rig.log.includes("enter:tool"));

		// While it waits the stage holds no listener of its own on the run's signal; the dispatcher's one serves it.
		assert.equal(getEventListeners(controller.signal, "abort").length, beforeStage + dispatcherListener);
		controller.abort(reason);

		await assert.rejects(turn, (error) => error === reason);
		assert.deepEqual(rig.ci.aborts("c1"), [reason]);
		assert.equal(rig.ctx.__isReleased?.(), false);
	});

	test("a stage listens to the run's signal again once it is woken, and takes its listener off again at the end", async () => {
		const controller = new AbortController();
		const rig = makeRig({ signal: controller.signal, detachOnPrompt: detachingOne() });
		const idleListeners = getEventListeners(controller.signal, "abort").length;
		const turn = rig.ctx.prompt("go");
		await until(() => rig.log.includes("enter:tool"));
		const waitingListeners = getEventListeners(controller.signal, "abort").length;

		rig.ci.finish("c1");
		await turn;

		assert.equal(getEventListeners(controller.signal, "abort").length, idleListeners);
		assert.equal(waitingListeners, idleListeners - 1);
		await rig.ctx.__dispose();
		assert.equal(getEventListeners(controller.signal, "abort").length, idleListeners - 1);
	});

	test("a paused waiting stage reopens only once resumed, and takes the resume message as steering after what was held", async () => {
		const { rig, turn } = await waitingRig();
		await rig.ctx.__requestPause();
		await rig.ctx.steer("held while paused");

		rig.ci.finish("c1");
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(rig.created(), 1);
		assert.equal((await settles(turn, 20)).done, false);
		await rig.ctx.__resume("take care with the migration");
		await turn;

		assert.deepEqual(
			rig.log.filter((entry) => /^(steer|followUp)#2/.test(entry)),
			[
				"steer#2:held while paused:undefined",
				'steer#2:take care with the migration:{"expandPromptTemplates":false}',
			],
		);
	});

	test("a waiting stage resumed without a message reopens with nothing extra queued", async () => {
		const { rig, turn } = await waitingRig();
		await rig.ctx.__requestPause();
		rig.ci.finish("c1");

		await rig.ctx.__resume();
		await turn;

		assert.deepEqual(names(rig.log, "steer#2"), []);
		assert.deepEqual(names(rig.log, "followUp#2"), []);
		assert.deepEqual(names(rig.log, "resume#"), ["resume#2:c1"]);
	});
});

/** The session store's own failure while it is unreachable, as its adapter reports it. */
function storeUnavailable(): StorageUnavailableError {
	return new StorageUnavailableError(
		{ adapter: "libsql", location: "the shared session store" },
		Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
	);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => assert.fail("expected a rejection"),
		(thrown: unknown) => thrown,
	);
}

/** The hooks the stage called around its waits, in order. */
function waitHooks(log: readonly string[]): string[] {
	return log.filter((entry) => /^(enter|record|leave|reopenFailed|rehydrated):/.test(entry));
}

describe("reopening a released stage whose session store fails (#4309)", () => {
	test("a store failure is tried again after a backoff, and the same turn continues from one reopened session with the input it held (#4309)", async () => {
		const { rig, turn } = await waitingRig({
			failCreation: (number) => (number === 2 ? storeUnavailable() : undefined),
		});
		await rig.ctx.steer("held across the retry");
		rig.ci.finish("c1");
		await turn;

		assert.deepEqual(waitHooks(rig.log), [
			"enter:tool",
			"record:tool:c1",
			"leave:tool",
			"reopenFailed:tool",
			"leave:tool",
			"rehydrated:tool",
		]);
		// The first session, the attempt the store refused, and the reopened one.
		assert.equal(rig.created(), 3);
		assert.equal(rig.ci.calls.size, 1);
		assert.deepEqual(
			rig.log.filter((entry) => /^(steer|resume)#3/.test(entry)),
			["steer#3:held across the retry:undefined", "resume#3:c1"],
		);
		assert.equal(rig.ctx.__isReleased?.(), false);
	});

	test("a store still unreachable after the last attempt ends the reopening with a typed, retryable StageRehydrationError (#4309)", async () => {
		const failures: StorageUnavailableError[] = [];
		const { rig, turn } = await waitingRig({
			failCreation: (number) => {
				if (number === 1) return undefined;
				const failure = storeUnavailable();
				failures.push(failure);
				return failure;
			},
		});
		const caller = rig.ctx.setModel({ id: "other-model" } as never);
		caller.catch(() => {});
		rig.ci.finish("c1");

		const error = await rejection(turn);

		assert.ok(error instanceof StageRehydrationError);
		assert.ok(isStageRehydrationError(error) && isRetryableWorkflowError(error));
		assert.equal(error.code, "session-unavailable");
		assert.equal(error.retryable, true);
		assert.equal(failures.length, STAGE_WAIT_RETRY_ATTEMPTS);
		assert.equal(error.cause, failures.at(-1));
		const { elapsedMs, ...fields } = error.fields;
		assert.deepEqual(fields, {
			runId: RUN_ID,
			stageId: STAGE_ID,
			stageName: STAGE_NAME,
			sessionId: rig.createOptions[0]?.sessionManager?.getSessionId(),
			phase: "reopen",
			attempts: STAGE_WAIT_RETRY_ATTEMPTS,
			timeoutMs: STAGE_WAIT_RETRY_BUDGET_MS,
		});
		assert.ok(typeof elapsedMs === "number" && elapsedMs > 0);
		assert.equal(names(rig.log, "leave:").length, STAGE_WAIT_RETRY_ATTEMPTS);
		assert.equal(names(rig.log, "reopenFailed:").length, STAGE_WAIT_RETRY_ATTEMPTS);
		assert.deepEqual(names(rig.log, "rehydrated:"), []);
		// A caller that waited for the session learns why it never came.
		await assert.rejects(caller, (thrown) => thrown === error);
	});

	test("a session the store does not hold ends the reopening at once with session-not-found (#4309)", async () => {
		const missing = new SessionNotFoundError("session-gone");
		const { rig, turn } = await waitingRig({ failCreation: (number) => (number === 2 ? missing : undefined) });
		rig.ci.finish("c1");

		const error = await rejection(turn);

		assert.ok(isStageRehydrationError(error));
		assert.equal(error.code, "session-not-found");
		assert.equal(error.retryable, false);
		assert.equal(error.cause, missing);
		assert.equal(rig.created(), 2);
		assert.deepEqual(names(rig.log, "reopenFailed:"), ["reopenFailed:tool"]);
	});

	test("a failure that is not the store's, such as a missing credential, ends the reopening at once as that same error (#4309)", async () => {
		const failure = new Error("No API key found for provider faux");
		const { rig, turn } = await waitingRig({ failCreation: (number) => (number === 2 ? failure : undefined) });
		const caller = rig.ctx.setModel({ id: "other-model" } as never);
		caller.catch(() => {});
		rig.ci.finish("c1");

		assert.equal(await rejection(turn), failure);
		assert.equal(findStageWaitError(failure), undefined);
		assert.equal(rig.created(), 2);
		await assert.rejects(caller, (thrown) => thrown === failure);
	});

	test("aborting the run while the stage waits to try again ends the reopening with the run's reason (#4309)", async () => {
		const controller = new AbortController();
		const reason = new Error("run killed");
		const { rig, turn } = await waitingRig({
			signal: controller.signal,
			failCreation: (number) => (number === 1 ? undefined : storeUnavailable()),
		});
		rig.ci.finish("c1");
		await until(() => rig.log.includes("reopenFailed:tool"));

		controller.abort(reason);

		assert.equal(await rejection(turn), reason);
		assert.equal(rig.created(), 2);
	});

	test("a failure while the run is aborting reports the run's reason, not a rehydration error (#4309)", async () => {
		const controller = new AbortController();
		const reason = new Error("run killed");
		const { rig, turn } = await waitingRig({
			signal: controller.signal,
			onCreate: (number) => {
				if (number === 2) controller.abort(reason);
			},
			failCreation: (number) => (number === 2 ? storeUnavailable() : undefined),
		});
		rig.ci.finish("c1");

		const error = await rejection(turn);

		assert.equal(error, reason);
		assert.equal(findStageWaitError(error), undefined);
	});

	test("a paused stage does not try to reopen again until it is resumed (#4309)", async () => {
		const { rig, turn } = await waitingRig({
			failCreation: (number) => (number === 2 ? storeUnavailable() : undefined),
		});
		rig.ci.finish("c1");
		await until(() => rig.log.includes("reopenFailed:tool"));
		await rig.ctx.__requestPause();

		await new Promise((resolve) => setTimeout(resolve, STAGE_WAIT_RETRY_BUDGET_MS / 2));
		assert.equal(rig.created(), 2);
		await rig.ctx.__resume();
		await turn;

		assert.equal(rig.created(), 3);
		assert.deepEqual(names(rig.log, "resume#"), ["resume#3:c1"]);
	});
});

/** A session the runner recognizes as a real `AgentSession`, whose manager says whether its transcript is stored. */
function agentLike(persisted: boolean): Partial<StageSessionRuntime> {
	return {
		state: {},
		sessionManager: { isPersisted: () => persisted },
		modelRuntime: {},
		getContextUsage: () => undefined,
	} as unknown as Partial<StageSessionRuntime>;
}

describe("explicit stage.release() and stage.rehydrate() on the runner (#4309)", () => {
	test("a released stage holds no session, waits as a release with the dispatcher, and the next prompt reopens its session", async () => {
		const rig = makeRig();
		await rig.ctx.prompt("first");
		assert.equal(rig.subscriptions.get(1) !== 0, true);

		await rig.ctx.release();

		assert.equal(rig.subscriptions.get(1), 0);
		assert.deepEqual(names(rig.log, "dispose#"), ["dispose#1"]);
		assert.equal(rig.ctx.__isReleased?.(), true);
		assert.deepEqual(
			rig.dispatcher.entries().map((entry) => [entry.runId, entry.stageId, entry.reason, entry.wakeKey]),
			[[RUN_ID, STAGE_ID, "release", stageWakeKey(RUN_ID, STAGE_ID)]],
		);
		await rig.ctx.release();
		assert.deepEqual(names(rig.log, "enter:"), ["enter:release"]);

		await rig.ctx.prompt("second");

		assert.equal(rig.ctx.__isReleased?.(), false);
		assert.equal(rig.dispatcher.size, 0);
		assert.deepEqual(
			rig.log.filter((entry) => /^(enter|leave|rehydrated):/.test(entry)),
			["enter:release", "leave:release", "rehydrated:release"],
		);
		assert.deepEqual(names(rig.log, "prompt#"), ["prompt#1:first", "prompt#2:second"]);
	});

	test("rehydrate reopens a released stage once however many callers ask, and does nothing for a stage that holds its session", async () => {
		const rig = makeRig();
		await rig.ctx.rehydrate();
		assert.equal(rig.created(), 0);
		await rig.ctx.prompt("first");
		await rig.ctx.rehydrate();
		assert.equal(rig.created(), 1);
		await rig.ctx.release();

		await Promise.all([rig.ctx.rehydrate(), rig.ctx.rehydrate(), rig.ctx.rehydrate()]);

		assert.equal(rig.created(), 2);
		assert.deepEqual(names(rig.log, "leave:"), ["leave:release"]);
		assert.deepEqual(names(rig.log, "rehydrated:"), ["rehydrated:release"]);
		assert.equal(rig.ctx.__isReleased?.(), false);
		await rig.ctx.rehydrate();
		assert.equal(rig.created(), 2);
	});

	test("a message that is not text held for a wait reaches a released stage as it reopens: it is delivered, not held", async () => {
		const rig = makeRig();
		await rig.ctx.prompt("first");
		await rig.ctx.release();

		await rig.ctx.steer("after the release");
		await rig.ctx.release();
		await rig.ctx.followUp("and again");

		assert.deepEqual(
			rig.log.filter((entry) => /^(steer|followUp)#/.test(entry)),
			["steer#2:after the release:undefined", "followUp#3:and again:undefined"],
		);
	});

	test("reopening a released stage by session id reopens its own session, whatever id was named", async () => {
		const rig = makeRig();
		await rig.ctx.prompt("first");
		await rig.ctx.release();

		await rig.ctx.__ensureSessionFromId("some-other-session");

		assert.equal(rig.created(), 2);
		assert.equal(
			rig.createOptions[1]?.sessionManager?.getSessionId(),
			rig.createOptions[0]?.sessionManager?.getSessionId(),
		);
	});

	test("a stage with nothing to release, or already disposed, releases nothing", async () => {
		const rig = makeRig();
		await rig.ctx.release();
		assert.equal(rig.created(), 0);
		assert.deepEqual(names(rig.log, "enter:"), []);
		await rig.ctx.prompt("first");

		await rig.ctx.__dispose();
		await rig.ctx.release();

		assert.deepEqual(names(rig.log, "enter:"), []);
		assert.equal(rig.dispatcher.size, 0);
	});

	test("a stage whose session is still streaming refuses to release and keeps its session", async () => {
		const rig = makeRig({ customize: () => ({ isStreaming: true }) });
		await rig.ctx.prompt("first");

		await assert.rejects(rig.ctx.release(), (error: unknown) => {
			assert.ok(error instanceof StageReleaseError);
			assert.equal(error.code, "stage-busy");
			assert.equal(error.fields.sessionId, rig.createOptions[0]?.sessionManager?.getSessionId());
			return true;
		});
		assert.deepEqual(names(rig.log, "dispose#"), []);
		assert.equal(rig.ctx.__isReleased?.(), false);
	});

	test("a session no store can reopen refuses to release, naming the stage and session, and is left as it was", async () => {
		const rig = makeRig({ withStore: false });
		await rig.ctx.prompt("first");

		await assert.rejects(rig.ctx.release(), (error: unknown) => {
			assert.ok(isStageReleaseError(error));
			assert.equal(error.code, "not-reopenable");
			assert.deepEqual(error.fields, {
				runId: RUN_ID,
				stageId: STAGE_ID,
				stageName: STAGE_NAME,
				sessionId: "session-1",
			});
			return true;
		});
		assert.deepEqual(names(rig.log, "dispose#"), []);
		assert.equal(rig.subscriptions.get(1) !== 0, true);
	});

	test("a stage without wait hooks cannot release even over a store", async () => {
		const rig = makeRig({ noHooks: true });
		await rig.ctx.prompt("first");

		await assert.rejects(
			rig.ctx.release(),
			(error: unknown) => isStageReleaseError(error) && error.code === "not-reopenable",
		);

		assert.deepEqual(names(rig.log, "dispose#"), []);
	});

	test("a persisted AgentSession releases without a caller-owned store, and one that is not persisted refuses", async () => {
		const persisted = makeRig({ withStore: false, customize: () => agentLike(true) });
		await persisted.ctx.prompt("first");
		await persisted.ctx.release();
		assert.equal(persisted.ctx.__isReleased?.(), true);

		const ephemeral = makeRig({ withStore: false, customize: () => agentLike(false) });
		await ephemeral.ctx.prompt("first");
		await assert.rejects(
			ephemeral.ctx.release(),
			(error: unknown) => isStageReleaseError(error) && error.code === "not-reopenable",
		);
	});

	test("aborting a stage released between prompts does not fail the dispatcher's entry for it", async () => {
		const rig = makeRig();
		await rig.ctx.prompt("first");
		await rig.ctx.release();

		await rig.ctx.abort();

		const parked = rig.dispatcher.park(stageWakeKey(RUN_ID, STAGE_ID), "tool-results");
		assert.equal((await settles(parked, 20)).done, false);
	});
});

/** A rig whose first session's disposal waits for `disposing`, as a session store that is slow to close it. */
function slowDisposalRig(disposing: Promise<void>, config: RigConfig = {}): Rig {
	return makeRig({
		...config,
		customize: (number, log) =>
			number === 1
				? {
						dispose() {
							log.push("dispose#1");
							return disposing;
						},
					}
				: {},
	});
}

/** Sessions created and not disposed. */
function liveSessions(rig: Rig): number {
	return rig.created() - names(rig.log, "dispose#").length;
}

async function settleTicks(rounds = 20): Promise<void> {
	for (let round = 0; round < rounds; round++) await new Promise((resolve) => setImmediate(resolve));
}

describe("a release and a reopening that race (#4309)", () => {
	test("a message sent while release() is still disposing the session reaches the stage after the release, which ends live and running, never waiting with a live session (#4309)", async () => {
		const disposing = Promise.withResolvers<void>();
		const rig = slowDisposalRig(disposing.promise);
		await rig.ctx.prompt("first");

		const released = rig.ctx.release();
		const sent = rig.ctx.__sendUserMessage("next");
		await settleTicks();
		// The message joins the release under way instead of reopening the stage in the middle of it.
		assert.equal(rig.created(), 1);
		assert.deepEqual(names(rig.log, "enter:"), []);
		disposing.resolve();
		await Promise.all([released, sent]);

		assert.deepEqual(waitHooks(rig.log), ["enter:release", "leave:release", "rehydrated:release"]);
		assert.equal(rig.ctx.__isReleased?.(), false);
		assert.equal(liveSessions(rig), 1);
		assert.equal(rig.dispatcher.size, 0);
		assert.deepEqual(names(rig.log, "prompt#"), ["prompt#1:first", "prompt#2:next"]);
	});

	test("rehydrate() called while release() is still disposing the session reopens it once the release is done (#4309)", async () => {
		const disposing = Promise.withResolvers<void>();
		const rig = slowDisposalRig(disposing.promise);
		await rig.ctx.prompt("first");

		const released = rig.ctx.release();
		const rehydrated = rig.ctx.rehydrate();
		await settleTicks();
		assert.equal(rig.created(), 1);
		disposing.resolve();
		await Promise.all([released, rehydrated]);

		assert.deepEqual(waitHooks(rig.log), ["enter:release", "leave:release", "rehydrated:release"]);
		assert.equal(rig.ctx.__isReleased?.(), false);
		assert.equal(liveSessions(rig), 1);
	});

	test("a message sent while the idle scan is still releasing the stage reaches it after the release, never leaving it waiting with a live session (#4309)", async () => {
		const IDLE_THRESHOLD_MS = 1_000;
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const releaser = new StageIdleReleaser((key, error) => assert.fail(`${key} could not release: ${String(error)}`));
		try {
			const disposing = Promise.withResolvers<void>();
			const rig = slowDisposalRig(disposing.promise, { policy: { afterMs: IDLE_THRESHOLD_MS } });
			await rig.ctx.prompt("first");
			releaser.watch("stage", {
				afterMs: IDLE_THRESHOLD_MS,
				idleSince: () => rig.ctx.__idleSince?.(),
				release: async () => {
					await rig.ctx.__releaseIdle?.();
				},
			});

			await vi.advanceTimersByTimeAsync(IDLE_THRESHOLD_MS);
			assert.deepEqual(names(rig.log, "dispose#"), ["dispose#1"]);
			const sent = rig.ctx.__sendUserMessage("next");
			await settleTicks();
			assert.equal(rig.created(), 1);
			disposing.resolve();
			await sent;

			assert.deepEqual(waitHooks(rig.log), ["enter:idle", "leave:idle", "rehydrated:idle"]);
			assert.equal(rig.ctx.__isReleased?.(), false);
			assert.equal(liveSessions(rig), 1);
			assert.deepEqual(names(rig.log, "prompt#"), ["prompt#1:first", "prompt#2:next"]);
		} finally {
			releaser.dispose();
			vi.useRealTimers();
		}
	});
});

describe("which sessions are told to detach long calls (#4309)", () => {
	test("a stage with a policy over a store tells its session the policy, and reports nothing", async () => {
		const rig = makeRig({ policy: { afterMs: 1234 } });

		await rig.ctx.prompt("go");

		assert.deepEqual(names(rig.log, "setToolDetachment#"), ['setToolDetachment#1:{"afterMs":1234}']);
		assert.deepEqual(rig.residents, []);
	});

	test("a session no store can reopen is not told to detach, and the stage reports once why it stays resident", async () => {
		const rig = makeRig({ withStore: false, policy: { afterMs: 1234 } });

		await rig.ctx.prompt("go");

		assert.deepEqual(names(rig.log, "setToolDetachment#"), []);
		assert.equal(rig.residents.length, 1);
		const [reason] = rig.residents;
		assert.ok(reason instanceof StageReleaseError);
		assert.equal(reason.code, "not-reopenable");
		assert.deepEqual(reason.fields, {
			runId: RUN_ID,
			stageId: STAGE_ID,
			stageName: STAGE_NAME,
			sessionId: "session-1",
		});
	});

	test("a stage without a wait policy never tells its session to detach and reports nothing", async () => {
		const rig = makeRig({ policy: undefined });

		await rig.ctx.prompt("go");

		assert.deepEqual(names(rig.log, "setToolDetachment#"), []);
		assert.deepEqual(rig.residents, []);
	});

	test("a session that cannot detach calls is left alone, with no report", async () => {
		const rig = makeRig({ customize: () => ({ setToolDetachment: undefined }) });

		await rig.ctx.prompt("go");

		assert.deepEqual(names(rig.log, "setToolDetachment#"), []);
		assert.deepEqual(rig.residents, []);
	});

	test("a persisted AgentSession is told the policy, and one that is not is reported as resident", async () => {
		const persisted = makeRig({ withStore: false, customize: () => agentLike(true) });
		await persisted.ctx.prompt("go");
		assert.deepEqual(names(persisted.log, "setToolDetachment#"), ['setToolDetachment#1:{"afterMs":0}']);
		assert.deepEqual(persisted.residents, []);

		const ephemeral = makeRig({ withStore: false, customize: () => agentLike(false) });
		await ephemeral.ctx.prompt("go");
		assert.deepEqual(names(ephemeral.log, "setToolDetachment#"), []);
		assert.equal(ephemeral.residents.length, 1);
	});

	test("a session no store can reopen that hands back a call is waited on where it is", async () => {
		let handedBack = false;
		const rig = makeRig({
			withStore: false,
			customize: (_number, _log, ci) => ({
				takeDetachedToolCalls: () => {
					if (handedBack) return [];
					handedBack = true;
					return [ci.call("c1")];
				},
			}),
		});

		const turn = rig.ctx.prompt("go");
		await until(() => rig.ci.calls.has("c1"));
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.deepEqual(names(rig.log, "enter:"), []);
		rig.ci.finish("c1");
		await turn;

		assert.equal(rig.created(), 1);
		assert.deepEqual(names(rig.log, "resume#"), ["resume#1:c1"]);
	});
});

describe("how a stage reports starting a session (#4309)", () => {
	test("a startup phase an adapter reports while creating the session is observed, and one from a creation the stage abandoned is not", async () => {
		let report: ((phase: StageStartupPhase) => void) | undefined;
		const rig = makeRig({
			onCreate: async (_number, reportStartupPhase, ctx) => {
				report = reportStartupPhase;
				reportStartupPhase("sdk-creation");
				await ctx().abort();
				reportStartupPhase("extension-binding");
			},
		});

		await rig.ctx.prompt("go").catch(() => {});

		const phases = rig.startups.map((snapshot) => snapshot.phase);
		assert.ok(phases.includes("sdk-creation"));
		assert.equal(phases.includes("extension-binding"), false);
		assert.ok(report !== undefined);
	});
});

describe("the runner's other paths around a waiting stage (#4309)", () => {
	test("a stage given no options prompts, and is not asked for a detached turn", async () => {
		const rig = makeRig({ bare: true, withStore: false });

		await rig.ctx.prompt("go");

		assert.deepEqual(names(rig.log, "prompt#"), ["prompt#1:go"]);
	});

	test("text sent to a stage that holds its session reaches that session at once", async () => {
		const rig = makeRig();
		await rig.ctx.prompt("first");

		await rig.ctx.steer("now");
		await rig.ctx.followUp("later");

		assert.deepEqual(
			rig.log.filter((entry) => /^(steer|followUp)#/.test(entry)),
			["steer#1:now:undefined", "followUp#1:later:undefined"],
		);
	});

	test("a stage that was never given a session reopens the stored session it is named", async () => {
		const store = new MemorySessionStore();
		const sessionId = await persistedSession(store);
		let closed = 0;
		const rig = makeRig({
			store,
			customize: () => ({
				async closeWorkflowStageGeneration() {
					closed += 1;
				},
			}),
		});

		await rig.ctx.__ensureSessionFromId(sessionId);

		assert.equal(rig.created(), 1);
		assert.equal(rig.createOptions[0]?.sessionManager?.getSessionId(), sessionId);
		// A session reopened by id is an archived transcript: its generation ends with the reopening.
		assert.equal(closed, 1);
	});

	test("a stage with no wait hooks that is handed a call by its session waits for it where it is", async () => {
		const rig = makeRig({ noHooks: true, detachOnPrompt: detachingOne() });

		const turn = rig.ctx.prompt("go");
		await until(() => rig.ci.calls.has("c1"));
		rig.ci.finish("c1");
		await turn;

		assert.equal(rig.created(), 1);
		assert.deepEqual(names(rig.log, "resume#"), ["resume#1:c1"]);
	});

	test("a wait that is cancelled with a text reason fails with that text and aborts the calls with it", async () => {
		const { rig, turn } = await waitingRig();

		rig.dispatcher.cancel(stageWakeKey(RUN_ID, STAGE_ID), "closed by the host");

		await assert.rejects(turn, (error) => error === "closed by the host");
		assert.deepEqual(rig.ci.aborts("c1"), ["closed by the host"]);
	});

	test("a wait that fails with something that is no error aborts the calls with a workflow-killed abort", async () => {
		const rig = makeRig({ detachOnPrompt: detachingOne(), enterFails: 42 });

		await assert.rejects(rig.ctx.prompt("go"), (error) => error === 42);

		const [reason] = rig.ci.aborts("c1");
		assert.ok(reason instanceof DOMException);
		assert.equal(reason.name, "AbortError");
		assert.equal(reason.message, "workflow killed");
		assert.equal(rig.ctx.__isReleased?.(), false);
	});

	test("a call result goes to a session that cannot record results as the continuation prompt", async () => {
		const rig = makeRig({ detachOnPrompt: detachingOne(), customize: () => ({ resumeDetachedTurn: undefined }) });

		const turn = rig.ctx.prompt("go");
		await until(() => rig.log.includes("enter:tool"));
		rig.ci.finish("c1");
		await turn;

		assert.deepEqual(names(rig.log, "prompt#"), ["prompt#1:go", `prompt#2:${RESUME_CONTINUATION_PROMPT}`]);
	});

	test("a session that cannot start calls again continues an answered turn without any", async () => {
		const rig = await makeResumedRig({
			pendingTurn: true,
			customize: () => ({ redispatchDetachedToolCalls: undefined }),
		});

		await rig.ctx.prompt("the original prompt");

		assert.deepEqual(names(rig.log, "resume#"), ["resume#1:"]);
		assert.deepEqual(names(rig.log, "prompt#"), []);
	});

	test("a pause that lands as the woken turn is about to continue holds it, and a resume without a message then continues it", async () => {
		const { rig, turn } = await waitingRig({
			onCreate: (number, _report, ctx) => {
				if (number === 2) void ctx().__requestPause();
			},
		});
		rig.ci.finish("c1");
		await until(() => rig.created() === 2);
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal((await settles(turn, 20)).done, false);
		assert.deepEqual(names(rig.log, "resume#"), []);

		await rig.ctx.__resume();
		await turn;

		assert.deepEqual(names(rig.log, "resume#"), ["resume#2:c1"]);
		assert.deepEqual(names(rig.log, "prompt#"), ["prompt#1:go"]);
	});

	test("a resume message sent to such a turn reaches it as steering, with templates off, ahead of the call results", async () => {
		const { rig, turn } = await waitingRig({
			onCreate: (number, _report, ctx) => {
				if (number === 2) void ctx().__requestPause();
			},
		});
		rig.ci.finish("c1");
		await until(() => rig.created() === 2);
		await new Promise((resolve) => setTimeout(resolve, 30));

		await rig.ctx.__resume("mind the schema");
		await turn;

		assert.deepEqual(
			rig.log.filter((entry) => /^(steer|resume|prompt)#2/.test(entry)),
			['steer#2:mind the schema:{"expandPromptTemplates":false}', "resume#2:c1"],
		);
	});
});

describe("the output artifact of each generation (#4309)", () => {
	test("a prompt's output file holds only the answers of that prompt, however many a stage gave before", async () => {
		const directory = mkdtempSync(join(tmpdir(), "waiting-stage-artifact-"));
		try {
			const messages: StageSessionRuntime["messages"] = [];
			const rig = makeRig({
				stageOptions: { cwd: directory },
				customize: () => ({
					messages,
					async prompt(text: string) {
						messages.push({
							role: "assistant",
							content: [{ type: "text", text: `answer to ${text}` }],
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
							stopReason: "stop",
							timestamp: 0,
						});
					},
				}),
			});

			await rig.ctx.prompt("one", { output: "one.md" });
			await rig.ctx.prompt("two", { output: "two.md" });

			// The runner adds its artifact instruction to the prompt text, which the scripted model echoes back.
			const first = readFileSync(join(directory, "one.md"), "utf8");
			const second = readFileSync(join(directory, "two.md"), "utf8");
			assert.ok(first.startsWith("answer to one"));
			assert.ok(second.startsWith("answer to two"));
			assert.equal(second.includes("answer to one"), false);
			assert.equal(second.includes("## Supplement"), false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
