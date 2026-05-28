import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { createCursorBridge } from "../cursor-bridge.ts";
import { discoverCursorModels } from "../models.ts";
import {
	AgentClientMessageSchema,
	AgentRunRequestSchema,
	AgentServerMessageSchema,
	ConversationStateStructureSchema,
	ConversationStepSchema,
	ConversationTurnStructureSchema,
	ExecServerMessageSchema,
	GetUsableModelsResponseSchema,
	InteractionUpdateSchema,
	McpArgsSchema,
	ModelDetailsSchema,
	TextDeltaUpdateSchema,
	ThinkingDeltaUpdateSchema,
	ThinkingDetailsSchema,
	type ConversationStateStructure,
} from "../proto/agent_pb.ts";

const tempDirs: string[] = [];
const CONNECT_END_STREAM_OK_FRAME_SOURCE = "Buffer.from([0b00000010, 0, 0, 0, 2, 123, 125])";

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeFakeUnaryBridge(responseBody: Uint8Array): string {
	const dir = mkdtempSync(join(tmpdir(), "cursor-bridge-test-"));
	tempDirs.push(dir);
	const bridgePath = join(dir, "fake-h2-bridge.mjs");
	writeFileSync(
		bridgePath,
		`
const response = Buffer.from(${JSON.stringify(Buffer.from(responseBody).toString("base64"))}, "base64");
const len = Buffer.alloc(4);
len.writeUInt32BE(response.length, 0);
process.stdout.write(len);
process.stdout.write(response);
setTimeout(() => process.exit(0), 5);
`,
	);
	return bridgePath;
}

function writeFailingBridge(stderr: string, code = 7): string {
	const dir = mkdtempSync(join(tmpdir(), "cursor-bridge-test-"));
	tempDirs.push(dir);
	const bridgePath = join(dir, "failing-h2-bridge.mjs");
	writeFileSync(
		bridgePath,
		`
process.stderr.write(${JSON.stringify(stderr)});
setTimeout(() => process.exit(${JSON.stringify(code)}), 5);
`,
	);
	return bridgePath;
}

function writeStreamingRunBridge(serverMessages: Uint8Array[]): string {
	const dir = mkdtempSync(join(tmpdir(), "cursor-bridge-test-"));
	tempDirs.push(dir);
	const bridgePath = join(dir, "streaming-run-bridge.mjs");
	writeFileSync(
		bridgePath,
		`
const messages = ${JSON.stringify(serverMessages.map((message) => Buffer.from(message).toString("base64")))};
let pending = Buffer.alloc(0);
let seenInit = false;
let seenRun = false;
function writeLp(payload) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(payload.length, 0);
  process.stdout.write(len);
  process.stdout.write(payload);
}
function writeConnectFrame(message) {
  const body = Buffer.from(message, "base64");
  const frame = Buffer.alloc(5 + body.length);
  frame[0] = 0;
  frame.writeUInt32BE(body.length, 1);
  body.copy(frame, 5);
  return frame;
}
function writeConnectMessage(message) {
  writeLp(writeConnectFrame(message));
}
function emitDone() {
  const end = ${CONNECT_END_STREAM_OK_FRAME_SOURCE};
  writeLp(end);
  setTimeout(() => process.exit(0), 5);
}
process.stdin.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= 4) {
    const len = pending.readUInt32BE(0);
    if (pending.length < 4 + len) return;
    const payload = pending.subarray(4, 4 + len);
    pending = pending.subarray(4 + len);
    if (!seenInit) { seenInit = true; continue; }
    if (payload.length === 0 || seenRun) continue;
    seenRun = true;
    for (const message of messages) writeConnectMessage(message);
    emitDone();
  }
});
`,
	);
	return bridgePath;
}

function writeBatchedStreamingRunBridge(serverMessages: Uint8Array[]): string {
	const dir = mkdtempSync(join(tmpdir(), "cursor-bridge-test-"));
	tempDirs.push(dir);
	const bridgePath = join(dir, "batched-streaming-run-bridge.mjs");
	writeFileSync(
		bridgePath,
		`
const messages = ${JSON.stringify(serverMessages.map((message) => Buffer.from(message).toString("base64")))};
let pending = Buffer.alloc(0);
let seenInit = false;
let seenRun = false;
function writeLp(payload) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(payload.length, 0);
  process.stdout.write(len);
  process.stdout.write(payload);
}
function connectFrame(message) {
  const body = Buffer.from(message, "base64");
  const frame = Buffer.alloc(5 + body.length);
  frame[0] = 0;
  frame.writeUInt32BE(body.length, 1);
  body.copy(frame, 5);
  return frame;
}
function emitDone() {
  const end = ${CONNECT_END_STREAM_OK_FRAME_SOURCE};
  writeLp(end);
  setTimeout(() => process.exit(0), 5);
}
process.stdin.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= 4) {
    const len = pending.readUInt32BE(0);
    if (pending.length < 4 + len) return;
    const payload = pending.subarray(4, 4 + len);
    pending = pending.subarray(4 + len);
    if (!seenInit) { seenInit = true; continue; }
    if (payload.length === 0 || seenRun) continue;
    seenRun = true;
    writeLp(Buffer.concat(messages.map(connectFrame)));
    emitDone();
  }
});
`,
	);
	return bridgePath;
}

function writeDelayedStreamingRunBridge(serverMessages: Uint8Array[], delayMs: number): string {
	const dir = mkdtempSync(join(tmpdir(), "cursor-bridge-test-"));
	tempDirs.push(dir);
	const bridgePath = join(dir, "delayed-streaming-run-bridge.mjs");
	writeFileSync(
		bridgePath,
		`
const messages = ${JSON.stringify(serverMessages.map((message) => Buffer.from(message).toString("base64")))};
const delayMs = ${JSON.stringify(delayMs)};
let pending = Buffer.alloc(0);
let seenInit = false;
let seenRun = false;
function writeLp(payload) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(payload.length, 0);
  process.stdout.write(len);
  process.stdout.write(payload);
}
function writeConnectMessage(message) {
  const body = Buffer.from(message, "base64");
  const frame = Buffer.alloc(5 + body.length);
  frame[0] = 0;
  frame.writeUInt32BE(body.length, 1);
  body.copy(frame, 5);
  writeLp(frame);
}
function emitDone() {
  const end = ${CONNECT_END_STREAM_OK_FRAME_SOURCE};
  writeLp(end);
  setTimeout(() => process.exit(0), 5);
}
process.stdin.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= 4) {
    const len = pending.readUInt32BE(0);
    if (pending.length < 4 + len) return;
    const payload = pending.subarray(4, 4 + len);
    pending = pending.subarray(4 + len);
    if (!seenInit) { seenInit = true; continue; }
    if (payload.length === 0 || seenRun) continue;
    seenRun = true;
    messages.forEach((message, index) => setTimeout(() => writeConnectMessage(message), index * delayMs));
    setTimeout(emitDone, messages.length * delayMs + 500);
  }
});
`,
	);
	return bridgePath;
}

function interactionUpdateBytes(message: "textDelta" | "thinkingDelta", text: string): Uint8Array {
	return toBinary(
		AgentServerMessageSchema,
		create(AgentServerMessageSchema, {
			message: {
				case: "interactionUpdate",
				value: create(InteractionUpdateSchema, {
					message:
						message === "textDelta"
							? { case: "textDelta", value: create(TextDeltaUpdateSchema, { text }) }
							: { case: "thinkingDelta", value: create(ThinkingDeltaUpdateSchema, { text }) },
				}),
			},
		}),
	);
}

function mcpExecMessageBytes(toolCallId: string, toolName: string): Uint8Array {
	return toBinary(
		AgentServerMessageSchema,
		create(AgentServerMessageSchema, {
			message: {
				case: "execServerMessage",
				value: create(ExecServerMessageSchema, {
					id: 1,
					message: {
						case: "mcpArgs",
						value: create(McpArgsSchema, { name: toolName, toolName, toolCallId, providerIdentifier: "atomic", args: {} }),
					},
				}),
			},
		}),
	);
}

function writeCaptureRunBridge(capturePath: string): string {
	const dir = mkdtempSync(join(tmpdir(), "cursor-bridge-test-"));
	tempDirs.push(dir);
	const bridgePath = join(dir, "capture-run-bridge.mjs");
	writeFileSync(
		bridgePath,
		`
const fs = await import("node:fs");
let pending = Buffer.alloc(0);
let seenInit = false;
function emitDone() {
  const end = ${CONNECT_END_STREAM_OK_FRAME_SOURCE};
  const len = Buffer.alloc(4);
  len.writeUInt32BE(end.length, 0);
  process.stdout.write(len);
  process.stdout.write(end);
  setTimeout(() => process.exit(0), 5);
}
process.stdin.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= 4) {
    const len = pending.readUInt32BE(0);
    if (pending.length < 4 + len) return;
    const payload = pending.subarray(4, 4 + len);
    pending = pending.subarray(4 + len);
    if (!seenInit) { seenInit = true; continue; }
    if (payload.length === 0) continue;
    const messageLen = payload.readUInt32BE(1);
    fs.writeFileSync(${JSON.stringify(capturePath)}, payload.subarray(5, 5 + messageLen).toString("base64"));
    emitDone();
  }
});
`,
	);
	return bridgePath;
}

async function readCapturedRunRequest(capturePath: string) {
	const bytes = Buffer.from(readFileSync(capturePath, "utf8"), "base64");
	const client = fromBinary(AgentClientMessageSchema, bytes);
	const runRequest = client.message.case === "runRequest" ? client.message.value : undefined;
	expect(runRequest).toBeDefined();
	return fromBinary(AgentRunRequestSchema, toBinary(AgentRunRequestSchema, runRequest!));
}

async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
	for await (const _ of iterable) {}
}

function lpEncode(data: Uint8Array): Buffer {
	const buf = Buffer.alloc(4 + data.length);
	buf.writeUInt32BE(data.length, 0);
	buf.set(data, 4);
	return buf;
}

interface TestStoredSession {
	checkpoint?: Uint8Array;
	blobStore: Map<string, Uint8Array>;
}

interface TestBridgeWithSessions {
	sessions: Map<string, TestStoredSession>;
}

function getTestSession(bridge: ReturnType<typeof createCursorBridge>, sessionId: string): TestStoredSession {
	const session = (bridge as ReturnType<typeof createCursorBridge> & TestBridgeWithSessions).sessions.get(sessionId);
	expect(session).toBeDefined();
	return session!;
}

function expectCheckpointUnchanged(session: TestStoredSession, checkpointBytes: Uint8Array): void {
	expect(Buffer.from(session.checkpoint ?? new Uint8Array()).equals(Buffer.from(checkpointBytes))).toBe(true);
}

function collectMcpToolResults(conversationState: ConversationStateStructure, blobStore: Map<string, Uint8Array>): Array<{ toolCallId: string; resultCase?: string; successText: string }> {
	const results: Array<{ toolCallId: string; resultCase?: string; successText: string }> = [];
	for (const turnBlobId of conversationState.turns) {
		const turnBytes = blobStore.get(Buffer.from(turnBlobId).toString("hex"));
		if (!turnBytes) continue;
		const turn = fromBinary(ConversationTurnStructureSchema, turnBytes);
		if (turn.turn.case !== "agentConversationTurn") continue;
		for (const stepBlobId of turn.turn.value.steps) {
			const stepBytes = blobStore.get(Buffer.from(stepBlobId).toString("hex"));
			if (!stepBytes) continue;
			const step = fromBinary(ConversationStepSchema, stepBytes);
			if (step.message.case !== "toolCall" || step.message.value.tool.case !== "mcpToolCall") continue;
			const mcpToolCall = step.message.value.tool.value;
			const result = mcpToolCall.result?.result;
			results.push({
				toolCallId: mcpToolCall.args?.toolCallId ?? "",
				resultCase: result?.case,
				successText:
					result?.case === "success"
						? result.value.content.map((item) => (item.content.case === "text" ? item.content.value.text : "")).join("")
						: "",
			});
		}
	}
	return results;
}

describe("Cursor live bridge child process RPC", () => {
	it("rejects quickly with a sanitized actionable error when the Node executable is missing", async () => {
		const bridge = createCursorBridge({ bridgePath: writeFakeUnaryBridge(new Uint8Array()), nodeExecutable: "definitely-missing-node-for-cursor-provider", requestTimeoutMs: 5_000 });

		await expect(bridge.getUsableModels("secret-access-token-that-must-not-leak")).rejects.toThrow(/Cursor bridge failed to start.*Node executable/);
		await expect(bridge.getUsableModels("secret-access-token-that-must-not-leak")).rejects.not.toThrow(/secret-access-token-that-must-not-leak/);
		bridge.close();
	});

	it("rejects quickly with a sanitized actionable error when h2-bridge.mjs is missing", async () => {
		const missingPath = join(mkdtempSync(join(tmpdir(), "cursor-bridge-test-")), "missing-h2-bridge.mjs");
		const bridge = createCursorBridge({ bridgePath: missingPath, requestTimeoutMs: 5_000 });

		await expect(bridge.getUsableModels("secret-access-token-that-must-not-leak")).rejects.toThrow(/Cursor bridge failed to start.*h2-bridge\.mjs/);
		await expect(bridge.getUsableModels("secret-access-token-that-must-not-leak")).rejects.not.toThrow(/secret-access-token-that-must-not-leak/);
		bridge.close();
	});

	it("lets model discovery fall back when bridge startup fails", async () => {
		const bridge = createCursorBridge({ bridgePath: join(mkdtempSync(join(tmpdir(), "cursor-bridge-test-")), "missing-h2-bridge.mjs"), requestTimeoutMs: 5_000 });

		const result = await discoverCursorModels("secret-access-token-that-must-not-leak", {
			bridge,
			cacheTtlMs: 0,
			fallbackModels: [{ id: "cached-model", name: "Cached Model", reasoning: false, contextWindow: 10, maxTokens: 5 }],
		});

		expect(result.source).toBe("fallback");
		expect(result.models[0]?.id).toBe("cached-model");
		expect(result.warning).toContain("Cursor bridge failed to start");
		expect(result.warning).not.toContain("secret-access-token-that-must-not-leak");
		bridge.close();
	});

	it("propagates sanitized nonzero child stderr for unary calls", async () => {
		const accessToken = "secret-access-token-that-must-not-leak";
		const bridge = createCursorBridge({ bridgePath: writeFailingBridge(`Cursor HTTP/2 request to /agent.v1.AgentService/GetUsableModels failed with status 403.\nBearer ${accessToken}\u0000`), requestTimeoutMs: 1_000 });

		let message = "";
		try {
			await bridge.getUsableModels(accessToken);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}

		expect(message).toContain("status 403");
		expect(message).not.toContain(accessToken);
		expect(message).not.toContain("\u0000");
		bridge.close();
	});

	it("propagates sanitized nonzero child stderr for streaming calls", async () => {
		const accessToken = "secret-stream-token-that-must-not-leak";
		const bridge = createCursorBridge({ bridgePath: writeFailingBridge(`Cursor HTTP/2 request to /agent.v1.AgentService/Run failed with status 429.\nBearer ${accessToken}`), requestTimeoutMs: 1_000 });

		await expect(
			drain(bridge.chatCompletions({ model: "gpt-5", pi_session_id: "session-failure", messages: [{ role: "user", content: "hello" }] }, { accessToken })),
		).rejects.toThrow(/status 429/);
		await expect(
			drain(bridge.chatCompletions({ model: "gpt-5", pi_session_id: "session-failure", messages: [{ role: "user", content: "hello" }] }, { accessToken })),
		).rejects.not.toThrow(new RegExp(accessToken));
		bridge.close();
	});

	it("emits Cursor thinkingDelta separately from answer textDelta", async () => {
		const bridge = createCursorBridge({
			bridgePath: writeStreamingRunBridge([
				interactionUpdateBytes("thinkingDelta", "private reasoning"),
				interactionUpdateBytes("textDelta", "visible answer"),
			]),
			requestTimeoutMs: 1_000,
		});
		const chunks = [];

		for await (const chunk of bridge.chatCompletions(
			{ model: "gpt-5", pi_session_id: "session-thinking", messages: [{ role: "user", content: "hello" }] },
			{ accessToken: "access-token" },
		)) {
			chunks.push(chunk);
		}

		expect(chunks).toEqual([
			{ type: "thinking", text: "private reasoning" },
			{ type: "text", text: "visible answer" },
			{ type: "done", finishReason: "stop" },
		]);
		expect(chunks.filter((chunk) => chunk.type === "text").map((chunk) => chunk.text)).toEqual(["visible answer"]);
		bridge.close();
	});

	it("assigns stable distinct indexes to Cursor MCP tool calls in one response", async () => {
		const bridge = createCursorBridge({
			bridgePath: writeBatchedStreamingRunBridge([
				mcpExecMessageBytes("call_1", "read"),
				mcpExecMessageBytes("call_2", "grep"),
				mcpExecMessageBytes("call_1", "read"),
			]),
			requestTimeoutMs: 1_000,
		});
		const chunks = [];

		for await (const chunk of bridge.chatCompletions(
			{ model: "gpt-5", pi_session_id: "session-tool-indexes", messages: [{ role: "user", content: "use tools" }] },
			{ accessToken: "access-token" },
		)) {
			chunks.push(chunk);
		}

		const toolCalls = chunks.filter((chunk) => chunk.type === "tool_call");
		expect(toolCalls).toEqual([
			{ type: "tool_call", id: "call_1", index: 0, name: "read", arguments: "{}" },
			{ type: "tool_call", id: "call_2", index: 1, name: "grep", arguments: "{}" },
			{ type: "tool_call", id: "call_1", index: 0, name: "read", arguments: "{}" },
		]);
		expect(chunks.at(-1)).toEqual({ type: "done", finishReason: "tool_calls" });
		bridge.close();
	});

	it("collects Cursor MCP tool calls emitted in delayed frames", async () => {
		const bridge = createCursorBridge({
			bridgePath: writeDelayedStreamingRunBridge([mcpExecMessageBytes("call_1", "read"), mcpExecMessageBytes("call_2", "grep")], 80),
			requestTimeoutMs: 1_000,
		});
		const chunks = [];

		for await (const chunk of bridge.chatCompletions(
			{ model: "gpt-5", pi_session_id: "session-delayed-tool-indexes", messages: [{ role: "user", content: "use tools" }] },
			{ accessToken: "access-token" },
		)) {
			chunks.push(chunk);
		}

		const toolCalls = chunks.filter((chunk) => chunk.type === "tool_call");
		expect(toolCalls).toEqual([
			{ type: "tool_call", id: "call_1", index: 0, name: "read", arguments: "{}" },
			{ type: "tool_call", id: "call_2", index: 1, name: "grep", arguments: "{}" },
		]);
		expect(chunks.at(-1)).toEqual({ type: "done", finishReason: "tool_calls" });
		bridge.close();
	});

	it("uses resumeAction instead of replaying userMessageAction for tool-result continuations", async () => {
		const capturePath = join(mkdtempSync(join(tmpdir(), "cursor-bridge-test-")), "request.b64");
		const bridge = createCursorBridge({ bridgePath: writeCaptureRunBridge(capturePath), requestTimeoutMs: 1_000 });

		for await (const _chunk of bridge.chatCompletions(
			{
				model: "gpt-5",
				pi_session_id: "session-tool",
				messages: [
					{ role: "user", content: "read a file" },
					{ role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"README.md"}' } }] },
					{ role: "tool", tool_call_id: "call_1", content: "file contents" },
				],
			},
			{ accessToken: "access-token" },
		)) {}

		const runRequest = await readCapturedRunRequest(capturePath);
		expect(runRequest.action?.action.case).toBe("resumeAction");
		const json = JSON.stringify(runRequest);
		expect(json).not.toContain("userMessageAction");
		bridge.close();
	});

	it("merges tool-result continuations into checkpointed MCP tool calls", async () => {
		const capturePath = join(mkdtempSync(join(tmpdir(), "cursor-bridge-test-")), "request.b64");
		const bridge = createCursorBridge({ bridgePath: writeCaptureRunBridge(capturePath), requestTimeoutMs: 1_000 });
		const sessionId = "session-checkpoint-tool-result";
		const initialMessages = [
			{ role: "user", content: "read a file" },
			{ role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"README.md"}' } }] },
		];

		await drain(bridge.chatCompletions({ model: "gpt-5", pi_session_id: sessionId, messages: initialMessages }, { accessToken: "access-token" }));

		const firstRunRequest = await readCapturedRunRequest(capturePath);
		expect(firstRunRequest.conversationState).toBeDefined();
		const session = getTestSession(bridge, sessionId);
		const checkpointBytes = toBinary(ConversationStateStructureSchema, firstRunRequest.conversationState!);
		session.checkpoint = checkpointBytes;

		await drain(
			bridge.chatCompletions(
				{
					model: "gpt-5",
					pi_session_id: sessionId,
					messages: [...initialMessages, { role: "tool", tool_call_id: "call_1", content: "file contents" }],
				},
				{ accessToken: "access-token" },
			),
		);

		const runRequest = await readCapturedRunRequest(capturePath);
		expect(runRequest.action?.action.case).toBe("resumeAction");
		expectCheckpointUnchanged(session, checkpointBytes);
		const results = collectMcpToolResults(runRequest.conversationState!, session.blobStore);
		expect(results).toContainEqual({ toolCallId: "call_1", resultCase: "success", successText: "file contents" });
		bridge.close();
	});

	it("falls back to a synthesized continuation when checkpoint blobs cannot be matched", async () => {
		const capturePath = join(mkdtempSync(join(tmpdir(), "cursor-bridge-test-")), "request.b64");
		const bridge = createCursorBridge({ bridgePath: writeCaptureRunBridge(capturePath), requestTimeoutMs: 1_000 });
		const sessionId = "session-checkpoint-fallback";

		await drain(
			bridge.chatCompletions(
				{ model: "gpt-5", pi_session_id: sessionId, messages: [{ role: "user", content: "seed" }] },
				{ accessToken: "access-token" },
			),
		);

		const session = getTestSession(bridge, sessionId);
		const checkpoint = create(ConversationStateStructureSchema, {
			turns: [new Uint8Array([1, 2, 3, 4])],
			pendingToolCalls: ['{"toolCallId":"call_missing"}', "ambiguous pending tool call"],
		});
		const checkpointBytes = toBinary(ConversationStateStructureSchema, checkpoint);
		session.checkpoint = checkpointBytes;

		await drain(
			bridge.chatCompletions(
				{
					model: "gpt-5",
					pi_session_id: sessionId,
					messages: [
						{ role: "user", content: "read a file" },
						{ role: "assistant", content: null, tool_calls: [{ id: "call_missing", type: "function", function: { name: "read", arguments: '{"path":"README.md"}' } }] },
						{ role: "tool", tool_call_id: "call_missing", content: "fallback contents" },
					],
				},
				{ accessToken: "access-token" },
			),
		);

		const runRequest = await readCapturedRunRequest(capturePath);
		expect(runRequest.action?.action.case).toBe("resumeAction");
		expectCheckpointUnchanged(session, checkpointBytes);
		expect(runRequest.conversationState?.turns).toHaveLength(2);
		expect(runRequest.conversationState?.pendingToolCalls).toEqual(["ambiguous pending tool call"]);
		const results = collectMcpToolResults(runRequest.conversationState!, session.blobStore);
		expect(results).toContainEqual({ toolCallId: "call_missing", resultCase: "success", successText: "fallback contents" });
		bridge.close();
	});

	it("uses userMessageAction for normal new user prompts", async () => {
		const capturePath = join(mkdtempSync(join(tmpdir(), "cursor-bridge-test-")), "request.b64");
		const bridge = createCursorBridge({ bridgePath: writeCaptureRunBridge(capturePath), requestTimeoutMs: 1_000 });

		for await (const _chunk of bridge.chatCompletions(
			{ model: "gpt-5", pi_session_id: "session-user", messages: [{ role: "user", content: "hello" }] },
			{ accessToken: "access-token" },
		)) {}

		const runRequest = await readCapturedRunRequest(capturePath);
		expect(runRequest.action?.action.case).toBe("userMessageAction");
		expect(runRequest.action?.action.value).toMatchObject({ userMessage: { text: "hello" } });
		bridge.close();
	});

	it("clearSession drops one checkpoint so the next request rebuilds from fresh messages", async () => {
		const capturePath = join(mkdtempSync(join(tmpdir(), "cursor-bridge-test-")), "request.b64");
		const bridge = createCursorBridge({ bridgePath: writeCaptureRunBridge(capturePath), requestTimeoutMs: 1_000 });
		const sessionId = "session-clear-checkpoint";
		await drain(bridge.chatCompletions({ model: "gpt-5", pi_session_id: sessionId, messages: [{ role: "user", content: "seed" }] }, { accessToken: "access-token" }));

		const session = getTestSession(bridge, sessionId);
		const staleCheckpoint = create(ConversationStateStructureSchema, { turns: [new Uint8Array([9, 9, 9, 9])] });
		const staleCheckpointBytes = toBinary(ConversationStateStructureSchema, staleCheckpoint);
		session.checkpoint = staleCheckpointBytes;

		await drain(bridge.chatCompletions({ model: "gpt-5", pi_session_id: sessionId, messages: [{ role: "user", content: "stale branch" }] }, { accessToken: "access-token" }));
		const staleRunRequest = await readCapturedRunRequest(capturePath);
		expect(Buffer.from(staleRunRequest.conversationState?.turns[0] ?? new Uint8Array()).equals(Buffer.from(staleCheckpoint.turns[0]!))).toBe(true);

		bridge.clearSession(sessionId);
		await drain(bridge.chatCompletions({ model: "gpt-5", pi_session_id: sessionId, messages: [{ role: "user", content: "fresh branch" }] }, { accessToken: "access-token" }));
		const freshRunRequest = await readCapturedRunRequest(capturePath);
		const freshSession = getTestSession(bridge, sessionId);
		expect(freshSession.checkpoint).toBeUndefined();
		expect(Buffer.from(freshRunRequest.conversationState?.turns[0] ?? new Uint8Array()).equals(Buffer.from(staleCheckpoint.turns[0]!))).toBe(false);
		expect(freshRunRequest.action?.action.value).toMatchObject({ userMessage: { text: "fresh branch" } });
		bridge.close();
	});

	it("decodes unary GetUsableModels protobuf responses from h2-bridge.mjs", async () => {
		const body = toBinary(
			GetUsableModelsResponseSchema,
			create(GetUsableModelsResponseSchema, {
				models: [
					create(ModelDetailsSchema, {
						modelId: "gpt-5-high",
						displayModelId: "gpt-5-high",
						displayName: "GPT-5 High",
						displayNameShort: "GPT-5",
						aliases: [],
						thinkingDetails: create(ThinkingDetailsSchema, {}),
					}),
				],
			}),
		);
		const bridge = createCursorBridge({ bridgePath: writeFakeUnaryBridge(body), requestTimeoutMs: 1_000 });

		const result = await bridge.getUsableModels("access-token-that-must-not-be-logged");

		expect(result).toMatchObject({ models: [{ modelId: "gpt-5-high", displayName: "GPT-5 High" }] });
		bridge.close();
	});

	it("h2-bridge.mjs exits nonzero and suppresses stdout for non-2xx statuses", async () => {
		const accessToken = "secret-h2-status-token";
		const requestBody = "private request body";
		const responseBody = "private response body";
		const server = http2.createServer();
		server.on("stream", (stream) => {
			stream.respond({ ":status": 401, "content-type": "text/plain" });
			stream.end(responseBody);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address() as AddressInfo;
			const child = spawn("node", [join(dirname(fileURLToPath(import.meta.url)), "..", "h2-bridge.mjs")], { stdio: ["pipe", "pipe", "pipe"] });
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
			child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
			child.stdin.write(lpEncode(new TextEncoder().encode(JSON.stringify({ accessToken, url: `http://127.0.0.1:${address.port}`, path: "/agent.v1.AgentService/Run", unary: true }))));
			child.stdin.write(lpEncode(new TextEncoder().encode(requestBody)));
			child.stdin.end();

			const code = await new Promise<number>((resolve) => child.on("close", (childCode) => resolve(childCode ?? 1)));
			const stderrText = Buffer.concat(stderr).toString("utf8");
			expect(code).not.toBe(0);
			expect(Buffer.concat(stdout).length).toBe(0);
			expect(stderrText).toContain("/agent.v1.AgentService/Run");
			expect(stderrText).toContain("status 401");
			expect(stderrText).not.toContain(accessToken);
			expect(stderrText).not.toContain(requestBody);
			expect(stderrText).not.toContain(responseBody);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
