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

    test("agentSession.create forwards stage options unchanged (pi SDK leaves resource isolation to SettingsManager)", async () => {
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
        await adapters.agentSession!.create({ cwd: "/tmp/project" });
        assert.equal(calls[0]?.cwd, "/tmp/project");
        // Per-call isolation knobs (`disableExtensionDiscovery`, `skills`,
        // `promptTemplates`, `slashCommands`) are not part of the pi SDK
        // surface — resource loading is owned by `SettingsManager` /
        // `ResourceLoader`. The SDK intentionally has no equivalent fields.
        assert.ok(!("disableExtensionDiscovery" in calls[0]!));
        assert.ok(!("skills" in calls[0]!));
        assert.ok(!("promptTemplates" in calls[0]!));
        assert.ok(!("slashCommands" in calls[0]!));
    });

    test("agentSession.create lets callers override fields the SDK still supports", async () => {
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
        await adapters.agentSession!.create({
            cwd: "/tmp/project",
            thinkingLevel: "high",
            noTools: "all",
        });
        assert.equal(calls[0]?.cwd, "/tmp/project");
        assert.equal(calls[0]?.thinkingLevel, "high");
        assert.equal(calls[0]?.noTools, "all");
    });

    test("strips workflow-only fallbackModels before calling createAgentSession", async () => {
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
        await adapters.agentSession!.create({
            cwd: "/tmp/project",
            fallbackModels: ["openai/fallback"],
        });
        assert.equal(
            Object.prototype.hasOwnProperty.call(calls[0], "fallbackModels"),
            false,
        );
        assert.equal(calls[0]?.cwd, "/tmp/project");
    });

    test("strips workflow-only mcp options before calling createAgentSession", async () => {
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
        await adapters.agentSession!.create({
            cwd: "/tmp/project",
            mcp: { allow: ["github"] },
        });
        assert.equal(
            Object.prototype.hasOwnProperty.call(calls[0], "mcp"),
            false,
        );
        assert.equal(calls[0]?.cwd, "/tmp/project");
    });

    test("binds a broker-backed UI context even when the parent pi surface has no ui", async () => {
        const store = createStore();
        store.recordRunStart({
            id: "run-1",
            name: "wf",
            inputs: {},
            status: "running",
            stages: [],
            startedAt: Date.now(),
        });
        store.recordStageStart("run-1", {
            id: "stage-1",
            name: "ask",
            status: "running",
            parentIds: [],
            toolEvents: [],
        });
        const broker = new StageUiBroker(store);
        let capturedUi:
            | {
                  custom<T>(
                      factory: Parameters<StageUiBroker["requestCustomUi"]>[2],
                  ): Promise<T>;
              }
            | undefined;
        const session = {
            ...fakeSession(),
            async bindExtensions(bindings: { uiContext?: typeof capturedUi }) {
                capturedUi = bindings.uiContext;
            },
        } satisfies StageSessionRuntime & {
            bindExtensions(bindings: {
                uiContext?: typeof capturedUi;
            }): Promise<void>;
        };
        const adapters = buildRuntimeAdapters(
            {},
            {
                stageUiBroker: broker,
                createAgentSession: async () => ({ session }),
            },
        );
        const meta: StageExecutionMeta = {
            runId: "run-1",
            stageId: "stage-1",
            stageName: "ask",
        };

        await adapters.agentSession!.create({}, meta);
        assert.ok(
            capturedUi,
            "stage sessions need a non-noop UI context so ask_user_question does not return no_ui",
        );
        const pending = capturedUi.custom<string>(() => ({
            render: () => ["question"],
            invalidate: () => {},
        }));
        assert.equal(store.runs()[0]?.stages[0]?.status, "awaiting_input");

        const unregister = broker.registerHost("run-1", "stage-1", {
            showCustomUi(request) {
                broker.resolve(request, "answered");
            },
        });
        assert.equal(await pending, "answered");
        unregister();
    });

    test("binds stage custom UI to the stage UI broker instead of parent overlays", async () => {
        const store = createStore();
        store.recordRunStart({
            id: "run-1",
            name: "wf",
            inputs: {},
            status: "running",
            stages: [],
            startedAt: Date.now(),
        });
        store.recordStageStart("run-1", {
            id: "stage-1",
            name: "ask",
            status: "running",
            parentIds: [],
            toolEvents: [],
        });
        const broker = new StageUiBroker(store);
        let capturedUi:
            | {
                  custom<T>(
                      factory: Parameters<StageUiBroker["requestCustomUi"]>[2],
                  ): Promise<T>;
              }
            | undefined;
        const session = {
            ...fakeSession(),
            async bindExtensions(bindings: { uiContext?: typeof capturedUi }) {
                capturedUi = bindings.uiContext;
            },
        } satisfies StageSessionRuntime & {
            bindExtensions(bindings: {
                uiContext?: typeof capturedUi;
            }): Promise<void>;
        };
        let parentOverlayCalls = 0;
        const adapters = buildRuntimeAdapters(
            {
                ui: {
                    theme: {},
                    custom() {
                        parentOverlayCalls += 1;
                    },
                },
            },
            {
                stageUiBroker: broker,
                createAgentSession: async () => ({ session }),
            },
        );
        const meta: StageExecutionMeta = {
            runId: "run-1",
            stageId: "stage-1",
            stageName: "ask",
        };

        await adapters.agentSession!.create({}, meta);
        assert.ok(capturedUi);
        const pending = capturedUi.custom<string>(() => ({
            render: () => ["question"],
            invalidate: () => {},
        }));
        assert.equal(store.runs()[0]?.stages[0]?.status, "awaiting_input");

        const unregister = broker.registerHost("run-1", "stage-1", {
            showCustomUi(request) {
                broker.resolve(request, "answered");
            },
        });
        assert.equal(await pending, "answered");
        assert.equal(parentOverlayCalls, 0);
        unregister();
    });
});
