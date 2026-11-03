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
	status: Details["results"][number]["status"],
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
	for (const expanded of [false, true]) {
		for (const withCompletedSibling of [false, true]) {
			test(`${expanded ? "expanded" : "compact"} killed${withCompletedSibling ? " and completed" : "-only"} group is stopped and non-resumable`, () => {
				const children = [parallelChild("alpha", "killed")];
				if (withCompletedSibling) children.push(parallelChild("beta", "ok"));
				const rendered = renderParallel(children, { expanded });
				const header = rendered.split("\n")[0]!;
				assert.match(header, expanded ? /^killed \(non-resumable\) parallel/ : /^■ parallel/);
				assert.match(header, /killed \(non-resumable\)/i);
				assert.match(header, withCompletedSibling ? /1\/2 done/ : /0\/1 done/);
				assert.doesNotMatch(header, /✓|failed|^ok /);
			});
		}
	}

	for (const [status, compact, expanded] of [
		["ok", "✓", "ok"],
		["error", "✗", "failed"],
		["interrupted", "■", "failed"],
		["continued", "■", "failed"],
		["skipped", "■", "failed"],
	] as const) {
		test(`${status} groups retain their compact and expanded summaries`, () => {
			const children = [parallelChild("alpha", status)];
			assert.ok(renderParallel(children, { expanded: false }).startsWith(`${compact} parallel`));
			assert.ok(renderParallel(children).startsWith(`${expanded} parallel`));
		});
	}

	test("killed siblings do not override parent cancellation, failure, running or handoff summaries", () => {
		const killed = parallelChild("alpha", "killed");
		const cancelled = parallelChild("beta", "interrupted", { interrupted: true, cause: "abort" });
		assert.ok(renderParallel([killed, cancelled]).startsWith("cancelled parallel"));
		assert.ok(renderParallel([killed, parallelChild("beta", "error")]).startsWith("failed parallel"));
		assert.ok(renderParallel([killed, parallelChild("beta", "error")], { expanded: false }).startsWith("✗ parallel"));
		const running = parallelChild("beta", "continued", { progressIndex: 1 });
		running.progress!.status = "running";
		assert.ok(renderParallel([killed, running]).startsWith("running parallel"));
		assert.doesNotMatch(renderParallel([killed, running], { expanded: false }).split("\n")[0]!, /■|✓|killed/);
		assert.ok(renderParallel([killed], { parentAskYielded: true }).startsWith("yielded parallel"));
	});

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
	assert.match(rendered, /alpha.*openai-codex\/gpt-5\.6-sol-fast {2}high/);
	assert.match(rendered, /beta.*claude-sonnet-4 {2}low/);
	assert.doesNotMatch(rendered, / · fast(?: ·|\))/u);
});
