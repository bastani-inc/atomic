import { expect, test, vi } from "vitest";

// Hoisted DNS resolution used by the mocked node:dns/promises.lookup. `null`
// (default) preserves the real lookup; a hostname test sets a public IP to force
// the pinned (undici) connect path.
const { resolvedHost, setResolvedHost } = vi.hoisted(() => {
	const state = { address: null as { address: string; family: number } | null };
	return {
		resolvedHost: state,
		setResolvedHost: (value: { address: string; family: number } | null) => { state.address = value; },
	};
});
vi.mock("node:dns/promises", async (importActual) => {
	const actual = await importActual<typeof import("node:dns/promises")>();
	return {
		...actual,
		lookup: ((hostname: string, options?: object) =>
			resolvedHost.address ? Promise.resolve([resolvedHost.address]) : actual.lookup(hostname, options as never)) as typeof actual.lookup,
	};
});

import { getReadUrlCacheKey, isReadableUrlPath, loadPage, parseReadUrlTarget, repairCollapsedScheme } from "../src/core/tools/fetch-url.ts";

// Network rendering (HTML→markdown, caching, llms.txt discovery, artifact
// persistence) is exercised through the read-tool integration path; these
// deterministic unit tests cover the URL parsing/cache-key surface that drives
// it without depending on an ephemeral local HTTP server.

test("repairs collapsed URL schemes", () => {
	expect(repairCollapsedScheme("https:/example.com")).toBe("https://example.com");
	expect(repairCollapsedScheme("http:/a.b/c")).toBe("http://a.b/c");
	expect(repairCollapsedScheme("https://ok.com")).toBe("https://ok.com");
});

test("recognizes readable URL paths including bare www", () => {
	expect(isReadableUrlPath("https://example.com")).toBe(true);
	expect(isReadableUrlPath("http://example.com")).toBe(true);
	expect(isReadableUrlPath("www.example.com")).toBe(true);
	expect(isReadableUrlPath("./local/file.ts")).toBe(false);
	expect(isReadableUrlPath("data.sqlite:users")).toBe(false);
});

test("parses URL targets with raw and line-range selectors", () => {
	expect(parseReadUrlTarget("https://example.com/doc")?.url).toBe("https://example.com/doc");
	const ranged = parseReadUrlTarget("https://example.com/doc:5-10");
	expect(ranged?.url).toBe("https://example.com/doc");
	const raw = parseReadUrlTarget("https://example.com/doc:raw");
	expect(raw?.url).toBe("https://example.com/doc");
	expect(raw?.raw).toBe(true);
	// Host/port URLs keep their port; a selector needs a trailing slash to disambiguate.
	expect(parseReadUrlTarget("https://example.com:8080/")?.url).toBe("https://example.com:8080/");
	// Bare www is recognized; scheme normalization happens at fetch time.
	expect(parseReadUrlTarget("www.example.com")?.url).toBe("www.example.com");
});

test("rejects invalid URL line selectors", () => {
	expect(() => parseReadUrlTarget("https://example.com/doc:0")).toThrow("Invalid URL line selector");
	expect(() => parseReadUrlTarget("https://example.com/doc:3+0")).toThrow("Invalid URL line selector");
});

test.sequential("blocks private URL reads by default", async () => {
	const previous = process.env.ATOMIC_ALLOW_PRIVATE_URL_READS;
	delete process.env.ATOMIC_ALLOW_PRIVATE_URL_READS;
	try {
		await expect(loadPage("http://127.0.0.1:1/", 100)).rejects.toThrow("Refusing to fetch private or metadata URL");
		await expect(loadPage("http://localhost:1/", 100)).rejects.toThrow("Refusing to fetch private or metadata URL");
		for (const host of ["2130706433", "0x7f.0.0.1", "0177.0.0.1", "127.1"]) {
			await expect(loadPage(`http://${host}:1/`, 100)).rejects.toThrow("Refusing to fetch private or metadata URL");
		}
		for (const host of ["[64:ff9b::a9fe:a9fe]", "[2002:a9fe:a9fe::]", "[0:0:0:0:0:ffff:169.254.169.254]", "[::ffff:7f00:1]"]) {
			await expect(loadPage(`http://${host}/`, 100)).rejects.toThrow("Refusing to fetch private or metadata URL");
		}
		process.env.ATOMIC_ALLOW_PRIVATE_URL_READS = "1";
		await expect(loadPage("file:///etc/passwd", 100)).rejects.toThrow("Unsupported URL protocol");
		delete process.env.ATOMIC_ALLOW_PRIVATE_URL_READS;
	} finally {
		if (previous === undefined) delete process.env.ATOMIC_ALLOW_PRIVATE_URL_READS;
		else process.env.ATOMIC_ALLOW_PRIVATE_URL_READS = previous;
	}
});

test.sequential("revalidates redirect targets before fetching them", async () => {
	const previousAllowance = process.env.ATOMIC_ALLOW_PRIVATE_URL_READS;
	const previousFetch = globalThis.fetch;
	delete process.env.ATOMIC_ALLOW_PRIVATE_URL_READS;
	let calls = 0;
	globalThis.fetch = (async () => { calls++; return new Response("", { status: 302, headers: { Location: "http://127.0.0.1/secret" } }); }) as typeof fetch;
	try {
		await expect(loadPage("http://93.184.216.34/", 100)).rejects.toThrow("Refusing to fetch private or metadata URL");
		expect(calls).toBe(1);
	} finally {
		globalThis.fetch = previousFetch;
		if (previousAllowance === undefined) delete process.env.ATOMIC_ALLOW_PRIVATE_URL_READS;
		else process.env.ATOMIC_ALLOW_PRIVATE_URL_READS = previousAllowance;
	}
});

test("cache keys are scoped and split raw vs rendered", () => {
	const a = getReadUrlCacheKey("session-1", "https://example.com", false);
	const b = getReadUrlCacheKey("session-1", "https://example.com", true);
	const c = getReadUrlCacheKey("session-2", "https://example.com", false);
	expect(a).not.toBe(b);
	expect(a).not.toBe(c);
	expect(a).toBe(getReadUrlCacheKey("session-1", "https://example.com", false));
});

test("pins the DNS-resolved address for hostname fetches (no rebinding at connect)", async () => {
	// Regression: globalThis.fetch ignores the undici `dispatcher` option under
	// Bun's compiled binary, so a hostname target must route through undici's
	// own client for the pinned lookup to take effect. If the pinned (undici)
	// path is taken, a mocked global fetch returning 200 must NOT be reached.
	const previousAllowance = process.env.ATOMIC_ALLOW_PRIVATE_URL_READS;
	const previousFetch = globalThis.fetch;
	delete process.env.ATOMIC_ALLOW_PRIVATE_URL_READS;
	let globalFetchCalls = 0;
	globalThis.fetch = (async () => { globalFetchCalls++; return new Response("should-not-reach", { status: 200 }); }) as typeof fetch;
	// Resolve the hostname to a routable-but-unreachable public IP; undici's
	// pinned client attempts the connect and fails — proving the request went
	// through undici (the pinned path), not the mocked global fetch.
	setResolvedHost({ address: "192.0.2.1", family: 4 });
	try {
		await expect(loadPage("http://dns-pinned.example/", 2000, undefined, "text/plain")).rejects.toThrow();
		// The hostname went through undici's pinned client, not global fetch.
		expect(globalFetchCalls).toBe(0);
	} finally {
		setResolvedHost(null);
		globalThis.fetch = previousFetch;
		if (previousAllowance === undefined) delete process.env.ATOMIC_ALLOW_PRIVATE_URL_READS;
		else process.env.ATOMIC_ALLOW_PRIVATE_URL_READS = previousAllowance;
	}
});
