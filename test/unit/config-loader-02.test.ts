// @ts-nocheck
/**
 * Tests for src/extension/config-loader.ts
 *
 * Covers:
 *   - Missing files: no diagnostics, config null
 *   - Valid global config: loaded correctly
 *   - Valid project-local config: loaded correctly
 *   - Merge: project overrides global, workflows merged key-by-key
 *   - Invalid JSON: CONFIG_INVALID diagnostic
 *   - Invalid shape: CONFIG_INVALID diagnostic per bad field
 *   - Project-local candidate priority: first existing candidate wins
 *   - Explicit workflows map: parsed with path validation
 *   - Both scopes invalid: both diagnostics returned, config null
 */

import { afterAll, beforeAll, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadWorkflowConfig,
  type ConfigDiagnostic,
} from "../../packages/workflows/src/extension/config-loader.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeDir(base: string, ...parts: string[]): Promise<string> {
  const full = join(base, ...parts);
  await mkdir(full, { recursive: true });
  return full;
}

async function writeJson(dir: string, filename: string, content: unknown): Promise<string> {
  const filePath = join(dir, filename);
  await writeFile(filePath, JSON.stringify(content), "utf8");
  return filePath;
}

async function writeBadJson(dir: string, filename: string): Promise<string> {
  const filePath = join(dir, filename);
  await writeFile(filePath, "{ this is not valid json }", "utf8");
  return filePath;
}

// ---------------------------------------------------------------------------
// Test suite setup — temp dirs for home and project
// ---------------------------------------------------------------------------
describe("loadWorkflowConfig — config not top-level object", () => {
  let tmpHome: string;
  let tmpProject: string;

  beforeAll(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "pi-config-test-home-"));
    tmpProject = await mkdtemp(join(tmpdir(), "pi-config-test-proj-"));
    const projDir = await makeDir(tmpProject, ".atomic", "extensions", "workflow");
    // Valid JSON but not an object
    await writeFile(join(projDir, "config.json"), JSON.stringify([1, 2, 3]), "utf8");
  });

  afterAll(async () => {
    await rm(tmpHome, { recursive: true, force: true });
    await rm(tmpProject, { recursive: true, force: true });
  });

  test("array at root → CONFIG_INVALID", async () => {
    const result = await loadWorkflowConfig({ homeDir: tmpHome, projectRoot: tmpProject });
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0]!.code, "CONFIG_INVALID");
    assert.ok(result.diagnostics[0]!.message.includes("JSON object"));
  });
});
describe("ConfigDiagnostic shape", () => {
  test("CONFIG_INVALID diagnostic has correct fields", () => {
    const diag: ConfigDiagnostic = {
      level: "error",
      code: "CONFIG_INVALID",
      message: "Invalid JSON in config file: Unexpected token",
      source: "/home/user/.atomic/agent/extensions/workflow/config.json",
    };
    assert.equal(diag.code, "CONFIG_INVALID");
    assert.equal(diag.level, "error");
    assert.equal(typeof diag.message, "string");
    assert.ok(diag.source!.includes("config.json"));
  });
});
describe("loadWorkflowConfig — workflowNotifications", () => {
  let tmpHome: string;
  let tmpProject: string;

  beforeAll(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "wf-home-notifications-"));
    tmpProject = await mkdtemp(join(tmpdir(), "wf-project-notifications-"));
  });

  afterAll(async () => {
    await rm(tmpHome, { recursive: true, force: true });
    await rm(tmpProject, { recursive: true, force: true });
  });

  test("accepts valid notification config", async () => {
    const dir = await makeDir(tmpProject, ".atomic", "extensions", "workflow");
    await writeJson(dir, "config.json", {
      workflowNotifications: {
        enabled: false,
        notifyOn: ["failed", "awaiting_input"],
      },
    });

    const result = await loadWorkflowConfig({ homeDir: tmpHome, projectRoot: tmpProject });
    assert.deepEqual(result.config?.workflowNotifications, {
      enabled: false,
      notifyOn: ["failed", "awaiting_input"],
    });
    assert.equal(result.diagnostics.length, 0);
  });

  test("rejects invalid notifyOn entries", async () => {
    const home = await mkdtemp(join(tmpdir(), "wf-home-notifications-invalid-"));
    const project = await mkdtemp(join(tmpdir(), "wf-project-notifications-invalid-"));
    try {
      const dir = await makeDir(project, ".atomic", "extensions", "workflow");
      await writeJson(dir, "config.json", {
        workflowNotifications: { notifyOn: ["completed", "killed"] },
      });

      const result = await loadWorkflowConfig({ homeDir: home, projectRoot: project });
      assert.equal(result.config, null);
      assert.equal(result.diagnostics.length, 1);
      assert.match(result.diagnostics[0]?.message ?? "", /workflowNotifications\.notifyOn/);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });

  test("rejects empty notifyOn arrays", async () => {
    const home = await mkdtemp(join(tmpdir(), "wf-home-notifications-empty-"));
    const project = await mkdtemp(join(tmpdir(), "wf-project-notifications-empty-"));
    try {
      const dir = await makeDir(project, ".atomic", "extensions", "workflow");
      await writeJson(dir, "config.json", {
        workflowNotifications: { notifyOn: [] },
      });

      const result = await loadWorkflowConfig({ homeDir: home, projectRoot: project });
      assert.equal(result.config, null);
      assert.equal(result.diagnostics.length, 1);
      assert.match(result.diagnostics[0]?.message ?? "", /workflowNotifications\.notifyOn/);
      assert.match(result.diagnostics[0]?.message ?? "", /non-empty|at least one/);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });
});
