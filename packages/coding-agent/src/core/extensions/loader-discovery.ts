import * as fs from "node:fs";
import * as path from "node:path";
import { APP_NAME, CONFIG_DIR_NAME, getAgentDir } from "../../config.ts";
import { resolvePath } from "../../utils/paths.ts";
import type { EventBus } from "../event-bus.ts";
import { loadExtensions } from "./loader-core.ts";
import type { LoadExtensionsResult } from "./types.ts";

interface PiManifest {
  extensions?: string[];
  themes?: string[];
  skills?: string[];
  prompts?: string[];
}

function manifestFromPackageJson(pkg: Record<string, unknown>): PiManifest | null {
  const appManifest = pkg[APP_NAME];
  if (appManifest && typeof appManifest === "object" && !Array.isArray(appManifest)) {
    return appManifest as PiManifest;
  }
  const legacyManifest = pkg.pi;
  if (legacyManifest && typeof legacyManifest === "object" && !Array.isArray(legacyManifest)) {
    return legacyManifest as PiManifest;
  }
  return null;
}

function readPiManifest(packageJsonPath: string): PiManifest | null {
  try {
    const content = fs.readFileSync(packageJsonPath, "utf-8");
    const pkg = JSON.parse(content) as Record<string, unknown>;
    return manifestFromPackageJson(pkg);
  } catch {
    return null;
  }
}

function isExtensionFile(name: string): boolean {
  return name.endsWith(".ts") || name.endsWith(".js");
}

/**
 * Resolve extension entry points from a directory.
 *
 * Checks for:
 * 1. package.json with "pi.extensions" field -> returns declared paths
 * 2. index.ts or index.js -> returns the index file
 *
 * Returns resolved paths or null if no entry points found.
 */
function resolveExtensionEntries(dir: string): string[] | null {
  const packageJsonPath = path.join(dir, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    const manifest = readPiManifest(packageJsonPath);
    if (manifest?.extensions?.length) {
      const entries: string[] = [];
      for (const extPath of manifest.extensions) {
        const resolvedExtPath = path.resolve(dir, extPath);
        if (fs.existsSync(resolvedExtPath)) {
          entries.push(resolvedExtPath);
        }
      }
      if (entries.length > 0) {
        return entries;
      }
    }
  }

  const indexTs = path.join(dir, "index.ts");
  const indexJs = path.join(dir, "index.js");
  if (fs.existsSync(indexTs)) {
    return [indexTs];
  }
  if (fs.existsSync(indexJs)) {
    return [indexJs];
  }

  return null;
}

/**
 * Discover extensions in a directory.
 *
 * Discovery rules:
 * 1. Direct files: `extensions/*.ts` or `*.js` → load
 * 2. Subdirectory with index: `extensions/* /index.ts` or `index.js` → load
 * 3. Subdirectory with package.json: `extensions/* /package.json` with "pi" field → load what it declares
 *
 * No recursion beyond one level. Complex packages must use package.json manifest.
 */
function discoverExtensionsInDir(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const discovered: string[] = [];

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);

      if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
        discovered.push(entryPath);
        continue;
      }

      if (entry.isDirectory() || entry.isSymbolicLink()) {
        const childEntries = resolveExtensionEntries(entryPath);
        if (childEntries) {
          discovered.push(...childEntries);
        }
      }
    }
  } catch {
    return [];
  }

  return discovered;
}

function addUniquePaths(target: string[], seen: Set<string>, pathsToAdd: string[]): void {
  for (const p of pathsToAdd) {
    const resolved = path.resolve(p);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      target.push(p);
    }
  }
}

/**
 * Discover and load extensions from standard locations.
 */
export async function discoverAndLoadExtensions(
  configuredPaths: string[],
  cwd: string,
  agentDir: string = getAgentDir(),
  eventBus?: EventBus,
): Promise<LoadExtensionsResult> {
  const resolvedCwd = resolvePath(cwd);
  const resolvedAgentDir = resolvePath(agentDir);
  const allPaths: string[] = [];
  const seen = new Set<string>();
  const addPaths = (pathsToAdd: string[]) => addUniquePaths(allPaths, seen, pathsToAdd);

  const localExtDir = path.join(resolvedCwd, CONFIG_DIR_NAME, "extensions");
  addPaths(discoverExtensionsInDir(localExtDir));

  const globalExtDir = path.join(resolvedAgentDir, "extensions");
  addPaths(discoverExtensionsInDir(globalExtDir));

  for (const configuredPath of configuredPaths) {
    const resolved = resolvePath(configuredPath, resolvedCwd, { normalizeUnicodeSpaces: true });
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      const entries = resolveExtensionEntries(resolved);
      if (entries) {
        addPaths(entries);
        continue;
      }
      addPaths(discoverExtensionsInDir(resolved));
      continue;
    }

    addPaths([resolved]);
  }

  return loadExtensions(allPaths, resolvedCwd, eventBus);
}
