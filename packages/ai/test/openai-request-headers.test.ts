import assert from "node:assert/strict";
import { it } from "vitest";
import { getFixtureModel } from "../../../test/helpers/catalog-model-fixtures.ts";
import { streamSimple as streamChat } from "../src/api/openai-completions.ts";
import { streamSimple as streamResponses } from "../src/api/openai-responses.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model = getFixtureModel("openai", "gpt-5.4");
const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 0 }] });

function responseFor(api: "chat" | "responses"): Response {
	const body =
		api === "chat"
			? 'data: {"id":"chat-test","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
			: 'data: {"type":"response.completed","response":{"status":"completed"}}\n\n';
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

it.each(["chat", "responses"] as const)("traces every OpenAI %s HTTP attempt independently (#6794)", async (api) => {
	const requests: Array<{ headers: Headers; body: { prompt_cache_key?: string } }> = [];
	const fetch = Object.assign(async (_input: string | URL | Request, init?: RequestInit) => {
		assert.equal(typeof init?.body, "string");
		requests.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
		if (requests.length === 1) {
			return new Response('{"error":{"message":"temporary failure"}}', {
				status: 503,
				headers: { "content-type": "application/json", "retry-after-ms": "1" },
			});
		}
		return responseFor(api);
	}, globalThis.fetch);
	for (const sessionId of ["session-id-test", "session-id-test", undefined]) {
		const options = { apiKey: "sk-test", fetch, maxRetries: 1, sessionId };
		const stream =
			api === "chat"
				? streamChat({ ...model, api: "openai-completions", compat: undefined }, context, options)
				: streamResponses(model, context, options);
		assert.equal((await stream.result()).stopReason, "stop");
	}
	assert.equal(requests.length, 4);
	const traceIds = requests.map(({ headers }) => headers.get("x-client-request-id"));
	for (const traceId of traceIds) {
		assert.match(traceId ?? "", /^[\x20-\x7e]{1,512}$/);
		assert.notEqual(traceId, "session-id-test");
	}
	assert.equal(new Set(traceIds).size, requests.length);
	assert.deepEqual(
		requests.map(({ body }) => body.prompt_cache_key),
		["session-id-test", "session-id-test", "session-id-test", undefined],
	);
	if (api === "responses") {
		assert.deepEqual(
			requests.map(({ headers }) => headers.get("session-id")),
			["session-id-test", "session-id-test", "session-id-test", null],
		);
	}
});

it.each(["chat", "responses"] as const)(
	"opts %s requests into a fresh idempotency key per logical request (#6794)",
	async (api) => {
		const requests: Headers[] = [];
		const fetch = Object.assign(async (_input: string | URL | Request, init?: RequestInit) => {
			requests.push(new Headers(init?.headers));
			if (requests.length === 1) {
				return new Response('{"error":{"message":"temporary failure"}}', {
					status: 503,
					headers: { "content-type": "application/json", "retry-after-ms": "1" },
				});
			}
			return responseFor(api);
		}, globalThis.fetch);
		const gateway = { ...model, baseUrl: "https://gateway.example/v1", provider: "example" };
		for (const enabled of [true, true, undefined]) {
			const compat = { sendIdempotencyKey: enabled, supportsDeveloperRole: true };
			const options = { apiKey: "test", fetch, maxRetries: 1, sessionId: "same-session" };
			const stream =
				api === "chat"
					? streamChat({ ...gateway, api: "openai-completions", compat }, context, options)
					: streamResponses({ ...gateway, compat }, context, options);
			assert.equal((await stream.result()).stopReason, "stop");
		}
		assert.equal(requests.length, 4);
		const [first, retry, next, off] = requests.map((headers) => headers.get("idempotency-key"));
		assert.ok(first);
		assert.equal(retry, first);
		assert.ok(next);
		assert.notEqual(next, first);
		assert.equal(off, null);
		assert.ok(requests.every((headers) => !headers.has("x-client-request-id")));
	},
);
