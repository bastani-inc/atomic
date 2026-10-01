import assert from "node:assert/strict";
import { beforeEach, describe, test, vi } from "vitest";

/**
 * Regression coverage for You.com in the curator/bootstrap provider
 * resolution (`loadCuratorBootstrap` in web-search-config.ts). The shared
 * `search()` auto chain is exa → perplexity → youcom → gemini; the curator
 * default-provider resolution must mirror that ordering rather than skipping
 * youcom whenever it was not requested explicitly. Availability functions are
 * mocked at the module boundary; the provider request path is exercised for
 * real.
 */

const configDir = await vi.hoisted(async () => {
	const { mkdtempSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	return mkdtempSync(join(tmpdir(), "youcom-curator-resolution-test-"));
});

vi.mock("../../packages/web-access/config-paths.js", () => {
	// Isolate resolution from the developer's real machine config: resolve
	// every config path into a temp directory no test writes, so the resolved
	// default provider depends only on the mocked availability flags.
	const isolated = `${configDir}/web-search.json`;
	return {
		WEB_SEARCH_CONFIG_PATHS: [isolated],
		WEB_SEARCH_CONFIG_PATH: isolated,
		EXA_USAGE_PATHS: [`${configDir}/exa-usage.json`],
		EXA_USAGE_PATH: `${configDir}/exa-usage.json`,
		findReadableConfigPath: () => isolated,
	};
});

let exaAvailableFlag = false;
let perplexityAvailableFlag = false;
let youcomAvailableFlag = false;
let geminiApiAvailableFlag = false;

vi.mock("../../packages/web-access/exa.js", () => ({
	hasExaApiKey: () => exaAvailableFlag,
	isExaAvailable: () => exaAvailableFlag,
}));

vi.mock("../../packages/web-access/perplexity.js", () => ({
	isPerplexityAvailable: () => perplexityAvailableFlag,
}));

vi.mock("../../packages/web-access/youcom.js", () => ({
	isYoucomAvailable: () => youcomAvailableFlag,
}));

vi.mock("../../packages/web-access/gemini-api.js", () => ({
	isGeminiApiAvailable: () => geminiApiAvailableFlag,
}));

vi.mock("../../packages/web-access/gemini-web.js", () => ({
	isGeminiWebAvailable: async () => null,
}));

const { loadCuratorBootstrap } = await import("../../packages/web-access/web-search-config.js");

beforeEach(() => {
	exaAvailableFlag = false;
	perplexityAvailableFlag = false;
	youcomAvailableFlag = false;
	geminiApiAvailableFlag = false;
});

describe("curator provider resolution with the youcom provider", () => {
	test("auto resolves to youcom when only youcom is keyed", async () => {
		youcomAvailableFlag = true;

		const bootstrap = await loadCuratorBootstrap("auto");

		assert.equal(bootstrap.defaultProvider, "youcom");
		assert.deepEqual(bootstrap.availableProviders, {
			perplexity: false,
			exa: false,
			gemini: false,
			youcom: true,
		});
	});

	test("auto prefers perplexity over youcom when both are keyed", async () => {
		perplexityAvailableFlag = true;
		youcomAvailableFlag = true;

		const bootstrap = await loadCuratorBootstrap("auto");

		assert.equal(bootstrap.defaultProvider, "perplexity");
	});

	test("requested exa without a key falls back to youcom when only youcom is keyed", async () => {
		youcomAvailableFlag = true;

		const bootstrap = await loadCuratorBootstrap("exa");

		assert.equal(bootstrap.defaultProvider, "youcom");
	});

	test("requested youcom without any key stays youcom for its setup message", async () => {
		const bootstrap = await loadCuratorBootstrap("youcom");

		assert.equal(bootstrap.defaultProvider, "youcom");
	});

	test("requested youcom without a key falls back to exa when exa is keyed", async () => {
		exaAvailableFlag = true;
		geminiApiAvailableFlag = true;

		const bootstrap = await loadCuratorBootstrap("youcom");

		assert.equal(bootstrap.defaultProvider, "exa");
	});

	test("requested youcom without a key falls back to perplexity when only perplexity is keyed", async () => {
		perplexityAvailableFlag = true;

		const bootstrap = await loadCuratorBootstrap("youcom");

		assert.equal(bootstrap.defaultProvider, "perplexity");
	});

	test("requested youcom with a key resolves to youcom", async () => {
		youcomAvailableFlag = true;
		perplexityAvailableFlag = true;
		exaAvailableFlag = true;

		const bootstrap = await loadCuratorBootstrap("youcom");

		assert.equal(bootstrap.defaultProvider, "youcom");
	});
});
