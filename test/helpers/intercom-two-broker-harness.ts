import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { vi } from "vitest";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { loadStorageAdapter } from "../../packages/coding-agent/src/core/storage/provider.js";
import { selectStorage } from "../../packages/coding-agent/src/core/storage/selection.js";
import type { IntercomClient } from "../../packages/intercom/broker/client.js";
import { getBrokerSocketPath } from "../../packages/intercom/broker/paths.js";
import { getJitiCliPath } from "../../packages/intercom/broker/spawn.js";
import type { Message, SessionInfo, SupervisorRegistration } from "../../packages/intercom/types.js";
import { IntercomBrokerFixture } from "./intercom-broker-fixture.js";
import { removePath } from "./runtime.js";

type ClientModule = typeof import("../../packages/intercom/broker/client.js");

export type BrokerNode = "a" | "b";
export const BROKER_NODES: readonly BrokerNode[] = ["a", "b"];

/** Table prefix of the one shared storage selection both nodes use. */
export const TWO_BROKER_STORAGE_PREFIX = "mn_";
/** S1's presence and membership leases; a broker writing rows here is routing across nodes (spec §12, S1/S5). */
export const SHARED_LEASES_TABLE = `${TWO_BROKER_STORAGE_PREFIX}intercom_leases`;
/** S4's database-polled wake-up hints. */
export const SHARED_WAKEUPS_TABLE = `${TWO_BROKER_STORAGE_PREFIX}intercom_wakeups`;

const repoRoot = resolve(import.meta.dirname, "../..");
const extensionDir = join(repoRoot, "packages/intercom");
const storageAdapterModule = join(repoRoot, "test/fixtures/storage-adapter.ts");
const BROKER_READY_TIMEOUT_MS = 10_000;
const CLIENT_DISCONNECT_TIMEOUT_MS = 5_000;
/** How long start() waits for a broker to write its lease before reporting single-node brokers. */
const CAPABILITY_PROBE_TIMEOUT_MS = 2_000;
const DROP_WAKEUPS_TRIGGER = "two_broker_harness_drop_wakeups";

export interface ReceivedFrame {
	readonly from: SessionInfo;
	readonly message: Message;
	readonly channel?: "supervisor";
}

export interface TwoBrokerConnectOptions {
	readonly group?: string;
	/** Reuse a disconnected client's address to reconnect as the same recipient. */
	readonly returnAddress?: string;
	readonly preferredSessionId?: string;
	/** Default true: confirm each saved message (#3761), as a real session does. */
	readonly acknowledgeReceipts?: boolean;
	readonly supervisor?: SupervisorRegistration;
	readonly supervisorOwnerToken?: string;
}

/** A real Intercom client attached to one node's broker, recording every frame it receives. */
export class TwoBrokerClient {
	readonly received: ReceivedFrame[] = [];
	readonly errors: Error[] = [];
	disconnected = false;

	constructor(
		readonly node: BrokerNode,
		readonly name: string,
		readonly group: string,
		readonly returnAddress: string,
		readonly client: IntercomClient,
	) {}

	get sessionId(): string {
		const id = this.client.sessionId;
		if (id === null) throw new Error(`${this.name} is not registered`);
		return id;
	}

	messagesWithId(id: string): ReceivedFrame[] {
		return this.received.filter((frame) => frame.message.id === id);
	}
}

interface NodeState {
	readonly fixture: IntercomBrokerFixture;
	readonly clientModule: ClientModule;
	readonly clients: TwoBrokerClient[];
	broker: ChildProcess | undefined;
}

export interface TwoBrokerHarnessOptions {
	/** Delay every shared database call by this many ms on a timer, as a remote database would. */
	readonly databaseCallDelayMs?: number;
}

function nodeSettings(sharedDatabasePath: string, options: TwoBrokerHarnessOptions): string {
	return JSON.stringify({
		storage: {
			adapter: storageAdapterModule,
			options: {
				path: sharedDatabasePath,
				...(options.databaseCallDelayMs === undefined ? {} : { callDelayMs: options.databaseCallDelayMs }),
			},
			prefix: TWO_BROKER_STORAGE_PREFIX,
		},
	});
}

/** Intercom snapshots its socket path at import, so each node gets its own module instance. */
async function loadClientModule(agentDir: string): Promise<ClientModule> {
	const original = process.env.ATOMIC_CODING_AGENT_DIR;
	process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
	try {
		vi.resetModules();
		return await import("../../packages/intercom/broker/client.js");
	} finally {
		if (original === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
		else process.env.ATOMIC_CODING_AGENT_DIR = original;
	}
}

function socketAnswers(socketPath: string): Promise<boolean> {
	return new Promise((resolveAnswer) => {
		const socket = net.createConnection(socketPath);
		socket.once("connect", () => {
			socket.destroy();
			resolveAnswer(true);
		});
		socket.once("error", () => resolveAnswer(false));
	});
}

async function tableExists(database: SqliteDatabase, table: string): Promise<boolean> {
	return (await database.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", table)) !== undefined;
}

/**
 * Two real broker processes, as on two hosts: separate agent directories (so separate sockets, pids and logs) whose
 * settings select one shared storage adapter over one SQLite file. Each node keeps a keeper client connected so an
 * idle broker does not retire between scenarios.
 */
export class TwoBrokerHarness {
	readonly sharedDatabasePath: string;
	private readonly nodes: Record<BrokerNode, NodeState>;
	private readonly databases: SqliteDatabase[] = [];
	private probeDatabase: SqliteDatabase | undefined;
	private advertised = false;

	private constructor(
		readonly root: string,
		nodes: Record<BrokerNode, NodeState>,
	) {
		this.sharedDatabasePath = join(root, "shared.sqlite");
		this.nodes = nodes;
	}

	static async start(options: TwoBrokerHarnessOptions = {}): Promise<TwoBrokerHarness> {
		// Short root: a Unix socket path must fit in about 104 bytes.
		const root = mkdtempSync(join(tmpdir(), "icmn-"));
		const sharedDatabasePath = join(root, "shared.sqlite");
		const nodes = {} as Record<BrokerNode, NodeState>;
		for (const node of BROKER_NODES) {
			const agentDir = join(root, node);
			mkdirSync(agentDir, { recursive: true });
			writeFileSync(join(agentDir, "settings.json"), nodeSettings(sharedDatabasePath, options));
			nodes[node] = {
				fixture: new IntercomBrokerFixture(agentDir),
				clientModule: await loadClientModule(agentDir),
				clients: [],
				broker: undefined,
			};
		}
		const harness = new TwoBrokerHarness(root, nodes);
		try {
			for (const node of BROKER_NODES) await harness.startBroker(node);
			harness.advertised = await harness.probeMultiNodeRouting();
		} catch (error) {
			await harness.cleanup();
			throw error;
		}
		return harness;
	}

	/**
	 * Whether the brokers route across nodes: a broker wrote its membership or presence lease into the shared store.
	 * Cross-node scenarios run fully when this is true; when false they assert that nothing crosses nodes, so a
	 * broker that routes without advertising it fails them too.
	 */
	get multiNodeRouting(): boolean {
		return this.advertised;
	}

	agentDir(node: BrokerNode): string {
		return this.nodes[node].fixture.agentDir;
	}

	socketPath(node: BrokerNode): string {
		return getBrokerSocketPath(process.platform, this.agentDir(node));
	}

	brokerPid(node: BrokerNode): number | undefined {
		return this.nodes[node].broker?.pid;
	}

	isBrokerRunning(node: BrokerNode): boolean {
		const broker = this.nodes[node].broker;
		return broker !== undefined && broker.exitCode === null && broker.signalCode === null;
	}

	async startBroker(node: BrokerNode): Promise<void> {
		const state = this.nodes[node];
		const broker = spawn(process.execPath, [getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")], {
			env: { ...process.env, ATOMIC_CODING_AGENT_DIR: state.fixture.agentDir },
			stdio: "ignore",
		});
		state.broker = broker;
		state.fixture.trackBroker(broker);
		await vi.waitFor(
			async () => {
				state.fixture.assertRunning();
				if (!(await socketAnswers(this.socketPath(node)))) throw new Error(`broker ${node} is not answering yet`);
			},
			{ timeout: BROKER_READY_TIMEOUT_MS, interval: 20 },
		);
		await this.connect(node, `harness-keeper-${node}-${randomUUID().slice(0, 8)}`);
	}

	/** SIGKILL is a crash (leases and claims stay behind); SIGTERM is an orderly shutdown. */
	async stopBroker(node: BrokerNode, signal: "SIGTERM" | "SIGKILL"): Promise<void> {
		const broker = this.nodes[node].broker;
		if (!broker || broker.exitCode !== null || broker.signalCode !== null) return;
		const closed = new Promise<void>((resolveClosed) => broker.once("close", () => resolveClosed()));
		broker.kill(signal);
		await closed;
		await vi.waitFor(
			() => {
				const live = this.nodes[node].clients.filter((client) => !client.disconnected);
				if (live.length > 0) throw new Error(`clients of broker ${node} still connected: ${live.length}`);
			},
			{ timeout: BROKER_READY_TIMEOUT_MS, interval: 20 },
		);
	}

	async ensureBrokersRunning(): Promise<void> {
		for (const node of BROKER_NODES) if (!this.isBrokerRunning(node)) await this.startBroker(node);
	}

	async connect(node: BrokerNode, name: string, options: TwoBrokerConnectOptions = {}): Promise<TwoBrokerClient> {
		const state = this.nodes[node];
		const group = options.group ?? "default";
		const returnAddress = options.returnAddress ?? randomUUID();
		const client = new state.clientModule.IntercomClient(returnAddress, {
			...(options.preferredSessionId === undefined ? {} : { preferredSessionId: options.preferredSessionId }),
			acknowledgesReceipt: true,
		});
		const attached = new TwoBrokerClient(node, name, group, returnAddress, client);
		const acknowledge = options.acknowledgeReceipts ?? true;
		client.on("message", (from: SessionInfo, message: Message, channel: "supervisor" | undefined) => {
			attached.received.push({ from, message, ...(channel === undefined ? {} : { channel }) });
			if (acknowledge) client.acknowledgeReceived(message.id);
		});
		client.on("error", (error: Error) => attached.errors.push(error));
		client.on("disconnected", () => {
			attached.disconnected = true;
		});
		state.clients.push(attached);
		const now = Date.now();
		await client.connect(
			{
				name,
				model: "two-broker-harness",
				cwd: this.root,
				pid: process.pid,
				status: "idle",
				startedAt: now,
				lastActivity: now,
				group,
				groups: [group],
			},
			options.supervisor,
			options.supervisorOwnerToken,
		);
		return attached;
	}

	async disconnect(client: TwoBrokerClient): Promise<void> {
		await client.client.disconnect();
		client.disconnected = true;
	}

	/** Open the storage selected by one node's own settings, as that node's broker would. */
	async openSharedStorage(node: BrokerNode): Promise<SqliteDatabase> {
		const agentDir = this.agentDir(node);
		const value = SettingsManager.create(this.root, agentDir).getSettings().storage;
		if (value === undefined) throw new Error(`node ${node} has no top-level storage selection`);
		const selection = selectStorage(value, "settings", "storage", join(dirname(agentDir), "storage.sqlite"));
		if (selection.kind !== "adapter") throw new Error(`node ${node} selects ${selection.kind}, not an adapter`);
		const context = { agentDir, domain: "sessions" } as const;
		const adapter = await loadStorageAdapter(selection.module, context);
		if (!adapter.openDatabase) throw new Error(`${selection.module} cannot open a database`);
		const database = await adapter.openDatabase(selection.options ?? {}, context);
		this.databases.push(database);
		return database;
	}

	private async shared(): Promise<SqliteDatabase> {
		this.probeDatabase ??= await this.openSharedStorage("a");
		return this.probeDatabase;
	}

	private async probeMultiNodeRouting(): Promise<boolean> {
		const database = await this.shared();
		const deadline = Date.now() + CAPABILITY_PROBE_TIMEOUT_MS;
		for (;;) {
			if (await tableExists(database, SHARED_LEASES_TABLE)) {
				const row = await database.get(`SELECT count(*) AS leases FROM "${SHARED_LEASES_TABLE}"`);
				if (row !== undefined && Number(row.leases) > 0) return true;
			}
			if (Date.now() >= deadline) return false;
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
		}
	}

	/**
	 * Lose every wake-up hint: each hint row is deleted in the statement that writes it, so only a broker's
	 * catch-up scan or backup poll can find outbox rows. Returns a function that restores hints.
	 */
	async dropWakeUps(): Promise<() => Promise<void>> {
		const database = await this.shared();
		if (!(await tableExists(database, SHARED_WAKEUPS_TABLE))) {
			throw new Error(`${SHARED_WAKEUPS_TABLE} is missing: the brokers do not use the database wake-up bus`);
		}
		await database.exec(`DELETE FROM "${SHARED_WAKEUPS_TABLE}"`);
		await database.exec(
			`CREATE TRIGGER "${DROP_WAKEUPS_TRIGGER}" AFTER INSERT ON "${SHARED_WAKEUPS_TABLE}" ` +
				`BEGIN DELETE FROM "${SHARED_WAKEUPS_TABLE}" WHERE rowid = NEW.rowid; END`,
		);
		return async () => {
			await database.exec(`DROP TRIGGER IF EXISTS "${DROP_WAKEUPS_TRIGGER}"`);
		};
	}

	/** Disconnect every client on both nodes first, then stop the brokers, then remove the files. */
	async cleanup(): Promise<void> {
		const clients = BROKER_NODES.flatMap((node) => this.nodes[node].clients);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				Promise.all(clients.map((client) => client.client.disconnect().catch(() => undefined))),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error("Two-broker clients did not close before cleanup deadline")),
						CLIENT_DISCONNECT_TIMEOUT_MS,
					);
				}),
			]);
		} finally {
			clearTimeout(timer);
			for (const node of BROKER_NODES) await this.nodes[node].fixture.cleanup();
			await Promise.all(this.databases.splice(0).map((database) => database.close().catch(() => undefined)));
			await removePath(this.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
		}
	}
}
