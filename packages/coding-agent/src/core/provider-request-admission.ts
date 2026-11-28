import type { Api, AssistantMessage, Model, RetryDeadline, StreamOptions } from "@bastani/atomic-ai";
import { ProviderRetryTransport } from "@bastani/atomic-ai/utils/provider-retry";
import {
	readBoundedErrorBody,
	remainingRequestTimeoutMs,
	responseWithoutBody,
} from "@bastani/atomic-ai/utils/provider-waits/timeout";
import { createFetchWithAdmission } from "@bastani/atomic-ai/utils/request-admission";
import { RetryDeadlineError, retryDeadlineReached } from "@bastani/atomic-ai/utils/retry-sleep";
import { setLongTimeoutAt, setWallTimeoutAt } from "@bastani/atomic-timers";
import { raceWithAbortSignal } from "../utils/abort.js";
import { asyncScope } from "./async-scope.ts";
import { observeFailedProviderAccount, providerAccount } from "./provider-account.ts";
import {
	isProviderLimitFailure,
	markProviderRateLimitObserved,
	type ProviderLimitScope,
	providerAdmissionTurn,
	providerLimitScope,
	providerRequestGate,
	recordProviderRateLimit,
	recordProviderRetryHint,
	recordProviderServerRetryHint,
	recordProviderSuccess,
	tryAdmitProviderRequest,
} from "./provider-rate-limits.js";
import { SETTINGS_DEFAULTS } from "./settings-defaults.ts";

const FETCH_APIS = new Set([
	"anthropic-messages",
	"openai-completions",
	"openai-responses",
	"azure-openai-responses",
	"mistral-conversations",
	"pi-messages",
]);

/** The stream being admitted is itself a retry of an assistant call, even if SDK retries are disabled. */
export const assistantRetryAttempt = Symbol("assistantRetryAttempt");
/** Admission has a separate clock: a slow queue must not spend the HTTP request's own timeout. */
export const providerAdmissionTimeout = Symbol("providerAdmissionTimeout");

export interface ProviderAdmissionOptions {
	[assistantRetryAttempt]?: boolean;
	[providerAdmissionTimeout]?: number;
}

interface StreamAdmissionState {
	outerRetryDeadline?: RetryDeadline;
	callerSignal?: AbortSignal;
	timeoutMs?: number;
	admissionTimeoutMs?: number;
	observedRateLimit: boolean;
	observedQuotaExhaustion: boolean;
	observedServerCooldown?: boolean;
	/** The limit the observed 429/402 response was recorded against. */
	observedScope?: ProviderLimitScope;
}

const streamAdmission = asyncScope<StreamAdmissionState>();
const admittedFetches = new WeakMap<typeof fetch, Map<string, { account?: string; fetch: typeof fetch }>>();

function providerFetch(provider: string, model: string, originalFetch: typeof fetch, account?: string): typeof fetch {
	let providers = admittedFetches.get(originalFetch);
	if (!providers) {
		providers = new Map();
		admittedFetches.set(originalFetch, providers);
	}
	const key = `${provider}/${model}`;
	const cached = providers.get(key);
	if (cached && cached.account === account) return cached.fetch;
	const observedFetch: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const state = streamAdmission.getStore();
		if (state) {
			if (retryDeadlineReached(state.outerRetryDeadline)) throw new RetryDeadlineError();
			state.observedRateLimit = false;
			state.observedQuotaExhaustion = false;
			state.observedServerCooldown = false;
			state.observedScope = undefined;
		}
		const startedAt = performance.now();
		const response = await originalFetch(input, init);
		const serverError = response.status >= 500 && response.status < 600;
		if (response.status === 429 || response.status === 402 || serverError) {
			// The body may name the affected model or carry retry advice. Don't wait beyond the request budget.
			const signal = init?.signal ?? (input instanceof Request ? input.signal : state?.callerSignal);
			const remaining = remainingRequestTimeoutMs(startedAt, state?.timeoutMs);
			const body = await readBoundedErrorBody(response, signal, remaining).catch(() => "");
			const failure = { status: response.status, headers: response.headers, message: body, body };
			if (serverError) {
				const recorded = recordProviderServerRetryHint(provider, failure, account, response.status);
				if (state) state.observedServerCooldown = recorded;
			} else {
				recordProviderRateLimit(provider, failure, model, account);
				if (state) {
					state.observedScope = providerLimitScope(provider, failure, model, account);
					state.observedRateLimit = response.status === 429;
					state.observedQuotaExhaustion = response.status === 402;
				}
			}
			if (body === undefined) {
				signal?.throwIfAborted();
				return responseWithoutBody(response);
			}
		} else if (response.ok) recordProviderSuccess(provider, model, account);
		return response;
	}, originalFetch);
	const admitted = createFetchWithAdmission(observedFetch, (signal, retryDeadline) => {
		const state = streamAdmission.getStore();
		return waitForAdmission(
			provider,
			model,
			signal ?? state?.callerSignal,
			state?.outerRetryDeadline ?? retryDeadline,
			state?.admissionTimeoutMs,
			account,
		);
	});
	providers.set(key, { account, fetch: admitted });
	return admitted;
}

function sleepForAdmission(at: number, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	return new Promise((resolve, reject) => {
		const cleanup = () => signal?.removeEventListener("abort", abort);
		const timer = setWallTimeoutAt(() => {
			cleanup();
			resolve();
		}, at);
		const abort = () => {
			timer.clear();
			cleanup();
			reject(signal?.reason ?? new Error("Provider request aborted"));
		};
		signal?.addEventListener("abort", abort, { once: true });
	});
}

async function waitForAdmission(
	provider: string,
	model: string,
	callerSignal?: AbortSignal,
	retryDeadline?: RetryDeadline,
	timeoutMs: number = SETTINGS_DEFAULTS.httpIdleTimeoutMs,
	account?: string,
): Promise<void> {
	const controller = new AbortController();
	const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
	const retryAt = typeof retryDeadline === "number" ? retryDeadline : retryDeadline?.at;
	const timeout = timeoutMs > 0 ? timeoutMs : SETTINGS_DEFAULTS.httpIdleTimeoutMs;
	const admissionAt = performance.now() + timeout;
	const retryExpiresFirst = retryAt !== undefined && retryAt <= admissionAt;
	const deadline = retryExpiresFirst ? retryAt : admissionAt;
	const retryError = retryExpiresFirst ? new RetryDeadlineError() : undefined;
	const expire = () => {
		if (!signal.aborted) controller.abort(retryError ?? new Error(`Provider admission timed out after ${timeout}ms`));
	};
	const check = () => {
		if (performance.now() >= deadline) expire();
		signal.throwIfAborted();
	};
	const timer = setLongTimeoutAt(expire, deadline);
	try {
		let queued = false;
		while (true) {
			check();
			const turn = providerAdmissionTurn(provider, model, queued, signal);
			if (turn) {
				await turn;
				check();
			}
			const delay = tryAdmitProviderRequest(provider, model, account);
			if (delay === 0) {
				const gate = providerRequestGate();
				if (gate) await raceWithAbortSignal(Promise.resolve(gate(provider, model, signal)), signal);
				// A gate can settle on the same tick as Esc or the deadline; never dispatch in that case.
				check();
				return;
			}
			await sleepForAdmission(Date.now() + Math.min(delay, 60_000), signal);
			queued = true;
		}
	} catch (error) {
		if (retryError && error === retryError && typeof retryDeadline === "object") retryDeadline.onExpired();
		throw error;
	} finally {
		timer.clear();
	}
}

export async function admitProviderStream(
	model: Model<Api>,
	options: StreamOptions & ProviderAdmissionOptions,
	ownsTransport: boolean,
): Promise<{
	options: StreamOptions;
	run<T>(invoke: () => T): T;
	observeFailure(error: AssistantMessage): void;
	observeSuccess(): void;
}> {
	const account = providerAccount(model, options);
	const state: StreamAdmissionState = {
		observedRateLimit: false,
		observedQuotaExhaustion: false,
		callerSignal: options.signal,
		timeoutMs: options.timeoutMs,
		admissionTimeoutMs: options[providerAdmissionTimeout],
	};
	if (options[assistantRetryAttempt]) state.outerRetryDeadline = options.retryDeadline;
	const usesFetch =
		!ownsTransport &&
		(FETCH_APIS.has(model.api) || (model.api === "openai-codex-responses" && options.transport === "sse"));
	if (usesFetch) {
		options = {
			...options,
			fetch: providerFetch(model.provider, model.id, options.fetch ?? globalThis.fetch, account),
		};
	} else {
		await waitForAdmission(
			model.provider,
			model.id,
			options.signal,
			state.outerRetryDeadline,
			state.admissionTimeoutMs,
			account,
		);
		// Google's SDK accepts fetch but, unlike the OpenAI adapters, is admitted before the stream is opened.
		if (
			state.outerRetryDeadline !== undefined &&
			!ownsTransport &&
			(model.api === "google-generative-ai" || model.api === "google-vertex")
		) {
			options = {
				...options,
				fetch: ProviderRetryTransport.forRetriedCall(state.outerRetryDeadline, options.fetch),
			};
		}
	}
	return {
		options,
		run: (invoke) => {
			if (retryDeadlineReached(state.outerRetryDeadline)) throw new RetryDeadlineError();
			return streamAdmission.run(state, invoke);
		},
		observeFailure(error) {
			if (account !== undefined) observeFailedProviderAccount(error, account);
			if (state.observedRateLimit && error.stopReason === "error" && !isProviderLimitFailure(error)) {
				error.errorMessage = `429 Too Many Requests: ${error.errorMessage ?? "provider rate limited the request"}`;
			}
			if (!isProviderLimitFailure(error)) {
				if (!state.observedServerCooldown) recordProviderServerRetryHint(model.provider, error, account);
				return;
			}
			let scope = state.observedScope;
			if (scope === undefined) {
				recordProviderRateLimit(model.provider, error, model.id, account);
				scope = providerLimitScope(model.provider, error, model.id, account);
			} else recordProviderRetryHint(model.provider, error, scope);
			markProviderRateLimitObserved(error, scope);
		},
		observeSuccess() {
			recordProviderSuccess(model.provider, model.id, account);
		},
	};
}
