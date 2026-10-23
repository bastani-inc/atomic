import type { DurableWorkflowBackend } from "../durable/backend.js";
import type { PoolControl } from "../durable/journal/sql-pool-queue.js";
import type { PoolUsage } from "../durable/journal/sql-pool-usage.js";
import type { ResolvedInputs, RunOpts, RunResult } from "../runs/foreground/executor-types.js";
import type { Store } from "../shared/store.js";
import type { WorkflowDefinition } from "../shared/types.js";

export interface ChildWorkerDispatcher {
	validateOptions(options: RunOpts): void;
	prepare?(root: string, store?: Store): Promise<void>;
	control?(state: PoolControl["state"]): Promise<void>;
	usage?(): PoolUsage | undefined;
	run(definition: WorkflowDefinition, inputs: ResolvedInputs, options: RunOpts): Promise<RunResult>;
}

export const childWorkerDispatchers = new WeakMap<DurableWorkflowBackend, ChildWorkerDispatcher>();

const rootDispatchers = new WeakMap<DurableWorkflowBackend, Map<string, ChildWorkerDispatcher>>();

export function childWorkerDispatcher(
	backend: DurableWorkflowBackend,
	root: string,
): ChildWorkerDispatcher | undefined {
	return rootDispatchers.get(backend)?.get(root) ?? childWorkerDispatchers.get(backend);
}

export function bindChildWorkerDispatcher(
	backend: DurableWorkflowBackend,
	dispatcher: ChildWorkerDispatcher,
	root?: string,
): () => void {
	if (root === undefined) {
		if (childWorkerDispatchers.has(backend) || rootDispatchers.get(backend)?.size)
			throw new Error("Local worker pool already attached");
		childWorkerDispatchers.set(backend, dispatcher);
		return () => {
			if (childWorkerDispatchers.get(backend) === dispatcher) childWorkerDispatchers.delete(backend);
		};
	}
	if (childWorkerDispatcher(backend, root)) throw new Error("Local worker pool already attached to this root");
	let roots = rootDispatchers.get(backend);
	if (!roots) {
		roots = new Map();
		rootDispatchers.set(backend, roots);
	}
	roots.set(root, dispatcher);
	return () => {
		if (roots.get(root) === dispatcher) roots.delete(root);
	};
}
