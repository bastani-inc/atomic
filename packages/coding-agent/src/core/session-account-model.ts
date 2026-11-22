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
export const sessionAccountCheckpoint = Symbol("sessionAccountCheckpoint");

export interface SessionAccountSource {
	provider: Provider;
	config?: ModelsJsonProvider;
	/** The runtime's current credential snapshot, if its store supplies one. */
	credential?: Credential;
	version?: string;
}

interface AccountRequest {
	credential: Credential;
	baseUrl?: string;
}

/** Discovering a model must not rotate a login or start a credential command. */
async function accountRequest(source: SessionAccountSource, signal: AbortSignal): Promise<AccountRequest | undefined> {
	const stored = source.credential;
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
		before.version === after.version &&
		sameCredential(before.credential, after.credential) &&
		before.provider.baseUrl === after.provider.baseUrl &&
		isDeepStrictEqual(before.config, after.config)
	);
}

/** The parser already admitted the exact chat row. Apply the same metadata layers as a locally restored row. */
function configuredModel(model: Model<Api>, baseUrl: string, config?: ModelsJsonProvider): Model<Api> {
	// trim() can leave a short display name backed by megabytes of discarded padding. Preserve every UTF-16 code unit.
	let selected = { ...model, name: Buffer.from(model.name, "utf16le").toString("utf16le"), baseUrl };
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
	let deadline: AbortController | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		if (caller?.aborted) return undefined;
		const initial = source();
		if (!initial) return undefined;
		const controller = new AbortController();
		deadline = controller;
		const signal = caller ? AbortSignal.any([caller, controller.signal]) : controller.signal;
		timer = setTimeout(() => controller.abort(), 15_000);
		const request = await raceWithAbortSignal(accountRequest(initial, signal), signal);
		if (!request || !sameSource(initial, source()) || signal.aborted) return undefined;
		let selected: Model<Api> | null;
		{
			const list = await raceWithAbortSignal(readGitHubCopilotAccountModelList({ ...request, signal }), signal);
			signal.throwIfAborted();
			const current = source();
			if (!list || !sameSource(initial, current)) return localModel();
			const catalog = current.provider.getAllModels?.() ?? current.provider.getModels();
			const model = parseGitHubCopilotDiscoveredModels(list.raw, catalog).find((candidate) => candidate.id === id);
			selected = model ? configuredModel(model, list.baseUrl, current.config) : null;
		}
		const account = await raceWithAbortSignal(accountRequest(initial, signal), signal);
		signal.throwIfAborted();
		const local = localModel();
		if (local) return local;
		return sameSource(initial, source()) &&
			account &&
			request.baseUrl === account.baseUrl &&
			sameCredential(request.credential, account.credential)
			? selected
			: undefined;
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
		deadline?.abort(); // Release the body even when the account refused the request at the headers.
	}
}
