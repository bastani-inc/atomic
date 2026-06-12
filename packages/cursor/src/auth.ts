import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { createHash, randomBytes as nodeRandomBytes, randomUUID } from "node:crypto";
import {
	CURSOR_API_BASE_URL,
	CURSOR_AUTH_POLL_PATH,
	CURSOR_DEFAULT_TOKEN_TTL_MS,
	CURSOR_OAUTH_EXPIRY_SKEW_MS,
	CURSOR_REFRESH_PATH,
	CURSOR_WEB_BASE_URL,
	CURSOR_LOGIN_PATH,
	parseJsonObject,
	readStringField,
	readNumberField,
	sanitizeDiagnosticText,
} from "./config.js";

export type CursorAuthErrorCode =
	| "LoginCancelled"
	| "PollTimedOut"
	| "PollRejected"
	| "RefreshTokenExpired"
	| "CursorApiRejected"
	| "NetworkError";

export class CursorAuthError extends Error {
	constructor(
		readonly code: CursorAuthErrorCode,
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "CursorAuthError";
	}
}

export class CursorToken {
	readonly kind: "access" | "refresh";
	readonly #value: string;

	constructor(kind: "access" | "refresh", value: string) {
		this.kind = kind;
		this.#value = value;
	}

	unwrap(): string {
		return this.#value;
	}

	toString(): string {
		return `[redacted cursor ${this.kind} token]`;
	}

	toJSON(): string {
		return this.toString();
	}
}

export interface CursorCredentialBundle {
	readonly access: CursorToken;
	readonly refresh: CursorToken;
	readonly expires: number;
}

export interface CursorPkcePair {
	readonly verifier: string;
	readonly challenge: string;
}

export type CursorFetch = (url: string, init?: RequestInit) => Promise<Response>;
export type CursorSleep = (milliseconds: number, signal?: AbortSignal) => Promise<void>;
export type CursorUuid = () => string;
export type CursorRandomBytes = (length: number) => Uint8Array;
export type CursorNow = () => number;

export interface CursorAuthServiceOptions {
	readonly fetch?: CursorFetch;
	readonly sleep?: CursorSleep;
	readonly uuid?: CursorUuid;
	readonly randomBytes?: CursorRandomBytes;
	readonly now?: CursorNow;
	readonly maxPollAttempts?: number;
	readonly initialPollDelayMs?: number;
	readonly maxPollDelayMs?: number;
	readonly pollBackoffMultiplier?: number;
	readonly fetchTimeoutMs?: number;
	readonly apiBaseUrl?: string;
	readonly webBaseUrl?: string;
}

interface CursorTokenResponse {
	readonly accessToken: string;
	readonly refreshToken: string;
}

const DEFAULT_MAX_POLL_ATTEMPTS = 150;
const DEFAULT_INITIAL_POLL_DELAY_MS = 1000;
const DEFAULT_MAX_POLL_DELAY_MS = 10000;
const DEFAULT_POLL_BACKOFF_MULTIPLIER = 1.2;
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

export function base64Url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

export function createPkcePair(randomBytes: CursorRandomBytes = defaultRandomBytes): CursorPkcePair {
	const verifier = base64Url(randomBytes(96));
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	return { verifier, challenge };
}

export function toOAuthCredentials(bundle: CursorCredentialBundle): OAuthCredentials {
	return {
		access: bundle.access.unwrap(),
		refresh: bundle.refresh.unwrap(),
		expires: bundle.expires,
	};
}

export function fromOAuthCredentials(credentials: OAuthCredentials): CursorCredentialBundle {
	return {
		access: new CursorToken("access", credentials.access),
		refresh: new CursorToken("refresh", credentials.refresh),
		expires: credentials.expires,
	};
}

export function redactOAuthCredentials(credentials: OAuthCredentials): OAuthCredentials {
	return {
		access: "[redacted]",
		refresh: "[redacted]",
		expires: credentials.expires,
	};
}

export function deriveCursorTokenExpiry(accessToken: string, now: CursorNow = Date.now): number {
	const parts = accessToken.split(".");
	if (parts.length < 2 || !parts[1]) {
		return now() + CURSOR_DEFAULT_TOKEN_TTL_MS;
	}

	try {
		const payload = Buffer.from(parts[1], "base64url").toString("utf8");
		const parsed = parseJsonObject(payload);
		if (!parsed) {
			return now() + CURSOR_DEFAULT_TOKEN_TTL_MS;
		}
		const exp = readNumberField(parsed, "exp");
		return exp ? exp * 1000 - CURSOR_OAUTH_EXPIRY_SKEW_MS : now() + CURSOR_DEFAULT_TOKEN_TTL_MS;
	} catch {
		return now() + CURSOR_DEFAULT_TOKEN_TTL_MS;
	}
}

export class CursorAuthService {
	readonly #fetch: CursorFetch;
	readonly #sleep: CursorSleep;
	readonly #uuid: CursorUuid;
	readonly #randomBytes: CursorRandomBytes;
	readonly #now: CursorNow;
	readonly #maxPollAttempts: number;
	readonly #initialPollDelayMs: number;
	readonly #maxPollDelayMs: number;
	readonly #pollBackoffMultiplier: number;
	readonly #fetchTimeoutMs: number;
	readonly #apiBaseUrl: string;
	readonly #webBaseUrl: string;

	constructor(options: CursorAuthServiceOptions = {}) {
		this.#fetch = options.fetch ?? fetch;
		this.#sleep = options.sleep ?? sleep;
		this.#uuid = options.uuid ?? randomUUID;
		this.#randomBytes = options.randomBytes ?? defaultRandomBytes;
		this.#now = options.now ?? Date.now;
		this.#maxPollAttempts = options.maxPollAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS;
		this.#initialPollDelayMs = options.initialPollDelayMs ?? DEFAULT_INITIAL_POLL_DELAY_MS;
		this.#maxPollDelayMs = options.maxPollDelayMs ?? DEFAULT_MAX_POLL_DELAY_MS;
		this.#pollBackoffMultiplier = options.pollBackoffMultiplier ?? DEFAULT_POLL_BACKOFF_MULTIPLIER;
		this.#fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
		this.#apiBaseUrl = options.apiBaseUrl ?? CURSOR_API_BASE_URL;
		this.#webBaseUrl = options.webBaseUrl ?? CURSOR_WEB_BASE_URL;
	}

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		const bundle = await this.loginCursor(callbacks);
		return toOAuthCredentials(bundle);
	}

	async loginCursor(callbacks: OAuthLoginCallbacks): Promise<CursorCredentialBundle> {
		const { verifier, challenge } = createPkcePair(this.#randomBytes);
		const uuid = this.#uuid();
		const loginUrl = new URL(CURSOR_LOGIN_PATH, this.#webBaseUrl);
		loginUrl.searchParams.set("challenge", challenge);
		loginUrl.searchParams.set("uuid", uuid);
		loginUrl.searchParams.set("mode", "login");
		loginUrl.searchParams.set("redirectTarget", "cli");
		callbacks.onAuth({
			url: loginUrl.toString(),
			instructions: "Complete the experimental Cursor login in your browser.",
		});
		callbacks.onProgress?.("Waiting for Cursor browser login...");

		let delayMs = this.#initialPollDelayMs;
		let consecutiveErrors = 0;
		for (let attempt = 0; attempt < this.#maxPollAttempts; attempt += 1) {
			if (callbacks.signal?.aborted) {
				throw new CursorAuthError("LoginCancelled", "Cursor login was cancelled.");
			}

			const pollUrl = new URL(CURSOR_AUTH_POLL_PATH, this.#apiBaseUrl);
			pollUrl.searchParams.set("uuid", uuid);
			pollUrl.searchParams.set("verifier", verifier);

			let response: Response;
			try {
				response = await this.fetchWithDeadline(pollUrl.toString(), { method: "GET" }, callbacks.signal);
			} catch {
				if (callbacks.signal?.aborted) throw new CursorAuthError("LoginCancelled", "Cursor login was cancelled.");
				consecutiveErrors += 1;
				if (consecutiveErrors >= 3) {
					throw new CursorAuthError("NetworkError", "Cursor login polling failed after repeated network errors.");
				}
				await this.#sleep(delayMs, callbacks.signal);
				delayMs = Math.min(this.#maxPollDelayMs, Math.ceil(delayMs * this.#pollBackoffMultiplier));
				continue;
			}

			if (response.status === 404) {
				consecutiveErrors = 0;
				await this.#sleep(delayMs, callbacks.signal);
				delayMs = Math.min(this.#maxPollDelayMs, Math.ceil(delayMs * this.#pollBackoffMultiplier));
				continue;
			}

			if (!response.ok) {
				consecutiveErrors += 1;
				if (consecutiveErrors >= 3) {
					const responseText = await response.text();
					throw new CursorAuthError(
						"PollRejected",
						`Cursor login polling was rejected (${response.status}): ${sanitizeDiagnosticText(responseText, [verifier, uuid, pollUrl.toString()])}`,
						response.status,
					);
				}
				await this.#sleep(delayMs, callbacks.signal);
				delayMs = Math.min(this.#maxPollDelayMs, Math.ceil(delayMs * this.#pollBackoffMultiplier));
				continue;
			}

			const tokenResponse = parseTokenResponse(await response.text());
			if (!tokenResponse || tokenResponse.refreshToken.length === 0) {
				throw new CursorAuthError("PollRejected", "Cursor login response did not include usable tokens.", response.status);
			}

			callbacks.onProgress?.("Cursor login complete.");
			return {
				access: new CursorToken("access", tokenResponse.accessToken),
				refresh: new CursorToken("refresh", tokenResponse.refreshToken),
				expires: deriveCursorTokenExpiry(tokenResponse.accessToken, this.#now),
			};
		}

		throw new CursorAuthError("PollTimedOut", "Cursor login timed out before authorization completed.");
	}

	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		const bundle = await this.refreshCursorCredentials(fromOAuthCredentials(credentials));
		return toOAuthCredentials(bundle);
	}

	async refreshCursorCredentials(credentials: CursorCredentialBundle): Promise<CursorCredentialBundle> {
		const refresh = credentials.refresh.unwrap();
		let response: Response;
		try {
			response = await this.fetchWithDeadline(new URL(CURSOR_REFRESH_PATH, this.#apiBaseUrl).toString(), {
				method: "POST",
				headers: {
					Authorization: `Bearer ${refresh}`,
					"Content-Type": "application/json",
				},
				body: "{}",
			});
		} catch {
			throw new CursorAuthError("NetworkError", "Cursor token refresh failed because the network request failed.");
		}

		if (response.status === 401 || response.status === 403) {
			throw new CursorAuthError("RefreshTokenExpired", "Cursor refresh token expired or was rejected; run /login again.", response.status);
		}
		if (!response.ok) {
			const responseText = await response.text();
			throw new CursorAuthError(
				"CursorApiRejected",
				`Cursor token refresh failed (${response.status}): ${sanitizeDiagnosticText(responseText, [refresh])}`,
				response.status,
			);
		}

		const tokenResponse = parseTokenResponse(await response.text());
		if (!tokenResponse) {
			throw new CursorAuthError("CursorApiRejected", "Cursor token refresh response did not include an access token.", response.status);
		}
		return {
			access: new CursorToken("access", tokenResponse.accessToken),
			refresh: new CursorToken("refresh", tokenResponse.refreshToken || refresh),
			expires: deriveCursorTokenExpiry(tokenResponse.accessToken, this.#now),
		};
	}

	private async fetchWithDeadline(url: string, init: RequestInit, parentSignal?: AbortSignal): Promise<Response> {
		const controller = new AbortController();
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const timeoutPromise = new Promise<never>((_, reject) => {
			timeout = setTimeout(() => {
				controller.abort();
				reject(new CursorAuthError("NetworkError", "Cursor authentication request timed out."));
			}, this.#fetchTimeoutMs);
			timeout.unref?.();
		});
		const onAbort = (): void => controller.abort();
		parentSignal?.addEventListener("abort", onAbort, { once: true });
		try {
			return await Promise.race([this.#fetch(url, { ...init, signal: controller.signal }), timeoutPromise]);
		} finally {
			if (timeout) clearTimeout(timeout);
			parentSignal?.removeEventListener("abort", onAbort);
		}
	}
}

function parseTokenResponse(text: string): CursorTokenResponse | undefined {
	const parsed = parseJsonObject(text);
	if (!parsed) return undefined;
	const accessToken = readStringField(parsed, "accessToken") ?? readStringField(parsed, "access_token");
	const refreshToken = readStringField(parsed, "refreshToken") ?? readStringField(parsed, "refresh_token") ?? "";
	if (!accessToken) return undefined;
	return { accessToken, refreshToken };
}

function defaultRandomBytes(length: number): Uint8Array {
	return nodeRandomBytes(length);
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) {
		return Promise.reject(new CursorAuthError("LoginCancelled", "Cursor login was cancelled."));
	}
	return new Promise((resolve, reject) => {
		const abort = (): void => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			reject(new CursorAuthError("LoginCancelled", "Cursor login was cancelled."));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", abort);
			resolve();
		}, milliseconds);
		signal?.addEventListener("abort", abort, { once: true });
	});
}
