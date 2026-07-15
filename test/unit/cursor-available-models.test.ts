import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { CursorModelDiscoveryError, CursorModelDiscoveryService } from "../../packages/cursor/src/models.js";
import {
	AgentClientMessageSchema,
	GetUsableModelsResponseSchema,
	ModelDetailsSchema,
} from "../../packages/cursor/src/proto/agent_pb.js";
import {
	CursorProtobufProtocolCodec,
	Http2CursorAgentTransport,
	type CursorAgentTransport,
	type CursorHttp2Client,
	type CursorHttp2StreamHandle,
	type CursorRunRequest,
	type CursorRunStream,
} from "../../packages/cursor/src/transport.js";
import { cursorProtoTest } from "./cursor-proto-test-helpers.js";

const GET_USABLE_PATH = "/agent.v1.AgentService/GetUsableModels";
const AVAILABLE_PATH = "/aiserver.v1.AiService/AvailableModels";

function getUsableBody(models: ReadonlyArray<{ id: string; displayName?: string; maxMode?: boolean }>): Uint8Array {
	return toBinary(GetUsableModelsResponseSchema, create(GetUsableModelsResponseSchema, {
		models: models.map((model) => create(ModelDetailsSchema, {
			modelId: model.id,
			displayName: model.displayName ?? "",
			maxMode: model.maxMode ?? false,
		})),
	}));
}

function availableParent(options: {
	readonly id?: string;
	readonly serverModelName?: string;
	readonly supportsImages?: boolean;
	readonly variantIds?: readonly string[];
}): Uint8Array {
	const variants = (options.variantIds ?? []).map((id) => cursorProtoTest.encodeMessageField(30, cursorProtoTest.concatBytes(
		cursorProtoTest.encodeMessageField(1, cursorProtoTest.concatBytes(
			cursorProtoTest.encodeStringField(1, "effort"),
			cursorProtoTest.encodeStringField(2, "high"),
		)),
		cursorProtoTest.encodeStringField(9, id),
	)));
	const model = cursorProtoTest.concatBytes(
		...(options.id ? [cursorProtoTest.encodeStringField(1, options.id)] : []),
		...(options.supportsImages === undefined ? [] : [cursorProtoTest.encodeVarintField(10, options.supportsImages ? 1n : 0n)]),
		...(options.serverModelName ? [cursorProtoTest.encodeStringField(18, options.serverModelName)] : []),
		...variants,
		// Obsolete routing metadata must be skipped rather than retained.
		cursorProtoTest.encodeVarintField(14, 1n),
		cursorProtoTest.encodeVarintField(15, 999_999n),
	);
	return cursorProtoTest.encodeMessageField(2, model);
}

class UnaryClient implements CursorHttp2Client {
	readonly paths: string[] = [];
	constructor(readonly bodies: Readonly<Record<string, Uint8Array>>) {}
	async requestUnary(request: { readonly path: string }): Promise<{ readonly statusCode: number; readonly body: Uint8Array; readonly headers: Record<string, string> }> {
		this.paths.push(request.path);
		return { statusCode: 200, body: this.bodies[request.path] ?? new Uint8Array(), headers: {} };
	}
	async openStream(): Promise<CursorHttp2StreamHandle> { throw new Error("not used") }
	async dispose(): Promise<void> {}
}

class DiscoveryTransport implements CursorAgentTransport {
	readonly calls: Array<{ readonly operation: "usable" | "available"; readonly accessToken: string }> = [];
	constructor(
		readonly usable: Awaited<ReturnType<CursorAgentTransport["getUsableModels"]>>,
		readonly available: Awaited<ReturnType<NonNullable<CursorAgentTransport["getAvailableModels"]>>>,
		readonly availableFailure?: Error,
	) {}
	async getUsableModels(accessToken: string): Promise<typeof this.usable> {
		this.calls.push({ operation: "usable", accessToken });
		return this.usable;
	}
	async getAvailableModels(accessToken: string): Promise<typeof this.available> {
		this.calls.push({ operation: "available", accessToken });
		if (this.availableFailure) throw this.availableFailure;
		return this.available;
	}
	async run(_request: CursorRunRequest): Promise<CursorRunStream> { throw new Error("not used") }
	async dispose(): Promise<void> {}
	getLifecycleSnapshot() { return { openStreams: 0, cancelledStreams: 0, closedStreams: 0 } }
}

interface Deferred<T> {
	readonly promise: Promise<T>;
	resolve(value: T): void;
	reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

type UsableModels = Awaited<ReturnType<CursorAgentTransport["getUsableModels"]>>;
type AvailableModels = Awaited<ReturnType<NonNullable<CursorAgentTransport["getAvailableModels"]>>>;

function awaitAbortable<T>(pending: Deferred<T>, signal: AbortSignal | undefined, onAbort: () => void): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const aborted = (): void => { onAbort(); reject(new Error("aborted by test")); };
		if (signal?.aborted) {
			aborted();
			return;
		}
		signal?.addEventListener("abort", aborted, { once: true });
		pending.promise.then(
			(value) => { signal?.removeEventListener("abort", aborted); resolve(value); },
			(error: Error) => { signal?.removeEventListener("abort", aborted); reject(error); },
		);
	});
}

class AbortAwareDiscoveryTransport implements CursorAgentTransport {
	readonly usable = deferred<UsableModels>();
	readonly available = deferred<AvailableModels>();
	usableStarts = 0;
	availableStarts = 0;
	usableAborts = 0;
	availableAborts = 0;

	getUsableModels(_accessToken: string, _requestId: string, signal?: AbortSignal): Promise<UsableModels> {
		this.usableStarts += 1;
		return awaitAbortable(this.usable, signal, () => { this.usableAborts += 1; });
	}
	getAvailableModels(_accessToken: string, _requestId: string, signal?: AbortSignal): Promise<AvailableModels> {
		this.availableStarts += 1;
		return awaitAbortable(this.available, signal, () => { this.availableAborts += 1; });
	}
	async run(_request: CursorRunRequest): Promise<CursorRunStream> { throw new Error("not used") }
	async dispose(): Promise<void> {}
	getLifecycleSnapshot() { return { openStreams: 0, cancelledStreams: 0, closedStreams: 0 } }
}

describe("Cursor split catalog discovery", () => {
	test("GetUsable transport calls only AgentService and Available transport calls only AiService", async () => {
		const client = new UnaryClient({
			[GET_USABLE_PATH]: getUsableBody([
				{ id: "", displayName: "", maxMode: false },
				{ id: "   ", displayName: "  ", maxMode: true },
				{ id: "cursor-grok-4.5-high", maxMode: true },
				{ id: "cursor-grok-4.5-high", displayName: "Duplicate", maxMode: false },
			]),
			[AVAILABLE_PATH]: availableParent({ id: "cursor-grok-4.5-high", supportsImages: true }),
		});
		const transport = new Http2CursorAgentTransport({ client });
		const usable = await transport.getUsableModels("secret", "usable");
		assert.deepEqual(client.paths, [GET_USABLE_PATH]);
		assert.deepEqual(usable, [
			{ id: "", maxMode: false },
			{ id: "   ", displayName: "  ", maxMode: true },
			{ id: "cursor-grok-4.5-high", maxMode: true },
			{ id: "cursor-grok-4.5-high", displayName: "Duplicate", maxMode: false },
		]);

		const available = await transport.getAvailableModels("secret", "available");
		assert.deepEqual(client.paths, [GET_USABLE_PATH, AVAILABLE_PATH]);
		assert.deepEqual(available, [{ id: "cursor-grok-4.5-high", variantIds: [], supportsImages: true }]);
	});

	test("Available decoder retains only exact identity keys and explicit image support", () => {
		const codec = new CursorProtobufProtocolCodec();
		const decoded = codec.decodeAvailableModelsResponse(availableParent({
			id: " parent-id ",
			serverModelName: " server-id ",
			supportsImages: true,
			variantIds: [" flat-high ", "flat-high"],
		}));
		assert.deepEqual(decoded, [{
			id: " parent-id ",
			serverModelName: " server-id ",
			variantIds: [" flat-high ", "flat-high"],
			supportsImages: true,
		}]);
	});

	test("GetUsable alone fixes byte-for-byte route identity, row order, display, Max, and duplicate occurrences", async () => {
		const transport = new DiscoveryTransport([
			{ id: " route-high ", displayName: "Old", maxMode: false },
			{ id: "route-high", displayName: "Route High", maxMode: true },
			{ id: " route-high ", displayName: "Whitespace Route", maxMode: true },
			{ id: "route-low", displayName: "Route Low", maxMode: false },
		], [
			{ id: "available-only", variantIds: [], supportsImages: true },
			{ id: "different-parent", serverModelName: "route-high", variantIds: [], supportsImages: true },
		]);
		const catalog = await new CursorModelDiscoveryService({ transport, now: () => 42 }).discover("same-account-token", "request");

		assert.deepEqual(catalog.models, [
			{ id: " route-high ", displayName: "Old", maxMode: false },
			{ id: "route-high", displayName: "Route High", maxMode: true, supportsImages: true },
			{ id: " route-high ", displayName: "Whitespace Route", maxMode: true },
			{ id: "route-low", displayName: "Route Low", maxMode: false },
		]);
		assert.deepEqual(transport.calls, [
			{ operation: "available", accessToken: "same-account-token" },
			{ operation: "usable", accessToken: "same-account-token" },
		]);
	});

	test("image support requires nonempty exact evidence with every matching parent explicitly true", async () => {
		const transport = new DiscoveryTransport([
			{ id: "one-true", maxMode: false },
			{ id: "duplicate-true", maxMode: false },
			{ id: "distinct-true", maxMode: false },
			{ id: "true-false", maxMode: false },
			{ id: "true-missing", maxMode: false },
			{ id: "all-missing", maxMode: false },
			{ id: "multi-field", maxMode: false },
			{ id: "duplicate-usable", displayName: "first", maxMode: false },
			{ id: "duplicate-usable", displayName: "second", maxMode: true },
			{ id: "gpt-family-name-is-not-evidence", maxMode: false },
		], [
			{ id: "one-true", variantIds: [], supportsImages: true },
			{ id: "duplicate-true", variantIds: [], supportsImages: true },
			{ id: "duplicate-true", variantIds: [], supportsImages: true },
			{ id: "parent-a", variantIds: ["distinct-true"], supportsImages: true },
			{ serverModelName: "distinct-true", variantIds: [], supportsImages: true },
			{ id: "true-false", variantIds: [], supportsImages: true },
			{ serverModelName: "true-false", variantIds: [], supportsImages: false },
			{ id: "true-missing", variantIds: [], supportsImages: true },
			{ serverModelName: "true-missing", variantIds: [] },
			{ id: "all-missing", variantIds: [] },
			{ id: "multi-field", serverModelName: "multi-field", variantIds: ["multi-field"], supportsImages: true },
			{ id: "duplicate-usable", variantIds: [], supportsImages: true },
			{ id: "available-only", variantIds: [], supportsImages: true },
		]);
		const catalog = await new CursorModelDiscoveryService({ transport }).discover("account", "request");
		assert.deepEqual(catalog.models.map((model) => [model.id, model.displayName, model.supportsImages === true]), [
			["one-true", undefined, true],
			["duplicate-true", undefined, true],
			["distinct-true", undefined, true],
			["true-false", undefined, false],
			["true-missing", undefined, false],
			["all-missing", undefined, false],
			["multi-field", undefined, true],
			["duplicate-usable", "first", true],
			["duplicate-usable", "second", true],
			["gpt-family-name-is-not-evidence", undefined, false],
		]);
	});

	test("Available failure does not block authoritative text routes", async () => {
		const transport = new DiscoveryTransport(
			[{ id: "text-route", displayName: "Text Route", maxMode: false }],
			[],
			new Error("AvailableModels unavailable"),
		);
		const catalog = await new CursorModelDiscoveryService({ transport }).discover("account", "request");
		assert.deepEqual(catalog.models, [{ id: "text-route", displayName: "Text Route", maxMode: false }]);
	});

	test("starts both calls concurrently and enriches metadata that arrives within the default grace", async () => {
		const transport = new AbortAwareDiscoveryTransport();
		const task = new CursorModelDiscoveryService({ transport }).discover("account", "request");
		assert.equal(transport.usableStarts, 1);
		assert.equal(transport.availableStarts, 1);
		transport.usable.resolve([{ id: "image-route", maxMode: false }]);
		await Promise.resolve();
		transport.available.resolve([{ id: "image-route", variantIds: [], supportsImages: true }]);
		const catalog = await task;
		assert.deepEqual(catalog.models, [{ id: "image-route", maxMode: false, supportsImages: true }]);
		assert.equal(transport.usableAborts, 0);
		assert.equal(transport.availableAborts, 0);
	});

	test("the default grace returns text routes and aborts a timed-out Available call exactly once", async () => {
		const transport = new AbortAwareDiscoveryTransport();
		const task = new CursorModelDiscoveryService({ transport }).discover("account", "request");
		transport.usable.resolve([{ id: "prompt-text-route", maxMode: false }]);
		const catalog = await task;
		assert.deepEqual(catalog.models, [{ id: "prompt-text-route", maxMode: false }]);
		assert.equal(transport.availableAborts, 1);
		assert.equal(transport.usableAborts, 0);
	});

	test("caller cancellation aborts both concurrent discovery calls and rejects", async () => {
		const transport = new AbortAwareDiscoveryTransport();
		const controller = new AbortController();
		const task = new CursorModelDiscoveryService({ transport }).discover("account", "request", controller.signal);
		assert.equal(transport.usableStarts, 1);
		assert.equal(transport.availableStarts, 1);
		controller.abort();
		await assert.rejects(task, (error: Error) => {
			assert.ok(error instanceof CursorModelDiscoveryError);
			assert.equal(error.code, "Aborted");
			return true;
		});
		assert.equal(transport.usableAborts, 1);
		assert.equal(transport.availableAborts, 1);
	});

	test("contains a late Available rejection after the grace has elapsed", async () => {
		const lateAvailable = deferred<AvailableModels>();
		let lateCallStarted = false;
		const transport: CursorAgentTransport = {
			async getUsableModels() { return [{ id: "text-route", maxMode: false }]; },
			getAvailableModels() { lateCallStarted = true; return lateAvailable.promise; },
			async run() { throw new Error("not used"); },
			async dispose() {},
			getLifecycleSnapshot() { return { openStreams: 0, cancelledStreams: 0, closedStreams: 0 }; },
		};
		const catalog = await new CursorModelDiscoveryService({ transport, imageMetadataGraceMs: 1 }).discover("account", "request");
		assert.equal(lateCallStarted, true);
		assert.deepEqual(catalog.models, [{ id: "text-route", maxMode: false }]);
		lateAvailable.reject(new Error("late Available failure"));
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
});

describe("Cursor exact request encoding", () => {
	test("sends the exact flat id, dual Max, and no parameters", () => {
		const exactId = " cursor-grok-4.5-high ";
		const model: Model<Api> = {
			id: exactId,
			name: "Grok High",
			provider: "cursor",
			api: "cursor-agent",
			baseUrl: "https://api2.cursor.sh",
			input: ["text"],
			reasoning: false,
			contextWindow: 200_000,
			maxTokens: 64_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		const encoded = new CursorProtobufProtocolCodec().encodeRunRequest({
			accessToken: "secret",
			requestId: "request",
			model,
			resolvedModelId: exactId,
			maxMode: true,
			context: { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
		});
		const decoded = fromBinary(AgentClientMessageSchema, encoded);
		assert.equal(decoded.message.case, "runRequest");
		if (decoded.message.case !== "runRequest") throw new Error("expected run request");
		assert.equal(decoded.message.value.modelDetails?.modelId, exactId);
		assert.equal(decoded.message.value.modelDetails?.maxMode, true);
		assert.equal(decoded.message.value.requestedModel?.modelId, exactId);
		assert.equal(decoded.message.value.requestedModel?.maxMode, true);
		assert.deepEqual(decoded.message.value.requestedModel?.parameters, []);
	});

	test("sets non-Max false in both model structures and still emits no parameters", () => {
		const model: Model<Api> = {
			id: "cursor-grok-4.5-low", name: "Grok Low", provider: "cursor", api: "cursor-agent",
			baseUrl: "https://api2.cursor.sh", input: ["text"], reasoning: false,
			contextWindow: 200_000, maxTokens: 64_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		const decoded = fromBinary(AgentClientMessageSchema, new CursorProtobufProtocolCodec().encodeRunRequest({
			accessToken: "secret", requestId: "request-low", model,
			resolvedModelId: "cursor-grok-4.5-low", maxMode: false,
			context: { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
		}));
		assert.equal(decoded.message.case, "runRequest");
		if (decoded.message.case !== "runRequest") throw new Error("expected run request");
		assert.equal(decoded.message.value.modelDetails?.maxMode, false);
		assert.equal(decoded.message.value.requestedModel?.maxMode, false);
		assert.deepEqual(decoded.message.value.requestedModel?.parameters, []);
	});
});
