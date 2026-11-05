import {
	type SessionStartEventLoopSample,
	type SessionStartPhase,
	type SessionStartStep,
	type SessionStartStepTiming,
	SessionStartTimeoutError,
} from "@bastani/atomic";

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

/**
 * The start budget of one child attempt. Its signal aborts with a {@link SessionStartTimeoutError} naming the step the
 * start was in, the phase that blocked it, and how the event loop turned meanwhile.
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
	private turnTotalMs = 0;
	private longestTurnMs = 0;

	constructor(subject: string, timeoutMs: number, step: SessionStartStep) {
		this.subject = subject;
		this.timeoutMs = timeoutMs;
		this.step = step;
		this.deadline = setTimeout(() => this.expire(), timeoutMs);
		this.probe = setInterval(() => this.sampleTurn(), START_PROBE_INTERVAL_MS);
		this.probe.unref();
	}

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	/** The start moves on to `step`; the step it leaves keeps how long it ran. */
	enter(step: SessionStartStep): void {
		if (step === this.step) return;
		const now = performance.now();
		this.timings.push({ step: this.step, elapsedMs: Math.round(now - this.stepStartedAt) });
		this.step = step;
		this.stepStartedAt = now;
	}

	/** The agent session starts, or stops, waiting for its resource-admission permit. */
	admissionWait(waiting: boolean): void {
		this.enter(waiting ? "awaiting-admission" : "creating-session");
	}

	/** The start is over, started or failed: its budget no longer runs. */
	end(): void {
		clearTimeout(this.deadline);
		clearInterval(this.probe);
	}

	private sampleTurn(): void {
		const now = performance.now();
		const turnMs = now - this.lastTurnAt;
		this.lastTurnAt = now;
		this.turns += 1;
		this.turnTotalMs += turnMs;
		this.longestTurnMs = Math.max(this.longestTurnMs, turnMs);
	}

	private expire(): void {
		const now = performance.now();
		const eventLoop: SessionStartEventLoopSample = {
			turns: this.turns,
			meanTurnMs: Math.round(this.turns > 0 ? this.turnTotalMs / this.turns : now - this.startedAt),
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
		this.end();
		this.controller.abort(error);
	}
}
