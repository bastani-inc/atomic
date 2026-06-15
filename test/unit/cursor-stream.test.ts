import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { Api, AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";
import { CursorStreamAdapter } from "../../packages/cursor/src/stream.js";
import {
	type CursorAgentTransport,
	type CursorRunRequest,
	type CursorRunStream,
	type CursorServerMessage,
	type CursorToolResultMessage,
	type CursorWriteOptions,
} from "../../packages/cursor/src/transport.js";
import { CursorMockRunStream, CursorMockTransport } from "./cursor-test-helpers.js";
import type { CursorUsableModel } from "../../packages/cursor/src/model-mapper.js";

function model(): Model<Api> {
	return {
		id: "composer-2",
		name: "Composer 2",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl: "https://api2.cursor.sh",
		reasoning: true,
		thinkingLevelMap: { high: "high", xhigh: "max" },
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

function context(): Context {
	return { messages: [{ role: "user", content: "hello", timestamp: 1 }] };
}

interface Deferred {
	readonly promise: Promise<void>;
	resolve(): void;
}

function deferred(): Deferred {
	let resolveFn = (): void => {};
	const promise = new Promise<void>((resolve) => {
		resolveFn = resolve;
	});
	return { promise, resolve: resolveFn };
}

async function collectEvents(stream: AsyncIterable<AssistantMessageEvent>, onEvent?: (event: AssistantMessageEvent) => void): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
		onEvent?.(event);
	}
	return events;
}

async function collectEventsWithTimeout(stream: AsyncIterable<AssistantMessageEvent>, timeoutMs = 250): Promise<AssistantMessageEvent[]> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			collectEvents(stream),
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(() => reject(new Error("timed out waiting for cursor stream to end")), timeoutMs);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

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
		assert.deepEqual(transport.stream.writtenToolResults, [{ toolCallId: "tool-timeout", toolName: "Read", text: "file contents", isError: false, execId: "exec-timeout", execNumericId: 1 }]);
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

	test("batches adjacent Cursor tool calls into one paused turn", async () => {
		const transport = new CursorMockTransport({ messages: [
			{ type: "toolCall", id: "tool-1", name: "Read", argumentsJson: "{\"path\":\"README.md\"}", execId: "exec-1", execNumericId: 7 },
			{ type: "toolCall", id: "tool-2", name: "List", argumentsJson: "{\"path\":\"packages\"}", execId: "exec-2", execNumericId: 8 },
			{ type: "textDelta", text: "after tools" },
			{ type: "done", reason: "stop" },
		] });
		const adapter = new CursorStreamAdapter({ transport, uuid: () => "request-multi-tool" });

		const firstEvents = await collectEvents(adapter.streamSimple(model(), context(), { apiKey: "access-secret", sessionId: "session-multi-tool" }));

		assert.deepEqual(firstEvents.map((event) => event.type), ["start", "toolcall_start", "toolcall_delta", "toolcall_end", "toolcall_start", "toolcall_delta", "toolcall_end", "done"]);
		const firstDone = firstEvents.at(-1);
		assert.equal(firstDone?.type, "done");
		if (firstDone?.type === "done") assert.equal(firstDone.reason, "toolUse");

		const resumeContext: Context = { messages: [
			{ role: "toolResult", toolCallId: "tool-1", toolName: "Read", content: [{ type: "text", text: "file contents" }], isError: false, timestamp: 2 },
			{ role: "toolResult", toolCallId: "tool-2", toolName: "List", content: [{ type: "text", text: "listing" }], isError: false, timestamp: 3 },
		] };
		const secondEvents = await collectEvents(adapter.streamSimple(model(), resumeContext, { apiKey: "access-secret", sessionId: "session-multi-tool" }));

		assert.equal(transport.runs.length, 1);
		assert.deepEqual(transport.runs[0]?.stream.writtenToolResults, [
			{ toolCallId: "tool-1", toolName: "Read", text: "file contents", isError: false, execId: "exec-1", execNumericId: 7 },
			{ toolCallId: "tool-2", toolName: "List", text: "listing", isError: false, execId: "exec-2", execNumericId: 8 },
		]);
		assert.equal(secondEvents.some((event) => event.type === "text_delta"), true);
		assert.equal(secondEvents.at(-1)?.type, "done");
	});

	test("resumes a paused Cursor tool turn with trailing tool results", async () => {
		const transport = new CursorMockTransport({ messages: [
			{ type: "toolCall", id: "tool-1", name: "Read", argumentsJson: "{\"path\":\"README.md\"}", execId: "exec-1", execNumericId: 7 },
			{ type: "textDelta", text: "done" },
			{ type: "done", reason: "stop" },
		] });
		const adapter = new CursorStreamAdapter({ transport, uuid: () => "request-1" });
		const firstEvents = await collectEvents(adapter.streamSimple(model(), context(), { apiKey: "access-secret", sessionId: "session-1" }));
		assert.equal(firstEvents.at(-1)?.type, "done");
		assert.deepEqual(transport.getLifecycleSnapshot(), { openStreams: 1, cancelledStreams: 0, closedStreams: 0 });

		const resumeContext: Context = { messages: [{ role: "toolResult", toolCallId: "tool-1", toolName: "Read", content: [{ type: "text", text: "file contents" }], isError: false, timestamp: 2 }] };
		const secondEvents = await collectEvents(adapter.streamSimple(model(), resumeContext, { apiKey: "access-secret", sessionId: "session-1" }));

		assert.equal(transport.runs.length, 1);
		assert.deepEqual(transport.runs[0]?.stream.writtenToolResults, [{ toolCallId: "tool-1", toolName: "Read", text: "file contents", isError: false, execId: "exec-1", execNumericId: 7 }]);
		assert.equal(secondEvents.some((event) => event.type === "text_delta"), true);
		assert.equal(secondEvents.at(-1)?.type, "done");
		assert.deepEqual(transport.getLifecycleSnapshot(), { openStreams: 0, cancelledStreams: 0, closedStreams: 1 });
	});

	test("cancels a paused Cursor tool stream when the original request aborts", async () => {
		const transport = new CursorMockTransport({ messages: [{ type: "toolCall", id: "tool-abort", name: "Read", argumentsJson: "{\"path\":\"README.md\"}" }] });
		const adapter = new CursorStreamAdapter({ transport, uuid: () => "run-paused-abort" });
		const controller = new AbortController();
		const events = await collectEvents(adapter.streamSimple(model(), context(), { apiKey: "access-secret", sessionId: "session-abort", signal: controller.signal }));
		assert.equal(events.at(-1)?.type, "done");
		assert.deepEqual(transport.getLifecycleSnapshot(), { openStreams: 1, cancelledStreams: 0, closedStreams: 0 });

		controller.abort();
		await new Promise((resolve) => setTimeout(resolve, 0));

		assert.deepEqual(adapter.getLifecycleSnapshot(), { openStreams: 0, cancelledStreams: 1, closedStreams: 1, activeTurns: 0 });
	});

	test("cancels a paused Cursor tool stream after the idle timeout", async () => {
		const transport = new CursorMockTransport({ messages: [{ type: "toolCall", id: "tool-timeout", name: "Read", argumentsJson: "{\"path\":\"README.md\"}" }] });
		const adapter = new CursorStreamAdapter({ transport, uuid: () => "run-paused-timeout", pausedTurnIdleTimeoutMs: 1 });
		const events = await collectEvents(adapter.streamSimple(model(), context(), { apiKey: "access-secret", sessionId: "session-timeout" }));
		assert.equal(events.at(-1)?.type, "done");

		await new Promise((resolve) => setTimeout(resolve, 10));

		assert.deepEqual(adapter.getLifecycleSnapshot(), { openStreams: 0, cancelledStreams: 1, closedStreams: 1, activeTurns: 0 });
	});

	test("cancels paused stream when tool-result resume write fails", async () => {
		class FailingResumeTransport implements CursorAgentTransport {
			readonly requests: CursorRunRequest[] = [];
			#openStreams = 0;
			#cancelledStreams = 0;
			#closedStreams = 0;
			readonly stream: CursorRunStream = {
				id: "run-failing-resume",
				messages: (async function* (): AsyncIterable<CursorServerMessage> {
					yield { type: "toolCall", id: "tool-fail", name: "Read", argumentsJson: "{\"path\":\"README.md\"}" };
				})(),
				writeToolResult: async () => { throw new Error("write failed access-secret"); },
				cancel: async () => {
					this.#cancelledStreams += 1;
					this.#closedStreams += 1;
					this.#openStreams = Math.max(0, this.#openStreams - 1);
				},
				close: async () => {
					this.#closedStreams += 1;
					this.#openStreams = Math.max(0, this.#openStreams - 1);
				},
			};
			async getUsableModels(): Promise<readonly CursorUsableModel[]> { return []; }
			async run(request: CursorRunRequest): Promise<CursorRunStream> {
				this.requests.push(request);
				this.#openStreams += 1;
				return this.stream;
			}
			async dispose(): Promise<void> {}
			getLifecycleSnapshot() { return { openStreams: this.#openStreams, cancelledStreams: this.#cancelledStreams, closedStreams: this.#closedStreams }; }
		}
		const transport = new FailingResumeTransport();
		const adapter = new CursorStreamAdapter({ transport, uuid: () => "run-failing-resume" });
		await collectEvents(adapter.streamSimple(model(), context(), { apiKey: "access-secret", sessionId: "session-failing-resume" }));
		const resumeContext: Context = { messages: [{ role: "toolResult", toolCallId: "tool-fail", toolName: "Read", content: [{ type: "text", text: "file contents" }], isError: false, timestamp: 2 }] };

		const events = await collectEvents(adapter.streamSimple(model(), resumeContext, { apiKey: "access-secret", sessionId: "session-failing-resume" }));

		const terminal = events.at(-1);
		assert.equal(terminal?.type, "error");
		if (terminal?.type === "error") assert.doesNotMatch(terminal.error.errorMessage ?? "", /access-secret/u);
		assert.deepEqual(adapter.getLifecycleSnapshot(), { openStreams: 0, cancelledStreams: 1, closedStreams: 1, activeTurns: 0 });
	});

	test("honors per-request timeoutMs for stream open and idle read deadlines", async () => {
		class IdleTransport implements CursorAgentTransport {
			readonly requests: CursorRunRequest[] = [];
			#openStreams = 0;
			#cancelledStreams = 0;
			#closedStreams = 0;
			async getUsableModels(): Promise<readonly CursorUsableModel[]> { return []; }
			async run(request: CursorRunRequest): Promise<CursorRunStream> {
				this.requests.push(request);
				this.#openStreams += 1;
				return new CursorMockRunStream(request.requestId, (async function* (): AsyncIterable<CursorServerMessage> { await new Promise<void>(() => {}); })(), () => {
					this.#cancelledStreams += 1;
				}, () => {
					this.#closedStreams += 1;
					this.#openStreams = Math.max(0, this.#openStreams - 1);
				});
			}
			async dispose(): Promise<void> {}
			getLifecycleSnapshot() { return { openStreams: this.#openStreams, cancelledStreams: this.#cancelledStreams, closedStreams: this.#closedStreams }; }
		}
		const transport = new IdleTransport();
		const adapter = new CursorStreamAdapter({ transport, uuid: () => "run-per-request-timeout", streamReadTimeoutMs: 10_000 });
		const startedAt = Date.now();

		const events = await collectEventsWithTimeout(adapter.streamSimple(model(), context(), { apiKey: "access-secret", timeoutMs: 1 }), 250);

		assert.equal(transport.requests[0]?.openTimeoutMs, 1);
		assert.ok(Date.now() - startedAt < 250);
		const terminal = events.at(-1);
		assert.equal(terminal?.type, "error");
		if (terminal?.type === "error") assert.match(terminal.error.errorMessage ?? "", /timed out/u);
		assert.deepEqual(adapter.getLifecycleSnapshot(), { openStreams: 0, cancelledStreams: 1, closedStreams: 1, activeTurns: 0 });
	});

	test("observes iterator failures that arrive after a stream read timeout", async () => {
		const unhandledReasons: string[] = [];
		const onUnhandled = (reason: {} | null | undefined): void => {
			unhandledReasons.push(String(reason));
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			class LateRejectTransport implements CursorAgentTransport {
				#openStreams = 0;
				#cancelledStreams = 0;
				#closedStreams = 0;
				async getUsableModels(): Promise<readonly CursorUsableModel[]> { return []; }
				async run(request: CursorRunRequest): Promise<CursorRunStream> {
					this.#openStreams += 1;
					return new CursorMockRunStream(request.requestId, (async function* (): AsyncIterable<CursorServerMessage> {
						await new Promise((resolve) => setTimeout(resolve, 10));
						throw new Error("late cursor iterator failure");
					})(), () => {
						this.#cancelledStreams += 1;
					}, () => {
						this.#closedStreams += 1;
						this.#openStreams = Math.max(0, this.#openStreams - 1);
					});
				}
				async dispose(): Promise<void> {}
				getLifecycleSnapshot() { return { openStreams: this.#openStreams, cancelledStreams: this.#cancelledStreams, closedStreams: this.#closedStreams }; }
			}
			const adapter = new CursorStreamAdapter({ transport: new LateRejectTransport(), uuid: () => "run-late-reject" });

			const events = await collectEventsWithTimeout(adapter.streamSimple(model(), context(), { apiKey: "access-secret", timeoutMs: 1 }), 250);
			await new Promise((resolve) => setTimeout(resolve, 25));

			assert.equal(events.at(-1)?.type, "error");
			assert.deepEqual(unhandledReasons, []);
			assert.deepEqual(adapter.getLifecycleSnapshot(), { openStreams: 0, cancelledStreams: 1, closedStreams: 1, activeTurns: 0 });
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	test("aborts stalled tool-result resume writes with the current signal", async () => {
		class StalledResumeStream implements CursorRunStream {
			readonly id = "run-stalled-resume-abort";
			readonly writeStarted = deferred();
			readonly messages = this.createMessages();
			#cancelled = false;
			#closed = false;
			#rejectWrite: ((error: Error) => void) | undefined;
			constructor(readonly onCancel: () => void, readonly onClose: () => void) {}
			async writeToolResult(_result: CursorToolResultMessage, options: CursorWriteOptions = {}): Promise<void> {
				this.writeStarted.resolve();
				if (options.signal?.aborted) throw new Error("write aborted");
				await new Promise<void>((_resolve, reject) => {
					let settled = false;
					const rejectOnce = (error: Error): void => {
						if (settled) return;
						settled = true;
						this.#rejectWrite = undefined;
						reject(error);
					};
					const onAbort = (): void => rejectOnce(new Error("write aborted"));
					options.signal?.addEventListener("abort", onAbort, { once: true });
					this.#rejectWrite = (error) => {
						options.signal?.removeEventListener("abort", onAbort);
						rejectOnce(error);
					};
				});
			}
			async cancel(): Promise<void> {
				if (this.#cancelled) return;
				this.#cancelled = true;
				this.#rejectWrite?.(new Error("write cancelled"));
				this.onCancel();
				if (!this.#closed) {
					this.#closed = true;
					this.onClose();
				}
			}
			async close(): Promise<void> {
				if (this.#closed) return;
				this.#closed = true;
				this.onClose();
			}
			private async *createMessages(): AsyncIterable<CursorServerMessage> {
				yield { type: "toolCall", id: "tool-stalled", name: "Read", argumentsJson: "{\"path\":\"README.md\"}" };
				yield { type: "done", reason: "toolUse" };
				await new Promise<void>(() => {});
			}
		}
		class StalledResumeTransport implements CursorAgentTransport {
			readonly requests: CursorRunRequest[] = [];
			#openStreams = 0;
			#cancelledStreams = 0;
			#closedStreams = 0;
			readonly stream = new StalledResumeStream(() => {
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
		const transport = new StalledResumeTransport();
		const adapter = new CursorStreamAdapter({ transport, uuid: () => "run-stalled-resume-abort" });
		await collectEvents(adapter.streamSimple(model(), context(), { apiKey: "access-secret", sessionId: "session-stalled-resume" }));
		const resumeContext: Context = { messages: [{ role: "toolResult", toolCallId: "tool-stalled", toolName: "Read", content: [{ type: "text", text: "file contents" }], isError: false, timestamp: 2 }] };
		const controller = new AbortController();

		const eventPromise = collectEventsWithTimeout(adapter.streamSimple(model(), resumeContext, { apiKey: "access-secret", sessionId: "session-stalled-resume", signal: controller.signal, timeoutMs: 10_000 }), 500);
		await transport.stream.writeStarted.promise;
		controller.abort();
		const events = await eventPromise;

		const terminal = events.at(-1);
		assert.equal(terminal?.type, "error");
		if (terminal?.type === "error") assert.equal(terminal.reason, "aborted");
		assert.deepEqual(adapter.getLifecycleSnapshot(), { openStreams: 0, cancelledStreams: 1, closedStreams: 1, activeTurns: 0 });
	});

	test("deadline-bounds stalled tool-result resume writes", async () => {
		class DeadlineResumeStream implements CursorRunStream {
			readonly id = "run-stalled-resume-deadline";
			readonly messages = this.createMessages();
			#cancelled = false;
			#closed = false;
			#rejectWrite: ((error: Error) => void) | undefined;
			lastWriteTimeoutMs: number | undefined;
			constructor(readonly onCancel: () => void, readonly onClose: () => void) {}
			async writeToolResult(_result: CursorToolResultMessage, options: CursorWriteOptions = {}): Promise<void> {
				this.lastWriteTimeoutMs = options.timeoutMs;
				await new Promise<void>((_resolve, reject) => {
					let settled = false;
					let timeout: ReturnType<typeof setTimeout> | undefined;
					const rejectOnce = (error: Error): void => {
						if (settled) return;
						settled = true;
						if (timeout) clearTimeout(timeout);
						this.#rejectWrite = undefined;
						reject(error);
					};
					if (options.timeoutMs && options.timeoutMs > 0) {
						timeout = setTimeout(() => rejectOnce(new Error("write timed out")), options.timeoutMs);
						timeout.unref?.();
					}
					this.#rejectWrite = rejectOnce;
				});
			}
			async cancel(): Promise<void> {
				if (this.#cancelled) return;
				this.#cancelled = true;
				this.#rejectWrite?.(new Error("write cancelled"));
				this.onCancel();
				if (!this.#closed) {
					this.#closed = true;
					this.onClose();
				}
			}
			async close(): Promise<void> {
				if (this.#closed) return;
				this.#closed = true;
				this.onClose();
			}
			private async *createMessages(): AsyncIterable<CursorServerMessage> {
				yield { type: "toolCall", id: "tool-deadline", name: "Read", argumentsJson: "{\"path\":\"README.md\"}" };
				yield { type: "done", reason: "toolUse" };
				await new Promise<void>(() => {});
			}
		}
		class DeadlineResumeTransport implements CursorAgentTransport {
			#openStreams = 0;
			#cancelledStreams = 0;
			#closedStreams = 0;
			readonly stream = new DeadlineResumeStream(() => {
				this.#cancelledStreams += 1;
			}, () => {
				this.#closedStreams += 1;
				this.#openStreams = Math.max(0, this.#openStreams - 1);
			});
			async getUsableModels(): Promise<readonly CursorUsableModel[]> { return []; }
			async run(): Promise<CursorRunStream> {
				this.#openStreams += 1;
				return this.stream;
			}
			async dispose(): Promise<void> {}
			getLifecycleSnapshot() { return { openStreams: this.#openStreams, cancelledStreams: this.#cancelledStreams, closedStreams: this.#closedStreams }; }
		}
		const transport = new DeadlineResumeTransport();
		const adapter = new CursorStreamAdapter({ transport, uuid: () => "run-stalled-resume-deadline", streamReadTimeoutMs: 10_000 });
		await collectEvents(adapter.streamSimple(model(), context(), { apiKey: "access-secret", sessionId: "session-stalled-deadline" }));
		const resumeContext: Context = { messages: [{ role: "toolResult", toolCallId: "tool-deadline", toolName: "Read", content: [{ type: "text", text: "file contents" }], isError: false, timestamp: 2 }] };

		const events = await collectEventsWithTimeout(adapter.streamSimple(model(), resumeContext, { apiKey: "access-secret", sessionId: "session-stalled-deadline", timeoutMs: 1 }), 500);

		assert.equal(transport.stream.lastWriteTimeoutMs, 1);
		const terminal = events.at(-1);
		assert.equal(terminal?.type, "error");
		if (terminal?.type === "error") assert.match(terminal.error.errorMessage ?? "", /write timed out/u);
		assert.deepEqual(adapter.getLifecycleSnapshot(), { openStreams: 0, cancelledStreams: 1, closedStreams: 1, activeTurns: 0 });
	});

	test("times out idle Cursor streams without leaking credentials", async () => {
		class IdleTransport implements CursorAgentTransport {
			#openStreams = 0;
			#cancelledStreams = 0;
			#closedStreams = 0;
			async getUsableModels(): Promise<readonly CursorUsableModel[]> { return []; }
			async run(request: CursorRunRequest): Promise<CursorRunStream> {
				this.#openStreams += 1;
				return new CursorMockRunStream(request.requestId, (async function* (): AsyncIterable<CursorServerMessage> { await new Promise<void>(() => {}); })(), () => {
					this.#cancelledStreams += 1;
				}, () => {
					this.#closedStreams += 1;
					this.#openStreams = Math.max(0, this.#openStreams - 1);
				});
			}
			async dispose(): Promise<void> {}
			getLifecycleSnapshot() { return { openStreams: this.#openStreams, cancelledStreams: this.#cancelledStreams, closedStreams: this.#closedStreams }; }
		}
		const adapter = new CursorStreamAdapter({ transport: new IdleTransport(), uuid: () => "run-idle", streamReadTimeoutMs: 1 });

		const events = await collectEvents(adapter.streamSimple(model(), context(), { apiKey: "access-secret" }));

		const terminal = events.at(-1);
		assert.equal(terminal?.type, "error");
		if (terminal?.type === "error") {
			assert.match(terminal.error.errorMessage ?? "", /timed out/u);
			assert.doesNotMatch(terminal.error.errorMessage ?? "", /access-secret/u);
		}
		assert.deepEqual(adapter.getLifecycleSnapshot(), { openStreams: 0, cancelledStreams: 1, closedStreams: 1, activeTurns: 0 });
	});

	test("rejects unmatched trailing tool results without starting a new Cursor run", async () => {
		const transport = new CursorMockTransport({ messages: [{ type: "done", reason: "stop" }] });
		const adapter = new CursorStreamAdapter({ transport, uuid: () => "request-orphan" });
		const orphanContext: Context = { messages: [{ role: "toolResult", toolCallId: "missing-tool", toolName: "Read", content: [{ type: "text", text: "orphan" }], isError: false, timestamp: 1 }] };

		const events = await collectEvents(adapter.streamSimple(model(), orphanContext, { apiKey: "access-secret", sessionId: "session-missing" }));

		assert.equal(transport.runs.length, 0);
		const terminal = events.at(-1);
		assert.equal(terminal?.type, "error");
		if (terminal?.type === "error") assert.match(terminal.error.errorMessage ?? "", /no paused tool turn/u);
	});

	test("aborts active streams, sends cancel, and releases lifecycle handles", async () => {
		const firstDelta = deferred();
		const blocker = deferred();
		class BlockingTransport implements CursorAgentTransport {
			readonly requests: CursorRunRequest[] = [];
			#openStreams = 0;
			#cancelledStreams = 0;
			#closedStreams = 0;

			async getUsableModels(_accessToken: string, _requestId: string, _signal?: AbortSignal): Promise<readonly CursorUsableModel[]> {
				return [];
			}

			async run(request: CursorRunRequest): Promise<CursorRunStream> {
				this.requests.push(request);
				this.#openStreams += 1;
				return new CursorMockRunStream(
					request.requestId,
					this.messages(),
					() => {
						this.#cancelledStreams += 1;
					},
					() => {
						this.#closedStreams += 1;
						this.#openStreams = Math.max(0, this.#openStreams - 1);
					},
				);
			}

			async dispose(): Promise<void> {}

			getLifecycleSnapshot() {
				return { openStreams: this.#openStreams, cancelledStreams: this.#cancelledStreams, closedStreams: this.#closedStreams };
			}

			private async *messages(): AsyncIterable<CursorServerMessage> {
				yield { type: "textDelta", text: "partial" };
				firstDelta.resolve();
				await blocker.promise;
				yield { type: "done", reason: "stop" };
			}
		}

		const transport = new BlockingTransport();
		const adapter = new CursorStreamAdapter({ transport, uuid: () => "run-abort" });
		const controller = new AbortController();
		const eventPromise = collectEvents(adapter.streamSimple(model(), context(), { apiKey: "access-secret", signal: controller.signal }));
		await firstDelta.promise;
		controller.abort();
		const events = await eventPromise;

		const terminal = events.at(-1);
		assert.equal(terminal?.type, "error");
		if (terminal?.type === "error") {
			assert.equal(terminal.reason, "aborted");
			assert.equal(terminal.error.stopReason, "aborted");
		}
		assert.deepEqual(transport.getLifecycleSnapshot(), { openStreams: 0, cancelledStreams: 1, closedStreams: 1 });
	});

	test("rejects image input and missing credentials with sanitized errors", async () => {
		const adapter = new CursorStreamAdapter({ transport: new CursorMockTransport(), uuid: () => "run-error" });
		const imageContext: Context = {
			messages: [{ role: "user", content: [{ type: "image", data: "abc", mimeType: "image/png" }], timestamp: 1 }],
		};
		const imageEvents = await collectEvents(adapter.streamSimple(model(), imageContext, { apiKey: "access-secret" }));
		const imageTerminal = imageEvents.at(-1);
		assert.equal(imageTerminal?.type, "error");
		if (imageTerminal?.type === "error") {
			assert.match(imageTerminal.error.errorMessage ?? "", /text input only/u);
			assert.doesNotMatch(imageTerminal.error.errorMessage ?? "", /access-secret/u);
		}

		const missingCredentialEvents = await collectEvents(adapter.streamSimple(model(), context()));
		const missingTerminal = missingCredentialEvents.at(-1);
		assert.equal(missingTerminal?.type, "error");
	});
});
