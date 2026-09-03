import { spawnSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import * as undici from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureHttpDispatcher, createHttpDispatcherOptions } from "../src/core/http-dispatcher.ts";
import { bunExecutable } from "./cli-test-helpers.ts";

/** Structural: starts Bun to exercise its ESM view of undici, which differs from Node's. */
const BUN_HTTP_SETUP_TIMEOUT_MS = 10_000;

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

	it(
		"installs the configured undici fetch under Bun",
		() => {
			const moduleUrl = new URL("../src/core/http-dispatcher.ts", import.meta.url).href;
			const script = [
				`const originalFetch = globalThis.fetch;`,
				`const { configureHttpDispatcher } = await import(${JSON.stringify(moduleUrl)});`,
				`configureHttpDispatcher();`,
				`console.log(JSON.stringify({ replaced: globalThis.fetch !== originalFetch }));`,
			].join("\n");
			const child = spawnSync(bunExecutable(), ["--eval", script], {
				encoding: "utf8",
				timeout: BUN_HTTP_SETUP_TIMEOUT_MS,
			});

			expect(child.error).toBeUndefined();
			expect(child.status).toBe(0);
			expect(child.stderr).toBe("");
			expect(JSON.parse(child.stdout)).toEqual({ replaced: true });
		},
		BUN_HTTP_SETUP_TIMEOUT_MS,
	);
});

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
});
