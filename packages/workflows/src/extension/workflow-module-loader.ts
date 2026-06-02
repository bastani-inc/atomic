/**
 * Shared workflow module loading helpers.
 *
 * Discovery loads user-authored workflow files through this jiti instance so
 * TypeScript/ESM/CJS semantics and the @bastani/workflows virtual SDK alias
 * stay consistent.
 */

import { readFileSync } from "node:fs";
import { createJiti } from "jiti/static";
import * as workflowsSdkSurface from "../sdk-surface.js";
import { isBrandedWorkflowDefinition } from "../workflows/define-workflow.js";
import deepResearchCodebase from "../../builtin/deep-research-codebase.js";
import goal from "../../builtin/goal.js";
import openClaudeDesign from "../../builtin/open-claude-design.js";
import ralph from "../../builtin/ralph.js";

const WORKFLOWS_MODULE_SPECIFIER = "@bastani/workflows";
const WORKFLOWS_BUILTIN_MODULE_SPECIFIER = `${WORKFLOWS_MODULE_SPECIFIER}/builtin`;
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
const WORKFLOWS_VIRTUAL_MODULES: Record<string, unknown> = {
  [WORKFLOWS_MODULE_SPECIFIER]: WORKFLOWS_SDK_MODULE,
  [WORKFLOWS_BUILTIN_MODULE_SPECIFIER]: WORKFLOWS_BUILTIN_MODULE,
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

interface SourceToken {
  readonly kind: "identifier" | "string" | "punct";
  readonly value: string;
}

function isIdentifierStart(char: string): boolean {
  return /[A-Za-z_$]/.test(char);
}

function isIdentifierPart(char: string): boolean {
  return /[A-Za-z0-9_$]/.test(char);
}

function readStringToken(source: string, start: number, quote: string): { readonly token: SourceToken; readonly nextIndex: number } {
  let index = start + 1;
  let value = "";
  let escaped = false;

  while (index < source.length) {
    const current = source[index]!;
    if (escaped) {
      value += current;
      escaped = false;
      index += 1;
      continue;
    }
    if (current === "\\") {
      escaped = true;
      index += 1;
      continue;
    }
    if (current === quote) {
      return { token: { kind: "string", value }, nextIndex: index + 1 };
    }
    value += current;
    index += 1;
  }

  return { token: { kind: "string", value }, nextIndex: index };
}

function tokenizeJavaScriptForWorkflowImportScan(source: string): readonly SourceToken[] {
  const tokens: SourceToken[] = [];
  let index = 0;

  while (index < source.length) {
    const current = source[index]!;
    const next = source[index + 1];

    if (/\s/.test(current)) {
      index += 1;
      continue;
    }

    if (current === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }

    if (current === "/" && next === "*") {
      index += 2;
      while (index < source.length) {
        if (source[index] === "*" && source[index + 1] === "/") {
          index += 2;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (current === '"' || current === "'" || current === "`") {
      const result = readStringToken(source, index, current);
      tokens.push(result.token);
      index = result.nextIndex;
      continue;
    }

    if (isIdentifierStart(current)) {
      let value = current;
      index += 1;
      while (index < source.length && isIdentifierPart(source[index]!)) {
        value += source[index]!;
        index += 1;
      }
      tokens.push({ kind: "identifier", value });
      continue;
    }

    tokens.push({ kind: "punct", value: current });
    index += 1;
  }

  return tokens;
}

function tokenValue(tokens: readonly SourceToken[], index: number): string | undefined {
  return tokens[index]?.value;
}

function isIdentifier(tokens: readonly SourceToken[], index: number, value?: string): boolean {
  const token = tokens[index];
  return token?.kind === "identifier" && (value === undefined || token.value === value);
}

function isWorkflowModuleString(tokens: readonly SourceToken[], index: number): boolean {
  const token = tokens[index];
  return token?.kind === "string" && token.value === WORKFLOWS_MODULE_SPECIFIER;
}

function findMatchingToken(
  tokens: readonly SourceToken[],
  start: number,
  open: string,
  close: string,
): number | undefined {
  if (tokenValue(tokens, start) !== open) return undefined;
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    const value = tokenValue(tokens, index);
    if (value === open) depth += 1;
    if (value === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

function workflowModuleCallCloseAt(
  tokens: readonly SourceToken[],
  index: number,
  callee: "import" | "require",
): number | undefined {
  if (!isIdentifier(tokens, index, callee) || tokenValue(tokens, index + 1) !== "(") return undefined;
  const close = findMatchingToken(tokens, index + 1, "(", ")");
  if (close === undefined || close !== index + 3) return undefined;
  return isWorkflowModuleString(tokens, index + 2) ? close : undefined;
}

function workflowModuleExpressionCloseAt(tokens: readonly SourceToken[], index: number): number | undefined {
  let cursor = index;
  if (isIdentifier(tokens, cursor, "await")) cursor += 1;

  if (tokenValue(tokens, cursor) === "(") {
    const close = findMatchingToken(tokens, cursor, "(", ")");
    if (close !== undefined) {
      const innerClose = workflowModuleExpressionCloseAt(tokens, cursor + 1);
      if (innerClose !== undefined && innerClose < close) return close;
    }
  }

  return workflowModuleCallCloseAt(tokens, cursor, "require") ?? workflowModuleCallCloseAt(tokens, cursor, "import");
}

function isRunWorkflowMemberAccessAt(tokens: readonly SourceToken[], index: number): boolean {
  if (tokenValue(tokens, index) === "." && isIdentifier(tokens, index + 1, "runWorkflow")) return true;
  if (tokenValue(tokens, index) === "?" && tokenValue(tokens, index + 1) === "." && isIdentifier(tokens, index + 2, "runWorkflow")) return true;
  if (tokenValue(tokens, index) === "[" && tokenValue(tokens, index + 2) === "]") {
    const token = tokens[index + 1];
    return token?.kind === "string" && token.value === "runWorkflow";
  }
  return false;
}

function isRunWorkflowMemberAccessAfterCall(tokens: readonly SourceToken[], callClose: number): boolean {
  let cursor = callClose + 1;
  while (tokenValue(tokens, cursor) === ")") cursor += 1;
  return isRunWorkflowMemberAccessAt(tokens, cursor);
}

function namedImportSpecifiersIncludeRunWorkflow(tokens: readonly SourceToken[], start: number, end: number): boolean {
  let cursor = start + 1;
  while (cursor < end) {
    if (tokenValue(tokens, cursor) === ",") {
      cursor += 1;
      continue;
    }

    if (isIdentifier(tokens, cursor, "type")) cursor += 1;
    const token = tokens[cursor];
    if (token !== undefined && (token.kind === "identifier" || token.kind === "string")) {
      if (token.value === "runWorkflow") return true;
      while (cursor < end && tokenValue(tokens, cursor) !== ",") cursor += 1;
      continue;
    }

    cursor += 1;
  }
  return false;
}

function objectPatternImportsRunWorkflow(tokens: readonly SourceToken[], start: number, end: number): boolean {
  let depth = 1;
  let expectingProperty = true;

  for (let cursor = start + 1; cursor < end; cursor += 1) {
    const value = tokenValue(tokens, cursor);
    if (value === "{" || value === "[") {
      depth += 1;
      continue;
    }
    if (value === "}" || value === "]") {
      depth -= 1;
      continue;
    }
    if (depth !== 1) continue;
    if (value === ",") {
      expectingProperty = true;
      continue;
    }
    if (value === "...") {
      expectingProperty = false;
      continue;
    }
    if (!expectingProperty) continue;

    const token = tokens[cursor];
    if (token !== undefined && (token.kind === "identifier" || token.kind === "string") && token.value === "runWorkflow") {
      return true;
    }
    expectingProperty = false;
  }

  return false;
}

function staticImportReferencesRemovedRunWorkflow(
  tokens: readonly SourceToken[],
  index: number,
  namespaceBindings: Set<string>,
): boolean {
  if (!isIdentifier(tokens, index, "import") || tokenValue(tokens, index + 1) === "(") return false;

  let cursor = index + 1;
  if (isIdentifier(tokens, cursor, "type")) cursor += 1;
  if (tokens[cursor]?.kind === "string") return false;

  let fromIndex: number | undefined;
  for (let scan = cursor; scan < tokens.length; scan += 1) {
    if (tokenValue(tokens, scan) === ";") break;
    if (isIdentifier(tokens, scan, "from") && isWorkflowModuleString(tokens, scan + 1)) {
      fromIndex = scan;
      break;
    }
  }
  if (fromIndex === undefined) return false;

  let defaultBinding: string | undefined;
  let namespaceBinding: string | undefined;

  if (isIdentifier(tokens, cursor) && tokenValue(tokens, cursor) !== "from") {
    defaultBinding = tokenValue(tokens, cursor);
    if (defaultBinding === "runWorkflow") return true;
    cursor += 1;
    if (tokenValue(tokens, cursor) === ",") cursor += 1;
  }

  if (tokenValue(tokens, cursor) === "*" && isIdentifier(tokens, cursor + 1, "as") && isIdentifier(tokens, cursor + 2)) {
    namespaceBinding = tokenValue(tokens, cursor + 2);
  } else if (tokenValue(tokens, cursor) === "{") {
    const importEnd = findMatchingToken(tokens, cursor, "{", "}");
    if (importEnd !== undefined && importEnd < fromIndex && namedImportSpecifiersIncludeRunWorkflow(tokens, cursor, importEnd)) {
      return true;
    }
  }

  if (defaultBinding !== undefined) namespaceBindings.add(defaultBinding);
  if (namespaceBinding !== undefined) namespaceBindings.add(namespaceBinding);
  return false;
}

function assignmentOperatorIndexAfterBinding(tokens: readonly SourceToken[], nameIndex: number): number | undefined {
  if (!isIdentifier(tokens, nameIndex)) return undefined;
  if (tokenValue(tokens, nameIndex + 1) === "=") return nameIndex + 1;
  if (tokenValue(tokens, nameIndex + 1) !== ":") return undefined;

  let depth = 0;
  for (let cursor = nameIndex + 2; cursor < tokens.length; cursor += 1) {
    const value = tokenValue(tokens, cursor);
    if (value === "(" || value === "{" || value === "[" || value === "<") {
      depth += 1;
      continue;
    }
    if (value === ")" || value === "}" || value === "]" || value === ">") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0 && value === "=") return cursor;
    if (depth === 0 && (value === ";" || value === ",")) return undefined;
  }
  return undefined;
}

function collectWorkflowModuleNamespaceBinding(
  tokens: readonly SourceToken[],
  index: number,
  namespaceBindings: Set<string>,
): boolean {
  if (!isIdentifier(tokens, index) || !["const", "let", "var"].includes(tokens[index]!.value)) return false;

  let found = false;
  let depth = 0;
  for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
    const value = tokenValue(tokens, cursor);
    if (depth === 0 && value === ";") break;
    if (depth === 0 && isIdentifier(tokens, cursor)) {
      const assignmentIndex = assignmentOperatorIndexAfterBinding(tokens, cursor);
      if (assignmentIndex !== undefined) {
        const expressionClose = workflowModuleExpressionCloseAt(tokens, assignmentIndex + 1);
        if (expressionClose !== undefined) {
          namespaceBindings.add(tokens[cursor]!.value);
          found = true;
          cursor = expressionClose;
          continue;
        }
      }
    }

    if (value === "(" || value === "{" || value === "[" || value === "<") {
      depth += 1;
      continue;
    }
    if (value === ")" || value === "}" || value === "]" || value === ">") {
      depth = Math.max(0, depth - 1);
    }
  }
  return found;
}

function staticExportReferencesRemovedRunWorkflow(
  tokens: readonly SourceToken[],
  index: number,
  namespaceBindings: Set<string>,
): boolean {
  if (!isIdentifier(tokens, index, "export")) return false;

  if (tokenValue(tokens, index + 1) === "*" && isIdentifier(tokens, index + 2, "as") && isIdentifier(tokens, index + 3)) {
    if (isIdentifier(tokens, index + 4, "from") && isWorkflowModuleString(tokens, index + 5)) {
      namespaceBindings.add(tokens[index + 3]!.value);
    }
    return false;
  }

  if (tokenValue(tokens, index + 1) !== "{") return false;
  const exportEnd = findMatchingToken(tokens, index + 1, "{", "}");
  if (exportEnd === undefined) return false;
  if (!isIdentifier(tokens, exportEnd + 1, "from") || !isWorkflowModuleString(tokens, exportEnd + 2)) return false;
  return namedImportSpecifiersIncludeRunWorkflow(tokens, index + 1, exportEnd);
}

function destructuringReferencesRemovedRunWorkflow(
  tokens: readonly SourceToken[],
  index: number,
  namespaceBindings: Set<string>,
): boolean {
  const patternStart = ["const", "let", "var"].includes(tokenValue(tokens, index) ?? "") ? index + 1 : index;
  if (tokenValue(tokens, patternStart) !== "{") return false;
  const patternEnd = findMatchingToken(tokens, patternStart, "{", "}");
  if (patternEnd === undefined || tokenValue(tokens, patternEnd + 1) !== "=") return false;
  if (!objectPatternImportsRunWorkflow(tokens, patternStart, patternEnd)) return false;

  const rhsStart = patternEnd + 2;
  if (workflowModuleExpressionCloseAt(tokens, rhsStart) !== undefined) return true;
  return isIdentifier(tokens, rhsStart) && namespaceBindings.has(tokens[rhsStart]!.value);
}

function sourceReferencesRemovedWorkflowSdkImport(source: string): boolean {
  const tokens = tokenizeJavaScriptForWorkflowImportScan(source);
  const namespaceBindings = new Set<string>();

  for (let index = 0; index < tokens.length; index += 1) {
    if (staticImportReferencesRemovedRunWorkflow(tokens, index, namespaceBindings)) return true;
    if (staticExportReferencesRemovedRunWorkflow(tokens, index, namespaceBindings)) return true;
    collectWorkflowModuleNamespaceBinding(tokens, index, namespaceBindings);
    if (destructuringReferencesRemovedRunWorkflow(tokens, index, namespaceBindings)) return true;
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const requireClose = workflowModuleCallCloseAt(tokens, index, "require");
    if (requireClose !== undefined && isRunWorkflowMemberAccessAfterCall(tokens, requireClose)) return true;

    const importClose = workflowModuleCallCloseAt(tokens, index, "import");
    if (importClose !== undefined && isRunWorkflowMemberAccessAfterCall(tokens, importClose)) return true;

    if (token?.kind === "identifier" && namespaceBindings.has(token.value) && isRunWorkflowMemberAccessAt(tokens, index + 1)) {
      return true;
    }

    if (destructuringReferencesRemovedRunWorkflow(tokens, index, namespaceBindings)) return true;
  }

  return false;
}

function assertNoRemovedWorkflowSdkImports(filePath: string): void {
  const source = readFileSync(filePath, "utf-8");
  if (!sourceReferencesRemovedWorkflowSdkImport(source)) return;
  throw new Error(
    "@bastani/workflows no longer exports runWorkflow; author workflows with defineWorkflow(...).compile()",
  );
}

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
    return "missing or incorrect __piWorkflow sentinel (expected true); export a workflow from defineWorkflow(...).compile()";
  }
  if (!isBrandedWorkflowDefinition(value)) {
    return "workflow definition is not produced by defineWorkflow(...).compile(); hand-rolled __piWorkflow objects are not supported";
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
  assertNoRemovedWorkflowSdkImports(filePath);
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
