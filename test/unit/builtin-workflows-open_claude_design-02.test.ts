// @ts-nocheck
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import type { WorkflowDefinition } from "../../packages/workflows/src/types.js";
import { makeMockCtx } from "./builtin-workflows-helpers.js";

describe("open-claude-design — refinement export gate (#1464)", () => {
    function refinementDecision(readyForExport: boolean): string {
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
            blocking_findings: [],
        });
    }

    const previewWithAnnotations = [
        "display_method: playwright-cli interactive annotation",
        "preview_path: /tmp/preview.html",
        "annotated_snapshot: .playwright-cli/annotations-test.png",
        "user_notes:",
        "- I don't like this background; simplify it to a black to grey gradient.",
        "- Make the overall vibe more polished, closer to the Apple website.",
        "next_action_hint: proceed to refinement",
    ].join("\n");

    test("forces an apply pass before export when the latest preview captured unaddressed annotations", async () => {
        const mod =
            await import("../../packages/workflows/builtin/open-claude-design.js");
        const d = mod.default as unknown as WorkflowDefinition;
        const ctx = makeMockCtx(
            { prompt: "Redesign the Atomic website", max_refinements: 2 },
            {
                task: (name) => {
                    if (name === "preview-display-initial")
                        return previewWithAnnotations;
                    // The reviewer model approves export on every round.
                    if (name.startsWith("user-feedback-"))
                        return refinementDecision(true);
                    if (name === "pre-export-scan")
                        return exportGateDecision(false);
                    return undefined;
                },
            },
        );

        const result = await d.run(ctx);

        // Even though user-feedback-1 returned ready_for_export=true, the captured
        // annotations were not yet addressed, so the gate must force an apply pass
        // (which threads them) instead of silently exporting at the gate. #1464
        assert.ok(ctx.calls.task.includes("apply-changes-1"));
        const applyPrompt = ctx.calls.prompts["apply-changes-1"]?.[0] ?? "";
        assert.ok(applyPrompt.includes("I don't like this background"));
        assert.ok(applyPrompt.includes("Apple website"));
        // The next iteration approves with no new annotations -> no second apply.
        assert.equal(ctx.calls.task.includes("apply-changes-2"), false);
        assert.equal(typeof result["handoff"], "string");
        const artifactDir = result["artifact_dir"] as string;
        rmSync(artifactDir, { recursive: true, force: true });
    });

    test("exports immediately when there are no captured annotations to drop", async () => {
        const mod =
            await import("../../packages/workflows/builtin/open-claude-design.js");
        const d = mod.default as unknown as WorkflowDefinition;
        const ctx = makeMockCtx(
            { prompt: "Design a dashboard", max_refinements: 2 },
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

        // No meaningful annotations were captured, so an immediate export approval
        // is honored without forcing an apply pass.
        assert.equal(ctx.calls.task.includes("apply-changes-1"), false);
        assert.equal(result["approved_for_export"], true);
        const artifactDir = result["artifact_dir"] as string;
        rmSync(artifactDir, { recursive: true, force: true });
    });
});
