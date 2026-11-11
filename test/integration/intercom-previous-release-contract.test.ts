import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import type net from "node:net";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, test, vi } from "vitest";
import { stopDetachedBroker } from "../helpers/detached-broker.js";
import { bunExecutable, type SpawnedProcess, spawnProcess } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

/**
 * #4538: this version's broker keeps serving the Intercom client of the previous release, 0.9.71, vendored unmodified
 * under test/fixtures/intercom-0.9.71: it accepts every frame that client sends, and writes it only frames it handles.
 */

const agentDir = useTemporaryAgentDir();
const repoRoot = resolve(import.meta.dirname, "../..");
const previousRelease = join(repoRoot, "test/fixtures/intercom-0.9.71");

const { createMessageReader } = await import("../../packages/intercom/broker/framing.js");
const { queryIntercomBroker } = await import("../../packages/intercom/broker/control.js");
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
const { PROTOCOL_2_FRAME_TYPES, PROTOCOL_3_FRAME_TYPES } = await import(
	"../../packages/intercom/broker/socket-writes.js"
);

type Client = InstanceType<typeof IntercomClient>;
type Message = import("../../packages/intercom/types.js").Message;
type SessionInfo = import("../../packages/intercom/types.js").SessionInfo;

/** The part of the 0.9.71 client the 0.9.71 runtime uses here. It is loaded by path, so it is not type-checked. */
interface PreviousClient extends EventEmitter {
	readonly sessionId: string | null;
	isConnected(): boolean;
	connect(
		session: Omit<SessionInfo, "id">,
		supervisor?: { capability: string; supervisorSessionId: string },
		supervisorOwnerToken?: string,
	): Promise<void>;
	send(
		to: string,
		options: {
			text: string;
			messageId?: string;
			replyTo?: string;
			expectsReply?: boolean;
			requirePendingReply?: true;
			expectedRecipientId?: string;
		},
	): Promise<{ id: string; delivered: boolean; reason?: string }>;
	listSessions(): Promise<SessionInfo[]>;
	acknowledgeReceived(messageId: string): void;
	disconnect(): Promise<void>;
}
type PreviousClientClass = new (
	returnAddress: string,
	options?: { preferredSessionId?: string; acknowledgesReceipt?: true },
) => PreviousClient;

const previousClientPath = join(previousRelease, "broker/client.ts");
const { IntercomClient: PreviousIntercomClient } = (await import(previousClientPath)) as {
	IntercomClient: PreviousClientClass;
};

const REAL_BROKER_TEST_TIMEOUT_MS = 60_000;
const WAIT = { timeout: 15_000, interval: 20 };

/** Every `case "<type>"` a module's switch handles. */
function handledCases(path: string): Set<string> {
	return new Set([...readFileSync(path, "utf8").matchAll(/case "([a-z_]+)"/g)].map((match) => match[1] ?? ""));
}

/** The `type` literals of an exported union in a `types.ts`, between its declaration and the next export. */
function unionTypes(path: string, union: string): Set<string> {
	const source = readFileSync(path, "utf8");
	const start = source.indexOf(`export type ${union} =`);
	assert.ok(start >= 0, `${union} in ${path}`);
	const end = source.indexOf("\nexport ", start + 1);
	return new Set([...source.slice(start, end).matchAll(/type: "([a-z_]+)"/g)].map((match) => match[1] ?? ""));
}

const PREVIOUS_CLIENT_HANDLES = handledCases(previousClientPath);

let broker: SpawnedProcess | undefined;
const cleanups: Array<() => Promise<void> | void> = [];
/** Frame types this version's broker wrote to 0.9.71 clients, and the protocol errors those clients raised. */
const toPreviousClients = new Set<string>();
const previousClientErrors: Error[] = [];

function startBroker(): SpawnedProcess {
	const started = spawnProcess([bunExecutable(), join(repoRoot, "packages/intercom/broker/broker.ts")], {
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
		env: { ...process.env, ATOMIC_CODING_AGENT_DIR: agentDir, ATOMIC_STORAGE: "" },
	});
	broker = started;
	return started;
}

async function brokerRunning(): Promise<number> {
	let pid = 0;
	await vi.waitFor(async () => {
		const query = await queryIntercomBroker(agentDir);
		assert.equal(query.state, "running");
		if (query.state === "running") {
			assert.deepEqual(query.report.protocol, { min: 1, max: 3 });
			pid = query.report.pid;
		}
	}, WAIT);
	return pid;
}

function session(name: string): Omit<SessionInfo, "id"> {
	return {
		name,
		model: "contract-model",
		cwd: repoRoot,
		pid: process.pid,
		status: "idle",
		startedAt: Date.now(),
		lastActivity: Date.now(),
		group: "default",
		groups: ["default"],
	};
}

/** Watch every frame the broker writes to a 0.9.71 client, and every protocol error it raises. */
function watchPreviousClient(client: PreviousClient): void {
	const socket = (client as unknown as { socket: net.Socket | null }).socket;
	assert.ok(socket, "the 0.9.71 client holds its socket once registered");
	socket.on(
		"data",
		createMessageReader(
			(frame) => {
				if (typeof frame === "object" && frame !== null && !Array.isArray(frame) && typeof frame.type === "string")
					toPreviousClients.add(frame.type);
			},
			() => {},
		),
	);
}

interface PreviousSession {
	readonly client: PreviousClient;
	readonly received: Message[];
}

/** A 0.9.71 session's client, as its runtime connects it: receipts on, each message confirmed once it is kept. */
async function connectPrevious(name: string, preferredSessionId?: string): Promise<PreviousSession> {
	const client = new PreviousIntercomClient(randomUUID(), {
		acknowledgesReceipt: true,
		...(preferredSessionId === undefined ? {} : { preferredSessionId }),
	});
	const received: Message[] = [];
	client.on("message", (_from: SessionInfo, message: Message) => {
		received.push(message);
		client.acknowledgeReceived(message.id);
	});
	client.on("error", (error: Error) => previousClientErrors.push(error));
	await client.connect(session(name));
	watchPreviousClient(client);
	cleanups.push(() => client.disconnect().catch(() => undefined));
	return { client, received };
}

async function connectCurrent(
	name: string,
	options: { ownerToken?: string; supervisor?: { capability: string; supervisorSessionId: string } } = {},
): Promise<{ client: Client; received: Message[] }> {
	const client = new IntercomClient(randomUUID());
	const received: Message[] = [];
	client.on("message", (_from: SessionInfo, message: Message) => received.push(message));
	await client.connect(session(name), options.supervisor, options.ownerToken);
	cleanups.push(() => client.disconnect().catch(() => undefined));
	return { client, received };
}

function idOf(client: { readonly sessionId: string | null }): string {
	const id = client.sessionId;
	assert.ok(id);
	return id;
}

beforeAll(async () => {
	startBroker();
	await brokerRunning();
}, REAL_BROKER_TEST_TIMEOUT_MS);

afterAll(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	broker?.kill("SIGTERM");
	await broker?.exited;
	await stopDetachedBroker(agentDir);
}, REAL_BROKER_TEST_TIMEOUT_MS);

describe("the 0.9.71 Intercom client against this version's broker (#4538)", () => {
	test("every frame type the 0.9.71 client sends is one this version's broker handles", () => {
		const sent = unionTypes(join(previousRelease, "types.ts"), "ClientMessage");
		const handled = handledCases(join(repoRoot, "packages/intercom/broker/broker.ts"));
		for (const control of ["health", "broker_status", "shutdown"]) handled.add(control);
		assert.ok(sent.size > 20, [...sent].join(", "));
		assert.deepEqual(
			[...sent].filter((type) => !handled.has(type)),
			[],
		);
	});

	test("every frame type this version's broker writes is one the 0.9.71 client handles, or one of protocol 2 or 3 it is never sent (#4642)", () => {
		const written = unionTypes(join(repoRoot, "packages/intercom/types.ts"), "BrokerMessage");
		const answeredOnlyToTheBrokerWatchdogOrAControlClient = new Set(["health", "shutdown_ack"]);
		const newer: ReadonlySet<string> = new Set([...PROTOCOL_2_FRAME_TYPES, ...PROTOCOL_3_FRAME_TYPES]);
		assert.ok(written.size > 20, [...written].join(", "));
		assert.deepEqual(
			[...written].filter(
				(type) =>
					!PREVIOUS_CLIENT_HANDLES.has(type) &&
					!newer.has(type) &&
					!answeredOnlyToTheBrokerWatchdogOrAControlClient.has(type),
			),
			[],
		);
		for (const type of newer) assert.equal(PREVIOUS_CLIENT_HANDLES.has(type), false, type);
	});

	test(
		"registers, and exchanges sends and asks with 0.9.71 and current sessions both ways",
		async () => {
			const alpha = await connectPrevious("previous-alpha");
			const beta = await connectPrevious("previous-beta");
			const current = await connectCurrent("current-gamma");
			const sessions = await alpha.client.listSessions();
			assert.deepEqual(
				["current-gamma", "previous-alpha", "previous-beta"].map((name) =>
					sessions.some((info) => info.name === name),
				),
				[true, true, true],
			);

			const toBeta = await alpha.client.send("previous-beta", { text: "old to old" });
			assert.equal(toBeta.delivered, true, toBeta.reason);
			const toCurrent = await alpha.client.send("current-gamma", { text: "old to new" });
			assert.equal(toCurrent.delivered, true, toCurrent.reason);
			const toAlpha = await current.client.send(idOf(alpha.client), { text: "new to old" });
			assert.equal(toAlpha.delivered, true, toAlpha.reason);
			await vi.waitFor(() => {
				assert.deepEqual(
					beta.received.map((message) => message.content.text),
					["old to old"],
				);
				assert.ok(current.received.some((message) => message.content.text === "old to new"));
				assert.ok(alpha.received.some((message) => message.content.text === "new to old"));
			}, WAIT);

			const oldAsks = await alpha.client.send("current-gamma", { text: "old asks", expectsReply: true });
			assert.equal(oldAsks.delivered, true, oldAsks.reason);
			const newAnswers = await current.client.send(idOf(alpha.client), {
				text: "new answers",
				replyTo: oldAsks.id,
				requirePendingReply: true,
			});
			assert.equal(newAnswers.delivered, true, newAnswers.reason);
			const newAsks = await current.client.send("previous-alpha", { text: "new asks", expectsReply: true });
			assert.equal(newAsks.delivered, true, newAsks.reason);
			await vi.waitFor(() => assert.ok(alpha.received.some((message) => message.id === newAsks.id)), WAIT);
			const oldAnswers = await alpha.client.send(idOf(current.client), {
				text: "old answers",
				replyTo: newAsks.id,
				requirePendingReply: true,
				expectedRecipientId: idOf(current.client),
			});
			assert.equal(oldAnswers.delivered, true, oldAnswers.reason);
			await vi.waitFor(() => {
				assert.ok(
					alpha.received.some(
						(message) => message.replyTo === oldAsks.id && message.content.text === "new answers",
					),
				);
				assert.ok(
					current.received.some(
						(message) => message.replyTo === newAsks.id && message.content.text === "old answers",
					),
				);
			}, WAIT);
			assert.equal(alpha.client.isConnected(), true);
			assert.equal(beta.client.isConnected(), true);
		},
		REAL_BROKER_TEST_TIMEOUT_MS,
	);

	test(
		"a 0.9.71 session's reply to a released asker reaches the asker's owner",
		async () => {
			const replier = await connectPrevious("previous-replier");
			const owner = await connectCurrent("current-owner", { ownerToken: randomUUID() });
			const childName = "subagent-released-asker";
			const authorization = await owner.client.authorizeSupervisorChild(childName);
			const child = await connectCurrent(childName, { supervisor: authorization });
			const childSessionId = idOf(child.client);
			const handedOver: Array<{ replyTo: string; text: string }> = [];
			owner.client.on(
				"released_child_reply",
				(reply: import("../../packages/intercom/broker/client.js").ReleasedChildReply) => {
					handedOver.push({ replyTo: reply.replyTo, text: reply.message.content.text });
					owner.client.acknowledgeReleasedChildReply(reply, true);
				},
			);

			const question = await child.client.send("previous-replier", { text: "which file?", expectsReply: true });
			assert.equal(question.delivered, true, question.reason);
			await vi.waitFor(() => assert.ok(replier.received.some((message) => message.id === question.id)), WAIT);
			await owner.client.reserveReleasedChildren([{ childName, wake: true }]);
			await child.client.disconnect();
			await vi.waitFor(async () => {
				assert.equal(
					(await owner.client.listSessions()).some((info) => info.id === childSessionId),
					false,
				);
			}, WAIT);

			const reply = await replier.client.send(childSessionId, {
				text: "config.json",
				replyTo: question.id,
				requirePendingReply: true,
				expectedRecipientId: childSessionId,
			});
			assert.equal(reply.delivered, true, reply.reason);
			assert.deepEqual(handedOver, [{ replyTo: question.id, text: "config.json" }]);
			assert.equal(replier.client.isConnected(), true);
		},
		REAL_BROKER_TEST_TIMEOUT_MS,
	);

	test(
		"a 0.9.71 asker of a released subagent stays connected when the subagent is restored, and receives its reply",
		async () => {
			const asker = await connectPrevious("previous-asker");
			const owner = await connectCurrent("current-restoring-owner", { ownerToken: randomUUID() });
			const childName = "subagent-restored-answerer";
			const child = await connectCurrent(childName, {
				supervisor: await owner.client.authorizeSupervisorChild(childName),
			});
			const originalId = idOf(child.client);
			const question = await asker.client.send(childName, { text: "question", expectsReply: true });
			assert.equal(question.delivered, true, question.reason);
			await owner.client.reserveReleasedChildren([{ childName, wake: false }]);
			await child.client.disconnect();
			await vi.waitFor(async () => {
				assert.equal(
					(await owner.client.listSessions()).some((info) => info.id === originalId),
					false,
				);
			}, WAIT);
			await owner.client.reserveReleasedChildren([{ childName, wake: true }]);
			const restored = await connectCurrent(childName, {
				supervisor: await owner.client.authorizeSupervisorChild(childName),
			});

			const reply = await restored.client.send(idOf(asker.client), {
				text: "answer",
				replyTo: question.id,
				requirePendingReply: true,
			});
			assert.equal(reply.delivered, true, reply.reason);
			await vi.waitFor(
				() =>
					assert.ok(asker.received.some((message) => message.id === reply.id && message.replyTo === question.id)),
				WAIT,
			);
			assert.equal(asker.client.isConnected(), true);
		},
		REAL_BROKER_TEST_TIMEOUT_MS,
	);

	test(
		"a 0.9.71 session reconnects to a restarted broker under its own session id and keeps exchanging messages",
		async () => {
			const previous = await connectPrevious("previous-reconnecting");
			const current = await connectCurrent("current-reconnecting");
			const originalId = idOf(previous.client);
			const disconnected = new Promise<void>((settle) => previous.client.once("disconnected", () => settle()));
			const stopping = broker;
			assert.ok(stopping);
			stopping.kill("SIGTERM");
			await stopping.exited;
			await disconnected;
			startBroker();
			await brokerRunning();

			const reconnected = await connectPrevious("previous-reconnecting", originalId);
			assert.equal(reconnected.client.sessionId, originalId);
			const peer = await connectCurrent("current-after-restart");
			const toPrevious = await peer.client.send("previous-reconnecting", { text: "after restart" });
			assert.equal(toPrevious.delivered, true, toPrevious.reason);
			const toCurrent = await reconnected.client.send("current-after-restart", { text: "back again" });
			assert.equal(toCurrent.delivered, true, toCurrent.reason);
			await vi.waitFor(() => {
				assert.ok(reconnected.received.some((message) => message.content.text === "after restart"));
				assert.ok(peer.received.some((message) => message.content.text === "back again"));
			}, WAIT);
			assert.equal(current.client.isConnected(), false);
		},
		REAL_BROKER_TEST_TIMEOUT_MS,
	);

	test("the broker wrote the 0.9.71 clients only frame types they handle, and none raised a protocol error", () => {
		assert.ok(toPreviousClients.has("message"), [...toPreviousClients].join(", "));
		assert.deepEqual(
			[...toPreviousClients].filter((type) => !PREVIOUS_CLIENT_HANDLES.has(type)),
			[],
		);
		assert.deepEqual(
			previousClientErrors.map((error) => error.message),
			[],
		);
	});
});

const alphaRelease = join(repoRoot, "test/fixtures/intercom-0.9.77-alpha.1");
const { IntercomClient: AlphaIntercomClient } = (await import(join(alphaRelease, "broker/client.ts"))) as {
	IntercomClient: PreviousClientClass;
};

describe("the 0.9.77-alpha.1 Intercom client against a released stage hosted on this version's broker (#4642)", () => {
	const STAGE_STATUS = "closed · reply: post-mortem only";

	interface HostedStage {
		readonly host: Client;
		readonly hosted: { readonly name: string; readonly id: string };
		readonly asked: { readonly recipient: string; readonly message: Message }[];
	}

	async function connectAlpha(name: string, group: string) {
		const client = new AlphaIntercomClient(randomUUID(), { acknowledgesReceipt: true });
		const received: Message[] = [];
		const errors: Error[] = [];
		client.on("message", (_from: SessionInfo, message: Message) => {
			received.push(message);
			client.acknowledgeReceived(message.id);
		});
		client.on("error", (error: Error) => errors.push(error));
		await (client as unknown as { connect: (...args: unknown[]) => Promise<void> }).connect(
			{ ...session(name), group, groups: [group] },
			undefined,
			undefined,
			undefined,
			group,
		);
		cleanups.push(() => client.disconnect().catch(() => undefined));
		return { client, received, errors };
	}

	async function hostStage(group: string): Promise<HostedStage> {
		const host = new IntercomClient(randomUUID());
		const asked: HostedStage["asked"] = [];
		host.on("hosted_message", (recipient: string, _from: SessionInfo, message: Message) =>
			asked.push({ recipient, message }),
		);
		const now = Date.now();
		await host.connect(
			{ ...session(`stage-host-${randomUUID()}`), group, groups: [group], recipientPurpose: "control" },
			undefined,
			undefined,
			undefined,
			group,
		);
		cleanups.push(() => host.disconnect().catch(() => undefined));
		const name = `subagent-chat-${randomUUID()}`;
		const [assigned] = await host.hostSessions([
			{
				key: "stage",
				session: {
					name,
					cwd: repoRoot,
					model: "faux/model",
					pid: process.pid,
					startedAt: now,
					lastActivity: now,
					status: STAGE_STATUS,
					replyCapability: "live",
					groups: [group],
					group,
				},
				returnAddress: `${name}:released-stage`,
			},
		]);
		assert.ok(assigned);
		return { host, hosted: { name, id: assigned.sessionId }, asked };
	}

	test(
		"lists the hosted stage, asks it and receives its reply",
		async () => {
			const group = `workflow:${randomUUID()}`;
			const stage = await hostStage(group);
			const alpha = await connectAlpha(`alpha-asker-${randomUUID()}`, group);

			const listed = await alpha.client.listSessions();
			const entry = listed.find((info) => info.name === stage.hosted.name);
			assert.equal(entry?.id, stage.hosted.id);
			assert.equal(entry?.status, STAGE_STATUS);

			const ask = await alpha.client.send(stage.hosted.name, { text: "which file?", expectsReply: true });
			assert.equal(ask.delivered, true, ask.reason);
			await vi.waitFor(() => assert.equal(stage.asked.length, 1), WAIT);
			assert.equal(stage.asked[0]!.recipient, stage.hosted.id);
			const reply = await stage.host.send(idOf(alpha.client), {
				text: "the parser",
				replyTo: ask.id,
				requirePendingReply: true,
				hostedSender: stage.hosted.id,
			});
			assert.equal(reply.delivered, true, reply.reason);
			await vi.waitFor(
				() =>
					assert.ok(
						alpha.received.some((message) => message.replyTo === ask.id && message.content.text === "the parser"),
					),
				WAIT,
			);
			assert.deepEqual(alpha.errors, []);
			assert.equal(alpha.client.isConnected(), true);
		},
		REAL_BROKER_TEST_TIMEOUT_MS,
	);

	test(
		"keeps its connection, with a plain refusal, when it sends to a released stage whose hosted peer is gone",
		async () => {
			const group = `workflow:${randomUUID()}`;
			const stage = await hostStage(group);
			const alpha = await connectAlpha(`alpha-sender-${randomUUID()}`, group);
			await stage.host.unhostSessions([stage.hosted.id]);

			for (const target of [stage.hosted.name, stage.hosted.id]) {
				const refused = await alpha.client.send(target, { text: "are you there?" });
				assert.equal(refused.delivered, false);
				assert.ok((refused.reason ?? "").length > 0, "it carries a reason to show");
				assert.match(refused.reason ?? "", /released and the session that answered for it has gone away/);
			}
			assert.deepEqual(alpha.errors, [], "no protocol error was raised on the client");
			assert.equal(alpha.client.isConnected(), true, "the connection survived the refusal");
			assert.ok(Array.isArray(await alpha.client.listSessions()), "and it still serves requests");
		},
		REAL_BROKER_TEST_TIMEOUT_MS,
	);
});
