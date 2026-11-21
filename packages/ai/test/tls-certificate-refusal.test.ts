import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer, type Server } from "node:https";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import tls, { type ConnectionOptions, connect as connectTls, type TLSSocket } from "node:tls";
import { afterEach, describe, it, vi } from "vitest";
import { createTestCertificate } from "../../../test/helpers/tls-certificates.ts";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamAzureOpenAIResponses } from "../src/api/azure-openai-responses.ts";
import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { stream as streamGoogleGenerativeAI } from "../src/api/google-generative-ai.ts";
import { stream as streamGoogleVertex } from "../src/api/google-vertex.ts";
import { stream as streamMistral } from "../src/api/mistral-conversations.ts";
import {
	getOpenAICodexWebSocketDebugStats,
	stream as streamOpenAICodexResponses,
} from "../src/api/openai-codex-responses.ts";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { stream as streamPiMessages } from "../src/api/pi-messages.ts";
import { getModel } from "../src/compat.ts";
import type { Api, AssistantMessage, Model } from "../src/types.ts";
import { retryProviderRequest } from "../src/utils/provider-retry.ts";
import { transportFailure } from "../src/utils/tls-certificate.ts";
import { observeWebSocketTransport } from "../src/utils/websocket-transport.ts";
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

/** A caller's hook on the request, as the SDK and extensions pass one. */
interface Hooks {
	readonly onPayload?: () => Promise<undefined>;
}
type Turn = (baseUrl: string, hooks?: Hooks) => Promise<AssistantMessage>;
const options = { apiKey: "test-key", maxRetries: SDK_RETRIES };

const TURNS: Readonly<Record<string, Turn>> = {
	Anthropic: (baseUrl, hooks) =>
		streamAnthropic(createModel("anthropic-messages", baseUrl), context, { ...options, ...hooks }).result(),
	"OpenAI Completions": (baseUrl, hooks) =>
		streamOpenAICompletions(createModel("openai-completions", `${baseUrl}/v1`), context, {
			...options,
			...hooks,
		}).result(),
	"OpenAI Responses": (baseUrl, hooks) =>
		streamOpenAIResponses(createModel("openai-responses", `${baseUrl}/v1`), context, {
			...options,
			...hooks,
		}).result(),
	"OpenAI Codex": (baseUrl, hooks) =>
		streamOpenAICodexResponses(createModel("openai-codex-responses", baseUrl), context, {
			...options,
			...hooks,
			apiKey: CODEX_TOKEN,
			transport: "sse",
		}).result(),
	"Azure OpenAI Responses": (baseUrl, hooks) =>
		streamAzureOpenAIResponses(createModel("azure-openai-responses", `${baseUrl}/openai/v1`), context, {
			...options,
			...hooks,
		}).result(),
	"Google Gemini": (baseUrl, hooks) =>
		streamGoogleGenerativeAI(createModel("google-generative-ai", baseUrl), context, {
			...options,
			...hooks,
		}).result(),
	"Google Vertex": (baseUrl, hooks) =>
		streamGoogleVertex(createModel("google-vertex", baseUrl), context, {
			...options,
			...hooks,
			project: "test-project",
			location: "us-central1",
		}).result(),
	Mistral: (baseUrl, hooks) =>
		streamMistral(createModel("mistral-conversations", baseUrl), context, { ...options, ...hooks }).result(),
	"pi-messages": (baseUrl, hooks) =>
		streamPiMessages(createModel("pi-messages", baseUrl), context, { ...options, ...hooks }).result(),
	"Amazon Bedrock": (baseUrl, hooks) => {
		const model = getModel(
			"amazon-bedrock",
			"us.anthropic.claude-haiku-4-5-20251001-v1:0",
		) as Model<"bedrock-converse-stream">;
		return streamBedrock({ ...model, baseUrl }, context, {
			...hooks,
			cacheRetention: "none",
			maxRetries: SDK_RETRIES,
			env: { AWS_BEDROCK_FORCE_HTTP1: "1", AWS_BEDROCK_SKIP_AUTH: "1", AWS_REGION: "us-east-1" },
		}).result();
	},
};

const servers: (Server | NetServer | import("node:http").Server | tls.Server)[] = [];

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
			// A hook that succeeds leaves the request's own connection to decide.
			const message = await TURNS[adapter](endpoint.baseUrl, { onPayload: async () => undefined });

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
		// Bun's WebSocket error event: the runtime's reason after its own prefix, and the code on the event's error. The
		// endpoint's path holds an apostrophe, as a URL may.
		const failure =
			"WebSocket connection to 'wss://chatgpt.test/o'hara/backend-api/codex/responses' failed: TLS handshake failed: self signed certificate";
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
			createModel("openai-codex-responses", "https://chatgpt.test/o'hara/backend-api"),
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

	it("OpenAI Codex over the runtime's own WebSocket reports a certificate its connection refused without falling back to SSE (#6114)", async () => {
		// Node.js's WebSocket reports the refusal as an empty error; the connection's own failure names the certificate.
		const endpoint = await selfSignedEndpoint();
		const fetch = vi.fn(async () => new Response("unavailable", { status: 503 }));

		const message = await streamOpenAICodexResponses(
			createModel("openai-codex-responses", endpoint.baseUrl),
			context,
			{ apiKey: CODEX_TOKEN, transport: "auto", fetch, sessionId: "codex-native-websocket-refused" },
		).result();

		assert.equal(message.stopReason, "error");
		assert.equal(fetch.mock.calls.length, 0, `the request was sent again over SSE: ${message.errorMessage}`);
		assert.equal(endpoint.connections(), 1);
		assert.ok(
			message.errorMessage?.startsWith(
				`The TLS certificate for ${new URL(endpoint.baseUrl).host} was not accepted (DEPTH_ZERO_SELF_SIGNED_CERT: self-signed certificate`,
			),
			message.errorMessage,
		);
		assert.deepEqual(
			(message.diagnostics ?? []).map((diagnostic) => diagnostic.type),
			["provider_tls_certificate_refused"],
		);
	});

	it("OpenAI Codex's WebSocket connects through the dispatcher the runtime's WebSocket uses by default (#6114)", async () => {
		// Each global dispatcher undici keeps, wrapped to record the requests sent through it. Which one the WebSocket uses
		// when it is given none (a proxy agent, say) is up to the runtime's undici; Codex's connection must use the same.
		const NativeWebSocket = globalThis.WebSocket;
		interface Dispatcher {
			dispatch(options: object, handler: object): boolean;
		}
		const globals = globalThis as { [key: symbol]: Dispatcher | undefined };
		const used: string[] = [];
		const restore: (() => void)[] = [];
		for (const name of ["undici.globalDispatcher.1", "undici.globalDispatcher.2"]) {
			const key = Symbol.for(name);
			const real = globals[key];
			if (real === undefined) continue;
			globals[key] = Object.assign(Object.create(real) as Dispatcher, {
				dispatch(options: object, handler: object) {
					used.push(name);
					return real.dispatch(options, handler);
				},
			});
			restore.push(() => {
				globals[key] = real;
			});
		}
		try {
			const endpoint = await selfSignedEndpoint();
			const wss = endpoint.baseUrl.replace("https:", "wss:");
			await new Promise<void>((resolve) => {
				// Node.js 22's WebSocket reports a failed handshake with an error event and no close event.
				new NativeWebSocket(wss).addEventListener("error", () => resolve());
			});
			const byDefault = used.splice(0);
			assert.equal(byDefault.length, 1, byDefault.join());

			const fetch = vi.fn(async () => new Response("unavailable", { status: 503 }));
			await streamOpenAICodexResponses(createModel("openai-codex-responses", endpoint.baseUrl), context, {
				apiKey: CODEX_TOKEN,
				transport: "websocket",
				fetch,
				sessionId: "codex-native-websocket-dispatcher",
			}).result();
			assert.deepEqual(used, byDefault);
		} finally {
			for (const undo of restore) undo();
		}
	});

	it("OpenAI Codex over the runtime's own WebSocket still falls back to SSE for a reset, a refused connection or an upgrade the server refused, reporting the WebSocket's error as before (#6114)", async () => {
		// A TLS endpoint that resets each connection during the handshake, a port nothing listens on, and a plain endpoint
		// that answers the upgrade with 502.
		const reset = createNetServer((socket: Socket) => {
			socket.on("error", () => {});
			socket.once("data", () => socket.resetAndDestroy());
		});
		const refusing = createHttpServer((_request, response) => response.writeHead(502).end());
		refusing.on("upgrade", (_request, socket: Socket) => socket.end("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n"));
		servers.push(reset, refusing);
		for (const server of [reset, refusing]) await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const portOf = (server: NetServer | import("node:http").Server) => {
			const address = server.address();
			assert.ok(address !== null && typeof address === "object");
			return address.port;
		};

		const closed = createNetServer();
		await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
		const closedPort = portOf(closed);
		await new Promise<void>((resolve) => closed.close(() => resolve()));

		for (const baseUrl of [
			`https://localhost:${portOf(reset)}`,
			`https://127.0.0.1:${closedPort}`,
			`http://127.0.0.1:${portOf(refusing)}`,
		]) {
			const fetch = vi.fn(async () => new Response("unavailable", { status: 503 }));
			const sessionId = `codex-native-websocket-${baseUrl}`;
			const message = await streamOpenAICodexResponses(createModel("openai-codex-responses", baseUrl), context, {
				apiKey: CODEX_TOKEN,
				transport: "auto",
				fetch,
				sessionId,
			}).result();

			// The WebSocket's own error, as Node.js 22 and Node.js 24 and later word it, not the connection's failure.
			assert.match(
				getOpenAICodexWebSocketDebugStats(sessionId)?.lastWebSocketError ?? "",
				/^(?:WebSocket error|Received network error or non-101 status code\.)$/,
				baseUrl,
			);

			assert.equal(message.stopReason, "error");
			assert.equal(fetch.mock.calls.length, 1, `${baseUrl}: ${message.errorMessage}`);
			assert.deepEqual(tlsDiagnostics(message), [], message.errorMessage);
			assert.ok(
				(message.diagnostics ?? []).some((diagnostic) => diagnostic.type === "provider_transport_failure"),
				JSON.stringify(message.diagnostics),
			);
		}
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

	it.each(Object.keys(TURNS))(
		"%s does not blame its endpoint for a certificate a hook's own request was refused (#6114)",
		async (adapter) => {
			// The hook asks another host, whose certificate is self-signed; the model's endpoint is never reached.
			const elsewhere = await selfSignedEndpoint();
			let connections = 0;
			const endpoint = createHttpServer((request, response) => {
				connections++;
				request.resume();
				response.end();
			});
			servers.push(endpoint);
			await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
			const address = endpoint.address();
			assert.ok(address !== null && typeof address === "object");

			const message = await TURNS[adapter](`http://127.0.0.1:${address.port}`, {
				onPayload: async () => {
					await fetch(elsewhere.baseUrl);
					return undefined;
				},
			});

			assert.equal(message.stopReason, "error");
			assert.equal(connections, 0);
			assert.deepEqual(tlsDiagnostics(message), [], message.errorMessage);
			assert.equal(message.errorMessage?.includes("NODE_EXTRA_CA_CERTS"), false, message.errorMessage);
		},
	);

	it("a fetch that rejects every request with one shared error names each request's own host, and a hook that throws that error is not a refusal (#6114)", async () => {
		// As a fetch with a circuit breaker does: the first failure, kept and thrown again for every request.
		const shared = new TypeError("fetch failed", {
			cause: Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" }),
		});
		const failing: typeof fetch = Object.assign(async () => {
			throw shared;
		}, globalThis.fetch);
		const turn = (baseUrl: string, hooks?: Hooks) =>
			streamPiMessages(createModel("pi-messages", baseUrl), context, { apiKey: "test-key", fetch: failing, ...hooks }).result();

		const [first, second] = await Promise.all([turn("https://first.test"), turn("https://second.test")]);
		assert.ok(first.errorMessage?.startsWith("The TLS certificate for first.test was not accepted"), first.errorMessage);
		assert.ok(second.errorMessage?.startsWith("The TLS certificate for second.test was not accepted"), second.errorMessage);

		const hooked = await turn("https://third.test", {
			onPayload: async () => {
				throw shared;
			},
		});
		assert.equal(hooked.stopReason, "error");
		assert.deepEqual(tlsDiagnostics(hooked), [], hooked.errorMessage);
	});

	it("a refused certificate on a default endpoint names the host the request was sent to (#6114)", async () => {
		// The model has no base URL of its own: the SDK resolves the endpoint from the project, resource or region. Each
		// request is sent on to a local endpoint whose certificate is self-signed.
		const endpoint = await selfSignedEndpoint();
		const requested: string[] = [];
		const redirect: typeof fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
			requested.push(url.host);
			return globalThis.fetch(`${endpoint.baseUrl}${url.pathname}${url.search}`, init);
		}, globalThis.fetch);
		// Bedrock's SDK speaks HTTP/2 unless told otherwise: an endpoint that offers it, with the same certificate.
		const certificate = createTestCertificate({ subject: "localhost", altNames: ["localhost"] });
		const bedrockEndpoint = tls.createServer({ cert: certificate.cert, key: certificate.key, ALPNProtocols: ["h2", "http/1.1"] });
		bedrockEndpoint.on("tlsClientError", () => {});
		servers.push(bedrockEndpoint);
		await new Promise<void>((resolve) => bedrockEndpoint.listen(0, "127.0.0.1", resolve));
		const bedrockAddress = bedrockEndpoint.address();
		assert.ok(bedrockAddress !== null && typeof bedrockAddress === "object");
		const bedrockPort = bedrockAddress.port;
		const connect = tls.connect;
		// Amazon Bedrock's SDK has its own HTTP handler: its TLS connections to AWS are sent on instead.
		// Called as `connect(options)` (HTTP/1.1) or `connect(port, host, options)` (HTTP/2).
		vi.spyOn(tls, "connect").mockImplementation(((...args: (ConnectionOptions | string | number)[]) => {
			const options = (args.find((arg) => typeof arg === "object") ?? {}) as ConnectionOptions;
			const host = typeof args[1] === "string" ? args[1] : options.host;
			const name = options.servername || host || "";
			if (name.endsWith(".amazonaws.com")) {
				requested.push(name);
				return connect({ ...options, host: "127.0.0.1", port: bedrockPort, servername: name });
			}
			// Nothing leaves this machine.
			if (name !== "localhost" && name !== "127.0.0.1") throw new Error(`unexpected connection to ${name}`);
			return (connect as (...forwarded: unknown[]) => TLSSocket)(...args);
		}) as typeof tls.connect);
		try {
			const bedrock = getModel(
				"amazon-bedrock",
				"us.anthropic.claude-haiku-4-5-20251001-v1:0",
			) as Model<"bedrock-converse-stream">;
			const bedrockTurn = (http1: string) =>
				streamBedrock(bedrock, context, {
					cacheRetention: "none",
					maxRetries: 0,
					env: { AWS_BEDROCK_FORCE_HTTP1: http1, AWS_BEDROCK_SKIP_AUTH: "1", AWS_REGION: "eu-west-1" },
				}).result();
			const turns: [string, () => Promise<AssistantMessage>][] = [
				[
					"aiplatform.googleapis.com",
					() =>
						streamGoogleVertex(getModel("google-vertex", "gemini-2.5-flash") as Model<"google-vertex">, context, {
							apiKey: "test-key",
							fetch: redirect,
							maxRetries: 0,
						}).result(),
				],
				[
					"my-resource.openai.azure.com",
					() =>
						streamAzureOpenAIResponses(
							getModel("azure-openai-responses", "gpt-4.1") as Model<"azure-openai-responses">,
							context,
							{ apiKey: "test-key", azureResourceName: "my-resource", fetch: redirect, maxRetries: 0 },
						).result(),
				],
				["bedrock-runtime.eu-west-1.amazonaws.com", () => bedrockTurn("1")],
				["bedrock-runtime.eu-west-1.amazonaws.com", () => bedrockTurn("0")],
			];
			for (const [host, turn] of turns) {
				const message = await turn();
				assert.deepEqual(requested.splice(0), [host], `${host}: ${message.errorMessage}`);
				assert.ok(
					message.errorMessage?.startsWith(
						`The TLS certificate for ${host} was not accepted (DEPTH_ZERO_SELF_SIGNED_CERT: self-signed certificate`,
					),
					message.errorMessage,
				);
			}
		} finally {
			vi.restoreAllMocks();
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
	it("a WebSocket's connection failure counts only from its last dispatch, before any response (#6114)", () => {
		// Global dispatchers that fail or answer each request as told: an intermediary may dispatch a connection more
		// than once, and only the last attempt's outcome is the connection's.
		type Handler = { [callback: string]: ((...args: unknown[]) => unknown) | undefined };
		const outcomes: ((handler: Handler) => void)[] = [];
		const answering = { dispatch: (_options: object, handler: Handler) => (outcomes.shift()?.(handler), true) };
		const keys = [Symbol.for("undici.globalDispatcher.1"), Symbol.for("undici.globalDispatcher.2")];
		const globals = globalThis as { [key: symbol]: object | undefined };
		// undici defines them writable but not configurable; one not defined yet is defined for the test only.
		const saved = keys.map((key) => [key, key in globalThis, globals[key]] as const);
		for (const key of keys)
			if (key in globalThis) globals[key] = answering;
			else Object.defineProperty(globalThis, key, { value: answering, writable: true, configurable: true });
		try {
			const refused = Object.assign(new Error("self-signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
			const run = (...steps: ((handler: Handler) => void)[]) => {
				const transport = observeWebSocketTransport();
				assert.ok(transport !== undefined);
				const dispatcher = transport.dispatcher as typeof answering;
				for (const step of steps) {
					outcomes.push(step);
					// As undici 8's fetch dispatches, and as undici 6 and 7 do.
					dispatcher.dispatch({}, { onRequestStart() {}, onResponseStart() {}, onResponseError() {} });
				}
				return transport.failure();
			};
			const fail = (handler: Handler) => handler.onResponseError?.({}, refused);
			const answer = (handler: Handler) => handler.onResponseStart?.({}, 403, {}, "Forbidden");
			const answerThenFail = (handler: Handler) => {
				answer(handler);
				handler.onResponseError?.({}, refused);
			};
			assert.equal(run(fail), refused);
			assert.equal(run(fail, answer), undefined);
			const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
			assert.equal(
				run(fail, (handler) => handler.onResponseError?.({}, reset)),
				reset,
			);
			assert.equal(run(answerThenFail), undefined);
			assert.equal(run(answer, fail), refused);
			// A dispatch that has not reported yet has not failed.
			assert.equal(
				run(fail, () => {}),
				undefined,
			);
			// The earlier callbacks undici 6 and 7 dispatch with.
			const legacy = observeWebSocketTransport();
			outcomes.push((handler) => handler.onError?.(refused));
			(legacy?.dispatcher as typeof answering).dispatch({}, { onConnect() {}, onHeaders() {}, onError() {} });
			assert.equal(legacy?.failure(), refused);
		} finally {
			for (const [key, defined, value] of saved) {
				if (defined) globals[key] = value;
				else delete globals[key];
			}
		}
	});
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
		// The runtime's own wording on the request's own rejection, but over an answer with a status.
		const answered = transportFailure(
			Object.assign(
				new Error("certificate has expired", { cause: Object.assign(new Error("502"), { status: 502 }) }),
				{ code: "CERT_HAS_EXPIRED" },
			),
			"https://llm.test/v1",
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
					// As the OpenAI and Anthropic SDKs report their fetch's rejection: no status or headers, the reason in the
					// causes.
					const rejection = transportFailure(new TypeError("fetch failed", { cause }), "https://llm.test/v1");
					throw Object.assign(new Error("Connection error.", { cause: rejection }), {
						status: undefined,
						headers: undefined,
					});
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
