import { EventEmitter } from "node:events";
import * as undici from "undici";
import { installCopilotResponseInterceptor } from "./copilot-gemini-reasoning.ts";

export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 600_000;

const originalGlobalFetch = globalThis.fetch;
let installedGlobalFetch: typeof globalThis.fetch | undefined;

export const HTTP_IDLE_TIMEOUT_CHOICES = [
	{ label: "30 sec", timeoutMs: 30_000 },
	{ label: "1 min", timeoutMs: 60_000 },
	{ label: "5 min", timeoutMs: 300_000 },
	{ label: "10 min", timeoutMs: 600_000 },
	{ label: "30 min", timeoutMs: 1_800_000 },
	{ label: "Disabled", timeoutMs: 0 },
] as const;

export function parseHttpIdleTimeoutMs(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return undefined;
	}
	return Math.floor(value);
}

export function formatHttpIdleTimeoutMs(timeoutMs: number): string {
	const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((item) => item.timeoutMs === timeoutMs);
	if (choice) {
		return choice.label;
	}
	return `${timeoutMs / 1000} sec`;
}

export function createHttpDispatcherOptions(timeoutMs: number): ConstructorParameters<typeof undici.EnvHttpProxyAgent>[0] {
	return {
		allowH2: false,
		// Undici defaults to a 10s connect timeout; disable it so slow
		// policy/proxy CONNECT establishment follows provider retry handling.
		connectTimeout: 0,
		bodyTimeout: timeoutMs,
		headersTimeout: timeoutMs,
		clientFactory: createUndiciClient,
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

	// Keep fetch and the dispatcher on the same undici implementation. Some Node
	// releases use a bundled fetch that can ignore the npm undici dispatcher or
	// otherwise behave differently from the configured dispatcher used by SDKs.
	// If a caller replaced fetch after module load, preserve that deliberate
	// override.
	const shouldInstallGlobals = installedGlobalFetch === undefined
		? globalThis.fetch === originalGlobalFetch
		: globalThis.fetch === installedGlobalFetch;
	if (shouldInstallGlobals) {
		undici.install?.();
		installedGlobalFetch = globalThis.fetch;
	}

	// Install Copilot response stream compatibility shims before provider parsers
	// consume the body. Idempotent and scoped inside each shim to the relevant
	// Copilot event-stream endpoint.
	installCopilotResponseInterceptor();
}
