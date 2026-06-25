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
