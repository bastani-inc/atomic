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

describe("open-claude-design", () => {

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
        for (const inputName of ["prompt", "discover_references", "max_refinements"]) {
            assert.notEqual(d.inputs[inputName], undefined, inputName);
        }
        // Removed inputs: reference, output_type, design_system are now gathered
        // by the discovery interview rather than passed as parameters.
        assert.equal(d.inputs["reference"], undefined);
        assert.equal(d.inputs["output_type"], undefined);
        assert.equal(d.inputs["design_system"], undefined);
        assert.equal(d.inputs["output-type"], undefined);
        assert.equal(d.inputs["design-system"], undefined);
        assert.equal(fieldRequired(d.inputs["prompt"]), true);
    });

    test("discovery decision schema offers the canonical output types", async () => {
        const utils =
            await import("../../packages/workflows/builtin/open-claude-design-utils.js");
        const schema = (utils.discoveryDecisionSchema as { properties: Record<string, unknown> })
            .properties["output_type"];
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
    });

    test("declares discover_references boolean input defaulting true", async () => {
        const mod =
            await import("../../packages/workflows/builtin/open-claude-design.js");
        const schema = mod.default.inputs["discover_references"];
        assert.equal(fieldKind(schema), "boolean");
        assert.equal(fieldDefault(schema), true);
        assert.ok(fieldDescription(schema).length > 0);
    });

    test("runs reference-discovery by default and feeds the generator reference inspiration", async () => {
        const mod =
            await import("../../packages/workflows/builtin/open-claude-design.js");
        const d = mod.default as unknown as WorkflowDefinition;
        const ctx = makeMockCtx(
            { prompt: "Design a landing page", max_refinements: 1 },
            {
                task: (name) => {
                    if (name.startsWith("user-feedback-"))
                        return "user_notes: none";
                    return undefined;
                },
            },
        );
        await d.run(ctx);
        assert.ok(ctx.calls.task.includes("reference-discovery"));
        assert.ok(ctx.calls.parallel.some((names) => names.includes("ds-locator")));
        assert.equal(ctx.calls.parallel.some((names) => names.includes("reference-discovery")), false);
        assert.ok(ctx.calls.task.indexOf("ds-patterns") < ctx.calls.task.indexOf("reference-discovery"));
        const refPrompt = ctx.calls.prompts["reference-discovery"]?.[0] ?? "";
        assert.match(refPrompt, /awwwards\.com\/websites/);
        assert.match(refPrompt, /motionsites\.ai/);
        assert.match(refPrompt, /\[mock-task:ds-locator\]/);
        assert.match(refPrompt, /ask_user_question/);
        assert.match(refPrompt, /reference image, screenshot, URL, or local file path/i);
        const genPrompt = ctx.calls.prompts["generate-1"]?.[0] ?? "";
        assert.match(genPrompt, /<reference_inspiration>/);
    });

    test("runs /skill:impeccable init in a full run when the project lacks PRODUCT.md/DESIGN.md", async () => {
        const mod =
            await import("../../packages/workflows/builtin/open-claude-design.js");
        const d = mod.default as unknown as WorkflowDefinition;
        const dir = mkdtempSync(join(tmpdir(), "ocd-run-init-"));
        try {
            const ctx = makeMockCtx(
                { prompt: "Design a dashboard", max_refinements: 1 },
                {
                    task: (name) => {
                        if (name.startsWith("user-feedback-"))
                            return "user_notes: none";
                        return undefined;
                    },
                },
            );
            // Point the run at an empty project dir so init detects missing files.
            (ctx as { cwd?: string }).cwd = dir;
            const result = await d.run(ctx);
            assert.ok(ctx.calls.task.includes("init"));
            const initPrompt = ctx.calls.prompts["init"]?.[0] ?? "";
            assert.match(initPrompt, /\/skill:impeccable init/);
            assert.match(initPrompt, /<discovery_context>/);
            assert.equal(ctx.calls.task.includes("design-system-builder"), false);
            const genPrompt = ctx.calls.prompts["generate-1"]?.[0] ?? "";
            assert.match(genPrompt, /Ran `\/skill:impeccable init`/);
            const artifactDir = result["artifact_dir"] as string | undefined;
            if (artifactDir) rmSync(artifactDir, { recursive: true, force: true });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("skips reference-discovery when discover_references=false", async () => {
        const mod =
            await import("../../packages/workflows/builtin/open-claude-design.js");
        const d = mod.default as unknown as WorkflowDefinition;
        const ctx = makeMockCtx(
            {
                prompt: "Design a landing page",
                discover_references: false,
                max_refinements: 1,
            },
            {
                task: (name) => {
                    if (name.startsWith("user-feedback-"))
                        return "user_notes: none";
                    return undefined;
                },
            },
        );
        await d.run(ctx);
        assert.equal(ctx.calls.task.includes("reference-discovery"), false);
    });

    test("always runs init (Phase 2) and drives /skill:impeccable live in user-feedback", async () => {
        const mod =
            await import("../../packages/workflows/builtin/open-claude-design.js");
        const d = mod.default as unknown as WorkflowDefinition;
        // Phase 2 always runs now, even when PRODUCT.md/DESIGN.md already exist
        // (repo root has them committed); init reconciles rather than skipping.
        const ctx = makeMockCtx(
            { prompt: "Design a dashboard", max_refinements: 1 },
            {
                task: (name) => {
                    if (name.startsWith("user-feedback-"))
                        return "user_notes: none";
                    return undefined;
                },
            },
        );
        await d.run(ctx);
        assert.ok(ctx.calls.task.includes("init"));
        assert.ok(ctx.calls.task.includes("discovery"));
        assert.match(
            ctx.calls.prompts["discovery"]?.[0] ?? "",
            /\/skill:impeccable shape/,
        );
        const feedbackPrompt = ctx.calls.prompts["user-feedback-1"]?.[0] ?? "";
        assert.match(feedbackPrompt, /\/skill:impeccable live/);
        assert.match(feedbackPrompt, /`live_changes`/);
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

    test("runs context gathering, generate/user-feedback loop, and export", async () => {
        const mod =
            await import("../../packages/workflows/builtin/open-claude-design.js");
        const d = mod.default as unknown as WorkflowDefinition;
        const ctx = makeMockCtx(
            {
                prompt: "Design a kanban board",
                max_refinements: 2,
            },
            {
                task: (name) => {
                    if (name === "discovery")
                        return JSON.stringify({
                            brief: "Confirmed: a kanban board component.",
                            output_type: "component",
                            references: ["https://example.com/reference"],
                        });
                    if (name.startsWith("user-feedback-"))
                        return "user_notes: none";
                    return undefined;
                },
            },
        );

        const result = await d.run(ctx);

        assert.deepEqual(ctx.calls.stage, []);
        assert.ok(ctx.calls.task.includes("discovery"));
        assert.ok(
            ctx.calls.parallel.some(
                (names) =>
                    names.includes("ds-locator") &&
                    names.includes("ds-patterns"),
            ),
        );
        assert.equal(ctx.calls.parallel.some((names) => names.includes("reference-discovery")), false);
        assert.equal(ctx.calls.task.includes("web-capture-1"), false);
        assert.equal(ctx.calls.task.includes("file-parser-1"), false);
        assert.equal(ctx.calls.task.includes("design-system-builder"), false);
        assert.ok(ctx.calls.task.includes("generate-1"));
        assert.match(ctx.calls.prompts["ds-locator"]?.[0] ?? "", /https:\/\/example\.com\/reference/);
        assert.match(ctx.calls.prompts["generate-1"]?.[0] ?? "", /<reference_context>/);
        assert.ok(ctx.calls.task.includes("user-feedback-1"));
        assert.equal(ctx.calls.task.includes("pre-export-scan"), false);
        assert.equal(ctx.calls.task.includes("forced-fix"), false);
        assert.ok(ctx.calls.task.includes("exporter"));
        assert.ok(ctx.calls.task.includes("final-display"));
        const feedbackOptions = ctx.calls.taskOptions["user-feedback-1"]?.[0];
        assert.equal(feedbackOptions?.schema, undefined);
        const feedbackPrompt = ctx.calls.prompts["user-feedback-1"]?.[0] ?? "";
        assert.match(feedbackPrompt, /\/skill:impeccable live/);
        assert.match(feedbackPrompt, /`user_notes`/);
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
                        return "user_notes: none";
                    return undefined;
                },
            },
        );
        const result = await d.run(ctx);
        assert.equal(result["output_type"], "prototype");
    });

    test("browser-capable prompts use playwright-cli bootstrap rules", async () => {
        const mod =
            await import("../../packages/workflows/builtin/open-claude-design.js");
        const d = mod.default as unknown as WorkflowDefinition;
        const ctx = makeMockCtx(
            {
                prompt: "Design a dashboard",
                max_refinements: 1,
            },
            {
                task: (name) => {
                    if (name === "discovery")
                        return JSON.stringify({
                            brief: "A dashboard.",
                            output_type: "page",
                            references: ["https://example.com/reference"],
                        });
                    if (name.startsWith("user-feedback-"))
                        return "user_notes: none";
                    return undefined;
                },
            },
        );

        await d.run(ctx);

        const feedbackPrompt = ctx.calls.prompts["user-feedback-1"]?.[0] ?? "";
        const finalPrompt = ctx.calls.prompts["final-display"]?.[0] ?? "";
        for (const displayPrompt of [
            ctx.calls.prompts["ds-locator"]?.[0] ?? "",
            ctx.calls.prompts["ds-analyzer"]?.[0] ?? "",
            ctx.calls.prompts["ds-patterns"]?.[0] ?? "",
            feedbackPrompt,
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

    const annotationNotes = [
        "- I don't like this background; simplify it to a black to grey gradient with solid texture.",
        "- The top-left masthead text is too light on this background; ensure WCAG/a11y standards across the page.",
        "- The copy button font is too generic; make it less generic with better design craft.",
        "- Good call to action on the Start a loop CTA; keep it.",
        "- Make the overall vibe more polished, closer to the Apple website.",
    ].join("\n");

    const previewWithAnnotations = [
        "display_method: playwright-cli interactive annotation",
        "preview_path: /tmp/preview.html",
        "annotated_snapshot: .playwright-cli/annotations-test.png",
        "user_notes:",
        annotationNotes,
        "next_action_hint: proceed to refinement",
    ].join("\n");

    test("threads captured user-feedback annotations into the next generate stage", async () => {
        const mod =
            await import("../../packages/workflows/builtin/open-claude-design.js");
        const d = mod.default as unknown as WorkflowDefinition;
        const ctx = makeMockCtx(
            { prompt: "Redesign the Atomic website", max_refinements: 2 },
            {
                task: (name) => {
                    if (name === "user-feedback-1")
                        return previewWithAnnotations;
                    if (name === "user-feedback-2")
                        return "user_notes: none";
                    return undefined;
                },
            },
        );

        const result = await d.run(ctx);

        assert.equal(ctx.calls.task.includes("preview-display-initial"), false);
        assert.equal(ctx.calls.task.includes("apply-changes-1"), false);
        assert.ok(ctx.calls.task.includes("generate-2"));
        const generatePrompt = ctx.calls.prompts["generate-2"]?.[0] ?? "";
        assert.ok(generatePrompt.includes("I don't like this background"));
        assert.ok(generatePrompt.includes("Apple website"));
        assert.doesNotMatch(generatePrompt, /Impeccable critique findings/);
        assert.doesNotMatch(generatePrompt, /screenshot-validated/);

        // Annotations persisted as durable workflow artifacts.
        const artifactDir = result["artifact_dir"] as string;
        const mdPath = join(artifactDir, "feedback", "iteration-1.md");
        const jsonPath = join(artifactDir, "feedback", "iteration-1.json");
        assert.ok(existsSync(mdPath));
        assert.match(readFileSync(mdPath, "utf8"), /I don't like this background/);
        const persisted = JSON.parse(readFileSync(jsonPath, "utf8"));
        assert.equal(persisted.hasUserNotes, true);
        assert.match(persisted.userNotes, /Apple website/);
        rmSync(artifactDir, { recursive: true, force: true });
    });

    test("falls back gracefully and does not block when no annotations were captured", async () => {
        const mod =
            await import("../../packages/workflows/builtin/open-claude-design.js");
        const d = mod.default as unknown as WorkflowDefinition;
        const ctx = makeMockCtx(
            { prompt: "Design a dashboard", max_refinements: 1 },
            {
                task: (name) => {
                    if (name.startsWith("user-feedback-"))
                        return "user_notes: none";
                    return undefined;
                },
            },
        );

        const result = await d.run(ctx);

        // No notes means no second generate stage and no feedback artifacts.
        assert.equal(ctx.calls.task.includes("generate-2"), false);
        assert.equal(ctx.calls.task.includes("apply-changes-1"), false);
        assert.equal(typeof result["handoff"], "string");
        const artifactDir = result["artifact_dir"] as string;
        assert.equal(existsSync(join(artifactDir, "feedback")), false);
        rmSync(artifactDir, { recursive: true, force: true });
    });

    test("definition is frozen (immutable)", async () => {
        const mod =
            await import("../../packages/workflows/builtin/open-claude-design.js");
        const d = mod.default;
        assert.equal(Object.isFrozen(d), true);
        assert.equal(Object.isFrozen(d.inputs), true);
    });
});
