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
    test("exports all four builtins by name", async () => {
        const mod = await import("../../packages/workflows/builtin/index.js");
        assert.notEqual(mod.deepResearchCodebase, undefined);
        assert.notEqual(mod.goal, undefined);
        assert.notEqual(mod.ralph, undefined);
        assert.notEqual(mod.openClaudeDesign, undefined);

        assertWorkflowDefinition(mod.deepResearchCodebase);
        assertWorkflowDefinition(mod.goal);
        assertWorkflowDefinition(mod.ralph);
        assertWorkflowDefinition(mod.openClaudeDesign);
    });
});
