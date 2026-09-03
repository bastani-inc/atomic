export const CODEX_FAST_ROUTE_ORIGINATOR = "codex_cli_rs";
export const CODEX_FAST_ROUTE_HEADER = "x-codex-routing-hint";
const CODEX_FAST_ROUTE_REQUEST_MARKER_HEADER = "x-atomic-codex-fast-route";
const CODEX_FAST_ROUTE_PRIORITY_MARKER_VALUE = "priority";
const CODEX_FAST_ROUTE_NORMAL_MARKER_VALUE = "normal";

const CODEX_BACKEND_HOSTS = new Set(["chatgpt.com", "chat.openai.com"]);
const wrappedWebSockets = new WeakMap<typeof globalThis.WebSocket, typeof globalThis.WebSocket>();
const installedWebSocketWrappers = new WeakSet<typeof globalThis.WebSocket>();

function requestUrl(input: string | URL | Request): URL | undefined {
	try {
		if (typeof input === "string" || input instanceof URL) return new URL(input);
		return new URL(input.url);
	} catch {
		return undefined;
	}
}

export function isFirstPartyCodexHost(input: string | URL | Request): boolean {
	const url = requestUrl(input);
	return url !== undefined && CODEX_BACKEND_HOSTS.has(url.hostname.toLowerCase());
}
export function isFirstPartyCodexBaseUrl(input: string | URL | Request): boolean {
	const url = requestUrl(input);
	if (url === undefined || !isFirstPartyCodexHost(url)) return false;
	const path = url.pathname.replace(/\/+$/u, "");
	return path === "/backend-api" || path === "/backend-api/codex" || path === "/backend-api/codex/responses";
}

export function isFirstPartyCodexEndpoint(input: string | URL | Request): boolean {
	const url = requestUrl(input);
	return (
		url !== undefined &&
		isFirstPartyCodexHost(url) &&
		url.pathname.replace(/\/+$/u, "") === "/backend-api/codex/responses"
	);
}

function hasCodexPriorityRoutingHint(headers: Headers): boolean {
	return headers.get(CODEX_FAST_ROUTE_HEADER)?.endsWith(";tier=priority") === true;
}

function codexFastRouteRequestMarker(headers: Headers): "normal" | "priority" | undefined {
	const marker = headers.get(CODEX_FAST_ROUTE_REQUEST_MARKER_HEADER);
	return marker === CODEX_FAST_ROUTE_PRIORITY_MARKER_VALUE || marker === CODEX_FAST_ROUTE_NORMAL_MARKER_VALUE
		? marker
		: undefined;
}

export function markCodexFastRouteRequest(headers: Record<string, string | null>, priority: boolean): void {
	headers[CODEX_FAST_ROUTE_REQUEST_MARKER_HEADER] = priority
		? CODEX_FAST_ROUTE_PRIORITY_MARKER_VALUE
		: CODEX_FAST_ROUTE_NORMAL_MARKER_VALUE;
}

export function clearCodexFastRouteRequestMarker(headers: Record<string, string | null>): void {
	for (const name of Object.keys(headers)) {
		if (name.toLowerCase() === CODEX_FAST_ROUTE_REQUEST_MARKER_HEADER) delete headers[name];
	}
}

export function forceCodexFastRouteOriginator(
	_endpoint: string | URL | Request,
	headersInit: HeadersInit | undefined,
): Headers {
	const headers = new Headers(headersInit);
	const marker = codexFastRouteRequestMarker(headers);
	headers.delete(CODEX_FAST_ROUTE_REQUEST_MARKER_HEADER);
	if (marker === "priority" && hasCodexPriorityRoutingHint(headers)) {
		headers.set("originator", CODEX_FAST_ROUTE_ORIGINATOR);
	} else if (marker !== undefined) {
		headers.delete(CODEX_FAST_ROUTE_HEADER);
		if (headers.get("originator") === CODEX_FAST_ROUTE_ORIGINATOR) headers.set("originator", "pi");
	}
	return headers;
}

export function wrapCodexFastRouteFetch(fetchImplementation: typeof globalThis.fetch): typeof globalThis.fetch {
	return new Proxy(fetchImplementation, {
		apply(target, thisArg, args: Parameters<typeof globalThis.fetch>) {
			const [input, init] = args;
			if (!init?.headers) return Reflect.apply(target, thisArg, args);
			return Reflect.apply(target, thisArg, [
				input,
				{
					...init,
					headers: forceCodexFastRouteOriginator(input, init.headers),
				},
			]);
		},
	});
}

function findWebSocketOptionsIndex(args: readonly unknown[]): number | undefined {
	for (let index = 1; index < args.length; index += 1) {
		const value = args[index];
		if (typeof value === "object" && value !== null && "headers" in value) return index;
	}
	return undefined;
}

export function wrapCodexFastRouteWebSocket(
	WebSocketImplementation: typeof globalThis.WebSocket,
): typeof globalThis.WebSocket {
	if (installedWebSocketWrappers.has(WebSocketImplementation)) return WebSocketImplementation;
	const existing = wrappedWebSockets.get(WebSocketImplementation);
	if (existing !== undefined) return existing;

	const wrapped = new Proxy(WebSocketImplementation, {
		construct(target, args, newTarget) {
			const endpoint = args[0];
			const optionsIndex = findWebSocketOptionsIndex(args);
			if ((typeof endpoint !== "string" && !(endpoint instanceof URL)) || optionsIndex === undefined) {
				return Reflect.construct(target, args, newTarget);
			}
			const candidateOptions = args[optionsIndex] as { headers?: HeadersInit };
			const candidateHeaders = new Headers(candidateOptions.headers);
			if (codexFastRouteRequestMarker(candidateHeaders) === undefined) {
				return Reflect.construct(target, args, newTarget);
			}
			const options = candidateOptions;
			const nextArgs = [...args];
			nextArgs[optionsIndex] = {
				...options,
				headers: forceCodexFastRouteOriginator(endpoint, options.headers),
			};
			return Reflect.construct(target, nextArgs, newTarget);
		},
	}) as typeof globalThis.WebSocket;
	wrappedWebSockets.set(WebSocketImplementation, wrapped);
	installedWebSocketWrappers.add(wrapped);
	return wrapped;
}

export function installCodexFastRouteWebSocketIdentity(): void {
	if (typeof globalThis.WebSocket !== "function") return;
	globalThis.WebSocket = wrapCodexFastRouteWebSocket(globalThis.WebSocket);
}
