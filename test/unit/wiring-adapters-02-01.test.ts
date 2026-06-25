// @ts-nocheck
/**
 * Tests for buildRuntimeAdapters — pi AgentSession wiring.
 *
 * The legacy `buildUIAdapter` (pi.ui → WorkflowUIAdapter for HIL) was removed
 * when workflows became background-only — HIL prompts now route through the
 * store-backed background adapter (see `background-ui-adapter.test.ts`).
 */

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
    buildRuntimeAdapters,
    prepareAtomicStageSessionOptions,
} from "../../packages/workflows/src/extension/wiring.js";
import { StageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import {
    DefaultResourceLoader,
    type CreateAgentSessionOptions,
    type DefaultResourceLoaderInheritanceSnapshot,
    type PackageSource,
} from "@bastani/atomic";
import type {
    PiCodingAgentSdk,
    PiSdkResourceLoader,
    PiSdkSettingsManager,
} from "../../packages/workflows/src/extension/wiring.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import type { StageExecutionMeta } from "../../packages/workflows/src/shared/types.js";

function fakeSession(): StageSessionRuntime {
    let last = "";
    return {
        async prompt(text: string): Promise<string> {
            last = `reply:${text}`;
            return last;
        },
        async steer(text: string): Promise<void> {
            last = `steer:${text}`;
        },
        async followUp(text: string): Promise<void> {
            last = `follow:${text}`;
        },
        subscribe: () => () => {},
        sessionFile: undefined,
        sessionId: "session-1",
        async setModel(): Promise<void> {},
        setThinkingLevel(): void {},
        async cycleModel(): Promise<undefined> {
            return undefined;
        },
        cycleThinkingLevel(): undefined {
            return undefined;
        },
        agent: {} as StageSessionRuntime["agent"],
        model: undefined,
        thinkingLevel: "medium" as StageSessionRuntime["thinkingLevel"],
        messages: [],
        isStreaming: false,
        async navigateTree(): Promise<{ cancelled: boolean }> {
            return { cancelled: true };
        },
        async compact(): ReturnType<StageSessionRuntime["compact"]> {
            return undefined as unknown as Awaited<
                ReturnType<StageSessionRuntime["compact"]>
            >;
        },
        abortCompaction(): void {},
        async abort(): Promise<void> {},
        dispose(): void {},
        getLastAssistantText(): string | undefined {
            return last;
        },
    };
}

function deferred(): {
    readonly promise: Promise<void>;
    readonly resolve: () => void;
    readonly reject: (reason?: unknown) => void;
} {
    let resolvePromise: (() => void) | undefined;
    let rejectPromise: ((reason?: unknown) => void) | undefined;
    const promise = new Promise<void>((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
    });
    return {
        promise,
        resolve: () => resolvePromise?.(),
        reject: (reason?: unknown) => rejectPromise?.(reason),
    };
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        if (predicate()) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    assert.fail(message);
}

function makeFakeAtomicSdk(
    defaultAgentDir: string,
    builtinPackagePaths: string[] = [],
): {
    readonly sdk: PiCodingAgentSdk;
    readonly loaderOptions: Array<{
        cwd: string;
        agentDir: string;
        settingsManager?: PiSdkSettingsManager;
        builtinPackagePaths?: PackageSource[];
        resourceLoaderInheritanceSnapshot?: DefaultResourceLoaderInheritanceSnapshot;
    }>;
    readonly settingsCalls: Array<{
        cwd?: string;
        agentDir?: string;
        options?: { projectTrusted?: boolean };
    }>;
    readonly reloads: PiSdkResourceLoader[];
} {
    const loaderOptions: Array<{
        cwd: string;
        agentDir: string;
        settingsManager?: PiSdkSettingsManager;
        builtinPackagePaths?: PackageSource[];
        resourceLoaderInheritanceSnapshot?: DefaultResourceLoaderInheritanceSnapshot;
    }> = [];
    const settingsCalls: Array<{
        cwd?: string;
        agentDir?: string;
        options?: { projectTrusted?: boolean };
    }> = [];
    const reloads: PiSdkResourceLoader[] = [];

    class FakeResourceLoader implements PiSdkResourceLoader {
        constructor(options: {
            cwd: string;
            agentDir: string;
            settingsManager?: PiSdkSettingsManager;
            builtinPackagePaths?: PackageSource[];
            resourceLoaderInheritanceSnapshot?: DefaultResourceLoaderInheritanceSnapshot;
        }) {
            loaderOptions.push(options);
        }

        async reload(): Promise<void> {
            reloads.push(this);
        }
    }

    const sdk: PiCodingAgentSdk = {
        getAgentDir: () => defaultAgentDir,
        getBuiltinPackagePaths: () => builtinPackagePaths,
        SettingsManager: {
            create(
                cwd?: string,
                agentDir?: string,
                options?: { projectTrusted?: boolean },
            ): PiSdkSettingsManager {
                settingsCalls.push({ cwd, agentDir, options });
                return {
                    getCodexFastModeSettings: () => ({
                        chat: false,
                        workflow: false,
                    }),
                };
            },
        },
        DefaultResourceLoader: FakeResourceLoader,
        async createAgentSession(): Promise<{ session: StageSessionRuntime }> {
            return { session: fakeSession() };
        },
    };

    return { sdk, loaderOptions, settingsCalls, reloads };
}

describe("buildRuntimeAdapters — SDK AgentSession adapter", () => {
    test("provides an agentSession adapter without requiring pi.exec", () => {
        const adapters = buildRuntimeAdapters({});
        assert.notEqual(adapters.agentSession, undefined);
        assert.equal(adapters.prompt, undefined);
        assert.equal(adapters.complete, undefined);
        assert.equal(
            Object.prototype.hasOwnProperty.call(adapters, "subagent"),
            false,
        );
    });

    test("falls back to the pi SDK createAgentSession in production (NODE_ENV unset) — proves pi-coding-agent ≥ 0.74 integration", () => {
        // The pi SDK (`@bastani/atomic` ≥ 0.74) exposes
        // `createAgentSession` as a top-level package export, NOT on the
        // ExtensionAPI surface. The workflow extension MUST resolve a default
        // session factory from that package in production (no test context,
        // no caller-provided seam). Otherwise stages that rely on the default
        // SDK-backed prompt() path crash with "prompt adapter not configured"
        // at runtime.
        const savedNodeEnv = process.env["NODE_ENV"];
        const savedNodeTestCtx = process.env["NODE_TEST_CONTEXT"];
        delete process.env["NODE_ENV"];
        delete process.env["NODE_TEST_CONTEXT"];
        try {
            const adapters = buildRuntimeAdapters({});
            assert.notEqual(
                adapters.agentSession,
                undefined,
                "production buildRuntimeAdapters MUST wire an agentSession adapter via the pi SDK; got undefined.",
            );
        } finally {
            if (savedNodeEnv === undefined) delete process.env["NODE_ENV"];
            else process.env["NODE_ENV"] = savedNodeEnv;
            if (savedNodeTestCtx === undefined)
                delete process.env["NODE_TEST_CONTEXT"];
            else process.env["NODE_TEST_CONTEXT"] = savedNodeTestCtx;
        }
    });

    test("agentSession.create delegates to createAgentSession seam", async () => {
        const calls: Array<CreateAgentSessionOptions | undefined> = [];
        const adapters = buildRuntimeAdapters(
            {},
            {
                createAgentSession: async (options) => {
                    calls.push(options);
                    return { session: fakeSession() };
                },
            },
        );
        const result = await adapters.agentSession!.create({
            cwd: "/tmp/project",
        });
        assert.equal(
            "session" in result ? result.session.sessionId : result.sessionId,
            "session-1",
        );
        assert.equal(calls[0]?.cwd, "/tmp/project");
    });

    test("agentSession.create returns the SDK-prepared settings manager for workflow metadata", async () => {
        const settingsManager = {
            getCodexFastModeSettings: () => ({ chat: false, workflow: true }),
        };
        const adapters = buildRuntimeAdapters(
            {},
            {
                createAgentSession: async () => ({
                    session: fakeSession(),
                    settingsManager,
                }),
            },
        );

        const result = await adapters.agentSession!.create({
            cwd: "/tmp/project",
        });

        assert.equal(
            "session" in result ? result.settingsManager : undefined,
            settingsManager,
        );
    });

    test("agentSession.create marks workflow stages with orchestration constraints and excludes workflow tool", async () => {
        const calls: Array<CreateAgentSessionOptions | undefined> = [];
        const adapters = buildRuntimeAdapters(
            {},
            {
                createAgentSession: async (options) => {
                    calls.push(options);
                    return { session: fakeSession() };
                },
            },
        );

        await adapters.agentSession!.create(
            {
                cwd: "/tmp/project",
                excludedTools: ["ask_user_question", "workflow"],
            },
            { runId: "run-1", stageId: "stage-1", stageName: "Implement" },
        );

        assert.deepEqual(calls[0]?.excludedTools, [
            "ask_user_question",
            "workflow",
        ]);
        assert.deepEqual(calls[0]?.orchestrationContext, {
            kind: "workflow-stage",
            workflowRunId: "run-1",
            workflowStageId: "stage-1",
            workflowStageName: "Implement",
            constraints: { disableWorkflowTool: true, maxSubagentDepth: 5 },
        });
    });

    test("interactive stage sessions exclude workflow without blocking opt-in structured_output", async () => {
        const calls: Array<CreateAgentSessionOptions | undefined> = [];
        const adapters = buildRuntimeAdapters(
            {},
            {
                createAgentSession: async (options) => {
                    calls.push(options);
                    return { session: fakeSession() };
                },
            },
        );

        await adapters.agentSession!.create(
            { cwd: "/tmp/project" },
            {
                runId: "run-1",
                stageId: "stage-1",
                stageName: "Implement",
                executionMode: "interactive",
            },
        );

        assert.deepEqual(calls[0]?.excludedTools, ["workflow"]);
        assert.equal(calls[0]?.excludedTools?.includes("structured_output"), false);
    });

    test("non-interactive stage sessions exclude ask_user_question without blocking opt-in structured_output", async () => {
        const calls: Array<CreateAgentSessionOptions | undefined> = [];
        let bindCalls = 0;
        const session = {
            ...fakeSession(),
            async bindExtensions(): Promise<void> {
                bindCalls += 1;
            },
        } satisfies StageSessionRuntime & { bindExtensions(): Promise<void> };
        const adapters = buildRuntimeAdapters(
            {},
            {
                createAgentSession: async (options) => {
                    calls.push(options);
                    return { session };
                },
            },
        );

        await adapters.agentSession!.create(
            { cwd: "/tmp/project" },
            {
                runId: "run-1",
                stageId: "stage-1",
                stageName: "Implement",
                executionMode: "non_interactive",
            },
        );

        assert.deepEqual(calls[0]?.excludedTools, [
            "workflow",
            "ask_user_question",
        ]);
        assert.equal(calls[0]?.excludedTools?.includes("structured_output"), false);
        assert.equal(bindCalls, 0);
    });
});
