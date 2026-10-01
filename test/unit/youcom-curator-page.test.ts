import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { generateCuratorPage } from "../../packages/web-access/curator-page.js";
import { CURATOR_PAGE_SCRIPT_1 } from "../../packages/web-access/curator-page-assets/script-1.js";
import { CURATOR_PAGE_STYLES_2 } from "../../packages/web-access/curator-page-assets/styles-2.js";

/**
 * The curator page's inline client script keeps its own provider list; a
 * provider the server renders a button for but the client script does not
 * know is inert (normalizeProvider drops it and a youcom defaultProvider
 * resets to exa). These tests pin server markup and client script together.
 */

function renderPage(availableYoucom: boolean, defaultProvider = "exa"): string {
	return generateCuratorPage(
		["example query"],
		"token",
		120,
		{ perplexity: true, exa: true, gemini: true, youcom: availableYoucom },
		defaultProvider,
		[],
		null,
	);
}

describe("curator page youcom support", () => {
	test("renders a You.com provider button when youcom is available", () => {
		const html = renderPage(true);
		assert.match(html, /data-provider="youcom"[^>]*>You\.com<\/button>/);
	});

	test("omits the You.com button when youcom is unavailable", () => {
		const html = renderPage(false);
		assert.doesNotMatch(html, /data-provider="youcom"/);
	});

	test("client script's providers list includes youcom so the button is live", () => {
		assert.match(CURATOR_PAGE_SCRIPT_1, /var providers = \["perplexity", "exa", "gemini", "youcom"\];/);
	});

	test("client script labels youcom as You.com", () => {
		assert.match(CURATOR_PAGE_SCRIPT_1, /if \(provider === "youcom"\) return "You\.com";/);
	});

	test("styles define a provider-youcom tag alongside the other provider tags", () => {
		assert.match(CURATOR_PAGE_STYLES_2, /\.provider-tag\.provider-youcom \{/);
	});

	test("a youcom defaultProvider survives into the page and the client provider list", () => {
		const html = renderPage(true, "youcom");
		// Server side: the button is marked default; client side: the inline
		// script's providers list contains youcom, so normalizeProvider keeps it.
		assert.match(html, /class="provider-btn[^"]*is-default[^"]*"[^>]*data-provider="youcom"/);
		assert.ok(html.includes('var providers = ["perplexity", "exa", "gemini", "youcom"];'));
	});
});
