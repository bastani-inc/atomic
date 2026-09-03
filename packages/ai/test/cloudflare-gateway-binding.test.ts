import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
	type AiGatewayBinding,
	CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL,
	createGatewayBindingFetch,
} from "../src/api/cloudflare-gateway-binding.ts";
import { streamSimple as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { Model } from "../src/types.ts";

const BINDING_PREFIX = "https://workers-binding.ai/ai-gateway/gateways/my-gateway";
const OPTIONS = { baseUrl: BINDING_PREFIX, gateway: "my-gateway" };

function fakeBinding(response?: Response) {
	const requests: Request[] = [];
	const binding: AiGatewayBinding = {
		aiGatewayLogId: null,
		fetch: (input: Request | string | URL, init?: RequestInit) => {
			requests.push(input instanceof Request ? input : new Request(input, init));
			return Promise.resolve(response ?? new Response("{}"));
		},
	};
	return { binding, requests };
}

describe("createGatewayBindingFetch", () => {
	it("passes requests to the binding untouched", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
				controller.close();
			},
		});
		const bindingResponse = new Response(stream, {
			headers: { "content-type": "text/event-stream", "cf-aig-log-id": "log-1" },
		});
		const { binding, requests } = fakeBinding(bindingResponse);
		const fetchFn = createGatewayBindingFetch({ binding, ...OPTIONS });
		const body = JSON.stringify({ model: "claude", messages: [{ role: "user", content: "hi" }] });

		const response = await fetchFn(`${BINDING_PREFIX}/anthropic/v1/messages?beta=true`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"cf-aig-authorization": `Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}`,
				"anthropic-version": "2023-06-01",
			},
			body,
		});

		assert.equal(requests[0].url, `${BINDING_PREFIX}/anthropic/v1/messages?beta=true`);
		assert.equal(requests[0].method, "POST");
		assert.deepEqual(Object.fromEntries(requests[0].headers), {
			"anthropic-version": "2023-06-01",
			"cf-aig-authorization": `Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}`,
			"content-type": "application/json",
		});
		assert.equal(await requests[0].text(), body);
		assert.equal(response, bindingResponse);
		assert.equal(await response.text(), "data: {}\n\n");
	});

	it("rejects a binding with no fetch() at construction", () => {
		assert.throws(
			() => createGatewayBindingFetch({ binding: { aiGatewayLogId: null }, ...OPTIONS }),
			/does not expose fetch\(\)/,
		);
	});

	it("keeps SDK placeholder auth off the wire when paired with null auth headers", async () => {
		const { binding, requests } = fakeBinding(
			Response.json({ error: { type: "bad_request", message: "stubbed" } }, { status: 400 }),
		);
		const model: Model<"openai-completions"> = {
			id: "test-model",
			name: "Test Model",
			api: "openai-completions",
			provider: "openai",
			baseUrl: `${BINDING_PREFIX}/openai`,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 10_000,
			maxTokens: 1_000,
		};

		const result = await streamOpenAICompletions(
			model,
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				headers: {
					"cf-aig-authorization": `Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}`,
					Authorization: null,
					"x-api-key": null,
				},
				fetch: createGatewayBindingFetch({ binding, ...OPTIONS }),
				maxRetries: 0,
			},
		).result();

		assert.equal(result.stopReason, "error");
		assert.equal(requests.length, 1);
		assert.equal(requests[0].url, `${BINDING_PREFIX}/openai/chat/completions`);
		const headerNames = Object.keys(Object.fromEntries(requests[0].headers));
		assert.equal(headerNames.includes("authorization"), false);
		assert.equal(headerNames.includes("x-api-key"), false);
	});
});
