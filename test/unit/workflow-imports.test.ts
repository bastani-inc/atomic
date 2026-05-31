import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverWorkflows } from "../../packages/workflows/src/extension/discovery.js";
import { defineWorkflow } from "../../packages/workflows/src/workflows/define-workflow.js";
import { validateWorkflowImportGraph } from "../../packages/workflows/src/workflows/import-resolver.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "workflow-imports-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

function workflowSource(name: string, body: string): string {
  return [
    `import { defineWorkflow } from "@bastani/workflows";`,
    `export default defineWorkflow(${JSON.stringify(name)})`,
    body,
  ].join("\n");
}

describe("workflow import resolver", () => {
  test("resolves registered workflow id imports", () => {
    const child = defineWorkflow("shared-child")
      .run(async (ctx) => {
        await ctx.task("child", { prompt: "child" });
        return { ok: true };
      })
      .compile();
    const parent = defineWorkflow("parent")
      .import("child", { workflow: "shared-child" })
      .run(async () => ({}))
      .compile();
    const registry = createRegistry([parent, child]);

    const diagnostics = validateWorkflowImportGraph({ registry, roots: [parent] });

    assert.deepEqual(diagnostics, []);
  });

  test("resolves local path imports relative to the parent source file", async () => {
    const childPath = join(tmpRoot, "child.ts");
    const parentPath = join(tmpRoot, "parent.ts");
    await writeFile(
      childPath,
      workflowSource(
        "path-child",
        `.output("answer", { type: "text", required: true })\n  .run(async (ctx) => { await ctx.task("child", { prompt: "child" }); return { answer: "ok" }; })\n  .compile();`,
      ),
      "utf8",
    );
    const parent = defineWorkflow("path-parent")
      .import("child", { path: "./child.ts" })
      .run(async () => ({}))
      .compile();
    const registry = createRegistry([parent]);

    const diagnostics = validateWorkflowImportGraph({
      registry,
      cwd: join(tmpRoot, "elsewhere"),
      sources: [{ id: parent.normalizedName, filePath: parentPath }],
      roots: [parent],
    });

    assert.deepEqual(diagnostics, []);
  });

  test("keeps path identity for same-named workflows from different files", async () => {
    const childPath = join(tmpRoot, "child.ts");
    const parentPath = join(tmpRoot, "parent.ts");
    await writeFile(
      childPath,
      workflowSource(
        "same-name",
        `.run(async (ctx) => { await ctx.task("child", { prompt: "child" }); return {}; })\n  .compile();`,
      ),
      "utf8",
    );
    const parent = defineWorkflow("same-name")
      .import("child", { path: "./child.ts" })
      .run(async () => ({}))
      .compile();
    const registry = createRegistry([parent]);

    const diagnostics = validateWorkflowImportGraph({
      registry,
      cwd: join(tmpRoot, "elsewhere"),
      sources: [{ id: parent.normalizedName, filePath: parentPath }],
      roots: [parent],
    });

    assert.deepEqual(diagnostics, []);
  });

  test("uses workflow identity for path imports proven to be the same source file", async () => {
    const parentPath = join(tmpRoot, "parent.ts");
    await writeFile(
      parentPath,
      workflowSource(
        "same-source-cycle",
        `.run(async (ctx) => { await ctx.task("self", { prompt: "self" }); return {}; })\n  .compile();`,
      ),
      "utf8",
    );
    const parent = defineWorkflow("same-source-cycle")
      .import("self", { path: "./parent.ts" })
      .run(async () => ({}))
      .compile();
    const registry = createRegistry([parent]);

    const diagnostics = validateWorkflowImportGraph({
      registry,
      cwd: join(tmpRoot, "elsewhere"),
      sources: [{ id: parent.normalizedName, filePath: parentPath }],
      roots: [parent],
    });

    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]?.code, "IMPORT_CIRCULAR");
    assert.match(diagnostics[0]?.message ?? "", /same-source-cycle -> same-source-cycle/);
  });

  test("reports unresolved imports", () => {
    const parent = defineWorkflow("parent-missing")
      .import("ghost", { workflow: "ghost-workflow" })
      .run(async () => ({}))
      .compile();
    const diagnostics = validateWorkflowImportGraph({ registry: createRegistry([parent]), roots: [parent] });

    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]?.code, "IMPORT_UNRESOLVED");
    assert.match(diagnostics[0]?.message ?? "", /ghost-workflow/);
  });

  test("reports circular imports with chain text", () => {
    const parent = defineWorkflow("cycle-parent")
      .import("child", { workflow: "cycle-child" })
      .run(async () => ({}))
      .compile();
    const child = defineWorkflow("cycle-child")
      .import("parent", { workflow: "cycle-parent" })
      .run(async () => ({}))
      .compile();
    const diagnostics = validateWorkflowImportGraph({ registry: createRegistry([parent, child]), roots: [parent] });

    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]?.code, "IMPORT_CIRCULAR");
    assert.match(diagnostics[0]?.message ?? "", /cycle-parent -> cycle-child -> cycle-parent/);
  });
});

describe("discoverWorkflows import diagnostics", () => {
  async function writeProjectWorkflow(filename: string, content: string): Promise<string> {
    const dir = join(tmpRoot, "cwd", ".atomic", "workflows");
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, filename);
    await writeFile(filePath, content, "utf8");
    return filePath;
  }

  test("emits IMPORT_UNRESOLVED while keeping the parent registered", async () => {
    await writeProjectWorkflow(
      "parent.ts",
      workflowSource(
        "discover-missing-parent",
        `.import("ghost", { workflow: "missing-child" })\n  .run(async (ctx) => { await ctx.task("parent", { prompt: "parent" }); return {}; })\n  .compile();`,
      ),
    );

    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
    });

    assert.equal(result.registry.has("discover-missing-parent"), true);
    assert.equal(result.errors.some((error) => error.code === "IMPORT_UNRESOLVED"), true);
  });

  test("emits IMPORT_CIRCULAR for discovered workflow cycles", async () => {
    await writeProjectWorkflow(
      "parent.ts",
      workflowSource(
        "discover-cycle-parent",
        `.import("child", { workflow: "discover-cycle-child" })\n  .run(async (ctx) => { await ctx.task("parent", { prompt: "parent" }); return {}; })\n  .compile();`,
      ),
    );
    await writeProjectWorkflow(
      "child.ts",
      workflowSource(
        "discover-cycle-child",
        `.import("parent", { workflow: "discover-cycle-parent" })\n  .run(async (ctx) => { await ctx.task("child", { prompt: "child" }); return {}; })\n  .compile();`,
      ),
    );

    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
    });

    const circular = result.errors.find((error) => error.code === "IMPORT_CIRCULAR");
    assert.notEqual(circular, undefined);
    assert.match(circular?.message ?? "", /discover-cycle-parent/);
    assert.match(circular?.message ?? "", /discover-cycle-child/);
    assert.match(circular?.message ?? "", / -> /);
  });

  test("path imports use the parent workflow file as their base path", async () => {
    await writeProjectWorkflow(
      "child.ts",
      workflowSource(
        "discover-path-child",
        `.output("answer", { type: "text", required: true })\n  .run(async (ctx) => { await ctx.task("child", { prompt: "child" }); return { answer: "ok" }; })\n  .compile();`,
      ),
    );
    await writeProjectWorkflow(
      "parent.ts",
      workflowSource(
        "discover-path-parent",
        `.import("child", { path: "./child.ts" })\n  .run(async (ctx) => { await ctx.workflow("child", { outputs: ["answer"] }); return {}; })\n  .compile();`,
      ),
    );

    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
    });

    assert.equal(result.registry.has("discover-path-parent"), true);
    assert.equal(result.errors.filter((error) => error.code.startsWith("IMPORT_")).length, 0);
  });
});
