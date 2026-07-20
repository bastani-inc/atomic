/**
 * Smoke tests for the three builtin workflows.
 * Validates definition shape, input schema, and that builtins are authored with
 * the high-level ctx.task / ctx.parallel / ctx.chain primitives.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
    TSchema,
    WorkflowChainOptions,
    WorkflowDefinition,
    WorkflowInputValues,
    WorkflowOutputValues,
    WorkflowParallelOptions,
    WorkflowRunChildArgs,
    WorkflowRunContext,
    WorkflowTaskOptions,
    WorkflowTaskResult,
    WorkflowTaskStep,
    WorkflowSerializableValue,
    WorkflowUIContext,
} from "../../packages/workflows/src/shared/types.js";
import {
    schemaChoices,
    schemaDefault,
    schemaDescription,
    schemaFieldKind,
    schemaIsRequired,
} from "../../packages/workflows/src/shared/schema-introspection.js";

// Derived legacy-descriptor views over a declared TypeBox schema — the same
// adapter the dispatcher/inputs action uses. Inputs/outputs are declared with
// TypeBox; these helpers read back the normalized field-kind / required /
// default / description / choices view, tolerating absent keys.
export function fieldKind(schema: TSchema | undefined): string | undefined {
    return schema === undefined ? undefined : schemaFieldKind(schema);
}
export function fieldRequired(schema: TSchema | undefined): boolean | undefined {
    return schema === undefined ? undefined : schemaIsRequired(schema);
}
export function fieldDefault(schema: TSchema | undefined): unknown {
    return schema === undefined ? undefined : schemaDefault(schema);
}
export function fieldDescription(schema: TSchema | undefined): string {
    return schema === undefined ? "" : (schemaDescription(schema) ?? "");
}
export function fieldChoices(schema: TSchema | undefined): readonly string[] {
    return schema === undefined ? [] : (schemaChoices(schema) ?? []);
}

export interface MockCalls {
    readonly stage: string[];
    readonly task: string[];
    readonly parallel: string[][];
    readonly parallelOptions: WorkflowParallelOptions[];
    readonly chain: string[][];
    readonly prompts: Record<string, string[]>;
    readonly taskOptions: Record<string, WorkflowTaskOptions[]>;
    readonly tool: string[];
}

interface MockResponders {
    task?: (
        name: string,
        options: WorkflowTaskOptions,
        calls: MockCalls,
    ) => string | undefined;
    sessionFile?: (
        name: string,
        options: WorkflowTaskOptions,
        calls: MockCalls,
    ) => string | undefined;
    parallel?: (
        steps: readonly WorkflowTaskStep[],
        options: WorkflowParallelOptions,
        calls: MockCalls,
    ) =>
        | Promise<WorkflowTaskResult[] | undefined>
        | WorkflowTaskResult[]
        | undefined;
    omitParallelResults?: readonly string[];
    skipOutputWrites?: readonly string[];
    /** Override a ctx.tool call, e.g. to replay a durably cached value. */
    tool?: (
        name: string,
        args: Readonly<Record<string, WorkflowSerializableValue>>,
        calls: MockCalls,
    ) => WorkflowSerializableValue | undefined;
}

export function promptText(options: WorkflowTaskOptions): string {
    return options.prompt ?? options.task ?? "";
}

export function makeTaskResult(
    name: string,
    text: string,
    sessionFile?: string,
    structured?: WorkflowTaskResult["structured"],
): WorkflowTaskResult {
    return {
        name,
        stageName: name,
        text,
        ...(structured === undefined ? {} : { structured }),
        ...(sessionFile === undefined ? {} : { sessionFile }),
    };
}

export function readPaths(
    options: WorkflowTaskOptions | undefined,
): readonly string[] {
    return Array.isArray(options?.reads) ? options.reads : [];
}

export function normalizePathSeparators(path: string): string {
    return path.replace(/\\/g, "/");
}

export function readPathEndsWith(
    options: WorkflowTaskOptions | undefined,
    suffix: string,
): boolean {
    const normalizedSuffix = normalizePathSeparators(suffix);
    return readPaths(options).some((path) =>
        normalizePathSeparators(path).endsWith(normalizedSuffix),
    );
}

export function expectedDeepResearchAggregatorReadCount(): number {
    return 5;
}

export function assertStringOutput(
    output: WorkflowTaskOptions["output"] | undefined,
): asserts output is string {
    assert.equal(typeof output, "string");
}

/** Mock WorkflowRunContext factory that records high-level SDK calls. */
export function makeMockCtx<TInputs extends WorkflowInputValues>(
    inputs: TInputs,
    responders: MockResponders = {},
): WorkflowRunContext<TInputs> & { calls: MockCalls } {
    const calls: MockCalls = {
        stage: [],
        task: [],
        parallel: [],
        parallelOptions: [],
        chain: [],
        prompts: {},
        taskOptions: {},
        tool: [],
    };

    const ui: WorkflowUIContext = {
        input: async (prompt: string) => `mock-input:${prompt.slice(0, 20)}`,
        confirm: async () => false,
        select: async <T extends string>(
            _message: string,
            options: readonly T[],
        ) => options[0]!,
        editor: async (initial?: string) => initial ?? "mock-editor-content",
        custom: async () => {
            throw new Error("mock custom UI unavailable");
        },
    };

    const runTask = async (
        name: string,
        options: WorkflowTaskOptions,
    ): Promise<WorkflowTaskResult> => {
        calls.task.push(name);
        const text = promptText(options);
        calls.prompts[name] = [...(calls.prompts[name] ?? []), text];
        calls.taskOptions[name] = [...(calls.taskOptions[name] ?? []), options];
        const override = responders.task?.(name, options, calls);
        const resultText =
            override ?? `[mock-task:${name}] ${text.slice(0, 80)}`;
        if (
            typeof options.output === "string" &&
            responders.skipOutputWrites?.includes(name) !== true
        ) {
            mkdirSync(dirname(options.output), { recursive: true });
            writeFileSync(options.output, resultText);
        }
        let structured: WorkflowTaskResult["structured"] | undefined;
        if (options.schema !== undefined) {
            try {
                structured = JSON.parse(resultText) as WorkflowTaskResult["structured"];
            } catch {
                structured = undefined;
            }
        }
        return makeTaskResult(
            name,
            resultText,
            responders.sessionFile?.(name, options, calls),
            structured,
        );
    };

    const ctx: WorkflowRunContext<TInputs> & { calls: MockCalls } = {
        inputs,
        calls,
        exit: () => {
            throw new Error("ctx.exit should not be used by builtin workflow mocks");
        },
        stage: (name: string) => {
            calls.stage.push(name);
            throw new Error(
                `ctx.stage should not be used by builtin workflow ${name}`,
            );
        },
        task: runTask,
        chain: async (
            steps: readonly WorkflowTaskStep[],
            _options?: WorkflowChainOptions,
        ): Promise<WorkflowTaskResult[]> => {
            calls.chain.push(steps.map((step) => step.name));
            const results: WorkflowTaskResult[] = [];
            for (const step of steps) {
                results.push(await runTask(step.name, step));
            }
            return results;
        },
        parallel: async (
            steps: readonly WorkflowTaskStep[],
            options: WorkflowParallelOptions = {},
        ): Promise<WorkflowTaskResult[]> => {
            calls.parallel.push(steps.map((step) => step.name));
            calls.parallelOptions.push(options);
            const override = await responders.parallel?.(steps, options, calls);
            if (override !== undefined) return override;
            const results = await Promise.all(
                steps.map((step) => runTask(step.name, step)),
            );
            const omitted = new Set(responders.omitParallelResults ?? []);
            return omitted.size === 0
                ? results
                : results.filter(
                      (result) =>
                          result.name === undefined ||
                          !omitted.has(result.name),
                  );
        },
        workflow: async <
            TChildInputs extends WorkflowInputValues,
            TChildOutputs extends WorkflowOutputValues,
            TChildRunInputs extends WorkflowInputValues = TChildInputs,
        >(
            target: WorkflowDefinition<TChildInputs, TChildOutputs, TChildRunInputs>,
            ..._args: WorkflowRunChildArgs<TChildRunInputs>
        ) => {
            throw new Error(
                `ctx.workflow should not be used by builtin workflow ${target.normalizedName}`,
            );
        },
        ui,
        tool: async <T extends WorkflowSerializableValue>(
            name: string,
            args: Readonly<Record<string, WorkflowSerializableValue>>,
            fn: () => Promise<T>,
        ): Promise<T> => {
            calls.tool.push(name);
            const override = responders.tool?.(name, args, calls);
            if (override !== undefined) return override as T;
            return fn();
        },
    };

    return ctx;
}

/** Assert a value is a valid WorkflowDefinition with the sentinel. */
export function assertWorkflowDefinition(
    def: unknown,
): asserts def is WorkflowDefinition {
    assert.notEqual(def, undefined);
    assert.equal(typeof def, "object");
    const d = def as WorkflowDefinition;
    assert.equal(d.__piWorkflow, true);
    assert.equal(typeof d.name, "string");
    assert.ok(d.name.length > 0);
    assert.equal(typeof d.normalizedName, "string");
    assert.equal(typeof d.description, "string");
    assert.equal(typeof d.run, "function");
    assert.equal(typeof d.inputs, "object");
}

export function assertOutputTypes(
    outputs: WorkflowDefinition["outputs"],
    expected: Readonly<Record<string, string>>,
): void {
    assert.notEqual(outputs, undefined);
    assert.deepEqual(
        Object.keys(outputs ?? {}).sort(),
        Object.keys(expected).sort(),
    );
    for (const [key, type] of Object.entries(expected)) {
        assert.equal(
            fieldKind(outputs?.[key]),
            type,
            `unexpected output type for ${key}`,
        );
        assert.ok(
            fieldDescription(outputs?.[key]).length > 0,
            `expected output description for ${key}`,
        );
    }
}

// ---------------------------------------------------------------------------
// deep-research-codebase
// ---------------------------------------------------------------------------

