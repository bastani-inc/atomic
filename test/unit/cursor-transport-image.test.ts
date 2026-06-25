import { Buffer } from "node:buffer";
import { fromBinary } from "@bufbuild/protobuf";
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai";
import { AgentClientMessageSchema, type SelectedImage } from "../../packages/cursor/src/proto/agent_pb.js";
import {
	CursorProtobufProtocolCodec,
	CursorTransportError,
	Http2CursorAgentTransport,
	type CursorHttp2Client,
	type CursorHttp2StreamHandle,
} from "../../packages/cursor/src/transport.js";

class FakeStreamHandle implements CursorHttp2StreamHandle {
	readonly writes: Uint8Array[] = [];
	readonly frames: AsyncIterable<Uint8Array>;
	closed = false;
	cancelled = false;

	constructor(frames: readonly Uint8Array[] = []) {
		this.frames = (async function* (): AsyncIterable<Uint8Array> {
			for (const frame of frames) yield frame;
		})();
	}

	async write(data: Uint8Array): Promise<void> {
		this.writes.push(data);
	}

	async close(): Promise<void> {
		this.closed = true;
	}

	async cancel(): Promise<void> {
		this.cancelled = true;
	}
}

class FakeHttp2Client implements CursorHttp2Client {
	streamRequests: Array<{ path: string; headers: Record<string, string> }> = [];
	streamHandle = new FakeStreamHandle();

	async requestUnary(): Promise<{ readonly body: Uint8Array; readonly headers: Record<string, string>; readonly statusCode?: number }> {
		return { statusCode: 200, body: new Uint8Array(), headers: {} };
	}

	async openStream(request: { readonly path: string; readonly headers: Record<string, string>; readonly initialBody?: Uint8Array }): Promise<CursorHttp2StreamHandle> {
		this.streamRequests.push({ path: request.path, headers: request.headers });
		if (request.initialBody) await this.streamHandle.write(request.initialBody);
		return this.streamHandle;
	}

	async dispose(): Promise<void> {}
}

const model: Model<Api> = {
	id: "composer-2",
	name: "Composer 2",
	provider: "cursor",
	api: "cursor-agent" as Api,
	baseUrl: "https://api2.cursor.sh",
	input: ["text"],
	reasoning: false,
	contextWindow: 200_000,
	maxTokens: 64_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function decodeRunUserMessage(data: Uint8Array) {
	const clientMessage = fromBinary(AgentClientMessageSchema, data);
	if (clientMessage.message.case !== "runRequest") assert.fail("expected runRequest");
	const action = clientMessage.message.value.action;
	if (!action || action.action.case !== "userMessageAction") assert.fail("expected userMessageAction");
	const { userMessage } = action.action.value;
	if (!userMessage) assert.fail("expected userMessage");
	return userMessage;
}

function selectedImageData(image: SelectedImage | undefined): Uint8Array {
	if (!image) assert.fail("expected selected image");
	if (image.dataOrBlobId.case !== "data") assert.fail("expected selected image inline data");
	return image.dataOrBlobId.value;
}

describe("Cursor HTTP2 image transport boundary", () => {
	test("protobuf codec encodes current user images as inline Cursor selected images without changing text", () => {
		const codec = new CursorProtobufProtocolCodec();
		const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
		const encodedRun = codec.encodeRunRequest({
			accessToken: "secret-token-that-must-not-appear",
			requestId: "run-image",
			model,
			resolvedModelId: "composer-2",
			experimentalImageInput: true,
			context: {
				systemPrompt: "system prompt",
				messages: [{
					role: "user",
					content: [
						{ type: "text", text: "describe without mutation" },
						{ type: "image", data: Buffer.from(pngBytes).toString("base64"), mimeType: "image/png" },
					],
					timestamp: 1,
				}],
			},
		});

		const decodedText = new TextDecoder().decode(encodedRun);
		assert.equal(decodedText.includes("secret-token-that-must-not-appear"), false);
		assert.equal(decodedText.includes(Buffer.from(pngBytes).toString("base64")), false);
		const userMessage = decodeRunUserMessage(encodedRun);
		assert.equal(userMessage.text, "describe without mutation");
		const selectedImages = userMessage.selectedContext?.selectedImages ?? [];
		assert.equal(selectedImages.length, 1);
		assert.equal(selectedImages[0]?.mimeType, "image/png");
		assert.deepEqual([...selectedImageData(selectedImages[0])], [...pngBytes]);
	});

	test("protobuf codec rejects current user images without serialization opt-in", () => {
		const codec = new CursorProtobufProtocolCodec();
		assert.throws(
			() => codec.encodeRunRequest({
				accessToken: "secret-token-that-must-not-appear",
				requestId: "run-image-rejected",
				model,
				resolvedModelId: "composer-2",
				context: {
					messages: [{ role: "user", content: [{ type: "image", data: "image-bytes-must-not-leak", mimeType: "image/png" }], timestamp: 1 }],
				},
			}),
			(error: Error) => {
				assert.match(error.message, /explicit opt-in/u);
				assert.doesNotMatch(error.message, /secret-token-that-must-not-appear/u);
				assert.doesNotMatch(error.message, /image-bytes-must-not-leak/u);
				return true;
			},
		);
	});

	test("protobuf codec allows historical user images while serializing only current images", () => {
		const codec = new CursorProtobufProtocolCodec();
		const currentFirstImage = new Uint8Array([1, 2, 3]);
		const currentSecondImage = new Uint8Array([4, 5, 6]);
		const encodedRun = codec.encodeRunRequest({
			accessToken: "secret-token-that-must-not-appear",
			requestId: "run-historical-image-allowed",
			model,
			resolvedModelId: "composer-2",
			experimentalImageInput: true,
			context: {
				messages: [
					{ role: "user", content: [{ type: "text", text: "historical text" }, { type: "image", data: "historical-image-is-not-base64", mimeType: "image/png" }], timestamp: 1 },
					{ role: "assistant", content: [{ type: "text", text: "historical answer" }], api: "cursor-agent", provider: "cursor", model: "composer-2", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 },
					{ role: "user", content: [{ type: "text", text: "current text" }, { type: "image", data: Buffer.from(currentFirstImage).toString("base64"), mimeType: "image/png" }, { type: "image", data: Buffer.from(currentSecondImage).toString("base64"), mimeType: "image/png" }], timestamp: 3 },
				],
			},
		});

		const selectedImages = decodeRunUserMessage(encodedRun).selectedContext?.selectedImages ?? [];
		assert.equal(selectedImages.length, 2);
		assert.deepEqual([...selectedImageData(selectedImages[0])], [...currentFirstImage]);
		assert.deepEqual([...selectedImageData(selectedImages[1])], [...currentSecondImage]);
	});

	test("protobuf codec serializes all images from the trailing user-message run", () => {
		const codec = new CursorProtobufProtocolCodec();
		const firstImage = new Uint8Array([9, 8, 7]);
		const secondImage = new Uint8Array([6, 5, 4]);
		const encodedRun = codec.encodeRunRequest({
			accessToken: "secret-token-that-must-not-appear",
			requestId: "run-trailing-user-images",
			model,
			resolvedModelId: "composer-2",
			experimentalImageInput: true,
			context: {
				messages: [
					{ role: "user", content: "historical text", timestamp: 1 },
					{ role: "assistant", content: [{ type: "text", text: "ok" }], api: "cursor-agent", provider: "cursor", model: "composer-2", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 },
					{ role: "user", content: [{ type: "text", text: "first current" }, { type: "image", data: Buffer.from(firstImage).toString("base64"), mimeType: "image/png" }], timestamp: 3 },
					{ role: "user", content: [{ type: "text", text: "second current" }, { type: "image", data: Buffer.from(secondImage).toString("base64"), mimeType: "image/png" }], timestamp: 4 },
				],
			},
		});

		const userMessage = decodeRunUserMessage(encodedRun);
		assert.equal(userMessage.text, "first current\nsecond current");
		const selectedImages = userMessage.selectedContext?.selectedImages ?? [];
		assert.equal(selectedImages.length, 2);
		assert.deepEqual([...selectedImageData(selectedImages[0])], [...firstImage]);
		assert.deepEqual([...selectedImageData(selectedImages[1])], [...secondImage]);
	});

	test("protobuf codec rejects tool-result images anywhere in context under serialization opt-in without leaking payloads", () => {
		const codec = new CursorProtobufProtocolCodec();
		assert.throws(
			() => codec.encodeRunRequest({
				accessToken: "secret-token-that-must-not-appear",
				requestId: "run-tool-image-rejected",
				model,
				resolvedModelId: "composer-2",
				experimentalImageInput: true,
				context: {
					messages: [
						{ role: "user", content: "first", timestamp: 1 },
						{ role: "toolResult", toolCallId: "tool-1", toolName: "Read", content: [{ type: "text", text: "tool text must not leak" }, { type: "image", data: "tool-image-must-not-leak", mimeType: "image/png" }], isError: false, timestamp: 2 },
						{ role: "user", content: "current text", timestamp: 3 },
					],
				},
			}),
			(error: Error) => {
				assert.match(error.message, /tool-result images/u);
				assert.doesNotMatch(error.message, /secret-token-that-must-not-appear/u);
				assert.doesNotMatch(error.message, /tool-image-must-not-leak/u);
				assert.doesNotMatch(error.message, /tool text must not leak/u);
				return true;
			},
		);
	});

	test("transport allows historical user images before opening a Cursor stream", async () => {
		const client = new FakeHttp2Client();
		const transport = new Http2CursorAgentTransport({ client });

		const stream = await transport.run({
			accessToken: "secret-token-that-must-not-appear",
			requestId: "run-transport-historical-image",
			model,
			resolvedModelId: "composer-2",
			experimentalImageInput: true,
			context: {
				messages: [
					{ role: "user", content: [{ type: "image", data: "historical-transport-image-is-not-base64", mimeType: "image/png" }], timestamp: 1 },
					{ role: "assistant", content: [{ type: "text", text: "ok" }], api: "cursor-agent", provider: "cursor", model: "composer-2", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 },
					{ role: "user", content: "current text", timestamp: 3 },
				],
			},
		});

		assert.equal(client.streamRequests.length, 1);
		assert.equal(client.streamHandle.writes.length, 1);
		await stream.close();
	});

	test("transport rejects tool-result images before opening a Cursor stream", async () => {
		const client = new FakeHttp2Client();
		const transport = new Http2CursorAgentTransport({ client });

		await assert.rejects(
			() => transport.run({
				accessToken: "secret-token-that-must-not-appear",
				requestId: "run-transport-tool-image",
				model,
				resolvedModelId: "composer-2",
				experimentalImageInput: true,
				context: {
					messages: [
						{ role: "user", content: "first", timestamp: 1 },
						{ role: "toolResult", toolCallId: "tool-1", toolName: "Read", content: [{ type: "image", data: "tool-transport-image-must-not-leak", mimeType: "image/png" }], isError: false, timestamp: 2 },
						{ role: "user", content: "current text", timestamp: 3 },
					],
				},
			}),
			(error: Error) => {
				assert.ok(error instanceof CursorTransportError);
				assert.equal(error.code, "ProtocolError");
				assert.match(error.message, /tool-result images/u);
				assert.doesNotMatch(error.message, /secret-token-that-must-not-appear/u);
				assert.doesNotMatch(error.message, /tool-transport-image-must-not-leak/u);
				return true;
			},
		);
		assert.equal(client.streamRequests.length, 0);
		assert.equal(client.streamHandle.writes.length, 0);
	});

	test("protobuf codec accepts parameterized image data URLs under serialization opt-in", () => {
		const codec = new CursorProtobufProtocolCodec();
		const pngBytes = new Uint8Array([0, 1, 2, 3]);
		const encodedRun = codec.encodeRunRequest({
			accessToken: "secret-token-that-must-not-appear",
			requestId: "run-parameterized-image-url",
			model,
			resolvedModelId: "composer-2",
			experimentalImageInput: true,
			context: {
				messages: [{
					role: "user",
					content: [
						{ type: "image", data: `data:image/png;name=tiny.png;base64,${Buffer.from(pngBytes).toString("base64")}`, mimeType: "image/png" },
						{ type: "image", data: `data:;base64,${Buffer.from([4, 5]).toString("base64")}`, mimeType: "image/png" },
					],
					timestamp: 1,
				}],
			},
		});

		const selectedImages = decodeRunUserMessage(encodedRun).selectedContext?.selectedImages ?? [];
		assert.equal(selectedImages.length, 2);
		assert.deepEqual([...selectedImageData(selectedImages[0])], [...pngBytes]);
		assert.deepEqual([...selectedImageData(selectedImages[1])], [4, 5]);
	});

	test("protobuf codec accepts ASCII-whitespace-wrapped image base64", () => {
		const codec = new CursorProtobufProtocolCodec();
		const firstBytes = new Uint8Array([6, 7, 8, 9]);
		const secondBytes = new Uint8Array([10, 11, 12]);
		const firstWrapped = Buffer.from(firstBytes).toString("base64").replace("IC", "I\r\n\tC");
		const secondWrapped = Buffer.from(secondBytes).toString("base64").replace("C", "C \f\v");
		const encodedRun = codec.encodeRunRequest({
			accessToken: "secret-token-that-must-not-appear",
			requestId: "run-wrapped-image-base64",
			model,
			resolvedModelId: "composer-2",
			experimentalImageInput: true,
			context: {
				messages: [{
					role: "user",
					content: [
						{ type: "image", data: `data:image/png;base64,${firstWrapped}`, mimeType: "image/png" },
						{ type: "image", data: secondWrapped, mimeType: "image/png" },
					],
					timestamp: 1,
				}],
			},
		});

		const selectedImages = decodeRunUserMessage(encodedRun).selectedContext?.selectedImages ?? [];
		assert.equal(selectedImages.length, 2);
		assert.deepEqual([...selectedImageData(selectedImages[0])], [...firstBytes]);
		assert.deepEqual([...selectedImageData(selectedImages[1])], [...secondBytes]);
	});

	test("protobuf codec rejects malformed image base64 and data URLs without leaking payloads", () => {
		const cases = [
			"%%%%malformed-image-payload%%%%",
			"abcde",
			"YQ=Q",
			" \t\r\n\f\v ",
			"data:image/png;base64,%%%%malformed-data-url%%%%",
			"data:image/png,not-base64",
			"data:image/png;base64",
		];
		for (const data of cases) {
			const codec = new CursorProtobufProtocolCodec();
			assert.throws(
				() => codec.encodeRunRequest({
					accessToken: "secret-token-that-must-not-appear",
					requestId: "run-malformed-image",
					model,
					resolvedModelId: "composer-2",
					experimentalImageInput: true,
					context: {
						messages: [{ role: "user", content: [{ type: "image", data, mimeType: "image/png" }], timestamp: 1 }],
					},
				}),
				(error: Error) => {
					assert.match(error.message, /not valid base64\/data URL base64/u);
					assert.doesNotMatch(error.message, /secret-token-that-must-not-appear/u);
					assert.doesNotMatch(error.message, /malformed-image-payload/u);
					assert.doesNotMatch(error.message, /malformed-data-url/u);
					assert.doesNotMatch(error.message, /not-base64/u);
					return true;
				},
			);
		}
	});
});
