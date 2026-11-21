import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, afterEach, test, vi } from "vitest";
import {
	type AgentSession,
	createAgentSession,
	createAgentSessionFromServices,
	createAgentSessionServices,
	SessionManager,
	SettingsManager,
} from "../../packages/coding-agent/src/index.js";
import { IntercomClient } from "../../packages/intercom/broker/client.js";
import { queryIntercomBroker } from "../../packages/intercom/broker/control.js";
import { createMessageReader, writeMessage } from "../../packages/intercom/broker/framing.js";
import { getBrokerSocketPath } from "../../packages/intercom/broker/paths.js";
import { getJitiCliPath, spawnBrokerIfNeeded } from "../../packages/intercom/broker/spawn.js";
import type { BrokerMessage, Message, SessionInfo, SupervisorRegistration } from "../../packages/intercom/types.js";
import { stopDetachedBroker } from "../helpers/detached-broker.js";
import { makeTempDirectory, moduleDir, removeTempDirectory } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

const REAL_BROKER_SESSION_TIMEOUT_MS = 90_000;
const BROKER_START_TIMEOUT_MS = 30_000;
const SETTLE_MS = 300;

const agentDir = useTemporaryAgentDir();
const cwd = makeTempDirectory("atomic-intercom-reach-");
const repoRoot = join(moduleDir(import.meta.url), "../..");

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});
afterAll(async () => {
	await stopDetachedBroker(agentDir);
	removeTempDirectory(cwd);
});

interface ToolResult {
	readonly isError?: boolean;
	readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
	readonly details?: Record<string, unknown>;
	readonly structuredContent?: Record<string, unknown>;
}

interface HostSession {
	readonly session: AgentSession;
	intercom(params: Record<string, unknown>): Promise<ToolResult>;
	id(): Promise<string>;
	visible(): Promise<string[]>;
}

function text(result: ToolResult): string {
	return result.content.map((part) => part.text ?? "").join("\n");
}

async function hostSession(intercom?: { group: string; reachable?: string[] }): Promise<HostSession> {
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, sessionSummary: { enabled: false } }),
		builtins: { subagents: false, mcp: false, "web-access": false },
		...(intercom === undefined ? {} : { intercom }),
	});
	cleanups.push(() => session.dispose());
	const run = async (params: Record<string, unknown>): Promise<ToolResult> => {
		const tool = session.agent.state.tools.find((candidate) => candidate.name === "intercom");
		assert.ok(tool, "the intercom tool is active");
		return (await tool.execute(randomUUID(), params as never, new AbortController().signal)) as ToolResult;
	};
	return {
		session,
		intercom: run,
		async id() {
			const status = await run({ action: "status" });
			assert.equal(status.isError ?? false, false, text(status));
			return String(status.structuredContent?.sessionId);
		},
		async visible() {
			const list = await run({ action: "list" });
			assert.equal(list.isError ?? false, false, text(list));
			const sessions = (list.structuredContent?.sessions ?? []) as Array<{ sessionId: string; self: boolean }>;
			return sessions.filter((entry) => !entry.self).map((entry) => entry.sessionId);
		},
	};
}

interface Peer {
	readonly client: IntercomClient;
	readonly id: string;
	readonly received: Message[];
	readonly senders: SessionInfo[];
}

async function peer(home: string, reach?: { reachable: string[] }, ownerToken?: string): Promise<Peer> {
	await spawnBrokerIfNeeded("npx", ["--no-install", "tsx"], BROKER_START_TIMEOUT_MS);
	const client = new IntercomClient(undefined, reach === undefined ? {} : { reach: () => ({ home, ...reach }) });
	const received: Message[] = [];
	const senders: SessionInfo[] = [];
	client.on("message", (from: SessionInfo, message: Message) => {
		senders.push(from);
		received.push(message);
	});
	const now = Date.now();
	await client.connect(
		{
			name: `peer-${home}-${randomUUID().slice(0, 8)}`,
			cwd,
			model: "peer",
			pid: process.pid,
			startedAt: now,
			lastActivity: now,
			groups: [home],
			group: home,
		},
		undefined,
		ownerToken,
		undefined,
		home,
	);
	cleanups.push(() => client.disconnect());
	return { client, id: client.sessionId!, received, senders };
}

function group(label: string): string {
	return `doc-${label}-${randomUUID().slice(0, 8)}`;
}

test(
	"sessions in different groups with no reachable groups can't see or message each other or join each other's group (#5352)",
	async () => {
		const [homeA, homeB] = [group("a"), group("b")];
		const a = await hostSession({ group: homeA });
		const b = await hostSession({ group: homeB });
		const [idA, idB] = [await a.id(), await b.id()];

		assert.ok(!(await a.visible()).includes(idB));
		assert.ok(!(await b.visible()).includes(idA));

		const send = await a.intercom({ action: "send", to: idB, message: "hello" });
		assert.equal(send.isError, true, text(send));
		assert.match(
			text(send),
			/outside this session's Intercom reach \(home group doc-a-\w+; reachable groups: none\)/,
		);
		const ask = await b.intercom({ action: "ask", to: idA, message: "anyone?", wait: { kind: "background" } });
		assert.equal(ask.isError, true, text(ask));

		const join = await a.intercom({ action: "join", group: homeB });
		assert.equal(join.isError, true);
		assert.match(text(join), /outside this session's Intercom reach/);
		const groups = await a.intercom({ action: "groups" });
		assert.deepEqual(
			((groups.details?.groups ?? []) as Array<{ group: string }>).map((summary) => summary.group),
			[homeA],
		);
		const peek = await a.intercom({ action: "list", group: homeB });
		assert.equal(peek.isError, true);
		const leave = await a.intercom({ action: "leave", group: homeA });
		assert.equal(leave.isError, true);
		assert.match(text(leave), /can't be left/);
	},
	REAL_BROKER_SESSION_TIMEOUT_MS,
);

test(
	"with B's group reachable, A lists, sends to and asks B, and B replies but can't start a message to A (#5352)",
	async () => {
		const [homeA, homeB] = [group("a"), group("b")];
		const a = await hostSession({ group: homeA, reachable: [homeB] });
		const idA = await a.id();
		const b = await peer(homeB, { reachable: [] });

		assert.ok((await a.visible()).includes(b.id), "A lists B");
		assert.deepEqual(await b.client.listSessions().then((sessions) => sessions.map((session) => session.id)), [b.id]);

		const send = await a.intercom({ action: "send", to: b.id, message: "status update" });
		assert.equal(send.isError ?? false, false, text(send));
		await vi.waitFor(() =>
			assert.deepEqual(
				b.received.map((message) => message.content.text),
				["status update"],
			),
		);

		b.client.on("message", (from: SessionInfo, message: Message) => {
			if (message.expectsReply === true)
				void b.client.send(from.id, { text: "the answer", replyTo: message.id, requirePendingReply: true });
		});
		const ask = await a.intercom({
			action: "ask",
			to: b.id,
			message: "what is the answer?",
			wait: { kind: "foreground", budgetMs: 15_000 },
		});
		assert.equal(ask.isError ?? false, false, text(ask));
		assert.match(text(ask), /the answer/);

		const unprompted = await b.client.send(idA, { text: "may I?" });
		assert.equal(unprompted.delivered, false);
		assert.match(unprompted.reason ?? "", /outside this session's Intercom reach/);
	},
	REAL_BROKER_SESSION_TIMEOUT_MS,
);

test(
	"widening reach takes effect on the next call, narrowing refuses the next send, and a refused send is never queued (#5352)",
	async () => {
		const [homeA, homeB] = [group("a"), group("b")];
		const a = await hostSession({ group: homeA });
		await a.id();
		const b = await peer(homeB);

		const refused = await a.intercom({ action: "send", to: b.id, message: "too early" });
		assert.equal(refused.isError, true, text(refused));

		void a.session.intercom.setReachable([homeB]);
		assert.deepEqual(a.session.intercom.reachable, [homeB]);
		const widened = await a.intercom({ action: "send", to: b.id, message: "now in reach" });
		assert.equal(widened.isError ?? false, false, text(widened));
		const joined = await a.intercom({ action: "join", group: homeB });
		assert.equal(joined.isError ?? false, false, text(joined));

		const narrowing = a.session.intercom.setReachable([]);
		const narrowed = await a.intercom({ action: "send", to: b.id, message: "out of reach again" });
		assert.equal(narrowed.isError, true, text(narrowed));
		await narrowing;
		const status = await a.intercom({ action: "status" });
		assert.deepEqual(status.structuredContent?.groups, [homeA], "the joined group was dropped with the reach");

		await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
		assert.deepEqual(
			b.received.map((message) => message.content.text),
			["now in reach"],
			"neither refused send was queued and delivered later",
		);
	},
	REAL_BROKER_SESSION_TIMEOUT_MS,
);

for (const narrowAfterHeld of [true, false])
	test(
		`a send held by a single broker keeps its receipt-time reach when narrowed ${narrowAfterHeld ? "after send_held" : "in the send's tick"} (#5352)`,
		async () => {
			const [home, other] = [group("held-home"), group("held-other")];
			const owner = await peer(other, undefined, randomUUID());
			const status = await queryIntercomBroker(agentDir);
			assert.equal(status.state, "running");
			assert.ok(status.state === "running");
			assert.equal(status.report.multiNode.status, "off", "held sends replay on the single broker");
			const childName = `subagent-worker-${randomUUID()}-1`;
			const supervisor = await owner.client.authorizeSupervisorChild(childName);
			await owner.client.reserveRestoringRecipient(supervisor.capability, { group: other, holdMs: 60_000 });
			const sender = await rawRegistration(home, { reachable: [other] });
			const messageId = randomUUID();
			const requestId = randomUUID();
			const narrow = () => writeMessage(sender.socket, { type: "set_reach", requestId, reachable: [] });
			sender.socket.cork();
			writeMessage(sender.socket, {
				type: "send",
				to: childName,
				message: { id: messageId, timestamp: Date.now(), content: { text: "held before narrowing" } },
				awaitRestoringRecipient: true,
			});
			if (!narrowAfterHeld) narrow();
			sender.socket.uncork();
			const held = await sender.next(
				(frame) =>
					(frame.type === "send_held" || frame.type === "delivery_failed") && frame.messageId === messageId,
			);
			assert.equal(held.type, "send_held", JSON.stringify(held));
			if (narrowAfterHeld) narrow();
			await sender.next((frame) => frame.type === "reach_ack" && frame.requestId === requestId);

			const child = await rawRegistration(other, { name: childName, supervisor, reachable: [] });
			const outcome = await sender.next(
				(frame) =>
					(frame.type === "delivered" || frame.type === "delivery_failed") && frame.messageId === messageId,
			);
			assert.equal(outcome.type, "delivered", JSON.stringify(outcome));
			await child.next((frame) => frame.type === "message" && frame.message.id === messageId);
			await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
			assert.deepEqual(
				child.frames.flatMap((frame) => (frame.type === "message" ? [frame.message.id] : [])),
				[messageId],
				"the restoring child receives the held send exactly once",
			);
		},
		REAL_BROKER_SESSION_TIMEOUT_MS,
	);

test(
	"the broker refuses a forged join, peek, presence or reach change from a client (#5352)",
	async () => {
		const [homeA, homeC] = [group("a"), group("c")];
		const a = await hostSession({ group: homeA });
		const idA = await a.id();
		const c = await peer(homeC, { reachable: [] });

		await assert.rejects(c.client.joinGroup(homeA), /outside this session's Intercom reach/);
		await assert.rejects(c.client.leaveGroup(homeC), /can't be left/);
		await assert.rejects(c.client.updatePresenceAcked({ groups: [homeC, homeA] }), /outside this session's reach/);
		const peek = await c.client.listDirectory(homeA);
		assert.equal(peek.restricted, true);
		assert.deepEqual(peek.sessions, []);
		assert.deepEqual(
			(await c.client.listGroups()).map((summary) => summary.group),
			[homeC],
		);
		const send = await c.client.send(idA, { text: "forged" });
		assert.equal(send.delivered, false);
		assert.deepEqual(c.client.groups, [homeC]);

		const now = Date.now();
		const stage = (key: string, home: string) => ({
			key,
			session: {
				name: key,
				cwd,
				model: "m",
				pid: process.pid,
				startedAt: now,
				lastActivity: now,
				groups: [home],
				group: home,
			},
		});
		await assert.rejects(
			c.client.hostSessions([stage("into-a", homeA)]),
			(error: Error & { code?: string }) => error.code === "invalid_hosted_session",
		);
		await assert.rejects(
			c.client.hostSessions([stage("in-a-former-workflow-group", `workflow:${randomUUID()}`)]),
			(error: Error & { code?: string }) => error.code === "invalid_hosted_session",
			"a workflow: group is an ordinary group, outside this host's reach",
		);
		const [hosted] = await c.client.hostSessions([stage("in-home", homeC)]);
		assert.ok(hosted, "a session in a group the host reaches is hosted");
		const asHosted = await c.client.send(idA, { text: "as a hosted session", hostedSender: hosted.sessionId });
		assert.equal(asHosted.delivered, false);
		assert.match(asHosted.reason ?? "", /can only reply to an ask it received/);

		const legacy = await rawRegistration(group("legacy"));
		writeMessage(legacy.socket, { type: "set_reach", requestId: "widen", reachable: [homeA] });
		const answer = await legacy.next((frame) => frame.type === "reach_failed" || frame.type === "reach_ack");
		assert.equal(answer.type, "reach_failed");
	},
	REAL_BROKER_SESSION_TIMEOUT_MS,
);

test(
	"a session in another process is held to its policy by the same broker (#5352)",
	async () => {
		const [homeA, homeX] = [group("a"), group("x")];
		const a = await hostSession({ group: homeA, reachable: [homeX] });
		const idA = await a.id();
		const child = spawn(
			process.execPath,
			[
				getJitiCliPath(join(repoRoot, "packages/intercom")),
				join(repoRoot, "test/integration/fixtures/intercom-reach-peer.ts"),
				homeX,
				idA,
				homeA,
			],
			{ cwd, env: { ...process.env, ATOMIC_CODING_AGENT_DIR: agentDir }, stdio: ["ignore", "pipe", "pipe"] },
		);
		cleanups.push(() => stopChild(child));
		const records = lines(child);

		const ready = await records.next("ready");
		assert.ok(!(ready.listed as string[]).includes(idA), "the other process does not list A");
		assert.deepEqual(ready.send, { delivered: false, reason: (ready.send as { reason: string }).reason });
		assert.match((ready.send as { reason: string }).reason, /outside this session's Intercom reach/);
		assert.match(String((ready.join as { refused?: string }).refused), /outside this session's Intercom reach/);
		assert.deepEqual(ready.peek, { restricted: true, sessions: [] });
		assert.deepEqual(ready.groups, [homeX]);

		const peerId = String(ready.sessionId);
		assert.ok((await a.visible()).includes(peerId), "A lists the session in the other process");
		const send = await a.intercom({ action: "send", to: peerId, message: "across processes" });
		assert.equal(send.isError ?? false, false, text(send));
		const done = await records.next("done");
		assert.deepEqual(done.received, ["across processes"]);
	},
	REAL_BROKER_SESSION_TIMEOUT_MS,
);

test(
	"the policy, including a live change, survives a broker restart and reconnect (#5352)",
	async () => {
		const [homeA, homeB, homeC] = [group("a"), group("b"), group("c")];
		const a = await hostSession({ group: homeA });
		await a.id();
		await a.session.intercom.setReachable([homeB]);
		await killBroker();

		await vi.waitFor(async () => assert.equal((await a.intercom({ action: "status" })).isError ?? false, false), {
			timeout: BROKER_START_TIMEOUT_MS,
			interval: 250,
		});
		const b = await peer(homeB);
		const c = await peer(homeC);
		const visible = await a.visible();
		assert.ok(visible.includes(b.id), "the widened reach came back with the reconnect");
		assert.ok(!visible.includes(c.id));

		const outside = await a.intercom({ action: "send", to: c.id, message: "still out of reach" });
		assert.equal(outside.isError, true);
		assert.match(
			text(outside),
			/outside this session's Intercom reach \(home group doc-a-\w+; reachable groups: doc-b-\w+\)/,
		);
		const byName = await a.intercom({ action: "send", to: "no-such-session", message: "anyone" });
		assert.match(
			text(byName),
			/This session reaches only sessions in its home group/,
			"the restarted broker holds the policy",
		);
		const inside = await a.intercom({ action: "send", to: b.id, message: "in reach after the restart" });
		assert.equal(inside.isError ?? false, false, text(inside));
		await vi.waitFor(() =>
			assert.deepEqual(
				b.received.map((message) => message.content.text),
				["in reach after the restart"],
			),
		);
		assert.deepEqual(c.received, []);
	},
	REAL_BROKER_SESSION_TIMEOUT_MS,
);

test(
	"a runtime factory passes the option through createAgentSessionFromServices (#5352)",
	async () => {
		const home = group("services");
		const services = await createAgentSessionServices({ cwd, agentDir });
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(cwd),
			builtins: { subagents: false, mcp: false, "web-access": false },
			intercom: { group: home },
		});
		cleanups.push(() => session.dispose());
		assert.equal(session.intercom.group, home);
		const tool = session.agent.state.tools.find((candidate) => candidate.name === "intercom");
		assert.ok(tool);
		const status = (await tool.execute(
			randomUUID(),
			{ action: "status" } as never,
			new AbortController().signal,
		)) as ToolResult;
		assert.deepEqual(status.structuredContent?.groups, [home]);
	},
	REAL_BROKER_SESSION_TIMEOUT_MS,
);

test(
	"a session created without the option keeps today's membership rules (#5352)",
	async () => {
		const shared = group("shared");
		const legacy = await peer(shared);
		const plain = await hostSession();
		const join = await plain.intercom({ action: "join", group: shared });
		assert.equal(join.isError ?? false, false, text(join));
		assert.ok((await plain.visible()).includes(legacy.id));
		assert.equal(plain.session.intercom.group, undefined);
		await assert.rejects(plain.session.intercom.setReachable([shared]), /created without the intercom option/);
	},
	REAL_BROKER_SESSION_TIMEOUT_MS,
);

/** Kills the broker as a crash does, and waits until it is gone. #6125: only the broker that answers in this agent dir. */
async function killBroker(): Promise<void> {
	assert.equal(await stopDetachedBroker(agentDir, { signals: ["SIGKILL"] }), true, "no broker answered to be killed");
}

interface RawRegistration {
	readonly socket: net.Socket;
	readonly frames: readonly BrokerMessage[];
	next(matches: (frame: BrokerMessage) => boolean): Promise<BrokerMessage>;
}

async function rawRegistration(
	home: string,
	options: { name?: string; reachable?: string[]; supervisor?: SupervisorRegistration } = {},
): Promise<RawRegistration> {
	const socket = net.connect(getBrokerSocketPath());
	cleanups.push(() => {
		socket.destroy();
	});
	const frames: BrokerMessage[] = [];
	const waiters = new Set<() => void>();
	socket.on(
		"data",
		createMessageReader(
			(frame) => {
				frames.push(frame as unknown as BrokerMessage);
				for (const wake of waiters) wake();
			},
			(error) => socket.destroy(error),
		),
	);
	const next = (matches: (frame: BrokerMessage) => boolean): Promise<BrokerMessage> =>
		new Promise((resolve) => {
			const check = () => {
				const found = frames.find(matches);
				if (found === undefined) return;
				waiters.delete(check);
				resolve(found);
			};
			waiters.add(check);
			check();
		});
	await new Promise<void>((resolve) => socket.once("connect", resolve));
	const now = Date.now();
	writeMessage(socket, {
		type: "register",
		session: {
			name: options.name ?? "raw",
			cwd,
			model: "raw",
			pid: process.pid,
			startedAt: now,
			lastActivity: now,
			groups: [home],
			group: home,
		},
		protocol: { min: 1, max: 4 },
		...(options.reachable === undefined ? {} : { reach: { home, reachable: options.reachable } }),
		...(options.supervisor === undefined ? {} : { supervisor: options.supervisor }),
	});
	await next((frame) => frame.type === "registered");
	return { socket, frames, next };
}

function lines(child: ChildProcess): { next(type: string): Promise<Record<string, unknown>> } {
	const records: Array<Record<string, unknown>> = [];
	const waiters = new Set<() => void>();
	let stderr = "";
	child.stderr?.on("data", (chunk) => {
		stderr += String(chunk);
	});
	createInterface({ input: child.stdout! }).on("line", (line) => {
		records.push(JSON.parse(line) as Record<string, unknown>);
		for (const wake of waiters) wake();
	});
	return {
		next: (type) =>
			new Promise((resolve, reject) => {
				const timer = setTimeout(
					() => reject(new Error(`no ${type} record from the peer process: ${stderr}`)),
					30_000,
				);
				const check = () => {
					const found = records.find((record) => record.type === type);
					if (found === undefined) return;
					clearTimeout(timer);
					waiters.delete(check);
					resolve(found);
				};
				waiters.add(check);
				check();
			}),
	};
}

async function stopChild(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise((resolve) => child.once("exit", resolve));
	child.kill("SIGKILL");
	await exited;
}
