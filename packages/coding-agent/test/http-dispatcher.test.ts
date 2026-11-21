import { execFile } from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { stream as streamOpenAICodexResponses } from "@bastani/atomic-ai/api/openai-codex-responses";
import { normalizeContext } from "@bastani/atomic-ai/utils/transcript";
import * as undici from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ConnectProxy, startConnectProxy } from "../../../test/helpers/http-connect-proxy.js";
import { createTestCertificate } from "../../../test/helpers/tls-certificates.js";
import { wrapCodexFastRouteWebSocket } from "../src/core/fast-model-routing-transport.ts";
import { configureHttpDispatcher, createHttpDispatcherOptions } from "../src/core/http-dispatcher.ts";
import { bunExecutable } from "./cli-test-helpers.ts";

describe("createHttpDispatcherOptions", () => {
	it("disables undici's default fixed connect timeout", () => {
		const options = createHttpDispatcherOptions(123_456);
		expect(options.allowH2).toBe(false);
		expect(options.connectTimeout).toBe(0);
		expect(options.bodyTimeout).toBe(123_456);
		expect(options.headersTimeout).toBe(123_456);
		// Pi sync (23842b1e): force CONNECT tunnels for plain-HTTP origins, which
		// Undici stopped doing by default in 8.7 and which left proxied HTTP
		// provider requests hanging after a tool call.
		expect(options.proxyTunnel).toBe(true);
		// Pi sync: attach undici error-suppressing factories so mid-stream
		// client errors do not crash the process.
		expect(typeof options.clientFactory).toBe("function");
		expect(typeof options.factory).toBe("function");
	});
});

function codexModel(baseUrl: string) {
	return {
		id: "test-model",
		name: "Test Model",
		api: "openai-codex-responses" as const,
		provider: "test-provider",
		baseUrl,
		reasoning: false,
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10_000,
		maxTokens: 1_000,
	};
}

function codexToken(): string {
	return `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } })).toString("base64url")}.x`;
}

const DISPATCHER_PROXY_ENV_KEYS = [
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"http_proxy",
	"https_proxy",
	"NO_PROXY",
	"no_proxy",
] as const;

describe("http dispatcher", () => {
	let savedEnv: Record<(typeof DISPATCHER_PROXY_ENV_KEYS)[number], string | undefined>;
	let originalDispatcher: undici.Dispatcher;
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		savedEnv = Object.fromEntries(DISPATCHER_PROXY_ENV_KEYS.map((key) => [key, process.env[key]])) as typeof savedEnv;
		for (const key of DISPATCHER_PROXY_ENV_KEYS) delete process.env[key];
		originalDispatcher = undici.getGlobalDispatcher();
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		for (const key of DISPATCHER_PROXY_ENV_KEYS) {
			const value = savedEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		undici.setGlobalDispatcher(originalDispatcher);
		globalThis.fetch = originalFetch;
	});

	// Regression for upstream pi 23842b1e (#8134): without `proxyTunnel: true`
	// Undici >= 8.7 forwards plain-HTTP origins in absolute form instead of
	// issuing CONNECT, and the reused proxy connection stalls the next request.
	it("tunnels proxied HTTP origins", async () => {
		const origin = http.createServer((_request, response) => {
			response.end("origin");
		});
		await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
		const originAddress = origin.address();
		if (!originAddress || typeof originAddress === "string") {
			throw new Error("Origin did not bind to a TCP port");
		}

		const proxyRequestLines: string[] = [];
		const proxy = net.createServer((client) => {
			client.once("data", (data) => {
				const [requestLine = ""] = data.toString().split("\r\n");
				proxyRequestLines.push(requestLine);
				if (!requestLine.startsWith("CONNECT ")) {
					client.end("HTTP/1.1 501 Not Implemented\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
					return;
				}

				const upstream = net.connect(originAddress.port, "127.0.0.1", () => {
					client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
					client.pipe(upstream).pipe(client);
				});
				upstream.on("error", () => client.destroy());
				client.on("error", () => upstream.destroy());
			});
		});
		await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
		const proxyAddress = proxy.address();
		if (!proxyAddress || typeof proxyAddress === "string") {
			throw new Error("Proxy did not bind to a TCP port");
		}

		process.env.HTTP_PROXY = `http://127.0.0.1:${proxyAddress.port}`;
		configureHttpDispatcher();
		const dispatcher = undici.getGlobalDispatcher();
		try {
			const originUrl = `http://127.0.0.1:${originAddress.port}/v1/chat/completions`;
			await expect(undici.fetch(originUrl).then((response) => response.text())).resolves.toBe("origin");
			await expect(undici.fetch(originUrl).then((response) => response.text())).resolves.toBe("origin");
			expect(proxyRequestLines).not.toHaveLength(0);
			expect(proxyRequestLines).toEqual(
				expect.arrayContaining([
					expect.stringMatching(`^CONNECT 127\\.0\\.0\\.1:${originAddress.port} HTTP/1\\.1$`),
				]),
			);
		} finally {
			await dispatcher.close();
			await Promise.all([
				new Promise<void>((resolve) => proxy.close(() => resolve())),
				new Promise<void>((resolve) => origin.close(() => resolve())),
			]);
		}
	});

	it("sends OpenAI Codex's WebSocket through the configured proxy and reports a certificate it refused without falling back to SSE (#6114)", async () => {
		// The endpoint shows a self-signed certificate; the proxy tunnels to it.
		const certificate = createTestCertificate({ subject: "localhost", altNames: ["localhost", "127.0.0.1"] });
		const endpoint = https.createServer({ cert: certificate.cert, key: certificate.key });
		endpoint.on("tlsClientError", () => {});
		await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
		const endpointAddress = endpoint.address();
		if (!endpointAddress || typeof endpointAddress === "string")
			throw new Error("Endpoint did not bind to a TCP port");
		const proxyRequestLines: string[] = [];
		const proxy = net.createServer((client) => {
			client.on("error", () => {});
			client.once("data", (data) => {
				proxyRequestLines.push(data.toString().split("\r\n")[0] ?? "");
				const upstream = net.connect(endpointAddress.port, "127.0.0.1", () => {
					client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
					client.pipe(upstream).pipe(client);
				});
				upstream.on("error", () => client.destroy());
			});
		});
		await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
		const proxyAddress = proxy.address();
		if (!proxyAddress || typeof proxyAddress === "string") throw new Error("Proxy did not bind to a TCP port");

		process.env.HTTPS_PROXY = `http://127.0.0.1:${proxyAddress.port}`;
		configureHttpDispatcher();
		const dispatcher = undici.getGlobalDispatcher();
		// The WebSocket the runtime installs with the dispatcher, whichever test installed it first.
		const originalWebSocket = globalThis.WebSocket;
		globalThis.WebSocket = wrapCodexFastRouteWebSocket(undici.WebSocket as unknown as typeof globalThis.WebSocket);
		try {
			const token = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } })).toString("base64url")}.x`;
			const fetch = vi.fn(async () => new Response("unavailable", { status: 503 }));
			const message = await streamOpenAICodexResponses(
				{
					id: "test-model",
					name: "Test Model",
					api: "openai-codex-responses",
					provider: "test-provider",
					baseUrl: `https://localhost:${endpointAddress.port}`,
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 10_000,
					maxTokens: 1_000,
				},
				normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] }),
				{ apiKey: token, transport: "auto", fetch, sessionId: "codex-websocket-through-proxy" },
			).result();

			expect(fetch).not.toHaveBeenCalled();
			expect(proxyRequestLines).toEqual([`CONNECT localhost:${endpointAddress.port} HTTP/1.1`]);
			expect(message.errorMessage).toMatch(
				new RegExp(
					`^The TLS certificate for localhost:${endpointAddress.port} was not accepted \\(DEPTH_ZERO_SELF_SIGNED_CERT: `,
				),
			);
		} finally {
			globalThis.WebSocket = originalWebSocket;
			await dispatcher.close();
			await Promise.all([
				new Promise<void>((resolve) => proxy.close(() => resolve())),
				new Promise<void>((resolve) => endpoint.close(() => resolve())),
			]);
		}
	});
	it("names an https proxy whose own certificate was refused, not the endpoint the proxy never reached, over fetch and over OpenAI Codex's WebSocket", async () => {
		// The proxy shows a self-signed certificate; the endpoint behind it is never connected to.
		const certificate = createTestCertificate({ subject: "localhost", altNames: ["localhost", "127.0.0.1"] });
		let proxyConnections = 0;
		const proxy = https.createServer({ cert: certificate.cert, key: certificate.key });
		proxy.on("connection", () => proxyConnections++);
		proxy.on("tlsClientError", () => {});
		let endpointConnections = 0;
		const endpoint = net.createServer((socket) => {
			endpointConnections++;
			socket.destroy();
		});
		for (const server of [proxy, endpoint])
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const portOf = (server: net.Server) => {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Server did not bind to a TCP port");
			return address.port;
		};
		// The proxy URL's credentials are never repeated.
		process.env.HTTPS_PROXY = `https://agent:s3cret@localhost:${portOf(proxy)}`;
		configureHttpDispatcher();
		const dispatcher = undici.getGlobalDispatcher();
		const originalWebSocket = globalThis.WebSocket;
		globalThis.WebSocket = wrapCodexFastRouteWebSocket(undici.WebSocket as unknown as typeof globalThis.WebSocket);
		try {
			const sse = vi.fn(async () => new Response("unavailable", { status: 503 }));
			for (const [transport, fetch] of [
				["auto", sse],
				["sse", undefined],
			] as const) {
				const message = await streamOpenAICodexResponses(
					codexModel(`https://localhost:${portOf(endpoint)}`),
					normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] }),
					{ apiKey: codexToken(), transport, fetch, maxRetries: 2, sessionId: `codex-https-proxy-${transport}` },
				).result();

				expect(message.errorMessage).toMatch(
					new RegExp(
						`^The TLS certificate of the proxy localhost:${portOf(proxy)} was not accepted \\(DEPTH_ZERO_SELF_SIGNED_CERT: .*\\)\\. If the proxy uses a certificate from a private or corporate CA, set NODE_EXTRA_CA_CERTS`,
					),
				);
				expect(message.errorMessage).not.toContain("s3cret");
				expect(proxyConnections, transport).toBe(1);
				proxyConnections = 0;
			}
			expect(sse).not.toHaveBeenCalled();
			expect(endpointConnections).toBe(0);
		} finally {
			globalThis.WebSocket = originalWebSocket;
			await dispatcher.close();
			await Promise.all(
				[proxy, endpoint].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
			);
		}
	});

	it("names the endpoint whose certificate was refused through a trusted https proxy, and the proxy whose certificate names another host", async () => {
		// A proxy whose certificate a CA the client trusts for proxies issued, which opens the tunnel to an endpoint showing a
		// self-signed certificate.
		const ca = createTestCertificate({
			subject: "Proxy CA",
			ca: true,
			keyUsage: ["keyCertSign", "digitalSignature"],
		});
		const issue = (name: string) =>
			createTestCertificate({
				subject: name,
				issuer: ca,
				ca: false,
				extendedKeyUsage: ["serverAuth"],
				altNames: [name],
			});
		const endpointCertificate = createTestCertificate({ subject: "localhost", altNames: ["localhost"] });
		const endpoint = https.createServer({ cert: endpointCertificate.cert, key: endpointCertificate.key });
		endpoint.on("tlsClientError", () => {});
		await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
		const endpointAddress = endpoint.address();
		if (!endpointAddress || typeof endpointAddress === "string")
			throw new Error("Endpoint did not bind to a TCP port");
		const proxyFor = async (certificate: ReturnType<typeof createTestCertificate>) => {
			const tunnels: string[] = [];
			const proxy = https.createServer({ cert: certificate.cert, key: certificate.key });
			proxy.on("tlsClientError", () => {});
			proxy.on("connect", (request: http.IncomingMessage, client: net.Socket) => {
				tunnels.push(request.url ?? "");
				client.on("error", () => {});
				const upstream = net.connect(endpointAddress.port, "127.0.0.1", () => {
					client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
					client.pipe(upstream).pipe(client);
				});
				upstream.on("error", () => client.destroy());
			});
			await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
			const address = proxy.address();
			if (!address || typeof address === "string") throw new Error("Proxy did not bind to a TCP port");
			return { proxy, port: address.port, tunnels };
		};
		const trusted = await proxyFor(issue("localhost"));
		const misnamed = await proxyFor(issue("proxy.test"));
		const request = async (proxyPort: number) => {
			const dispatcher = new undici.EnvHttpProxyAgent({
				...createHttpDispatcherOptions(60_000),
				httpsProxy: `https://localhost:${proxyPort}`,
				noProxy: "none.invalid",
				proxyTls: { ca: ca.cert },
			});
			undici.setGlobalDispatcher(dispatcher);
			try {
				return await streamOpenAICodexResponses(
					codexModel(`https://localhost:${endpointAddress.port}`),
					normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] }),
					{
						apiKey: codexToken(),
						transport: "sse",
						fetch: undici.fetch as unknown as typeof fetch,
						maxRetries: 0,
					},
				).result();
			} finally {
				await dispatcher.close();
			}
		};
		try {
			const throughTrusted = await request(trusted.port);
			expect(trusted.tunnels).toEqual([`localhost:${endpointAddress.port}`]);
			expect(throughTrusted.errorMessage).toMatch(
				new RegExp(
					`^The TLS certificate for localhost:${endpointAddress.port} was not accepted \\(DEPTH_ZERO_SELF_SIGNED_CERT: `,
				),
			);

			const throughMisnamed = await request(misnamed.port);
			expect(misnamed.tunnels).toEqual([]);
			expect(throughMisnamed.errorMessage).toMatch(
				new RegExp(
					`^The TLS certificate of the proxy localhost:${misnamed.port} was not accepted \\(ERR_TLS_CERT_ALTNAME_INVALID: .*\\)\\. Use a proxy URL whose host name the certificate names\\. The request is not retried$`,
				),
			);
		} finally {
			await Promise.all(
				[trusted.proxy, misnamed.proxy, endpoint].map(
					(server) => new Promise<void>((resolve) => server.close(() => resolve())),
				),
			);
		}
	});

	it("connects OpenAI Codex's WebSocket through the dispatcher the installed WebSocket uses by default (#6114)", async () => {
		configureHttpDispatcher();
		const dispatcher = undici.getGlobalDispatcher();
		// Each global dispatcher, wrapped to record the requests sent through it.
		interface Recorded {
			dispatch(options: object, handler: object): boolean;
		}
		const globals = globalThis as { [key: symbol]: Recorded | undefined };
		const used: string[] = [];
		const restore: (() => void)[] = [];
		for (const name of ["undici.globalDispatcher.1", "undici.globalDispatcher.2"]) {
			const key = Symbol.for(name);
			const real = globals[key];
			if (real === undefined) continue;
			globals[key] = Object.assign(Object.create(real) as Recorded, {
				dispatch(options: object, handler: object) {
					used.push(name);
					return real.dispatch(options, handler);
				},
			});
			restore.push(() => {
				globals[key] = real;
			});
		}
		const certificate = createTestCertificate({ subject: "localhost", altNames: ["localhost"] });
		const endpoint = https.createServer({ cert: certificate.cert, key: certificate.key });
		endpoint.on("tlsClientError", () => {});
		await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
		const endpointAddress = endpoint.address();
		if (!endpointAddress || typeof endpointAddress === "string")
			throw new Error("Endpoint did not bind to a TCP port");
		const originalWebSocket = globalThis.WebSocket;
		const WebSocket = wrapCodexFastRouteWebSocket(undici.WebSocket as unknown as typeof globalThis.WebSocket);
		globalThis.WebSocket = WebSocket;
		try {
			await new Promise<void>((resolve) => {
				new WebSocket(`wss://localhost:${endpointAddress.port}/x`).addEventListener("error", () => resolve());
			});
			const byDefault = used.splice(0);
			expect(byDefault).toHaveLength(1);

			const token = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } })).toString("base64url")}.x`;
			await streamOpenAICodexResponses(
				{
					id: "test-model",
					name: "Test Model",
					api: "openai-codex-responses",
					provider: "test-provider",
					baseUrl: `https://localhost:${endpointAddress.port}`,
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 10_000,
					maxTokens: 1_000,
				},
				normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] }),
				{ apiKey: token, transport: "websocket", sessionId: "codex-websocket-default-dispatcher" },
			).result();
			expect(used).toEqual(byDefault);
		} finally {
			globalThis.WebSocket = originalWebSocket;
			for (const undo of restore) undo();
			await dispatcher.close();
			await new Promise<void>((resolve) => endpoint.close(() => resolve()));
		}
	});
});

/**
 * Structural: each case starts Bun, as the standalone binary runs, and waits for Bun's socket idle timer, which fires
 * only on a sweep every few seconds (up to about 8 s after a 1 s deadline).
 */
const BUN_IDLE_TIMER_TEST_MS = 60_000;
/** How long the slow servers stay silent: well past the deadline Bun is given, and past its sweep. */
const SILENT_MS = 12_000;
const PROXY_ENV_KEYS = [
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"all_proxy",
	"no_proxy",
];

/** Runs `script` under Bun with the http dispatcher configured as the binary configures it, and returns what it prints. */
function runUnderBun(script: string, env: Readonly<Record<string, string>>): Promise<string> {
	const moduleUrl = new URL("../src/core/http-dispatcher.ts", import.meta.url).href;
	const childEnv: NodeJS.ProcessEnv = { ...process.env };
	for (const key of [...PROXY_ENV_KEYS, "BUN_CONFIG_HTTP_IDLE_TIMEOUT"]) delete childEnv[key];
	Object.assign(childEnv, env);
	const source = [
		`const { configureHttpDispatcher } = await import(${JSON.stringify(moduleUrl)});`,
		`const outcome = async (request) => { const started = performance.now(); try { const response = await request; return { text: await response.text(), ms: performance.now() - started }; } catch (error) { return { error: error?.name ?? String(error), ms: performance.now() - started }; } };`,
		script,
	].join("\n");
	return new Promise((resolve, reject) => {
		execFile(
			bunExecutable(),
			["--eval", source],
			{ cwd: new URL("..", import.meta.url), env: childEnv, timeout: BUN_IDLE_TIMER_TEST_MS, encoding: "utf8" },
			(error, stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout)),
		);
	});
}

/** Servers that answer after `SILENT_MS`: one before its headers, one between two body chunks. */
async function silentServers(): Promise<{ headers: string; body: string; close(): Promise<void> }> {
	const timers = new Set<NodeJS.Timeout>();
	const later = (run: () => void) => {
		const timer = setTimeout(() => {
			timers.delete(timer);
			run();
		}, SILENT_MS);
		timers.add(timer);
	};
	const headers = http.createServer((_request, response) => later(() => response.end("late headers")));
	const body = http.createServer((_request, response) => {
		response.writeHead(200, { "content-type": "text/plain" });
		response.write("first chunk, ");
		later(() => response.end("late chunk"));
	});
	for (const server of [headers, body]) await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const urlOf = (server: http.Server) => `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/`;
	return {
		headers: urlOf(headers),
		body: urlOf(body),
		async close() {
			for (const timer of timers) clearTimeout(timer);
			await Promise.all(
				[headers, body].map((server) => {
					server.closeAllConnections();
					return new Promise<void>((resolve) => server.close(() => resolve()));
				}),
			);
		},
	};
}

describe("the standalone binary's fetch (Bun)", () => {
	it(
		"ends a response that stays silent longer than httpIdleTimeoutMs, before its headers and between body chunks",
		async () => {
			const servers = await silentServers();
			try {
				const printed = await runUnderBun(
					[
						`configureHttpDispatcher(1_000);`,
						`console.log(JSON.stringify(await Promise.all([outcome(fetch(${JSON.stringify(servers.headers)})), outcome(fetch(${JSON.stringify(servers.body)}))])));`,
					].join("\n"),
					{},
				);
				const [headers, body] = JSON.parse(printed) as { error?: string; text?: string; ms: number }[];
				for (const outcome of [headers, body]) {
					expect(outcome?.error, JSON.stringify(outcome)).toBe("TimeoutError");
					expect(outcome?.ms).toBeLessThan(SILENT_MS);
				}
			} finally {
				await servers.close();
			}
		},
		BUN_IDLE_TIMER_TEST_MS,
	);

	it(
		"waits for a response silent for less than httpIdleTimeoutMs, or for any time when it is disabled, past Bun's own idle timeout",
		async () => {
			const servers = await silentServers();
			try {
				// Bun's own idle timeout, one second here, would end both requests long before the servers answer.
				const run = (timeoutMs: number) =>
					runUnderBun(
						[
							`configureHttpDispatcher(${timeoutMs});`,
							`console.log(JSON.stringify(await Promise.all([outcome(fetch(${JSON.stringify(servers.headers)})), outcome(fetch(${JSON.stringify(servers.body)}))])));`,
						].join("\n"),
						{ BUN_CONFIG_HTTP_IDLE_TIMEOUT: "1" },
					);
				for (const printed of await Promise.all([run(60_000), run(0)])) {
					const outcomes = (JSON.parse(printed) as { error?: string; text?: string }[]).map(
						(outcome) => outcome.text ?? outcome.error,
					);
					expect(outcomes).toEqual(["late headers", "first chunk, late chunk"]);
				}
			} finally {
				await servers.close();
			}
		},
		BUN_IDLE_TIMER_TEST_MS,
	);

	it(
		"sends an https request through HTTP_PROXY when no https proxy is set, as on Node.js, keeping NO_PROXY, ALL_PROXY and HTTPS_PROXY",
		async () => {
			const certificate = createTestCertificate({ subject: "localhost", altNames: ["localhost"] });
			const endpoints: https.Server[] = [];
			for (let i = 0; i < 4; i++) {
				const endpoint = https.createServer(
					{ cert: certificate.cert, key: certificate.key },
					(_request, response) => response.end("endpoint"),
				);
				await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
				endpoints.push(endpoint);
			}
			const ports = endpoints.map((endpoint) => (endpoint.address() as net.AddressInfo).port);
			const routes = (target: string) => ({ host: "127.0.0.1", port: Number(target.split(":")[1]) });
			const proxies: ConnectProxy[] = [await startConnectProxy({ routes }), await startConnectProxy({ routes })];
			const [httpProxy, otherProxy] = proxies as [ConnectProxy, ConnectProxy];
			try {
				// Each case sets the environment for its own endpoint; Bun reads it at each request.
				const cases = [
					{ HTTP_PROXY: httpProxy.url },
					{ HTTP_PROXY: httpProxy.url, NO_PROXY: "localhost" },
					{ HTTP_PROXY: httpProxy.url, ALL_PROXY: otherProxy.url },
					{ HTTP_PROXY: httpProxy.url, HTTPS_PROXY: otherProxy.url },
				];
				const printed = await runUnderBun(
					[
						`configureHttpDispatcher();`,
						`const cases = ${JSON.stringify(cases)};`,
						`const ports = ${JSON.stringify(ports)};`,
						`const keys = ${JSON.stringify(PROXY_ENV_KEYS)};`,
						`const results = [];`,
						`for (let i = 0; i < cases.length; i++) {`,
						`	for (const key of keys) delete process.env[key];`,
						`	Object.assign(process.env, cases[i]);`,
						`	results.push(await outcome(fetch("https://localhost:" + ports[i] + "/", { tls: { ca: ${JSON.stringify(certificate.cert)} } })));`,
						`}`,
						`console.log(JSON.stringify(results.map((result) => result.text ?? result.error)));`,
					].join("\n"),
					{},
				);
				expect(JSON.parse(printed)).toEqual(["endpoint", "endpoint", "endpoint", "endpoint"]);
				const [toHttpProxy, exempt, toAllProxy, toHttpsProxy] = ports.map((port) => `localhost:${port}`);
				expect(httpProxy.requests.map((request) => request.target)).toEqual([toHttpProxy]);
				expect(otherProxy.requests.map((request) => request.target)).toEqual([toAllProxy, toHttpsProxy]);
				expect([...httpProxy.requests, ...otherProxy.requests].map((request) => request.target)).not.toContain(
					exempt,
				);
			} finally {
				await Promise.all([
					...proxies.map((proxy) => proxy.close()),
					...endpoints.map((endpoint) => new Promise<void>((resolve) => endpoint.close(() => resolve()))),
				]);
			}
		},
		BUN_IDLE_TIMER_TEST_MS,
	);

	it(
		"connects OpenAI Codex's WebSocket through HTTP_PROXY when no https proxy is set, as its requests over fetch go",
		async () => {
			let endpointConnections = 0;
			const endpoint = net.createServer((socket) => {
				endpointConnections++;
				socket.destroy();
			});
			await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
			const port = (endpoint.address() as net.AddressInfo).port;
			// The proxy refuses the tunnel, so the request goes on over SSE, which the test answers.
			const proxy = await startConnectProxy({ routes: () => undefined });
			try {
				const model = {
					id: "test-model",
					name: "Test Model",
					api: "openai-codex-responses",
					provider: "test-provider",
					baseUrl: `https://localhost:${port}`,
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 10_000,
					maxTokens: 1_000,
				};
				const token = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } })).toString("base64url")}.x`;
				const printed = await runUnderBun(
					[
						`configureHttpDispatcher();`,
						`const { stream } = await import("@bastani/atomic-ai/api/openai-codex-responses");`,
						`const { normalizeContext } = await import("@bastani/atomic-ai/utils/transcript");`,
						`let sse = 0;`,
						`const message = await stream(${JSON.stringify(model)}, normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] }), { apiKey: ${JSON.stringify(token)}, transport: "auto", sessionId: "codex-bun-http-proxy", fetch: async () => { sse++; return new Response("unavailable", { status: 503 }); } }).result();`,
						`console.log(JSON.stringify({ stopReason: message.stopReason, sse }));`,
					].join("\n"),
					{ HTTP_PROXY: proxy.url },
				);
				expect(JSON.parse(printed)).toMatchObject({ stopReason: "error" });
				expect(proxy.requests.map((request) => request.target)).toEqual([`localhost:${port}`]);
				expect(endpointConnections).toBe(0);
			} finally {
				await proxy.close();
				await new Promise<void>((resolve) => endpoint.close(() => resolve()));
			}
		},
		BUN_IDLE_TIMER_TEST_MS,
	);
});
