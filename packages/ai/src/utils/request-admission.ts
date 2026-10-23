import type OpenAI from "openai";

interface FetchAdmission {
	beforeRequest(signal?: AbortSignal): Promise<void>;
	fetch: typeof globalThis.fetch;
}

const admissions = new WeakMap<typeof globalThis.fetch, FetchAdmission>();

export function createFetchWithAdmission(
	fetch: typeof globalThis.fetch,
	beforeRequest: FetchAdmission["beforeRequest"],
): typeof globalThis.fetch {
	const admittedFetch: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		await beforeRequest(init?.signal ?? (input instanceof Request ? input.signal : undefined));
		return fetch(input, init);
	}, fetch);
	admissions.set(admittedFetch, { beforeRequest, fetch });
	return admittedFetch;
}

export function wrapFetchPreservingAdmission(
	fetch: typeof globalThis.fetch,
	wrap: (fetch: typeof globalThis.fetch) => typeof globalThis.fetch,
): typeof globalThis.fetch {
	const admission = getFetchAdmission(fetch);
	if (!admission) return wrap(fetch);
	return createFetchWithAdmission(wrap(admission.fetch), admission.beforeRequest);
}

export function getFetchAdmission(fetch?: typeof globalThis.fetch): FetchAdmission | undefined {
	return fetch ? admissions.get(fetch) : undefined;
}

export async function admitFetch(
	fetch: typeof globalThis.fetch | undefined,
	signal?: AbortSignal,
): Promise<typeof globalThis.fetch> {
	const admission = getFetchAdmission(fetch);
	if (!admission) return fetch ?? globalThis.fetch;
	await admission.beforeRequest(signal);
	return admission.fetch;
}

export function admitOpenAIRequests<T extends Pick<OpenAI, "fetchWithTimeout">>(
	client: T,
	fetch?: typeof globalThis.fetch,
): T {
	const admission = getFetchAdmission(fetch);
	if (!admission) return client;
	const fetchWithTimeout = client.fetchWithTimeout;
	client.fetchWithTimeout = async function (url, init, ms, controller) {
		await admission.beforeRequest(init?.signal ?? controller.signal);
		return fetchWithTimeout.call(this, url, init, ms, controller);
	};
	return client;
}
