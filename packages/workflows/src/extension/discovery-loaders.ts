import { readdir, stat } from "node:fs/promises";
import { extname, isAbsolute, join, resolve } from "node:path";
import type { DiscoveryDiagnostic, DiscoveryKind } from "./discovery.js";
import {
  collectWorkflowModuleCandidates,
  loadWorkflowModule,
} from "./workflow-module-loader.js";

export type WorkflowModuleCandidateRecord = {
  readonly value: unknown;
  readonly exportKey: string;
  readonly kind: DiscoveryKind;
  readonly filePath?: string;
  readonly configuredName?: string;
};

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

async function importWorkflowFile(
  filePath: string,
  kind: DiscoveryKind,
  diagnostics: DiscoveryDiagnostic[],
): Promise<WorkflowModuleCandidateRecord[]> {
  let mod: Record<string, unknown>;
  try {
    mod = loadWorkflowModule(filePath);
  } catch (err) {
    diagnostics.push({
      level: "error",
      code: "IMPORT_FAILED",
      message: `Failed to import "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
      source: filePath,
    });
    return [];
  }

  return collectWorkflowModuleCandidates(mod).map((candidate) => ({
    ...candidate,
    kind,
    filePath,
  }));
}

/** Load workflows from a scanned directory. */
export async function loadFromDir(
  dir: string,
  kind: DiscoveryKind,
  diagnostics: DiscoveryDiagnostic[],
): Promise<WorkflowModuleCandidateRecord[]> {
  const files = await scanWorkflowDir(dir);
  if (files === null) return [];

  const all: WorkflowModuleCandidateRecord[] = [];
  for (const filePath of files) {
    const candidates = await importWorkflowFile(filePath, kind, diagnostics);
    all.push(...candidates);
  }
  return all;
}

/** Load workflows from an explicit path list (from config). */
export async function loadFromPaths(
  pathsOrMap: string[] | Record<string, string>,
  kind: DiscoveryKind,
  baseCwd: string,
  diagnostics: DiscoveryDiagnostic[],
): Promise<WorkflowModuleCandidateRecord[]> {
  const all: WorkflowModuleCandidateRecord[] = [];

  const entries: Array<{ rawPath: string; configuredName?: string }> = Array.isArray(pathsOrMap)
    ? pathsOrMap.map((p) => ({ rawPath: p }))
    : Object.entries(pathsOrMap).map(([name, p]) => ({ rawPath: p, configuredName: name }));

  for (const { rawPath, configuredName } of entries) {
    const absPath = isAbsolute(rawPath) ? rawPath : resolve(baseCwd, rawPath);

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
