import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti/static";
import { getExtensionTranspileCacheDir, isBunBinary, isBundledBuild } from "../../config.ts";
import { moduleDirFromMetaUrl } from "../../utils/split-launcher.ts";
import { resolutionBaseUrl } from "../../utils/module-require.ts";
import { resolvePath } from "../../utils/paths.ts";
import type { ExtensionFactory } from "./types.ts";

const require = createRequire(import.meta.url);
let _virtualModules: Record<string, object> | null = null;
let _virtualModulesPromise: Promise<Record<string, object>> | null = null;

async function loadVirtualModules(): Promise<Record<string, object>> {
  const [typebox, typeboxCompile, typeboxValue, piAgentCore, piTui, piAi, piAiOauth, piCodingAgent] = await Promise.all([
    import("typebox"),
    import("typebox/compile"),
    import("typebox/value"),
    import("@earendil-works/pi-agent-core"),
    import("@earendil-works/pi-tui"),
    // pi 0.80.2: the old global pi-ai API moved off the root entrypoint onto
    // `/compat` (a strict superset). Extensions still `import ... from
    // "@earendil-works/pi-ai"`, so we load the compat module here and key it
    // under the root specifier below to keep every extension working unchanged.
    import("@earendil-works/pi-ai/compat"),
    import("@earendil-works/pi-ai/oauth"),
    // NOTE: This import works because loader.ts exports are NOT re-exported from index.ts,
    // avoiding a circular dependency while preserving the package-name extension import path.
    import("../../index.ts"),
  ]);

  return {
    typebox,
    "typebox/compile": typeboxCompile,
    "typebox/value": typeboxValue,
    "@sinclair/typebox": typebox,
    "@sinclair/typebox/compile": typeboxCompile,
    "@sinclair/typebox/value": typeboxValue,
    "@earendil-works/pi-agent-core": piAgentCore,
    "@earendil-works/pi-tui": piTui,
    "@earendil-works/pi-ai": piAi,
    "@earendil-works/pi-ai/compat": piAi,
    "@earendil-works/pi-ai/oauth": piAiOauth,
    "@bastani/atomic": piCodingAgent,
    "@mariozechner/pi-agent-core": piAgentCore,
    "@mariozechner/pi-tui": piTui,
    "@mariozechner/pi-ai": piAi,
    "@mariozechner/pi-ai/compat": piAi,
    "@mariozechner/pi-ai/oauth": piAiOauth,
  };
}

/** Modules available to extensions via virtualModules (for compiled Bun binary). */
async function getVirtualModules(): Promise<Record<string, object>> {
  if (_virtualModules) return _virtualModules;
  _virtualModulesPromise ??= loadVirtualModules().then(
    (virtualModules) => {
      _virtualModules = virtualModules;
      return virtualModules;
    },
    (error: Error) => {
      _virtualModulesPromise = null;
      throw error;
    },
  );
  return _virtualModulesPromise;
}
let _aliases: Record<string, string> | null = null;
let _transpileCacheDir: string | null = null;

/**
 * Persistent on-disk cache for jiti-transpiled extension modules.
 * jiti keys cache entries by source-content hash, so entries self-invalidate
 * when extension sources change; stale sibling version dirs are pruned
 * in the background.
 */
function getTranspileCacheDir(): string {
  if (_transpileCacheDir) return _transpileCacheDir;
  _transpileCacheDir = getExtensionTranspileCacheDir();
  pruneStaleTranspileCaches(_transpileCacheDir);
  return _transpileCacheDir;
}

function pruneStaleTranspileCaches(currentDir: string): void {
  const parent = path.dirname(currentDir);
  const keep = path.basename(currentDir);
  void fs.promises
    .readdir(parent)
    .then((entries) =>
      Promise.all(
        entries
          .filter((entry) => entry !== keep)
          .map((entry) => fs.promises.rm(path.join(parent, entry), { recursive: true, force: true })),
      ),
    )
    .catch(() => {});
}

let extensionCacheCwd: string | undefined;
let extensionCacheGeneration = 0;
const extensionCache = new Map<string, ExtensionFactory>();

export interface ExtensionCacheToken {
  cwd: string;
  generation: number;
}

export function clearExtensionCache(): void {
  extensionCache.clear();
  extensionCacheCwd = undefined;
  extensionCacheGeneration++;
}

export function useExtensionCacheCwd(cwd: string): ExtensionCacheToken {
  const resolvedCwd = resolvePath(cwd);
  if (extensionCacheCwd !== undefined && extensionCacheCwd !== resolvedCwd) {
    clearExtensionCache();
  }
  extensionCacheCwd = resolvedCwd;
  return { cwd: resolvedCwd, generation: extensionCacheGeneration };
}

function isCurrentCacheToken(cacheToken: ExtensionCacheToken | undefined): cacheToken is ExtensionCacheToken {
  return (
    cacheToken !== undefined &&
    extensionCacheCwd === cacheToken.cwd &&
    extensionCacheGeneration === cacheToken.generation
  );
}

function extensionImportSpecifier(extensionPath: string, cacheToken: ExtensionCacheToken | undefined): string {
  const url = pathToFileURL(extensionPath);
  const cacheKey = cacheToken ? `${cacheToken.generation}:${cacheToken.cwd}` : `${Date.now()}:${Math.random()}`;
  url.searchParams.set("atomicExtensionCache", cacheKey);
  return url.href;
}

/**
 * Locate an installed package's root directory without consulting its
 * "exports" map: require.resolve("<pkg>/package.json") throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED under Node for packages that do not export
 * "./package.json" (pi-ai does not), and import.meta.resolve() cannot be
 * used because its mere presence silently disables bytecode generation for
 * the compiled binary (CJS bundle). Scanning require.resolve.paths() walks
 * the same node_modules chain Node would, without exports-map encapsulation.
 */
function findPackageRoot(packageName: string, searchPaths?: string[]): string {
  for (const base of searchPaths ?? require.resolve.paths(packageName) ?? []) {
    const candidate = path.join(base, packageName);
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      return candidate;
    }
  }
  throw new Error(`Cannot locate package directory for "${packageName}"`);
}
function currentModuleDir(): string {
  return moduleDirFromMetaUrl(import.meta.url, "dist", "core", "extensions");
}


/**
 * Get aliases for jiti (used in Node.js/development mode).
 * In Bun binary mode, virtualModules is used instead.
 */
function getAliases(): Record<string, string> {
  if (_aliases) return _aliases;

  const __dirname = currentModuleDir();
  const packageIndex = path.resolve(__dirname, "../..", "index.js");

  const typeboxEntry = require.resolve("typebox");
  const typeboxCompileEntry = require.resolve("typebox/compile");
  const typeboxValueEntry = require.resolve("typebox/value");

  const packagesRoot = path.resolve(__dirname, "../../../../");
  const resolveWorkspaceOrImport = (workspaceRelativePath: string, packageName: string): string => {
    const workspacePath = path.join(packagesRoot, workspaceRelativePath);
    if (fs.existsSync(workspacePath)) {
      return workspacePath;
    }
    const packageRoot = findPackageRoot(packageName);
    const entryRelativePath = workspaceRelativePath.split("/").slice(1).join("/");
    return path.join(packageRoot, entryRelativePath);
  };

  const piCodingAgentEntry = packageIndex;
  const piAgentCoreEntry = resolveWorkspaceOrImport("agent/dist/index.js", "@earendil-works/pi-agent-core");
  const piTuiEntry = resolveWorkspaceOrImport("tui/dist/index.js", "@earendil-works/pi-tui");
  // The workspace path mirrors pi-ai 0.80.x's built dist layout. If an
  // upstream layout change moves these files, this join needs updating to
  // match the package's real dist paths.
  const piAiEntry = resolveWorkspaceOrImport("ai/dist/compat.js", "@earendil-works/pi-ai");
  const piAiOauthEntry = resolveWorkspaceOrImport("ai/dist/oauth.js", "@earendil-works/pi-ai");

  _aliases = {
    "@bastani/atomic": piCodingAgentEntry,
    "@earendil-works/pi-coding-agent": piCodingAgentEntry,
    "@earendil-works/pi-agent-core": piAgentCoreEntry,
    "@earendil-works/pi-tui": piTuiEntry,
    "@earendil-works/pi-ai": piAiEntry,
    "@earendil-works/pi-ai/compat": piAiEntry,
    "@earendil-works/pi-ai/oauth": piAiOauthEntry,
    "@mariozechner/pi-agent-core": piAgentCoreEntry,
    "@mariozechner/pi-tui": piTuiEntry,
    "@mariozechner/pi-ai": piAiEntry,
    "@mariozechner/pi-ai/compat": piAiEntry,
    "@mariozechner/pi-ai/oauth": piAiOauthEntry,
    typebox: typeboxEntry,
    "typebox/compile": typeboxCompileEntry,
    "typebox/value": typeboxValueEntry,
    "@sinclair/typebox": typeboxEntry,
    "@sinclair/typebox/compile": typeboxCompileEntry,
    "@sinclair/typebox/value": typeboxValueEntry,
  };

  return _aliases;
}

/** Internal hooks for extension-loader alias regression tests. */
export const extensionLoaderTestHooks = {
  loadVirtualModules,
  getAliases,
  findPackageRoot,
};

/**
 * Extension paths already evaluated via native import() in this process. Bun on
 * Windows ignores the cache-busting query on file URLs, so re-loads of these
 * paths (e.g. /reload) must go through jiti's transformed-import path to get a
 * fresh module evaluation.
 */
const nativelyImportedPaths = new Set<string>();

export async function loadExtensionModule(
  extensionPath: string,
  cacheToken?: ExtensionCacheToken,
): Promise<ExtensionFactory | undefined> {
  if (isCurrentCacheToken(cacheToken)) {
    const cachedFactory = extensionCache.get(extensionPath);
    if (cachedFactory) return cachedFactory;
  }

  const isWindows = process.platform === "win32";
  // Single-file builds (compiled binary or dev bundle) cannot alias host
  // package specifiers to files on disk: extensions must share the live
  // module instances baked into the build, so virtualModules is used instead
  // (which requires jiti's transformed-import path).
  const isSingleFileBuild = isBunBinary || isBundledBuild;
  // Windows first-load fast path: native import() (jiti's default tryNative)
  // skips per-launch transpilation of the extension module graph. Re-loads of
  // the same path fall back to transformed imports for fresh evaluation.
  const forceTransformedImports = isSingleFileBuild || (isWindows && nativelyImportedPaths.has(extensionPath));
  const jiti = createJiti(resolutionBaseUrl(import.meta.url), {
    moduleCache: false,
    ...(forceTransformedImports
      ? { fsCache: getTranspileCacheDir(), tryNative: false }
      : isWindows
        ? { fsCache: getTranspileCacheDir() }
        : {}),
    ...(isSingleFileBuild ? { virtualModules: await getVirtualModules() } : { alias: getAliases() }),
  });
  const module = await jiti.import(extensionImportSpecifier(extensionPath, cacheToken), { default: true });
  if (isWindows && !forceTransformedImports) {
    nativelyImportedPaths.add(extensionPath);
  }
  const factory = module as ExtensionFactory;
  if (typeof factory !== "function") return undefined;
  if (isCurrentCacheToken(cacheToken)) {
    extensionCache.set(extensionPath, factory);
  }
  return factory;
}
