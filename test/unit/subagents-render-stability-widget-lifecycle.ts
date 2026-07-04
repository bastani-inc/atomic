import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { renderWidget, RUNNING_ANIMATION_MS, stopWidgetAnimation } from "../../packages/subagents/src/tui/render.js";
import { type AsyncJobState, type Component, type ExtensionContext, type RenderTheme, theme, withMockedNow } from "./subagents-render-stability-helpers.js";
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

    function mockLifecycleWidgetCtx(ownerCwd?: string, toolsExpanded = false): {
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
            cwd: ownerCwd,
            ui: {
                setWidget: (
                    key: string,
                    content: unknown,
                    options?: unknown,
                ) => {
                    widgetCalls.push({ key, content, options });
                },
                getToolsExpanded: () => toolsExpanded,
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

    test("mounted async widget keeps last expanded state across stale stage-exit context re-renders", () => {
        type WidgetFactory = (
            tui: unknown,
            widgetTheme: RenderTheme,
        ) => Component;

        const { ctx, widgetCalls } = mockLifecycleWidgetCtx(undefined, true);
        renderWidget(ctx, [
            {
                ...runningJob(),
                mode: "chain",
                chainStepCount: 1,
                steps: [
                    {
                        agent: "worker",
                        status: "running",
                        durationMs: 1_000,
                        toolCount: 1,
                        tokens: { input: 20, output: 0, total: 20 },
                        recentTools: [{ tool: "bash", args: "bun test", endMs: 10_000 }],
                        recentOutput: ["still running"],
                    },
                ],
            },
        ]);

        const factory = widgetCalls[0]?.content;
        assert.equal(
            typeof factory,
            "function",
            "mounted widget content should be a component factory",
        );
        const component = (factory as WidgetFactory)(undefined, theme);
        const expanded = component.render(120).join("\n");
        assert.match(
            expanded,
            /bash: bun test/,
            "expanded widget should show live detail from the current UI state",
        );

        ctx.hasUI = false;

        const staleContextRender = component.render(120).join("\n");
        assert.match(
            staleContextRender,
            /bash: bun test/,
            "stage-exit stale/no-UI re-renders should preserve the last expanded state while the job remains mounted",
        );
        assert.doesNotMatch(
            staleContextRender,
            /Press ctrl\+o for live detail/,
            "stale context fallback must not transiently collapse the running widget",
        );
    });

    test("visible async widget remounts when the logical owner changes", () => {
        const first = mockLifecycleWidgetCtx("/tmp/atomic-widget-owner-a");
        const second = mockLifecycleWidgetCtx("/tmp/atomic-widget-owner-b");

        renderWidget(first.ctx, [runningJob()]);
        renderWidget(second.ctx, [runningJob()]);

        assert.equal(
            first.widgetCalls.length,
            2,
            "stale context should mount once and then be cleared on owner switch",
        );
        assert.equal(
            first.widgetCalls[1]?.content,
            undefined,
            "owner switch should unmount the widget from the stale context",
        );
        assert.equal(
            second.widgetCalls.length,
            1,
            "fresh UI context should receive a mounted widget",
        );
        assert.equal(
            first.renders(),
            0,
            "owner switch should not request an in-place render on the stale context",
        );
        assert.equal(
            second.renders(),
            0,
            "owner switch should mount rather than request render before mounting",
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

