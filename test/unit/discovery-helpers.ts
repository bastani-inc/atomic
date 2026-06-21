import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";

export function makeValidDef(
  name: string,
  normalizedName: string,
  overrides: Partial<WorkflowDefinition> = {},
): WorkflowDefinition {
  const definition = workflow({
    name: name,
    description: `${name} description`,
    inputs: {},
    outputs: {},
    run: async () => ({}),
  });
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
      `import { workflow } from "@bastani/workflows";`,
      `const definition = workflow({`,
      `  name: ${JSON.stringify(normalizedName)},`,
      `  description: ${JSON.stringify(`${name} description`)},`,
      `  inputs: {},`,
      `  outputs: {},`,
      `  run: async (ctx) => { await ctx.task("validation-smoke", { prompt: "validation smoke" }); return {}; },`,
      `});`,
      `if (definition.normalizedName !== ${JSON.stringify(normalizedName)}) throw new Error("unexpected normalized name");`,
      `export default definition;`,
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
      `import { workflow } from "@bastani/workflows";`,
      `export default workflow({`,
      `  name: "No Stage Workflow",`,
      `  description: "Discovery rejects this because it creates no stages",`,
      `  inputs: {},`,
      `  outputs: {},`,
      `  run: async () => ({}),`,
      `});`,
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
