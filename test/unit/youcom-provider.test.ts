import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test, vi } from "vitest";

// Isolate the provider under test from the developer's real machine config:
// resolve every config path to a temp directory that no test writes unless it
// intends to, so availability and routing depend only on stubbed env vars.
const configDir = await vi.hoisted(async () => {
	const { mkdtempSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	return mkdtempSync(join(tmpdir(), "youcom-provider-test-"));
});

vi.mock("../../packages/web-access/config-paths.js", () => {
	// Isolate the provider under test from the developer's real machine config:
	// resolve every config path into a temp directory that no test writes
	// unless it intends to, so availability depends only on stubbed env vars
	// and the user's real ~/.atomic/web-search.json can never leak in.
	const isolated = `${configDir}/web-search.json`;
	return {
		WEB_SEARCH_CONFIG_PATHS: [isolated],
		WEB_SEARCH_CONFIG_PATH: isolated,
		EXA_USAGE_PATHS: [`${configDir}/exa-usage.json`],
		EXA_USAGE_PATH: `${configDir}/exa-usage.json`,
		findReadableConfigPath: () => isolated,
	};
});

const { isDomainFilterValidationError, isYoucomAvailable, searchWithYoucom } = await import(
	"../../packages/web-access/youcom.js"
);
const { activityMonitor } = await import("../../packages/web-access/activity.js");

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

function webResults(entries: Array<Partial<{ url: string; title: string; description: string }>>): unknown {
	return { results: { web: entries } };
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

	test("floors count at 1 when numResults is zero or negative", async () => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");

		for (const numResults of [0, -3]) {
			fetchResult = okResponse({ results: { web: [] } });
			await searchWithYoucom("query", { numResults });
			const body = JSON.parse(fetchCalls.at(-1)?.init.body as string) as Record<string, unknown>;
			assert.equal(body.count, 1, `numResults ${numResults} should send count 1`);
		}
	});

	test("coerces fractional and non-finite numResults to an integer count", async () => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");

		const cases: Array<[number, number]> = [
			[2.5, 2],
			[Number.NaN, 5],
			[Number.POSITIVE_INFINITY, 20],
		];
		for (const [numResults, expected] of cases) {
			fetchResult = okResponse({ results: { web: [] } });
			await searchWithYoucom("query", { numResults });
			const body = JSON.parse(fetchCalls.at(-1)?.init.body as string) as Record<string, unknown>;
			assert.equal(body.count, expected, `numResults ${numResults} should send count ${expected}`);
		}
	});

	test("maps recencyFilter to the freshness parameter", async () => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		fetchResult = okResponse({ results: { web: [] } });

		await searchWithYoucom("latest news", { recencyFilter: "week" });

		const body = JSON.parse(fetchCalls[0].init.body as string) as Record<string, unknown>;
		assert.equal(body.freshness, "week");
	});

	test("sends a pure include filter as include_domains with the requested count", async () => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		fetchResult = okResponse({ results: { web: [] } });

		await searchWithYoucom("query", { numResults: 5, domainFilter: ["docs.rs"] });

		const body = JSON.parse(fetchCalls[0].init.body as string) as Record<string, unknown>;
		assert.deepEqual(body.include_domains, ["docs.rs"]);
		assert.equal("exclude_domains" in body, false);
		assert.equal(body.count, 5);
	});

	test("sends a pure exclude filter (prefix -) as exclude_domains with the requested count", async () => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		fetchResult = okResponse({ results: { web: [] } });

		await searchWithYoucom("query", { numResults: 5, domainFilter: ["-tokio.rs"] });

		const body = JSON.parse(fetchCalls[0].init.body as string) as Record<string, unknown>;
		assert.deepEqual(body.exclude_domains, ["tokio.rs"]);
		assert.equal("include_domains" in body, false);
		assert.equal(body.count, 5);
	});

	test("sends include_domains only for a mixed filter and enforces the exclusions client-side", async () => {
		// The API returns 422 when include_domains and exclude_domains are both
		// present, so a mixed filter keeps server-side narrowing via
		// include_domains and enforces the exclusions client-side; the full page
		// is requested because client-side exclusion can shrink it.
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		fetchResult = okResponse(
			webResults([
				{ url: "https://blog.rust-lang.org/a", title: "Kept" },
				{ url: "https://forum.rust-lang.org/b", title: "Excluded but still returned by the server" },
			]),
		);

		const response = await searchWithYoucom("query", {
			numResults: 5,
			domainFilter: ["rust-lang.org", "-forum.rust-lang.org"],
		});

		const body = JSON.parse(fetchCalls[0].init.body as string) as Record<string, unknown>;
		assert.deepEqual(body.include_domains, ["rust-lang.org"]);
		assert.equal("exclude_domains" in body, false);
		assert.equal(body.count, 20);
		assert.equal(response.results.length, 1);
		assert.equal(response.results[0]?.url, "https://blog.rust-lang.org/a");
	});

	test("normalizes include entries with a scheme and path before sending them", async () => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		fetchResult = okResponse({ results: { web: [] } });

		await searchWithYoucom("query", { numResults: 5, domainFilter: ["https://docs.rs/tokio"] });

		const body = JSON.parse(fetchCalls[0].init.body as string) as Record<string, unknown>;
		assert.deepEqual(body.include_domains, ["docs.rs"]);
	});

	test("normalizes exclude entries with a scheme and path before sending them", async () => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		fetchResult = okResponse({ results: { web: [] } });

		await searchWithYoucom("query", { numResults: 5, domainFilter: ["-http://medium.com/x"] });

		const body = JSON.parse(fetchCalls[0].init.body as string) as Record<string, unknown>;
		assert.deepEqual(body.exclude_domains, ["medium.com"]);
		assert.equal("include_domains" in body, false);
	});

	test("strips a port and a leading *. wildcard from include entries before sending them", async () => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		fetchResult = okResponse({ results: { web: [] } });

		await searchWithYoucom("query", { numResults: 5, domainFilter: ["*.Docs.rs:443"] });

		const body = JSON.parse(fetchCalls[0].init.body as string) as Record<string, unknown>;
		assert.deepEqual(body.include_domains, ["docs.rs"]);
		assert.equal("exclude_domains" in body, false);
	});

	test("folds an IDN include entry to ASCII before sending it", async () => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		fetchResult = okResponse({ results: { web: [] } });

		await searchWithYoucom("query", { numResults: 5, domainFilter: ["bücher.de"] });

		const body = JSON.parse(fetchCalls[0].init.body as string) as Record<string, unknown>;
		assert.deepEqual(body.include_domains, ["xn--bcher-kva.de"]);
	});

	test("trims a trailing dot from an include entry before sending it", async () => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		fetchResult = okResponse({ results: { web: [] } });

		await searchWithYoucom("query", { numResults: 5, domainFilter: ["docs.rs."] });

		const body = JSON.parse(fetchCalls[0].init.body as string) as Record<string, unknown>;
		assert.deepEqual(body.include_domains, ["docs.rs"]);
	});

	test("rejects an invalid entry with a DomainFilterValidationError recognized by the predicate", async () => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		fetchResult = okResponse(webResults([{ url: "https://example.com/a", title: "Would be fail-open" }]));

		let caught: unknown;
		try {
			await searchWithYoucom("validation-error-identity", { domainFilter: ["not a host!"] });
		} catch (err) {
			caught = err;
		}

		assert.ok(caught instanceof Error, "the search must reject");
		assert.equal(caught.name, "DomainFilterValidationError");
		assert.equal(isDomainFilterValidationError(caught), true);
		assert.match(caught.message, /Invalid domainFilter entry "not a host!"/);
		assert.equal(fetchCalls.length, 0, "no request should be made for an invalid filter");
	});

	test("rejects blank domainFilter entries before any request or activity entry", async () => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		fetchResult = okResponse(webResults([{ url: "https://example.com/a", title: "Would be fail-open" }]));

		for (const domainFilter of [[""], ["  ", ""]]) {
			await assert.rejects(
				() => searchWithYoucom("blank-filter-entry", { domainFilter }),
				/Invalid domainFilter entry "\s*": expected a hostname like example\.com \(prefix with - to exclude\)/,
			);
		}

		assert.equal(fetchCalls.length, 0, "no request should be made for a blank filter entry");
		const entry = activityMonitor.getEntries().find((e) => e.query === "blank-filter-entry");
		assert.equal(entry, undefined, "no activity entry should be created for a blank filter entry");
	});

	test("rejects a non-string domainFilter entry before any request or activity entry", async () => {
		// Tool arguments are not validated at runtime by the host, so a number
		// can reach the provider; it must not be skipped into an open filter.
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		fetchResult = okResponse(webResults([{ url: "https://example.com/a", title: "Would be fail-open" }]));

		await assert.rejects(
			() => searchWithYoucom("non-string-filter-entry", { domainFilter: [123] as unknown as string[] }),
			/Invalid domainFilter entry "123": expected a hostname like example\.com \(prefix with - to exclude\)/,
		);

		assert.equal(fetchCalls.length, 0, "no request should be made for a non-string filter entry");
		const entry = activityMonitor.getEntries().find((e) => e.query === "non-string-filter-entry");
		assert.equal(entry, undefined, "no activity entry should be created for a non-string filter entry");
	});

	test("rejects an object domainFilter entry even when it stringifies to an exclusion", async () => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		fetchResult = okResponse(webResults([{ url: "https://docs.rs/a", title: "Would be fail-open" }]));

		await assert.rejects(
			() =>
				searchWithYoucom("object-filter-entry", {
					domainFilter: [{ toString: () => "-docs.rs" }] as unknown as string[],
				}),
			/Invalid domainFilter entry "-docs\.rs": expected a hostname like example\.com \(prefix with - to exclude\)/,
		);

		assert.equal(fetchCalls.length, 0, "no request should be made for an object filter entry");
		const entry = activityMonitor.getEntries().find((e) => e.query === "object-filter-entry");
		assert.equal(entry, undefined, "no activity entry should be created for an object filter entry");
	});

	test("rejects a filter mixing a valid exclusion with a non-string entry instead of dropping the entry", async () => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		fetchResult = okResponse(webResults([{ url: "https://example.com/a", title: "Would be fail-open" }]));

		await assert.rejects(
			() =>
				searchWithYoucom("mixed-valid-and-non-string-entry", {
					domainFilter: ["-docs.rs", 123] as unknown as string[],
				}),
			/Invalid domainFilter entry "123": expected a hostname like example\.com \(prefix with - to exclude\)/,
		);

		assert.equal(fetchCalls.length, 0, "no request should be made when any filter entry is invalid");
		const entry = activityMonitor.getEntries().find((e) => e.query === "mixed-valid-and-non-string-entry");
		assert.equal(entry, undefined, "no activity entry should be created when any filter entry is invalid");
	});

	test("rejects an invalid include entry before any request or activity entry", async () => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		fetchResult = okResponse(webResults([{ url: "https://example.com/a", title: "Would be fail-open" }]));

		await assert.rejects(
			() => searchWithYoucom("invalid-include-entry", { domainFilter: ["not a host!"] }),
			/Invalid domainFilter entry "not a host!": expected a hostname like example\.com \(prefix with - to exclude\)/,
		);

		assert.equal(fetchCalls.length, 0, "no request should be made for an invalid filter");
		const entry = activityMonitor.getEntries().find((e) => e.query === "invalid-include-entry");
		assert.equal(entry, undefined, "no activity entry should be created for an invalid filter");
	});

	test("rejects an invalid exclude entry before any request or activity entry", async () => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		fetchResult = okResponse(webResults([{ url: "https://example.com/a", title: "Would be fail-open" }]));

		await assert.rejects(
			() => searchWithYoucom("invalid-exclude-entry", { domainFilter: ["-docs"] }),
			/Invalid domainFilter entry "-docs": expected a hostname like example\.com \(prefix with - to exclude\)/,
		);

		assert.equal(fetchCalls.length, 0, "no request should be made for an invalid filter");
		const entry = activityMonitor.getEntries().find((e) => e.query === "invalid-exclude-entry");
		assert.equal(entry, undefined, "no activity entry should be created for an invalid filter");
	});

	test("rejects a bare - exclusion prefix before any request or activity entry", async () => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		fetchResult = okResponse(webResults([{ url: "https://example.com/a", title: "Would be fail-open" }]));

		await assert.rejects(
			() => searchWithYoucom("bare-exclusion-prefix", { domainFilter: ["example.com", "-"] }),
			/Invalid domainFilter entry "-": expected a hostname like example\.com \(prefix with - to exclude\)/,
		);

		assert.equal(fetchCalls.length, 0, "no request should be made for an invalid filter");
		const entry = activityMonitor.getEntries().find((e) => e.query === "bare-exclusion-prefix");
		assert.equal(entry, undefined, "no activity entry should be created for an invalid filter");
	});

	test.each([
		["a bare string", "docs.rs"],
		["a plain object", { include: "docs.rs" }],
		["a number", 42],
	])("rejects %s passed as the whole domainFilter before any request or activity entry", async (label, malformed) => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		fetchResult = okResponse(webResults([{ url: "https://example.com/a", title: "Would be fail-open" }]));
		const query = `non-array-domain-filter ${label}`;

		let caught: unknown;
		try {
			await searchWithYoucom(query, { domainFilter: malformed as unknown as string[] });
		} catch (err) {
			caught = err;
		}

		assert.ok(caught instanceof Error, "a non-array domainFilter must reject");
		assert.equal(isDomainFilterValidationError(caught), true, "the rejection must be a DomainFilterValidationError");
		assert.match(caught.message, /domainFilter must be an array of hostnames/);
		assert.equal(fetchCalls.length, 0, "no request should be made for a non-array domainFilter");
		const entry = activityMonitor.getEntries().find((e) => e.query === query);
		assert.equal(entry, undefined, "no activity entry should be created for a non-array domainFilter");
	});
});

describe("youcom domainFilter enforcement", () => {
	test("keeps only results from included domains", async () => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		fetchResult = okResponse(
			webResults([
				{ url: "https://docs.rust-lang.org/book", title: "Rust Book", description: "async chapters" },
				{ url: "https://blog.example.com/post", title: "Other", description: "unrelated" },
			]),
		);

		const response = await searchWithYoucom("query", { domainFilter: ["rust-lang.org"] });

		assert.equal(response.results.length, 1);
		assert.equal(response.results[0]?.url, "https://docs.rust-lang.org/book");
	});

	test("matches subdomains of an included domain", async () => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		fetchResult = okResponse(webResults([{ url: "https://blog.rust-lang.org/2026/ann", title: "Announcement" }]));

		const response = await searchWithYoucom("query", { domainFilter: ["rust-lang.org"] });

		assert.equal(response.results.length, 1);
	});

	test("drops results from excluded domains (prefix -)", async () => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		fetchResult = okResponse(
			webResults([
				{ url: "https://pinterest.com/pin/1", title: "Excluded" },
				{ url: "https://example.com/page", title: "Kept" },
			]),
		);

		const response = await searchWithYoucom("query", { domainFilter: ["-pinterest.com"] });

		assert.equal(response.results.length, 1);
		assert.equal(response.results[0]?.url, "https://example.com/page");
	});

	test("excludes subdomains of an excluded domain", async () => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		fetchResult = okResponse(webResults([{ url: "https://i.pinterest.com/x", title: "Excluded subdomain" }]));

		const response = await searchWithYoucom("query", { domainFilter: ["-pinterest.com"] });

		assert.equal(response.results.length, 0);
	});

	test("honors mixed include and exclude filters together", async () => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		fetchResult = okResponse(
			webResults([
				{ url: "https://blog.rust-lang.org/a", title: "Kept" },
				{ url: "https://forum.rust-lang.org/b", title: "Excluded subdomain" },
				{ url: "https://example.com/c", title: "Not included" },
			]),
		);

		const response = await searchWithYoucom("query", { domainFilter: ["rust-lang.org", "-forum.rust-lang.org"] });

		assert.equal(response.results.length, 1);
		assert.equal(response.results[0]?.url, "https://blog.rust-lang.org/a");
	});

	test("treats an empty domainFilter as no restriction", async () => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		fetchResult = okResponse(webResults([{ url: "https://example.com/a", title: "Kept" }]));

		const response = await searchWithYoucom("query", { numResults: 6, domainFilter: [] });

		const body = JSON.parse(fetchCalls[0].init.body as string) as Record<string, unknown>;
		assert.equal(body.count, 6);
		assert.equal("include_domains" in body, false);
		assert.equal("exclude_domains" in body, false);
		assert.equal(response.results.length, 1);
	});

	test("treats an undefined domainFilter as no restriction", async () => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		fetchResult = okResponse(webResults([{ url: "https://example.com/a", title: "Kept" }]));

		const response = await searchWithYoucom("query", { numResults: 6, domainFilter: undefined });

		const body = JSON.parse(fetchCalls[0].init.body as string) as Record<string, unknown>;
		assert.equal(body.count, 6);
		assert.equal("include_domains" in body, false);
		assert.equal("exclude_domains" in body, false);
		assert.equal(response.results.length, 1);
	});

	test("drops results whose URL cannot be parsed when a filter is active", async () => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		fetchResult = okResponse(webResults([{ url: "not a url", title: "Unparseable" }]));

		const response = await searchWithYoucom("query", { domainFilter: ["example.com"] });
		assert.equal(response.results.length, 0);
	});

	test("drops an off-domain result client-side even when include_domains was sent", async () => {
		// The server contract is not trusted blindly: a result outside the
		// include list is dropped even though the API was asked to filter.
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		fetchResult = okResponse(
			webResults([
				{ url: "https://docs.rs/tokio/latest", title: "Kept" },
				{ url: "https://blog.example.com/post", title: "Off-domain" },
			]),
		);

		const response = await searchWithYoucom("query", { domainFilter: ["docs.rs"] });

		const body = JSON.parse(fetchCalls[0].init.body as string) as Record<string, unknown>;
		assert.deepEqual(body.include_domains, ["docs.rs"]);
		assert.equal(response.results.length, 1);
		assert.equal(response.results[0]?.url, "https://docs.rs/tokio/latest");
	});

	test("applies normalized include entries to client-side matching", async () => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		fetchResult = okResponse(webResults([{ url: "https://docs.rs/tokio/latest", title: "Kept" }]));

		const response = await searchWithYoucom("query", { domainFilter: ["https://docs.rs/tokio"] });

		assert.equal(response.results.length, 1);
		assert.equal(response.results[0]?.url, "https://docs.rs/tokio/latest");
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
	});

	test("synthesizes an answer from result snippets with source citations", async () => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		fetchResult = okResponse({
			results: {
				web: [
					{ url: "https://example.com/article", title: "Article Title", description: "Brief description" },
					{ url: "https://example.com/bare", title: "No Snippet" },
				],
				news: [{ url: "https://news.example.com/story", title: "News Headline", description: "News summary" }],
			},
		});

		const response = await searchWithYoucom("query", { numResults: 5 });

		assert.equal(
			response.answer,
			"Brief description\nSource: Article Title (https://example.com/article)\n\n" +
				"News summary\nSource: News Headline (https://news.example.com/story)",
		);
	});

	test("caps per-result snippet content at 1000 characters, mirroring the exa cap", async () => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		const longDescription = "x".repeat(3000);
		fetchResult = okResponse(
			webResults([{ url: "https://example.com/long", title: "Long", description: longDescription }]),
		);

		const response = await searchWithYoucom("query");

		assert.equal(response.results[0]?.snippet, "x".repeat(1000));
		assert.equal(response.answer, `${"x".repeat(1000)}\nSource: Long (https://example.com/long)`);
	});

	test("returns an empty answer when no result has a snippet", async () => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		fetchResult = okResponse(
			webResults([
				{ url: "https://example.com/1", title: "One" },
				{ url: "https://example.com/2", title: "Two" },
			]),
		);

		const response = await searchWithYoucom("query");
		assert.equal(response.answer, "");
		assert.equal(response.results.length, 2);
	});

	test("caps combined web+news results at numResults", async () => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		fetchResult = okResponse({
			results: {
				web: [
					{ url: "https://example.com/1", title: "One" },
					{ url: "https://example.com/2", title: "Two" },
				],
				news: [
					{ url: "https://example.com/3", title: "Three" },
					{ url: "https://example.com/4", title: "Four" },
				],
			},
		});

		const response = await searchWithYoucom("query", { numResults: 3 });
		assert.equal(response.results.length, 3);
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

	test("keeps a result whose snippets array mixes strings and non-strings", async () => {
		// The shape guard only requires snippets to be an array; toSearchResult
		// filters non-string elements individually.
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		fetchResult = okResponse({
			results: {
				web: [{ url: "https://example.com/mixed", title: "Mixed", snippets: ["good", 5] }],
			},
		});

		const response = await searchWithYoucom("query");
		assert.equal(response.results.length, 1);
		assert.equal(response.results[0]?.snippet, "good");
	});

	test("returns empty results when the response omits 'results' entirely", async () => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		fetchResult = okResponse({});

		const response = await searchWithYoucom("query");
		assert.deepEqual(response.results, []);
	});
});

describe("youcom response-shape validation", () => {
	test("rejects a non-object response body", async () => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		fetchResult = okResponse("just a string");

		await assert.rejects(() => searchWithYoucom("query"), /expected a JSON object/);
	});

	test("rejects a non-object results field", async () => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		fetchResult = okResponse({ results: "nope" });

		await assert.rejects(() => searchWithYoucom("query"), /'results' is not an object/);
	});

	test("rejects a non-array results.web", async () => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		fetchResult = okResponse({ results: { web: "not-an-array" } });

		await assert.rejects(() => searchWithYoucom("query"), /'results.web' is not an array/);
	});

	test("rejects a non-array results.news", async () => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		fetchResult = okResponse({ results: { news: 42 } });

		await assert.rejects(() => searchWithYoucom("query"), /'results.news' is not an array/);
	});

	test("skips entries that do not match the result shape instead of failing", async () => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		fetchResult = okResponse({
			results: {
				web: [
					{ url: "https://example.com/valid", title: "Valid" },
					{ title: "Missing url" },
					"url-in-string",
					{ url: 123, title: "Non-string url" },
					null,
				],
			},
		});

		const response = await searchWithYoucom("query");
		assert.equal(response.results.length, 1);
		assert.equal(response.results[0]?.url, "https://example.com/valid");
	});
});

describe("youcom error handling and activity tracking", () => {
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

	test("settles activity tracking with an error when response-shape validation fails", async () => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		fetchResult = okResponse({ results: { web: "not-an-array" } });

		await assert.rejects(() => searchWithYoucom("shape-validation-failure"), /'results.web' is not an array/);
		const entry = activityMonitor.getEntries().find((e) => e.query === "shape-validation-failure");
		assert.ok(entry, "activity entry should exist");
		assert.ok(entry.endTime !== undefined, "activity entry should be settled");
		assert.match(entry.error ?? "", /'results.web' is not an array/);
	});

	test("does not leave a dangling activity entry when the key is missing", async () => {
		vi.stubEnv("YDC_API_KEY", "");
		await assert.rejects(() => searchWithYoucom("missing-key-no-activity"), /You.com API key not found/);
		const entry = activityMonitor.getEntries().find((e) => e.query === "missing-key-no-activity");
		assert.equal(entry, undefined, "no activity entry should be created without a key");
	});

	test("marks activity complete after a successful search", async () => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		fetchResult = okResponse(webResults([{ url: "https://example.com/a", title: "A" }]));

		await searchWithYoucom("successful-search");
		const entry = activityMonitor.getEntries().find((e) => e.query === "successful-search");
		assert.ok(entry, "activity entry should exist");
		assert.equal(entry.status, 200);
		assert.equal(entry.error, undefined);
	});

	test("propagates an abort and settles activity with status 0", async () => {
		vi.stubEnv("YDC_API_KEY", "ydc-test-key");
		const controller = new AbortController();
		controller.abort();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				const err = new Error("This operation was aborted");
				err.name = "AbortError";
				throw err;
			}),
		);

		await assert.rejects(() => searchWithYoucom("aborted-search", { signal: controller.signal }), /aborted/i);
		const entry = activityMonitor.getEntries().find((e) => e.query === "aborted-search");
		assert.ok(entry, "activity entry should exist");
		assert.equal(entry.status, 0);
	});
});
