import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import diagnosticsChannel from "node:diagnostics_channel";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type ClientRequest, type Server as HttpServer, createServer as createHttpServer } from "node:http";
import { type Server as NetServer, createServer as createNetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { TLSSocket } from "node:tls";
import { crc32 } from "node:zlib";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { afterEach, describe, it, vi } from "vitest";
import { createTestCertificate } from "../../../test/helpers/tls-certificates.ts";
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
const tempDirs: string[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Encode one AWS event-stream frame (prelude, CRCs, string headers, payload) as Bedrock sends it. */
function encodeEventStreamFrame(headers: Record<string, string>, payload: string): Buffer {
	const headerBytes = Buffer.concat(
		Object.entries(headers).map(([name, value]) => {
			const nameBytes = Buffer.from(name, "utf8");
			const valueBytes = Buffer.from(value, "utf8");
			const valueLength = Buffer.alloc(2);
			valueLength.writeUInt16BE(valueBytes.length);
			// Header value type 7 is a UTF-8 string.
			return Buffer.concat([Buffer.from([nameBytes.length]), nameBytes, Buffer.from([7]), valueLength, valueBytes]);
		}),
	);
	const payloadBytes = Buffer.from(payload, "utf8");
	const prelude = Buffer.alloc(8);
	prelude.writeUInt32BE(12 + headerBytes.length + payloadBytes.length + 4, 0);
	prelude.writeUInt32BE(headerBytes.length, 4);
	const preludeCrc = Buffer.alloc(4);
	preludeCrc.writeUInt32BE(crc32(prelude));
	const message = Buffer.concat([prelude, preludeCrc, headerBytes, payloadBytes]);
	const messageCrc = Buffer.alloc(4);
	messageCrc.writeUInt32BE(crc32(message));
	return Buffer.concat([message, messageCrc]);
}

function bedrockEventStream(text: string): Buffer {
	const event = (type: string, body: object) =>
		encodeEventStreamFrame(
			{ ":event-type": type, ":message-type": "event", ":content-type": "application/json" },
			JSON.stringify(body),
		);
	return Buffer.concat([
		event("messageStart", { role: "assistant" }),
		event("contentBlockDelta", { contentBlockIndex: 0, delta: { text } }),
		event("contentBlockStop", { contentBlockIndex: 0 }),
		event("messageStop", { stopReason: "end_turn" }),
		event("metadata", { usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 }, metrics: { latencyMs: 1 } }),
	]);
}

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
			// Closing proxies and endpoints covering every HTTP/1.1 TLS close path under Bun:
			// 0: https:// endpoint through https:// proxy (tunnel closes before proxy TLS handshake)
			// 1: plain-HTTP endpoint through https:// proxy (connection closes before proxy TLS handshake)
			// 2: https:// endpoint through http:// proxy (tunnel closes after 200 CONNECT before endpoint TLS handshake)
			// 3: direct https:// endpoint with AWS_BEDROCK_FORCE_HTTP1=1 (closes before endpoint TLS handshake)
			const httpsTunnelProxy = await closingProxy();
			const httpsForwardProxy = await closingProxy();
			let httpAfter200Connections = 0;
			const httpAfter200Proxy = createNetServer((socket: Socket) => {
				httpAfter200Connections++;
				socket.on("error", () => {});
				socket.once("data", () => {
					socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
					setTimeout(() => socket.destroy(), 15);
				});
			});
			const httpAfter200Port = await listen(httpAfter200Proxy);
			const directH1Endpoint = await closingProxy();

			// Transient recovery: an https:// proxy that closes the first connection before TLS for a plain-HTTP endpoint,
			// then completes TLS and answers with a valid Bedrock stream on the SDK retry.
			const ca = createTestCertificate({ subject: "Bedrock Test CA", ca: true, keyUsage: ["keyCertSign"] });
			const leaf = createTestCertificate({
				subject: "localhost",
				issuer: ca,
				keyUsage: ["digitalSignature"],
				extendedKeyUsage: ["serverAuth"],
				altNames: ["localhost"],
			});
			const caDir = mkdtempSync(join(tmpdir(), "atomic-bedrock-ca-"));
			tempDirs.push(caDir);
			const caPath = join(caDir, "ca.pem");
			writeFileSync(caPath, ca.cert);
			const streamBody = bedrockEventStream("recovered");
			let transientConnections = 0;
			const transientProxy = createNetServer((socket: Socket) => {
				transientConnections++;
				socket.on("error", () => {});
				if (transientConnections === 1) {
					socket.destroy();
					return;
				}
				const tlsSocket = new TLSSocket(socket, { isServer: true, cert: leaf.cert, key: leaf.key });
				tlsSocket.on("error", () => {});
				let received = Buffer.alloc(0);
				let responded = false;
				tlsSocket.on("data", (chunk: Buffer) => {
					received = Buffer.concat([received, chunk]);
					if (responded) return;
					const headerEnd = received.indexOf("\r\n\r\n");
					if (headerEnd === -1) return;
					const headersText = received.subarray(0, headerEnd).toString("latin1");
					const lengthMatch = headersText.match(/\r\ncontent-length:\s*(\d+)/i);
					const contentLength = lengthMatch ? Number(lengthMatch[1]) : 0;
					if (received.length < headerEnd + 4 + contentLength) return;
					responded = true;
					tlsSocket.end(
						Buffer.concat([
							Buffer.from(
								`HTTP/1.1 200 OK\r\nContent-Type: application/vnd.amazon.eventstream\r\nContent-Length: ${streamBody.length}\r\nConnection: close\r\n\r\n`,
								"latin1",
							),
							streamBody,
						]),
					);
				});
			});
			const transientPort = await listen(transientProxy);

			const cases = [
				{
					name: "httpsProxy_httpsEndpoint",
					baseUrl: "https://localhost:9",
					env: {
						HTTPS_PROXY: `https://localhost:${httpsTunnelProxy.port}`,
						HTTP_PROXY: `https://localhost:${httpsTunnelProxy.port}`,
					},
				},
				{
					name: "httpsProxy_plainEndpoint",
					baseUrl: "http://127.0.0.1:9",
					env: {
						HTTPS_PROXY: `https://localhost:${httpsForwardProxy.port}`,
						HTTP_PROXY: `https://localhost:${httpsForwardProxy.port}`,
					},
				},
				{
					name: "httpProxy_finAfter200_httpsEndpoint",
					baseUrl: "https://localhost:9",
					env: {
						HTTPS_PROXY: `http://127.0.0.1:${httpAfter200Port}`,
						HTTP_PROXY: `http://127.0.0.1:${httpAfter200Port}`,
					},
				},
				{
					name: "direct_h1_httpsEndpoint",
					baseUrl: `https://localhost:${directH1Endpoint.port}`,
					env: { AWS_BEDROCK_FORCE_HTTP1: "1" },
				},
				{
					name: "httpsProxy_plainEndpoint_transientRecovery",
					baseUrl: "http://127.0.0.1:9",
					env: {
						HTTPS_PROXY: `https://localhost:${transientPort}`,
						HTTP_PROXY: `https://localhost:${transientPort}`,
					},
				},
			];
			const source = [
				`const { stream } = await import(${JSON.stringify(new URL("../src/api/bedrock-converse-stream.ts", import.meta.url).href)});`,
				`const { getModel } = await import(${JSON.stringify(new URL("../src/compat.ts", import.meta.url).href)});`,
				`const { isRetryableAssistantError } = await import(${JSON.stringify(new URL("../src/utils/retry.ts", import.meta.url).href)});`,
				`const uncaught = [];`,
				`process.on("uncaughtException", (error) => uncaught.push(String(error)));`,
				`const model = getModel("amazon-bedrock", "us.anthropic.claude-haiku-4-5-20251001-v1:0");`,
				`const results = [];`,
				`for (const c of ${JSON.stringify(cases)}) {`,
				`	const env = { AWS_BEDROCK_SKIP_AUTH: "1", AWS_REGION: "us-east-1", NO_PROXY: "none.invalid", ...c.env };`,
				`	const message = await stream({ ...model, baseUrl: c.baseUrl }, { messages: [{ role: "user", content: "hello", timestamp: 1 }] }, { cacheRetention: "none", maxRetries: ${SDK_RETRIES}, env }).result();`,
				`	await new Promise((resolve) => setTimeout(resolve, 50));`,
				`	const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("");`,
				`	results.push({ name: c.name, stopReason: message.stopReason, retryable: isRetryableAssistantError(message), message: message.errorMessage, text });`,
				`}`,
				`console.log(JSON.stringify({ results, uncaught }));`,
			].join("\n");
			const printed = await new Promise<string>((resolve, reject) => {
				execFile(
					"bun",
					["--eval", source],
					{
						cwd: new URL("..", import.meta.url),
						env: { ...process.env, NODE_EXTRA_CA_CERTS: caPath },
						timeout: BUN_CHILD_TIMEOUT_MS,
						encoding: "utf8",
					},
					(error, stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout)),
				);
			});
			const { results, uncaught } = JSON.parse(printed) as {
				results: { name: string; stopReason: string; retryable: boolean; message?: string; text: string }[];
				uncaught: string[];
			};
			assert.deepEqual(uncaught, []);
			for (const result of results.slice(0, 4)) {
				assert.equal(result.stopReason, "error", result.name);
				assert.equal(result.retryable, true, `${result.name}: ${result.message}`);
				assert.equal(result.message?.includes("(ERR_SOCKET_CLOSED)"), false, `${result.name}: ${result.message}`);
			}
			// Every HTTP/1.1 TLS-close path reads as a reset connection under Bun too, so the SDK retries it as on Node.js.
			assert.equal(httpsTunnelProxy.connections(), 1 + SDK_RETRIES, results[0]?.message);
			assert.equal(httpsForwardProxy.connections(), 1 + SDK_RETRIES, results[1]?.message);
			assert.equal(httpAfter200Connections, 1 + SDK_RETRIES, results[2]?.message);
			assert.equal(directH1Endpoint.connections(), 1 + SDK_RETRIES, results[3]?.message);
			// When the first connection closes before TLS and the retry succeeds, the SDK recovers transparently.
			assert.equal(results[4]?.stopReason, "stop", results[4]?.message);
			assert.equal(results[4]?.text, "recovered");
			assert.equal(transientConnections, 2);
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

	it("does not take a hook's error for the connection's because an earlier request's connection failed with that object", async () => {
		// The HTTP handler fails the first request with an error object that a hook throws again in the next one.
		const shared = Object.assign(new Error("Transport stopped"), { code: "ECONNRESET" });
		const handle = vi.spyOn(NodeHttpHandler.prototype, "handle").mockRejectedValue(shared);
		const model = getModel("amazon-bedrock", "us.anthropic.claude-haiku-4-5-20251001-v1:0") as Model<"bedrock-converse-stream">;
		const turn = (hooks: { onPayload?: () => Promise<undefined> }) =>
			streamBedrock({ ...model, baseUrl: "https://localhost:9" }, context, {
				cacheRetention: "none",
				maxRetries: 0,
				env: { AWS_BEDROCK_FORCE_HTTP1: "1", AWS_BEDROCK_SKIP_AUTH: "1", AWS_REGION: "us-east-1" },
				...hooks,
			}).result();
		try {
			const first = await turn({});
			assert.equal(handle.mock.calls.length, 1);
			assert.equal(first.errorMessage, "Transport stopped (ECONNRESET)");
			assert.equal(isRetryableAssistantError(first), true);

			const second = await turn({
				onPayload: async () => {
					throw shared;
				},
			});
			assert.equal(handle.mock.calls.length, 1);
			assert.equal(second.errorMessage, "Transport stopped");
			assert.equal(isRetryableAssistantError(second), false);
		} finally {
			handle.mockRestore();
		}
	});

	it("does not take a hook's error for the connection's because an earlier attempt's connection failed with that object", async () => {
		// The HTTP handler fails the first attempt with an error object; the retry gets an answer, and the onResponse hook
		// throws that object again.
		const shared = Object.assign(new Error("Transport stopped"), { code: "ECONNRESET" });
		const handle = vi
			.spyOn(NodeHttpHandler.prototype, "handle")
			.mockRejectedValueOnce(shared)
			.mockResolvedValueOnce({
				response: { statusCode: 400, reason: "Bad Request", headers: {}, body: Readable.from([]) },
			} as Awaited<ReturnType<NodeHttpHandler["handle"]>>);
		const model = getModel("amazon-bedrock", "us.anthropic.claude-haiku-4-5-20251001-v1:0") as Model<"bedrock-converse-stream">;
		try {
			const message = await streamBedrock({ ...model, baseUrl: "https://localhost:9" }, context, {
				cacheRetention: "none",
				maxRetries: 1,
				env: { AWS_BEDROCK_FORCE_HTTP1: "1", AWS_BEDROCK_SKIP_AUTH: "1", AWS_REGION: "us-east-1" },
				onResponse: async () => {
					throw shared;
				},
			}).result();
			assert.equal(handle.mock.calls.length, 2);
			assert.equal(message.errorMessage, "Transport stopped");
			assert.equal(isRetryableAssistantError(message), false);
		} finally {
			handle.mockRestore();
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

describe("Bedrock's tunnel request and connection errors", () => {
	it("sends the CONNECT request https-proxy-agent sends, with the proxy URL's credentials decoded", async () => {
		// A proxy that records what it is sent up to the blank line ending the headers, then refuses the tunnel.
		const received: Buffer[] = [];
		const proxy = createNetServer((socket: Socket) => {
			socket.on("error", () => {});
			socket.on("data", (chunk: Buffer) => {
				received.push(chunk);
				if (Buffer.concat(received).includes("\r\n\r\n"))
					socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
			});
		});
		const port = await listen(proxy);
		await bedrockTurn("https://localhost:9", `http://us%40er:p%3Ass%20w@127.0.0.1:${port}`);

		const credentials = Buffer.from("us@er:p:ss w").toString("base64");
		assert.equal(
			Buffer.concat(received).toString("latin1"),
			`CONNECT localhost:9 HTTP/1.1\r\nProxy-Authorization: Basic ${credentials}\r\nHost: localhost:9\r\nProxy-Connection: close\r\n\r\n`,
		);
	});

	it("names each connection error by its own code, and Bun's closed socket as the reset it is", async () => {
		const model = getModel("amazon-bedrock", "us.anthropic.claude-haiku-4-5-20251001-v1:0") as Model<"bedrock-converse-stream">;
		const failures: [Error, string][] = [
			[Object.assign(new Error("Transport stopped"), { code: "ECONNREFUSED" }), "Transport stopped (ECONNREFUSED)"],
			[Object.assign(new Error("Transport stopped"), { code: "ETIMEDOUT" }), "Transport stopped (ETIMEDOUT)"],
			[Object.assign(new Error("Transport stopped"), { code: "EPIPE" }), "Transport stopped (EPIPE)"],
			[Object.assign(new Error("Transport stopped"), { code: "ECONNRESET" }), "Transport stopped (ECONNRESET)"],
			[Object.assign(new Error("Transport stopped"), { code: "ERR_SOCKET_CLOSED" }), "Transport stopped (ECONNRESET)"],
			[Object.assign(new Error(""), { code: "ERR_SOCKET_CLOSED" }), "ECONNRESET"],
			[
				Object.assign(new Error("Transport stopped", { cause: Object.assign(new Error("inner"), { code: "EPIPE" }) }), {
					code: "ERR_SOCKET_CLOSED",
				}),
				"Transport stopped: inner (EPIPE) (ECONNRESET)",
			],
			// Node.js on Windows can report a refused connection to localhost with no message of its own.
			[Object.assign(new AggregateError([], ""), { code: "ECONNREFUSED" }), "ECONNREFUSED"],
		];
		const handle = vi.spyOn(NodeHttpHandler.prototype, "handle");
		try {
			for (const [failure, expected] of failures) {
				handle.mockRejectedValueOnce(failure);
				const message = await streamBedrock({ ...model, baseUrl: "https://localhost:9" }, context, {
					cacheRetention: "none",
					maxRetries: 0,
					env: { AWS_BEDROCK_FORCE_HTTP1: "1", AWS_BEDROCK_SKIP_AUTH: "1", AWS_REGION: "us-east-1" },
				}).result();
				assert.equal(message.errorMessage, expected);
				assert.equal(isRetryableAssistantError(message), true, expected);
			}
		} finally {
			handle.mockRestore();
		}
	});

	it("retries a closed-socket transport failure at the SDK level without mutating the original error or retrying hooks", async () => {
		const shared = Object.assign(new Error("Socket is closed"), { code: "ERR_SOCKET_CLOSED" });
		const handle = vi.spyOn(NodeHttpHandler.prototype, "handle").mockRejectedValue(shared);
		const model = getModel("amazon-bedrock", "us.anthropic.claude-haiku-4-5-20251001-v1:0") as Model<"bedrock-converse-stream">;
		try {
			const first = await streamBedrock({ ...model, baseUrl: "https://localhost:9" }, context, {
				cacheRetention: "none",
				maxRetries: SDK_RETRIES,
				env: { AWS_BEDROCK_FORCE_HTTP1: "1", AWS_BEDROCK_SKIP_AUTH: "1", AWS_REGION: "us-east-1" },
			}).result();
			assert.equal(handle.mock.calls.length, 1 + SDK_RETRIES);
			assert.equal(first.errorMessage, "Socket is closed (ECONNRESET)");
			assert.equal(isRetryableAssistantError(first), true);
			assert.equal(shared.code, "ERR_SOCKET_CLOSED");

			// Re-throwing the same object from a hook in a later request keeps its message and is never retried.
			const second = await streamBedrock({ ...model, baseUrl: "https://localhost:9" }, context, {
				cacheRetention: "none",
				maxRetries: SDK_RETRIES,
				env: { AWS_BEDROCK_FORCE_HTTP1: "1", AWS_BEDROCK_SKIP_AUTH: "1", AWS_REGION: "us-east-1" },
				onPayload: async () => {
					throw shared;
				},
			}).result();
			assert.equal(handle.mock.calls.length, 1 + SDK_RETRIES);
			assert.equal(second.errorMessage, "Socket is closed");
			assert.equal(isRetryableAssistantError(second), false);

			// Attempt 1 fails with shared ERR_SOCKET_CLOSED; Attempt 2 gets an answer and onResponse throws shared:
			// Attempt 3 must never run because shared was not mutated to ECONNRESET.
			handle.mockReset();
			handle.mockRejectedValueOnce(shared).mockResolvedValueOnce({
				response: { statusCode: 400, reason: "Bad Request", headers: {}, body: Readable.from([]) },
			} as Awaited<ReturnType<NodeHttpHandler["handle"]>>);
			const third = await streamBedrock({ ...model, baseUrl: "https://localhost:9" }, context, {
				cacheRetention: "none",
				maxRetries: SDK_RETRIES,
				env: { AWS_BEDROCK_FORCE_HTTP1: "1", AWS_BEDROCK_SKIP_AUTH: "1", AWS_REGION: "us-east-1" },
				onResponse: async () => {
					throw shared;
				},
			}).result();
			assert.equal(handle.mock.calls.length, 2);
			assert.equal(third.errorMessage, "Socket is closed");
			assert.equal(isRetryableAssistantError(third), false);
			assert.equal(shared.code, "ERR_SOCKET_CLOSED");
		} finally {
			handle.mockRestore();
		}
	});

	it("never normalizes or SDK-retries ERR_SOCKET_CLOSED after response headers arrive, with response metadata, on abort, or for other codes", async () => {
		const model = getModel("amazon-bedrock", "us.anthropic.claude-haiku-4-5-20251001-v1:0") as Model<"bedrock-converse-stream">;
		const handle = vi.spyOn(NodeHttpHandler.prototype, "handle");
		try {
			// 1. Mid-stream ERR_SOCKET_CLOSED after a 200 response's headers arrived: must never replay the request.
			const midStreamBody = new Readable({
				read() {
					this.destroy(Object.assign(new Error("Socket is closed"), { code: "ERR_SOCKET_CLOSED" }));
				},
			});
			handle.mockResolvedValueOnce({
				response: {
					statusCode: 200,
					reason: "OK",
					headers: { "content-type": "application/vnd.amazon.eventstream" },
					body: midStreamBody,
				},
			} as Awaited<ReturnType<NodeHttpHandler["handle"]>>);
			const midStream = await streamBedrock({ ...model, baseUrl: "https://localhost:9" }, context, {
				cacheRetention: "none",
				maxRetries: SDK_RETRIES,
				env: { AWS_BEDROCK_FORCE_HTTP1: "1", AWS_BEDROCK_SKIP_AUTH: "1", AWS_REGION: "us-east-1" },
			}).result();
			assert.equal(handle.mock.calls.length, 1);
			assert.equal(midStream.stopReason, "error");
			assert.equal(isRetryableAssistantError(midStream), false, midStream.errorMessage);

			// 2. Handler rejections carrying response metadata with ERR_SOCKET_CLOSED must never be wrapped or retried.
			for (const responseTagged of [
				Object.assign(new Error("Response closed"), { code: "ERR_SOCKET_CLOSED", $response: { statusCode: 400 } }),
				Object.assign(new Error("Response closed"), { code: "ERR_SOCKET_CLOSED", statusCode: 400 }),
				Object.assign(new Error("Response closed"), { code: "ERR_SOCKET_CLOSED", headers: {} }),
			]) {
				handle.mockReset();
				handle.mockRejectedValue(responseTagged);
				const message = await streamBedrock({ ...model, baseUrl: "https://localhost:9" }, context, {
					cacheRetention: "none",
					maxRetries: SDK_RETRIES,
					env: { AWS_BEDROCK_FORCE_HTTP1: "1", AWS_BEDROCK_SKIP_AUTH: "1", AWS_REGION: "us-east-1" },
				}).result();
				assert.equal(handle.mock.calls.length, 1);
				assert.equal(message.stopReason, "error");
				assert.equal(isRetryableAssistantError(message), false, message.errorMessage);
			}

			// 3. An already-aborted request whose socket emits ERR_SOCKET_CLOSED must never be retried.
			handle.mockReset();
			const controller = new AbortController();
			handle.mockImplementation(async () => {
				controller.abort();
				throw Object.assign(new Error("Socket is closed"), { code: "ERR_SOCKET_CLOSED" });
			});
			const aborted = await streamBedrock({ ...model, baseUrl: "https://localhost:9" }, context, {
				cacheRetention: "none",
				maxRetries: SDK_RETRIES,
				signal: controller.signal,
				env: { AWS_BEDROCK_FORCE_HTTP1: "1", AWS_BEDROCK_SKIP_AUTH: "1", AWS_REGION: "us-east-1" },
			}).result();
			assert.equal(handle.mock.calls.length, 1);
			assert.equal(aborted.stopReason, "aborted");
			assert.equal(isRetryableAssistantError(aborted), false);

			// 4. Non-ERR_SOCKET_CLOSED transport errors like EPROTO keep their code and are not retried by the SDK.
			handle.mockReset();
			handle.mockRejectedValue(Object.assign(new Error("wrong version number"), { code: "EPROTO" }));
			const proto = await streamBedrock({ ...model, baseUrl: "https://localhost:9" }, context, {
				cacheRetention: "none",
				maxRetries: SDK_RETRIES,
				env: { AWS_BEDROCK_FORCE_HTTP1: "1", AWS_BEDROCK_SKIP_AUTH: "1", AWS_REGION: "us-east-1" },
			}).result();
			assert.equal(handle.mock.calls.length, 1);
			assert.equal(proto.errorMessage, "wrong version number (EPROTO)");
			assert.equal(isRetryableAssistantError(proto), false);
		} finally {
			handle.mockRestore();
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
