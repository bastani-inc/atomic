import type { Api, AssistantMessage, Model, StreamOptions } from "@bastani/pi-ai";
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
): Promise<{ options: StreamOptions; observeFailure(error: AssistantMessage): void }> {
	let observedRateLimit = false;
	const usesFetch =
		!ownsTransport &&
		(FETCH_APIS.has(model.api) || (model.api === "openai-codex-responses" && options.transport === "sse"));
	if (usesFetch) {
		const originalFetch = options.fetch ?? globalThis.fetch;
		const gatedFetch: typeof fetch = Object.assign(
			async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
				const signal = init?.signal ?? (input instanceof Request ? input.signal : options.signal);
				await waitForAdmission(model.provider, signal ?? undefined);
				signal?.throwIfAborted();
				observedRateLimit = false;
				const response = await originalFetch(input, init);
				if (response.status === 429) {
					recordProviderRateLimit(model.provider, { status: 429, headers: response.headers });
					observedRateLimit = true;
				} else if (response.ok) recordProviderSuccess(model.provider);
				return response;
			},
			originalFetch,
		);
		options = { ...options, fetch: gatedFetch };
	} else {
		await waitForAdmission(model.provider, options.signal);
	}
	return {
		options,
		observeFailure(error) {
			if (observedRateLimit && error.stopReason === "error" && !isProviderRateLimit(error)) {
				error.errorMessage = `429 Too Many Requests: ${error.errorMessage ?? "provider rate limited the request"}`;
			}
			if (!isProviderRateLimit(error)) return;
			if (!observedRateLimit) recordProviderRateLimit(model.provider, error);
			markProviderRateLimitObserved(error);
		},
	};
}
