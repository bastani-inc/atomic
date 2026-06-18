import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import {
	clearActiveCopilotModelCatalog,
	COPILOT_CATALOG_CACHE_TTL_MS,
	COPILOT_CATALOG_HEADERS,
	COPILOT_CONTEXT_WINDOW_FALLBACK,
	copilotApiBaseUrlFromToken,
	fetchCopilotModelCatalog,
	getActiveCopilotModelCatalog,
	parseCopilotModelCatalog,
	readCopilotCatalogCache,
	resolveCopilotModelContext,
	setActiveCopilotModelCatalog,
	writeCopilotCatalogCache,
} from "../src/core/copilot-model-catalog.ts";

// Minimal CAPI /models fixture mirroring the live shape. Every window is INPUT (prompt) tokens:
//   gpt-5.5 / claude  -> tiered (default + long_context), different default budgets
//   gpt-5.3-codex     -> default tier only, no long_context (single window)
//   gpt-4o            -> no tiered pricing; window comes from max_prompt_tokens
//   mystery-model     -> no max_prompt_tokens; window falls back to max_context_window_tokens
//   bare-model        -> no usable limit signal at all (skipped)
function capiBody() {
	return {
		data: [
			{
				id: "gpt-5.5",
				capabilities: { limits: { max_output_tokens: 128_000, max_prompt_tokens: 922_000, max_context_window_tokens: 1_050_000 } },
				billing: { token_prices: { default: { context_max: 272_000 }, long_context: { context_max: 922_000 } } },
			},
			{
				id: "claude-opus-4.8",
				capabilities: { limits: { max_output_tokens: 64_000, max_prompt_tokens: 936_000, max_context_window_tokens: 1_000_000 } },
				billing: { token_prices: { default: { context_max: 200_000 }, long_context: { context_max: 936_000 } } },
			},
			{
				id: "gpt-5.3-codex",
				capabilities: { limits: { max_output_tokens: 128_000, max_prompt_tokens: 272_000, max_context_window_tokens: 400_000 } },
				billing: { token_prices: { default: { context_max: 272_000 } } },
			},
			{
				id: "gpt-4o",
				capabilities: { limits: { max_output_tokens: 16_384, max_prompt_tokens: 64_000, max_context_window_tokens: 128_000 } },
				billing: {},
			},
			{
				id: "mystery-model",
				capabilities: { limits: { max_output_tokens: 16_384, max_context_window_tokens: 256_000 } },
			},
			{ id: "bare-model", capabilities: { limits: {} }, billing: {} },
		],
	};
}

describe("resolveCopilotModelContext", () => {
	test("uses the default tier as the base and adds a larger long_context window", () => {
		assert.deepEqual(resolveCopilotModelContext({ maxPromptTokens: 922_000, defaultContextMax: 272_000, longContextMax: 922_000 }), {
			contextWindow: 272_000,
			contextWindowOptions: [272_000, 922_000],
		});
	});

	test("omits options when there is no larger long_context tier", () => {
		assert.deepEqual(resolveCopilotModelContext({ maxPromptTokens: 272_000, defaultContextMax: 272_000 }), { contextWindow: 272_000 });
		// long_context not larger than default -> single window
		assert.deepEqual(resolveCopilotModelContext({ defaultContextMax: 272_000, longContextMax: 272_000 }), { contextWindow: 272_000 });
	});

	test("scalar formula: max_prompt_tokens || max_context_window_tokens || 128_000", () => {
		assert.deepEqual(resolveCopilotModelContext({ maxPromptTokens: 922_000, maxContextWindowTokens: 1_050_000 }), { contextWindow: 922_000 });
		assert.deepEqual(resolveCopilotModelContext({ maxContextWindowTokens: 256_000 }), { contextWindow: 256_000 });
		// 128_000 safety only kicks in when nothing else is advertised
		assert.deepEqual(resolveCopilotModelContext({ longContextMax: 500_000 }), {
			contextWindow: COPILOT_CONTEXT_WINDOW_FALLBACK,
			contextWindowOptions: [COPILOT_CONTEXT_WINDOW_FALLBACK, 500_000],
		});
	});

	test("returns undefined without any limit signal", () => {
		assert.equal(resolveCopilotModelContext({}), undefined);
	});
});

describe("parseCopilotModelCatalog", () => {
	test("includes every model with a usable input budget", () => {
		const catalog = parseCopilotModelCatalog(capiBody());
		assert.deepEqual([...catalog.keys()].sort(), ["claude-opus-4.8", "gpt-4o", "gpt-5.3-codex", "gpt-5.5", "mystery-model"]);
	});

	test("resolves input-token windows per model", () => {
		const catalog = parseCopilotModelCatalog(capiBody());
		assert.deepEqual(catalog.get("gpt-5.5"), { contextWindow: 272_000, contextWindowOptions: [272_000, 922_000] });
		assert.deepEqual(catalog.get("claude-opus-4.8"), { contextWindow: 200_000, contextWindowOptions: [200_000, 936_000] });
		assert.deepEqual(catalog.get("gpt-5.3-codex"), { contextWindow: 272_000 });
		assert.deepEqual(catalog.get("gpt-4o"), { contextWindow: 64_000 });
		assert.deepEqual(catalog.get("mystery-model"), { contextWindow: 256_000 });
	});

	test("tolerates malformed bodies", () => {
		assert.equal(parseCopilotModelCatalog(undefined).size, 0);
		assert.equal(parseCopilotModelCatalog({}).size, 0);
		assert.equal(parseCopilotModelCatalog({ data: "nope" }).size, 0);
		assert.equal(parseCopilotModelCatalog({ data: [null, { id: 5 }, {}] }).size, 0);
	});
});

describe("copilotApiBaseUrlFromToken", () => {
	test("derives the api host from the token proxy-ep", () => {
		assert.equal(
			copilotApiBaseUrlFromToken("tid=abc;exp=1;proxy-ep=proxy.individual.githubcopilot.com;more=1"),
			"https://api.individual.githubcopilot.com",
		);
	});

	test("falls back to enterprise host then the individual default", () => {
		assert.equal(copilotApiBaseUrlFromToken(undefined, "company.ghe.com"), "https://copilot-api.company.ghe.com");
		assert.equal(copilotApiBaseUrlFromToken("no-proxy-here"), "https://api.individual.githubcopilot.com");
	});
});

describe("fetchCopilotModelCatalog", () => {
	test("requests /models with bearer + copilot headers and parses the body", async () => {
		let capturedUrl = "";
		let capturedHeaders: Record<string, string> = {};
		const catalog = await fetchCopilotModelCatalog({
			token: "tid=abc;proxy-ep=proxy.individual.githubcopilot.com",
			fetchImpl: (async (url: string, init?: RequestInit) => {
				capturedUrl = String(url);
				capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
				return new Response(JSON.stringify(capiBody()), { status: 200 });
			}) as typeof fetch,
		});
		assert.equal(capturedUrl, "https://api.individual.githubcopilot.com/models");
		assert.equal(capturedHeaders.Authorization, "Bearer tid=abc;proxy-ep=proxy.individual.githubcopilot.com");
		assert.equal(capturedHeaders["X-GitHub-Api-Version"], COPILOT_CATALOG_HEADERS["X-GitHub-Api-Version"]);
		assert.equal(capturedHeaders["Copilot-Integration-Id"], "vscode-chat");
		assert.deepEqual(catalog.get("gpt-5.5"), { contextWindow: 272_000, contextWindowOptions: [272_000, 922_000] });
	});

	test("throws on a non-ok response", async () => {
		await assert.rejects(
			fetchCopilotModelCatalog({
				token: "t",
				baseUrl: "https://api.individual.githubcopilot.com",
				fetchImpl: (async () => new Response("nope", { status: 401, statusText: "Unauthorized" })) as typeof fetch,
			}),
			/401 Unauthorized/,
		);
	});
});

describe("active catalog overlay", () => {
	afterEach(() => clearActiveCopilotModelCatalog());

	test("set/get/clear round-trips", () => {
		assert.equal(getActiveCopilotModelCatalog().size, 0);
		setActiveCopilotModelCatalog(parseCopilotModelCatalog(capiBody()));
		assert.equal(getActiveCopilotModelCatalog().size, 5);
		clearActiveCopilotModelCatalog();
		assert.equal(getActiveCopilotModelCatalog().size, 0);
	});
});

describe("disk cache", () => {
	let dir: string;
	let path: string;
	const host = "api.individual.githubcopilot.com";
	const baseUrl = `https://${host}`;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "copilot-catalog-cache-"));
		path = join(dir, "nested", "copilot-models.json");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	test("round-trips a fresh catalog (creating parent dirs)", () => {
		const catalog = parseCopilotModelCatalog(capiBody());
		writeCopilotCatalogCache(path, baseUrl, catalog, 1_000);
		const read = readCopilotCatalogCache(path, { host, now: 1_000 + COPILOT_CATALOG_CACHE_TTL_MS - 1 });
		assert.deepEqual(read?.get("gpt-5.5"), { contextWindow: 272_000, contextWindowOptions: [272_000, 922_000] });
		assert.deepEqual(read?.get("gpt-5.3-codex"), { contextWindow: 272_000 });
		assert.deepEqual(read?.get("mystery-model"), { contextWindow: 256_000 });
	});

	test("ignores a stale catalog", () => {
		writeCopilotCatalogCache(path, baseUrl, parseCopilotModelCatalog(capiBody()), 1_000);
		const read = readCopilotCatalogCache(path, { host, now: 1_000 + COPILOT_CATALOG_CACHE_TTL_MS });
		assert.equal(read, undefined);
	});

	test("ignores a catalog cached for a different host", () => {
		writeCopilotCatalogCache(path, baseUrl, parseCopilotModelCatalog(capiBody()), 1_000);
		const read = readCopilotCatalogCache(path, { host: "copilot-api.company.ghe.com", now: 1_000 });
		assert.equal(read, undefined);
	});

	test("returns undefined for a missing or corrupt file", () => {
		assert.equal(readCopilotCatalogCache(join(dir, "missing.json"), { host, now: 0 }), undefined);
		writeFileSync(path.replace("nested/", ""), "{not json");
		assert.equal(readCopilotCatalogCache(path.replace("nested/", ""), { host, now: 0 }), undefined);
	});
});
