import type { DetachedToolCall, DetachedToolResult, ReleasedAgentSession } from "@bastani/atomic";
import { StageWakeError } from "../../shared/stage-wait-errors.js";
import { isStageWakeKindRegistered, type StageWake, type StageWakeDelivery } from "../../shared/stage-wake.js";
import type { StageEvictionState } from "./stage-runner-types.js";
import {
	type EvictedToolWait,
	type PendingStageWakes,
	routeStageWakes,
	type StageToolWait,
	type StageWaitHandoff,
	type StageWakeRoute,
	unrouteStageWakes,
} from "./stage-wake-dispatcher.js";

/** A live stage as its run's eviction sees it. */
export interface ResidentStage {
	evictionState(): StageEvictionState;
	/** What the stage waits on, released: its detached calls and the session it gave up; undefined unless it does. */
	waitingOn(): StageToolWait | undefined;
	/** The run is evicted: let go of everything outside the run that still names the stage. */
	evict(): void;
}

/** The most often a run that stays busy beside its waiting stages is checked again for eviction. */
export const EVICTION_RECHECK_MS = 1_000;

/**
 * What a run's eviction check found: `evicted`; `busy`, something besides stages waiting on detached calls runs, so
 * the run is checked again; or `settled`, nothing to evict until a stage waits again.
 */
export type RunEvictionCheck = "evicted" | "busy" | "settled";

/**
 * The live stages of one run that may be evicted while it waits. Each time a stage starts or ends a wait or a call, one
 * quiet period of `afterMs` starts again; when it ends, `onQuiet` checks the run. A run found busy is checked again
 * after `afterMs`, or {@link EVICTION_RECHECK_MS} when that is longer, until it is evicted or settles.
 */
export class RunStageResidency {
	private readonly stages = new Map<string, ResidentStage>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private readonly afterMs: number;
	private readonly onQuiet: (residency: RunStageResidency) => RunEvictionCheck;

	constructor(afterMs: number, onQuiet: (residency: RunStageResidency) => RunEvictionCheck) {
		this.afterMs = afterMs;
		this.onQuiet = onQuiet;
	}

	add(stageId: string, stage: ResidentStage): void {
		this.stages.set(stageId, stage);
	}

	/** A stage started or ended a wait or a call: the run's quiet period starts again. */
	changed(): void {
		this.arm(this.afterMs);
	}

	private arm(delayMs: number): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (this.onQuiet(this) === "busy") this.arm(Math.max(this.afterMs, EVICTION_RECHECK_MS));
		}, delayMs);
		this.timer.unref();
	}

	/**
	 * What the run's stages wait on: `tools` while every stage waits, released, on detached calls or holds nothing and at
	 * least one waits on calls; `busy` while a stage does anything else; `none` while every stage holds nothing.
	 */
	waits(): "tools" | "busy" | "none" {
		let waiting = false;
		for (const stage of this.stages.values()) {
			const state = stage.evictionState();
			if (state === "busy") return "busy";
			if (state === "waiting-on-tool") waiting = true;
		}
		return waiting ? "tools" : "none";
	}

	/** What the stage `stageId` waits on, released; undefined unless it does. */
	waitingOn(stageId: string): StageToolWait | undefined {
		return this.stages.get(stageId)?.waitingOn();
	}

	/** The run is evicted: every stage lets go of what names it outside the run, and nothing is watched any more. */
	evict(): void {
		for (const stage of this.stages.values()) stage.evict();
		this.stages.clear();
		this.stop();
	}

	stop(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
	}
}

/**
 * A waiting stage of an evicted run: everything that stays in memory of the stage. Plain data of one fixed shape,
 * whatever the stage did before it waited.
 */
export interface StageResidencyEntry {
	readonly runId: string;
	readonly stageId: string;
	readonly replayKey: string;
	readonly reason: "tool";
	readonly wakeKey: string;
	/** When the stage released its session (epoch milliseconds). */
	readonly since: number;
	/** The watch whose result subscriptions report the calls' results while the run is evicted. */
	readonly watchId: number;
	readonly toolCallIds: readonly string[];
	/** The ids of those calls whose results have arrived. The stage wakes the run once every call is among them. */
	readonly settledCallIds: readonly string[];
	/** The stage's stored conversation, as a released agent session names it (#4326). */
	readonly session: ReleasedAgentSession;
}

function allSettled(entry: StageResidencyEntry): boolean {
	return entry.toolCallIds.every((callId) => entry.settledCallIds.includes(callId));
}

/** Why an evicted run is rebuilt: a stage's calls all have results, a stage was sent a message, or the run's owner asked. */
export type RunWakeReason = "tool-results" | "message" | "control";

/**
 * One evicted run: an index entry per waiting stage, and the detached call handles of each, which the tools running
 * the calls own. It routes the run's wakes and tool results until the run is rebuilt.
 */
export class EvictedRun implements StageWakeRoute {
	readonly runId: string;
	/** By wake key: each waiting stage's entry, beside the call handles the tools running its calls own. */
	private readonly stages = new Map<
		string,
		{ readonly entry: StageResidencyEntry; readonly calls: readonly DetachedToolCall[] }
	>();
	private readonly wakes = new Map<string | undefined, PendingStageWakes>();
	private readonly woken = Promise.withResolvers<RunWakeReason>();
	private wakeReason: RunWakeReason | undefined;

	constructor(runId: string, handoff: StageWaitHandoff) {
		this.runId = runId;
		for (const wait of handoff.waits)
			this.stages.set(wait.wakeKey, {
				entry: {
					runId,
					stageId: wait.stageId,
					replayKey: wait.replayKey,
					reason: "tool",
					wakeKey: wait.wakeKey,
					since: wait.since,
					watchId: wait.watchId,
					toolCallIds: wait.calls.map((call) => call.toolCallId),
					settledCallIds: wait.settledCallIds,
					session: wait.session,
				},
				calls: wait.calls,
			});
		for (const [replayKey, pending] of handoff.wakes) this.wakes.set(replayKey, pending);
		if ([...this.stages.values()].some(({ entry }) => allSettled(entry))) this.wake("tool-results");
	}

	/** One entry per waiting stage. */
	stageEntries(): StageResidencyEntry[] {
		return [...this.stages.values()].map((stage) => stage.entry);
	}

	/** Why the run was woken, once it was. */
	get wokenBy(): RunWakeReason | undefined {
		return this.wakeReason;
	}

	/** Settles with the first reason the run was woken for. */
	untilWoken(): Promise<RunWakeReason> {
		return this.woken.promise;
	}

	/** Wake the run, for its owner's control or its abort. */
	wake(reason: RunWakeReason): void {
		if (this.wakeReason !== undefined) return;
		this.wakeReason = reason;
		this.woken.resolve(reason);
	}

	/** Everything the rebuilt run takes over: each waiting stage's tool wait, and the messages it was sent meanwhile. */
	handoff(): StageWaitHandoff {
		const waits: EvictedToolWait[] = [];
		for (const { entry, calls } of this.stages.values())
			waits.push({
				stageId: entry.stageId,
				replayKey: entry.replayKey,
				wakeKey: entry.wakeKey,
				since: entry.since,
				watchId: entry.watchId,
				calls,
				settledCallIds: entry.settledCallIds,
				session: entry.session,
			});
		return { waits, wakes: new Map(this.wakes) };
	}

	/** A stage sent a message while its run is evicted: queued for it, and the run is rebuilt to take it. */
	deliver(wakeKey: string, wake: StageWake): StageWakeDelivery {
		const entry = this.stages.get(wakeKey)?.entry;
		const stageId = entry?.stageId ?? wakeKey.slice(wakeKey.indexOf("/") + 1);
		if (!isStageWakeKindRegistered(wake.kind))
			throw new StageWakeError({ runId: this.runId, stageId, kind: String(wake.kind) });
		if (entry === undefined) return { status: "stage-not-open" };
		const pending = this.wakes.get(entry.replayKey);
		this.wakes.set(entry.replayKey, { stageId, wakes: [...(pending?.wakes ?? []), wake] });
		this.wake("message");
		return { status: "queued" };
	}

	/** A detached call of a waiting stage has its result: once every call of the stage has one, the run is rebuilt. */
	toolResultSettled(wakeKey: string, watchId: number, callId: string, _result: DetachedToolResult): void {
		const stage = this.stages.get(wakeKey);
		if (stage === undefined || stage.entry.watchId !== watchId) return;
		const { entry } = stage;
		if (!entry.toolCallIds.includes(callId) || entry.settledCallIds.includes(callId)) return;
		const settled = { ...entry, settledCallIds: [...entry.settledCallIds, callId] };
		this.stages.set(wakeKey, { entry: settled, calls: stage.calls });
		if (allSettled(settled)) this.wake("tool-results");
	}

	/** A detached call's result rejected: the rebuilt stage meets the rejection when it waits on the call again. */
	toolResultFailed(wakeKey: string, watchId: number, _error: unknown): void {
		if (this.stages.get(wakeKey)?.entry.watchId === watchId) this.wake("tool-results");
	}
}

// Shared across module copies, as the wake routes are.
const indexKey = Symbol.for("atomic-workflows/run-residency@1");
const processState = globalThis as typeof globalThis & Record<symbol, Map<string, EvictedRun> | undefined>;
const evictedRuns: Map<string, EvictedRun> = processState[indexKey] ?? new Map();
processState[indexKey] = evictedRuns;

/** Record an evicted run in the index; it routes the run's wakes from now on. */
export function admitEvictedRun(run: EvictedRun): void {
	evictedRuns.set(run.runId, run);
	routeStageWakes(run.runId, run);
}

/** Take an evicted run out of the index when it is rebuilt. */
export function releaseEvictedRun(run: EvictedRun): void {
	if (evictedRuns.get(run.runId) === run) evictedRuns.delete(run.runId);
	unrouteStageWakes(run.runId, run);
}

/** The evicted run with this id, if this process holds one. */
export function evictedRun(runId: string): EvictedRun | undefined {
	return evictedRuns.get(runId);
}

/** The index: one entry per waiting stage of every run this process holds evicted. */
export function residentStageEntries(): StageResidencyEntry[] {
	return [...evictedRuns.values()].flatMap((run) => run.stageEntries());
}
