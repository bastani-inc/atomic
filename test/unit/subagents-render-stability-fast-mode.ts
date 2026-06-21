import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { buildWidgetLines, renderSubagentResult } from "../../packages/subagents/src/tui/render.js";
import { type AgentToolResult, type AsyncJobState, type Details, theme, withMockedNow } from "./subagents-render-stability-helpers.js";
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
                        exitCode: 0,
                        usage: {
                            input: 0,
                            output: 0,
                            cacheRead: 0,
                            cacheWrite: 0,
                            cost: 0,
                            turns: 0,
                        },
                        model: "openai/gpt-5.1-codex:medium",
                        fastMode: true,
                        finalOutput: "done",
                    },
                ],
            },
        };

        const text = renderSubagentResult(result, { expanded: false }, theme)
            .render(120)
            .join("\n");

        assert.match(text, /gpt-5\.1-codex · thinking medium · fast/);
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
                        exitCode: 0,
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

        const text = renderSubagentResult(result, { expanded: false }, theme)
            .render(120)
            .join("\n");

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

        const text = withMockedNow(10_000, () =>
            buildWidgetLines([job], theme, 120).join("\n"),
        );

        assert.match(text, /gpt-5\.1-codex · thinking medium · fast/);
    });
});

