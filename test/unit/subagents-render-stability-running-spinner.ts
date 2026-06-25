import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { renderLiveSubagentResult, renderSubagentResult, RUNNING_ANIMATION_MS, stopResultAnimations } from "../../packages/subagents/src/tui/render.js";
import { type AgentToolResult, type Details, RUNNING_FRAMES, firstSpinnerChar, runningSingleResult, stripSpinnerChars, theme, withMockedNow } from "./subagents-render-stability-helpers.js";
describe("subagent running spinner animation (issue #1084)", () => {
    afterEach(() => {
        stopResultAnimations();
    });

    test("running glyph advances with wall clock (no longer frozen)", () => {
        const result = runningSingleResult();

        // Two renders exactly one animation frame apart must differ: the spinner
        // is driven by wall-clock time, not by progress data changes.
        const first = withMockedNow(10_000, () =>
            renderSubagentResult(result, { expanded: false }, theme)
                .render(120)
                .join("\n"),
        );
        const second = withMockedNow(10_000 + RUNNING_ANIMATION_MS, () =>
            renderSubagentResult(result, { expanded: false }, theme)
                .render(120)
                .join("\n"),
        );

        assert.notEqual(
            second,
            first,
            "running spinner should advance after one animation interval",
        );
    });

    // NOTE: this invariant assumes the render path only consults Date.now() for
    // time (which the tests mock). If elapsed-time labels ever start reading
    // performance.now()/process.uptime(), this assertion would start to drift.
    test("renders within the same animation frame are identical (deterministic, no churn)", () => {
        const result = runningSingleResult();
        const frameStart = 10_000;

        const a = withMockedNow(frameStart, () =>
            renderSubagentResult(result, { expanded: false }, theme)
                .render(120)
                .join("\n"),
        );
        const b = withMockedNow(frameStart + RUNNING_ANIMATION_MS - 1, () =>
            renderSubagentResult(result, { expanded: false }, theme)
                .render(120)
                .join("\n"),
        );

        assert.equal(
            b,
            a,
            "renders inside the same animation frame must be byte-identical",
        );
    });

    test("foreground tool result timer changes only spinner glyphs", async () => {
        const result = runningSingleResult();
        let invalidates = 0;
        const context = {
            state: {},
            invalidate: () => {
                invalidates++;
            },
        } as Parameters<typeof renderLiveSubagentResult>[3];

        const firstLines = withMockedNow(10_000, () =>
            renderLiveSubagentResult(
                result,
                { expanded: false, isPartial: true },
                theme,
                context,
            ).render(120),
        );
        assert.ok(
            context.state.subagentResultAnimationTimer,
            "running foreground rows should install a spinner-only timer",
        );
        assert.equal(context.state.subagentResultSnapshotNow, 10_000);
        assert.equal(context.state.subagentResultSpinnerFrameNow, 10_000);

        await new Promise((resolve) =>
            setTimeout(resolve, RUNNING_ANIMATION_MS + 40),
        );
        assert.ok(
            invalidates > 0,
            "foreground spinner timer should invalidate for smooth glyph updates",
        );
        assert.equal(
            context.state.subagentResultSnapshotNow,
            10_000,
            "timer must not advance semantic/content time",
        );
        assert.notEqual(
            context.state.subagentResultSpinnerFrameNow,
            10_000,
            "timer should advance spinner-only time",
        );

        // Pin the next spinner frame deterministically; the real timer assertion
        // above proves the timer updates only spinnerFrameNow, while this render
        // assertion proves such an update only changes spinner glyph cells.
        context.state.subagentResultSpinnerFrameNow =
            10_000 + RUNNING_ANIMATION_MS;
        const secondLines = renderLiveSubagentResult(
            result,
            { expanded: false, isPartial: true },
            theme,
            context,
        ).render(120);
        assert.equal(
            secondLines.length,
            firstLines.length,
            "spinner tick must preserve row height",
        );
        let changed = 0;
        for (let i = 0; i < firstLines.length; i++) {
            if (firstLines[i] === secondLines[i]) continue;
            changed++;
            assert.equal(
                stripSpinnerChars(firstLines[i]!),
                stripSpinnerChars(secondLines[i]!),
                `line ${i} changed in non-spinner content between foreground spinner frames`,
            );
        }
        assert.ok(
            changed > 0,
            "expected spinner-only timer to advance at least one glyph",
        );
    });

    test("foreground tool result captures a fresh frame on semantic progress updates", () => {
        const result = runningSingleResult();
        const context = {
            state: {},
            invalidate: () => {},
        } as Parameters<typeof renderLiveSubagentResult>[3];

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
        assert.equal(context.state.subagentResultSnapshotNow, 10_000);

        const updated: AgentToolResult<Details> = {
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
        const second = withMockedNow(10_000 + RUNNING_ANIMATION_MS, () =>
            renderLiveSubagentResult(
                updated,
                { expanded: false, isPartial: true },
                theme,
                context,
            )
                .render(120)
                .join("\n"),
        );

        assert.equal(
            context.state.subagentResultSnapshotNow,
            10_000 + RUNNING_ANIMATION_MS,
        );
        assert.equal(
            context.state.subagentResultSpinnerFrameNow,
            10_000 + RUNNING_ANIMATION_MS,
        );
        assert.notEqual(
            second,
            first,
            "semantic progress updates should still refresh the foreground row",
        );
        assert.ok(
            context.state.subagentResultAnimationTimer,
            "running semantic updates should keep the spinner-only timer installed",
        );
    });

    test("foreground tool result reuses captured now across unrelated renderer calls", () => {
        const result = runningSingleResult();
        const context = {
            state: {},
            invalidate: () => {},
        } as Parameters<typeof renderLiveSubagentResult>[3];

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
        const second = withMockedNow(10_000 + RUNNING_ANIMATION_MS, () =>
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
            "same foreground snapshot should stay stable until a semantic update advances now",
        );
    });

    test("honours captured now so chatbox result rows do not tick on host re-renders", () => {
        const result = runningSingleResult();
        const first = renderSubagentResult(
            result,
            { expanded: false, now: 10_000 },
            theme,
        )
            .render(120)
            .join("\n");
        const second = renderSubagentResult(
            result,
            { expanded: false, now: 10_000 + RUNNING_ANIMATION_MS },
            theme,
        )
            .render(120)
            .join("\n");
        assert.notEqual(
            second,
            first,
            "sanity: running subagent result glyphs should still be sensitive to opts.now",
        );

        const stableA = withMockedNow(20_000, () =>
            renderSubagentResult(
                result,
                { expanded: false, now: 10_000 },
                theme,
            )
                .render(120)
                .join("\n"),
        );
        const stableB = withMockedNow(30_000, () =>
            renderSubagentResult(
                result,
                { expanded: false, now: 10_000 },
                theme,
            )
                .render(120)
                .join("\n"),
        );
        assert.equal(
            stableB,
            stableA,
            "a captured opts.now should keep chatbox rows byte-stable across host re-renders",
        );
    });

    test("honours captured now for multi-agent compact chatbox rows", () => {
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
                        progress: {
                            ...base.progress!,
                            agent: "reviewer",
                            index: 1,
                        },
                    },
                ],
                progress: [
                    base.progress!,
                    { ...base.progress!, agent: "reviewer", index: 1 },
                ],
                totalSteps: 2,
            },
        };

        const first = renderSubagentResult(
            parallel,
            { expanded: false, now: 10_000 },
            theme,
        )
            .render(120)
            .join("\n");
        const second = renderSubagentResult(
            parallel,
            { expanded: false, now: 10_000 + RUNNING_ANIMATION_MS },
            theme,
        )
            .render(120)
            .join("\n");
        assert.notEqual(
            second,
            first,
            "sanity: multi-agent running glyphs should be sensitive to opts.now",
        );

        const stableA = withMockedNow(20_000, () =>
            renderSubagentResult(
                parallel,
                { expanded: false, now: 10_000 },
                theme,
            )
                .render(120)
                .join("\n"),
        );
        const stableB = withMockedNow(30_000, () =>
            renderSubagentResult(
                parallel,
                { expanded: false, now: 10_000 },
                theme,
            )
                .render(120)
                .join("\n"),
        );
        assert.equal(
            stableB,
            stableA,
            "captured opts.now should keep multi-agent chatbox rows byte-stable",
        );
    });

    test("consecutive frames differ only in spinner glyph cells (minimal diff = no flicker)", () => {
        const result = runningSingleResult();

        const firstLines = withMockedNow(10_000, () =>
            renderSubagentResult(result, { expanded: false }, theme).render(
                120,
            ),
        );
        const secondLines = withMockedNow(10_000 + RUNNING_ANIMATION_MS, () =>
            renderSubagentResult(result, { expanded: false }, theme).render(
                120,
            ),
        );

        assert.equal(
            firstLines.length,
            secondLines.length,
            "line count must stay stable across animation frames",
        );

        let changedLines = 0;
        for (let i = 0; i < firstLines.length; i++) {
            if (firstLines[i] === secondLines[i]) continue;
            changedLines++;
            // The only thing that may change between frames is the spinner glyph.
            assert.equal(
                stripSpinnerChars(firstLines[i]!),
                stripSpinnerChars(secondLines[i]!),
                `line ${i} changed in non-spinner content between animation frames`,
            );
        }
        assert.ok(
            changedLines > 0,
            "expected at least one spinner line to animate",
        );
    });

    test("running glyph cycles through frames in order over a full period", () => {
        const result = runningSingleResult();
        const sequence: string[] = [];
        for (let frame = 0; frame <= RUNNING_FRAMES.length; frame++) {
            const out = withMockedNow(frame * RUNNING_ANIMATION_MS, () =>
                renderSubagentResult(result, { expanded: false }, theme)
                    .render(120)
                    .join("\n"),
            );
            const glyph = firstSpinnerChar(out);
            assert.ok(glyph, `expected a spinner glyph at frame ${frame}`);
            sequence.push(glyph!);
        }
        // Every distinct frame is visited...
        assert.equal(
            new Set(sequence).size,
            RUNNING_FRAMES.length,
            "spinner should visit every frame",
        );
        // ...and each step advances to the cyclic successor in RUNNING_FRAMES order.
        for (let i = 1; i < sequence.length; i++) {
            const prev = RUNNING_FRAMES.indexOf(sequence[i - 1]!);
            const cur = RUNNING_FRAMES.indexOf(sequence[i]!);
            assert.equal(
                cur,
                (prev + 1) % RUNNING_FRAMES.length,
                `frame ${i} did not advance by exactly one step`,
            );
        }
    });
});
