/**
 * Top-level PARALLEL rendering must be byte-identical to its pre-removal
 * behaviour. Removing the sequential execution mode deleted the workflow-graph
 * snapshot that fed two renderer predicates, and a reduction that replaces
 * those predicates with newly-derived ones silently changes what a parallel run
 * displays. These tests pin the two places that regressed.
 *
 * Historical behaviour both cases reproduce:
 *   - `renderSubagentResult` derived `failed`/`paused` only from the workflow
 *     graph, which a top-level parallel run never populated. A parallel run with
 *     one errored child therefore read `failed`, never `paused`.
 *   - `widgetStats` gated running/done counts on `activeParallelGroup` — an
 *     active-state signal — not on the run's mode. A launched-but-not-yet-running
 *     parallel job therefore read `steps N`.
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

function renderParallel(results: Details["results"]): string {
	const result: AgentToolResult<Details> = {
		content: [{ type: "text", text: "done" }],
		details: { mode: "parallel", results, totalSteps: results.length },
	};
	return renderSubagentResult(result, { expanded: true }, theme).render(120).join("\n");
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
