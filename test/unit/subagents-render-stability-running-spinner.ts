import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
    PULSE_FRAMES,
    renderLiveSubagentResult,
    renderSubagentResult,
    pulseGlyph,
    RUNNING_ANIMATION_MS,
    stopResultAnimations,
} from "../../packages/subagents/src/tui/render.js";
import { widgetStepGlyph } from "../../packages/subagents/src/tui/render-event-formatting.js";
import {
    type AgentToolResult,
    type Details,
    firstPulseChar,
    firstSpinnerChar,
    runningSingleResult,
    theme,
    withMockedNow,
} from "./subagents-render-stability-helpers.js";

type LiveContext = Parameters<typeof renderLiveSubagentResult>[3];

function freshContext(): LiveContext {
    return { state: {}, invalidate: () => {} } as LiveContext;
}

/** Simulate a genuine progress update (a tool use plus elapsed time). */
function bumpProgress(result: AgentToolResult<Details>): AgentToolResult<Details> {
    return {
        ...result,
        details: {
            ...result.details!,
            results: result.details!.results.map((entry) => ({
                ...entry,
                progress: entry.progress
                    ? {
                          ...entry.progress,
                          durationMs: entry.progress.durationMs + 1_000,
                          toolCount: entry.progress.toolCount + 1,
                      }
                    : entry.progress,
            })),
        },
    };
}

// Foreground subagent results render into chat scrollback, which can scroll
// above pi-tui's viewport fold. A wall-clock animation timer there forces a
// destructive full-screen/scrollback clear on every tick (the flicker that
// grew with widget height). The fix replaces the timer-driven spinner with a
// pulse that advances once per real progress update — so the only line diffs
// coincide with content that genuinely changed.
describe("subagent running pulse (foreground flicker fix)", () => {
    afterEach(() => {
        stopResultAnimations();
    });

    test("foreground running rows never install an animation timer", () => {
        const context = freshContext();
        withMockedNow(10_000, () =>
            renderLiveSubagentResult(
                runningSingleResult(),
                { expanded: false, isPartial: true },
                theme,
                context,
            ).render(120),
        );
        assert.equal(
            context.state.subagentResultAnimationTimer,
            undefined,
            "foreground subagent rows must not run a wall-clock timer (above-fold ticks flicker)",
        );
        assert.equal(
            context.state.subagentResultPulseFrame,
            1,
            "the first render seeds the pulse at frame 1",
        );
        assert.equal(context.state.subagentResultSnapshotNow, 10_000);
    });

    test("renders are byte-identical across wall-clock advances without a progress update", () => {
        const result = runningSingleResult();
        const context = freshContext();
        const first = withMockedNow(10_000, () =>
            renderLiveSubagentResult(
                result,
                { expanded: false, isPartial: true },
                theme,
                context,
            )
                .render(120)
                .join("\n"),
        );
        const second = withMockedNow(10_000 + 8 * RUNNING_ANIMATION_MS, () =>
            renderLiveSubagentResult(
                result,
                { expanded: false, isPartial: true },
                theme,
                context,
            )
                .render(120)
                .join("\n"),
        );
        assert.equal(
            second,
            first,
            "with no progress update the row must not change across host re-renders / time",
        );
        assert.equal(
            context.state.subagentResultPulseFrame,
            1,
            "the pulse must not advance without a progress update",
        );
    });

    test("the pulse advances exactly once per progress update and refreshes the row", () => {
        let result = runningSingleResult();
        const context = freshContext();
        const before = withMockedNow(10_000, () =>
            renderLiveSubagentResult(
                result,
                { expanded: false, isPartial: true },
                theme,
                context,
            )
                .render(120)
                .join("\n"),
        );
        assert.equal(context.state.subagentResultPulseFrame, 1);

        result = bumpProgress(result);
        const after = withMockedNow(10_000, () =>
            renderLiveSubagentResult(
                result,
                { expanded: false, isPartial: true },
                theme,
                context,
            )
                .render(120)
                .join("\n"),
        );
        assert.equal(
            context.state.subagentResultPulseFrame,
            2,
            "a progress update advances the pulse by exactly one",
        );
        assert.notEqual(after, before, "a progress update refreshes the foreground row");
    });

    test("the running glyph is a pulse frame that visibly changes on every update", () => {
        let result = runningSingleResult();
        const context = freshContext();
        let previous: string | undefined;
        for (let frame = 1; frame <= PULSE_FRAMES.length + 2; frame++) {
            const out = withMockedNow(10_000, () =>
                renderLiveSubagentResult(
                    result,
                    { expanded: false, isPartial: true },
                    theme,
                    context,
                )
                    .render(120)
                    .join("\n"),
            );
            assert.equal(context.state.subagentResultPulseFrame, frame);
            const glyph = firstPulseChar(out);
            assert.ok(glyph, `expected a pulse glyph on update ${frame}`);
            assert.equal(
                glyph,
                pulseGlyph(frame),
                `glyph must match pulseGlyph(${frame})`,
            );
            if (previous !== undefined) {
                assert.notEqual(
                    glyph,
                    previous,
                    `update ${frame} must visibly change the pulse glyph`,
                );
            }
            previous = glyph;
            result = bumpProgress(result);
        }
    });

    test("the running glyph is decoupled from wall-clock time", () => {
        const result = runningSingleResult();
        const a = withMockedNow(10_000, () =>
            renderSubagentResult(
                result,
                { expanded: false, now: 10_000, pulseFrame: 2 },
                theme,
            )
                .render(120)
                .join("\n"),
        );
        const b = withMockedNow(10_000 + 9 * RUNNING_ANIMATION_MS, () =>
            renderSubagentResult(
                result,
                { expanded: false, now: 10_000, pulseFrame: 2 },
                theme,
            )
                .render(120)
                .join("\n"),
        );
        assert.equal(
            a,
            b,
            "same pulse frame + same captured now must render byte-identically regardless of wall-clock",
        );
        assert.equal(firstPulseChar(a), pulseGlyph(2));
    });

    test("foreground chain placeholder rows keep their existing running glyph", () => {
        const glyph = withMockedNow(10_000, () => widgetStepGlyph("running", theme));

        assert.ok(firstSpinnerChar(glyph), "foreground placeholder helper keeps the preexisting running spinner glyph");
        assert.notEqual(glyph, pulseGlyph(1), "foreground placeholder helper must not reuse the async/foreground pulse frame");
    });

    test("multi-agent compact rows stay stable until a progress update", () => {
        const base = runningSingleResult().details!.results[0]!;
        const parallel: AgentToolResult<Details> = {
            content: [{ type: "text", text: "running parallel" }],
            details: {
                mode: "parallel",
                results: [
                    base,
                    {
                        ...base,
                        agent: "reviewer",
                        task: "review",
                        progress: { ...base.progress!, agent: "reviewer", index: 1 },
                    },
                ],
                progress: [
                    base.progress!,
                    { ...base.progress!, agent: "reviewer", index: 1 },
                ],
                totalSteps: 2,
            },
        };
        const context = freshContext();
        const first = withMockedNow(10_000, () =>
            renderLiveSubagentResult(
                parallel,
                { expanded: false, isPartial: true },
                theme,
                context,
            )
                .render(120)
                .join("\n"),
        );
        const second = withMockedNow(10_000 + 5 * RUNNING_ANIMATION_MS, () =>
            renderLiveSubagentResult(
                parallel,
                { expanded: false, isPartial: true },
                theme,
                context,
            )
                .render(120)
                .join("\n"),
        );
        assert.equal(
            second,
            first,
            "multi-agent compact rows must be byte-stable across host re-renders without updates",
        );
    });
});
