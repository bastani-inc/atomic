import { stat } from "node:fs/promises";
import type { Api, Model, ModelsStoreEntry, Provider } from "@earendil-works/pi-ai";
import { VERSION } from "../config.ts";
import { getPiUserAgent } from "../utils/pi-user-agent.ts";

const DEFAULT_CATALOG_BASE_URL = "https://pi.dev";
export const REMOTE_CATALOG_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;

function mergeModels(baseline: readonly Model<Api>[], dynamic: readonly Model<Api>[]): Model<Api>[] {
	const merged = [...baseline];
	for (const model of dynamic) {
		const index = merged.findIndex((entry) => entry.id === model.id);
		if (index >= 0) merged[index] = model;
		else merged.push(model);
	}
	return merged;
}

function parseCatalog(providerId: string, value: object): Model<Api>[] {
	const entries = Array.isArray(value)
		? value
		: "models" in value && Array.isArray(value.models)
			? value.models
			: Object.values(value);
	return entries
		.filter((entry): entry is Model<Api> => typeof entry === "object" && entry !== null && "id" in entry)
		.map((model) => ({ ...model, provider: providerId }));
}

function remoteModels(entry: ModelsStoreEntry | undefined, localLastModified: number | undefined): readonly Model<Api>[] {
	if (!entry) return [];
	if (localLastModified !== undefined && (entry.lastModified === undefined || entry.lastModified <= localLastModified)) {
		return [];
	}
	return entry.models;
}

function settleOnAbort(
	operation: Promise<void>,
	signal: AbortSignal | undefined,
	canSettle: () => boolean,
): Promise<void> {
	if (!signal) return operation;
	if (signal.aborted && canSettle()) return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		const abort = () => {
			if (canSettle()) resolve();
		};
		signal.addEventListener("abort", abort, { once: true });
		operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

type RefreshContext = Parameters<NonNullable<Provider["refreshModels"]>>[0];

interface InflightRefresh {
	promise: Promise<void>;
	allowNetwork: boolean;
	force: boolean;
	signal?: AbortSignal;
}
/** Add a persisted pi.dev catalog overlay to a static built-in provider. */
export function withRemoteCatalog(
	provider: Provider,
	catalogBaseUrl: string = DEFAULT_CATALOG_BASE_URL,
	localCatalogUrl?: URL,
): Provider {
	let dynamicModels: readonly Model<Api>[] = [];
	let inflightRefresh: InflightRefresh | undefined;
	let refreshEpoch = 0;
	let persistenceInProgress = false;

	const refreshModels = (context: RefreshContext): Promise<void> => {
		if (inflightRefresh) {
			const requiresEscalation = (context.allowNetwork && !inflightRefresh.allowNetwork)
				|| (context.force === true && !inflightRefresh.force)
				|| (inflightRefresh.signal?.aborted === true && context.signal?.aborted !== true);
			if (requiresEscalation) {
				const startEscalation = () => {
					if (context.signal?.aborted) return;
					return refreshModels(context);
				};
				const escalation = inflightRefresh.promise.then(startEscalation, startEscalation);
				return settleOnAbort(escalation, context.signal, () => !persistenceInProgress);
			}
			const owner = inflightRefresh;
			const retryAfterAbortedOwner = () => {
				if (owner.signal?.aborted && !context.signal?.aborted) return refreshModels(context);
			};
			const joined = owner.promise.then(retryAfterAbortedOwner, (error) => {
				const retry = retryAfterAbortedOwner();
				if (retry) return retry;
				throw error;
			});
			return settleOnAbort(joined, context.signal, () => !persistenceInProgress);
		}
		const epoch = ++refreshEpoch;
		const isCurrent = () => epoch === refreshEpoch && !context.signal?.aborted;
		const persist = async (entry: Parameters<typeof context.store.write>[0]) => {
			persistenceInProgress = true;
			try {
				await context.store.write(entry);
			} finally {
				persistenceInProgress = false;
			}
		};
		const operation = (async () => {
			const localLastModified = localCatalogUrl
				? await stat(localCatalogUrl).then((value) => value.mtimeMs, () => undefined)
				: undefined;
			const stored = await context.store.read();
			if (!isCurrent()) return;
			dynamicModels = remoteModels(stored, localLastModified).filter((model) => model.provider === provider.id);
			if (!context.allowNetwork) return;
			if (
				!context.force &&
				stored?.checkedAt !== undefined &&
				stored.lastModified !== undefined &&
				Date.now() - stored.checkedAt < REMOTE_CATALOG_REFRESH_INTERVAL_MS
			) return;

			const url = new URL(`/api/models/providers/${encodeURIComponent(provider.id)}`, catalogBaseUrl);
			const response = await fetch(url, {
				headers: { accept: "application/json", "User-Agent": getPiUserAgent(VERSION) },
				signal: context.signal,
			});
			if (!isCurrent()) return;
			const checkedAt = Date.now();
			if (response.status === 404 || response.status === 501) {
				await persist({ ...(stored ?? { models: [] }), checkedAt, lastModified: 0 });
				return;
			}
			if (!response.ok) {
				await persist({ ...(stored ?? { models: [] }), checkedAt });
				throw new Error(`Model catalog request failed for ${provider.id}: ${response.status}`);
			}
			const body: object = await response.json();
			if (!isCurrent()) return;
			const refreshed = parseCatalog(provider.id, body);
			const lastModified = Date.parse(response.headers.get("last-modified") ?? "");
			const entry = {
				models: refreshed,
				checkedAt,
				lastModified: Number.isNaN(lastModified) ? 0 : lastModified,
			};
			await persist(entry);
			if (isCurrent()) dynamicModels = remoteModels(entry, localLastModified);
		})();
		const refresh = settleOnAbort(operation, context.signal, () => !persistenceInProgress);
		const published = refresh.finally(() => {
			if (inflightRefresh?.promise === published) inflightRefresh = undefined;
		});
		inflightRefresh = {
			promise: published,
			allowNetwork: context.allowNetwork,
			force: context.force === true,
			signal: context.signal,
		};
		return published;
	};

	return {
		...provider,
		getModels: () => mergeModels(provider.getModels(), dynamicModels),
		refreshModels,
	};
}
