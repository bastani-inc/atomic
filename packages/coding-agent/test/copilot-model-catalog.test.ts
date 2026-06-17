import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import {
	clearActiveCopilotModelCatalog,
	COPILOT_CATALOG_CACHE_TTL_MS,
	COPILOT_CATALOG_HEADERS,
	copilotApiBaseUrlFromToken,
	deriveCopilotContextWindows,
	fetchCopilotModelCatalog,
	getActiveCopilotModelCatalog,
	parseCopilotModelCatalog,
	readCopilotCatalogCache,
	setActiveCopilotModelCatalog,
	tierContextWindowTokens,
	writeCopilotCatalogCache,
} from "../src/core/copilot-model-catalog.ts";

// Minimal CAPI /models fixture mirroring the live shape (gpt-5.5 has a long tier, claude has one
// with a different default, gpt-5-mini has no long tier, gpt-4.1 has no tiered pricing at all).
function capiBody() {
	return {
		data: [
			{
				id: "gpt-5.5",
				capabilities: { limits: { max_output_tokens: 128_000, max_prompt_tokens: 922_000 } },
				billing: { token_prices: { default: { context_max: 272_000 }, long_context: { context_max: 922_000 } } },
			},
			{
				id: "claude-opus-4.8",
				capabilities: { limits: { max_output_tokens: 64_000 } },
				billing: { token_prices: { default: { context_max: 200_000 }, long_context: { context_max: 936_000 } } },
			},
			{
				id: "gpt-5-mini",
				capabilities: { limits: { max_output_tokens: 128_000 } },
				billing: { token_prices: { default: { context_max: 272_000 } } },
			},
			{
				id: "gpt-4.1",
				capabilities: { limits: { max_output_tokens: 16_000 } },
				billing: {},
			},
		],
	};
}

describe("parseCopilotModelCatalog", () => {
	test("includes only models with both a default and long_context tier", () => {
		const catalog = parseCopilotModelCatalog(capiBody());
		assert.deepEqual([...catalog.keys()].sort(), ["claude-opus-4.8", "gpt-5.5"]);
	});

	test("captures the raw tier maxima and output tokens", () => {
		const catalog = parseCopilotModelCatalog(capiBody());
		assert.deepEqual(catalog.get("gpt-5.5"), {
			maxOutputTokens: 128_000,
			defaultContextMax: 272_000,
			longContextMax: 922_000,
		});
		assert.deepEqual(catalog.get("claude-opus-4.8"), {
			maxOutputTokens: 64_000,
			defaultContextMax: 200_000,
			longContextMax: 936_000,
		});
	});

	test("tolerates malformed bodies", () => {
		assert.equal(parseCopilotModelCatalog(undefined).size, 0);
		assert.equal(parseCopilotModelCatalog({}).size, 0);
		assert.equal(parseCopilotModelCatalog({ data: "nope" }).size, 0);
		assert.equal(parseCopilotModelCatalog({ data: [null, { id: 5 }, {}] }).size, 0);
	});
});

describe("context-window derivation", () => {
	test("window = context_max + max_output_tokens (input+output, matching the Copilot CLI)", () => {
		assert.equal(tierContextWindowTokens(272_000, 128_000), 400_000);
		assert.equal(tierContextWindowTokens(922_000, 128_000), 1_050_000);
		assert.equal(tierContextWindowTokens(200_000, 64_000), 264_000);
		assert.equal(tierContextWindowTokens(936_000, 64_000), 1_000_000);
	});

	test("derives default/long windows per model", () => {
		const catalog = parseCopilotModelCatalog(capiBody());
		assert.deepEqual(deriveCopilotContextWindows(catalog.get("gpt-5.5")!), {
			defaultWindow: 400_000,
			longWindow: 1_050_000,
		});
		assert.deepEqual(deriveCopilotContextWindows(catalog.get("claude-opus-4.8")!), {
			defaultWindow: 264_000,
			longWindow: 1_000_000,
		});
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
		assert.deepEqual([...catalog.keys()].sort(), ["claude-opus-4.8", "gpt-5.5"]);
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
		assert.equal(getActiveCopilotModelCatalog().size, 2);
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
		assert.deepEqual(read && [...read.keys()].sort(), ["claude-opus-4.8", "gpt-5.5"]);
		assert.deepEqual(read?.get("gpt-5.5"), { maxOutputTokens: 128_000, defaultContextMax: 272_000, longContextMax: 922_000 });
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
