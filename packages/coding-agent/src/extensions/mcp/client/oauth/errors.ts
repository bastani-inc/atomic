import { redactOAuthErrorText, redactUrlForDisplay } from "./redact.js";

export class OAuthError extends Error {
	readonly code: string;
	readonly errorUri: string | undefined;
	/** HTTP status of the response that reported the error. */
	readonly status: number | undefined;

	constructor(code: string, message: string, errorUri?: string, status?: number) {
		const safeCode = redactOAuthErrorText(code);
		const safeMessage = message ? redactOAuthErrorText(message) : safeCode;
		super(safeMessage);
		this.name = "OAuthError";
		this.code = safeCode;
		this.errorUri = errorUri === undefined ? undefined : redactUrlForDisplay(errorUri);
		this.status = status;
	}
}

/**
 * A token refresh failed for a reason that may pass (a 5xx or 429 answer, `server_error`,
 * `temporarily_unavailable`, a network error, or a timeout). The stored grant is still valid.
 */
export class OAuthTemporarilyUnavailableError extends Error {
	constructor(cause: unknown) {
		const reason = redactOAuthErrorText(cause instanceof Error ? cause.message : String(cause));
		const safeCause = cause instanceof OAuthError ? cause : new Error(reason);
		super(`OAuth authorization server temporarily unavailable during token refresh: ${reason}`, { cause: safeCause });
		this.name = "OAuthTemporarilyUnavailableError";
	}
}

export class OAuthIssuerMismatchError extends Error {
	/** `undefined` when no authorization server metadata was discovered. */
	readonly expected: string | undefined;
	/** `undefined` when an authorization response lacks the `iss` parameter its server promised (RFC 9207). */
	readonly received: string | undefined;

	constructor(expected: string | undefined, received: string | undefined) {
		const safeExpected = expected === undefined ? undefined : redactUrlForDisplay(expected);
		const safeReceived = received === undefined ? undefined : redactUrlForDisplay(received);
		const format = (issuer: string | undefined) => (issuer === undefined ? "none" : JSON.stringify(issuer));
		super(`OAuth issuer mismatch: expected ${format(safeExpected)}, received ${format(safeReceived)}`);
		this.name = "OAuthIssuerMismatchError";
		this.expected = safeExpected;
		this.received = safeReceived;
	}
}

export class OAuthInsecureEndpointError extends Error {
	readonly endpoint: string;

	constructor(endpoint: string) {
		const safeEndpoint = redactUrlForDisplay(endpoint);
		super(`Refusing to send OAuth credentials to non-HTTPS endpoint ${safeEndpoint}`);
		this.name = "OAuthInsecureEndpointError";
		this.endpoint = safeEndpoint;
	}
}

export class OAuthRegistrationError extends Error {
	readonly status: number;
	readonly body: string;

	constructor(status: number, body: string) {
		const safeBody = redactOAuthErrorText(body);
		super(`OAuth dynamic client registration failed with status ${status}: ${safeBody}`);
		this.name = "OAuthRegistrationError";
		this.status = status;
		this.body = safeBody;
	}
}

export class McpOAuthAuthorizationRequiredError extends Error {
	constructor() {
		super("MCP OAuth authorization requires user interaction");
		this.name = "McpOAuthAuthorizationRequiredError";
	}
}
