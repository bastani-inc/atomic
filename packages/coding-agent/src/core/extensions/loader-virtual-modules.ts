import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as _bundledPiAgentCore from "@earendil-works/pi-agent-core";
import * as _bundledPiAi from "@earendil-works/pi-ai";
import * as _bundledPiAiOauth from "@earendil-works/pi-ai/oauth";
import * as _bundledPiTui from "@earendil-works/pi-tui";
import { createJiti } from "jiti/static";
import * as _bundledTypebox from "typebox";
import * as _bundledTypeboxCompile from "typebox/compile";
import * as _bundledTypeboxValue from "typebox/value";
import { isBunBinary } from "../../config.ts";
import { resolvePath } from "../../utils/paths.ts";
// NOTE: This import works because loader.ts exports are NOT re-exported from index.ts,
// avoiding a circular dependency. Extensions can import from the Atomic package
// name (or upstream-compatible pi package names).
import * as _bundledPiCodingAgent from "../../index.ts";
import type { ExtensionFactory } from "./types.ts";

/** Modules available to extensions via virtualModules (for compiled Bun binary) */
const VIRTUAL_MODULES: Record<string, unknown> = {
  typebox: _bundledTypebox,
  "typebox/compile": _bundledTypeboxCompile,
  "typebox/value": _bundledTypeboxValue,
  "@sinclair/typebox": _bundledTypebox,
  "@sinclair/typebox/compile": _bundledTypeboxCompile,
  "@sinclair/typebox/value": _bundledTypeboxValue,
  "@earendil-works/pi-agent-core": _bundledPiAgentCore,
  "@earendil-works/pi-tui": _bundledPiTui,
  "@earendil-works/pi-ai": _bundledPiAi,
  "@earendil-works/pi-ai/oauth": _bundledPiAiOauth,
  "@bastani/atomic": _bundledPiCodingAgent,
  "@mariozechner/pi-agent-core": _bundledPiAgentCore,
  "@mariozechner/pi-tui": _bundledPiTui,
  "@mariozechner/pi-ai": _bundledPiAi,
  "@mariozechner/pi-ai/oauth": _bundledPiAiOauth,
};

const require = createRequire(import.meta.url);
let _aliases: Record<string, string> | null = null;

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

/**
 * Get aliases for jiti (used in Node.js/development mode).
 * In Bun binary mode, virtualModules is used instead.
 */
function getAliases(): Record<string, string> {
  if (_aliases) return _aliases;

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const packageIndex = path.resolve(__dirname, "../..", "index.js");

  const typeboxEntry = require.resolve("typebox");
  const typeboxCompileEntry = require.resolve("typebox/compile");
  const typeboxValueEntry = require.resolve("typebox/value");

  const packagesRoot = path.resolve(__dirname, "../../../../");
  const resolveWorkspaceOrImport = (workspaceRelativePath: string, specifier: string): string => {
    const workspacePath = path.join(packagesRoot, workspaceRelativePath);
    if (fs.existsSync(workspacePath)) {
      return workspacePath;
    }
    return fileURLToPath(import.meta.resolve(specifier));
  };

  const piCodingAgentEntry = packageIndex;
  const piAgentCoreEntry = resolveWorkspaceOrImport("agent/dist/index.js", "@earendil-works/pi-agent-core");
  const piTuiEntry = resolveWorkspaceOrImport("tui/dist/index.js", "@earendil-works/pi-tui");
  const piAiEntry = resolveWorkspaceOrImport("ai/dist/index.js", "@earendil-works/pi-ai");
  const piAiOauthEntry = resolveWorkspaceOrImport("ai/dist/oauth.js", "@earendil-works/pi-ai/oauth");

  _aliases = {
    "@bastani/atomic": piCodingAgentEntry,
    "@earendil-works/pi-coding-agent": piCodingAgentEntry,
    "@earendil-works/pi-agent-core": piAgentCoreEntry,
    "@earendil-works/pi-tui": piTuiEntry,
    "@earendil-works/pi-ai": piAiEntry,
    "@earendil-works/pi-ai/oauth": piAiOauthEntry,
    "@mariozechner/pi-agent-core": piAgentCoreEntry,
    "@mariozechner/pi-tui": piTuiEntry,
    "@mariozechner/pi-ai": piAiEntry,
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

export async function loadExtensionModule(
  extensionPath: string,
  cacheToken?: ExtensionCacheToken,
): Promise<ExtensionFactory | undefined> {
  if (isCurrentCacheToken(cacheToken)) {
    const cachedFactory = extensionCache.get(extensionPath);
    if (cachedFactory) return cachedFactory;
  }

  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    ...(isBunBinary ? { virtualModules: VIRTUAL_MODULES, tryNative: false } : { alias: getAliases() }),
  });

  const module = await jiti.import(extensionPath, { default: true });
  const factory = module as ExtensionFactory;
  if (typeof factory !== "function") return undefined;
  if (isCurrentCacheToken(cacheToken)) {
    extensionCache.set(extensionPath, factory);
  }
  return factory;
}
