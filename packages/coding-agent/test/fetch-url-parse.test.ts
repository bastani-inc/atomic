import { describe, expect, it } from "vitest";
import { getReadUrlCacheKey, parseReadUrlTarget, repairCollapsedScheme } from "../src/core/tools/fetch-url.ts";

describe("fetch-url parseReadUrlTarget", () => {
	it("repairs collapsed schemes", () => {
		expect(repairCollapsedScheme("https:/example.com/x")).toBe("https://example.com/x");
	});

	it("parses plain url and www", () => {
		expect(parseReadUrlTarget("https://example.com")?.url).toBe("https://example.com");
		expect(parseReadUrlTarget("www.example.com")?.url).toBe("www.example.com");
	});

	it("parses raw selector", () => {
		const t = parseReadUrlTarget("https://example.com/page:raw");
		expect(t?.raw).toBe(true);
		expect(t?.url).toBe("https://example.com/page");
	});

	it("parses single range into offset/limit", () => {
		const t = parseReadUrlTarget("https://example.com/page:5-10");
		expect(t?.offset).toBe(5);
		expect(t?.limit).toBe(6);
		expect(t?.ranges).toBeUndefined();
	});

	it("parses plus range", () => {
		const t = parseReadUrlTarget("https://example.com/page:5+3");
		expect(t?.offset).toBe(5);
		expect(t?.limit).toBe(3);
	});

	it("parses multi-range into ranges", () => {
		const t = parseReadUrlTarget("https://example.com/page:5-10,20-30");
		expect(t?.ranges).toEqual([{ start: 5, end: 10 }, { start: 20, end: 30 }]);
		expect(t?.offset).toBeUndefined();
	});

	it("returns null for non-url", () => {
		expect(parseReadUrlTarget("not a url")).toBeNull();
	});

	it("does not treat host:port path without selector as range", () => {
		const t = parseReadUrlTarget("https://example.com:8080/path");
		expect(t?.url).toBe("https://example.com:8080/path");
		expect(t?.raw).toBe(false);
	});
});

describe("fetch-url cache key", () => {
	it("scopes by session and raw mode", () => {
		expect(getReadUrlCacheKey("/s1", "https://x.com", false)).toBe("/s1::rendered::https://x.com");
		expect(getReadUrlCacheKey("/s1", "https://x.com", true)).toBe("/s1::raw::https://x.com");
	});
});
