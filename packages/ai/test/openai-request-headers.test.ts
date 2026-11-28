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

const zai = getFixtureModel("zai", "glm-5.3");
const zaiCodingCn = getFixtureModel("zai-coding-cn", "glm-5.3");

it.each([
	{ name: "Z.ai traces each attempt", model: zai, traces: true, idempotent: false },
	{
		name: "Zhipu Coding CN traces each attempt without changing the idempotency key",
		model: zaiCodingCn,
		traces: true,
		idempotent: true,
	},
	{
		name: "another provider using the same endpoint does not send a tracing ID",
		model: { ...zai, provider: "other" },
		traces: false,
		idempotent: false,
	},
])("$name (#6798)", async ({ model, traces, idempotent }) => {
	const requests: Array<{ body: { request_id?: string }; key: string | null }> = [];
	const fetch = Object.assign(async (_input: string | URL | Request, init?: RequestInit) => {
		const body: { request_id?: string } = JSON.parse(String(init?.body));
		requests.push({ body, key: new Headers(init?.headers).get("idempotency-key") });
		if (requests.length === 1) {
			return new Response('{"error":{"message":"temporary failure"}}', {
				status: 503,
				headers: { "content-type": "application/json", "retry-after-ms": "1" },
			});
		}
		return responseFor("chat");
	}, globalThis.fetch);
	const stream = streamChat(
		idempotent ? { ...model, compat: { ...model.compat, sendIdempotencyKey: true } } : model,
		context,
		{ apiKey: "test", fetch, maxRetries: 1 },
	);
	assert.equal((await stream.result()).stopReason, "stop");
	assert.equal(requests.length, 2);
	const [first, retry] = requests;
	assert.ok(first && retry);
	if (traces) {
		assert.match(first.body.request_id ?? "", /^.{6,64}$/);
		assert.match(retry.body.request_id ?? "", /^.{6,64}$/);
		assert.notEqual(first.body.request_id, retry.body.request_id);
	} else {
		assert.ok(requests.every(({ body }) => !Object.hasOwn(body, "request_id")));
	}
	if (idempotent) {
		assert.ok(first.key);
		assert.equal(retry.key, first.key);
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

it.each([
	["chat", "idempotency_conflict", 1],
	["responses", "idempotency_conflict", 1],
	["chat", "conflict", 3],
	["responses", "conflict", 3],
] as const)("handles %s HTTP 409 code %s with %i attempt(s) (#6794)", async (api, code, expectedAttempts) => {
	let attempts = 0;
	const fetch = Object.assign(async () => {
		attempts++;
		return new Response(JSON.stringify({ error: { code, message: "Request conflict" } }), {
			status: 409,
			headers: { "content-type": "application/json", "retry-after-ms": "1" },
		});
	}, globalThis.fetch);
	const gateway = {
		...model,
		baseUrl: "https://gateway.example/v1",
		provider: "example",
		compat: { sendIdempotencyKey: true },
	};
	const options = { apiKey: "test", fetch, maxRetries: 2 };
	const stream =
		api === "chat"
			? streamChat({ ...gateway, api: "openai-completions" }, context, options)
			: streamResponses(gateway, context, options);
	const result = await stream.result();
	assert.equal(attempts, expectedAttempts);
	assert.equal(result.stopReason, "error");
	assert.ok(result.errorMessage?.includes(code));
});
