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

describe("open-claude-design", () => {    function refinementDecision(readyForExport: boolean): string {
        return JSON.stringify({
            ready_for_export: readyForExport,
            rationale: readyForExport
                ? "Preview is ready for export."
                : "More refinement is needed.",
            required_changes: readyForExport ? [] : ["Tighten hierarchy"],
        });
    }

    function exportGateDecision(hasBlockingFindings: boolean): string {
        return JSON.stringify({
            has_blocking_findings: hasBlockingFindings,
            rationale: hasBlockingFindings
                ? "A P0 issue blocks export."
                : "No P0 issues block export.",
            blocking_findings: hasBlockingFindings
                ? [
                      {
                          finding: "Critical contrast issue",
                          evidence: "#submit-button",
                          why_blocking: "Primary action is unreadable.",
                          must_fix_action: "Increase contrast.",
                          severity: "P0",
                      },
                  ]
                : [],
        });
    }

    test("loads and has correct shape", async () => {
        const mod =
            await import("../../packages/workflows/builtin/open-claude-design.js");
        assertWorkflowDefinition(mod.default);
        assert.equal(mod.default.name, "open-claude-design");
    });

    test("has design workflow inputs without compatibility aliases", async () => {
        const mod =
            await import("../../packages/workflows/builtin/open-claude-design.js");
        const d = mod.default;
        for (const inputName of [
            "prompt",
            "reference",
            "output_type",
            "design_system",
            "max_refinements",
        ]) {
            assert.notEqual(d.inputs[inputName], undefined, inputName);
        }
        assert.equal(d.inputs["output-type"], undefined);
        assert.equal(d.inputs["design-system"], undefined);
        assert.equal(fieldRequired(d.inputs["prompt"]), true);
    });

    test("output_type supports canonical underscore choices", async () => {
        const mod =
            await import("../../packages/workflows/builtin/open-claude-design.js");
        const schema = mod.default.inputs["output_type"];
        assert.equal(fieldKind(schema), "select");
        const choices = fieldChoices(schema);
        for (const choice of [
            "prototype",
            "wireframe",
            "page",
            "component",
            "theme",
            "tokens",
        ]) {
            assert.ok(choices.includes(choice), choice);
        }
        assert.equal(fieldDefault(schema), "prototype");
    });

    test("declares child workflow output contract", async () => {
        const mod =
            await import("../../packages/workflows/builtin/open-claude-design.js");
        assertOutputTypes(mod.default.outputs, {
            approved_for_export: "boolean",
            artifact: "text",
            artifact_dir: "text",
            design_system: "text",
            handoff: "text",
            import_context: "text",
            output_type: "text",
            preview_file_url: "text",
            preview_path: "text",
            refinements_completed: "number",
            run_id: "text",
            spec_file_url: "text",
            spec_path: "text",
            playwright_cli_status: "text",
        });
    });

    test("runs onboarding, import, generation, refinement, scan, and export", async () => {
        const mod =
            await import("../../packages/workflows/builtin/open-claude-design.js");
        const d = mod.default as unknown as WorkflowDefinition;
        const ctx = makeMockCtx(
            {
                prompt: "Design a kanban board",
                reference: "https://example.com/reference",
                output_type: "component",
                max_refinements: 2,
            },
            {
                task: (name) => {
                    if (name.startsWith("user-feedback-"))
                        return refinementDecision(true);
                    if (name === "pre-export-scan")
                        return exportGateDecision(false);
                    return undefined;
                },
            },
        );

        const result = await d.run(ctx);

        assert.deepEqual(ctx.calls.stage, []);
        assert.ok(
            ctx.calls.parallel.some(
                (names) =>
                    names.includes("ds-locator") &&
                    names.includes("ds-patterns"),
            ),
        );
        assert.ok(
            ctx.calls.parallel.some((names) => names.includes("web-capture")),
        );
        assert.ok(ctx.calls.task.includes("design-system-builder"));
        assert.ok(ctx.calls.task.includes("generator"));
        assert.ok(ctx.calls.task.includes("user-feedback-1"));
        assert.ok(ctx.calls.task.includes("pre-export-scan"));
        assert.ok(ctx.calls.task.includes("exporter"));
        const refinementOptions = ctx.calls.taskOptions["user-feedback-1"]?.[0];
        assert.notEqual(refinementOptions?.schema, undefined);
        assert.equal(refinementOptions?.customTools, undefined);
        assert.deepEqual(refinementOptions?.tools, ["read", "grep", "ls"]);
        const refinementPrompt = ctx.calls.prompts["user-feedback-1"]?.[0] ?? "";
        assert.doesNotMatch(refinementPrompt, /structured_output/i);
        assert.match(refinementPrompt, /ready_for_export=true/);
        const exportGateOptions = ctx.calls.taskOptions["pre-export-scan"]?.[0];
        assert.notEqual(exportGateOptions?.schema, undefined);
        assert.equal(exportGateOptions?.customTools, undefined);
        assert.deepEqual(exportGateOptions?.tools, ["read", "grep", "ls"]);
        assert.doesNotMatch(ctx.calls.prompts["pre-export-scan"]?.[0] ?? "", /structured_output/i);
        assert.doesNotMatch(ctx.calls.prompts["pre-export-scan"]?.[0] ?? "", /output_format/i);
        assert.equal(result["output_type"], "component");
        assert.equal(typeof result["artifact"], "string");
        assert.equal(typeof result["handoff"], "string");
    });

    test("uses default output_type 'prototype' when not provided", async () => {
        const mod =
            await import("../../packages/workflows/builtin/open-claude-design.js");
        const d = mod.default as unknown as WorkflowDefinition;
        const ctx = makeMockCtx(
            { prompt: "Design a dashboard" },
            {
                task: (name) => {
                    if (name.startsWith("user-feedback-"))
                        return refinementDecision(true);
                    if (name === "pre-export-scan")
                        return exportGateDecision(false);
                    return undefined;
                },
            },
        );
        const result = await d.run(ctx);
        assert.equal(result["output_type"], "prototype");
    });

    test("browser display prompts use playwright-cli bootstrap rules", async () => {
        const mod =
            await import("../../packages/workflows/builtin/open-claude-design.js");
        const d = mod.default as unknown as WorkflowDefinition;
        const ctx = makeMockCtx(
            {
                prompt: "Design a dashboard",
                reference: "https://example.com/reference",
                design_system: "Use the existing app design system.",
                max_refinements: 1,
            },
            {
                task: (name) => {
                    if (name.startsWith("user-feedback-"))
                        return refinementDecision(true);
                    if (name === "pre-export-scan")
                        return exportGateDecision(false);
                    return undefined;
                },
            },
        );

        await d.run(ctx);

        const webCapturePrompt = ctx.calls.prompts["web-capture"]?.[0] ?? "";
        const previewPrompt =
            ctx.calls.prompts["preview-display-initial"]?.[0] ?? "";
        const finalPrompt = ctx.calls.prompts["final-display"]?.[0] ?? "";
        for (const displayPrompt of [
            webCapturePrompt,
            previewPrompt,
            finalPrompt,
        ]) {
            assert.match(displayPrompt, /<browser_use_guidelines>/);
            assert.match(displayPrompt, /<\/browser_use_guidelines>/);
            assert.match(displayPrompt, /which playwright-cli/);
            assert.match(displayPrompt, /@playwright\/cli/);
            assert.match(displayPrompt, /Do not add project dependencies/);
            assert.match(displayPrompt, /missing browser executable/);
            assert.match(displayPrompt, /screenshot --filename/);
            assert.doesNotMatch(displayPrompt, /playwright_browser_bootstrap/);
            assert.doesNotMatch(displayPrompt, /which browse/);
            assert.doesNotMatch(displayPrompt, /npm install -g browse/);
            assert.doesNotMatch(displayPrompt, /browser-use/);
            assert.doesNotMatch(displayPrompt, /browser goto/);
        }
    });

    test("definition is frozen (immutable)", async () => {
        const mod =
            await import("../../packages/workflows/builtin/open-claude-design.js");
        const d = mod.default;
        assert.equal(Object.isFrozen(d), true);
        assert.equal(Object.isFrozen(d.inputs), true);
    });
});
