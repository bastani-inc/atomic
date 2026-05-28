import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";

const CURSOR_LOGIN_URL = "https://cursor.com/loginDeepControl";
const CURSOR_POLL_URL = "https://api2.cursor.sh/auth/poll";
const CURSOR_REFRESH_URL = "https://api2.cursor.sh/auth/exchange_user_api_key";
const DEFAULT_POLL_INTERVAL_MS = 1_500;
const DEFAULT_POLL_TIMEOUT_MS = 5 * 60_000;
const EXPIRY_SKEW_MS = 5 * 60_000;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface CursorCredentials extends OAuthCredentials {
	access: string;
	refresh: string;
	expires: number;
}

export interface CursorPkcePair {
	verifier: string;
	challenge: string;
}

export interface CursorLoginUrlOptions {
	uuid: string;
	challenge: string;
}

export interface PollCursorAuthOptions {
	uuid: string;
	verifier: string;
	fetch?: FetchLike;
	intervalMs?: number;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface RefreshCursorTokenOptions {
	fetch?: FetchLike;
	signal?: AbortSignal;
}

function base64Url(bytes: ArrayBuffer | Uint8Array): string {
	const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let binary = "";
	for (const byte of data) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function randomBase64Url(byteLength: number): string {
	const bytes = new Uint8Array(byteLength);
	crypto.getRandomValues(bytes);
	return base64Url(bytes);
}

function toCredentials(raw: Record<string, unknown>, refreshFallback?: string): CursorCredentials {
	const access = raw.accessToken ?? raw.access_token ?? raw.access;
	const refresh = raw.refreshToken ?? raw.refresh_token ?? raw.refresh ?? refreshFallback;
	const expires = raw.expiresAt ?? raw.expires_at ?? raw.expires;
	const expiresIn = raw.expiresIn ?? raw.expires_in;

	if (typeof access !== "string" || access.length === 0) {
		throw new Error("Cursor token response did not include an access token");
	}
	if (typeof refresh !== "string" || refresh.length === 0) {
		throw new Error("Cursor token response did not include a refresh token");
	}

	let expiresMs: number | undefined;
	if (typeof expires === "number") {
		expiresMs = expires < 10_000_000_000 ? expires * 1000 : expires;
	} else if (typeof expiresIn === "number") {
		expiresMs = Date.now() + expiresIn * 1000;
	} else {
		expiresMs = decodeJwtExpiry(access);
	}

	return {
		access,
		refresh,
		expires: Math.max(Date.now(), (expiresMs ?? Date.now() + 30 * 60_000) - EXPIRY_SKEW_MS),
	};
}

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
	const raw = await response.text();
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// Fall through to useful error below.
	}
	throw new Error(`Cursor returned invalid JSON: ${raw.slice(0, 200)}`);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(new Error("Login cancelled"));
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timeout);
			reject(new Error("Login cancelled"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export async function generatePkcePair(): Promise<CursorPkcePair> {
	const verifier = randomBase64Url(32);
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return { verifier, challenge: base64Url(digest) };
}

export function buildCursorLoginUrl(options: CursorLoginUrlOptions): string {
	const url = new URL(CURSOR_LOGIN_URL);
	url.searchParams.set("uuid", options.uuid);
	url.searchParams.set("challenge", options.challenge);
	url.searchParams.set("mode", "login");
	url.searchParams.set("redirectTarget", "cli");
	return url.toString();
}

export function decodeJwtExpiry(token: string): number | undefined {
	const [, payload] = token.split(".");
	if (!payload) return undefined;
	try {
		const normalized = payload.replaceAll("-", "+").replaceAll("_", "/");
		const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
		const parsed = JSON.parse(atob(padded)) as { exp?: unknown };
		return typeof parsed.exp === "number" ? parsed.exp * 1000 : undefined;
	} catch {
		return undefined;
	}
}

export async function pollCursorAuth(options: PollCursorAuthOptions): Promise<CursorCredentials> {
	const fetchImpl = options.fetch ?? fetch;
	const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const timeoutMs = options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
	const deadline = Date.now() + timeoutMs;
	let consecutiveErrors = 0;

	while (Date.now() <= deadline) {
		if (options.signal?.aborted) throw new Error("Login cancelled");
		const url = new URL(CURSOR_POLL_URL);
		url.searchParams.set("uuid", options.uuid);
		url.searchParams.set("verifier", options.verifier);

		try {
			const response = await fetchImpl(url.toString(), { signal: options.signal });
			if (response.status === 404 || response.status === 202 || response.status === 204) {
				await delay(intervalMs, options.signal);
				continue;
			}
			if (!response.ok) {
				consecutiveErrors += 1;
				if (consecutiveErrors >= 3) {
					throw new Error(`Cursor auth poll failed with HTTP ${response.status}: ${await response.text()}`);
				}
				await delay(intervalMs, options.signal);
				continue;
			}
			return toCredentials(await readJsonObject(response));
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("Cursor auth poll failed")) throw error;
			consecutiveErrors += 1;
			if (consecutiveErrors >= 3) throw error;
			await delay(intervalMs, options.signal);
		}
	}

	throw new Error("Timed out waiting for Cursor authentication");
}

export async function refreshCursorToken(
	credentials: OAuthCredentials,
	options: RefreshCursorTokenOptions = {},
): Promise<CursorCredentials> {
	const fetchImpl = options.fetch ?? fetch;
	const response = await fetchImpl(CURSOR_REFRESH_URL, {
		method: "POST",
		headers: {
			accept: "application/json",
			authorization: `Bearer ${credentials.refresh}`,
		},
		signal: options.signal,
	});
	if (!response.ok) {
		throw new Error(`Cursor token refresh failed with HTTP ${response.status}: ${await response.text()}`);
	}
	return toCredentials(await readJsonObject(response), credentials.refresh);
}

export async function loginCursor(callbacks: OAuthLoginCallbacks): Promise<CursorCredentials> {
	const { verifier, challenge } = await generatePkcePair();
	const uuid = crypto.randomUUID();
	callbacks.onAuth({
		url: buildCursorLoginUrl({ uuid, challenge }),
		instructions:
			"Complete Cursor login in your browser. This experimental provider uses unofficial Cursor private APIs and may break without notice.",
	});
	callbacks.onProgress?.("Waiting for Cursor authentication...");
	return pollCursorAuth({ uuid, verifier, signal: callbacks.signal });
}
