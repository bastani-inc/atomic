import { ActivityWatchdog, type ActivityWatchdogDiagnostic } from "./activity-watchdog.ts";
import { parseInteractiveEngineMessage, type InteractiveEngineMessage } from "./protocol.ts";

export class InteractiveEngineMonitor {
	private readonly watchdog: ActivityWatchdog;
	private readonly readiness: Promise<void>;
	private resolveReady!: () => void;
	private readonly bound: Promise<void>;
	private resolveBound!: () => void;
	private rejectBound!: (error: Error) => void;
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
	}


	stop(): void {
		this.watchdog.stop();
	}
	fail(error: Error): void { this.rejectBound(error); }

	async waitUntilReady(timeoutMs = 5_000): Promise<void> {
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				this.readiness,
				new Promise<never>((_, reject) => {
					timeout = setTimeout(() => reject(new Error(`Interactive engine did not become ready within ${timeoutMs} ms`)), timeoutMs);
				}),
			]);
		} finally {
			if (timeout) clearTimeout(timeout);
		}
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
