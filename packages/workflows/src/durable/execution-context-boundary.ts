import type { AsyncLocalStorage } from "node:async_hooks";

type ExecutionStorage = Pick<AsyncLocalStorage<object>, "exit">;

const executionStorages = new Set<ExecutionStorage>();

export function registerExecutionStorages(...storages: readonly ExecutionStorage[]): () => void {
	for (const storage of storages) executionStorages.add(storage);
	return () => {
		for (const storage of storages) executionStorages.delete(storage);
	};
}

export function outsideWorkflowExecutions<TResult>(callback: () => TResult): TResult {
	let run = callback;
	for (const storage of executionStorages) {
		const inner = run;
		run = () => storage.exit(inner);
	}
	return run();
}
