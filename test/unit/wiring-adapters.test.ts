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

describe("prepareAtomicStageSessionOptions", () => {
    test("uses the Atomic default agent dir for resource loading without turning it into a user override", async () => {
        const projectDir = join("/tmp", "project");
        const atomicAgentDir = join("/home", "user", ".atomic", "agent");
        const { sdk, loaderOptions, settingsCalls, reloads } =
            makeFakeAtomicSdk(atomicAgentDir);

        const options = await prepareAtomicStageSessionOptions(
            { cwd: projectDir },
            sdk,
        );

        assert.equal(options?.cwd, projectDir);
        assert.equal(options?.agentDir, undefined);
        assert.equal(loaderOptions[0]?.cwd, projectDir);
        assert.equal(loaderOptions[0]?.agentDir, atomicAgentDir);
        assert.equal(settingsCalls[0]?.cwd, projectDir);
        assert.equal(settingsCalls[0]?.agentDir, atomicAgentDir);
        assert.equal(reloads.length, 1);
    });

    test("preserves a user-provided agentDir as an explicit single-directory override", async () => {
        const projectDir = join("/tmp", "project");
        const atomicAgentDir = join("/home", "user", ".atomic", "agent");
        const customAgentDir = join("/tmp", "custom-agent");
        const { sdk, loaderOptions } = makeFakeAtomicSdk(atomicAgentDir);

        const options = await prepareAtomicStageSessionOptions(
            { cwd: projectDir, agentDir: customAgentDir },
            sdk,
        );

        assert.equal(options?.agentDir, customAgentDir);
        assert.equal(loaderOptions[0]?.agentDir, customAgentDir);
    });

    test("disables only the recursive workflow extension for workflow stage sessions", async () => {
        const projectDir = join("/tmp", "project");
        const atomicAgentDir = join("/home", "user", ".atomic", "agent");
        const builtinPackagePaths = [
            "/repo/packages/workflows",
            "/repo/packages/subagents",
            "/repo/packages/mcp",
            "/repo/packages/web-access",
            "/repo/packages/intercom",
        ];
        const { sdk, loaderOptions } = makeFakeAtomicSdk(
            atomicAgentDir,
            builtinPackagePaths,
        );

        await prepareAtomicStageSessionOptions({ cwd: projectDir }, sdk);

        assert.deepEqual(loaderOptions[0]?.builtinPackagePaths, [
            { source: "/repo/packages/workflows", extensions: [] },
            "/repo/packages/subagents",
            "/repo/packages/mcp",
            "/repo/packages/web-access",
            "/repo/packages/intercom",
        ]);
    });

    test("passes inherited atomic -e resource options to fresh workflow stage loaders", async () => {
        const projectDir = join("/tmp", "project");
        const atomicAgentDir = join("/home", "user", ".atomic", "agent");
        const inheritedSnapshot: DefaultResourceLoaderInheritanceSnapshot = {
            projectTrusted: false,
            additionalExtensionPaths: ["/external-package/extensions/index.ts"],
            additionalSkillPaths: ["/external-package/.atomic/skills/inherited/SKILL.md"],
            additionalPromptTemplatePaths: ["/external-package/.atomic/prompts/review.md"],
            additionalThemePaths: ["/external-package/.atomic/themes/theme.json"],
            builtinPackagePaths: [
                "/repo/packages/workflows",
                {
                    source: "/repo/packages/subagents",
                    skills: ["skills/**"],
                },
            ],
            trustedBorrowedProjectLocalSources: ["/external-package"],
        };
        const { sdk, loaderOptions, settingsCalls, reloads } = makeFakeAtomicSdk(
            atomicAgentDir,
            ["/should/not/use/sdk/builtins"],
        );

        await prepareAtomicStageSessionOptions({ cwd: projectDir }, sdk, {
            resourceLoaderInheritanceSnapshot: inheritedSnapshot,
        });

        assert.equal(settingsCalls[0]?.options?.projectTrusted, false);
        assert.deepEqual(
            loaderOptions[0]?.resourceLoaderInheritanceSnapshot,
            inheritedSnapshot,
        );
        assert.deepEqual(loaderOptions[0]?.builtinPackagePaths, [
            { source: "/repo/packages/workflows", extensions: [] },
            { source: "/repo/packages/subagents", skills: ["skills/**"] },
        ]);
        assert.equal(reloads.length, 1);
    });

    test("preserves explicit resourceLoader overrides instead of inheriting parent resources", async () => {
        const projectDir = join("/tmp", "project");
        const atomicAgentDir = join("/home", "user", ".atomic", "agent");
        const { sdk, loaderOptions, settingsCalls, reloads } =
            makeFakeAtomicSdk(atomicAgentDir);
        const explicitResourceLoader = new DefaultResourceLoader({
            cwd: projectDir,
            agentDir: atomicAgentDir,
        });

        const options = await prepareAtomicStageSessionOptions(
            { cwd: projectDir, resourceLoader: explicitResourceLoader },
            sdk,
            {
                resourceLoaderInheritanceSnapshot: {
                    additionalExtensionPaths: ["/external-package"],
                    builtinPackagePaths: ["/repo/packages/workflows"],
                },
            },
        );

        assert.equal(options?.resourceLoader, explicitResourceLoader);
        assert.equal(loaderOptions.length, 0);
        assert.equal(settingsCalls.length, 0);
        assert.equal(reloads.length, 0);
    });

    test("serializes workflow stage resource reload env isolation", async () => {
        const projectDir = join("/tmp", "project");
        const atomicAgentDir = join("/home", "user", ".atomic", "agent");
        const envKeys = [
            "ATOMIC_SUBAGENT_CHILD",
            "ATOMIC_SUBAGENT_FANOUT_CHILD",
            "PI_SUBAGENT_CHILD",
            "PI_SUBAGENT_FANOUT_CHILD",
        ] as const;
        const savedEnv = new Map<string, string | undefined>(
            envKeys.map((key) => [key, process.env[key]]),
        );
        const reloadGates: Array<{
            readonly release: ReturnType<typeof deferred>;
            readonly envDuringReload: ReadonlyMap<string, string | undefined>;
        }> = [];

        class GatedResourceLoader implements PiSdkResourceLoader {
            constructor(_options: {
                cwd: string;
                agentDir: string;
                settingsManager?: PiSdkSettingsManager;
                builtinPackagePaths?: PackageSource[];
            }) {}

            async reload(): Promise<void> {
                const release = deferred();
                reloadGates.push({
                    release,
                    envDuringReload: new Map<string, string | undefined>(
                        envKeys.map((key) => [key, process.env[key]]),
                    ),
                });
                await release.promise;
            }
        }

        const sdk: PiCodingAgentSdk = {
            getAgentDir: () => atomicAgentDir,
            getBuiltinPackagePaths: () => [],
            SettingsManager: {
                create(): PiSdkSettingsManager {
                    return {
                        getCodexFastModeSettings: () => ({
                            chat: false,
                            workflow: false,
                        }),
                    };
                },
            },
            DefaultResourceLoader: GatedResourceLoader,
            async createAgentSession(): Promise<{ session: StageSessionRuntime }> {
                return { session: fakeSession() };
            },
        };

        let first: ReturnType<typeof prepareAtomicStageSessionOptions> | undefined;
        let second: ReturnType<typeof prepareAtomicStageSessionOptions> | undefined;
        try {
            process.env.ATOMIC_SUBAGENT_CHILD = "1";
            process.env.ATOMIC_SUBAGENT_FANOUT_CHILD = "0";
            process.env.PI_SUBAGENT_CHILD = "legacy-child";
            delete process.env.PI_SUBAGENT_FANOUT_CHILD;

            first = prepareAtomicStageSessionOptions({ cwd: projectDir }, sdk);
            await waitUntil(
                () => reloadGates.length >= 1,
                "expected the first resource reload to start",
            );
            second = prepareAtomicStageSessionOptions({ cwd: projectDir }, sdk);
            await new Promise<void>((resolve) => setTimeout(resolve, 0));

            assert.deepEqual(
                Object.fromEntries(reloadGates[0]!.envDuringReload),
                {
                    ATOMIC_SUBAGENT_CHILD: undefined,
                    ATOMIC_SUBAGENT_FANOUT_CHILD: undefined,
                    PI_SUBAGENT_CHILD: undefined,
                    PI_SUBAGENT_FANOUT_CHILD: undefined,
                },
            );

            reloadGates[0]!.release.resolve();
            await waitUntil(
                () => reloadGates.length >= 2,
                "expected the second resource reload to start after the first completes",
            );
            assert.deepEqual(
                Object.fromEntries(reloadGates[1]!.envDuringReload),
                {
                    ATOMIC_SUBAGENT_CHILD: undefined,
                    ATOMIC_SUBAGENT_FANOUT_CHILD: undefined,
                    PI_SUBAGENT_CHILD: undefined,
                    PI_SUBAGENT_FANOUT_CHILD: undefined,
                },
            );

            reloadGates[1]!.release.resolve();
            await Promise.all([first, second]);

            assert.equal(process.env.ATOMIC_SUBAGENT_CHILD, "1");
            assert.equal(process.env.ATOMIC_SUBAGENT_FANOUT_CHILD, "0");
            assert.equal(process.env.PI_SUBAGENT_CHILD, "legacy-child");
            assert.equal(process.env.PI_SUBAGENT_FANOUT_CHILD, undefined);
        } finally {
            for (const gate of reloadGates) gate.release.resolve();
            const pendingReloads: Array<ReturnType<typeof prepareAtomicStageSessionOptions>> = [];
            if (first !== undefined) pendingReloads.push(first);
            if (second !== undefined) pendingReloads.push(second);
            await Promise.allSettled(pendingReloads);
            for (const key of envKeys) {
                const value = savedEnv.get(key);
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        }
    });
});

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
            constraints: { disableWorkflowTool: true, maxSubagentDepth: 2 },
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
