import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import { defineWorkflow } from "../../packages/workflows/src/workflows/define-workflow.js";

export function makeValidDef(
  name: string,
  normalizedName: string,
  overrides: Partial<WorkflowDefinition> = {},
): WorkflowDefinition {
  const definition = defineWorkflow(name)
    .description(`${name} description`)
    .run(async () => ({}))
    .compile();
  assert.equal(definition.normalizedName, normalizedName);
  assert.deepEqual(overrides, {});
  return definition;
}

const tempDirs: string[] = [];

export function makeTempDir(label: string): string {
  const dir = join(tmpdir(), `pi-disc-${label}-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

export function writeWorkflowJs(
  dir: string,
  filename: string,
  name: string,
  normalizedName: string,
): string {
  const filePath = join(dir, filename);
  writeFileSync(
    filePath,
    [
      `import { defineWorkflow } from "@bastani/workflows";`,
      `const workflow = defineWorkflow(${JSON.stringify(normalizedName)})`,
      `  .description(${JSON.stringify(`${name} description`)})`,
      `  .run(async (ctx) => { await ctx.task("validation-smoke", { prompt: "validation smoke" }); return {}; })`,
      `  .compile();`,
      `if (workflow.normalizedName !== ${JSON.stringify(normalizedName)}) throw new Error("unexpected normalized name");`,
      `export default workflow;`,
    ].join("\n"),
    "utf-8",
  );
  return filePath;
}

export function writeInvalidWorkflowJs(dir: string, filename: string): string {
  const filePath = join(dir, filename);
  writeFileSync(filePath, `export default null;\n`, "utf-8");
  return filePath;
}

export function writeNoStageWorkflowJs(dir: string, filename: string): string {
  const filePath = join(dir, filename);
  writeFileSync(
    filePath,
    [
      `import { defineWorkflow } from "@bastani/workflows";`,
      `export default defineWorkflow("No Stage Workflow")`,
      `  .description("Discovery rejects this because it creates no stages")`,
      `  .run(async () => ({}))`,
      `  .compile();`,
    ].join("\n"),
    "utf-8",
  );
  return filePath;
}

export function writeMissingSentinelWorkflowJs(dir: string, filename: string): string {
  const filePath = join(dir, filename);
  writeFileSync(
    filePath,
    [
      `export default {`,
      `  name: "no-sentinel",`,
      `  normalizedName: "no-sentinel",`,
      `  run: async () => ({}),`,
      `};`,
    ].join("\n"),
    "utf-8",
  );
  return filePath;
}

export function cleanupDiscoveryTempDirs(): void {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

export { existsSync, mkdirSync, writeFileSync, join };
