import type { Extension, ExtensionRuntime, LoadExtensionsResult } from "./types.ts";

// Only the CLI's still-open cwd check listens. Keep one subscription per runtime, not one per
// extension or state request. On an addition, match the actual handlers the decision can dispatch.
const firstRegistrations = new WeakMap<ExtensionRuntime, (handlers: Extension["handlers"]) => void>();

export function projectTrustHandlerRegistered(runtime: ExtensionRuntime, handlers: Extension["handlers"]): void {
	firstRegistrations.get(runtime)?.(handlers);
}

/** Watch an initially empty inventory until its first addition, the dispatch snapshot, or session disposal. */
export function watchFirstProjectTrustHandler(
	inventory: LoadExtensionsResult,
	signal: AbortSignal,
	onRegistered: () => void,
): () => void {
	const stop = () => {
		signal.removeEventListener("abort", stop);
		if (firstRegistrations.get(inventory.runtime) === notify) firstRegistrations.delete(inventory.runtime);
	};
	const notify = (handlers: Extension["handlers"]) => {
		if (!inventory.extensions.some((ext) => ext.handlers === handlers)) return;
		stop();
		onRegistered();
	};
	if (!signal.aborted) {
		firstRegistrations.set(inventory.runtime, notify);
		signal.addEventListener("abort", stop, { once: true });
	}
	return stop;
}
