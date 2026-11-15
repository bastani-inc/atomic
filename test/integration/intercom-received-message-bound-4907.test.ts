/**
 * #4907: a received Intercom message is bounded in the recipient's context. The send limits (#4896) stop new senders,
 * but an older broker relays whatever an older client sent. The real broker runs behind `IntercomWireProxy`, which
 * stands in for that older broker by enlarging one delivered message in transit; the recipient is the real Intercom
 * extension.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_MAX_BYTES } from "@bastani/atomic";
import { afterAll, beforeAll, test, vi } from "vitest";
import { getBrokerSocketPath } from "../../packages/intercom/broker/paths.js";
import { formatAttachments } from "../../packages/intercom/intercom-utils.js";
import type { Attachment, Message } from "../../packages/intercom/types.js";
import { IntercomWireProxy, type WireFrame } from "../helpers/intercom-wire-proxy.js";

vi.mock("../../packages/intercom/broker/spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../packages/intercom/broker/spawn.js")>()),
	spawnBrokerIfNeeded: async () => {},
}));

const repoRoot = resolve(import.meta.dirname, "../..");
const extensionDir = join(repoRoot, "packages/intercom");
const brokerAgentDir = mkdtempSync(join(tmpdir(), "irm-b-"));
const frontAgentDir = mkdtempSync(join(tmpdir(), "irm-f-"));
const sessionDir = mkdtempSync(join(tmpdir(), "irm-s-"));
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
const { INTERCOM_RECOVERY_PEERS_EVENT } = await import("../../packages/intercom/session-recovery.js");
const { INTERCOM_INBOX_ENTRY, INTERCOM_INBOX_REPLAY_EVENT } = await import("../../packages/intercom/durable-inbox.js");

/** A real broker started through jiti, a recipient extension, and a 16 MiB frame relayed and spilled. */
const REAL_BROKER_TEST_TIMEOUT_MS = 90_000;
const BROKER_STARTUP_TIMEOUT_MS = 60_000;
const WAIT = { timeout: 30_000, interval: 20 };
const MIB = 1024 * 1024;
const RECIPIENT = "bounded-recipient";

let broker: ChildProcess | undefined;
const proxy = new IntercomWireProxy(frontSocketPath, brokerSocketPath);

type Handler = (event: object, ctx: object) => unknown;
type EventHandler = (payload: object) => void;
interface ShownMessage {
	readonly content: string;
	readonly details: { readonly message: Message; readonly bodyText: string };
}

const handlers = new Map<string, Handler[]>();
const eventHandlers = new Map<string, EventHandler[]>();
const entries: Array<{ type: "custom"; customType: string; data?: object }> = [];
const shown: ShownMessage[] = [];
const events = {
	on(eventName: string, handler: EventHandler) {
		eventHandlers.set(eventName, [...(eventHandlers.get(eventName) ?? []), handler]);
		return () => {};
	},
	emit(eventName: string, payload: object) {
		for (const handler of eventHandlers.get(eventName) ?? []) handler(payload);
	},
};
const pi = {
	on(eventName: string, handler: Handler) {
		handlers.set(eventName, [...(handlers.get(eventName) ?? []), handler]);
	},
	registerTool() {},
	registerCommand() {},
	registerShortcut() {},
	registerMessageRenderer() {},
	async appendEntry(customType: string, data?: object) {
		entries.push({ type: "custom", customType, data });
	},
	async sendMessage(message: ShownMessage) {
		shown.push(message);
	},
	async sendMessages(messages: ShownMessage[]) {
		shown.push(...messages);
	},
	getSessionName: () => RECIPIENT,
	setSessionName() {},
	getActiveTools: () => [],
	setActiveTools() {},
	events,
};
const context = {
	hasUI: false,
	cwd: repoRoot,
	isIdle: () => true,
	model: { id: "test-model" },
	sessionManager: {
		getSessionId: () => "bounded-recipient-session",
		getSessionDir: () => sessionDir,
		getEntries: () => entries,
		getBranch: () => entries,
	},
	ui: { confirm: async () => true, notify() {} },
};

async function waitForSocket(socketPath: string): Promise<void> {
	await vi.waitFor(
		() =>
			new Promise<void>((resolveProbe, rejectProbe) => {
				const probe = net.createConnection(socketPath);
				probe.once("connect", () => {
					probe.destroy();
					resolveProbe();
				});
				probe.once("error", rejectProbe);
			}),
		{ timeout: BROKER_STARTUP_TIMEOUT_MS, interval: 50 },
	);
}

beforeAll(async () => {
	broker = spawn(process.execPath, [getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")], {
		env: { ...process.env, ATOMIC_CODING_AGENT_DIR: brokerAgentDir, PI_CODING_AGENT_DIR: undefined },
		stdio: "ignore",
	});
	await waitForSocket(brokerSocketPath);
	await proxy.listen();
	intercomHeavy(pi as never);
	for (const handler of handlers.get("session_start") ?? []) {
		await handler({ type: "session_start", reason: "startup" }, context);
	}
	const connected: { completion?: Promise<object[]> } = {};
	events.emit(INTERCOM_RECOVERY_PEERS_EVENT, connected);
	await connected.completion;
}, REAL_BROKER_TEST_TIMEOUT_MS);

afterAll(async () => {
	for (const handler of handlers.get("session_shutdown") ?? []) {
		await Promise.resolve(handler({ type: "session_shutdown", reason: "quit" }, context)).catch(() => {});
	}
	await proxy.close();
	if (broker?.exitCode === null) {
		const stopped = new Promise<void>((resolveExit) => broker?.once("exit", () => resolveExit()));
		broker.kill("SIGTERM");
		await stopped;
	}
	if (originalAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = originalAgentDir;
	if (originalLegacyAgentDir !== undefined) process.env.PI_CODING_AGENT_DIR = originalLegacyAgentDir;
	for (const dir of [brokerAgentDir, frontAgentDir, sessionDir]) {
		rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
	}
});

async function sender(name: string) {
	const client = new IntercomClient(`${name}-home`);
	client.on("error", () => {});
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
	return client;
}

async function shownCard(messageId: string): Promise<ShownMessage> {
	return await vi.waitFor(() => {
		const card = shown.find((message) => message.details.message.id === messageId);
		assert.ok(card, `${messageId} was not shown`);
		return card;
	}, WAIT);
}

test(
	"a 16 MiB message from an older sender reaches the recipient's context as a bounded card with its full text spilled to a file (#4907)",
	async () => {
		const hugeText = `first line of a huge report\n${"r".repeat(12 * MIB)}`;
		const hugeAttachment: Attachment = { type: "file", name: "huge.log", content: "a".repeat(4 * MIB) };
		// An older broker relays what an older client sent, unlimited; the current broker would refuse it.
		proxy.transformBrokerFrames((frame: WireFrame) => {
			const message = frame.message;
			if (frame.type !== "message" || typeof message !== "object" || message === null || Array.isArray(message)) {
				return frame;
			}
			if (message.id !== "huge-4907") return frame;
			const { type, name, content } = hugeAttachment;
			return {
				...frame,
				message: { ...message, content: { text: hugeText, attachments: [{ type, name, content }] } },
			};
		});
		const client = await sender("older-sender");
		try {
			const result = await client.send(RECIPIENT, { messageId: "huge-4907", text: "placeholder" });
			assert.equal(result.delivered, true, result.reason ?? "");
			const card = await shownCard("huge-4907");

			assert.ok(
				Buffer.byteLength(card.content) <= DEFAULT_MAX_BYTES,
				`card is ${Buffer.byteLength(card.content)} bytes`,
			);
			assert.ok(JSON.stringify(card.details).length <= 2 * DEFAULT_MAX_BYTES, "the saved card details are bounded");
			assert.match(card.content, /^\*\*📨 From older-sender\*\*/);
			assert.match(card.content, /first line of a huge report/);
			const spillPath = /saved to: (.+)$/m.exec(card.content)?.[1];
			assert.ok(spillPath, card.content.slice(0, 2_000));
			assert.equal(readFileSync(spillPath, "utf8"), `${hugeText}${formatAttachments([hugeAttachment])}`);

			const inbox = entries.find(
				(entry) => entry.customType === "intercom_inbox" && JSON.stringify(entry.data).includes("huge-4907"),
			);
			assert.ok(inbox, "the message is saved to the durable inbox");
			assert.ok(
				JSON.stringify(inbox.data).length <= 2 * DEFAULT_MAX_BYTES,
				"the durable inbox saves the bounded card",
			);
		} finally {
			proxy.transformBrokerFrames(undefined);
			await client.disconnect();
		}
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a message within the limit reaches the recipient's context unchanged (#4907)",
	async () => {
		const client = await sender("current-sender");
		try {
			const attachment: Attachment = { type: "snippet", name: "note.ts", language: "ts", content: "export {};" };
			const result = await client.send(RECIPIENT, {
				messageId: "small-4907",
				text: "hello",
				attachments: [attachment],
			});
			assert.equal(result.delivered, true, result.reason ?? "");
			const card = await shownCard("small-4907");
			assert.equal(card.details.bodyText, `hello${formatAttachments([attachment])}`);
			assert.deepEqual(card.details.message.content, { text: "hello", attachments: [attachment] });
		} finally {
			await client.disconnect();
		}
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"resume shows a message an earlier version saved whole as a bounded card with its full text spilled to a file (#4907)",
	async () => {
		const savedText = `saved whole by an earlier version\n${"s".repeat(2 * MIB)}`;
		entries.push({
			type: "custom",
			customType: INTERCOM_INBOX_ENTRY,
			data: {
				message: { id: "saved-whole-4907", timestamp: Date.now(), content: { text: savedText } },
				from: {
					id: "departed-session",
					name: "departed-sender",
					cwd: repoRoot,
					model: "test-model",
					pid: 1,
					startedAt: 1,
					lastActivity: 1,
				},
				receivedAt: Date.now(),
			},
		});
		const request: { peers: object[]; restored: object[]; completion?: Promise<readonly string[]> } = {
			peers: [],
			restored: [],
		};
		events.emit(INTERCOM_INBOX_REPLAY_EVENT, request);
		await request.completion;
		const card = await shownCard("saved-whole-4907");
		assert.ok(
			Buffer.byteLength(card.content) <= DEFAULT_MAX_BYTES,
			`card is ${Buffer.byteLength(card.content)} bytes`,
		);
		assert.match(card.content, /saved whole by an earlier version/);
		const spillPath = /saved to: (.+)$/m.exec(card.content)?.[1];
		assert.ok(spillPath, card.content.slice(0, 2_000));
		assert.equal(readFileSync(spillPath, "utf8"), savedText);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);
