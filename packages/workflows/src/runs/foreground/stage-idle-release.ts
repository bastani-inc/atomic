import type { StageWakeDispatcher } from "./stage-wake-dispatcher.js";

/** A resident stage the run's idle scan watches. */
export interface IdleStage {
	/** The stage's `releaseWhenWaiting` threshold. */
	readonly afterMs: number;
	/** When the stage last became idle, or undefined while it is busy. */
	idleSince(): number | undefined;
	/** Release the stage's session; called once the stage has been idle for its threshold. */
	release(): Promise<void>;
}

/** How soon a stage found busy is looked at again; it is watched afresh the moment its own call ends. */
const BUSY_RECHECK_MS = 1_000;

interface Watched {
	readonly stage: IdleStage;
	deadline: number;
}

/**
 * One idle scan per run: a single timer releases resident stages the workflow holds without using — awaiting a child
 * workflow or a run-level prompt, say — once they have been idle longer than their threshold. No stage owns a timer
 * of its own. The timer runs only while some stage is watched, and never keeps the process alive by itself.
 */
export class StageIdleReleaser {
	private readonly watched = new Map<string, Watched>();
	/** Stages released between turns, with how each shows its status again once the run ends. */
	private readonly releasedBetweenTurns = new Map<string, () => void>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private timerAt = Number.POSITIVE_INFINITY;
	/** The workflow returned or the run ended: nothing is watched or released any more. */
	private finished = false;

	constructor(private readonly reportFailure: (key: string, error: unknown) => void) {}

	/** Watch a stage whose session is resident; it is released after `afterMs` without activity. */
	watch(key: string, stage: IdleStage): void {
		if (this.finished) return;
		const deadline = Date.now() + stage.afterMs;
		this.watched.set(key, { stage, deadline });
		this.arm(deadline);
	}

	/** Stop watching a stage: it released its session or ended. */
	unwatch(key: string): void {
		this.watched.delete(key);
		if (this.watched.size === 0) this.clearTimer();
	}

	get size(): number {
		return this.watched.size;
	}

	/** A stage released between turns; `settle` shows its own status again if the run ends before it reopens. */
	trackReleased(key: string, settle: () => void): void {
		// A release that was already under way when the workflow returned settles at once.
		if (this.finished) settle();
		else this.releasedBetweenTurns.set(key, settle);
	}

	/** The stage reopened its session. */
	forgetReleased(key: string): void {
		this.releasedBetweenTurns.delete(key);
	}

	/**
	 * The workflow finished: a stage still released between turns will not be used again, so it shows the status it
	 * had before it was released — completed, for a stage the workflow held — rather than `waiting`.
	 */
	settleReleased(): void {
		this.finished = true;
		this.watched.clear();
		this.clearTimer();
		const settles = [...this.releasedBetweenTurns.values()];
		this.releasedBetweenTurns.clear();
		for (const settle of settles) settle();
	}

	/** The run ended. */
	dispose(): void {
		this.finished = true;
		this.watched.clear();
		this.releasedBetweenTurns.clear();
		this.clearTimer();
	}

	private arm(deadline: number): void {
		if (this.timer !== undefined && this.timerAt <= deadline) return;
		this.clearTimer();
		this.timerAt = deadline;
		this.timer = setTimeout(() => this.scan(), Math.max(0, deadline - Date.now()));
		this.timer.unref?.();
	}

	private clearTimer(): void {
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		this.timerAt = Number.POSITIVE_INFINITY;
	}

	private scan(): void {
		this.timer = undefined;
		this.timerAt = Number.POSITIVE_INFINITY;
		const now = Date.now();
		let next = Number.POSITIVE_INFINITY;
		for (const [key, watched] of [...this.watched]) {
			if (watched.deadline > now) {
				next = Math.min(next, watched.deadline);
				continue;
			}
			const since = watched.stage.idleSince();
			// A busy stage is looked at again later; one idle for less than its threshold, when it would be due.
			if (since === undefined || now - since < watched.stage.afterMs) {
				watched.deadline =
					since === undefined
						? now + Math.max(watched.stage.afterMs, BUSY_RECHECK_MS)
						: since + watched.stage.afterMs;
				next = Math.min(next, watched.deadline);
				continue;
			}
			this.watched.delete(key);
			void watched.stage.release().catch((error: unknown) => this.reportFailure(key, error));
		}
		if (next !== Number.POSITIVE_INFINITY && !this.finished) this.arm(next);
	}
}

const releasersByDispatcher = new WeakMap<StageWakeDispatcher, StageIdleReleaser>();

/** The idle scan of the run that owns `dispatcher`, created on first use. */
export function stageIdleReleaser(
	dispatcher: StageWakeDispatcher,
	reportFailure: (key: string, error: unknown) => void,
): StageIdleReleaser {
	let releaser = releasersByDispatcher.get(dispatcher);
	if (releaser === undefined) {
		releaser = new StageIdleReleaser(reportFailure);
		releasersByDispatcher.set(dispatcher, releaser);
	}
	return releaser;
}

/** Show the stages still released between turns with their own status again; called when the workflow finishes. */
export function settleReleasedStages(dispatcher: StageWakeDispatcher): void {
	releasersByDispatcher.get(dispatcher)?.settleReleased();
}

/** Stop the idle scan of the run that owns `dispatcher`; called when the run ends. */
export function disposeStageIdleReleaser(dispatcher: StageWakeDispatcher): void {
	releasersByDispatcher.get(dispatcher)?.dispose();
	releasersByDispatcher.delete(dispatcher);
}
