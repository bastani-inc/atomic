import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMessageReader, writeMessage } from "../../packages/intercom/broker/framing.js";
import { BROKER_DISCONNECT_TIMEOUT_MS } from "../../packages/intercom/retry-policy.js";
import { stopDetachedBroker } from "./detached-broker.js";
import { removeTestDirectory } from "./test-directory-removal.js";
import { TEST_TIMEOUT_MS } from "./test-timeout.js";

const BROKER_TERMINATE_GRACE_MS = 1_000;
/** Margin kept below `TEST_TIMEOUT_MS` so even a multi-phase cleanup timeout reports the fixture's own error. */
const CLEANUP_HOOK_MARGIN_MS = 5_000;
/** Shared ceiling across all teardown phases so client, exit, and stdio waits never reach `TEST_TIMEOUT_MS`. */
const CLEANUP_TOTAL_TIMEOUT_MS = TEST_TIMEOUT_MS - CLEANUP_HOOK_MARGIN_MS;
/**
 * How long the suite's own client cleanups may take. Each Intercom client destroys its socket after
 * `BROKER_DISCONNECT_TIMEOUT_MS`, so this leaves load headroom for the disconnect timer and its close callback
 * while still failing a hanging cleanup inside the hook timeout.
 */
const CLIENT_CLEANUP_TIMEOUT_MS = Math.min(TEST_TIMEOUT_MS / 2, BROKER_DISCONNECT_TIMEOUT_MS * 5);
/**
 * How long a broker killed at teardown may take to exit. A killed process exits once the system has ended it, which a
 * loaded machine slows, so this only names a kill that never took, well inside the hook's own timeout.
 */
const BROKER_EXIT_TIMEOUT_MS = TEST_TIMEOUT_MS / 2;
/** How long an exited broker's inherited stdio may stay open: only a process it started can hold it longer. */
const BROKER_STDIO_RELEASE_TIMEOUT_MS = 5_000;
const BROKER_READY_POLL_MS = 25;

async function bounded<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let firstTurn: ReturnType<typeof setImmediate> | undefined;
	let secondTurn: ReturnType<typeof setImmediate> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					// If an event-loop stall fired both a client's disconnect destroy timer and this deadline in the
					// same timers phase, yield past libuv's close-callbacks phase so `socket.destroy()` can deliver
					// its `'close'` event before rejecting.
					firstTurn = setImmediate(() => {
						secondTurn = setImmediate(() => reject(new Error(message)));
					});
				}, timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
		if (firstTurn !== undefined) clearImmediate(firstTurn);
		if (secondTurn !== undefined) clearImmediate(secondTurn);
	}
}

/** Lifecycle ownership for the raw-child broker suites (including inherited log fds). */
export class IntercomBrokerFixture {
	private broker: ChildProcess | undefined;
	private exited: Promise<void> = Promise.resolve();
	private closed: Promise<void> = Promise.resolve();
	private hasClosed = false;
	private processError: Error | undefined;
	private readonly cleanups: Array<() => void | Promise<void>> = [];
	private restoreEnvironment: (() => void) | undefined;

	constructor(readonly agentDir: string) {}

	overrideAgentDir(): void {
		const original = process.env.ATOMIC_CODING_AGENT_DIR;
		const originalLegacy = process.env.PI_CODING_AGENT_DIR;
		process.env.ATOMIC_CODING_AGENT_DIR = this.agentDir;
		delete process.env.PI_CODING_AGENT_DIR;
		this.restoreEnvironment = () => {
			if (original === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
			else process.env.ATOMIC_CODING_AGENT_DIR = original;
			if (originalLegacy === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = originalLegacy;
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
		// Close follows exit; a process that closed has exited even when its exit was not reported first.
		this.exited = new Promise<void>((resolveExited) => {
			broker.once("exit", () => resolveExited());
			broker.once("close", () => resolveExited());
		});
		this.closed = new Promise<void>((resolveClosed) => {
			broker.once("close", () => {
				this.hasClosed = true;
				resolveClosed();
			});
		});
	}

	/**
	 * Starts the source checkout's broker under jiti, tracked by this fixture, and resolves once it holds a session
	 * (see {@link holdSession}). Call {@link overrideAgentDir} first so the broker and the suite share its socket.
	 */
	async startSourceBroker(timeoutMs: number): Promise<void> {
		const { getJitiCliPath } = await import("../../packages/intercom/broker/spawn.js");
		const { getBrokerSocketPath } = await import("../../packages/intercom/broker/paths.js");
		const intercomPath = fileURLToPath(new URL("../../packages/intercom", import.meta.url));
		this.trackBroker(
			spawn(process.execPath, [getJitiCliPath(intercomPath), join(intercomPath, "broker/broker.ts")], {
				env: process.env,
				stdio: "ignore",
			}),
		);
		await this.holdSession(getBrokerSocketPath(), timeoutMs);
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

	/** Stops the tracked broker process (SIGTERM, escalating to SIGKILL) within the fixture's shared cleanup ceiling. */
	async stopBroker(): Promise<void> {
		const cleanupDeadline = performance.now() + CLEANUP_TOTAL_TIMEOUT_MS;
		await this.stopTrackedBroker((phaseBudgetMs) =>
			Math.min(phaseBudgetMs, Math.max(0, cleanupDeadline - performance.now())),
		);
	}

	private async stopTrackedBroker(remainingBudgetMs: (phaseBudgetMs: number) => number): Promise<void> {
		const broker = this.broker;
		if (!broker || this.hasClosed) return;
		const signal = (name: NodeJS.Signals) => {
			// A failed spawn has no pid; still await its close, but never signal it.
			if (broker.pid !== undefined && broker.exitCode === null && broker.signalCode === null) broker.kill(name);
		};
		const force = setTimeout(() => signal("SIGKILL"), BROKER_TERMINATE_GRACE_MS);
		try {
			signal("SIGTERM");
			await bounded(
				this.exited,
				remainingBudgetMs(BROKER_EXIT_TIMEOUT_MS),
				"Broker did not close before cleanup deadline (it had not exited); keeping its files",
			);
			// Unlike exit or kill success, close also proves inherited stdio was released.
			await bounded(
				this.closed,
				remainingBudgetMs(BROKER_STDIO_RELEASE_TIMEOUT_MS),
				"Broker did not close before cleanup deadline; keeping its files",
			);
		} finally {
			clearTimeout(force);
		}
	}

	private async stopSuccessorBroker(): Promise<void> {
		const pidPath = join(this.agentDir, "intercom", "broker.pid");
		if (!existsSync(pidPath)) return;
		const pid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
		if (!Number.isFinite(pid) || pid <= 0 || pid === this.broker?.pid) return;
		await stopDetachedBroker(this.agentDir);
	}

	async cleanup(): Promise<void> {
		const cleanupDeadline = performance.now() + CLEANUP_TOTAL_TIMEOUT_MS;
		const remainingBudgetMs = (phaseBudgetMs: number): number =>
			Math.min(phaseBudgetMs, Math.max(0, cleanupDeadline - performance.now()));
		try {
			try {
				await bounded(
					Promise.all(this.cleanups.splice(0).map(async (cleanup) => cleanup())),
					remainingBudgetMs(CLIENT_CLEANUP_TIMEOUT_MS),
					"Broker clients did not close before cleanup deadline",
				);
			} finally {
				await this.stopTrackedBroker(remainingBudgetMs);
				await this.stopSuccessorBroker();
			}
			removeTestDirectory(this.agentDir, { retries: 20, retryDelayMs: 50 });
		} finally {
			this.restoreEnvironment?.();
			this.restoreEnvironment = undefined;
		}
	}
}
