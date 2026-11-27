import { createHmac } from "node:crypto";
import type { Model, ProviderHeaders } from "../types.js";
import { transportFetch } from "../utils/tls-certificate.js";

const CLIENT_REQUEST_ID = "x-client-request-id";
const IDEMPOTENCY_KEY = "idempotency-key";

export function isOpenAITracingEndpoint(baseUrl: string): boolean {
	return URL.parse(baseUrl)?.origin === "https://api.openai.com";
}

/** Attach request identity to the serialized HTTP attempt without changing session affinity. */
export function openAIRequestFetch(
	model: Model<"openai-completions" | "openai-responses">,
	fetch: typeof globalThis.fetch | undefined,
	explicitHeaders: ProviderHeaders,
	logicalRequestId?: string,
): typeof globalThis.fetch {
	const send = transportFetch(fetch, true);
	const tracesRequests =
		isOpenAITracingEndpoint(model.baseUrl) &&
		!Object.keys(explicitHeaders).some((name) => name.toLowerCase() === CLIENT_REQUEST_ID);
	const idempotencySeed =
		model.compat?.sendIdempotencyKey === true ? (logicalRequestId ?? crypto.randomUUID()) : undefined;
	if (!tracesRequests && idempotencySeed === undefined) return send;

	return Object.assign((input: Parameters<typeof send>[0], init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		if (idempotencySeed !== undefined && typeof init?.body === "string") {
			const url = input instanceof Request ? input.url : String(input);
			// Retry the same operation, not a changed payload, target or credential. Stainless
			// adds its own per-attempt fields; tracing headers don't identify the operation either.
			const stableHeaders = [...headers].filter(
				([name]) => !name.startsWith("x-stainless-") && name !== CLIENT_REQUEST_ID && name !== IDEMPOTENCY_KEY,
			);
			const key = createHmac("sha256", idempotencySeed)
				.update(JSON.stringify([model.provider, model.id, url, stableHeaders]))
				.update(init.body)
				.digest("hex");
			headers.set(IDEMPOTENCY_KEY, key);
		}
		if (tracesRequests) headers.set(CLIENT_REQUEST_ID, crypto.randomUUID());
		return send(input, { ...init, headers });
	}, send);
}
