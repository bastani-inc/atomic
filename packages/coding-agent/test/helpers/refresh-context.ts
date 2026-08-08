import type {
	Credential,
	ModelsPublication,
	ModelsStore,
	ModelsStoreEntry,
	RefreshModelsContext,
} from "@earendil-works/pi-ai";

/**
 * Test-side mirror of the host half of pi 0.84.1's provider refresh contract.
 *
 * Providers no longer own a mutable store. `Models` reads the entry once, hands
 * it to `refreshModels` as the immutable `stored` snapshot, and applies whatever
 * the provider returns through `publish()`. This helper reproduces
 * `publishProviderModels` (pi-ai models.js:97-121) faithfully, because two
 * details are load-bearing for the suites that use it:
 *
 *  - persistence runs BEFORE `update`, so a failing write means the in-memory
 *    update never happens. 0.83.0 published in memory first, so this ordering is
 *    inverted rather than merely relocated.
 *  - `publish` resolves `false` when the pass has been superseded; it rejects
 *    only when the store itself fails.
 *
 * `stored` is read at construction, so a context must be built per refresh call
 * rather than reused — the same rule real callers live under.
 */
export async function makeRefreshContext(
	store: ModelsStore,
	providerId: string,
	overrides: {
		credential?: Credential;
		allowNetwork?: boolean;
		force?: boolean;
		signal?: AbortSignal;
		/** Resolve false to simulate a superseded generation. */
		superseded?: boolean;
	} = {},
): Promise<RefreshModelsContext> {
	const stored = await store.read(providerId);
	return {
		credential: overrides.credential,
		stored: stored ? structuredClone(stored) : undefined,
		allowNetwork: overrides.allowNetwork ?? true,
		force: overrides.force,
		signal: overrides.signal ?? new AbortController().signal,
		publish: async ({ persist, update }: ModelsPublication): Promise<boolean> => {
			if (overrides.superseded) return false;
			if (persist === null) await store.delete(providerId);
			else if (persist !== undefined) await store.write(providerId, structuredClone(persist) as ModelsStoreEntry);
			update?.();
			return true;
		},
	};
}
