import { streamSimple as anthropicMessagesStreamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import * as piAiCloudflareGatewayBinding from "@earendil-works/pi-ai/api/cloudflare-gateway-binding";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import {
	type AiGatewayBinding,
	type AiGatewayUniversalRequestLike,
	CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL,
	createGatewayBindingFetch,
} from "../src/index.ts";

const ACCOUNT_ID = "acct";
const GATEWAY_ID = "gw";
const GATEWAY_PREFIX = `https://gateway.ai.cloudflare.com/v1/${ACCOUNT_ID}/${GATEWAY_ID}`;

interface RecordedRun {
	gatewayId: string;
	data: AiGatewayUniversalRequestLike;
}

function createFakeBinding(responseBody: string): { binding: AiGatewayBinding; runs: RecordedRun[] } {
	const runs: RecordedRun[] = [];
	const binding: AiGatewayBinding = {
		gateway(gatewayId: string) {
			return {
				run: async (data: AiGatewayUniversalRequestLike) => {
					runs.push({ gatewayId, data });
					return new Response(responseBody, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					});
				},
			};
		},
	};
	return { binding, runs };
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
		expect(createGatewayBindingFetch).toBe(piAiCloudflareGatewayBinding.createGatewayBindingFetch);
		expect(CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL).toBe("cloudflare-gateway-binding");
	});

	it("translates a gateway-prefixed POST into one universal-endpoint binding call", async () => {
		const { binding, runs } = createFakeBinding(ANTHROPIC_SSE);
		const fetch = createGatewayBindingFetch({ binding, gateway: GATEWAY_ID, baseUrl: GATEWAY_PREFIX });

		const body = { model: "claude-sonnet-4-5", stream: true, max_tokens: 64 };
		const response = await fetch(`${GATEWAY_PREFIX}/anthropic/v1/messages?beta=true`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"cf-aig-authorization": `Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}`,
				host: "gateway.ai.cloudflare.com",
			},
			body: JSON.stringify(body),
		});

		expect(response.status).toBe(200);
		expect(runs).toHaveLength(1);
		expect(runs[0].gatewayId).toBe(GATEWAY_ID);
		expect(runs[0].data.provider).toBe("anthropic");
		expect(runs[0].data.endpoint).toBe("v1/messages?beta=true");
		expect(runs[0].data.query).toEqual(body);
		// Gateway auth never reaches the binding: binding calls are pre-authenticated,
		// and a sentinel on the wire would be read as a BYOK provider key.
		expect(runs[0].data.headers).not.toHaveProperty("cf-aig-authorization");
		expect(runs[0].data.headers).not.toHaveProperty("host");
		expect(runs[0].data.headers["content-type"]).toBe("application/json");
	});

	it("rejects URLs outside the configured gateway prefix instead of forwarding them", async () => {
		const { binding } = createFakeBinding(ANTHROPIC_SSE);
		const fetch = createGatewayBindingFetch({ binding, gateway: GATEWAY_ID, baseUrl: GATEWAY_PREFIX });

		await expect(fetch("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" })).rejects.toThrow(
			/outside the configured gateway prefix/,
		);
	});

	it("rejects in-prefix requests the universal endpoint cannot express", async () => {
		const { binding } = createFakeBinding(ANTHROPIC_SSE);
		const fetch = createGatewayBindingFetch({ binding, gateway: GATEWAY_ID, baseUrl: GATEWAY_PREFIX });

		await expect(fetch(`${GATEWAY_PREFIX}/anthropic/v1/messages`)).rejects.toThrow(/only POST is supported/);
		await expect(
			fetch(`${GATEWAY_PREFIX}/anthropic/v1/messages`, { method: "POST", body: "not json" }),
		).rejects.toThrow(/non-JSON body/);
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
			const { binding, runs } = createFakeBinding(ANTHROPIC_SSE);

			// The provider-extension shape documented in docs/providers.md →
			// "Cloudflare AI Gateway" → "Workers AI binding (no API token)".
			modelRuntime.registerProvider("cloudflare-ai-gateway", {
				apiKey: CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL,
				api: "anthropic-messages",
				streamSimple: (model, context, options) =>
					anthropicMessagesStreamSimple(
						{
							...model,
							baseUrl: (model.baseUrl ?? GATEWAY_PREFIX)
								.replaceAll("{CLOUDFLARE_ACCOUNT_ID}", options?.env?.CLOUDFLARE_ACCOUNT_ID ?? "")
								.replaceAll("{CLOUDFLARE_GATEWAY_ID}", options?.env?.CLOUDFLARE_GATEWAY_ID ?? ""),
						},
						context,
						{
							...options,
							fetch: createGatewayBindingFetch({
								binding,
								gateway: GATEWAY_ID,
								baseUrl: GATEWAY_PREFIX,
							}),
						},
					),
			});

			const model = modelRuntime.getModel("cloudflare-ai-gateway", "claude-sonnet-4-5");
			expect(model).toBeDefined();
			if (!model) throw new Error("cloudflare-ai-gateway/claude-sonnet-4-5 missing from the catalog");

			const resolution = await modelRuntime.getAuth(model);
			expect(resolution?.auth.apiKey).toBeUndefined();
			expect(resolution?.auth.headers?.["cf-aig-authorization"]).toBe(
				`Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}`,
			);
			expect(resolution?.env).toEqual({
				CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
				CLOUDFLARE_GATEWAY_ID: GATEWAY_ID,
			});

			const result = await modelRuntime.complete(model, {
				messages: [{ role: "user", content: "Say hello" }],
			});

			expect(result.stopReason).toBe("stop");
			expect(result.content).toEqual([{ type: "text", text: "Hello from the binding" }]);
			expect(runs).toHaveLength(1);
			expect(runs[0].gatewayId).toBe(GATEWAY_ID);
			expect(runs[0].data.provider).toBe("anthropic");
			expect(runs[0].data.endpoint).toBe("v1/messages");
			expect(runs[0].data.query).toMatchObject({ model: "claude-sonnet-4-5", stream: true });
			expect(runs[0].data.headers).not.toHaveProperty("cf-aig-authorization");
			expect(runs[0].data.headers).not.toHaveProperty("authorization");
			expect(runs[0].data.headers).not.toHaveProperty("x-api-key");
		} finally {
			if (previousAccount === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
			else process.env.CLOUDFLARE_ACCOUNT_ID = previousAccount;
			if (previousGateway === undefined) delete process.env.CLOUDFLARE_GATEWAY_ID;
			else process.env.CLOUDFLARE_GATEWAY_ID = previousGateway;
		}
	});
});
