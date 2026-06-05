/**
 * Tests for buildRuntimeAdapters — pi AgentSession wiring.
 *
 * The legacy `buildUIAdapter` (pi.ui → WorkflowUIAdapter for HIL) was removed
 * when workflows became background-only — HIL prompts now route through the
 * store-backed background adapter (see `background-ui-adapter.test.ts`).
 */

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    buildRuntimeAdapters,
    prepareAtomicStageSessionOptions,
} from "../../packages/workflows/src/extension/wiring.js";
import { StageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { SessionManager, type CreateAgentSessionOptions, type SessionHeader } from "@bastani/atomic";
import type {
    PiCodingAgentSdk,
    PiSdkResourceLoader,
    PiSdkSettingsManager,
} from "../../packages/workflows/src/extension/wiring.js";
import type { StageSessionCreateOptions, StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import type { StageExecutionMeta, StageOptions } from "../../packages/workflows/src/shared/types.js";

async function writeSessionHeader(path: string, cwd: string): Promise<void> {
    const timestamp = new Date().toISOString();
    await writeFile(
        path,
        `${JSON.stringify({
            type: "session",
            version: 3,
            id: "source-session",
            timestamp,
            cwd,
        })}\n`,
        "utf8",
    );
}

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

function makeFakeAtomicSdk(
    defaultAgentDir: string,
    builtinPackagePaths: string[] = [],
): {
    readonly sdk: PiCodingAgentSdk;
    readonly loaderOptions: Array<{
        cwd: string;
        agentDir: string;
        settingsManager?: PiSdkSettingsManager;
        builtinPackagePaths?: string[];
    }>;
    readonly settingsCalls: Array<{ cwd?: string; agentDir?: string }>;
    readonly reloads: PiSdkResourceLoader[];
} {
    const loaderOptions: Array<{
        cwd: string;
        agentDir: string;
        settingsManager?: PiSdkSettingsManager;
        builtinPackagePaths?: string[];
    }> = [];
    const settingsCalls: Array<{ cwd?: string; agentDir?: string }> = [];
    const reloads: PiSdkResourceLoader[] = [];

    class FakeResourceLoader implements PiSdkResourceLoader {
        constructor(options: {
            cwd: string;
            agentDir: string;
            settingsManager?: PiSdkSettingsManager;
            builtinPackagePaths?: string[];
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
            create(cwd?: string, agentDir?: string): PiSdkSettingsManager {
                settingsCalls.push({ cwd, agentDir });
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

    test("loads non-workflow Atomic builtin package extensions for workflow stage sessions", async () => {
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
            "/repo/packages/subagents",
            "/repo/packages/mcp",
            "/repo/packages/web-access",
            "/repo/packages/intercom",
        ]);
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
            constraints: { disableWorkflowTool: true, maxSubagentDepth: 1 },
        });
    });

    test("interactive stage sessions exclude workflow but keep ask_user_question available", async () => {
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
    });

    test("non-interactive stage sessions exclude ask_user_question and do not bind UI", async () => {
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

    test("strips workflow provenance internals before calling createAgentSession", async () => {
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
        const stageOptions: StageOptions = {
            cwd: "/tmp/project",
            context: "fork",
            forkFromSessionFile: "/tmp/source.jsonl",
            sessionDir: "/tmp/sessions",
            gitWorktreeDir: "/tmp/worktree",
            baseBranch: "main",
            fallbackThinkingLevels: ["low"],
            workflowOriginSessionFile: "/tmp/chat.jsonl",
            workflowRunId: "run-1",
            workflowName: "workflow",
            workflowStageId: "stage-1",
            workflowStageName: "plan",
        };
        await adapters.agentSession!.create(stageOptions as StageSessionCreateOptions);
        const forwarded = calls[0]!;
        for (const key of [
            "context",
            "forkFromSessionFile",
            "sessionDir",
            "gitWorktreeDir",
            "baseBranch",
            "fallbackThinkingLevels",
            "workflowOriginSessionFile",
            "workflowRunId",
            "workflowName",
            "workflowStageId",
            "workflowStageName",
        ]) {
            assert.equal(Object.prototype.hasOwnProperty.call(forwarded, key), false, key);
        }
        assert.equal(forwarded.cwd, "/tmp/project");
    });

    test("default adapter creates Atomic session manager with workflow metadata from meta.stageOptions", async () => {
        const dir = await mkdtemp(join(tmpdir(), "pi-workflows-wiring-metadata-"));
        try {
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
            const meta: StageExecutionMeta = {
                runId: "run-1",
                stageId: "stage-1",
                stageName: "analyze",
                stageOptions: {
                    cwd: dir,
                    sessionDir: dir,
                    workflowOriginSessionFile: "/tmp/chat.jsonl",
                    workflowRunId: "run-1",
                    workflowName: "workflow-name",
                    workflowStageId: "stage-1",
                    workflowStageName: "analyze",
                },
            };

            await adapters.agentSession!.create({ cwd: dir }, meta);

            const forwarded = calls[0]!;
            const header = forwarded.sessionManager?.getHeader() as SessionHeader | undefined;
            assert.equal(header?.cwd, dir);
            assert.equal(header?.originSession, "/tmp/chat.jsonl");
            assert.equal(header?.workflowRunId, "run-1");
            assert.equal(header?.workflowName, "workflow-name");
            assert.equal(header?.workflowStageId, "stage-1");
            assert.equal(header?.workflowStageName, "analyze");
            assert.equal(Object.prototype.hasOwnProperty.call(forwarded, "workflowRunId"), false);
            assert.equal(Object.prototype.hasOwnProperty.call(forwarded, "sessionDir"), false);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("default adapter preserves explicit session managers instead of replacing them", async () => {
        const dir = await mkdtemp(join(tmpdir(), "pi-workflows-wiring-explicit-"));
        try {
            const explicitSessionManager = SessionManager.create(dir, dir);
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
            const meta: StageExecutionMeta = {
                runId: "run-1",
                stageId: "stage-1",
                stageName: "analyze",
                stageOptions: {
                    cwd: dir,
                    sessionDir: join(dir, "ignored-sessions"),
                    workflowRunId: "run-1",
                    workflowStageId: "stage-1",
                    workflowStageName: "analyze",
                },
            };

            await adapters.agentSession!.create(
                { cwd: dir, sessionManager: explicitSessionManager },
                meta,
            );

            assert.equal(calls[0]?.sessionManager, explicitSessionManager);
            const header = explicitSessionManager.getHeader() as SessionHeader;
            assert.equal(header.workflowRunId, undefined);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("default adapter forks Atomic session manager and writes fork provenance from meta.stageOptions", async () => {
        const dir = await mkdtemp(join(tmpdir(), "pi-workflows-wiring-fork-"));
        try {
            const source = join(dir, "source.jsonl");
            await writeSessionHeader(source, dir);
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
            const meta: StageExecutionMeta = {
                runId: "run-2",
                stageId: "stage-2",
                stageName: "plan",
                stageOptions: {
                    cwd: dir,
                    sessionDir: dir,
                    context: "fork",
                    forkFromSessionFile: source,
                    workflowOriginSessionFile: "/tmp/chat.jsonl",
                    workflowRunId: "run-2",
                    workflowName: "workflow-name",
                    workflowStageId: "stage-2",
                    workflowStageName: "plan",
                },
            };

            await adapters.agentSession!.create({ cwd: dir }, meta);

            const header = calls[0]?.sessionManager?.getHeader() as SessionHeader | undefined;
            assert.equal(header?.parentSession, source);
            assert.equal(header?.forkedFromSession, source);
            assert.equal(header?.originSession, "/tmp/chat.jsonl");
            assert.equal(header?.workflowRunId, "run-2");
            assert.equal(header?.workflowStageName, "plan");
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
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
