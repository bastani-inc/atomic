import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { buildWidgetLines, renderSubagentResult } from "../../packages/subagents/src/tui/render.js";
import {
	type AgentToolResult,
	type AsyncJobState,
	type Details,
	theme,
	withMockedNow,
} from "./subagents-render-stability-helpers.js";

describe("subagent fast-mode UI labels (issue #1153)", () => {
	test("foreground compact result renders fast after thinking", () => {
		const result: AgentToolResult<Details> = {
			content: [{ type: "text", text: "done" }],
			details: {
				mode: "single",
				results: [
					{
						agent: "worker",
						task: "do work",
						status: "ok",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							cost: 0,
							turns: 0,
						},
						model: "openai/gpt-5.1-codex",
						thinking: "medium",
						fastMode: true,
						finalOutput: "done",
					},
				],
			},
		};

		const text = renderSubagentResult(result, { expanded: false }, theme).render(120).join("\n");

		assert.match(text, /gpt-5\.1-codex · thinking medium · fast/);
		const expanded = renderSubagentResult(result, { expanded: true }, theme).render(120).join("\n");
		assert.match(expanded, /gpt-5\.1-codex · thinking medium · fast/);
		assert.equal(expanded.match(/gpt-5\.1-codex/g)?.length, 1);
	});

	test("foreground result omits fast when metadata is missing", () => {
		const result: AgentToolResult<Details> = {
			content: [{ type: "text", text: "done" }],
			details: {
				mode: "single",
				results: [
					{
						agent: "worker",
						task: "do work",
						status: "ok",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							cost: 0,
							turns: 0,
						},
						model: "openai/gpt-5.1-codex:medium",
						finalOutput: "done",
					},
				],
			},
		};

		const text = renderSubagentResult(result, { expanded: false }, theme).render(120).join("\n");

		assert.match(text, /gpt-5\.1-codex · thinking medium/);
		assert.doesNotMatch(text, / · fast/);
	});

	test("async widget step renders fast after thinking", () => {
		const job: AsyncJobState = {
			asyncId: "fast-run",
			asyncDir: "/tmp/fast-run",
			status: "running",
			mode: "single",
			agents: ["worker"],
			updatedAt: 10_000,
			steps: [
				{
					index: 0,
					agent: "worker",
					status: "running",
					model: "openai/gpt-5.1-codex",
					thinking: "medium",
					fastMode: true,
				},
			],
		};

		const text = withMockedNow(10_000, () => buildWidgetLines([job], theme, 120).join("\n"));

		assert.match(text, /gpt-5\.1-codex · thinking medium · fast/);
	});

	test("running multi-result rows render thinking and fast metadata", () => {
		const result: AgentToolResult<Details> = {
			content: [{ type: "text", text: "running" }],
			details: {
				mode: "parallel",
				results: [],
				progress: [
					{
						index: 0,
						agent: "worker",
						status: "running",
						task: "do work",
						model: "openai/gpt-5.1-codex",
						thinking: "high",
						fastMode: true,
						recentTools: [],
						recentOutput: [],
						toolCount: 0,
						tokens: 0,
						durationMs: 0,
					},
					{
						index: 1,
						agent: "reviewer",
						status: "running",
						task: "review work",
						model: "anthropic/claude-sonnet-4",
						thinking: "low",
						recentTools: [],
						recentOutput: [],
						toolCount: 0,
						tokens: 0,
						durationMs: 0,
					},
				],
			},
		};

		const text = renderSubagentResult(result, { expanded: false }, theme).render(120).join("\n");
		assert.match(text, /gpt-5\.1-codex · thinking high · fast/);
		assert.match(text, /claude-sonnet-4 · thinking low/);
		assert.doesNotMatch(text, /claude-sonnet-4 · thinking low · fast/);
	});
});
