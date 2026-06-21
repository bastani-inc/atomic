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

    test("writes final research doc and historical hidden run artifacts under research", async () => {
        const mod =
            await import("../../packages/workflows/builtin/deep-research-codebase.js");
        let aggregatorReadPaths: readonly string[] = [];
        const ctx = makeMockCtx(
            {
                prompt: "Trace auth behavior",
                max_partitions: 1,
                max_concurrency: 1,
            },
            {
                task: (name, options) => {
                    if (name === "partition") return "auth logic";
                    if (name === "aggregator") {
                        aggregatorReadPaths = readPaths(options);
                        assert.ok(aggregatorReadPaths.length > 0);
                        for (const path of aggregatorReadPaths) {
                            assert.equal(
                                existsSync(path),
                                true,
                                `expected aggregator read path to exist: ${path}`,
                            );
                        }
                        return "final synthesized findings";
                    }
                    return undefined;
                },
            },
        );

        const result = await withDeepResearchTempCwd(() =>
            mod.default.run(ctx),
        );

        assert.equal(result["findings"], "final synthesized findings");
        assert.equal(
            result["research_doc_path"],
            normalizePathSeparators(
                join(
                    "research",
                    `${new Date().toISOString().slice(0, 10)}-trace-auth-behavior.md`,
                ),
            ),
        );
        assert.equal(
            readFileSync(
                join(
                    requireDeepResearchTempCwd(),
                    result["research_doc_path"] as string,
                ),
                "utf8",
            ),
            "final synthesized findings",
        );
        assert.equal(
            existsSync(join(requireDeepResearchTempCwd(), "context-build")),
            false,
        );

        const artifactDirValue = result["artifact_dir"];
        if (typeof artifactDirValue !== "string") {
            throw new Error("expected artifact_dir to be a string");
        }
        const artifactDir = artifactDirValue;
        const artifactDirFsPath = join(
            requireDeepResearchTempCwd(),
            artifactDir,
        );
        assert.match(
            normalizePathSeparators(artifactDir),
            /^research\/\.deep-research-/,
        );
        assert.equal(existsSync(artifactDirFsPath), true);

        for (const filename of [
            "00-codebase-scout.md",
            "01-partition-plan.md",
            "01-history-locator.md",
            "02-history-analyzer.md",
            "locator-1.md",
            "pattern-finder-1.md",
            "analyzer-1.md",
            "online-1.md",
            "explorer-1.md",
            "manifest.json",
        ]) {
            assert.equal(
                existsSync(join(artifactDirFsPath, filename)),
                true,
                `expected ${filename}`,
            );
        }
        for (const path of aggregatorReadPaths) {
            assert.equal(
                existsSync(path),
                true,
                `expected handoff artifact to persist: ${path}`,
            );
            assert.equal(
                /(^|\/)context-build\//.test(normalizePathSeparators(path)),
                false,
            );
        }

        const manifest = JSON.parse(
            readFileSync(join(artifactDirFsPath, "manifest.json"), "utf8"),
        ) as {
            runId?: string;
            startedAt?: string;
            completedAt?: string;
            researchQuestion?: string;
            finalAsset?: string;
            artifacts?: Record<string, string>;
        };
        assert.equal(
            manifest.runId,
            basename(artifactDir).replace(/^\.deep-research-/, ""),
        );
        assert.equal(typeof manifest.startedAt, "string");
        assert.equal(typeof manifest.completedAt, "string");
        assert.equal(manifest.researchQuestion, "Trace auth behavior");
        assert.equal(
            manifest.finalAsset,
            normalizePathSeparators(
                join(
                    "research",
                    `${new Date().toISOString().slice(0, 10)}-trace-auth-behavior.md`,
                ),
            ),
        );
        assert.deepEqual(manifest.artifacts, {
            "codebase-scout": normalizePathSeparators(
                join(artifactDir, "00-codebase-scout.md"),
            ),
            partition: normalizePathSeparators(
                join(artifactDir, "01-partition-plan.md"),
            ),
            "history-locator": normalizePathSeparators(
                join(artifactDir, "01-history-locator.md"),
            ),
            "history-analyzer": normalizePathSeparators(
                join(artifactDir, "02-history-analyzer.md"),
            ),
            "locator-1": normalizePathSeparators(
                join(artifactDir, "locator-1.md"),
            ),
            "pattern-finder-1": normalizePathSeparators(
                join(artifactDir, "pattern-finder-1.md"),
            ),
            "analyzer-1": normalizePathSeparators(
                join(artifactDir, "analyzer-1.md"),
            ),
            "online-1": normalizePathSeparators(
                join(artifactDir, "online-1.md"),
            ),
            "explorer-1": normalizePathSeparators(
                join(artifactDir, "explorer-1.md"),
            ),
            manifest: normalizePathSeparators(
                join(artifactDir, "manifest.json"),
            ),
        });
    });

    test("does not overwrite an existing default research document", async () => {
        const mod =
            await import("../../packages/workflows/builtin/deep-research-codebase.js");
        const date = new Date().toISOString().slice(0, 10);
        const existingPath = join(
            requireDeepResearchTempCwd(),
            "research",
            `${date}-trace-auth-behavior.md`,
        );
        mkdirSync(dirname(existingPath), { recursive: true });
        writeFileSync(existingPath, "existing research", "utf8");
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

        const result = await withDeepResearchTempCwd(() =>
            mod.default.run(ctx),
        );
        const researchDocPath = result["research_doc_path"];

        assert.equal(readFileSync(existingPath, "utf8"), "existing research");
        assert.ok(typeof researchDocPath === "string");
        assert.ok(
            normalizePathSeparators(researchDocPath).endsWith(
                `${date}-trace-auth-behavior-2.md`,
            ),
        );
        assert.equal(
            readFileSync(
                join(requireDeepResearchTempCwd(), researchDocPath),
                "utf8",
            ),
            "final synthesized findings",
        );
    });

    test("does not create a top-level context-build directory", async () => {
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

        await withDeepResearchTempCwd(() => mod.default.run(ctx));

        assert.equal(
            existsSync(join(requireDeepResearchTempCwd(), "context-build")),
            false,
        );
        assert.deepEqual(
            readdirSync(join(requireDeepResearchTempCwd(), "research")).filter(
                (entry) => entry === "context-build",
            ),
            [],
        );
    });
});
