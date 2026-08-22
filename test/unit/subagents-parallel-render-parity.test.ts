/**
 * Top-level PARALLEL rendering preserves result status labels and per-child
 * model/thinking metadata across the foreground rendering paths. These tests
 * cover errored, interrupted, and detached child statuses plus result rows.
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { renderSubagentResult } from "../../packages/subagents/src/tui/render.js";
import { type AgentToolResult, type Details, theme } from "./subagents-render-stability-helpers.js";

function parallelChild(
	agent: string,
	status: "ok" | "error" | "interrupted" | "continued" | "skipped",
	extra: {
		interrupted?: boolean;
		detached?: boolean;
		model?: string;
		thinking?: string;
		fastMode?: boolean;
	} = {},
): Details["results"][number] {
	return {
		agent,
		task: `task for ${agent}`,
		status,
		finalOutput: `output from ${agent}`,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		...extra,
	} as Details["results"][number];
}

function renderParallel(
	results: Details["results"],
	options: { parentAskPaused?: boolean; expanded?: boolean; content?: string } = {},
): string {
	const result: AgentToolResult<Details> = {
		content: [{ type: "text", text: options.content ?? "done" }],
		details: {
			mode: "parallel",
			results,
			totalSteps: results.length,
			parentAskPaused: options.parentAskPaused,
		},
	};
	return renderSubagentResult(result, { expanded: options.expanded ?? true }, theme)
		.render(120)
		.join("\n");
}

describe("top-level parallel status reduction", () => {
	test("one errored child reads failed, never paused", () => {
		const rendered = renderParallel([parallelChild("alpha", "ok"), parallelChild("beta", "error")]);
		assert.match(rendered, /failed parallel · 1\/2 done/);
		assert.doesNotMatch(rendered, /paused parallel/);
	});

	test("an interrupted child reads failed, never paused", () => {
		const rendered = renderParallel([
			parallelChild("alpha", "ok"),
			parallelChild("beta", "interrupted", { interrupted: true }),
		]);
		assert.match(rendered, /failed parallel · 1\/2 done/);
		assert.doesNotMatch(rendered, /paused parallel/);
	});

	test("a detached child reads failed, never paused", () => {
		const rendered = renderParallel([
			parallelChild("alpha", "ok"),
			parallelChild("beta", "continued", { detached: true }),
		]);
		assert.match(rendered, /failed parallel · 1\/2 done/);
		assert.doesNotMatch(rendered, /paused parallel/);
	});

	test("a parent-ask interruption reads paused and shows the resume prompt", () => {
		const content = [
			"Subagent paused for parent input (beta, child 2).",
			"Run: exact-run",
			"Question:",
			"Keep  this question verbatim?",
			'Resume with: subagent({ action: "resume", id: "exact-run", message: "<answer>" })',
		].join("\n");
		const children = [
			parallelChild("alpha", "interrupted", { interrupted: true }),
			parallelChild("beta", "interrupted", { interrupted: true }),
			parallelChild("queued", "skipped"),
		];
		for (const expanded of [false, true]) {
			const rendered = renderParallel(children, { parentAskPaused: true, expanded, content });
			assert.match(rendered, expanded ? /paused parallel/ : /■ parallel/);
			assert.match(rendered, /Keep {2}this question verbatim\?/);
			assert.match(rendered, /Resume with: subagent/);
			assert.doesNotMatch(rendered, /failed parallel/);
		}
	});

	test("every child ok still reads ok", () => {
		const rendered = renderParallel([parallelChild("alpha", "ok"), parallelChild("beta", "ok")]);
		assert.match(rendered, /ok parallel · 2\/2 done/);
	});
});

test("parallel result rows keep each child's model and thinking metadata", () => {
	const rendered = renderParallel([
		parallelChild("alpha", "ok", {
			model: "openai/gpt-5.1-codex",
			thinking: "high",
			fastMode: true,
		}),
		parallelChild("beta", "ok", {
			model: "anthropic/claude-sonnet-4",
			thinking: "low",
		}),
	]);
	assert.match(rendered, /alpha.*gpt-5\.1-codex · thinking high · fast/);
	assert.match(rendered, /beta.*claude-sonnet-4 · thinking low/);
	assert.doesNotMatch(rendered, /claude-sonnet-4 · thinking low · fast/);
});
