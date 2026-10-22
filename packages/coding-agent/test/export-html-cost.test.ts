import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, it } from "vitest";

type ExportStats = {
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
};

function assertClose(actual: number | undefined, expected: number): void {
	assert.ok(
		actual !== undefined && Math.abs(actual - expected) < 1e-9,
		`expected ${actual} to be close to ${expected}`,
	);
}

describe("export HTML cost", () => {
	it("uses recorded totals while falling back to component sums for old sessions (pi #9980)", () => {
		const templateJs = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf-8");
		const functionStart = templateJs.indexOf("function computeStats(entryList)");
		const functionEnd = templateJs.indexOf("const globalStats = computeStats(entries);");
		assert.ok(functionStart >= 0);
		assert.ok(functionEnd > functionStart);

		const context: { result?: ExportStats } = {};
		runInNewContext(
			`${templateJs.slice(functionStart, functionEnd)}
			result = computeStats(${JSON.stringify([
				{
					type: "message",
					message: {
						role: "assistant",
						content: [],
						usage: { cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.9 } },
					},
				},
				{
					type: "message",
					message: {
						role: "assistant",
						content: [],
						usage: { cost: { input: 0.4, output: 0.1, cacheRead: 0, cacheWrite: 0 } },
					},
				},
			])});`,
			context,
		);

		assertClose(context.result?.cost.input, 0.5);
		assertClose(context.result?.cost.output, 0.3);
		assertClose(context.result?.cost.total, 1.4);
	});
});
