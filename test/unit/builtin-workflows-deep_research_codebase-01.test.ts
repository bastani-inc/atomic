// @ts-nocheck
import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { WorkflowDefinition } from "../../packages/workflows/src/types.js";
import {
    assertOutputTypes,
    assertStringOutput,
    assertWorkflowDefinition,
    expectedDeepResearchAggregatorReadCount,
    fieldChoices,
    fieldDefault,
    fieldDescription,
    fieldKind,
    fieldRequired,
    makeMockCtx,
    makeTaskResult,
    normalizePathSeparators,
    promptText,
    readPathEndsWith,
    readPaths,
} from "./builtin-workflows-helpers.js";

describe("deep-research-codebase", () => {    let tempCwd: string | undefined;

    beforeEach(() => {
        tempCwd = mkdtempSync(join(tmpdir(), "atomic-deep-research-test-"));
    });

    afterEach(() => {
        if (tempCwd !== undefined) {
            rmSync(tempCwd, { recursive: true, force: true });
            tempCwd = undefined;
        }
    });

    function requireDeepResearchTempCwd(): string {
        if (tempCwd === undefined)
            throw new Error("expected deep research temp cwd");
        return tempCwd;
    }

    async function withDeepResearchTempCwd<T>(
        fn: () => Promise<T> | T,
    ): Promise<T> {
        const previousCwd = process.cwd();
        process.chdir(requireDeepResearchTempCwd());
        try {
            return await fn();
        } finally {
            process.chdir(previousCwd);
        }
    }

    test("loads and has correct shape", async () => {
        const mod =
            await import("../../packages/workflows/builtin/deep-research-codebase.js");
        const def = mod.default as unknown as WorkflowDefinition;
        assertWorkflowDefinition(def);
        assert.equal(def.name, "deep-research-codebase");
        assert.equal(def.normalizedName, "deep-research-codebase");
    });

    test("reserves discovery guidance for comprehensive whole-repository research", async () => {
        const mod =
            await import("../../packages/workflows/builtin/deep-research-codebase.js");
        assert.equal(
            mod.default.description,
            "Heavy research for tasks requiring comprehensive, whole-repository context.",
        );
    });

    test("has prompt, max_partitions, and max_concurrency inputs", async () => {
        const mod =
            await import("../../packages/workflows/builtin/deep-research-codebase.js");
        const d = mod.default;
        assert.equal(fieldRequired(d.inputs["prompt"]), true);
        assert.match(fieldKind(d.inputs["prompt"]) ?? "", /^(text|string)$/);
        assert.equal(fieldKind(d.inputs["max_partitions"]), "number");
        assert.equal(fieldDefault(d.inputs["max_partitions"]), 100);
        assert.equal(fieldKind(d.inputs["max_concurrency"]), "number");
        assert.equal(fieldDefault(d.inputs["max_concurrency"]), 100);
        assert.deepEqual(Object.keys(d.inputs).sort(), [
            "max_concurrency",
            "max_partitions",
            "prompt",
        ]);
    });

    test("declares child workflow output contract", async () => {
        const mod =
            await import("../../packages/workflows/builtin/deep-research-codebase.js");
        assertOutputTypes(mod.default.outputs, {
            artifact_dir: "text",
            explorer_count: "number",
            findings: "text",
            result: "text",
            history: "text",
            manifest_path: "text",
            max_concurrency: "number",
            partitions: "array",
            research_doc_path: "text",
            specialist_count: "number",
        });
    });

    test("runs scout/history, specialist waves, and aggregator via task primitives", async () => {
        const mod =
            await import("../../packages/workflows/builtin/deep-research-codebase.js");
        const ctx = makeMockCtx(
            {
                prompt: "What does the auth module do?",
                max_partitions: 2,
                max_concurrency: 2,
            },
            {
                task: (name) => {
                    if (name === "partition")
                        return "auth logic\ntoken validation";
                    return undefined;
                },
            },
        );

        const result = await withDeepResearchTempCwd(() =>
            mod.default.run(ctx),
        );

        assert.deepEqual(ctx.calls.stage, []);
        assert.ok(
            ctx.calls.parallel.some(
                (names) =>
                    names.includes("codebase-scout") &&
                    names.includes("history-locator"),
            ),
        );
        assert.deepEqual(ctx.calls.chain[0], ["history-analyzer"]);
        assert.ok(
            ctx.calls.parallel.some(
                (names) =>
                    names.includes("locator-1") &&
                    names.includes("pattern-finder-2"),
            ),
        );
        assert.ok(
            ctx.calls.parallel.some(
                (names) =>
                    names.includes("analyzer-1") &&
                    names.includes("online-researcher-2"),
            ),
        );
        assert.ok(
            ctx.calls.parallelOptions.every(
                (options) => options.concurrency === 2,
            ),
        );
        assert.ok(ctx.calls.task.includes("aggregator"));
        assert.equal(typeof result["findings"], "string");
        assert.deepEqual(result["partitions"], [
            "auth logic",
            "token validation",
        ]);
        assert.equal(result["specialist_count"], 8);
        assert.equal(result["max_concurrency"], 2);
        assert.equal("artifact_root" in result, false);
        assert.equal("artifact_count" in result, false);
        assert.equal(typeof result["research_doc_path"], "string");
    });

    test("uses artifact handoffs so aggregation stays bounded", async () => {
        const mod =
            await import("../../packages/workflows/builtin/deep-research-codebase.js");
        const largeSentinel = "SPECIALIST_INLINE_SENTINEL".repeat(200);
        const ctx = makeMockCtx(
            {
                prompt: "Trace auth behavior",
                max_partitions: 2,
                max_concurrency: 2,
            },
            {
                task: (name) => {
                    if (name === "partition")
                        return "auth logic\ntoken validation";
                    if (
                        /^(locator|pattern-finder|analyzer|online-researcher)-/.test(
                            name,
                        )
                    ) {
                        return `${name}: ${largeSentinel}`;
                    }
                    return undefined;
                },
            },
        );

        const result = await withDeepResearchTempCwd(() =>
            mod.default.run(ctx),
        );
        const aggregatorOptions = ctx.calls.taskOptions["aggregator"]?.[0];
        const aggregatorPrompt = ctx.calls.prompts["aggregator"]?.[0] ?? "";
        const normalizedAggregatorPrompt =
            normalizePathSeparators(aggregatorPrompt);
        const aggregatorReads = readPaths(aggregatorOptions);

        assert.deepEqual(result["partitions"], [
            "auth logic",
            "token validation",
        ]);
        assert.equal(aggregatorOptions?.previous, undefined);
        assert.ok(Array.isArray(aggregatorOptions?.reads));
        assert.equal(
            aggregatorReads.length,
            expectedDeepResearchAggregatorReadCount(),
        );
        assert.match(normalizedAggregatorPrompt, /<specialist_reports>/);
        assert.match(normalizedAggregatorPrompt, /<\/specialist_reports>/);
        assert.match(normalizedAggregatorPrompt, /explorer-1\.md/);
        assert.match(
            normalizedAggregatorPrompt,
            /Read the complete explorer handoff artifact/,
        );
        assert.doesNotMatch(normalizedAggregatorPrompt, /artifact_index/);
        assert.doesNotMatch(
            normalizedAggregatorPrompt,
            /SPECIALIST_INLINE_SENTINEL/,
        );
        assert.doesNotMatch(normalizedAggregatorPrompt, /Context:/);
        assert.ok(
            aggregatorReads.some((path) =>
                normalizePathSeparators(path).endsWith("00-codebase-scout.md"),
            ),
        );
        assert.ok(
            aggregatorReads.some((path) =>
                normalizePathSeparators(path).endsWith("01-partition-plan.md"),
            ),
        );
        assert.ok(
            aggregatorReads.some((path) =>
                normalizePathSeparators(path).endsWith(
                    "02-history-analyzer.md",
                ),
            ),
        );
        assert.ok(
            aggregatorReads.some((path) =>
                normalizePathSeparators(path).endsWith("explorer-1.md"),
            ),
        );
        assert.equal(
            aggregatorReads.some((path) =>
                /\/wave[12]\//.test(normalizePathSeparators(path)),
            ),
            false,
        );
        assert.equal(
            aggregatorReads.some((path) =>
                /(^|\/)context-build\//.test(normalizePathSeparators(path)),
            ),
            false,
        );

        const scoutOutput = ctx.calls.taskOptions["codebase-scout"]?.[0];
        const historyLocatorOutput =
            ctx.calls.taskOptions["history-locator"]?.[0];
        const historyAnalyzerOutput =
            ctx.calls.taskOptions["history-analyzer"]?.[0];
        assert.equal(scoutOutput?.outputMode, "file-only");
        assert.equal(historyLocatorOutput?.outputMode, "file-only");
        assert.equal(historyAnalyzerOutput?.outputMode, "file-only");
        assert.notEqual(scoutOutput?.output, historyLocatorOutput?.output);

        const partitionOutput = ctx.calls.taskOptions["partition"]?.[0];
        assert.equal(partitionOutput?.outputMode, undefined);
        assertStringOutput(partitionOutput?.output);
        assert.ok(
            normalizePathSeparators(partitionOutput.output).endsWith(
                "01-partition-plan.md",
            ),
        );
        assert.ok(readPathEndsWith(partitionOutput, "00-codebase-scout.md"));
        assert.ok(
            readPathEndsWith(
                ctx.calls.taskOptions["locator-1"]?.[0],
                "00-codebase-scout.md",
            ),
        );
        assert.ok(
            readPathEndsWith(
                ctx.calls.taskOptions["analyzer-1"]?.[0],
                "00-codebase-scout.md",
            ),
        );
        assert.ok(
            readPathEndsWith(
                ctx.calls.taskOptions["analyzer-1"]?.[0],
                "locator-1.md",
            ),
        );
        assert.ok(
            readPathEndsWith(
                ctx.calls.taskOptions["online-researcher-1"]?.[0],
                "locator-1.md",
            ),
        );
        assert.equal(
            ctx.calls.taskOptions["locator-1"]?.[0]?.outputMode,
            "file-only",
        );
        assert.equal(
            ctx.calls.taskOptions["analyzer-1"]?.[0]?.outputMode,
            "file-only",
        );
    });

    test("does not use a saved-output reference when history artifact is unavailable", async () => {
        const mod =
            await import("../../packages/workflows/builtin/deep-research-codebase.js");
        const ctx = makeMockCtx(
            {
                prompt: "Trace auth behavior",
                max_partitions: 1,
                max_concurrency: 1,
            },
            {
                skipOutputWrites: ["history-analyzer"],
                task: (name) => {
                    if (name === "partition") return "auth logic";
                    if (name === "history-analyzer") {
                        return "Output saved to: /tmp/history-analyzer.md (123 bytes). Read this file if needed.";
                    }
                    return undefined;
                },
            },
        );

        const result = await withDeepResearchTempCwd(() =>
            mod.default.run(ctx),
        );
        const aggregatorPrompt = ctx.calls.prompts["aggregator"]?.[0] ?? "";

        assert.doesNotMatch(aggregatorPrompt, /Output saved to:/);
        assert.match(aggregatorPrompt, /\(no prior research found\)/);
        assert.equal(result["history"], "");
    });

    test("falls back to scout context when a wave1 locator result is missing", async () => {
        const mod =
            await import("../../packages/workflows/builtin/deep-research-codebase.js");
        const ctx = makeMockCtx(
            {
                prompt: "Trace auth behavior",
                max_partitions: 1,
                max_concurrency: 1,
            },
            {
                omitParallelResults: ["locator-1"],
                task: (name) => {
                    if (name === "partition") return "auth logic";
                    return undefined;
                },
            },
        );

        await withDeepResearchTempCwd(() => mod.default.run(ctx));

        const analyzerOptions = ctx.calls.taskOptions["analyzer-1"]?.[0];
        const onlineOptions = ctx.calls.taskOptions["online-researcher-1"]?.[0];
        const normalizedAnalyzerPrompt = normalizePathSeparators(
            ctx.calls.prompts["analyzer-1"]?.[0] ?? "",
        );
        const normalizedOnlinePrompt = normalizePathSeparators(
            ctx.calls.prompts["online-researcher-1"]?.[0] ?? "",
        );

        assert.equal(readPaths(analyzerOptions).length, 1);
        assert.ok(readPathEndsWith(analyzerOptions, "00-codebase-scout.md"));
        assert.equal(
            readPathEndsWith(analyzerOptions, "wave1/locator-1.md"),
            false,
        );
        assert.doesNotMatch(normalizedAnalyzerPrompt, /wave1\/locator-1\.md/);

        assert.equal(readPaths(onlineOptions).length, 1);
        assert.ok(readPathEndsWith(onlineOptions, "00-codebase-scout.md"));
        assert.equal(
            readPathEndsWith(onlineOptions, "wave1/locator-1.md"),
            false,
        );
        assert.match(
            normalizedOnlinePrompt,
            /Read scout context before researching/,
        );
        assert.doesNotMatch(normalizedOnlinePrompt, /wave1\/locator-1\.md/);
    });

    test("displays final artifact paths relative to ctx.cwd", async () => {
        const mod =
            await import("../../packages/workflows/builtin/deep-research-codebase.js");
        const ctx = makeMockCtx(
            {
                prompt: "Trace auth behavior",
                max_partitions: 1,
                max_concurrency: 1,
            },
            {
                task: (name) => {
                    if (name === "partition") return "auth logic";
                    if (name === "aggregator")
                        return "final synthesized findings";
                    return undefined;
                },
            },
        );
        const cwd = requireDeepResearchTempCwd();

        const result = await mod.default.run({ ...ctx, cwd });

        const researchDocPath = result["research_doc_path"];
        if (typeof researchDocPath !== "string") {
            throw new Error("expected research_doc_path to be a string");
        }
        assert.match(
            normalizePathSeparators(researchDocPath),
            /^research\/\d{4}-\d{2}-\d{2}-trace-auth-behavior\.md$/,
        );
        assert.equal(existsSync(join(cwd, researchDocPath)), true);

        const artifactDir = result["artifact_dir"];
        if (typeof artifactDir !== "string") {
            throw new Error("expected artifact_dir to be a string");
        }
        assert.match(
            normalizePathSeparators(artifactDir),
            /^research\/\.deep-research-/,
        );
        assert.equal(existsSync(join(cwd, artifactDir)), true);

        const manifestPath = result["manifest_path"];
        if (typeof manifestPath !== "string") {
            throw new Error("expected manifest_path to be a string");
        }
        assert.match(
            normalizePathSeparators(manifestPath),
            /^research\/\.deep-research-.*\/manifest\.json$/,
        );
        assert.equal(existsSync(join(cwd, manifestPath)), true);
    });
});
