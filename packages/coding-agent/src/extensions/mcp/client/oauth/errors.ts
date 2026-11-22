import { redactUrlCredentials } from "./redact.js";

export class OAuthError extends Error {
	readonly code: string;
	readonly errorUri: string | undefined;
	/** HTTP status of the response that reported the error. */
	readonly status: number | undefined;

	constructor(code: string, message: string, errorUri?: string, status?: number) {
		super(message || code);
		this.name = "OAuthError";
		this.code = code;
		this.errorUri = errorUri;
		this.status = status;
	}
}

/**
 * A token refresh failed for a reason that may pass (a 5xx or 429 answer, `server_error`,
 * `temporarily_unavailable`, a network error, or a timeout). The stored grant is still valid.
 */
export class OAuthTemporarilyUnavailableError extends Error {
	constructor(cause: unknown) {
		const reason = cause instanceof Error ? cause.message : String(cause);
		super(`OAuth authorization server temporarily unavailable during token refresh: ${reason}`, { cause });
		this.name = "OAuthTemporarilyUnavailableError";
	}
}

export class OAuthIssuerMismatchError extends Error {
	/** `undefined` when no authorization server metadata was discovered. */
	readonly expected: string | undefined;
	/** `undefined` when an authorization response lacks the `iss` parameter its server promised (RFC 9207). */
	readonly received: string | undefined;

	constructor(expected: string | undefined, received: string | undefined) {
		const format = (issuer: string | undefined) =>
			issuer === undefined ? "none" : JSON.stringify(redactUrlCredentials(issuer, "server-url"));
		super(`OAuth issuer mismatch: expected ${format(expected)}, received ${format(received)}`);
		this.name = "OAuthIssuerMismatchError";
		this.expected = expected === undefined ? undefined : redactUrlCredentials(expected, "server-url");
		this.received = received === undefined ? undefined : redactUrlCredentials(received, "server-url");
	}
}

export class OAuthInsecureEndpointError extends Error {
	readonly endpoint: string;

	constructor(endpoint: string) {
		const safeEndpoint = redactUrlCredentials(endpoint, "server-url");
		super(`Refusing to send OAuth credentials to non-HTTPS endpoint ${safeEndpoint}`);
		this.name = "OAuthInsecureEndpointError";
		this.endpoint = safeEndpoint;
	}
}

export class OAuthRegistrationError extends Error {
	readonly status: number;
	readonly body: string;

	constructor(status: number, body: string) {
		super(`OAuth dynamic client registration failed with status ${status}: ${body}`);
		this.name = "OAuthRegistrationError";
		this.status = status;
		this.body = body;
	}
}

export class McpOAuthAuthorizationRequiredError extends Error {
	constructor() {
		super("MCP OAuth authorization requires user interaction");
		this.name = "McpOAuthAuthorizationRequiredError";
	}
}
