import { afterAll, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { discoverWorkflows } from "../../packages/workflows/src/extension/discovery.js";
import { cleanupDiscoveryTempDirs, existsSync, join, makeTempDir, mkdirSync, writeFileSync, writeInvalidWorkflowJs, writeMissingSentinelWorkflowJs, writeNoStageWorkflowJs, writeWorkflowJs } from "./discovery-helpers.js";

afterAll(cleanupDiscoveryTempDirs);


// ---------------------------------------------------------------------------
// Invalid exports → diagnostics
// ---------------------------------------------------------------------------

describe("discoverWorkflows — INVALID_DEFINITION diagnostics", () => {
  test("null default export emits INVALID_DEFINITION", async () => {
    const cwd = makeTempDir("invalid-null");
    const wfDir = join(cwd, ".atomic", "workflows");
    mkdirSync(wfDir, { recursive: true });
    const fp = writeInvalidWorkflowJs(wfDir, "bad-null.js");

    const { errors } = await discoverWorkflows({ cwd, homeDir: makeTempDir("empty"), includeBundled: false });
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.level, "error");
    assert.equal(errors[0]!.code, "INVALID_DEFINITION");
    assert.equal(errors[0]!.source, fp);
    assert.match(errors[0]!.message, /project-local export "default" rejected: export is not an object/);
  });

  test("missing __piWorkflow sentinel emits INVALID_DEFINITION", async () => {
    const cwd = makeTempDir("invalid-sentinel");
    const wfDir = join(cwd, ".atomic", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeMissingSentinelWorkflowJs(wfDir, "bad-sentinel.js");

    const { errors } = await discoverWorkflows({ cwd, homeDir: makeTempDir("empty2"), includeBundled: false });
    const inv = errors.filter((e) => e.code === "INVALID_DEFINITION");
    assert.ok(inv.length > 0);
    assert.match(inv[0]!.message, /missing or incorrect __piWorkflow sentinel/);
    assert.match(inv[0]!.message, /workflow\(\{\.\.\.\}\)/);
  });

  test("forged __piWorkflow object emits workflow diagnostic", async () => {
    const cwd = makeTempDir("forged-sentinel");
    const wfDir = join(cwd, ".atomic", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(
      join(wfDir, "forged.js"),
      [
        `export default {`,
        `  __piWorkflow: true,`,
        `  name: "forged",`,
        `  normalizedName: "forged",`,
        `  description: "forged",`,
        `  inputs: {},`,
        `  run: async () => ({}),`,
        `};`,
      ].join("\n"),
      "utf-8",
    );

    const { registry, errors } = await discoverWorkflows({ cwd, homeDir: makeTempDir("empty-forged"), includeBundled: false });
    assert.equal(registry.has("forged"), false);
    const inv = errors.filter((e) => e.code === "INVALID_DEFINITION");
    assert.ok(inv.length > 0);
    assert.match(inv[0]!.message, /not produced by workflow\(\{\.\.\.\}\)/);
    assert.match(inv[0]!.message, /hand-rolled __piWorkflow objects are not supported/);
  });

  test("INVALID_DEFINITION does not register a workflow", async () => {
    const cwd = makeTempDir("invalid-no-reg");
    const wfDir = join(cwd, ".atomic", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeInvalidWorkflowJs(wfDir, "bad.js");

    const { registry } = await discoverWorkflows({ cwd, homeDir: makeTempDir("empty3"), includeBundled: false });
    assert.equal(registry.names().length, 0);
  });

  test("workflow that completes without creating stages registers structurally", async () => {
    const cwd = makeTempDir("structural-no-stages");
    const wfDir = join(cwd, ".atomic", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeNoStageWorkflowJs(wfDir, "no-stage.js");

    const { registry, errors } = await discoverWorkflows({ cwd, homeDir: makeTempDir("empty-structural-no-stages"), includeBundled: false });

    assert.equal(registry.has("no-stage-workflow"), true);
    assert.equal(errors.filter((e) => e.code === "INVALID_DEFINITION").length, 0);
  });

  test("discovery does not invoke workflow run bodies", async () => {
    const cwd = makeTempDir("no-run-body-side-effects");
    const wfDir = join(cwd, ".atomic", "workflows");
    mkdirSync(wfDir, { recursive: true });
    const sideEffectPath = join(cwd, "side-effect.txt");
    writeFileSync(
      join(wfDir, "side-effect.js"),
      [
        `import { writeFileSync } from "node:fs";`,
        `import { workflow } from "@bastani/workflows";`,
        `export default workflow({`,
        `  name: "Side Effect Workflow",`,
        `  description: "Would write during run if discovery invoked it",`,
        `  inputs: {},`,
        `  outputs: {},`,
        `  run: async () => { writeFileSync(new URL("../../side-effect.txt", import.meta.url), "ran"); return {}; },`,
        `});`,
      ].join("\n"),
      "utf-8",
    );

    const { registry, errors } = await discoverWorkflows({ cwd, homeDir: makeTempDir("empty-no-run-body-side-effects"), includeBundled: false });

    assert.equal(registry.has("side-effect-workflow"), true);
    assert.equal(errors.length, 0);
    assert.equal(existsSync(sideEffectPath), false);
  });

  test("workflow that reaches a stage through an aliased primitive registers structurally", async () => {
    const cwd = makeTempDir("valid-aliased-stage-primitive");
    const wfDir = join(cwd, ".atomic", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(
      join(wfDir, "aliased.js"),
      [
        `import { workflow } from "@bastani/workflows";`,
        `export default workflow({`,
        `  name: "Aliased Stage Workflow",`,
        `  description: "Uses an aliased task primitive",`,
        `  inputs: {},`,
        `  outputs: {},`,
        `  run: async (ctx) => { const { task } = ctx; await task("validation-smoke", { prompt: "validation smoke" }); return {}; },`,
        `});`,
      ].join("\n"),
      "utf-8",
    );

    const { registry, errors } = await discoverWorkflows({ cwd, homeDir: makeTempDir("empty-aliased-stage-primitive"), includeBundled: false });

    assert.equal(registry.has("aliased-stage-workflow"), true);
    assert.equal(errors.filter((e) => e.code === "INVALID_DEFINITION").length, 0);
  });

  test("PATH_NOT_FOUND for configured path that does not exist", async () => {
    const cwd = makeTempDir("path-not-found");
    const missingPath = join(makeTempDir("ghost-dir"), "ghost.js");

    const { errors } = await discoverWorkflows({
      cwd,
      homeDir: makeTempDir("empty4"),
      includeBundled: false,
      config: { projectWorkflows: [missingPath] },
    });
    const pathErr = errors.filter((e) => e.code === "PATH_NOT_FOUND");
    assert.equal(pathErr.length, 1);
    assert.equal(pathErr[0]!.level, "error");
    assert.equal(pathErr[0]!.source, missingPath);
  });

  test("CONFIG_INVALID for bad config structure", async () => {
    const cwd = makeTempDir("bad-config");
    const { errors } = await discoverWorkflows({
      cwd,
      homeDir: makeTempDir("empty5"),
      includeBundled: false,
      config: { projectWorkflows: 42 as unknown as string[] },
    });
    const cfgErr = errors.filter((e) => e.code === "CONFIG_INVALID");
    assert.equal(cfgErr.length, 1);
    assert.equal(cfgErr[0]!.level, "error");
  });
});

// ---------------------------------------------------------------------------
// Duplicate normalizedName — precedence and DUPLICATE_NAME warnings
// ---------------------------------------------------------------------------

describe("discoverWorkflows — DUPLICATE_NAME precedence", () => {
  test("settings-project beats project-local: project-local emits DUPLICATE_NAME", async () => {
    const cwd = makeTempDir("dup-sp-vs-pl");
    // settings-project: highest precedence
    const spDir = makeTempDir("sp-files");
    const spPath = writeWorkflowJs(spDir, "sp.js", "dup-wf", "dup-wf");
    // project-local: lower precedence
    const wfDir = join(cwd, ".atomic", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeWorkflowJs(wfDir, "pl.js", "PL Version", "dup-wf");

    const { registry, sources, errors } = await discoverWorkflows({
      cwd,
      homeDir: makeTempDir("empty-home"),
      includeBundled: false,
      config: { projectWorkflows: [spPath] },
    });

    // settings-project wins
    const def = registry.get("dup-wf");
    assert.equal(def?.name, "dup-wf");

    // project-local entry emits DUPLICATE_NAME
    const dupes = errors.filter((e) => e.code === "DUPLICATE_NAME");
    assert.equal(dupes.length, 1);
    assert.equal(dupes[0]!.level, "warn");

    // only one source registered for dup-wf
    const srcs = sources.filter((s) => s.id === "dup-wf");
    assert.equal(srcs.length, 1);
    assert.equal(srcs[0]!.kind, "settings-project");
  });

  test("project-local beats settings-global: settings-global emits DUPLICATE_NAME", async () => {
    const cwd = makeTempDir("dup-pl-vs-sg");
    // project-local
    const wfDir = join(cwd, ".atomic", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeWorkflowJs(wfDir, "pl.js", "dup-sg-wf", "dup-sg-wf");
    // settings-global
    const sgDir = makeTempDir("sg-files");
    const sgPath = writeWorkflowJs(sgDir, "sg.js", "SG Loser", "dup-sg-wf");

    const { registry, sources, errors } = await discoverWorkflows({
      cwd,
      homeDir: makeTempDir("empty-home2"),
      includeBundled: false,
      config: { globalWorkflows: [sgPath] },
    });

    assert.equal(registry.get("dup-sg-wf")?.name, "dup-sg-wf");
    const dupes = errors.filter((e) => e.code === "DUPLICATE_NAME");
    assert.equal(dupes.length, 1);
    assert.equal(dupes[0]!.level, "warn");

    const srcs = sources.filter((s) => s.id === "dup-sg-wf");
    assert.equal(srcs.length, 1);
    assert.equal(srcs[0]!.kind, "project-local");
  });

  test("project-local beats user-global: user-global emits DUPLICATE_NAME", async () => {
    const cwd = makeTempDir("dup-pl-vs-ug");
    // project-local
    const wfDir = join(cwd, ".atomic", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeWorkflowJs(wfDir, "pl.js", "dup-ug-wf", "dup-ug-wf");
    // user-global
    const homeDir = makeTempDir("home-ug");
    const ugDir = join(homeDir, ".atomic", "agent", "workflows");
    mkdirSync(ugDir, { recursive: true });
    writeWorkflowJs(ugDir, "ug.js", "UG Loser", "dup-ug-wf");

    const { registry, sources, errors } = await discoverWorkflows({ cwd, homeDir, includeBundled: false });

    assert.equal(registry.get("dup-ug-wf")?.name, "dup-ug-wf");
    const dupes = errors.filter((e) => e.code === "DUPLICATE_NAME");
    assert.equal(dupes.length, 1);

    const srcs = sources.filter((s) => s.id === "dup-ug-wf");
    assert.equal(srcs.length, 1);
    assert.equal(srcs[0]!.kind, "project-local");
  });

  test("project-local beats bundled: bundled emits DUPLICATE_NAME, name=ralph", async () => {
    const cwd = makeTempDir("dup-pl-vs-bundled");
    const wfDir = join(cwd, ".atomic", "workflows");
    mkdirSync(wfDir, { recursive: true });
    // Use same normalizedName as bundled "ralph"
    writeWorkflowJs(wfDir, "override-ralph.js", "ralph", "ralph");

    const { registry, sources, errors } = await discoverWorkflows({
      cwd,
      homeDir: makeTempDir("empty-home-ralph"),
      includeBundled: true,
    });

    // Custom wins
    assert.equal(registry.get("ralph")?.name, "ralph");

    // Bundled ralph emits DUPLICATE_NAME
    const dupes = errors.filter((e) => e.code === "DUPLICATE_NAME" && e.source === "ralph");
    assert.equal(dupes.length, 1);
    assert.equal(dupes[0]!.level, "warn");

    // Only one source for ralph
    const ralphSrcs = sources.filter((s) => s.id === "ralph");
    assert.equal(ralphSrcs.length, 1);
    assert.equal(ralphSrcs[0]!.kind, "project-local");
  });

  test("settings-global beats user-global: user-global emits DUPLICATE_NAME", async () => {
    const homeDir = makeTempDir("home-sg-ug");
    const ugDir = join(homeDir, ".atomic", "agent", "workflows");
    mkdirSync(ugDir, { recursive: true });
    writeWorkflowJs(ugDir, "ug.js", "UG Loser SG", "dup-sgug-wf");

    const sgDir = makeTempDir("sg-vs-ug");
    const sgPath = writeWorkflowJs(sgDir, "sg.js", "dup-sgug-wf", "dup-sgug-wf");
    const cwd = makeTempDir("proj-sg-ug");

    const { registry, sources, errors } = await discoverWorkflows({
      cwd,
      homeDir,
      includeBundled: false,
      config: { globalWorkflows: [sgPath] },
    });

    assert.equal(registry.get("dup-sgug-wf")?.name, "dup-sgug-wf");
    const dupes = errors.filter((e) => e.code === "DUPLICATE_NAME");
    assert.equal(dupes.length, 1);

    const srcs = sources.filter((s) => s.id === "dup-sgug-wf");
    assert.equal(srcs[0]!.kind, "settings-global");
  });

  test("user-global beats bundled: bundled emits DUPLICATE_NAME, name=deep-research-codebase", async () => {
    const homeDir = makeTempDir("home-ug-bundled");
    const ugDir = join(homeDir, ".atomic", "agent", "workflows");
    mkdirSync(ugDir, { recursive: true });
    writeWorkflowJs(ugDir, "override-drc.js", "deep-research-codebase", "deep-research-codebase");
    const cwd = makeTempDir("proj-ug-bundled");

    const { registry, sources, errors } = await discoverWorkflows({
      cwd,
      homeDir,
      includeBundled: true,
    });

    assert.equal(registry.get("deep-research-codebase")?.name, "deep-research-codebase");
    const dupes = errors.filter((e) => e.code === "DUPLICATE_NAME" && e.source === "deep-research-codebase");
    assert.equal(dupes.length, 1);

    const srcs = sources.filter((s) => s.id === "deep-research-codebase");
    assert.equal(srcs.length, 1);
    assert.equal(srcs[0]!.kind, "user-global");
  });
});

// ---------------------------------------------------------------------------
// includeBundled flag
// ---------------------------------------------------------------------------

describe("discoverWorkflows — includeBundled", () => {
  test("includeBundled=true (default) loads bundled workflows", async () => {
    const cwd = makeTempDir("bundled-true");
    const { registry } = await discoverWorkflows({ cwd, homeDir: makeTempDir("empty-b") });
    assert.equal(registry.has("ralph"), true);
    assert.equal(registry.has("deep-research-codebase"), true);
    assert.equal(registry.has("open-claude-design"), true);
  });

  test("includeBundled=false excludes all bundled workflows", async () => {
    const cwd = makeTempDir("bundled-false");
    const { registry } = await discoverWorkflows({
      cwd,
      homeDir: makeTempDir("empty-b2"),
      includeBundled: false,
    });
    assert.equal(registry.has("ralph"), false);
    assert.equal(registry.has("deep-research-codebase"), false);
    assert.equal(registry.has("open-claude-design"), false);
  });

  test("includeBundled=false still loads project-local workflows", async () => {
    const cwd = makeTempDir("bundled-false-proj");
    const wfDir = join(cwd, ".atomic", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeWorkflowJs(wfDir, "local.js", "Local Only", "local-only");

    const { registry } = await discoverWorkflows({
      cwd,
      homeDir: makeTempDir("empty-b3"),
      includeBundled: false,
    });
    assert.equal(registry.has("local-only"), true);
    assert.equal(registry.has("ralph"), false);
  });
});
