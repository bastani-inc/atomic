import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import intercomHeavy from "../../packages/intercom/index-heavy.js";
import { TwoBrokerHarness } from "../helpers/intercom-two-broker-harness.js";
import { replaceEnvironmentVariable } from "../helpers/temporary-agent-dir.js";

/**
 * #4842: with multi-node routing, an asker on one broker learns that its recipient on the other broker ended, as a
 * failed-ask message, exactly as it does when both sessions share a broker.
 */

/** Spawning two real broker processes is the structural cost of this suite. */
const REAL_BROKERS_HOOK_TIMEOUT_MS = 60_000;
const REAL_BROKERS_TEST_TIMEOUT_MS = 60_000;
const WAIT = { timeout: 15_000, interval: 25 };
/** How long a failure that must not arrive, or must not arrive twice, is given to show up. */
const SETTLE_MS = 1_500;

interface ToolResult {
	content: Array<{ type: string; text: string }>;
	details: Record<string, unknown>;
	isError: boolean;
}
type Entry = Record<string, unknown> & { type: string };
type LifecycleHandler = (event: Record<string, unknown>, ctx: object) => void | Promise<void>;
type EventHandler = (payload: object) => void | Promise<void>;
type Execute = (
	toolCallId: string,
	params: Record<string, unknown>,
	signal: AbortSignal | undefined,
	onUpdate: undefined,
	ctx: object,
) => Promise<ToolResult>;

let harness: TwoBrokerHarness;
let restoreAgentDir: (() => void) | undefined;
const cleanups: Array<() => void | Promise<void>> = [];

beforeAll(async () => {
	harness = await TwoBrokerHarness.start();
	// The asker's Atomic session runs on node a: its Intercom runtime connects to that node's broker.
	restoreAgentDir = replaceEnvironmentVariable("ATOMIC_CODING_AGENT_DIR", harness.agentDir("a"));
}, REAL_BROKERS_HOOK_TIMEOUT_MS);
afterAll(async () => {
	restoreAgentDir?.();
	await harness?.cleanup();
}, REAL_BROKERS_HOOK_TIMEOUT_MS);
beforeEach(() => harness.ensureBrokersRunning(), REAL_BROKERS_HOOK_TIMEOUT_MS);
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const unique = (label: string): string => `${label}-${randomUUID().slice(0, 8)}`;

/** With multi-node routing an Atomic session joins its project's group; outside Git, its working directory names it. */
const projectGroup = (): string => `project:${basename(harness.root)}`;

/** One saved Atomic session running Intercom on node a, with a session branch that survives a restart. */
function atomicSession(options: { readonly name: string; readonly sessionId?: string; readonly entries?: Entry[] }) {
	const sessionId = options.sessionId ?? randomUUID();
	const entries: Entry[] = options.entries ?? [];
	const lifecycle = new Map<string, LifecycleHandler[]>();
	const events = new Map<string, EventHandler[]>();
	const tools = new Map<string, { execute: Execute }>();
	const shown: string[] = [];
	const record = (entry: Entry) => entries.push({ id: randomUUID(), timestamp: new Date().toISOString(), ...entry });
	const context = {
		hasUI: true,
		cwd: harness.root,
		isIdle: () => true,
		model: { id: "test-model" },
		sessionManager: { getSessionId: () => sessionId, getBranch: () => entries, getEntries: () => entries },
		ui: { confirm: async () => true, notify() {} },
	};
	const deliver = (message: { customType?: string; content?: string; details?: unknown }) => {
		shown.push(message.content ?? "");
		record({
			type: "custom_message",
			customType: message.customType,
			content: message.content,
			details: message.details,
			display: true,
		});
	};
	const pi = {
		on(name: string, handler: LifecycleHandler) {
			lifecycle.set(name, [...(lifecycle.get(name) ?? []), handler]);
		},
		registerTool(tool: { name: string; execute: Execute }) {
			tools.set(tool.name, tool);
		},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		async appendEntry(customType: string, data: unknown) {
			record({ type: "custom", customType, data });
		},
		async sendMessage(message: { customType?: string; content?: string; details?: unknown }) {
			deliver(message);
		},
		async sendMessages(messages: Array<{ customType?: string; content?: string; details?: unknown }>) {
			for (const message of messages) deliver(message);
		},
		getSessionName: () => options.name,
		setSessionName() {},
		getActiveTools: () => [],
		setActiveTools() {},
		events: {
			on(name: string, handler: EventHandler) {
				events.set(name, [...(events.get(name) ?? []), handler]);
				return () =>
					events.set(
						name,
						(events.get(name) ?? []).filter((candidate) => candidate !== handler),
					);
			},
			emit(name: string, payload: object) {
				for (const handler of events.get(name) ?? []) void handler(payload);
			},
		},
	};
	intercomHeavy(pi as never);
	const fire = async (name: string, event: Record<string, unknown> = {}) => {
		for (const handler of lifecycle.get(name) ?? []) await handler({ type: name, ...event }, context);
	};
	const call = (params: Record<string, unknown>): Promise<ToolResult> => {
		const tool = tools.get("intercom");
		assert.ok(tool, "the intercom tool is registered");
		return tool.execute(randomUUID(), params, undefined, undefined, context);
	};
	return {
		sessionId,
		entries,
		call,
		shutdown: () => fire("session_shutdown", { reason: "quit" }),
		async start(reason = "startup") {
			await fire("session_start", { reason });
			const status = await call({ action: "status" });
			assert.equal(status.isError, false, status.content[0]?.text);
		},
		failures: () => shown.filter((content) => /^Your ask .* failed/.test(content)),
		replies: () => shown.filter((content) => /^Reply to your ask/.test(content)),
	};
}

async function startedSession(options: Parameters<typeof atomicSession>[0]) {
	const session = atomicSession(options);
	await session.start(options.sessionId === undefined ? "startup" : "resume");
	cleanups.push(() => session.shutdown());
	return session;
}

async function pendingText(session: ReturnType<typeof atomicSession>): Promise<string> {
	return (await session.call({ action: "pending" })).content[0]?.text ?? "";
}

/** The session's Intercom session id, as its status reports it. */
async function intercomSessionId(session: ReturnType<typeof atomicSession>): Promise<string> {
	const status = (await session.call({ action: "status" })).content[0]?.text ?? "";
	const id = /Session ID: (\S+)/.exec(status)?.[1];
	assert.ok(id, status);
	return id;
}

async function askAcross(asker: ReturnType<typeof atomicSession>, recipientName: string, question: string) {
	const asked = await asker.call({
		action: "ask",
		to: recipientName,
		message: question,
		wait: { kind: "background" },
	});
	assert.equal(asked.isError, false, asked.content[0]?.text);
	assert.equal(asked.details.delivered, true, JSON.stringify(asked.details));
	return String(asked.details.askId);
}

test(
	"an ask to a session on another broker fails once when that session ends (#4842)",
	async () => {
		assert.ok(harness.multiNodeRouting, "the two brokers route across nodes");
		const asker = await startedSession({ name: unique("asker") });
		const recipient = await harness.connect("b", unique("recipient-ends"), { group: projectGroup() });
		const askId = await askAcross(asker, recipient.name, "still there?");
		await vi.waitFor(() => assert.equal(recipient.messagesWithId(askId).length, 1), WAIT);

		await harness.disconnect(recipient);

		await vi.waitFor(() => assert.equal(asker.failures().length, 1), WAIT);
		assert.ok(asker.failures()[0]?.startsWith(`Your ask ${askId} to ${recipient.name} failed`), asker.failures()[0]);
		assert.match(asker.failures()[0] ?? "", /ended before replying/);
		assert.match(await pendingText(asker), /No unresolved/);
		await new Promise((resolveDelay) => setTimeout(resolveDelay, SETTLE_MS));
		assert.equal(asker.failures().length, 1, "the asker is told once");
	},
	REAL_BROKERS_TEST_TIMEOUT_MS,
);

test(
	"an ask to a subagent on another broker that its owner released stays pending and is answered when it wakes (#4842)",
	async () => {
		assert.ok(harness.multiNodeRouting, "the two brokers route across nodes");
		const owner = await harness.connect("b", unique("owner"), {
			group: projectGroup(),
			supervisorOwnerToken: randomUUID(),
		});
		const childName = unique("subagent-released");
		const first = await owner.client.authorizeSupervisorChild(childName);
		const child = await harness.connect("b", childName, {
			group: projectGroup(),
			supervisor: { capability: first.capability, supervisorSessionId: first.supervisorSessionId },
		});
		const asker = await startedSession({ name: unique("asker") });
		const askId = await askAcross(asker, child.sessionId, "ready?");
		await vi.waitFor(() => assert.equal(child.messagesWithId(askId).length, 1), WAIT);
		await owner.client.reserveReleasedChildren([{ childName, wake: true }]);
		const childSessionId = child.sessionId;

		await harness.disconnect(child);

		await new Promise((resolveDelay) => setTimeout(resolveDelay, SETTLE_MS));
		assert.equal(asker.failures().length, 0, "a released subagent's asks stay open");
		assert.match(await pendingText(asker), new RegExp(askId));
		const second = await owner.client.authorizeSupervisorChild(childName);
		const woken = await harness.connect("b", childName, {
			group: projectGroup(),
			supervisor: { capability: second.capability, supervisorSessionId: second.supervisorSessionId },
			returnAddress: child.returnAddress,
			preferredSessionId: childSessionId,
		});
		const askerIntercomId = await intercomSessionId(asker);
		const answered = await woken.client.send(askerIntercomId, {
			text: "ready now",
			replyTo: askId,
			requirePendingReply: true,
			expectedRecipientId: askerIntercomId,
		});
		assert.equal(answered.delivered, true, JSON.stringify(answered));
		await vi.waitFor(() => assert.equal(asker.replies().length, 1), WAIT);
		assert.equal(asker.failures().length, 0);
		assert.match(await pendingText(asker), /No unresolved/);
	},
	REAL_BROKERS_TEST_TIMEOUT_MS,
);

test(
	"an asker restarted while its recipient on another broker ends gets the failure once when it is back (#4842)",
	async () => {
		assert.ok(harness.multiNodeRouting, "the two brokers route across nodes");
		const askerName = unique("asker-away");
		const first = atomicSession({ name: askerName });
		await first.start();
		const recipient = await harness.connect("b", unique("recipient-ends-while-away"), { group: projectGroup() });
		const askId = await askAcross(first, recipient.name, "still there later?");
		await vi.waitFor(() => assert.equal(recipient.messagesWithId(askId).length, 1), WAIT);
		await first.shutdown();

		await harness.disconnect(recipient);

		const resumed = await startedSession({ name: askerName, sessionId: first.sessionId, entries: first.entries });
		await vi.waitFor(() => assert.equal(resumed.failures().length, 1), WAIT);
		assert.ok(
			resumed.failures()[0]?.startsWith(`Your ask ${askId} to ${recipient.name} failed`),
			resumed.failures()[0],
		);
		assert.match(await pendingText(resumed), /No unresolved/);
		await new Promise((resolveDelay) => setTimeout(resolveDelay, SETTLE_MS));
		assert.equal(resumed.failures().length, 1, "the asker is told once");
	},
	REAL_BROKERS_TEST_TIMEOUT_MS,
);
