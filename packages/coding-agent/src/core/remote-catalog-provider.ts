import {
	type AnyModel,
	getModelType,
	isModelType,
	type ModelsStoreEntry,
	type ModelType,
	type Provider,
	type RefreshModelsContext,
} from "@bastani/atomic-ai";
import {
	buildModelsDevChatModels,
	finalizeChatModels,
	type ModelsDevCatalog,
} from "@bastani/atomic-ai/utils/models-dev-catalog";
import { VERSION } from "../config.js";
import { fetchWithRetry } from "../utils/management-http.ts";
import { getPiUserAgent } from "../utils/pi-user-agent.ts";

/** Where Atomic refreshes its model catalog: models.dev's public `api.json`. Override with `ATOMIC_MODEL_CATALOG_URL`. */
export const DEFAULT_CATALOG_BASE_URL = "https://models.dev";
/** One catalog download's deadline, body included. The catalog is a few megabytes. */
const REMOTE_CATALOG_ATTEMPT_TIMEOUT_MS = 15_000;
export const REMOTE_CATALOG_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;
/** Model types a refreshed catalog may carry. models.dev only yields chat models. */
export const REMOTE_CATALOG_MODEL_TYPES: readonly ModelType[] = ["chat", "image", "classifier"];

function isSupportedModelType(model: { type?: unknown }): boolean {
	return (
		model.type === undefined ||
		(typeof model.type === "string" && REMOTE_CATALOG_MODEL_TYPES.includes(model.type as ModelType))
	);
}

function hasOperationShape(model: unknown): boolean {
	if (typeof model !== "object" || model === null) return false;
	if (!("type" in model) || (model.type !== "image" && model.type !== "classifier")) return true;
	if (!("cost" in model)) return false;
	const cost = model.cost;
	return (
		"id" in model &&
		typeof model.id === "string" &&
		model.id.length > 0 &&
		"name" in model &&
		typeof model.name === "string" &&
		"api" in model &&
		typeof model.api === "string" &&
		"baseUrl" in model &&
		typeof model.baseUrl === "string" &&
		"input" in model &&
		Array.isArray(model.input) &&
		cost !== null &&
		typeof cost === "object" &&
		["input", "output", "cacheRead", "cacheWrite"].every(
			(key) => key in cost && typeof (cost as Record<string, unknown>)[key] === "number",
		) &&
		(model.type === "image"
			? "output" in model && Array.isArray(model.output) && model.output.includes("image")
			: "contextWindow" in model && typeof model.contextWindow === "number" && model.contextWindow > 0)
	);
}

function mergeModels<TModel extends AnyModel>(baseline: readonly TModel[], dynamic: readonly TModel[]): TModel[] {
	const merged = new Map<string, TModel>();
	for (const model of baseline) merged.set(`${getModelType(model)}\0${model.id}`, model);
	for (const model of dynamic) {
		const key = `${getModelType(model)}\0${model.id}`;
		const bundled = merged.get(key);
		if (
			bundled &&
			isModelType(bundled, "chat") &&
			isModelType(model, "chat") &&
			model.serviceTiers === undefined &&
			bundled.serviceTiers !== undefined
		) {
			merged.set(key, { ...model, serviceTiers: bundled.serviceTiers });
		} else {
			merged.set(key, model);
		}
	}
	return [...merged.values()];
}

/** One download of models.dev's catalog, mapped to Atomic's chat models by provider. */
interface RemoteCatalog {
	readonly byProvider: ReadonlyMap<string, readonly AnyModel[]>;
	readonly lastModified: number;
	/** The response's ETag, sent as `if-none-match` on the next refresh. */
	readonly etag?: string;
	/** The server answered 304 to the stored ETag: the stored overlay is current. */
	readonly notModified?: boolean;
}

/**
 * Downloads `<catalogBaseUrl>/api.json` once for every provider that refreshes together: providers refresh in
 * parallel, and they share the download while it is in flight, so a refresh of every provider costs one request.
 */
const inflightCatalogs = new Map<string, Promise<RemoteCatalog>>();

/**
 * The models.dev catalog, mapped with the same transform the build uses for the bundled catalog. With `etag`, the
 * request revalidates it, and a 304 answer reports `notModified` instead of a catalog.
 */
export async function loadRemoteCatalog(
	catalogBaseUrl: string,
	signal: AbortSignal,
	etag?: string,
): Promise<RemoteCatalog> {
	const key = `${catalogBaseUrl}\n${etag ?? ""}`;
	let download = inflightCatalogs.get(key);
	if (!download) {
		// The download is shared, so it is bounded by its own deadline, not by one caller's signal.
		download = downloadRemoteCatalog(catalogBaseUrl, etag);
		inflightCatalogs.set(key, download);
		const settled = download;
		void settled
			.catch(() => undefined)
			.finally(() => {
				if (inflightCatalogs.get(key) === settled) inflightCatalogs.delete(key);
			});
	}
	return untilAborted(download, signal);
}

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

/** Forget in-flight downloads, so the next refresh downloads again. For tests. */
export function clearRemoteCatalogCache(): void {
	inflightCatalogs.clear();
}

async function downloadRemoteCatalog(catalogBaseUrl: string, etag: string | undefined): Promise<RemoteCatalog> {
	const url = new URL("api.json", catalogBaseUrl.endsWith("/") ? catalogBaseUrl : `${catalogBaseUrl}/`);
	const headers: Record<string, string> = { accept: "application/json", "User-Agent": getPiUserAgent(VERSION) };
	if (etag) headers["if-none-match"] = etag;
	const response = await fetchWithRetry(
		url,
		{ headers },
		{ attemptTimeoutMs: REMOTE_CATALOG_ATTEMPT_TIMEOUT_MS, timeoutMs: REMOTE_CATALOG_ATTEMPT_TIMEOUT_MS * 3 },
	);
	// A server without the catalog (404, 501) means no overlay, not a failed refresh: the bundled catalog stays.
	if (response.status === 404 || response.status === 501) return { byProvider: new Map(), lastModified: 0 };
	if (response.status === 304 && etag) return { byProvider: new Map(), lastModified: 0, etag, notModified: true };
	if (!response.ok) throw new Error(`Model catalog request to ${url.origin} failed: ${response.status}`);
	const data = (await response.json()) as ModelsDevCatalog;
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		throw new Error(`Model catalog from ${url.origin} is not a models.dev catalog`);
	}
	const byProvider = new Map<string, AnyModel[]>();
	for (const model of finalizeChatModels(buildModelsDevChatModels(data))) {
		const chat: AnyModel = { ...model, type: "chat" };
		if (!hasOperationShape(chat)) continue;
		const list = byProvider.get(model.provider) ?? [];
		list.push(chat);
		byProvider.set(model.provider, list);
	}
	const lastModified = Date.parse(response.headers.get("last-modified") ?? "");
	return {
		byProvider,
		lastModified: Number.isNaN(lastModified) ? Date.now() : lastModified,
		etag: response.headers.get("etag") ?? undefined,
	};
}

/** Whether a downloaded catalog is newer than the model data shipped with Atomic. */
function isNewer(lastModified: number | undefined, localGeneratedAt: number | undefined): boolean {
	return localGeneratedAt === undefined || (lastModified !== undefined && lastModified > localGeneratedAt);
}

function remoteModels(entry: ModelsStoreEntry | undefined, localGeneratedAt: number | undefined): readonly AnyModel[] {
	return entry && isNewer(entry.lastModified, localGeneratedAt) ? entry.models : [];
}

/** Replaces the catalog with a credential-specific model list. */
export type PersonalizeCatalog = (
	catalog: readonly AnyModel[],
	context: RefreshModelsContext,
) => Promise<readonly AnyModel[]>;

/** Add a persisted overlay from the refreshed models.dev catalog to a static built-in provider. */
export function withRemoteCatalog(
	provider: Provider,
	catalogBaseUrl: string = DEFAULT_CATALOG_BASE_URL,
	localGeneratedAt?: number,
): Provider {
	const models = provider.getAllModels?.() ?? provider.getModels();
	if (models.length > 0 && !models.some(isSupportedModelType)) return provider;

	let dynamicModels: readonly AnyModel[] = [];

	return {
		...provider,
		getModels: () =>
			mergeModels(
				provider.getModels(),
				dynamicModels.filter((model) => isModelType(model, "chat")),
			),
		getAllModels: () => mergeModels(provider.getAllModels?.() ?? provider.getModels(), dynamicModels),
		refreshModelsAuth: "configured",
		refreshModels: async (context) => {
			// 0.84.1 hands the snapshot in directly and coalesces concurrent refreshes
			// itself, so the old inflight-promise dedup is gone. Every mutation of
			// dynamicModels now runs inside a generation-checked publish; a false return
			// means a newer refresh already superseded this pass, so it must not continue.
			const stored = context.stored;
			const restored = remoteModels(stored, localGeneratedAt).filter(
				(model) => model.provider === provider.id && hasOperationShape(model),
			);
			if (
				!(await context.publish({
					update: () => {
						dynamicModels = restored;
					},
				}))
			) {
				return;
			}
			if (!context.allowNetwork || context.signal.aborted) return;
			// Skip the download if the catalog was checked less than REMOTE_CATALOG_REFRESH_INTERVAL_MS ago.
			// An entry without lastModified (saved by an older version, or after a failed first request) is
			// always refetched: remoteModels() ignores it, so waiting would leave the overlay empty.
			if (
				!context.force &&
				stored?.checkedAt !== undefined &&
				stored.lastModified !== undefined &&
				Date.now() - stored.checkedAt < REMOTE_CATALOG_REFRESH_INTERVAL_MS
			) {
				return;
			}

			let catalog: RemoteCatalog;
			try {
				// Revalidate only a stored overlay: an ETag without its body cannot be reused on a 304.
				const validator = stored?.etag && stored.models.length > 0 ? stored.etag : undefined;
				catalog = await loadRemoteCatalog(catalogBaseUrl, context.signal, validator);
			} catch (error) {
				if (context.signal.aborted) return;
				// The stored overlay stays; the next refresh after the interval tries again.
				await context.publish({ persist: { ...(stored ?? { models: [] }), checkedAt: Date.now() } });
				throw error;
			}
			if (context.signal.aborted) return;
			if (catalog.notModified && stored) {
				await context.publish({ persist: { ...stored, checkedAt: Date.now() } });
				return;
			}
			const entry: ModelsStoreEntry = {
				models: [...(catalog.byProvider.get(provider.id) ?? [])].map((model) => ({
					...model,
					provider: provider.id,
				})),
				lastModified: catalog.lastModified,
				checkedAt: Date.now(),
				...(catalog.etag ? { etag: catalog.etag } : {}),
			};
			const published = remoteModels(entry, localGeneratedAt);
			await context.publish({
				persist: entry,
				update: () => {
					dynamicModels = published;
				},
			});
		},
	};
}

/**
 * Like `withRemoteCatalog`, but on each network refresh the catalog (built-in models plus a newer
 * refreshed catalog) is passed through `personalize` and the result is saved. The saved entry holds
 * the personalized list, not the refreshed catalog, and replaces the catalog, including offline.
 * The refresh interval is skipped. An empty list (nothing saved yet, or an empty catalog saved
 * after a failed or missing catalog download) falls back to
 * the built-in models.
 */
export function withPersonalizedCatalog(
	provider: Provider,
	personalize: PersonalizeCatalog,
	catalogBaseUrl: string = DEFAULT_CATALOG_BASE_URL,
	localGeneratedAt?: number,
): Provider {
	let personalModels: readonly AnyModel[] = [];
	const builtinModels = (): readonly AnyModel[] => provider.getAllModels?.() ?? provider.getModels();
	const getAllModels = (): readonly AnyModel[] => (personalModels.length > 0 ? personalModels : builtinModels());

	return {
		...provider,
		getModels: () => getAllModels().filter((model) => isModelType(model, "chat")),
		getAllModels,
		refreshModelsAuth: "credential",
		refreshModels: async (context) => {
			const restored = (context.stored?.models ?? []).filter(
				(model) => model.provider === provider.id && hasOperationShape(model),
			);
			if (
				!(await context.publish({
					update: () => {
						personalModels = restored;
					},
				}))
			) {
				return;
			}
			if (!context.allowNetwork || context.signal.aborted) return;

			let remote: readonly AnyModel[] = [];
			try {
				const catalog = await loadRemoteCatalog(catalogBaseUrl, context.signal);
				if (isNewer(catalog.lastModified, localGeneratedAt)) remote = catalog.byProvider.get(provider.id) ?? [];
			} catch {
				remote = [];
			}
			if (context.signal.aborted) return;
			const personalized = await personalize(mergeModels(builtinModels(), remote), context);
			if (context.signal.aborted) return;
			await context.publish({
				persist: { models: personalized, checkedAt: Date.now() },
				update: () => {
					personalModels = personalized;
				},
			});
		},
	};
}

/**
 * Lists the models an account offers that `catalog` lacks, or undefined when the account's list
 * could not be read, which keeps the models saved before.
 */
export type DiscoverModels = (
	catalog: readonly AnyModel[],
	context: RefreshModelsContext,
) => Promise<readonly AnyModel[] | undefined>;

function isDiscoveredModel(model: AnyModel): boolean {
	return isModelType(model, "chat") && model.discovered === true;
}

function modelKey(model: AnyModel): string {
	return `${getModelType(model)}\0${model.id}`;
}

function withSavedModels(entry: ModelsStoreEntry, saved: readonly AnyModel[]): ModelsStoreEntry {
	return { ...entry, models: [...entry.models, ...saved] };
}

/**
 * Add the models an account offers beyond the provider's catalog. Each network refresh runs the
 * wrapped provider's own refresh first, then `discover`. Discovered models are saved in the
 * provider's stored entry beside the wrapped provider's data, so a later start restores them without
 * the network. They are replaced only by a list `discover` read; when it could not read one, the saved
 * models stay. The catalog always wins: a discovered ID the catalog also lists is dropped, so a
 * curated entry is never replaced.
 */
export function withDiscoveredModels(
	provider: Provider,
	discover: DiscoverModels,
	cache?: { missing?: symbol; enabled: boolean },
): Provider {
	let discovered: readonly AnyModel[] = [];
	const catalogModels = (): readonly AnyModel[] => provider.getAllModels?.() ?? provider.getModels();
	const withDiscovered = (catalog: readonly AnyModel[]): AnyModel[] => {
		const owned = new Set(catalog.map(modelKey));
		return [...catalog, ...discovered.filter((model) => !owned.has(modelKey(model)))];
	};

	return {
		...provider,
		getModels: () => withDiscovered(provider.getModels()).filter((model) => isModelType(model, "chat")),
		getAllModels: () => withDiscovered(catalogModels()),
		refreshModelsAuth: "credential",
		refreshModels: async (context) => {
			const stored = context.stored;
			const saved = (stored?.models ?? []).filter(
				(model) => model.provider === provider.id && isDiscoveredModel(model),
			);
			let catalogEntry: ModelsStoreEntry | undefined = stored && {
				...stored,
				models: stored.models.filter((model) => !isDiscoveredModel(model)),
			};
			if (
				!(await context.publish({
					update: () => {
						discovered = saved;
						if (cache?.enabled)
							cache.missing = !context.allowNetwork && stored === undefined ? Symbol() : undefined;
					},
				}))
			) {
				return;
			}
			try {
				await provider.refreshModels?.({
					...context,
					stored: catalogEntry,
					publish: (publication) => {
						if (publication.persist === undefined) return context.publish(publication);
						catalogEntry = publication.persist ?? undefined;
						return context.publish({
							...publication,
							persist: withSavedModels(publication.persist ?? { models: [] }, saved),
						});
					},
				});
			} finally {
				if (context.allowNetwork && !context.signal.aborted) {
					const found = await discover(catalogModels(), context);
					if (found && !context.signal.aborted) {
						await context.publish({
							persist: withSavedModels(catalogEntry ?? { models: [] }, found),
							update: () => {
								discovered = found;
							},
						});
					}
				}
			}
		},
	};
}
