import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { Context } from "@earendil-works/pi-ai/compat";
import { CursorStreamAdapter } from "../../packages/cursor/src/stream.js";
import type { CursorAgentTransport, CursorRunRequest, CursorRunStream, CursorServerMessage } from "../../packages/cursor/src/transport.js";
import { CursorMockRunStream, CursorMockTransport, cursorRouteAuthority, cursorRouteReference } from "./cursor-test-helpers.js";
import type { CursorUsableModel } from "../../packages/cursor/src/model-mapper.js";
import { collectEvents, context, deferred, model } from "./cursor-stream-helpers.js";

describe("CursorStreamAdapter", () => {
	test("requires authoritative route ownership before an adapter can stream", () => {
		const transport = new CursorMockTransport();
		assert.throws(
			() => new CursorStreamAdapter({ transport } as never),
			(error: Error) => error.name === "CursorError" && "code" in error && error.code === "UnsupportedSelection",
		);
		assert.equal(transport.runs.length, 0);
	});

	test("rejects a fabricated official reference before transport", async () => {
		const transport = new CursorMockTransport();
		const adapter = new CursorStreamAdapter({ transport, routeAuthority: cursorRouteAuthority() });
		const events = await collectEvents(adapter.streamSimple(model(cursorRouteReference("never-discovered")), context(), { apiKey: "access-secret" }));
		assert.equal(events.at(-1)?.type, "error");
		assert.equal(transport.runs.length, 0);
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
		const adapter = new CursorStreamAdapter({ routeAuthority: cursorRouteAuthority(), transport: new IdleTransport(), uuid: () => "run-idle", streamReadTimeoutMs: 1 });

		const events = await collectEvents(adapter.streamSimple(model(), context(), { apiKey: "access-secret" }));

		const terminal = events.at(-1);
		assert.equal(terminal?.type, "error");
		if (terminal?.type === "error") {
			assert.match(terminal.error.errorMessage ?? "", /timed out/u);
			assert.doesNotMatch(terminal.error.errorMessage ?? "", /access-secret/u);
		}
		assert.deepEqual(adapter.getLifecycleSnapshot(), { openStreams: 0, cancelledStreams: 1, closedStreams: 1, activeTurns: 0 });
	});

	test("persisted restart ignores orphan tool results without inventing provider calls", async () => {
		const transport = new CursorMockTransport({ messages: [{ type: "done", reason: "stop" }] });
		const adapter = new CursorStreamAdapter({ transport, routeAuthority: cursorRouteAuthority(), uuid: () => "request-orphan" });
		const orphanContext: Context = { messages: [{ role: "toolResult", toolCallId: "missing-tool", toolName: "Read", content: [{ type: "text", text: "orphan" }], isError: false, timestamp: 1 }] };
		const events = await collectEvents(adapter.streamSimple(model(), orphanContext, { apiKey: "access-secret", sessionId: "session-missing" }));
		assert.equal(transport.runs.length, 1);
		assert.equal(events.at(-1)?.type, "done");
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
		const adapter = new CursorStreamAdapter({ transport, routeAuthority: cursorRouteAuthority(), uuid: () => "run-abort" });
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

	test("emits deterministic text to thinking to text block transitions exactly once", async () => {
		const transport = new CursorMockTransport({ messages: [
			{ type: "textDelta", text: "a" },
			{ type: "thinkingDelta", text: "b" },
			{ type: "textDelta", text: "c" },
			{ type: "done", reason: "stop" },
		] });
		const events = await collectEvents(new CursorStreamAdapter({ transport, routeAuthority: cursorRouteAuthority() }).streamSimple(model(), context(), { apiKey: "access-secret" }));
		assert.deepEqual(events.map((event) => event.type), [
			"start", "text_start", "text_delta", "text_end", "thinking_start", "thinking_delta", "thinking_end", "text_start", "text_delta", "text_end", "done",
		]);
		assert.deepEqual(events.filter((event) => event.type === "text_delta").map((event) => event.delta), ["a", "c"]);
		assert.deepEqual(events.filter((event) => event.type === "thinking_delta").map((event) => event.delta), ["b"]);
	});
	test("generation lease cancellation fences late signal-ignoring chunks after open", async () => {
		const first = deferred();
		const release = deferred();
		const generation = new AbortController();
		const transport = new CursorMockTransport({ messages: [] });
		transport.run = async (request) => {
			return new CursorMockRunStream(request.requestId, (async function* () {
				yield { type: "textDelta" as const, text: "current" };
				first.resolve();
				await release.promise;
				yield { type: "textDelta" as const, text: "stale" };
				yield { type: "done" as const, reason: "stop" as const };
			})(), () => undefined, () => undefined);
		};
		const adapter = new CursorStreamAdapter({
			transport,
			routeAuthority: { acquireRequestLease: () => ({
				signal: generation.signal,
				assertCurrent: () => { if (generation.signal.aborted) throw new Error("stale generation"); },
			}) },
		});
		const eventsPromise = collectEvents(adapter.streamSimple(model(), context(), { apiKey: "access-secret" }));
		await first.promise;
		generation.abort();
		release.resolve();
		const events = await eventsPromise;
		assert.deepEqual(events.filter((event) => event.type === "text_delta").map((event) => event.delta), ["current"]);
		assert.equal(events.filter((event) => event.type === "error").length, 1);
		assert.equal(events.filter((event) => event.type === "done").length, 0);
	});

	test("closes a stream returned after route invalidation but before registration", async () => {
		const release = deferred();
		const generation = new AbortController();
		let closes = 0;
		let cancels = 0;
		const transport = new CursorMockTransport();
		transport.run = async (request) => {
			await release.promise;
			return new CursorMockRunStream(request.requestId, (async function* () {})(), () => { cancels += 1; }, () => { closes += 1; });
		};
		const adapter = new CursorStreamAdapter({
			transport,
			routeAuthority: { acquireRequestLease: () => ({
				signal: generation.signal,
				assertCurrent: () => { if (generation.signal.aborted) throw new Error("stale generation"); },
			}) },
		});
		const eventsPromise = collectEvents(adapter.streamSimple(model(), context(), { apiKey: "access-secret" }));
		generation.abort();
		release.resolve();
		const events = await eventsPromise;
		assert.equal(events.at(-1)?.type, "error");
		assert.deepEqual({ closes, cancels }, { closes: 1, cancels: 1 });
	});
	test("rejects current user and live tool-result images even when a forged model advertises image input", async () => {
		const imageContext: Context = { messages: [{ role: "user", content: [{ type: "text", text: "caption" }, { type: "image", data: "abc", mimeType: "image/png" }], timestamp: 1 }] };
		const transport = new CursorMockTransport();
		const adapter = new CursorStreamAdapter({ transport, routeAuthority: cursorRouteAuthority(), uuid: () => "run-error" });
		for (const candidate of [model(), { ...model(), input: ["text", "image"] as ("text" | "image")[] }]) {
			const events = await collectEvents(adapter.streamSimple(candidate, imageContext, { apiKey: "access-secret" }));
			const terminal = events.at(-1);
			assert.equal(terminal?.type, "error");
			if (terminal?.type === "error") {
				assert.match(terminal.error.errorMessage ?? "", /text only|images are unsupported/iu);
				assert.doesNotMatch(terminal.error.errorMessage ?? "", /access-secret/u);
			}
		}
		const toolImageContext: Context = { messages: [{ role: "toolResult", toolCallId: "tool-1", toolName: "ReadImage", content: [{ type: "text", text: "caption" }, { type: "image", data: "aGk=", mimeType: "image/png" }], isError: false, timestamp: 2 }] };
		const toolEvents = await collectEvents(adapter.streamSimple(model(), toolImageContext, { apiKey: "access-secret" }));
		assert.equal(toolEvents.at(-1)?.type, "error");
		assert.equal(transport.runs.length, 0);
	});

	test("reports missing credentials before image capability checks", async () => {
		const adapter = new CursorStreamAdapter({ routeAuthority: cursorRouteAuthority(), transport: new CursorMockTransport(), uuid: () => "run-error" });
		const missingCredentialEvents = await collectEvents(adapter.streamSimple(model(), context()));
		const missingTerminal = missingCredentialEvents.at(-1);
		assert.equal(missingTerminal?.type, "error");
	});
});
