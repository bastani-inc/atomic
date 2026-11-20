import { Worker } from "node:worker_threads";
import type { CodemodeSandboxOptions } from "../types.ts";
import { type CodemodeWasmModule, loadQuickJSWasm } from "../wasm.ts";
import { CodemodeSandboxBase, errorMessage, type VmLauncher } from "./execution.ts";
import type { WorkerData } from "./protocol.ts";

function defaultWorkerUrl(): URL {
	// `.ts` when running from source (tests, tsx), `.js` from the published dist.
	return new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js", import.meta.url);
}

/** Whether the process was started with `--input-type`, on its command line or in `NODE_OPTIONS`. */
function startedWithInputType(): boolean {
	return [...process.execArgv, ...(process.env.NODE_OPTIONS ?? "").split(/\s+/)].some(
		(flag) => flag === "--input-type" || flag.startsWith("--input-type="),
	);
}

/**
 * Starts the worker with the process's flags, which can include the loaders its module needs. Node refuses
 * `--input-type` for an ES module given as a worker's entry, and a worker inherits it from a process started with it
 * (`node --input-type=module --eval ...`), so there this package's own worker is imported from evaluated source. A
 * `workerUrl` given in the options starts as given.
 */
function startWorker(workerUrl: string | URL | undefined, workerData: WorkerData): Worker {
	if (workerUrl !== undefined) return new Worker(workerUrl, { workerData });
	const url = defaultWorkerUrl();
	if (!startedWithInputType()) return new Worker(url, { workerData });
	return new Worker(`import(${JSON.stringify(url.href)});`, { eval: true, workerData });
}

/**
 * An error a stopping worker reports, or its termination's failure, reaches no run; it is only kept from being thrown.
 * A module function, so a worker still exiting holds nothing of the run through it.
 */
function ignoreWorkerError(): void {}

/** Settles when `worker` exits, holding nothing of the run that started it. */
function workerExit(worker: Worker): Promise<void> {
	return new Promise<void>((resolve) => worker.once("exit", () => resolve()));
}

/**
 * Each execution gets its own worker thread and QuickJS VM. A fresh worker per run keeps
 * termination simple: a runaway script, including one that only spins the microtask queue, is
 * killed with `terminate()` and cannot poison a later run. Before terminating, the host sets a
 * shared interrupt flag that the VM polls, because Bun's `terminate()` cannot stop a thread that
 * is spinning in wasm. Stopping requests termination without waiting for exit: some built-ins do
 * not poll the flag, so on Bun a worker can outlive the script's result.
 */
function workerLauncher(options: CodemodeSandboxOptions): VmLauncher {
	return async (data, events) => {
		let module: CodemodeWasmModule;
		try {
			module = await (options.wasm ?? loadQuickJSWasm());
		} catch (error) {
			throw new Error(`Failed to load QuickJS: ${errorMessage(error)}`);
		}
		const interrupt = new SharedArrayBuffer(4);
		const workerData: WorkerData = { ...data, wasm: module, interrupt };
		const releaseWorker = options.acquireWorker?.();
		let worker: Worker;
		try {
			worker = startWorker(options.workerUrl, workerData);
		} catch (error) {
			releaseWorker?.();
			throw new Error(`Failed to start worker: ${errorMessage(error)}`);
		}
		if (releaseWorker) worker.once("exit", releaseWorker);
		const onMessage = (message: unknown) => {
			// Node 24/26 --watch leaks dependency reports onto the worker channel (nodejs/node#65044).
			if (
				typeof message === "object" &&
				message !== null &&
				("watch:import" in message || "watch:require" in message)
			)
				return;
			events.message(message);
		};
		const onError = (error: unknown) => {
			events.failure({
				kind: "sandbox",
				name: error instanceof Error ? error.name : undefined,
				message: errorMessage(error),
			});
		};
		const onExit = (code: number) => {
			events.failure({ kind: "sandbox", message: `Worker exited with code ${code} before the script settled` });
		};
		worker.on("message", onMessage);
		worker.on("error", onError);
		worker.on("exit", onExit);
		const stop = async (): Promise<void> => {
			Atomics.store(new Int32Array(interrupt), 0, 1);
			// A stopped run hears nothing more from its worker. The listeners reach the run's options and, through
			// them, whatever the caller gave the run, so a worker still exiting must not keep them (or that) alive.
			worker.off("message", onMessage);
			worker.off("exit", onExit);
			worker.off("error", onError);
			worker.on("error", ignoreWorkerError);
			// A non-interruptible built-in can delay Bun's terminate() until it returns (#10748).
			// Do not hold up the result while that worker exits.
			void worker.terminate().catch(ignoreWorkerError);
			// terminate() refs the worker internally; unref it after requesting termination.
			worker.unref();
		};
		try {
			options.onWorkerStarted?.(workerExit(worker));
		} catch (error) {
			void stop();
			throw error;
		}
		return { post: (message) => worker.postMessage(message), stop };
	};
}

/**
 * Runs JavaScript in a QuickJS VM (a separate wasm instance) inside a worker thread. The worker
 * keeps script execution off the host thread: QuickJS runs synchronously, so a spinning script on
 * the host thread would block its event loop. Requires `node:worker_threads` (Node or Bun); see
 * `InlineCodemodeSandbox` and `RemoteCodemodeSandbox` in `@bastani/atomic-codemode/portable`
 * for other runtimes.
 */
export class CodemodeSandbox extends CodemodeSandboxBase {
	constructor(options: CodemodeSandboxOptions = {}) {
		super(options, workerLauncher(options));
	}
}
