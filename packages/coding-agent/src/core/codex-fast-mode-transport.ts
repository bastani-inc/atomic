export const CODEX_FAST_MODE_ORIGINATOR = "codex_cli_rs";
export const CODEX_FAST_MODE_ROUTING_HEADER = "x-codex-routing-hint";

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
	return headers.get(CODEX_FAST_MODE_ROUTING_HEADER)?.endsWith(";tier=priority") === true;
}

export function forceCodexFastModeOriginator(
	endpoint: string | URL | Request,
	headersInit: HeadersInit | undefined,
): Headers {
	const headers = new Headers(headersInit);
	if (isFirstPartyCodexEndpoint(endpoint) && hasCodexPriorityRoutingHint(headers)) {
		headers.set("originator", CODEX_FAST_MODE_ORIGINATOR);
	}
	return headers;
}

export function wrapCodexFastModeFetch(fetchImplementation: typeof globalThis.fetch): typeof globalThis.fetch {
	return new Proxy(fetchImplementation, {
		apply(target, thisArg, args: Parameters<typeof globalThis.fetch>) {
			const [input, init] = args;
			if (!init?.headers) return Reflect.apply(target, thisArg, args);
			return Reflect.apply(target, thisArg, [
				input,
				{
					...init,
					headers: forceCodexFastModeOriginator(input, init.headers),
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

export function wrapCodexFastModeWebSocket(
	WebSocketImplementation: typeof globalThis.WebSocket,
): typeof globalThis.WebSocket {
	if (installedWebSocketWrappers.has(WebSocketImplementation)) return WebSocketImplementation;
	const existing = wrappedWebSockets.get(WebSocketImplementation);
	if (existing !== undefined) return existing;

	const wrapped = new Proxy(WebSocketImplementation, {
		construct(target, args, newTarget) {
			const endpoint = args[0];
			const optionsIndex = findWebSocketOptionsIndex(args);
			if (
				(typeof endpoint !== "string" && !(endpoint instanceof URL)) ||
				optionsIndex === undefined ||
				!isFirstPartyCodexEndpoint(endpoint)
			) {
				return Reflect.construct(target, args, newTarget);
			}
			const options = args[optionsIndex] as { headers?: HeadersInit };
			const nextArgs = [...args];
			nextArgs[optionsIndex] = {
				...options,
				headers: forceCodexFastModeOriginator(endpoint, options.headers),
			};
			return Reflect.construct(target, nextArgs, newTarget);
		},
	}) as typeof globalThis.WebSocket;
	wrappedWebSockets.set(WebSocketImplementation, wrapped);
	installedWebSocketWrappers.add(wrapped);
	return wrapped;
}

export function installCodexFastModeWebSocketIdentity(): void {
	if (typeof globalThis.WebSocket !== "function") return;
	globalThis.WebSocket = wrapCodexFastModeWebSocket(globalThis.WebSocket);
}
