/**
 * Shared workflow module loading helpers.
 *
 * Discovery loads user-authored workflow files through this jiti instance so
 * TypeScript/ESM/CJS semantics and the @bastani/workflows virtual SDK alias
 * stay consistent.
 */

import { createJiti } from "jiti/static";
import * as typeboxModule from "typebox";
import * as workflowsSdkSurface from "../sdk-surface.js";
import { isBrandedWorkflowDefinition } from "../authoring/workflow.js";
import deepResearchCodebase from "../../builtin/deep-research-codebase.js";
import goal from "../../builtin/goal.js";
import openClaudeDesign from "../../builtin/open-claude-design.js";
import ralph from "../../builtin/ralph.js";

const WORKFLOWS_MODULE_SPECIFIER = "@bastani/workflows";
const WORKFLOWS_BUILTIN_MODULE_SPECIFIER = `${WORKFLOWS_MODULE_SPECIFIER}/builtin`;
const TYPEBOX_MODULE_SPECIFIER = "typebox";
// Keep this in sync with index.ts through sdk-surface.ts.
const WORKFLOWS_SDK_MODULE: Record<string, unknown> = {
  ...workflowsSdkSurface,
};
const WORKFLOWS_BUILTIN_MODULE: Record<string, unknown> = {
  deepResearchCodebase,
  goal,
  openClaudeDesign,
  ralph,
};
const TYPEBOX_MODULE: Record<string, unknown> = {
  ...typeboxModule,
};
const WORKFLOWS_VIRTUAL_MODULES: Record<string, unknown> = {
  [WORKFLOWS_MODULE_SPECIFIER]: WORKFLOWS_SDK_MODULE,
  [WORKFLOWS_BUILTIN_MODULE_SPECIFIER]: WORKFLOWS_BUILTIN_MODULE,
  [TYPEBOX_MODULE_SPECIFIER]: TYPEBOX_MODULE,
  [`${WORKFLOWS_BUILTIN_MODULE_SPECIFIER}/deep-research-codebase`]: { default: deepResearchCodebase },
  [`${WORKFLOWS_BUILTIN_MODULE_SPECIFIER}/goal`]: { default: goal },
  [`${WORKFLOWS_BUILTIN_MODULE_SPECIFIER}/open-claude-design`]: { default: openClaudeDesign },
  [`${WORKFLOWS_BUILTIN_MODULE_SPECIFIER}/ralph`]: { default: ralph },
};

const workflowModuleLoader = createJiti(import.meta.url, {
  moduleCache: false,
  // Keep workflow-file import semantics deterministic: jiti owns .ts/.js/.mjs/.cjs
  // resolution instead of handing some imports back to native import().
  tryNative: false,
  // Resolve the @bastani/workflows SDK (and its builtin submodules) to in-memory
  // surfaces in every runtime. This mirrors the compiled bun binary path and
  // keeps discovery fast: aliasing the SDK to its on-disk package re-evaluated
  // the entire SDK module graph once per workflow file (moduleCache stays false),
  // which scaled discovery to multiple seconds on projects with many workflow
  // files. Workflow files themselves are still evaluated fresh from disk, so
  // `/workflow reload` continues to observe edits.
  virtualModules: WORKFLOWS_VIRTUAL_MODULES,
});

function materializeModuleObject(mod: object): Record<string, unknown> {
  const materialized: Record<string, unknown> = {};

  // jiti's callable API can return an interop namespace proxy. Its own property
  // descriptors contain the authored export values, but property access may apply
  // default-export conveniences (and even expose a throwing inherited `then`
  // getter for `export default null`). Copy own descriptors into a plain object
  // so candidate collection sees the exact authored exports.
  for (const key of Object.getOwnPropertyNames(mod)) {
    const descriptor = Object.getOwnPropertyDescriptor(mod, key);
    if (descriptor === undefined) continue;

    const value = "value" in descriptor ? descriptor.value : descriptor.get?.call(mod);
    Object.defineProperty(materialized, key, {
      value,
      enumerable: descriptor.enumerable,
      configurable: true,
      writable: true,
    });
  }

  return materialized;
}

function normalizeWorkflowModule(mod: unknown): Record<string, unknown> {
  if (mod !== null && typeof mod === "object") {
    return materializeModuleObject(mod);
  }
  // CJS/default interop can return the exported value directly; wrap it so the
  // candidate collector can handle it the same way as an ESM default export.
  return { default: mod };
}

export interface WorkflowModuleCandidate {
  readonly value: unknown;
  readonly exportKey: string;
}

export function validateWorkflowDefinitionShape(value: unknown): string | null {
  if (value === null || typeof value !== "object") {
    return "export is not an object";
  }
  const d = value as Record<string, unknown>;

  if (d["__piWorkflow"] !== true) {
    return "missing or incorrect __piWorkflow sentinel (expected true); export a workflow from workflow({...})";
  }
  if (!isBrandedWorkflowDefinition(value)) {
    return "workflow definition is not produced by workflow({...}); hand-rolled __piWorkflow objects are not supported";
  }
  if (typeof d["name"] !== "string" || (d["name"] as string).trim().length === 0) {
    return "name must be a non-empty string";
  }
  if (typeof d["normalizedName"] !== "string" || (d["normalizedName"] as string).trim().length === 0) {
    return "normalizedName must be a non-empty string";
  }
  if (typeof d["run"] !== "function") {
    return "run must be a function";
  }
  return null;
}

export function loadWorkflowModule(filePath: string): Record<string, unknown> {
  return normalizeWorkflowModule(workflowModuleLoader(filePath));
}

export function collectWorkflowModuleCandidates(mod: Record<string, unknown>): WorkflowModuleCandidate[] {
  const candidates: WorkflowModuleCandidate[] = [];

  // Default export first (RFC §5.12: check mod.default before named exports)
  if ("default" in mod && mod["default"] !== undefined) {
    candidates.push({ value: mod["default"], exportKey: "default" });
  }

  // Then all named exports (a file may export multiple workflow definitions)
  for (const [key, val] of Object.entries(mod)) {
    if (key === "default") continue;
    if (val !== undefined) {
      candidates.push({ value: val, exportKey: key });
    }
  }

  return candidates;
}
