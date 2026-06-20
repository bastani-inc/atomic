import type { AgentSession } from "@bastani/atomic";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type {
    AgentSessionAdapter,
    CompleteAdapter,
    InternalStageContext,
    PromptAdapter,
    StageRunnerOpts,
    StageSessionCreateOptions,
    StageSessionRuntime,
} from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { createStageContext } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import type {
    CompleteStageOpts,
    StageExecutionMeta,
    WorkflowModelInfo,
} from "../../packages/workflows/src/shared/types.js";

export {
    Type,
    assert,
    createStageContext,
    join,
    mkdtemp,
    readFile,
    rm,
    tmpdir,
    writeFile,
};
export type {
    AgentSession,
    AgentSessionAdapter,
    CompleteAdapter,
    CompleteStageOpts,
    InternalStageContext,
    PromptAdapter,
    StageExecutionMeta,
    StageRunnerOpts,
    StageSessionCreateOptions,
    StageSessionRuntime,
    WorkflowModelInfo,
};

export function makeSignal(): AbortSignal {
    return new AbortController().signal;
}

export function makeOpts(overrides: Partial<StageRunnerOpts> = {}): StageRunnerOpts {
    return {
        stageId: "stage-abc",
        stageName: "My Stage",
        runId: "run-xyz",
        adapters: {},
        ...overrides,
    };
}

export function makeMockSession(overrides: Partial<StageSessionRuntime> = {}): {
    session: StageSessionRuntime;
    state: {
        promptCalls: number;
        abortCalls: number;
        resolvers: Array<() => void>;
    };
    emit: (event: { type: string; [k: string]: unknown }) => void;
} {
    const state = {
        promptCalls: 0,
        abortCalls: 0,
        resolvers: [] as Array<() => void>,
    };
    const listeners = new Set<
        (e: { type: string; [k: string]: unknown }) => void
    >();
    const session: StageSessionRuntime = {
        async prompt() {
            state.promptCalls += 1;
            // Pretend the SDK is in-flight; return a controllable promise.
            return new Promise<void>((resolve, reject) => {
                state.resolvers.push(resolve);
                // Reject if abort is invoked.
                (session as { __reject?: (err: Error) => void }).__reject =
                    reject;
            });
        },
        async steer() {},
        async followUp() {},
        subscribe(listener) {
            listeners.add(listener as never);
            return () => listeners.delete(listener as never);
        },
        sessionFile: "/tmp/session.ndjson",
        sessionId: "sess-1",
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
        async abort() {
            state.abortCalls += 1;
            const reject = (session as { __reject?: (err: Error) => void })
                .__reject;
            reject?.(new Error("AbortError"));
        },
        dispose() {},
        getLastAssistantText() {
            return "ok";
        },
        ...overrides,
    };
    const emit = (event: { type: string; [k: string]: unknown }): void => {
        for (const listener of listeners) listener(event);
    };
    return { session, state, emit };
}

export function copilotOpusInfo(contextWindowOptions: readonly number[] = [200_000, 936_000]): WorkflowModelInfo {
    return {
        provider: "github-copilot",
        id: "claude-opus-4.8",
        fullId: "github-copilot/claude-opus-4.8",
        model: {
            provider: "github-copilot",
            id: "claude-opus-4.8",
            contextWindow: 200_000,
            defaultContextWindow: 200_000,
            contextWindowOptions,
        } as unknown as NonNullable<WorkflowModelInfo["model"]>,
    };
}

export function flushMicrotasks(times = 8): Promise<void> {
    return new Promise<void>((resolve) => {
        let i = times;
        const tick = (): void => {
            if (i-- <= 0) resolve();
            else queueMicrotask(tick);
        };
        tick();
    });
}
