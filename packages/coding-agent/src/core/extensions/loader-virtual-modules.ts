import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { createJiti } from "jiti";
import { getAgentDir, getExtensionTranspileCacheDir, isBunBinary, isBundledBuild } from "../../config.js";
import { resolutionBaseUrl } from "../../utils/module-require.js";
import { pathExists } from "../../utils/path-exists.ts";
import { pathsEqual, resolvePath } from "../../utils/paths.ts";
import { moduleDirFromMetaUrl } from "../../utils/split-launcher.ts";
import { getBuiltinExtensionEntryLabel } from "./builtin-extension-entry-labels.ts";
import {
	FORKED_PACKAGE_WORKSPACE_DIRS,
	type ForkedPackageManifest,
	forkedPackageExportAliases,
	TYPEBOX_SUBPATHS,
	withLegacyPackageNames,
} from "./forked-package-names.ts";
import { installHostModuleBridge } from "./host-module-bridge.ts";
import { normalizeJitiAliases } from "./jiti-aliases.js";
import { hasLazyBuiltinSpec } from "./lazy-builtin.js";
import { getVirtualModules, loadVirtualModules } from "./loader-host-modules.js";
import { isNativeBuiltinExtensionPath, isSourceBuiltinExtensionPath } from "./native-builtin-entries.ts";
import {
	evaluateReloadableScript,
	installReloadableScripts,
	isReloadableScriptPath,
	observeJsonReads,
	withReloadableScriptPrologue,
} from "./reloadable-scripts.ts";
import {
	importAfterEvaluation,
	prepareSourceEntries,
	prepareSourceEntry,
	registerSourceBuiltinLoad,
	transformTemplate,
} from "./source-builtin-imports.js";
import { trackTranspileCacheWrite } from "./transpile-cache-writes.js";
import { createTypeScriptSourceSpecifierTransform } from "./ts-source-specifiers.js";
import type { ExtensionFactory } from "./types.ts";

export { getVirtualModules } from "./loader-host-modules.js";

const requireFromHere = createRequire(import.meta.url);
let _aliases: Promise<Record<string, string>> | null = null;
let createJitiPromise: Promise<typeof createJiti> | undefined;
// A transpile cache directory nothing has used for this long is removed by the next process that sets up another one.
const UNUSED_TRANSPILE_CACHE_MS = 7 * 24 * 60 * 60 * 1000;
// How often a process marks a transpile cache directory it keeps using as used.
const TRANSPILE_CACHE_USE_MARK_MS = 60 * 60 * 1000;
const transpileCacheUseMarks = new Map<string, number>();
// Per cache directory this process has set up, the removal of the unused ones beside it.
const transpileCachePrunes = new Map<string, Promise<void>>();

function getCreateJiti(): Promise<typeof createJiti> {
	createJitiPromise ??= (
		isBunBinary || isBundledBuild ? import("./jiti-static-loader.ts") : import("./jiti-loader.ts")
	).then((module) =>
		// jiti imports a module natively first under Bun, and Bun then resolves the module's own imports itself, so an
		// extension's `typebox` or Atomic package imports could reach other copies than the host's. Every load is
		// transformed instead, as under Node: each import goes through the host's modules and aliases. Atomic's own
		// packages in a source checkout are the exception (see `bunImportsNatively`).
		process.versions.bun === undefined
			? module.createJiti
			: (((id, options) => module.createJiti(id, { tryNative: false, ...options })) as typeof createJiti),
	);
	return createJitiPromise;
}

/** Where Atomic's own packages import TypeBox's `Type` from. */
const HOST_TYPEBOX = "@bastani/atomic-ai";
const sharesHostTypeboxByDir = new Map<string, Promise<boolean>>();

/**
 * Under Bun, whether to import the entry of Atomic's own package at `extensionPath`, as a source checkout loads it,
 * natively, as before Bun transformed every extension: Bun then resolves its imports itself, from the files the host
 * loads, which reach the host's own instances as long as its TypeBox is the host's copy.
 */
function bunImportsNatively(extensionPath: string): Promise<boolean> {
	const bun = (globalThis as typeof globalThis & { Bun?: { resolve(id: string, parent: string): Promise<string> } })
		.Bun;
	if (bun === undefined || isBunBinary || isBundledBuild || !isSourceBuiltinExtensionPath(extensionPath)) {
		return Promise.resolve(false);
	}
	const dir = path.dirname(extensionPath);
	let shares = sharesHostTypeboxByDir.get(dir);
	if (shares === undefined) {
		shares = Promise.all([bun.resolve(HOST_TYPEBOX, dir), bun.resolve(HOST_TYPEBOX, currentModuleDir())]).then(
			([fromPackage, fromHost]) => fromPackage === fromHost,
			() => false,
		);
		sharesHostTypeboxByDir.set(dir, shares);
	}
	return shares;
}

/** Creates `dir` one level at a time below `root`, never `root` itself, so a removed agent directory stays removed. */
async function mkdirBelowExisting(root: string, dir: string): Promise<boolean> {
	let current = root;
	for (const segment of path.relative(root, dir).split(path.sep)) {
		current = path.join(current, segment);
		try {
			await fs.promises.mkdir(current);
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
 * self-invalidate when either changes. Each version has its own directory, and
 * the cache directories nothing has used for a week are removed in the
 * background once per cache directory. The first use of an agent directory
 * creates it as before. After that, a missing agent directory was removed: the
 * load runs uncached and the directory is not recreated (#4728).
 */
async function resolveTranspileCacheDir(agentDir: string = getAgentDir()): Promise<string | undefined> {
	const root = path.resolve(agentDir);
	const cacheDir = getExtensionTranspileCacheDir(root);
	if (!(await mkdirBelowExisting(root, cacheDir))) return undefined;
	markTranspileCacheUsed(cacheDir);
	if (!transpileCachePrunes.has(cacheDir)) transpileCachePrunes.set(cacheDir, pruneUnusedTranspileCaches(cacheDir));
	return cacheDir;
}

/** Sets the modification time of a cache directory in use, which a process removing unused ones goes by. */
function markTranspileCacheUsed(cacheDir: string): void {
	const now = Date.now();
	if (now - (transpileCacheUseMarks.get(cacheDir) ?? Number.NEGATIVE_INFINITY) < TRANSPILE_CACHE_USE_MARK_MS) return;
	transpileCacheUseMarks.set(cacheDir, now);
	const time = new Date(now);
	void fs.promises.utimes(cacheDir, time, time).catch(() => {});
}

// The name of a version's cache directory: `<version>+<transform format>`, or `<version>` in early releases.
const TRANSPILE_CACHE_DIR_NAME = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Removes the version cache directories beside `currentDir`, and those that earlier releases kept in `cache/jiti`,
 * that have not been used for {@link UNUSED_TRANSPILE_CACHE_MS}. Another Atomic using the same agent directory, such
 * as a source checkout beside an installed Atomic, or another version, keeps its cache while it uses it. Only
 * directories named like a version's cache are removed. Never rejects.
 */
async function pruneUnusedTranspileCaches(currentDir: string): Promise<void> {
	const parent = path.dirname(currentDir);
	const unusedSince = Date.now() - UNUSED_TRANSPILE_CACHE_MS;
	await Promise.all(
		[parent, path.join(path.dirname(parent), "jiti")].map(async (dir) => {
			const entries = await fs.promises.readdir(dir).catch((): string[] => []);
			await Promise.all(
				entries.map(async (entry) => {
					const entryPath = path.join(dir, entry);
					if (entryPath === currentDir || !TRANSPILE_CACHE_DIR_NAME.test(entry)) return;
					try {
						const stats = await fs.promises.lstat(entryPath);
						if (!stats.isDirectory() || stats.mtimeMs > unusedSince) return;
						await fs.promises.rm(entryPath, { recursive: true, force: true });
					} catch {
						// Another process removed or replaced it, or it cannot be removed; nothing to do.
					}
				}),
			);
		}),
	);
}

/**
 * Per-extension-path record of the complete file graph a transformed (jiti)
 * evaluation read, mapping each absolute file path to the SHA256 hex digest of
 * its content at evaluation time. Persisted under the versioned transpile
 * cache directory so pruneUnusedTranspileCaches handles version cleanup.
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
const fsExports = requireFromHere("node:fs") as typeof fs;

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
	recordObservedDigest(target, () => sha256Hex(content));
}

/** A digest that no file's content has: a reload never finds the file unchanged. */
const CHANGED_WHILE_READ = "changed-while-read";

/** Records `digest` for `target` in every graph being recorded, except a recorder's own transpile cache. */
function recordObservedDigest(target: string, digest: string | (() => string)): void {
	const normalizedTarget = path.normalize(target);
	const comparableTarget = normalizedTarget.toLowerCase();
	let hash: string | undefined;
	for (const recorder of activeGraphRecorders) {
		if (recorder.cachePrefix && comparableTarget.startsWith(recorder.cachePrefix)) continue;
		hash ??= typeof digest === "string" ? digest : digest();
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

async function persistGraphManifest(contents: string, manifestFile: string, cacheDir: string): Promise<void> {
	let tempFile: string | undefined;
	try {
		if (!(await mkdirBelowExisting(cacheDir, path.dirname(manifestFile)))) throw new Error("transpile cache is gone");
		tempFile = `${manifestFile}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
		await fs.promises.writeFile(tempFile, contents);
		await fs.promises.rename(tempFile, manifestFile);
	} catch {
		// Manifest persistence is best-effort: a missing manifest only means the
		// next reload cannot prove the graph unchanged and re-evaluates. A failed
		// replacement must not leave an older manifest behind describing a graph
		// that no longer matches this evaluation, so invalidate the destination
		// first, independently of removing the temporary file.
		try {
			await fs.promises.rm(manifestFile, { force: true });
		} catch {
			// A leftover stale manifest cannot be reused without also matching
			// the in-memory manifest of the same evaluation, and readers
			// tolerate missing or corrupt files.
		}
		try {
			if (tempFile) await fs.promises.rm(tempFile, { force: true });
		} catch {
			// Temporary files carry a unique suffix and are never read back.
		}
	}
}

const graphManifestWrites = new Map<string, Promise<void>>();

function writeGraphManifest(manifest: ExtensionGraphManifest, cacheDir: string | undefined): Promise<void> {
	if (cacheDir === undefined) return Promise.resolve();
	const manifestFile = graphManifestPath(manifest.extensionPath, cacheDir);
	const contents = JSON.stringify(manifest);
	const write = trackTranspileCacheWrite(
		(graphManifestWrites.get(manifestFile) ?? Promise.resolve()).then(() =>
			persistGraphManifest(contents, manifestFile, cacheDir),
		),
	);
	graphManifestWrites.set(manifestFile, write);
	void write.finally(() => {
		if (graphManifestWrites.get(manifestFile) === write) graphManifestWrites.delete(manifestFile);
	});
	return write;
}

function isStringRecord(value: unknown): value is Record<string, string> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	return Object.values(value).every((entry) => typeof entry === "string");
}

/** Reads the graph manifest recorded under `agentDir`, which defaults to the agent directory in effect now. */
export function readExtensionGraphManifest(
	extensionPath: string,
	agentDir: string = getAgentDir(),
): Promise<ExtensionGraphManifest | undefined> {
	return readGraphManifestIn(extensionPath, getExtensionTranspileCacheDir(path.resolve(agentDir)));
}

async function readGraphManifestIn(
	extensionPath: string,
	cacheDir: string | undefined,
): Promise<ExtensionGraphManifest | undefined> {
	if (cacheDir === undefined) return undefined;
	const manifestFile = graphManifestPath(extensionPath, cacheDir);
	await graphManifestWrites.get(manifestFile);
	try {
		const parsed = JSON.parse(await fs.promises.readFile(manifestFile, "utf-8")) as Partial<ExtensionGraphManifest>;
		if (parsed.version !== GRAPH_MANIFEST_VERSION) return undefined;
		if (parsed.extensionPath !== extensionPath) return undefined;
		if (!isStringRecord(parsed.files)) return undefined;
		return { version: GRAPH_MANIFEST_VERSION, extensionPath, files: parsed.files };
	} catch {
		return undefined;
	}
}

/**
 * Runs `load` while recording the files it reads, then hands the result and its graph to `recorded` before anything
 * else runs, so a module the evaluation imports from then on can join that graph, and persists the graph.
 */
async function recordExtensionGraph<T>(
	extensionPath: string,
	cacheDir: string,
	load: () => Promise<T>,
	recorded: (result: T, manifest: ExtensionGraphManifest) => void,
): Promise<T> {
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
	recorded(result, manifest);
	await writeGraphManifest(manifest, cacheDir);
	return result;
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

async function graphUnchangedSince(manifest: ExtensionGraphManifest, cacheDir: string): Promise<boolean> {
	const stored = await readGraphManifestIn(manifest.extensionPath, cacheDir);
	if (!stored || !manifestFilesEqual(stored.files, manifest.files)) return false;
	const entries = Object.entries(manifest.files);
	if (entries.length === 0) return false;
	for (const [filePath, hash] of entries) {
		try {
			if (sha256Hex(await fs.promises.readFile(filePath)) !== hash) return false;
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
	owner: RetainedTransformedLoad,
): ExtensionFactory {
	return async (pi) => {
		const recorder = createGraphRecorder(cacheDir);
		activeGraphRecorders.add(recorder);
		installReadFileSyncObserver();
		try {
			return await factory(pi);
		} finally {
			activeGraphRecorders.delete(recorder);
			uninstallReadFileSyncObserver();
			if (recorder.files.size > 0) await mergeDeferredGraphReads(extensionPath, cacheDir, recorder.files, owner);
		}
	};
}

/** Merges into `owner`'s graph while it is still the retained evaluation for `extensionPath`. */
async function mergeDeferredGraphReads(
	extensionPath: string,
	cacheDir: string,
	files: Map<string, string>,
	owner: RetainedTransformedLoad,
): Promise<void> {
	const retained = retainedTransformedLoads.get(extensionPath);
	if (retained !== owner || retained.cacheDir !== cacheDir) return;
	let changed = false;
	for (const [filePath, hash] of files) {
		if (retained.manifest.files[filePath] !== hash) {
			retained.manifest.files[filePath] = hash;
			changed = true;
		}
	}
	if (changed) await writeGraphManifest(retained.manifest, retained.cacheDir);
}

const lateReadWrites = new WeakSet<RetainedTransformedLoad>();

/**
 * Adds a module that a retained evaluation evaluated after its graph was recorded, such as one it imported lazily, to
 * that evaluation's graph, while it is still the evaluation /reload would reuse. An edit to the module then makes
 * /reload evaluate the extension again instead of keeping the module as it was (#6118). The digest is of the source
 * jiti evaluated; the manifest is written once per burst of modules.
 */
function recordLateModule(
	extensionPath: string,
	owner: RetainedTransformedLoad,
	filename: string | undefined,
	source: string,
): void {
	if (filename === undefined) return;
	recordLateDigest(extensionPath, owner, filename, sha256Hex(source));
}

/** {@link recordLateModule} with the digest of what the evaluation read. */
function recordLateDigest(extensionPath: string, owner: RetainedTransformedLoad, filename: string, hash: string): void {
	if (retainedTransformedLoads.get(extensionPath) !== owner) return;
	const file = path.normalize(filename);
	if (owner.manifest.files[file] === hash) return;
	owner.manifest.files[file] = hash;
	if (lateReadWrites.has(owner)) return;
	lateReadWrites.add(owner);
	void trackTranspileCacheWrite(
		new Promise<void>((written) => {
			setImmediate(() => {
				lateReadWrites.delete(owner);
				written(
					retainedTransformedLoads.get(extensionPath) === owner
						? writeGraphManifest(owner.manifest, owner.cacheDir)
						: undefined,
				);
			});
		}),
	);
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
async function findPackageRoot(packageName: string, searchPaths?: string[]): Promise<string> {
	for (const base of searchPaths ?? requireFromHere.resolve.paths(packageName) ?? []) {
		const candidate = path.join(base, packageName);
		if (await pathExists(path.join(candidate, "package.json"))) {
			return candidate;
		}
	}
	throw new Error(`Cannot locate package directory for "${packageName}"`);
}

const realpathJs = promisify(fs.realpath);

function currentModuleDir(): string {
	return moduleDirFromMetaUrl(import.meta.url, "dist", "core", "extensions");
}

/**
 * Get aliases for jiti (used in Node.js/development mode).
 * In Bun binary mode, virtualModules is used instead.
 */
function getAliases(): Promise<Record<string, string>> {
	_aliases ??= computeAliases().then(normalizeJitiAliases, (error: Error) => {
		_aliases = null;
		throw error;
	});
	return _aliases;
}

async function computeAliases(): Promise<Record<string, string>> {
	const __dirname = currentModuleDir();
	const packageIndex = path.resolve(__dirname, "../..", "index.js");

	const packagesRoot = path.resolve(__dirname, "../../../../");
	const resolveWorkspaceOrImport = async (workspaceRelativePath: string, packageName: string): Promise<string> => {
		const workspacePath = path.join(packagesRoot, workspaceRelativePath);
		if (await pathExists(workspacePath)) {
			return workspacePath;
		}
		const packageRoot = await findPackageRoot(packageName);
		const entryRelativePath = workspaceRelativePath.split("/").slice(1).join("/");
		return path.join(packageRoot, entryRelativePath);
	};

	const piCodingAgentEntry = packageIndex;
	const piAgentCoreEntry = await resolveWorkspaceOrImport("agent/dist/index.js", "@bastani/atomic-agent-core");
	const piTuiEntry = await resolveWorkspaceOrImport("tui/dist/index.js", "@bastani/atomic-tui");
	const piTuiLayoutEntry = await resolveWorkspaceOrImport("tui/dist/layout.js", "@bastani/atomic-tui");
	const piTuiLayoutNodeEntry = await resolveWorkspaceOrImport("tui/dist/layout-node.js", "@bastani/atomic-tui");
	// The workspace path mirrors pi-ai 0.80.x's built dist layout. If an
	// upstream layout change moves these files, this join needs updating to
	// match the package's real dist paths.
	const piAiEntry = await resolveWorkspaceOrImport("ai/dist/compat.js", "@bastani/atomic-ai");
	const piAiCodexResponsesEntry = await resolveWorkspaceOrImport(
		"ai/dist/api/openai-codex-responses.js",
		"@bastani/atomic-ai",
	);
	const piAiLlamaCppClassifyEntry = await resolveWorkspaceOrImport(
		"ai/dist/api/llama-cpp-classify.lazy.js",
		"@bastani/atomic-ai",
	);
	const piAiTypesafeSystemOneEntry = await resolveWorkspaceOrImport(
		"ai/dist/api/typesafe-system-one.lazy.js",
		"@bastani/atomic-ai",
	);
	const piAiOauthEntry = await resolveWorkspaceOrImport("ai/dist/oauth.js", "@bastani/atomic-ai");
	const piAiModelsEntry = await resolveWorkspaceOrImport("ai/dist/models.js", "@bastani/atomic-ai");
	const piAiProvidersEntry = await resolveWorkspaceOrImport("ai/dist/providers/all.js", "@bastani/atomic-ai");
	const piAiCopilotEnvEntry = await resolveWorkspaceOrImport(
		"ai/dist/providers/github-copilot-env.js",
		"@bastani/atomic-ai",
	);
	const piAiCopilotEntry = await resolveWorkspaceOrImport("ai/dist/providers/github-copilot.js", "@bastani/atomic-ai");
	const piAiOpenRouterEntry = await resolveWorkspaceOrImport("ai/dist/providers/openrouter.js", "@bastani/atomic-ai");
	const piAiProviderEnvEntry = await resolveWorkspaceOrImport("ai/dist/utils/provider-env.js", "@bastani/atomic-ai");
	const piAiRetryEntry = await resolveWorkspaceOrImport("ai/dist/utils/retry.js", "@bastani/atomic-ai");
	const piAiRequestAdmissionEntry = await resolveWorkspaceOrImport(
		"ai/dist/utils/request-admission.js",
		"@bastani/atomic-ai",
	);
	const piAiRetryHintsEntry = await resolveWorkspaceOrImport("ai/dist/utils/retry-hints.js", "@bastani/atomic-ai");
	const piAiCompatSchemaEntry = await resolveWorkspaceOrImport(
		"ai/dist/providers/compat-schema.js",
		"@bastani/atomic-ai",
	);
	const piAiModelSchemaEntry = await resolveWorkspaceOrImport(
		"ai/dist/providers/model-schema.js",
		"@bastani/atomic-ai",
	);
	const piAiOauthPageEntry = await resolveWorkspaceOrImport("ai/dist/utils/oauth-page.js", "@bastani/atomic-ai");
	const piAiGatewayBindingEntry = await resolveWorkspaceOrImport(
		"ai/dist/api/cloudflare-gateway-binding.js",
		"@bastani/atomic-ai",
	);
	// The Anthropic thinking guard replays assistant turns with pi-ai's own conversion (#4185).
	const piAiAnthropicAssistantContentEntry = await resolveWorkspaceOrImport(
		"ai/dist/api/anthropic-assistant-content.js",
		"@bastani/atomic-ai",
	);
	const piAiTransformMessagesEntry = await resolveWorkspaceOrImport(
		"ai/dist/api/transform-messages.js",
		"@bastani/atomic-ai",
	);
	// Every specifier each forked package's manifest exposes, so no subpath resolves below a root entry file.
	const forkedPackageAliases: Record<string, string> = {};
	for (const [name, dir] of Object.entries(FORKED_PACKAGE_WORKSPACE_DIRS)) {
		const workspaceRoot = path.join(packagesRoot, dir);
		const workspaceManifest = path.join(workspaceRoot, "package.json");
		const packageRoot =
			(await pathExists(workspaceManifest)) &&
			(JSON.parse(await fs.promises.readFile(workspaceManifest, "utf8")) as { name?: string }).name === name
				? workspaceRoot
				: await findPackageRoot(name);
		const manifest = JSON.parse(
			await fs.promises.readFile(path.join(packageRoot, "package.json"), "utf8"),
		) as ForkedPackageManifest;
		Object.assign(forkedPackageAliases, forkedPackageExportAliases(name, packageRoot, manifest, path.join));
	}

	// Each forked package also answers to its legacy pi names (@earendil-works/pi-*, @mariozechner/pi-*).
	return withLegacyPackageNames({
		...forkedPackageAliases,
		"@bastani/atomic/storage": path.resolve(__dirname, "../storage/index.js"),
		"@bastani/atomic": piCodingAgentEntry,
		"@earendil-works/pi-coding-agent": piCodingAgentEntry,
		"@mariozechner/pi-coding-agent": piCodingAgentEntry,
		"@bastani/atomic-agent-core": piAgentCoreEntry,
		"@bastani/atomic-tui/dist/layout.js": piTuiLayoutEntry,
		"@bastani/atomic-tui/dist/layout-node.js": piTuiLayoutNodeEntry,
		"@bastani/atomic-tui": piTuiEntry,
		"@bastani/atomic-ai/api/openai-codex-responses": piAiCodexResponsesEntry,
		"@bastani/atomic-ai/api/llama-cpp-classify.lazy": piAiLlamaCppClassifyEntry,
		"@bastani/atomic-ai/api/typesafe-system-one.lazy": piAiTypesafeSystemOneEntry,
		"@bastani/atomic-ai/oauth": piAiOauthEntry,
		"@bastani/atomic-ai/models": piAiModelsEntry,
		"@bastani/atomic-ai/providers/all": piAiProvidersEntry,
		"@bastani/atomic-ai/providers/github-copilot-env": piAiCopilotEnvEntry,
		"@bastani/atomic-ai/providers/github-copilot": piAiCopilotEntry,
		"@bastani/atomic-ai/providers/openrouter": piAiOpenRouterEntry,
		"@bastani/atomic-ai/providers/compat-schema": piAiCompatSchemaEntry,
		"@bastani/atomic-ai/providers/model-schema": piAiModelSchemaEntry,
		"@bastani/atomic-ai/utils/provider-env": piAiProviderEnvEntry,
		"@bastani/atomic-ai/utils/oauth-page": piAiOauthPageEntry,
		"@bastani/atomic-ai/utils/request-admission": piAiRequestAdmissionEntry,
		"@bastani/atomic-ai/utils/retry-hints": piAiRetryHintsEntry,
		"@bastani/atomic-ai/utils/retry": piAiRetryEntry,
		"@bastani/atomic-ai/compat": piAiEntry,
		"@bastani/atomic-ai/api/cloudflare-gateway-binding": piAiGatewayBindingEntry,
		"@bastani/atomic-ai/api/anthropic-assistant-content": piAiAnthropicAssistantContentEntry,
		"@bastani/atomic-ai/api/transform-messages": piAiTransformMessagesEntry,
		"@bastani/atomic-ai": piAiEntry,
		...typeboxAliases(forkedPackageAliases, path.resolve(__dirname, "../..", "typebox")),
	});
}

/**
 * Every `typebox` specifier, the SDK's re-exports of it (`@bastani/atomic/typebox`), and TypeBox 0.x's name for the
 * subpaths TypeBox 1 shares with it, as the files of Atomic's one copy of TypeBox in `@bastani/atomic-ai/utils/typebox/`.
 */
function typeboxAliases(forkedPackageAliases: Record<string, string>, sdkTypeboxDir: string): Record<string, string> {
	const aiUtils = forkedPackageAliases["@bastani/atomic-ai/utils"];
	if (aiUtils === undefined) throw new Error("@bastani/atomic-ai does not export ./utils/*");
	const aliases: Record<string, string> = {};
	for (const subpath of TYPEBOX_SUBPATHS) {
		aliases[`typebox${subpath}`] = path.join(aiUtils, "typebox", `${subpath.slice(1) || "index"}.js`);
		aliases[`@bastani/atomic/typebox${subpath}`] = path.join(sdkTypeboxDir, `${subpath.slice(1) || "index"}.js`);
	}
	for (const subpath of ["", "/compile", "/value"])
		aliases[`@sinclair/typebox${subpath}`] = aliases[`typebox${subpath}`]!;
	return aliases;
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
		...(isSingleFileBuild ? { tryNative: false } : { alias: await getAliases() }),
		virtualModules,
	});
}

export const extensionLoaderTestHooks = {
	loadVirtualModules,
	getAliases,
	findPackageRoot,
	getTranspileCacheDir: (agentDir?: string): Promise<string | undefined> => resolveTranspileCacheDir(agentDir),
	/** The removal of unused cache directories that setting up `agentDir`'s cache started, if any. */
	transpileCachePrune: (agentDir: string): Promise<void> | undefined =>
		transpileCachePrunes.get(getExtensionTranspileCacheDir(path.resolve(agentDir))),
	graphManifestPath: (extensionPath: string, agentDir: string = getAgentDir()): string =>
		graphManifestPath(extensionPath, getExtensionTranspileCacheDir(path.resolve(agentDir))),
	readExtensionGraphManifest,
	loadExtensionModuleTransformed: async (extensionPath: string, cacheToken?: ExtensionCacheToken, agentDir?: string) =>
		importExtensionModule(extensionPath, cacheToken, true, await resolveTranspileCacheDir(agentDir)),
	loadTransformedExtensionModule: async (extensionPath: string, cacheToken?: ExtensionCacheToken, agentDir?: string) =>
		loadTransformedExtensionModule(extensionPath, cacheToken, await resolveTranspileCacheDir(agentDir)),
	loadNativeBuiltinExtensionModule,
	hasNativeBuiltinFactory: (extensionPath: string): boolean => nativeBuiltinFactories.has(extensionPath),
};

/**
 * Extension paths already evaluated via native import() in this process. A
 * native import leaves the extension's whole module graph in the runtime's
 * module registry: the cache-busting query reaches only the entry file (and Bun
 * on Windows ignores even that), never its relative imports. Re-loads of these
 * paths (e.g. /reload) must go through jiti's transformed-import path to get a
 * fresh evaluation of every file (#4986), which also keeps each reload's
 * evaluation collectable instead of adding one registry entry per reload.
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
	// Import the real path so a symlinked entry (a pnpm store package) resolves its dependencies next to the real
	// file; extensionPath stays the cache and graph key.
	const importPath = await realpathJs(extensionPath).catch(() => extensionPath);
	const transformSource = createTypeScriptSourceSpecifierTransform(
		createJitiImpl,
		resolutionBaseUrl(import.meta.url),
		() => cacheDir,
		trackTranspileCacheWrite,
	);
	// Atomic's own packages as a source checkout loads them: their entries and deferred imports are transformed in a
	// worker (#6118).
	const sourceBuiltin = !isSingleFileBuild && isSourceBuiltinExtensionPath(extensionPath);
	// The evaluation /reload may reuse, from the moment its graph is recorded: the modules it evaluates later join it.
	let retained: RetainedTransformedLoad | undefined;
	installReloadableScripts((id) => createJitiImpl(id, { moduleCache: false, fsCache: false }), importAfterEvaluation);
	const jiti = createJitiImpl(resolutionBaseUrl(import.meta.url), {
		moduleCache: false,
		fsCache: false,
		transform: (options) => {
			if (retained) recordLateModule(extensionPath, retained, options.filename, options.source);
			const { code } = transformSource(options);
			return { code: withReloadableScriptPrologue(code, options.filename ?? "", options.source) };
		},
		...(forceTransformedImports
			? { tryNative: false }
			: (await bunImportsNatively(extensionPath))
				? { tryNative: true }
				: {}),
		// A first native import can fall back to transformation too. Always share
		// the live host instead of re-evaluating its graph through source aliases.
		virtualModules: await getVirtualModules(),
		...(!isSingleFileBuild ? { alias: await getAliases() } : {}),
	});
	// A JSON file the evaluation reads joins its graph, also after the graph was recorded, as a module it evaluates then
	// does. One whose parsed content the load cannot vouch for is recorded with a digest no content has, so a reload
	// evaluates the extension again.
	observeJsonReads(jiti, (file, content) => {
		if (retained)
			recordLateDigest(
				extensionPath,
				retained,
				file,
				content === undefined ? CHANGED_WHILE_READ : sha256Hex(content),
			);
		// While the graph is recorded, the recording took the content from the read itself.
		else if (content === undefined) recordObservedDigest(file, CHANGED_WHILE_READ);
	});
	if (sourceBuiltin) registerSourceBuiltinLoad(jiti, { createJiti: createJitiImpl, cacheDir });
	const specifier = extensionImportSpecifier(importPath, cacheToken);
	// The runtime would keep a JavaScript entry it loads itself until the process exits, so jiti's transform
	// evaluates it instead, as on every reload (#4988). Installed builtin bundles cannot change while Atomic runs,
	// so they keep loading natively, with nothing to transpile.
	const reloadableEntry = isReloadableScriptPath(importPath) && !(await isNativeBuiltinExtensionPath(extensionPath));
	const importEntry = async () => {
		try {
			return await (reloadableEntry
				? evaluateReloadableScript(jiti, importPath)
				: jiti.import(specifier, { default: true }));
		} finally {
			await transformSource.flush();
		}
	};
	const flushingFactory = (loadedFactory: ExtensionFactory): ExtensionFactory =>
		cacheDir === undefined
			? loadedFactory
			: async (pi) => {
					try {
						return await loadedFactory(pi);
					} finally {
						await transformSource.flush();
					}
				};
	// Unless the runtime imports the entry itself, a cold cache would have jiti transform a builtin package's source
	// graph on the main thread.
	if (sourceBuiltin && !jiti.options.tryNative) await prepareSourceEntry(jiti, importPath);
	// Transformed evaluations are the loads whose repeat cost is the Windows
	// /reload regression, so they are also the loads whose file graph is
	// recorded into a content-hash manifest. Without a transpile cache there is
	// nowhere to persist the manifest, so the evaluation is not retained.
	let module: unknown;
	if (forceTransformedImports && cacheDir !== undefined) {
		module = await recordExtensionGraph(extensionPath, cacheDir, importEntry, (loaded, manifest) => {
			if (typeof loaded !== "function") return;
			const load: RetainedTransformedLoad = {
				factory: flushingFactory(loaded as ExtensionFactory),
				manifest,
				cacheDir,
			};
			load.factory = withDeferredGraphRecording(extensionPath, cacheDir, load.factory, load);
			retainedTransformedLoads.set(extensionPath, load);
			retained = load;
		});
	} else {
		module = await importEntry();
	}
	// jiti transforms every load except Atomic's own packages in a source checkout under Bun (see getCreateJiti); a
	// native import's re-loads, and on Windows every re-load, use the transformed path and its retained-evaluation reuse.
	if ((isWindows || jiti.options.tryNative) && !forceTransformedImports) {
		nativelyImportedPaths.add(extensionPath);
	}
	if (typeof module !== "function") return undefined;
	const factory = retained?.factory ?? flushingFactory(module as ExtensionFactory);
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
		(await graphUnchangedSince(retained.manifest, cacheDir))
	) {
		if (isCurrentCacheToken(cacheToken)) {
			extensionCache.set(extensionPath, retained.factory);
		}
		return retained.factory;
	}
	return importExtensionModule(extensionPath, cacheToken, true, cacheDir);
}

/**
 * Before a batch of extension loads: the builtin packages' source entries among `extensionPaths` (a source checkout)
 * that jiti will transform and whose transforms are not stored have their module graphs transformed in workers, so
 * their loads do not transform them on the main thread. Does nothing for any other extension or layout, or for one
 * {@link loadExtensionModule} would serve from memory under `cacheToken`. The transpile cache is chosen as
 * {@link loadExtensionModule} chooses it.
 */
export async function prepareExtensionEntries(
	extensionPaths: readonly string[],
	cacheToken?: ExtensionCacheToken,
	agentDir?: string,
): Promise<void> {
	if (isBunBinary || isBundledBuild) return;
	const resident = isCurrentCacheToken(cacheToken) ? extensionCache : undefined;
	const entries = extensionPaths.filter((entry) => {
		if (resident?.has(entry) || !isSourceBuiltinExtensionPath(entry)) return false;
		const label = getBuiltinExtensionEntryLabel(entry);
		return label === undefined || !hasLazyBuiltinSpec(label);
	});
	if (entries.length === 0) return;
	const cacheDir = await resolveTranspileCacheDir(agentDir ?? cacheToken?.agentDir);
	if (cacheDir === undefined) return;
	const createJitiImpl = await getCreateJiti();
	// The options a load's jiti gets that decide whether it imports the entry natively and how it transforms modules.
	const { options } = createJitiImpl(resolutionBaseUrl(import.meta.url), { moduleCache: false, fsCache: false });
	const native = await Promise.all(entries.map((entry) => bunImportsNatively(entry)));
	const transformed = entries.filter(
		(entry, index) => nativelyImportedPaths.has(entry) || !(options.tryNative || native[index]),
	);
	const importPaths = await Promise.all(transformed.map((entry) => realpathJs(entry).catch(() => entry)));
	await prepareSourceEntries(
		{ createJiti: createJitiImpl, cacheDir, template: transformTemplate(options) },
		importPaths,
	);
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
	if (isSingleFileBuild && (await isNativeBuiltinExtensionPath(extensionPath))) {
		return loadNativeBuiltinExtensionModule(extensionPath, cacheToken);
	}

	if (isCurrentCacheToken(cacheToken)) {
		const cachedFactory = extensionCache.get(extensionPath);
		if (cachedFactory) return cachedFactory;
	}

	// Single-file builds (compiled binary or dev bundle) cannot alias host
	// package specifiers to files on disk: extensions must share the live
	// module instances baked into the build, so virtualModules is used instead
	// (which requires jiti's transformed-import path).
	// Every editable path retains the existing jiti/virtualModules behavior.
	// A first load is transformed like any other (see getCreateJiti), from
	// the persistent transpile cache when it holds the module, except Atomic's
	// own packages in a source checkout under Bun, which Bun imports itself.
	// On Windows, re-loads of the same path take the retained-evaluation path
	// below.
	//
	// A transformed re-import is not free. Measured on Windows CI, a transformed re-import
	// costs ~15 ms per module file in the extension's transitive graph, so a
	// reload of all five builtin packages (621 files) takes ~10.7 s cold and
	// ~2.5 s against a warm jiti fsCache, against ~40 ms on Linux and macOS. The
	// cost is correctness-driven and is paid interactively on every Windows
	// `/reload`; removing it needs a content-hash-keyed evaluation cache or a
	// narrower trigger, not a larger timeout.
	const forceTransformedImports = isSingleFileBuild || nativelyImportedPaths.has(extensionPath);
	const cacheDir = await resolveTranspileCacheDir(agentDir ?? cacheToken?.agentDir);
	if (forceTransformedImports) {
		return loadTransformedExtensionModule(extensionPath, cacheToken, cacheDir);
	}
	return importExtensionModule(extensionPath, cacheToken, false, cacheDir);
}
