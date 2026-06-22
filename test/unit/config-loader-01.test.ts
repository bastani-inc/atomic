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
describe("loadWorkflowConfig — missing files", () => {
  let tmpHome: string;
  let tmpProject: string;

  beforeAll(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "pi-config-test-home-"));
    tmpProject = await mkdtemp(join(tmpdir(), "pi-config-test-proj-"));
  });

  afterAll(async () => {
    await rm(tmpHome, { recursive: true, force: true });
    await rm(tmpProject, { recursive: true, force: true });
  });

  test("no config files → config null, no diagnostics", async () => {
    const result = await loadWorkflowConfig({ homeDir: tmpHome, projectRoot: tmpProject });
    assert.equal(result.config, null);
    assert.equal(result.diagnostics.length, 0);
  });
});
describe("loadWorkflowConfig — global config only", () => {
  let tmpHome: string;
  let tmpProject: string;

  beforeAll(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "pi-config-test-home-"));
    tmpProject = await mkdtemp(join(tmpdir(), "pi-config-test-proj-"));
    const globalDir = await makeDir(tmpHome, ".atomic", "agent", "extensions", "workflow");
    await writeJson(globalDir, "config.json", {
      maxDepth: 5,
      defaultConcurrency: 2,
      persistRuns: false,
    });
  });

  afterAll(async () => {
    await rm(tmpHome, { recursive: true, force: true });
    await rm(tmpProject, { recursive: true, force: true });
  });

  test("global config loaded", async () => {
    const result = await loadWorkflowConfig({ homeDir: tmpHome, projectRoot: tmpProject });
    assert.equal(result.diagnostics.length, 0);
    assert.notEqual(result.config, null);
    assert.equal(result.config!.maxDepth, 5);
    assert.equal(result.config!.defaultConcurrency, 2);
    assert.equal(result.config!.persistRuns, false);
  });
});
describe("loadWorkflowConfig — project-local config only (primary candidate)", () => {
  let tmpHome: string;
  let tmpProject: string;

  beforeAll(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "pi-config-test-home-"));
    tmpProject = await mkdtemp(join(tmpdir(), "pi-config-test-proj-"));
    const projDir = await makeDir(tmpProject, ".atomic", "extensions", "workflow");
    await writeJson(projDir, "config.json", {
      maxDepth: 3,
      resumeInFlight: "auto",
    });
  });

  afterAll(async () => {
    await rm(tmpHome, { recursive: true, force: true });
    await rm(tmpProject, { recursive: true, force: true });
  });

  test("project-local (.atomic/extensions) config loaded", async () => {
    const result = await loadWorkflowConfig({ homeDir: tmpHome, projectRoot: tmpProject });
    assert.equal(result.diagnostics.length, 0);
    assert.notEqual(result.config, null);
    assert.equal(result.config!.maxDepth, 3);
    assert.equal(result.config!.resumeInFlight, "auto");
  });
});
describe("loadWorkflowConfig — non-pi config ignored", () => {
  let tmpHome: string;
  let tmpProject: string;

  beforeAll(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "pi-config-test-home-"));
    tmpProject = await mkdtemp(join(tmpdir(), "pi-config-test-proj-"));
    const projDir = await makeDir(tmpProject, ".legacy", "agent", "extensions", "workflow");
    await writeJson(projDir, "config.json", {
      statusFile: true,
    });
  });

  afterAll(async () => {
    await rm(tmpHome, { recursive: true, force: true });
    await rm(tmpProject, { recursive: true, force: true });
  });

  test("non-pi config is not loaded", async () => {
    const result = await loadWorkflowConfig({ homeDir: tmpHome, projectRoot: tmpProject });
    assert.equal(result.diagnostics.length, 0);
    assert.equal(result.config, null);
  });
});
describe("loadWorkflowConfig — .atomic config wins over non-pi config", () => {
  let tmpHome: string;
  let tmpProject: string;

  beforeAll(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "pi-config-test-home-"));
    tmpProject = await mkdtemp(join(tmpdir(), "pi-config-test-proj-"));
    const primaryDir = await makeDir(tmpProject, ".atomic", "extensions", "workflow");
    await writeJson(primaryDir, "config.json", { maxDepth: 10 });
    const ignoredDir = await makeDir(tmpProject, ".legacy", "agent", "extensions", "workflow");
    await writeJson(ignoredDir, "config.json", { maxDepth: 99 });
  });

  afterAll(async () => {
    await rm(tmpHome, { recursive: true, force: true });
    await rm(tmpProject, { recursive: true, force: true });
  });

  test(".atomic config used when non-pi config also exists", async () => {
    const result = await loadWorkflowConfig({ homeDir: tmpHome, projectRoot: tmpProject });
    assert.equal(result.diagnostics.length, 0);
    assert.equal(result.config!.maxDepth, 10);
  });
});
describe("loadWorkflowConfig — merge: project overrides global", () => {
  let tmpHome: string;
  let tmpProject: string;

  beforeAll(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "pi-config-test-home-"));
    tmpProject = await mkdtemp(join(tmpdir(), "pi-config-test-proj-"));
    const globalDir = await makeDir(tmpHome, ".atomic", "agent", "extensions", "workflow");
    await writeJson(globalDir, "config.json", {
      maxDepth: 4,
      persistRuns: true,
      resumeInFlight: "ask",
    });
    const projDir = await makeDir(tmpProject, ".atomic", "extensions", "workflow");
    await writeJson(projDir, "config.json", {
      maxDepth: 2,
      statusFile: true,
    });
  });

  afterAll(async () => {
    await rm(tmpHome, { recursive: true, force: true });
    await rm(tmpProject, { recursive: true, force: true });
  });

  test("project maxDepth overrides global maxDepth", async () => {
    const result = await loadWorkflowConfig({ homeDir: tmpHome, projectRoot: tmpProject });
    assert.equal(result.diagnostics.length, 0);
    assert.equal(result.config!.maxDepth, 2);
  });

  test("global-only fields preserved after merge", async () => {
    const result = await loadWorkflowConfig({ homeDir: tmpHome, projectRoot: tmpProject });
    assert.equal(result.config!.persistRuns, true);
    assert.equal(result.config!.resumeInFlight, "ask");
  });

  test("project-only fields present after merge", async () => {
    const result = await loadWorkflowConfig({ homeDir: tmpHome, projectRoot: tmpProject });
    assert.equal(result.config!.statusFile, true);
  });
});
describe("loadWorkflowConfig — workflows map merge", () => {
  let tmpHome: string;
  let tmpProject: string;

  beforeAll(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "pi-config-test-home-"));
    tmpProject = await mkdtemp(join(tmpdir(), "pi-config-test-proj-"));
    const globalDir = await makeDir(tmpHome, ".atomic", "agent", "extensions", "workflow");
    await writeJson(globalDir, "config.json", {
      workflows: {
        "global-wf": { path: "/home/user/.atomic/workflows/global.ts" },
        "shared-wf": { path: "/home/user/.atomic/workflows/shared.ts" },
      },
    });
    const projDir = await makeDir(tmpProject, ".atomic", "extensions", "workflow");
    await writeJson(projDir, "config.json", {
      workflows: {
        "proj-wf": { path: "./workflows/project.ts" },
        "shared-wf": { path: "./workflows/shared-override.ts" },
      },
    });
  });

  afterAll(async () => {
    await rm(tmpHome, { recursive: true, force: true });
    await rm(tmpProject, { recursive: true, force: true });
  });

  test("workflows from both scopes merged", async () => {
    const result = await loadWorkflowConfig({ homeDir: tmpHome, projectRoot: tmpProject });
    assert.equal(result.diagnostics.length, 0);
    assert.notEqual(result.config!.workflows, undefined);
    assert.notEqual(result.config!.workflows!["global-wf"], undefined);
    assert.notEqual(result.config!.workflows!["proj-wf"], undefined);
  });

  test("project workflows override global on conflict", async () => {
    const result = await loadWorkflowConfig({ homeDir: tmpHome, projectRoot: tmpProject });
    assert.equal(result.config!.workflows!["shared-wf"].path, "./workflows/shared-override.ts");
  });

  test("global-only workflow preserved", async () => {
    const result = await loadWorkflowConfig({ homeDir: tmpHome, projectRoot: tmpProject });
    assert.equal(result.config!.workflows!["global-wf"].path, "/home/user/.atomic/workflows/global.ts");
  });
});
describe("loadWorkflowConfig — invalid JSON", () => {
  let tmpHome: string;
  let tmpProject: string;

  beforeAll(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "pi-config-test-home-"));
    tmpProject = await mkdtemp(join(tmpdir(), "pi-config-test-proj-"));
    const globalDir = await makeDir(tmpHome, ".atomic", "agent", "extensions", "workflow");
    await writeBadJson(globalDir, "config.json");
  });

  afterAll(async () => {
    await rm(tmpHome, { recursive: true, force: true });
    await rm(tmpProject, { recursive: true, force: true });
  });

  test("invalid JSON produces CONFIG_INVALID diagnostic", async () => {
    const result = await loadWorkflowConfig({ homeDir: tmpHome, projectRoot: tmpProject });
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0]!.code, "CONFIG_INVALID");
    assert.equal(result.diagnostics[0]!.level, "error");
  });

  test("source path present in diagnostic", async () => {
    const result = await loadWorkflowConfig({ homeDir: tmpHome, projectRoot: tmpProject });
    assert.ok(result.diagnostics[0]!.source!.includes("config.json"));
  });

  test("config null when only source is invalid", async () => {
    const result = await loadWorkflowConfig({ homeDir: tmpHome, projectRoot: tmpProject });
    assert.equal(result.config, null);
  });

  test("diagnostic message references JSON parse error", async () => {
    const result = await loadWorkflowConfig({ homeDir: tmpHome, projectRoot: tmpProject });
    assert.ok(result.diagnostics[0]!.message.includes("Invalid JSON"));
  });
});
describe("loadWorkflowConfig — invalid shape (wrong field types)", () => {
  let tmpHome: string;
  let tmpProject: string;

  beforeAll(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "pi-config-test-home-"));
    tmpProject = await mkdtemp(join(tmpdir(), "pi-config-test-proj-"));
    const projDir = await makeDir(tmpProject, ".atomic", "extensions", "workflow");
    await writeJson(projDir, "config.json", { maxDepth: "not-a-number" });
  });

  afterAll(async () => {
    await rm(tmpHome, { recursive: true, force: true });
    await rm(tmpProject, { recursive: true, force: true });
  });

  test("bad maxDepth type → CONFIG_INVALID", async () => {
    const result = await loadWorkflowConfig({ homeDir: tmpHome, projectRoot: tmpProject });
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0]!.code, "CONFIG_INVALID");
    assert.ok(result.diagnostics[0]!.message.includes("maxDepth"));
  });
});
describe("loadWorkflowConfig — invalid resumeInFlight enum", () => {
  let tmpHome: string;
  let tmpProject: string;

  beforeAll(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "pi-config-test-home-"));
    tmpProject = await mkdtemp(join(tmpdir(), "pi-config-test-proj-"));
    const projDir = await makeDir(tmpProject, ".atomic", "extensions", "workflow");
    await writeJson(projDir, "config.json", { resumeInFlight: "maybe" });
  });

  afterAll(async () => {
    await rm(tmpHome, { recursive: true, force: true });
    await rm(tmpProject, { recursive: true, force: true });
  });

  test("unknown resumeInFlight value → CONFIG_INVALID", async () => {
    const result = await loadWorkflowConfig({ homeDir: tmpHome, projectRoot: tmpProject });
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0]!.code, "CONFIG_INVALID");
    assert.ok(result.diagnostics[0]!.message.includes("resumeInFlight"));
  });
});
describe("loadWorkflowConfig — invalid workflows entry (missing path)", () => {
  let tmpHome: string;
  let tmpProject: string;

  beforeAll(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "pi-config-test-home-"));
    tmpProject = await mkdtemp(join(tmpdir(), "pi-config-test-proj-"));
    const projDir = await makeDir(tmpProject, ".atomic", "extensions", "workflow");
    await writeJson(projDir, "config.json", {
      workflows: {
        "my-wf": { path: "" }, // empty path
      },
    });
  });

  afterAll(async () => {
    await rm(tmpHome, { recursive: true, force: true });
    await rm(tmpProject, { recursive: true, force: true });
  });

  test("empty workflow path → CONFIG_INVALID", async () => {
    const result = await loadWorkflowConfig({ homeDir: tmpHome, projectRoot: tmpProject });
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0]!.code, "CONFIG_INVALID");
    assert.ok(result.diagnostics[0]!.message.includes("path"));
  });
});
describe("loadWorkflowConfig — both scopes invalid", () => {
  let tmpHome: string;
  let tmpProject: string;

  beforeAll(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "pi-config-test-home-"));
    tmpProject = await mkdtemp(join(tmpdir(), "pi-config-test-proj-"));
    const globalDir = await makeDir(tmpHome, ".atomic", "agent", "extensions", "workflow");
    await writeBadJson(globalDir, "config.json");
    const projDir = await makeDir(tmpProject, ".atomic", "extensions", "workflow");
    await writeBadJson(projDir, "config.json");
  });

  afterAll(async () => {
    await rm(tmpHome, { recursive: true, force: true });
    await rm(tmpProject, { recursive: true, force: true });
  });

  test("two CONFIG_INVALID diagnostics", async () => {
    const result = await loadWorkflowConfig({ homeDir: tmpHome, projectRoot: tmpProject });
    assert.equal(result.diagnostics.length, 2);
    for (const d of result.diagnostics) {
      assert.equal(d.code, "CONFIG_INVALID");
    }
  });

  test("config null when both sources invalid", async () => {
    const result = await loadWorkflowConfig({ homeDir: tmpHome, projectRoot: tmpProject });
    assert.equal(result.config, null);
  });
});
describe("loadWorkflowConfig — one invalid, one valid", () => {
  let tmpHome: string;
  let tmpProject: string;

  beforeAll(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "pi-config-test-home-"));
    tmpProject = await mkdtemp(join(tmpdir(), "pi-config-test-proj-"));
    const globalDir = await makeDir(tmpHome, ".atomic", "agent", "extensions", "workflow");
    await writeBadJson(globalDir, "config.json"); // invalid global
    const projDir = await makeDir(tmpProject, ".atomic", "extensions", "workflow");
    await writeJson(projDir, "config.json", { maxDepth: 6 }); // valid project
  });

  afterAll(async () => {
    await rm(tmpHome, { recursive: true, force: true });
    await rm(tmpProject, { recursive: true, force: true });
  });

  test("one diagnostic from global, config from project", async () => {
    const result = await loadWorkflowConfig({ homeDir: tmpHome, projectRoot: tmpProject });
    assert.equal(result.diagnostics.length, 1);
    assert.notEqual(result.config, null);
    assert.equal(result.config!.maxDepth, 6);
  });
});
describe("loadWorkflowConfig — workflows array rejected (not object)", () => {
  let tmpHome: string;
  let tmpProject: string;

  beforeAll(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "pi-config-test-home-"));
    tmpProject = await mkdtemp(join(tmpdir(), "pi-config-test-proj-"));
    const projDir = await makeDir(tmpProject, ".atomic", "extensions", "workflow");
    await writeJson(projDir, "config.json", { workflows: ["array-not-allowed"] });
  });

  afterAll(async () => {
    await rm(tmpHome, { recursive: true, force: true });
    await rm(tmpProject, { recursive: true, force: true });
  });

  test("array workflows → CONFIG_INVALID", async () => {
    const result = await loadWorkflowConfig({ homeDir: tmpHome, projectRoot: tmpProject });
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0]!.code, "CONFIG_INVALID");
    assert.ok(result.diagnostics[0]!.message.includes("workflows"));
  });
});
describe("loadWorkflowConfig — valid config with all fields", () => {
  let tmpHome: string;
  let tmpProject: string;

  beforeAll(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "pi-config-test-home-"));
    tmpProject = await mkdtemp(join(tmpdir(), "pi-config-test-proj-"));
    const projDir = await makeDir(tmpProject, ".atomic", "extensions", "workflow");
    await writeJson(projDir, "config.json", {
      maxDepth: 4,
      defaultConcurrency: 4,
      persistRuns: true,
      statusFile: false,
      resumeInFlight: "never",
      workflows: {
        "my-workflow": { path: "./workflows/my-workflow.ts" },
      },
    });
  });

  afterAll(async () => {
    await rm(tmpHome, { recursive: true, force: true });
    await rm(tmpProject, { recursive: true, force: true });
  });

  test("all valid fields parsed correctly", async () => {
    const result = await loadWorkflowConfig({ homeDir: tmpHome, projectRoot: tmpProject });
    assert.equal(result.diagnostics.length, 0);
    const c = result.config!;
    assert.equal(c.maxDepth, 4);
    assert.equal(c.defaultConcurrency, 4);
    assert.equal(c.persistRuns, true);
    assert.equal(c.statusFile, false);
    assert.equal(c.resumeInFlight, "never");
    assert.equal(c.workflows!["my-workflow"]!.path, "./workflows/my-workflow.ts");
  });
});
