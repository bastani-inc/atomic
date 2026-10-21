import type { JsonValue } from "../types.ts";

/** A token endpoint's error code and description, as the provider sent them. */
export interface OAuthErrorDetail {
	code?: string;
	description?: string;
}

/** A token endpoint's answer to a refresh, by HTTP status and the provider's error code and description. */
export interface OAuthRefreshRejection extends OAuthErrorDetail {
	status: number;
}

/** Codes that mean the stored refresh token can never be used again (OAuth 2.0 and OpenAI's refresh_token_*). */
const PERMANENT_REFRESH_ERROR_CODES = new Set([
	"invalid_grant",
	"refresh_token_expired",
	"refresh_token_reused",
	"refresh_token_invalidated",
]);

/** HTTP 401 from a token endpoint: the provider no longer accepts this login, whatever its error code. */
const UNAUTHORIZED_STATUS = 401;

/** A longer description is dropped rather than cut, so an echoed token cannot survive as a prefix. */
const MAX_DESCRIPTION_LENGTH = 300;
const ERROR_CODE_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Network errors raised before a request was sent: the connection was never established, so the server cannot
 * have seen (or rotated) the refresh token. Node reports the code on `cause`; Bun on the error itself.
 */
const UNDELIVERED_REQUEST_ERROR_CODES = new Set([
	"ECONNREFUSED",
	"ENOTFOUND",
	"EAI_AGAIN",
	"ENETUNREACH",
	"EHOSTUNREACH",
	"UND_ERR_CONNECT_TIMEOUT",
]);

function textField(value: JsonValue | undefined): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function objectField(value: JsonValue | undefined): { readonly [key: string]: JsonValue } | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as { readonly [key: string]: JsonValue })
		: undefined;
}

/** Reads `error` / `error.code` / `code` and `error_description` / `error.message` / `message` from a JSON body. */
export function parseOAuthErrorBody(body: string): OAuthErrorDetail {
	let parsed: JsonValue;
	try {
		parsed = JSON.parse(body);
	} catch {
		return {};
	}
	const json = objectField(parsed);
	if (!json) return {};
	const nested = objectField(json.error);
	return {
		code: textField(json.error) ?? textField(nested?.code) ?? textField(json.code),
		description: textField(json.error_description) ?? textField(nested?.message) ?? textField(json.message),
	};
}

/** Whether a refresh rejection means the stored login is revoked or expired, so only signing in again helps. */
export function isPermanentRefreshRejection(rejection: OAuthRefreshRejection): boolean {
	return (
		rejection.status === UNAUTHORIZED_STATUS ||
		(rejection.code !== undefined && isPermanentRefreshErrorCode(rejection.code))
	);
}

/** Whether `code` is one of the OAuth error codes that mark a refresh token as permanently unusable. */
export function isPermanentRefreshErrorCode(code: string): boolean {
	return PERMANENT_REFRESH_ERROR_CODES.has(code.toLowerCase());
}

const JSON_STRING = String.raw`"((?:[^"\\]|\\.)*)"`;
const TEXT_ERROR_CODE_PATTERNS = [
	new RegExp(String.raw`"error"\s*:\s*${JSON_STRING}`, "g"),
	new RegExp(String.raw`"error"\s*:\s*\{[^{}]*?"code"\s*:\s*${JSON_STRING}`, "g"),
	new RegExp(String.raw`"code"\s*:\s*${JSON_STRING}`, "g"),
];
const TEXT_ERROR_DESCRIPTION_PATTERNS = [
	new RegExp(String.raw`"error_description"\s*:\s*${JSON_STRING}`),
	new RegExp(String.raw`"error"\s*:\s*\{[^{}]*?"message"\s*:\s*${JSON_STRING}`),
];
const BARE_PERMANENT_REFRESH_ERROR_CODE = new RegExp(String.raw`\b(${[...PERMANENT_REFRESH_ERROR_CODES].join("|")})\b`, "i");

function jsonStringContent(escaped: string): string | undefined {
	try {
		const value: JsonValue = JSON.parse(`"${escaped}"`);
		return typeof value === "string" ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Finds a permanent refresh rejection in an error message from a refresher that does not throw
 * {@link OAuthRefreshRejectedError}: an embedded JSON error body (`error`, nested `error.code`, or `code`) or a bare
 * permanent code, plus the body's description. Returns nothing if no permanent code appears.
 */
export function findPermanentRefreshRejectionInText(text: string): OAuthErrorDetail | undefined {
	const embeddedCodes = TEXT_ERROR_CODE_PATTERNS.flatMap((pattern) =>
		[...text.matchAll(pattern)].map((match) => jsonStringContent(match[1] ?? "")),
	);
	const code =
		embeddedCodes.find((candidate) => candidate !== undefined && isPermanentRefreshErrorCode(candidate)) ??
		BARE_PERMANENT_REFRESH_ERROR_CODE.exec(text)?.[1];
	if (code === undefined) return undefined;
	const description = TEXT_ERROR_DESCRIPTION_PATTERNS.map((pattern) => pattern.exec(text)?.[1])
		.map((escaped) => (escaped === undefined ? undefined : jsonStringContent(escaped)))
		.find((candidate) => candidate !== undefined);
	return { code, description };
}

/** The provider's error code, if it looks like one; anything else could be echoed request data. */
export function safeOAuthErrorCode(code: string | undefined): string | undefined {
	return code !== undefined && ERROR_CODE_PATTERN.test(code) ? code : undefined;
}

/** The provider's description, unless it echoes a presented secret, carries a URL, or is too long to be one. */
export function safeOAuthErrorDescription(
	description: string | undefined,
	presentedSecrets: readonly string[],
): string | undefined {
	const text = description?.replace(/\s+/g, " ").trim();
	if (!text || text.length > MAX_DESCRIPTION_LENGTH || URL_PATTERN.test(text)) return undefined;
	return presentedSecrets.some((secret) => secret.length > 0 && text.includes(secret)) ? undefined : text;
}

/** `: code: description` with only the parts that are safe to show, or nothing. */
export function formatOAuthErrorDetail(detail: OAuthErrorDetail, presentedSecrets: readonly string[]): string {
	const parts = [safeOAuthErrorCode(detail.code), safeOAuthErrorDescription(detail.description, presentedSecrets)];
	const shown = parts.filter((part): part is string => part !== undefined);
	return shown.length > 0 ? `: ${shown.join(": ")}` : "";
}

/**
 * A token endpoint rejected a refresh because the stored login is revoked or expired. Carries only the HTTP status
 * and the provider's error code and description, the latter dropped if it echoes the presented token.
 */
export class OAuthRefreshRejectedError extends Error {
	override readonly name = "OAuthRefreshRejectedError";
	readonly status: number;
	readonly code: string | undefined;
	readonly description: string | undefined;

	constructor(summary: string, rejection: OAuthRefreshRejection, presentedSecrets: readonly string[]) {
		super(`${summary}${formatOAuthErrorDetail(rejection, presentedSecrets)}`);
		this.status = rejection.status;
		this.code = safeOAuthErrorCode(rejection.code);
		this.description = safeOAuthErrorDescription(rejection.description, presentedSecrets);
	}
}

/** Recognises the rejection across duplicated module copies (source and built output), not only by identity. */
export function isOAuthRefreshRejectedError(error: Error): error is OAuthRefreshRejectedError {
	return (
		error instanceof OAuthRefreshRejectedError ||
		(error.name === "OAuthRefreshRejectedError" && "status" in error && typeof error.status === "number")
	);
}

function errorCode(error: Error): string | undefined {
	const code = "code" in error ? error.code : undefined;
	return typeof code === "string" ? code : undefined;
}

/**
 * Whether a failed fetch provably never sent its request (no connection was made). Only then may a refresh token be
 * presented again: after an abort, a timeout, or a connection lost mid-request the server may already have rotated it.
 */
export function requestNeverReachedServer(error: Error): boolean {
	if (error.name === "AbortError" || error.name === "TimeoutError") return false;
	const cause = error.cause instanceof Error ? error.cause : undefined;
	const code = errorCode(error) ?? (cause ? errorCode(cause) : undefined);
	return code !== undefined && UNDELIVERED_REQUEST_ERROR_CODES.has(code);
}
