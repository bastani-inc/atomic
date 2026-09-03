/**
 * AI Gateway transport over the Workers AI binding.
 *
 * pi's Cloudflare AI Gateway support speaks HTTPS
 * (`gateway.ai.cloudflare.com/v1/{account}/{gateway}/{provider}/...`, see `api/cloudflare.ts`),
 * which needs a Cloudflare API token even when the caller is a Worker in the gateway's own
 * account.
 *
 * `createGatewayBindingFetch` returns a {@link FetchFunction} backed by the binding's plain
 * `env.AI.fetch()` passthrough. Requests are forwarded untouched, so methods, headers, query
 * strings, non-JSON bodies, and streaming bodies retain native fetch semantics. Models using
 * that route should point their `baseUrl` at
 * `https://workers-binding.ai/ai-gateway/gateways/{gateway}/{provider}`.
 *
 * For compatibility with older Workers runtimes and Atomic consumers whose structural binding
 * exposes only `gateway(id).run(...)`, the established universal-endpoint translation remains a
 * fallback. Current bindings with `fetch()` never use that shim.
 */

import type { FetchFunction } from "../types.ts";

/**
 * Structural type for the Workers AI binding's gateway surface (`env.AI`), so this
 * module does not depend on `@cloudflare/workers-types`. Any real `Ai` binding satisfies it.
 */
export interface AiGatewayBinding {
	/** Unique member of the Workers AI binding. */
	aiGatewayLogId?: string | null;
	/** Present at runtime but not yet declared by `@cloudflare/workers-types`. */
	fetch?(input: Request | string | URL, init?: RequestInit): Promise<Response>;
	/** Legacy universal-endpoint surface retained for source compatibility. */
	gateway?(id: string): AiGatewayBindingGateway;
}

export interface AiGatewayBindingGateway {
	run(data: AiGatewayUniversalRequestLike, options?: { signal?: AbortSignal }): Promise<Response>;
}

/** One universal-endpoint request entry, as accepted by `AiGateway.run()`. */
export interface AiGatewayUniversalRequestLike {
	provider: string;
	endpoint: string;
	headers: Record<string, string>;
	query: unknown;
}

/**
 * Placeholder value for auth headers on binding-routed requests. API implementations
 * require an API key or a recognized auth header (`authorization`, `x-api-key`,
 * `cf-aig-authorization`) before dispatch; binding calls are pre-authenticated, so pass
 * `cf-aig-authorization: Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}` to satisfy
 * the check. On the plain `fetch()` path, the gateway recognizes and strips the sentinel; the
 * legacy `gateway().run()` fallback strips it before calling the binding. Pair it with
 * `Authorization: null` / `x-api-key: null` so the SDKs' placeholder auth headers never reach
 * the gateway, which would treat a request-supplied auth header as a BYOK provider key that
 * overrides its stored keys — the same as it would over HTTPS.
 */
export const CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL = "cloudflare-gateway-binding";

export interface GatewayBindingFetchOptions {
	/** The Workers AI binding (e.g. `env.AI`). */
	binding: AiGatewayBinding;
	/**
	 * Request prefix used only by the legacy `gateway().run()` fallback, without a trailing slash.
	 * A binding with `fetch()` forwards requests untouched and ignores this option.
	 */
	baseUrl: string;
	/** Gateway name used only by the legacy `gateway().run()` fallback. */
	gateway: string;
}

// Removed only by the legacy gateway().run() fallback: hop-by-hop/derived headers and
// gateway auth. The plain binding.fetch() path forwards headers untouched; Cloudflare handles
// its sentinel there.
const STRIP_HEADERS = new Set(["content-length", "host", "cf-aig-authorization"]);

type FetchInput = Parameters<FetchFunction>[0];

/**
 * Create a `fetch` that routes AI Gateway requests through the Workers AI binding.
 * See the module docs for behavior and composition notes.
 */
export function createGatewayBindingFetch(options: GatewayBindingFetchOptions): FetchFunction {
	const { binding, gateway } = options;
	if (typeof binding.fetch === "function") {
		const bindingFetch = binding.fetch.bind(binding);
		return (input, init) => bindingFetch(input, init);
	}
	const legacyGateway = binding.gateway?.bind(binding);
	if (!legacyGateway) {
		throw new TypeError("createGatewayBindingFetch: the AI binding does not expose fetch()");
	}
	// Prefix matching runs on URL-normalized components (origin + pathname), not raw strings:
	// dot segments resolve away and fragments drop, matching what real fetch would put on the
	// wire, so a lexical variant can't split provider/endpoint differently than HTTPS would.
	const base = new URL(options.baseUrl);
	const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;

	return async (input: FetchInput, init?: RequestInit): Promise<Response> => {
		const request = input instanceof Request ? input : undefined;
		const url = request ? request.url : input.toString();
		const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
		let parsed: URL | undefined;
		try {
			parsed = new URL(url);
		} catch {
			parsed = undefined;
		}
		// Out-of-prefix URLs are a configuration bug, not passthrough traffic: silently
		// forwarding would ship the auth sentinel to whatever host the URL names.
		if (parsed === undefined || parsed.origin !== base.origin || !parsed.pathname.startsWith(basePath)) {
			throw new Error(
				`createGatewayBindingFetch: ${method} ${url} is outside the configured gateway ` +
					`prefix (${base.origin}${basePath}); this fetch only serves its gateway-bound client`,
			);
		}

		// In-prefix requests the universal endpoint cannot express always reject: forwarding
		// them over HTTPS would send the sentinel to the gateway and fail with a misleading
		// auth error instead of naming the real problem. Callers that need such endpoints
		// route them over HTTPS with real gateway auth themselves.
		const unexpressible = (reason: string): never => {
			throw new Error(
				`createGatewayBindingFetch: cannot express ${method} ${url} as a universal ` +
					`gateway request (${reason}); route it over HTTPS with gateway auth instead`,
			);
		};
		if (method !== "POST") return unexpressible("only POST is supported");

		const rest = parsed.pathname.slice(basePath.length);
		const slash = rest.indexOf("/");
		if (slash <= 0) {
			return unexpressible("missing provider/endpoint path");
		}
		const provider = rest.slice(0, slash);
		// Keep the query string on the endpoint — it's part of what HTTPS would have sent.
		const endpoint = rest.slice(slash + 1) + parsed.search;

		const bodyText = await readBodyText(request, init);
		let query: unknown;
		try {
			query = bodyText === undefined ? undefined : JSON.parse(bodyText);
		} catch {
			return unexpressible("non-JSON body");
		}
		if (query === undefined) {
			return unexpressible("missing body");
		}

		const headers = collectHeaders(request, init);
		// Per the fetch spec an explicit `signal: null` in init clears a Request input's signal.
		const signal = init?.signal ?? (init && "signal" in init && init.signal === null ? undefined : request?.signal);
		return legacyGateway(gateway).run({ provider, endpoint, headers, query }, signal ? { signal } : {});
	};
}

async function readBodyText(request: Request | undefined, init?: RequestInit): Promise<string | undefined> {
	const body = init?.body;
	if (body === undefined || body === null) {
		// Per the fetch spec an explicit `body: null` in init clears a Request input's body.
		if (init && "body" in init && body === null) return undefined;
		if (request && request.body !== null) return request.clone().text();
		return undefined;
	}
	if (typeof body === "string") return body;
	if (body instanceof Uint8Array) return new TextDecoder().decode(body);
	if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));
	// URLSearchParams, FormData, Blob, ReadableStream in init: read via a Request wrapper.
	// Consuming a one-shot stream here is fine — unexpressible requests reject rather than
	// replay, so nothing downstream needs the body again.
	return new Request("http://body.local", {
		method: "POST",
		body,
		// The fetch spec requires `duplex: "half"` to construct a Request with a stream body
		// (Node's undici enforces it; it is ignored for the replayable body types). TypeScript's
		// RequestInit does not declare the field yet, hence the cast.
		duplex: "half",
	} as RequestInit).text();
}

// Entry header names are lowercased so case-variant duplicates collapse and stripping is
// uniform. Per the fetch spec, `init.headers` replaces a Request input's headers entirely.
function collectHeaders(request: Request | undefined, init?: RequestInit): Record<string, string> {
	const result: Record<string, string> = {};
	const add = (key: string, value: string) => {
		const name = key.toLowerCase();
		if (!STRIP_HEADERS.has(name)) result[name] = value;
	};
	const headers = init?.headers;
	if (headers === undefined) {
		if (request) {
			for (const [key, value] of request.headers) add(key, value);
		}
	} else if (headers instanceof Headers) {
		for (const [key, value] of headers) add(key, value);
	} else if (Array.isArray(headers)) {
		for (const [key, value] of headers) add(key, value);
	} else {
		for (const [key, value] of Object.entries(headers)) {
			if (value !== undefined) add(key, String(value));
		}
	}
	return result;
}
