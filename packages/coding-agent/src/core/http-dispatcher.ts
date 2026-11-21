import { EventEmitter } from "node:events";
import { resolveHttpsFallbackProxyUrl } from "@bastani/atomic-ai/utils/node-http-proxy";
import { recordProxyConnectionFailure } from "@bastani/atomic-ai/utils/tls-certificate";
import * as undici from "undici";
import { installCodexFastRouteWebSocketIdentity } from "./fast-model-routing-transport.ts";
import { SETTINGS_DEFAULTS } from "./settings-defaults.ts";

export const DEFAULT_HTTP_IDLE_TIMEOUT_MS: number = SETTINGS_DEFAULTS.httpIdleTimeoutMs;

const originalGlobalFetch = globalThis.fetch;
let installedGlobalFetch: typeof globalThis.fetch | undefined;

/**
 * Install the Undici web globals: npm Undici's on Node. Bun resolves `undici` to its own stand-in, which has no
 * `install` helper and whose fetch and WebSocket are Bun's; `configureHttpDispatcher` gives that fetch the dispatcher's
 * settings itself.
 */
function installUndiciGlobals(): void {
	if (typeof undici.install === "function") {
		undici.install();
		return;
	}
	Object.assign(globalThis, {
		fetch: undici.fetch,
		Headers: undici.Headers,
		Response: undici.Response,
		Request: undici.Request,
		FormData: undici.FormData,
		WebSocket: undici.WebSocket,
		CloseEvent: undici.CloseEvent,
		ErrorEvent: undici.ErrorEvent,
		MessageEvent: undici.MessageEvent,
		EventSource: undici.EventSource,
	});
}

/** Bun's own options for one `fetch()`: its socket idle timeout, and the proxy to use. */
type BunFetchInit = RequestInit & { timeout?: number | boolean; proxy?: string | URL | false | object };

/** The idle timeout the standalone binary's fetch gives Bun for each request; see `createBunFetch`. */
let bunIdleTimeoutMs: number = DEFAULT_HTTP_IDLE_TIMEOUT_MS;

/** The URL a fetch call asks for. */
function requestUrl(input: Parameters<typeof globalThis.fetch>[0]): string | URL {
	return typeof input === "string" || input instanceof URL ? input : input.url;
}

/**
 * The fetch of the standalone binary. There `undici` is Bun's own stand-in, which ignores the dispatcher and its options,
 * and fetch is Bun's. For each request that does not set them itself, this fetch gives Bun what the dispatcher does on
 * Node.js: `httpIdleTimeoutMs` as Bun's socket idle timeout (none when it is disabled), and, for an `https:` request with
 * no https proxy set, the http proxy, which Node.js uses and Bun on its own does not. Bun still exempts the hosts
 * `NO_PROXY` names. The timeout is read at each request, so a fetch kept from before the setting changed follows it.
 */
function createBunFetch(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
	return Object.assign((input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
		const given = init as BunFetchInit | undefined;
		const timeout = given?.timeout === undefined ? (bunIdleTimeoutMs === 0 ? false : bunIdleTimeoutMs) : undefined;
		const proxy = given?.proxy === undefined ? resolveHttpsFallbackProxyUrl(requestUrl(input))?.href : undefined;
		if (timeout === undefined && proxy === undefined) return fetch(input, init);
		const added: BunFetchInit = {
			...(timeout === undefined ? {} : { timeout }),
			...(proxy === undefined ? {} : { proxy }),
		};
		if (init === undefined || init === null) return fetch(input, added);
		// The request's own options are read from `init` itself, as Bun reads them: inherited or not enumerable,
		// getters with `init` as their receiver, and only the ones Bun asks for. Only Bun's two are added, on a separate
		// object, so a frozen `init` that sets either to undefined is never asked to report another value.
		const options = new Proxy<RequestInit>(
			{},
			{
				get: (_holder, key) =>
					Object.hasOwn(added, key) ? added[key as keyof BunFetchInit] : Reflect.get(init, key, init),
				has: (_holder, key) => Object.hasOwn(added, key) || Reflect.has(init, key),
			},
		);
		return fetch(input, options);
	}, fetch);
}

const DURATION_STRING_PATTERN = /^(\d+)(ms|s|m|h)$/i;

function parseDurationString(value: string): number | undefined {
	const match = DURATION_STRING_PATTERN.exec(value);
	if (!match) return undefined;
	const amount = Number(match[1]);
	const unit = match[2].toLowerCase();
	const multiplier = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000;
	const milliseconds = amount * multiplier;
	return Number.isFinite(milliseconds) ? milliseconds : undefined;
}

export const HTTP_IDLE_TIMEOUT_CHOICES = [
	{ label: "30 sec", timeoutMs: 30_000 },
	{ label: "1 min", timeoutMs: 60_000 },
	{ label: "5 min", timeoutMs: 300_000 },
	{ label: "10 min", timeoutMs: 600_000 },
	{ label: "30 min", timeoutMs: 1_800_000 },
	{ label: "Disabled", timeoutMs: 0 },
] as const;

export function parseHttpIdleTimeoutMs(value: unknown): number | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.toLowerCase() === "disabled") return 0;
		if (trimmed.length === 0) return undefined;
		const durationMs = parseDurationString(trimmed);
		if (durationMs !== undefined) return durationMs;
		return parseHttpIdleTimeoutMs(Number(trimmed));
	}
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
	return Math.floor(value);
}

export function formatHttpIdleTimeoutMs(timeoutMs: number): string {
	const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((item) => item.timeoutMs === timeoutMs);
	if (choice) {
		return choice.label;
	}
	return `${timeoutMs / 1000} sec`;
}

export function applyHttpProxySettings(httpProxy: string | undefined): void {
	const proxy = httpProxy?.trim();
	if (!proxy) return;
	process.env.HTTP_PROXY ??= proxy;
	process.env.HTTPS_PROXY ??= proxy;
}

export function createHttpDispatcherOptions(
	timeoutMs: number,
): ConstructorParameters<typeof undici.EnvHttpProxyAgent>[0] {
	return {
		allowH2: false,
		// Keep HTTP origins on CONNECT tunnels as they were before Undici 8.7.
		proxyTunnel: true,
		// Undici defaults to a 10s connect timeout; disable it so slow
		// policy/proxy CONNECT establishment follows provider retry handling.
		connectTimeout: 0,
		bodyTimeout: timeoutMs,
		headersTimeout: timeoutMs,
		clientFactory: createUndiciProxyClient,
		factory: createUndiciOriginDispatcher,
	};
}

const ignoreUndiciDispatcherError = (_error: unknown): void => {};

// Undici can emit an internal Client "error" while terminating a mid-stream
// fetch body. The body stream still rejects through reader.read(); this listener
// only prevents EventEmitter's unhandled "error" special case from crashing.
function withUndiciErrorListener<T extends undici.Dispatcher>(dispatcher: T): T {
	if (dispatcher instanceof EventEmitter) {
		EventEmitter.prototype.on.call(dispatcher, "error", ignoreUndiciDispatcherError);
	}
	return dispatcher;
}

function createUndiciClient(origin: string | URL, options: object): undici.Dispatcher {
	return withUndiciErrorListener(new undici.Client(origin, options as undici.Client.Options));
}

/**
 * The client a proxy agent builds for the proxy itself, with the connector that reaches the proxy: an error that
 * connector fails with, such as a certificate the proxy showed, is the proxy's, not the endpoint's, which the proxy never
 * reached. Each one is recorded as the proxy's, so a refused certificate names the proxy.
 */
function createUndiciProxyClient(proxy: string | URL, options: object): undici.Dispatcher {
	const { connect } = options as undici.Client.Options;
	if (typeof connect !== "function") return createUndiciClient(proxy, options);
	const connectToProxy: undici.buildConnector.connector = (connectOptions, callback) =>
		connect(connectOptions, (...result) => {
			if (result[0] !== null) recordProxyConnectionFailure(result[0], proxy);
			callback(...result);
		});
	return createUndiciClient(proxy, { ...options, connect: connectToProxy });
}

function createUndiciOriginDispatcher(origin: string | URL, options: object): undici.Dispatcher {
	const dispatcherOptions = options as undici.Pool.Options;
	if (dispatcherOptions.connections === 1) {
		return createUndiciClient(origin, dispatcherOptions);
	}
	return withUndiciErrorListener(
		new undici.Pool(origin, {
			...dispatcherOptions,
			factory: createUndiciClient,
		}),
	);
}

/**
 * Configure the global undici dispatcher used by fetch and SDK HTTP clients.
 *
 * Keep HTTP/2 disabled for now because some Node/undici combinations have
 * produced stream-reset crashes, and use a configurable idle timeout so stale
 * connections are eventually reclaimed while long-running requests remain
 * supported. Do not install a fixed connect-phase timeout here: under Pier and
 * other policy/proxy layers, CONNECT establishment can be slower than normal
 * internet egress and should surface through the provider/agent retry path.
 */
export function configureHttpDispatcher(timeoutMs: number = DEFAULT_HTTP_IDLE_TIMEOUT_MS): void {
	const normalizedTimeoutMs = parseHttpIdleTimeoutMs(timeoutMs);
	if (normalizedTimeoutMs === undefined) {
		throw new Error(`Invalid HTTP idle timeout: ${String(timeoutMs)}`);
	}

	const dispatcher = withUndiciErrorListener(
		new undici.EnvHttpProxyAgent(createHttpDispatcherOptions(normalizedTimeoutMs)),
	);
	undici.setGlobalDispatcher(dispatcher);
	bunIdleTimeoutMs = normalizedTimeoutMs;

	// Keep fetch and the dispatcher on the same undici implementation. Some Node
	// releases use a bundled fetch that can ignore the npm undici dispatcher or
	// otherwise behave differently from the configured dispatcher used by SDKs.
	// If a caller replaced fetch after module load, preserve that deliberate
	// override.
	const shouldInstallGlobals =
		installedGlobalFetch === undefined
			? globalThis.fetch === originalGlobalFetch
			: globalThis.fetch === installedGlobalFetch;
	if (shouldInstallGlobals) {
		installUndiciGlobals();
		// Bun's `undici` stand-in ignores the dispatcher just configured: its fetch is given the same settings itself.
		if (typeof process.versions.bun === "string") globalThis.fetch = createBunFetch(globalThis.fetch);
		installedGlobalFetch = globalThis.fetch;
		// Undici replaces the WebSocket constructor pi-ai caches on first use.
		// The wrapper only rewrites a shared Codex request carrying Atomic's
		// final-payload routing marker, so all other handshakes stay unchanged.
		installCodexFastRouteWebSocketIdentity();
	}
}
