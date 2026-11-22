import { Worker, type WorkerOptions } from "node:worker_threads";
import { startedWithInputType } from "@bastani/atomic-codemode/node-options";

/**
 * The `execArgv` for a worker thread that evaluates Atomic's own source (`new Worker(source, { eval: true })`).
 *
 * None of the process's command-line flags: the host's `--import`/`--require` preloads would run again in every worker,
 * and its `--input-type=module` would make the source a module (#6079). Under Node's permission model a worker is restricted only by the flags it starts with, so there it keeps the
 * process's flags (`undefined` inherits them) and stays as restricted as the process.
 */
export function evalWorkerExecArgv(): string[] | undefined {
	return process.permission === undefined ? [] : undefined;
}

/**
 * The first line of a worker's evaluated source, which then loads Node's built-in modules with `builtin(id)` instead of
 * `require(id)`. Node evaluates the source as an ES module, which has no `require`, when `--input-type=module` reaches
 * the worker: from `NODE_OPTIONS`, which Node parses again, as it holds then, for a worker given its own `execArgv` (as
 * these workers are), or from the options the process started with, which a worker started without `execArgv` keeps,
 * as under the permission model (#6110). Elsewhere `builtin` is that `require`.
 */
export const EVAL_WORKER_BUILTIN =
	'const builtin = typeof require === "function" ? require : (id) => process.getBuiltinModule(id);';

const ENGINE_WORKER_HEAP_MB_SYMBOL = Symbol.for("atomic.engine-worker-heap-mb.v1");

function withInheritedEngineHeapLimit(options: WorkerOptions): WorkerOptions {
	if (options.resourceLimits?.maxOldGenerationSizeMb !== undefined) return options;
	const heapMb = (globalThis as Record<symbol, unknown>)[ENGINE_WORKER_HEAP_MB_SYMBOL];
	if (typeof heapMb !== "number" || !Number.isSafeInteger(heapMb) || heapMb <= 0) return options;
	return {
		...options,
		resourceLimits: { ...options.resourceLimits, maxOldGenerationSizeMb: heapMb },
	};
}

/**
 * Starts a worker thread that runs Atomic's own ES module at `url` with the process's flags, which can include the
 * loaders the module needs. Node refuses `--input-type` for an ES module given as a worker's entry, and a worker
 * inherits it from a process started with it (`node --input-type=module --eval ...`), so there the worker imports the
 * module from evaluated source instead (#6079).
 */
export function startModuleWorker(url: URL, options: WorkerOptions = {}): Worker {
	const resolved = withInheritedEngineHeapLimit(options);
	if (!startedWithInputType()) return new Worker(url, resolved);
	return new Worker(`import(${JSON.stringify(url.href)});`, { ...resolved, eval: true });
}
