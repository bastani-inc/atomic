import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { vi } from "vitest";
import {
	type EndedChildWakeNotice,
	type EndedQueueMemory,
	IntercomClient,
	type LostEndedQueuedMessage,
} from "../../packages/intercom/broker/client.js";
import { queryIntercomBroker } from "../../packages/intercom/broker/control.js";
import {
	ENDED_QUEUE_OPEN_WAIT_ENV,
	ENDED_QUEUE_OPEN_WAIT_MS,
} from "../../packages/intercom/broker/durable-ended-queue.js";
import { createMessageReader, writeMessage } from "../../packages/intercom/broker/framing.js";
import { getBrokerSocketPath } from "../../packages/intercom/broker/paths.js";
import { getJitiCliPath } from "../../packages/intercom/broker/spawn.js";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";
import { sleep } from "../helpers/runtime.js";

export const repoRoot = resolve(import.meta.dirname, "../..");
/** The shared storage adapter the multi-node suites select: SQLite, through the storage layer's adapter module. */
export const STORAGE_ADAPTER = join(repoRoot, "test/fixtures/storage-adapter.ts");
/** A SQLite adapter that can park `store.load()` on a gate file for deterministic restore-window ordering tests. */
export const LOAD_GATE_ADAPTER = join(repoRoot, "test/fixtures/intercom-ended-queue-load-gate-adapter.ts");
export const SHARED_PREFIX = "ecq_";

export type Client = IntercomClient;
export type Memory = EndedQueueMemory;
export type Notice = EndedChildWakeNotice;
export type Lost = LostEndedQueuedMessage;
export interface Received {
	readonly from: { readonly id: string; readonly name?: string };
	readonly message: {
		readonly id: string;
		readonly replyTo?: string;
		readonly replyError?: string;
		readonly expectsReply?: boolean;
		readonly heldWhilePaused?: true;
		readonly content: { readonly text: string };
	};
}

export const BROKER_START_WAIT_MS = 60_000;
/**
 * How long a broker started here waits for its store at the first registration, unless the test is about that wait:
 * on a loaded machine opening the store can take longer than its 2 s, and the broker then keeps the queue in memory.
 */
export const STORE_OPEN_WAIT_MS = BROKER_START_WAIT_MS;
export const WAIT = { timeout: 20_000, interval: 25 } as const;
/** Long enough for a frame that must not come (a second copy, a wake) to have arrived. */
export const SETTLE_MS = 750;
/**
 * A slow start: the shared database opens this long after the broker listens, so after the store's own open wait counted
 * from the first registration (which comes as the broker listens), and well within the broker's wait for routing.
 */
export const SLOW_SHARED_OPEN_MS = ENDED_QUEUE_OPEN_WAIT_MS + 1_000;
/** How long loading the store's code takes in a broker standing in for a busy machine: longer than its usual wait. */
export const SLOW_STORE_LOAD_MS = ENDED_QUEUE_OPEN_WAIT_MS + 1_000;
export const SLOW_MODULE_LOAD_PRELOAD = join(repoRoot, "test/fixtures/intercom-slow-module-load-preload.cjs");

const fixtures: IntercomBrokerFixture[] = [];
export const tempDirs: string[] = [];

export async function cleanupEndedQueueRestartFixtures(): Promise<void> {
	for (const fixture of fixtures.splice(0)) await fixture.cleanup();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

/** Ask the broker to shut down in order, as `atomic intercom restart` does, on every platform. */
export async function requestShutdown(host: Host): Promise<void> {
	await new Promise<void>((resolveAck, rejectAck) => {
		const requestId = randomUUID();
		const socket = net.connect(getBrokerSocketPath(process.platform, host.agentDir));
		socket.once("error", rejectAck);
		socket.once("connect", () => writeMessage(socket, { type: "shutdown", requestId }));
		socket.on(
			"data",
			createMessageReader((message) => {
				if (typeof message !== "object" || message === null || Array.isArray(message)) return;
				if (message.type !== "shutdown_ack" || message.requestId !== requestId) return;
				socket.destroy();
				resolveAck();
			}, rejectAck),
		);
	});
}

/** When a slowly started broker's shared database opens (see {@link Host.startSlowly}). */
export type SharedOpening = { readonly afterMs: number } | "once it answered a registration" | "after a failed attempt";

/** One agent directory and its broker, started, killed and started again. */
export class Host {
	readonly fixture: IntercomBrokerFixture;
	private broker: ChildProcess | undefined;

	/**
	 * `shared`: the broker selects a shared SQLite database at this path, so multi-node routing is on. `openGate`: the
	 * file the storage adapter waits on before it opens that database (see {@link startSlowly}).
	 */
	constructor(
		private readonly shared?: string,
		private readonly openGate?: string,
		loadGate?: string,
	) {
		this.fixture = new IntercomBrokerFixture(mkdtempSync(join(tmpdir(), "ecq-")));
		fixtures.push(this.fixture);
		if (shared !== undefined)
			writeFileSync(
				join(this.agentDir, "settings.json"),
				JSON.stringify({
					storage: {
						adapter: loadGate === undefined ? STORAGE_ADAPTER : LOAD_GATE_ADAPTER,
						options: {
							path: shared,
							...(openGate === undefined ? {} : { openGate }),
							...(loadGate === undefined ? {} : { loadGate }),
						},
						prefix: SHARED_PREFIX,
					},
				}),
			);
	}

	get agentDir(): string {
		return this.fixture.agentDir;
	}

	/** `preload`: a module the broker's Node loads first (`--require`), as a test's stand-in for a busy machine. */
	async start(env: Readonly<Record<string, string>> = {}, preload?: string): Promise<void> {
		const extensionDir = join(repoRoot, "packages/intercom");
		const args = [getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")];
		const broker = spawn(process.execPath, preload === undefined ? args : ["--require", preload, ...args], {
			env: {
				...process.env,
				[ENDED_QUEUE_OPEN_WAIT_ENV]: String(STORE_OPEN_WAIT_MS),
				...env,
				ATOMIC_CODING_AGENT_DIR: this.agentDir,
			},
			stdio: "ignore",
		});
		this.broker = broker;
		this.fixture.trackBroker(broker);
		await this.fixture.holdSession(getBrokerSocketPath(process.platform, this.agentDir), BROKER_START_WAIT_MS);
		if (this.shared === undefined) return;
		await vi.waitFor(
			async () => {
				const status = await queryIntercomBroker(this.agentDir);
				assert.ok(
					status.state === "running" && status.report.multiNode.status === "on",
					"multi-node routing is on",
				);
			},
			{ timeout: BROKER_START_WAIT_MS, interval: 25 },
		);
	}

	/**
	 * Starts the broker with its shared database slow to open, as on a cold start after a reboot (the storage modules
	 * compile on first use) or with a remote database: it opens `afterMs` after the broker listens, once the broker
	 * answered a registration (so without it), or once routing's first attempt to open it failed.
	 */
	async startSlowly(opening: SharedOpening = { afterMs: SLOW_SHARED_OPEN_MS }): Promise<void> {
		const gate = this.openGate;
		assert.ok(gate !== undefined, "a host started slowly has an open gate");
		writeFileSync(gate, opening === "after a failed attempt" ? "fail" : "closed");
		// These starts are about the broker's own wait for its store.
		const started = this.start({ [ENDED_QUEUE_OPEN_WAIT_ENV]: String(ENDED_QUEUE_OPEN_WAIT_MS) });
		const socketPath = getBrokerSocketPath(process.platform, this.agentDir);
		if (opening === "after a failed attempt")
			await vi.waitFor(
				async () => {
					const status = await queryIntercomBroker(this.agentDir);
					assert.ok(
						status.state === "running" && status.report.multiNode.status === "unavailable",
						"routing's first attempt failed",
					);
				},
				{ timeout: BROKER_START_WAIT_MS, interval: 25 },
			);
		else {
			await vi.waitFor(async () => assert.ok(await accepts(socketPath), "the broker listens"), {
				timeout: BROKER_START_WAIT_MS,
				interval: 10,
			});
			if (opening === "once it answered a registration") await registerOnce(socketPath);
			else await sleep(opening.afterMs);
		}
		writeFileSync(gate, "open");
		await started;
	}

	/** SIGKILL: the broker's memory is gone, as in a crash or a machine restart. */
	async kill(): Promise<void> {
		const broker = this.broker;
		if (broker === undefined || broker.exitCode !== null || broker.signalCode !== null) return;
		const closed = new Promise<void>((resolveClosed) => broker.once("close", () => resolveClosed()));
		broker.kill("SIGKILL");
		await closed;
	}

	/** Until the broker exits on its own (a crash point). */
	async exited(): Promise<void> {
		const broker = this.broker;
		if (broker === undefined || broker.exitCode !== null || broker.signalCode !== null) return;
		await new Promise<void>((resolveClosed) => broker.once("close", () => resolveClosed()));
	}
}

/** Whether a broker accepts connections on `socketPath` now (a killed broker's socket file refuses them). */
async function accepts(socketPath: string): Promise<boolean> {
	return new Promise<boolean>((resolveAccepts) => {
		const socket = net.connect(socketPath);
		socket.once("connect", () => {
			socket.destroy();
			resolveAccepts(true);
		});
		socket.once("error", () => {
			socket.destroy();
			resolveAccepts(false);
		});
	});
}

/** A control connection registers with the broker on `socketPath`; resolves once the broker answered it. */
async function registerOnce(socketPath: string): Promise<void> {
	await new Promise<void>((resolveRegistered, rejectRegistered) => {
		const socket = net.connect(socketPath);
		socket.once("error", rejectRegistered);
		socket.once("connect", () => {
			const now = Date.now();
			writeMessage(socket, {
				type: "register",
				session: {
					cwd: repoRoot,
					model: "test-model",
					pid: process.pid,
					startedAt: now,
					lastActivity: now,
					group: "default",
					recipientPurpose: "control",
				},
			});
		});
		socket.on(
			"data",
			createMessageReader((message) => {
				if (typeof message !== "object" || message === null || Array.isArray(message)) return;
				if (message.type !== "registered") return;
				socket.destroy();
				resolveRegistered();
			}, rejectRegistered),
		);
	});
}

export interface Session {
	readonly client: Client;
	readonly received: Received[];
	readonly wakes: Notice[];
	readonly lost: Lost[];
	readonly returnAddress: string;
	/** Its Intercom id, as registered (the client forgets it once its broker is gone). */
	readonly sessionId: string;
}

export interface SessionOptions {
	readonly returnAddress?: string;
	readonly preferredSessionId?: string;
	readonly ownerToken?: string;
	readonly supervisor?: { capability: string; supervisorSessionId: string };
	readonly memory?: Memory;
	readonly group?: string;
	readonly reach?: () => { readonly home: string; readonly reachable: readonly string[] } | undefined;
	/** Confirm each message once saved, as a session's durable inbox does (#3761). */
	readonly confirms?: boolean;
}

/** A session as its extension registers it, and again after a restart: same return address, same Intercom id. */
export async function connect(host: Host, name: string, options: SessionOptions = {}): Promise<Session> {
	const returnAddress = options.returnAddress ?? randomUUID();
	const group = options.group ?? "default";
	const client = new IntercomClient(returnAddress, {
		brokerSocketPath: getBrokerSocketPath(process.platform, host.agentDir),
		...(options.preferredSessionId === undefined ? {} : { preferredSessionId: options.preferredSessionId }),
		...(options.confirms === false ? {} : { acknowledgesReceipt: true }),
		...(options.memory === undefined ? {} : { endedQueue: options.memory }),
		...(options.reach === undefined ? {} : { reach: options.reach }),
	});
	client.on("error", () => {});
	const received: Received[] = [];
	const wakes: Notice[] = [];
	const lost: Lost[] = [];
	client.on("message", (from: Received["from"], message: Received["message"]) => {
		received.push({ from, message });
		if (options.confirms !== false) client.acknowledgeReceived(message.id);
	});
	client.on("ended_child_wake", (notice: Notice) => wakes.push(notice));
	client.on("ended_queue_lost", (messages: readonly Lost[]) => lost.push(...messages));
	await client.connect(
		{
			name,
			model: "test-model",
			cwd: repoRoot,
			pid: process.pid,
			status: "idle",
			startedAt: Date.now(),
			lastActivity: Date.now(),
			group,
			groups: [group],
		},
		options.supervisor,
		options.ownerToken,
		undefined,
		group,
	);
	host.fixture.onCleanup(() => client.disconnect().catch(() => undefined));
	assert.ok(client.sessionId);
	return { client, received, wakes, lost, returnAddress, sessionId: client.sessionId };
}

/** The same session, registering with the next broker. */
export function again(host: Host, name: string, session: Session, options: SessionOptions = {}): Promise<Session> {
	return connect(host, name, {
		returnAddress: session.returnAddress,
		preferredSessionId: session.sessionId,
		...options,
	});
}

export async function untilGone(observer: Client, sessionId: string | null): Promise<void> {
	assert.ok(sessionId);
	await vi.waitFor(
		async () =>
			assert.equal(
				(await observer.listSessions()).some((session) => session.id === sessionId),
				false,
			),
		WAIT,
	);
}

/** Its owner launched it, it ran, and its session is gone: the owner reports how it ended. */
export async function endedChild(
	host: Host,
	ownerSession: Session,
	childName: string,
	outcome: "completed" | "stopped",
): Promise<void> {
	const child = await connect(host, childName, {
		returnAddress: childReturnAddress(childName),
		supervisor: await ownerSession.client.authorizeSupervisorChild(childName),
	});
	const id = child.client.sessionId;
	await child.client.disconnect();
	await untilGone(ownerSession.client, id);
	await markEnded(ownerSession, childName, outcome);
}

export function markEnded(ownerSession: Session, childName: string, outcome: "completed" | "stopped"): Promise<void> {
	return ownerSession.client.markEndedChildren([
		{
			childName,
			childId: `${childName}:0`,
			outcome,
			aliases: [],
			messages: outcome === "stopped" ? "hold" : "wake",
		},
	]);
}

const ownerTokens = new WeakMap<Session, string>();

export async function owner(host: Host, label: string, existing?: Session): Promise<Session> {
	const ownerToken = existing === undefined ? randomUUID() : (ownerTokens.get(existing) as string);
	const session =
		existing === undefined
			? await connect(host, `${label}-owner`, { ownerToken })
			: await again(host, `${label}-owner`, existing, { ownerToken });
	ownerTokens.set(session, ownerToken);
	return session;
}

/** A subagent's own session, the same however often it is resumed: its return address. */
const childReturnAddresses = new Map<string, string>();
export function childReturnAddress(childName: string): string {
	let returnAddress = childReturnAddresses.get(childName);
	if (returnAddress === undefined) {
		returnAddress = randomUUID();
		childReturnAddresses.set(childName, returnAddress);
	}
	return returnAddress;
}

/** The owner continues or resumes the child: its session registers again under the owner's authorization. */
export async function resume(host: Host, ownerSession: Session, childName: string): Promise<Session> {
	return connect(host, childName, {
		returnAddress: childReturnAddress(childName),
		supervisor: await ownerSession.client.authorizeSupervisorChild(childName),
	});
}

export function texts(session: Session): string[] {
	return session.received.map(({ message }) => message.content.text);
}

/** A paused subagent with one message queued for it, and its sender, on `host`'s running broker. */
export async function heldMessage(
	host: Host,
	label: string,
	memory: Memory,
): Promise<{
	ownerSession: Session;
	childName: string;
	sender: Session;
	messageId: string;
}> {
	const ownerSession = await owner(host, label);
	const childName = `subagent-worker-${label}-1`;
	await endedChild(host, ownerSession, childName, "stopped");
	const sender = await connect(host, `${label}-sender`, { memory });
	const messageId = randomUUID();
	const queued = await sender.client.send(childName, { text: "kept", messageId, wakeEndedRecipient: true });
	assert.equal(queued.queued, true, queued.reason);
	return { ownerSession, childName, sender, messageId };
}
