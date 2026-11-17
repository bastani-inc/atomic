import type { AsyncLocalStorage } from "node:async_hooks";

type ExecutionStorage = Pick<AsyncLocalStorage<object>, "exit">;

const EXECUTION_CONTEXT_BOUNDARY_KEY = Symbol.for("atomic-workflows/execution-context-boundary@1");

function executionStorages(): Set<ExecutionStorage> {
	const bag = globalThis as typeof globalThis & Record<symbol, Set<ExecutionStorage> | undefined>;
	let existing = bag[EXECUTION_CONTEXT_BOUNDARY_KEY];
	if (!(existing instanceof Set)) {
		existing = new Set<ExecutionStorage>();
		bag[EXECUTION_CONTEXT_BOUNDARY_KEY] = existing;
	}
	return existing;
}

export function registerExecutionStorages(...storages: readonly ExecutionStorage[]): () => void {
	const active = executionStorages();
	for (const storage of storages) active.add(storage);
	return () => {
		const current = executionStorages();
		for (const storage of storages) current.delete(storage);
	};
}

export function outsideWorkflowExecutions<TResult>(callback: () => TResult): TResult {
	let run = callback;
	for (const storage of executionStorages()) {
		const inner = run;
		run = () => storage.exit(inner);
	}
	return run();
}
