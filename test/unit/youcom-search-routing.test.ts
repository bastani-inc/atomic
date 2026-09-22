import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test, vi } from "vitest";

/**
 * Regression coverage for You.com routing through the shared `search()` entry
 * point in gemini-search.ts — explicit selection, automatic selection, fallback
 * after a You.com error, and cancellation without falling through to another
 * provider. The per-provider behavior of searchWithYoucom itself is covered by
 * youcom-provider.test.ts; these tests exercise the routing layer only, so the
 * sibling provider modules are mocked at the module boundary.
 */

const configDir = await vi.hoisted(async () => {
	const { mkdtempSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	return mkdtempSync(join(tmpdir(), "search-routing-test-"));
});

vi.mock("../../packages/web-access/config-paths.js", () => {
	// Isolate routing from the developer's real machine config: resolve every
	// config path into a temp directory no test writes, so availability and
	// default provider selection depend only on what each test controls.
	const isolated = `${configDir}/web-search.json`;
	return {
		WEB_SEARCH_CONFIG_PATHS: [isolated],
		WEB_SEARCH_CONFIG_PATH: isolated,
		EXA_USAGE_PATHS: [`${configDir}/exa-usage.json`],
		EXA_USAGE_PATH: `${configDir}/exa-usage.json`,
		findReadableConfigPath: () => isolated,
	};
});

const youcomCalls: string[] = [];
const perplexityCalls: string[] = [];
const exaCalls: string[] = [];

vi.mock("../../packages/web-access/youcom.js", () => ({
	isYoucomAvailable: () => youcomAvailableFlag,
	// Mirror the real predicate's name-based check so the routing layer under
	// test recognizes validation errors thrown across this module boundary.
	isDomainFilterValidationError: (err: unknown) =>
		typeof err === "object" && err !== null && (err as { name?: unknown }).name === "DomainFilterValidationError",
	searchWithYoucom: async (query: string) => {
		youcomCalls.push(query);
		return youcomResultFactory();
	},
}));

vi.mock("../../packages/web-access/perplexity.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../packages/web-access/perplexity.js")>();
	return {
		...original,
		isPerplexityAvailable: () => perplexityAvailableFlag,
		searchWithPerplexity: async (query: string) => {
			perplexityCalls.push(query);
			if (perplexityErrorFactory) return perplexityErrorFactory();
			return { answer: `perplexity:${query}`, results: [] };
		},
	};
});

vi.mock("../../packages/web-access/exa.js", () => ({
	hasExaApiKey: () => false,
	isExaAvailable: () => false,
	searchWithExa: async (query: string) => {
		exaCalls.push(query);
		return { answer: `exa:${query}`, results: [] };
	},
}));

vi.mock("../../packages/web-access/gemini-api.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../packages/web-access/gemini-api.js")>();
	return {
		...original,
		// Deterministic regardless of the developer's GEMINI_API_KEY: tests opt
		// in to a fake key only when they must observe a Gemini API attempt.
		getApiKey: () => geminiApiKey || null,
		isGeminiApiAvailable: () => !!geminiApiKey,
	};
});

vi.mock("../../packages/web-access/gemini-web.js", () => ({
	isGeminiWebAvailable: async () => null,
	queryWithCookies: async () => {
		throw new Error("gemini-web should not be reached in these tests");
	},
}));

const { search } = await import("../../packages/web-access/gemini-search.js");

let youcomAvailableFlag = false;
let perplexityAvailableFlag = false;
let geminiApiKey = "";
let perplexityErrorFactory: (() => Promise<never>) | null = null;
let youcomResultFactory: () => { answer: string; results: Array<{ title: string; url: string; snippet: string }> } =
	() => ({ answer: "youcom-answer", results: [] });
beforeEach(() => {
	youcomCalls.length = 0;
	perplexityCalls.length = 0;
	exaCalls.length = 0;
	youcomAvailableFlag = false;
	perplexityAvailableFlag = false;
	geminiApiKey = "";
	perplexityErrorFactory = null;
	youcomResultFactory = () => ({ answer: "youcom-answer", results: [] });
	// Never let a developer's real key open a network path through the chain.
	vi.stubEnv("GEMINI_API_KEY", "");
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe("search() routing with the youcom provider", () => {
	test("explicit provider: 'youcom' routes to searchWithYoucom", async () => {
		youcomAvailableFlag = true;

		const result = await search("explicit youcom selection", { provider: "youcom" });

		assert.equal(result.provider, "youcom");
		assert.deepEqual(youcomCalls, ["explicit youcom selection"]);
		assert.deepEqual(perplexityCalls, [], "perplexity must not be tried for an explicit youcom selection");
		assert.deepEqual(exaCalls, [], "exa must not be tried for an explicit youcom selection");
	});

	test("auto selection prefers youcom when available ahead of the gemini fallbacks", async () => {
		youcomAvailableFlag = true;

		const result = await search("auto selects youcom", { provider: "auto" });

		assert.equal(result.provider, "youcom");
		assert.deepEqual(youcomCalls, ["auto selects youcom"]);
	});

	test("auto selection skips youcom when no key is configured", async () => {
		youcomAvailableFlag = false;
		perplexityAvailableFlag = true;

		const result = await search("auto skips unavailable youcom", { provider: "auto" });

		assert.equal(result.provider, "perplexity");
		assert.deepEqual(youcomCalls, [], "youcom must not be called when it is unavailable");
		assert.deepEqual(perplexityCalls, ["auto skips unavailable youcom"]);
	});

	test("falls back to youcom after a perplexity error under auto selection", async () => {
		// The auto chain is exa → perplexity → youcom → gemini; with perplexity
		// configured but failing, youcom is the next stop.
		youcomAvailableFlag = true;
		perplexityAvailableFlag = true;
		perplexityErrorFactory = async () => {
			throw new Error("Perplexity API error 429: rate limited");
		};

		const result = await search("fallback to youcom after perplexity error", { provider: "auto" });

		assert.equal(result.provider, "youcom");
		assert.deepEqual(
			perplexityCalls,
			["fallback to youcom after perplexity error"],
			"perplexity should have been attempted first",
		);
		assert.deepEqual(youcomCalls, ["fallback to youcom after perplexity error"], "youcom should catch the fallback");
	});

	test("auto selection aggregates a youcom error into the chain failure message", async () => {
		// youcom is the last non-gemini stop in the chain; when everything above
		// it is unavailable and youcom fails, its error must appear in the
		// thrown auto-provider summary rather than being silently dropped.
		youcomAvailableFlag = true;
		youcomResultFactory = () => {
			throw new Error("You.com API error 503: upstream unavailable");
		};

		await assert.rejects(
			() => search("youcom last in chain and failing", { provider: "auto" }),
			/You.com: You.com API error 503/,
		);
		assert.deepEqual(youcomCalls, ["youcom last in chain and failing"]);
	});

	test("a rejected domain filter under auto selection propagates unchanged and stops the chain", async () => {
		// A caller's domain restriction rejected by You.com validation must
		// never be silently broadened by falling back to a provider that
		// ignores domainFilter. Arm Gemini after youcom so any continuation
		// past the validation error is observable as a fetch call.
		youcomAvailableFlag = true;
		geminiApiKey = "fake-gemini-key";
		const fetchCalls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL) => {
				fetchCalls.push(String(url));
				return new Response(JSON.stringify({}), { status: 200 });
			}),
		);
		const message =
			'Invalid domainFilter entry "not a host!": expected a hostname like example.com (prefix with - to exclude)';
		const validationError = new Error(message);
		validationError.name = "DomainFilterValidationError";
		youcomResultFactory = () => {
			throw validationError;
		};

		let caught: unknown;
		try {
			await search("rejected domain filter", { provider: "auto", domainFilter: ["not a host!"] });
		} catch (err) {
			caught = err;
		}

		assert.equal(caught, validationError, "the exact validation error must propagate");
		assert.ok(caught instanceof Error);
		assert.equal(caught.name, "DomainFilterValidationError", "the error name must be preserved");
		assert.equal(caught.message, message, "the message must be intact");
		assert.ok(
			!caught.message.includes("Auto provider search failed"),
			"the validation error must not be aggregated into the auto-provider failure summary",
		);
		assert.deepEqual(youcomCalls, ["rejected domain filter"]);
		assert.deepEqual(fetchCalls, [], "no Gemini API request may follow the rejected domain filter");
	});

	test("explicit youcom selection surfaces the provider error instead of falling through", async () => {
		youcomAvailableFlag = true;
		perplexityAvailableFlag = true;
		youcomResultFactory = () => {
			throw new Error("You.com API error 403: missing scopes");
		};

		await assert.rejects(() => search("explicit youcom failure", { provider: "youcom" }), /You.com API error 403/);
		assert.deepEqual(youcomCalls, ["explicit youcom failure"]);
		assert.deepEqual(perplexityCalls, [], "an explicit provider failure must not fall through to another provider");
	});

	test("cancellation during a youcom search does not fall through to another provider", async () => {
		// Perplexity sits before youcom in the auto chain, so asserting on
		// perplexityCalls alone proves nothing about fall-through. Instead,
		// arm the provider *after* youcom: give Gemini API a fake key and a
		// recording fetch, so any continuation past youcom is observable.
		youcomAvailableFlag = true;
		perplexityAvailableFlag = false;
		geminiApiKey = "fake-gemini-key";
		const fetchCalls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL) => {
				fetchCalls.push(String(url));
				return new Response(JSON.stringify({}), { status: 200 });
			}),
		);
		const controller = new AbortController();
		controller.abort();
		youcomResultFactory = () => {
			const err = new Error("This operation was aborted");
			err.name = "AbortError";
			throw err;
		};

		let caught: unknown;
		try {
			await search("cancelled youcom search", { provider: "auto", signal: controller.signal });
		} catch (err) {
			caught = err;
		}

		assert.ok(caught instanceof Error, "the search must reject");
		assert.equal(caught.name, "AbortError", "the original abort error must propagate unchanged");
		assert.ok(
			!caught.message.includes("Auto provider search failed"),
			"the abort must not be aggregated into the auto-provider failure summary",
		);
		assert.deepEqual(youcomCalls, ["cancelled youcom search"]);
		assert.deepEqual(fetchCalls, [], "no Gemini API request may follow the aborted youcom search");
	});
});
