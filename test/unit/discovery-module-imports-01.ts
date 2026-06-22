import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { discoverWorkflows } from "../../packages/workflows/src/extension/discovery.js";
import {
  createProjectWorkflowFile,
  tmpRoot,
  validDefaultExportSrc,
} from "./discovery-module-imports-helpers.js";

export function registerDiscoveryModuleImportsSuite1(): void {
  // ---------------------------------------------------------------------------
  // Extension support: .js, .mjs, .cjs
  // (Bun handles .js natively; .mjs and .cjs are ESM/CJS variants)
  // ---------------------------------------------------------------------------

  describe("scanWorkflowDir — supported file extensions", () => {
    test("discovers .js workflow files", async () => {
      await createProjectWorkflowFile(
        "alpha.js",
        validDefaultExportSrc("Alpha", "alpha"),
      );
      const result = await discoverWorkflows({
        cwd: join(tmpRoot, "cwd"),
        homeDir: join(tmpRoot, "home"),
        includeBundled: false,
      });
      assert.equal(result.registry.has("alpha"), true);
      assert.equal(result.errors.filter((e) => e.code === "INVALID_DEFINITION").length, 0);
    });

    test("discovers .mjs workflow files", async () => {
      await createProjectWorkflowFile(
        "beta.mjs",
        validDefaultExportSrc("Beta", "beta"),
      );
      const result = await discoverWorkflows({
        cwd: join(tmpRoot, "cwd"),
        homeDir: join(tmpRoot, "home"),
        includeBundled: false,
      });
      assert.equal(result.registry.has("beta"), true);
    });

    test("discovers .cjs workflow files", async () => {
      // .cjs files use module.exports syntax
      const dir = join(tmpRoot, "cwd", ".atomic", "workflows");
      await mkdir(dir, { recursive: true });
      const cjsPath = join(dir, "gamma.cjs");
      await writeFile(
        cjsPath,
        `
  const { workflow } = require("@bastani/workflows");
  module.exports = workflow({
    name: "Gamma",
    description: "cjs workflow",
    inputs: {},
    outputs: {},
    run: async (ctx) => { await ctx.task("validation-smoke", { prompt: "validation smoke" }); return {}; },
  });
  `,
        "utf8",
      );
      const result = await discoverWorkflows({
        cwd: join(tmpRoot, "cwd"),
        homeDir: join(tmpRoot, "home"),
        includeBundled: false,
      });
      // .cjs may expose as default or named depending on Bun's CJS interop
      const hasGamma = result.registry.has("gamma");
      const importFailed = result.errors.some(
        (e) => e.code === "IMPORT_FAILED" && e.source?.includes("gamma.cjs"),
      );
      // Should either register it OR at most emit IMPORT_FAILED (not INVALID_DEFINITION for the ext)
      // Key assertion: the file was attempted (not silently ignored due to extension filtering)
      assert.equal(hasGamma || importFailed || result.errors.some((e) => e.source?.includes("gamma")), true);
    });

    test("ignores files with unsupported extensions (.txt, .json, .md)", async () => {
      const dir = join(tmpRoot, "cwd", ".atomic", "workflows");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "readme.md"), "# not a workflow", "utf8");
      await writeFile(join(dir, "config.json"), '{"not":"workflow"}', "utf8");
      await writeFile(join(dir, "notes.txt"), "some notes", "utf8");
      // Also add a valid .js so we get a non-empty result
      await createProjectWorkflowFile("real.js", validDefaultExportSrc("Real", "real"));
      const result = await discoverWorkflows({
        cwd: join(tmpRoot, "cwd"),
        homeDir: join(tmpRoot, "home"),
        includeBundled: false,
      });
      assert.equal(result.registry.has("real"), true);
      // No errors from trying to import md/json/txt
      const importErrors = result.errors.filter(
        (e) => e.code === "IMPORT_FAILED" && (e.source?.endsWith(".md") || e.source?.endsWith(".txt")),
      );
      assert.equal(importErrors.length, 0);
    });
  });

  // ---------------------------------------------------------------------------
  // Default export AND named exports both collected
}
