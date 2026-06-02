/**
 * Tests for module-import behavior in src/extension/discovery.ts
 *
 * Covers the new module-imports requirements:
 *   - .ts, .js, .mjs, .cjs file extension support in scanWorkflowDir
 *   - Default export AND named exports both collected (not OR)
 *   - IMPORT_FAILED diagnostic on bad files
 *   - PATH_NOT_FOUND diagnostic on missing config paths
 *   - configuredName in DiscoverySource when using named-map config
 *   - Precedence: settings-project > project-local > settings-global > user-global
 *   - DiscoverySource.filePath populated for fs-loaded workflows
 *
 * Uses temp directories created per test to exercise discoverWorkflows().
 */

import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  discoverWorkflows,
} from "../../packages/workflows/src/extension/discovery.js";

// ---------------------------------------------------------------------------
// Temp dir management
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "pi-wf-test-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Canonical valid workflow JS source (default export). */
function validDefaultExportSrc(name: string, normalizedName: string): string {
  return `
import { defineWorkflow } from "@bastani/workflows";
const wf = defineWorkflow(${JSON.stringify(normalizedName)})
  .description(${JSON.stringify(name)} + " test workflow")
  .run(async (ctx) => { await ctx.task("validation-smoke", { prompt: "validation smoke" }); return {}; })
  .compile();
if (wf.normalizedName !== ${JSON.stringify(normalizedName)}) throw new Error("unexpected normalized name");
export default wf;
`;
}

/** Valid workflow JS source as named export. */
function validNamedExportSrc(name: string, normalizedName: string, exportName = "workflow"): string {
  return `
import { defineWorkflow } from "@bastani/workflows";
export const ${exportName} = defineWorkflow(${JSON.stringify(normalizedName)})
  .description(${JSON.stringify(name)} + " test workflow")
  .run(async (ctx) => { await ctx.task("validation-smoke", { prompt: "validation smoke" }); return {}; })
  .compile();
if (${exportName}.normalizedName !== ${JSON.stringify(normalizedName)}) throw new Error("unexpected normalized name");
`;
}

/** File with both a valid default export AND a valid named export. */
function validDefaultAndNamedExportSrc(
  defaultName: string,
  defaultNorm: string,
  namedName: string,
  namedNorm: string,
): string {
  return `
import { defineWorkflow } from "@bastani/workflows";
const first = defineWorkflow(${JSON.stringify(defaultNorm)})
  .description(${JSON.stringify(defaultName)} + " default export workflow")
  .run(async (ctx) => { await ctx.task("validation-smoke", { prompt: "validation smoke" }); return {}; })
  .compile();
if (first.normalizedName !== ${JSON.stringify(defaultNorm)}) throw new Error("unexpected normalized name");
export default first;

export const second = defineWorkflow(${JSON.stringify(namedNorm)})
  .description(${JSON.stringify(namedName)} + " named export workflow")
  .run(async (ctx) => { await ctx.task("validation-smoke", { prompt: "validation smoke" }); return {}; })
  .compile();
if (second.normalizedName !== ${JSON.stringify(namedNorm)}) throw new Error("unexpected normalized name");
`;
}

/** Create a directory structure: <tmpRoot>/cwd/.atomic/workflows/<file> */
async function createProjectWorkflowFile(filename: string, content: string): Promise<string> {
  const dir = join(tmpRoot, "cwd", ".atomic", "workflows");
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, filename);
  await writeFile(filePath, content, "utf8");
  return filePath;
}

/** Create a directory structure: <tmpRoot>/home/.atomic/agent/workflows/<file> */
async function createUserGlobalWorkflowFile(filename: string, content: string): Promise<string> {
  const dir = join(tmpRoot, "home", ".atomic", "agent", "workflows");
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, filename);
  await writeFile(filePath, content, "utf8");
  return filePath;
}

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
const { defineWorkflow } = require("@bastani/workflows");
module.exports = defineWorkflow("Gamma")
  .description("cjs workflow")
  .run(async (ctx) => { await ctx.task("validation-smoke", { prompt: "validation smoke" }); return {}; })
  .compile();
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
import { defineWorkflow } from "@bastani/workflows";
export default defineWorkflow("conflict-alpha")
  .description("conflict-alpha")
  .run(async (ctx) => { await ctx.task("validation-smoke", { prompt: "validation smoke" }); return {}; })
  .compile();
export const named = defineWorkflow("conflict-alpha")
  .description("Alpha Named")
  .run(async (ctx) => { await ctx.task("validation-smoke", { prompt: "validation smoke" }); return {}; })
  .compile();
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
import { defineWorkflow } from "@bastani/workflows";
export default defineWorkflow("Valid Default")
  .run(async (ctx) => { await ctx.task("validation-smoke", { prompt: "validation smoke" }); return {}; })
  .compile();
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

  test("removed runWorkflow named import fails during workflow loading", async () => {
    await createProjectWorkflowFile(
      "removed-api.js",
      `
import { defineWorkflow, runWorkflow } from "@bastani/workflows";
void runWorkflow;
export default defineWorkflow("removed-api-import")
  .run(async () => ({}))
  .compile();
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

  test("removed runWorkflow namespace import reference fails during workflow loading", async () => {
    await createProjectWorkflowFile(
      "removed-namespace.js",
      `
import * as workflows from "@bastani/workflows";
void workflows.runWorkflow;
export default workflows.defineWorkflow("removed-namespace-import")
  .run(async () => ({}))
  .compile();
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

  test("removed runWorkflow CJS destructured require fails during workflow loading", async () => {
    await createProjectWorkflowFile(
      "removed-require.cjs",
      `
const { defineWorkflow, runWorkflow } = require("@bastani/workflows");
void runWorkflow;
exports.default = defineWorkflow("removed-require-destructured")
  .run(async () => ({}))
  .compile();
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

  test("removed runWorkflow CJS namespace require reference fails during workflow loading", async () => {
    await createProjectWorkflowFile(
      "removed-require-namespace.cjs",
      `
const workflows = require("@bastani/workflows");
void workflows.runWorkflow;
exports.default = workflows.defineWorkflow("removed-require-namespace")
  .run(async () => ({}))
  .compile();
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

  test("removed runWorkflow namespace destructuring fails during workflow loading", async () => {
    await createProjectWorkflowFile(
      "removed-namespace-destructure.js",
      `
import * as workflows from "@bastani/workflows";
const { runWorkflow } = workflows;
void runWorkflow;
export default workflows.defineWorkflow("removed-namespace-destructure")
  .run(async () => ({}))
  .compile();
`,
    );
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
    });
    assert.equal(result.registry.has("removed-namespace-destructure"), false);
    const importFailed = result.errors.filter((e) => e.code === "IMPORT_FAILED");
    assert.equal(importFailed.length, 1);
    assert.match(importFailed[0]!.message, /no longer exports runWorkflow/);
  });

  test("removed runWorkflow CJS namespace destructuring fails during workflow loading", async () => {
    await createProjectWorkflowFile(
      "removed-require-namespace-destructure.cjs",
      `
const workflows = require("@bastani/workflows");
const { runWorkflow } = workflows;
void runWorkflow;
exports.default = workflows.defineWorkflow("removed-require-namespace-destructure")
  .run(async () => ({}))
  .compile();
`,
    );
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
    });
    assert.equal(result.registry.has("removed-require-namespace-destructure"), false);
    const importFailed = result.errors.filter((e) => e.code === "IMPORT_FAILED");
    assert.equal(importFailed.length, 1);
    assert.match(importFailed[0]!.message, /no longer exports runWorkflow/);
  });

  test("removed runWorkflow dynamic import destructuring fails during workflow loading", async () => {
    await createProjectWorkflowFile(
      "removed-dynamic-destructure.js",
      `
import { defineWorkflow } from "@bastani/workflows";
(async () => {
  const { runWorkflow } = await import("@bastani/workflows");
  void runWorkflow;
})();
export default defineWorkflow("removed-dynamic-destructure")
  .run(async () => ({}))
  .compile();
`,
    );
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
    });
    assert.equal(result.registry.has("removed-dynamic-destructure"), false);
    const importFailed = result.errors.filter((e) => e.code === "IMPORT_FAILED");
    assert.equal(importFailed.length, 1);
    assert.match(importFailed[0]!.message, /no longer exports runWorkflow/);
  });

  test("removed runWorkflow direct require property reference fails during workflow loading", async () => {
    await createProjectWorkflowFile(
      "removed-require-property.cjs",
      `
const { defineWorkflow } = require("@bastani/workflows");
void require("@bastani/workflows").runWorkflow;
exports.default = defineWorkflow("removed-require-property")
  .run(async () => ({}))
  .compile();
`,
    );
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
    });
    assert.equal(result.registry.has("removed-require-property"), false);
    const importFailed = result.errors.filter((e) => e.code === "IMPORT_FAILED");
    assert.equal(importFailed.length, 1);
    assert.match(importFailed[0]!.message, /no longer exports runWorkflow/);
  });

  test("removed runWorkflow dynamic namespace import reference fails during workflow loading", async () => {
    await createProjectWorkflowFile(
      "removed-dynamic-namespace.js",
      `
import { defineWorkflow } from "@bastani/workflows";
(async () => {
  const workflows = await import("@bastani/workflows");
  void workflows.runWorkflow;
})();
export default defineWorkflow("removed-dynamic-namespace")
  .run(async () => ({}))
  .compile();
`,
    );
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
    });
    assert.equal(result.registry.has("removed-dynamic-namespace"), false);
    const importFailed = result.errors.filter((e) => e.code === "IMPORT_FAILED");
    assert.equal(importFailed.length, 1);
    assert.match(importFailed[0]!.message, /no longer exports runWorkflow/);
  });

  test("removed runWorkflow typed dynamic namespace import reference fails during workflow loading", async () => {
    await createProjectWorkflowFile(
      "removed-dynamic-namespace-typed.ts",
      `
import { defineWorkflow } from "@bastani/workflows";
(async () => {
  const workflows: typeof import("@bastani/workflows") = await import("@bastani/workflows");
  void workflows.runWorkflow;
})();
export default defineWorkflow("removed-dynamic-namespace-typed")
  .run(async () => ({}))
  .compile();
`,
    );
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
    });
    assert.equal(result.registry.has("removed-dynamic-namespace-typed"), false);
    const importFailed = result.errors.filter((e) => e.code === "IMPORT_FAILED");
    assert.equal(importFailed.length, 1);
    assert.match(importFailed[0]!.message, /no longer exports runWorkflow/);
  });

  test("removed runWorkflow re-export fails during workflow loading", async () => {
    await createProjectWorkflowFile(
      "removed-re-export.js",
      `
import { defineWorkflow } from "@bastani/workflows";
export { runWorkflow as removedRunWorkflow } from "@bastani/workflows";
export default defineWorkflow("removed-re-export")
  .run(async () => ({}))
  .compile();
`,
    );
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
    });
    assert.equal(result.registry.has("removed-re-export"), false);
    const importFailed = result.errors.filter((e) => e.code === "IMPORT_FAILED");
    assert.equal(importFailed.length, 1);
    assert.match(importFailed[0]!.message, /no longer exports runWorkflow/);
  });

  test("removed runWorkflow namespace re-export reference fails during workflow loading", async () => {
    await createProjectWorkflowFile(
      "removed-namespace-re-export.js",
      `
import { defineWorkflow } from "@bastani/workflows";
export * as workflows from "@bastani/workflows";
void workflows.runWorkflow;
export default defineWorkflow("removed-namespace-re-export")
  .run(async () => ({}))
  .compile();
`,
    );
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
    });
    assert.equal(result.registry.has("removed-namespace-re-export"), false);
    const importFailed = result.errors.filter((e) => e.code === "IMPORT_FAILED");
    assert.equal(importFailed.length, 1);
    assert.match(importFailed[0]!.message, /no longer exports runWorkflow/);
  });

  test("comments mentioning removed runWorkflow do not fail workflow loading", async () => {
    await createProjectWorkflowFile(
      "removed-comment.js",
      `
import { defineWorkflow } from "@bastani/workflows";
// import { runWorkflow } from "@bastani/workflows"; removed migration note only
export default defineWorkflow("removed-comment")
  .run(async () => ({}))
  .compile();
`,
    );
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
    });
    assert.equal(result.registry.has("removed-comment"), true);
    const importFailed = result.errors.filter((e) => e.code === "IMPORT_FAILED");
    assert.equal(importFailed.length, 0);
  });

  test("strings mentioning removed runWorkflow do not fail workflow loading", async () => {
    await createProjectWorkflowFile(
      "removed-string.js",
      `
import { defineWorkflow } from "@bastani/workflows";
const docs = [
  'import { runWorkflow } from "@bastani/workflows";',
  "const workflows = await import('@bastani/workflows'); workflows.runWorkflow;",
].join("\\n");
void docs;
export default defineWorkflow("removed-string")
  .run(async () => ({}))
  .compile();
`,
    );
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
    });
    assert.equal(result.registry.has("removed-string"), true);
    const importFailed = result.errors.filter((e) => e.code === "IMPORT_FAILED");
    assert.equal(importFailed.length, 0);
  });
});

// ---------------------------------------------------------------------------
// PATH_NOT_FOUND diagnostic
// ---------------------------------------------------------------------------

describe("PATH_NOT_FOUND diagnostic", () => {
  test("emits PATH_NOT_FOUND for missing projectWorkflows path (array form)", async () => {
    const missingPath = join(tmpRoot, "nonexistent", "workflow.js");
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
      config: {
        projectWorkflows: [missingPath],
      },
    });
    const pathErrors = result.errors.filter((e) => e.code === "PATH_NOT_FOUND");
    assert.equal(pathErrors.length, 1);
    assert.equal(pathErrors[0]!.level, "error");
    assert.equal(pathErrors[0]!.source, missingPath);
  });

  test("emits PATH_NOT_FOUND for missing globalWorkflows path", async () => {
    const missingPath = join(tmpRoot, "ghost", "wf.js");
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
      config: {
        globalWorkflows: [missingPath],
      },
    });
    const pathErrors = result.errors.filter((e) => e.code === "PATH_NOT_FOUND");
    assert.equal(pathErrors.length, 1);
    assert.equal(pathErrors[0]!.source, missingPath);
  });

  test("PATH_NOT_FOUND does not block other valid paths from loading", async () => {
    const missingPath = join(tmpRoot, "missing.js");
    const goodPath = join(tmpRoot, "present.js");
    await writeFile(goodPath, validDefaultExportSrc("Present", "present"), "utf8");
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
      config: {
        projectWorkflows: [missingPath, goodPath],
      },
    });
    const pathErrors = result.errors.filter((e) => e.code === "PATH_NOT_FOUND");
    assert.equal(pathErrors.length, 1);
    assert.equal(result.registry.has("present"), true);
  });
});

// ---------------------------------------------------------------------------
// configuredName in DiscoverySource (named-map config)
// ---------------------------------------------------------------------------

describe("DiscoverySource.configuredName — named-map DiscoveryConfig", () => {
  test("configuredName is populated when using Record<string, string> projectWorkflows", async () => {
    const wfPath = join(tmpRoot, "my-workflow.js");
    await writeFile(wfPath, validDefaultExportSrc("My Workflow", "my-workflow"), "utf8");
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
      config: {
        projectWorkflows: { "my-custom-key": wfPath },
      },
    });
    assert.equal(result.registry.has("my-workflow"), true);
    const src = result.sources.find((s) => s.id === "my-workflow");
    assert.notEqual(src, undefined);
    assert.equal(src!.configuredName, "my-custom-key");
  });

  test("configuredName is populated for globalWorkflows named map", async () => {
    const wfPath = join(tmpRoot, "global-wf.js");
    await writeFile(wfPath, validDefaultExportSrc("Global WF", "global-wf"), "utf8");
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
      config: {
        globalWorkflows: { "global-key": wfPath },
      },
    });
    assert.equal(result.registry.has("global-wf"), true);
    const src = result.sources.find((s) => s.id === "global-wf");
    assert.equal(src!.configuredName, "global-key");
  });

  test("configuredName is undefined for dir-scanned (project-local) workflows", async () => {
    await createProjectWorkflowFile(
      "local.js",
      validDefaultExportSrc("Local", "local"),
    );
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
    });
    const src = result.sources.find((s) => s.id === "local");
    assert.notEqual(src, undefined);
    assert.equal(src!.configuredName, undefined);
  });

  test("configuredName is undefined when using plain string[] projectWorkflows", async () => {
    const wfPath = join(tmpRoot, "arr-wf.js");
    await writeFile(wfPath, validDefaultExportSrc("Arr WF", "arr-wf"), "utf8");
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
      config: {
        projectWorkflows: [wfPath],
      },
    });
    const src = result.sources.find((s) => s.id === "arr-wf");
    assert.equal(src!.configuredName, undefined);
  });
});

// ---------------------------------------------------------------------------
// DiscoverySource.filePath populated for fs-loaded workflows
// ---------------------------------------------------------------------------

describe("DiscoverySource.filePath", () => {
  test("filePath is set for project-local workflows", async () => {
    const fp = await createProjectWorkflowFile(
      "fp-test.js",
      validDefaultExportSrc("FP Test", "fp-test"),
    );
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
    });
    const src = result.sources.find((s) => s.id === "fp-test");
    assert.notEqual(src, undefined);
    assert.equal(src!.filePath, fp);
  });

  test("filePath is set for settings-project workflows", async () => {
    const wfPath = join(tmpRoot, "settings-wf.js");
    await writeFile(wfPath, validDefaultExportSrc("Settings WF", "settings-wf"), "utf8");
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
      config: { projectWorkflows: [wfPath] },
    });
    const src = result.sources.find((s) => s.id === "settings-wf");
    assert.equal(src!.filePath, wfPath);
  });

  test("filePath is undefined for bundled workflows", async () => {
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: true,
    });
    const bundled = result.sources.filter((s) => s.kind === "bundled");
    for (const s of bundled) {
      assert.equal(s.filePath, undefined);
    }
  });
});

// ---------------------------------------------------------------------------
// Precedence: settings-project > project-local > settings-global > user-global
// ---------------------------------------------------------------------------

describe("discoverWorkflows — precedence order", () => {
  test("settings-project wins over project-local (same normalizedName)", async () => {
    // project-local file with normalizedName "conflict"
    await createProjectWorkflowFile(
      "conflict.js",
      validDefaultExportSrc("pl-sg-conflict", "prec-conflict"),
    );
    // settings-project path with same normalizedName
    const spPath = join(tmpRoot, "sp-conflict.js");
    await writeFile(spPath, validDefaultExportSrc("prec-conflict", "prec-conflict"), "utf8");

    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
      config: { projectWorkflows: [spPath] },
    });
    // settings-project registered first (higher precedence)
    assert.equal(result.registry.has("prec-conflict"), true);
    assert.equal(result.registry.get("prec-conflict")?.name, "prec-conflict");
    // project-local emits DUPLICATE_NAME
    const dupes = result.errors.filter((e) => e.code === "DUPLICATE_NAME");
    assert.ok(dupes.length >= 1);
  });

  test("project-local wins over settings-global (same normalizedName)", async () => {
    await createProjectWorkflowFile(
      "pl-sg.js",
      validDefaultExportSrc("pl-sg-conflict", "pl-sg-conflict"),
    );
    const sgPath = join(tmpRoot, "sg-wf.js");
    await writeFile(sgPath, validDefaultExportSrc("sg-ug-conflict", "pl-sg-conflict"), "utf8");

    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
      config: { globalWorkflows: [sgPath] },
    });
    assert.equal(result.registry.get("pl-sg-conflict")?.name, "pl-sg-conflict");
  });

  test("settings-global wins over user-global (same normalizedName)", async () => {
    await createUserGlobalWorkflowFile(
      "ug.js",
      validDefaultExportSrc("From User Global", "sg-ug-conflict"),
    );
    const sgPath = join(tmpRoot, "sg-ug.js");
    await writeFile(sgPath, validDefaultExportSrc("sg-ug-conflict", "sg-ug-conflict"), "utf8");

    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
      config: { globalWorkflows: [sgPath] },
    });
    assert.equal(result.registry.get("sg-ug-conflict")?.name, "sg-ug-conflict");
  });

  test("user-global wins over bundled (same normalizedName)", async () => {
    // Use a name that matches a bundled workflow
    await createUserGlobalWorkflowFile(
      "ralph-override.js",
      validDefaultExportSrc("ralph", "ralph"),
    );
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: true,
    });
    assert.equal(result.registry.get("ralph")?.name, "ralph");
    const bundledWarning = result.errors.filter(
      (e) => e.code === "DUPLICATE_NAME" && e.source === "ralph",
    );
    assert.ok(bundledWarning.length >= 1);
  });

  test("sources reflect correct kind for each precedence tier", async () => {
    const spPath = join(tmpRoot, "sp.js");
    const sgPath = join(tmpRoot, "sg.js");
    await writeFile(spPath, validDefaultExportSrc("SP Workflow", "sp-only"), "utf8");
    await writeFile(sgPath, validDefaultExportSrc("SG Workflow", "sg-only"), "utf8");
    await createProjectWorkflowFile("pl.js", validDefaultExportSrc("PL Workflow", "pl-only"));
    await createUserGlobalWorkflowFile("ug.js", validDefaultExportSrc("UG Workflow", "ug-only"));

    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
      config: {
        projectWorkflows: [spPath],
        globalWorkflows: [sgPath],
      },
    });

    const kindOf = (id: string) => result.sources.find((s) => s.id === id)?.kind;
    assert.equal(kindOf("sp-only"), "settings-project");
    assert.equal(kindOf("pl-only"), "project-local");
    assert.equal(kindOf("sg-only"), "settings-global");
    assert.equal(kindOf("ug-only"), "user-global");
  });
});

// ---------------------------------------------------------------------------
// Removed runWorkflow API diagnostics
// ---------------------------------------------------------------------------

describe("discoverWorkflows — removed runWorkflow diagnostics", () => {
  test("rejects runWorkflow references through later CJS namespace declarators", async () => {
    const workflowPath = await createProjectWorkflowFile(
      "removed-run-workflow-later-declarator.cjs",
      `
const { defineWorkflow } = require("@bastani/workflows");
const ignored = 1, workflows = require("@bastani/workflows");
void workflows.runWorkflow;
module.exports = defineWorkflow("later-cjs-run-workflow")
  .description("removed API diagnostic")
  .run(async () => ({}))
  .compile();
`,
    );

    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
    });

    assert.equal(result.registry.has("later-cjs-run-workflow"), false);
    assert.ok(
      result.errors.some(
        (e) => e.code === "IMPORT_FAILED" && e.source === workflowPath && /runWorkflow/.test(e.message),
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// User-global path: ~/.atomic/agent/workflows/
// ---------------------------------------------------------------------------

describe("discoverWorkflows — user-global path", () => {
  test("scans ~/.atomic/agent/workflows/ for user-global workflows", async () => {
    await createUserGlobalWorkflowFile(
      "user-wf.js",
      validDefaultExportSrc("User Global WF", "user-global-wf"),
    );
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
    });
    assert.equal(result.registry.has("user-global-wf"), true);
    const src = result.sources.find((s) => s.id === "user-global-wf");
    assert.equal(src?.kind, "user-global");
    assert.ok(src?.filePath!.includes(join(".atomic", "agent", "workflows")));
  });

  test("missing ~/.atomic/agent/workflows/ dir is silently skipped (no error)", async () => {
    // Don't create the user-global dir
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
    });
    const errors = result.errors.filter((e) => e.code !== "DUPLICATE_NAME");
    assert.equal(errors.length, 0);
  });
});

// ---------------------------------------------------------------------------
// CONFIG_INVALID diagnostic for malformed DiscoveryConfig
// ---------------------------------------------------------------------------

describe("discoverWorkflows — CONFIG_INVALID diagnostic", () => {
  test("emits CONFIG_INVALID when config has non-string entry in array", async () => {
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
      // @ts-expect-error: intentionally invalid for runtime test
      config: { projectWorkflows: [42] },
    });
    const configErrors = result.errors.filter((e) => e.code === "CONFIG_INVALID");
    assert.ok(configErrors.length >= 1);
  });
});
