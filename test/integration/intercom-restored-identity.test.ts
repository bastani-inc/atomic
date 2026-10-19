import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, test, vi } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";
import { sleep } from "../helpers/runtime.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const brokerFixture = new IntercomBrokerFixture(mkdtempSync(join(tmpdir(), "intercom-identity-")));
brokerFixture.overrideAgentDir();
// Intercom's broker paths are snapshotted at import time, so import after the agent dir override.
const { getBrokerSocketPath } = await import("../../packages/intercom/broker/paths.js");
const { getJitiCliPath } = await import("../../packages/intercom/broker/spawn.js");
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
const { default: intercomLightweight } = await import("../../packages/intercom/index.js");

type Client = InstanceType<typeof IntercomClient>;

/** Spawning the broker child is the structural cost of this real-broker suite. */
const REAL_BROKER_TEST_TIMEOUT_MS = 60_000;
const SETTLE_MS = 300;
const SUPERVISOR_AUTHORIZATION_EVENT = "subagent:supervisor-authorization";

type Handler = (event: object, ctx: object) => unknown;
type EventHandler = (payload: object) => void;

interface ToolResult {
	content: Array<{ type: string; text: string }>;
	details: { delivered?: boolean; error?: boolean; reply?: unknown };
	isError?: boolean;
}

interface CapturedTool {
	name: string;
	execute: (id: string, params: object, signal: undefined, onUpdate: undefined, ctx: object) => Promise<ToolResult>;
}

interface ChildIdentity {
	orchestratorTarget: string;
	runId: string;
	agent: string;
	index: number;
	sessionName: string;
	supervisor: { capability: string; supervisorSessionId: string };
}

const text = (result: ToolResult): string => result.content.map((part) => part.text).join("\n");

/**
 * The real Intercom extension in one session process. Restarting the process is a new
 * extension instance over the same session store, which is how a resume reopens a session.
 */
function intercomSession(name: string, sessionManager: SessionManager, childIdentity?: ChildIdentity) {
	const handlers = new Map<string, Handler[]>();
	const eventHandlers = new Map<string, EventHandler[]>();
	const tools = new Map<string, CapturedTool>();
	const received: string[] = [];
	let activeTools: string[] = [];
	let sessionName = name;
	const context = {
		hasUI: false,
		cwd: repoRoot,
		isIdle: () => true,
		model: { id: "test-model" },
		sessionManager,
		...(childIdentity
			? {
					subagentPolicy: {
						managementActions: "restricted",
						fanoutAuthorized: false,
						inheritProjectContext: false,
						inheritSkills: false,
						depth: 1,
						intercom: childIdentity,
					},
				}
			: {}),
		ui: { confirm: async () => true, notify() {} },
	};
	const pi = {
		on(eventName: string, handler: Handler) {
			handlers.set(eventName, [...(handlers.get(eventName) ?? []), handler]);
		},
		registerTool(tool: CapturedTool) {
			tools.set(tool.name, tool);
		},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		async appendEntry(customType: string, data?: unknown) {
			await sessionManager.appendCustomEntry(customType, data);
		},
		async sendMessage(message: { customType?: string; details?: { message?: { content?: { text?: string } } } }) {
			if (message.customType === "intercom_message") received.push(message.details?.message?.content?.text ?? "");
		},
		async sendMessages() {},
		getSessionName: () => sessionName,
		async setSessionName(next: string) {
			sessionName = next;
		},
		getActiveTools: () => activeTools,
		setActiveTools(next: string[]) {
			activeTools = next;
		},
		events: {
			on(eventName: string, handler: EventHandler) {
				eventHandlers.set(eventName, [...(eventHandlers.get(eventName) ?? []), handler]);
				return () => {};
			},
			emit(eventName: string, payload: object) {
				for (const handler of eventHandlers.get(eventName) ?? []) handler(payload);
			},
		},
	};
	intercomLightweight(pi as never);
	const fire = async (eventName: string, event: object): Promise<void> => {
		for (const handler of handlers.get(eventName) ?? []) await handler(event, context);
	};
	const tool = (params: object): Promise<ToolResult> => {
		const intercom = tools.get("intercom");
		assert.ok(intercom, "the intercom tool must be registered");
		return intercom.execute("call", params, undefined, undefined, context);
	};
	return {
		received,
		tool,
		async start(reason: "startup" | "resume"): Promise<void> {
			await fire("session_start", { type: "session_start", reason });
			if (reason === "resume") await fire("session_recovery_restore", { type: "session_recovery_restore", reason });
		},
		/** The Intercom session id this process is registered under (connecting first, like any tool call). */
		async intercomId(): Promise<string> {
			const status = await tool({ action: "status" });
			const id = text(status).match(/Session ID: ([^\n]+)/)?.[1];
			assert.ok(id, text(status));
			return id;
		},
		async authorize(childName: string): Promise<{ capability: string; supervisorSessionId: string }> {
			const request: {
				childName: string;
				completion?: Promise<{ capability: string; supervisorSessionId: string }>;
			} = { childName };
			pi.events.emit(SUPERVISOR_AUTHORIZATION_EVENT, request);
			assert.ok(request.completion, "Intercom must answer the supervisor authorization request");
			return request.completion;
		},
		shutdown: () => fire("session_shutdown", { type: "session_shutdown", reason: "quit" }),
	};
}

/** A plain Intercom peer with no session runtime of its own. */
async function peer(name: string, returnAddress: string, group = "default"): Promise<Client> {
	const client = new IntercomClient(returnAddress);
	await client.connect({
		name,
		model: "test-model",
		cwd: repoRoot,
		pid: process.pid,
		status: "idle",
		startedAt: Date.now(),
		lastActivity: Date.now(),
		group,
		groups: [group],
	});
	brokerFixture.onCleanup(() => client.disconnect().catch(() => undefined));
	return client;
}

/** A raw client asking the broker for a preferred id, as a restored session's runtime does. */
async function claimant(name: string, returnAddress: string, preferredSessionId: string): Promise<Client> {
	const client = new IntercomClient(returnAddress, { preferredSessionId });
	await client.connect({
		name,
		model: "test-model",
		cwd: repoRoot,
		pid: process.pid,
		status: "idle",
		startedAt: Date.now(),
		lastActivity: Date.now(),
		group: "default",
		groups: ["default"],
	});
	brokerFixture.onCleanup(() => client.disconnect().catch(() => undefined));
	return client;
}

async function waitUntilListed(observer: Client, name: string, listed: boolean): Promise<void> {
	await vi.waitFor(
		async () => {
			const names = (await observer.listSessions()).map((session) => session.name);
			assert.equal(names.includes(name), listed, `${name} listed: ${names.join(", ")}`);
		},
		{ timeout: 10_000, interval: 25 },
	);
}

let broker: ChildProcess | undefined;

function spawnBroker(): ChildProcess {
	const extensionDir = join(repoRoot, "packages/intercom");
	broker = spawn(process.execPath, [getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")], {
		env: { ...process.env, ATOMIC_CODING_AGENT_DIR: brokerFixture.agentDir },
		stdio: "ignore",
	});
	return broker;
}

async function waitForBroker(assertRunning: () => void): Promise<void> {
	await vi.waitFor(
		async () => {
			assertRunning();
			const connected = await new Promise<boolean>((resolveConnected) => {
				const socket = net.createConnection(getBrokerSocketPath(process.platform, brokerFixture.agentDir));
				socket.once("connect", () => {
					socket.destroy();
					resolveConnected(true);
				});
				socket.once("error", () => resolveConnected(false));
			});
			assert.ok(connected);
		},
		{ timeout: 10_000, interval: 20 },
	);
}

/** Kill the broker the way a crashed Atomic leaves it, then start a fresh one that remembers nothing. */
async function restartBroker(): Promise<void> {
	const killed = broker;
	assert.ok(killed);
	if (killed.exitCode === null && killed.signalCode === null) {
		const closed = new Promise<void>((resolveClosed) => killed.once("close", () => resolveClosed()));
		killed.kill("SIGKILL");
		await closed;
	}
	brokerFixture.trackBroker(spawnBroker());
	await waitForBroker(() => brokerFixture.assertRunning());
}

beforeAll(async () => {
	brokerFixture.trackBroker(spawnBroker());
	await waitForBroker(() => brokerFixture.assertRunning());
});
afterAll(() => brokerFixture.cleanup());

test(
	"a resumed session is reachable by its pre-restart Intercom id and by its Atomic session id after the broker restarts, exactly once (#3760)",
	async () => {
		const sessionManager = SessionManager.inMemory(repoRoot);
		const beforeRestart = intercomSession("identity-parent", sessionManager);
		await beforeRestart.start("startup");
		const originalId = await beforeRestart.intercomId();
		// The agent persisted that tool result, so the resumed session knows it used Intercom.
		await sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "status-call",
			toolName: "intercom",
			content: [{ type: "text", text: `Session ID: ${originalId}` }],
			isError: false,
			timestamp: Date.now(),
		});
		await beforeRestart.shutdown();
		await restartBroker();

		const sender = await peer("identity-sender", "identity-sender-session");
		const afterRestart = intercomSession("identity-parent", sessionManager);
		await afterRestart.start("resume");
		try {
			await waitUntilListed(sender, "identity-parent", true);
			const byIntercomId = await sender.send(originalId, { text: "TOKEN-PARENT-OLD-INTERCOM-ID" });
			assert.equal(byIntercomId.delivered, true, byIntercomId.reason);
			const byAtomicId = await sender.send(sessionManager.getSessionId(), { text: "TOKEN-PARENT-ATOMIC-ID" });
			assert.equal(byAtomicId.delivered, true, byAtomicId.reason);
			const byName = await sender.send("identity-parent", { text: "TOKEN-PARENT-NAME" });
			assert.equal(byName.delivered, true, byName.reason);

			await sleep(SETTLE_MS);
			assert.deepEqual(afterRestart.received, [
				"TOKEN-PARENT-OLD-INTERCOM-ID",
				"TOKEN-PARENT-ATOMIC-ID",
				"TOKEN-PARENT-NAME",
			]);
			const listed = (await sender.listSessions()).filter((session) => session.name === "identity-parent");
			assert.deepEqual(
				listed.map((session) => session.id),
				[originalId],
				"intercom list shows the resumed session under the id peers saw before the restart",
			);
		} finally {
			await afterRestart.shutdown();
		}
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a restored subagent is reachable by its pre-restart Intercom id and by its Atomic session id, exactly once (#3760)",
	async () => {
		const keepAlive = await peer("identity-keepalive", "identity-keepalive-session");
		const parentManager = SessionManager.inMemory(repoRoot);
		const childManager = SessionManager.inMemory(repoRoot);
		const parentName = "identity-orchestrator";
		const childName = "subagent-worker-identity-1";
		const childIdentity = (supervisor: { capability: string; supervisorSessionId: string }): ChildIdentity => ({
			orchestratorTarget: parentName,
			runId: "identity",
			agent: "worker",
			index: 0,
			sessionName: childName,
			supervisor,
		});

		const parentBefore = intercomSession(parentName, parentManager);
		await parentBefore.start("startup");
		const parentOriginalId = await parentBefore.intercomId();
		const childBefore = intercomSession(
			childName,
			childManager,
			childIdentity(await parentBefore.authorize(childName)),
		);
		await childBefore.start("startup");
		await waitUntilListed(keepAlive, childName, true);
		const childOriginalId = (await keepAlive.listSessions()).find((session) => session.name === childName)?.id;
		assert.ok(childOriginalId);
		await parentManager.appendCustomEntry("subagent-child", { childId: "identity:0", state: "running" });
		await childBefore.shutdown();
		await parentBefore.shutdown();
		await waitUntilListed(keepAlive, childName, false);
		await waitUntilListed(keepAlive, parentName, false);

		const parentAfter = intercomSession(parentName, parentManager);
		await parentAfter.start("resume");
		const childAfter = intercomSession(
			childName,
			childManager,
			childIdentity(await parentAfter.authorize(childName)),
		);
		try {
			await childAfter.start("startup");
			await waitUntilListed(keepAlive, childName, true);
			const byIntercomId = await parentAfter.tool({
				action: "send",
				to: childOriginalId,
				message: "TOKEN-CHILD-OLD-INTERCOM-ID",
			});
			assert.equal(byIntercomId.details.delivered, true, text(byIntercomId));
			const byAtomicId = await parentAfter.tool({
				action: "send",
				to: childManager.getSessionId(),
				message: "TOKEN-CHILD-ATOMIC-ID",
			});
			assert.equal(byAtomicId.details.delivered, true, text(byAtomicId));
			const byName = await parentAfter.tool({ action: "send", to: childName, message: "TOKEN-CHILD-NAME" });
			assert.equal(byName.details.delivered, true, text(byName));

			await sleep(SETTLE_MS);
			assert.deepEqual(childAfter.received, [
				"TOKEN-CHILD-OLD-INTERCOM-ID",
				"TOKEN-CHILD-ATOMIC-ID",
				"TOKEN-CHILD-NAME",
			]);
			const listed = await keepAlive.listSessions();
			assert.equal(listed.find((session) => session.name === parentName)?.id, parentOriginalId);
			assert.equal(listed.find((session) => session.name === childName)?.id, childOriginalId);
		} finally {
			await childAfter.shutdown();
			await parentAfter.shutdown();
		}
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"an ask addressed by a peer's Atomic session id is answered through the resolved peer (#3760)",
	async () => {
		const peerSessionId = "0199a3d0-0000-7000-8000-00000000a5c1";
		const answering = await peer("identity-answering", peerSessionId);
		answering.on("message", (from: { id: string }, message: { id: string; expectsReply?: boolean }) => {
			if (message.expectsReply === true) void answering.send(from.id, { text: "PONG", replyTo: message.id });
		});
		const asker = intercomSession("identity-asker", SessionManager.inMemory(repoRoot));
		await asker.start("startup");
		try {
			const answer = await Promise.race([
				asker.tool({ action: "ask", to: peerSessionId, message: "PING" }),
				sleep(5_000).then(() => undefined),
			]);
			assert.ok(answer, "the ask must receive the reply instead of waiting for the reply timeout");
			assert.equal(answer.isError, false, text(answer));
			assert.match(text(answer), /PONG/);
		} finally {
			await asker.shutdown();
		}
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a preferred Intercom id is never taken from a live session or from another session that held it (#3760)",
	async () => {
		const sender = await peer("identity-guard-sender", "identity-guard-sender-session");
		const holderReturnAddress = "0199a3d0-0000-7000-8000-00000000b0b0";
		const holder = await peer("identity-holder", holderReturnAddress);
		const heldId = holder.sessionId;
		assert.ok(heldId);
		const holderReceived: string[] = [];
		holder.on("message", (_from: object, message: { content: { text: string } }) =>
			holderReceived.push(message.content.text),
		);

		const intruder = await claimant("identity-intruder", "0199a3d0-0000-7000-8000-00000000dead", heldId);
		assert.notEqual(intruder.sessionId, heldId, "a live session keeps its id");
		const intruderReceived: string[] = [];
		intruder.on("message", (_from: object, message: { content: { text: string } }) =>
			intruderReceived.push(message.content.text),
		);
		const toHolder = await sender.send(heldId, { text: "TOKEN-HOLDER" });
		assert.equal(toHolder.delivered, true, toHolder.reason);
		await sleep(SETTLE_MS);
		assert.deepEqual(holderReceived, ["TOKEN-HOLDER"]);
		assert.deepEqual(intruderReceived, []);

		await holder.disconnect();
		await waitUntilListed(sender, "identity-holder", false);
		const thief = await claimant("identity-thief", "0199a3d0-0000-7000-8000-00000000beef", heldId);
		assert.notEqual(thief.sessionId, heldId, "another session cannot take over a departed session's id");
		const holderAgain = await claimant("identity-holder", holderReturnAddress, heldId);
		assert.equal(holderAgain.sessionId, heldId, "the departed session itself gets its id back");

		const hidden = await peer("identity-hidden", "0199a3d0-0000-7000-8000-0000000041dd", "identity-other-group");
		assert.ok(hidden.sessionId);
		const crossGroup = await sender.send("0199a3d0-0000-7000-8000-0000000041dd", { text: "TOKEN-HIDDEN" });
		assert.equal(crossGroup.delivered, false);
		assert.equal(crossGroup.reason, "Session not found", "an Atomic session id never reaches across groups");
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);
