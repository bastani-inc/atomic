import type { DurableWorkflowBackend } from "../../durable/backend.js";

const transitions = new WeakMap<DurableWorkflowBackend, Map<string, Promise<void>>>();

/** Order whole control transitions, including their flush, without blocking other roots. */
export async function withDurableControlTransition<T>(
	backend: DurableWorkflowBackend,
	rootRunId: string,
	transition: () => Promise<T>,
): Promise<T> {
	let roots = transitions.get(backend);
	if (roots === undefined) {
		roots = new Map();
		transitions.set(backend, roots);
	}
	const previous = roots.get(rootRunId);
	const { promise, resolve } = Promise.withResolvers<void>();
	roots.set(rootRunId, promise);
	try {
		if (previous !== undefined) await previous;
		return await transition();
	} finally {
		resolve();
		if (roots.get(rootRunId) === promise) roots.delete(rootRunId);
		if (roots.size === 0) transitions.delete(backend);
	}
}
