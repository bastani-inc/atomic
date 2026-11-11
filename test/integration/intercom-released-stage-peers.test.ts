import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, test, vi } from "vitest";
import type {
	IntercomClient as IntercomClientType,
	ReleasedChildReply,
} from "../../packages/intercom/broker/client.js";
import type { JsonWireValue } from "../../packages/intercom/broker/framing.js";
import type {
	ReleasedStageAnnouncement,
	ReleasedStagePeers as ReleasedStagePeersType,
} from "../../packages/intercom/released-stage-peers.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";

const BROKER_STARTUP_TIMEOUT_MS = 10_000;
const BROKER_SHUTDOWN_TIMEOUT_MS = 5_000;
const ASK_TIMEOUT_MS = 10_000;
const POLL_TIMEOUT_MS = 10_000;
/** 200 finished stages, the scale #4642 measures. */
const STAGES = 200;
const RELEASED_STAGE_STATUS = "closed · reply: post-mortem only";

const extensionDir = resolve(import.meta.dirname, "../../packages/intercom");
const agentDir = mkdtempSync(join(tmpdir(), "released-stage-peers-"));
const previousAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
const previousLegacyAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
delete process.env.PI_CODING_AGENT_DIR;

const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
const { ReleasedStagePeers } = await import("../../packages/intercom/released-stage-peers.js");
const { getJitiCliPath } = await import("../../packages/intercom/broker/spawn.js");
const { isStageRecipientReleasedError } = await import("../../packages/intercom/broker/recipient-gone-errors.js");
const { HostedSessionRequestError, NotHostedSessionError, isNotHostedSessionError } = await import(
	"../../packages/intercom/broker/hosted-session-errors.js"
);
const { createMessageReader, writeMessage } = await import("../../packages/intercom/broker/framing.js");
const { getBrokerSocketPath } = await import("../../packages/intercom/broker/paths.js");

let broker: ChildProcess | undefined;

beforeAll(async () => {
	const child = spawn(process.execPath, [getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")], {
		env: { ...process.env, ATOMIC_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: undefined },
		stdio: ["ignore", "pipe", "pipe"],
	});
	broker = child;
	await new Promise<void>((resolveReady, rejectReady) => {
		let stdout = "";
		const timer = setTimeout(
			() => rejectReady(new Error(`Intercom broker did not become ready within ${BROKER_STARTUP_TIMEOUT_MS}ms`)),
			BROKER_STARTUP_TIMEOUT_MS,
		);
		child.stdout?.on("data", (chunk: Buffer | string) => {
			stdout += chunk.toString();
			if (!stdout.includes("Intercom broker started")) return;
			clearTimeout(timer);
			resolveReady();
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			rejectReady(new Error(`Intercom broker exited before readiness (code=${String(code)})`));
		});
	});
});

afterAll(async () => {
	const active = broker;
	broker = undefined;
	if (active !== undefined && active.exitCode === null) {
		await new Promise<void>((resolveExit, rejectExit) => {
			const timer = setTimeout(
				() => rejectExit(new Error(`Broker did not exit within ${BROKER_SHUTDOWN_TIMEOUT_MS}ms`)),
				BROKER_SHUTDOWN_TIMEOUT_MS,
			);
			active.once("exit", () => {
				clearTimeout(timer);
				resolveExit();
			});
			active.kill("SIGTERM");
		});
	}
	if (previousAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = previousAgentDir;
	if (previousLegacyAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousLegacyAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function registration(name: string | undefined, group: string): Omit<SessionInfo, "id"> {
	const now = Date.now();
	return {
		name,
		cwd: agentDir,
		model: "test",
		pid: process.pid,
		startedAt: now,
		lastActivity: now,
		groups: [group],
		group,
	};
}

interface Asker {
	readonly client: IntercomClientType;
	ask(to: string, text: string): Promise<{ readonly delivered: boolean; readonly reply?: Message }>;
	listed(): Promise<SessionInfo[]>;
	until(expected: (sessions: SessionInfo[]) => boolean): Promise<SessionInfo[]>;
}

async function connectAsker(group: string, name = `asker-${randomUUID()}`): Promise<Asker> {
	const client = new IntercomClient();
	const replies = new Map<string, (message: Message) => void>();
	client.on("message", (_from: SessionInfo, message: Message) => {
		if (message.replyTo !== undefined) replies.get(message.replyTo)?.(message);
	});
	await client.connect(registration(name, group), undefined, undefined, undefined, group);
	cleanups.push(() => client.disconnect());
	const listed = async (): Promise<SessionInfo[]> =>
		(await client.listSessions(group)).filter((session) => session.status === RELEASED_STAGE_STATUS);
	return {
		client,
		async ask(to, text) {
			const messageId = randomUUID();
			const answered = new Promise<Message>((resolveReply, rejectReply) => {
				const timer = setTimeout(() => rejectReply(new Error(`no reply from ${to}`)), ASK_TIMEOUT_MS);
				replies.set(messageId, (message) => {
					clearTimeout(timer);
					resolveReply(message);
				});
			});
			const sent = await client.send(to, { text, expectsReply: true, messageId });
			return sent.delivered ? { delivered: true, reply: await answered } : { delivered: false };
		},
		listed,
		async until(expected) {
			const deadline = Date.now() + POLL_TIMEOUT_MS;
			let sessions = await listed();
			while (!expected(sessions)) {
				if (Date.now() > deadline) throw new Error(`listing never matched: ${sessions.length} released stages`);
				await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
				sessions = await listed();
			}
			return sessions;
		},
	};
}

interface PeersFixture {
	readonly peers: ReleasedStagePeersType;
	readonly clients: IntercomClientType[];
	readonly relayed: Message[];
	readonly answered: string[];
	route(index: number, overrides?: Partial<ReleasedStageAnnouncement>): ReleasedStageAnnouncement;
}

function peersFixture(group: string, runId = randomUUID()): PeersFixture {
	const clients: IntercomClientType[] = [];
	const relayed: Message[] = [];
	const answered: string[] = [];
	const sessionIds = new Map<number, string>();
	const peers = new ReleasedStagePeers({
		prepare: async () => {},
		createClient: (returnAddress) => {
			const client = new IntercomClient(returnAddress);
			clients.push(client);
			return client;
		},
		cwd: () => agentDir,
		relay: (_from, message) => relayed.push(message),
	});
	cleanups.push(() => peers.disconnectAll());
	return {
		peers,
		clients,
		relayed,
		answered,
		route(index, overrides = {}) {
			let sessionId = sessionIds.get(index);
			if (sessionId === undefined) {
				sessionId = randomUUID();
				sessionIds.set(index, sessionId);
			}
			return {
				runId,
				stageId: `stage-${index}`,
				stageName: `reviewer-${index}`,
				sessionId,
				group,
				model: "faux/model",
				answer: async (content) => {
					answered.push(`stage-${index}`);
					return `stage-${index} answers: ${content.split("\n")[2] ?? content}`;
				},
				...overrides,
			};
		},
	};
}

const nameOf = (route: ReleasedStageAnnouncement): string => `subagent-chat-${route.sessionId}`;

test("200 released stages share one broker connection and are listed as closed post-mortem peers (#4642)", async () => {
	const group = `workflow:${randomUUID()}`;
	const fixture = peersFixture(group);
	const asker = await connectAsker(group);
	const routes = Array.from({ length: STAGES }, (_, index) => fixture.route(index));

	await Promise.all(routes.map((route) => fixture.peers.adopt(route)));

	assert.equal(fixture.clients.length, 1, "one connection hosts every released stage");
	assert.equal(fixture.peers.size, STAGES);
	const listed = await asker.listed();
	assert.equal(listed.length, STAGES);
	assert.deepEqual(new Set(listed.map((session) => session.name)), new Set(routes.map(nameOf)));
	assert.ok(listed.every((session) => session.model === "faux/model" && session.groups?.includes(group)));
	assert.deepEqual(fixture.answered, [], "listing reopens no stage");
});

test("an ask to a released stage is answered by that stage alone, and a plain send reaches the host session (#4642)", async () => {
	const group = `workflow:${randomUUID()}`;
	const fixture = peersFixture(group);
	const asker = await connectAsker(group);
	const routes = [0, 1, 2].map((index) => fixture.route(index));
	for (const route of routes) await fixture.peers.adopt(route);

	const asked = await asker.ask(nameOf(routes[1]!), "which file did you review?");

	assert.equal(asked.delivered, true);
	assert.equal(asked.reply?.content.text, "stage-1 answers: which file did you review?");
	assert.equal(asked.reply?.replyError, undefined);
	assert.deepEqual(fixture.answered, ["stage-1"]);

	const sent = await asker.client.send(nameOf(routes[2]!), { text: "fyi: the build is green" });
	assert.equal(sent.delivered, true);
	const deadline = Date.now() + POLL_TIMEOUT_MS;
	while (fixture.relayed.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
	assert.deepEqual(
		fixture.relayed.map((message) => message.content.text),
		["fyi: the build is green"],
	);
	assert.deepEqual(fixture.answered, ["stage-1"], "a notification reopens no stage");
});

test("an ask the released stage cannot answer gets the failure as its reply (#4642)", async () => {
	const group = `workflow:${randomUUID()}`;
	const fixture = peersFixture(group);
	const asker = await connectAsker(group);
	const route = fixture.route(0, {
		answer: async () => {
			throw new Error("model unavailable");
		},
	});
	await fixture.peers.adopt(route);

	const asked = await asker.ask(nameOf(route), "are you there?");

	assert.equal(asked.reply?.content.text, "Released workflow stage could not answer: model unavailable");
	assert.equal(asked.reply?.replyError, "Released workflow stage could not answer: model unavailable");
});

test("a stage released again keeps its one hosted session and answers with its newest loader (#4642)", async () => {
	const group = `workflow:${randomUUID()}`;
	const fixture = peersFixture(group);
	const asker = await connectAsker(group);
	const routes = [0, 1, 2, 3, 4].map((index) => fixture.route(index));
	for (const route of routes) await fixture.peers.adopt(route);
	const before = await asker.listed();

	for (const route of routes) {
		await fixture.peers.adopt({ ...route, answer: async () => `${route.stageId} answers after its second release` });
	}

	assert.equal(fixture.clients.length, 1);
	assert.equal(fixture.peers.size, 5);
	const after = await asker.listed();
	assert.deepEqual(
		after.map((session) => session.id).sort(),
		before.map((session) => session.id).sort(),
		"the same broker sessions stay hosted",
	);
	const asked = await asker.ask(nameOf(routes[3]!), "still there?");
	assert.equal(asked.reply?.content.text, "stage-3 answers after its second release");

	const reopenedUnderNewSession = fixture.route(4, { sessionId: randomUUID() });
	await fixture.peers.adopt(reopenedUnderNewSession);
	const replaced = await asker.until((sessions) => !sessions.some((session) => session.name === nameOf(routes[4]!)));
	assert.equal(replaced.length, 5);
	assert.ok(replaced.some((session) => session.name === nameOf(reopenedUnderNewSession)));
	assert.equal(fixture.clients.length, 1);
});

test("disconnecting the peers removes every released stage from the broker and closes the connection (#4642)", async () => {
	const group = `workflow:${randomUUID()}`;
	const fixture = peersFixture(group);
	const asker = await connectAsker(group);
	for (let index = 0; index < 10; index++) await fixture.peers.adopt(fixture.route(index));
	assert.equal((await asker.listed()).length, 10);

	await fixture.peers.disconnectAll();

	assert.equal(fixture.peers.size, 0);
	assert.deepEqual(await asker.until((sessions) => sessions.length === 0), []);
	assert.equal(fixture.clients[0]?.isConnected(), false);
});

test("a send to a released stage whose peer is gone is refused with why and where to send instead, until it is hosted again (#4642)", async () => {
	const group = `workflow:${randomUUID()}`;
	const fixture = peersFixture(group);
	const asker = await connectAsker(group);
	const gone = fixture.route(0);
	await fixture.peers.adopt(gone);
	await fixture.peers.adopt(fixture.route(1));
	const hostedIds = (await asker.listed())
		.filter((session) => session.name === nameOf(gone))
		.map((session) => session.id);
	assert.equal(hostedIds.length, 1);

	await fixture.peers.disconnectAll();
	await asker.until((sessions) => sessions.length === 0);

	for (const target of [nameOf(gone), hostedIds[0]!]) {
		const refused = await asker.client.send(target, { text: "are you there?" });
		assert.equal(refused.delivered, false);
		assert.equal(refused.reasonCode, "recipient_stage_released");
		const error = refused.error;
		assert.ok(error !== undefined && isStageRecipientReleasedError(error));
		assert.equal(error.name, "StageRecipientReleasedError");
		assert.equal(error.retryable, false);
		assert.equal(error.fields.target, target);
		assert.equal(error.fields.childName, nameOf(gone));
		assert.match(error.hint, /workflow:<rootRunId>\/<stage>/);
		assert.match(refused.reason ?? "", /Workflow stage .* was released/);
	}
	const unknown = await asker.client.send("never-hosted", { text: "hello?" });
	assert.equal(unknown.reason, "Session not found", "a name nobody hosted keeps its plain refusal");

	await fixture.peers.adopt(gone);
	const answered = await asker.ask(nameOf(gone), "back?");
	assert.equal(answered.delivered, true, "hosting the stage again ends the refusal");
});

test("a session joining a hosted stage's group is announced to the host connection by no hosted session (#4642)", async () => {
	const stageGroup = `stages-${randomUUID()}`;
	const fixture = peersFixture(stageGroup);
	for (let index = 0; index < 3; index++) await fixture.peers.adopt(fixture.route(index));
	const hostClient = fixture.clients[0]!;
	const announced: string[] = [];
	hostClient.on("session_joined", (session: SessionInfo) => announced.push(`joined:${session.name}`));
	hostClient.on("presence_update", (session: SessionInfo) => announced.push(`presence:${session.name}`));
	const joinerName = `joiner-${randomUUID()}`;
	const joiner = await connectAsker(`home-${randomUUID()}`, joinerName);

	await joiner.client.joinGroup(stageGroup);
	await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));

	assert.deepEqual(
		announced,
		[],
		"the host connection is in a group of its own, and three hosted stages share its socket without being sent copies",
	);
	const asked = await joiner.ask(nameOf(fixture.route(0)), "hello?");
	assert.equal(asked.delivered, true, "the joiner reaches the stage through its new group");
});

test("a stage hosted with a live route, whose peer is gone, is refused with why instead of being forwarded to its run (#4642)", async () => {
	const runId = randomUUID();
	const group = `workflow:${runId}`;
	const capability = randomUUID();
	const owner = new IntercomClient();
	await owner.connect(
		{ ...registration(undefined, group), recipientPurpose: "control" },
		undefined,
		undefined,
		undefined,
		group,
	);
	cleanups.push(() => owner.disconnect());
	const forwarded: string[] = [];
	owner.on("pending_stage_message", (request: { requestId: string; target: string }) => {
		forwarded.push(request.target);
		owner.respondPendingStageMessage(request.requestId, { outcome: "forward", target: request.target });
	});
	await owner.registerPendingStageRouteAcknowledged(runId, group, capability, [
		{
			stageId: "stage-0",
			stageName: "reviewer",
			target: `workflow:${runId}/stage-0`,
			lifecycle: "running",
			routeEligible: true,
			recipientPurpose: "agent",
			group,
		},
	]);
	const fixture = peersFixture(group, runId);
	const asker = await connectAsker(group);
	const stage = fixture.route(0, {
		stageName: "reviewer",
		liveRoute: { stageKeys: ["stage-0", "reviewer"], capability },
	});
	await fixture.peers.adopt(stage);
	await fixture.peers.disconnectAll();
	await asker.until((sessions) => sessions.length === 0);

	for (const kind of ["send", "ask"] as const) {
		const refused = await asker.client.send(nameOf(stage), { text: "are you there?", expectsReply: kind === "ask" });
		assert.equal(refused.delivered, false, kind);
		assert.equal(refused.reasonCode, "recipient_stage_released", kind);
		const error = refused.error;
		assert.ok(error !== undefined && isStageRecipientReleasedError(error), kind);
	}
	assert.deepEqual(forwarded, [], "the run was not asked about a stage nothing answers for");

	await fixture.peers.adopt(stage);
	const answered = await asker.ask(nameOf(stage), "back?");
	assert.equal(answered.delivered, true, "hosting the stage again reaches it");
});

test("a stage whose hosted peer is gone is reached through its run once a live session answers for it (#4642)", async () => {
	const runId = randomUUID();
	const group = `workflow:${runId}`;
	const capability = randomUUID();
	const owner = new IntercomClient();
	await owner.connect(
		{ ...registration(undefined, group), recipientPurpose: "control" },
		undefined,
		undefined,
		undefined,
		group,
	);
	cleanups.push(() => owner.disconnect());
	const forwarded: string[] = [];
	owner.on("pending_stage_message", (request: { requestId: string; target: string }) => {
		forwarded.push(request.target);
		owner.respondPendingStageMessage(request.requestId, { outcome: "forward", target: request.target });
	});
	await owner.registerPendingStageRouteAcknowledged(runId, group, capability, [
		{
			stageId: "stage-0",
			stageName: "reviewer",
			target: `workflow:${runId}/stage-0`,
			lifecycle: "running",
			routeEligible: true,
			recipientPurpose: "agent",
			group,
		},
	]);
	const fixture = peersFixture(group, runId);
	const asker = await connectAsker(group);
	const stage = fixture.route(0, {
		stageName: "reviewer",
		liveRoute: { stageKeys: ["stage-0", "reviewer"], capability },
	});
	await fixture.peers.adopt(stage);
	const hosted = (await asker.client.listSessions(group)).find((session) => session.name === nameOf(stage));
	assert.ok(hosted, "the hosted stage is listed under its own broker id");
	await fixture.peers.disconnectAll();
	await asker.until((sessions) => sessions.length === 0);

	const reopened = new IntercomClient();
	const received: string[] = [];
	reopened.on("message", (_from: SessionInfo, message: Message) => {
		received.push(message.content.text);
		reopened.acknowledgeReceived(message.id);
	});
	await reopened.connect(registration(nameOf(stage), group), undefined, undefined, undefined, group);
	cleanups.push(() => reopened.disconnect());
	await reopened.registerLiveWorkflowStageRoute(runId, ["stage-0", "reviewer"], capability);

	const sent = await asker.client.send(hosted.id, { text: "are you back?" });

	assert.equal(sent.delivered, true, sent.reason);
	assert.deepEqual(forwarded, [`workflow:${runId}/stage-0`], "the run was asked, and it forwarded the message");
	await vi.waitFor(() => assert.deepEqual(received, ["are you back?"]));
});

test("a sender that registered below protocol 3 is refused with the plain reason only, and keeps its connection (#4642)", async () => {
	const group = `workflow:${randomUUID()}`;
	const fixture = peersFixture(group);
	const gone = fixture.route(0);
	await fixture.peers.adopt(gone);
	await fixture.peers.disconnectAll();
	const older = await rawConnection(group, { protocolMax: 2 });
	const current = await rawConnection(group, { protocolMax: 3 });

	older.send({ type: "send", to: nameOf(gone), message: { id: "m-old", timestamp: 1, content: { text: "hi" } } });
	const plain = await older.next("delivery_failed");
	assert.equal(plain.messageId, "m-old");
	assert.match(String(plain.reason), /^Workflow stage .* was released/);
	assert.equal(Object.hasOwn(plain, "recipientError"), false, "an older client is never sent a code it does not know");
	assert.equal(Object.hasOwn(plain, "reasonCode"), false);
	assert.equal(
		await Promise.race([older.closed.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 200))]),
		false,
	);

	current.send({ type: "send", to: nameOf(gone), message: { id: "m-new", timestamp: 1, content: { text: "hi" } } });
	const typed = await current.next("delivery_failed");
	assert.equal((typed.recipientError as { code?: string }).code, "recipient_stage_released");
});

test("a dropped host connection takes its released stages with it, and they are hosted again on reconnect (#4642)", async () => {
	const group = `workflow:${randomUUID()}`;
	const fixture = peersFixture(group);
	const asker = await connectAsker(group);
	const routes = Array.from({ length: 20 }, (_, index) => fixture.route(index));
	for (const route of routes) await fixture.peers.adopt(route);
	assert.equal((await asker.listed()).length, 20);

	(Reflect.get(fixture.clients[0]!, "socket") as net.Socket).destroy();

	await asker.until((sessions) => sessions.length === 0);
	const restored = await asker.until((sessions) => sessions.length === 20);
	assert.equal(fixture.clients.length, 2, "one new connection hosts every stage again");
	assert.deepEqual(new Set(restored.map((session) => session.name)), new Set(routes.map(nameOf)));
	const asked = await asker.ask(nameOf(routes[7]!), "back?");
	assert.equal(asked.reply?.content.text, "stage-7 answers: back?");
});

test("another connection that a joining peer's broadcast reaches gets one copy, not one per hosted stage (#4642)", async () => {
	const group = `workflow:${randomUUID()}`;
	const fixture = peersFixture(group);
	for (let index = 0; index < 50; index++) await fixture.peers.adopt(fixture.route(index));
	const host = fixture.clients[0]!;
	let joinedSeenByHost = 0;
	host.on("session_joined", () => {
		joinedSeenByHost += 1;
	});
	const observer = await connectAsker(group, "observer");
	let joinedSeenByObserver = 0;
	observer.client.on("session_joined", () => {
		joinedSeenByObserver += 1;
	});

	await connectAsker(group, "late-joiner");
	await observer.listed();

	assert.equal(joinedSeenByObserver, 1);
	assert.equal(joinedSeenByHost, 0, "the hosting connection is not sent the stages' copies");
});

test("a send as a session another connection hosts is refused with NotHostedSessionError (#4642)", async () => {
	const group = `workflow:${randomUUID()}`;
	const fixture = peersFixture(group);
	const asker = await connectAsker(group);
	const route = fixture.route(0);
	await fixture.peers.adopt(route);
	const hosted = (await asker.listed())[0]!;

	const spoofed = await asker.client.send(asker.client.sessionId!, {
		text: "pretending to be the released stage",
		hostedSender: hosted.id,
	});

	assert.equal(spoofed.delivered, false);
	assert.equal(spoofed.reasonCode, "not_hosted_by_connection");
	assert.ok(spoofed.error !== undefined && isNotHostedSessionError(spoofed.error));
	assert.ok(spoofed.error instanceof NotHostedSessionError);
	assert.equal(spoofed.error.code, "not_hosted_by_connection");
	assert.equal(spoofed.error.sessionId, hosted.id);
	assert.equal(spoofed.error.retryable, false);
	assert.deepEqual(fixture.answered, []);
});

test("removing a session another connection hosts is refused and leaves it hosted (#4642)", async () => {
	const group = `workflow:${randomUUID()}`;
	const fixture = peersFixture(group);
	const asker = await connectAsker(group);
	await fixture.peers.adopt(fixture.route(0));
	const hosted = (await asker.listed())[0]!;

	await assert.rejects(asker.client.unhostSessions([hosted.id]), (error: Error) => {
		assert.ok(error instanceof NotHostedSessionError);
		assert.equal(error.code, "not_hosted_by_connection");
		assert.equal(error.sessionId, hosted.id);
		return true;
	});
	assert.deepEqual(
		(await asker.listed()).map((session) => session.id),
		[hosted.id],
	);
});

test("a malformed hosted session fails the request before anything is hosted (#4642)", async () => {
	const group = `workflow:${randomUUID()}`;
	const asker = await connectAsker(group);
	const valid = { key: "valid", session: { ...registration("valid-stage", group), status: RELEASED_STAGE_STATUS } };

	await assert.rejects(
		asker.client.hostSessions([valid, { key: "nameless", session: registration(undefined, group) }]),
		(error: Error) => {
			assert.ok(error instanceof HostedSessionRequestError);
			assert.equal(error.code, "invalid_hosted_session");
			assert.equal(error.key, "nameless");
			return true;
		},
	);
	await assert.rejects(asker.client.hostSessions([valid, valid]), (error: Error) => {
		assert.ok(error instanceof HostedSessionRequestError);
		assert.equal(error.code, "invalid_hosted_frame");
		return true;
	});
	assert.deepEqual(await asker.listed(), []);
});

test("an ask to a released stage's workflow path reaches its hosted session (#4642)", async () => {
	const runId = randomUUID();
	const group = `workflow:${runId}`;
	const capability = randomUUID();
	const owner = new IntercomClient();
	await owner.connect(
		{ ...registration(undefined, group), recipientPurpose: "control" },
		undefined,
		undefined,
		undefined,
		group,
	);
	cleanups.push(() => owner.disconnect());
	owner.on("pending_stage_message", (request: { requestId: string; target: string }) => {
		owner.respondPendingStageMessage(request.requestId, { outcome: "forward", target: request.target });
	});
	await owner.registerPendingStageRouteAcknowledged(runId, group, capability, [
		{
			stageId: "stage-0",
			stageName: "reviewer",
			target: `workflow:${runId}/stage-0`,
			lifecycle: "running",
			routeEligible: true,
			recipientPurpose: "agent",
			group,
		},
	]);
	const fixture = peersFixture(group, runId);
	const asker = await connectAsker(group);
	await fixture.peers.adopt(
		fixture.route(0, { stageName: "reviewer", liveRoute: { stageKeys: ["stage-0", "reviewer"], capability } }),
	);

	const asked = await asker.ask(`workflow:${runId}/reviewer`, "any blockers?");

	assert.equal(asked.delivered, true);
	assert.equal(asked.reply?.content.text, "stage-0 answers: any blockers?");
	assert.deepEqual(fixture.answered, ["stage-0"]);
});

/** A connection that speaks the broker protocol frame by frame, as a client this repository does not ship might. */
interface RawConnection {
	send(frame: Record<string, JsonWireValue>): void;
	/** The next frame of `type` the broker writes. */
	next(type: string): Promise<{ readonly [key: string]: JsonWireValue }>;
	/** Settles when the broker ends the connection. */
	readonly closed: Promise<void>;
}

async function rawConnection(
	group: string,
	options: { readonly protocolMax?: number; readonly register?: boolean; readonly recipientPurpose?: "control" } = {},
): Promise<RawConnection> {
	const socket = net.createConnection(getBrokerSocketPath());
	const frames: { readonly [key: string]: JsonWireValue }[] = [];
	const waiters: (() => void)[] = [];
	const closed = new Promise<void>((resolveClosed) => socket.once("close", () => resolveClosed()));
	socket.on("error", () => {});
	socket.on(
		"data",
		createMessageReader(
			(frame) => {
				frames.push(frame as { readonly [key: string]: JsonWireValue });
				for (const wake of waiters.splice(0)) wake();
			},
			() => socket.destroy(),
		),
	);
	cleanups.push(async () => {
		socket.destroy();
	});
	await new Promise<void>((resolveConnect) => socket.once("connect", () => resolveConnect()));
	const connection: RawConnection = {
		send: (frame) => writeMessage(socket, frame),
		async next(type) {
			const deadline = Date.now() + POLL_TIMEOUT_MS;
			for (;;) {
				const index = frames.findIndex((frame) => frame.type === type);
				if (index !== -1) return frames.splice(index, 1)[0]!;
				if (Date.now() > deadline) throw new Error(`the broker never wrote ${type}`);
				await new Promise<void>((wake) => {
					waiters.push(wake);
					setTimeout(wake, 25);
				});
			}
		},
		closed,
	};
	if (options.register !== false) {
		connection.send({
			type: "register",
			session: {
				...registration(`raw-${randomUUID()}`, group),
				...(options.recipientPurpose === undefined ? {} : { recipientPurpose: options.recipientPurpose }),
			} as unknown as JsonWireValue,
			protocol: { min: 1, max: options.protocolMax ?? 3 },
			registrationGroup: group,
		});
		await connection.next("registered");
	}
	return connection;
}

async function endsConnection(connection: RawConnection): Promise<boolean> {
	return Promise.race([
		connection.closed.then(() => true),
		new Promise<boolean>((resolveTimeout) => setTimeout(() => resolveTimeout(false), POLL_TIMEOUT_MS)),
	]);
}

test("the broker itself refuses a malformed host or removal frame with its refusal code (#4642)", async () => {
	const group = `workflow:${randomUUID()}`;
	const raw = await rawConnection(group);
	const nameless = { key: "nameless", session: registration(undefined, group) as unknown as JsonWireValue };

	raw.send({ type: "host_sessions", requestId: "empty", sessions: [] });
	assert.deepEqual(await raw.next("hosted_sessions_ack"), {
		type: "hosted_sessions_ack",
		requestId: "empty",
		refusal: { code: "invalid_hosted_frame" },
	});
	raw.send({ type: "host_sessions", requestId: "nameless", sessions: [nameless] });
	assert.deepEqual(await raw.next("hosted_sessions_ack"), {
		type: "hosted_sessions_ack",
		requestId: "nameless",
		refusal: { code: "invalid_hosted_session", key: "nameless" },
	});
	raw.send({ type: "unhost_sessions", requestId: "none", sessionIds: [] });
	assert.deepEqual(await raw.next("hosted_sessions_ack"), {
		type: "hosted_sessions_ack",
		requestId: "none",
		refusal: { code: "invalid_hosted_frame" },
	});
	const asker = await connectAsker(group);
	assert.deepEqual(await asker.listed(), [], "nothing was hosted");
});

test("a send as a session the connection does not host is refused for that attempt, whatever its message (#4642)", async () => {
	const group = `workflow:${randomUUID()}`;
	const raw = await rawConnection(group);
	const message = { id: "m-1", timestamp: 1, content: { text: "spoofed" } };

	raw.send({ type: "send", to: "anyone", message, attemptId: "attempt-2", hostedSender: "not-mine" });
	const refused = await raw.next("delivery_failed");
	assert.equal(refused.messageId, "m-1");
	assert.equal(refused.attemptId, "attempt-2");
	assert.equal(refused.reasonCode, "not_hosted_by_connection");

	raw.send({ type: "send", to: "anyone", message: { text: "no id" }, attemptId: 5, hostedSender: "not-mine" });
	const unnamed = await raw.next("delivery_failed");
	assert.equal(unnamed.messageId, "unknown");
	assert.equal(Object.hasOwn(unnamed, "attemptId"), false, "an attempt id that is not one is not echoed");
});

test("a live route asked for by a control session is refused as registrant_not_agent (#4642)", async () => {
	const runId = randomUUID();
	const group = `workflow:${runId}`;
	const owner = new IntercomClient();
	await owner.connect(
		{ ...registration(undefined, group), recipientPurpose: "control" },
		undefined,
		undefined,
		undefined,
		group,
	);
	cleanups.push(() => owner.disconnect());
	await owner.registerPendingStageRouteAcknowledged(runId, group, "the-capability", []);
	const control = await rawConnection(group, { recipientPurpose: "control" });

	control.send({
		type: "register_live_workflow_stage_route",
		requestId: "control-route",
		runId,
		stageKeys: ["reviewer"],
		capability: "the-capability",
	});

	const refusal = await control.next("registration_failed");
	assert.equal(refusal.code, "registrant_not_agent");
	assert.equal(await endsConnection(control), true);
});

test("a hosting request the broker cannot accept ends that connection and no other (#4642)", async () => {
	const group = `workflow:${randomUUID()}`;
	const session = { key: "k", session: registration("stage", group) as unknown as JsonWireValue };
	const requests: {
		readonly label: string;
		readonly options?: Parameters<typeof rawConnection>[1];
		readonly frame: Record<string, JsonWireValue>;
	}[] = [
		{
			label: "before registering",
			options: { register: false },
			frame: { type: "host_sessions", requestId: "r", sessions: [session] },
		},
		{
			label: "removal before registering",
			options: { register: false },
			frame: { type: "unhost_sessions", requestId: "r", sessionIds: ["x"] },
		},
		{
			label: "from a protocol-2 client",
			options: { protocolMax: 2 },
			frame: { type: "host_sessions", requestId: "r", sessions: [session] },
		},
		{ label: "without a request id", frame: { type: "host_sessions", sessions: [session] } },
		{ label: "removal without a request id", frame: { type: "unhost_sessions", sessionIds: ["x"] } },
		{
			label: "a sender that is not an id",
			frame: {
				type: "send",
				to: "anyone",
				message: { id: "m", timestamp: 1, content: { text: "x" } },
				attemptId: "a",
				hostedSender: 7,
			},
		},
	];
	for (const request of requests) {
		const raw = await rawConnection(group, request.options);
		raw.send(request.frame);
		assert.equal(await endsConnection(raw), true, request.label);
	}
	const asker = await connectAsker(group);
	assert.deepEqual(await asker.listed(), [], "nothing was hosted");
});

test("a hosted session whose live route is refused stays hosted under its name, with the refusal reported (#4642)", async () => {
	const runId = randomUUID();
	const group = `workflow:${runId}`;
	const owner = new IntercomClient();
	await owner.connect(
		{ ...registration(undefined, group), recipientPurpose: "control" },
		undefined,
		undefined,
		undefined,
		group,
	);
	cleanups.push(() => owner.disconnect());
	await owner.registerPendingStageRouteAcknowledged(runId, group, "the-capability", []);
	const host = await connectAsker(group);
	const hosted = (
		name: string,
		liveRoute: { runId: string; capability: string; stageKeys?: string[] },
		sessionGroup = group,
	) => ({
		key: name,
		session: { ...registration(name, sessionGroup), status: RELEASED_STAGE_STATUS },
		liveRoute: { stageKeys: [name], ...liveRoute },
	});

	const assigned = await host.client.hostSessions([
		hosted("routed", { runId, capability: "the-capability" }),
		hosted("wrong-capability", { runId, capability: "another" }),
		hosted("no-owner", { runId: randomUUID(), capability: "the-capability" }),
		hosted("path-key", { runId, capability: "the-capability", stageKeys: ["a/b"] }),
		hosted("glob-key", { runId, capability: "the-capability", stageKeys: ["a*"] }),
		hosted("one-bad-key", { runId, capability: "the-capability", stageKeys: ["fine", "a/b"] }),
		hosted("other-group", { runId, capability: "the-capability" }, "workflow:elsewhere"),
	]);

	assert.deepEqual(
		assigned.map(({ key, liveRouteRefusal }) => [key, liveRouteRefusal ?? "none"]),
		[
			["routed", "none"],
			["wrong-capability", "capability_mismatch"],
			["no-owner", "owner_missing"],
			["path-key", "invalid_stage_key"],
			["glob-key", "invalid_stage_key"],
			["one-bad-key", "invalid_stage_key"],
			["other-group", "group_mismatch"],
		],
	);
	const { group: _group, ...groupsOnly } = registration("groups-only-routed", group);
	const [routedByGroups] = await host.client.hostSessions([
		{
			key: "groups-only-routed",
			session: { ...groupsOnly, groups: [group], status: RELEASED_STAGE_STATUS },
			liveRoute: { runId, capability: "the-capability", stageKeys: ["groups-only-routed"] },
		},
	]);
	assert.equal(routedByGroups?.liveRouteRefusal, undefined, "its first group is its registration group");
	assert.deepEqual(
		(await host.listed()).map((session) => session.name).sort(),
		["glob-key", "groups-only-routed", "no-owner", "one-bad-key", "path-key", "routed", "wrong-capability"],
		"every refused session stays hosted; the one in another group is listed there",
	);
});

test("a hosted session is listed in its groups as given, trimmed, without a single group of its own (#4642)", async () => {
	const group = `workflow:${randomUUID()}`;
	const host = await connectAsker(group);
	const { group: _group, ...withoutGroup } = registration("groups-only", group);
	await host.client.hostSessions([
		{ key: "groups-only", session: { ...withoutGroup, groups: [group], status: RELEASED_STAGE_STATUS } },
		{ key: "padded", session: { ...registration("padded", `  ${group}  `), status: RELEASED_STAGE_STATUS } },
	]);

	const listed = await host.listed();
	assert.deepEqual(listed.map((session) => [session.name, session.group]).sort(), [
		["groups-only", group],
		["padded", group],
	]);
});

test("a removed hosted session is no longer the connection's to send as (#4642)", async () => {
	const group = `workflow:${randomUUID()}`;
	const host = await connectAsker(group);
	const [assignment] = await host.client.hostSessions([
		{ key: "removed", session: { ...registration("removed", group), status: RELEASED_STAGE_STATUS } },
	]);

	await host.client.unhostSessions([assignment!.sessionId]);

	assert.deepEqual(await host.listed(), []);
	const sent = await host.client.send(host.client.sessionId!, { text: "as it", hostedSender: assignment!.sessionId });
	assert.equal(sent.delivered, false);
	assert.ok(sent.error instanceof NotHostedSessionError);
	assert.equal(sent.error.sessionId, assignment!.sessionId);
});

test("a hosted session's message to a pending workflow stage carries its trimmed name and return address (#4642)", async () => {
	const runId = randomUUID();
	const group = `workflow:${runId}`;
	const capability = randomUUID();
	const owner = new IntercomClient();
	await owner.connect(
		{ ...registration(undefined, group), recipientPurpose: "control" },
		undefined,
		undefined,
		undefined,
		group,
	);
	cleanups.push(() => owner.disconnect());
	const seen = new Promise<{ senderRegistrationName?: string; senderReturnAddress?: string }>((resolveSeen) => {
		owner.on(
			"pending_stage_message",
			(request: { requestId: string; senderRegistrationName?: string; senderReturnAddress?: string }) => {
				owner.respondPendingStageMessage(request.requestId, { outcome: "queued", position: 1 });
				resolveSeen(request);
			},
		);
	});
	await owner.registerPendingStageRouteAcknowledged(runId, group, capability, [
		{
			stageId: "next",
			stageName: "next",
			target: `workflow:${runId}/next`,
			lifecycle: "pending",
			routeEligible: true,
			recipientPurpose: "agent",
			group,
		},
	]);
	const host = await connectAsker(group);
	const [assignment] = await host.client.hostSessions([
		{
			key: "released",
			session: { ...registration("  released-name  ", group), status: RELEASED_STAGE_STATUS },
			returnAddress: "released-session:released-stage",
		},
	]);

	const sent = await host.client.send(`workflow:${runId}/next`, {
		text: "for the next stage",
		hostedSender: assignment!.sessionId,
	});

	assert.equal(sent.queued, true, JSON.stringify(sent));
	const request = await seen;
	assert.equal(request.senderRegistrationName, "released-name");
	assert.equal(request.senderReturnAddress, "released-session:released-stage");
});

test("a released subagent's reply sent as a hosted session keeps waiting for its owner when another session of that connection is removed (#4642)", async () => {
	const group = `workflow:${randomUUID()}`;
	const childName = `released-asker-${randomUUID()}`;
	const owner = new IntercomClient();
	await owner.connect(registration(`owner-${randomUUID()}`, group), undefined, randomUUID(), undefined, group);
	cleanups.push(() => owner.disconnect());
	const handoffs: ReleasedChildReply[] = [];
	owner.on("released_child_reply", (handoff: ReleasedChildReply) => handoffs.push(handoff));
	const { capability, supervisorSessionId } = await owner.authorizeSupervisorChild(childName);
	const child = new IntercomClient();
	await child.connect(
		registration(childName, group),
		{ capability, supervisorSessionId },
		undefined,
		undefined,
		group,
	);
	cleanups.push(() => child.disconnect());
	const childSessionId = child.sessionId!;

	const host = await connectAsker(group);
	const received: string[] = [];
	host.client.on("hosted_message", (_recipient: string, _from: SessionInfo, message: Message) =>
		received.push(message.id),
	);
	const [replier, other] = await host.client.hostSessions([
		{ key: "replier", session: { ...registration("hosted-replier", group), status: RELEASED_STAGE_STATUS } },
		{ key: "other", session: { ...registration("hosted-other", group), status: RELEASED_STAGE_STATUS } },
	]);
	const questionId = randomUUID();
	const asked = await child.send("hosted-replier", { messageId: questionId, text: "Which file?", expectsReply: true });
	assert.equal(asked.delivered, true, asked.reason);
	await until(() => received.includes(questionId), "the hosted session never received the question");
	await owner.reserveReleasedChildren([{ childName, wake: true }]);
	await child.disconnect();
	await until(
		async () => !(await owner.listSessions(group)).some((session) => session.name === childName),
		"the released child never left",
	);

	let settled = false;
	const reply = host.client
		.send(childSessionId, {
			text: "src/config.ts",
			replyTo: questionId,
			requirePendingReply: true,
			expectedRecipientId: childSessionId,
			hostedSender: replier!.sessionId,
		})
		.finally(() => {
			settled = true;
		});
	await until(() => handoffs.length === 1, "the reply was never handed to the owner");

	await host.client.unhostSessions([other!.sessionId]);
	await host.client.listSessions(group);
	assert.equal(settled, false, "removing another hosted session does not settle the reply waiting on its owner");
	const bystander = new IntercomClient();
	await bystander.connect(registration("bystander", group), undefined, undefined, undefined, group);
	await bystander.disconnect();
	await until(
		async () => !(await host.client.listSessions(group)).some((session) => session.name === "bystander"),
		"the bystander never left",
	);
	assert.equal(settled, false, "another connection leaving does not settle it either");

	owner.acknowledgeReleasedChildReply(handoffs[0]!, true);
	const delivered = await reply;
	assert.equal(delivered.delivered, true, delivered.reason);
	assert.equal(handoffs[0]!.message.content.text, "src/config.ts");
});

async function until(condition: () => boolean | Promise<boolean>, failure: string): Promise<void> {
	const deadline = Date.now() + POLL_TIMEOUT_MS;
	while (!(await condition())) {
		if (Date.now() > deadline) throw new Error(failure);
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
	}
}
