import { afterEach, beforeEach, test } from "bun:test";
import { Type } from "typebox";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    RESUME_CONTINUATION_PROMPT,
    run,
    resolveInputs,
} from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { stageUiBroker, type StageCustomUiRequest } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import {
    WORKFLOW_AUTH_FAILURE_MESSAGE,
    WORKFLOW_INVALID_PROVIDER_CREDENTIALS_MESSAGE,
    WORKFLOW_MISSING_API_KEY_FAILURE_MESSAGE,
    WORKFLOW_UNKNOWN_MODEL_MESSAGE,
} from "../../packages/workflows/src/shared/workflow-failures.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { setDurableBackend, createInMemoryTestBackend } from "../../packages/workflows/src/durable/factory.js";
import type { AgentSession, CreateAgentSessionOptions, ToolDefinition } from "@bastani/atomic";
import type {
    WorkflowCustomUiFactory,
    WorkflowCustomUiOptions,
    WorkflowDefinition,
    WorkflowUIAdapter,
} from "../../packages/workflows/src/shared/types.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";

async function waitForExecutorStagePendingPrompt(
    store: ReturnType<typeof createStore>,
    timeoutMs = 1000,
): Promise<{ runId: string; stageId: string; promptId: string }> {
    const pending = await waitForExecutorStagePendingPrompts(
        store,
        1,
        timeoutMs,
    );
    const stage = pending.stages[0]!;
    return {
        runId: pending.runId,
        stageId: stage.id,
        promptId: stage.pendingPrompt!.id,
    };
}

async function waitForExecutorStagePendingPrompts(
    store: ReturnType<typeof createStore>,
    count: number,
    timeoutMs = 1000,
): Promise<{ runId: string; stages: StageSnapshot[] }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        for (const runSnapshot of store.runs()) {
            const stages = runSnapshot.stages.filter(
                (stage) => stage.pendingPrompt !== undefined,
            );
            if (stages.length === count) {
                return { runId: runSnapshot.id, stages };
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`${count} stage pending prompts did not appear`);
}

async function waitForExecutorCustomPromptStage(
    store: ReturnType<typeof createStore>,
    timeoutMs = 1000,
): Promise<{ runId: string; stage: StageSnapshot }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        for (const runSnapshot of store.runs()) {
            const stage = runSnapshot.stages.find(
                (candidate) =>
                    candidate.status === "awaiting_input" &&
                    candidate.promptFootprint?.kind === "custom",
            );
            if (stage) return { runId: runSnapshot.id, stage };
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("custom prompt stage did not appear");
}

function resolveExecutorCustomPrompt<T>(
    runId: string,
    stageId: string,
    value: T,
): void {
    let request: StageCustomUiRequest<T> | undefined;
    const unregister = stageUiBroker.registerHost(runId, stageId, {
        showCustomUi: (next) => {
            request = next as StageCustomUiRequest<T>;
        },
    });
    try {
        if (request === undefined) {
            throw new Error("custom prompt broker request did not appear");
        }
        stageUiBroker.resolve(request, value);
    } finally {
        unregister();
    }
}

function callThroughStack<T>(depth: number, fn: () => Promise<T>): Promise<T> {
    if (depth <= 0) return fn();
    return callThroughStack(depth - 1, fn);
}

let savedGitEnv: Map<string, string | undefined> | undefined;

beforeEach(() => {
    // DBOS-only durability throws before readiness; inject an internal
    // in-memory test backend so executor tests run without a live DBOS.
    setDurableBackend(createInMemoryTestBackend());
    savedGitEnv = new Map<string, string | undefined>();
    for (const key of Object.keys(process.env).filter((candidate) =>
        candidate.startsWith("GIT_"),
    )) {
        savedGitEnv.set(key, process.env[key]);
        delete process.env[key];
    }
});

afterEach(() => {
    if (savedGitEnv === undefined) return;
    for (const [key, value] of savedGitEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    savedGitEnv = undefined;
});

// ---------------------------------------------------------------------------
// resolveInputs

import { createCancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import {
    killRun,
    pauseRun,
    resumeRun,
} from "../../packages/workflows/src/runs/background/status.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner.js";

function deferred<T = void>(): PromiseWithResolvers<T> {
    return Promise.withResolvers<T>();
}

async function waitForMicrotasks(): Promise<void> {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => queueMicrotask(resolve));
}

async function sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitForPromptCall(
    promptCalls: readonly string[],
    text: string,
    occurrence = 1,
    timeoutMs = 1000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const count = promptCalls.filter((call) => call === text).length;
        if (count >= occurrence) return;
        await sleep(5);
    }
    throw new Error(`prompt ${JSON.stringify(text)} occurrence ${occurrence} did not appear`);
}

function mockSession(): StageSessionRuntime {
    const listeners = new Set<
        (e: { type: string; [k: string]: unknown }) => void
    >();
    void listeners;
    return {
        async prompt() {
            // Resolve immediately to keep the executor's tracked call short.
        },
        async steer() {},
        async followUp() {},
        subscribe() {
            return () => {};
        },
        sessionFile: "/tmp/atomic-test-session.ndjson",
        sessionId: "sess-test-1",
        async setModel() {},
        setThinkingLevel() {},
        cycleModel: (async () =>
            undefined) as StageSessionRuntime["cycleModel"],
        cycleThinkingLevel: (() =>
            undefined) as StageSessionRuntime["cycleThinkingLevel"],
        agent: undefined as unknown as AgentSession["agent"],
        model: undefined as AgentSession["model"],
        thinkingLevel: "medium" as AgentSession["thinkingLevel"],
        messages: [] as AgentSession["messages"],
        isStreaming: false,
        navigateTree: (async () => ({
            cancelled: false,
        })) as StageSessionRuntime["navigateTree"],
        compact:
            (async () => ({})) as unknown as StageSessionRuntime["compact"],
        abortCompaction() {},
        async abort() {},
        dispose() {},
        getLastAssistantText() {
            return "ok";
        },
    };
}


function makeSmartSession(events: string[]): () => StageSessionRuntime {
    return (): StageSessionRuntime => {
        const listeners = new Set<
            (e: { type: string; [k: string]: unknown }) => void
        >();
        const emit = (e: { type: string; [k: string]: unknown }): void => {
            for (const l of [...listeners]) l(e);
        };
        return {
            ...mockSession(),
            async prompt(text: string) {
                if (text.includes("ask the user")) {
                    events.push("ask");
                    emit({
                        type: "tool_execution_start",
                        toolCallId: "c",
                        toolName: "ask_user_question",
                    });
                    emit({
                        type: "tool_execution_end",
                        toolCallId: "c",
                        toolName: "ask_user_question",
                    });
                } else {
                    events.push(`turn:${text}`);
                }
                emit({ type: "agent_end", messages: [] });
            },
            subscribe(listener) {
                listeners.add(
                    listener as (e: {
                        type: string;
                        [k: string]: unknown;
                    }) => void,
                );
                return () =>
                    listeners.delete(
                        listener as (e: {
                            type: string;
                            [k: string]: unknown;
                        }) => void,
                    );
            },
        };
    };
}

function structuredOutputMockSession(
    options: CreateAgentSessionOptions,
    payload: Record<string, unknown>,
): StageSessionRuntime {
    const listeners = new Set<
        (e: { type: string; [k: string]: unknown }) => void
    >();
    const messages: AgentSession["messages"] = [] as AgentSession["messages"];
    const base = mockSession();
    const structuredTool = options.customTools?.find(
        (tool): tool is ToolDefinition => tool.name === "structured_output",
    );
    return {
        ...base,
        async prompt() {
            if (!structuredTool) {
                messages.push({
                    role: "assistant",
                    content: [{ type: "text", text: "plain" }],
                } as AgentSession["messages"][number]);
                return;
            }
            messages.push({
                role: "assistant",
                content: [{ type: "toolCall", id: "structured-call", name: "structured_output" }],
            } as AgentSession["messages"][number]);
            const result = await structuredTool.execute(
                "structured-call",
                payload as Parameters<ToolDefinition["execute"]>[1],
                undefined,
                undefined,
                {} as Parameters<ToolDefinition["execute"]>[4],
            );
            for (const listener of listeners) {
                listener({
                    type: "tool_execution_end",
                    toolCallId: "structured-call",
                    toolName: "structured_output",
                    result,
                });
            }
            messages.push({
                role: "toolResult",
                toolCallId: "structured-call",
                toolName: "structured_output",
                content: result.content,
            } as AgentSession["messages"][number]);
        },
        subscribe(listener) {
            listeners.add(listener as (e: { type: string; [k: string]: unknown }) => void);
            return () => {
                listeners.delete(listener as (e: { type: string; [k: string]: unknown }) => void);
            };
        },
        get messages() {
            return messages;
        },
        getLastAssistantText() {
            return structuredTool ? undefined : "plain";
        },
    };
}


export {
    afterEach,
    assert,
    beforeEach,
    callThroughStack,
    createCancellationRegistry,
    createRegistry,
    createStageControlRegistry,
    createStore,
    deferred,
    workflow,
    join,
    killRun,
    mkdtempSync,
    mockSession,
    makeSmartSession,
    pauseRun,
    readFileSync,
    RESUME_CONTINUATION_PROMPT,
    resolveExecutorCustomPrompt,
    resolveInputs,
    resumeRun,
    run,
    sleep,
    stageUiBroker,
    structuredOutputMockSession,
    test,
    tmpdir,
    Type,
    waitForExecutorCustomPromptStage,
    waitForExecutorStagePendingPrompt,
    waitForExecutorStagePendingPrompts,
    waitForMicrotasks,
    waitForPromptCall,
    WORKFLOW_AUTH_FAILURE_MESSAGE,
    WORKFLOW_INVALID_PROVIDER_CREDENTIALS_MESSAGE,
    WORKFLOW_MISSING_API_KEY_FAILURE_MESSAGE,
    WORKFLOW_UNKNOWN_MODEL_MESSAGE,
};
export type { AgentSession, CreateAgentSessionOptions, StageCustomUiRequest, StageSessionRuntime, StageSnapshot, ToolDefinition, WorkflowCustomUiFactory, WorkflowCustomUiOptions, WorkflowDefinition, WorkflowUIAdapter };
