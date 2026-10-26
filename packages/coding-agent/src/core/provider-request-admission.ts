import { AsyncLocalStorage } from "node:async_hooks";
import type { Api, AssistantMessage, Model, StreamOptions } from "@bastani/pi-ai";
import { createFetchWithAdmission } from "@bastani/pi-ai/utils/request-admission";
import {
	isProviderLimitFailure,
	isProviderRateLimit,
	markProviderRateLimitObserved,
	type ProviderLimitScope,
	providerLimitScope,
	recordProviderRateLimit,
	recordProviderRetryHint,
	recordProviderSuccess,
	tryAdmitProviderRequest,
} from "./provider-rate-limits.js";

const FETCH_APIS = new Set([
	"anthropic-messages",
	"openai-completions",
	"openai-responses",
	"azure-openai-responses",
	"mistral-conversations",
	"pi-messages",
]);

interface StreamAdmissionState {
	observedRateLimit: boolean;
	observedQuotaExhaustion: boolean;
	/** The limit the observed 429/402 response was recorded against. */
	observedScope?: ProviderLimitScope;
}

const streamAdmission = new AsyncLocalStorage<StreamAdmissionState>();
const admittedFetches = new WeakMap<typeof fetch, Map<string, typeof fetch>>();

async function responseText(response: Response): Promise<string> {
	try {
		return await response.clone().text();
	} catch {
		return "";
	}
}

function providerFetch(provider: string, model: string, originalFetch: typeof fetch): typeof fetch {
	let providers = admittedFetches.get(originalFetch);
	if (!providers) {
		providers = new Map();
		admittedFetches.set(originalFetch, providers);
	}
	const key = `${provider}/${model}`;
	const cached = providers.get(key);
	if (cached) return cached;
	const observedFetch: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const state = streamAdmission.getStore();
		if (state) {
			state.observedRateLimit = false;
			state.observedQuotaExhaustion = false;
			state.observedScope = undefined;
		}
		const response = await originalFetch(input, init);
		if (response.status === 429 || response.status === 402) {
			// The body can name the model whose limit was hit, which scopes the cooldown to that model.
			const body = await responseText(response);
			const failure = { status: response.status, headers: response.headers, message: body, body };
			recordProviderRateLimit(provider, failure, model);
			if (state) state.observedScope = providerLimitScope(provider, failure, model);
			if (state && response.status === 429) state.observedRateLimit = true;
			if (state && response.status === 402) state.observedQuotaExhaustion = true;
		} else if (response.ok) recordProviderSuccess(provider, model);
		return response;
	}, originalFetch);
	const admitted = createFetchWithAdmission(observedFetch, (signal) => waitForAdmission(provider, model, signal));
	providers.set(key, admitted);
	return admitted;
}

function sleepForAdmission(ms: number, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	return new Promise((resolve, reject) => {
		const cleanup = () => signal?.removeEventListener("abort", abort);
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		const abort = () => {
			clearTimeout(timer);
			cleanup();
			reject(signal?.reason ?? new Error("Provider request aborted"));
		};
		signal?.addEventListener("abort", abort, { once: true });
	});
}

async function waitForAdmission(provider: string, model: string, signal?: AbortSignal): Promise<void> {
	while (true) {
		signal?.throwIfAborted();
		const delay = tryAdmitProviderRequest(provider, model);
		if (delay === 0) return;
		await sleepForAdmission(Math.min(delay, 60_000), signal);
	}
}

export async function admitProviderStream(
	model: Model<Api>,
	options: StreamOptions,
	ownsTransport: boolean,
): Promise<{ options: StreamOptions; run<T>(invoke: () => T): T; observeFailure(error: AssistantMessage): void }> {
	const state: StreamAdmissionState = { observedRateLimit: false, observedQuotaExhaustion: false };
	const usesFetch =
		!ownsTransport &&
		(FETCH_APIS.has(model.api) || (model.api === "openai-codex-responses" && options.transport === "sse"));
	if (usesFetch) {
		options = { ...options, fetch: providerFetch(model.provider, model.id, options.fetch ?? globalThis.fetch) };
	} else {
		await waitForAdmission(model.provider, model.id, options.signal);
	}
	return {
		options,
		run: (invoke) => streamAdmission.run(state, invoke),
		observeFailure(error) {
			if (state.observedRateLimit && error.stopReason === "error" && !isProviderRateLimit(error)) {
				error.errorMessage = `429 Too Many Requests: ${error.errorMessage ?? "provider rate limited the request"}`;
			}
			if (!isProviderLimitFailure(error)) return;
			let scope = state.observedScope;
			if (scope === undefined) {
				recordProviderRateLimit(model.provider, error, model.id);
				scope = providerLimitScope(model.provider, error, model.id);
			} else recordProviderRetryHint(model.provider, error, scope);
			markProviderRateLimitObserved(error, scope);
		},
	};
}
