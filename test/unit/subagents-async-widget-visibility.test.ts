import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@bastani/atomic";
import { createAsyncJobTracker } from "../../packages/subagents/src/runs/background/async-job-tracker.js";
import { stopWidgetAnimation } from "../../packages/subagents/src/tui/render.js";
import type {
    AsyncStatus,
    SubagentState,
} from "../../packages/subagents/src/shared/types.js";

type SetWidgetArgs = Parameters<ExtensionContext["ui"]["setWidget"]>;
type WidgetCall = {
    key: string;
    content: SetWidgetArgs[1];
    options: SetWidgetArgs[2];
};

const states: SubagentState[] = [];
const tempRoots: string[] = [];

function makeTempRoot(prefix: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempRoots.push(root);
    return root;
}

function makeState(
    cwd: string,
    currentSessionId: string | null = "session-current",
): SubagentState {
    const state: SubagentState = {
        baseCwd: cwd,
        currentSessionId,
        asyncJobs: new Map(),
        foregroundRuns: new Map(),
        foregroundControls: new Map(),
        lastForegroundControlId: null,
        cleanupTimers: new Map(),
        lastUiContext: null,
        poller: null,
        completionSeen: new Map(),
        watcher: null,
        watcherRestartTimer: null,
        resultFileCoalescer: {
            schedule: () => false,
            clear: () => {},
        },
    };
    states.push(state);
    return state;
}

function makePi(): Pick<ExtensionAPI, "events"> {
    return {
        events: {
            emit: () => {},
            on: () => () => {},
        },
    } as Pick<ExtensionAPI, "events">;
}

function makeUiContext(
    cwd: string,
    sessionId = "session-current",
): {
    ctx: ExtensionContext;
    widgetCalls: WidgetCall[];
    renderCount: () => number;
} {
    const widgetCalls: WidgetCall[] = [];
    let renders = 0;
    const ctx = {
        hasUI: true,
        cwd,
        ui: {
            setWidget: (
                key: string,
                content: SetWidgetArgs[1],
                options?: SetWidgetArgs[2],
            ) => {
                widgetCalls.push({ key, content, options });
            },
            getToolsExpanded: () => false,
            setToolsExpanded: () => {},
            requestRender: () => {
                renders++;
            },
        },
        sessionManager: {
            getSessionFile: () => sessionId,
            getSessionId: () => sessionId,
            getEntries: () => [],
        },
        modelRegistry: {
            getAvailable: () => [],
        },
        model: undefined,
        isIdle: () => true,
        signal: undefined,
        abort: () => {},
        hasPendingMessages: () => false,
        shutdown: () => {},
        getContextUsage: () => undefined,
        compact: () => {},
        getSystemPrompt: () => "",
    } as unknown as ExtensionContext;
    return { ctx, widgetCalls, renderCount: () => renders };
}

function makeStatus(
    runId: string,
    cwd: string,
    overrides: Partial<AsyncStatus> = {},
): AsyncStatus {
    return {
        runId,
        mode: "single",
        state: "running",
        cwd,
        startedAt: 1_000,
        lastUpdate: 2_000,
        currentStep: 0,
        steps: [{ agent: "worker", status: "running", startedAt: 1_000 }],
        ...overrides,
    };
}

function writeStatus(
    asyncRoot: string,
    runId: string,
    status: AsyncStatus,
): void {
    const asyncDir = path.join(asyncRoot, runId);
    fs.mkdirSync(asyncDir, { recursive: true });
    fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        `${JSON.stringify(status, null, 2)}\n`,
        "utf-8",
    );
}

function makeTracker(
    state: SubagentState,
    asyncRoot: string,
    resultsDir: string,
) {
    return createAsyncJobTracker(makePi(), state, asyncRoot, {
        resultsDir,
        pollIntervalMs: 60_000,
    });
}

afterEach(() => {
    stopWidgetAnimation();
    for (const state of states.splice(0)) {
        if (state.poller) clearInterval(state.poller);
        state.poller = null;
        for (const timer of state.cleanupTimers.values()) clearTimeout(timer);
        state.cleanupTimers.clear();
    }
    for (const root of tempRoots.splice(0)) {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

describe("subagent async widget hydration (issue #1146)", () => {
    test("hydrates an active status-visible run and renders the widget belowEditor", () => {
        const cwd = makeTempRoot("atomic-subagent-widget-cwd-");
        const asyncRoot = makeTempRoot("atomic-subagent-widget-async-");
        const resultsDir = makeTempRoot("atomic-subagent-widget-results-");
        const state = makeState(cwd, "session-current");
        writeStatus(
            asyncRoot,
            "run-visible",
            makeStatus("run-visible", cwd, {
                sessionId: "session-current",
                currentTool: "read",
                currentToolStartedAt: 1_500,
                toolCount: 2,
            }),
        );
        const { ctx, widgetCalls, renderCount } = makeUiContext(cwd);

        makeTracker(state, asyncRoot, resultsDir).hydrateActiveJobs(ctx);

        const job = state.asyncJobs.get("run-visible");
        assert.ok(
            job,
            "status-visible active run should be projected into widget state",
        );
        assert.equal(job.asyncDir, path.join(asyncRoot, "run-visible"));
        assert.equal(job.status, "running");
        assert.equal(job.sessionId, "session-current");
        assert.equal(job.currentTool, "read");
        assert.ok(
            widgetCalls.some(
                (call) => call.options?.placement === "belowEditor",
            ),
            "hydrated active run should mount belowEditor",
        );
        assert.equal(
            renderCount(),
            0,
            "mounting is handled by setWidget; the tracker must not duplicate requestRender",
        );
    });

    test("visible active-run hydration updates the mounted widget with one in-place render", () => {
        const cwd = makeTempRoot("atomic-subagent-widget-cwd-");
        const asyncRoot = makeTempRoot("atomic-subagent-widget-async-");
        const resultsDir = makeTempRoot("atomic-subagent-widget-results-");
        const state = makeState(cwd, "session-current");
        writeStatus(
            asyncRoot,
            "run-visible",
            makeStatus("run-visible", cwd, {
                sessionId: "session-current",
                toolCount: 1,
            }),
        );
        const { ctx, widgetCalls, renderCount } = makeUiContext(cwd);
        const tracker = makeTracker(state, asyncRoot, resultsDir);

        tracker.hydrateActiveJobs(ctx);
        writeStatus(
            asyncRoot,
            "run-visible",
            makeStatus("run-visible", cwd, {
                sessionId: "session-current",
                currentTool: "bash",
                currentToolStartedAt: 2_000,
                toolCount: 2,
                lastUpdate: 3_000,
            }),
        );
        tracker.hydrateActiveJobs(ctx);

        assert.equal(
            widgetCalls.length,
            1,
            "visible hydration updates must not remount the widget",
        );
        assert.equal(
            renderCount(),
            1,
            "visible hydration updates should request exactly one in-place render",
        );
    });

    test("does not hydrate active runs from unrelated sessions or directories", () => {
        const cwd = makeTempRoot("atomic-subagent-widget-current-");
        const otherCwd = makeTempRoot("atomic-subagent-widget-other-");
        const asyncRoot = makeTempRoot("atomic-subagent-widget-async-");
        const resultsDir = makeTempRoot("atomic-subagent-widget-results-");
        const state = makeState(cwd, "session-current");
        writeStatus(
            asyncRoot,
            "run-other-session",
            makeStatus("run-other-session", cwd, {
                sessionId: "session-other",
            }),
        );
        writeStatus(
            asyncRoot,
            "run-other-cwd",
            makeStatus("run-other-cwd", otherCwd),
        );
        const { ctx, widgetCalls } = makeUiContext(cwd);

        makeTracker(state, asyncRoot, resultsDir).hydrateActiveJobs(ctx);

        assert.equal(state.asyncJobs.size, 0);
        assert.ok(
            !widgetCalls.some(
                (call) => call.options?.placement === "belowEditor",
            ),
            "unrelated runs must not mount an active widget",
        );
    });

    test("uses cwd fallback for active runs that do not have a session id", () => {
        const cwd = makeTempRoot("atomic-subagent-widget-current-");
        const otherCwd = makeTempRoot("atomic-subagent-widget-other-");
        const asyncRoot = makeTempRoot("atomic-subagent-widget-async-");
        const resultsDir = makeTempRoot("atomic-subagent-widget-results-");
        const state = makeState(cwd, "session-current");
        writeStatus(
            asyncRoot,
            "run-matching-cwd",
            makeStatus("run-matching-cwd", cwd),
        );
        writeStatus(
            asyncRoot,
            "run-different-cwd",
            makeStatus("run-different-cwd", otherCwd),
        );
        const { ctx, widgetCalls } = makeUiContext(cwd);

        makeTracker(state, asyncRoot, resultsDir).hydrateActiveJobs(ctx);

        assert.deepEqual([...state.asyncJobs.keys()], ["run-matching-cwd"]);
        assert.ok(
            widgetCalls.some(
                (call) => call.options?.placement === "belowEditor",
            ),
        );
    });

    test("hydrates only active queued/running statuses, not terminal history", () => {
        const cwd = makeTempRoot("atomic-subagent-widget-cwd-");
        const asyncRoot = makeTempRoot("atomic-subagent-widget-async-");
        const resultsDir = makeTempRoot("atomic-subagent-widget-results-");
        const state = makeState(cwd, "session-current");
        writeStatus(
            asyncRoot,
            "run-queued",
            makeStatus("run-queued", cwd, {
                sessionId: "session-current",
                state: "queued",
                steps: [
                    { agent: "worker", status: "pending", startedAt: 1_000 },
                ],
            }),
        );
        writeStatus(
            asyncRoot,
            "run-complete",
            makeStatus("run-complete", cwd, {
                sessionId: "session-current",
                state: "complete",
                endedAt: 2_000,
                steps: [
                    {
                        agent: "worker",
                        status: "complete",
                        startedAt: 1_000,
                        endedAt: 2_000,
                    },
                ],
            }),
        );
        writeStatus(
            asyncRoot,
            "run-failed",
            makeStatus("run-failed", cwd, {
                sessionId: "session-current",
                state: "failed",
                endedAt: 2_000,
                steps: [
                    {
                        agent: "worker",
                        status: "failed",
                        startedAt: 1_000,
                        endedAt: 2_000,
                    },
                ],
            }),
        );
        writeStatus(
            asyncRoot,
            "run-paused",
            makeStatus("run-paused", cwd, {
                sessionId: "session-current",
                state: "paused",
                endedAt: 2_000,
                steps: [
                    {
                        agent: "worker",
                        status: "paused",
                        startedAt: 1_000,
                        endedAt: 2_000,
                    },
                ],
            }),
        );
        const { ctx, widgetCalls } = makeUiContext(cwd);

        makeTracker(state, asyncRoot, resultsDir).hydrateActiveJobs(ctx);

        assert.deepEqual([...state.asyncJobs.keys()], ["run-queued"]);
        assert.equal(state.asyncJobs.get("run-queued")?.status, "queued");
        assert.ok(!state.asyncJobs.has("run-complete"));
        assert.ok(!state.asyncJobs.has("run-failed"));
        assert.ok(!state.asyncJobs.has("run-paused"));
        assert.ok(
            widgetCalls.some(
                (call) => call.options?.placement === "belowEditor",
            ),
            "active queued runs should render while terminal history stays out of the widget",
        );
    });

    test("keeps a mounted active widget visible across reset and hydration", () => {
        const cwd = makeTempRoot("atomic-subagent-widget-cwd-");
        const asyncRoot = makeTempRoot("atomic-subagent-widget-async-");
        const resultsDir = makeTempRoot("atomic-subagent-widget-results-");
        const state = makeState(cwd, "session-current");
        writeStatus(
            asyncRoot,
            "run-visible",
            makeStatus("run-visible", cwd, { sessionId: "session-current" }),
        );
        const first = makeUiContext(cwd);
        const reset = makeUiContext(cwd);
        const hydrate = makeUiContext(cwd);
        const tracker = makeTracker(state, asyncRoot, resultsDir);

        tracker.hydrateActiveJobs(first.ctx);
        tracker.resetJobs(reset.ctx);
        tracker.hydrateActiveJobs(hydrate.ctx);
        const widgetCalls = [
            ...first.widgetCalls,
            ...reset.widgetCalls,
            ...hydrate.widgetCalls,
        ];

        assert.equal(
            widgetCalls.filter((call) => call.content === undefined).length,
            0,
            "reset before active hydration must not publish a blank widget frame",
        );
        assert.equal(
            widgetCalls.filter(
                (call) => call.options?.placement === "belowEditor",
            ).length,
            1,
            "active hydration after reset should reuse the mounted widget",
        );
        assert.equal(
            hydrate.renderCount(),
            1,
            "active hydration after reset should render in place once",
        );
    });

    test("unmounts a mounted widget after reset and hydration finds no active jobs", () => {
        const cwd = makeTempRoot("atomic-subagent-widget-cwd-");
        const asyncRoot = makeTempRoot("atomic-subagent-widget-async-");
        const resultsDir = makeTempRoot("atomic-subagent-widget-results-");
        const state = makeState(cwd, "session-current");
        writeStatus(
            asyncRoot,
            "run-visible",
            makeStatus("run-visible", cwd, { sessionId: "session-current" }),
        );
        const first = makeUiContext(cwd);
        const reset = makeUiContext(cwd);
        const hydrate = makeUiContext(cwd);
        const tracker = makeTracker(state, asyncRoot, resultsDir);

        tracker.hydrateActiveJobs(first.ctx);
        writeStatus(
            asyncRoot,
            "run-visible",
            makeStatus("run-visible", cwd, {
                sessionId: "session-current",
                state: "complete",
                endedAt: 3_000,
                steps: [
                    {
                        agent: "worker",
                        status: "complete",
                        startedAt: 1_000,
                        endedAt: 3_000,
                    },
                ],
            }),
        );
        tracker.resetJobs(reset.ctx);
        const afterResetWidgetCalls = [
            ...first.widgetCalls,
            ...reset.widgetCalls,
            ...hydrate.widgetCalls,
        ];
        assert.equal(
            afterResetWidgetCalls.filter((call) => call.content === undefined).length,
            0,
            "reset itself should defer empty rendering to hydration",
        );

        tracker.hydrateActiveJobs(hydrate.ctx);
        const afterHydrateWidgetCalls = [
            ...first.widgetCalls,
            ...reset.widgetCalls,
            ...hydrate.widgetCalls,
        ];

        assert.equal(
            afterHydrateWidgetCalls.filter((call) => call.content === undefined).length,
            1,
            "hydrate should still unmount when no active jobs remain",
        );
    });
});
