import { ActivityWatchdog, type ActivityWatchdogDiagnostic } from "./activity-watchdog.ts";
import { parseInteractiveEngineMessage, type InteractiveEngineMessage } from "./protocol.ts";

export class InteractiveEngineMonitor {
	private readonly watchdog: ActivityWatchdog;
	private readonly readiness: Promise<void>;
	private resolveReady!: () => void;
	private readonly bound: Promise<void>;
	private resolveBound!: () => void;
	private rejectBound!: (error: Error) => void;
	private readonly failure: Promise<never>;
	private rejectFailure!: (error: Error) => void;
	private readonly onMessage: (message: InteractiveEngineMessage) => void;

	constructor(
		onDiagnostic: (diagnostic: ActivityWatchdogDiagnostic) => void,
		onMessage: (message: InteractiveEngineMessage) => void,
	) {
		this.watchdog = new ActivityWatchdog({ onDiagnostic });
		this.onMessage = onMessage;
		this.readiness = new Promise((resolve) => {
			this.resolveReady = resolve;
		});
		this.bound = new Promise((resolve, reject) => {
			this.resolveBound = resolve;
			this.rejectBound = reject;
		});
		this.bound.catch(() => {});
		this.failure = new Promise((_, reject) => {
			this.rejectFailure = reject;
		});
		this.failure.catch(() => {});
	}


	stop(): void {
		this.watchdog.stop();
	}
	fail(error: Error): void { this.rejectBound(error); this.rejectFailure(error); }

	/**
	 * Waits for the engine to announce readiness. There is deliberately no
	 * deadline: slow starts (cold module loads on Windows) must not be treated
	 * as failures. Engine exit or a transport error rejects via fail().
	 */
	async waitUntilReady(): Promise<void> {
		await Promise.race([this.readiness, this.failure]);
	}

	waitUntilBound(): Promise<void> { return this.bound; }

	handleLine(line: string): boolean {
		const message = parseInteractiveEngineMessage(line);
		if (!message) return false;
		this.onMessage(message);
		switch (message.type) {
			case "engine_ready":
				this.watchdog.heartbeat();
				this.watchdog.start();
				this.resolveReady();
				break;
			case "engine_bound":
				this.resolveBound();
				break;
			case "engine_heartbeat":
				this.watchdog.heartbeat();
				this.watchdog.start();
				break;
			case "engine_activity_started":
				this.watchdog.activityStarted(message.activity);
				break;
			case "engine_activity_finished":
				this.watchdog.activityFinished(message.activityId);
				break;
		}
		return true;
	}
}
