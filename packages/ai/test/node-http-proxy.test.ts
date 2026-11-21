import { afterEach, describe, expect, it } from "vitest";
import {
	resolveHttpProxyUrlForTarget,
	resolveHttpsFallbackProxyUrl,
	UNSUPPORTED_PROXY_PROTOCOL_MESSAGE,
} from "../src/utils/node-http-proxy.ts";

const PROXY_ENV_KEYS = [
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"ALL_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
	"all_proxy",
	"npm_config_http_proxy",
	"npm_config_https_proxy",
	"npm_config_proxy",
	"npm_config_no_proxy",
] as const;

const originalEnv = new Map<string, string | undefined>();
for (const key of PROXY_ENV_KEYS) {
	originalEnv.set(key, process.env[key]);
}

function resetProxyEnv(): void {
	for (const key of PROXY_ENV_KEYS) {
		delete process.env[key];
	}
}

afterEach(() => {
	resetProxyEnv();
	for (const [key, value] of originalEnv) {
		if (value !== undefined) {
			process.env[key] = value;
		}
	}
});

describe("node HTTP proxy resolution", () => {
	it("respects NO_PROXY exclusions", () => {
		resetProxyEnv();
		process.env.HTTPS_PROXY = "http://proxy.example:8080";
		process.env.NO_PROXY = "bedrock-runtime.us-east-1.amazonaws.com";

		expect(resolveHttpProxyUrlForTarget("https://bedrock-runtime.us-east-1.amazonaws.com")).toBeUndefined();
	});

	it("resolves HTTP and HTTPS proxy URLs", () => {
		resetProxyEnv();
		process.env.HTTPS_PROXY = "http://proxy.example:8080";

		expect(resolveHttpProxyUrlForTarget("https://bedrock-runtime.us-east-1.amazonaws.com")?.toString()).toBe(
			"http://proxy.example:8080/",
		);
	});

	it("prefers scoped proxy env aliases before process env aliases", () => {
		resetProxyEnv();
		process.env.https_proxy = "http://process-proxy.example:8080";

		expect(
			resolveHttpProxyUrlForTarget("https://bedrock-runtime.us-east-1.amazonaws.com", {
				HTTPS_PROXY: "http://scoped-proxy.example:8080",
			})?.toString(),
		).toBe("http://scoped-proxy.example:8080/");
	});

	it("rejects SOCKS and PAC proxy URLs explicitly", () => {
		resetProxyEnv();
		process.env.HTTPS_PROXY = "socks5://proxy.example:1080";

		expect(() => resolveHttpProxyUrlForTarget("https://bedrock-runtime.us-east-1.amazonaws.com")).toThrow(
			UNSUPPORTED_PROXY_PROTOCOL_MESSAGE,
		);
	});

	it("handles subdomain wildcards, IPv6, and ports in NO_PROXY", () => {
		resetProxyEnv();
		process.env.HTTPS_PROXY = "http://proxy.example:8080";
		process.env.NO_PROXY = "example.com, .wildcard.org, *.star.net, ::1, [2001:db8::1], 127.0.0.1:8080";

		expect(resolveHttpProxyUrlForTarget("https://example.com")).toBeUndefined();
		expect(resolveHttpProxyUrlForTarget("https://api.example.com")).toBeUndefined();
		expect(resolveHttpProxyUrlForTarget("https://wildcard.org")).toBeUndefined();
		expect(resolveHttpProxyUrlForTarget("https://api.wildcard.org")).toBeUndefined();
		expect(resolveHttpProxyUrlForTarget("https://star.net")).toBeUndefined();
		expect(resolveHttpProxyUrlForTarget("https://api.star.net")).toBeUndefined();
		expect(resolveHttpProxyUrlForTarget("https://notexample.com")?.toString()).toBe("http://proxy.example:8080/");

		expect(resolveHttpProxyUrlForTarget("https://[::1]:80")).toBeUndefined();
		expect(resolveHttpProxyUrlForTarget("https://[2001:db8::1]")).toBeUndefined();
		expect(resolveHttpProxyUrlForTarget("https://127.0.0.1:8080")).toBeUndefined();
		expect(resolveHttpProxyUrlForTarget("https://127.0.0.1:3000")?.toString()).toBe("http://proxy.example:8080/");
	});

	// Regression: upstream pi a63fb12c (#8737) rewrote NO_PROXY matching and lost the bare `*`
	// entry. The whole-string fast path only fires when the entire value is exactly "*", so a
	// wildcard in a list, or with surrounding whitespace, fell through to the strip-and-compare
	// path and proxied everything. Atomic restores the pre-#8737 behavior, which matches Go's
	// x/net/http/httpproxy (an explicit per-entry `p == "*"` check) and curl.
	it("honors a bare wildcard entry inside a NO_PROXY list", () => {
		resetProxyEnv();
		process.env.HTTPS_PROXY = "http://proxy.example:8080";
		process.env.NO_PROXY = "*,localhost";

		expect(resolveHttpProxyUrlForTarget("https://api.example.com")).toBeUndefined();
	});

	it("honors a whitespace-padded bare wildcard entry in NO_PROXY", () => {
		resetProxyEnv();
		process.env.HTTPS_PROXY = "http://proxy.example:8080";
		process.env.NO_PROXY = "* ";

		expect(resolveHttpProxyUrlForTarget("https://api.example.com")).toBeUndefined();
	});

	it("scopes a bare wildcard NO_PROXY entry to its port", () => {
		resetProxyEnv();
		process.env.HTTP_PROXY = "http://proxy.example:8080";
		process.env.HTTPS_PROXY = "http://proxy.example:8080";
		process.env.NO_PROXY = "*:443";

		expect(resolveHttpProxyUrlForTarget("https://api.example.com")).toBeUndefined();
		expect(resolveHttpProxyUrlForTarget("http://api.example.com")?.toString()).toBe("http://proxy.example:8080/");
	});

	// A bare `*` must stay strict: these entries strip to an empty domain but are not wildcards,
	// and must keep proxying rather than becoming bypass-everything.
	it("does not treat a bare dot or empty-domain wildcard as match-all", () => {
		resetProxyEnv();
		process.env.HTTPS_PROXY = "http://proxy.example:8080";
		process.env.NO_PROXY = ".";
		expect(resolveHttpProxyUrlForTarget("https://api.example.com")?.toString()).toBe("http://proxy.example:8080/");

		process.env.NO_PROXY = "*.";
		expect(resolveHttpProxyUrlForTarget("https://api.example.com")?.toString()).toBe("http://proxy.example:8080/");
	});
});

describe("the http proxy an https request falls back to", () => {
	const target = "https://api.example.com/v1";
	const fallback = (env: Record<string, string>, providerEnv?: Record<string, string>, url = target) => {
		resetProxyEnv();
		Object.assign(process.env, env);
		return resolveHttpsFallbackProxyUrl(url, providerEnv)?.href;
	};

	it("is HTTP_PROXY when no https proxy is set, as Node.js's dispatcher takes it, and only for an https request", () => {
		expect(fallback({ HTTP_PROXY: "http://proxy.example:8080" })).toBe("http://proxy.example:8080/");
		expect(fallback({ http_proxy: "http://lower.example:8080", HTTP_PROXY: "http://upper.example:8080" })).toBe(
			"http://lower.example:8080/",
		);
		expect(fallback({ HTTP_PROXY: "proxy.example:3128" })).toBe("http://proxy.example:3128/");
		// A SOCKS ALL_PROXY is not one the runtime's fetch uses, so it does not stand in for the http proxy.
		expect(fallback({ HTTP_PROXY: "http://proxy.example:8080", ALL_PROXY: "socks5://socks.example:1080" })).toBe(
			"http://proxy.example:8080/",
		);
		expect(fallback({ HTTP_PROXY: "http://proxy.example:8080" }, undefined, "http://api.example.com/v1")).toBe(
			undefined,
		);
	});

	it("is none where the runtime already takes a proxy, where NO_PROXY exempts the host, or where Node.js takes none", () => {
		expect(fallback({ HTTP_PROXY: "http://proxy.example:8080", HTTPS_PROXY: "http://https.example:8080" })).toBe(
			undefined,
		);
		expect(fallback({ HTTP_PROXY: "http://proxy.example:8080", https_proxy: "http://https.example:8080" })).toBe(
			undefined,
		);
		expect(fallback({ HTTP_PROXY: "http://proxy.example:8080", ALL_PROXY: "http://all.example:8080" })).toBe(
			undefined,
		);
		expect(fallback({ HTTP_PROXY: "http://proxy.example:8080", NO_PROXY: ".example.com" })).toBe(undefined);
		// Node.js reads the lowercase variable when it is set at all: an empty one means no proxy.
		expect(fallback({ http_proxy: "", HTTP_PROXY: "http://proxy.example:8080" })).toBe(undefined);
		expect(fallback({ HTTP_PROXY: "socks5://socks.example:1080" })).toBe(undefined);
		expect(fallback({})).toBe(undefined);
	});

	it("reads a credential's own proxy variables before the process's", () => {
		expect(
			fallback({ HTTP_PROXY: "http://process.example:8080" }, { HTTP_PROXY: "http://scoped.example:8080" }),
		).toBe("http://scoped.example:8080/");
		expect(
			fallback({ HTTP_PROXY: "http://process.example:8080" }, { HTTPS_PROXY: "http://scoped-https.example:8080" }),
		).toBe(undefined);
	});
});
