/*
 * Adapted from modelcontextprotocol/typescript-sdk v1.29.0 src/client/auth.ts.
 * Copyright (c) 2024 Anthropic, PBC. Licensed under MIT; see LICENSES/.
 * Modified to remove SDK/Zod dependencies and use WebCrypto for PKCE.
 */

import type { AuthProvider, McpFetch, UnauthorizedContext } from "../auth-provider.js";
import { isObject } from "../protocol/jsonrpc.js";
import {
	discoverAuthorizationServerMetadata,
	discoverOAuthServerInfo,
	parseWwwAuthenticate,
	selectResource,
} from "./discovery.js";
import {
	McpOAuthAuthorizationRequiredError,
	OAuthError,
	OAuthInsecureEndpointError,
	OAuthIssuerMismatchError,
	OAuthRegistrationError,
	OAuthTemporarilyUnavailableError,
} from "./errors.js";
import { extractHeaderSecrets, redactOAuthErrorText, redactUrlForDisplay, stripUrlUserinfoAndHash } from "./redact.js";
import {
	type AuthorizationServerMetadata,
	isHttpUrl,
	type OAuthClientInformation,
	type OAuthClientInformationFull,
	type OAuthClientInformationMixed,
	type OAuthClientMetadata,
	type OAuthDiscoveryState,
	type OAuthTokens,
	parseClientInformation,
	parseOAuthTokens,
} from "./types.js";

export type AddClientAuthentication = (
	headers: Headers,
	params: URLSearchParams,
	url: string | URL,
	metadata?: AuthorizationServerMetadata,
) => void | Promise<void>;

/** A Client ID Metadata Document URL and a redirect URI it lists. */
export interface OAuthClientMetadataDocument {
	url: string;
	redirectUrl: string;
}

export interface OAuthClientProvider {
	readonly redirectUrl: string | URL;
	readonly clientMetadata: OAuthClientMetadata;
	/** Called without stored client information. The caller checks server support; the document is not stored. */
	clientMetadataDocument?(metadata: AuthorizationServerMetadata | undefined): OAuthClientMetadataDocument | undefined;
	state?(): string | Promise<string>;
	clientInformation(): OAuthClientInformationMixed | undefined | Promise<OAuthClientInformationMixed | undefined>;
	saveClientInformation?(information: OAuthClientInformationMixed): void | Promise<void>;
	tokens(): OAuthTokens | undefined | Promise<OAuthTokens | undefined>;
	saveTokens(tokens: OAuthTokens): void | Promise<void>;
	redirectToAuthorization(url: URL): void | Promise<void>;
	saveCodeVerifier(verifier: string): void | Promise<void>;
	codeVerifier(): string | Promise<string>;
	addClientAuthentication?: AddClientAuthentication;
	invalidateCredentials?(kind: "all" | "client" | "tokens" | "verifier" | "discovery"): void | Promise<void>;
	saveDiscoveryState?(state: OAuthDiscoveryState): void | Promise<void>;
	discoveryState?(): OAuthDiscoveryState | undefined | Promise<OAuthDiscoveryState | undefined>;
}

export interface OAuthFlowOptions {
	serverUrl: string | URL;
	authorizationCode?: string;
	/** `iss` parameter of the authorization response that delivered `authorizationCode` (RFC 9207). */
	iss?: string;
	scope?: string;
	resourceMetadataUrl?: URL;
	/**
	 * Authorization server metadata document to use instead of discovery, for servers that advertise a
	 * wrong authorization server or none. It is trusted as configured. Must use https, except on loopback.
	 */
	authorizationServerMetadataUrl?: URL;
	fetch?: McpFetch;
	/** Aborts every request of the flow. Requests have no time limit of their own; combine with a timeout as needed. */
	signal?: AbortSignal;
	skipIssuerValidation?: boolean;
	/**
	 * Go straight to the authorization redirect instead of refreshing stored tokens, for example when the
	 * server asks for scopes the current grant lacks (a refresh keeps the old scope).
	 */
	skipRefresh?: boolean;
}

export type OAuthFlowResult = "AUTHORIZED" | "REDIRECT";
type ClientAuthMethod = "client_secret_basic" | "client_secret_post" | "none";

export interface TokenRequestOptions {
	metadata?: AuthorizationServerMetadata;
	clientInformation: OAuthClientInformationMixed;
	resource?: string;
	addClientAuthentication?: AddClientAuthentication;
	fetch?: McpFetch;
	signal?: AbortSignal;
}

function loopback(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function applicationType(redirectUris: readonly string[]): "native" | "web" {
	const native = redirectUris.some((uri) => {
		if (!URL.canParse(uri)) return false;
		const url = new URL(uri);
		return (url.protocol !== "http:" && url.protocol !== "https:") || loopback(url.hostname);
	});
	return native ? "native" : "web";
}

function secureEndpoint(value: string | URL): URL {
	const url = new URL(value);
	if (url.protocol !== "https:" && !loopback(url.hostname)) throw new OAuthInsecureEndpointError(url.href);
	return url;
}

function selectClientAuthMethod(information: OAuthClientInformationMixed, supported: string[]): ClientAuthMethod {
	const hinted = "token_endpoint_auth_method" in information ? information.token_endpoint_auth_method : undefined;
	if (
		hinted &&
		["client_secret_basic", "client_secret_post", "none"].includes(hinted) &&
		(supported.length === 0 || supported.includes(hinted))
	) {
		return hinted as ClientAuthMethod;
	}
	if (supported.length === 0) return information.client_secret ? "client_secret_basic" : "none";
	if (information.client_secret && supported.includes("client_secret_basic")) return "client_secret_basic";
	if (information.client_secret && supported.includes("client_secret_post")) return "client_secret_post";
	if (supported.includes("none")) return "none";
	return information.client_secret ? "client_secret_post" : "none";
}

function applyClientAuthentication(
	method: ClientAuthMethod,
	information: OAuthClientInformation,
	headers: Headers,
	params: URLSearchParams,
): void {
	if (method === "client_secret_basic") {
		if (!information.client_secret) throw new Error("client_secret_basic requires a client secret");
		headers.set(
			"Authorization",
			`Basic ${Buffer.from(`${information.client_id}:${information.client_secret}`).toString("base64")}`,
		);
	} else {
		params.set("client_id", information.client_id);
		if (method === "client_secret_post" && information.client_secret)
			params.set("client_secret", information.client_secret);
	}
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	const verifier = Buffer.from(bytes).toString("base64url");
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return { verifier, challenge: Buffer.from(digest).toString("base64url") };
}

export async function startAuthorization(
	authorizationServerUrl: string | URL,
	options: {
		metadata?: AuthorizationServerMetadata;
		clientInformation: OAuthClientInformationMixed;
		redirectUrl: string | URL;
		scope?: string;
		state?: string;
		resource?: string;
	},
): Promise<{ authorizationUrl: URL; codeVerifier: string }> {
	const metadata = options.metadata;
	if (metadata && !metadata.response_types_supported.includes("code")) {
		throw new Error("Authorization server does not support authorization codes");
	}
	if (metadata?.code_challenge_methods_supported && !metadata.code_challenge_methods_supported.includes("S256")) {
		throw new Error("Authorization server does not support PKCE S256");
	}
	const url = new URL(metadata?.authorization_endpoint ?? new URL("/authorize", authorizationServerUrl));
	// Callers open this URL with the platform URL handler, which also launches files and custom protocols.
	if (!isHttpUrl(url)) throw new Error(`Invalid authorization endpoint ${redactUrlForDisplay(url.href)}`);
	url.username = "";
	url.password = "";
	const { verifier, challenge } = await pkce();
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", options.clientInformation.client_id);
	url.searchParams.set("code_challenge", challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("redirect_uri", String(options.redirectUrl));
	if (options.state) url.searchParams.set("state", options.state);
	if (options.scope) url.searchParams.set("scope", options.scope);
	if (options.scope?.split(/\s+/).includes("offline_access")) url.searchParams.set("prompt", "consent");
	if (options.resource) url.searchParams.set("resource", stripUrlUserinfoAndHash(options.resource));
	return { authorizationUrl: url, codeVerifier: verifier };
}

const NON_SECRET_TOKEN_HEADERS = new Set(["accept", "content-type", "user-agent"]);

const SENSITIVE_BODY_FIELDS = new Set([
	"access_token",
	"refresh_token",
	"id_token",
	"client_secret",
	"code_verifier",
	"code",
	"registration_access_token",
	"client_assertion",
	"token",
	"secret",
	"password",
]);

function tokenRequestSecrets(options: TokenRequestOptions, headers: Headers, params: URLSearchParams): string[] {
	const secrets: (string | undefined)[] = [
		options.clientInformation.client_secret,
		params.get("client_secret") ?? undefined,
		params.get("code_verifier") ?? undefined,
		params.get("refresh_token") ?? undefined,
		params.get("code") ?? undefined,
		params.get("client_assertion") ?? undefined,
	];
	headers.forEach((value, name) => {
		if (!NON_SECRET_TOKEN_HEADERS.has(name.toLowerCase())) {
			secrets.push(...extractHeaderSecrets(name, value));
		}
	});
	return secrets.filter((value): value is string => typeof value === "string" && value.length > 0);
}

function responseBodySecrets(value: unknown, depth = 0): string[] {
	if (depth > 6 || value === null || value === undefined || typeof value !== "object") return [];
	if (Array.isArray(value)) {
		return value.flatMap((item) => responseBodySecrets(item, depth + 1));
	}
	const secrets: string[] = [];
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === "string" && entry.length > 0 && SENSITIVE_BODY_FIELDS.has(key.toLowerCase())) {
			secrets.push(entry);
		} else if (typeof entry === "object" && entry !== null) {
			secrets.push(...responseBodySecrets(entry, depth + 1));
		}
	}
	return secrets;
}

function scrubTokenFetchError(error: unknown, secrets: readonly string[]): Error {
	const message = redactOAuthErrorText(error instanceof Error ? error.message : String(error), secrets);
	if (error instanceof TypeError) return new TypeError(message);
	if (error instanceof DOMException) return new DOMException(message, error.name);
	return new Error(message);
}

async function tokenRequest(
	authorizationServerUrl: string | URL,
	options: TokenRequestOptions,
	params: URLSearchParams,
): Promise<OAuthTokens> {
	const url = secureEndpoint(options.metadata?.token_endpoint ?? new URL("/token", authorizationServerUrl));
	const headers = new Headers({ Accept: "application/json", "content-type": "application/x-www-form-urlencoded" });
	if (options.resource) params.set("resource", options.resource);
	if (options.addClientAuthentication) {
		await options.addClientAuthentication(headers, params, url, options.metadata);
	} else {
		applyClientAuthentication(
			selectClientAuthMethod(
				options.clientInformation,
				options.metadata?.token_endpoint_auth_methods_supported ?? [],
			),
			options.clientInformation,
			headers,
			params,
		);
	}
	const requestSecrets = tokenRequestSecrets(options, headers, params);
	let response: Response;
	try {
		response = await (options.fetch ?? globalThis.fetch)(url, {
			method: "POST",
			headers,
			body: params,
			signal: options.signal,
		});
	} catch (error) {
		throw scrubTokenFetchError(error, requestSecrets);
	}
	const text = await response.text();
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {}
	// Servers may report OAuth errors with any status, so check the body before the status.
	if (isObject(value) && typeof value.error === "string") {
		const allSecrets = [...requestSecrets, ...responseBodySecrets(value)];
		const safeCode = redactOAuthErrorText(value.error, allSecrets);
		const rawDescription =
			typeof value.error_description === "string" && value.error_description.length > 0
				? value.error_description
				: safeCode;
		throw new OAuthError(
			safeCode,
			redactOAuthErrorText(rawDescription, allSecrets),
			typeof value.error_uri === "string" ? redactUrlForDisplay(value.error_uri) : undefined,
			response.status,
		);
	}
	if (!response.ok) {
		const allSecrets = isObject(value) ? [...requestSecrets, ...responseBodySecrets(value)] : requestSecrets;
		throw new OAuthError(
			"server_error",
			`HTTP ${response.status}: ${redactOAuthErrorText(text, allSecrets)}`,
			undefined,
			response.status,
		);
	}
	return parseOAuthTokens(value);
}

export async function registerClient(
	authorizationServerUrl: string | URL,
	options: {
		metadata?: AuthorizationServerMetadata;
		clientMetadata: OAuthClientMetadata;
		scope?: string;
		fetch?: McpFetch;
		signal?: AbortSignal;
	},
): Promise<OAuthClientInformationFull> {
	const endpoint = options.metadata?.registration_endpoint;
	if (options.metadata && !endpoint)
		throw new Error("Authorization server does not support dynamic client registration");
	const response = await (options.fetch ?? globalThis.fetch)(
		new URL(endpoint ?? new URL("/register", authorizationServerUrl)),
		{
			method: "POST",
			headers: { Accept: "application/json", "content-type": "application/json" },
			body: JSON.stringify({
				...options.clientMetadata,
				application_type:
					options.clientMetadata.application_type ?? applicationType(options.clientMetadata.redirect_uris),
				...(options.scope ? { scope: options.scope } : {}),
			}),
			signal: options.signal,
		},
	);
	const text = await response.text();
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {}
	if (!response.ok) {
		throw new OAuthRegistrationError(response.status, redactOAuthErrorText(text, responseBodySecrets(parsed)));
	}
	if (parsed === undefined) throw new Error("Invalid OAuth client registration response");
	return parseClientInformation(parsed);
}

export async function exchangeAuthorizationCode(
	authorizationServerUrl: string | URL,
	options: TokenRequestOptions & { code: string; codeVerifier: string; redirectUrl: string | URL },
): Promise<OAuthTokens> {
	return tokenRequest(
		authorizationServerUrl,
		options,
		new URLSearchParams({
			grant_type: "authorization_code",
			code: options.code,
			code_verifier: options.codeVerifier,
			redirect_uri: String(options.redirectUrl),
		}),
	);
}

export async function refreshAuthorization(
	authorizationServerUrl: string | URL,
	options: TokenRequestOptions & { refreshToken: string },
): Promise<OAuthTokens> {
	const tokens = await tokenRequest(
		authorizationServerUrl,
		options,
		new URLSearchParams({ grant_type: "refresh_token", refresh_token: options.refreshToken }),
	);
	return { refresh_token: options.refreshToken, ...tokens };
}

/** Errors with which the authorization server rejects the grant or the client: only a new sign-in helps. */
const REAUTHORIZATION_ERRORS = new Set(["invalid_grant", "invalid_client", "unauthorized_client"]);

/**
 * Whether a failed token request may succeed when repeated: network errors, timeouts, overloaded or
 * failing servers. A 4xx other than 408 and 429 is an answer, even when reported as `server_error`.
 */
function isTransientTokenFailure(error: unknown): boolean {
	if (error instanceof OAuthError) {
		if (REAUTHORIZATION_ERRORS.has(error.code)) return false;
		const status = error.status ?? 0;
		if (status === 408 || status === 429 || status >= 500) return true;
		if (error.code === "temporarily_unavailable") return true;
		return error.code === "server_error" && status < 400;
	}
	return (
		error instanceof TypeError ||
		(error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError"))
	);
}

function withScope(tokens: OAuthTokens, scope: string | undefined): OAuthTokens {
	return tokens.scope === undefined && scope ? { ...tokens, scope } : tokens;
}

/**
 * Scopes for a step-up authorization: the challenged scopes plus the ones granted so far, since a
 * challenge may list only the missing scopes and a token with just those would lose access the old
 * one had (SEP-2350). Without challenged scopes, `undefined` lets the flow pick its default.
 */
export function stepUpScope(granted: string | undefined, challenged: string | undefined): string | undefined {
	if (!challenged) return undefined;
	const scopes = [granted, challenged].flatMap((scope) => scope?.split(/\s+/).filter(Boolean) ?? []);
	return [...new Set(scopes)].join(" ");
}

async function runFlow(provider: OAuthClientProvider, options: OAuthFlowOptions): Promise<OAuthFlowResult> {
	const metadataUrl = options.authorizationServerMetadataUrl && secureEndpoint(options.authorizationServerMetadataUrl);
	// With a configured metadata URL, discovery is not cached, so changing the URL applies at once.
	let cached = metadataUrl ? undefined : await provider.discoveryState?.();
	if (options.resourceMetadataUrl && options.resourceMetadataUrl.href !== cached?.resourceMetadataUrl)
		cached = undefined;
	const discovered = cached?.authorizationServerUrl
		? {
				authorizationServerUrl: cached.authorizationServerUrl,
				authorizationServerMetadata:
					cached.authorizationServerMetadata ??
					(await discoverAuthorizationServerMetadata(cached.authorizationServerUrl, {
						fetch: options.fetch,
						skipIssuerValidation: options.skipIssuerValidation,
						signal: options.signal,
					})),
				resourceMetadata: cached.resourceMetadata,
			}
		: await discoverOAuthServerInfo(options.serverUrl, {
				resourceMetadataUrl: options.resourceMetadataUrl,
				authorizationServerMetadataUrl: metadataUrl,
				fetch: options.fetch,
				skipIssuerValidation: options.skipIssuerValidation,
				signal: options.signal,
			});
	if (!metadataUrl) {
		await provider.saveDiscoveryState?.({
			...discovered,
			...(options.resourceMetadataUrl || cached?.resourceMetadataUrl
				? { resourceMetadataUrl: options.resourceMetadataUrl?.href ?? cached?.resourceMetadataUrl }
				: {}),
		});
	}
	const metadata = discovered.authorizationServerMetadata;
	const resource = selectResource(options.serverUrl, discovered.resourceMetadata);
	// `||`, not `??`: an empty scope (for example from `scopes_supported: []`) falls through to the next source.
	const scope =
		options.scope || discovered.resourceMetadata?.scopes_supported?.join(" ") || provider.clientMetadata.scope;
	const stored = await provider.clientInformation();
	const clientDocument = stored ? undefined : provider.clientMetadataDocument?.(metadata);
	if (clientDocument) {
		const url = new URL(clientDocument.url);
		if (url.protocol !== "https:" || url.pathname === "/") throw new Error("Invalid OAuth client metadata URL");
	}
	let client = stored ?? (clientDocument && { client_id: clientDocument.url });
	if (!client) {
		if (options.authorizationCode) throw new Error("OAuth client information is missing during code exchange");
		if (!provider.saveClientInformation) throw new Error("OAuth client information cannot be persisted");
		client = await registerClient(discovered.authorizationServerUrl, {
			metadata,
			clientMetadata: provider.clientMetadata,
			scope,
			fetch: options.fetch,
			signal: options.signal,
		});
		await provider.saveClientInformation(client);
	}
	const redirectUrl = clientDocument?.redirectUrl ?? provider.redirectUrl;
	const tokenOptions: TokenRequestOptions = {
		metadata,
		clientInformation: client,
		resource,
		addClientAuthentication: provider.addClientAuthentication,
		fetch: options.fetch,
		signal: options.signal,
	};
	if (options.authorizationCode) {
		// RFC 9207: never send a code from another authorization server to this one. Without metadata there
		// is no issuer to compare with, so any `iss` is rejected.
		const iss = options.iss;
		if (iss !== undefined || metadata?.authorization_response_iss_parameter_supported) {
			if (iss !== metadata?.issuer) throw new OAuthIssuerMismatchError(metadata?.issuer, iss);
		}
		const tokens = await exchangeAuthorizationCode(discovered.authorizationServerUrl, {
			...tokenOptions,
			code: options.authorizationCode,
			codeVerifier: await provider.codeVerifier(),
			redirectUrl,
		});
		// A response without `scope` grants the requested scope (RFC 6749 §5.1). Recorded so a step-up can
		// keep it. Callers pass the options of the authorization request, so `scope` is what was requested.
		await provider.saveTokens(withScope(tokens, scope));
		return "AUTHORIZED";
	}
	const existing = options.skipRefresh ? undefined : await provider.tokens();
	if (existing?.refresh_token) {
		try {
			const tokens = await refreshAuthorization(discovered.authorizationServerUrl, {
				...tokenOptions,
				refreshToken: existing.refresh_token,
			});
			// A refresh without `scope` keeps the scope of the grant (RFC 6749 §6).
			await provider.saveTokens(withScope(tokens, existing.scope));
			return "AUTHORIZED";
		} catch (error) {
			if (options.signal?.aborted || error instanceof OAuthInsecureEndpointError) throw error;
			// The grant may still be valid: keep it, and the pending PKCE state, for another attempt.
			if (isTransientTokenFailure(error)) throw new OAuthTemporarilyUnavailableError(error);
			if (error instanceof OAuthError && error.code !== "server_error") throw error;
		}
	}
	const state = await provider.state?.();
	const authorization = await startAuthorization(discovered.authorizationServerUrl, {
		metadata,
		clientInformation: client,
		redirectUrl,
		scope,
		state,
		resource,
	});
	await provider.saveCodeVerifier(authorization.codeVerifier);
	await provider.redirectToAuthorization(authorization.authorizationUrl);
	return "REDIRECT";
}

export async function authorizeMcp(provider: OAuthClientProvider, options: OAuthFlowOptions): Promise<OAuthFlowResult> {
	// A failed code exchange says nothing about the stored credentials, which may belong to another sign-in.
	const refreshing = !options.authorizationCode && !options.skipRefresh;
	const refreshToken = refreshing ? (await provider.tokens())?.refresh_token : undefined;
	try {
		return await runFlow(provider, options);
	} catch (error) {
		if (!refreshing || !(error instanceof OAuthError)) throw error;
		if (["invalid_client", "unauthorized_client"].includes(error.code)) {
			await provider.invalidateCredentials?.("all");
			return runFlow(provider, options);
		}
		if (error.code === "invalid_grant") {
			// Only the rejected grant is dropped: tokens saved meanwhile (another sign-in or refresh) are tried instead.
			if ((await provider.tokens())?.refresh_token === refreshToken)
				await provider.invalidateCredentials?.("tokens");
			return runFlow(provider, options);
		}
		throw error;
	}
}

/**
 * Auth provider for `StreamableHttpTransport`. After a 401 it refreshes the tokens, or throws
 * `McpOAuthAuthorizationRequiredError` when the user has to authorize (again). Concurrent 401s share
 * one refresh, and a request whose token was already replaced is just retried: with rotating refresh
 * tokens, a second refresh with the old refresh token would fail and discard the new grant.
 */
export function adaptOAuthProvider(provider: OAuthClientProvider): AuthProvider {
	let inFlight: Promise<void> | undefined;
	return {
		token: async () => (await provider.tokens())?.access_token,
		onUnauthorized: async (context: UnauthorizedContext) => {
			const challenge = parseWwwAuthenticate(context.response.headers.get("www-authenticate"));
			const insufficientScope = challenge.error === "insufficient_scope";
			if (!insufficientScope && !inFlight && context.token !== undefined) {
				const current = (await provider.tokens())?.access_token;
				if (current !== undefined && current !== context.token) return;
			}
			inFlight ??= Promise.resolve(insufficientScope ? provider.tokens() : undefined)
				.then((granted) =>
					authorizeMcp(provider, {
						serverUrl: context.serverUrl,
						resourceMetadataUrl: challenge.resourceMetadataUrl,
						scope: insufficientScope ? stepUpScope(granted?.scope, challenge.scope) : challenge.scope,
						fetch: context.fetch,
						skipRefresh: insufficientScope,
					}),
				)
				.then((result) => {
					if (result === "REDIRECT") throw new McpOAuthAuthorizationRequiredError();
				})
				.finally(() => {
					inFlight = undefined;
				});
			await inFlight;
		},
	};
}
