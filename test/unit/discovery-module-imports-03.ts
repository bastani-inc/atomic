import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { discoverWorkflows } from "../../packages/workflows/src/extension/discovery.js";
import {
  createProjectWorkflowFile,
  createUserGlobalWorkflowFile,
  tmpRoot,
  validDefaultExportSrc,
} from "./discovery-module-imports-helpers.js";

export function registerDiscoveryModuleImportsSuite3(): void {
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
    test("rejects runWorkflow calls through later CJS namespace declarators", async () => {
      const workflowPath = await createProjectWorkflowFile(
        "removed-run-workflow-later-declarator.cjs",
        `
  const { defineWorkflow } = require("@bastani/workflows");
  const ignored = 1, workflows = require("@bastani/workflows");
  workflows.runWorkflow();
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
}
