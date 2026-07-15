/**
 * Prompt replay keys include a normalized workflow-author callsite so two
 * `ctx.ui.*` prompts with identical descriptors can still replay the matching
 * answer after continuation. Runtime/framework frames are filtered out; the
 * selected frame is hashed by the executor and never persisted in raw form.
 */

import { fileURLToPath } from "node:url";

export interface PromptCallsiteFrame {
  readonly normalizedPath: string;
  readonly lineNumber: string;
  readonly columnNumber: string;
}

const PACKAGED_WORKFLOW_RUNTIME_ROOTS = [
  "/dist/builtin/workflows/src/",
  "/node_modules/@bastani/workflows/src/",
] as const;

function normalizeSlashes(path: string): string {
  return path.replace(/\\/g, "/");
}

export function normalizeStackPath(framePath: string): string {
  let normalized = framePath;
  if (normalized.startsWith("file://")) {
    try {
      normalized = fileURLToPath(normalized);
    } catch {
      try {
        normalized = decodeURIComponent(new URL(normalized).pathname);
      } catch {
        // Keep the original string; it will only be hashed, not persisted raw.
      }
    }
  }

  // Keep the normalized module/file identity absolute. Relativizing against
  // mutable process.cwd() makes the same persisted workflow callsite hash
  // differently when a later process starts from another directory.
  normalized = normalizeSlashes(normalized).replace(/^\/([A-Za-z]:\/)/, "$1");

  return normalized;
}

function currentModuleRuntimeRoot(): string | undefined {
  const modulePath = normalizeStackPath(fileURLToPath(import.meta.url));
  const markers = ["packages/workflows/src/", ...PACKAGED_WORKFLOW_RUNTIME_ROOTS.map((root) => root.slice(1))];
  for (const marker of markers) {
    const index = modulePath.indexOf(marker);
    if (index >= 0) return modulePath.slice(0, index + marker.length);
  }
  return undefined;
}

const CURRENT_WORKFLOW_RUNTIME_ROOT = currentModuleRuntimeRoot();

export function isWorkflowRuntimeFrame(normalizedPath: string): boolean {
  const path = normalizeSlashes(normalizedPath);
  if (path.startsWith("packages/workflows/src/")) return true;
  if (CURRENT_WORKFLOW_RUNTIME_ROOT !== undefined && path.startsWith(CURRENT_WORKFLOW_RUNTIME_ROOT)) {
    return true;
  }
  const comparable = path.startsWith("/") ? path : `/${path}`;
  return PACKAGED_WORKFLOW_RUNTIME_ROOTS.some((runtimeRoot) => comparable.includes(runtimeRoot));
}

export function parsePromptStackFrame(stackLine: string): PromptCallsiteFrame | undefined {
  const line = stackLine.trim();
  if (line.length === 0) return undefined;
  if (line.includes("node:internal") || line.includes("bun:") || line.includes("(native:")) return undefined;

  const match = line.match(/(\S+):(\d+):(\d+)\)?$/);
  if (!match) return undefined;
  const [, rawFramePath, lineNumber, columnNumber] = match;
  if (rawFramePath === undefined || lineNumber === undefined || columnNumber === undefined) return undefined;

  const normalizedPath = normalizeStackPath(rawFramePath.replace(/^\(/, ""));
  return { normalizedPath, lineNumber, columnNumber };
}

export function normalizedPromptCallsiteFrame(stackLine: string): string | undefined {
  const frame = parsePromptStackFrame(stackLine);
  if (frame === undefined) return undefined;
  if (isWorkflowRuntimeFrame(frame.normalizedPath)) return undefined;
  return `${frame.normalizedPath}:${frame.lineNumber}:${frame.columnNumber}`;
}

export function selectPromptCallsiteFrame(stack: string): string | undefined {
  return stack
    .split("\n")
    .slice(1)
    .map(normalizedPromptCallsiteFrame)
    .find((candidate): candidate is string => candidate !== undefined);
}
