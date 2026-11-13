import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { createJiti } from "jiti";
import { getAgentDir, getExtensionTranspileCacheDir, isBunBinary, isBundledBuild } from "../../config.js";
import { resolutionBaseUrl } from "../../utils/module-require.ts";
import { canonicalizePath, pathsEqual, resolvePath } from "../../utils/paths.ts";
import { moduleDirFromMetaUrl } from "../../utils/split-launcher.ts";
import { installHostModuleBridge } from "./host-module-bridge.ts";
import { getVirtualModules, loadVirtualModules } from "./loader-host-modules.js";
import { isNativeBuiltinExtensionPath } from "./native-builtin-entries.ts";
import { createTypeScriptSourceSpecifierTransform } from "./ts-source-specifiers.js";
import type { ExtensionFactory } from "./types.ts";

export { getVirtualModules } from "./loader-host-modules.js";

const require = createRequire(import.meta.url);
let _aliases: Record<string, string> | null = null;
let createJitiPromise: Promise<typeof createJiti> | undefined;
type SourceSpecifierTransform = ReturnType<typeof createTypeScriptSourceSpecifierTransform>;
// Keyed by transpile cache directory; "" is the uncached transform for a load whose agent directory is gone.
const typeScriptSourceSpecifierTransforms = new Map<string, SourceSpecifierTransform>();
// Cache directories this process has created or found and pruned, one per agent directory.
const preparedTranspileCacheDirs = new Set<string>();

function getCreateJiti(): Promise<typeof createJiti> {
	createJitiPromise ??= (
		isBunBinary || isBundledBuild ? import("./jiti-static-loader.ts") : import("./jiti-loader.ts")
	).then((module) => module.createJiti);
	return createJitiPromise;
}

function getTypeScriptSourceSpecifierTransform(
	createJitiImpl: typeof createJiti,
	cacheDir: string | undefined,
): SourceSpecifierTransform {
	const key = cacheDir ?? "";
	let transform = typeScriptSourceSpecifierTransforms.get(key);
	if (!transform) {
		transform = createTypeScriptSourceSpecifierTransform(
			createJitiImpl,
			resolutionBaseUrl(import.meta.url),
			() => cacheDir,
		);
		typeScriptSourceSpecifierTransforms.set(key, transform);
	}
	return transform;
}

/** Creates `dir` one level at a time below `root`, never `root` itself, so a removed agent directory stays removed. */
function mkdirBelowExisting(root: string, dir: string): boolean {
	let current = root;
	for (const segment of path.relative(root, dir).split(path.sep)) {
		current = path.join(current, segment);
		try {
			fs.mkdirSync(current);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
		}
	}
	return true;
}

/**
 * Persistent on-disk cache for transpiled extension modules, under the agent
 * directory of this load: the session's `agentDir`, else the one in effect now.
 * Entries are keyed by source content and resolved TypeScript siblings, so they
 * self-invalidate when either changes; stale sibling version dirs are pruned in
 * the background once per cache directory. The first use of an agent directory
 * creates it as before. After that, a missing agent directory was removed: the
 * load runs uncached and the directory is not recreated (#4728).
 */
function resolveTranspileCacheDir(agentDir: string = getAgentDir()): string | undefined {
	const root = path.resolve(agentDir);
	const cacheDir = getExtensionTranspileCacheDir(root);
	if (preparedTranspileCacheDirs.has(cacheDir)) {
		return mkdirBelowExisting(root, cacheDir) ? cacheDir : undefined;
	}
	try {
		fs.mkdirSync(cacheDir, { recursive: true });
	} catch {
		return undefined;
	}
	preparedTranspileCacheDirs.add(cacheDir);
	pruneStaleTranspileCaches(cacheDir);
	return cacheDir;
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

function graphManifestPath(extensionPath: string, cacheDir: string): string {
	const key = crypto.createHash("sha256").update(extensionPath).digest("hex").slice(0, 32);
	return path.join(cacheDir, GRAPH_MANIFEST_DIR_NAME, `${key}.json`);
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

/** Files read by one evaluation; reads of its own transpile cache are not part of the graph. */
interface GraphRecorder {
	files: Map<string, string>;
	cachePrefix: string | undefined;
}

const activeGraphRecorders = new Set<GraphRecorder>();
let observedReadFileSync: typeof fs.readFileSync | null = null;

function createGraphRecorder(cacheDir: string | undefined): GraphRecorder {
	return {
		files: new Map(),
		cachePrefix: cacheDir === undefined ? undefined : (path.normalize(cacheDir) + path.sep).toLowerCase(),
	};
}

function recordObservedRead(target: Parameters<typeof fs.readFileSync>[0], content: string | Buffer): void {
	if (typeof target !== "string" || !path.isAbsolute(target)) return;
	if (!graphManifestFileExtensions.has(path.extname(target).toLowerCase())) return;
	const normalizedTarget = path.normalize(target);
	const comparableTarget = normalizedTarget.toLowerCase();
	let hash: string | undefined;
	for (const recorder of activeGraphRecorders) {
		if (recorder.cachePrefix && comparableTarget.startsWith(recorder.cachePrefix)) continue;
		hash ??= sha256Hex(content);
		recorder.files.set(normalizedTarget, hash);
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

function writeGraphManifest(manifest: ExtensionGraphManifest, cacheDir: string | undefined): void {
	if (cacheDir === undefined) return;
	const manifestFile = graphManifestPath(manifest.extensionPath, cacheDir);
	let tempFile: string | undefined;
	try {
		if (!mkdirBelowExisting(cacheDir, path.dirname(manifestFile))) throw new Error("transpile cache is gone");
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

/** Reads the graph manifest recorded under `agentDir`, which defaults to the agent directory in effect now. */
export function readExtensionGraphManifest(
	extensionPath: string,
	agentDir: string = getAgentDir(),
): ExtensionGraphManifest | undefined {
	return readGraphManifestIn(extensionPath, getExtensionTranspileCacheDir(path.resolve(agentDir)));
}

function readGraphManifestIn(extensionPath: string, cacheDir: string | undefined): ExtensionGraphManifest | undefined {
	if (cacheDir === undefined) return undefined;
	try {
		const parsed = JSON.parse(
			fs.readFileSync(graphManifestPath(extensionPath, cacheDir), "utf-8"),
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
	cacheDir: string | undefined,
	load: () => Promise<T>,
): Promise<{ result: T; manifest: ExtensionGraphManifest }> {
	const recorder = createGraphRecorder(cacheDir);
	activeGraphRecorders.add(recorder);
	installReadFileSyncObserver();
	let result: T;
	try {
		result = await load();
	} finally {
		activeGraphRecorders.delete(recorder);
		uninstallReadFileSyncObserver();
	}
	const manifest: ExtensionGraphManifest = {
		version: GRAPH_MANIFEST_VERSION,
		extensionPath,
		files: Object.fromEntries([...recorder.files.entries()].sort(([a], [b]) => a.localeCompare(b))),
	};
	writeGraphManifest(manifest, cacheDir);
	return { result, manifest };
}

/**
 * Factories from transformed evaluations, retained across extension cache
 * generation bumps and paired with the graph manifest recorded by the
 * evaluation that produced them. A retained factory is reused on a reload only
 * when the persisted manifest still equals the paired one and every file in it
 * rehashes to its recorded digest; any doubt (missing or corrupt manifest,
 * missing file, hash mismatch, changed graph shape) falls back to a fresh
 * transformed re-evaluation, which re-records the manifest. A factory is only
 * reused under the transpile cache directory (and so the agent directory) it
 * was evaluated with.
 */
interface RetainedTransformedLoad {
	factory: ExtensionFactory;
	manifest: ExtensionGraphManifest;
	cacheDir: string;
}

const retainedTransformedLoads = new Map<string, RetainedTransformedLoad>();

function manifestFilesEqual(a: Record<string, string>, b: Record<string, string>): boolean {
	const aEntries = Object.entries(a);
	if (aEntries.length !== Object.keys(b).length) return false;
	return aEntries.every(([filePath, hash]) => b[filePath] === hash);
}

function graphUnchangedSince(manifest: ExtensionGraphManifest, cacheDir: string): boolean {
	const stored = readGraphManifestIn(manifest.extensionPath, cacheDir);
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
function withDeferredGraphRecording(
	extensionPath: string,
	cacheDir: string,
	factory: ExtensionFactory,
): ExtensionFactory {
	return (pi) => {
		const recorder = createGraphRecorder(cacheDir);
		activeGraphRecorders.add(recorder);
		installReadFileSyncObserver();
		const finish = () => {
			activeGraphRecorders.delete(recorder);
			uninstallReadFileSyncObserver();
			if (recorder.files.size > 0) mergeDeferredGraphReads(extensionPath, cacheDir, recorder.files);
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

function mergeDeferredGraphReads(extensionPath: string, cacheDir: string, files: Map<string, string>): void {
	const retained = retainedTransformedLoads.get(extensionPath);
	if (!retained || retained.cacheDir !== cacheDir) return;
	let changed = false;
	for (const [filePath, hash] of files) {
		if (retained.manifest.files[filePath] !== hash) {
			retained.manifest.files[filePath] = hash;
			changed = true;
		}
	}
	if (changed) writeGraphManifest(retained.manifest, retained.cacheDir);
}

let extensionCacheCwd: string | undefined;
let extensionCacheAgentDir: string | undefined;
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
	agentDir: string;
	generation: number;
}

export function clearExtensionCache(): void {
	extensionCache.clear();
	extensionCacheCwd = undefined;
	extensionCacheAgentDir = undefined;
	extensionCacheGeneration++;
}

/**
 * Scope the in-memory extension cache to `cwd` and the agent directory of the
 * load (the session's `agentDir`, else the one in effect now). Changing either
 * starts a new generation, so a module evaluated under another agent directory
 * is never served from memory (#4728).
 */
export function useExtensionCacheCwd(cwd: string, agentDir: string = getAgentDir()): ExtensionCacheToken {
	const resolvedCwd = resolvePath(cwd);
	const resolvedAgentDir = resolvePath(agentDir);
	if (
		(extensionCacheCwd !== undefined && !pathsEqual(extensionCacheCwd, resolvedCwd)) ||
		(extensionCacheAgentDir !== undefined && !pathsEqual(extensionCacheAgentDir, resolvedAgentDir))
	) {
		clearExtensionCache();
	}
	extensionCacheCwd = resolvedCwd;
	extensionCacheAgentDir = resolvedAgentDir;
	return { cwd: resolvedCwd, agentDir: resolvedAgentDir, generation: extensionCacheGeneration };
}

function isCurrentCacheToken(cacheToken: ExtensionCacheToken | undefined): cacheToken is ExtensionCacheToken {
	return (
		cacheToken !== undefined &&
		extensionCacheCwd === cacheToken.cwd &&
		extensionCacheAgentDir === cacheToken.agentDir &&
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
	const piTuiLayoutNodeEntry = resolveWorkspaceOrImport("tui/dist/layout-node.js", "@earendil-works/pi-tui");
	// The workspace path mirrors pi-ai 0.80.x's built dist layout. If an
	// upstream layout change moves these files, this join needs updating to
	// match the package's real dist paths.
	const piAiEntry = resolveWorkspaceOrImport("ai/dist/compat.js", "@bastani/pi-ai");
	const piAiCodexResponsesEntry = resolveWorkspaceOrImport("ai/dist/api/openai-codex-responses.js", "@bastani/pi-ai");
	const piAiLlamaCppClassifyEntry = resolveWorkspaceOrImport(
		"ai/dist/api/llama-cpp-classify.lazy.js",
		"@bastani/pi-ai",
	);
	const piAiTypesafeSystemOneEntry = resolveWorkspaceOrImport(
		"ai/dist/api/typesafe-system-one.lazy.js",
		"@bastani/pi-ai",
	);
	const piAiOauthEntry = resolveWorkspaceOrImport("ai/dist/oauth.js", "@bastani/pi-ai");
	const piAiModelsEntry = resolveWorkspaceOrImport("ai/dist/models.js", "@bastani/pi-ai");
	const piAiProvidersEntry = resolveWorkspaceOrImport("ai/dist/providers/all.js", "@bastani/pi-ai");
	const piAiCopilotEnvEntry = resolveWorkspaceOrImport("ai/dist/providers/github-copilot-env.js", "@bastani/pi-ai");
	const piAiCopilotEntry = resolveWorkspaceOrImport("ai/dist/providers/github-copilot.js", "@bastani/pi-ai");
	const piAiOpenRouterEntry = resolveWorkspaceOrImport("ai/dist/providers/openrouter.js", "@bastani/pi-ai");
	const piAiProviderEnvEntry = resolveWorkspaceOrImport("ai/dist/utils/provider-env.js", "@bastani/pi-ai");
	const piAiRetryEntry = resolveWorkspaceOrImport("ai/dist/utils/retry.js", "@bastani/pi-ai");
	const piAiRequestAdmissionEntry = resolveWorkspaceOrImport("ai/dist/utils/request-admission.js", "@bastani/pi-ai");
	const piAiRetryHintsEntry = resolveWorkspaceOrImport("ai/dist/utils/retry-hints.js", "@bastani/pi-ai");
	const piAiCompatSchemaEntry = resolveWorkspaceOrImport("ai/dist/providers/compat-schema.js", "@bastani/pi-ai");
	const piAiModelSchemaEntry = resolveWorkspaceOrImport("ai/dist/providers/model-schema.js", "@bastani/pi-ai");
	const piAiOauthPageEntry = resolveWorkspaceOrImport("ai/dist/utils/oauth-page.js", "@bastani/pi-ai");
	const piAiGatewayBindingEntry = resolveWorkspaceOrImport(
		"ai/dist/api/cloudflare-gateway-binding.js",
		"@bastani/pi-ai",
	);
	// The Anthropic thinking guard replays assistant turns with pi-ai's own conversion (#4185).
	const piAiAnthropicAssistantContentEntry = resolveWorkspaceOrImport(
		"ai/dist/api/anthropic-assistant-content.js",
		"@bastani/pi-ai",
	);
	const piAiTransformMessagesEntry = resolveWorkspaceOrImport("ai/dist/api/transform-messages.js", "@bastani/pi-ai");

	_aliases = {
		"@bastani/atomic/storage": path.resolve(__dirname, "../storage/index.js"),
		"@bastani/atomic": piCodingAgentEntry,
		"@earendil-works/pi-coding-agent": piCodingAgentEntry,
		"@mariozechner/pi-coding-agent": piCodingAgentEntry,
		"@earendil-works/pi-agent-core": piAgentCoreEntry,
		"@earendil-works/pi-tui/dist/layout.js": piTuiLayoutEntry,
		"@earendil-works/pi-tui/dist/layout-node.js": piTuiLayoutNodeEntry,
		"@earendil-works/pi-tui": piTuiEntry,
		"@bastani/pi-ai/api/openai-codex-responses": piAiCodexResponsesEntry,
		"@bastani/pi-ai/api/llama-cpp-classify.lazy": piAiLlamaCppClassifyEntry,
		"@bastani/pi-ai/api/typesafe-system-one.lazy": piAiTypesafeSystemOneEntry,
		"@bastani/pi-ai/oauth": piAiOauthEntry,
		"@bastani/pi-ai/models": piAiModelsEntry,
		"@bastani/pi-ai/providers/all": piAiProvidersEntry,
		"@bastani/pi-ai/providers/github-copilot-env": piAiCopilotEnvEntry,
		"@bastani/pi-ai/providers/github-copilot": piAiCopilotEntry,
		"@bastani/pi-ai/providers/openrouter": piAiOpenRouterEntry,
		"@bastani/pi-ai/providers/compat-schema": piAiCompatSchemaEntry,
		"@bastani/pi-ai/providers/model-schema": piAiModelSchemaEntry,
		"@bastani/pi-ai/utils/provider-env": piAiProviderEnvEntry,
		"@bastani/pi-ai/utils/oauth-page": piAiOauthPageEntry,
		"@bastani/pi-ai/utils/request-admission": piAiRequestAdmissionEntry,
		"@bastani/pi-ai/utils/retry-hints": piAiRetryHintsEntry,
		"@bastani/pi-ai/utils/retry": piAiRetryEntry,
		"@bastani/pi-ai/compat": piAiEntry,
		"@bastani/pi-ai/api/cloudflare-gateway-binding": piAiGatewayBindingEntry,
		"@bastani/pi-ai/api/anthropic-assistant-content": piAiAnthropicAssistantContentEntry,
		"@bastani/pi-ai/api/transform-messages": piAiTransformMessagesEntry,
		"@bastani/pi-ai": piAiEntry,
		"@earendil-works/pi-ai/api/openai-codex-responses": piAiCodexResponsesEntry,
		"@earendil-works/pi-ai/oauth": piAiOauthEntry,
		"@earendil-works/pi-ai/models": piAiModelsEntry,
		"@earendil-works/pi-ai/providers/all": piAiProvidersEntry,
		"@earendil-works/pi-ai/compat": piAiEntry,
		"@earendil-works/pi-ai/api/cloudflare-gateway-binding": piAiGatewayBindingEntry,
		"@earendil-works/pi-ai/utils/oauth-page": piAiOauthPageEntry,
		"@earendil-works/pi-ai": piAiEntry,
		"@mariozechner/pi-agent-core": piAgentCoreEntry,
		"@mariozechner/pi-tui/dist/layout.js": piTuiLayoutEntry,
		"@mariozechner/pi-tui": piTuiEntry,
		"@mariozechner/pi-ai/oauth": piAiOauthEntry,
		"@mariozechner/pi-ai/models": piAiModelsEntry,
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

/**
 * A jiti loader that resolves host package specifiers the way extensions see them: `virtualModules` share live host
 * instances, and outside single-file builds every other host specifier aliases to the installed host files.
 */
export async function createHostModuleJiti(
	id: string,
	virtualModules: Record<string, object>,
	options: Parameters<typeof createJiti>[1] = {},
): Promise<ReturnType<typeof createJiti>> {
	const isSingleFileBuild = isBunBinary || isBundledBuild;
	const createJitiImpl = await getCreateJiti();
	return createJitiImpl(id, {
		...options,
		// Single-file builds have no host files to alias, so every import must reach the virtual modules.
		...(isSingleFileBuild ? { tryNative: false } : { alias: getAliases() }),
		virtualModules,
	});
}

export const extensionLoaderTestHooks = {
	loadVirtualModules,
	getAliases,
	findPackageRoot,
	getTranspileCacheDir: (agentDir?: string): string | undefined => resolveTranspileCacheDir(agentDir),
	graphManifestPath: (extensionPath: string, agentDir: string = getAgentDir()): string =>
		graphManifestPath(extensionPath, getExtensionTranspileCacheDir(path.resolve(agentDir))),
	readExtensionGraphManifest,
	loadExtensionModuleTransformed: (extensionPath: string, cacheToken?: ExtensionCacheToken, agentDir?: string) =>
		importExtensionModule(extensionPath, cacheToken, true, resolveTranspileCacheDir(agentDir)),
	loadTransformedExtensionModule: (extensionPath: string, cacheToken?: ExtensionCacheToken, agentDir?: string) =>
		loadTransformedExtensionModule(extensionPath, cacheToken, resolveTranspileCacheDir(agentDir)),
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
	cacheDir: string | undefined,
): Promise<ExtensionFactory | undefined> {
	const isWindows = process.platform === "win32";
	const isSingleFileBuild = isBunBinary || isBundledBuild;
	const createJitiImpl = await getCreateJiti();
	const jiti = createJitiImpl(resolutionBaseUrl(import.meta.url), {
		moduleCache: false,
		fsCache: false,
		transform: getTypeScriptSourceSpecifierTransform(createJitiImpl, cacheDir),
		...(forceTransformedImports ? { tryNative: false } : {}),
		// A first native import can fall back to transformation too. Always share
		// the live host instead of re-evaluating its graph through source aliases.
		virtualModules: await getVirtualModules(),
		...(!isSingleFileBuild ? { alias: getAliases() } : {}),
	});
	// Import the real path so a symlinked entry (a pnpm store package) resolves its dependencies next to the real
	// file; extensionPath stays the cache and graph key.
	const specifier = extensionImportSpecifier(canonicalizePath(extensionPath), cacheToken);
	// Transformed evaluations are the loads whose repeat cost is the Windows
	// /reload regression, so they are also the loads whose file graph is
	// recorded into a content-hash manifest. Without a transpile cache there is
	// nowhere to persist the manifest, so the evaluation is not retained.
	let module: unknown;
	let recordedManifest: ExtensionGraphManifest | undefined;
	if (forceTransformedImports && cacheDir !== undefined) {
		const recorded = await recordExtensionGraph(extensionPath, cacheDir, () =>
			jiti.import(specifier, { default: true }),
		);
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
	if (recordedManifest && cacheDir !== undefined) {
		factory = withDeferredGraphRecording(extensionPath, cacheDir, factory);
		retainedTransformedLoads.set(extensionPath, { factory, manifest: recordedManifest, cacheDir });
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
	cacheDir: string | undefined,
): Promise<ExtensionFactory | undefined> {
	const retained = retainedTransformedLoads.get(extensionPath);
	if (
		retained &&
		cacheDir !== undefined &&
		retained.cacheDir === cacheDir &&
		graphUnchangedSince(retained.manifest, cacheDir)
	) {
		if (isCurrentCacheToken(cacheToken)) {
			extensionCache.set(extensionPath, retained.factory);
		}
		return retained.factory;
	}
	return importExtensionModule(extensionPath, cacheToken, true, cacheDir);
}

/**
 * Load an extension module. Its transpile cache lives under `agentDir` (the
 * session's agent directory), else the cache token's, else the agent directory
 * in effect now; the load runs uncached when that directory no longer exists.
 */
export async function loadExtensionModule(
	extensionPath: string,
	cacheToken?: ExtensionCacheToken,
	agentDir?: string,
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
	const cacheDir = resolveTranspileCacheDir(agentDir ?? cacheToken?.agentDir);
	if (forceTransformedImports) {
		return loadTransformedExtensionModule(extensionPath, cacheToken, cacheDir);
	}
	return importExtensionModule(extensionPath, cacheToken, false, cacheDir);
}
