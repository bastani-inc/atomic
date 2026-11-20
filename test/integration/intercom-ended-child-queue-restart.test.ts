import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, test, vi } from "vitest";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";
import { sleep } from "../helpers/runtime.js";

/**
 * #5999 durable wake queue: messages queued for a subagent that finished (to be resumed) or was paused (to be continued)
 * survive the broker being killed. Each test runs its own real broker processes on an agent directory of its own, kills
 * them with SIGKILL, and starts the next one, as a crash or a machine restart would; the sessions register again as
 * their extensions do (same return address, same Intercom id), and the owner reports its ended children again.
 */

const repoRoot = resolve(import.meta.dirname, "../..");
const { getJitiCliPath } = await import("../../packages/intercom/broker/spawn.js");
const { getBrokerSocketPath, getBrokerEndedChildQueuePath } = await import("../../packages/intercom/broker/paths.js");
const { IntercomClient, EndedQueueMemory } = await import("../../packages/intercom/broker/client.js");
const { BROKER_CRASH_AT_ENV, ENDED_QUEUE_KEPT, ENDED_QUEUE_RECEIVED } = await import(
	"../../packages/intercom/broker/crash-points.js"
);
const { PAUSED_RECIPIENT_TARGET, RESUMING_RECIPIENT_TARGET } = await import(
	"../../packages/intercom/broker/ended-child-wakes.js"
);
const { queryIntercomBroker } = await import("../../packages/intercom/broker/control.js");
/** The shared storage adapter the multi-node suites select: SQLite, through the storage layer's adapter module. */
const STORAGE_ADAPTER = join(repoRoot, "test/fixtures/storage-adapter.ts");
const SHARED_PREFIX = "ecq_";

type Client = InstanceType<typeof IntercomClient>;
type Memory = InstanceType<typeof EndedQueueMemory>;
type Notice = import("../../packages/intercom/broker/client.js").EndedChildWakeNotice;
type Lost = import("../../packages/intercom/broker/client.js").LostEndedQueuedMessage;
interface Received {
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

/** Real broker processes, killed and started again: their start, registration and restore are the structural cost. */
const RESTART_TEST_TIMEOUT_MS = 120_000;
const BROKER_START_WAIT_MS = 60_000;
const WAIT = { timeout: 20_000, interval: 25 } as const;
/** Long enough for a frame that must not come (a second copy, a wake) to have arrived. */
const SETTLE_MS = 750;

const fixtures: IntercomBrokerFixture[] = [];
afterEach(async () => {
	for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});
afterAll(async () => {
	for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

/** Ask the broker to shut down in order, as `atomic intercom restart` does, on every platform. */
async function requestShutdown(host: Host): Promise<void> {
	const { createMessageReader, writeMessage } = await import("../../packages/intercom/broker/framing.js");
	const net = await import("node:net");
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

/** One agent directory and its broker, started, killed and started again. */
class Host {
	readonly fixture: IntercomBrokerFixture;
	private broker: ChildProcess | undefined;

	/** `shared`: the broker selects a shared SQLite database at this path, so multi-node routing is on. */
	constructor(private readonly shared?: string) {
		this.fixture = new IntercomBrokerFixture(mkdtempSync(join(tmpdir(), "ecq-")));
		fixtures.push(this.fixture);
		if (shared !== undefined)
			writeFileSync(
				join(this.agentDir, "settings.json"),
				JSON.stringify({ storage: { adapter: STORAGE_ADAPTER, options: { path: shared }, prefix: SHARED_PREFIX } }),
			);
	}

	get agentDir(): string {
		return this.fixture.agentDir;
	}

	async start(env: Readonly<Record<string, string>> = {}): Promise<void> {
		const extensionDir = join(repoRoot, "packages/intercom");
		const broker = spawn(process.execPath, [getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")], {
			env: { ...process.env, ...env, ATOMIC_CODING_AGENT_DIR: this.agentDir },
			stdio: process.env.ECQ_BROKER_STDERR === "1" ? ["ignore", "ignore", "inherit"] : "ignore",
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

interface Session {
	readonly client: Client;
	readonly received: Received[];
	readonly wakes: Notice[];
	readonly lost: Lost[];
	readonly returnAddress: string;
	/** Its Intercom id, as registered (the client forgets it once its broker is gone). */
	readonly sessionId: string;
}

interface SessionOptions {
	readonly returnAddress?: string;
	readonly preferredSessionId?: string;
	readonly ownerToken?: string;
	readonly supervisor?: { capability: string; supervisorSessionId: string };
	readonly memory?: Memory;
	/** Confirm each message once saved, as a session's durable inbox does (#3761). */
	readonly confirms?: boolean;
}

/** A session as its extension registers it, and again after a restart: same return address, same Intercom id. */
async function connect(host: Host, name: string, options: SessionOptions = {}): Promise<Session> {
	const returnAddress = options.returnAddress ?? randomUUID();
	const client = new IntercomClient(returnAddress, {
		brokerSocketPath: getBrokerSocketPath(process.platform, host.agentDir),
		...(options.preferredSessionId === undefined ? {} : { preferredSessionId: options.preferredSessionId }),
		...(options.confirms === false ? {} : { acknowledgesReceipt: true }),
		...(options.memory === undefined ? {} : { endedQueue: options.memory }),
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
			group: "default",
			groups: ["default"],
		},
		options.supervisor,
		options.ownerToken,
		undefined,
		"default",
	);
	host.fixture.onCleanup(() => client.disconnect().catch(() => undefined));
	assert.ok(client.sessionId);
	return { client, received, wakes, lost, returnAddress, sessionId: client.sessionId };
}

/** The same session, registering with the next broker. */
function again(host: Host, name: string, session: Session, options: SessionOptions = {}): Promise<Session> {
	return connect(host, name, {
		returnAddress: session.returnAddress,
		preferredSessionId: session.sessionId,
		...options,
	});
}

async function untilGone(observer: Client, sessionId: string | null): Promise<void> {
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
async function endedChild(
	host: Host,
	ownerSession: Session,
	childName: string,
	outcome: "completed" | "stopped",
): Promise<void> {
	const child = await connect(host, childName, {
		supervisor: await ownerSession.client.authorizeSupervisorChild(childName),
	});
	const id = child.client.sessionId;
	await child.client.disconnect();
	await untilGone(ownerSession.client, id);
	await markEnded(ownerSession, childName, outcome);
}

function markEnded(owner: Session, childName: string, outcome: "completed" | "stopped"): Promise<void> {
	return owner.client.markEndedChildren([
		{
			childName,
			childId: `${childName}:0`,
			outcome,
			aliases: [],
			messages: outcome === "stopped" ? "hold" : "wake",
		},
	]);
}

async function owner(host: Host, label: string, existing?: Session): Promise<Session> {
	const ownerToken = existing === undefined ? randomUUID() : (ownerTokens.get(existing) as string);
	const session =
		existing === undefined
			? await connect(host, `${label}-owner`, { ownerToken })
			: await again(host, `${label}-owner`, existing, { ownerToken });
	ownerTokens.set(session, ownerToken);
	return session;
}
const ownerTokens = new WeakMap<Session, string>();

/** The owner continues or resumes the child: it registers again under the owner's authorization. */
async function resume(host: Host, ownerSession: Session, childName: string): Promise<Session> {
	return connect(host, childName, { supervisor: await ownerSession.client.authorizeSupervisorChild(childName) });
}

function texts(session: Session): string[] {
	return session.received.map(({ message }) => message.content.text);
}

/**
 * The scenario both storage modes run: messages queued for a completed subagent and for a paused one, the broker killed,
 * the next broker started, every session back. `start` starts (or restarts) the mode's broker.
 */
async function survivesRestart(host: Host, start: () => Promise<void>): Promise<void> {
	await start();
	const ownerBefore = await owner(host, "restart");
	await endedChild(host, ownerBefore, "subagent-worker-done-1", "completed");
	await endedChild(host, ownerBefore, "subagent-worker-paused-1", "stopped");
	const memory = new EndedQueueMemory();
	const senderBefore = await connect(host, "restart-sender", { memory });
	const askId = randomUUID();
	const answers = [
		await senderBefore.client.send("subagent-worker-done-1", { text: "first", wakeEndedRecipient: true }),
		await senderBefore.client.send("subagent-worker-done-1", {
			text: "what did you find?",
			messageId: askId,
			expectsReply: true,
			wakeEndedRecipient: true,
		}),
		await senderBefore.client.send("subagent-worker-done-1", { text: "third", wakeEndedRecipient: true }),
		await senderBefore.client.send("subagent-worker-paused-1", {
			text: "when you are back",
			wakeEndedRecipient: true,
		}),
	];
	assert.deepEqual(
		answers.map((answer) => [answer.queued, answer.target]),
		[
			[true, RESUMING_RECIPIENT_TARGET],
			[true, RESUMING_RECIPIENT_TARGET],
			[true, RESUMING_RECIPIENT_TARGET],
			[true, PAUSED_RECIPIENT_TARGET],
		],
	);
	// Its owner was asked to resume the finished one, and the broker is killed before it did.
	await vi.waitFor(() => assert.equal(ownerBefore.wakes.length, 1), WAIT);
	await host.kill();

	await start();
	const ownerAfter = await owner(host, "restart", ownerBefore);
	const sender = await again(host, "restart-sender", senderBefore, { memory });
	assert.equal(sender.sessionId, senderBefore.sessionId);
	assert.equal(ownerAfter.sessionId, ownerBefore.sessionId);
	// It reports its ended children again, as its extension does on every connection.
	await markEnded(ownerAfter, "subagent-worker-done-1", "completed");
	await markEnded(ownerAfter, "subagent-worker-paused-1", "stopped");

	// The finished subagent is woken again, once, and resumed: it gets each message once, in its sender's order.
	await vi.waitFor(() => assert.equal(ownerAfter.wakes.length, 1), WAIT);
	const [wake] = ownerAfter.wakes;
	assert.equal(wake!.childName, "subagent-worker-done-1");
	assert.notEqual(wake!.wakeId, ownerBefore.wakes[0]!.wakeId, "a new wake, never the lost broker's");
	assert.equal(ownerAfter.client.answerEndedChildWake("subagent-worker-done-1", wake!.wakeId, true), true);
	const done = await resume(host, ownerAfter, "subagent-worker-done-1");
	await vi.waitFor(() => assert.equal(done.received.length, 3), WAIT);
	assert.deepEqual(texts(done), ["first", "what did you find?", "third"]);
	assert.equal(done.received[1]!.message.id, askId);
	assert.equal(done.received[1]!.message.expectsReply, true);

	// The ask gets its reply.
	const replied = await done.client.send(done.received[1]!.from.id, {
		text: "three bugs",
		replyTo: askId,
		requirePendingReply: true,
	});
	assert.equal(replied.delivered, true, replied.reason);
	await vi.waitFor(
		() =>
			assert.deepEqual(
				sender.received
					.filter(({ message }) => message.replyTo === askId)
					.map(({ message }) => message.content.text),
				["three bugs"],
			),
		WAIT,
	);

	// The paused subagent is not woken: its message waits until it is continued, then reaches it once.
	await sleep(SETTLE_MS);
	assert.equal(ownerAfter.wakes.length, 1, "the paused subagent is never woken");
	const paused = await resume(host, ownerAfter, "subagent-worker-paused-1");
	await vi.waitFor(() => assert.equal(paused.received.length, 1), WAIT);
	assert.equal(paused.received[0]!.message.content.text, "when you are back");
	assert.equal(paused.received[0]!.message.heldWhilePaused, true);

	await sleep(SETTLE_MS);
	assert.deepEqual(texts(done), ["first", "what did you find?", "third"], "nothing twice");
	assert.equal(paused.received.length, 1, "nothing twice");
	assert.deepEqual(sender.lost, [], "the sender is told nothing was lost: nothing was");
	assert.deepEqual(
		sender.received.filter(({ message }) => message.replyError !== undefined),
		[],
		"no message failed",
	);
	assert.equal((await sender.client.brokerStatus())?.queuedBytes, 0, "nothing is left queued");
}

test(
	"messages for a completed and a paused subagent survive a broker killed with SIGKILL, in the default local store (#5999)",
	async () => {
		const host = new Host();
		await survivesRestart(host, () => host.start());
	},
	RESTART_TEST_TIMEOUT_MS,
);

test(
	"messages for a completed and a paused subagent survive a broker killed with SIGKILL, in the shared database (#5999)",
	async () => {
		const shared = join(mkdtempSync(join(tmpdir(), "ecq-shared-")), "shared.sqlite");
		const host = new Host(shared);
		await survivesRestart(host, () => host.start());
		// Kept in the shared database, under its prefix; nothing in the local file.
		const { openNodeSqliteDatabase } = await import("@bastani/atomic/storage");
		const database = await openNodeSqliteDatabase(shared);
		try {
			const tables = await database.all<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ecq_intercom_ended_child_%' ORDER BY name",
			);
			assert.deepEqual(
				tables.map((table) => table.name),
				["ecq_intercom_ended_child_meta", "ecq_intercom_ended_child_queue", "ecq_intercom_ended_child_wakes"],
			);
		} finally {
			await database.close();
		}
		assert.equal(existsSync(getBrokerEndedChildQueuePath(host.agentDir)), false);
	},
	RESTART_TEST_TIMEOUT_MS,
);

test(
	"a broker killed after keeping a message and before answering it: the retry with its id is answered queued, and it arrives once (#5999)",
	async () => {
		const host = new Host();
		await host.start({ [BROKER_CRASH_AT_ENV]: ENDED_QUEUE_KEPT });
		const ownerBefore = await owner(host, "kept");
		await endedChild(host, ownerBefore, "subagent-worker-kept-1", "completed");
		const memory = new EndedQueueMemory();
		const senderBefore = await connect(host, "kept-sender", { memory });
		const messageId = randomUUID();
		// The broker keeps it and dies before it answers: the client never hears `queued`.
		const cut = senderBefore.client
			.send("subagent-worker-kept-1", { text: "only once", messageId, wakeEndedRecipient: true })
			.catch((error: Error) => ({ delivered: false, queued: undefined, reason: error.message }));
		await host.exited();
		const unanswered = await cut;
		assert.notEqual(unanswered.queued, true, "the crash came before the answer");

		await host.start();
		const ownerAfter = await owner(host, "kept", ownerBefore);
		const sender = await again(host, "kept-sender", senderBefore, { memory });
		// The tool sends it again with the same id, before the owner reported the subagent again.
		const retried = await sender.client.send("subagent-worker-kept-1", {
			text: "only once",
			messageId,
			wakeEndedRecipient: true,
		});
		assert.equal(retried.queued, true, retried.reason);
		assert.equal(retried.target, RESUMING_RECIPIENT_TARGET);
		await markEnded(ownerAfter, "subagent-worker-kept-1", "completed");
		await vi.waitFor(() => assert.equal(ownerAfter.wakes.length, 1), WAIT);
		ownerAfter.client.answerEndedChildWake("subagent-worker-kept-1", ownerAfter.wakes[0]!.wakeId, true);
		const child = await resume(host, ownerAfter, "subagent-worker-kept-1");
		await vi.waitFor(() => assert.equal(child.received.length, 1), WAIT);
		await sleep(SETTLE_MS);
		assert.deepEqual(
			child.received.map(({ message }) => message.id),
			[messageId],
			"one row, one delivery",
		);
		assert.equal(ownerAfter.wakes.length, 1, "one wake");
	},
	RESTART_TEST_TIMEOUT_MS,
);

test(
	"a broker killed after the subagent saved a message and before its row was deleted delivers nothing twice and wakes nobody (#5999)",
	async () => {
		const host = new Host();
		await host.start({ [BROKER_CRASH_AT_ENV]: ENDED_QUEUE_RECEIVED });
		const ownerBefore = await owner(host, "received");
		await endedChild(host, ownerBefore, "subagent-worker-received-1", "completed");
		const memory = new EndedQueueMemory();
		const senderBefore = await connect(host, "received-sender", { memory });
		const queued = await senderBefore.client.send("subagent-worker-received-1", {
			text: "saved once",
			wakeEndedRecipient: true,
		});
		assert.equal(queued.queued, true, queued.reason);
		await vi.waitFor(() => assert.equal(ownerBefore.wakes.length, 1), WAIT);
		ownerBefore.client.answerEndedChildWake("subagent-worker-received-1", ownerBefore.wakes[0]!.wakeId, true);
		// The resumed subagent saves it and confirms; the broker dies before it deletes the row.
		const childBefore = await resume(host, ownerBefore, "subagent-worker-received-1");
		await host.exited();
		assert.deepEqual(texts(childBefore), ["saved once"]);

		await host.start();
		const ownerAfter = await owner(host, "received", ownerBefore);
		const sender = await again(host, "received-sender", senderBefore, { memory });
		// Its run ended meanwhile; its owner reports it again.
		await markEnded(ownerAfter, "subagent-worker-received-1", "completed");
		await sleep(SETTLE_MS * 2);
		assert.deepEqual(ownerAfter.wakes, [], "nothing is left to wake it for");
		assert.deepEqual(sender.lost, []);
		assert.deepEqual(
			sender.received.filter(({ message }) => message.replyError !== undefined),
			[],
			"it is not told it failed: it was delivered",
		);
		assert.equal((await sender.client.brokerStatus())?.queuedBytes, 0);
	},
	RESTART_TEST_TIMEOUT_MS,
);

test(
	"a store that cannot be opened keeps the queue in memory, and a restart tells each sender once that it was lost (#5999)",
	async () => {
		const host = new Host();
		// Not a database: a directory where the file would be.
		mkdirSync(getBrokerEndedChildQueuePath(host.agentDir), { recursive: true });
		await host.start();
		const ownerBefore = await owner(host, "unopenable");
		await endedChild(host, ownerBefore, "subagent-worker-unopenable-1", "completed");
		const memory = new EndedQueueMemory();
		const senderBefore = await connect(host, "unopenable-sender", { memory });
		const messageId = randomUUID();
		const queued = await senderBefore.client.send("subagent-worker-unopenable-1", {
			text: "kept in memory",
			messageId,
			wakeEndedRecipient: true,
		});
		assert.equal(queued.queued, true, queued.reason);
		await host.kill();
		await host.start();
		const sender = await again(host, "unopenable-sender", senderBefore, { memory });
		await vi.waitFor(
			() =>
				assert.deepEqual(
					sender.lost.map((lost) => lost.messageId),
					[messageId],
				),
			WAIT,
		);
	},
	RESTART_TEST_TIMEOUT_MS,
);

test(
	"a corrupt store keeps the queue in memory, and a restart tells each sender once that it was lost (#5999)",
	async () => {
		const host = new Host();
		const path = getBrokerEndedChildQueuePath(host.agentDir);
		mkdirSync(resolve(path, ".."), { recursive: true });
		writeFileSync(path, "this is not a SQLite database, and was never one".repeat(100));
		await host.start();
		const ownerBefore = await owner(host, "corrupt");
		await endedChild(host, ownerBefore, "subagent-worker-corrupt-1", "stopped");
		const memory = new EndedQueueMemory();
		const senderBefore = await connect(host, "corrupt-sender", { memory });
		const messageId = randomUUID();
		const queued = await senderBefore.client.send("subagent-worker-corrupt-1", {
			text: "kept in memory",
			messageId,
			wakeEndedRecipient: true,
		});
		assert.equal(queued.queued, true, queued.reason);
		assert.equal(queued.target, PAUSED_RECIPIENT_TARGET);
		await host.kill();
		await host.start();
		const sender = await again(host, "corrupt-sender", senderBefore, { memory });
		await vi.waitFor(
			() =>
				assert.deepEqual(
					sender.lost.map((lost) => lost.messageId),
					[messageId],
				),
			WAIT,
		);
	},
	RESTART_TEST_TIMEOUT_MS,
);

test(
	"a broker's orderly shutdown closes its store, so the Intercom directory can be removed at once (Windows locks open files) (#5999)",
	async () => {
		const host = new Host();
		await host.start();
		const ownerBefore = await owner(host, "closed");
		await endedChild(host, ownerBefore, "subagent-worker-closed-1", "stopped");
		const sender = await connect(host, "closed-sender");
		const queued = await sender.client.send("subagent-worker-closed-1", { text: "kept", wakeEndedRecipient: true });
		assert.equal(queued.queued, true, queued.reason);
		await sender.client.disconnect();
		await ownerBefore.client.disconnect();
		await requestShutdown(host);
		await host.exited();
		rmSync(getBrokerEndedChildQueuePath(host.agentDir), { force: true });
		rmSync(`${getBrokerEndedChildQueuePath(host.agentDir)}-wal`, { force: true });
		rmSync(`${getBrokerEndedChildQueuePath(host.agentDir)}-shm`, { force: true });
	},
	RESTART_TEST_TIMEOUT_MS,
);
