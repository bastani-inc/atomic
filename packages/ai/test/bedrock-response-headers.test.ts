import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getFixtureModel } from "../../../test/helpers/catalog-model-fixtures.ts";
import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { normalizeContext } from "../src/compat.ts";
import type { Model, ProviderResponse } from "../src/types.ts";

const MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0";

let server: Server | undefined;

afterEach(async () => {
	vi.restoreAllMocks();
	if (!server) return;
	await new Promise<void>((resolve, reject) => {
		server?.close((error) => (error ? reject(error) : resolve()));
	});
	server = undefined;
});

async function startBedrockResponseServer(): Promise<string> {
	server = createServer((_req, res) => {
		res.writeHead(200, {
			"content-type": "application/vnd.amazon.eventstream",
			"x-bifrost-provider": "bedrock",
			"x-bifrost-resolved-model": MODEL_ID,
			"x-amzn-requestid": "req-123",
		});
		res.end();
	});

	await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected TCP test server address");
	return `http://127.0.0.1:${address.port}`;
}

describe("Bedrock SDK retry hints", () => {
	it.each([
		{ name: "over-cap throttle", status: 429, code: "ThrottlingException", hintMs: 360_000, requests: 1 },
		{ name: "short throttle", status: 429, code: "ThrottlingException", hintMs: 50, requests: 2 },
		{ name: "over-cap server error", status: 503, code: "ServiceUnavailableException", hintMs: 360_000, requests: 1 },
		{
			name: "over-cap AWS retry header",
			status: 429,
			code: "ThrottlingException",
			hintMs: 360_000,
			requests: 1,
			awsHeader: true,
		},
		{
			name: "millisecond hint with the cap disabled",
			status: 503,
			code: "ServiceUnavailableException",
			hintMs: 120,
			requests: 2,
			disableCap: true,
		},
	])(
		"honors the retry cap on a $name",
		async ({ status, code, hintMs, requests, awsHeader, disableCap }) => {
			if (disableCap) vi.spyOn(Math, "random").mockReturnValue(0);
			const attempts: number[] = [];
			server = createServer((_req, res) => {
				attempts.push(performance.now());
				res.writeHead(status, {
					"content-type": "application/json",
					"x-amzn-errortype": code,
					...(disableCap
						? { "retry-after-ms": String(hintMs) }
						: awsHeader
							? { "x-amz-retry-after": String(hintMs) }
							: { "retry-after": String(hintMs / 1000) }),
				});
				res.end(JSON.stringify({ message: "Cannot serve." }));
			});
			await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Expected TCP test server address");
			const result = await streamBedrock(
				{ ...getFixtureModel("amazon-bedrock", MODEL_ID), baseUrl: `http://127.0.0.1:${address.port}` },
				normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 0 }] }),
				{
					cacheRetention: "none",
					env: { AWS_BEDROCK_FORCE_HTTP1: "1", AWS_BEDROCK_SKIP_AUTH: "1" },
					maxRetries: 1,
					maxRetryDelayMs: disableCap ? 0 : 60_000,
				},
			).result();
			expect(attempts).toHaveLength(requests);
			if (disableCap) expect(attempts[1]! - attempts[0]!).toBeGreaterThanOrEqual(hintMs);
			expect(result.stopReason).toBe("error");
			expect(result.retryAfterMs).toBe(hintMs);
		},
		12_000,
	);
});

describe("bedrock response headers", () => {
	it("forwards raw Smithy response headers to onResponse", async () => {
		const baseModel = getFixtureModel("amazon-bedrock", MODEL_ID) as Model<"bedrock-converse-stream">;
		const model = { ...baseModel, baseUrl: await startBedrockResponseServer() };
		const responses: ProviderResponse[] = [];

		const result = await streamBedrock(
			model,
			normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: Date.now() }] }),
			{
				cacheRetention: "none",
				env: { AWS_BEDROCK_FORCE_HTTP1: "1", AWS_BEDROCK_SKIP_AUTH: "1" },
				onResponse: (response) => {
					responses.push(response);
				},
			},
		).result();

		// The fake server intentionally returns an empty event stream; this assertion
		// documents that the header callback still fires before stream consumption.
		expect(result.stopReason).toBe("error");
		expect(responses).toHaveLength(1);
		expect(responses[0].status).toBe(200);
		expect(responses[0].headers["x-amzn-requestid"]).toBe("req-123");
		expect(responses[0].headers["x-bifrost-provider"]).toBe("bedrock");
		expect(responses[0].headers["x-bifrost-resolved-model"]).toBe(MODEL_ID);
	});
});
