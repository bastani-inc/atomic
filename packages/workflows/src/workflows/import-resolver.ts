/**
 * Workflow import resolution and import graph validation.
 *
 * Supports imports by registered workflow id and by local module path plus an
 * optional export key. Path imports use the shared workflow jiti loader so they
 * behave like discovery-loaded workflow files.
 */

import { dirname, isAbsolute, resolve } from "node:path";
import type {
  WorkflowDefinition,
  WorkflowImportDeclaration,
  WorkflowImportSource,
} from "../shared/types.js";
import {
  loadWorkflowModule,
  validateWorkflowDefinitionShape,
} from "../extension/workflow-module-loader.js";
import type { WorkflowRegistry } from "./registry.js";

export type WorkflowImportDiagnosticCode = "IMPORT_UNRESOLVED" | "IMPORT_CIRCULAR" | "IMPORT_INVALID";

export interface WorkflowImportDiagnostic {
  readonly level: "error";
  readonly code: WorkflowImportDiagnosticCode;
  readonly message: string;
  readonly source?: string;
  readonly workflow?: string;
  readonly alias?: string;
  readonly chain?: readonly string[];
}

export interface WorkflowSourceReference {
  readonly id: string;
  readonly filePath?: string;
}

export interface WorkflowImportResolverOptions {
  readonly registry: WorkflowRegistry;
  readonly cwd?: string;
  readonly sources?: readonly WorkflowSourceReference[];
}

export interface WorkflowImportGraphValidationOptions extends WorkflowImportResolverOptions {
  readonly roots?: readonly WorkflowDefinition[];
}

export interface ResolvedWorkflowImport {
  readonly alias: string;
  readonly declaration: WorkflowImportDeclaration;
  readonly definition: WorkflowDefinition;
  readonly identity: string;
  readonly label: string;
  readonly filePath?: string;
  readonly exportKey?: string;
}

export type WorkflowImportResolution =
  | { readonly ok: true; readonly resolved: ResolvedWorkflowImport }
  | { readonly ok: false; readonly diagnostic: WorkflowImportDiagnostic };

type ImportDeclarationResolution =
  | { readonly ok: true; readonly declaration: WorkflowImportDeclaration }
  | { readonly ok: false; readonly diagnostic: WorkflowImportDiagnostic };

interface StackNode {
  readonly identity: string;
  readonly label: string;
}

interface PathCacheEntry {
  readonly filePath: string;
  readonly exportKey: string;
  readonly value?: unknown;
  readonly loadError?: string;
}

function importSourceSummary(source: WorkflowImportSource): string {
  if ("workflow" in source) return `workflow:${source.workflow}`;
  return `path:${source.path}${source.export !== undefined ? `#${source.export}` : "#default"}`;
}

function hasOwnRecordKey(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidImportSource(value: unknown): value is WorkflowImportSource {
  if (!isRecord(value)) return false;
  const hasWorkflow = hasOwnRecordKey(value, "workflow");
  const hasPath = hasOwnRecordKey(value, "path");
  if (hasWorkflow === hasPath) return false;
  if (hasWorkflow) {
    return typeof value["workflow"] === "string" && value["workflow"].trim().length > 0;
  }
  if (typeof value["path"] !== "string" || value["path"].trim().length === 0) return false;
  return value["export"] === undefined || typeof value["export"] === "string";
}

function invalidDiagnostic(
  parent: WorkflowDefinition,
  alias: string,
  message: string,
  source?: string,
): WorkflowImportDiagnostic {
  return {
    level: "error",
    code: "IMPORT_INVALID",
    workflow: parent.normalizedName,
    alias,
    message: `Workflow "${parent.name}" import "${alias}" is invalid: ${message}`,
    ...(source !== undefined ? { source } : {}),
  };
}

function unresolvedDiagnostic(
  parent: WorkflowDefinition,
  alias: string,
  message: string,
  source?: string,
): WorkflowImportDiagnostic {
  return {
    level: "error",
    code: "IMPORT_UNRESOLVED",
    workflow: parent.normalizedName,
    alias,
    message: `Workflow "${parent.name}" import "${alias}" could not be resolved: ${message}`,
    ...(source !== undefined ? { source } : {}),
  };
}

function sourceFileForWorkflow(
  workflow: WorkflowDefinition,
  sources: readonly WorkflowSourceReference[] | undefined,
): string | undefined {
  return sources?.find((source) => source.id === workflow.normalizedName)?.filePath;
}

function baseDirForWorkflow(
  workflow: WorkflowDefinition,
  options: WorkflowImportResolverOptions,
  pathOrigins?: WeakMap<WorkflowDefinition, string>,
): string {
  const originFile = pathOrigins?.get(workflow);
  if (originFile !== undefined) return dirname(originFile);
  const sourceFile = sourceFileForWorkflow(workflow, options.sources);
  if (sourceFile !== undefined) return dirname(sourceFile);
  return options.cwd ?? process.cwd();
}

function resolveImportPath(
  parent: WorkflowDefinition,
  path: string,
  options: WorkflowImportResolverOptions,
  pathOrigins?: WeakMap<WorkflowDefinition, string>,
): string {
  return isAbsolute(path) ? path : resolve(baseDirForWorkflow(parent, options, pathOrigins), path);
}

function workflowIdentity(definition: WorkflowDefinition): string {
  return `workflow:${definition.normalizedName}`;
}

function pathIdentity(filePath: string, exportKey: string): string {
  return `path:${filePath}#${exportKey}`;
}

function identityForResolvedPathDefinition(
  definition: WorkflowDefinition,
  filePath: string,
  exportKey: string,
  options: WorkflowImportResolverOptions,
): string {
  const sourceFile = sourceFileForWorkflow(definition, options.sources);
  if (sourceFile !== undefined && sourceFile === filePath) {
    return workflowIdentity(definition);
  }
  return pathIdentity(filePath, exportKey);
}

function resolutionLabel(definition: WorkflowDefinition, identity: string): string {
  return identity.startsWith("workflow:") ? definition.normalizedName : identity.replace(/^path:/, "");
}

function declarationForAlias(
  parent: WorkflowDefinition,
  alias: string,
): ImportDeclarationResolution {
  const declaration = parent.imports?.[alias];
  if (declaration === undefined) {
    return {
      ok: false,
      diagnostic: unresolvedDiagnostic(parent, alias, `alias is not declared on workflow "${parent.name}"`),
    };
  }
  if (!isRecord(declaration)) {
    return { ok: false, diagnostic: invalidDiagnostic(parent, alias, "declaration must be an object") };
  }
  const source = declaration["source"];
  if (!isValidImportSource(source)) {
    return { ok: false, diagnostic: invalidDiagnostic(parent, alias, "source must be { workflow: string } or { path: string; export?: string }") };
  }
  if (declaration["description"] !== undefined && typeof declaration["description"] !== "string") {
    return { ok: false, diagnostic: invalidDiagnostic(parent, alias, "description must be a string when provided") };
  }
  return {
    ok: true,
    declaration: {
      source,
      ...(typeof declaration["description"] === "string" ? { description: declaration["description"] } : {}),
    },
  };
}

function loadPathExport(
  filePath: string,
  exportKey: string,
  pathCache: Map<string, PathCacheEntry>,
): PathCacheEntry {
  const cacheKey = `${filePath}#${exportKey}`;
  const cached = pathCache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const mod = loadWorkflowModule(filePath);
    if (!hasOwnRecordKey(mod, exportKey) || mod[exportKey] === undefined) {
      const entry: PathCacheEntry = {
        filePath,
        exportKey,
        loadError: `export "${exportKey}" was not found`,
      };
      pathCache.set(cacheKey, entry);
      return entry;
    }
    const entry: PathCacheEntry = { filePath, exportKey, value: mod[exportKey] };
    pathCache.set(cacheKey, entry);
    return entry;
  } catch (err) {
    const entry: PathCacheEntry = {
      filePath,
      exportKey,
      loadError: err instanceof Error ? err.message : String(err),
    };
    pathCache.set(cacheKey, entry);
    return entry;
  }
}

function resolveDeclaredImport(
  parent: WorkflowDefinition,
  alias: string,
  declaration: WorkflowImportDeclaration,
  options: WorkflowImportResolverOptions,
  pathCache: Map<string, PathCacheEntry>,
  pathOrigins?: WeakMap<WorkflowDefinition, string>,
): WorkflowImportResolution {
  const source = declaration.source;
  if ("workflow" in source) {
    const child = options.registry.get(source.workflow);
    if (child === undefined) {
      return {
        ok: false,
        diagnostic: unresolvedDiagnostic(parent, alias, `registered workflow "${source.workflow}" was not found`, source.workflow),
      };
    }
    const identity = workflowIdentity(child);
    return {
      ok: true,
      resolved: {
        alias,
        declaration,
        definition: child,
        identity,
        label: resolutionLabel(child, identity),
      },
    };
  }

  const exportKey = source.export ?? "default";
  const filePath = resolveImportPath(parent, source.path, options, pathOrigins);
  const entry = loadPathExport(filePath, exportKey, pathCache);
  if (entry.loadError !== undefined) {
    return {
      ok: false,
      diagnostic: unresolvedDiagnostic(parent, alias, `${entry.loadError} (${filePath}#${exportKey})`, `${filePath}#${exportKey}`),
    };
  }

  const reason = validateWorkflowDefinitionShape(entry.value);
  if (reason !== null) {
    return {
      ok: false,
      diagnostic: invalidDiagnostic(parent, alias, `path export "${exportKey}" rejected: ${reason}`, `${filePath}#${exportKey}`),
    };
  }

  const definition = entry.value as WorkflowDefinition;
  pathOrigins?.set(definition, filePath);
  const identity = identityForResolvedPathDefinition(definition, filePath, exportKey, options);
  return {
    ok: true,
    resolved: {
      alias,
      declaration,
      definition,
      identity,
      label: resolutionLabel(definition, identity),
      filePath,
      exportKey,
    },
  };
}

function importDeclarations(definition: WorkflowDefinition): readonly [string, unknown][] {
  const imports = definition.imports;
  if (imports === undefined) return [];
  if (!isRecord(imports)) return [["<imports>", imports]];
  return Object.entries(imports);
}

function circularDiagnostic(stack: readonly StackNode[], repeated: StackNode): WorkflowImportDiagnostic {
  const start = stack.findIndex((node) => node.identity === repeated.identity);
  const cycle = [...stack.slice(Math.max(0, start)), repeated].map((node) => node.label);
  return {
    level: "error",
    code: "IMPORT_CIRCULAR",
    message: `Circular workflow import detected: ${cycle.join(" -> ")}`,
    source: cycle.join(" -> "),
    workflow: repeated.label,
    chain: Object.freeze(cycle),
  };
}

function diagnosticKey(diagnostic: WorkflowImportDiagnostic): string {
  return JSON.stringify([
    diagnostic.code,
    diagnostic.workflow ?? "",
    diagnostic.alias ?? "",
    diagnostic.source ?? "",
    diagnostic.message,
  ]);
}

function pushDiagnostic(
  diagnostics: WorkflowImportDiagnostic[],
  seen: Set<string>,
  diagnostic: WorkflowImportDiagnostic,
): void {
  const key = diagnosticKey(diagnostic);
  if (seen.has(key)) return;
  seen.add(key);
  diagnostics.push(diagnostic);
}

export function resolveWorkflowImport(
  parent: WorkflowDefinition,
  alias: string,
  options: WorkflowImportResolverOptions,
): WorkflowImportResolution {
  const declaration = declarationForAlias(parent, alias);
  if (!declaration.ok) return declaration;
  return resolveDeclaredImport(parent, alias, declaration.declaration, options, new Map());
}

export function validateWorkflowImportGraph(
  options: WorkflowImportGraphValidationOptions,
): WorkflowImportDiagnostic[] {
  const diagnostics: WorkflowImportDiagnostic[] = [];
  const seenDiagnostics = new Set<string>();
  const visited = new Set<string>();
  const pathCache = new Map<string, PathCacheEntry>();
  const pathOrigins = new WeakMap<WorkflowDefinition, string>();
  const roots = options.roots ?? options.registry.all();

  const visit = (definition: WorkflowDefinition, identity: string, label: string, stack: readonly StackNode[]): void => {
    const repeated = stack.find((node) => node.identity === identity);
    if (repeated !== undefined) {
      pushDiagnostic(diagnostics, seenDiagnostics, circularDiagnostic(stack, { identity, label }));
      return;
    }
    if (visited.has(identity)) return;

    const nextStack = [...stack, { identity, label }];
    for (const [alias, rawDeclaration] of importDeclarations(definition)) {
      if (alias === "<imports>") {
        pushDiagnostic(diagnostics, seenDiagnostics, invalidDiagnostic(definition, alias, "imports must be an object map"));
        continue;
      }
      if (!isRecord(rawDeclaration)) {
        pushDiagnostic(diagnostics, seenDiagnostics, invalidDiagnostic(definition, alias, "declaration must be an object"));
        continue;
      }
      const source = rawDeclaration["source"];
      if (!isValidImportSource(source)) {
        pushDiagnostic(diagnostics, seenDiagnostics, invalidDiagnostic(definition, alias, "source must be { workflow: string } or { path: string; export?: string }"));
        continue;
      }
      const declaration: WorkflowImportDeclaration = {
        source,
        ...(typeof rawDeclaration["description"] === "string" ? { description: rawDeclaration["description"] } : {}),
      };
      const resolved = resolveDeclaredImport(definition, alias, declaration, options, pathCache, pathOrigins);
      if (!resolved.ok) {
        pushDiagnostic(diagnostics, seenDiagnostics, resolved.diagnostic);
        continue;
      }
      visit(
        resolved.resolved.definition,
        resolved.resolved.identity,
        resolved.resolved.label,
        nextStack,
      );
    }

    visited.add(identity);
  };

  for (const root of roots) {
    visit(root, workflowIdentity(root), root.normalizedName, []);
  }

  return diagnostics;
}

export function formatWorkflowImportDiagnostics(diagnostics: readonly WorkflowImportDiagnostic[]): string {
  return diagnostics.map((diagnostic) => `  - ${diagnostic.code}: ${diagnostic.message}`).join("\n");
}

export function workflowImportSourceSummary(declaration: WorkflowImportDeclaration): string {
  return importSourceSummary(declaration.source);
}
