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
}

export interface ActivityWatchdogOptions {
	now?: () => number;
	onDiagnostic: (diagnostic: ActivityWatchdogDiagnostic) => void;
	thresholds?: Partial<ActivityWatchdogThresholds>;
}

const DEFAULT_THRESHOLDS: ActivityWatchdogThresholds = {
	diagnosticMs: 250,
	unresponsiveMs: 1_000,
	pollMs: 25,
};

export class ActivityWatchdog {
	private readonly now: () => number;
	private readonly onDiagnostic: (diagnostic: ActivityWatchdogDiagnostic) => void;
	private readonly thresholds: ActivityWatchdogThresholds;
	private lastHeartbeatAt: number;
	private activity: CallbackActivity | undefined;
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
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}

	heartbeat(): void {
		this.lastHeartbeatAt = this.now();
		this.emittedBlocking = false;
		this.emittedUnresponsive = false;
	}

	activityStarted(activity: CallbackActivity): void {
		this.activity = activity;
	}

	activityFinished(activityId: string): void {
		if (this.activity?.id === activityId) this.activity = undefined;
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
		const label = this.activity ? `${this.activity.kind} ${this.activity.name}` : "unknown callback";
		const suffix = level === "unresponsive" ? "Esc interrupt · Ctrl+C terminate" : "the TUI remains responsive";
		this.onDiagnostic({
			activity: this.activity,
			elapsedMs,
			level,
			message: `Engine callback ${label} has not yielded for ${Math.round(elapsedMs)} ms; ${suffix}`,
		});
	}
}
