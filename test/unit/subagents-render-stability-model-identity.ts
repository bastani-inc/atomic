import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { renderSubagentResult } from "../../packages/subagents/src/tui/render.js";
import { type AgentToolResult, type Details, theme } from "./subagents-render-stability-helpers.js";

describe("subagent explicit fast-model UI labels", () => {
	test("foreground compact result renders the fast model identity without a separate badge", () => {
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
						model: "openai-codex/gpt-5.6-sol-fast",
						thinking: "medium",
						finalOutput: "done",
					},
				],
			},
		};

		const text = renderSubagentResult(result, { expanded: false }, theme).render(120).join("\n");

		assert.match(text, /openai-codex\/gpt-5\.6-sol-fast · thinking medium/);
		const expanded = renderSubagentResult(result, { expanded: true }, theme).render(120).join("\n");
		assert.match(expanded, /openai-codex\/gpt-5\.6-sol-fast · thinking medium/);
		assert.equal(expanded.match(/gpt-5\.6-sol-fast/g)?.length, 1);
	});

	test("foreground result renders a normal model without a fast badge", () => {
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

	test("running multi-result rows render thinking and the canonical fast model ID", () => {
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
						model: "openai-codex/gpt-5.6-sol-fast",
						thinking: "high",
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
		assert.match(text, /openai-codex\/gpt-5\.6-sol-fast · thinking high/);
		assert.match(text, /claude-sonnet-4 · thinking low/);
		assert.doesNotMatch(text, /claude-sonnet-4 · thinking low · fast/);
	});
});
