import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, it } from "vitest";
import { formatTokenCount } from "../src/utils/token-count.ts";

function exportedTokenFormatter(): (count: number) => string {
	const templateJs = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf-8");
	const start = templateJs.indexOf("function formatTokens(count) {");
	const end = templateJs.indexOf("\n      }\n", start);
	assert.ok(start >= 0 && end > start);
	const context: { formatTokens?: (count: number) => string } = {};
	runInNewContext(`${templateJs.slice(start, end + 8)}\nthis.formatTokens = formatTokens;`, context);
	assert.ok(context.formatTokens);
	return context.formatTokens;
}

describe("export HTML token counts", () => {
	it("write every count as the terminal does", () => {
		const formatTokens = exportedTokenFormatter();
		const counts = [0, 999, 1_000, 1_150, 99_949, 99_950, 999_949, 999_950, 1_000_000, 9_999_999, 1_000_000_000];
		for (const count of [...counts, 999_950_000_000, Number.MAX_SAFE_INTEGER, 999.5, -1, Number.NaN])
			assert.equal(formatTokens(count), formatTokenCount(count), `token count ${count}`);
		const fromJavaScript: (number | string)[] = ["1500", "x"];
		for (const count of fromJavaScript)
			assert.equal(formatTokens(count as number), formatTokenCount(count as number), `token count ${count}`);
		for (let count = 0; count < 2_000_000; count += 97)
			assert.equal(formatTokens(count), formatTokenCount(count), `token count ${count}`);
	});
});
