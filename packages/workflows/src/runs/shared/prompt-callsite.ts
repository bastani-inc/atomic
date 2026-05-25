/**
 * Prompt replay keys include a normalized workflow-author callsite so two
 * `ctx.ui.*` prompts with identical descriptors can still replay the matching
 * answer after continuation. Runtime/framework frames are filtered out; the
 * selected frame is hashed by the executor and never persisted in raw form.
 */

import { relative, win32 } from "node:path";
import { fileURLToPath } from "node:url";

export interface PromptCallsiteFrame {
  readonly normalizedPath: string;
  readonly lineNumber: string;
  readonly columnNumber: string;
}

const WORKFLOW_RUNTIME_ROOTS = [
  "/packages/workflows/src/",
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

  normalized = normalizeSlashes(normalized).replace(/^\/([A-Za-z]:\/)/, "$1");

  const cwd = normalizeSlashes(process.cwd());
  if (normalized.startsWith(`${cwd}/`)) {
    normalized = normalizeSlashes(relative(process.cwd(), normalized));
  } else if (normalized.startsWith("/") && !win32.isAbsolute(normalized)) {
    normalized = normalizeSlashes(relative(process.cwd(), normalized));
  }

  return normalized;
}

export function isWorkflowRuntimeFrame(normalizedPath: string): boolean {
  const path = normalizeSlashes(normalizedPath);
  const comparable = path.startsWith("/") ? path : `/${path}`;
  return WORKFLOW_RUNTIME_ROOTS.some((runtimeRoot) => comparable.includes(runtimeRoot));
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
