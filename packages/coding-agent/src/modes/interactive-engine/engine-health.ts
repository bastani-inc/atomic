import { type ActivityWatchdogDiagnostic, ENGINE_UNRESPONSIVE_MS } from "./activity-watchdog.ts";
import type { InteractiveEngineGenerationEnded } from "./engine-generation.ts";

export type EngineDiagnosticListener = (diagnostic: ActivityWatchdogDiagnostic) => void;

export interface EngineHealthDeps {
	/** Terminate the current (or hung replacement) engine child. */
	stop(): Promise<void>;
	/** Replace the engine child and reload host state from it. */
	restart(): Promise<void>;
	/** Drop streaming/compaction/callback activity owned by the dead generation. */
	clearActivity(): void;
}

export const UNEXPECTED_ENGINE_LOSS_NOTICE = "Interactive engine stopped unexpectedly; restarting.";
export const UNRESPONSIVE_ENGINE_NOTICE = "Interactive engine is not responding; restarting.";

/**
 * Keep the actionable transport cause in the recovery notice. Child stderr can
 * contain provider output or secrets, so only the bounded summary before the
 * RpcClient's `. Stderr:` suffix is safe to render.
 */
export function formatUnexpectedEngineLossNotice(event: InteractiveEngineGenerationEnded): string {
	const firstLine = event.error.message.split(/\r?\n/u, 1)[0]?.trim() ?? "";
	const stderrIndex = firstLine.indexOf(". Stderr:");
	const withoutStderr = (stderrIndex === -1 ? firstLine : firstLine.slice(0, stderrIndex)).trim();
	const summary = withoutStderr.slice(0, 240).replace(/[.!?]+$/u, "");
	return summary
		? `${UNEXPECTED_ENGINE_LOSS_NOTICE} Cause (${event.kind}): ${summary}.`
		: `${UNEXPECTED_ENGINE_LOSS_NOTICE} Cause: ${event.kind}.`;
}

export interface EngineHealthOptions {
	/** Injectable clock so tests can cross the unresponsive threshold instantly. */
	now?: () => number;
}

/**
 * Engine health surface: diagnostic fan-out plus single-flight recovery.
 *
 * Recovery has exactly two entry points, deliberately separate:
 *
 *  - {@link handleGenerationEnded} runs ONE automatic replacement attempt after
 *    an unexpected loss of a generation. Expected losses (explicit stop,
 *    deliberate generation replacement, host shutdown) never restart.
 *  - {@link terminate} is the explicit user escape hatch (Ctrl+C). It force-stops
 *    first, so it can rescue a replacement child that is hung waiting for
 *    readiness instead of joining that pending promise.
 *
 * Neither path is reachable from an interrupt: pressing Escape only requests the
 * engine's own cooperative abort and waits for it.
 */
export class EngineHealthController {
	private readonly deps: EngineHealthDeps;
	private readonly now: () => number;
	private readonly listeners = new Set<EngineDiagnosticListener>();
	private pending: ActivityWatchdogDiagnostic[] = [];
	private unresponsive = false;
	private abortStartedAt: number | undefined;
	private attempt: Promise<void> | undefined;
	/** When the current replacement attempt began; undefined once it settles. */
	private attemptStartedAt: number | undefined;
	private attemptId = 0;
	private forceStoppedAttemptId: number | undefined;
	private rescueRequested = false;
	/**
	 * Latched when a replacement failed on its own. Automatic recovery stays
	 * single-shot, but the user's Ctrl+C must remain able to try again: without
	 * this the host would be left with no engine, no pending attempt, no overdue
	 * abort, and no watchdog flag, so nothing could arm the escape hatch.
	 */
	private replacementNeeded = false;
	private termination: Promise<void> | undefined;
	/** Set once disposal begins; joins the in-flight attempt and termination. */
	private shutdownPromise: Promise<void> | undefined;
	private stopped = false;

	constructor(deps: EngineHealthDeps, options?: EngineHealthOptions) {
		this.deps = deps;
		this.now = options?.now ?? (() => performance.now());
	}

	onDiagnostic(listener: EngineDiagnosticListener): () => void {
		for (const diagnostic of this.pending.splice(0)) listener(diagnostic);
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Publish a diagnostic produced elsewhere (watchdog, transport, bridge). */
	publish(diagnostic: ActivityWatchdogDiagnostic): void {
		if (diagnostic.level === "unresponsive" && diagnostic.source === "watchdog") this.unresponsive = true;
		this.deliver(diagnostic);
	}

	/** A heartbeat proves the child's loop turns again, so clear a reported stall. */
	clearUnresponsive(): void {
		this.unresponsive = false;
	}

	markCooperativeAbortStarted(): void {
		this.abortStartedAt ??= this.now();
	}

	markCooperativeAbortSettled(): void {
		this.abortStartedAt = undefined;
	}

	/**
	 * True only when the engine is provably not answering:
	 *
	 *  - the heartbeat watchdog declared it unresponsive;
	 *  - a replacement failed on its own and the host has no engine;
	 *  - a cooperative abort has been outstanding past the unresponsive threshold
	 *    (a child whose loop still turns but is deadlocked);
	 *  - a replacement has been waiting for `engine_ready` past that threshold.
	 *
	 * The readiness case has no watchdog coverage at all: a child stopped before
	 * readiness emits no heartbeat and no diagnostic, and `start()` waits without
	 * a deadline by design. Crossing a threshold arms nothing on its own — it
	 * only decides whether a deliberate Ctrl+C escalates — and all of this stays
	 * false for a healthy engine so a stray second Ctrl+C cannot replace one.
	 */
	needsExplicitTermination(): boolean {
		if (this.unresponsive || this.replacementNeeded) return true;
		return this.isOverdue(this.abortStartedAt) || this.isOverdue(this.attemptStartedAt);
	}

	private isOverdue(startedAt: number | undefined): boolean {
		return startedAt !== undefined && this.now() - startedAt >= ENGINE_UNRESPONSIVE_MS;
	}

	isRecovering(): boolean {
		return this.attempt !== undefined || this.termination !== undefined;
	}

	/**
	 * Stop accepting recovery work and join whatever is still running.
	 *
	 * Disposal must not return while a replacement is between its own stop and
	 * its spawn: the client's restart permit is voided by `deps.stop()`, and the
	 * attempt is then awaited so no child, and no host initialization, outlives
	 * teardown. Idempotent, and bounded by the client's own stop deadlines.
	 */
	shutdown(): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise;
		this.stopped = true;
		this.rescueRequested = false;
		this.replacementNeeded = false;
		this.shutdownPromise = (async () => {
			await this.stopQuietly();
			await this.attempt?.catch(() => {});
			await this.termination?.catch(() => {});
		})();
		return this.shutdownPromise;
	}

	handleGenerationEnded(event: InteractiveEngineGenerationEnded): void {
		this.deps.clearActivity();
		if (event.expected || this.stopped) return;
		if (this.attempt) {
			// A newer child died while the replacement attempt was still running, so
			// that attempt cannot leave a viable generation behind. Latch instead of
			// restarting again: automatic recovery stays single-shot, and Ctrl+C is
			// armed once the in-flight attempt settles.
			this.replacementNeeded = true;
			return;
		}
		void this.recover(formatUnexpectedEngineLossNotice(event)).catch(() => {});
	}

	terminate(): Promise<void> {
		// A repeat Ctrl+C must be able to rescue a replacement that is itself
		// overdue, instead of joining the in-flight termination forever. The stop
		// is fenced by attempt id so repeated presses cannot stack restarts onto a
		// healthy replacement.
		if (this.termination) {
			this.rescueOverdueAttempt();
			return this.termination;
		}
		const inFlight = this.attempt;
		// The attempt this press supersedes fails by our own hand, so its failure is
		// expected rather than something to report to the user.
		if (inFlight) this.forceStoppedAttemptId = this.attemptId;
		const run = (async () => {
			this.deps.clearActivity();
			this.notice(UNRESPONSIVE_ENGINE_NOTICE);
			await this.stopQuietly();
			// An automatic attempt swallows its own errors, so this only waits for it
			// to release the single-flight slot.
			if (inFlight) await inFlight;
			await this.recover(undefined);
			// Each user-forced stop of an overdue replacement earns exactly one more
			// replacement attempt, so the escape hatch stays usable indefinitely.
			while (this.rescueRequested && !this.stopped) {
				this.rescueRequested = false;
				this.notice(UNRESPONSIVE_ENGINE_NOTICE);
				await this.recover(undefined);
			}
		})().finally(() => {
			if (this.termination === run) this.termination = undefined;
		});
		this.termination = run;
		return run;
	}

	/** Force-stop an overdue replacement, at most once per attempt. */
	private rescueOverdueAttempt(): boolean {
		if (!this.isOverdue(this.attemptStartedAt)) return false;
		if (this.forceStoppedAttemptId === this.attemptId) return false;
		this.forceStoppedAttemptId = this.attemptId;
		this.rescueRequested = true;
		void this.stopQuietly();
		return true;
	}

	private async stopQuietly(): Promise<void> {
		try {
			await this.deps.stop();
		} catch {
			// A stop failure must not strand the escape hatch: the restart still
			// replaces the child and reports any real failure.
		}
	}

	private recover(notice: string | undefined): Promise<void> {
		// Order matters: after shutdown no caller may join, or revive, an attempt
		// that still happens to occupy the slot.
		if (this.stopped) return Promise.resolve();
		if (this.attempt) return this.attempt;
		if (notice) this.notice(notice);
		this.attemptId += 1;
		const id = this.attemptId;
		this.attemptStartedAt = this.now();
		this.rescueRequested = false;
		// A new attempt is under way, so the previous failure is no longer the
		// reason to arm Ctrl+C. It re-arms below only if this attempt fails too.
		this.replacementNeeded = false;
		// The watchdog verdict belonged to the generation being replaced. A fresh
		// child emits no heartbeat until it is ready, so leaving the latch set
		// would keep `needsExplicitTermination()` true through the whole pre-ready
		// window and let the first Ctrl+C stop a replacement that never misbehaved.
		// Only this child's own heartbeat, or its own stall, may set it again.
		this.unresponsive = false;
		const run = this.deps
			.restart()
			.catch((error: Error) => {
				// An attempt the user deliberately stopped, or one cancelled by
				// disposal, did not fail on its own.
				if (this.forceStoppedAttemptId === id || this.stopped) return;
				// Keep Ctrl+C armed: automatic recovery is single-shot, but the user
				// must be able to ask for another attempt after a real failure.
				this.replacementNeeded = true;
				// A concrete failure, so no operational source: this one surfaces.
				this.deliver({
					activity: undefined,
					elapsedMs: 0,
					level: "unresponsive",
					message: `Interactive engine restart failed: ${error.message}`,
				});
			})
			.finally(() => {
				if (this.attempt !== run) return;
				this.attempt = undefined;
				this.attemptStartedAt = undefined;
			});
		this.attempt = run;
		return run;
	}

	private notice(message: string): void {
		this.deliver({ activity: undefined, elapsedMs: 0, level: "blocking", message, source: "recovery" });
	}

	private deliver(diagnostic: ActivityWatchdogDiagnostic): void {
		if (this.listeners.size === 0) this.pending.push(diagnostic);
		for (const listener of this.listeners) listener(diagnostic);
	}
}
