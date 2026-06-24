import { expect, test } from "bun:test";
import { getReadUrlCacheKey, isReadableUrlPath, parseReadUrlTarget, repairCollapsedScheme } from "../src/core/tools/fetch-url.ts";

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

test("cache keys are scoped and split raw vs rendered", () => {
	const a = getReadUrlCacheKey("session-1", "https://example.com", false);
	const b = getReadUrlCacheKey("session-1", "https://example.com", true);
	const c = getReadUrlCacheKey("session-2", "https://example.com", false);
	expect(a).not.toBe(b);
	expect(a).not.toBe(c);
	expect(a).toBe(getReadUrlCacheKey("session-1", "https://example.com", false));
});
