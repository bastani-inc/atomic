import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { Usage } from "@earendil-works/pi-ai/compat";
import { emptyUsage } from "../../packages/coding-agent/src/core/transitive-usage.ts";
import { getUsageLine } from "../../packages/coding-agent/src/modes/interactive/components/footer.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";

initTheme("dark", false);

function usage(input: number, cost: number): Usage {
	return {
		input,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("footer transitive cost rendering", () => {
	test("transitive totals render incomplete cost with ~ prefix and include descendant tokens in badges; context percent stays self-only", () => {
		const selfUsage = usage(12, 1);
		const transitive = {
			self: selfUsage,
			descendants: usage(1_000, 2.5),
			total: usage(1_012, 3.5),
			complete: false,
			breakdown: [],
		};
		const session = {
			state: { model: { contextWindow: 100 } },
			modelRegistry: { isUsingOAuth: () => false },
			sessionManager: {
				getEntries: () => [{ type: "message", message: { role: "assistant", usage: selfUsage } }],
			},
			getContextUsage: () => ({ tokens: 12, contextWindow: 100, percent: 12 }),
			getTransitiveUsage: () => transitive,
		};
		const rendered = stripAnsi(getUsageLine(session as never, false, 120));
		assert.match(rendered, /↑1\.0k/);
		assert.match(rendered, /~\$3\.500/);
		assert.match(rendered, /12\.0%\/100/);
		assert.doesNotMatch(rendered, /1012%/);
	});

	test("zero-cost incomplete totals render an approximate dollar segment", () => {
		const session = {
			state: { model: { contextWindow: 200 } },
			modelRegistry: { isUsingOAuth: () => false },
			sessionManager: { getEntries: () => [] },
			getContextUsage: () => ({ tokens: 0, contextWindow: 200, percent: 0 }),
			getTransitiveUsage: () => ({ self: emptyUsage(), descendants: emptyUsage(), total: emptyUsage(), complete: false, breakdown: [] }),
		};
		const rendered = stripAnsi(getUsageLine(session as never, false, 120));
		assert.match(rendered, /~\$0\.000/);
		assert.match(rendered, /0\.0%\/200/);
	});

	test("zero-priced token usage still renders an explicit dollar segment", () => {
		const tokensOnly = usage(25, 0);
		const session = {
			state: { model: { contextWindow: 200 } },
			modelRegistry: { isUsingOAuth: () => false },
			sessionManager: { getEntries: () => [] },
			getContextUsage: () => ({ tokens: 25, contextWindow: 200, percent: 12.5 }),
			getTransitiveUsage: () => ({ self: emptyUsage(), descendants: tokensOnly, total: tokensOnly, complete: false, breakdown: [] }),
		};
		const rendered = stripAnsi(getUsageLine(session as never, false, 120));
		assert.match(rendered, /~\$0\.000/);
	});

	test("descendant tokens and cost appear in badges even when self usage is zero", () => {
		const session = {
			state: { model: { contextWindow: 200 } },
			modelRegistry: { isUsingOAuth: () => false },
			sessionManager: { getEntries: () => [] },
			getContextUsage: () => ({ tokens: 50, contextWindow: 200, percent: 25 }),
			getTransitiveUsage: () => ({ self: emptyUsage(), descendants: usage(900, 9), total: usage(900, 9), complete: true, breakdown: [] }),
		};
		const rendered = stripAnsi(getUsageLine(session as never, false, 120));
		assert.match(rendered, /\$9\.000/);
		assert.match(rendered, /25\.0%\/200/);
		assert.match(rendered, /↑900/);
	});
});
