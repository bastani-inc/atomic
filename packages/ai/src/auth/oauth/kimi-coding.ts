/**
 * Kimi Code (subscription) OAuth flow
 *
 * RFC 8628 device authorization grant against https://auth.kimi.com with JSON
 * responses. The access token authenticates requests to
 * https://api.kimi.com/coding/v1 as an `Authorization: Bearer` header.
 */

import { getProviderEnvValue } from "../../utils/provider-env.ts";
import { sleep } from "../../utils/sleep.ts";
import {
	formatOAuthErrorDetail,
	isPermanentRefreshRejection,
	OAuthRefreshRejectedError,
	type OAuthRefreshRejection,
	parseOAuthErrorBody,
	requestNeverReachedServer,
} from "../oauth-refresh-errors.ts";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { pollOAuthDeviceCodeFlow } from "./device-code.ts";

const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const DEFAULT_OAUTH_HOST = "https://auth.kimi.com";
const DEVICE_CODE_TIMEOUT_SECONDS = 15 * 60;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
/** Login requests (device authorization and polling) give up after this; a refresh request never does. */
const REQUEST_TIMEOUT_MS = 30 * 1000;
/** Retries of a refresh request that never reached the server, after 1 s, 2 s, then 4 s. */
const REFRESH_MAX_RETRIES = 3;
const REFRESH_RETRY_BASE_DELAY_MS = 1000;

type DeviceAuthorization = {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	verificationUriComplete: string;
	intervalSeconds: number;
	expiresInSeconds: number;
};

type TokenResponse = {
	access: string;
	refresh: string;
	expires: number;
};

function getOauthHost(): string {
	const override = getProviderEnvValue("KIMI_CODE_OAUTH_HOST") || getProviderEnvValue("KIMI_OAUTH_HOST");
	return (override || DEFAULT_OAUTH_HOST).replace(/\/+$/, "");
}

function requestSignal(signal: AbortSignal): AbortSignal {
	return AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), signal]);
}

function formUrlEncode(fields: Record<string, string>): string {
	return new URLSearchParams(fields).toString();
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
	try {
		const json = await response.json();
		return json && typeof json === "object" ? (json as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/** The verification URI is opened in the user's browser; only http(s) URLs are trusted. */
function trustedHttpUrl(value: unknown): string | null {
	if (typeof value !== "string" || !value) return null;
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" && url.protocol !== "http:") return null;
		return url.href;
	} catch {
		return null;
	}
}

async function startDeviceAuthorization(oauthHost: string, signal: AbortSignal): Promise<DeviceAuthorization> {
	const response = await fetch(`${oauthHost}/api/oauth/device_authorization`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body: formUrlEncode({ client_id: CLIENT_ID }),
		signal: requestSignal(signal),
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Kimi Code device authorization failed with status ${response.status}${text ? `: ${text}` : ""}`);
	}

	const json = await readJson(response);
	const deviceCode = json?.device_code;
	const userCode = json?.user_code;
	const verificationUri = json?.verification_uri;
	const verificationUriComplete = json?.verification_uri_complete;
	if (
		typeof deviceCode !== "string" ||
		typeof userCode !== "string" ||
		typeof verificationUri !== "string" ||
		typeof verificationUriComplete !== "string" ||
		!trustedHttpUrl(verificationUriComplete) ||
		!trustedHttpUrl(verificationUri)
	) {
		throw new Error(`Invalid Kimi Code device authorization response: ${JSON.stringify(json)}`);
	}

	const interval = json?.interval;
	const expiresIn = json?.expires_in;
	return {
		deviceCode,
		userCode,
		verificationUri,
		verificationUriComplete,
		intervalSeconds:
			typeof interval === "number" && Number.isFinite(interval) && interval > 0
				? interval
				: DEFAULT_POLL_INTERVAL_SECONDS,
		expiresInSeconds:
			typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
				? expiresIn
				: DEVICE_CODE_TIMEOUT_SECONDS,
	};
}

function parseTokenResponse(json: Record<string, unknown> | null, operation: string): TokenResponse {
	const accessToken = json?.access_token;
	const refreshToken = json?.refresh_token;
	const expiresIn = json?.expires_in;
	if (
		typeof accessToken !== "string" ||
		!accessToken ||
		typeof refreshToken !== "string" ||
		!refreshToken ||
		typeof expiresIn !== "number" ||
		!Number.isFinite(expiresIn) ||
		expiresIn <= 0
	) {
		throw new Error(`Kimi Code token ${operation} response missing fields: ${JSON.stringify(json)}`);
	}
	return {
		access: accessToken,
		refresh: refreshToken,
		expires: Date.now() + expiresIn * 1000,
	};
}

async function pollForToken(
	oauthHost: string,
	device: DeviceAuthorization,
	signal: AbortSignal,
): Promise<TokenResponse> {
	return pollOAuthDeviceCodeFlow<TokenResponse>({
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: device.expiresInSeconds,
		waitBeforeFirstPoll: true,
		signal,
		poll: async () => {
			const response = await fetch(`${oauthHost}/api/oauth/token`, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					Accept: "application/json",
				},
				body: formUrlEncode({
					client_id: CLIENT_ID,
					device_code: device.deviceCode,
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				}),
				signal: requestSignal(signal),
			});

			if (response.status >= 500) {
				const text = await response.text().catch(() => "");
				return {
					status: "failed",
					message: `Kimi Code device token request failed with status ${response.status}${text ? `: ${text}` : ""}`,
				};
			}

			const json = await readJson(response);
			if (response.ok && typeof json?.access_token === "string") {
				try {
					return { status: "complete", value: parseTokenResponse(json, "poll") };
				} catch (error) {
					return { status: "failed", message: error instanceof Error ? error.message : String(error) };
				}
			}

			const error = json?.error;
			const description = typeof json?.error_description === "string" ? `: ${json.error_description}` : "";
			if (error === "authorization_pending") {
				return { status: "pending" };
			}
			if (error === "slow_down") {
				const interval = json?.interval;
				return {
					status: "slow_down",
					intervalSeconds: typeof interval === "number" && interval > 0 ? interval : undefined,
				};
			}
			if (error === "expired_token") {
				return { status: "failed", message: "Kimi Code device authorization expired. Please restart login." };
			}
			if (error === "access_denied") {
				return { status: "failed", message: "Kimi Code login was denied." };
			}
			return {
				status: "failed",
				message: `Kimi Code device token request failed (status ${response.status})${typeof error === "string" ? `: ${error}${description}` : ""}`,
			};
		},
	});
}

/** Kimi treats 401 and 403 from its token endpoint as a dead login, along with the usual permanent codes. */
function isUnauthorizedRefresh(rejection: OAuthRefreshRejection): boolean {
	return rejection.status === 401 || rejection.status === 403 || isPermanentRefreshRejection(rejection);
}

async function refreshToken(oauthHost: string, refreshTokenValue: string, signal: AbortSignal): Promise<TokenResponse> {
	for (let attempt = 0; ; attempt++) {
		if (attempt > 0) {
			await sleep(REFRESH_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), signal);
		}
		if (signal.aborted) {
			throw new Error("Kimi Code token refresh aborted");
		}

		let response: Response;
		try {
			// No timeout of its own: once sent, the server may already have rotated the refresh token, and only
			// this response carries the replacement.
			response = await fetch(`${oauthHost}/api/oauth/token`, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					Accept: "application/json",
				},
				body: formUrlEncode({
					client_id: CLIENT_ID,
					grant_type: "refresh_token",
					refresh_token: refreshTokenValue,
				}),
				signal,
			});
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error));
			// Presenting the same refresh token again is safe only if this attempt provably never reached the server.
			if (attempt < REFRESH_MAX_RETRIES && !signal.aborted && requestNeverReachedServer(failure)) continue;
			throw failure;
		}

		if (response.ok) {
			return parseTokenResponse(await readJson(response), "refresh");
		}

		// Any answer, a 429 or 5xx included, means the request was delivered and may have rotated the token, so it
		// is never retried with the same one.
		const rejection = { status: response.status, ...parseOAuthErrorBody(await response.text().catch(() => "")) };
		if (isUnauthorizedRefresh(rejection)) {
			throw new OAuthRefreshRejectedError(
				`Kimi Code token refresh unauthorized (status ${response.status})`,
				rejection,
				[refreshTokenValue],
			);
		}
		throw new Error(
			`Kimi Code token refresh failed with status ${response.status}${formatOAuthErrorDetail(rejection, [refreshTokenValue])}`,
		);
	}
}

async function loginKimiCoding(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	const oauthHost = getOauthHost();
	const device = await startDeviceAuthorization(oauthHost, interaction.signal);
	interaction.notify({
		type: "device_code",
		userCode: device.userCode,
		verificationUri: device.verificationUriComplete,
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: device.expiresInSeconds,
	});
	const token = await pollForToken(oauthHost, device, interaction.signal);
	return { type: "oauth", access: token.access, refresh: token.refresh, expires: token.expires };
}

export const kimiCodingOAuth: OAuthAuth = {
	name: "Kimi Code (subscription)",
	isSubscription: true,
	loginLabel: "Sign in with Kimi Code",

	login: loginKimiCoding,

	refresh: async (credential, signal) => {
		const token = await refreshToken(getOauthHost(), credential.refresh, signal);
		return { type: "oauth", access: token.access, refresh: token.refresh, expires: token.expires };
	},

	async toAuth(credential) {
		return { headers: { Authorization: `Bearer ${credential.access}` } };
	},
};
