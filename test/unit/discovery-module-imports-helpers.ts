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

import { afterEach, beforeEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Temp dir management
// ---------------------------------------------------------------------------

export let tmpRoot: string;

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
export function validDefaultExportSrc(name: string, normalizedName: string): string {
  return `
import { workflow } from "@bastani/workflows";
const wf = workflow({
  name: ${JSON.stringify(normalizedName)},
  description: ${JSON.stringify(name)} + " test workflow",
  inputs: {},
  outputs: {},
  run: async (ctx) => { await ctx.task("validation-smoke", { prompt: "validation smoke" }); return {}; },
});
if (wf.normalizedName !== ${JSON.stringify(normalizedName)}) throw new Error("unexpected normalized name");
export default wf;
`;
}

/** Valid workflow JS source as named export. */
export function validNamedExportSrc(name: string, normalizedName: string, exportName = "workflow"): string {
  return `
import { workflow as defineWorkflow } from "@bastani/workflows";
export const ${exportName} = defineWorkflow({
  name: ${JSON.stringify(normalizedName)},
  description: ${JSON.stringify(name)} + " test workflow",
  inputs: {},
  outputs: {},
  run: async (ctx) => { await ctx.task("validation-smoke", { prompt: "validation smoke" }); return {}; },
});
if (${exportName}.normalizedName !== ${JSON.stringify(normalizedName)}) throw new Error("unexpected normalized name");
`;
}

/** File with both a valid default export AND a valid named export. */
export function validDefaultAndNamedExportSrc(
  defaultName: string,
  defaultNorm: string,
  namedName: string,
  namedNorm: string,
): string {
  return `
import { workflow } from "@bastani/workflows";
const first = workflow({
  name: ${JSON.stringify(defaultNorm)},
  description: ${JSON.stringify(defaultName)} + " default export workflow",
  inputs: {},
  outputs: {},
  run: async (ctx) => { await ctx.task("validation-smoke", { prompt: "validation smoke" }); return {}; },
});
if (first.normalizedName !== ${JSON.stringify(defaultNorm)}) throw new Error("unexpected normalized name");
export default first;

export const second = workflow({
  name: ${JSON.stringify(namedNorm)},
  description: ${JSON.stringify(namedName)} + " named export workflow",
  inputs: {},
  outputs: {},
  run: async (ctx) => { await ctx.task("validation-smoke", { prompt: "validation smoke" }); return {}; },
});
if (second.normalizedName !== ${JSON.stringify(namedNorm)}) throw new Error("unexpected normalized name");
`;
}

/** Create a directory structure: <tmpRoot>/cwd/.atomic/workflows/<file> */
export async function createProjectWorkflowFile(filename: string, content: string): Promise<string> {
  const dir = join(tmpRoot, "cwd", ".atomic", "workflows");
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, filename);
  await writeFile(filePath, content, "utf8");
  return filePath;
}

/** Create a directory structure: <tmpRoot>/home/.atomic/agent/workflows/<file> */
export async function createUserGlobalWorkflowFile(filename: string, content: string): Promise<string> {
  const dir = join(tmpRoot, "home", ".atomic", "agent", "workflows");
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, filename);
  await writeFile(filePath, content, "utf8");
  return filePath;
}

