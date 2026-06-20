import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { buildWidgetLines, currentRunningFrame, RUNNING_ANIMATION_MS, stopResultAnimations } from "../../packages/subagents/src/tui/render.js";
import { type AsyncJobState, theme, withMockedNow } from "./subagents-render-stability-helpers.js";

describe("subagent running spinner animation (issue #1084)", () => {
    afterEach(() => {
        stopResultAnimations();
    });

    test("async widget spinner advances with wall clock for running jobs", () => {
        const job: AsyncJobState = {
            asyncId: "abc123",
            asyncDir: "/tmp/abc123",
            status: "running",
            mode: "single",
            agents: ["worker"],
            updatedAt: 10_000,
            lastActivityAt: 10_000,
            toolCount: 1,
            turnCount: 2,
        };
        const first = withMockedNow(10_000, () =>
            buildWidgetLines([job], theme, 120).join("\n"),
        );
        const second = withMockedNow(10_000 + RUNNING_ANIMATION_MS, () =>
            buildWidgetLines([job], theme, 120).join("\n"),
        );
        assert.notEqual(
            second,
            first,
            "running async widget spinner should animate over wall-clock time",
        );
    });

    test("async widget honours captured now for job, step, and nested running glyphs", () => {
        const job: AsyncJobState = {
            asyncId: "abc123",
            asyncDir: "/tmp/abc123",
            status: "running",
            mode: "single",
            agents: ["worker"],
            updatedAt: 10_000,
            lastActivityAt: 10_000,
            toolCount: 1,
            turnCount: 2,
            steps: [
                {
                    index: 0,
                    agent: "worker",
                    status: "running",
                    toolCount: 1,
                    children: [
                        {
                            id: "nested-run",
                            parentRunId: "abc123",
                            parentStepIndex: 0,
                            depth: 1,
                            path: [{ runId: "abc123", stepIndex: 0 }],
                            state: "running",
                            agent: "nested-worker",
                            lastUpdate: 10_000,
                            lastActivityAt: 10_000,
                            steps: [
                                { agent: "leaf-worker", status: "running" },
                            ],
                        },
                    ],
                },
            ],
        };

        const first = buildWidgetLines([job], theme, 120, true, 10_000).join(
            "\n",
        );
        const second = buildWidgetLines(
            [job],
            theme,
            120,
            true,
            10_000 + RUNNING_ANIMATION_MS,
        ).join("\n");
        assert.notEqual(
            second,
            first,
            "sanity: widget running glyphs should still be sensitive to captured now",
        );
        assert.match(
            first,
            /nested-worker/,
            "test fixture should exercise nested widget lines",
        );
        assert.match(
            first,
            /leaf-worker/,
            "test fixture should exercise nested step glyphs",
        );

        const stableA = withMockedNow(20_000, () =>
            buildWidgetLines([job], theme, 120, true, 10_000).join("\n"),
        );
        const stableB = withMockedNow(30_000, () =>
            buildWidgetLines([job], theme, 120, true, 10_000).join("\n"),
        );
        assert.equal(
            stableB,
            stableA,
            "captured now should keep widget lines byte-stable across unrelated host re-renders",
        );
    });

    test("multi-job async widget list honours captured now for header and row glyphs", () => {
        const base: AsyncJobState = {
            asyncId: "abc123",
            asyncDir: "/tmp/abc123",
            status: "running",
            mode: "single",
            agents: ["worker"],
            updatedAt: 10_000,
            lastActivityAt: 10_000,
            toolCount: 1,
            turnCount: 2,
        };
        const jobs = [
            base,
            {
                ...base,
                asyncId: "def456",
                asyncDir: "/tmp/def456",
                agents: ["reviewer"],
                turnCount: 3,
            },
        ];

        const first = buildWidgetLines(jobs, theme, 120, false, 10_000).join(
            "\n",
        );
        const second = buildWidgetLines(
            jobs,
            theme,
            120,
            false,
            10_000 + RUNNING_ANIMATION_MS,
        ).join("\n");
        assert.notEqual(
            second,
            first,
            "sanity: multi-job widget glyphs should still be sensitive to captured now",
        );

        const stableA = withMockedNow(20_000, () =>
            buildWidgetLines(jobs, theme, 120, false, 10_000).join("\n"),
        );
        const stableB = withMockedNow(30_000, () =>
            buildWidgetLines(jobs, theme, 120, false, 10_000).join("\n"),
        );
        assert.equal(
            stableB,
            stableA,
            "captured now should keep multi-job widget rows stable across unrelated host re-renders",
        );
    });

    test("currentRunningFrame advances one step per animation interval", () => {
        const f0 = currentRunningFrame(1_000_000);
        const f1 = currentRunningFrame(1_000_000 + RUNNING_ANIMATION_MS);
        const fSame = currentRunningFrame(1_000_000 + RUNNING_ANIMATION_MS - 1);
        assert.equal(f1 - f0, 1);
        assert.equal(fSame, f0);
    });
});

