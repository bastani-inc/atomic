import { AsyncLocalStorage } from "node:async_hooks";
import type { Api, AssistantMessage, Model, StreamOptions } from "@bastani/pi-ai";
import { createFetchWithAdmission } from "@bastani/pi-ai/utils/request-admission";
import {
	isProviderRateLimit,
	markProviderRateLimitObserved,
	recordProviderRateLimit,
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
}

const streamAdmission = new AsyncLocalStorage<StreamAdmissionState>();
const admittedFetches = new WeakMap<typeof fetch, Map<string, typeof fetch>>();

function providerFetch(provider: string, originalFetch: typeof fetch): typeof fetch {
	let providers = admittedFetches.get(originalFetch);
	if (!providers) {
		providers = new Map();
		admittedFetches.set(originalFetch, providers);
	}
	const cached = providers.get(provider);
	if (cached) return cached;
	const observedFetch: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const state = streamAdmission.getStore();
		if (state) state.observedRateLimit = false;
		const response = await originalFetch(input, init);
		if (response.status === 429) {
			recordProviderRateLimit(provider, { status: 429, headers: response.headers });
			if (state) state.observedRateLimit = true;
		} else if (response.ok) recordProviderSuccess(provider);
		return response;
	}, originalFetch);
	const admitted = createFetchWithAdmission(observedFetch, (signal) => waitForAdmission(provider, signal));
	providers.set(provider, admitted);
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

async function waitForAdmission(provider: string, signal?: AbortSignal): Promise<void> {
	while (true) {
		signal?.throwIfAborted();
		const delay = tryAdmitProviderRequest(provider);
		if (delay === 0) return;
		await sleepForAdmission(Math.min(delay, 60_000), signal);
	}
}

export async function admitProviderStream(
	model: Model<Api>,
	options: StreamOptions,
	ownsTransport: boolean,
): Promise<{ options: StreamOptions; run<T>(invoke: () => T): T; observeFailure(error: AssistantMessage): void }> {
	const state: StreamAdmissionState = { observedRateLimit: false };
	const usesFetch =
		!ownsTransport &&
		(FETCH_APIS.has(model.api) || (model.api === "openai-codex-responses" && options.transport === "sse"));
	if (usesFetch) {
		options = { ...options, fetch: providerFetch(model.provider, options.fetch ?? globalThis.fetch) };
	} else {
		await waitForAdmission(model.provider, options.signal);
	}
	return {
		options,
		run: (invoke) => streamAdmission.run(state, invoke),
		observeFailure(error) {
			if (state.observedRateLimit && error.stopReason === "error" && !isProviderRateLimit(error)) {
				error.errorMessage = `429 Too Many Requests: ${error.errorMessage ?? "provider rate limited the request"}`;
			}
			if (!isProviderRateLimit(error)) return;
			if (!state.observedRateLimit) recordProviderRateLimit(model.provider, error);
			markProviderRateLimitObserved(error);
		},
	};
}
