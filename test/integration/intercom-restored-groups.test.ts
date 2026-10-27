import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, test, vi } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const brokerFixture = new IntercomBrokerFixture(mkdtempSync(join(tmpdir(), "intercom-groups-restore-")));
brokerFixture.overrideAgentDir();
// Intercom's broker paths are snapshotted at import time, so import after the agent dir override.
const { getBrokerSocketPath } = await import("../../packages/intercom/broker/paths.js");
const { getJitiCliPath } = await import("../../packages/intercom/broker/spawn.js");
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
const { default: intercomLightweight } = await import("../../packages/intercom/index.js");

type Client = InstanceType<typeof IntercomClient>;

/** Spawning the broker child is the structural cost of this real-broker suite. */
const REAL_BROKER_TEST_TIMEOUT_MS = 60_000;

type Handler = (event: object, ctx: object) => unknown;
type EventHandler = (payload: object) => void;

interface ToolResult {
	content: Array<{ type: string; text: string }>;
	details: { delivered?: boolean; groups?: string[] };
	isError?: boolean;
}

interface CapturedTool {
	name: string;
	execute: (id: string, params: object, signal: undefined, onUpdate: undefined, ctx: object) => Promise<ToolResult>;
}

const text = (result: ToolResult): string => result.content.map((part) => part.text).join("\n");

/**
 * The real Intercom extension in one session process. A restart is a new extension instance
 * over the same session store, which is how Atomic reopens a session after it restarts.
 */
function intercomSession(name: string, sessionManager: SessionManager) {
	const handlers = new Map<string, Handler[]>();
	const eventHandlers = new Map<string, EventHandler[]>();
	const tools = new Map<string, CapturedTool>();
	const context = {
		hasUI: false,
		cwd: repoRoot,
		isIdle: () => true,
		model: { id: "test-model" },
		sessionManager,
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
		async appendEntry(customType: string, data?: object) {
			await sessionManager.appendCustomEntry(customType, data);
		},
		async sendMessage() {},
		async sendMessages() {},
		getSessionName: () => name,
		async setSessionName() {},
		getActiveTools: () => [],
		setActiveTools() {},
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
	return {
		tool(params: object): Promise<ToolResult> {
			const intercom = tools.get("intercom");
			assert.ok(intercom, "the intercom tool must be registered");
			return intercom.execute("call", params, undefined, undefined, context);
		},
		async start(reason: "startup" | "resume"): Promise<void> {
			await fire("session_start", { type: "session_start", reason });
			if (reason === "resume") await fire("session_recovery_restore", { type: "session_recovery_restore", reason });
		},
		shutdown: () => fire("session_shutdown", { type: "session_shutdown", reason: "quit" }),
	};
}

/** A plain Intercom peer, standing in for a relaunched subagent registered in its own group. */
async function peer(name: string, group: string): Promise<{ client: Client; received: string[] }> {
	const client = new IntercomClient(`${name}-session`);
	const received: string[] = [];
	client.on("message", (_from: object, message: { content: { text: string } }) => received.push(message.content.text));
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
	return { client, received };
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

beforeAll(async () => {
	brokerFixture.trackBroker(spawnBroker());
	await waitForBroker(() => brokerFixture.assertRunning());
});
afterAll(() => brokerFixture.cleanup());

test.each(["startup", "resume"] as const)(
	"a session restored on %s rejoins its joined groups, so its first send reaches a session there (#4079)",
	async (reason) => {
		const worker = await peer(`restored-groups-worker-${reason}`, `team-${reason}`);
		const sessionManager = SessionManager.inMemory(repoRoot);
		const before = intercomSession(`restored-groups-supervisor-${reason}`, sessionManager);
		await before.start("startup");
		const joined = await before.tool({ action: "join", group: `team-${reason}` });
		assert.equal(joined.isError, false, text(joined));
		await before.shutdown();

		const after = intercomSession(`restored-groups-supervisor-${reason}`, sessionManager);
		await after.start(reason);
		try {
			const sent = await after.tool({
				action: "send",
				to: `restored-groups-worker-${reason}`,
				message: "TOKEN-RESTORED",
			});
			assert.equal(sent.details.delivered, true, text(sent));
			await vi.waitFor(() => assert.deepEqual(worker.received, ["TOKEN-RESTORED"]), {
				timeout: 5_000,
				interval: 20,
			});
			const status = await after.tool({ action: "status" });
			assert.match(text(status), new RegExp(`team-${reason}`));
		} finally {
			await after.shutdown();
		}
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a group left before the restart is not rejoined, and a send there names the group to join (#4079)",
	async () => {
		await peer("left-group-worker", "team-left");
		const sessionManager = SessionManager.inMemory(repoRoot);
		const before = intercomSession("left-group-supervisor", sessionManager);
		await before.start("startup");
		assert.equal((await before.tool({ action: "join", group: "team-kept" })).isError, false);
		assert.equal((await before.tool({ action: "join", group: "team-left" })).isError, false);
		assert.equal((await before.tool({ action: "leave", group: "team-left" })).isError, false);
		await before.shutdown();

		const after = intercomSession("left-group-supervisor", sessionManager);
		await after.start("resume");
		try {
			const sent = await after.tool({ action: "send", to: "left-group-worker", message: "TOKEN-LEFT" });
			assert.notEqual(sent.details.delivered, true, text(sent));
			assert.match(text(sent), /left-group-worker is live in group team-left; join it to send/);
			const status = await after.tool({ action: "status" });
			assert.match(text(status), /team-kept/);
			assert.doesNotMatch(text(status), /team-left/);
		} finally {
			await after.shutdown();
		}
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a send to a session only in a group the sender cannot peek at stays Session not found (#4079)",
	async () => {
		const runId = "40790000-0000-4000-8000-000000000001";
		const invocationGroup = `workflow:${runId}`;
		const owner = await peer("hidden-invocation-owner", invocationGroup);
		owner.client.registerPendingStageRoute(runId, invocationGroup, "hidden-invocation-capability", [
			{
				stageId: "stage-a",
				stageName: "orchestrator",
				target: `workflow:${runId}/stage-a`,
				lifecycle: "pending",
				routeEligible: true,
				group: invocationGroup,
			},
		]);
		await peer("hidden-invocation-member", invocationGroup);
		await owner.client.listSessions();

		const outsider = intercomSession("hidden-invocation-outsider", SessionManager.inMemory(repoRoot));
		await outsider.start("startup");
		try {
			const peek = await outsider.tool({ action: "list", group: invocationGroup });
			assert.doesNotMatch(text(peek), /hidden-invocation-member/);
			const sent = await outsider.tool({ action: "send", to: "hidden-invocation-member", message: "TOKEN-HIDDEN" });
			assert.notEqual(sent.details.delivered, true, text(sent));
			assert.match(text(sent), /Session not found/);
			assert.doesNotMatch(text(sent), /workflow:|is live in group/);

			const missing = await outsider.tool({ action: "send", to: "nobody-by-this-name", message: "TOKEN-MISSING" });
			assert.match(text(missing), /Session not found/);
			assert.doesNotMatch(text(missing), /is live in group/);

			// A peekable workflow group without a roster: joining it would hand a host control of that run, so no hint.
			await peer("open-invocation-member", "workflow:40790000-0000-4000-8000-000000000002");
			const openInvocation = await outsider.tool({
				action: "send",
				to: "open-invocation-member",
				message: "TOKEN-OPEN-INVOCATION",
			});
			assert.match(text(openInvocation), /Session not found/);
			assert.doesNotMatch(text(openInvocation), /is live in group/);
		} finally {
			await outsider.shutdown();
		}
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);
