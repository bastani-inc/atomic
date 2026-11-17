import {
	type SessionStartEventLoopSample,
	type SessionStartPhase,
	type SessionStartStep,
	type SessionStartStepTiming,
	SessionStartTimeoutError,
} from "@bastani/atomic";

/**
 * How long a child may take to start: open its session, load its resources, create its agent session, including any
 * wait for a resource-admission permit, register on Intercom, and dispatch its task. A start still under way then is
 * retried once; a retry still under way then fails with a `SessionStartTimeoutError`. Waiting for a running slot does
 * not count.
 */
export const SUBAGENT_SESSION_START_TIMEOUT_MS = 5 * 60_000;

/** How often a starting child samples its event loop: a timer that turns at most once per loop turn. */
export const START_PROBE_INTERVAL_MS = 100;

/**
 * A start budget in which the event loop turned fewer times than this left no room for any session to start: a child
 * start takes well under this many sequential loop turns, and above it the step itself was what took too long.
 */
export const SESSION_START_MIN_LOOP_TURNS = 100;

/** A loop turn this long on average means the main thread was saturated, not idle between events. */
export const SATURATED_LOOP_TURN_MS = 2 * START_PROBE_INTERVAL_MS;

const STEP_PHASE: Readonly<Record<SessionStartStep, SessionStartPhase>> = {
	"opening-session": "setup",
	"loading-resources": "setup",
	"creating-session": "setup",
	"awaiting-admission": "admission",
	"registering-intercom": "setup",
	"dispatching-task": "dispatch",
};

/**
 * What blocked a start whose budget ran out in `step`: its admission wait, an event loop too saturated to turn as
 * often as a start needs, or otherwise the step itself.
 */
export function sessionStartPhase(step: SessionStartStep, loop: SessionStartEventLoopSample): SessionStartPhase {
	const phase = STEP_PHASE[step];
	const starved = loop.turns < SESSION_START_MIN_LOOP_TURNS && loop.meanTurnMs >= SATURATED_LOOP_TURN_MS;
	return starved && phase !== "admission" ? "event-loop" : phase;
}

/** Where a start is: its step, and when the start and that step began (`Date.now()` time). */
export interface SessionStartProgress {
	readonly step: SessionStartStep;
	readonly startedAt: number;
	readonly stepStartedAt: number;
}

/**
 * The start budget of one child attempt. Its signal aborts with a {@link SessionStartTimeoutError} naming the step the
 * start was in, the phase that blocked it, and how the event loop turned meanwhile. `onProgress` hears every step it
 * enters, and `undefined` once the start is over, so a start is never shown as merely running.
 */
export class SessionStartBudget {
	private readonly controller = new AbortController();
	private readonly subject: string;
	private readonly timeoutMs: number;
	private readonly startedAt = performance.now();
	private readonly timings: SessionStartStepTiming[] = [];
	private readonly deadline: ReturnType<typeof setTimeout>;
	private readonly probe: ReturnType<typeof setInterval>;
	private step: SessionStartStep;
	private stepStartedAt = this.startedAt;
	private lastTurnAt = this.startedAt;
	private turns = 0;
	private longestTurnMs = 0;
	private readonly startedAtWall = Date.now();
	private stepStartedAtWall = this.startedAtWall;
	private ended = false;
	private readonly onProgress: ((progress: SessionStartProgress | undefined) => void) | undefined;

	constructor(
		subject: string,
		timeoutMs: number,
		step: SessionStartStep,
		onProgress?: (progress: SessionStartProgress | undefined) => void,
	) {
		this.subject = subject;
		this.timeoutMs = timeoutMs;
		this.step = step;
		this.onProgress = onProgress;
		this.deadline = setTimeout(() => this.expire(), timeoutMs);
		this.probe = setInterval(() => this.sampleTurn(), START_PROBE_INTERVAL_MS);
		this.probe.unref();
		this.report();
	}

	/** The step the start is in now. */
	get currentStep(): SessionStartStep {
		return this.step;
	}

	/** Whether the start is still under way: it has neither ended nor run out of its budget. */
	get active(): boolean {
		return !this.ended;
	}

	private report(): void {
		try {
			this.onProgress?.(
				this.ended
					? undefined
					: { step: this.step, startedAt: this.startedAtWall, stepStartedAt: this.stepStartedAtWall },
			);
		} catch {
			// Reporting where a start is never decides how it goes.
		}
	}

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	/** The start moves on to `step`; the step it leaves keeps how long it ran. */
	enter(step: SessionStartStep): void {
		if (step === this.step || this.ended) return;
		const now = performance.now();
		this.timings.push({ step: this.step, elapsedMs: Math.round(now - this.stepStartedAt) });
		this.step = step;
		this.stepStartedAt = now;
		this.stepStartedAtWall = Date.now();
		this.report();
	}

	/** The agent session starts, or stops, waiting for its resource-admission permit. */
	admissionWait(waiting: boolean): void {
		this.enter(waiting ? "awaiting-admission" : "creating-session");
	}

	/** The start is over, started or failed: its budget no longer runs. */
	end(): void {
		this.stop(true);
	}

	/** Stop the budget; a start that ran out of it is not over, so its progress stays where it stalled. */
	private stop(reportEnd: boolean): void {
		clearTimeout(this.deadline);
		clearInterval(this.probe);
		if (this.ended) return;
		this.ended = true;
		if (reportEnd) this.report();
	}

	private sampleTurn(): void {
		const now = performance.now();
		const turnMs = now - this.lastTurnAt;
		this.lastTurnAt = now;
		this.turns += 1;
		this.longestTurnMs = Math.max(this.longestTurnMs, turnMs);
	}

	private expire(): void {
		const now = performance.now();
		// The time since the last probe is a turn of its own once the probe was due in it, as when the thread was held
		// past it. A shorter tail belongs to the turn that probe already counted, as when the deadline fires right after it
		// in the same loop turn: counting it as one more turn would understate how long the loop's turns took.
		const tailIsTurn = this.turns === 0 || now - this.lastTurnAt >= START_PROBE_INTERVAL_MS;
		const eventLoop: SessionStartEventLoopSample = {
			turns: this.turns,
			meanTurnMs: Math.round(
				tailIsTurn ? (now - this.startedAt) / (this.turns + 1) : (this.lastTurnAt - this.startedAt) / this.turns,
			),
			maxTurnMs: Math.round(Math.max(this.longestTurnMs, now - this.lastTurnAt)),
		};
		const stepElapsedMs = Math.round(now - this.stepStartedAt);
		const error = new SessionStartTimeoutError({
			subject: this.subject,
			phase: sessionStartPhase(this.step, eventLoop),
			step: this.step,
			timeoutMs: this.timeoutMs,
			elapsedMs: Math.round(now - this.startedAt),
			stepElapsedMs,
			steps: [...this.timings, { step: this.step, elapsedMs: stepElapsedMs }],
			eventLoop,
		});
		this.stop(false);
		this.controller.abort(error);
	}
}
