import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { SendOptions, SendResult } from "../../packages/intercom/broker/client.js";
import { registerIntercomTool } from "../../packages/intercom/intercom-tool.js";
import type { IntercomReachPolicy } from "../../packages/intercom/reach-policy.js";
import { IntercomClientDisconnectedError } from "../../packages/intercom/recoverable-disconnect.js";
import { ReplyTracker } from "../../packages/intercom/reply-tracker.js";
import { ReplyWaiterRegistry } from "../../packages/intercom/reply-waiter.js";
import type { SessionInfo } from "../../packages/intercom/types.js";

type ToolResult = { content: Array<{ text: string }>; isError: boolean; details?: Record<string, unknown> };
type Tool = {
	execute(
		id: string,
		params: { action: string; to?: string; message?: string; wait?: { kind: "background" } },
		signal: AbortSignal | undefined,
		update: undefined,
		ctx: object,
	): Promise<ToolResult>;
};

const peer: SessionInfo = {
	id: "peer-id",
	name: "peer",
	cwd: "/tmp",
	model: "test",
	pid: 2,
	startedAt: 1,
	lastActivity: 1,
};

vi.mock("node:timers/promises", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:timers/promises")>()),
	setTimeout: (ms: number, value: unknown, options?: { signal?: AbortSignal }) =>
		new Promise((resolve, reject) => {
			const signal = options?.signal;
			if (signal?.aborted) return reject(signal.reason);
			const timer = setTimeout(() => resolve(value), ms);
			signal?.addEventListener(
				"abort",
				() => {
					clearTimeout(timer);
					reject(signal.reason);
				},
				{ once: true },
			);
		}),
}));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const context = { sessionManager: { getSessionId: () => "host-session" }, hasUI: false };

/** An intercom tool whose first send loses its connection, so its outcome is unknown and it is retried. */
function fixture(reach: { current: IntercomReachPolicy }) {
	let tool: Tool | undefined;
	const sent: SendOptions[] = [];
	const client = {
		sessionId: "self-id",
		groups: [reach.current.home],
		async listSessions() {
			return [peer];
		},
		async send(_target: string, options: SendOptions): Promise<SendResult> {
			options.beforeWrite?.(reach.current);
			sent.push(options);
			if (sent.length === 1) throw new IntercomClientDisconnectedError();
			return { id: options.messageId ?? "missing", delivered: true };
		},
	};
	const waiters = new ReplyWaiterRegistry();
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
			resolveSessionTarget: async () => peer.id,
			homeGroup: () => reach.current.home,
			reachPolicy: () => reach.current,
			setJoinedGroups() {},
			clearJoinedGroups() {},
			confirmSend: false,
			beginReplyWait: (from: string, replyTo: string, signal?: AbortSignal, timeoutMs?: number | null) =>
				waiters.begin(from, replyTo, signal, timeoutMs),
			replyTracker: new ReplyTracker(),
		} as never,
	);
	assert.ok(tool);
	return { tool, sent };
}

for (const action of ["send", "ask"] as const) {
	test(`a ${action} whose outcome is unknown is not sent again once the session's reach changed (#5352)`, async () => {
		const reach = { current: { home: "doc-a", reachable: ["doc-b"] } };
		const { tool, sent } = fixture(reach);
		const execution = tool.execute(
			"lost",
			{ action, to: peer.name, message: "status", ...(action === "ask" ? { wait: { kind: "background" } } : {}) },
			undefined,
			undefined,
			context,
		);
		await vi.advanceTimersByTimeAsync(0);
		assert.equal(sent.length, 1);
		reach.current = { home: "doc-a", reachable: [] };
		await vi.advanceTimersByTimeAsync(30_000);
		const result = await execution;
		assert.equal(sent.length, 1, "the message was not sent again under the new reach");
		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /reach changed while this message's outcome was unknown/);
		assert.equal(result.details?.outcome, "unknown");
	});
}

test("a send whose outcome is unknown is retried while the reach is unchanged (#5352)", async () => {
	const reach = { current: { home: "doc-a", reachable: ["doc-b"] } };
	const { tool, sent } = fixture(reach);
	const execution = tool.execute(
		"lost",
		{ action: "send", to: peer.name, message: "status" },
		undefined,
		undefined,
		context,
	);
	await vi.advanceTimersByTimeAsync(30_000);
	const result = await execution;
	assert.equal(sent.length, 2);
	assert.equal(sent[1]?.messageId, sent[0]?.messageId, "the retry keeps the message id");
	assert.equal(result.isError, false, JSON.stringify(result));
});
