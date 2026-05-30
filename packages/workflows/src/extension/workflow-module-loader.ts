/**
 * Shared workflow module loading helpers.
 *
 * Discovery and workflow import resolution both load user-authored workflow
 * files through the same jiti instance so TypeScript/ESM/CJS semantics and the
 * @bastani/workflows virtual SDK alias stay consistent.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { isBunBinary } from "@bastani/atomic";
import { createJiti } from "jiti/static";
import * as workflowsSdkSurface from "../sdk-surface.js";

type RunWorkflowFunction = typeof import("../runs/shared/workflow-runner.js").runWorkflow;

const runWorkflow: RunWorkflowFunction = async (...args) => {
  const { runWorkflow: actualRunWorkflow } = await import("../runs/shared/workflow-runner.js");
  return actualRunWorkflow(...args);
};

const require = createRequire(import.meta.url);
const WORKFLOWS_MODULE_SPECIFIER = "@bastani/workflows";
// Keep this in sync with index.ts through sdk-surface.ts. runWorkflow stays as
// a lazy wrapper because the public re-export comes from workflow-runner.ts,
// which imports discovery.ts and would otherwise reintroduce a cycle.
const WORKFLOWS_SDK_MODULE: Record<string, unknown> = {
  ...workflowsSdkSurface,
  runWorkflow,
};
const WORKFLOWS_VIRTUAL_MODULES: Record<string, unknown> = {
  [WORKFLOWS_MODULE_SPECIFIER]: WORKFLOWS_SDK_MODULE,
};

function resolveWorkflowsSdkAlias(): string {
  // Resolve the package self-reference through package.json exports instead of
  // pinning loader code to the current src/extension -> src/index.ts layout.
  const sdkEntry = require.resolve(WORKFLOWS_MODULE_SPECIFIER);
  if (!existsSync(sdkEntry)) {
    throw new Error(
      `Unable to resolve ${WORKFLOWS_MODULE_SPECIFIER} SDK entry at ${sdkEntry}. ` +
        "Check the package exports map for the workflows SDK entry.",
    );
  }
  return sdkEntry;
}

const workflowModuleLoader = createJiti(import.meta.url, {
  moduleCache: false,
  // Keep workflow-file import semantics deterministic: jiti owns .ts/.js/.mjs/.cjs
  // resolution instead of handing some imports back to native import().
  tryNative: false,
  ...(isBunBinary
    ? { virtualModules: WORKFLOWS_VIRTUAL_MODULES }
    : { alias: { [WORKFLOWS_MODULE_SPECIFIER]: resolveWorkflowsSdkAlias() } }),
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
    return "missing or incorrect __piWorkflow sentinel (expected true)";
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
