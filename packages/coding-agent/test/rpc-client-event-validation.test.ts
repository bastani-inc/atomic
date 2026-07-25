import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { INTERACTIVE_ENGINE_MAX_FRAME_BYTES } from "../src/modes/interactive-engine/protocol.ts";
import { RpcClient, type RpcEvent } from "../src/modes/rpc/rpc-client.ts";
import { isRpcMessageLifecycleEvent } from "../src/modes/rpc/rpc-event-validation.ts";
import { serializeBounded } from "../src/modes/rpc/rpc-output-buffer.ts";

const tempDirs: string[] = [];

function writeChildScript(contents: string): string {
	const dir = mkdtempSync(join(tmpdir(), "atomic-rpc-event-validation-"));
	tempDirs.push(dir);
	const path = join(dir, "child.mjs");
	writeFileSync(path, contents);
	return path;
}

function childScript(writeAfterInput: string): string {
	return `
process.stdout.write([
	JSON.stringify({ type: "engine_ready", protocolVersion: 1, pid: process.pid }),
	JSON.stringify({ type: "engine_bound" }),
].join("\\n") + "\\n");
process.stdin.once("data", () => {
	${writeAfterInput}
});
process.stdin.resume();
`;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function stopAndExpectTermination(client: RpcClient): Promise<void> {
	const pid = client.getEnginePid();
	if (pid === undefined) {
		await client.stop();
		throw new Error("Fake interactive engine did not report its pid");
	}
	expect(isProcessAlive(pid)).toBe(true);
	await client.stop();
	expect(isProcessAlive(pid)).toBe(false);
}

function sendFixture(client: RpcClient): void {
	client.sendInteractiveEngineCommand({ type: "engine_custom_dispose", componentId: "emit-fixture" });
}

afterEach(() => {
	vi.useRealTimers();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const USAGE = {
	input: 1,
	output: 2,
	cacheRead: 3,
	cacheWrite: 4,
	totalTokens: 10,
	cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
};
const TOOL_CALL = { type: "toolCall", id: "call-1", name: "read", arguments: { path: "file.ts" } };
const ASSISTANT = {
	role: "assistant",
	content: [
		{ type: "text", text: "answer" },
		{ type: "thinking", thinking: "reasoning" },
		TOOL_CALL,
	],
	api: "messages",
	provider: "provider",
	model: "model",
	usage: USAGE,
	stopReason: "stop",
	timestamp: 2,
};

const VALID_ROLE_CASES: Array<{ name: string; message: unknown }> = [
	{ name: "user", message: { role: "user", content: [{ type: "image", data: "AA==", mimeType: "image/png" }], timestamp: 1 } },
	{ name: "assistant", message: ASSISTANT },
	{ name: "toolResult", message: { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "result" }], isError: false, timestamp: 3 } },
	{ name: "custom", message: { role: "custom", customType: "notice", content: "custom", display: true, timestamp: 4 } },
	{ name: "bashExecution", message: { role: "bashExecution", command: "pwd", output: "/tmp", exitCode: 0, cancelled: false, truncated: false, timestamp: 5 } },
	{ name: "branchSummary", message: { role: "branchSummary", summary: "summary", fromId: "entry-1", timestamp: 6 } },
];

const ASSISTANT_EVENT_CASES: Array<{ name: string; event: unknown }> = [
	{ name: "start", event: { type: "start", partial: ASSISTANT } },
	{ name: "text_start", event: { type: "text_start", contentIndex: 0, partial: ASSISTANT } },
	{ name: "thinking_start", event: { type: "thinking_start", contentIndex: 0, partial: ASSISTANT } },
	{ name: "toolcall_start", event: { type: "toolcall_start", contentIndex: 0, partial: ASSISTANT } },
	{ name: "text_delta", event: { type: "text_delta", contentIndex: 0, delta: "x", partial: ASSISTANT } },
	{ name: "thinking_delta", event: { type: "thinking_delta", contentIndex: 0, delta: "x", partial: ASSISTANT } },
	{ name: "toolcall_delta", event: { type: "toolcall_delta", contentIndex: 0, delta: "x", partial: ASSISTANT } },
	{ name: "text_end", event: { type: "text_end", contentIndex: 0, content: "text", partial: ASSISTANT } },
	{ name: "thinking_end", event: { type: "thinking_end", contentIndex: 0, content: "thought", partial: ASSISTANT } },
	{ name: "toolcall_end", event: { type: "toolcall_end", contentIndex: 0, toolCall: TOOL_CALL, partial: ASSISTANT } },
	{ name: "done", event: { type: "done", reason: "toolUse", message: ASSISTANT } },
	{ name: "error", event: { type: "error", reason: "error", error: { ...ASSISTANT, stopReason: "error" } } },
];

function updateWith(assistantMessageEvent: unknown): unknown {
	return { type: "message_update", message: ASSISTANT, assistantMessageEvent };
}

const SENTINEL = {
	type: "message_start",
	message: { role: "user", content: "before failure", timestamp: 10 },
};
const BUFFERED_UPDATE = updateWith({
	type: "text_delta",
	contentIndex: 0,
	delta: "queued",
	partial: ASSISTANT,
});
const POST_FAILURE = {
	type: "message_end",
	message: { role: "user", content: "after failure", timestamp: 11 },
};

interface FailureCase {
	name: string;
	record: unknown;
	diagnostic: string;
}

const FAILURE_CASES: FailureCase[] = [
	{
		name: "malformed message_start",
		record: { type: "message_start", success: false, error: "missing message" },
		diagnostic: "Interactive engine emitted malformed message_start event",
	},
	{
		name: "malformed message_update",
		record: updateWith({ type: "text_delta", contentIndex: 0, partial: ASSISTANT }),
		diagnostic: "Interactive engine emitted malformed message_update event",
	},
	{
		name: "malformed message_end",
		record: { type: "message_end", message: { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [null], isError: false, timestamp: 3 } },
		diagnostic: "Interactive engine emitted malformed message_end event",
	},
	{
		name: "malformed transport_error",
		record: { type: "transport_error", recordType: "message_start", error: 17 },
		diagnostic: "Interactive engine emitted malformed transport_error record",
	},
	{
		name: "valid transport_error",
		record: { type: "transport_error", recordType: "message_start", error: "RPC record exceeded the 1 MiB transport limit" },
		diagnostic: "Interactive engine transport error for message_start: RPC record exceeded the 1 MiB transport limit",
	},
];

describe("RPC lifecycle validation", () => {
	test.each(VALID_ROLE_CASES)("accepts the $name message contract", ({ message }) => {
		expect(isRpcMessageLifecycleEvent({ type: "message_start", message })).toBe(true);
	});

	test.each(ASSISTANT_EVENT_CASES)("accepts the $name assistant event contract", ({ event }) => {
		expect(isRpcMessageLifecycleEvent(updateWith(event))).toBe(true);
	});

	test.each([
		{ name: "missing content", event: { type: "message_start", message: { role: "user", timestamp: 1 } } },
		{ name: "null content block", event: { type: "message_start", message: { role: "user", content: [null], timestamp: 1 } } },
		{ name: "missing tool-call arguments", event: { type: "message_start", message: { ...ASSISTANT, content: [{ type: "toolCall", id: "call-1", name: "read" }] } } },
		{ name: "unsupported role", event: { type: "message_start", message: { role: "system", content: "hidden", timestamp: 1 } } },
		{ name: "missing assistant event field", event: updateWith({ type: "text_delta", contentIndex: 0, partial: ASSISTANT }) },
		{ name: "missing assistant event", event: updateWith(undefined) },
		{ name: "unknown assistant event", event: updateWith({ type: "text_replace", contentIndex: 0, content: "x", partial: ASSISTANT }) },
	])("rejects $name", ({ event }) => {
		expect(isRpcMessageLifecycleEvent(event)).toBe(false);
	});
});

describe("RpcClient JSONL lifecycle boundary", () => {
	test("delivers an aggregate-large bounded tool result through the subprocess reader", async () => {
		const record = {
			type: "message_start",
			message: {
				role: "toolResult",
				toolCallId: "aggregate-call",
				toolName: "aggregate",
				content: [{ type: "text", text: "small visible result" }],
				isError: false,
				timestamp: 20,
			},
			details: {
				detail: {
					stages: Array.from({ length: 78 }, (_, index) => ({ index, result: "x".repeat(20_000) })),
				},
			},
		};
		expect(Buffer.byteLength(JSON.stringify(record), "utf8")).toBeGreaterThan(INTERACTIVE_ENGINE_MAX_FRAME_BYTES);
		const line = serializeBounded(record);
		expect(Buffer.byteLength(line.slice(0, -1), "utf8")).toBeLessThanOrEqual(INTERACTIVE_ENGINE_MAX_FRAME_BYTES);
		const expected = JSON.parse(line) as RpcEvent;
		expect(isRpcMessageLifecycleEvent(expected)).toBe(true);

		let resolveEvent!: (event: RpcEvent) => void;
		const received = new Promise<RpcEvent>((resolve) => { resolveEvent = resolve; });
		const client = new RpcClient({
			cliPath: writeChildScript(childScript(`process.stdout.write(${JSON.stringify(line)});`)),
			interactiveEngine: { onDiagnostic: () => {} },
		});
		client.onEvent((event) => resolveEvent(event));
		await client.start();
		try {
			await client.waitForInteractiveEngineBound();
			sendFixture(client);
			const event = await received;
			expect(event).toEqual(expected);
			expect(event).toMatchObject({
				type: "message_start",
				message: { role: "toolResult", content: [{ type: "text", text: "small visible result" }] },
			});
		} finally {
			await stopAndExpectTermination(client);
		}
	});

	test.each(FAILURE_CASES)("makes $name terminal for the current stream", async ({ record, diagnostic }) => {
		vi.useFakeTimers({ toFake: ["setTimeout"] });
		const batch = [BUFFERED_UPDATE, record, POST_FAILURE, { type: "turn_start" }]
			.map((entry) => JSON.stringify(entry))
			.join("\n") + "\n";
		const script = childScript(`
process.stdout.write(${JSON.stringify(`${JSON.stringify(SENTINEL)}\n`)});
process.stdout.write(${JSON.stringify(batch)});`);
		const events: RpcEvent[] = [];
		const diagnostics: string[] = [];
		let resolveDiagnostic!: () => void;
		const diagnosticReceived = new Promise<void>((resolve) => { resolveDiagnostic = resolve; });
		const client = new RpcClient({
			cliPath: writeChildScript(script),
			interactiveEngine: {
				onDiagnostic: (entry) => {
					if (entry.source === "watchdog") return;
					diagnostics.push(entry.message);
					if (entry.message === diagnostic) resolveDiagnostic();
				},
			},
		});
		client.onEvent((event) => events.push(event));
		await client.start();
		try {
			await client.waitForInteractiveEngineBound();
			sendFixture(client);
			await diagnosticReceived;
			vi.advanceTimersByTime(20);
			expect(events).toEqual([SENTINEL]);
			expect(diagnostics).toEqual([diagnostic]);
		} finally {
			vi.useRealTimers();
			await stopAndExpectTermination(client);
		}
	});
});
