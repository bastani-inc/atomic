import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";
import { getBrokerSocketPath } from "../../packages/intercom/broker/paths.js";
import { getJitiCliPath } from "../../packages/intercom/broker/spawn.js";
import { registerIntercomTool } from "../../packages/intercom/intercom-tool.js";
import { createReachPolicy, type IntercomReachPolicy } from "../../packages/intercom/reach-policy.js";
import { routeIncomingReply } from "../../packages/intercom/reply-routing.js";
import { ReplyTracker } from "../../packages/intercom/reply-tracker.js";
import { ReplyWaiterRegistry } from "../../packages/intercom/reply-waiter.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";

/**
 * Atomic 0.10.0 removed workflows. The intercom tool answers a send, ask or reply to a workflow stage target
 * (`workflow:<rootRunId>/...`) exactly as it answers one to a name no session has, against a real broker, and never
 * sends it on.
 */

const repoRoot = resolve(import.meta.dirname, "../..");
const extensionDir = join(repoRoot, "packages/intercom");
const agentDir = mkdtempSync(join(tmpdir(), "intercom-workflow-target-"));
const socketPath = getBrokerSocketPath(process.platform, agentDir);
const originalAtomicAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
const originalPiAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
delete process.env.PI_CODING_AGENT_DIR;
mkdirSync(join(agentDir, "intercom"), { recursive: true });
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");

type Client = InstanceType<typeof IntercomClient>;
type ToolResult = {
	content: Array<{ type: string; text: string }>;
	isError: boolean;
	details?: Record<string, unknown>;
};
type Tool = {
	execute(
		id: string,
		params: { action: string; to?: string; message?: string; replyTo?: string },
		signal: AbortSignal | undefined,
		update: undefined,
		ctx: object,
	): Promise<ToolResult>;
};

const WORKFLOW_TARGET = "workflow:3f0c9a52-1d4e-4b7a-9c2f-5e8d7a6b4c31/reviewer";
const UNKNOWN_NAME = "no-session-has-this-name";
const context = { sessionManager: { getSessionId: () => "host-session" }, hasUI: false };
const clients: Client[] = [];
let broker: ChildProcess | undefined;

async function waitForBroker(): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const connected = await new Promise<boolean>((settle) => {
			const probe = net.createConnection(socketPath);
			probe.once("connect", () => {
				probe.destroy();
				settle(true);
			});
			probe.once("error", () => settle(false));
		});
		if (connected) return;
		await new Promise((settle) => setTimeout(settle, 20));
	}
	throw new Error("Broker socket did not become ready");
}

async function connectClient(name: string, reach?: IntercomReachPolicy): Promise<Client> {
	const client = new IntercomClient(undefined, reach === undefined ? {} : { reach: () => reach });
	client.on("error", () => {});
	clients.push(client);
	await client.connect({ cwd: repoRoot, model: "test", pid: process.pid, startedAt: 1, lastActivity: 1, name });
	return client;
}

function registerTool(client: Client, tracker: ReplyTracker, reach?: IntercomReachPolicy): Tool {
	let tool: Tool | undefined;
	const waiters = new ReplyWaiterRegistry();
	client.on("message", (from: SessionInfo, message: Message) => {
		routeIncomingReply(waiters.pending(), from, message);
	});
	registerIntercomTool(
		{
			registerTool(value: Tool) {
				tool = value;
			},
			async appendEntry() {},
		} as never,
		{
			ensureConnected: async () => client,
			syncPresenceIdentity() {},
			homeGroup: () => "default",
			setJoinedGroups() {},
			clearJoinedGroups() {},
			confirmSend: false,
			beginReplyWait: (from: string, replyTo: string, signal?: AbortSignal) => waiters.begin(from, replyTo, signal),
			replyTracker: tracker,
			...(reach === undefined ? {} : { reachPolicy: () => reach }),
		} as never,
	);
	assert.ok(tool);
	return tool;
}

/** The result with the target written as `<target>` and each message id as `<id>`, which differ between two calls. */
function normalized(result: ToolResult, target: string): unknown {
	const text = JSON.stringify(result)
		.split(JSON.stringify(target).slice(1, -1))
		.join("<target>")
		.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>");
	return JSON.parse(text);
}

beforeAll(async () => {
	broker = spawn(process.execPath, [getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")], {
		env: { ...process.env, ATOMIC_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: undefined },
		stdio: "ignore",
	});
	await waitForBroker();
});

afterAll(async () => {
	for (const client of clients.splice(0)) await client.disconnect().catch(() => undefined);
	const running = broker;
	if (running !== undefined && running.exitCode === null) {
		await new Promise<void>((settle) => {
			running.once("exit", () => settle());
			running.kill("SIGTERM");
		});
	}
	if (originalAtomicAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = originalAtomicAgentDir;
	if (originalPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalPiAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

describe.each([
	{ sender: "without a reach policy", reach: undefined },
	{ sender: "with a reach policy", reach: createReachPolicy("default", []) },
])("a workflow stage target, from a session $sender, is answered as an unknown name", ({ reach }) => {
	test.each(["send", "ask"])("%s", async (action) => {
		const client = await connectClient(`${action}-sender-${reach === undefined ? "open" : "reach"}`, reach);
		const tool = registerTool(client, new ReplyTracker(), reach);
		const call = (to: string) =>
			tool.execute(action, { action, to, message: "which file?" }, undefined, undefined, context);
		const viaPath = await call(WORKFLOW_TARGET);
		const unknownName = await call(UNKNOWN_NAME);
		assert.match(viaPath.content[0]?.text ?? "", /Session not found/);
		assert.equal(viaPath.isError, true);
		assert.deepEqual(normalized(viaPath, WORKFLOW_TARGET), normalized(unknownName, UNKNOWN_NAME));
	});

	test("reply, with an ask waiting for an answer", async () => {
		const suffix = reach === undefined ? "open" : "reach";
		const replier = await connectClient(`replier-${suffix}`, reach);
		const asker = await connectClient(`asker-${suffix}`);
		const tracker = new ReplyTracker();
		const incoming: Message[] = [];
		replier.on("message", (from: SessionInfo, message: Message) => {
			tracker.queueTurnContext(tracker.recordIncomingMessage(from, message));
			incoming.push(message);
		});
		const tool = registerTool(replier, tracker, reach);
		const ask = await asker.send(replier.sessionId!, { text: "which file?", expectsReply: true });
		assert.equal(ask.delivered, true, ask.reason);
		const deadline = Date.now() + 5_000;
		while (!incoming.some((message) => message.id === ask.id)) {
			assert.ok(Date.now() < deadline, "the ask arrives");
			await new Promise((settle) => setTimeout(settle, 10));
		}
		const call = (to: string) =>
			tool.execute("reply", { action: "reply", to, message: "src/app.ts" }, undefined, undefined, context);
		const viaPath = await call(WORKFLOW_TARGET);
		const unknownName = await call(UNKNOWN_NAME);
		assert.equal(viaPath.isError, true);
		assert.deepEqual(normalized(viaPath, WORKFLOW_TARGET), normalized(unknownName, UNKNOWN_NAME));
	});
});
