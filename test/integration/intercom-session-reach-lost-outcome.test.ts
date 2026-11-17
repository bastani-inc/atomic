/**
 * #5352: a send whose refusal never reached its sender is not delivered later under a widened reach. The real broker
 * runs behind `IntercomWireProxy`, which drops the broker's refusal of one send and closes the sender's connection, as
 * a broker crash would; meanwhile the host widens the sender's reach. The sender is the real Intercom extension and
 * tool, which would otherwise send the same message again after reconnecting and have it delivered.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, test, vi } from "vitest";
import { SessionIntercomPolicy } from "../../packages/coding-agent/src/core/intercom-policy.js";
import { getBrokerSocketPath } from "../../packages/intercom/broker/paths.js";
import type { Message } from "../../packages/intercom/types.js";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";
import { IntercomWireProxy, type WireFrame } from "../helpers/intercom-wire-proxy.js";
import { removeTestDirectory } from "../helpers/test-directory-removal.js";

vi.mock("../../packages/intercom/broker/spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../packages/intercom/broker/spawn.js")>()),
	spawnBrokerIfNeeded: async () => {},
}));

const repoRoot = resolve(import.meta.dirname, "../..");
const extensionDir = join(repoRoot, "packages/intercom");
const brokerAgentDir = mkdtempSync(join(tmpdir(), "irl-b-"));
const frontAgentDir = mkdtempSync(join(tmpdir(), "irl-f-"));
const brokerSocketPath = getBrokerSocketPath(process.platform, brokerAgentDir);
const frontSocketPath = getBrokerSocketPath(process.platform, frontAgentDir);
const originalAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
const originalLegacyAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.ATOMIC_CODING_AGENT_DIR = frontAgentDir;
delete process.env.PI_CODING_AGENT_DIR;
mkdirSync(join(frontAgentDir, "intercom"), { recursive: true });

// The client resolves its socket path on load, so everything that reaches it is imported after the override.
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
const { getJitiCliPath } = await vi.importActual<typeof import("../../packages/intercom/broker/spawn.js")>(
	"../../packages/intercom/broker/spawn.js",
);
const { default: intercomHeavy } = await import("../../packages/intercom/index-heavy.js");

/** Structural: a real broker started through jiti and a real extension that reconnects through the proxy. */
const REAL_BROKER_TEST_TIMEOUT_MS = 90_000;
const BROKER_STARTUP_TIMEOUT_MS = 60_000;
const SETTLE_MS = 500;
const HOME = "doc-a-lost-outcome";
const OTHER = "doc-b-lost-outcome";

const brokerFixture = new IntercomBrokerFixture(brokerAgentDir);
const proxy = new IntercomWireProxy(frontSocketPath, brokerSocketPath);
const policy = SessionIntercomPolicy.fromOptions({ group: HOME });

type Handler = (event: object, ctx: object) => unknown;
interface ToolResult {
	readonly isError: boolean;
	readonly content: ReadonlyArray<{ readonly text: string }>;
	readonly details?: Record<string, unknown>;
}
interface Tool {
	readonly name: string;
	execute(
		id: string,
		params: object,
		signal: AbortSignal | undefined,
		update: undefined,
		ctx: object,
	): Promise<ToolResult>;
}

const handlers = new Map<string, Handler[]>();
const tools = new Map<string, Tool>();
const entries: Array<{ type: "custom"; customType: string; data?: object }> = [];
const pi = {
	on(eventName: string, handler: Handler) {
		handlers.set(eventName, [...(handlers.get(eventName) ?? []), handler]);
	},
	registerTool(tool: Tool) {
		tools.set(tool.name, tool);
	},
	registerCommand() {},
	registerShortcut() {},
	registerMessageRenderer() {},
	async appendEntry(customType: string, data?: object) {
		entries.push({ type: "custom", customType, data });
	},
	async sendMessage() {},
	async sendMessages() {},
	getSessionName: () => "lost-outcome-sender",
	setSessionName() {},
	getActiveTools: () => [],
	setActiveTools() {},
	events: { on: () => () => {}, emit() {} },
};
const context = {
	hasUI: false,
	cwd: repoRoot,
	isIdle: () => true,
	model: { id: "test-model" },
	intercomPolicy: policy,
	sessionManager: {
		getSessionId: () => "lost-outcome-session",
		getEntries: () => entries,
		getBranch: () => entries,
	},
	ui: { confirm: async () => true, notify() {} },
};

beforeAll(async () => {
	brokerFixture.trackBroker(
		spawn(process.execPath, [getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")], {
			env: { ...process.env, ATOMIC_CODING_AGENT_DIR: brokerAgentDir, PI_CODING_AGENT_DIR: undefined },
			stdio: "ignore",
		}),
	);
	await brokerFixture.holdSession(brokerSocketPath, BROKER_STARTUP_TIMEOUT_MS);
	await proxy.listen();
	intercomHeavy(pi as never);
	for (const handler of handlers.get("session_start") ?? []) {
		await handler({ type: "session_start", reason: "startup" }, context);
	}
}, REAL_BROKER_TEST_TIMEOUT_MS);

afterAll(async () => {
	try {
		for (const handler of handlers.get("session_shutdown") ?? []) {
			await Promise.resolve(handler({ type: "session_shutdown", reason: "quit" }, context)).catch(() => {});
		}
		await proxy.close();
		await brokerFixture.cleanup();
	} finally {
		if (originalAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
		else process.env.ATOMIC_CODING_AGENT_DIR = originalAgentDir;
		if (originalLegacyAgentDir !== undefined) process.env.PI_CODING_AGENT_DIR = originalLegacyAgentDir;
		removeTestDirectory(frontAgentDir, { retries: 20, retryDelayMs: 50 });
	}
});

function run(params: object): Promise<ToolResult> {
	const tool = tools.get("intercom");
	assert.ok(tool, "the intercom tool is registered");
	return tool.execute("lost-outcome", params, undefined, undefined, context);
}

const isRegistration = (first: WireFrame) => first.type === "register" || first.type === "register_verified";

test(
	"a send whose refusal was lost is not delivered after the reach widens and the session reconnects (#5352)",
	async () => {
		const recipient = new IntercomClient("lost-outcome-recipient", { brokerSocketPath });
		recipient.on("error", () => {});
		const received: Message[] = [];
		recipient.on("message", (_from: object, message: Message) => received.push(message));
		const now = Date.now();
		await recipient.connect({
			name: "lost-outcome-recipient",
			model: "test-model",
			cwd: repoRoot,
			pid: process.pid,
			startedAt: now,
			lastActivity: now,
			group: OTHER,
			groups: [OTHER],
		});
		try {
			const status = await run({ action: "status" });
			assert.equal(status.isError, false, status.content[0]?.text);

			// The broker refuses the send; its refusal is lost with the connection, and the host widens the reach.
			let armed = true;
			proxy.transformBrokerFrames((frame) => {
				if (!armed || frame.type !== "delivery_failed") return frame;
				armed = false;
				void policy.setReachable([OTHER]);
				setImmediate(() => proxy.disconnect(isRegistration));
				return undefined;
			});
			const result = await run({ action: "send", to: recipient.sessionId!, message: "written while out of reach" });
			proxy.transformBrokerFrames(undefined);

			assert.equal(armed, false, "the broker refused the send");
			assert.equal(result.isError, true, result.content[0]?.text);
			assert.match(result.content[0]?.text ?? "", /reach changed while this message's outcome was unknown/);
			await new Promise((resolveDelay) => setTimeout(resolveDelay, SETTLE_MS));
			assert.equal(received.length, 0, "the refused message was never delivered");
			assert.equal(
				proxy.toBroker.filter(({ frame }) => frame.type === "send").length,
				1,
				"the message went to the broker once",
			);

			const after = await run({ action: "send", to: recipient.sessionId!, message: "written in reach" });
			assert.equal(after.isError, false, after.content[0]?.text);
			await vi.waitFor(() =>
				assert.deepEqual(
					received.map((message) => message.content.text),
					["written in reach"],
				),
			);
		} finally {
			await recipient.disconnect();
		}
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);
