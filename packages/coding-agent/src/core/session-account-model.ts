import { isDeepStrictEqual } from "node:util";
import { type Api, type Credential, defaultProviderAuthContext, type Model, type Provider } from "@bastani/atomic-ai";
import {
	parseGitHubCopilotDiscoveredModels,
	readGitHubCopilotAccountModelList,
} from "@bastani/atomic-ai/providers/github-copilot";
import { raceWithAbortSignal } from "../utils/abort.js";
import type { ModelsJsonProvider } from "./model-config.ts";
import { applyModelOverride } from "./provider-composer-internal.ts";
import { isCommandConfigValue } from "./resolve-config-value.ts";

/** Internal SDK capability, absent on a borrowed runtime from another package copy. */
export const readSessionAccountModel = Symbol("readSessionAccountModel");

export interface SessionAccountSource {
	provider: Provider;
	config?: ModelsJsonProvider;
	/** The runtime's current credential snapshot, if its store supplies one. */
	credential?: Credential;
	readCredential(signal: AbortSignal): Promise<Credential | undefined>;
}

interface AccountRequest {
	credential: Credential;
	baseUrl?: string;
}

/** Discovering a model must not rotate a login or start a credential command. */
async function accountRequest(source: SessionAccountSource, signal: AbortSignal): Promise<AccountRequest | undefined> {
	const stored = await source.readCredential(signal);
	signal.throwIfAborted();
	if (stored?.type === "oauth")
		return stored.access && stored.expires > Date.now() ? { credential: stored } : undefined;
	const { config, provider } = source;
	if (
		(!stored && config?.apiKey && isCommandConfigValue(config.apiKey)) ||
		Object.values(config?.headers ?? {}).some(isCommandConfigValue)
	)
		return undefined;
	const resolved = await provider.auth.apiKey?.resolve({
		credential: stored,
		ctx: defaultProviderAuthContext(),
		signal,
	});
	return resolved?.auth.apiKey
		? { credential: { type: "api_key", key: resolved.auth.apiKey }, baseUrl: provider.baseUrl }
		: undefined;
}

function sameCredential(a: Credential | undefined, b: Credential | undefined): boolean {
	if (!a || !b) return a === b;
	return a.type === "oauth"
		? b.type === "oauth" && a.access === b.access && a.enterpriseUrl === b.enterpriseUrl
		: b.type === "api_key" && a.key === b.key;
}

function sameSource(
	before: SessionAccountSource,
	after: SessionAccountSource | undefined,
): after is SessionAccountSource {
	return (
		after !== undefined &&
		sameCredential(before.credential, after.credential) &&
		before.provider.baseUrl === after.provider.baseUrl &&
		isDeepStrictEqual(before.config, after.config)
	);
}

/** The parser already admitted the exact chat row. Apply the same metadata layers as a locally restored row. */
function configuredModel(model: Model<Api>, baseUrl: string, config?: ModelsJsonProvider): Model<Api> {
	let selected = { ...model, baseUrl };
	if (config?.compat) selected = applyModelOverride(selected, { compat: config.compat });
	const baseContext = model.fastRoute
		? config?.modelOverrides?.[model.fastRoute.baseModelId]?.contextWindow
		: undefined;
	if (baseContext !== undefined) selected.contextWindow = baseContext;
	const override = config?.modelOverrides?.[model.id];
	return override ? applyModelOverride(selected, override) : selected;
}

/** One foreground GET for one session. Undefined means no usable answer; null means the account did not offer the ID. */
export async function readSelectedAccountModel(
	id: string,
	caller: AbortSignal | undefined,
	source: () => SessionAccountSource | undefined,
	localModel: () => Model<Api> | undefined,
): Promise<Model<Api> | null | undefined> {
	const deadline = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const initial = source();
		if (!initial || caller?.aborted) return undefined;
		const signal = caller ? AbortSignal.any([caller, deadline.signal]) : deadline.signal;
		timer = setTimeout(() => deadline.abort(), 15_000).unref();
		return await raceWithAbortSignal(
			(async () => {
				const request = await accountRequest(initial, signal);
				if (!request || !sameSource(initial, source()) || signal.aborted) return undefined;
				const list = await readGitHubCopilotAccountModelList({ ...request, signal });
				signal.throwIfAborted();
				const current = source();
				if (!list || !sameSource(initial, current)) return localModel();
				const account = await accountRequest(current, signal);
				signal.throwIfAborted();
				const local = localModel();
				if (local) return local;
				const latest = source();
				if (
					!sameSource(initial, latest) ||
					!account ||
					request.baseUrl !== account.baseUrl ||
					!sameCredential(request.credential, account.credential)
				)
					return undefined;
				const catalog = latest.provider.getAllModels?.() ?? latest.provider.getModels();
				const model = parseGitHubCopilotDiscoveredModels(list.raw, catalog).find(
					(candidate) => candidate.id === id,
				);
				return model ? configuredModel(model, list.baseUrl, latest.config) : null;
			})(),
			signal,
		);
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
		deadline.abort(); // Release the body even when the account refused the request at the headers.
	}
}
