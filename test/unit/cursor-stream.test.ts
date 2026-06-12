import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { Api, AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";
import { CursorStreamAdapter } from "../../packages/cursor/src/stream.js";
import {
	CursorMockRunStream,
	CursorMockTransport,
	type CursorAgentTransport,
	type CursorRunRequest,
	type CursorRunStream,
	type CursorServerMessage,
} from "../../packages/cursor/src/transport.js";
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

describe("CursorStreamAdapter", () => {
	test("maps fake Cursor text, thinking, tool-call, usage, and done messages to streamSimple events", async () => {
		const transport = new CursorMockTransport({
			messages: [
				{ type: "thinkingDelta", text: "plan" },
				{ type: "textDelta", text: "Hello" },
				{ type: "textDelta", text: " world" },
				{ type: "toolCall", id: "tool-1", name: "Read", argumentsJson: "{\"path\":\"README.md\"}" },
				{ type: "usage", inputTokens: 10, outputTokens: 5 },
				{ type: "done", reason: "toolUse" },
			],
		});
		const adapter = new CursorStreamAdapter({ transport, uuid: () => "run-1" });
		const events = await collectEvents(adapter.streamSimple(model(), context(), { apiKey: "access-secret", reasoning: "high" }));

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
			assert.equal(done.message.usage.totalTokens, 15);
			assert.ok(Math.abs(done.message.usage.cost.total - 0.00002) < 0.000000001);
		}
		assert.equal(transport.runs[0]?.request.resolvedModelId, "composer-2-high");
		assert.deepEqual(transport.getLifecycleSnapshot(), { openStreams: 0, cancelledStreams: 0, closedStreams: 1 });
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
