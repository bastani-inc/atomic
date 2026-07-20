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

describe("builtin/index manifest", () => {
    test("exports all ten builtins by name", async () => {
        const mod = await import("../../packages/workflows/builtin/index.js");
        const definitions = [
            mod.adversarialVerification,
            mod.classifyAndAct,
            mod.deepResearchCodebase,
            mod.fanOutAndSynthesize,
            mod.generateAndFilter,
            mod.goal,
            mod.loopUntilDone,
            mod.openClaudeDesign,
            mod.ralph,
            mod.tournament,
        ];
        assert.deepEqual(
            definitions.map((definition) => definition?.normalizedName),
            [
                "adversarial-verification",
                "classify-and-act",
                "deep-research-codebase",
                "fan-out-and-synthesize",
                "generate-and-filter",
                "goal",
                "loop-until-done",
                "open-claude-design",
                "ralph",
                "tournament",
            ],
        );
        for (const definition of definitions) assertWorkflowDefinition(definition);
    });
});
