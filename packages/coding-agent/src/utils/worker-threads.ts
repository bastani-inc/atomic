import { Worker, type WorkerOptions } from "node:worker_threads";

/**
 * The `execArgv` for a worker thread that evaluates Atomic's own CommonJS source (`new Worker(source, { eval: true })`).
 *
 * None of the process's command-line flags: a host started with `--input-type=module` would make that source a module,
 * which fails at its first `require`, and the host's `--import`/`--require` preloads would run again in every worker
 * (#6079). Under Node's permission model a worker is restricted only by the flags it starts with, so there it keeps the
 * process's flags (`undefined` inherits them) and stays as restricted as the process.
 */
export function evalWorkerExecArgv(): string[] | undefined {
	return process.permission === undefined ? [] : undefined;
}

/** Whether the process was started with `--input-type`, on its command line or in `NODE_OPTIONS`. */
function startedWithInputType(): boolean {
	return [...process.execArgv, ...(process.env.NODE_OPTIONS ?? "").split(/\s+/)].some(
		(flag) => flag === "--input-type" || flag.startsWith("--input-type="),
	);
}

/**
 * Starts a worker thread that runs Atomic's own ES module at `url` with the process's flags, which can include the
 * loaders the module needs. Node refuses `--input-type` for an ES module given as a worker's entry, and a worker
 * inherits it from a process started with it (`node --input-type=module --eval ...`), so there the worker imports the
 * module from evaluated source instead (#6079).
 */
export function startModuleWorker(url: URL, options: WorkerOptions = {}): Worker {
	if (!startedWithInputType()) return new Worker(url, options);
	return new Worker(`import(${JSON.stringify(url.href)});`, { ...options, eval: true });
}
