import { normalizeProviderId } from "../provider-id.ts";
import type { ProviderEnv } from "../types.ts";
import { operationSignal, raceWithAbortSignal } from "../utils/abort.ts";
import { formatThrownValue } from "../utils/diagnostics.ts";
import { ModelsError } from "../utils/models-error.ts";

export { ModelsError, type ModelsErrorCode } from "../utils/models-error.ts";

import type {
	ApiKeyAuth,
	ApiKeyCredential,
	AuthContext,
	AuthResult,
	Credential,
	CredentialStore,
	OAuthAuth,
	OAuthCredential,
	ProviderAuth,
} from "./types.ts";

/** Bound for pre-transport request-auth work: credential read, OAuth refresh, and toAuth. */
export const REQUEST_AUTH_PREPARATION_TIMEOUT_MS = 15_000;

/** Source-neutral diagnostic when pre-transport request auth exceeds {@link REQUEST_AUTH_PREPARATION_TIMEOUT_MS}. */
export function requestAuthTimeoutMessage(providerId: string): string {
	return `Request authentication timed out for ${providerId}. Check the provider's credential source and try again.`;
}

export interface AuthResolutionOverrides {
	apiKey?: string;
	env?: ProviderEnv;
	/** Require this much remaining OAuth-token validity; defaults to five minutes. */
	minOAuthValidityMs?: number;
	signal?: AbortSignal;
}

/**
 * Auth resolution shared by all operations in a `Models` collection.
 * A stored credential owns the provider: ambient/env is consulted only when
 * nothing is stored. A provider that borrows credentials reads only its
 * lenders' (see `readProviderCredential`). No silent env fallback after a failed
 * refresh or for a credential type without a matching handler.
 */
export function resolveProviderAuth(
	provider: { id: string; auth: ProviderAuth },
	credentials: CredentialStore,
	authContext: AuthContext,
	overrides?: AuthResolutionOverrides,
): Promise<AuthResult | undefined> {
	const caller = operationSignal(overrides?.signal);
	const timeout = new AbortController();
	const timer = setTimeout(() => {
		timeout.abort();
	}, REQUEST_AUTH_PREPARATION_TIMEOUT_MS);
	const signal = AbortSignal.any([caller, timeout.signal]);
	const operation = resolveProviderAuthWithSignal(
		provider,
		credentials,
		authContext,
		{ ...overrides, signal },
		signal,
	);
	return raceWithAbortSignal(operation, signal)
		.catch((error: unknown) => {
			if (timeout.signal.aborted && !caller.aborted) {
				throw new ModelsError("auth", requestAuthTimeoutMessage(provider.id));
			}
			throw error;
		})
		.finally(() => {
			clearTimeout(timer);
		});
}

async function resolveProviderAuthWithSignal(
	provider: { id: string; auth: ProviderAuth },
	credentials: CredentialStore,
	authContext: AuthContext,
	overrides: AuthResolutionOverrides | undefined,
	signal: AbortSignal,
): Promise<AuthResult | undefined> {
	signal.throwIfAborted();
	const requestAuthContext = overrides?.env ? overlayEnvAuthContext(authContext, overrides.env) : authContext;

	if (overrides?.apiKey !== undefined && provider.auth.apiKey) {
		return resolveApiKey(
			requestAuthContext,
			provider.auth.apiKey,
			provider.id,
			{
				type: "api_key",
				key: overrides.apiKey,
				env: overrides.env,
			},
			signal,
		);
	}

	const stored = await readProviderCredential(credentials, provider, signal);
	if (stored) {
		if (stored.type === "oauth" && provider.auth.oauth) {
			return resolveStoredOAuth(
				credentials,
				provider.id,
				provider.auth.oauth,
				stored,
				signal,
				overrides?.minOAuthValidityMs,
			);
		}
		if (stored.type === "api_key" && provider.auth.apiKey) {
			const credential = overrides?.env ? { ...stored, env: { ...stored.env, ...overrides.env } } : stored;
			return resolveApiKey(requestAuthContext, provider.auth.apiKey, provider.id, credential, signal);
		}
		return undefined;
	}

	// Ambient (env vars, AWS profiles, ADC files).
	return provider.auth.apiKey
		? resolveApiKey(requestAuthContext, provider.auth.apiKey, provider.id, undefined, signal)
		: undefined;
}

function overlayEnvAuthContext(base: AuthContext, env: ProviderEnv): AuthContext {
	return {
		env: async (name) => env[name] || (await base.env(name)),
		fileExists: (path) => base.fileExists(path),
	};
}

const DEFAULT_OAUTH_MINIMUM_VALIDITY_MS = 5 * 60 * 1000;
/** How long a refresh keeps its caller waiting for one token exchange. */
export const OAUTH_REFRESH_TIMEOUT_MS = 60_000;

/**
 * How long a refresh keeps the credential lock while its token exchange is still running, so no other refresh
 * presents a token the exchange may already have rotated. A response after this is still persisted, lock-free.
 */
export const OAUTH_REFRESH_LOCK_HOLD_MS = 2 * OAUTH_REFRESH_TIMEOUT_MS;

/**
 * Signal handed to a provider's token exchange. Nothing aborts it: once sent, the provider may already have
 * rotated the refresh token, so only the exchange's own response can tell us the replacement.
 */
const TOKEN_EXCHANGE_SIGNAL = new AbortController().signal;

const OAUTH_ERROR_CODE = /"error"\s*:\s*"([\w.-]+)"/;
const OAUTH_ERROR_DESCRIPTION = /"error_description"\s*:\s*("(?:[^"\\]|\\.)*")/;
const MAX_ERROR_CHAIN_DEPTH = 5;

function parseJsonString(literal: string): string | undefined {
	try {
		const value: string | number | boolean | null | object = JSON.parse(literal);
		return typeof value === "string" ? value : undefined;
	} catch {
		return undefined;
	}
}

/** The provider's `invalid_grant` code and description, without request bodies, URLs, or tokens. */
function describeRejectedGrant(error: unknown, presented: OAuthCredential): string | undefined {
	let current = error;
	for (let depth = 0; depth < MAX_ERROR_CHAIN_DEPTH && current !== undefined && current !== null; depth++) {
		const message = formatThrownValue(current);
		const code = OAUTH_ERROR_CODE.exec(message)?.[1] ?? (/\binvalid_grant\b/.test(message) ? "invalid_grant" : "");
		if (code === "invalid_grant") {
			const literal = OAUTH_ERROR_DESCRIPTION.exec(message)?.[1];
			const description = literal === undefined ? undefined : parseJsonString(literal)?.trim();
			const safe =
				description && !description.includes(presented.refresh) && !description.includes(presented.access);
			return safe ? `${code} (${description})` : code;
		}
		current = current instanceof Error ? current.cause : undefined;
	}
	return undefined;
}

function oauthRefreshFailure(providerId: string, error: unknown, presented: OAuthCredential): ModelsError {
	const rejectedGrant = describeRejectedGrant(error, presented);
	if (rejectedGrant === undefined) {
		return new ModelsError("oauth", `OAuth refresh failed for ${providerId}`, { cause: error });
	}
	return new ModelsError(
		"oauth",
		`OAuth refresh failed for ${providerId}: ${rejectedGrant}. The provider rejected the stored login; run /login ${providerId} to sign in again.`,
	);
}

/** A token exchange that settles after its timeout already rotated the token server-side, so keep its result. */
function persistLateRotation(
	credentials: CredentialStore,
	providerId: string,
	rotatedFrom: OAuthCredential,
	rotation: Promise<OAuthCredential>,
): void {
	void rotation
		.then((late) =>
			credentials.modify(providerId, async (current) =>
				current?.type === "oauth" && current.refresh === rotatedFrom.refresh ? late : undefined,
			),
		)
		.catch(() => undefined);
}

/**
 * Runs one token exchange under the credential lock. The caller stops waiting after {@link OAUTH_REFRESH_TIMEOUT_MS};
 * the lock is kept until the exchange settles or {@link OAUTH_REFRESH_LOCK_HOLD_MS} passes, after which a late
 * response is still persisted.
 */
async function rotateOAuthCredential(
	credentials: CredentialStore,
	providerId: string,
	oauth: OAuthAuth,
	current: OAuthCredential,
	stopCallerWaiting: (reason: Error) => void,
): Promise<OAuthCredential> {
	const rotation = oauth.refresh(current, TOKEN_EXCHANGE_SIGNAL);
	const callerWait = AbortSignal.timeout(OAUTH_REFRESH_TIMEOUT_MS);
	const onCallerWaitExpired = () => {
		stopCallerWaiting(
			new ModelsError("oauth", `OAuth refresh failed for ${providerId}`, { cause: callerWait.reason }),
		);
	};
	callerWait.addEventListener("abort", onCallerWaitExpired, { once: true });
	const lockHold = AbortSignal.timeout(OAUTH_REFRESH_LOCK_HOLD_MS);
	try {
		return await raceWithAbortSignal(rotation, lockHold);
	} catch (error) {
		if (lockHold.aborted) persistLateRotation(credentials, providerId, current, rotation);
		throw error;
	} finally {
		callerWait.removeEventListener("abort", onCallerWaitExpired);
	}
}

/** A login another process saved after this refresh read the store, e.g. its own rotation of the same token. */
async function readNewerOAuthCredential(
	credentials: CredentialStore,
	providerId: string,
	rejected: OAuthCredential,
): Promise<OAuthCredential | undefined> {
	const latest = await credentials.read(providerId).catch(() => undefined);
	return latest?.type === "oauth" && latest.refresh !== rejected.refresh ? latest : undefined;
}

/** Cancellation stops waiting for the credential lock, not an already started token rotation. */
export async function refreshStoredOAuthCredential(
	credentials: CredentialStore,
	providerId: string,
	oauth: OAuthAuth,
	needsRefresh: (credential: OAuthCredential) => boolean,
	signal: AbortSignal,
): Promise<OAuthCredential | undefined> {
	let post: Credential | undefined;
	const lockWait = new AbortController();
	const cancelLockWait = () => lockWait.abort(signal.reason);
	signal.addEventListener("abort", cancelLockWait, { once: true });
	if (signal.aborted) cancelLockWait();
	let stopCallerWaiting!: (reason: Error) => void;
	const callerWaitExpired = new Promise<never>((_, reject) => {
		stopCallerWaiting = reject;
	});
	try {
		const transaction = credentials.modify(
			providerId,
			async (current) => {
				signal.removeEventListener("abort", cancelLockWait);
				signal.throwIfAborted();
				if (current?.type !== "oauth") return undefined;
				if (!needsRefresh(current)) return undefined;
				try {
					return await rotateOAuthCredential(credentials, providerId, oauth, current, stopCallerWaiting);
				} catch (error) {
					const newer = await readNewerOAuthCredential(credentials, providerId, current);
					if (newer) return newer;
					throw oauthRefreshFailure(providerId, error, current);
				}
			},
			{ signal: lockWait.signal },
		);
		void transaction.catch(() => undefined);
		post = await Promise.race([transaction, callerWaitExpired]);
	} catch (error) {
		if (error instanceof ModelsError) throw error;
		signal.throwIfAborted();
		throw new ModelsError("auth", `Credential store modify failed for ${providerId}`, { cause: error });
	} finally {
		signal.removeEventListener("abort", cancelLockWait);
	}
	return post?.type === "oauth" ? post : undefined;
}

/** Refresh expiring tokens under the credential-store lock and persist rotation before releasing it. */
async function resolveStoredOAuth(
	credentials: CredentialStore,
	providerId: string,
	oauth: OAuthAuth,
	stored: OAuthCredential,
	signal: AbortSignal,
	minOAuthValidityMs?: number,
): Promise<AuthResult | undefined> {
	const minimumValidityMs = Math.max(DEFAULT_OAUTH_MINIMUM_VALIDITY_MS, minOAuthValidityMs ?? 0);
	const expiresSoon = (credential: OAuthCredential) => Date.now() + minimumValidityMs >= credential.expires;
	let credential = stored;

	if (expiresSoon(credential)) {
		// Optimistic check said expired; the authoritative check runs under the lock.
		const post = await refreshStoredOAuthCredential(credentials, providerId, oauth, expiresSoon, signal);
		if (!post) return undefined;
		credential = post;
		// The normal five-minute window triggers a refresh but does not impose a
		// provider contract. Explicit callers (such as bearer-token export) do
		// require the requested minimum after the refresh.
		if (minOAuthValidityMs !== undefined && expiresSoon(credential)) {
			throw new ModelsError("oauth", `OAuth refresh returned a token that expires too soon for ${providerId}`);
		}
	}

	try {
		return { auth: await oauth.toAuth(credential), source: "OAuth" };
	} catch (error) {
		throw new ModelsError("oauth", `OAuth auth derivation failed for ${providerId}`, { cause: error });
	}
}

async function resolveApiKey(
	authContext: AuthContext,
	apiKey: ApiKeyAuth,
	providerId: string,
	credential: ApiKeyCredential | undefined,
	signal: AbortSignal,
): Promise<AuthResult | undefined> {
	try {
		return await apiKey.resolve({ ctx: authContext, credential, signal });
	} catch (error) {
		throw new ModelsError("auth", `API key auth failed for provider ${providerId}`, { cause: error });
	}
}

/**
 * The stored credential that supplies auth for `provider`. A provider that
 * declares `apiKey.borrowCredentialsFrom` has no credential of its own: it
 * uses the first usable api-key credential among those providers. Any other
 * provider uses its own. Shared by request auth and availability checks so
 * both agree on which credential applies.
 */
export async function readProviderCredential(
	credentials: CredentialStore,
	provider: { id: string; auth: ProviderAuth },
	signal: AbortSignal,
): Promise<Credential | undefined> {
	const lenders = provider.auth.apiKey?.borrowCredentialsFrom;
	if (!lenders) return readCredential(credentials, provider.id, signal);
	for (const sourceId of lenders) {
		const borrowed = await readCredential(credentials, normalizeProviderId(sourceId), signal);
		if (borrowed?.type === "api_key" && borrowed.key) return borrowed;
	}
	return undefined;
}

async function readCredential(
	credentials: CredentialStore,
	providerId: string,
	signal: AbortSignal,
): Promise<Credential | undefined> {
	try {
		const credential = await credentials.read(providerId, { signal });
		return (
			credential ??
			(providerId === "azure" ? await credentials.read("azure-openai-responses", { signal }) : undefined)
		);
	} catch (error) {
		throw new ModelsError("auth", `Credential store read failed for ${providerId}`, { cause: error });
	}
}
