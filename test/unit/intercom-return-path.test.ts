import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { createMessageReader, writeMessage } from "../../packages/intercom/broker/framing.js";
import { getBrokerSocketPath } from "../../packages/intercom/broker/paths.js";
import {
	RETURN_PATH_MESSAGE_LIMIT,
	RETURN_PATH_WINDOW_MS,
	returnPathClosedReason,
} from "../../packages/intercom/broker/return-paths.js";
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

	async settled(id: string): Promise<BrokerMessage> {
		return await Promise.race([
			this.next("delivered", (frame) => frame.messageId === id),
			this.next("delivery_failed", (frame) => frame.messageId === id),
			this.next("queued", (frame) => frame.messageId === id),
		]);
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

async function register(client: WireClient, name: string, group: string): Promise<string> {
	await client.connected();
	client.send({
		type: "register",
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

/** A workflow run whose launcher, registered outside the run's group, holds the launcher claim (#4006). */
async function launchedRun(label: string, runId: string, stageIds: readonly string[]): Promise<Run> {
	const group = `workflow:${runId}`;
	const routeCapability = `${label}-route-capability`;
	const launcherCapability = `${label}-launcher-capability`;
	const owner = new WireClient();
	const launcher = new WireClient();
	await register(owner, `${label}-owner`, group);
	const launcherName = `${label}-launcher`;
	const launcherId = await register(launcher, launcherName, "default");
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
			group,
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

async function startStage(run: Run, stageId: string): Promise<WireClient> {
	const stage = new WireClient();
	await register(stage, `${run.runId.slice(0, 8)}-${stageId}`, run.group);
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
	assert.ok(RETURN_PATH_WINDOW_MS > 0);
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
