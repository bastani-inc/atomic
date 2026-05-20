/**
 * Workflow discovery for workflows extension startup.
 *
 * Supports bundled workflows (shipped with this package) as well as
 * project-local, user-global, settings-project, and settings-global sources
 * loaded from the file system via dynamic import.
 *
 * Supported file extensions: .ts, .js, .mjs, .cjs
 *
 * Precedence order (highest wins on duplicate normalizedName):
 *   1. settings-project — paths listed in config.projectWorkflows
 *   2. project-local    — {cwd}/.atomic/workflows/*.{ts,js,mjs,cjs}
 *   3. settings-global  — paths listed in config.globalWorkflows
 *   4. user-global      — {homeDir}/.atomic/agent/workflows/*.{ts,js,mjs,cjs}
 *   5. package          — workflow files supplied by Atomic/pi packages
 *   6. bundled          — shipped workflows (skipped when includeBundled=false)
 *
 * Usage:
 *   // Full discovery (all sources):
 *   const result = await discoverWorkflows({ cwd: process.cwd(), homeDir: os.homedir() });
 */

import { readdir, stat } from "node:fs/promises";
import { join, resolve, extname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAMES, getProjectConfigPaths } from "@bastani/atomic";
import { createJiti } from "jiti/static";
import type { WorkflowDefinition } from "../shared/types.js";
import { createRegistry } from "../workflows/registry.js";
import type { WorkflowRegistry } from "../workflows/registry.js";
import * as bundledManifest from "../../builtin/index.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The source kind for a discovered workflow.
 *
 *   bundled          — shipped with the workflows package
 *   project-local    — found in {cwd}/.atomic/workflows/
 *   user-global      — found in {homeDir}/.atomic/agent/workflows/
 *   settings-project — listed in DiscoveryConfig.projectWorkflows
 *   settings-global  — listed in DiscoveryConfig.globalWorkflows
 *   package          — supplied by Atomic/pi package workflow resources
 */
export type DiscoveryKind =
  | "bundled"
  | "project-local"
  | "user-global"
  | "settings-project"
  | "settings-global"
  | "package";

/** Identifies the origin of a discovered workflow definition. */
export interface DiscoverySource {
  /** The workflow's normalizedName (registry key). */
  readonly id: string;
  /** Where this workflow was discovered from. */
  readonly kind: DiscoveryKind;
  /** Human-readable display name as authored. */
  readonly name: string;
  /** Absolute file path (undefined for bundled). */
  readonly filePath?: string;
  /**
   * The configured name (key) under which this workflow was registered in
   * settings (e.g. the key in `config.projectWorkflows`).
   * Only present for settings-project and settings-global sources loaded
   * via a named-entry config map.
   */
  readonly configuredName?: string;
}

/** Severity of a discovery diagnostic. */
export type DiagnosticLevel = "error" | "warn";

/**
 * A diagnostic emitted during discovery.
 * Errors indicate a definition was rejected; warnings indicate a recoverable
 * condition (e.g. a duplicate that was skipped).
 *
 * Codes:
 *   INVALID_DEFINITION — failed structural validation
 *   DUPLICATE_NAME     — normalizedName already registered; skipped (warn)
 *   IMPORT_FAILED      — dynamic import of a workflow file threw
 *   PATH_NOT_FOUND     — a config-specified path does not exist
 *   CONFIG_INVALID     — DiscoveryConfig has an invalid structure
 */
export interface DiscoveryDiagnostic {
  readonly level: DiagnosticLevel;
  readonly code:
    | "INVALID_DEFINITION"
    | "DUPLICATE_NAME"
    | "IMPORT_FAILED"
    | "PATH_NOT_FOUND"
    | "CONFIG_INVALID";
  readonly message: string;
  /** Export key, workflow name, or file path associated with this diagnostic. */
  readonly source?: string;
}

/**
 * Optional config for settings-based workflow paths.
 * Entries are absolute paths (or resolvable relative paths) to .ts/.js/.mjs/.cjs
 * files that export a default WorkflowDefinition.
 *
 * Both plain string arrays and named entry maps are supported:
 *   - `string[]`          — paths without configured names
 *   - `Record<string, string>` — maps configuredName → path (preserves name in DiscoverySource)
 */
export interface DiscoveryConfig {
  /** Paths to project-scoped workflow files (settings-project). */
  projectWorkflows?: string[] | Record<string, string>;
  /** Paths to globally-scoped workflow files (settings-global). */
  globalWorkflows?: string[] | Record<string, string>;
}

/**
 * Options for discoverWorkflows().
 * All fields have sensible defaults so callers can pass Partial<DiscoveryOptions>.
 */
export interface DiscoveryOptions {
  /** Working directory; used as root for project-local discovery. Default: process.cwd() */
  cwd: string;
  /** User's home directory; used as root for user-global discovery. Default: os.homedir() */
  homeDir: string;
  /** Optional extra paths from project/global config. */
  config?: DiscoveryConfig;
  /** Workflow files supplied by installed Atomic/pi packages. */
  packageWorkflowPaths?: string[] | Record<string, string>;
  /** When false, bundled workflows are excluded. Default: true */
  includeBundled?: boolean;
}

/** Result returned by discoverWorkflows(). */
export interface DiscoveryResult {
  /** Registry populated with all valid, non-duplicate definitions (precedence-ordered). */
  readonly registry: WorkflowRegistry;
  /** One record per successfully registered workflow. */
  readonly sources: readonly DiscoverySource[];
  /** All diagnostics (errors + warnings). Empty when all is well. */
  readonly errors: readonly DiscoveryDiagnostic[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Validate a candidate value as a WorkflowDefinition.
 * Returns null when valid, or a human-readable rejection reason string.
 */
function workflowRunCreatesStage(run: WorkflowDefinition["run"]): boolean {
  // Discovery must not execute workflow bodies: run functions are arbitrary
  // user code and may perform I/O before the first stage. Use a conservative
  // static guard instead so obvious no-stage definitions are rejected before
  // they can register and render an empty graph.
  const source = Function.prototype.toString.call(run);
  return /\.\s*(?:stage|task|chain|parallel)\s*\(/.test(source);
}

function validateDefinition(value: unknown): string | null {
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
  if (!workflowRunCreatesStage(d["run"] as WorkflowDefinition["run"])) {
    return "run must create at least one workflow stage via ctx.stage(), ctx.task(), ctx.chain(), or ctx.parallel(); otherwise the workflow graph is empty (cachedLayout.length === 0)";
  }
  return null;
}

/**
 * Validate DiscoveryConfig shape.
 * Returns null when valid, or a description of the problem.
 */
function validateConfig(config: unknown): string | null {
  if (config === null || typeof config !== "object") {
    return "config must be an object";
  }
  const c = config as Record<string, unknown>;
  for (const field of ["projectWorkflows", "globalWorkflows"] as const) {
    const val = c[field];
    if (val !== undefined) {
      if (Array.isArray(val)) {
        for (const entry of val) {
          if (typeof entry !== "string") return `config.${field} entries must be strings`;
        }
      } else if (typeof val === "object" && val !== null) {
        // Named map: Record<string, string>
        for (const [key, entry] of Object.entries(val as Record<string, unknown>)) {
          if (typeof entry !== "string") return `config.${field}["${key}"] must be a string path`;
        }
      } else {
        return `config.${field} must be a string array or a Record<string, string> map`;
      }
    }
  }
  return null;
}

/** Merge a batch of candidates into registry state, first-seen wins. */
function applyBatch(
  candidates: Array<{ value: unknown; exportKey: string; kind: DiscoveryKind; filePath?: string; configuredName?: string }>,
  registry: WorkflowRegistry,
  sources: DiscoverySource[],
  diagnostics: DiscoveryDiagnostic[],
): WorkflowRegistry {
  for (const { value, exportKey, kind, filePath, configuredName } of candidates) {
    const reason = validateDefinition(value);
    if (reason !== null) {
      diagnostics.push({
        level: "error",
        code: "INVALID_DEFINITION",
        message: `${kind} export "${exportKey}" rejected: ${reason}`,
        source: filePath ?? exportKey,
      });
      continue;
    }

    const def = value as WorkflowDefinition;
    const key = def.normalizedName;

    if (registry.has(key)) {
      diagnostics.push({
        level: "warn",
        code: "DUPLICATE_NAME",
        message: `${kind} export "${exportKey}" skipped: normalizedName "${key}" already registered`,
        source: filePath ?? exportKey,
      });
      continue;
    }

    registry = registry.register(def);
    sources.push({
      id: key,
      kind,
      name: def.name,
      ...(filePath !== undefined ? { filePath } : {}),
      ...(configuredName !== undefined ? { configuredName } : {}),
    });
  }
  return registry;
}

/** Scan a directory for .ts/.js/.mjs/.cjs files, returning sorted absolute paths. */
async function scanWorkflowDir(dir: string): Promise<string[] | null> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const WORKFLOW_EXTS = new Set([".ts", ".js", ".mjs", ".cjs"]);
    return entries
      .filter((e) => e.isFile() && WORKFLOW_EXTS.has(extname(e.name)))
      .map((e) => join(dir, e.name))
      .sort();
  } catch {
    // Directory doesn't exist or isn't readable — not an error, just empty
    return null;
  }
}

/** Dynamically import a file and extract all WorkflowDefinition candidates.
 *
 * Strategy: try the default export first, then every named export.
 * Both are collected — a file may export multiple workflow definitions.
 * jiti loads package-authored .ts/.js/.mjs/.cjs files with the same
 * @bastani/workflows authoring import that project/user workflow files use.
 */
const workflowModuleLoader = createJiti(import.meta.url, {
  moduleCache: false,
  alias: {
    "@bastani/workflows": fileURLToPath(new URL("../index.ts", import.meta.url)),
  },
});

function normalizeWorkflowModule(mod: unknown): Record<string, unknown> {
  if (mod !== null && typeof mod === "object") {
    return mod as Record<string, unknown>;
  }
  return { default: mod };
}

async function loadWorkflowModule(filePath: string): Promise<Record<string, unknown>> {
  return normalizeWorkflowModule(workflowModuleLoader(filePath));
}

async function importWorkflowFile(
  filePath: string,
  kind: DiscoveryKind,
  diagnostics: DiscoveryDiagnostic[],
): Promise<Array<{ value: unknown; exportKey: string; kind: DiscoveryKind; filePath: string }>> {
  let mod: Record<string, unknown>;
  try {
    mod = await loadWorkflowModule(filePath);
  } catch (err) {
    diagnostics.push({
      level: "error",
      code: "IMPORT_FAILED",
      message: `Failed to import "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
      source: filePath,
    });
    return [];
  }

  const candidates: Array<{ value: unknown; exportKey: string; kind: DiscoveryKind; filePath: string }> = [];

  // Default export first (RFC §5.12: check mod.default before named exports)
  if ("default" in mod && mod["default"] !== undefined) {
    candidates.push({ value: mod["default"], exportKey: "default", kind, filePath });
  }

  // Then all named exports (a file may export multiple workflow definitions)
  for (const [key, val] of Object.entries(mod)) {
    if (key === "default") continue;
    if (val !== undefined) {
      candidates.push({ value: val, exportKey: key, kind, filePath });
    }
  }

  return candidates;
}

/** Load workflows from a scanned directory. */
async function loadFromDir(
  dir: string,
  kind: DiscoveryKind,
  diagnostics: DiscoveryDiagnostic[],
): Promise<Array<{ value: unknown; exportKey: string; kind: DiscoveryKind; filePath: string }>> {
  const files = await scanWorkflowDir(dir);
  if (files === null) return [];

  const all: Array<{ value: unknown; exportKey: string; kind: DiscoveryKind; filePath: string }> = [];
  for (const filePath of files) {
    const candidates = await importWorkflowFile(filePath, kind, diagnostics);
    all.push(...candidates);
  }
  return all;
}

/** Load workflows from an explicit path list (from config). */
async function loadFromPaths(
  pathsOrMap: string[] | Record<string, string>,
  kind: DiscoveryKind,
  baseCwd: string,
  diagnostics: DiscoveryDiagnostic[],
): Promise<Array<{ value: unknown; exportKey: string; kind: DiscoveryKind; filePath: string; configuredName?: string }>> {
  const all: Array<{ value: unknown; exportKey: string; kind: DiscoveryKind; filePath: string; configuredName?: string }> = [];

  // Normalise to [ { rawPath, configuredName? } ] regardless of input shape
  const entries: Array<{ rawPath: string; configuredName?: string }> = Array.isArray(pathsOrMap)
    ? pathsOrMap.map((p) => ({ rawPath: p }))
    : Object.entries(pathsOrMap).map(([name, p]) => ({ rawPath: p, configuredName: name }));

  for (const { rawPath, configuredName } of entries) {
    const absPath = isAbsolute(rawPath) ? rawPath : resolve(baseCwd, rawPath);

    // Give a specific PATH_NOT_FOUND when we can detect the file is absent.
    let pathStats: Awaited<ReturnType<typeof stat>> | undefined;
    try {
      pathStats = await stat(absPath);
    } catch {
      pathStats = undefined;
    }

    if (pathStats === undefined) {
      diagnostics.push({
        level: "error",
        code: "PATH_NOT_FOUND",
        message: `Workflow path not found: "${absPath}"`,
        source: absPath,
      });
      continue;
    }

    const candidates = pathStats.isDirectory()
      ? await loadFromDir(absPath, kind, diagnostics)
      : await importWorkflowFile(absPath, kind, diagnostics);
    for (const c of candidates) {
      all.push({ ...c, ...(configuredName !== undefined ? { configuredName } : {}) });
    }
  }
  return all;
}

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

/**
 * Discover workflows from all configured sources, applying precedence order.
 *
 * Precedence (highest first; first-registered wins on duplicate normalizedName):
 *   1. settings-project — config.projectWorkflows paths
 *   2. project-local    — {cwd}/.atomic/workflows/*.{ts,js,mjs,cjs}
 *   3. settings-global  — config.globalWorkflows paths
 *   4. user-global      — {homeDir}/.atomic/agent/workflows/*.{ts,js,mjs,cjs}
 *   5. package          — package-supplied workflow files
 *   6. bundled          — shipped workflows (omitted when includeBundled=false)
 */
export async function discoverWorkflows(
  options?: Partial<DiscoveryOptions>,
): Promise<DiscoveryResult> {
  const cwd = options?.cwd ?? process.cwd();
  const homeDir = options?.homeDir ?? (await defaultHomeDir());
  const config = options?.config;
  const packageWorkflowPaths = options?.packageWorkflowPaths;
  const includeBundled = options?.includeBundled !== false;

  const diagnostics: DiscoveryDiagnostic[] = [];
  const sources: DiscoverySource[] = [];
  let registry = createRegistry();

  // Validate config if provided
  let configIsValid = true;
  if (config !== undefined) {
    const configErr = validateConfig(config);
    if (configErr !== null) {
      diagnostics.push({
        level: "error",
        code: "CONFIG_INVALID",
        message: `DiscoveryConfig is invalid: ${configErr}`,
        source: "config",
      });
      configIsValid = false;
      // Skip settings-project and settings-global loading for invalid config
    }
  }

  // 1. settings-project (highest precedence)
  if (configIsValid && config !== undefined && config.projectWorkflows !== undefined) {
    const pw = config.projectWorkflows;
    const hasEntries = Array.isArray(pw) ? pw.length > 0 : Object.keys(pw).length > 0;
    if (hasEntries) {
      const candidates = await loadFromPaths(pw, "settings-project", cwd, diagnostics);
      registry = applyBatch(candidates, registry, sources, diagnostics);
    }
  }

  // 2. project-local
  for (const dir of getProjectConfigPaths(cwd, "workflows").reverse()) {
    const candidates = await loadFromDir(dir, "project-local", diagnostics);
    registry = applyBatch(candidates, registry, sources, diagnostics);
  }

  // 3. settings-global
  if (configIsValid && config !== undefined && config.globalWorkflows !== undefined) {
    const gw = config.globalWorkflows;
    const hasEntries = Array.isArray(gw) ? gw.length > 0 : Object.keys(gw).length > 0;
    if (hasEntries) {
      const candidates = await loadFromPaths(gw, "settings-global", homeDir, diagnostics);
      registry = applyBatch(candidates, registry, sources, diagnostics);
    }
  }

  // 4. user-global — canonical Atomic path plus legacy pi path
  for (const dir of CONFIG_DIR_NAMES.map((name) => join(homeDir, name, "agent", "workflows")).reverse()) {
    const candidates = await loadFromDir(dir, "user-global", diagnostics);
    registry = applyBatch(candidates, registry, sources, diagnostics);
  }

  // 5. package workflows
  if (packageWorkflowPaths !== undefined) {
    const hasEntries = Array.isArray(packageWorkflowPaths) ? packageWorkflowPaths.length > 0 : Object.keys(packageWorkflowPaths).length > 0;
    if (hasEntries) {
      const candidates = await loadFromPaths(packageWorkflowPaths, "package", cwd, diagnostics);
      registry = applyBatch(candidates, registry, sources, diagnostics);
    }
  }

  // 6. bundled
  if (includeBundled) {
    const bundledResult = discoverBundledManifest();
    // Merge bundled: only register names not already present (lower precedence)
    for (const def of bundledResult.registry.all()) {
      const key = def.normalizedName;
      if (registry.has(key)) {
        diagnostics.push({
          level: "warn",
          code: "DUPLICATE_NAME",
          message: `Bundled workflow "${key}" skipped: already registered by higher-precedence source`,
          source: key,
        });
        continue;
      }
      registry = registry.register(def);
      sources.push({ id: key, kind: "bundled", name: def.name });
    }
    // Propagate bundled diagnostics (e.g. INVALID_DEFINITION within bundled)
    for (const d of bundledResult.errors) {
      diagnostics.push(d);
    }
  }

  return { registry, sources, errors: diagnostics };
}

/** Resolve default homeDir using os.homedir(). */
async function defaultHomeDir(): Promise<string> {
  const { homedir } = await import("node:os");
  return homedir();
}

// ---------------------------------------------------------------------------
// Startup seed discovery
// ---------------------------------------------------------------------------

/**
 * Discover all bundled workflow definitions, validate them, and register valid
 * ones into a new WorkflowRegistry.
 *
 * Duplicate policy: first-seen wins (insertion order of the manifest export).
 */
export function discoverStartupWorkflowsSync(): DiscoveryResult {
  return discoverBundledManifest();
}

function discoverBundledManifest(): DiscoveryResult {
  const manifest = bundledManifest as Record<string, unknown>;
  const diagnostics: DiscoveryDiagnostic[] = [];
  const sources: DiscoverySource[] = [];
  let registry = createRegistry();

  const candidates = Object.entries(manifest).map(([exportKey, value]) => ({
    value,
    exportKey,
    kind: "bundled" as DiscoveryKind,
  }));

  registry = applyBatch(candidates, registry, sources, diagnostics);

  return { registry, sources, errors: diagnostics };
}

// ---------------------------------------------------------------------------
// Re-export types needed by callers (avoids them importing from registry.ts)
// ---------------------------------------------------------------------------
export type { WorkflowRegistry };
