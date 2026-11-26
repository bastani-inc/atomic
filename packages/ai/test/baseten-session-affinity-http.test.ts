import { createServer, type IncomingHttpHeaders } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getFixtureModel } from "../../../test/helpers/catalog-model-fixtures.ts";
import type { OpenAICompletionsOptions } from "../src/api/openai-completions.ts";
import { stream } from "../src/api/openai-completions.ts";

import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

let headers: IncomingHttpHeaders;
let path: string | undefined;
let baseUrl: string;
const server = createServer((request, response) => {
	headers = request.headers;
	path = request.url;
	request.resume();
	response.writeHead(200, { "content-type": "text/event-stream" });
	response.end(
		'data: {"id":"test","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
	);
});

beforeAll(async () => {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected TCP address");
	baseUrl = `http://127.0.0.1:${address.port}/v1`;
});
afterAll(async () => {
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

async function request(options: OpenAICompletionsOptions = {}, overrides: Partial<Model<"openai-completions">> = {}) {
	const model = { ...getFixtureModel("baseten", "zai-org/GLM-5.2"), ...overrides, baseUrl };
	const result = await stream(model, normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] }), {
		apiKey: "test",
		sessionId: "baseten-session",
		...options,
	}).result();
	expect(result.stopReason).toBe("stop");
	expect(path).toBe("/v1/chat/completions");
	return headers;
}

describe("Baseten catalog session affinity over HTTP", () => {
	it("sends both affinity headers through the real SDK", async () => {
		// Regression for upstream #9629: capture the actual outgoing HTTP request.
		expect(getFixtureModel("baseten", "zai-org/GLM-5.2").compat?.sendSessionAffinityHeaders).toBe(true);
		const captured = await request();
		expect(captured["x-session-affinity"]).toBe("baseten-session");
		expect(captured["x-client-request-id"]).toBe("baseten-session");
	});
	it.each([{ cacheRetention: "none" as const }, { sessionId: undefined }])(
		"omits automatic headers for %j",
		async (options) => {
			const captured = await request(options);
			expect(captured["x-session-affinity"]).toBeUndefined();
			expect(captured["x-client-request-id"]).toBeUndefined();
		},
	);
	it("respects the compatibility opt-out", async () => {
		const catalog = getFixtureModel("baseten", "zai-org/GLM-5.2");
		const captured = await request({}, { compat: { ...catalog.compat, sendSessionAffinityHeaders: false } });
		expect(captured["x-session-affinity"]).toBeUndefined();
		expect(captured["x-client-request-id"]).toBeUndefined();
	});
	it("preserves model overrides", async () => {
		const captured = await request(
			{},
			{ headers: { "x-session-affinity": "model", "x-client-request-id": "model-request" } },
		);
		expect(captured["x-session-affinity"]).toBe("model");
		expect(captured["x-client-request-id"]).toBe("model-request");
	});
	it.each(["request", null])("gives request headers precedence including null suppression: %s", async (value) => {
		const captured = await request(
			{ headers: { "x-session-affinity": value, "x-client-request-id": value } },
			{ headers: { "x-session-affinity": "model", "x-client-request-id": "model" } },
		);
		expect(captured["x-session-affinity"]).toBe(value ?? undefined);
		expect(captured["x-client-request-id"]).toBe(value ?? undefined);
	});
});
