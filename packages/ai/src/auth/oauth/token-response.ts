/**
 * Shared handling of OAuth token endpoint responses.
 *
 * RFC 6749 §5.1 makes `expires_in` optional, and §6 lets a server answer a refresh without issuing a new
 * `refresh_token`, in which case the presented one stays valid.
 */

import type { OAuthCredential } from "../types.ts";

/** Lifetime assumed for an access token whose response states none and that is not a JWT with an `exp` claim. */
export const DEFAULT_ACCESS_TOKEN_LIFETIME_MS = 60 * 60 * 1000;

/** The `exp` claim of a JWT access token, in milliseconds, or undefined when the token carries no finite one. */
function jwtExpiryMs(accessToken: string): number | undefined {
	const base64 = (accessToken.split(".")[1] ?? "").replace(/-/g, "+").replace(/_/g, "/");
	try {
		const claims = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="))) as { exp?: number };
		return Number.isFinite(claims.exp) ? (claims.exp as number) * 1000 : undefined;
	} catch {
		return undefined;
	}
}

/**
 * When an access token expires, less `skewMs`: from `expires_in` when it is a positive number, else from the
 * JWT `exp` claim of `accessToken`, else after {@link DEFAULT_ACCESS_TOKEN_LIFETIME_MS}. Always finite.
 */
export function oauthTokenExpiry(accessToken: string, expiresIn: unknown, skewMs: number): number {
	if (typeof expiresIn === "number" && expiresIn > 0 && expiresIn < Number.POSITIVE_INFINITY) {
		return Date.now() + expiresIn * 1000 - skewMs;
	}
	return (jwtExpiryMs(accessToken) ?? Date.now() + DEFAULT_ACCESS_TOKEN_LIFETIME_MS) - skewMs;
}

/** The fields a refresh response may carry besides the access token. */
export interface RefreshTokenResponse {
	refresh_token?: unknown;
	expires_in?: unknown;
}

/**
 * The credential a successful refresh stores: the new access token, the issued refresh token or else the presented
 * one, and a finite expiry from {@link oauthTokenExpiry}.
 */
export function refreshedOAuthCredential(
	accessToken: string,
	response: RefreshTokenResponse,
	presentedRefreshToken: string,
	skewMs: number,
): OAuthCredential {
	const issued = response.refresh_token;
	return {
		type: "oauth",
		access: accessToken,
		refresh: typeof issued === "string" && issued.length > 0 ? issued : presentedRefreshToken,
		expires: oauthTokenExpiry(accessToken, response.expires_in, skewMs),
	};
}
