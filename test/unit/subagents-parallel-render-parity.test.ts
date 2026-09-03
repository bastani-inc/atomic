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
		cause?: string;
		model?: string;
		thinking?: string;
		progressIndex?: number;
	} = {},
): Details["results"][number] {
	const result = {
		agent,
		task: `task for ${agent}`,
		status,
		finalOutput: `output from ${agent}`,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		...extra,
	} as Details["results"][number];
	if (extra.progressIndex !== undefined) {
		result.progress = {
			index: extra.progressIndex,
			agent,
			status: "completed",
			task: result.task,
			durationMs: 1,
			toolCount: 0,
			tokens: 0,
			recentTools: [],
			recentOutput: [],
		};
	}
	return result;
}

function renderParallel(
	results: Details["results"],
	options: { parentAskYielded?: boolean; expanded?: boolean; content?: string } = {},
): string {
	const result: AgentToolResult<Details> = {
		content: [{ type: "text", text: options.content ?? "done" }],
		details: {
			mode: "parallel",
			results,
			totalSteps: results.length,
			parentAskYielded: options.parentAskYielded,
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

	test("a parent-cancelled child reads cancelled, never failed", () => {
		const rendered = renderParallel([
			parallelChild("alpha", "ok"),
			parallelChild("beta", "interrupted", { interrupted: true, cause: "abort" }),
		]);
		assert.match(rendered, /cancelled/);
		assert.doesNotMatch(rendered, /failed/);
		assert.doesNotMatch(rendered, /✓/);
	});

	test("a detached child reads failed, never paused", () => {
		const rendered = renderParallel([
			parallelChild("alpha", "ok"),
			parallelChild("beta", "continued", { detached: true }),
		]);
		assert.match(rendered, /failed parallel · 1\/2 done/);
		assert.doesNotMatch(rendered, /paused parallel/);
	});

	test("a parent-ask interruption reads yielded and shows the fresh-start handoff", () => {
		const content = [
			"Subagent yielded for parent input (beta, child 2).",
			"Previous run (terminal): exact-run",
			"Question:",
			"Keep  this question verbatim?",
			"Start a fresh subagent with a new run identity:",
			'subagent({ "agent": "beta", "task": "[TASK_CONTEXT] Continue with this supervisor answer: <SUPERVISOR_ANSWER>" })',
		].join("\n");
		const children = [
			parallelChild("alpha", "interrupted", { interrupted: true }),
			parallelChild("beta", "interrupted", { interrupted: true }),
			parallelChild("queued", "skipped"),
		];
		for (const expanded of [false, true]) {
			const rendered = renderParallel(children, { parentAskYielded: true, expanded, content });
			assert.match(rendered, expanded ? /yielded parallel/ : /■ parallel/);
			assert.match(rendered, /Keep {2}this question verbatim\?/);
			assert.match(rendered, /Start a fresh subagent/);
			assert.doesNotMatch(rendered, /action.*resume/i);
			assert.doesNotMatch(rendered, /failed parallel/);
		}
	});

	test("every child ok still reads ok", () => {
		const rendered = renderParallel([parallelChild("alpha", "ok"), parallelChild("beta", "ok")]);
		assert.match(rendered, /ok parallel · 2\/2 done/);
	});

	test("children with canonical indexes render 2/2 and distinct rows", () => {
		const rendered = renderParallel([
			parallelChild("alpha", "ok", { progressIndex: 0 }),
			parallelChild("beta", "ok", { progressIndex: 1 }),
		]);
		assert.match(rendered, /ok parallel · 2\/2 done/);
		assert.match(rendered, /Agent 1\/2: alpha/);
		assert.match(rendered, /Agent 2\/2: beta/);
		assert.equal(rendered.match(/Agent 1\/2:/g)?.length, 1);
	});
});

test("parallel result rows keep each child's canonical model ID and thinking metadata", () => {
	const rendered = renderParallel([
		parallelChild("alpha", "ok", {
			model: "openai-codex/gpt-5.6-sol-fast",
			thinking: "high",
		}),
		parallelChild("beta", "ok", {
			model: "anthropic/claude-sonnet-4",
			thinking: "low",
		}),
	]);
	assert.match(rendered, /alpha.*openai-codex\/gpt-5\.6-sol-fast · thinking high/);
	assert.match(rendered, /beta.*claude-sonnet-4 · thinking low/);
	assert.doesNotMatch(rendered, / · fast(?: ·|\))/u);
});
