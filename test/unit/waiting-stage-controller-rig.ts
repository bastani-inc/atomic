import assert from "node:assert/strict";
import { type DetachedToolCall, type DetachedToolResult, SessionManager } from "@bastani/atomic";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import type { StageAdapters } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import type { StageWaitHooks } from "../../packages/workflows/src/runs/foreground/stage-runner-types.js";
import {
	StageWakeDispatcher,
	stageWakeKey,
} from "../../packages/workflows/src/runs/foreground/stage-wake-dispatcher.js";
import type { StageWaitSnapshot } from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import type { StageStartupPhase, StageStartupSnapshot } from "../../packages/workflows/src/shared/stage-startup.js";
import type { StageReleaseError } from "../../packages/workflows/src/shared/stage-wait-errors.js";
import type { StageOptions } from "../../packages/workflows/src/shared/types.js";
import {
	createStageContext,
	type InternalStageContext,
	makeMockSession,
	makeOpts,
	type StageSessionCreateOptions,
	type StageSessionRuntime,
} from "./stage-runner-helpers.js";

/**
 * The rig of the waiting-stage controller tests: one stage runner over fake sessions, a fake long tool, the run's wake
 * dispatcher and recording wait hooks. Shared by the controller test files so each can stay about one concern.
 */

export const RUN_ID = "run-controller";
export const STAGE_ID = "stage-controller";
export const STAGE_NAME = "implement";
/** What a fake session may be given on top of the runner's session surface. */
export type FakeSessionFields = Partial<StageSessionRuntime> & {
	clearQueue?: () => { steering: string[]; followUp: string[] };
};

export async function until(predicate: () => boolean): Promise<void> {
	for (let round = 0; round < 2_000 && !predicate(); round++) await new Promise((resolve) => setImmediate(resolve));
	assert.ok(predicate(), "condition never held");
}

/** The fake long tool: one call per id, finished (or failed) only by the test; records what aborted it and why. */
export class Ci {
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

export interface RigConfig {
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
	/** Holds the `rehydrated` hook, after it is logged, until this settles. */
	readonly rehydratedGate?: Promise<void>;
	/** Runs inside the adapter's `create`, before the session is built, with the stage's startup reporter. */
	readonly onCreate?: (
		sessionNumber: number,
		reportStartupPhase: (phase: StageStartupPhase) => void,
		ctx: () => InternalStageContext,
	) => Promise<void> | void;
}

export interface Rig {
	readonly ctx: InternalStageContext;
	/** Hooks, session creations and everything a session did, in the order it happened. */
	readonly log: string[];
	readonly ci: Ci;
	readonly dispatcher: StageWakeDispatcher;
	readonly store: MemorySessionStore;
	readonly residents: StageReleaseError[];
	readonly createOptions: StageSessionCreateOptions[];
	/** Each wait the stage entered, as the hook was given it. */
	readonly waits: StageWaitSnapshot[];
	/** Startup snapshots the stage reported, in order. */
	readonly startups: StageStartupSnapshot[];
	/** Subscriptions each session still holds, by session number. */
	readonly subscriptions: Map<number, number>;
	created(): number;
}

export function imagesNote(images: readonly object[] | undefined): string {
	return images === undefined ? "" : `:images=${JSON.stringify(images)}`;
}

export function names(log: readonly string[], prefix: string): string[] {
	return log.filter((entry) => entry.startsWith(prefix));
}

export function makeRig(config: RigConfig = {}): Rig {
	const log: string[] = [];
	const ci = new Ci();
	const store = config.store ?? new MemorySessionStore();
	const residents: StageReleaseError[] = [];
	const waits: StageWaitSnapshot[] = [];
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
			waits.push(wait);
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
			await config.rehydratedGate;
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
		waits,
		startups,
		subscriptions,
		created: () => created,
	};
}

/** Starts a prompt that detaches one call `c1` and waits until the stage reached the wait (or ran on resident). */
export function detachingOne(): NonNullable<RigConfig["detachOnPrompt"]> {
	return (number, text, ci) => (number === 1 && text === "go" ? [ci.call("c1")] : []);
}

export async function persistedSession(store: MemorySessionStore): Promise<string> {
	const manager = await SessionManager.create(store, process.cwd());
	return manager.getSessionId();
}

export interface ResumedRigConfig extends Omit<RigConfig, "stageOptions" | "store"> {
	/** `undefined`: the transcript ends on no detachable turn; the method is absent from the session. */
	readonly pendingTurn?: boolean;
	/** The calls the reopened transcript ends on without a result. */
	readonly redispatch?: (ci: Ci) => DetachedToolCall[];
	/** The stage's durable replay key, under which the run keeps results its previous process recorded. */
	readonly durableReplayKey?: string;
}

/** A stage resumed over a stored session, as after the process that ran it died. */
export async function makeResumedRig(
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

export const REPLAY_KEY = "task:implement:1";

/** A transcript that ends on an assistant turn calling the long tool with `toolCallIds`, none answered yet. */
export function endsOnCalls(...toolCallIds: string[]): StageSessionRuntime["messages"] {
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

export function recordedResult(toolCallId: string, text: string): DetachedToolResult {
	return {
		toolCallId,
		toolName: "wait_for_ci",
		result: { content: [{ type: "text", text }], details: undefined },
		isError: false,
	};
}

export function storeUnavailable(): StorageUnavailableError {
	return new StorageUnavailableError(
		{ adapter: "libsql", location: "the shared session store" },
		Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
	);
}

export async function rejection(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => assert.fail("expected a rejection"),
		(thrown: unknown) => thrown,
	);
}

/** The hooks the stage called around its waits, in order. */
export function waitHooks(log: readonly string[]): string[] {
	return log.filter((entry) => /^(enter|record|leave|reopenFailed|rehydrated):/.test(entry));
}
