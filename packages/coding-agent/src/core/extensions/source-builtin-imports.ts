import type { Worker } from "node:worker_threads";
import type { createJiti } from "jiti";
import { startModuleWorker } from "../../utils/worker-threads.js";
import type { JitiImport, LoadedModule } from "./reloadable-scripts.ts";
import {
	isTypeScriptFile,
	moduleTransformOptions,
	readModuleSource,
	resolveFrom,
	walkStaticImports,
} from "./transform-graph.js";
import { trackTranspileCacheWrite } from "./transpile-cache-writes.js";
import { createTypeScriptSourceSpecifierTransform } from "./ts-source-specifiers.js";

type CreateJiti = typeof createJiti;
type Jiti = ReturnType<CreateJiti>;
type TransformOptions = Parameters<NonNullable<Jiti["options"]["transform"]>>[0];

/** The transform options jiti passes for every module of one load, without the module's own. */
export type TransformTemplate = Omit<TransformOptions, "filename" | "source" | "ts" | "async">;

/** One load of a builtin package's source entry in a source checkout. */
export interface SourceBuiltinLoad {
	readonly createJiti: CreateJiti;
	readonly cacheDir: string | undefined;
	readonly template: TransformTemplate;
}

/** What the transform worker prepares: `targets` and the modules they import statically, except `visited`. */
export interface TransformPreparation {
	readonly cacheDir: string;
	readonly template: TransformTemplate;
	readonly targets: readonly string[];
	readonly visited: readonly string[];
}

// Every module jiti evaluates for one load shares that load's options object.
const loads = new WeakMap<object, SourceBuiltinLoad>();
/** Per load, the deferred imports in progress, by the module file they import. */
const importing = new WeakMap<SourceBuiltinLoad, Map<string, Promise<unknown>>>();
/** Preparations in progress, by transpile cache and module file; loads of one extension can share them. */
const preparing = new Map<string, Promise<void>>();
let transformWorkerUrl: URL | undefined;

export function registerSourceBuiltinLoad(jiti: Jiti, load: Omit<SourceBuiltinLoad, "template">): void {
	loads.set(jiti.options, { ...load, template: transformTemplate(jiti.options) });
}

/**
 * The options jiti's transform hands the `transform` option for every module a jiti with `options` evaluates, without
 * the module's own, as jiti 2 builds them. With source maps on, jiti also names each module in `babel.sourceFileName`;
 * {@link moduleTransformOptions} adds that back.
 */
export function transformTemplate(options: Jiti["options"]): TransformTemplate {
	return {
		...options.transformOptions,
		babel: { ...(options.sourceMaps ? { sourceMaps: "inline" } : {}), ...options.transformOptions?.babel },
		interopDefault: options.interopDefault,
		jsx: options.jsx,
	};
}

/**
 * The files of every module in `module`'s load, or `undefined` while any of them has not finished evaluating
 * (or failed to).
 */
function settledModuleFiles(module: LoadedModule): string[] | undefined {
	let root = module;
	while (root.parent) root = root.parent;
	const files: string[] = [];
	const pending = [root];
	for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
		if (next.loaded !== true) return undefined;
		files.push(next.filename);
		pending.push(...(next.children ?? []));
	}
	return files;
}

/**
 * A path import made by a module that has finished evaluating, in a load of a builtin package's source entry.
 *
 * jiti transforms and evaluates the imported module graph synchronously, so in a source checkout the first import of
 * a large deferred module held the event loop for about a second (#6118). When nothing in the load is mid-evaluation
 * and the target is not loaded yet, the modules the import will evaluate are looked up in the transpile cache first,
 * and a worker writes the transforms of any that are missing; jiti's load that follows then finds them all there. The
 * load itself is unchanged: it reads every file again and uses a stored transform only for the same source, so an
 * edit made meanwhile is evaluated as it is now. Anything else returns `undefined` and the import goes to jiti at
 * once, as before.
 *
 * Every import of the same module that arrives while one is in progress gets that import's own promise. jiti hands a
 * second caller the module as soon as its evaluation has started, so two callers that resumed together after the
 * preparation would let the second use the module before its body had run.
 */
export function importAfterEvaluation(
	importer: LoadedModule,
	id: string,
	require: Jiti,
	jitiImport: JitiImport,
): Promise<unknown> | undefined {
	const load = loads.get(require.options);
	if (load?.cacheDir === undefined) return undefined;
	let target: string;
	try {
		target = require.resolve(id);
	} catch {
		return undefined;
	}
	if (!isTypeScriptFile(target)) return undefined;
	let inProgress = importing.get(load);
	const pending = inProgress?.get(target);
	if (pending !== undefined) return pending;
	const loaded = settledModuleFiles(importer);
	if (loaded === undefined || loaded.includes(target)) return undefined;
	const { createJiti, cacheDir, template } = load;
	const imported = shared(preparing, `${cacheDir}\0${target}`, () =>
		prepareTransforms(createJiti, { cacheDir, template, targets: [target], visited: loaded }),
	).then(() => jitiImport(id));
	if (inProgress === undefined) {
		inProgress = new Map();
		importing.set(load, inProgress);
	}
	const imports = inProgress;
	imports.set(target, imported);
	const settled = (): void => {
		if (imports.get(target) === imported) imports.delete(target);
	};
	void imported.then(settled, settled);
	return imported;
}

/** The promise `start` makes for `key`, shared by every caller until it settles. */
function shared(promises: Map<string, Promise<void>>, key: string, start: () => Promise<void>): Promise<void> {
	let pending = promises.get(key);
	if (pending === undefined) {
		const started = start();
		const cleanup = (): void => {
			if (promises.get(key) === started) promises.delete(key);
		};
		void started.then(cleanup, cleanup);
		promises.set(key, started);
		pending = started;
	}
	return pending;
}

/**
 * Before jiti evaluates builtin packages' source entries for the first time, a cold transpile cache (no stored
 * transform of an entry) would have jiti transform the entry's whole module graph on the main thread, several seconds
 * in a fresh source checkout. A worker per entry without a stored transform transforms its graph into the cache
 * first, the workers side by side, and the loads that follow find them there; like a deferred import's load, each
 * still reads every file and uses a stored transform only for the same source. With every entry's transform stored,
 * nothing is started and the loads run as before. Always settles.
 */
export async function prepareSourceEntries(load: SourceBuiltinLoad, entries: readonly string[]): Promise<void> {
	const { createJiti: createJitiImpl, cacheDir, template } = load;
	if (cacheDir === undefined) return;
	const transform = createTypeScriptSourceSpecifierTransform(createJitiImpl, import.meta.url, () => cacheDir);
	// Each entry as jiti names the file it transforms (with forward slashes on Windows), which the stored key includes.
	const files = entries.map((entry) => resolveFrom(createJitiImpl, entry, entry) ?? entry);
	const cold = await Promise.all(
		files.map(async (file) => {
			const source = await readModuleSource(file);
			return source !== undefined && transform.cached(moduleTransformOptions(template, file, source)) === undefined;
		}),
	);
	await Promise.all(
		files
			.filter((_file, index) => cold[index])
			.map((file) =>
				shared(preparing, `${cacheDir}\0${file}`, () =>
					runTransformWorker({ cacheDir, template, targets: [file], visited: [] }),
				),
			),
	);
}

/** {@link prepareSourceEntries} for the entry of a load registered with {@link registerSourceBuiltinLoad}. */
export async function prepareSourceEntry(jiti: Jiti, entry: string): Promise<void> {
	const load = loads.get(jiti.options);
	if (load !== undefined) await prepareSourceEntries(load, [entry]);
}

/**
 * Finds the modules of the preparation's targets that have no stored transform, reading each file without blocking,
 * and has a worker transform those. Always settles, whatever happens to the files or the worker.
 */
async function prepareTransforms(createJitiImpl: CreateJiti, preparation: TransformPreparation): Promise<void> {
	const transform = createTypeScriptSourceSpecifierTransform(
		createJitiImpl,
		import.meta.url,
		() => preparation.cacheDir,
	);
	const visited = new Set(preparation.visited);
	const missing: string[] = [];
	await walkStaticImports(
		preparation.targets,
		visited,
		async (filename) => {
			const source = await readModuleSource(filename);
			if (source === undefined) return undefined;
			const stored = transform.cached(moduleTransformOptions(preparation.template, filename, source));
			if (stored === undefined) missing.push(filename);
			return stored;
		},
		(importer, specifier) => resolveFrom(createJitiImpl, importer, specifier),
	);
	if (missing.length === 0) return;
	for (const filename of missing) visited.delete(filename);
	await runTransformWorker({ ...preparation, targets: missing, visited: [...visited] });
}

function runTransformWorker(preparation: TransformPreparation): Promise<void> {
	return trackTranspileCacheWrite(
		new Promise<void>((resolve) => {
			let worker: Worker;
			try {
				transformWorkerUrl ??= new URL(
					import.meta.url.endsWith(".ts") ? "./ts-transform-worker.ts" : "./ts-transform-worker.js",
					import.meta.url,
				);
				worker = startModuleWorker(transformWorkerUrl, { workerData: preparation });
			} catch {
				resolve();
				return;
			}
			const finish = (): void => {
				resolve();
				void worker.terminate();
			};
			worker.once("message", finish);
			worker.once("exit", finish);
			worker.on("error", finish);
		}),
	);
}
