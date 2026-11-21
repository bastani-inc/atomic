import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer, type Server } from "node:https";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { connect as connectTls } from "node:tls";
import { afterEach, describe, it, vi } from "vitest";
import { createTestCertificate } from "../../../test/helpers/tls-certificates.ts";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamAzureOpenAIResponses } from "../src/api/azure-openai-responses.ts";
import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { stream as streamGoogleGenerativeAI } from "../src/api/google-generative-ai.ts";
import { stream as streamGoogleVertex } from "../src/api/google-vertex.ts";
import { stream as streamMistral } from "../src/api/mistral-conversations.ts";
import { stream as streamOpenAICodexResponses } from "../src/api/openai-codex-responses.ts";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { stream as streamPiMessages } from "../src/api/pi-messages.ts";
import { getModel } from "../src/compat.ts";
import type { Api, AssistantMessage, Model } from "../src/types.ts";
import { retryProviderRequest } from "../src/utils/provider-retry.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

/**
 * A request the runtime refused for the endpoint's TLS certificate is sent once, by every adapter, and says what to do
 * (#6114). The certificates are real: the endpoint shows a self-signed one, which Node's TLS refuses.
 */

const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] });
const CODEX_TOKEN = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } })).toString("base64url")}.x`;
/** SDK-level retries each adapter is allowed: a refused certificate must not use any of them. */
const SDK_RETRIES = 2;

function createModel<TApi extends Api>(api: TApi, baseUrl: string): Model<TApi> {
	return {
		id: "test-model",
		name: "Test Model",
		api,
		provider: "test-provider",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10_000,
		maxTokens: 1_000,
	};
}

type Turn = (baseUrl: string) => Promise<AssistantMessage>;
const options = { apiKey: "test-key", maxRetries: SDK_RETRIES };

const TURNS: Readonly<Record<string, Turn>> = {
	Anthropic: (baseUrl) => streamAnthropic(createModel("anthropic-messages", baseUrl), context, options).result(),
	"OpenAI Completions": (baseUrl) =>
		streamOpenAICompletions(createModel("openai-completions", `${baseUrl}/v1`), context, options).result(),
	"OpenAI Responses": (baseUrl) =>
		streamOpenAIResponses(createModel("openai-responses", `${baseUrl}/v1`), context, options).result(),
	"OpenAI Codex": (baseUrl) =>
		streamOpenAICodexResponses(createModel("openai-codex-responses", baseUrl), context, {
			...options,
			apiKey: CODEX_TOKEN,
			transport: "sse",
		}).result(),
	"Azure OpenAI Responses": (baseUrl) =>
		streamAzureOpenAIResponses(
			createModel("azure-openai-responses", `${baseUrl}/openai/v1`),
			context,
			options,
		).result(),
	"Google Gemini": (baseUrl) =>
		streamGoogleGenerativeAI(createModel("google-generative-ai", baseUrl), context, options).result(),
	"Google Vertex": (baseUrl) =>
		streamGoogleVertex(createModel("google-vertex", baseUrl), context, {
			...options,
			project: "test-project",
			location: "us-central1",
		}).result(),
	Mistral: (baseUrl) => streamMistral(createModel("mistral-conversations", baseUrl), context, options).result(),
	"Amazon Bedrock": (baseUrl) => {
		const model = getModel(
			"amazon-bedrock",
			"us.anthropic.claude-haiku-4-5-20251001-v1:0",
		) as Model<"bedrock-converse-stream">;
		return streamBedrock({ ...model, baseUrl }, context, {
			cacheRetention: "none",
			maxRetries: SDK_RETRIES,
			env: { AWS_BEDROCK_FORCE_HTTP1: "1", AWS_BEDROCK_SKIP_AUTH: "1", AWS_REGION: "us-east-1" },
		}).result();
	},
};

const servers: (Server | NetServer | import("node:http").Server)[] = [];

afterEach(async () => {
	vi.unstubAllGlobals();
	for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** An HTTPS endpoint showing a self-signed certificate for localhost; counts the connections made to it. */
async function selfSignedEndpoint(): Promise<{ baseUrl: string; connections(): number }> {
	const certificate = createTestCertificate({ subject: "localhost", altNames: ["localhost", "127.0.0.1"] });
	let connections = 0;
	const server = createHttpsServer({ cert: certificate.cert, key: certificate.key }, (_request, response) =>
		response.end(),
	);
	server.on("connection", () => connections++);
	server.on("tlsClientError", () => {});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address !== null && typeof address === "object");
	return { baseUrl: `https://localhost:${address.port}`, connections: () => connections };
}

function tlsDiagnostics(message: AssistantMessage): unknown[] {
	return (message.diagnostics ?? [])
		.filter((diagnostic) => diagnostic.type === "provider_tls_certificate_refused")
		.map((diagnostic) => diagnostic.details);
}

describe("a model request refused for its TLS certificate (#6114)", () => {
	it.each(Object.keys(TURNS))(
		"%s sends it once and names the certificate, its host and NODE_EXTRA_CA_CERTS (#6114)",
		async (adapter) => {
			const endpoint = await selfSignedEndpoint();
			const message = await TURNS[adapter](endpoint.baseUrl);

			assert.equal(message.stopReason, "error");
			assert.equal(endpoint.connections(), 1, `${adapter} asked again: ${message.errorMessage}`);
			const host = new URL(endpoint.baseUrl).host;
			assert.ok(
				message.errorMessage?.startsWith(
					`The TLS certificate for ${host} was not accepted (DEPTH_ZERO_SELF_SIGNED_CERT: self-signed certificate`,
				),
				message.errorMessage,
			);
			assert.ok(message.errorMessage?.includes("NODE_EXTRA_CA_CERTS"), message.errorMessage);
			const recorded = tlsDiagnostics(message) as { code: string; reason: string }[];
			assert.equal(recorded.length, 1, JSON.stringify(message.diagnostics));
			assert.equal(recorded[0]?.code, "DEPTH_ZERO_SELF_SIGNED_CERT");
			assert.match(recorded[0]?.reason ?? "", /^self-signed certificate/);
			assert.equal(isRetryableAssistantError(message), false);
		},
	);

	it("OpenAI Codex over WebSocket does not fall back to SSE for a certificate the WebSocket refused (#6114)", async () => {
		// Bun's WebSocket error event: the runtime's reason after its own prefix, and the code on the event's error.
		const failure =
			"WebSocket connection to 'wss://chatgpt.test/backend-api/codex/responses' failed: TLS handshake failed: self signed certificate";
		class RefusedWebSocket extends EventTarget {
			constructor() {
				super();
				queueMicrotask(() =>
					this.dispatchEvent(
						Object.assign(new Event("error"), {
							message: failure,
							error: Object.assign(new Error(failure), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }),
						}),
					),
				);
			}
			send(): void {}
			close(): void {}
		}
		const fetch = vi.fn();
		vi.stubGlobal("WebSocket", RefusedWebSocket);

		const message = await streamOpenAICodexResponses(
			createModel("openai-codex-responses", "https://chatgpt.test/backend-api"),
			context,
			{ apiKey: CODEX_TOKEN, transport: "auto", fetch },
		).result();

		assert.equal(message.stopReason, "error");
		assert.equal(fetch.mock.calls.length, 0, "the request was sent again over SSE");
		assert.ok(
			message.errorMessage?.startsWith(
				"The TLS certificate for chatgpt.test was not accepted (DEPTH_ZERO_SELF_SIGNED_CERT: self signed certificate)",
			),
			message.errorMessage,
		);
		assert.deepEqual(
			(message.diagnostics ?? []).map((diagnostic) => diagnostic.type),
			["provider_tls_certificate_refused"],
		);
	});

	it("OpenAI Codex still falls back to SSE for a WebSocket handshake failure that names no certificate code (#6114)", async () => {
		// Node's WebSocket reports the failure without the certificate's code; a reason in other words is not the runtime's.
		for (const error of [
			new Error("WebSocket connection to 'wss://chatgpt.test/backend-api/codex/responses' failed"),
			Object.assign(
				new Error(
					"WebSocket connection to 'wss://chatgpt.test/backend-api/codex/responses' failed: TLS handshake failed: upstream says its certificate has expired",
				),
				{ code: "CERT_HAS_EXPIRED" },
			),
		]) {
			class FailedWebSocket extends EventTarget {
				constructor() {
					super();
					queueMicrotask(() =>
						this.dispatchEvent(Object.assign(new Event("error"), { message: error.message, error })),
					);
				}
				send(): void {}
				close(): void {}
			}
			const fetch = vi.fn(async () => new Response("unavailable", { status: 503 }));
			vi.stubGlobal("WebSocket", FailedWebSocket);

			const message = await streamOpenAICodexResponses(
				createModel("openai-codex-responses", "https://chatgpt.test/backend-api"),
				context,
				{ apiKey: CODEX_TOKEN, transport: "auto", fetch, sessionId: `codex-${error.message.length}` },
			).result();

			assert.equal(message.stopReason, "error");
			assert.equal(fetch.mock.calls.length, 1, error.message);
			assert.deepEqual(tlsDiagnostics(message), [], message.errorMessage);
		}
	});

	it("a failed assistant message read back from JSON is still not retried (#6114)", async () => {
		const endpoint = await selfSignedEndpoint();
		const message = await TURNS["OpenAI Completions"](endpoint.baseUrl);
		const restored = JSON.parse(JSON.stringify(message)) as AssistantMessage;

		assert.equal(isRetryableAssistantError(restored), false);
		assert.deepEqual(tlsDiagnostics(restored), tlsDiagnostics(message));
	});
});

describe("failures that are not a refused certificate keep their retries (#6114)", () => {
	it("a connection reset during the TLS handshake is retried, at the SDK and by the session (#6114)", async () => {
		let connections = 0;
		const server = createNetServer((socket: Socket) => {
			connections++;
			socket.on("error", () => {});
			socket.once("data", () => socket.resetAndDestroy());
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		assert.ok(address !== null && typeof address === "object");

		const message = await TURNS["OpenAI Completions"](`https://localhost:${address.port}`);

		assert.equal(message.stopReason, "error");
		assert.equal(connections, 1 + SDK_RETRIES);
		assert.deepEqual(tlsDiagnostics(message), []);
		assert.equal(isRetryableAssistantError(message), true);
	});

	it("a 502 whose body quotes a certificate code is the provider's answer and is retried as before (#6114)", async () => {
		// As the OpenAI SDK reports it: the body's `code` becomes the error's code.
		let requests = 0;
		const failure = await retryProviderRequest(
			async () => {
				requests++;
				throw Object.assign(new Error("502 upstream TLS: CERT_HAS_EXPIRED certificate has expired"), {
					status: 502,
					headers: new Headers({ "retry-after-ms": "0" }),
					code: "CERT_HAS_EXPIRED",
				});
			},
			{ maxRetries: 1 },
		).then(
			() => assert.fail("the request succeeded"),
			(error: Error) => error,
		);
		assert.equal(requests, 2, failure.message);
	});

	it("a response whose body or stream error names a certificate code is the provider's answer, retried as before (#6114)", async () => {
		const relayed = { message: "upstream connect error: certificate has expired", code: "CERT_HAS_EXPIRED" };
		const answering = async (status: number, contentType: string, body: string) => {
			const server = createHttpServer((request, response) => {
				request.resume();
				request.on("end", () => {
					response.writeHead(status, { "content-type": contentType });
					response.end(body);
				});
			});
			servers.push(server);
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const address = server.address();
			assert.ok(address !== null && typeof address === "object");
			return `http://127.0.0.1:${address.port}`;
		};
		// Each with whether main retries its message: a provider error in other words than a transport failure is not.
		const turns: [string, Promise<AssistantMessage>, boolean][] = [
			[
				"pi-messages 502",
				answering(502, "application/json", JSON.stringify({ error: relayed })).then((baseUrl) =>
					streamPiMessages(createModel("pi-messages", baseUrl), context, { apiKey: "test-key" }).result(),
				),
				true,
			],
			[
				"OpenAI Completions stream error event",
				answering(200, "text/event-stream", `data: ${JSON.stringify({ error: relayed })}\n\n`).then((baseUrl) =>
					streamOpenAICompletions(createModel("openai-completions", `${baseUrl}/v1`), context, {
						apiKey: "test-key",
						maxRetries: 0,
					}).result(),
				),
				true,
			],
			[
				"OpenAI Codex response.failed in the runtime's own words",
				answering(
					200,
					"text/event-stream",
					`data: ${JSON.stringify({
						type: "response.failed",
						response: {
							status: "failed",
							error: { code: "CERT_HAS_EXPIRED", message: "certificate has expired" },
						},
					})}\n\n`,
				).then((baseUrl) =>
					streamOpenAICodexResponses(createModel("openai-codex-responses", baseUrl), context, {
						apiKey: CODEX_TOKEN,
						transport: "sse",
					}).result(),
				),
				false,
			],
			[
				"OpenAI Responses response.failed in the runtime's own words",
				answering(
					200,
					"text/event-stream",
					`data: ${JSON.stringify({
						type: "response.failed",
						sequence_number: 0,
						response: {
							status: "failed",
							error: { code: "CERT_HAS_EXPIRED", message: "certificate has expired" },
						},
					})}\n\n`,
				).then((baseUrl) =>
					streamOpenAIResponses(createModel("openai-responses", `${baseUrl}/v1`), context, {
						apiKey: "test-key",
						maxRetries: 0,
					}).result(),
				),
				false,
			],
			[
				"OpenAI Responses stream error event",
				answering(
					200,
					"text/event-stream",
					`data: ${JSON.stringify({ type: "error", sequence_number: 0, ...relayed })}\n\n`,
				).then((baseUrl) =>
					streamOpenAIResponses(createModel("openai-responses", `${baseUrl}/v1`), context, {
						apiKey: "test-key",
						maxRetries: 0,
					}).result(),
				),
				true,
			],
		];
		for (const [label, turn, retried] of turns) {
			const message = await turn;
			assert.equal(message.stopReason, "error", label);
			assert.deepEqual(tlsDiagnostics(message), [], `${label}: ${message.errorMessage}`);
			assert.equal(
				message.errorMessage?.includes("NODE_EXTRA_CA_CERTS"),
				false,
				`${label}: ${message.errorMessage}`,
			);
			assert.equal(
				message.errorMessage?.startsWith("The TLS certificate"),
				false,
				`${label}: ${message.errorMessage}`,
			);
			assert.equal(isRetryableAssistantError(message), retried, `${label}: ${message.errorMessage}`);
		}
	});

	it("a certificate code on an error that also carries a response's status, at any depth, is not a refusal (#6114)", async () => {
		// The runtime's own wording, but over an answer with a status.
		const answered = Object.assign(
			new Error("certificate has expired", { cause: Object.assign(new Error("502"), { status: 502 }) }),
			{ code: "CERT_HAS_EXPIRED" },
		);
		let requests = 0;
		await retryProviderRequest(
			async () => {
				requests++;
				throw Object.assign(new Error("Connection error.", { cause: answered }), {
					status: undefined,
					headers: undefined,
				});
			},
			{ maxRetries: 1 },
		).catch(() => {});
		assert.equal(requests, 2);
	});

	it("a recorded refusal whose code is not a certificate's, as a hand-written transcript could hold, is retried (#6114)", () => {
		const message = (code: string, reason = ""): AssistantMessage =>
			({
				role: "assistant",
				content: [],
				api: "openai-completions",
				provider: "test-provider",
				model: "test-model",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "error",
				errorMessage: "Connection error.: read ECONNRESET (ECONNRESET)",
				timestamp: 1,
				diagnostics: [{ type: "provider_tls_certificate_refused", timestamp: 1, details: { code, reason } }],
			}) as AssistantMessage;

		assert.equal(isRetryableAssistantError(message("ECONNRESET")), true);
		assert.equal(isRetryableAssistantError(message("UNSPECIFIED", "issuer certificate lookup error")), true);
		assert.equal(isRetryableAssistantError(message("CERT_HAS_EXPIRED", "certificate has expired")), false);
	});

	it("OpenSSL's own failures reported as UNSPECIFIED, an UNSPECIFIED that is not TLS's, and OUT_OF_MEM stay retried; a certificate refused as UNSPECIFIED does not (#6114)", async () => {
		// A root that may not sign certificates: Node reports UNSPECIFIED with OpenSSL's reason for it.
		const root = createTestCertificate({
			subject: "Root without keyCertSign",
			ca: true,
			keyUsage: ["digitalSignature"],
		});
		const leaf = createTestCertificate({
			subject: "localhost",
			issuer: root,
			ca: false,
			extendedKeyUsage: ["serverAuth"],
			altNames: ["localhost"],
		});
		const server = createHttpsServer({ cert: leaf.cert, key: leaf.key });
		server.on("tlsClientError", () => {});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		assert.ok(address !== null && typeof address === "object");
		const refused = await new Promise<Error>((resolve) => {
			const socket = connectTls({ host: "127.0.0.1", port: address.port, servername: "localhost", ca: root.cert });
			socket.on("secureConnect", () => {
				socket.destroy();
				resolve(new Error("the handshake succeeded"));
			});
			socket.on("error", resolve);
		});

		const attempts = async (cause: Error): Promise<number> => {
			let count = 0;
			await retryProviderRequest(
				async () => {
					count++;
					// As the OpenAI and Anthropic SDKs report a connection failure: no status or headers, the reason in the
					// causes.
					throw Object.assign(
						new Error("Connection error.", { cause: new TypeError("fetch failed", { cause }) }),
						{
							status: undefined,
							headers: undefined,
						},
					);
				},
				{ maxRetries: 1 },
			).catch(() => {});
			return count;
		};
		assert.equal((refused as Error & { code?: string }).code, "UNSPECIFIED", refused.message);
		assert.equal(await attempts(refused), 1, refused.message);
		for (const message of [
			"unspecified certificate verification error",
			"issuer certificate lookup error",
			"invalid certificate verification context",
			// Another library's code that happens to read UNSPECIFIED, as a custom fetch's could.
			"credential helper is temporarily offline",
		])
			assert.equal(await attempts(Object.assign(new Error(message), { code: "UNSPECIFIED" })), 2, message);
		assert.equal(await attempts(Object.assign(new Error("out of memory"), { code: "OUT_OF_MEM" })), 2);
	});
});
