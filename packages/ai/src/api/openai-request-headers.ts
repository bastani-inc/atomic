import { createHmac } from "node:crypto";
import type { JsonObject, Model, ProviderHeaders } from "../types.js";
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
	const send = transportFetch(fetch);
	const tracesRequests =
		isOpenAITracingEndpoint(model.baseUrl) &&
		!Object.keys(explicitHeaders).some((name) => name.toLowerCase() === CLIENT_REQUEST_ID);
	const tracesInBody =
		model.api === "openai-completions" && (model.provider === "zai" || model.provider === "zai-coding-cn");
	const idempotencySeed =
		model.compat?.sendIdempotencyKey === true ? (logicalRequestId ?? crypto.randomUUID()) : undefined;
	if (!tracesRequests && !tracesInBody && idempotencySeed === undefined) return send;

	return Object.assign((input: Parameters<typeof send>[0], init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		const body = init?.body;
		const params: JsonObject | undefined = tracesInBody && typeof body === "string" ? JSON.parse(body) : undefined;
		// The tracing ID describes the attempt, not the operation being fingerprinted.
		if (params) delete params.request_id;
		if (idempotencySeed !== undefined && typeof body === "string") {
			const url = input instanceof Request ? input.url : String(input);
			// Retry the same operation, not a changed payload, target or credential. Stainless
			// adds its own per-attempt fields; tracing headers don't identify the operation either.
			const stableHeaders = [...headers].filter(
				([name]) => !name.startsWith("x-stainless-") && name !== CLIENT_REQUEST_ID && name !== IDEMPOTENCY_KEY,
			);
			const key = createHmac("sha256", idempotencySeed)
				.update(JSON.stringify([model.provider, model.id, url, stableHeaders]))
				.update(params ? JSON.stringify(params) : body)
				.digest("hex");
			headers.set(IDEMPOTENCY_KEY, key);
		}
		if (tracesRequests) headers.set(CLIENT_REQUEST_ID, crypto.randomUUID());
		if (params) params.request_id = crypto.randomUUID();
		return send(input, { ...init, headers, body: params ? JSON.stringify(params) : body });
	}, send);
}
