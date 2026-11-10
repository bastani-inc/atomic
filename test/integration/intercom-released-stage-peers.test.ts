import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, test } from "vitest";
import type { IntercomClient as IntercomClientType } from "../../packages/intercom/broker/client.js";
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
const { HostedSessionRequestError, NotHostedSessionError, isNotHostedSessionError } = await import(
	"../../packages/intercom/broker/hosted-session-errors.js"
);

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
