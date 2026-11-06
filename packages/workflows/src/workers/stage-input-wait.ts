import { setTimeout as delay } from "node:timers/promises";
import { type StageInputIdentity, StageInputTimeoutError } from "./placement-errors.js";
import type { PooledStageInputKind } from "./stage-input-kind.js";

/** One input of a stage as the root polls it: settled with its receipt, and whether a host holds it now. */
export interface PolledStageInput {
	readonly done: boolean;
	readonly receipt: string | null;
	readonly held: boolean;
}

/** How the root waits for the receipt of one stage input it queued for a stage on another host (#4391). */
export interface StageInputWait {
	/** The input as the journal holds it now; undefined once it is gone. */
	readonly read: () => Promise<PolledStageInput | undefined>;
	/** Why nothing will take the input any more (the pool closed, or the stage's work ended); undefined while it may. */
	readonly ended: () => Promise<"pool-closed" | "work-ended" | undefined>;
	/** Whether a worker host runs the stage's work now; asked once the wait runs out, to name how far the input got. */
	readonly workHeld: () => Promise<boolean>;
	readonly pollMs: number;
	/** Undefined waits for as long as the input may still be taken. */
	readonly timeoutMs?: number | undefined;
	readonly now?: () => number;
	readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Waits for the receipt a worker host records for `input`, polling every `pollMs`. Resolves with the receipt, or with
 * why nothing will take the input any more. Past `timeoutMs` it fails with {@link StageInputTimeoutError}, naming
 * whether a host held the input then: the input stays queued, and waiting for it again finds the same receipt.
 */
export async function awaitStageInputReceipt(
	input: StageInputIdentity,
	wait: StageInputWait,
): Promise<{ readonly receipt: string } | { readonly ended: "pool-closed" | "work-ended" }> {
	const now = wait.now ?? (() => performance.now());
	const sleep = wait.sleep ?? ((ms: number) => delay(ms));
	const { timeoutMs = Number.POSITIVE_INFINITY } = wait;
	const started = now();
	for (;;) {
		const current = await wait.read();
		if (current?.done === true) return { receipt: current.receipt ?? "null" };
		const ended = await wait.ended();
		if (ended !== undefined) return { ended };
		const elapsedMs = Math.round(now() - started);
		if (elapsedMs >= timeoutMs)
			throw new StageInputTimeoutError(input, {
				timeoutMs,
				elapsedMs,
				phase: current?.held === true ? "applying" : (await wait.workHeld()) ? "deferred" : "unclaimed",
			});
		await sleep(wait.pollMs);
	}
}

/** The text inputs a stage defers while it waits for an answer (#4391). */
export const TEXT_STAGE_INPUT_KINDS: readonly PooledStageInputKind[] = ["user-message", "intercom-message"];

/**
 * When a host takes again each stage's input that its stage could not take yet: after `baseMs`, doubling with each
 * refusal up to `maxMs`, so a stage that is slow to start costs a bounded number of take and release writes. A stage
 * that defers its text while it waits for an answer has its other inputs, such as that answer, taken meanwhile.
 */
export class StageInputRetries {
	private readonly waits = new Map<string, { readonly delayMs: number; readonly at: number }>();
	private readonly deferring = new Set<string>();
	private readonly baseMs: number;
	private readonly maxMs: number;

	constructor(baseMs: number, maxMs: number) {
		this.baseMs = baseMs;
		this.maxMs = maxMs;
	}

	/**
	 * What may be taken for the stage `key` at `now`: its next input (`[]`), its next input of a kind it does not defer
	 * (those kinds), or nothing (undefined) while it waits to take again an input it could not take.
	 */
	take(key: string, now: number): readonly PooledStageInputKind[] | undefined {
		const wait = this.waits.get(key);
		if (wait === undefined || now >= wait.at) return [];
		return this.deferring.has(key) ? TEXT_STAGE_INPUT_KINDS : undefined;
	}

	/** The stage `key` refused its input at `now`: it is taken again after the next wait. */
	refused(key: string, now: number): void {
		const previous = this.waits.get(key)?.delayMs;
		const delayMs = previous === undefined ? this.baseMs : Math.min(previous * 2, this.maxMs);
		this.waits.set(key, { delayMs, at: now + delayMs });
	}

	/** The stage `key` deferred its text at `now`: it is taken again after the next wait, its other inputs before. */
	deferred(key: string, now: number): void {
		this.refused(key, now);
		this.deferring.add(key);
	}

	/** The stage `key` settled an input: its next one is taken at once, text included. */
	settled(key: string): void {
		this.waits.delete(key);
		this.deferring.delete(key);
	}

	/** Forgets every stage but those in `waiting`, whose inputs still wait. */
	retain(waiting: ReadonlySet<string>): void {
		for (const key of this.waits.keys()) if (!waiting.has(key)) this.waits.delete(key);
		for (const key of this.deferring) if (!waiting.has(key)) this.deferring.delete(key);
	}
}

/** How taking one stage input ended on a host: given back for later (`retry`, `defer`), settled, or neither. */
export type StageInputTakeOutcome = "retry" | "defer" | "settled" | "idle";

interface StageRef {
	readonly runId: string;
	readonly stageId: string;
}

/**
 * Which of a host's stages take their next input on a pass (#4391): one input in flight per stage, and a stage that
 * gave its input back takes it again only after its wait ({@link StageInputRetries}).
 */
export class StageInputScheduler {
	private readonly retries: StageInputRetries;
	private readonly taking = new Set<string>();

	constructor(baseMs: number, maxMs: number) {
		this.retries = new StageInputRetries(baseMs, maxMs);
	}

	/**
	 * The stages among `waiting` whose next input is taken at `now`, each with the kinds it defers; each is in flight until
	 * {@link finish}. Stages no longer waiting are forgotten.
	 */
	start<Stage extends StageRef>(
		waiting: readonly Stage[],
		now: number,
	): { readonly stage: Stage; readonly deferred: readonly PooledStageInputKind[] }[] {
		this.retries.retain(new Set(waiting.map(stageKey)));
		const started: { readonly stage: Stage; readonly deferred: readonly PooledStageInputKind[] }[] = [];
		for (const stage of waiting) {
			const key = stageKey(stage);
			const deferred = this.retries.take(key, now);
			if (deferred === undefined || this.taking.has(key)) continue;
			this.taking.add(key);
			started.push({ stage, deferred });
		}
		return started;
	}

	/** Records how taking `stage`'s input ended at `now`; without an outcome, it failed and its wait stays as it was. */
	finish(stage: StageRef, now: number, outcome?: StageInputTakeOutcome): void {
		const key = stageKey(stage);
		this.taking.delete(key);
		if (outcome === "retry") this.retries.refused(key, now);
		else if (outcome === "defer") this.retries.deferred(key, now);
		else if (outcome === "settled") this.retries.settled(key);
	}
}

function stageKey(stage: StageRef): string {
	return JSON.stringify([stage.runId, stage.stageId]);
}

/** Whether `work` is the attempt `attempt` names: the same work at the same generation. */
export function isAttempt(
	work: { readonly id: string; readonly generation: number } | undefined,
	attempt: { readonly id: string; readonly generation: number },
): boolean {
	return work?.id === attempt.id && work.generation === attempt.generation;
}

/** Whether the work `id` of a root ended, as the root's queue lists it: gone, completed or failed. */
export function workEnded(entries: readonly { readonly id: string; readonly state: string }[], id: string): boolean {
	const current = entries.find((entry) => entry.id === id);
	return current === undefined || current.state === "completed" || current.state === "failed";
}

/** Whether an attempt holds the work `id` of a root now, as the root's queue lists it. */
export function workHeld(entries: readonly { readonly id: string; readonly state: string }[], id: string): boolean {
	return entries.some((entry) => entry.id === id && entry.state === "leased");
}
