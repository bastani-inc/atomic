import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { Context } from "@earendil-works/pi-ai";
import { CursorStreamAdapter } from "../../packages/cursor/src/stream.js";
import type { CursorAgentTransport, CursorRunRequest, CursorRunStream, CursorServerMessage, CursorToolResultMessage } from "../../packages/cursor/src/transport.js";
import { CursorMockRunStream, CursorMockTransport } from "./cursor-test-helpers.js";
import type { CursorUsableModel } from "../../packages/cursor/src/model-mapper.js";
import { collectEvents, collectEventsWithTimeout, context, deferred, model } from "./cursor-stream-helpers.js";

describe("CursorStreamAdapter", () => {
	test("uses the production UUID generator when no test UUID is injected", async () => {
		const transport = new CursorMockTransport({ messages: [{ type: "textDelta", text: "ok" }, { type: "done", reason: "stop" }] });
		const adapter = new CursorStreamAdapter({ transport });

		const events = await collectEventsWithTimeout(adapter.streamSimple(model(), context(), { apiKey: "access-secret" }));

		assert.equal(events.at(-1)?.type, "done");
		assert.match(transport.runs[0]?.request.requestId ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
		assert.deepEqual(transport.getLifecycleSnapshot(), { openStreams: 0, cancelledStreams: 0, closedStreams: 1 });
	});

	test("turns UUID generator failures into a terminal error event and closes the stream", async () => {
		const transport = new CursorMockTransport({ messages: [{ type: "done", reason: "stop" }] });
		const adapter = new CursorStreamAdapter({
			transport,
			uuid: () => {
				throw new Error("uuid exploded access-secret");
			},
		});
		const stream = adapter.streamSimple(model(), context(), { apiKey: "access-secret" });

		const [events, result] = await Promise.all([collectEventsWithTimeout(stream), stream.result()]);

		assert.deepEqual(events.map((event) => event.type), ["start", "error"]);
		const terminal = events.at(-1);
		assert.equal(terminal?.type, "error");
		if (terminal?.type === "error") {
			assert.equal(terminal.reason, "error");
			assert.equal(terminal.error.stopReason, "error");
			assert.match(terminal.error.errorMessage ?? "", /uuid exploded/u);
			assert.doesNotMatch(terminal.error.errorMessage ?? "", /access-secret/u);
		}
		assert.equal(result.stopReason, "error");
		assert.equal(transport.runs.length, 0);
	});

	test("pauses after collecting Cursor MCP tool call usage metadata", async () => {
		const transport = new CursorMockTransport({
			messages: [
				{ type: "thinkingDelta", text: "plan" },
				{ type: "textDelta", text: "Hello" },
				{ type: "textDelta", text: " world" },
				{ type: "toolCall", id: "tool-1", name: "Read", argumentsJson: "{\"path\":\"README.md\"}" },
				{ type: "usage", kind: "outputDelta", outputTokens: 3 },
				{ type: "usage", kind: "outputDelta", outputTokens: 2 },
				{ type: "usage", kind: "checkpoint", inputTokens: 10 },
				{ type: "done", reason: "toolUse" },
			],
		});
		const adapter = new CursorStreamAdapter({ transport, uuid: () => "run-1" });
		const events = await collectEvents(adapter.streamSimple(model(), context(), { apiKey: "access-secret", reasoning: "high", sessionId: "session-tools" }));

		assert.deepEqual(events.map((event) => event.type), [
			"start",
			"thinking_start",
			"thinking_delta",
			"text_start",
			"text_delta",
			"text_delta",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
			"text_end",
			"thinking_end",
			"done",
		]);
		const done = events.find((event) => event.type === "done");
		assert.equal(done?.type, "done");
		if (done?.type === "done") {
			assert.equal(done.reason, "toolUse");
			assert.equal(done.message.usage.input, 10);
			assert.equal(done.message.usage.output, 5);
			assert.equal(done.message.usage.totalTokens, 15);
		}
		assert.equal(transport.runs[0]?.request.resolvedModelId, "composer-2-high");
		assert.deepEqual(transport.getLifecycleSnapshot(), { openStreams: 1, cancelledStreams: 0, closedStreams: 0 });
		await adapter.dispose();
	});

	test("ignores non-MCP Cursor exec protocol messages without ending the assistant turn", async () => {
		const transport = new CursorMockTransport({ messages: [
			{ type: "nonMcpExec", fieldNumber: 10, execId: "exec-context", execNumericId: 12 },
			{ type: "textDelta", text: "still running" },
			{ type: "done", reason: "stop" },
		] });
		const adapter = new CursorStreamAdapter({ transport, uuid: () => "run-non-mcp" });

		const events = await collectEvents(adapter.streamSimple(model(), context(), { apiKey: "access-secret" }));

		assert.equal(events.some((event) => event.type === "error"), false);
		assert.equal(events.some((event) => event.type === "text_delta"), true);
		assert.equal(events.at(-1)?.type, "done");
	});

	test("checkpoint output totals override accumulated usage deltas", async () => {
		const transport = new CursorMockTransport({ messages: [
			{ type: "usage", kind: "outputDelta", outputTokens: 3 },
			{ type: "usage", kind: "outputDelta", outputTokens: 5 },
			{ type: "usage", kind: "checkpoint", inputTokens: 12 },
			{ type: "usage", kind: "checkpoint", outputTokens: 20 },
			{ type: "done", reason: "stop" },
		] });
		const adapter = new CursorStreamAdapter({ transport, uuid: () => "run-usage" });
		const events = await collectEvents(adapter.streamSimple(model(), context(), { apiKey: "access-secret" }));
		const done = events.at(-1);
		assert.equal(done?.type, "done");
		if (done?.type === "done") {
			assert.equal(done.message.usage.input, 12);
			assert.equal(done.message.usage.output, 20);
			assert.equal(done.message.usage.totalTokens, 32);
		}
	});

	test("ends a tool-call-only Cursor turn with toolUse", async () => {
		const transport = new CursorMockTransport({ messages: [{ type: "toolCall", id: "tool-1", name: "Read", argumentsJson: "{\"path\":\"README.md\"}" }] });
		const adapter = new CursorStreamAdapter({ transport, uuid: () => "run-tool" });
		const events = await collectEvents(adapter.streamSimple(model(), context(), { apiKey: "access-secret", sessionId: "session-tool" }));
		const done = events.at(-1);
		assert.equal(done?.type, "done");
		if (done?.type === "done") assert.equal(done.reason, "toolUse");
		assert.deepEqual(events.map((event) => event.type), ["start", "toolcall_start", "toolcall_delta", "toolcall_end", "done"]);
		assert.deepEqual(transport.getLifecycleSnapshot(), { openStreams: 1, cancelledStreams: 0, closedStreams: 0 });
		await adapter.dispose();
		assert.deepEqual(transport.getLifecycleSnapshot(), { openStreams: 0, cancelledStreams: 1, closedStreams: 1 });
	});

	test("pauses pending tool calls immediately when Cursor waits for tool results without done", async () => {
		class WaitingToolTransport extends CursorMockTransport {
			async run(request: CursorRunRequest): Promise<CursorRunStream> {
				const stream = await super.run(request);
				return new CursorMockRunStream(stream.id, (async function* (): AsyncIterable<CursorServerMessage> {
					yield { type: "toolCall", id: "tool-waiting", name: "Read", argumentsJson: "{\"path\":\"README.md\"}", execId: "exec-waiting", execNumericId: 42 };
					await new Promise<void>(() => {});
				})(), () => void stream.cancel(), () => void stream.close());
			}
		}
		const transport = new WaitingToolTransport();
		const adapter = new CursorStreamAdapter({ transport, uuid: () => "run-tool-waiting" });

		const events = await collectEventsWithTimeout(adapter.streamSimple(model(), context(), { apiKey: "access-secret", sessionId: "session-tool-waiting", timeoutMs: 10_000 }), 250);

		const terminal = events.at(-1);
		assert.equal(terminal?.type, "done");
		if (terminal?.type === "done") assert.equal(terminal.reason, "toolUse");
		assert.deepEqual(events.map((event) => event.type), ["start", "toolcall_start", "toolcall_delta", "toolcall_end", "done"]);
	});

	test("resumes immediately-paused Cursor tool turns without dropping the first post-tool message", async () => {
		class TimeoutResumeStream implements CursorRunStream {
			readonly id = "run-timeout-resume";
			readonly messages = this.createMessages();
			readonly writtenToolResults: CursorToolResultMessage[] = [];
			#toolResultWritten = deferred();
			#cancelled = false;
			#closed = false;

			constructor(readonly onCancel: () => void, readonly onClose: () => void) {}

			async writeToolResult(result: CursorToolResultMessage): Promise<void> {
				this.writtenToolResults.push(result);
				this.#toolResultWritten.resolve();
			}

			async cancel(): Promise<void> {
				if (this.#cancelled) return;
				this.#cancelled = true;
				this.onCancel();
				await this.close();
			}

			async close(): Promise<void> {
				if (this.#closed) return;
				this.#closed = true;
				this.onClose();
			}

			private async *createMessages(): AsyncIterable<CursorServerMessage> {
				yield { type: "toolCall", id: "tool-timeout", name: "Read", argumentsJson: "{\"path\":\"README.md\"}", execId: "exec-timeout", execNumericId: 1 };
				await this.#toolResultWritten.promise;
				yield { type: "textDelta", text: "after tool" };
				yield { type: "done", reason: "stop" };
			}
		}

		class TimeoutResumeTransport implements CursorAgentTransport {
			readonly requests: CursorRunRequest[] = [];
			#openStreams = 0;
			#cancelledStreams = 0;
			#closedStreams = 0;
			readonly stream = new TimeoutResumeStream(() => {
				this.#cancelledStreams += 1;
			}, () => {
				this.#closedStreams += 1;
				this.#openStreams = Math.max(0, this.#openStreams - 1);
			});

			async getUsableModels(): Promise<readonly CursorUsableModel[]> { return []; }
			async run(request: CursorRunRequest): Promise<CursorRunStream> {
				this.requests.push(request);
				this.#openStreams += 1;
				return this.stream;
			}
			async dispose(): Promise<void> {}
			getLifecycleSnapshot() { return { openStreams: this.#openStreams, cancelledStreams: this.#cancelledStreams, closedStreams: this.#closedStreams }; }
		}

		const transport = new TimeoutResumeTransport();
		const adapter = new CursorStreamAdapter({ transport, uuid: () => "request-timeout-resume" });

		const firstEvents = await collectEventsWithTimeout(adapter.streamSimple(model(), context(), { apiKey: "access-secret", sessionId: "session-timeout-resume", timeoutMs: 1 }), 250);

		assert.deepEqual(firstEvents.map((event) => event.type), ["start", "toolcall_start", "toolcall_delta", "toolcall_end", "done"]);
		const resumeContext: Context = { messages: [{ role: "toolResult", toolCallId: "tool-timeout", toolName: "Read", content: [{ type: "text", text: "file contents" }], isError: false, timestamp: 2 }] };
		const secondEvents = await collectEventsWithTimeout(adapter.streamSimple(model(), resumeContext, { apiKey: "access-secret", sessionId: "session-timeout-resume" }), 250);

		assert.equal(transport.requests.length, 1);
		assert.deepEqual(transport.stream.writtenToolResults, [{ toolCallId: "tool-timeout", toolName: "Read", text: "file contents", content: [{ type: "text", text: "file contents" }], isError: false, execId: "exec-timeout", execNumericId: 1 }]);
		assert.deepEqual(secondEvents.filter((event) => event.type === "text_delta").map((event) => event.delta), ["after tool"]);
		assert.equal(secondEvents.at(-1)?.type, "done");
	});

	test("derives reference-style Cursor conversation keys when no session id is provided", async () => {
		const transport = new CursorMockTransport({ messages: [
			{ type: "toolCall", id: "tool-1", name: "Read", argumentsJson: "{\"path\":\"README.md\"}" },
			{ type: "textDelta", text: "after tool" },
			{ type: "done", reason: "stop" },
		] });
		const adapter = new CursorStreamAdapter({ transport, uuid: () => "run-tool-missing-session" });

		const firstEvents = await collectEvents(adapter.streamSimple(model(), context(), { apiKey: "access-secret" }));
		assert.deepEqual(firstEvents.map((event) => event.type), ["start", "toolcall_start", "toolcall_delta", "toolcall_end", "done"]);
		assert.equal(transport.runs[0]?.request.conversationId, "bc933415-34b2-474e-9078-cd393275bf94");
		assert.deepEqual(adapter.getLifecycleSnapshot(), { openStreams: 1, cancelledStreams: 0, closedStreams: 0, activeTurns: 1 });

		const resumeContext: Context = { messages: [
			{ role: "user", content: "hello", timestamp: 1 },
			{ role: "toolResult", toolCallId: "tool-1", toolName: "Read", content: [{ type: "text", text: "file contents" }], isError: false, timestamp: 2 },
		] };
		const secondEvents = await collectEvents(adapter.streamSimple(model(), resumeContext, { apiKey: "access-secret" }));
		assert.deepEqual(secondEvents.filter((event) => event.type === "text_delta").map((event) => event.delta), ["after tool"]);
		assert.deepEqual(adapter.getLifecycleSnapshot(), { openStreams: 0, cancelledStreams: 0, closedStreams: 1, activeTurns: 0 });
	});


});
