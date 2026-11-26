import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, realpathSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { vi } from "vitest";
import type { SqliteDatabase } from "../../../packages/coding-agent/src/core/storage/database.js";
import { IntercomClient, type IntercomIdHandoff } from "../../../packages/intercom/broker/client.js";
import { queryIntercomBroker } from "../../../packages/intercom/broker/control.js";
import { getBrokerSocketPath } from "../../../packages/intercom/broker/paths.js";
import { getJitiCliPath } from "../../../packages/intercom/broker/spawn.js";
import type { Message, SessionInfo, SupervisorRegistration } from "../../../packages/intercom/types.js";
import { openPostgresDatabase } from "../../../packages/storage-postgres/postgres.js";
import { IntercomBrokerFixture } from "../../helpers/intercom-broker-fixture.js";
import { BROKER_START_ALLOWANCE_MS } from "../../helpers/intercom-two-broker-harness.js";
import { bunExecutable, removePath } from "../../helpers/runtime.js";
import { NodeLink } from "./proxy.js";
import {
	type DistributedTopology,
	type Endpoint,
	passwordOf,
	postgresUrl,
	recordEvent,
	requireTopology,
} from "./topology.js";

export const repoRoot = resolve(import.meta.dirname, "../../..");
const intercomDir = join(repoRoot, "packages/intercom");
/** This checkout's PostgreSQL adapter by path, so a node never resolves (or Bun auto-installs) a published copy. */
export const postgresAdapter = join(repoRoot, "packages/storage-postgres/postgres.js");
const cli = join(repoRoot, "packages/coding-agent/dist/cli.js");
const clockSkew = join(repoRoot, "test/distributed/node/clock-skew.mjs");

/** How long a client waits for a loaded broker to answer its registration; the client's own default is 10 s. */
const CLIENT_REGISTRATION_TIMEOUT_MS = 30_000;
const DOCKER_TIMEOUT_MS = 300_000;
/** How long one node process may run before the harness kills it. */
export const NODE_STEP_TIMEOUT_MS = 120_000;

/** Storage settings a node's processes must not inherit from the shell that started the run. */
const CLEARED_STORAGE_ENV = {
	ATOMIC_STORAGE: "",
	ATOMIC_SESSIONS_STORAGE: "",
	ATOMIC_WORKFLOWS_JOURNAL: "",
	ATOMIC_WORKFLOW_JOURNAL_PATH: "",
	ATOMIC_CODING_AGENT_SESSION_DIR: "",
	ATOMIC_PROFILE: "",
};

export type Service = "primary" | "pgbouncer" | "replica";

/** `docker compose` on the run's project. Throws with the command's output when it fails. */
export function compose(...args: string[]): string {
	const current = requireTopology();
	const profiles = current.compose.profiles.flatMap((profile) => ["--profile", profile]);
	return execFileSync(
		"docker",
		[
			"compose",
			"--project-name",
			current.compose.project,
			"--file",
			current.compose.file,
			"--env-file",
			current.compose.envFile,
			...profiles,
			...args,
		],
		{ encoding: "utf8", timeout: DOCKER_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] },
	);
}

/** Runs `sql` as the administrator inside `service`'s container and returns psql's unaligned rows. */
export function adminSql(sql: string, service: "primary" | "replica" = "primary", database = "atomic"): string {
	return compose(
		"exec",
		"-T",
		"-u",
		"postgres",
		service,
		"psql",
		"-v",
		"ON_ERROR_STOP=1",
		"-d",
		database,
		"-Atc",
		sql,
	).trim();
}

/** Runs a console command on PgBouncer (`SHOW POOLS`, `SHOW CLIENTS`) as its stats user. */
export function bouncerConsole(command: string): string {
	return compose(
		"exec",
		"-T",
		"pgbouncer",
		"sh",
		"-c",
		`PGPASSWORD="$ADT_PGBOUNCER_AUTH_PASSWORD" psql -h 127.0.0.1 -p 6432 -U pgbouncer_auth pgbouncer -Atc "${command}"`,
	).trim();
}

/** Waits until every service of the run reports healthy again, after a restart or an unpause. */
export async function servicesHealthy(timeoutMs = 120_000): Promise<void> {
	await vi.waitFor(
		() => {
			const listed = compose("ps", "--format", "json")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as { Service: string; State: string; Health: string });
			const unhealthy = listed.filter((entry) => entry.State !== "running" || entry.Health !== "healthy");
			if (unhealthy.length > 0)
				throw new Error(`not healthy yet: ${unhealthy.map((entry) => entry.Service).join(", ")}`);
		},
		{ timeout: timeoutMs, interval: 500 },
	);
}

/** Opens the run's database directly with `openPostgresDatabase`, as `role` would, for checks a scenario makes. */
export function openDatabase(
	role: keyof DistributedTopology["roles"],
	endpoint: Endpoint,
	options: { readonly ca?: string; readonly sslmode?: string; readonly password?: string } = {},
): Promise<SqliteDatabase> {
	const current = requireTopology();
	const credentials = current.roles[role];
	return openPostgresDatabase({
		url: postgresUrl(endpoint, credentials.user, options),
		password: options.password ?? passwordOf(credentials),
		maxConnections: 2,
		readerMaxConnections: 0,
	});
}

/**
 * Creates or upgrades Atomic's tables for `prefix` with `atomic storage migrate`, as the owner role, straight to the
 * primary: the runtime role the nodes use has no rights to do it.
 */
export function migrate(prefix: string): string {
	const current = requireTopology();
	if (!existsSync(cli)) throw new Error(`${cli} is missing: run npm run build first`);
	const home = mkdtempSync(join(tmpdir(), "adt-migrate-"));
	try {
		return execFileSync(process.execPath, [cli, "storage", "migrate"], {
			encoding: "utf8",
			timeout: DOCKER_TIMEOUT_MS,
			env: {
				...process.env,
				...CLEARED_STORAGE_ENV,
				HOME: home,
				ATOMIC_CODING_AGENT_DIR: join(home, "agent"),
				ADT_OWNER_PASSWORD: passwordOf(current.roles.owner),
				ATOMIC_STORAGE: JSON.stringify({
					adapter: postgresAdapter,
					options: { url: postgresUrl(current.primary, current.roles.owner.user) },
					secrets: { password: { env: "ADT_OWNER_PASSWORD" } },
					prefix,
				}),
			},
		});
	} finally {
		execFileSync("rm", ["-rf", home]);
	}
}

/** A table prefix of its own for one scenario, so scenarios never read each other's rows. */
export function scenarioPrefix(scenario: string): string {
	return `adt_${scenario.replaceAll(/[^a-z0-9]/g, "").slice(0, 12)}_${randomBytes(2).toString("hex")}_`;
}

export interface ReceivedFrame {
	readonly from: SessionInfo;
	readonly message: Message;
	/** `performance.now()` when it arrived. */
	readonly at: number;
	/** Which connection of the session it arrived on, when the frames of several are merged. */
	readonly connection?: number;
}

/** A real Intercom client attached to one node's broker, recording every message it receives. */
export class NodeClient {
	readonly received: ReceivedFrame[] = [];
	disconnected = false;

	constructor(
		readonly node: Node,
		readonly name: string,
		readonly returnAddress: string,
		readonly client: IntercomClient,
	) {}

	get sessionId(): string {
		const id = this.client.sessionId;
		if (id === null) throw new Error(`${this.name} is not registered`);
		return id;
	}

	texts(): string[] {
		return this.received.flatMap((frame) => {
			const text = (frame.message.content as { text?: unknown }).text;
			return typeof text === "string" ? [text] : [];
		});
	}
}

export interface ConnectOptions {
	readonly group?: string;
	readonly preferredSessionId?: string;
	readonly returnAddress?: string;
	readonly takesIdHandoff?: true;
	/** #5607: the hand-over a previous connection of the session was given. */
	readonly idHandoff?: IntercomIdHandoff;
	readonly connectTimeoutMs?: number;
	/** A released child that connects again under its owner's authorization. */
	readonly supervisor?: SupervisorRegistration;
	/** The token an owner of released children registers with. */
	readonly supervisorOwnerToken?: string;
}

export interface NodeRun<T = Record<string, unknown>> {
	/** The last JSON line the process printed. */
	readonly output: T | undefined;
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly stderr: string;
}

/**
 * One Atomic node: a directory of its own (HOME, agent directory, Intercom broker socket and logs) and its own network
 * path to the database, through two links the harness can cut or slow: one to PgBouncer for queries and one to the
 * primary for wake-ups (`listenUrl`). Its broker and its agent processes are separate processes of their own.
 */
export class Node {
	readonly home: string;
	readonly agentDir: string;
	readonly logs: string;
	private broker: ChildProcess | undefined;
	private fixture: IntercomBrokerFixture;
	private readonly clients: NodeClient[] = [];
	private readonly children = new Set<ChildProcess>();
	clockSkewMs = 0;

	constructor(
		readonly cluster: Cluster,
		readonly name: string,
		readonly root: string,
		readonly queries: NodeLink,
		readonly wakeUps: NodeLink,
	) {
		this.home = join(root, "home");
		this.agentDir = join(root, "agent");
		this.logs = join(cluster.artifacts, name);
		for (const dir of [this.home, this.agentDir, this.logs]) mkdirSync(dir, { recursive: true });
		const topology = requireTopology();
		const passwordFile = join(this.agentDir, "storage-password");
		writeFileSync(passwordFile, passwordOf(topology.roles.runtime), { mode: 0o600 });
		writeFileSync(
			join(this.agentDir, "settings.json"),
			`${JSON.stringify({ storage: this.storage() }, null, "\t")}\n`,
		);
		this.fixture = new IntercomBrokerFixture(this.agentDir);
	}

	/** The `storage` setting of this node: PgBouncer for queries, the primary for wake-ups, both through its links. */
	storage(): Record<string, unknown> {
		const topology = requireTopology();
		const user = topology.roles.runtime.user;
		return {
			adapter: postgresAdapter,
			options: {
				url: postgresUrl({ host: "127.0.0.1", port: this.queries.port }, user),
				listenUrl: postgresUrl({ host: "127.0.0.1", port: this.wakeUps.port }, user),
			},
			secrets: { password: { file: join(this.agentDir, "storage-password") } },
			prefix: this.cluster.prefix,
		};
	}

	/** The environment of a process of this node. */
	env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
		return {
			...process.env,
			...CLEARED_STORAGE_ENV,
			HOME: this.home,
			ATOMIC_CODING_AGENT_DIR: this.agentDir,
			ATOMIC_STORAGE: JSON.stringify(this.storage()),
			ADT_CLOCK_SKEW_MS: String(this.clockSkewMs),
			...extra,
		};
	}

	/** Cuts both of this node's links: it keeps running, but nothing it sends reaches the database. */
	partition(): void {
		this.queries.partition();
		this.wakeUps.partition();
		recordEvent(this.cluster.scenario, { fault: "partition", node: this.name, phase: "start" });
	}

	heal(): void {
		this.queries.heal();
		this.wakeUps.heal();
		recordEvent(this.cluster.scenario, { fault: "partition", node: this.name, phase: "end" });
	}

	get socketPath(): string {
		return getBrokerSocketPath(process.platform, this.agentDir);
	}

	get brokerPid(): number | undefined {
		return this.broker?.pid;
	}

	brokerRunning(): boolean {
		return this.broker !== undefined && this.broker.exitCode === null && this.broker.signalCode === null;
	}

	/**
	 * Starts this node's Intercom broker as Atomic does, with the node's settings, and waits until it routes through the
	 * shared database. A keeper client stays connected, so the broker does not retire while idle.
	 */
	async startBroker(): Promise<void> {
		const log = openSync(join(this.logs, "broker.log"), "a");
		const broker = spawn(
			process.execPath,
			[
				"--import",
				pathToFileURL(clockSkew).href,
				getJitiCliPath(intercomDir),
				join(intercomDir, "broker/broker.ts"),
			],
			{ env: { ...this.env(), ATOMIC_STORAGE: "" }, stdio: ["ignore", log, log] },
		);
		closeSync(log);
		this.broker = broker;
		this.fixture.trackBroker(broker);
		const deadline = Date.now() + BROKER_START_ALLOWANCE_MS;
		const remainingMs = () => Math.max(1, deadline - Date.now());
		await vi.waitFor(
			async () => {
				this.fixture.assertRunning();
				if (!(await socketAnswers(this.socketPath))) throw new Error(`broker ${this.name} is not answering yet`);
			},
			{ timeout: remainingMs(), interval: 20 },
		);
		await this.connect(`keeper-${this.name}-${randomUUID().slice(0, 8)}`, { connectTimeoutMs: remainingMs() });
		await this.waitForRouting(remainingMs());
	}

	/** Waits until this node's broker routes through the shared database. */
	async waitForRouting(timeoutMs = BROKER_START_ALLOWANCE_MS): Promise<void> {
		await vi.waitFor(
			async () => {
				this.fixture.assertRunning();
				const status = await queryIntercomBroker(this.agentDir);
				if (status.state !== "running" || status.report.multiNode.status !== "on")
					throw new Error(`broker ${this.name} has not opened multi-node routing`);
			},
			{ timeout: timeoutMs, interval: 50 },
		);
	}

	/** SIGKILL is a crash: the broker's leases and claims stay behind until they go stale. */
	async killBroker(): Promise<void> {
		const broker = this.broker;
		if (broker === undefined || !this.brokerRunning()) return;
		const closed = new Promise<void>((done) => broker.once("close", () => done()));
		broker.kill("SIGKILL");
		await closed;
		recordEvent(this.cluster.scenario, { fault: "sigkill-broker", node: this.name });
		await vi.waitFor(
			() => {
				const live = this.clients.filter((client) => !client.disconnected);
				if (live.length > 0) throw new Error(`clients of broker ${this.name} still connected: ${live.length}`);
			},
			{ timeout: 15_000, interval: 20 },
		);
	}

	/** Freezes the broker (SIGSTOP), as a machine that stops answering does, or thaws it (SIGCONT). */
	signalBroker(signal: "SIGSTOP" | "SIGCONT"): void {
		const pid = this.broker?.pid;
		if (pid === undefined) throw new Error(`node ${this.name} has no broker`);
		process.kill(pid, signal);
		recordEvent(this.cluster.scenario, {
			fault: "sigstop-broker",
			node: this.name,
			phase: signal === "SIGSTOP" ? "start" : "end",
		});
	}

	async connect(name: string, options: ConnectOptions = {}): Promise<NodeClient> {
		const group = options.group ?? "default";
		const returnAddress = options.returnAddress ?? randomUUID();
		const client = new IntercomClient(returnAddress, {
			brokerSocketPath: this.socketPath,
			...(options.preferredSessionId === undefined ? {} : { preferredSessionId: options.preferredSessionId }),
			...(options.takesIdHandoff === undefined ? {} : { takesIdHandoff: options.takesIdHandoff }),
			...(options.idHandoff === undefined ? {} : { idHandoff: options.idHandoff }),
			acknowledgesReceipt: true,
			connectTimeoutMs: options.connectTimeoutMs ?? CLIENT_REGISTRATION_TIMEOUT_MS,
		});
		const attached = new NodeClient(this, name, returnAddress, client);
		client.on("message", (from: SessionInfo, message: Message) => {
			attached.received.push({ from, message, at: performance.now() });
			client.acknowledgeReceived(message.id);
		});
		client.on("error", () => {});
		client.on("disconnected", () => {
			attached.disconnected = true;
		});
		this.clients.push(attached);
		const now = Date.now();
		try {
			await client.connect(
				{
					name,
					model: "distributed-tests",
					cwd: this.home,
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
		} catch (error) {
			attached.disconnected = true;
			throw error;
		}
		return attached;
	}

	async disconnect(client: NodeClient): Promise<void> {
		await client.client.disconnect();
		client.disconnected = true;
	}

	/**
	 * Runs `command` of the node driver `script` (a TypeScript file run by Bun) as a process of this node. `extraEnv` is
	 * added to the node's environment.
	 */
	run<T = Record<string, unknown>>(
		script: string,
		command: string,
		args: object,
		extraEnv: NodeJS.ProcessEnv = {},
		timeoutMs = NODE_STEP_TIMEOUT_MS,
	): { child: ChildProcess; run: Promise<NodeRun<T>>; firstOutput: () => Promise<T> } {
		const child = spawn(
			bunExecutable(),
			["--no-install", "--preload", clockSkew, script, command, JSON.stringify(args)],
			{ cwd: this.home, env: this.env(extraEnv), stdio: ["ignore", "pipe", "pipe"] },
		);
		this.children.add(child);
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		const run = new Promise<NodeRun<T>>((resolveRun) => {
			const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
			child.once("close", (code, signal) => {
				clearTimeout(timer);
				this.children.delete(child);
				writeFileSync(join(this.logs, `${command}-${child.pid}.stderr.log`), stderr);
				const line = stdout.trim().split("\n").filter(Boolean).at(-1);
				resolveRun({ output: line ? (JSON.parse(line) as T) : undefined, code, signal, stderr });
			});
		});
		const firstOutput = () =>
			new Promise<T>((resolveOutput, reject) => {
				const check = () => {
					const line = stdout.split("\n").find((candidate) => candidate.startsWith("{"));
					if (line) resolveOutput(JSON.parse(line) as T);
				};
				check();
				child.stdout?.on("data", check);
				void run.then((ended) => reject(new Error(`node ${this.name} ${command} exited early: ${ended.stderr}`)));
			});
		return { child, run, firstOutput };
	}

	async cleanup(): Promise<void> {
		for (const child of this.children) child.kill("SIGKILL");
		if (this.broker?.pid !== undefined && this.brokerRunning()) {
			try {
				process.kill(this.broker.pid, "SIGCONT");
			} catch {}
		}
		await Promise.all(this.clients.map((client) => client.client.disconnect().catch(() => undefined)));
		await this.fixture.cleanup();
		await this.queries.close();
		await this.wakeUps.close();
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

/** The nodes of one scenario over the run's database, under a table prefix of the scenario's own. */
export class Cluster {
	readonly nodes = new Map<string, Node>();

	private constructor(
		readonly scenario: string,
		readonly prefix: string,
		readonly root: string,
		readonly artifacts: string,
	) {}

	/**
	 * Migrates a prefix of the scenario's own as the owner role, then sets up `names` as nodes. Brokers start only when
	 * a scenario asks for them.
	 */
	static async start(scenario: string, names: readonly string[]): Promise<Cluster> {
		const topology = requireTopology();
		const prefix = scenarioPrefix(scenario);
		migrate(prefix);
		// A short root: a Unix socket path must fit in about 104 bytes.
		const root = realpathSync(mkdtempSync(join(tmpdir(), "adt-")));
		const artifacts = join(topology.runDir, "nodes", scenario);
		mkdirSync(artifacts, { recursive: true });
		const cluster = new Cluster(scenario, prefix, root, artifacts);
		for (const name of names) await cluster.addNode(name);
		recordEvent(scenario, { event: "cluster-started", prefix, nodes: names });
		return cluster;
	}

	/**
	 * Adds a node whose queries go to `queries` (PgBouncer unless given) and whose wake-ups go to `wakeUps` (the primary
	 * unless given).
	 */
	async addNode(
		name: string,
		endpoints: { readonly queries?: Endpoint; readonly wakeUps?: Endpoint } = {},
	): Promise<Node> {
		const topology = requireTopology();
		const queriesTo = endpoints.queries ?? topology.pgbouncer;
		const wakeUpsTo = endpoints.wakeUps ?? topology.primary;
		const queries = await NodeLink.open(queriesTo.host, queriesTo.port);
		const wakeUps = await NodeLink.open(wakeUpsTo.host, wakeUpsTo.port);
		const node = new Node(this, name, join(this.root, name), queries, wakeUps);
		this.nodes.set(name, node);
		return node;
	}

	node(name: string): Node {
		const node = this.nodes.get(name);
		if (node === undefined) throw new Error(`no node ${name}`);
		return node;
	}

	/** Opens this scenario's tables as the runtime role, through PgBouncer as the nodes do, for checks. */
	openShared(): Promise<SqliteDatabase> {
		return openDatabase("runtime", requireTopology().pgbouncer);
	}

	async cleanup(): Promise<void> {
		for (const node of this.nodes.values()) await node.cleanup();
		await removePath(this.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
	}
}
