import type { ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";

const BROKER_TERMINATE_GRACE_MS = 1_000;
const BROKER_CLEANUP_TIMEOUT_MS = 5_000;

async function bounded<T>(operation: Promise<T>, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(message)), BROKER_CLEANUP_TIMEOUT_MS);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** Lifecycle ownership for the raw-child broker suites (including inherited log fds). */
export class IntercomBrokerFixture {
	private broker: ChildProcess | undefined;
	private closed: Promise<void> = Promise.resolve();
	private hasClosed = false;
	private processError: Error | undefined;
	private readonly cleanups: Array<() => void | Promise<void>> = [];
	private restoreEnvironment: (() => void) | undefined;

	constructor(readonly agentDir: string) {}

	overrideAgentDir(): void {
		const original = process.env.ATOMIC_CODING_AGENT_DIR;
		process.env.ATOMIC_CODING_AGENT_DIR = this.agentDir;
		this.restoreEnvironment = () => {
			if (original === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
			else process.env.ATOMIC_CODING_AGENT_DIR = original;
		};
	}

	onCleanup(cleanup: () => void | Promise<void>): void {
		this.cleanups.push(cleanup);
	}

	trackBroker(broker: ChildProcess): void {
		this.broker = broker;
		// Attach at spawn, not teardown: close/error may precede readiness or afterAll.
		broker.on("error", (error: Error) => {
			this.processError = error;
		});
		this.closed = new Promise<void>((resolveClosed) => {
			broker.once("close", () => {
				this.hasClosed = true;
				resolveClosed();
			});
		});
	}

	assertRunning(): void {
		if (this.processError) throw this.processError;
		if (this.hasClosed || (this.broker && (this.broker.exitCode !== null || this.broker.signalCode !== null))) {
			throw new Error(
				`Broker exited during startup: code ${this.broker?.exitCode}, signal ${this.broker?.signalCode}`,
			);
		}
	}

	private async stopBroker(): Promise<void> {
		const broker = this.broker;
		if (!broker || this.hasClosed) return;
		const signal = (name: NodeJS.Signals) => {
			// A failed spawn has no pid; still await its close, but never signal it.
			if (broker.pid !== undefined && broker.exitCode === null && broker.signalCode === null) broker.kill(name);
		};
		const force = setTimeout(() => signal("SIGKILL"), BROKER_TERMINATE_GRACE_MS);
		try {
			signal("SIGTERM");
			// Unlike exit or kill success, close also proves inherited stdio was released.
			await bounded(this.closed, "Broker did not close before cleanup deadline; keeping its files");
		} finally {
			clearTimeout(force);
		}
	}

	async cleanup(): Promise<void> {
		try {
			try {
				await bounded(
					Promise.all(this.cleanups.splice(0).map(async (cleanup) => cleanup())),
					"Broker clients did not close before cleanup deadline",
				);
			} finally {
				await this.stopBroker();
			}
			rmSync(this.agentDir, { recursive: true, force: true });
		} finally {
			this.restoreEnvironment?.();
			this.restoreEnvironment = undefined;
		}
	}
}
