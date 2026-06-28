export const CURSOR_PROVIDER_ID = "cursor";
export const CURSOR_PROVIDER_NAME = "Cursor";
export const CURSOR_LOGIN_NAME = "Cursor (Experimental)";
export const CURSOR_API = "cursor-agent";
export const CURSOR_API_BASE_URL = "https://api2.cursor.sh";
export const CURSOR_WEB_BASE_URL = "https://cursor.com";
// Keep this in sync with Cursor CLI traffic if api2.cursor.sh starts rejecting
// requests after a Cursor client release. Capture the current CLI headers from
// a fresh Cursor login/model request and update this single constant.
export const CURSOR_CLIENT_VERSION = "cli-2026.01.09-231024f";
export const CURSOR_CLIENT_TYPE = "cli";
export const CURSOR_DEFAULT_MODEL_ID = "composer-2";
export const CURSOR_AUTH_POLL_PATH = "/auth/poll";
export const CURSOR_REFRESH_PATH = "/auth/exchange_user_api_key";
export const CURSOR_GET_USABLE_MODELS_PATH = "/agent.v1.AgentService/GetUsableModels";
export const CURSOR_RUN_PATH = "/agent.v1.AgentService/Run";
export const CURSOR_LOGIN_PATH = "/loginDeepControl";
export const CURSOR_OAUTH_EXPIRY_SKEW_MS = 5 * 60 * 1000;
export const CURSOR_DEFAULT_TOKEN_TTL_MS = 60 * 60 * 1000;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export interface JsonObject {
	[key: string]: JsonValue;
}
export type JsonArray = JsonValue[];

export interface CursorRpcHeaders extends Record<string, string> {
	readonly authorization: string;
	readonly "content-type": string;
	readonly te: string;
	readonly "x-cursor-client-version": string;
	readonly "x-cursor-client-type": string;
	readonly "x-ghost-mode": string;
	readonly "x-request-id": string;
}

export class CursorExperimentalProtocolError extends Error {
	readonly code = "CURSOR_EXPERIMENTAL_PROTOCOL_ERROR";

	constructor(message = "Cursor private protocol transport failed.") {
		super(message);
		this.name = "CursorExperimentalProtocolError";
	}
}

export function createCursorExperimentalProtocolError(detail?: string): CursorExperimentalProtocolError {
	return new CursorExperimentalProtocolError(
		detail
			? `Cursor protocol error: ${sanitizeDiagnosticText(detail)}`
			: "Cursor protocol error: HTTP/2/protobuf transport failed.",
	);
}

export function buildCursorRpcHeaders(accessToken: string, requestId: string, contentType: string): CursorRpcHeaders {
	return {
		authorization: `Bearer ${accessToken}`,
		"content-type": contentType,
		te: "trailers",
		"x-cursor-client-version": CURSOR_CLIENT_VERSION,
		"x-cursor-client-type": CURSOR_CLIENT_TYPE,
		"x-ghost-mode": "true",
		"x-request-id": requestId,
	};
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
	const redacted: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		redacted[key] = key.toLowerCase() === "authorization" ? "[redacted]" : redactSensitiveText(value);
	}
	return redacted;
}

export function redactSensitiveText(text: string, secrets: readonly string[] = []): string {
	let redacted = text.replace(/authorization\s*[:=]\s*bearer\s+[^\s"']+/gi, "authorization: Bearer [redacted]");
	redacted = redacted.replace(/bearer\s+(eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)/gi, "Bearer [redacted]");
	for (const secret of secrets) {
		if (secret.length === 0) continue;
		redacted = redacted.split(secret).join("[redacted]");
	}
	return redacted;
}

export function sanitizeDiagnosticText(text: string, secrets: readonly string[] = []): string {
	return redactSensitiveText(text, secrets).slice(0, 1200);
}

export function isJsonObject(value: JsonValue): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readStringField(value: JsonObject, key: string): string | undefined {
	const field = value[key];
	return typeof field === "string" ? field : undefined;
}

export function readNumberField(value: JsonObject, key: string): number | undefined {
	const field = value[key];
	return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

export function readBooleanField(value: JsonObject, key: string): boolean | undefined {
	const field = value[key];
	return typeof field === "boolean" ? field : undefined;
}

export function parseJsonObject(text: string): JsonObject | undefined {
	try {
		const parsed = JSON.parse(text) as JsonValue;
		return isJsonObject(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export function parseJsonValue(text: string): JsonValue | undefined {
	try {
		return JSON.parse(text) as JsonValue;
	} catch {
		return undefined;
	}
}
