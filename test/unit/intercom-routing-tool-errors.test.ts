import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
	IntercomRoutingMismatchError,
	IntercomRoutingTimeoutError,
	IntercomRoutingUnavailableError,
	ProjectGroupError,
} from "../../packages/coding-agent/src/index.js";
import type { SendOptions, SendResult } from "../../packages/intercom/broker/client.js";
import { registerIntercomTool } from "../../packages/intercom/intercom-tool.js";
import { IntercomClientDisconnectedError } from "../../packages/intercom/recoverable-disconnect.js";
import type { SessionInfo } from "../../packages/intercom/types.js";

type ToolResult = { content: Array<{ text: string }>; isError: boolean; details?: Record<string, unknown> };
type Tool = {
	execute(
		id: string,
		params: { action: string; to?: string; message?: string },
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
const context = { sessionManager: { getSessionId: () => "host-session" }, hasUI: false };

// Vitest's fake clock does not replace node:timers/promises. Keep the real delay/abort contract, but schedule it on
// the fake global timer, as the sibling retry tests do.
vi.mock("node:timers/promises", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:timers/promises")>()),
	setTimeout: (ms: number, value: unknown, options?: { signal?: AbortSignal }) =>
		new Promise((resolve, reject) => {
			const signal = options?.signal;
			if (signal?.aborted) return reject(signal.reason);
			const onAbort = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				reject(signal?.reason);
			};
			const timer = setTimeout(() => {
				signal?.removeEventListener("abort", onAbort);
				resolve(value);
			}, ms);
			signal?.addEventListener("abort", onAbort, { once: true });
		}),
}));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/**
 * The public intercom tool with a scripted connection: each `ensureConnected` call consumes the next script entry,
 * which either throws that error or yields the client; once the script is spent, connecting succeeds. `send` throws
 * each queued failure in turn, then settles delivered.
 */
function fixture(connectScript: ReadonlyArray<Error | "connect">, sendFailures: readonly Error[] = []) {
	let tool: Tool | undefined;
	const sent: SendOptions[] = [];
	let connectionAttempts = 0;
	const client = {
		sessionId: "self-id",
		groups: ["default"],
		async send(_target: string, options: SendOptions): Promise<SendResult> {
			sent.push(options);
			const failure = sendFailures[sent.length - 1];
			if (failure !== undefined) throw failure;
			return { id: options.messageId ?? "missing", delivered: true };
		},
	};
	registerIntercomTool(
		{
			registerTool(value: Tool) {
				tool = value;
			},
			async appendEntry() {},
		} as never,
		{
			ensureConnected: async () => {
				const step = connectScript[connectionAttempts++];
				if (step instanceof Error) throw step;
				return client;
			},
			syncPresenceIdentity() {},
			resolveSessionTarget: async () => peer.id,
			homeGroup: () => "default",
			setJoinedGroups() {},
			clearJoinedGroups() {},
			confirmSend: false,
		} as never,
	);
	assert.ok(tool);
	return { tool, sent, connectionAttempts: () => connectionAttempts };
}

const sendParams = { action: "send", to: peer.name, message: "one message" };

/** Run the whole recovery schedule (1 s, 2 s, 5 s backoff) of a single invocation. */
async function settle(execution: Promise<ToolResult>): Promise<ToolResult> {
	await vi.advanceTimersByTimeAsync(8_000);
	return execution;
}

function assertNoRecoveryMetadata(result: ToolResult): void {
	assert.doesNotMatch(JSON.stringify(result), /retryToken/);
	assert.equal(Object.hasOwn(result.details ?? {}, "retryable"), false, "internal recovery metadata stays private");
}

const NON_RETRYABLE_STATUSES = [
	["a routing mismatch", () => new IntercomRoutingMismatchError("implicit-default-on-remote-broker", "default")],
	[
		"an unnameable project group",
		() => new ProjectGroupError("git-unavailable", { cwd: "/repo", hint: "Install Git or name the group." }),
	],
] as const;

for (const [label, makeError] of NON_RETRYABLE_STATUSES) {
	test(`${label} before connecting fails once with its code and hint, with no retry and no retry token`, async () => {
		const error = makeError();
		const { tool, sent, connectionAttempts } = fixture([error]);

		const result = await tool.execute("call", sendParams, undefined, undefined, context);

		assert.equal(result.isError, true);
		assert.equal(result.content[0]?.text, `Intercom not connected: ${error.message}`);
		assert.deepEqual(result.details, { error: true, code: error.code, hint: error.hint });
		assertNoRecoveryMetadata(result);
		assert.equal(connectionAttempts(), 1, "a non-retryable routing status is not retried");
		assert.equal(sent.length, 0);
		assert.equal(vi.getTimerCount(), 0, "no recovery is left scheduled");
	});
}

test("a plain connection error reports no routing code or hint and is not retried", async () => {
	const { tool, sent, connectionAttempts } = fixture([new Error("socket path is not writable")]);

	const result = await tool.execute("call", sendParams, undefined, undefined, context);

	assert.equal(result.isError, true);
	assert.equal(result.content[0]?.text, "Intercom not connected: socket path is not writable");
	assert.deepEqual(result.details, { error: true });
	assert.equal(Object.hasOwn(result.details ?? {}, "code"), false);
	assert.equal(Object.hasOwn(result.details ?? {}, "hint"), false);
	assertNoRecoveryMetadata(result);
	assert.equal(connectionAttempts(), 1);
	assert.equal(sent.length, 0);
});

const RETRYABLE_CONNECT_FAILURES = [
	[
		"a routing status timeout",
		() => new IntercomRoutingTimeoutError({ timeoutMs: 5_000, elapsedMs: 5_000, phase: "broker_status" }),
	],
	["an unavailable routing status", () => new IntercomRoutingUnavailableError("unsupported", "broker_status")],
	["a recoverable disconnect", () => new IntercomClientDisconnectedError()],
] as const;

for (const [label, makeError] of RETRYABLE_CONNECT_FAILURES) {
	test(`${label} before connecting is retried internally and ends as one terminal result without recovery metadata`, async () => {
		const error = makeError();
		const { tool, sent, connectionAttempts } = fixture([error, error, error, error]);

		const result = await settle(tool.execute("call", sendParams, undefined, undefined, context));

		assert.equal(result.isError, true);
		assert.equal(connectionAttempts(), 4, "the first attempt and three automatic retries");
		assert.deepEqual(result.details, { error: true, terminal: true, automaticRetries: 3, outcome: "unknown" });
		assertNoRecoveryMetadata(result);
		assert.equal(sent.length, 0);
		assert.equal(vi.getTimerCount(), 0);
	});
}

test("a routing timeout before reconnecting keeps the send's identity, so the retry reuses its message ID", async () => {
	const status = new IntercomRoutingTimeoutError({ timeoutMs: 5_000, elapsedMs: 5_000, phase: "broker_status" });
	// Attempt 1 connects and its send fails ambiguously; attempt 2 cannot read routing; attempt 3 connects and sends.
	const { tool, sent, connectionAttempts } = fixture(
		["connect", status, "connect"],
		[new IntercomClientDisconnectedError()],
	);

	const result = await settle(tool.execute("call", sendParams, undefined, undefined, context));

	assert.equal(result.isError, false, result.content[0]?.text);
	assert.equal(connectionAttempts(), 3);
	assert.equal(sent.length, 2, "the failed routing read is not a send");
	assert.ok(sent[0]?.messageId);
	assert.equal(sent[1]?.messageId, sent[0]?.messageId, "the same message ID must not be re-minted as a new message");
	assertNoRecoveryMetadata(result);
	assert.equal(vi.getTimerCount(), 0);
});

test("a non-retryable connection error during recovery ends the operation instead of retrying on", async () => {
	// Attempt 1 connects and its send fails ambiguously; attempt 2's connection fails for a reason that cannot recover.
	const { tool, sent, connectionAttempts } = fixture(
		["connect", new Error("socket path is not writable")],
		[new IntercomClientDisconnectedError()],
	);

	const result = await settle(tool.execute("call", sendParams, undefined, undefined, context));

	assert.equal(result.isError, true);
	assert.equal(connectionAttempts(), 2, "no third attempt follows a conclusive connection failure");
	assert.equal(sent.length, 1);
	assert.deepEqual(result.details, { error: true, terminal: true, automaticRetries: 1, outcome: "unknown" });
	assert.match(result.content[0]?.text ?? "", /Do not repeat this operation automatically/);
	assertNoRecoveryMetadata(result);
	assert.equal(vi.getTimerCount(), 0);
});
