import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { buildWidgetLines, currentRunningFrame, pulseGlyph, RUNNING_ANIMATION_MS, stopResultAnimations } from "../../packages/subagents/src/tui/render.js";
import { firstSpinnerChar, type AsyncJobState, theme, withMockedNow } from "./subagents-render-stability-helpers.js";

describe("subagent running pulse animation (issue #1084)", () => {
    afterEach(() => {
        stopResultAnimations();
    });

    test("async widget running glyphs reuse foreground pulse frames and ignore wall-clock time", () => {
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
            buildWidgetLines([job], theme, 120, false, 10_000, 1).join("\n"),
        );
        const sameFrameLater = withMockedNow(10_000 + RUNNING_ANIMATION_MS, () =>
            buildWidgetLines([job], theme, 120, false, 10_000, 1).join("\n"),
        );
        assert.equal(
            sameFrameLater,
            first,
            "async pulse must not advance from wall-clock time alone",
        );
        const advanced = buildWidgetLines([job], theme, 120, false, 10_000, 2).join("\n");
        assert.notEqual(advanced, first, "a semantic progress/status update pulse frame should change the glyph");
        assert.equal([...first.split("\n")[1]!][0], pulseGlyph(1));
        assert.equal([...advanced.split("\n")[1]!][0], pulseGlyph(2));
        assert.equal(firstSpinnerChar(advanced), undefined, "async widget must not render spinner-style glyphs");
        assert.equal(firstSpinnerChar(first), undefined, "async widget must not render spinner-style glyphs");
        assert.equal(firstSpinnerChar(sameFrameLater), undefined, "async widget must not render spinner-style glyphs");
    });

    test("async widget honours captured now for job, step, and nested running pulse glyphs", () => {
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

        const first = buildWidgetLines([job], theme, 120, true, 10_000, 1).join(
            "\n",
        );
        const sameFrameLater = buildWidgetLines(
            [job],
            theme,
            120,
            true,
            10_000 + RUNNING_ANIMATION_MS,
            1,
        ).join("\n");
        assert.equal(
            sameFrameLater,
            first,
            "same pulse frame should keep job, step, and nested glyphs stable across wall-clock advances",
        );
        const second = buildWidgetLines([job], theme, 120, true, 10_000, 2).join("\n");
        assert.notEqual(
            second,
            first,
            "progress/status-update pulse frames should advance job, step, and nested glyphs",
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
        assert.equal(firstSpinnerChar(first), undefined, "job, step, and nested running glyphs must not render spinner-style glyphs");
        assert.equal(firstSpinnerChar(second), undefined, "job, step, and nested running glyphs must not render spinner-style glyphs");

        const stableA = withMockedNow(20_000, () =>
            buildWidgetLines([job], theme, 120, true, 10_000, 1).join("\n"),
        );
        const stableB = withMockedNow(30_000, () =>
            buildWidgetLines([job], theme, 120, true, 10_000, 1).join("\n"),
        );
        assert.equal(
            stableB,
            stableA,
            "captured now should keep widget lines byte-stable across unrelated host re-renders",
        );
    });

    test("multi-job async widget list honours captured now for header and row pulse glyphs", () => {
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

        const first = buildWidgetLines(jobs, theme, 120, false, 10_000, 1).join(
            "\n",
        );
        const sameFrameLater = buildWidgetLines(
            jobs,
            theme,
            120,
            false,
            10_000 + RUNNING_ANIMATION_MS,
            1,
        ).join("\n");
        assert.equal(
            sameFrameLater,
            first,
            "same pulse frame should keep multi-job widget glyphs stable across wall-clock advances",
        );
        const second = buildWidgetLines(jobs, theme, 120, false, 10_000, 2).join("\n");
        assert.notEqual(
            second,
            first,
            "progress/status-update pulse frames should advance multi-job widget glyphs",
        );
        assert.equal(firstSpinnerChar(first), undefined, "multi-job widget rows must not render spinner-style glyphs");
        assert.equal(firstSpinnerChar(second), undefined, "multi-job widget rows must not render spinner-style glyphs");

        const stableA = withMockedNow(20_000, () =>
            buildWidgetLines(jobs, theme, 120, false, 10_000, 1).join("\n"),
        );
        const stableB = withMockedNow(30_000, () =>
            buildWidgetLines(jobs, theme, 120, false, 10_000, 1).join("\n"),
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

