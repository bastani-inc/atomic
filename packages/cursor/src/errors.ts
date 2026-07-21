export type CursorErrorCode =
	| "AuthenticationMissing"
	| "AuthenticationMalformed"
	| "AuthenticationExpired"
	| "AuthenticationRejected"
	| "DiscoveryFailed"
	| "ProtocolMalformed"
	| "ProtocolError"
	| "TransportError"
	| "Timeout"
	| "ServerError"
	| "Cancelled"
	| "AmbiguousSelection"
	| "UnsupportedSelection"
	| "StaleGeneration"
	| "Disposed";

export type CursorOperation = "authentication" | "discovery" | "preparation" | "selection" | "request" | "stream" | "cache";

export interface CursorErrorRouteContext {
	readonly routeId: string;
	readonly maxMode: boolean | undefined;
	readonly occurrence: number;
}

export interface CursorErrorOptions {
	readonly operation: CursorOperation;
	readonly route?: CursorErrorRouteContext;
	readonly cause?: Error;
	readonly secrets?: readonly string[];
}

export class CursorError extends Error {
	readonly provider = "cursor";
	readonly operation: CursorOperation;
	readonly code: CursorErrorCode;
	readonly route?: CursorErrorRouteContext;
	declare readonly cause?: Error;

	constructor(code: CursorErrorCode, message: string, options: CursorErrorOptions) {
		const safeMessage = sanitizeCursorDiagnostic(message, options.secrets);
		super(safeMessage, options.cause ? { cause: options.cause } : undefined);
		this.name = "CursorError";
		this.code = code;
		this.operation = options.operation;
		this.route = options.route;
		this.cause = options.cause;
	}
}
export function sanitizeCursorDiagnostic(text: string, secrets: readonly string[] = []): string {
	let sanitized = text
		.replace(/authorization\s*[:=]\s*bearer\s+[^\s"']+/giu, "authorization: Bearer [redacted]")
		.replace(/bearer\s+[A-Za-z0-9._~-]+/giu, "Bearer [redacted]")
		.replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]")
		.replace(/\b((?:access|refresh)[_-]?token)\s*[:=]\s*[^\s,;]+/giu, "$1: [redacted]");
	for (const secret of secrets) {
		if (typeof secret === "string" && secret.length > 0) sanitized = sanitized.split(secret).join("[redacted]");
	}
	return sanitized.slice(0, 1200);
}

export function cursorRouteLabel(route: CursorErrorRouteContext): string {
	const max = route.maxMode === undefined ? "absent" : route.maxMode ? "true" : "false";
	return `${JSON.stringify(route.routeId)} (max_mode=${max}, occurrence=${route.occurrence})`;
}
