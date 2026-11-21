import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import diagnosticsChannel from "node:diagnostics_channel";
import { type ClientRequest, type Server as HttpServer, createServer as createHttpServer } from "node:http";
import { type Server as NetServer, createServer as createNetServer, type Socket } from "node:net";
import { afterEach, describe, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { getModel } from "../src/compat.ts";
import type { Api, AssistantMessage, Model } from "../src/types.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] });
/** SDK-level retries Bedrock is allowed: a reset connection uses them, as on the other adapters. */
const SDK_RETRIES = 2;
/** Structural: starts Bun, as the standalone binary runs Bedrock's proxy agents. */
const BUN_CHILD_TIMEOUT_MS = 60_000;

const servers: (NetServer | HttpServer)[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function listen(server: NetServer | HttpServer): Promise<number> {
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address !== null && typeof address === "object");
	return address.port;
}

/** A proxy that closes every connection at once, before TLS or the tunnel request; counts the connections. */
async function closingProxy(): Promise<{ port: number; connections(): number }> {
	let connections = 0;
	const proxy = createNetServer((socket: Socket) => {
		connections++;
		socket.on("error", () => {});
		socket.destroy();
	});
	return { port: await listen(proxy), connections: () => connections };
}

function bedrockTurn(baseUrl: string, proxyUrl: string): Promise<AssistantMessage> {
	const model = getModel("amazon-bedrock", "us.anthropic.claude-haiku-4-5-20251001-v1:0") as Model<"bedrock-converse-stream">;
	return streamBedrock({ ...model, baseUrl }, context, {
		cacheRetention: "none",
		maxRetries: SDK_RETRIES,
		env: {
			AWS_BEDROCK_SKIP_AUTH: "1",
			AWS_REGION: "us-east-1",
			HTTPS_PROXY: proxyUrl,
			HTTP_PROXY: proxyUrl,
			NO_PROXY: "none.invalid",
		},
	}).result();
}

describe("Amazon Bedrock through a proxy whose connection fails", () => {
	it("fails as a connection reset that is retried, and never ends the process, when an https proxy closes the connection before its TLS handshake", async () => {
		const uncaught: unknown[] = [];
		const record = (error: unknown) => uncaught.push(error);
		process.prependListener("uncaughtException", record);
		try {
			for (const baseUrl of ["https://localhost:9", "http://127.0.0.1:9"]) {
				const proxy = await closingProxy();
				const message = await bedrockTurn(baseUrl, `https://localhost:${proxy.port}`);
				// Node.js's TLS layer reports a connection that ended before its handshake a tick after the end.
				await new Promise((resolve) => setTimeout(resolve, 50));

				assert.equal(message.stopReason, "error");
				assert.equal(isRetryableAssistantError(message), true, `${baseUrl}: ${message.errorMessage}`);
				assert.equal(proxy.connections(), 1 + SDK_RETRIES, `${baseUrl}: ${message.errorMessage}`);
			}
			assert.deepEqual(uncaught, []);
		} finally {
			process.removeListener("uncaughtException", record);
		}
	});

	it("fails as a connection reset that is retried when a plain proxy closes the connection before answering the tunnel request", async () => {
		const proxy = await closingProxy();
		const message = await bedrockTurn("https://localhost:9", `http://127.0.0.1:${proxy.port}`);

		assert.equal(message.stopReason, "error");
		assert.equal(isRetryableAssistantError(message), true, message.errorMessage);
		assert.equal(proxy.connections(), 1 + SDK_RETRIES);
	});

	it("still reports a tunnel the proxy refused as the proxy's answer, sent once, with the request's proxy events", async () => {
		let requests = 0;
		const proxy = createHttpServer();
		proxy.on("connect", (_request, client: Socket) => {
			requests++;
			client.end("HTTP/1.1 403 Forbidden\r\nX-Reason: listed\r\nContent-Length: 0\r\n\r\n");
		});
		const port = await listen(proxy);
		// The events https-proxy-agent emits on the request for its tunnel, which instrumentation may listen to.
		const events: string[] = [];
		const onRequest = (message: unknown) => {
			const { request } = message as { request: ClientRequest };
			request.on("proxyConnect", (connect: { statusCode: number; statusText: string; headers: object }) =>
				events.push(`proxyConnect ${connect.statusCode} ${connect.statusText} ${JSON.stringify(connect.headers)}`),
			);
			request.on("proxy", (proxied: { proxy: string }) => events.push(`proxy ${proxied.proxy}`));
		};
		diagnosticsChannel.subscribe("http.client.request.created", onRequest);
		try {
			const message = await bedrockTurn("https://localhost:9", `http://127.0.0.1:${port}`);

			assert.equal(message.stopReason, "error");
			assert.equal(isRetryableAssistantError(message), false, message.errorMessage);
			assert.equal(requests, 1);
			assert.deepEqual(events, [
				'proxyConnect 403 Forbidden {"x-reason":"listed","content-length":"0"}',
				`proxy http://127.0.0.1:${port}/`,
			]);
		} finally {
			diagnosticsChannel.unsubscribe("http.client.request.created", onRequest);
		}
	});

	it(
		"fails as a connection reset that is retried under Bun, as the standalone binary runs it",
		async () => {
			// One proxy for the request to an HTTPS endpoint, whose tunnel Atomic opens, one for a plain-HTTP endpoint.
			const proxies = [await closingProxy(), await closingProxy()];
			const cases = [
				{ baseUrl: "https://localhost:9", proxyUrl: `https://localhost:${proxies[0]?.port}` },
				{ baseUrl: "http://127.0.0.1:9", proxyUrl: `https://localhost:${proxies[1]?.port}` },
			];
			const source = [
				`const { stream } = await import(${JSON.stringify(new URL("../src/api/bedrock-converse-stream.ts", import.meta.url).href)});`,
				`const { getModel } = await import(${JSON.stringify(new URL("../src/compat.ts", import.meta.url).href)});`,
				`const { isRetryableAssistantError } = await import(${JSON.stringify(new URL("../src/utils/retry.ts", import.meta.url).href)});`,
				`const uncaught = [];`,
				`process.on("uncaughtException", (error) => uncaught.push(String(error)));`,
				`const model = getModel("amazon-bedrock", "us.anthropic.claude-haiku-4-5-20251001-v1:0");`,
				`const results = [];`,
				`for (const { baseUrl, proxyUrl } of ${JSON.stringify(cases)}) {`,
				`	const env = { AWS_BEDROCK_SKIP_AUTH: "1", AWS_REGION: "us-east-1", HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl, NO_PROXY: "none.invalid" };`,
				`	const message = await stream({ ...model, baseUrl }, { messages: [{ role: "user", content: "hello", timestamp: 1 }] }, { cacheRetention: "none", maxRetries: ${SDK_RETRIES}, env }).result();`,
				`	await new Promise((resolve) => setTimeout(resolve, 50));`,
				`	results.push({ stopReason: message.stopReason, retryable: isRetryableAssistantError(message), message: message.errorMessage });`,
				`}`,
				`console.log(JSON.stringify({ results, uncaught }));`,
			].join("\n");
			const printed = await new Promise<string>((resolve, reject) => {
				execFile(
					"bun",
					["--eval", source],
					{ cwd: new URL("..", import.meta.url), timeout: BUN_CHILD_TIMEOUT_MS, encoding: "utf8" },
					(error, stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout)),
				);
			});
			const { results, uncaught } = JSON.parse(printed) as {
				results: { stopReason: string; retryable: boolean; message: string }[];
				uncaught: string[];
			};
			assert.deepEqual(uncaught, []);
			for (const result of results) {
				assert.equal(result.stopReason, "error");
				assert.equal(result.retryable, true, result.message);
			}
			// The tunnel's failure reads as a reset connection under Bun too, so the SDK retries it as on Node.js.
			assert.equal(proxies[0]?.connections(), 1 + SDK_RETRIES, results[0]?.message);
		},
		BUN_CHILD_TIMEOUT_MS,
	);
});

describe("a Bedrock failure that is not its connection's", () => {
	it("keeps its own message and is not retried, though it carries a connection error's code", async () => {
		const model = getModel("amazon-bedrock", "us.anthropic.claude-haiku-4-5-20251001-v1:0") as Model<"bedrock-converse-stream">;
		for (const code of ["ERR_SOCKET_CLOSED", "ECONNRESET", "EACCES"]) {
			// A hook that stops the request before anything is sent, with a code of its own.
			const message = await streamBedrock({ ...model, baseUrl: "https://localhost:9" }, context, {
				cacheRetention: "none",
				maxRetries: SDK_RETRIES,
				env: { AWS_BEDROCK_SKIP_AUTH: "1", AWS_REGION: "us-east-1" },
				onPayload: async () => {
					throw Object.assign(new Error("Application preparation stopped"), { code });
				},
			}).result();

			assert.equal(message.stopReason, "error");
			assert.equal(message.errorMessage, "Application preparation stopped", code);
			assert.equal(isRetryableAssistantError(message), false, code);
		}
	});

	it("keeps an onResponse hook's own message, and does not retry it, though it carries a connection error's code", async () => {
		const endpoint = createHttpServer((request, response) => {
			request.resume();
			response.writeHead(400, { "content-type": "application/json" }).end('{"message":"bad request"}');
		});
		const port = await listen(endpoint);
		const model = getModel("amazon-bedrock", "us.anthropic.claude-haiku-4-5-20251001-v1:0") as Model<"bedrock-converse-stream">;
		for (const code of ["ERR_SOCKET_CLOSED", "ECONNRESET", "EACCES"]) {
			const message = await streamBedrock({ ...model, baseUrl: `http://127.0.0.1:${port}` }, context, {
				cacheRetention: "none",
				maxRetries: 0,
				env: { AWS_BEDROCK_FORCE_HTTP1: "1", AWS_BEDROCK_SKIP_AUTH: "1", AWS_REGION: "us-east-1" },
				onResponse: async () => {
					throw Object.assign(new Error("Response check stopped"), { code });
				},
			}).result();

			assert.equal(message.stopReason, "error");
			assert.equal(message.errorMessage, "Response check stopped", code);
			assert.equal(isRetryableAssistantError(message), false, code);
		}
	});
});

describe("a provider's answer that names a connection error", () => {
	it("is not retried for its text: an HTTP 400 whose body names a closed socket or a dropped proxy connection", async () => {
		// What a connection error reads like on Node.js and Bun, quoted by a provider in an answer to a bad request.
		const quoted = [
			"ERR_SOCKET_CLOSED",
			"Socket is closed",
			"Proxy connection ended before receiving CONNECT response",
			"Client network socket disconnected before secure TLS connection was established",
		].join("; ");
		const endpoint = createHttpServer((request, response) => {
			request.resume();
			response.writeHead(400, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: { type: "invalid_request_error", message: quoted }, message: quoted }));
		});
		const port = await listen(endpoint);
		const baseUrl = `http://127.0.0.1:${port}`;
		const model = <TApi extends Api>(api: TApi, url: string): Model<TApi> => ({
			id: "test-model",
			name: "Test Model",
			api,
			provider: "test-provider",
			baseUrl: url,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 10_000,
			maxTokens: 1_000,
		});
		const bedrock = getModel("amazon-bedrock", "us.anthropic.claude-haiku-4-5-20251001-v1:0") as Model<"bedrock-converse-stream">;
		const answers: [string, AssistantMessage][] = [
			[
				"Anthropic",
				await streamAnthropic(model("anthropic-messages", baseUrl), context, { apiKey: "test-key", maxRetries: 0 }).result(),
			],
			[
				"OpenAI Completions",
				await streamOpenAICompletions(model("openai-completions", `${baseUrl}/v1`), context, {
					apiKey: "test-key",
					maxRetries: 0,
				}).result(),
			],
			[
				"Amazon Bedrock",
				await streamBedrock({ ...bedrock, baseUrl }, context, {
					cacheRetention: "none",
					maxRetries: 0,
					env: { AWS_BEDROCK_FORCE_HTTP1: "1", AWS_BEDROCK_SKIP_AUTH: "1", AWS_REGION: "us-east-1" },
				}).result(),
			],
		];
		for (const [provider, message] of answers) {
			assert.equal(message.stopReason, "error", provider);
			assert.ok(message.errorMessage?.includes("ERR_SOCKET_CLOSED"), `${provider}: ${message.errorMessage}`);
			assert.equal(isRetryableAssistantError(message), false, `${provider}: ${message.errorMessage}`);
		}
	});
});
