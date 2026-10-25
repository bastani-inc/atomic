import type { ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import net from "node:net";
import { createMessageReader, writeMessage } from "../../packages/intercom/broker/framing.js";

const BROKER_TERMINATE_GRACE_MS = 1_000;
const BROKER_CLEANUP_TIMEOUT_MS = 5_000;
const BROKER_READY_POLL_MS = 25;

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
		this.hasClosed = false;
		this.processError = undefined;
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

	/**
	 * Resolves once the broker has registered a session the fixture holds until cleanup.
	 *
	 * A broker retires once no session has been connected for its idle window, and its clock starts when it
	 * listens. A suite that spawns the broker, then spends that window on its own setup or between tests
	 * before any client registers, would otherwise lose it to that retirement under load. The held session
	 * is a non-agent "control" connection made straight to `socketPath`, so it is neither a message recipient
	 * nor visible to a proxy or a spy in front of the suite's own clients.
	 */
	async holdSession(socketPath: string, timeoutMs: number): Promise<void> {
		const deadline = performance.now() + timeoutMs;
		for (;;) {
			this.assertRunning();
			if (performance.now() > deadline) throw new Error("Intercom broker did not register a session in time");
			const remainingMs = Math.max(0, deadline - performance.now());
			const socket = existsSync(socketPath) ? await this.registerHeldSession(socketPath, remainingMs) : undefined;
			if (socket !== undefined) {
				this.cleanups.push(() => {
					socket.destroy();
				});
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, BROKER_READY_POLL_MS));
		}
	}

	/** The registered socket, or undefined when the broker closed or refused it before registering. */
	private registerHeldSession(socketPath: string, timeoutMs: number): Promise<net.Socket | undefined> {
		return new Promise((resolve) => {
			const socket = net.connect(socketPath);
			let registered = false;
			const timer = setTimeout(() => fail(), timeoutMs);
			const fail = () => {
				clearTimeout(timer);
				socket.destroy();
				resolve(undefined);
			};
			socket.on("error", fail);
			socket.once("close", fail);
			socket.on(
				"data",
				createMessageReader((message) => {
					// Later frames (presence broadcasts and the like) are drained and ignored.
					if (registered) return;
					if (typeof message !== "object" || message === null || Array.isArray(message)) return fail();
					if (message.type !== "registered") return fail();
					registered = true;
					clearTimeout(timer);
					socket.off("close", fail);
					resolve(socket);
				}, fail),
			);
			socket.once("connect", () => {
				const now = Date.now();
				writeMessage(socket, {
					type: "register",
					session: {
						cwd: this.agentDir,
						model: "intercom-broker-fixture",
						pid: process.pid,
						startedAt: now,
						lastActivity: now,
						group: "intercom-broker-fixture",
						recipientPurpose: "control",
					},
				});
			});
		});
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
