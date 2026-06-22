// @ts-nocheck
import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    REFERENCE_DESIGN_SITES,
    buildLivePreviewDisplayPrompt,
    buildReferenceDiscoveryPrompt,
    detectDesignContextFiles,
    ensureProjectDesignContext,
    persistReferencesBrief,
    runDiscovery,
} from "../../packages/workflows/builtin/open-claude-design-setup.js";
import { shouldEarlyExitForBrowser } from "../../packages/workflows/builtin/open-claude-design-utils.js";

function makeRecorder(taskText) {
    const calls = { tasks: [], prompts: {} };
    const designContext = {
        task: async (name, options) => {
            calls.tasks.push(name);
            calls.prompts[name] = options.prompt;
            const text = taskText?.(name) ?? `[mock:${name}]`;
            let structured;
            try {
                structured = JSON.parse(text);
            } catch {
                structured = undefined;
            }
            return { name, stageName: name, text, structured };
        },
    };
    return { calls, designContext };
}

describe("open-claude-design setup", () => {
    const tempDirs = [];
    afterEach(() => {
        while (tempDirs.length > 0) {
            const dir = tempDirs.pop();
            if (dir) rmSync(dir, { recursive: true, force: true });
        }
    });
    const tempDir = () => {
        const dir = mkdtempSync(join(tmpdir(), "ocd-setup-"));
        tempDirs.push(dir);
        return dir;
    };

    describe("detectDesignContextFiles", () => {
        test("reports missing when neither file exists", () => {
            const detection = detectDesignContextFiles(tempDir());
            assert.equal(detection.hasProduct, false);
            assert.equal(detection.hasDesign, false);
            assert.equal(detection.hasBoth, false);
        });

        test("detects PRODUCT.md / DESIGN.md at the project root", () => {
            const dir = tempDir();
            writeFileSync(join(dir, "PRODUCT.md"), "# Product");
            writeFileSync(join(dir, "DESIGN.md"), "# Design");
            const detection = detectDesignContextFiles(dir);
            assert.equal(detection.hasBoth, true);
            assert.equal(detection.productPath, join(dir, "PRODUCT.md"));
            assert.equal(detection.designPath, join(dir, "DESIGN.md"));
        });

        test("detects case-insensitive files under .agents/context and docs", () => {
            const dir = tempDir();
            mkdirSync(join(dir, ".agents", "context"), { recursive: true });
            mkdirSync(join(dir, "docs"), { recursive: true });
            writeFileSync(join(dir, ".agents", "context", "product.md"), "# Product");
            writeFileSync(join(dir, "docs", "Design.md"), "# Design");
            const detection = detectDesignContextFiles(dir);
            assert.equal(detection.hasProduct, true);
            assert.equal(detection.hasDesign, true);
            assert.equal(detection.hasBoth, true);
        });
    });

    describe("runDiscovery", () => {
        test("asks via impeccable shape and parses the structured brief/output_type/references", async () => {
            const { calls, designContext } = makeRecorder(() =>
                JSON.stringify({
                    brief: "A confirmed kanban board brief.",
                    output_type: "component",
                    references: ["https://example.com/a", "./mock.png"],
                }),
            );
            const decision = await runDiscovery({
                designContext,
                prompt: "Design a kanban board",
                discoveryConfig: {},
            });
            assert.ok(calls.tasks.includes("discovery"));
            const prompt = calls.prompts["discovery"] ?? "";
            assert.match(prompt, /\/skill:impeccable shape/);
            assert.match(prompt, /ask_user_question/);
            assert.match(prompt, /prototype, wireframe, page, component, theme, tokens/);
            assert.equal(decision.brief, "A confirmed kanban board brief.");
            assert.equal(decision.output_type, "component");
            assert.deepEqual(decision.references, [
                "https://example.com/a",
                "./mock.png",
            ]);
        });

        test("falls back to the raw prompt and empty references when unstructured", async () => {
            const { designContext } = makeRecorder(() => "not json");
            const decision = await runDiscovery({
                designContext,
                prompt: "Design a dashboard",
                discoveryConfig: {},
            });
            assert.equal(decision.brief, "Design a dashboard");
            assert.equal(decision.output_type, "prototype");
            assert.deepEqual(decision.references, []);
        });
    });

    describe("ensureProjectDesignContext", () => {
        test("runs /skill:impeccable init with discovery context when files are missing", async () => {
            const dir = tempDir();
            const { calls, designContext } = makeRecorder();
            const result = await ensureProjectDesignContext({
                designContext,
                cwd: dir,
                prompt: "Design a dashboard",
                discoveryContext: "Confirmed design brief: a dashboard.",
                designModelConfig: {},
            });
            assert.equal(result.initRan, true);
            assert.ok(calls.tasks.includes("init"));
            const initPrompt = calls.prompts["init"] ?? "";
            assert.match(initPrompt, /\/skill:impeccable init/);
            assert.match(initPrompt, /<discovery_context>/);
            assert.match(initPrompt, /Confirmed design brief: a dashboard/);
            assert.match(initPrompt, /PRODUCT\.md/);
            assert.match(initPrompt, /DESIGN\.md/);
        });

        test("always runs init and reconciles when both files already exist", async () => {
            const dir = tempDir();
            writeFileSync(join(dir, "PRODUCT.md"), "# Product");
            writeFileSync(join(dir, "DESIGN.md"), "# Design");
            const { calls, designContext } = makeRecorder();
            const result = await ensureProjectDesignContext({
                designContext,
                cwd: dir,
                prompt: "Design a dashboard",
                discoveryContext: "brief",
                designModelConfig: {},
            });
            // Phase 2 always runs now — even when both files exist.
            assert.equal(result.initRan, true);
            assert.ok(calls.tasks.includes("init"));
            const initPrompt = calls.prompts["init"] ?? "";
            assert.match(initPrompt, /already exist/);
            assert.match(initPrompt, /never clobber|never overwrite|never silently overwrite/i);
            assert.match(result.summary, /reviewed existing/);
        });
    });

    describe("reference discovery", () => {
        test("buildReferenceDiscoveryPrompt names every gallery + the playwright bootstrap", () => {
            const prompt = buildReferenceDiscoveryPrompt({
                prompt: "Design a landing page",
                outputType: "page",
                designContextHint: "PRODUCT.md=/p DESIGN.md=/d\n\nDesign-system/reference discovery evidence from ds-* stages:\n### ds-locator\nFound tokens.",
                artifactDir: "/tmp/run",
                browserBootstrapRules: "which playwright-cli ... @playwright/cli",
            });
            for (const site of REFERENCE_DESIGN_SITES) {
                assert.ok(prompt.includes(site.url), site.url);
            }
            assert.match(prompt, /<browser_use_guidelines>/);
            assert.match(prompt, /<design_context>/);
            assert.match(prompt, /video-start/);
            assert.match(prompt, /scroll-through video/i);
            assert.match(prompt, /screenshot --full-page/);
            assert.match(prompt, /CLICK INTO/);
            assert.match(prompt, /destination URL/i);
            assert.match(prompt, /ds-\* discovery evidence/i);
            assert.match(prompt, /ask_user_question/);
            assert.match(prompt, /which reference direction they prefer/i);
            assert.match(prompt, /None of these fit/);
            assert.match(prompt, /provide a reference image, screenshot, URL, or local file path/i);
        });

        test("persistReferencesBrief writes references.md", () => {
            const dir = tempDir();
            persistReferencesBrief(dir, "## Curated references\n\n- Awwwards hero.");
            assert.ok(existsSync(join(dir, "references.md")));
            assert.match(
                readFileSync(join(dir, "references.md"), "utf8"),
                /Awwwards hero/,
            );
        });
    });

    describe("buildLivePreviewDisplayPrompt", () => {
        test("initial preview prompt drives /skill:impeccable live and keeps the feedback labels", () => {
            const prompt = buildLivePreviewDisplayPrompt({
                previewPath: "/tmp/run/preview.html",
                previewFileUrl: "file:///tmp/run/preview.html",
                browserBootstrapRules: "which playwright-cli ... @playwright/cli ... missing browser executable ... screenshot --filename",
            });
            assert.match(prompt, /\/skill:impeccable live/);
            assert.match(prompt, /<browser_use_guidelines>/);
            assert.match(prompt, /playwright-cli show --annotate/);
            assert.match(prompt, /`user_notes`/);
            assert.match(prompt, /`annotated_snapshot`/);
            assert.match(prompt, /`live_changes`/);
            assert.match(prompt, /the just-generated HTML artifact/);
            assert.ok(prompt.includes("/tmp/run/preview.html"));
        });

        test("per-iteration prompt labels the iteration", () => {
            const prompt = buildLivePreviewDisplayPrompt({
                previewPath: "/tmp/run/preview.html",
                previewFileUrl: "file:///tmp/run/preview.html",
                browserBootstrapRules: "rules",
                iteration: 2,
                maxRefinements: 3,
            });
            assert.match(prompt, /iteration 2\/3/);
        });

        test("final-mode prompt is read-only: it does not solicit actionable feedback", () => {
            const prompt = buildLivePreviewDisplayPrompt({
                previewPath: "/tmp/run/preview.html",
                previewFileUrl: "file:///tmp/run/preview.html",
                browserBootstrapRules: "rules",
                iteration: 3,
                maxRefinements: 3,
                final: true,
            });
            assert.match(prompt, /FINAL refinement pass/);
            assert.match(prompt, /re-run/i);
            assert.match(prompt, /do NOT (solicit|collect)/i);
        });
    });

    describe("shouldEarlyExitForBrowser", () => {
        test("exits only when the browser is unavailable outside the test harness", () => {
            assert.equal(shouldEarlyExitForBrowser(false, "production"), true);
            assert.equal(shouldEarlyExitForBrowser(false, undefined), true);
            assert.equal(shouldEarlyExitForBrowser(true, "production"), false);
            assert.equal(shouldEarlyExitForBrowser(false, "test"), false);
        });
    });
});
