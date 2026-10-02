import assert from "node:assert/strict";
import { streamSimple as anthropicMessagesStreamSimple } from "@bastani/pi-ai/api/anthropic-messages";
import * as piAiCloudflareGatewayBinding from "@bastani/pi-ai/api/cloudflare-gateway-binding";
import { describe, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRuntime } from "../src/core/model-runtime.js";
import { CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL, createGatewayBindingFetch } from "../src/index.js";

const ACCOUNT_ID = "acct";
const GATEWAY_ID = "gw";
const BINDING_PREFIX = `https://workers-binding.ai/ai-gateway/gateways/${GATEWAY_ID}`;

function createFakeBinding(responseBody: string): {
	binding: { fetch: typeof fetch };
	calls: Array<{ input: Request | string | URL; init?: RequestInit }>;
} {
	const calls: Array<{ input: Request | string | URL; init?: RequestInit }> = [];
	const binding = {
		fetch: (input: Request | string | URL, init?: RequestInit) => {
			calls.push({ input, init });
			return Promise.resolve(
				new Response(responseBody, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
			);
		},
	};
	return { binding, calls };
}

/** A minimal, well-formed Anthropic streaming response the pi-ai adapter can consume. */
const ANTHROPIC_SSE = `${[
	'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_binding","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-5","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":3,"output_tokens":1}}}',
	'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
	'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello from the binding"}}',
	'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
	'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
	'event: message_stop\ndata: {"type":"message_stop"}',
].join("\n\n")}\n\n`;

describe("Cloudflare AI Gateway Workers AI binding transport", () => {
	it("re-exports pi-ai's binding transport from the public surface", () => {
		assert.equal(createGatewayBindingFetch, piAiCloudflareGatewayBinding.createGatewayBindingFetch);
		assert.equal(CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL, "cloudflare-gateway-binding");
	});

	it("forwards requests through binding.fetch without translating them", async () => {
		const { binding, calls } = createFakeBinding(ANTHROPIC_SSE);
		const fetch = createGatewayBindingFetch({ binding, gateway: GATEWAY_ID, baseUrl: BINDING_PREFIX });
		const url = `${BINDING_PREFIX}/anthropic/v1/messages?beta=true`;
		const init = {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"cf-aig-authorization": `Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}`,
			},
			body: JSON.stringify({ model: "claude-sonnet-4-5", stream: true, max_tokens: 64 }),
		};

		const response = await fetch(url, init);

		assert.equal(response.status, 200);
		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.input, url);
		assert.equal(calls[0]?.init, init);
	});

	it("completes a ModelRuntime turn through the binding with no Cloudflare API token", async () => {
		const previousAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
		const previousGateway = process.env.CLOUDFLARE_GATEWAY_ID;
		process.env.CLOUDFLARE_ACCOUNT_ID = ACCOUNT_ID;
		process.env.CLOUDFLARE_GATEWAY_ID = GATEWAY_ID;
		try {
			const modelRuntime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory(),
				modelsPath: null,
			});
			const { binding, calls } = createFakeBinding(ANTHROPIC_SSE);

			modelRuntime.registerProvider("cloudflare-ai-gateway", {
				apiKey: CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL,
				api: "anthropic-messages",
				streamSimple: (model, context, options) =>
					anthropicMessagesStreamSimple(
						{
							...model,
							baseUrl: `${BINDING_PREFIX}/anthropic`,
						},
						context,
						{
							...options,
							fetch: createGatewayBindingFetch({
								binding,
								gateway: GATEWAY_ID,
								baseUrl: BINDING_PREFIX,
							}),
						},
					),
			});

			const model = modelRuntime.getModel("cloudflare-ai-gateway", "claude-sonnet-4-5");
			assert.ok(model);

			const resolution = await modelRuntime.getAuth(model);
			assert.equal(resolution?.auth.apiKey, undefined);
			assert.equal(
				resolution?.auth.headers?.["cf-aig-authorization"],
				`Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}`,
			);

			const result = await modelRuntime.complete(model, {
				messages: [{ role: "user", content: "Say hello" }],
			});

			assert.equal(result.stopReason, "stop");
			assert.deepEqual(result.content, [{ type: "text", text: "Hello from the binding" }]);
			assert.equal(calls.length, 1);
			const call = calls[0];
			assert.ok(call);
			const request = new Request(call.input, call.init);
			const body = (await request.json()) as { model: string; stream: boolean };
			assert.equal(body.model, "claude-sonnet-4-5");
			assert.equal(body.stream, true);
		} finally {
			if (previousAccount === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
			else process.env.CLOUDFLARE_ACCOUNT_ID = previousAccount;
			if (previousGateway === undefined) delete process.env.CLOUDFLARE_GATEWAY_ID;
			else process.env.CLOUDFLARE_GATEWAY_ID = previousGateway;
		}
	});
});
