import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { fromBinary } from "@bufbuild/protobuf";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { CursorProtobufProtocolCodec } from "../../packages/cursor/src/proto/protobuf-codec.js";
import { Http2CursorAgentTransport } from "../../packages/cursor/src/transport-http2.js";
import type { CursorHttp2Client, CursorProtocolCodec } from "../../packages/cursor/src/transport-types.js";
import { AgentClientMessageSchema } from "../../packages/cursor/src/proto/agent_pb.js";
import { cursorProtoTest } from "./cursor-proto-test-helpers.js";

function availableModelsFixture(): Uint8Array {
	const parameter = cursorProtoTest.concatBytes(
		cursorProtoTest.encodeStringField(1, "reasoning"),
		cursorProtoTest.encodeStringField(2, "high"),
	);
	const variant = cursorProtoTest.concatBytes(
		cursorProtoTest.encodeMessageField(1, parameter),
		cursorProtoTest.encodeStringField(2, "High Max"),
		cursorProtoTest.encodeVarintField(3, 1n),
		cursorProtoTest.encodeVarintField(4, 1n),
		cursorProtoTest.encodeStringField(9, "gpt-5.5-high-max"),
	);
	const model = cursorProtoTest.concatBytes(
		cursorProtoTest.encodeStringField(1, "gpt-5.5"),
		cursorProtoTest.encodeVarintField(10, 1n),
		cursorProtoTest.encodeVarintField(14, 1n),
		cursorProtoTest.encodeVarintField(15, 272_000n),
		cursorProtoTest.encodeVarintField(16, 1_000_000n),
		cursorProtoTest.encodeStringField(17, "GPT-5.5"),
		cursorProtoTest.encodeStringField(18, "gpt-5.5-server"),
		cursorProtoTest.encodeVarintField(19, 1n),
		cursorProtoTest.encodeMessageField(30, variant),
	);
	return cursorProtoTest.encodeMessageField(2, model);
}

function fableAvailableModelsFixture(): Uint8Array {
	const option = (value: string, label?: string, wireField3 = false) => cursorProtoTest.concatBytes(
		cursorProtoTest.encodeStringField(1, value),
		...(label ? [cursorProtoTest.encodeStringField(2, label)] : []),
		...(wireField3 ? [cursorProtoTest.encodeVarintField(3, 1n)] : []),
	);
	const definition = (id: string, displayName: string, description: string, typeField: 1 | 2, options: readonly Uint8Array[], wireField5 = false) => {
		const optionList = cursorProtoTest.concatBytes(...options.map((entry) => cursorProtoTest.encodeMessageField(1, entry)));
		const config = cursorProtoTest.encodeMessageField(typeField, optionList);
		return cursorProtoTest.concatBytes(
			cursorProtoTest.encodeStringField(1, id),
			cursorProtoTest.encodeStringField(2, displayName),
			cursorProtoTest.encodeStringField(3, description),
			cursorProtoTest.encodeMessageField(4, config),
			...(wireField5 ? [cursorProtoTest.encodeVarintField(5, 1n)] : []),
		);
	};
	const definitions = [
		definition("thinking", "Thinking", "Does the model use thinking to generate its response?", 1, [option("false"), option("true")]),
		definition("context", "Context", "Context size the model has available.", 2, [option("300k", "300K"), option("1m", "1M", true)]),
		definition("effort", "Effort", "Effort the model uses to generate its response.", 2, [
			option("low", "Low"), option("medium", "Medium"), option("high", "High"), option("xhigh", "Extra High"), option("max", "Max"),
		], true),
	];
	const efforts = ["low", "medium", "high", "xhigh", "max"] as const;
	const modes = [
		{ thinking: "false", context: "300k", max: false },
		{ thinking: "false", context: "1m", max: true },
		{ thinking: "true", context: "300k", max: false },
		{ thinking: "true", context: "1m", max: true },
	] as const;
	const variants = modes.flatMap((mode) => efforts.map((effort) => {
		const parameters = [["thinking", mode.thinking], ["context", mode.context], ["effort", effort]] as const;
		return cursorProtoTest.concatBytes(
			...parameters.map(([id, value]) => cursorProtoTest.encodeMessageField(1, cursorProtoTest.concatBytes(
				cursorProtoTest.encodeStringField(1, id), cursorProtoTest.encodeStringField(2, value),
			))),
			cursorProtoTest.encodeStringField(2, "Fable 5"),
			...(mode.max ? [cursorProtoTest.encodeVarintField(3, 1n)] : []),
			...(mode.thinking === "true" && effort === "high"
				? [cursorProtoTest.encodeVarintField(mode.max ? 4 : 5, 1n)]
				: []),
			cursorProtoTest.encodeStringField(8, "Fable 5"),
			cursorProtoTest.encodeStringField(9, `claude-fable-5[thinking=${mode.thinking},context=${mode.context},effort=${effort}]`),
		);
	}));
	const model = cursorProtoTest.concatBytes(
		cursorProtoTest.encodeStringField(1, "claude-fable-5"),
		cursorProtoTest.encodeVarintField(10, 1n),
		cursorProtoTest.encodeVarintField(14, 1n),
		cursorProtoTest.encodeStringField(17, "Fable 5"),
		cursorProtoTest.encodeStringField(18, "claude-fable-5"),
		cursorProtoTest.encodeVarintField(19, 1n),
		...definitions.map((entry) => cursorProtoTest.encodeMessageField(29, entry)),
		...variants.map((entry) => cursorProtoTest.encodeMessageField(30, entry)),
	);
	return cursorProtoTest.encodeMessageField(2, model);
}

type UnaryFixture = Uint8Array | { readonly statusCode: number; readonly body: Uint8Array };

class UnaryClient implements CursorHttp2Client {
	readonly requests: { readonly path: string; readonly body: Uint8Array }[] = [];
	readonly #responses: UnaryFixture[];
	constructor(responses: UnaryFixture[]) { this.#responses = responses; }
	async requestUnary(request: { readonly path: string; readonly body: Uint8Array }) {
		this.requests.push({ path: request.path, body: request.body });
		const fixture = this.#responses.shift() ?? new Uint8Array();
		return fixture instanceof Uint8Array
			? { statusCode: 200, headers: {}, body: fixture }
			: { statusCode: fixture.statusCode, headers: {}, body: fixture.body };
	}
	async openStream(): Promise<never> { throw new Error("unused"); }
	async dispose(): Promise<void> {}
}

function fallbackCodec(): CursorProtocolCodec {
	return {
		encodeAvailableModelsRequest: () => new Uint8Array([40, 1, 56, 1]),
		decodeAvailableModelsResponse: () => [],
		encodeGetUsableModelsRequest: () => new Uint8Array([9]),
		decodeGetUsableModelsResponse: () => [{ id: "composer-2" }],
		encodeRunRequest: () => new Uint8Array(),
		decodeRunFrame: () => [],
		encodeToolResult: () => new Uint8Array(),
		encodeCancelRequest: () => new Uint8Array(),
		encodeHeartbeatRequest: () => new Uint8Array(),
	};
}

const runModel: Model<Api> = {
	id: "gpt-5.5", name: "GPT-5.5", provider: "cursor", api: "cursor-agent", baseUrl: "https://api2.cursor.sh",
	reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 64_000,
};

describe("Cursor AvailableModels discovery", () => {
	test("preserves reverse-engineered normal/max limits, capabilities, parameters, and defaults", () => {
		const codec = new CursorProtobufProtocolCodec();
		assert.deepEqual([...codec.encodeAvailableModelsRequest()], [40, 1, 56, 1]);
		const [model] = codec.decodeAvailableModelsResponse(availableModelsFixture());
		assert.deepEqual(model, {
			id: "gpt-5.5",
			displayName: "GPT-5.5",
			serverModelName: "gpt-5.5-server",
			supportsImages: true,
			supportsMaxMode: true,
			supportsNonMaxMode: true,
			contextWindow: 272_000,
			maxModeContextWindow: 1_000_000,
			parameterDefinitions: [],
			variants: [{
				parameters: [{ id: "reasoning", value: "high" }],
				isMaxMode: true,
				isDefaultMaxConfig: true,
				displayName: "High Max",
				variantStringRepresentation: "gpt-5.5-high-max",
			}],
			metadataProvenance: "available-models-reverse-engineered",
		});
	});

	test("decodes authenticated Fable 5 parameter labels and all complete variants", () => {
		const [model] = new CursorProtobufProtocolCodec().decodeAvailableModelsResponse(fableAvailableModelsFixture());
		assert.equal(model?.variants.length, 20);
		assert.deepEqual(model?.parameterDefinitions, [
			{ id: "thinking", displayName: "Thinking", description: "Does the model use thinking to generate its response?", type: "boolean", options: [{ value: "false" }, { value: "true" }] },
			{ id: "context", displayName: "Context", description: "Context size the model has available.", type: "enum", options: [{ value: "300k", label: "300K" }, { value: "1m", label: "1M", wireField3: true }] },
			{ id: "effort", displayName: "Effort", description: "Effort the model uses to generate its response.", type: "enum", options: [{ value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" }, { value: "xhigh", label: "Extra High" }, { value: "max", label: "Max" }], wireField5: true },
		]);
		assert.deepEqual(model?.variants[17], {
			parameters: [{ id: "thinking", value: "true" }, { id: "context", value: "1m" }, { id: "effort", value: "high" }],
			isMaxMode: true,
			isDefaultMaxConfig: true,
			displayName: "Fable 5",
			displayNameOutsidePicker: "Fable 5",
			variantStringRepresentation: "claude-fable-5[thinking=true,context=1m,effort=high]",
		});
	});

	test("prefers AvailableModels and falls back to GetUsableModels when it is empty", async () => {
		const primaryClient = new UnaryClient([availableModelsFixture()]);
		const primary = new Http2CursorAgentTransport({ client: primaryClient });
		const models = await primary.getUsableModels("secret", "request-primary");
		assert.equal(models[0]?.id, "gpt-5.5");
		assert.deepEqual(primaryClient.requests.map((request) => request.path), ["/aiserver.v1.AiService/AvailableModels"]);

		const fallbackClient = new UnaryClient([new Uint8Array(), new Uint8Array([1])]);
		const fallback = new Http2CursorAgentTransport({ client: fallbackClient, codec: fallbackCodec() });
		assert.equal((await fallback.getUsableModels("secret", "request-fallback"))[0]?.id, "composer-2");
		assert.deepEqual(fallbackClient.requests.map((request) => request.path), [
			"/aiserver.v1.AiService/AvailableModels",
			"/agent.v1.AgentService/GetUsableModels",
		]);
	});

	test("falls back when AvailableModels is malformed or unavailable", async () => {
		for (const fixture of [
			new Uint8Array([255]),
			{ statusCode: 503, body: new TextEncoder().encode("temporarily unavailable") },
		] satisfies UnaryFixture[]) {
			const client = new UnaryClient([fixture, new Uint8Array([1])]);
			const codec = fallbackCodec();
			codec.decodeAvailableModelsResponse = () => { throw new Error("malformed AvailableModels response"); };
			const transport = new Http2CursorAgentTransport({ client, codec });
			assert.equal((await transport.getUsableModels("secret", "request-fallback-error"))[0]?.id, "composer-2");
			assert.deepEqual(client.requests.map((request) => request.path), [
				"/aiserver.v1.AiService/AvailableModels",
				"/agent.v1.AgentService/GetUsableModels",
			]);
		}
	});

	test("does not issue discovery requests when already aborted", async () => {
		const client = new UnaryClient([]);
		const transport = new Http2CursorAgentTransport({ client, codec: fallbackCodec() });
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(transport.getUsableModels("secret", "request-aborted", controller.signal), /aborted/u);
		assert.deepEqual(client.requests, []);
	});

	test("encodes one discovered RequestedModel preset without recombination", () => {
		const codec = new CursorProtobufProtocolCodec();
		const encoded = codec.encodeRunRequest({
			accessToken: "secret", requestId: "run-requested-model", model: runModel,
			resolvedModelId: "gpt-5.5-high-fast", requestedModelId: "backend-gpt-5.5", requestedMaxMode: true,
			modelParameters: [{ id: "reasoning", value: "high" }, { id: "fast", value: "true" }],
			context: { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
		});
		const decoded = fromBinary(AgentClientMessageSchema, encoded);
		assert.equal(decoded.message.case, "runRequest");
		if (decoded.message.case !== "runRequest") throw new Error("expected run request");
		const requested = decoded.message.value.requestedModel;
		assert.equal(decoded.message.value.modelDetails?.modelId, "backend-gpt-5.5");
		assert.equal(decoded.message.value.modelDetails?.displayModelId, "gpt-5.5-high-fast");
		assert.equal(requested?.modelId, "backend-gpt-5.5");
		assert.equal(requested?.maxMode, true);
		assert.deepEqual(requested?.parameters.map(({ id, value }) => ({ id, value })), [{ id: "reasoning", value: "high" }, { id: "fast", value: "true" }]);
	});
});
