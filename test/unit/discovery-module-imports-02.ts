import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { discoverWorkflows } from "../../packages/workflows/src/extension/discovery.js";
import {
  createProjectWorkflowFile,
  tmpRoot,
  validDefaultAndNamedExportSrc,
  validDefaultExportSrc,
  validNamedExportSrc,
} from "./discovery-module-imports-helpers.js";

export function registerDiscoveryModuleImportsSuite2(): void {
  // ---------------------------------------------------------------------------

  describe("importWorkflowFile — default AND named exports", () => {
    test("collects both default export and named export from same file", async () => {
      await createProjectWorkflowFile(
        "multi.js",
        validDefaultAndNamedExportSrc("First", "first", "Second", "second"),
      );
      const result = await discoverWorkflows({
        cwd: join(tmpRoot, "cwd"),
        homeDir: join(tmpRoot, "home"),
        includeBundled: false,
      });
      assert.equal(result.registry.has("first"), true);
      assert.equal(result.registry.has("second"), true);
    });

    test("default export is registered first (wins on duplicate normalizedName with named export)", async () => {
      // Both default and named export have the same normalizedName → default wins, named is DUPLICATE_NAME
      await createProjectWorkflowFile(
        "conflict.js",
        `
  import { workflow } from "@bastani/workflows";
  export default workflow({
    name: "conflict-alpha",
    description: "conflict-alpha",
    inputs: {},
    outputs: {},
    run: async (ctx) => { await ctx.task("validation-smoke", { prompt: "validation smoke" }); return {}; },
  });
  export const named = workflow({
    name: "conflict-alpha",
    description: "Alpha Named",
    inputs: {},
    outputs: {},
    run: async (ctx) => { await ctx.task("validation-smoke", { prompt: "validation smoke" }); return {}; },
  });
  `,
      );
      const result = await discoverWorkflows({
        cwd: join(tmpRoot, "cwd"),
        homeDir: join(tmpRoot, "home"),
        includeBundled: false,
      });
      // Default wins
      assert.equal(result.registry.has("conflict-alpha"), true);
      assert.equal(result.registry.get("conflict-alpha")?.name, "conflict-alpha");
      // Named emits DUPLICATE_NAME
      const dupes = result.errors.filter((e) => e.code === "DUPLICATE_NAME");
      assert.ok(dupes.length >= 1);
    });

    test("named exports collected even when no default export exists", async () => {
      await createProjectWorkflowFile(
        "named-only.js",
        validNamedExportSrc("Named Only", "named-only"),
      );
      const result = await discoverWorkflows({
        cwd: join(tmpRoot, "cwd"),
        homeDir: join(tmpRoot, "home"),
        includeBundled: false,
      });
      assert.equal(result.registry.has("named-only"), true);
    });

    test("named exports that fail validation emit INVALID_DEFINITION, others still register", async () => {
      await createProjectWorkflowFile(
        "mixed-validity.js",
        `
  import { workflow } from "@bastani/workflows";
  export default workflow({
    name: "Valid Default",
    description: "",
    inputs: {},
    outputs: {},
    run: async (ctx) => { await ctx.task("validation-smoke", { prompt: "validation smoke" }); return {}; },
  });
  export const bad = { notAWorkflow: true };
  `,
      );
      const result = await discoverWorkflows({
        cwd: join(tmpRoot, "cwd"),
        homeDir: join(tmpRoot, "home"),
        includeBundled: false,
      });
      assert.equal(result.registry.has("valid-default"), true);
      const invalids = result.errors.filter((e) => e.code === "INVALID_DEFINITION");
      assert.ok(invalids.length >= 1);
      assert.ok(invalids[0]!.source!.includes("mixed-validity.js"));
    });
  });

  // ---------------------------------------------------------------------------
  // IMPORT_FAILED diagnostic
  // ---------------------------------------------------------------------------

  describe("IMPORT_FAILED diagnostic", () => {
    test("emits IMPORT_FAILED when file has syntax error", async () => {
      await createProjectWorkflowFile(
        "broken.js",
        "this is not valid javascript }{{{",
      );
      const result = await discoverWorkflows({
        cwd: join(tmpRoot, "cwd"),
        homeDir: join(tmpRoot, "home"),
        includeBundled: false,
      });
      const importFailed = result.errors.filter((e) => e.code === "IMPORT_FAILED");
      assert.ok(importFailed.length >= 1);
      assert.equal(importFailed[0]!.level, "error");
      assert.ok(importFailed[0]!.source!.includes("broken.js"));
      assert.equal(typeof importFailed[0]!.message, "string");
    });

    test("IMPORT_FAILED does not block other files from being discovered", async () => {
      await createProjectWorkflowFile("broken.js", "}{{{ syntax error");
      await createProjectWorkflowFile(
        "good.js",
        validDefaultExportSrc("Good Workflow", "good-workflow"),
      );
      const result = await discoverWorkflows({
        cwd: join(tmpRoot, "cwd"),
        homeDir: join(tmpRoot, "home"),
        includeBundled: false,
      });
      assert.equal(result.registry.has("good-workflow"), true);
      const importFailed = result.errors.filter((e) => e.code === "IMPORT_FAILED");
      assert.ok(importFailed.length >= 1);
    });

    test("removed runWorkflow named import stub fails when called during workflow loading", async () => {
      await createProjectWorkflowFile(
        "removed-api.js",
        `
  import { workflow, runWorkflow } from "@bastani/workflows";
  runWorkflow();
  export default workflow({
    name: "removed-api-import",
    description: "",
    inputs: {},
    outputs: {},
    run: async () => ({}),
  });
  `,
      );
      const result = await discoverWorkflows({
        cwd: join(tmpRoot, "cwd"),
        homeDir: join(tmpRoot, "home"),
        includeBundled: false,
      });
      assert.equal(result.registry.has("removed-api-import"), false);
      const importFailed = result.errors.filter((e) => e.code === "IMPORT_FAILED");
      assert.equal(importFailed.length, 1);
      assert.match(importFailed[0]!.message, /no longer exports runWorkflow/);
    });

    test("removed runWorkflow namespace stub fails when called during workflow loading", async () => {
      await createProjectWorkflowFile(
        "removed-namespace.js",
        `
  import * as workflows from "@bastani/workflows";
  workflows.runWorkflow();
  export default workflows.workflow({
    name: "removed-namespace-import",
    description: "",
    inputs: {},
    outputs: {},
    run: async () => ({}),
  });
  `,
      );
      const result = await discoverWorkflows({
        cwd: join(tmpRoot, "cwd"),
        homeDir: join(tmpRoot, "home"),
        includeBundled: false,
      });
      assert.equal(result.registry.has("removed-namespace-import"), false);
      const importFailed = result.errors.filter((e) => e.code === "IMPORT_FAILED");
      assert.equal(importFailed.length, 1);
      assert.match(importFailed[0]!.message, /no longer exports runWorkflow/);
    });

    test("removed runWorkflow CJS destructured stub fails when called during workflow loading", async () => {
      await createProjectWorkflowFile(
        "removed-require.cjs",
        `
  const { workflow, runWorkflow } = require("@bastani/workflows");
  runWorkflow();
  exports.default = workflow({
    name: "removed-require-destructured",
    description: "",
    inputs: {},
    outputs: {},
    run: async () => ({}),
  });
  `,
      );
      const result = await discoverWorkflows({
        cwd: join(tmpRoot, "cwd"),
        homeDir: join(tmpRoot, "home"),
        includeBundled: false,
      });
      assert.equal(result.registry.has("removed-require-destructured"), false);
      const importFailed = result.errors.filter((e) => e.code === "IMPORT_FAILED");
      assert.equal(importFailed.length, 1);
      assert.match(importFailed[0]!.message, /no longer exports runWorkflow/);
    });

    test("removed runWorkflow CJS namespace stub fails when called during workflow loading", async () => {
      await createProjectWorkflowFile(
        "removed-require-namespace.cjs",
        `
  const workflows = require("@bastani/workflows");
  workflows.runWorkflow();
  exports.default = workflows.workflow({
    name: "removed-require-namespace",
    description: "",
    inputs: {},
    outputs: {},
    run: async () => ({}),
  });
  `,
      );
      const result = await discoverWorkflows({
        cwd: join(tmpRoot, "cwd"),
        homeDir: join(tmpRoot, "home"),
        includeBundled: false,
      });
      assert.equal(result.registry.has("removed-require-namespace"), false);
      const importFailed = result.errors.filter((e) => e.code === "IMPORT_FAILED");
      assert.equal(importFailed.length, 1);
      assert.match(importFailed[0]!.message, /no longer exports runWorkflow/);
    });

    test("removed runWorkflow reference-only imports still load", async () => {
      await createProjectWorkflowFile(
        "removed-reference-only.ts",
        `
  import { workflow, runWorkflow } from "@bastani/workflows";
  const pattern = /runWorkflow/;
  const identity = <T,>(value: T): T => value;
  void pattern;
  void identity(runWorkflow);
  export default workflow({
    name: "removed-reference-only",
    description: "",
    inputs: {},
    outputs: {},
    run: async () => ({}),
  });
  `,
      );
      const result = await discoverWorkflows({
        cwd: join(tmpRoot, "cwd"),
        homeDir: join(tmpRoot, "home"),
        includeBundled: false,
      });
      assert.equal(result.registry.has("removed-reference-only"), true);
      const importFailed = result.errors.filter((e) => e.code === "IMPORT_FAILED");
      assert.equal(importFailed.length, 0);
    });

    test("comments and strings mentioning removed runWorkflow do not fail workflow loading", async () => {
      await createProjectWorkflowFile(
        "removed-comment-string.js",
        `
  import { workflow } from "@bastani/workflows";
  // import { runWorkflow } from "@bastani/workflows"; removed migration note only
  const docs = [
    'import { runWorkflow } from "@bastani/workflows";',
    "const workflows = await import('@bastani/workflows'); workflows.runWorkflow();",
  ].join("\\n");
  void docs;
  export default workflow({
    name: "removed-comment-string",
    description: "",
    inputs: {},
    outputs: {},
    run: async () => ({}),
  });
  `,
      );
      const result = await discoverWorkflows({
        cwd: join(tmpRoot, "cwd"),
        homeDir: join(tmpRoot, "home"),
        includeBundled: false,
      });
      assert.equal(result.registry.has("removed-comment-string"), true);
      const importFailed = result.errors.filter((e) => e.code === "IMPORT_FAILED");
      assert.equal(importFailed.length, 0);
    });
  });
}
