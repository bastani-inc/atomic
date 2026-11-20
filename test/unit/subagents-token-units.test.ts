import assert from "node:assert/strict";
import { beforeAll, test } from "vitest";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { formatControlNoticeMessage } from "../../packages/subagents/src/runs/shared/subagent-control.js";
import { formatUsage } from "../../packages/subagents/src/shared/formatters.js";
import type { Details } from "../../packages/subagents/src/shared/types.js";
import { renderSubagentResult } from "../../packages/subagents/src/tui/render.js";
import { formatProgressStats } from "../../packages/subagents/src/tui/render-status-progress.js";
import { theme } from "./subagents-render-stability-helpers.js";

beforeAll(() => {
	initTheme("dark");
});

function result(tokens: number, progress: "summary" | "running", agent = "worker"): Details["results"][number] {
	return {
		agent,
		task: "do work",
		status: "ok",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		...(progress === "summary"
			? { progressSummary: { toolCount: 3, tokens, durationMs: 243_000 } }
			: {
					progress: {
						agent,
						index: 0,
						status: "running",
						task: "do work",
						durationMs: 243_000,
						toolCount: 3,
						tokens,
						recentTools: [],
						recentOutput: [],
					},
				}),
	} as Details["results"][number];
}

function header(details: Details): string {
	const rendered = renderSubagentResult({ content: [{ type: "text", text: "" }], details }, { expanded: true }, theme);
	return rendered.render(200)[0] ?? "";
}

test("a subagent result's header writes its tokens with one decimal and the word tokens", () => {
	for (const [tokens, expected] of [
		[999, "999 tokens"],
		[12_345, "12.3k tokens"],
		[1_234_567, "1.2M tokens"],
	] as const) {
		const summary = `| 3 tools, ${expected}, 4m 3s`;
		assert.ok(header({ mode: "single", results: [result(tokens, "summary")] }).includes(summary), summary);
		assert.ok(header({ mode: "single", results: [result(tokens, "running")] }).includes(summary), summary);
	}
	const parallel = header({
		mode: "parallel",
		results: [result(12_345, "summary"), result(12_345, "summary", "other")],
	});
	assert.ok(parallel.includes("| 6 tools, 24.7k tokens, 4m 3s"), parallel);
});

test("subagent progress stats count tokens, one token alone", () => {
	const stats = (tokens: number) => formatProgressStats(theme, { toolCount: 0, tokens, durationMs: 0 }, false);
	assert.equal(stats(1), "1 token");
	assert.equal(stats(999), "999 tokens");
	assert.equal(stats(12_345), "12.3k tokens");
	assert.equal(stats(999_950), "1.0M tokens");
});

test("a subagent's usage line writes each token count with one decimal", () => {
	assert.equal(
		formatUsage({ input: 12_345, output: 1_234_567, cacheRead: 999_950, cacheWrite: 999, cost: 0, turns: 2 }),
		"2 turns in:12.3k out:1.2M R1.0M W999",
	);
});

test("a long-running subagent notice gives the model the exact token count", () => {
	const message = formatControlNoticeMessage({
		type: "active_long_running",
		to: "active_long_running",
		ts: 0,
		agent: "worker",
		runId: "run-1",
		message: "still working",
		turns: 12,
		tokens: 123_456,
		toolCount: 41,
	});
	assert.match(message, /Facts: 12 turns \| 123456 tokens \| 41 tools/);
});
