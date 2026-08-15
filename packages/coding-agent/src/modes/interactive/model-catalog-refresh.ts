import type { ModelsRefreshOptions, ModelsRefreshResult } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import { raceWithAbortSignal } from "../../utils/abort.ts";

type ModelCatalogRuntime = Pick<
	ModelRuntime,
	"refresh" | "isNetworkRefreshEnabled" | "getCredentialGeneration" | "getModelConfigFingerprint"
>;

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
 *
 * The credential generation is part of the key because a catalog pass resolves
 * credentials as it runs. A refresh started before an API-key login answers for
 * credentials that no longer exist, and Atomic's login path deliberately leaves
 * the post-login catalog refresh to the selector (`interactive-auth-login.ts`).
 * Without the generation the selector joined the pre-login pass and showed no
 * models for the provider the user had just authenticated.
 *
 * The models.json fingerprint is part of the key for the same reason in the
 * other direction: every pass reloads that file and applies it, so a pass that
 * started before an edit answers with the provider keys and model definitions
 * the user just replaced. Without it, a `/model` picker opened after an edit
 * joined the older pass and the edit did not take effect until a third refresh,
 * silently revoking the hot reload `model-registry-hot-reload.test.ts` states.
 */
function refreshKey(modelRuntime: ModelCatalogRuntime, options: ModelCatalogRefreshOptions): string {
	const policy = (options.allowNetwork ?? modelRuntime.isNetworkRefreshEnabled()) ? "network" : "cache";
	return `${policy}:${modelRuntime.getCredentialGeneration()}:${modelRuntime.getModelConfigFingerprint()}`;
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
