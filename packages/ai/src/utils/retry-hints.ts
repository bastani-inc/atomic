import type { JsonObject, JsonValue } from "../types.ts";

interface HeaderReader {
	get(name: string): string | null;
}

function positiveDelay(value: number): number | undefined {
	return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isHeaderReader(value: object | null): value is HeaderReader {
	return value !== null && "get" in value && typeof value.get === "function";
}

/** Reads a plain header record (as the AWS SDK keeps on `$response.headers`) case-insensitively. */
function recordHeaderReader(record: object): HeaderReader {
	const entries = Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === "string");
	return {
		get(name: string): string | null {
			const lower = name.toLowerCase();
			return entries.find(([key]) => key.toLowerCase() === lower)?.[1] ?? null;
		},
	};
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A protobuf JSON `Duration` such as `"17s"` or `"0.250s"`, in ms. */
function durationMs(value: JsonValue | undefined): number | undefined {
	if (typeof value !== "string") return undefined;
	const match = /^\s*(\d+(?:\.\d+)?)s\s*$/.exec(value);
	return match ? positiveDelay(Number(match[1]) * 1000) : undefined;
}

/**
 * Retry hints in a parsed JSON error body: a top-level or `error.retry_after` in seconds (Cloudflare 5xx
 * pages), and a `RetryInfo` entry's `retryDelay` in `error.details` (Google APIs). Arrays of bodies, as
 * some streaming endpoints send, are searched entry by entry.
 */
function bodyHints(parsed: JsonValue, hints: number[]): void {
	if (Array.isArray(parsed)) {
		for (const entry of parsed) bodyHints(entry, hints);
		return;
	}
	if (!isJsonObject(parsed)) return;
	const error = isJsonObject(parsed.error) ? parsed.error : undefined;
	const seconds = parsed.retry_after ?? error?.retry_after;
	if (typeof seconds === "number") {
		const delay = positiveDelay(seconds * 1000);
		if (delay !== undefined) hints.push(delay);
	}
	const details = error?.details;
	if (!Array.isArray(details)) return;
	for (const detail of details) {
		if (!isJsonObject(detail)) continue;
		const type = detail["@type"];
		if (typeof type !== "string" || !type.endsWith("google.rpc.RetryInfo")) continue;
		const delay = durationMs(detail.retryDelay);
		if (delay !== undefined) hints.push(delay);
	}
}

/** Parses `text` as JSON, or the JSON that follows a prefix such as `got status: 429. {...}`. */
function parseJsonBody(text: string): JsonValue | undefined {
	const start = text.search(/[[{]/);
	if (start < 0) return undefined;
	try {
		return JSON.parse(text.slice(start)) as JsonValue;
	} catch {
		return undefined;
	}
}

/**
 * Largest server retry hint in ms from `Retry-After-Ms`, `Retry-After` (seconds or HTTP date), a JSON body
 * `retry_after` in seconds (Cloudflare 5xx pages) and a body `RetryInfo.retryDelay` (Google APIs).
 */
export function getRetryAfterMs(headers?: HeaderReader, body?: string, now = Date.now()): number | undefined {
	const hints: number[] = [];
	const milliseconds = headers?.get("retry-after-ms");
	if (milliseconds?.trim()) {
		const delay = positiveDelay(Number(milliseconds));
		if (delay !== undefined) hints.push(delay);
	}
	const retryAfter = headers?.get("retry-after");
	if (retryAfter?.trim()) {
		const seconds = Number(retryAfter);
		const delay = positiveDelay(Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - now);
		if (delay !== undefined) hints.push(delay);
	}
	if (body) {
		const parsed = parseJsonBody(body);
		if (parsed !== undefined) bodyHints(parsed, hints);
	}
	return hints.length ? Math.max(...hints) : undefined;
}

function errorHeaders(error: object): HeaderReader | undefined {
	if ("headers" in error && typeof error.headers === "object" && isHeaderReader(error.headers)) return error.headers;
	// AWS SDK service exceptions keep the raw HTTP response, with a plain header record, on `$response`.
	if ("$response" in error && typeof error.$response === "object" && error.$response !== null) {
		const response = error.$response;
		if ("headers" in response && typeof response.headers === "object" && response.headers !== null) {
			return isHeaderReader(response.headers) ? response.headers : recordHeaderReader(response.headers);
		}
	}
	return undefined;
}

function errorBody(error: object): string | undefined {
	if ("body" in error && typeof error.body === "string") return error.body;
	if ("error" in error && error.error !== undefined) return JSON.stringify(error.error);
	// SDKs that fold the JSON error body into the message (`@google/genai`'s ApiError).
	if (error instanceof Error && /[[{]/.test(error.message)) return error.message;
	return undefined;
}

/**
 * Server retry hint carried by a provider error (`headers` or an AWS `$response`, plus a parsed body `error`,
 * raw string `body` or a JSON body folded into the message), or an explicit `retryAfterMs`.
 */
export function getProviderRetryAfterMs(error: object): number | undefined {
	if ("retryAfterMs" in error && typeof error.retryAfterMs === "number") return positiveDelay(error.retryAfterMs);
	return getRetryAfterMs(errorHeaders(error), errorBody(error));
}
