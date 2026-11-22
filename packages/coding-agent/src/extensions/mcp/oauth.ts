/**
 * OAuth sign-in for remote MCP servers.
 *
 * Connections never start a browser flow on their own. They send the stored access token and, after
 * a 401, try the stored refresh token. When that is not possible they fail with
 * `McpOAuthAuthorizationRequiredError`, and the user signs in through `/mcp`, which runs
 * the authorization code flow (PKCE, dynamic client registration) against a loopback callback.
 *
 * Credentials live in `<agent-dir>/mcp-auth.json`, keyed by server name and URL.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { oauthErrorHtml, oauthSuccessHtml } from "@bastani/atomic-ai/utils/oauth-page";
import lockfile from "proper-lockfile";
import { APP_NAME, getAgentDir } from "../../config.js";
import { type AuthStorageBackend, FileAuthStorageBackend } from "../../core/auth-storage.ts";
import { type AsyncAuthStorageReads, asyncAuthStorageReads } from "../../core/auth-storage-backends.ts";
import { releaseLock } from "../../core/lock-release.ts";
import { waitForLock } from "../../core/lock-wait.ts";
import { mcpNamespace } from "../../core/mcp-servers.ts";
import type { AuthProvider, McpFetch } from "./client/index.js";
import {
	authorizeMcp,
	McpOAuthAuthorizationRequiredError,
	McpOAuthProvider,
	type McpOAuthState,
	type McpOAuthStateStore,
	MemoryOAuthStateStore,
	type OAuthCallback,
	type OAuthCallbackPage,
	OAuthCallbackServer,
	type OAuthChallenge,
	type OAuthClientInformationMixed,
	parseWwwAuthenticate,
	stepUpScope,
} from "./client/oauth/index.js";
import { redactAuthorizationUrlForDisplay, redactOAuthErrorText } from "./client/oauth/redact.js";

const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/callback";
/** Redirect URI for refreshes when none is stored. Refreshing never redirects the user. */
const FALLBACK_REDIRECT_URL = `http://${CALLBACK_HOST}${CALLBACK_PATH}`;
/** Access tokens this close to expiry are refreshed before they are sent. */
const REFRESH_SKEW_MS = 30_000;
/**
 * Bounds each request to the authorization server, so an unresponsive one cannot hold the refresh lock,
 * delay shutdown, or keep a sign-in waiting for long.
 */
const OAUTH_REQUEST_TIMEOUT_MS = 15_000;
/** A refresh lock that its holder stopped renewing (the process was killed) is taken over after this. */
const REFRESH_LOCK_STALE_MS = 20_000;
/** How long to wait for one other process's refresh: longer than a stale lock lives. */
const REFRESH_LOCK_WAIT_MS = 25_000;
const REFRESH_LOCK_RETRY_MS = 100;

export interface McpOAuthSettings {
	clientId?: string;
	/** Already resolved. */
	clientSecret?: string;
	callbackPort?: number;
	/** Loopback redirect URI; see `McpOAuthConfig.callbackUrl`. */
	callbackUrl?: string;
	/** Scopes to request, separated by spaces. */
	scope?: string;
	/** `client_name` for dynamic client registration. Default: `APP_NAME`. */
	clientName?: string;
	/** See `McpOAuthConfig.authServerMetadataUrl`. */
	authServerMetadataUrl?: URL;
}

/** Where the loopback callback server listens and the redirect URI it serves. */
interface CallbackSettings {
	/** Address to listen on. */
	host: string;
	/** Host name in the redirect URI. */
	redirectHost: string;
	port: number | undefined;
	path: string;
	/** The exact redirect URI, when the port is fixed. */
	fixedRedirectUrl: string | undefined;
}

function callbackSettings(settings: McpOAuthSettings): CallbackSettings {
	const url = new URL(settings.callbackUrl ?? `http://${CALLBACK_HOST}${CALLBACK_PATH}`);
	const address = url.hostname.replace(/^\[|\]$/g, "");
	const port = url.port ? Number(url.port) : settings.callbackPort;
	let fixedRedirectUrl: string | undefined;
	// A configured URI with a port is sent exactly as written, since servers compare it as a string.
	if (url.port) fixedRedirectUrl = settings.callbackUrl;
	else if (port !== undefined) {
		url.port = String(port);
		fixedRedirectUrl = url.href;
	}
	return {
		// `localhost` is served on 127.0.0.1; browsers fall back to it when ::1 refuses.
		host: address === "localhost" ? CALLBACK_HOST : address,
		redirectHost: address,
		port,
		path: url.pathname,
		fixedRedirectUrl,
	};
}

/** Scopes of both lists, each once. */
function mergeScopes(...scopes: (string | undefined)[]): string | undefined {
	const merged = [...new Set(scopes.flatMap((scope) => scope?.split(/\s+/).filter(Boolean) ?? []))];
	return merged.length > 0 ? merged.join(" ") : undefined;
}

// A token-free tombstone keeps revocation durable, including for other processes' late sign-ins.
type StoredState = McpOAuthState & { credentialGeneration?: string };
type StoredStates = Record<string, StoredState>;
const refreshQueues = new WeakMap<AuthStorageBackend, Map<string, Promise<unknown>>>();
const writeQueues = new WeakMap<AuthStorageBackend, Promise<unknown>>();

function parseStates(content: string | undefined): StoredStates {
	if (!content?.trim()) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		throw new Error("Failed to parse MCP OAuth credentials file");
	}
	return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as StoredStates) : {};
}

function serializeStates(states: StoredStates): string {
	return `${JSON.stringify(states, null, 2)}\n`;
}

/**
 * Keys of a server's state: by name and URL, so servers sharing a URL keep separate accounts, and the
 * legacy key by URL alone, written by older versions.
 */
function storeKeys(name: string, serverUrl: string): { key: string; legacyKey: string } {
	const legacyKey = String(new URL(serverUrl));
	return { key: `${mcpNamespace(name)}|${legacyKey}`, legacyKey };
}

export interface McpOAuthServerStore extends McpOAuthStateStore {
	/** Run `fn` while no other process refreshes the server's tokens. */
	withRefreshLock<T>(fn: () => Promise<T>): Promise<T>;
	/** Capture ownership for one flow; logout invalidates its subsequent reads and writes. */
	fenced(): McpOAuthStateStore;
}

/** Per-server OAuth state (client registration, tokens, pending PKCE verifier) in `mcp-auth.json`. */
export class McpOAuthCredentialStore {
	private readonly backend: AuthStorageBackend;
	private readonly reads: AsyncAuthStorageReads;
	/** Directory for the refresh lock files. Without one, refreshes are only serialized in this process. */
	private readonly lockDir: string | undefined;

	constructor(backend?: AuthStorageBackend, lockDir?: string) {
		this.backend = backend ?? new FileAuthStorageBackend(join(getAgentDir(), "mcp-auth.json"));
		this.reads = asyncAuthStorageReads(this.backend);
		this.lockDir = backend ? lockDir : getAgentDir();
	}

	forServer(name: string, serverUrl: string): McpOAuthServerStore {
		const { key, legacyKey } = storeKeys(name, serverUrl);
		const scoped = (fenced: boolean): McpOAuthStateStore => {
			const generation = fenced
				? this.inWriteTurn(() => this.readAsync()).then(
						(initial) => (initial[key] ?? initial[legacyKey])?.credentialGeneration,
					)
				: undefined;
			generation?.catch(() => {});
			const check = (state: StoredState | undefined, owned: string | undefined) => {
				if (fenced && state?.credentialGeneration !== owned) throw new McpSignInCancelledError();
			};
			return {
				load: async () => {
					const owned = await generation;
					const state = (await this.claimLegacyAsync(key, legacyKey))[key];
					check(state, owned);
					if (!state) return undefined;
					const { credentialGeneration: _generation, ...value } = state;
					return Object.keys(value).length > 1 ? value : undefined;
				},
				save: async (state) => {
					const owned = await generation;
					await this.writeAsync((states) => {
						check(states[key], owned);
						states[key] = { ...state, credentialGeneration: states[key]?.credentialGeneration };
					});
				},
			};
		};
		return {
			...scoped(false),
			fenced: () => scoped(true),
			withRefreshLock: (fn) => this.withRefreshLock(key, fn),
		};
	}

	/**
	 * A lock file per server. When the process exits, proper-lockfile removes the locks it holds; when
	 * it is killed, the lock goes stale because it is no longer renewed, and the next process takes it over.
	 */
	private async withRefreshLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
		let queues = refreshQueues.get(this.backend);
		if (!queues) {
			queues = new Map();
			refreshQueues.set(this.backend, queues);
		}
		const previous = queues.get(key) ?? Promise.resolve();
		const running = previous.catch(() => undefined).then(() => this.withFileRefreshLock(key, fn));
		queues.set(key, running);
		try {
			return await running;
		} finally {
			if (queues.get(key) === running) queues.delete(key);
		}
	}

	private async withFileRefreshLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
		if (!this.lockDir) return fn();
		await mkdir(this.lockDir, { recursive: true, mode: 0o700 });
		const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
		const lockPath = join(this.lockDir, `mcp-auth-refresh-${hash}`);
		const release = await waitForLock(
			(fs) =>
				lockfile.lock(lockPath, {
					realpath: false,
					stale: REFRESH_LOCK_STALE_MS,
					fs,
					retries: 0,
					// The default throws from a timer. A lost lock at worst lets two refreshes overlap.
					onCompromised: () => {},
				}),
			{
				lockPath: `${lockPath}.lock`,
				staleMs: REFRESH_LOCK_STALE_MS,
				holderWaitMs: REFRESH_LOCK_WAIT_MS,
				pollMinMs: REFRESH_LOCK_RETRY_MS,
				pollMaxMs: REFRESH_LOCK_RETRY_MS,
				retryable: (error) => (error as NodeJS.ErrnoException).code === "ELOCKED",
				stuck: (error) => error as Error,
				contended: (error, waitedMs) =>
					Object.assign(
						new Error(
							`Other processes kept refreshing this server's tokens for ${Math.round(waitedMs / 1000)} s`,
							{
								cause: error,
							},
						),
						{ code: "ELOCKED" },
					),
			},
		);
		try {
			return await fn();
		} finally {
			await releaseLock(release, lockPath);
		}
	}

	/**
	 * The first server to load legacy state takes it over; others with the same URL sign in again. Reads without the
	 * lock and takes it only when there is legacy state to move; in turn with this process's other reads and writes.
	 */
	private claimLegacyAsync(key: string, legacyKey: string): Promise<StoredStates> {
		return this.inWriteTurn(async () => {
			const states = await this.readAsync();
			if (states[key] || !states[legacyKey]) return states;
			return this.backend.withLockAsync(async (current) => {
				const states = parseStates(current);
				if (states[key] || !states[legacyKey]) return { result: states };
				states[key] = states[legacyKey];
				delete states[legacyKey];
				return { result: states, next: serializeStates(states) };
			});
		});
	}

	/** The stored tokens of a server, for noticing sign-ins done by another process. Does not take over legacy state. */
	tokens(name: string, serverUrl: string): McpOAuthState["tokens"] {
		const { key, legacyKey } = storeKeys(name, serverUrl);
		const states = this.read();
		return (states[key] ?? states[legacyKey])?.tokens;
	}

	async tokensAsync(name: string, serverUrl: string): Promise<McpOAuthState["tokens"]> {
		const { key, legacyKey } = storeKeys(name, serverUrl);
		const states = await this.inWriteTurn(() => this.readAsync());
		return (states[key] ?? states[legacyKey])?.tokens;
	}

	/** Serialized logout: waits for rotated tokens to be saved before revoking the grant. */
	removeAsync(name: string, serverUrl: string): Promise<boolean> {
		const { key } = storeKeys(name, serverUrl);
		return this.withRefreshLock(key, async () => {
			const revocation = revoke(name, serverUrl);
			await this.writeAsync(revocation.update);
			return revocation.removed();
		});
	}

	/**
	 * Synchronous revocation also fences late writes; logout callers should prefer removeAsync. Also removes
	 * legacy state the server would take over.
	 */
	remove(name: string, serverUrl: string): boolean {
		const revocation = revoke(name, serverUrl);
		this.write(revocation.update);
		return revocation.removed();
	}

	/**
	 * Reads without the lock when the backend can: writers replace the file whole, so a read sees the last complete
	 * file, and readers never wait for or fail on another process's lock.
	 */
	private read(): StoredStates {
		if (this.backend.read) return parseStates(this.backend.read());
		return this.backend.withLock((current) => ({ result: parseStates(current) }));
	}

	private async readAsync(): Promise<StoredStates> {
		if (this.reads.readAsync) return parseStates(await this.reads.readAsync());
		return this.backend.withLockAsync(async (current) => ({ result: parseStates(current) }));
	}

	private write(update: (states: StoredStates) => void): void {
		this.backend.withLock((current) => {
			const states = parseStates(current);
			update(states);
			return { result: undefined, next: serializeStates(states) };
		});
	}

	private writeAsync(update: (states: StoredStates) => void): Promise<void> {
		return this.inWriteTurn(() =>
			this.backend.withLockAsync(async (current) => {
				const states = parseStates(current);
				update(states);
				return { result: undefined, next: serializeStates(states) };
			}),
		);
	}

	private inWriteTurn<T>(write: () => Promise<T>): Promise<T> {
		const previous = writeQueues.get(this.backend) ?? Promise.resolve();
		const running = previous.catch(() => undefined).then(write);
		writeQueues.set(this.backend, running);
		return running;
	}
}

function revoke(name: string, serverUrl: string): { update: (states: StoredStates) => void; removed: () => boolean } {
	const { key, legacyKey } = storeKeys(name, serverUrl);
	const hasCredentials = (state: StoredState | undefined) =>
		state !== undefined &&
		Object.keys(state).some((field) => field !== "serverUrl" && field !== "credentialGeneration");
	let removed = false;
	return {
		update: (states) => {
			const own = states[key];
			const legacy = own === undefined ? states[legacyKey] : undefined;
			removed = hasCredentials(own) || hasCredentials(legacy);
			if (legacy) delete states[legacyKey];
			states[key] = { serverUrl: legacyKey, credentialGeneration: randomUUID() };
		},
		removed: () => removed,
	};
}

/** `fetch` with `OAUTH_REQUEST_TIMEOUT_MS` per request, on top of the request's own signal. */
function timedFetch(fetch: McpFetch = globalThis.fetch): McpFetch {
	return (input, init) => {
		const timeout = AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS);
		return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
	};
}

function registeredRedirectUrls(client: OAuthClientInformationMixed | undefined): string[] {
	return client && "redirect_uris" in client ? client.redirect_uris : [];
}

function createProvider(
	serverUrl: string,
	store: McpOAuthStateStore,
	settings: McpOAuthSettings,
	redirectUrl: string,
	onRedirect: (url: URL) => void,
): McpOAuthProvider {
	return new McpOAuthProvider({
		serverUrl,
		redirectUrl,
		clientMetadata: { client_name: settings.clientName ?? APP_NAME },
		clientId: settings.clientId,
		clientSecret: settings.clientSecret,
		store,
		onRedirect,
	});
}

export interface McpAuthProvider extends AuthProvider {
	/** Resolves when no refresh is running, so shutdown does not drop rotated tokens before they are saved. */
	settled(): Promise<void>;
}

/**
 * Auth provider for MCP connections: sends the stored access token and refreshes it when it is about
 * to expire or after a 401. Throws `McpOAuthAuthorizationRequiredError` when the user has to sign in,
 * including when the server asks for more scope (`insufficient_scope`). `onChallenge` receives the
 * server's `WWW-Authenticate` challenge so sign-in can use its resource metadata URL and scope.
 * `settings` is only called when a refresh is needed, so a secret that fails to resolve fails the
 * refresh instead of the whole connection setup.
 *
 * Many servers rotate refresh tokens, so two refreshes with the same refresh token lose the grant.
 * Requests in this process share one refresh, and other processes are kept out by the store's
 * refresh lock, held from reading the tokens to saving new ones. Tokens that changed meanwhile
 * (another process refreshed them, or the user signed in) are used without refreshing.
 */
export function createMcpAuthProvider(options: {
	serverUrl: string;
	store: McpOAuthServerStore;
	settings: () => McpOAuthSettings | Promise<McpOAuthSettings>;
	onChallenge: (challenge: OAuthChallenge) => void;
}): McpAuthProvider {
	const { serverUrl, store } = options;
	let refreshing: Promise<void> | undefined;

	/** Replace `staleToken`, the access token that expired or was rejected. */
	const refresh = (staleToken: string | undefined, fetch: McpFetch = globalThis.fetch, challenge?: OAuthChallenge) => {
		refreshing ??= store
			.withRefreshLock(async () => {
				const flowStore = store.fenced();
				const state = await flowStore.load();
				if (state?.tokens?.access_token !== staleToken) return;
				if (!state?.tokens?.refresh_token) throw new McpOAuthAuthorizationRequiredError();
				const settings = await options.settings();
				const redirectUrl =
					callbackSettings(settings).fixedRedirectUrl ??
					registeredRedirectUrls(state.clientInformation)[0] ??
					FALLBACK_REDIRECT_URL;
				const provider = createProvider(serverUrl, flowStore, settings, redirectUrl, () => {});
				// Refreshes the tokens, or reports that a new sign-in is needed. Not cancellable: a refresh the
				// server answered may have rotated the refresh token, so its answer must be saved.
				const result = await authorizeMcp(provider, {
					serverUrl,
					resourceMetadataUrl: challenge?.resourceMetadataUrl,
					authorizationServerMetadataUrl: settings.authServerMetadataUrl,
					scope: challenge?.scope,
					fetch: timedFetch(fetch),
				});
				if (result === "REDIRECT") throw new McpOAuthAuthorizationRequiredError();
			})
			.finally(() => {
				refreshing = undefined;
			});
		return refreshing;
	};

	return {
		token: async () => {
			await refreshing?.catch(() => undefined);
			const state = await store.load();
			const token = state?.tokens?.access_token;
			const expired = state?.tokensExpireAt !== undefined && state.tokensExpireAt - REFRESH_SKEW_MS <= Date.now();
			if (!expired || !state?.tokens?.refresh_token) return token;
			// Failures fall through: the request goes out with the old token and a 401 decides what happens.
			await refresh(token).catch(() => undefined);
			return (await store.load())?.tokens?.access_token;
		},
		onUnauthorized: async (context) => {
			const challenge = parseWwwAuthenticate(context.response.headers.get("www-authenticate"));
			options.onChallenge(challenge);
			// A refresh keeps the granted scope, so more scope needs a new sign-in.
			if (challenge.error === "insufficient_scope") throw new McpOAuthAuthorizationRequiredError();
			await refresh(context.token, context.fetch, challenge);
		},
		settled: async () => {
			await refreshing?.catch(() => undefined);
		},
	};
}

export interface McpSignInPrompt {
	/** Show the authorization URL to the user and open it in a browser. */
	showAuthorizationUrl(url: URL): void;
	/**
	 * Ask for the redirect URL from the browser address bar, for when the browser cannot reach the
	 * loopback callback (for example over SSH). Aborted once the callback arrives or the sign-in is
	 * cancelled. Resolves to `undefined` or an empty string when the user cancels.
	 */
	promptForRedirectUrl(signal: AbortSignal): Promise<string | undefined>;
}

export class McpSignInCancelledError extends Error {
	constructor() {
		super("Sign-in cancelled");
		this.name = "McpSignInCancelledError";
	}
}

type AuthorizationResponse = Pick<OAuthCallback, "code" | "iss">;

function responseFromRedirectUrl(
	input: string,
	state: string,
	redirectUrl: URL,
	extraSecrets: readonly (string | undefined)[] = [],
): AuthorizationResponse {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		throw new Error("Expected the full redirect URL from the browser address bar");
	}
	if (url.origin !== redirectUrl.origin || url.pathname !== redirectUrl.pathname) {
		throw new Error("The redirect URL does not match this sign-in's redirect URI");
	}
	const error = url.searchParams.get("error");
	if (error) {
		throw new Error(
			redactOAuthErrorText(url.searchParams.get("error_description") || error, [
				url.searchParams.get("code") ?? undefined,
				...extraSecrets,
			]),
		);
	}
	if (url.searchParams.get("state") !== state) throw new Error("The redirect URL belongs to a different sign-in");
	const code = url.searchParams.get("code");
	if (!code) throw new Error("The redirect URL does not contain an authorization code");
	return { code, iss: url.searchParams.get("iss") ?? undefined };
}

/**
 * Wait for the browser callback or a pasted redirect URL, whichever comes first. Aborting `signal`
 * aborts the prompt, which then cancels the sign-in.
 */
async function waitForAuthorizationResponse(
	callback: OAuthCallbackServer,
	state: string,
	redirectUrl: URL,
	prompt: McpSignInPrompt,
	signal: AbortSignal | undefined,
	extraSecrets: readonly (string | undefined)[] = [],
): Promise<AuthorizationResponse> {
	const controller = new AbortController();
	const promptSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
	const fromBrowser = callback.waitForCallback(state, redirectUrl.pathname, extraSecrets);
	const fromUser = prompt.promptForRedirectUrl(promptSignal).then((input) => {
		if (!input?.trim()) throw new McpSignInCancelledError();
		return responseFromRedirectUrl(input, state, redirectUrl, extraSecrets);
	});
	try {
		return await Promise.race([fromBrowser, fromUser]);
	} finally {
		// The losing side rejects once the prompt is aborted or the callback server closes.
		controller.abort();
		fromBrowser.catch(() => undefined);
		fromUser.catch(() => undefined);
	}
}

/** Listen on `port`, or on a free port when it is taken and not `required`. */
async function listenForCallback(
	settings: CallbackSettings,
	port: number | undefined,
	required: boolean,
): Promise<OAuthCallbackServer> {
	const options = {
		host: settings.host,
		redirectHost: settings.redirectHost,
		path: settings.path,
		renderPage: (page: OAuthCallbackPage) =>
			page.ok
				? oauthSuccessHtml("Signed in to the MCP server. You may now close this page.")
				: oauthErrorHtml(page.message, page.details),
	};
	try {
		return await OAuthCallbackServer.listen({ ...options, port: port ?? 0 });
	} catch (error) {
		if (required || port === undefined) throw error;
		return OAuthCallbackServer.listen(options);
	}
}

/**
 * Sign in to an MCP server. Uses the stored refresh token when possible, or the tokens a refresh that
 * finished meanwhile saved; otherwise runs the browser authorization code flow. The client and tokens are saved to `store` once the sign-in completes.
 * Aborting `signal` stops the sign-in at any step with `McpSignInCancelledError`; requests to the
 * authorization server are also time-limited.
 */
export async function signInMcpServer(options: {
	serverUrl: string;
	store: McpOAuthServerStore;
	settings: McpOAuthSettings;
	challenge?: OAuthChallenge;
	prompt: McpSignInPrompt;
	signal?: AbortSignal;
}): Promise<void> {
	const { serverUrl, settings, signal } = options;
	if (signal?.aborted) throw new McpSignInCancelledError();
	const store = options.store.fenced();
	const stored = await store.load();
	const stepUp = options.challenge?.error === "insufficient_scope";
	const callbackOptions = callbackSettings(settings);
	// Reuse the port of the registered redirect URI so the registered client stays valid.
	const registered = registeredRedirectUrls(stored?.clientInformation)[0];
	const preferredPort =
		callbackOptions.port ?? (registered ? Number(new URL(registered).port) || undefined : undefined);
	const callback = await listenForCallback(callbackOptions, preferredPort, callbackOptions.port !== undefined);
	const redirectUrl = callbackOptions.fixedRedirectUrl ?? callback.redirectUrl;
	// The sign-in works on its own copy of the state, so overlapping sign-ins to the server (for example
	// in two sessions) each keep their client, PKCE verifier, and `state` parameter. Only a completed
	// sign-in saves its client and tokens, and a failed one leaves the stored ones alone.
	const pending = new MemoryOAuthStateStore();
	if (stored) {
		const next: McpOAuthState = { ...stored };
		// Every sign-in gets a fresh `state` parameter and PKCE verifier.
		delete next.oauthState;
		delete next.codeVerifier;
		// A registered client cannot use another redirect URI, and its tokens belong to it.
		if (!settings.clientId && !registeredRedirectUrls(stored.clientInformation).includes(redirectUrl)) {
			delete next.clientInformation;
			delete next.tokens;
			delete next.tokensExpireAt;
		}
		pending.save(next);
	}
	const complete = async () => {
		const { oauthState: _state, codeVerifier: _verifier, ...credentials } = pending.load() ?? { serverUrl };
		await store.save(credentials);
	};
	try {
		let authorizationUrl: URL | undefined;
		const provider = createProvider(serverUrl, pending, settings, redirectUrl, (url) => {
			authorizationUrl = url;
		});
		const flow = {
			serverUrl,
			fetch: timedFetch(),
			signal,
			resourceMetadataUrl: options.challenge?.resourceMetadataUrl,
			authorizationServerMetadataUrl: settings.authServerMetadataUrl,
			// A server asking for more scope gets it on top of the configured scope and, since the challenge
			// may list only the missing scopes, on top of the scope granted so far.
			scope: mergeScopes(
				settings.scope,
				stepUp ? stepUpScope(stored?.tokens?.scope, options.challenge?.scope) : options.challenge?.scope,
			),
		};
		// A refresh keeps the granted scope; a server asking for more needs the browser flow.
		const skipRefresh = stepUp;
		const authorize = async () => {
			if ((await authorizeMcp(provider, { ...flow, skipRefresh })) !== "AUTHORIZED") return false;
			await complete();
			return true;
		};
		// Refresh tokens may rotate, so a refresh runs under the lock that connection refreshes take, and
		// tokens another holder saved meanwhile are kept instead of refreshed again with a used refresh token.
		const authorized = skipRefresh
			? await authorize()
			: await options.store.withRefreshLock(
					async () => (await store.load())?.tokens?.access_token !== stored?.tokens?.access_token || authorize(),
				);
		if (authorized) return;
		if (!authorizationUrl) throw new Error("OAuth flow did not produce an authorization URL");

		const state = await provider.state();
		const signInSecrets = [settings.clientSecret, pending.load()?.codeVerifier];
		const safeAuthorizationUrl = new URL(redactAuthorizationUrlForDisplay(authorizationUrl, signInSecrets));
		const authorizationRedirectUrl = new URL(safeAuthorizationUrl.searchParams.get("redirect_uri") ?? redirectUrl);
		options.prompt.showAuthorizationUrl(safeAuthorizationUrl);
		const { code, iss } = await waitForAuthorizationResponse(
			callback,
			state,
			authorizationRedirectUrl,
			options.prompt,
			signal,
			signInSecrets,
		);
		await authorizeMcp(provider, { ...flow, authorizationCode: code, iss });
		await complete();
	} catch (error) {
		// Aborted requests fail with the signal's reason; report them as the cancellation they are.
		if (signal?.aborted) throw new McpSignInCancelledError();
		throw error;
	} finally {
		await callback.close();
	}
}
