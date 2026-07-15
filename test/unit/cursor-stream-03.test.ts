import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { Context } from "@earendil-works/pi-ai/compat";
import type { CursorAgentTransport, CursorRunRequest, CursorRunStream, CursorServerMessage } from "../../packages/cursor/src/transport.js";
import { CursorMockRunStream, CursorMockTransport } from "./cursor-test-helpers.js";
import type { CursorUsableModel } from "../../packages/cursor/src/model-mapper.js";
import { collectEvents, context, deferred, model, testAuthorizedRoute, TestCursorStreamAdapter as CursorStreamAdapter } from "./cursor-stream-helpers.js";

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

	test("rejects image input only when the selected model lacks image capability", async () => {
		const imageContext: Context = {
			messages: [{ role: "user", content: [{ type: "image", data: "abc", mimeType: "image/png" }], timestamp: 1 }],
		};
		const textOnlyTransport = new CursorMockTransport();
		const textOnlyAdapter = new CursorStreamAdapter({ transport: textOnlyTransport, uuid: () => "run-error" });
		const imageEvents = await collectEvents(textOnlyAdapter.streamSimple(model(), imageContext, { apiKey: "access-secret" }));
		const imageTerminal = imageEvents.at(-1);
		assert.equal(textOnlyTransport.runs.length, 0);
		assert.equal(imageTerminal?.type, "error");
		if (imageTerminal?.type === "error") {
			assert.match(imageTerminal.error.errorMessage ?? "", /does not support image input/u);
			assert.doesNotMatch(imageTerminal.error.errorMessage ?? "", /access-secret/u);
		}

		const toolImageContext: Context = {
			messages: [{ role: "toolResult", toolCallId: "tool-1", toolName: "ReadImage", content: [{ type: "image", data: "aGk=", mimeType: "image/png" }], isError: false, timestamp: 2 }],
		};
		const toolImageEvents = await collectEvents(textOnlyAdapter.streamSimple(model(), toolImageContext, { apiKey: "access-secret" }));
		const toolImageTerminal = toolImageEvents.at(-1);
		assert.equal(textOnlyTransport.runs.length, 0);
		assert.equal(toolImageTerminal?.type, "error");
		if (toolImageTerminal?.type === "error") assert.match(toolImageTerminal.error.errorMessage ?? "", /does not support image input/u);


		const historicalImageContext: Context = {
			messages: [
				{ role: "user", content: [{ type: "text", text: "prior image" }, { type: "image", data: "aGk=", mimeType: "image/png" }], timestamp: 1 },
				{ role: "assistant", content: [{ type: "text", text: "prior response" }], api: "cursor-agent", provider: "cursor", model: model().id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 },
				{ role: "user", content: "continue with text", timestamp: 3 },
			],
		};
		const historicalTransport = new CursorMockTransport({ messages: [{ type: "done", reason: "stop" }] });
		const historicalAdapter = new CursorStreamAdapter({ transport: historicalTransport, uuid: () => "run-historical-image" });
		const historicalEvents = await collectEvents(historicalAdapter.streamSimple(model(), historicalImageContext, { apiKey: "access-secret" }));
		assert.equal(historicalTransport.runs.length, 1);
		assert.equal(historicalEvents.at(-1)?.type, "done");
		await historicalAdapter.dispose();
		const imageTransport = new CursorMockTransport({ messages: [{ type: "done", reason: "stop" }] });
		const imageAdapter = new CursorStreamAdapter({
			transport: imageTransport,
			uuid: () => "run-image",
			authorizedRoutes: [testAuthorizedRoute({ supportsImages: true })],
		});
		const allowedEvents = await collectEvents(imageAdapter.streamSimple(model(), imageContext, { apiKey: "access-secret" }));
		assert.equal(imageTransport.runs.length, 1);
		assert.equal(allowedEvents.at(-1)?.type, "done");
	});

	test("reports missing credentials before image capability checks", async () => {
		const adapter = new CursorStreamAdapter({ transport: new CursorMockTransport(), uuid: () => "run-error" });
		const missingCredentialEvents = await collectEvents(adapter.streamSimple(model(), context()));
		const missingTerminal = missingCredentialEvents.at(-1);
		assert.equal(missingTerminal?.type, "error");
	});
});
