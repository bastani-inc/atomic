import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { Context } from "@earendil-works/pi-ai";
import { CursorStreamAdapter } from "../../packages/cursor/src/stream.js";
import type { CursorAgentTransport, CursorRunRequest, CursorRunStream, CursorServerMessage, CursorToolResultMessage, CursorWriteOptions } from "../../packages/cursor/src/transport.js";
import { CursorMockRunStream, CursorMockTransport } from "./cursor-test-helpers.js";
import type { CursorUsableModel } from "../../packages/cursor/src/model-mapper.js";
import { collectEvents, collectEventsWithTimeout, context, deferred, model } from "./cursor-stream-helpers.js";

describe("CursorStreamAdapter", () => {	test("batches adjacent Cursor tool calls into one paused turn", async () => {
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
			{ toolCallId: "tool-1", toolName: "Read", text: "file contents", content: [{ type: "text", text: "file contents" }], isError: false, execId: "exec-1", execNumericId: 7 },
			{ toolCallId: "tool-2", toolName: "List", text: "listing", content: [{ type: "text", text: "listing" }], isError: false, execId: "exec-2", execNumericId: 8 },
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
		assert.deepEqual(transport.runs[0]?.stream.writtenToolResults, [{ toolCallId: "tool-1", toolName: "Read", text: "file contents", content: [{ type: "text", text: "file contents" }], isError: false, execId: "exec-1", execNumericId: 7 }]);
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


});
