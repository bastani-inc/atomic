import type { CallbackActivity } from "../../core/callback-activity.ts";

export interface ActivityWatchdogThresholds {
	diagnosticMs: number;
	unresponsiveMs: number;
	pollMs: number;
}

export interface ActivityWatchdogDiagnostic {
	activity: CallbackActivity | undefined;
	elapsedMs: number;
	level: "blocking" | "unresponsive";
	message: string;
	/**
	 * Set when the diagnostic is operational rather than a concrete engine
	 * failure: `"watchdog"` for heartbeat-gap reports, `"recovery"` for calm
	 * engine replacement status.
	 */
	source?: "watchdog" | "recovery";
}

/**
 * Chat-surface policy for engine diagnostics. Heartbeat-watchdog gaps and
 * engine-recovery status stay internal: the TUI remains responsive and both are
 * operational noise rather than a concrete engine failure. Concrete engine
 * failures (RPC errors, a restart that could not complete) always surface.
 */
export function shouldRenderEngineDiagnosticAsChatError(diagnostic: ActivityWatchdogDiagnostic): boolean {
	return diagnostic.level === "unresponsive" && diagnostic.source === undefined;
}

export interface ActivityWatchdogOptions {
	now?: () => number;
	onDiagnostic: (diagnostic: ActivityWatchdogDiagnostic) => void;
	thresholds?: Partial<ActivityWatchdogThresholds>;
}

/**
 * How long the engine may go without a heartbeat before it counts as
 * unresponsive. Shared with EngineHealthController so the watchdog's verdict and
 * the explicit Ctrl+C escape hatch use one seconds-scale threshold, not two.
 */
export const ENGINE_UNRESPONSIVE_MS = 1_000;

const DEFAULT_THRESHOLDS: ActivityWatchdogThresholds = {
	diagnosticMs: 250,
	unresponsiveMs: ENGINE_UNRESPONSIVE_MS,
	pollMs: 25,
};

export class ActivityWatchdog {
	private readonly now: () => number;
	private readonly onDiagnostic: (diagnostic: ActivityWatchdogDiagnostic) => void;
	private readonly thresholds: ActivityWatchdogThresholds;
	private lastHeartbeatAt: number;
	private readonly activities = new Map<string, CallbackActivity>();
	private timer: ReturnType<typeof setInterval> | undefined;
	private emittedBlocking = false;
	private emittedUnresponsive = false;

	constructor(options: ActivityWatchdogOptions) {
		this.now = options.now ?? performance.now.bind(performance);
		this.onDiagnostic = options.onDiagnostic;
		this.thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
		this.lastHeartbeatAt = this.now();
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => this.inspect(), this.thresholds.pollMs);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.activities.clear();
	}

	heartbeat(): void {
		this.lastHeartbeatAt = this.now();
		this.emittedBlocking = false;
		this.emittedUnresponsive = false;
	}

	activityStarted(activity: CallbackActivity): void {
		this.activities.delete(activity.id);
		this.activities.set(activity.id, activity);
	}

	activityFinished(activityId: string): void {
		this.activities.delete(activityId);
	}

	private inspect(): void {
		const elapsedMs = this.now() - this.lastHeartbeatAt;
		if (elapsedMs >= this.thresholds.unresponsiveMs && !this.emittedUnresponsive) {
			this.emittedUnresponsive = true;
			this.emit("unresponsive", elapsedMs);
			return;
		}
		if (elapsedMs >= this.thresholds.diagnosticMs && !this.emittedBlocking) {
			this.emittedBlocking = true;
			this.emit("blocking", elapsedMs);
		}
	}

	private emit(level: ActivityWatchdogDiagnostic["level"], elapsedMs: number): void {
		const activity = [...this.activities.values()].at(-1);
		const label = activity ? `${activity.kind} ${activity.name}` : "unknown callback";
		const suffix = level === "unresponsive" ? "Esc interrupt · Ctrl+C terminate" : "the TUI remains responsive";
		this.onDiagnostic({
			activity,
			elapsedMs,
			level,
			message: `Engine callback ${label} has not yielded for ${Math.round(elapsedMs)} ms; ${suffix}`,
			source: "watchdog",
		});
	}
}
