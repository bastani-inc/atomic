import type { ModelsRefreshOptions, ModelsRefreshResult } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import { raceWithAbortSignal } from "../../utils/abort.ts";

type ModelCatalogRuntime = Pick<ModelRuntime, "refresh" | "isNetworkRefreshEnabled">;

/**
 * The whole-catalog options interactive refreshes vary. `providers` and `force`
 * are deliberately absent: a scoped or forced refresh asks for different work
 * and must never be answered by another caller's in-flight pass.
 */
export type ModelCatalogRefreshOptions = Pick<ModelsRefreshOptions, "allowNetwork">;

export interface ModelCatalogRefreshRequest extends ModelCatalogRefreshOptions {
	/** Caller's cancellation, independent of the shared refresh it joins. */
	signal: AbortSignal;
}

interface ActiveModelCatalogRefresh {
	controller: AbortController;
	promise: Promise<ModelsRefreshResult>;
	waiters: number;
}

/**
 * Key on the policy the runtime will actually apply, not on how the caller spelled
 * it. Startup asks for `allowNetwork: true` while the `/model` selector omits the
 * option and lets the runtime decide; on an online runtime those are one pass, and
 * keying the spelling started two. An explicit value that disagrees with the
 * runtime's own policy is still different work and still keys apart.
 */
function refreshKey(modelRuntime: ModelCatalogRuntime, options: ModelCatalogRefreshOptions): string {
	return (options.allowNetwork ?? modelRuntime.isNetworkRefreshEnabled()) ? "network" : "cache";
}

class ModelCatalogRefreshCoordinator {
	private readonly activeByRuntime = new WeakMap<ModelCatalogRuntime, Map<string, ActiveModelCatalogRefresh>>();

	refresh(modelRuntime: ModelCatalogRuntime, request: ModelCatalogRefreshRequest): Promise<ModelsRefreshResult> {
		const { signal, ...options } = request;
		signal.throwIfAborted();

		let byKey = this.activeByRuntime.get(modelRuntime);
		if (!byKey) {
			byKey = new Map<string, ActiveModelCatalogRefresh>();
			this.activeByRuntime.set(modelRuntime, byKey);
		}
		const active = byKey;
		const key = refreshKey(modelRuntime, options);

		let shared = active.get(key);
		if (!shared) {
			const controller = new AbortController();
			let created!: ActiveModelCatalogRefresh;
			const operation = modelRuntime.refresh({ ...options, signal: controller.signal });
			const promise = raceWithAbortSignal(operation, controller.signal).finally(() => {
				if (active.get(key) === created) active.delete(key);
			});
			created = { controller, promise, waiters: 0 };
			shared = created;
			active.set(key, shared);
		}

		const joined = shared;
		joined.waiters++;
		// Release on the caller's abort rather than only on settlement: a selector
		// that closes must cancel the underlying refresh in the same tick, which is
		// what Atomic's callers already observe.
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			signal.removeEventListener("abort", release);
			joined.waiters--;
			if (joined.waiters === 0 && active.get(key) === joined) {
				joined.controller.abort();
			}
		};
		signal.addEventListener("abort", release);
		return raceWithAbortSignal(joined.promise, signal).finally(release);
	}
}

const modelCatalogRefreshCoordinator = new ModelCatalogRefreshCoordinator();

/** Share concurrent interactive all-catalog refreshes while keeping each caller's cancellation independent. */
export function refreshModelCatalogs(
	modelRuntime: ModelCatalogRuntime,
	request: ModelCatalogRefreshRequest,
): Promise<ModelsRefreshResult> {
	return modelCatalogRefreshCoordinator.refresh(modelRuntime, request);
}
