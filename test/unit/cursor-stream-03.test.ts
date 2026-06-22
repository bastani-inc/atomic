import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { Context } from "@earendil-works/pi-ai";
import { CursorConversationStateStore, type CursorResumeTurnOptions } from "../../packages/cursor/src/conversation-state.js";
import { CursorStreamAdapter } from "../../packages/cursor/src/stream.js";
import type { CursorAgentTransport, CursorRunRequest, CursorRunStream, CursorServerMessage, CursorToolResultMessage } from "../../packages/cursor/src/transport.js";
import { CursorMockRunStream, CursorMockTransport } from "./cursor-test-helpers.js";
import type { CursorUsableModel } from "../../packages/cursor/src/model-mapper.js";
import { collectEvents, context, deferred, model } from "./cursor-stream-helpers.js";

describe("CursorStreamAdapter", () => {	test("times out idle Cursor streams without leaking credentials", async () => {
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

	test("rejects image-only input without sessionId before invoking Cursor transport", async () => {
		const transport = new CursorMockTransport();
		const adapter = new CursorStreamAdapter({ transport, uuid: () => "run-user-image-no-session" });
		const imageData = "image-only-session-sentinel-must-not-leak";
		const imageContext: Context = {
			messages: [{ role: "user", content: [{ type: "image", data: imageData, mimeType: "image/png" }], timestamp: 1 }],
		};

		const events = await collectEvents(adapter.streamSimple(model(), imageContext, { apiKey: "access-secret" }));

		const terminal = events.at(-1);
		assert.equal(terminal?.type, "error");
		if (terminal?.type === "error") {
			const message = terminal.error.errorMessage ?? "";
			assert.match(message, /non-empty sessionId/u);
			assert.doesNotMatch(message, /access-secret/u);
			assert.doesNotMatch(message, /image-only-session-sentinel-must-not-leak/u);
		}
		assert.equal(transport.runs.length, 0);
	});

	test("rejects same-text different-image inputs without sessionId before invoking Cursor transport", async () => {
		const firstTransport = new CursorMockTransport();
		const secondTransport = new CursorMockTransport();
		const firstAdapter = new CursorStreamAdapter({ transport: firstTransport, uuid: () => "run-same-text-image-a" });
		const secondAdapter = new CursorStreamAdapter({ transport: secondTransport, uuid: () => "run-same-text-image-b" });
		const firstImageData = "same-text-first-image-must-not-leak";
		const secondImageData = "same-text-second-image-must-not-leak";
		const firstContext: Context = {
			messages: [{ role: "user", content: [{ type: "text", text: "same prompt" }, { type: "image", data: firstImageData, mimeType: "image/png" }], timestamp: 1 }],
		};
		const secondContext: Context = {
			messages: [{ role: "user", content: [{ type: "text", text: "same prompt" }, { type: "image", data: secondImageData, mimeType: "image/png" }], timestamp: 1 }],
		};

		const firstEvents = await collectEvents(firstAdapter.streamSimple(model(), firstContext, { apiKey: "access-secret" }));
		const secondEvents = await collectEvents(secondAdapter.streamSimple(model(), secondContext, { apiKey: "access-secret" }));

		for (const [events, imageData] of [[firstEvents, firstImageData], [secondEvents, secondImageData]] as const) {
			const terminal = events.at(-1);
			assert.equal(terminal?.type, "error");
			if (terminal?.type === "error") {
				const message = terminal.error.errorMessage ?? "";
				assert.match(message, /non-empty sessionId/u);
				assert.doesNotMatch(message, /access-secret/u);
				assert.doesNotMatch(message, new RegExp(imageData, "u"));
			}
		}
		assert.equal(firstTransport.runs.length, 0);
		assert.equal(secondTransport.runs.length, 0);
	});

	test("rejects user image input with whitespace-only sessionId before invoking Cursor transport", async () => {
		const transport = new CursorMockTransport();
		const adapter = new CursorStreamAdapter({ transport, uuid: () => "run-user-image-whitespace-session" });
		const imageContext: Context = {
			messages: [{ role: "user", content: [{ type: "image", data: "whitespace-session-image-must-not-leak", mimeType: "image/png" }], timestamp: 1 }],
		};

		const events = await collectEvents(adapter.streamSimple(model(), imageContext, { apiKey: "access-secret", sessionId: " \t\n " }));

		const terminal = events.at(-1);
		assert.equal(terminal?.type, "error");
		if (terminal?.type === "error") {
			const message = terminal.error.errorMessage ?? "";
			assert.match(message, /non-empty sessionId/u);
			assert.doesNotMatch(message, /access-secret/u);
			assert.doesNotMatch(message, /whitespace-session-image-must-not-leak/u);
		}
		assert.equal(transport.runs.length, 0);
	});

	test("allows current user image input to reach transport by default", async () => {
		const transport = new CursorMockTransport({ messages: [{ type: "done", reason: "stop" }] });
		const adapter = new CursorStreamAdapter({ transport, uuid: () => "run-user-image" });
		const imageContext: Context = {
			messages: [{ role: "user", content: [{ type: "text", text: "keep text exactly" }, { type: "image", data: "YWJj", mimeType: "image/png" }], timestamp: 1 }],
		};

		const events = await collectEvents(adapter.streamSimple(model(), imageContext, { apiKey: "access-secret", sessionId: "session-user-image" }));

		assert.equal(events.at(-1)?.type, "done");
		assert.equal(transport.runs.length, 1);
		assert.equal(transport.runs[0]?.request.experimentalImageInput, true);
		assert.deepEqual(transport.runs[0]?.request.context, imageContext);
	});

	test("allows historical user images while sending current image input", async () => {
		const transport = new CursorMockTransport({ messages: [{ type: "done", reason: "stop" }] });
		const adapter = new CursorStreamAdapter({ transport, uuid: () => "run-historical-user-image" });
		const imageContext: Context = {
			messages: [
				{ role: "user", content: [{ type: "image", data: "historical-image-must-not-leak", mimeType: "image/png" }], timestamp: 1 },
				{ role: "assistant", content: [{ type: "text", text: "ok" }], api: "cursor-agent", provider: "cursor", model: "composer-2", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 },
				{ role: "user", content: [{ type: "text", text: "next" }, { type: "image", data: "Y3VycmVudA==", mimeType: "image/png" }], timestamp: 3 },
			],
		};

		const events = await collectEvents(adapter.streamSimple(model(), imageContext, { apiKey: "access-secret", sessionId: "session-historical-user-image" }));

		assert.equal(events.some((event) => event.type === "error"), false);
		assert.equal(events.at(-1)?.type, "done");
		assert.equal(transport.runs.length, 1);
		assert.equal(transport.runs[0]?.request.experimentalImageInput, true);
		assert.deepEqual(transport.runs[0]?.request.context, imageContext);
	});

	test("allows text-only tool-result resumes after an image turn", async () => {
		const transport = new CursorMockTransport({ messages: [
			{ type: "toolCall", id: "tool-1", name: "Read", argumentsJson: "{\"path\":\"README.md\"}", execId: "exec-1", execNumericId: 7 },
			{ type: "done", reason: "toolUse" },
		] });
		const adapter = new CursorStreamAdapter({ transport, uuid: () => "run-resume-image-tool" });
		const imageData = "cmVzdW1lLWltYWdlLXNlbnRpbmVsLW11c3Qtbm90LWxlYWs=";
		const imageTurn = { role: "user" as const, content: [{ type: "text" as const, text: "inspect this" }, { type: "image" as const, data: imageData, mimeType: "image/png" }], timestamp: 1 };
		const firstContext: Context = { messages: [imageTurn] };

		const firstEvents = await collectEvents(adapter.streamSimple(model(), firstContext, { apiKey: "access-secret", sessionId: "session-resume-image-tool" }));

		assert.equal(firstEvents.at(-1)?.type, "done");
		const firstTerminal = firstEvents.at(-1);
		if (firstTerminal?.type === "done") assert.equal(firstTerminal.reason, "toolUse");
		assert.equal(transport.runs.length, 1);
		assert.equal(transport.runs[0]?.request.experimentalImageInput, true);
		const resumeContext: Context = {
			messages: [
				imageTurn,
				{ role: "assistant", content: [{ type: "toolCall", id: "tool-1", name: "Read", arguments: { path: "README.md" } }], api: "cursor-agent", provider: "cursor", model: "composer-2", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
				{ role: "toolResult", toolCallId: "tool-1", toolName: "Read", content: [{ type: "text", text: "file contents" }], isError: false, timestamp: 3 },
			],
		};

		const secondEvents = await collectEvents(adapter.streamSimple(model(), resumeContext, { apiKey: "access-secret", sessionId: "session-resume-image-tool" }));

		assert.equal(secondEvents.some((event) => event.type === "error"), false);
		assert.equal(secondEvents.at(-1)?.type, "done");
		assert.equal(transport.runs.length, 1);
		assert.deepEqual(transport.runs[0]?.stream.writtenToolResults, [{ toolCallId: "tool-1", toolName: "Read", text: "file contents", isError: false, execId: "exec-1", execNumericId: 7 }]);
		const serializedSecondEvents = JSON.stringify(secondEvents);
		assert.equal(serializedSecondEvents.includes(imageData), false);
		assert.doesNotMatch(serializedSecondEvents, /resume-image-sentinel-must-not-leak/u);
		assert.doesNotMatch(serializedSecondEvents, /access-secret/u);
	});

	test("rejects tool-result image input with provider fallback guidance before resume", async () => {
		class TrackingConversationState extends CursorConversationStateStore {
			resumeAttempts = 0;

			override async resumeTurnWithToolResults(conversationId: string, results: readonly CursorToolResultMessage[], options?: CursorResumeTurnOptions): Promise<CursorRunStream> {
				this.resumeAttempts += 1;
				return super.resumeTurnWithToolResults(conversationId, results, options);
			}
		}
		const transport = new CursorMockTransport();
		const conversationState = new TrackingConversationState();
		const adapter = new CursorStreamAdapter({ transport, conversationState, uuid: () => "run-tool-image" });
		const imageContext: Context = {
			messages: [{ role: "toolResult", toolCallId: "tool-1", toolName: "Read", content: [{ type: "image", data: "tool-image-must-not-leak", mimeType: "image/png" }], isError: false, timestamp: 1 }],
		};

		const events = await collectEvents(adapter.streamSimple(model(), imageContext, { apiKey: "access-secret", sessionId: "session-tool-image" }));

		const terminal = events.at(-1);
		assert.equal(terminal?.type, "error");
		if (terminal?.type === "error") {
			const message = terminal.error.errorMessage ?? "";
			assert.match(message, /text tool results only/u);
			assert.match(message, /tool-result images\/screenshots/u);
			assert.match(message, /vision-capable provider/u);
			assert.doesNotMatch(message, /access-secret/u);
			assert.doesNotMatch(message, /tool-image-must-not-leak/u);
		}
		assert.equal(transport.runs.length, 0);
		assert.equal(conversationState.resumeAttempts, 0);
	});

	test("rejects missing credentials with a terminal error", async () => {
		const adapter = new CursorStreamAdapter({ transport: new CursorMockTransport(), uuid: () => "run-error" });

		const missingCredentialEvents = await collectEvents(adapter.streamSimple(model(), context()));
		const missingTerminal = missingCredentialEvents.at(-1);
		assert.equal(missingTerminal?.type, "error");
	});
});
