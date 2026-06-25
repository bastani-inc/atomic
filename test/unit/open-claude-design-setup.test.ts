// @ts-nocheck
import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    REFERENCE_DESIGN_SITES,
    buildLivePreviewDisplayPrompt,
    buildReferenceDiscoveryPrompt,
    persistReferencesBrief,
    runDiscoveryAndInit,
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

    describe("runDiscoveryAndInit", () => {
        test("runs one discovery stage for shape + init and parses the structured brief/output_type/references", async () => {
            const { calls, designContext } = makeRecorder(() =>
                JSON.stringify({
                    brief: "A confirmed kanban board brief.",
                    output_type: "component",
                    references: ["https://example.com/a", "./mock.png"],
                }),
            );
            const result = await runDiscoveryAndInit({
                designContext,
                prompt: "Design a kanban board",
                discoveryConfig: {},
            });
            assert.deepEqual(calls.tasks, ["discovery"]);
            const prompt = calls.prompts["discovery"] ?? "";
            assert.match(prompt, /\/skill:impeccable shape/);
            assert.match(prompt, /\/skill:impeccable init/);
            assert.match(prompt, /ask_user_question/);
            assert.match(prompt, /prototype, wireframe, page, component, theme, tokens/);
            assert.match(prompt, /Let impeccable init perform its own PRODUCT\.md\/DESIGN\.md detection/);
            assert.doesNotMatch(prompt, /<discovery_context>/);
            assert.equal(result.discovery.brief, "A confirmed kanban board brief.");
            assert.equal(result.discovery.output_type, "component");
            assert.deepEqual(result.discovery.references, [
                "https://example.com/a",
                "./mock.png",
            ]);
            assert.match(result.discoveryContext, /A confirmed kanban board brief/);
            assert.match(result.projectContext.summary, /shape.*init/s);
        });

        test("falls back to the raw prompt and empty references when unstructured", async () => {
            const { calls, designContext } = makeRecorder(() => "not json");
            const result = await runDiscoveryAndInit({
                designContext,
                prompt: "Design a dashboard",
                discoveryConfig: {},
            });
            assert.deepEqual(calls.tasks, ["discovery"]);
            assert.equal(result.discovery.brief, "Design a dashboard");
            assert.equal(result.discovery.output_type, "prototype");
            assert.deepEqual(result.discovery.references, []);
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

        test("per-iteration prompt does not leak the iteration counter", () => {
            const prompt = buildLivePreviewDisplayPrompt({
                previewPath: "/tmp/run/preview.html",
                previewFileUrl: "file:///tmp/run/preview.html",
                browserBootstrapRules: "rules",
                iteration: 2,
                maxRefinements: 3,
            });
            assert.match(prompt, /the revised preview/);
            assert.doesNotMatch(prompt, /iteration \d+\/\d+/);
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
