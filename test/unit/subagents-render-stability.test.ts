import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Component } from "@earendil-works/pi-tui";
import {
    buildWidgetLines,
    clearLegacyResultAnimationTimer,
    currentRunningFrame,
    renderLiveSubagentResult,
    renderSubagentResult,
    renderWidget,
    RUNNING_ANIMATION_MS,
    stopResultAnimations,
    stopWidgetAnimation,
    widgetRenderKey,
} from "../../packages/subagents/src/tui/render.js";
import type { ExtensionContext } from "@bastani/atomic";
import type {
    AsyncJobState,
    Details,
} from "../../packages/subagents/src/shared/types.js";

type RenderTheme = Parameters<typeof renderSubagentResult>[2];

const theme = {
    fg: (_name: string, value: string) => value,
    bg: (_name: string, value: string) => value,
    bold: (value: string) => value,
} as unknown as RenderTheme;

// Braille spinner frames used by the running glyph. Kept in sync with render.ts.
const RUNNING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_CHARS = new Set(RUNNING_FRAMES);

function withMockedNow<T>(now: number, run: () => T): T {
    const originalNow = Date.now;
    Date.now = () => now;
    try {
        return run();
    } finally {
        Date.now = originalNow;
    }
}

function stripSpinnerChars(line: string): string {
    return [...line].filter((char) => !SPINNER_CHARS.has(char)).join("");
}

function firstSpinnerChar(text: string): string | undefined {
    for (const char of text) if (SPINNER_CHARS.has(char)) return char;
    return undefined;
}

function runningSingleResult(): AgentToolResult<Details> {
    return {
        content: [{ type: "text", text: "running" }],
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
                    progress: {
                        agent: "worker",
                        index: 0,
                        status: "running",
                        task: "do work",
                        durationMs: 2_000,
                        toolCount: 1,
                        tokens: 10,
                        recentTools: [],
                        recentOutput: [],
                    },
                },
            ],
        },
    };
}

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

describe("async widget animation ticker lifecycle", () => {
    afterEach(() => {
        stopWidgetAnimation();
    });

    function runningJob(): AsyncJobState {
        return {
            asyncId: "job1",
            asyncDir: "/tmp/job1",
            status: "running",
            mode: "single",
            agents: ["worker"],
            updatedAt: 10_000,
            lastActivityAt: 10_000,
            toolCount: 1,
            turnCount: 1,
        };
    }

    function mockLifecycleWidgetCtx(): {
        ctx: ExtensionContext;
        widgetCalls: Array<{ key: string; content: unknown; options: unknown }>;
        renders: () => number;
    } {
        const widgetCalls: Array<{
            key: string;
            content: unknown;
            options: unknown;
        }> = [];
        let renderCount = 0;
        const ctx = {
            hasUI: true,
            ui: {
                setWidget: (
                    key: string,
                    content: unknown,
                    options?: unknown,
                ) => {
                    widgetCalls.push({ key, content, options });
                },
                getToolsExpanded: () => false,
                requestRender: () => {
                    renderCount++;
                },
            },
        } as unknown as ExtensionContext;
        return { ctx, widgetCalls, renders: () => renderCount };
    }

    test("visible async widget updates render in place without remounting", () => {
        type WidgetFactory = (
            tui: unknown,
            widgetTheme: RenderTheme,
        ) => Component;

        const { ctx, widgetCalls, renders } = mockLifecycleWidgetCtx();
        renderWidget(ctx, [runningJob()]);

        assert.equal(
            widgetCalls.length,
            1,
            "first non-empty render should mount the widget once",
        );
        const factory = widgetCalls[0]?.content;
        assert.equal(
            typeof factory,
            "function",
            "mounted widget content should be a component factory",
        );
        const component = (factory as WidgetFactory)(undefined, theme);
        assert.match(
            component.render(120).join("\n"),
            /worker/,
            "initial mounted component should render the original job",
        );

        renderWidget(ctx, [
            {
                ...runningJob(),
                status: "complete",
                agents: ["reviewer"],
                toolCount: 3,
                turnCount: 4,
            },
        ]);

        assert.equal(
            widgetCalls.length,
            1,
            "visible->visible updates must not call setWidget/remount again",
        );
        assert.equal(
            renders(),
            1,
            "visible->visible updates should request an in-place render",
        );
        const updated = component.render(120).join("\n");
        assert.match(
            updated,
            /reviewer/,
            "existing mounted component should read the latest job snapshot",
        );
        assert.doesNotMatch(
            updated,
            /worker/,
            "existing mounted component must not be stuck on constructor-captured jobs",
        );
    });

    test("mounted async widget uses captured widget time across unrelated host re-renders", () => {
        type WidgetFactory = (
            tui: unknown,
            widgetTheme: RenderTheme,
        ) => Component;

        const { ctx, widgetCalls } = mockLifecycleWidgetCtx();
        withMockedNow(10_000, () => renderWidget(ctx, [runningJob()]));

        const factory = widgetCalls[0]?.content;
        assert.equal(
            typeof factory,
            "function",
            "mounted widget content should be a component factory",
        );
        const component = (factory as WidgetFactory)(undefined, theme);

        const stableA = withMockedNow(20_000, () =>
            component.render(120).join("\n"),
        );
        const stableB = withMockedNow(30_000, () =>
            component.render(120).join("\n"),
        );
        assert.equal(
            stableB,
            stableA,
            "host re-renders must not advance the mounted widget spinner clock by themselves",
        );

        withMockedNow(10_000 + RUNNING_ANIMATION_MS, () =>
            renderWidget(ctx, [runningJob()]),
        );
        const advanced = withMockedNow(30_000, () =>
            component.render(120).join("\n"),
        );
        assert.notEqual(
            advanced,
            stableA,
            "widget status updates/ticks should still advance the captured widget clock",
        );
    });

    test("visible async widget remounts when the UI context changes", () => {
        const first = mockLifecycleWidgetCtx();
        const second = mockLifecycleWidgetCtx();

        renderWidget(first.ctx, [runningJob()]);
        renderWidget(second.ctx, [runningJob()]);

        assert.equal(
            first.widgetCalls.length,
            2,
            "stale context should mount once and then be cleared on context switch",
        );
        assert.equal(
            first.widgetCalls[1]?.content,
            undefined,
            "context switch should unmount the widget from the stale context",
        );
        assert.equal(
            second.widgetCalls.length,
            1,
            "fresh UI context should receive a mounted widget",
        );
        assert.equal(
            first.renders(),
            0,
            "context switch should not request an in-place render on the stale context",
        );
        assert.equal(
            second.renders(),
            0,
            "context switch should mount rather than request render before mounting",
        );

        renderWidget(first.ctx, []);

        assert.equal(
            first.widgetCalls.length,
            2,
            "stale empty updates must not issue redundant clears on the stale context",
        );
        assert.equal(
            second.widgetCalls.length,
            1,
            "stale empty updates must not clear the active context's widget",
        );
    });

    test("empty async widget updates unmount once and ignore repeated hidden updates", () => {
        const { ctx, widgetCalls } = mockLifecycleWidgetCtx();

        renderWidget(ctx, [runningJob()]);
        renderWidget(ctx, []);
        renderWidget(ctx, []);

        assert.equal(
            widgetCalls.length,
            2,
            "non-empty render should mount once and first empty render should unmount once",
        );
        assert.equal(
            widgetCalls[1]?.content,
            undefined,
            "empty render should clear the mounted widget",
        );
    });

    test("async widget mounts again after an unmount cycle", () => {
        const { ctx, widgetCalls } = mockLifecycleWidgetCtx();

        renderWidget(ctx, [runningJob()]);
        renderWidget(ctx, []);
        renderWidget(ctx, [{ ...runningJob(), agents: ["reviewer"] }]);

        assert.equal(
            widgetCalls.length,
            3,
            "mount -> unmount -> remount should call setWidget for each lifecycle edge",
        );
        assert.equal(
            widgetCalls[1]?.content,
            undefined,
            "unmount step should clear the mounted widget",
        );
        assert.equal(
            typeof widgetCalls[2]?.content,
            "function",
            "remount should install a fresh widget factory",
        );
        assert.deepEqual(
            widgetCalls[2]?.options,
            { placement: "belowEditor" },
            "remount should preserve belowEditor placement",
        );
    });

    test("running jobs drive periodic re-renders; finished jobs stop them", async () => {
        const { ctx, renders } = mockLifecycleWidgetCtx();
        renderWidget(ctx, [runningJob()]);
        await new Promise((resolve) =>
            setTimeout(resolve, RUNNING_ANIMATION_MS * 3 + 40),
        );
        const whileRunning = renders();
        assert.ok(
            whileRunning >= 1,
            `expected periodic widget re-renders while running, saw ${whileRunning}`,
        );

        renderWidget(ctx, [{ ...runningJob(), status: "complete" }]);
        const afterStop = renders();
        await new Promise((resolve) =>
            setTimeout(resolve, RUNNING_ANIMATION_MS * 3 + 40),
        );
        assert.equal(
            renders(),
            afterStop,
            "widget ticker must stop once no job is running",
        );
    });

    test("mounts the async widget belowEditor so its live line stays within the viewport (flicker-free)", () => {
        const opts: unknown[] = [];
        const ctx = {
            hasUI: true,
            ui: {
                setWidget: (_key: string, _factory: unknown, o?: unknown) => {
                    opts.push(o);
                },
                getToolsExpanded: () => false,
                requestRender: () => {},
            },
        } as unknown as ExtensionContext;
        renderWidget(ctx, [runningJob()]);
        assert.deepEqual(
            opts,
            [{ placement: "belowEditor" }],
            "async widget must mount belowEditor (matches the workflow widget; avoids the above-fold flicker)",
        );
    });
});

describe("subagent render stability invariants", () => {
    afterEach(() => {
        stopResultAnimations();
    });

    test("widget render key is stable when only wall clock changes", () => {
        const job: AsyncJobState = {
            asyncId: "abc123",
            asyncDir: "/tmp/abc123",
            status: "running",
            mode: "single",
            agents: ["worker"],
            updatedAt: 10_000,
            toolCount: 1,
            turnCount: 2,
        };

        const first = withMockedNow(10_000, () => widgetRenderKey(job));
        const second = withMockedNow(10_080, () => widgetRenderKey(job));

        assert.equal(second, first);
    });

    test("clears legacy result animation timers", () => {
        let fired = false;
        const timer = setInterval(() => {
            fired = true;
        }, 10_000);
        const context: {
            state: {
                subagentResultAnimationTimer?: ReturnType<typeof setInterval>;
            };
        } = {
            state: { subagentResultAnimationTimer: timer },
        };

        clearLegacyResultAnimationTimer(context);

        assert.equal(context.state.subagentResultAnimationTimer, undefined);
        assert.equal(fired, false);
    });
});
