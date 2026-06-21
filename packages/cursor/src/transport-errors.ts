import {
	CURSOR_CLIENT_VERSION,
	readStringField,
	sanitizeDiagnosticText,
	type JsonObject,
} from "./config.js";

export type CursorTransportErrorCode = "Unauthorized" | "CursorApiRejected" | "Aborted" | "NetworkError" | "ProtocolError";

export class CursorTransportError extends Error {
	constructor(
		readonly code: CursorTransportErrorCode,
		message: string,
	) {
		super(message);
		this.name = "CursorTransportError";
	}
}
const textDecoder = new TextDecoder();

export function sanitizeCursorTransportError(error: Error, secrets: readonly string[] = []): Error {
	const message = sanitizeDiagnosticText(error.message, secrets);
	return error instanceof CursorTransportError ? new CursorTransportError(error.code, message) : new CursorTransportError("ProtocolError", message);
}

export function throwIfCursorEndStreamError(data: Uint8Array, secrets: readonly string[]): void {
	let parsed: JsonObject;
	try {
		const value = JSON.parse(textDecoder.decode(data)) as unknown;
		if (typeof value !== "object" || value === null || Array.isArray(value)) return;
		parsed = value as JsonObject;
	} catch {
		throw new CursorTransportError("ProtocolError", "Failed to parse Cursor Connect end stream.");
	}
	const errorValue = parsed.error;
	if (!errorValue) return;
	if (typeof errorValue !== "object" || Array.isArray(errorValue)) {
		throw new CursorTransportError("CursorApiRejected", `Cursor stream ended with unknown: ${sanitizeDiagnosticText(String(errorValue), secrets)}.`);
	}
	const error = errorValue as JsonObject;
	const code = readStringField(error, "code") ?? "unknown";
	const message = readStringField(error, "message") ?? "Unknown error";
	throw new CursorTransportError(classifyConnectErrorCode(code), `Cursor stream ended with ${code}: ${sanitizeDiagnosticText(message, secrets)}.`);
}

function classifyConnectErrorCode(code: string): CursorTransportErrorCode {
	if (code === "unauthenticated") return "Unauthorized";
	if (code === "canceled") return "Aborted";
	if (code === "resource_exhausted" || code === "unavailable") return "NetworkError";
	return "CursorApiRejected";
}

export function assertSuccessfulStatus(statusCode: number | undefined, body: Uint8Array, secrets: readonly string[]): void {
	if (statusCode === undefined || (statusCode >= 200 && statusCode < 300)) return;
	const detail = sanitizeDiagnosticText(textDecoder.decode(body), secrets);
	const versionHint = cursorClientVersionHint(statusCode);
	const message = `Cursor API rejected request with HTTP ${statusCode}${detail ? `: ${detail}` : ""}${versionHint}`;
	if (statusCode === 401 || statusCode === 403) throw new CursorTransportError("Unauthorized", message);
	throw new CursorTransportError("CursorApiRejected", message);
}

function cursorClientVersionHint(statusCode: number): string {
	if (statusCode !== 403 && statusCode !== 426) return "";
	return ` Cursor may be rejecting the bundled Cursor CLI-compatible client version (${CURSOR_CLIENT_VERSION}); refresh CURSOR_CLIENT_VERSION from current Cursor CLI traffic if authentication still succeeds in Cursor itself.`;
}

export function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

export function toTransportError(error: unknown): CursorTransportError {
	if (error instanceof CursorTransportError) return error;
	return new CursorTransportError("NetworkError", toError(error).message);
}
