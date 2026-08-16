import type { ModelsRefreshOptions, ModelsRefreshResult } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "../../core/model-runtime.js";
import { raceWithAbortSignal } from "../../utils/abort.js";

type ModelCatalogRuntime = Pick<ModelRuntime, "refresh" | "isNetworkRefreshEnabled" | "getCatalogInputsGeneration">;

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
 * A key names WHICH work a caller is asking for, plus WHEN the inputs that work
 * reads last changed. Both halves are needed and neither grows a third term.
 *
 * Which: the policy the runtime will actually apply, not how the caller spelled
 * it. Startup asks for `allowNetwork: true` while the `/model` selector omits the
 * option and lets the runtime decide; on an online runtime those are one pass, and
 * keying the spelling started two. An explicit value that disagrees with the
 * runtime's own policy is still different work and still keys apart.
 *
 * When: `ModelRuntime.getCatalogInputsGeneration()` — one monotonic counter over
 * every input a pass reads (credential writes, provider registrations, and
 * models.json content; see its doc comment). A pass publishes one snapshot built
 * from the inputs it started under, so joining across a bump serves the joiner
 * models and credentials the user already replaced and then overwrites the newer
 * state with them. Keying on the generation makes a request that arrives after
 * any such change start its own pass, and it is deliberately ONE number: this
 * coordinator previously keyed input by input — first the network policy, then
 * credentials, then models.json — and each round left the next input unkeyed.
 */
function refreshKey(modelRuntime: ModelCatalogRuntime, options: ModelCatalogRefreshOptions): string {
	const policy = (options.allowNetwork ?? modelRuntime.isNetworkRefreshEnabled()) ? "network" : "cache";
	return `${policy}:${modelRuntime.getCatalogInputsGeneration()}`;
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
			if (joined.waiters > 0) return;
			if (active.get(key) !== joined) return;
			// Evict before aborting. The abort is synchronous while the shared promise's
			// own cleanup is a microtask, so a caller retrying in this same tick would
			// otherwise join an entry that is already aborted and reject without work.
			active.delete(key);
			joined.controller.abort();
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
