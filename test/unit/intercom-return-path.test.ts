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
): Promise<string> {
	await client.connected();
	client.send({
		type: "register",
		returnAddress,
		...(acknowledgesReceipt ? { acknowledgesReceipt: true as const } : {}),
		session: { name, group, cwd: "/repo", model: "test", pid: 1, startedAt: 1, lastActivity: 1 },
	});
	return (await client.next("registered")).sessionId;
}

async function listed(client: WireClient, requestId: string): Promise<void> {
	client.send({ type: "list", requestId });
	await client.next("sessions", (frame) => frame.requestId === requestId);
}

interface Run {
	readonly runId: string;
	readonly group: string;
	readonly routeCapability: string;
	readonly owner: WireClient;
	readonly launcher: WireClient;
	readonly launcherId: string;
	readonly launcherName: string;
}

/**
 * A workflow run whose launcher, registered outside the run's group, holds the launcher claim (#4006). With `subgroup`,
 * its stages are declared in an isolated subgroup of the invocation.
 */
async function launchedRun(
	label: string,
	runId: string,
	stageIds: readonly string[],
	subgroup = false,
	launcherAcknowledgesReceipt = false,
): Promise<Run> {
	const group = `workflow:${runId}`;
	const routeCapability = `${label}-route-capability`;
	const launcherCapability = `${label}-launcher-capability`;
	const owner = new WireClient();
	const launcher = new WireClient();
	await register(owner, `${label}-owner`, group);
	const launcherName = `${label}-launcher`;
	const launcherId = await register(
		launcher,
		launcherName,
		"default",
		`host:${launcherName}`,
		launcherAcknowledgesReceipt,
	);
	owner.send({
		type: "register_pending_stage_route",
		runId,
		group,
		capability: routeCapability,
		launcherCapability,
		stages: stageIds.map((stageId) => ({
			stageId,
			stageName: stageId,
			target: `${group}/${stageId}`,
			lifecycle: "pending" as const,
			routeEligible: true,
			group: subgroup ? `${group}/isolated` : group,
		})),
	});
	await listed(owner, `${label}-route`);
	launcher.send({
		type: "claim_workflow_invocation",
		requestId: `${label}-claim`,
		runId,
		capability: launcherCapability,
	});
	assert.equal((await launcher.next("workflow_invocation_claimed")).claimed, true);
	return { runId, group, routeCapability, owner, launcher, launcherId, launcherName };
}

async function startStage(run: Run, stageId: string, subgroup = false): Promise<WireClient> {
	const stage = new WireClient();
	await register(stage, `${run.runId.slice(0, 8)}-${stageId}`, subgroup ? `${run.group}/isolated` : run.group);
	stage.send({
		type: "register_live_workflow_stage_route",
		requestId: `${stageId}-live-route`,
		runId: run.runId,
		stageKeys: [stageId],
		capability: run.routeCapability,
	});
	await stage.next("live_workflow_stage_route_registered", (frame) => frame.requestId === `${stageId}-live-route`);
	return stage;
}

/** The run's owner answers the next routed message for `stageId` as the workflow host does. */
async function ownerAnswers(run: Run, outcome: "forward" | "queued"): Promise<string> {
	const request = await run.owner.next("pending_stage_message");
	run.owner.send({
		type: "pending_stage_message_result",
		requestId: request.requestId,
		outcome,
		...(outcome === "forward" ? { target: request.target } : { position: 1 }),
	});
	return request.message.id;
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

test("a live stage answers the launcher that messaged it, by the name its message showed", async () => {
	const run = await launchedRun("live-answer", "5a1e0001-0000-4000-8000-000000000001", ["long-stage", "sibling"]);
	const stage = await startStage(run, "long-stage");
	const sibling = await startStage(run, "sibling");
	const outsider = new WireClient();
	await register(outsider, "live-answer-outsider", "default");

	const routed = ownerAnswers(run, "forward");
	run.launcher.send({
		type: "send",
		to: `${run.group}/long-stage`,
		message: { id: "status-check", timestamp: Date.now(), content: { text: "Status check from the main chat" } },
	});
	assert.equal(await routed, "status-check");
	const inbound = await stage.next("message", (frame) => frame.message.id === "status-check");
	assert.equal(inbound.from.name, run.launcherName);

	// The stage answers the sender its message named, by that name.
	assert.equal((await stage.sendTo(run.launcherName, "answer-1", "On it")).type, "delivered");
	const answer = await run.launcher.next("message", (frame) => frame.message.id === "answer-1");
	assert.equal(answer.message.content.text, "On it");

	// The return path reaches only that sender: a third session stays outside the stage's reach.
	const refused = await stage.sendTo("live-answer-outsider", "third-party", "not reachable");
	assert.deepEqual(refused, { type: "delivery_failed", messageId: "third-party", reason: "Session not found" });
	// A sibling stage that never received the message gains nothing.
	const siblingAttempt = await sibling.sendTo(run.launcherName, "sibling-answer", "not addressed to me");
	assert.equal(siblingAttempt.type, "delivery_failed");
	assert.equal(
		outsider.received.some((frame) => frame.type === "message"),
		false,
	);
});

test("the return path is bounded in messages and closes with a reason that names its limits", async () => {
	const run = await launchedRun("bounded", "5a1e0002-0000-4000-8000-000000000002", ["reviewer"]);
	const stage = await startStage(run, "reviewer");
	const routed = ownerAnswers(run, "forward");
	run.launcher.send({
		type: "send",
		to: `${run.group}/reviewer`,
		message: { id: "bounded-question", timestamp: Date.now(), content: { text: "How far along?" } },
	});
	await routed;
	await stage.next("message", (frame) => frame.message.id === "bounded-question");

	for (let index = 1; index <= RETURN_PATH_MESSAGE_LIMIT; index++) {
		assert.equal((await stage.sendTo(run.launcherId, `bounded-${index}`, `answer ${index}`)).type, "delivered");
	}
	assert.deepEqual(await stage.sendTo(run.launcherId, "bounded-over", "one too many"), {
		type: "delivery_failed",
		messageId: "bounded-over",
		reason: returnPathClosedReason(run.launcherName),
	});

	// A new message from the launcher opens the path again.
	const again = ownerAnswers(run, "forward");
	run.launcher.send({
		type: "send",
		to: `${run.group}/reviewer`,
		message: { id: "bounded-follow-up", timestamp: Date.now(), content: { text: "Thanks, one more thing" } },
	});
	await again;
	await stage.next("message", (frame) => frame.message.id === "bounded-follow-up");
	assert.equal((await stage.sendTo(run.launcherName, "bounded-reopened", "Sure")).type, "delivered");
});

test("a stage that started after the launcher queued a message for it can answer that launcher", async () => {
	const run = await launchedRun("queued", "5a1e0003-0000-4000-8000-000000000003", ["later", "other"]);
	const queued = ownerAnswers(run, "queued");
	const outcome = run.launcher.sendTo(`${run.group}/later`, "queued-note", "Read this when you start");
	assert.equal(await queued, "queued-note");
	assert.equal((await outcome).type, "queued");

	// The host hands the queued message over in process when the stage starts; the stage then answers.
	const stage = await startStage(run, "later");
	assert.equal((await stage.sendTo(run.launcherName, "queued-answer", "Got it")).type, "delivered");
	assert.equal(
		(await run.launcher.next("message", (frame) => frame.message.id === "queued-answer")).message.content.text,
		"Got it",
	);
	// Another stage of the run, which the message did not address, still cannot reach the launcher.
	const other = await startStage(run, "other");
	assert.equal((await other.sendTo(run.launcherName, "other-answer", "not mine")).type, "delivery_failed");
});

test("a stage still cannot reach the launcher before the launcher has written to it", async () => {
	const run = await launchedRun("unprompted", "5a1e0004-0000-4000-8000-000000000004", ["quiet"]);
	const stage = await startStage(run, "quiet");
	assert.deepEqual(await stage.sendTo(run.launcherName, "unprompted", "hello"), {
		type: "delivery_failed",
		messageId: "unprompted",
		reason: "Session not found",
	});
});

test("two messages that reached a stage give it one budget, counted from the latest", async () => {
	const run = await launchedRun("one-budget", "5a1e0005-0000-4000-8000-000000000005", ["twice"]);
	const queued = ownerAnswers(run, "queued");
	const outcome = run.launcher.sendTo(`${run.group}/twice`, "before-start", "Queued before you start");
	await queued;
	assert.equal((await outcome).type, "queued");
	const stage = await startStage(run, "twice");
	const routed = ownerAnswers(run, "forward");
	run.launcher.send({
		type: "send",
		to: `${run.group}/twice`,
		message: { id: "after-start", timestamp: Date.now(), content: { text: "And one more now" } },
	});
	await routed;
	await stage.next("message", (frame) => frame.message.id === "after-start");

	for (let index = 1; index <= RETURN_PATH_MESSAGE_LIMIT; index++) {
		assert.equal((await stage.sendTo(run.launcherName, `one-budget-${index}`, `answer ${index}`)).type, "delivered");
	}
	// The older queued message's path adds no answers of its own.
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
		const run = await launchedRun("id-churn", "5a1e0006-0000-4000-8000-000000000006", ["stage"]);
		const stage = await startStage(run, "stage");
		const forwarded = ownerAnswers(run, "forward");
		run.launcher.send({
			type: "send",
			to: `${run.group}/stage`,
			message: { id: "id-churn-note", timestamp: Date.now(), content: { text: "original sender" } },
		});
		await forwarded;
		await stage.next("message", (frame) => frame.message.id === "id-churn-note");
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
				group: "default",
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
	const run = await launchedRun("name-reuse", "5a1e0007-0000-4000-8000-000000000007", ["stage"]);
	const stage = await startStage(run, "stage");
	const forwarded = ownerAnswers(run, "forward");
	run.launcher.send({
		type: "send",
		to: `${run.group}/stage`,
		message: { id: "name-reuse-note", timestamp: Date.now(), content: { text: "original sender" } },
	});
	await forwarded;
	await stage.next("message", (frame) => frame.message.id === "name-reuse-note");
	run.launcher.send({ type: "unregister" });
	await new Promise<void>((done) => {
		run.launcher.socket.once("close", () => done());
		run.launcher.socket.end();
	});
	const replacement = new WireClient();
	const replacementId = await register(replacement, run.launcherName, "default", "replacement-host");
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
	const run = await launchedRun("retry-budget", "5a1e0008-0000-4000-8000-000000000008", ["later"]);
	const original = {
		type: "send" as const,
		to: `${run.group}/later`,
		message: { id: "retry-budget-note", timestamp: Date.now(), content: { text: "one original message" } },
	};
	run.launcher.send(original);
	await ownerAnswers(run, "queued");
	assert.equal((await run.launcher.settled(original.message.id)).type, "queued");
	const stage = await startStage(run, "later");
	for (let index = 0; index < RETURN_PATH_MESSAGE_LIMIT; index++) {
		assert.equal((await stage.sendTo(run.launcherId, `retry-budget-answer-${index}`, "answer")).type, "delivered");
	}
	assert.equal((await stage.sendTo(run.launcherId, "retry-budget-closed", "over")).type, "delivery_failed");
	// The host already handed that message over: it answers the identical retry without delivering anything new.
	for (const outcome of ["delivered", "queued"] as const) {
		run.launcher.send(original);
		const retry = await run.owner.next("pending_stage_message", (frame) => frame.message.id === original.message.id);
		run.owner.send({
			type: "pending_stage_message_result",
			requestId: retry.requestId,
			outcome,
			...(outcome === "queued" ? { position: 1 } : {}),
		});
		await run.launcher.settled(original.message.id);
		assert.equal(
			(await stage.sendTo(run.launcherId, `retry-budget-after-${outcome}`, "still closed")).type,
			"delivery_failed",
		);
	}
	// The stage reconnecting under its own identity does not receive that message again either.
	stage.send({
		type: "register_live_workflow_stage_route",
		requestId: "later-live-route-again",
		runId: run.runId,
		stageKeys: ["later"],
		capability: run.routeCapability,
	});
	await stage.next("live_workflow_stage_route_registered", (frame) => frame.requestId === "later-live-route-again");
	assert.equal(
		(await stage.sendTo(run.launcherId, "retry-budget-after-route", "still closed")).type,
		"delivery_failed",
	);
});

test("an isolated stage answers the invocation member whose queued message it received", async () => {
	const run = await launchedRun("subgroup", "5a1e0009-0000-4000-8000-000000000009", ["isolated-stage"], true);
	run.launcher.send({ type: "join_group", requestId: "join-subgroup-root", group: run.group });
	await run.launcher.next("membership_ack", (frame) => frame.requestId === "join-subgroup-root");
	const queued = ownerAnswers(run, "queued");
	const outcome = run.launcher.sendTo(`${run.group}/isolated-stage`, "subgroup-note", "start later");
	await queued;
	assert.equal((await outcome).type, "queued");
	const stage = await startStage(run, "isolated-stage", true);
	const answer = await stage.sendTo(run.launcherName, "subgroup-answer", "got your queued message");
	assert.equal(answer.type, "delivered", JSON.stringify(answer));
});

test("a stage that goes live while its host is still answering for the launcher's message can answer it", async () => {
	const run = await launchedRun("going-live", "5a1e0012-0000-4000-8000-000000000012", ["later"]);
	run.launcher.send({
		type: "send",
		to: `${run.group}/later`,
		message: { id: "going-live-note", timestamp: Date.now(), content: { text: "read this when you start" } },
	});
	const request = await run.owner.next("pending_stage_message", (frame) => frame.message.id === "going-live-note");
	// The stage takes its route before the host answered; the broker holds the route's acknowledgment behind it.
	const stage = new WireClient();
	await register(stage, "going-live-later", run.group);
	stage.send({
		type: "register_live_workflow_stage_route",
		requestId: "going-live-route",
		runId: run.runId,
		stageKeys: ["later"],
		capability: run.routeCapability,
	});
	await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
	run.owner.send({
		type: "pending_stage_message_result",
		requestId: request.requestId,
		outcome: "queued",
		position: 1,
	});
	assert.equal((await run.launcher.settled("going-live-note")).type, "queued");
	await stage.next("live_workflow_stage_route_registered", (frame) => frame.requestId === "going-live-route");
	// Its host hands the queued message to the live stage, which answers the launcher.
	const answer = await stage.sendTo(run.launcherName, "going-live-answer", "got it");
	assert.equal(answer.type, "delivered", JSON.stringify(answer));
	// A stage of the run the message did not address still gains nothing.
	const other = await startStage(run, "elsewhere");
	assert.equal((await other.sendTo(run.launcherName, "going-live-other", "not mine")).type, "delivery_failed");
});

/** The launcher steps away (a resumable unregister) and comes back as the same registration under a fresh broker id. */
async function reconnectLauncher(run: Run): Promise<{ back: WireClient; backId: string }> {
	run.launcher.send({ type: "unregister", resumable: true });
	await new Promise<void>((done) => {
		run.launcher.socket.once("close", () => done());
		run.launcher.socket.end();
	});
	const back = new WireClient();
	const backId = await register(back, run.launcherName, "default");
	assert.notEqual(backId, run.launcherId);
	return { back, backId };
}

test("a stage answers by name a launcher that came back under a new id after queuing its message", async () => {
	const run = await launchedRun("queued-reconnect", "5a1e0013-0000-4000-8000-000000000013", ["later"]);
	const queued = ownerAnswers(run, "queued");
	assert.equal(
		(await run.launcher.sendTo(`${run.group}/later`, "queued-reconnect-note", "read this later")).type,
		"queued",
	);
	await queued;
	const { back, backId } = await reconnectLauncher(run);
	const stage = await startStage(run, "later");
	assert.equal((await stage.sendTo(backId, "queued-reconnect-by-id", "by id")).type, "delivered");
	const byName = await stage.sendTo(run.launcherName, "queued-reconnect-by-name", "by name");
	assert.equal(byName.type, "delivered", JSON.stringify(byName));
	assert.equal(
		(await back.next("message", (frame) => frame.message.id === "queued-reconnect-by-name")).message.content.text,
		"by name",
	);
});

/** A live stage that confirms each message it saves only when the test says so, as a stage whose save is slow does. */
async function startReceiptStage(run: Run, name: string): Promise<WireClient> {
	const stage = new WireClient();
	await stage.connected();
	stage.send({
		type: "register",
		returnAddress: `host:${name}`,
		acknowledgesReceipt: true,
		session: { name, group: run.group, cwd: "/repo", model: "test", pid: 1, startedAt: 1, lastActivity: 1 },
	});
	await stage.next("registered");
	stage.send({
		type: "register_live_workflow_stage_route",
		requestId: `${name}-live`,
		runId: run.runId,
		stageKeys: ["later"],
		capability: run.routeCapability,
	});
	await stage.next("live_workflow_stage_route_registered");
	return stage;
}

/** The launcher's message reaches `stage`, which has not confirmed it yet. */
async function launcherNoteReaches(run: Run, stage: WireClient, messageId: string): Promise<void> {
	const forwarded = ownerAnswers(run, "forward");
	run.launcher.send({
		type: "send",
		to: `${run.group}/later`,
		message: { id: messageId, timestamp: Date.now(), content: { text: "read me" } },
	});
	await forwarded;
	await stage.next("message", (frame) => frame.message.id === messageId);
}

test("a stage whose receipt arrives after the launcher came back under a new id answers it by name", async () => {
	const run = await launchedRun("receipt-reconnect", "5a1e0014-0000-4000-8000-000000000014", ["later"]);
	const stage = await startReceiptStage(run, "receipt-stage");
	await launcherNoteReaches(run, stage, "receipt-note");
	const { backId } = await reconnectLauncher(run);
	// The stage confirms it saved the message only now, after the launcher came back.
	stage.send({ type: "received", messageId: "receipt-note" });
	await listed(stage, "receipt-processed");
	assert.equal((await stage.sendTo(backId, "receipt-by-id", "by id")).type, "delivered");
	const byName = await stage.sendTo(run.launcherName, "receipt-by-name", "by name");
	assert.equal(byName.type, "delivered", JSON.stringify(byName));
});

test("a stage whose receipt arrives after the launcher ended for good opens nothing a later registration inherits", async () => {
	const run = await launchedRun("receipt-ended", "5a1e0016-0000-4000-8000-000000000016", ["later"]);
	const stage = await startReceiptStage(run, "receipt-ended-stage");
	await launcherNoteReaches(run, stage, "receipt-ended-note");
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
	await register(copy, run.launcherName, "default");
	const answer = await stage.sendTo(run.launcherName, "receipt-ended-answer", "only for the launcher that ended");
	assert.equal(answer.type, "delivery_failed", JSON.stringify(answer));
	await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
	assert.equal(
		copy.received.some((frame) => frame.type === "message"),
		false,
	);
});

test("a stage whose receipt arrives after the launcher crashed, came back and ended for good opens nothing", async () => {
	const run = await launchedRun("receipt-hop", "5a1e0019-0000-4000-8000-000000000019", ["later"]);
	const stage = await startReceiptStage(run, "receipt-hop-stage");
	await launcherNoteReaches(run, stage, "receipt-hop-note");
	// The launcher's connection drops without a goodbye, and the broker notices it is away.
	const observer = new WireClient();
	await register(observer, "receipt-hop-observer", "default");
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
	await register(back, run.launcherName, "default");
	back.send({ type: "unregister" });
	await new Promise<void>((done) => {
		back.socket.once("close", () => done());
		back.socket.end();
	});
	// The stage confirms the message the launcher's first connection sent only now.
	stage.send({ type: "received", messageId: "receipt-hop-note" });
	await listed(stage, "receipt-hop-processed");
	const copy = new WireClient();
	await register(copy, run.launcherName, "default");
	const answer = await stage.sendTo(run.launcherName, "receipt-hop-answer", "only for the launcher that ended");
	assert.equal(answer.type, "delivery_failed", JSON.stringify(answer));
	await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
	assert.equal(
		copy.received.some((frame) => frame.type === "message"),
		false,
	);
});

test("a launcher whose receipt for a stage's answer arrives after the stage ended for good opens no path back", async () => {
	const run = await launchedRun("answer-ended", "5a1e0018-0000-4000-8000-000000000018", ["st"], false, true);
	const stage = await startStage(run, "st");
	const stageName = `${run.runId.slice(0, 8)}-st`;
	const forwarded = ownerAnswers(run, "forward");
	run.launcher.send({
		type: "send",
		to: `${run.group}/st`,
		message: { id: "answer-ended-note", timestamp: Date.now(), content: { text: "read me" } },
	});
	await forwarded;
	await stage.next("message", (frame) => frame.message.id === "answer-ended-note");
	// The stage answers; the launcher confirms it saved the answer only after the stage said goodbye.
	stage.send({
		type: "send",
		to: run.launcherName,
		message: { id: "answer-ended-answer", timestamp: Date.now(), content: { text: "done" } },
	});
	await run.launcher.next("message", (frame) => frame.message.id === "answer-ended-answer");
	stage.send({ type: "unregister" });
	await new Promise<void>((done) => {
		stage.socket.once("close", () => done());
		stage.socket.end();
	});
	run.launcher.send({ type: "received", messageId: "answer-ended-answer" });
	await listed(run.launcher, "answer-ended-processed");
	// A new registration copies the ended stage's return address, group and name.
	const copy = new WireClient();
	await register(copy, stageName, run.group);
	run.launcher.send({
		type: "send",
		to: stageName,
		message: { id: "answer-ended-reply", timestamp: Date.now(), content: { text: "only for the stage that ended" } },
	});
	// The name stands for the run's stage again, which the run's host holds until the stage starts once more.
	const held = await run.owner.next("pending_stage_message", (frame) => frame.message.id === "answer-ended-reply");
	run.owner.send({ type: "pending_stage_message_result", requestId: held.requestId, outcome: "queued", position: 1 });
	assert.equal((await run.launcher.settled("answer-ended-reply")).type, "queued");
	assert.equal(
		copy.received.some((frame) => frame.type === "message"),
		false,
	);
});

test("a name two live registrations of the launcher's identity share stays ambiguous", async () => {
	const run = await launchedRun("live-duplicate", "5a1e0015-0000-4000-8000-000000000015", ["stage"]);
	const stage = await startStage(run, "stage");
	const forwarded = ownerAnswers(run, "forward");
	run.launcher.send({
		type: "send",
		to: `${run.group}/stage`,
		message: { id: "live-duplicate-note", timestamp: Date.now(), content: { text: "hi" } },
	});
	await forwarded;
	await stage.next("message", (frame) => frame.message.id === "live-duplicate-note");
	// Another registration copies the launcher's return address, group and name while the launcher is still live.
	const duplicate = new WireClient();
	const duplicateId = await register(duplicate, run.launcherName, "default");
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
	const run = await launchedRun("duplicate-ended", "5a1e0017-0000-4000-8000-000000000017", ["stage"]);
	const stage = await startStage(run, "stage");
	const forwarded = ownerAnswers(run, "forward");
	run.launcher.send({
		type: "send",
		to: `${run.group}/stage`,
		message: { id: "duplicate-ended-note", timestamp: Date.now(), content: { text: "hi" } },
	});
	await forwarded;
	await stage.next("message", (frame) => frame.message.id === "duplicate-ended-note");
	const duplicate = new WireClient();
	await register(duplicate, run.launcherName, "default");
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
