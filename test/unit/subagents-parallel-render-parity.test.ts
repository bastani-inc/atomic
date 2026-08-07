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
import type { AsyncJobState } from "../../packages/subagents/src/shared/types.js";
import { renderSubagentResult } from "../../packages/subagents/src/tui/render.js";
import { widgetStats } from "../../packages/subagents/src/tui/render-event-formatting.js";
import { type AgentToolResult, type Details, theme } from "./subagents-render-stability-helpers.js";

function parallelChild(
	agent: string,
	status: "ok" | "error" | "interrupted" | "continued" | "skipped",
	extra: { interrupted?: boolean; detached?: boolean } = {},
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

describe("async parallel widget stats gate on active state, not mode", () => {
	function job(overrides: Partial<AsyncJobState>): AsyncJobState {
		return {
			asyncId: "run-1",
			asyncDir: "/tmp/run-1",
			status: "running",
			mode: "parallel",
			agents: ["alpha", "beta"],
			stepsTotal: 2,
			startedAt: 0,
			updatedAt: 0,
			...overrides,
		} as AsyncJobState;
	}

	test("a launched parallel job with no active group reads the step total", () => {
		const stats = widgetStats(job({}), theme);
		assert.match(stats, /steps 2/);
		assert.doesNotMatch(stats, /agent running/);
		assert.doesNotMatch(stats, /0\/2 done/);
	});

	test("an active parallel group reads running and done counts", () => {
		const stats = widgetStats(job({ activeParallelGroup: true, runningSteps: 1, completedSteps: 0 }), theme);
		assert.match(stats, /1 agent running/);
		assert.match(stats, /0\/2 done/);
		assert.doesNotMatch(stats, /steps 2/);
	});

	test("a single-agent job is unaffected", () => {
		const stats = widgetStats(job({ mode: "single", agents: ["alpha"], stepsTotal: 1 }), theme);
		assert.doesNotMatch(stats, /steps 1/);
		assert.doesNotMatch(stats, /agent running/);
	});
});
