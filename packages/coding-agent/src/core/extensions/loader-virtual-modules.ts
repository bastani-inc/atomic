import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti/static";
import { getExtensionTranspileCacheDir, isBunBinary, isBundledBuild } from "../../config.js";
import { resolutionBaseUrl } from "../../utils/module-require.ts";
import { resolvePath } from "../../utils/paths.ts";
import { moduleDirFromMetaUrl } from "../../utils/split-launcher.ts";
import { installHostModuleBridge } from "./host-module-bridge.ts";
import { getVirtualModules, loadVirtualModules } from "./loader-host-modules.js";
import { isNativeBuiltinExtensionPath } from "./native-builtin-entries.ts";
import type { ExtensionFactory } from "./types.ts";

export { getVirtualModules } from "./loader-host-modules.js";

const require = createRequire(import.meta.url);
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
	fs.mkdirSync(_transpileCacheDir, { recursive: true });
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

/**
 * Per-extension-path record of the complete file graph a transformed (jiti)
 * evaluation read, mapping each absolute file path to the SHA256 hex digest of
 * its content at evaluation time. Persisted under the versioned transpile
 * cache directory so pruneStaleTranspileCaches handles version cleanup.
 */
export interface ExtensionGraphManifest {
	version: 1;
	extensionPath: string;
	files: Record<string, string>;
}

const GRAPH_MANIFEST_VERSION = 1;
const GRAPH_MANIFEST_DIR_NAME = "graph-manifests";

const graphManifestFileExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx", ".json"]);

function graphManifestDir(): string {
	return path.join(getTranspileCacheDir(), GRAPH_MANIFEST_DIR_NAME);
}

function graphManifestPath(extensionPath: string): string {
	const key = crypto.createHash("sha256").update(extensionPath).digest("hex").slice(0, 32);
	return path.join(graphManifestDir(), `${key}.json`);
}

function sha256Hex(content: string | NodeJS.ArrayBufferView): string {
	return crypto.createHash("sha256").update(content).digest("hex");
}

// jiti's CJS bundle reads every module source in the require graph through
// fs.readFileSync (even on fsCache hits, since the cache key is a hash of the
// source), so observing readFileSync while a transformed import is in flight
// sees the complete transitive graph. The observer records into every active
// recorder; unrelated reads that interleave only over-record, which at worst
// forces a redundant re-evaluation later — never a stale one.
const fsExports = require("node:fs") as typeof fs;
const activeGraphRecorders = new Set<Map<string, string>>();
let observedReadFileSync: typeof fs.readFileSync | null = null;

function recordObservedRead(target: Parameters<typeof fs.readFileSync>[0], content: string | Buffer): void {
	if (typeof target !== "string" || !path.isAbsolute(target)) return;
	if (!graphManifestFileExtensions.has(path.extname(target).toLowerCase())) return;
	const normalizedTarget = path.normalize(target);
	const cachePrefix = path.normalize(getTranspileCacheDir()) + path.sep;
	if (normalizedTarget.toLowerCase().startsWith(cachePrefix.toLowerCase())) return;
	const hash = sha256Hex(content);
	for (const recorder of activeGraphRecorders) {
		recorder.set(normalizedTarget, hash);
	}
}

function installReadFileSyncObserver(): void {
	if (observedReadFileSync) return;
	const original = fsExports.readFileSync;
	observedReadFileSync = original;
	const wrapped = ((...args: Parameters<typeof fs.readFileSync>) => {
		const content = original(...args);
		recordObservedRead(args[0], content);
		return content;
	}) as typeof fs.readFileSync;
	fsExports.readFileSync = wrapped;
}

function uninstallReadFileSyncObserver(): void {
	if (!observedReadFileSync || activeGraphRecorders.size > 0) return;
	fsExports.readFileSync = observedReadFileSync;
	observedReadFileSync = null;
}

function writeGraphManifest(manifest: ExtensionGraphManifest): void {
	const manifestFile = graphManifestPath(manifest.extensionPath);
	let tempFile: string | undefined;
	try {
		fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
		tempFile = `${manifestFile}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
		fs.writeFileSync(tempFile, JSON.stringify(manifest));
		fs.renameSync(tempFile, manifestFile);
	} catch {
		// Manifest persistence is best-effort: a missing manifest only means the
		// next reload cannot prove the graph unchanged and re-evaluates. A failed
		// replacement must not leave an older manifest behind describing a graph
		// that no longer matches this evaluation, so invalidate the destination
		// first, independently of removing the temporary file.
		try {
			fs.rmSync(manifestFile, { force: true });
		} catch {
			// A leftover stale manifest cannot be reused without also matching
			// the in-memory manifest of the same evaluation, and readers
			// tolerate missing or corrupt files.
		}
		try {
			if (tempFile) fs.rmSync(tempFile, { force: true });
		} catch {
			// Temporary files carry a unique suffix and are never read back.
		}
	}
}

function isStringRecord(value: unknown): value is Record<string, string> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	return Object.values(value).every((entry) => typeof entry === "string");
}

export function readExtensionGraphManifest(extensionPath: string): ExtensionGraphManifest | undefined {
	try {
		const parsed = JSON.parse(
			fs.readFileSync(graphManifestPath(extensionPath), "utf-8"),
		) as Partial<ExtensionGraphManifest>;
		if (parsed.version !== GRAPH_MANIFEST_VERSION) return undefined;
		if (parsed.extensionPath !== extensionPath) return undefined;
		if (!isStringRecord(parsed.files)) return undefined;
		return { version: GRAPH_MANIFEST_VERSION, extensionPath, files: parsed.files };
	} catch {
		return undefined;
	}
}

async function recordExtensionGraph<T>(
	extensionPath: string,
	load: () => Promise<T>,
): Promise<{ result: T; manifest: ExtensionGraphManifest }> {
	const files = new Map<string, string>();
	activeGraphRecorders.add(files);
	installReadFileSyncObserver();
	let result: T;
	try {
		result = await load();
	} finally {
		activeGraphRecorders.delete(files);
		uninstallReadFileSyncObserver();
	}
	const manifest: ExtensionGraphManifest = {
		version: GRAPH_MANIFEST_VERSION,
		extensionPath,
		files: Object.fromEntries([...files.entries()].sort(([a], [b]) => a.localeCompare(b))),
	};
	writeGraphManifest(manifest);
	return { result, manifest };
}

/**
 * Factories from transformed evaluations, retained across extension cache
 * generation bumps and paired with the graph manifest recorded by the
 * evaluation that produced them. A retained factory is reused on a reload only
 * when the persisted manifest still equals the paired one and every file in it
 * rehashes to its recorded digest; any doubt (missing or corrupt manifest,
 * missing file, hash mismatch, changed graph shape) falls back to a fresh
 * transformed re-evaluation, which re-records the manifest.
 */
const retainedTransformedLoads = new Map<string, { factory: ExtensionFactory; manifest: ExtensionGraphManifest }>();

function manifestFilesEqual(a: Record<string, string>, b: Record<string, string>): boolean {
	const aEntries = Object.entries(a);
	if (aEntries.length !== Object.keys(b).length) return false;
	return aEntries.every(([filePath, hash]) => b[filePath] === hash);
}

function graphUnchangedSince(manifest: ExtensionGraphManifest): boolean {
	const stored = readExtensionGraphManifest(manifest.extensionPath);
	if (!stored || !manifestFilesEqual(stored.files, manifest.files)) return false;
	const entries = Object.entries(manifest.files);
	if (entries.length === 0) return false;
	for (const [filePath, hash] of entries) {
		try {
			if (sha256Hex(fs.readFileSync(filePath)) !== hash) return false;
		} catch {
			return false;
		}
	}
	return true;
}

/**
 * A factory can defer loading local code until it is invoked (e.g. a
 * `require()` inside the factory body). Those reads are invisible to the
 * import-time recording, so retained factories are wrapped to record reads
 * that happen while the factory executes and merge them into the retained and
 * persisted manifest — editing a deferred dependency then invalidates reuse
 * like any other graph file.
 */
function withDeferredGraphRecording(extensionPath: string, factory: ExtensionFactory): ExtensionFactory {
	return (pi) => {
		const files = new Map<string, string>();
		activeGraphRecorders.add(files);
		installReadFileSyncObserver();
		const finish = () => {
			activeGraphRecorders.delete(files);
			uninstallReadFileSyncObserver();
			if (files.size > 0) mergeDeferredGraphReads(extensionPath, files);
		};
		try {
			const result = factory(pi);
			if (
				result !== null &&
				(typeof result === "object" || typeof result === "function") &&
				typeof (result as PromiseLike<void>).then === "function"
			) {
				return Promise.resolve(result).finally(finish);
			}
			finish();
			return result;
		} catch (error) {
			finish();
			throw error;
		}
	};
}

function mergeDeferredGraphReads(extensionPath: string, files: Map<string, string>): void {
	const retained = retainedTransformedLoads.get(extensionPath);
	if (!retained) return;
	let changed = false;
	for (const [filePath, hash] of files) {
		if (retained.manifest.files[filePath] !== hash) {
			retained.manifest.files[filePath] = hash;
			changed = true;
		}
	}
	if (changed) writeGraphManifest(retained.manifest);
}

let extensionCacheCwd: string | undefined;
let extensionCacheGeneration = 0;
const extensionCache = new Map<string, ExtensionFactory>();

// Installed builtin bundles are immutable within a running binary. Keep their
// evaluated factories outside the generation-scoped editable-extension cache.
const nativeBuiltinFactories = new Map<string, ExtensionFactory>();
const nativeBuiltinLoads = new Map<string, Promise<ExtensionFactory | undefined>>();

async function loadNativeBuiltinExtensionModule(
	extensionPath: string,
	cacheToken: ExtensionCacheToken | undefined,
): Promise<ExtensionFactory | undefined> {
	let factory = nativeBuiltinFactories.get(extensionPath);
	if (!factory) {
		let pending = nativeBuiltinLoads.get(extensionPath);
		if (!pending) {
			pending = (async () => {
				await installHostModuleBridge();
				const module = (await import(pathToFileURL(extensionPath).href)) as { default?: unknown };
				if (typeof module.default !== "function") return undefined;
				const loadedFactory = module.default as ExtensionFactory;
				nativeBuiltinFactories.set(extensionPath, loadedFactory);
				return loadedFactory;
			})();
			nativeBuiltinLoads.set(extensionPath, pending);
		}
		try {
			factory = await pending;
		} finally {
			nativeBuiltinLoads.delete(extensionPath);
		}
	}
	if (factory && isCurrentCacheToken(cacheToken)) {
		extensionCache.set(extensionPath, factory);
	}
	return factory;
}

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
	const piTuiLayoutEntry = resolveWorkspaceOrImport("tui/dist/layout.js", "@earendil-works/pi-tui");
	// The workspace path mirrors pi-ai 0.80.x's built dist layout. If an
	// upstream layout change moves these files, this join needs updating to
	// match the package's real dist paths.
	const piAiEntry = resolveWorkspaceOrImport("ai/dist/compat.js", "@bastani/pi-ai");
	const piAiCodexResponsesEntry = resolveWorkspaceOrImport("ai/dist/api/openai-codex-responses.js", "@bastani/pi-ai");
	const piAiOauthEntry = resolveWorkspaceOrImport("ai/dist/oauth.js", "@bastani/pi-ai");
	const piAiProvidersEntry = resolveWorkspaceOrImport("ai/dist/providers/all.js", "@bastani/pi-ai");
	const piAiCopilotEnvEntry = resolveWorkspaceOrImport("ai/dist/providers/github-copilot-env.js", "@bastani/pi-ai");
	const piAiGatewayBindingEntry = resolveWorkspaceOrImport(
		"ai/dist/api/cloudflare-gateway-binding.js",
		"@bastani/pi-ai",
	);

	_aliases = {
		"@bastani/atomic": piCodingAgentEntry,
		"@earendil-works/pi-coding-agent": piCodingAgentEntry,
		"@earendil-works/pi-agent-core": piAgentCoreEntry,
		"@earendil-works/pi-tui/dist/layout.js": piTuiLayoutEntry,
		"@earendil-works/pi-tui": piTuiEntry,
		"@bastani/pi-ai/api/openai-codex-responses": piAiCodexResponsesEntry,
		"@bastani/pi-ai/oauth": piAiOauthEntry,
		"@bastani/pi-ai/providers/all": piAiProvidersEntry,
		"@bastani/pi-ai/providers/github-copilot-env": piAiCopilotEnvEntry,
		"@bastani/pi-ai/compat": piAiEntry,
		"@bastani/pi-ai/api/cloudflare-gateway-binding": piAiGatewayBindingEntry,
		"@bastani/pi-ai": piAiEntry,
		"@earendil-works/pi-ai/api/openai-codex-responses": piAiCodexResponsesEntry,
		"@earendil-works/pi-ai/oauth": piAiOauthEntry,
		"@earendil-works/pi-ai/providers/all": piAiProvidersEntry,
		"@earendil-works/pi-ai/compat": piAiEntry,
		"@earendil-works/pi-ai/api/cloudflare-gateway-binding": piAiGatewayBindingEntry,
		"@earendil-works/pi-ai": piAiEntry,
		"@mariozechner/pi-agent-core": piAgentCoreEntry,
		"@mariozechner/pi-tui/dist/layout.js": piTuiLayoutEntry,
		"@mariozechner/pi-tui": piTuiEntry,
		"@mariozechner/pi-ai/oauth": piAiOauthEntry,
		"@mariozechner/pi-ai/providers/all": piAiProvidersEntry,
		"@mariozechner/pi-ai/compat": piAiEntry,
		"@mariozechner/pi-ai/api/cloudflare-gateway-binding": piAiGatewayBindingEntry,
		"@mariozechner/pi-ai": piAiEntry,
		typebox: typeboxEntry,
		"typebox/compile": typeboxCompileEntry,
		"typebox/value": typeboxValueEntry,
		"@sinclair/typebox": typeboxEntry,
		"@sinclair/typebox/compile": typeboxCompileEntry,
		"@sinclair/typebox/value": typeboxValueEntry,
	};

	return _aliases;
}

export const extensionLoaderTestHooks = {
	loadVirtualModules,
	getAliases,
	findPackageRoot,
	getTranspileCacheDir,
	graphManifestPath,
	readExtensionGraphManifest,
	loadExtensionModuleTransformed: (extensionPath: string, cacheToken?: ExtensionCacheToken) =>
		importExtensionModule(extensionPath, cacheToken, true),
	loadTransformedExtensionModule: (extensionPath: string, cacheToken?: ExtensionCacheToken) =>
		loadTransformedExtensionModule(extensionPath, cacheToken),
	loadNativeBuiltinExtensionModule,
	hasNativeBuiltinFactory: (extensionPath: string): boolean => nativeBuiltinFactories.has(extensionPath),
};

/**
 * Extension paths already evaluated via native import() in this process. Bun on
 * Windows ignores the cache-busting query on file URLs, so re-loads of these
 * paths (e.g. /reload) must go through jiti's transformed-import path to get a
 * fresh module evaluation.
 */
const nativelyImportedPaths = new Set<string>();

async function importExtensionModule(
	extensionPath: string,
	cacheToken: ExtensionCacheToken | undefined,
	forceTransformedImports: boolean,
): Promise<ExtensionFactory | undefined> {
	const isWindows = process.platform === "win32";
	const isSingleFileBuild = isBunBinary || isBundledBuild;
	const jiti = createJiti(resolutionBaseUrl(import.meta.url), {
		moduleCache: false,
		...(forceTransformedImports
			? { fsCache: getTranspileCacheDir(), tryNative: false }
			: isWindows
				? { fsCache: getTranspileCacheDir() }
				: {}),
		...(isSingleFileBuild ? { virtualModules: await getVirtualModules() } : { alias: getAliases() }),
	});
	const specifier = extensionImportSpecifier(extensionPath, cacheToken);
	// Transformed evaluations are the loads whose repeat cost is the Windows
	// /reload regression, so they are also the loads whose file graph is
	// recorded into a content-hash manifest.
	let module: unknown;
	let recordedManifest: ExtensionGraphManifest | undefined;
	if (forceTransformedImports) {
		const recorded = await recordExtensionGraph(extensionPath, () => jiti.import(specifier, { default: true }));
		module = recorded.result;
		recordedManifest = recorded.manifest;
	} else {
		module = await jiti.import(specifier, { default: true });
	}
	if (isWindows && !forceTransformedImports) {
		nativelyImportedPaths.add(extensionPath);
	}
	let factory = module as ExtensionFactory;
	if (typeof factory !== "function") return undefined;
	if (recordedManifest) {
		factory = withDeferredGraphRecording(extensionPath, factory);
		retainedTransformedLoads.set(extensionPath, { factory, manifest: recordedManifest });
	}
	if (isCurrentCacheToken(cacheToken)) {
		extensionCache.set(extensionPath, factory);
	}
	return factory;
}

/**
 * Load an extension through jiti's transformed-import path, reusing the
 * previously evaluated factory when the recorded graph manifest proves the
 * entire transitive file graph is byte-identical. This lets the
 * unchanged-graph case survive the /reload generation bump instead of
 * re-evaluating hundreds of files; anything else re-evaluates as before.
 *
 * Note: when the graph is byte-identical, the previously evaluated module
 * instance (including any mutable module-scoped state it closed over) is
 * reused. An extension that requires clean module state on every reload must
 * change a file in its graph to force re-evaluation.
 */
async function loadTransformedExtensionModule(
	extensionPath: string,
	cacheToken: ExtensionCacheToken | undefined,
): Promise<ExtensionFactory | undefined> {
	const retained = retainedTransformedLoads.get(extensionPath);
	if (retained && graphUnchangedSince(retained.manifest)) {
		if (isCurrentCacheToken(cacheToken)) {
			extensionCache.set(extensionPath, retained.factory);
		}
		return retained.factory;
	}
	return importExtensionModule(extensionPath, cacheToken, true);
}

export async function loadExtensionModule(
	extensionPath: string,
	cacheToken?: ExtensionCacheToken,
): Promise<ExtensionFactory | undefined> {
	const isSingleFileBuild = isBunBinary || isBundledBuild;
	if (isSingleFileBuild && isNativeBuiltinExtensionPath(extensionPath)) {
		return loadNativeBuiltinExtensionModule(extensionPath, cacheToken);
	}

	if (isCurrentCacheToken(cacheToken)) {
		const cachedFactory = extensionCache.get(extensionPath);
		if (cachedFactory) return cachedFactory;
	}

	const isWindows = process.platform === "win32";
	// Single-file builds (compiled binary or dev bundle) cannot alias host
	// package specifiers to files on disk: extensions must share the live
	// module instances baked into the build, so virtualModules is used instead
	// (which requires jiti's transformed-import path).
	// Every editable path retains the existing jiti/virtualModules behavior.
	// Windows first-load fast path: native import() (jiti's default tryNative)
	// skips per-launch transpilation of the extension module graph. Re-loads of
	// the same path fall back to transformed imports for fresh evaluation.
	//
	// That fallback is not free. Measured on Windows CI, a transformed re-import
	// costs ~15 ms per module file in the extension's transitive graph, so a
	// reload of all five builtin packages (621 files) takes ~10.7 s cold and
	// ~2.5 s against a warm jiti fsCache, against ~40 ms on Linux and macOS. The
	// cost is correctness-driven and is paid interactively on every Windows
	// `/reload`; removing it needs a content-hash-keyed evaluation cache or a
	// narrower trigger, not a larger timeout.
	const forceTransformedImports = isSingleFileBuild || (isWindows && nativelyImportedPaths.has(extensionPath));
	if (forceTransformedImports) {
		return loadTransformedExtensionModule(extensionPath, cacheToken);
	}
	return importExtensionModule(extensionPath, cacheToken, false);
}
