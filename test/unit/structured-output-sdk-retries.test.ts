// Single-inference transport regression coverage for #3089 / #3090.
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { normalizeContext } from "@bastani/pi-ai";
import type { HttpRequest } from "@smithy/types";
import { afterEach, test, vi } from "vitest";
import { inferRouterDecision } from "../../packages/coding-agent/src/core/structured-output/index.js";
import { decisionModel, decisionRequest } from "../helpers/structured-output.js";

const { handle, bedrockSdkPath } = await vi.hoisted(async () => {
	const { createRequire } = await import("node:module");
	const require = createRequire(new URL("../../packages/ai/src/api/bedrock-converse-stream.ts", import.meta.url));
	return { handle: vi.fn(), bedrockSdkPath: require.resolve("@aws-sdk/client-bedrock-runtime") };
});
vi.mock(bedrockSdkPath, async (importOriginal) => {
	const sdk = await importOriginal<typeof import("@aws-sdk/client-bedrock-runtime")>();
	return {
		...sdk,
		// Keep the real command serializer, signing and retry middleware; replace only I/O.
		BedrockRuntimeClient: class extends sdk.BedrockRuntimeClient {
			constructor(config: import("@aws-sdk/client-bedrock-runtime").BedrockRuntimeClientConfig) {
				super({ ...config, requestHandler: { handle } });
			}
		},
	};
});

// Load unbuilt serializers at runtime without pulling the entire AI source graph into
// the root test typecheck (the AI package has its own no-emit typecheck).
const { streamSimple: bedrockStream } = await vi.importActual<
	typeof import("@bastani/pi-ai/api/bedrock-converse-stream")
>("../../packages/ai/src/api/bedrock-converse-stream.ts");
const { streamSimple: googleStream } = await vi.importActual<typeof import("@bastani/pi-ai/api/google-generative-ai")>(
	"../../packages/ai/src/api/google-generative-ai.ts",
);
const { streamSimple: vertexStream } = await vi.importActual<typeof import("@bastani/pi-ai/api/google-vertex")>(
	"../../packages/ai/src/api/google-vertex.ts",
);

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	handle.mockReset();
});

function bedrockFailure() {
	handle.mockImplementation(async () => {
		return {
			response: {
				statusCode: 503,
				headers: { "content-type": "application/json", "x-amzn-errortype": "ServiceUnavailableException" },
				body: Readable.from([JSON.stringify({ message: "mock unavailable" })]),
			},
		};
	});
}

test("Bedrock router inference performs only one SDK transport attempt on a retryable failure", async () => {
	bedrockFailure();
	vi.stubEnv("AWS_MAX_ATTEMPTS", "3");
	const model = { ...decisionModel, api: "bedrock-converse-stream" as const, compat: undefined };
	await assert.rejects(
		inferRouterDecision({
			...decisionRequest(),
			currentModel: model,
			// Decision-layer transient retries are covered elsewhere; disable them
			// here to isolate the SDK transport contract (#3206).
			retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
			modelRegistry: {
				getAll: () => [model],
				streamSimple: (_model, context, options) =>
					bedrockStream(model, normalizeContext(context), { ...options, apiKey: "mock-key" }),
			},
		}),
		/inference ended with error/,
	);
	assert.equal(handle.mock.calls.length, 1);
	const request: HttpRequest = handle.mock.calls[0][0];
	const body = JSON.parse(Buffer.from(request.body as Uint8Array).toString("utf8"));
	assert.equal(body.toolConfig.tools[0].toolSpec.name, "structured_output");
	assert.deepEqual(body.toolConfig.toolChoice, { auto: {} });
});

for (const maxRetries of [undefined, 1]) {
	test(`Bedrock preserves ${maxRetries === undefined ? "omitted SDK retry configuration" : "explicit retry budget"}`, async () => {
		bedrockFailure();
		vi.stubEnv("AWS_MAX_ATTEMPTS", "3");
		const model = { ...decisionModel, api: "bedrock-converse-stream" as const, compat: undefined };
		const result = await bedrockStream(
			model,
			normalizeContext({
				messages: [{ role: "user", content: "Decide", timestamp: 0 }],
				tools: [{ name: "structured_output", description: "Decide", parameters: decisionRequest().schema }],
			}),
			{ apiKey: "mock-key", toolChoice: "auto", ...(maxRetries !== undefined ? { maxRetries } : {}) },
		).result();
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /mock unavailable/);
		assert.equal(handle.mock.calls.length, maxRetries === undefined ? 3 : 2);
	});
}

for (const api of ["google-generative-ai", "google-vertex"] as const) {
	for (const status of [429, 503]) {
		test(`${api} router inference performs one fetch at status ${status}`, async () => {
			const model = { ...decisionModel, api, compat: undefined, id: "gemini-2.5-flash" };
			const transport = vi.fn<(...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>>(async () =>
				Response.json({ error: { code: status, message: "mock unavailable", status: "UNAVAILABLE" } }, { status }),
			);
			vi.stubGlobal("fetch", transport);
			await assert.rejects(
				inferRouterDecision({
					...decisionRequest(),
					settings: { getRouterModel: () => `${model.provider}/${model.id}` },
					currentModel: model,
					retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
					modelRegistry: {
						getAll: () => [model],
						streamSimple: (_model, context, options) =>
							api === "google-generative-ai"
								? googleStream({ ...model, api }, normalizeContext(context), { ...options, apiKey: "mock-key" })
								: vertexStream({ ...model, api }, normalizeContext(context), {
										...options,
										apiKey: "mock-key",
									}),
					},
				}),
				/inference ended with error/,
			);
			assert.equal(transport.mock.calls.length, 1);
			const body = JSON.parse(transport.mock.calls[0][1]?.body as string);
			assert.equal(body.tools[0].functionDeclarations[0].name, "structured_output");
			assert.equal(body.toolConfig.functionCallingConfig.mode, "AUTO");
		});
	}
	for (const maxRetries of [undefined, 1]) {
		test(`${api} ${maxRetries === undefined ? "omitted" : "explicit"} outer retry budget is not multiplied by SDK retries`, async () => {
			vi.useFakeTimers();
			const transport = vi.fn<(...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>>(async () =>
				Response.json(
					{ error: { code: 503, message: "mock unavailable", status: "UNAVAILABLE" } },
					{ status: 503 },
				),
			);
			vi.stubGlobal("fetch", transport);
			const context = normalizeContext({ messages: [{ role: "user", content: "Decide", timestamp: 0 }] });
			const options = { apiKey: "mock-key", ...(maxRetries !== undefined ? { maxRetries } : {}) };
			const pending = (
				api === "google-generative-ai"
					? googleStream({ ...decisionModel, api, compat: undefined }, context, options)
					: vertexStream({ ...decisionModel, api, compat: undefined }, context, options)
			).result();
			await vi.runAllTimersAsync();
			const result = await pending;
			assert.equal(result.stopReason, "error");
			assert.match(result.errorMessage ?? "", /mock unavailable/);
			assert.equal(transport.mock.calls.length, maxRetries === undefined ? 1 : 2);
		});
	}
}
