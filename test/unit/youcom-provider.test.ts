import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { isYoucomAvailable, searchWithYoucom } from "../../packages/web-access/youcom.js";

interface FetchCall {
	url: string;
	init: RequestInit;
}

let fetchCalls: FetchCall[];
let fetchResult: Response;

beforeEach(() => {
	fetchCalls = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL, init?: RequestInit) => {
			fetchCalls.push({ url: String(url), init: init ?? {} });
			return fetchResult;
		}),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

function okResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("youcom provider availability", () => {
	test("isYoucomAvailable is false without a key", () => {
		vi.stubEnv("YDC_API_KEY", "");
		assert.equal(isYoucomAvailable(), false);
	});

	test("isYoucomAvailable is true with YDC_API_KEY set", () => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		assert.equal(isYoucomAvailable(), true);
	});

	test("searchWithYoucom throws a setup message when no key is configured", async () => {
		vi.stubEnv("YDC_API_KEY", "");
		await assert.rejects(() => searchWithYoucom("rust async runtime"), /You.com API key not found/);
		assert.equal(fetchCalls.length, 0, "no request should be made without a key");
	});
});

describe("youcom search requests", () => {
	test("posts query and count to the You.com search endpoint with the API key header", async () => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		fetchResult = okResponse({ results: { web: [] } });

		await searchWithYoucom("rust async runtime comparison", { numResults: 7 });

		assert.equal(fetchCalls.length, 1);
		assert.equal(fetchCalls[0].url, "https://ydc-index.io/v1/search");
		assert.equal(fetchCalls[0].init.method, "POST");
		assert.equal((fetchCalls[0].init.headers as Record<string, string>)["X-API-Key"], "ydc-test-key");
		const body = JSON.parse(fetchCalls[0].init.body as string) as Record<string, unknown>;
		assert.equal(body.query, "rust async runtime comparison");
		assert.equal(body.count, 7);
	});

	test("caps count at 20 results", async () => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		fetchResult = okResponse({ results: { web: [] } });

		await searchWithYoucom("query", { numResults: 100 });

		const body = JSON.parse(fetchCalls[0].init.body as string) as Record<string, unknown>;
		assert.equal(body.count, 20);
	});

	test("maps recencyFilter to the freshness parameter", async () => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		fetchResult = okResponse({ results: { web: [] } });

		await searchWithYoucom("latest news", { recencyFilter: "week" });

		const body = JSON.parse(fetchCalls[0].init.body as string) as Record<string, unknown>;
		assert.equal(body.freshness, "week");
	});
});

describe("youcom response mapping", () => {
	test("maps web and news results to SearchResult shape", async () => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		fetchResult = okResponse({
			results: {
				web: [
					{
						url: "https://example.com/article",
						title: "Article Title",
						description: "Brief description",
						snippets: ["Relevant excerpt", "Brief description"],
						page_age: "2026-09-01T10:30:00",
					},
					{
						// Missing URL: skipped entirely
						title: "No URL result",
					},
				],
				news: [
					{
						url: "https://news.example.com/story",
						title: "News Headline",
						description: "News summary",
					},
				],
			},
		});

		const response = await searchWithYoucom("query", { numResults: 5 });

		assert.deepEqual(response.results, [
			{
				title: "Article Title",
				url: "https://example.com/article",
				snippet: "Brief description · Relevant excerpt",
			},
			{
				title: "News Headline",
				url: "https://news.example.com/story",
				snippet: "News summary",
			},
		]);
		assert.equal(response.answer, "");
	});

	test("falls back to a numbered source title when the title is missing", async () => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		fetchResult = okResponse({
			results: {
				web: [
					{
						url: "https://example.com/untitled",
						snippets: ["excerpt"],
					},
				],
			},
		});

		const response = await searchWithYoucom("query");
		assert.equal(response.results[0]?.title, "Source 1");
		assert.equal(response.results[0]?.snippet, "excerpt");
	});
});

describe("youcom error handling", () => {
	test("surfaces HTTP errors with status and body", async () => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		fetchResult = new Response(JSON.stringify({ detail: "Missing required scopes" }), {
			status: 403,
			headers: { "Content-Type": "application/json" },
		});

		await assert.rejects(() => searchWithYoucom("query"), /You.com API error 403/);
	});

	test("surfaces invalid JSON responses", async () => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		fetchResult = new Response("not json", { status: 200 });

		await assert.rejects(() => searchWithYoucom("query"), /You.com API returned invalid JSON/);
	});
});
