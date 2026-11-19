import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, test, vi } from "vitest";
import { createMessageReader, writeMessage } from "../../packages/intercom/broker/framing.js";
import { getBrokerSocketPath } from "../../packages/intercom/broker/paths.js";
import { RETURN_PATH_MESSAGE_LIMIT, returnPathClosedReason } from "../../packages/intercom/broker/return-paths.js";
import { getJitiCliPath } from "../../packages/intercom/broker/spawn.js";
import type { BrokerMessage, ClientMessage } from "../../packages/intercom/types.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const extensionDir = join(repoRoot, "packages/intercom");
const agentDir = mkdtempSync(join(tmpdir(), "icrp-"));
const socketPath = getBrokerSocketPath(process.platform, agentDir);
const clients = new Set<WireClient>();
let broker: ChildProcess | undefined;
let brokerOutput = "";

class WireClient {
	readonly received: BrokerMessage[] = [];
	readonly socket = net.createConnection(socketPath);
	private consumed = new Set<number>();

	constructor() {
		clients.add(this);
		this.socket.on(
			"data",
			createMessageReader(
				(message) => this.received.push(message as BrokerMessage),
				(error) => this.socket.destroy(error),
			),
		);
		this.socket.on("error", () => {});
	}

	async connected(): Promise<void> {
		if (!this.socket.connecting) return;
		await new Promise<void>((resolveConnected, reject) => {
			this.socket.once("connect", resolveConnected).once("error", reject);
		});
	}

	send(message: ClientMessage): void {
		writeMessage(this.socket, message);
	}

	async next<T extends BrokerMessage["type"]>(
		type: T,
		matches: (message: Extract<BrokerMessage, { type: T }>) => boolean = () => true,
	): Promise<Extract<BrokerMessage, { type: T }>> {
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline) {
			const index = this.received.findIndex((message, candidate) => {
				if (this.consumed.has(candidate) || message.type !== type) return false;
				return matches(message as Extract<BrokerMessage, { type: T }>);
			});
			if (index >= 0) {
				this.consumed.add(index);
				return this.received[index] as Extract<BrokerMessage, { type: T }>;
			}
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
		}
		throw new Error(`Timed out waiting for broker frame ${type}: ${JSON.stringify(this.received)}`);
	}

	/** Sends one plain message and returns how the broker settled it. */
	async sendTo(to: string, id: string, text: string, expectsReply = false): Promise<BrokerMessage> {
		this.send({
			type: "send",
			to,
			message: { id, timestamp: Date.now(), content: { text }, ...(expectsReply ? { expectsReply } : {}) },
		});
		return await this.settled(id);
	}

	/** The broker's outcome for message `id`: delivered, failed or queued, whichever it answered. */
	async settled(id: string): Promise<BrokerMessage> {
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline) {
			const index = this.received.findIndex(
				(frame, candidate) =>
					!this.consumed.has(candidate) &&
					(frame.type === "delivered" || frame.type === "delivery_failed" || frame.type === "queued") &&
					frame.messageId === id,
			);
			if (index >= 0) {
				this.consumed.add(index);
				return this.received[index]!;
			}
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
		}
		throw new Error(`Timed out waiting for the outcome of ${id}: ${JSON.stringify(this.received)}`);
	}
}

async function waitForBroker(): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const connected = await new Promise<boolean>((resolveConnected) => {
			const probe = net.createConnection(socketPath);
			probe.once("connect", () => {
				probe.destroy();
				resolveConnected(true);
			});
			probe.once("error", () => resolveConnected(false));
		});
		if (connected) return;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
	}
	throw new Error(`Broker socket did not become ready: ${brokerOutput}`);
}

/** A host session registers with its return address, the stable identity a return path binds. */
async function register(
	client: WireClient,
	name: string,
	group: string,
	returnAddress = `host:${name}`,
	acknowledgesReceipt = false,
	reachable?: readonly string[],
): Promise<string> {
	await client.connected();
	client.send({
		type: "register",
		returnAddress,
		...(acknowledgesReceipt ? { acknowledgesReceipt: true as const } : {}),
		...(reachable === undefined ? {} : { reach: { home: group, reachable: [...reachable] } }),
		session: { name, group, cwd: "/repo", model: "test", pid: 1, startedAt: 1, lastActivity: 1 },
	});
	return (await client.next("registered")).sessionId;
}

async function listed(client: WireClient, requestId: string): Promise<void> {
	client.send({ type: "list", requestId });
	await client.next("sessions", (frame) => frame.requestId === requestId);
}

interface Run {
	readonly label: string;
	/** The group the stages are registered in, which the launcher reaches. */
	readonly group: string;
	/** The launcher's home group, which no stage reaches. */
	readonly home: string;
	readonly launcher: WireClient;
	readonly launcherId: string;
	readonly launcherName: string;
}

/**
 * A launcher whose Intercom reach policy reaches the stages' group from a home group the stages do not share: a stage
 * can answer it only on a return path its message opened.
 */
async function launchedRun(label: string, launcherAcknowledgesReceipt = false): Promise<Run> {
	const group = `${label}-stages`;
	const home = `${label}-home`;
	const launcher = new WireClient();
	const launcherName = `${label}-launcher`;
	const launcherId = await register(
		launcher,
		launcherName,
		home,
		`host:${launcherName}`,
		launcherAcknowledgesReceipt,
		[group],
	);
	return { label, group, home, launcher, launcherId, launcherName };
}

function stageName(run: Run, stageId: string): string {
	return `${run.label}-${stageId}`;
}

async function startStage(run: Run, stageId: string): Promise<WireClient> {
	const stage = new WireClient();
	await register(stage, stageName(run, stageId), run.group);
	return stage;
}

/** The launcher's message reaches the stage `stageId`. */
async function launcherNoteReaches(run: Run, stage: WireClient, stageId: string, messageId: string): Promise<void> {
	run.launcher.send({
		type: "send",
		to: stageName(run, stageId),
		message: { id: messageId, timestamp: Date.now(), content: { text: "read me" } },
	});
	await stage.next("message", (frame) => frame.message.id === messageId);
}

beforeAll(async () => {
	broker = spawn(process.execPath, [getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")], {
		env: { ...process.env, ATOMIC_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: undefined },
		stdio: ["ignore", "pipe", "pipe"],
	});
	broker.stdout?.on("data", (data) => {
		brokerOutput += String(data);
	});
	broker.stderr?.on("data", (data) => {
		brokerOutput += String(data);
	});
	await waitForBroker();
});

afterAll(async () => {
	for (const client of clients) client.socket.destroy();
	if (broker?.exitCode === null) {
		const stopped = new Promise<void>((resolveExit) => broker?.once("exit", () => resolveExit()));
		broker.kill("SIGTERM");
		await stopped;
	}
	rmSync(agentDir, { recursive: true, force: true });
});

test("a stage answers the launcher that messaged it, by the name its message showed", async () => {
	const run = await launchedRun("live-answer");
	const stage = await startStage(run, "long-stage");
	const sibling = await startStage(run, "sibling");
	const outsider = new WireClient();
	await register(outsider, "live-answer-outsider", "live-answer-elsewhere");

	run.launcher.send({
		type: "send",
		to: stageName(run, "long-stage"),
		message: { id: "status-check", timestamp: Date.now(), content: { text: "Status check from the main chat" } },
	});
	assert.equal((await run.launcher.settled("status-check")).type, "delivered");
	const inbound = await stage.next("message", (frame) => frame.message.id === "status-check");
	assert.equal(inbound.from.name, run.launcherName);

	// The stage answers the sender its message named, by that name.
	assert.equal((await stage.sendTo(run.launcherName, "answer-1", "On it")).type, "delivered");
	const answer = await run.launcher.next("message", (frame) => frame.message.id === "answer-1");
	assert.equal(answer.message.content.text, "On it");

	// The return path reaches only that sender: a third session stays outside the stage's reach.
	const refused = await stage.sendTo("live-answer-outsider", "third-party", "not reachable");
	assert.equal(refused.type, "delivery_failed");
	// A sibling stage that never received the message gains nothing.
	const siblingAttempt = await sibling.sendTo(run.launcherName, "sibling-answer", "not addressed to me");
	assert.equal(siblingAttempt.type, "delivery_failed");
	assert.equal(
		outsider.received.some((frame) => frame.type === "message"),
		false,
	);
});

test("the return path is bounded in messages and closes with a reason that names its limits", async () => {
	const run = await launchedRun("bounded");
	const stage = await startStage(run, "reviewer");
	await launcherNoteReaches(run, stage, "reviewer", "bounded-question");

	for (let index = 1; index <= RETURN_PATH_MESSAGE_LIMIT; index++) {
		assert.equal((await stage.sendTo(run.launcherId, `bounded-${index}`, `answer ${index}`)).type, "delivered");
	}
	assert.deepEqual(await stage.sendTo(run.launcherId, "bounded-over", "one too many"), {
		type: "delivery_failed",
		messageId: "bounded-over",
		reason: returnPathClosedReason(run.launcherName),
	});

	// A new message from the launcher opens the path again.
	await launcherNoteReaches(run, stage, "reviewer", "bounded-follow-up");
	assert.equal((await stage.sendTo(run.launcherName, "bounded-reopened", "Sure")).type, "delivered");
});

test("a stage still cannot reach the launcher before the launcher has written to it", async () => {
	const run = await launchedRun("unprompted");
	const stage = await startStage(run, "quiet");
	const refused = await stage.sendTo(run.launcherName, "unprompted", "hello");
	assert.equal(refused.type, "delivery_failed");
	assert.equal(
		run.launcher.received.some((frame) => frame.type === "message" && frame.message.id === "unprompted"),
		false,
	);
});

test("two messages that reached a stage give it one budget, counted from the latest", async () => {
	const run = await launchedRun("one-budget");
	const stage = await startStage(run, "twice");
	await launcherNoteReaches(run, stage, "twice", "first-note");
	await launcherNoteReaches(run, stage, "twice", "second-note");

	for (let index = 1; index <= RETURN_PATH_MESSAGE_LIMIT; index++) {
		assert.equal((await stage.sendTo(run.launcherName, `one-budget-${index}`, `answer ${index}`)).type, "delivered");
	}
	// The older message's path adds no answers of its own.
	assert.deepEqual(await stage.sendTo(run.launcherName, "one-budget-over", "one too many"), {
		type: "delivery_failed",
		messageId: "one-budget-over",
		reason: returnPathClosedReason(run.launcherName),
	});
	// A retried answer is the same message: it is not counted again.
	assert.equal((await stage.sendTo(run.launcherName, "one-budget-1", "answer 1")).type, "delivered");
});

/** Unregistering and registering ten thousand sessions is the structural cost of evicting every retired id binding. */
const ID_CHURN_TEST_TIMEOUT_MS = 120_000;
const ID_CHURN_BATCH = 500;

test(
	"a session that takes an ended sender's id and name after the broker forgot it inherits no return path",
	async () => {
		const run = await launchedRun("id-churn");
		const stage = await startStage(run, "stage");
		await launcherNoteReaches(run, stage, "stage", "id-churn-note");
		run.launcher.send({ type: "unregister" });
		await new Promise<void>((done) => {
			run.launcher.socket.once("close", () => done());
			run.launcher.socket.end();
		});
		// Enough registrations to evict every retired id binding, with no Intercom message among them.
		const churn = new WireClient();
		await churn.connected();
		for (let index = 0; index < 10_001; index++) {
			churn.send({
				type: "register",
				session: {
					name: `churn-${index}`,
					group: "churn-only",
					cwd: "/repo",
					model: "test",
					pid: 1,
					startedAt: 1,
					lastActivity: 1,
					recipientPurpose: "control",
				},
			});
			if (index % ID_CHURN_BATCH === 0) await listed(churn, `churn-${index}`);
			churn.send({ type: "unregister" });
		}
		// The broker has handled every one of them before the next session registers.
		churn.send({
			type: "register",
			session: {
				name: "churn-final",
				group: "churn-only",
				cwd: "/repo",
				model: "test",
				pid: 1,
				startedAt: 1,
				lastActivity: 1,
				recipientPurpose: "control",
			},
		});
		churn.send({ type: "list", requestId: "churn-done" });
		await churn.next("sessions", (frame) => frame.requestId === "churn-done");
		const taker = new WireClient();
		await taker.connected();
		taker.send({
			type: "register",
			preferredSessionId: run.launcherId,
			returnAddress: "another-host",
			session: {
				name: run.launcherName,
				group: run.home,
				cwd: "/repo",
				model: "test",
				pid: 1,
				startedAt: 1,
				lastActivity: 1,
			},
		});
		await taker.next("registered", (frame) => frame.sessionId === run.launcherId);
		assert.equal(
			(await stage.sendTo(run.launcherName, "id-churn-by-name", "only for the original sender")).type,
			"delivery_failed",
		);
		assert.equal(
			(await stage.sendTo(run.launcherId, "id-churn-by-id", "only for the original sender")).type,
			"delivery_failed",
		);
		assert.equal(
			taker.received.some((frame) => frame.type === "message"),
			false,
		);
	},
	ID_CHURN_TEST_TIMEOUT_MS,
);

test("a session that only reuses an ended sender's name inherits no return path", async () => {
	const run = await launchedRun("name-reuse");
	const stage = await startStage(run, "stage");
	await launcherNoteReaches(run, stage, "stage", "name-reuse-note");
	run.launcher.send({ type: "unregister" });
	await new Promise<void>((done) => {
		run.launcher.socket.once("close", () => done());
		run.launcher.socket.end();
	});
	const replacement = new WireClient();
	const replacementId = await register(replacement, run.launcherName, run.home, "replacement-host");
	assert.notEqual(replacementId, run.launcherId);
	assert.equal(
		(await stage.sendTo(run.launcherName, "name-reuse-reply", "only for the original sender")).type,
		"delivery_failed",
	);
	assert.equal(
		replacement.received.some((frame) => frame.type === "message"),
		false,
	);
});

test("the launcher's retry of a message its stage already received opens no new answers", async () => {
	const run = await launchedRun("retry-budget");
	const stage = await startStage(run, "later");
	const original = {
		type: "send" as const,
		to: stageName(run, "later"),
		message: { id: "retry-budget-note", timestamp: Date.now(), content: { text: "one original message" } },
	};
	run.launcher.send(original);
	assert.equal((await run.launcher.settled(original.message.id)).type, "delivered");
	await stage.next("message", (frame) => frame.message.id === original.message.id);
	for (let index = 0; index < RETURN_PATH_MESSAGE_LIMIT; index++) {
		assert.equal((await stage.sendTo(run.launcherId, `retry-budget-answer-${index}`, "answer")).type, "delivered");
	}
	assert.equal((await stage.sendTo(run.launcherId, "retry-budget-closed", "over")).type, "delivery_failed");
	// The broker already handed that message over: it answers the identical retry without delivering anything new.
	run.launcher.send(original);
	assert.equal((await run.launcher.settled(original.message.id)).type, "delivered");
	assert.equal(
		(await stage.sendTo(run.launcherId, "retry-budget-after-retry", "still closed")).type,
		"delivery_failed",
	);
	assert.equal(
		stage.received.filter((frame) => frame.type === "message" && frame.message.id === original.message.id).length,
		1,
	);
});

/** The launcher steps away (a resumable unregister) and comes back as the same registration under a fresh broker id. */
async function reconnectLauncher(run: Run): Promise<{ back: WireClient; backId: string }> {
	run.launcher.send({ type: "unregister", resumable: true });
	await new Promise<void>((done) => {
		run.launcher.socket.once("close", () => done());
		run.launcher.socket.end();
	});
	const back = new WireClient();
	const backId = await register(back, run.launcherName, run.home, `host:${run.launcherName}`, false, [run.group]);
	assert.notEqual(backId, run.launcherId);
	return { back, backId };
}

test("a stage answers by name a launcher that came back under a new id after writing to it", async () => {
	const run = await launchedRun("reconnect");
	const stage = await startStage(run, "later");
	await launcherNoteReaches(run, stage, "later", "reconnect-note");
	const { back, backId } = await reconnectLauncher(run);
	assert.equal((await stage.sendTo(backId, "reconnect-by-id", "by id")).type, "delivered");
	const byName = await stage.sendTo(run.launcherName, "reconnect-by-name", "by name");
	assert.equal(byName.type, "delivered", JSON.stringify(byName));
	assert.equal(
		(await back.next("message", (frame) => frame.message.id === "reconnect-by-name")).message.content.text,
		"by name",
	);
});

/** A stage that confirms each message it saves only when the test says so, as a stage whose save is slow does. */
async function startReceiptStage(run: Run, name: string): Promise<WireClient> {
	const stage = new WireClient();
	await register(stage, name, run.group, `host:${name}`, true);
	return stage;
}

/** The launcher's message reaches `stage` by `name`, which has not confirmed it yet. */
async function launcherNoteReachesByName(run: Run, stage: WireClient, name: string, messageId: string): Promise<void> {
	run.launcher.send({
		type: "send",
		to: name,
		message: { id: messageId, timestamp: Date.now(), content: { text: "read me" } },
	});
	await stage.next("message", (frame) => frame.message.id === messageId);
}

test("a stage whose receipt arrives after the launcher came back under a new id answers it by name", async () => {
	const run = await launchedRun("receipt-reconnect");
	const stage = await startReceiptStage(run, "receipt-stage");
	await launcherNoteReachesByName(run, stage, "receipt-stage", "receipt-note");
	const { backId } = await reconnectLauncher(run);
	// The stage confirms it saved the message only now, after the launcher came back.
	stage.send({ type: "received", messageId: "receipt-note" });
	await listed(stage, "receipt-processed");
	assert.equal((await stage.sendTo(backId, "receipt-by-id", "by id")).type, "delivered");
	const byName = await stage.sendTo(run.launcherName, "receipt-by-name", "by name");
	assert.equal(byName.type, "delivered", JSON.stringify(byName));
});

test("a stage whose receipt arrives after the launcher ended for good opens nothing a later registration inherits", async () => {
	const run = await launchedRun("receipt-ended");
	const stage = await startReceiptStage(run, "receipt-ended-stage");
	await launcherNoteReachesByName(run, stage, "receipt-ended-stage", "receipt-ended-note");
	run.launcher.send({ type: "unregister" });
	await new Promise<void>((done) => {
		run.launcher.socket.once("close", () => done());
		run.launcher.socket.end();
	});
	// The stage confirms it saved the message only after the launcher said goodbye.
	stage.send({ type: "received", messageId: "receipt-ended-note" });
	await listed(stage, "receipt-ended-processed");
	// A new registration copies the ended launcher's return address, group and name.
	const copy = new WireClient();
	await register(copy, run.launcherName, run.home);
	const answer = await stage.sendTo(run.launcherName, "receipt-ended-answer", "only for the launcher that ended");
	assert.equal(answer.type, "delivery_failed", JSON.stringify(answer));
	await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
	assert.equal(
		copy.received.some((frame) => frame.type === "message"),
		false,
	);
});

test("a stage whose receipt arrives after the launcher crashed, came back and ended for good opens nothing", async () => {
	const run = await launchedRun("receipt-hop");
	const stage = await startReceiptStage(run, "receipt-hop-stage");
	await launcherNoteReachesByName(run, stage, "receipt-hop-stage", "receipt-hop-note");
	// The launcher's connection drops without a goodbye, and the broker notices it is away.
	const observer = new WireClient();
	await register(observer, "receipt-hop-observer", run.home);
	run.launcher.socket.destroy();
	await vi.waitFor(async () => {
		observer.send({ type: "list", requestId: "receipt-hop-away" });
		const sessions = (await observer.next("sessions", (frame) => frame.requestId === "receipt-hop-away")).sessions;
		assert.equal(
			sessions.some((session) => session.id === run.launcherId),
			false,
		);
	});
	// It comes back under a new id, then says goodbye for good.
	const back = new WireClient();
	await register(back, run.launcherName, run.home);
	back.send({ type: "unregister" });
	await new Promise<void>((done) => {
		back.socket.once("close", () => done());
		back.socket.end();
	});
	// The stage confirms the message the launcher's first connection sent only now.
	stage.send({ type: "received", messageId: "receipt-hop-note" });
	await listed(stage, "receipt-hop-processed");
	const copy = new WireClient();
	await register(copy, run.launcherName, run.home);
	const answer = await stage.sendTo(run.launcherName, "receipt-hop-answer", "only for the launcher that ended");
	assert.equal(answer.type, "delivery_failed", JSON.stringify(answer));
	await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
	assert.equal(
		copy.received.some((frame) => frame.type === "message"),
		false,
	);
});

test("a name two live registrations of the launcher's identity share stays ambiguous", async () => {
	const run = await launchedRun("live-duplicate");
	const stage = await startStage(run, "stage");
	await launcherNoteReaches(run, stage, "stage", "live-duplicate-note");
	// Another registration copies the launcher's return address, group and name while the launcher is still live.
	const duplicate = new WireClient();
	const duplicateId = await register(duplicate, run.launcherName, run.home);
	assert.notEqual(duplicateId, run.launcherId);
	const refused = await stage.sendTo(run.launcherName, "live-duplicate-answer", "for the launcher");
	assert.equal(refused.type, "delivery_failed", JSON.stringify(refused));
	await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
	assert.equal(
		duplicate.received.some((frame) => frame.type === "message"),
		false,
	);
	assert.equal(
		run.launcher.received.some((frame) => frame.type === "message" && frame.message.id === "live-duplicate-answer"),
		false,
	);
});

test("a duplicate of the launcher's identity that ends for good leaves the live launcher's path open", async () => {
	const run = await launchedRun("duplicate-ended");
	const stage = await startStage(run, "stage");
	await launcherNoteReaches(run, stage, "stage", "duplicate-ended-note");
	const duplicate = new WireClient();
	await register(duplicate, run.launcherName, run.home);
	duplicate.send({ type: "unregister" });
	await new Promise<void>((done) => {
		duplicate.socket.once("close", () => done());
		duplicate.socket.end();
	});
	const answer = await stage.sendTo(run.launcherName, "duplicate-ended-answer", "for the launcher");
	assert.equal(answer.type, "delivered", JSON.stringify(answer));
	const received = await run.launcher.next("message", (frame) => frame.message.id === "duplicate-ended-answer");
	assert.equal(received.message.content.text, "for the launcher");
});
