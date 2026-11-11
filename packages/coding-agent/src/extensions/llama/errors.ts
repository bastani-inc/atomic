import {
	type ErrorFieldValue,
	findInCauseChain,
	hasErrorIdentity,
	redactUrlCredentials,
	rehydrateErrorCause,
	type SerializedTypedError,
	serializeErrorCause,
} from "../../core/error-contract.ts";

/** Stable codes of LlamaServerError. Codes are public API: never rename or reuse one. */
export type LlamaServerErrorCode = "server-unreachable" | "request-rejected";

/** Whether a caller may retry a failure with each code; a new code has to decide here. */
const RETRYABLE_BY_CODE: Readonly<Record<LlamaServerErrorCode, boolean>> = {
	"server-unreachable": true,
	"request-rejected": false,
};

const LLAMA_SERVER_ERROR_CODES: ReadonlySet<string> = new Set(Object.keys(RETRYABLE_BY_CODE));
const LLAMA_SERVER_ERROR_NAMES: ReadonlySet<string> = new Set([
	"LlamaServerError",
	"LlamaServerUnreachableError",
	"LlamaServerRequestError",
]);
const UNREACHABLE_NAMES: ReadonlySet<string> = new Set(["LlamaServerUnreachableError"]);
const UNREACHABLE_CODES: ReadonlySet<string> = new Set<LlamaServerErrorCode>(["server-unreachable"]);
const REQUEST_REJECTED_NAMES: ReadonlySet<string> = new Set(["LlamaServerRequestError"]);
const REQUEST_REJECTED_CODES: ReadonlySet<string> = new Set<LlamaServerErrorCode>(["request-rejected"]);

const UNREACHABLE_HINT =
	"Check that llama-server is running, and that the URL, port and http or https scheme in /login llama.cpp or LLAMA_BASE_URL are right.";
const REQUEST_REJECTED_HINT =
	"Check the server URL in /login llama.cpp or LLAMA_BASE_URL: use a plain http or https address without a user name or password (give an API key separately), on a port that fetch does not block, such as the default 9931.";

/** The server URL without user information, so it can go into messages and fields. */
function displayServerUrl(serverUrl: string): string {
	try {
		const url = new URL(serverUrl);
		url.username = "";
		url.password = "";
		return url.toString().replace(/\/$/u, "");
	} catch {
		return redactUrlCredentials(serverUrl, "server-url");
	}
}

/** A request to a llama.cpp router server failed. Branch on `code` or the class. */
export class LlamaServerError extends Error {
	override readonly name: string = "LlamaServerError";
	readonly code: LlamaServerErrorCode;
	/** The server URL, without user information. */
	readonly serverUrl: string;
	readonly hint: string | undefined;
	readonly retryable: boolean;

	constructor(
		message: string,
		options: { code: LlamaServerErrorCode; serverUrl: string; hint?: string; retryable: boolean; cause?: unknown },
	) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.code = options.code;
		this.serverUrl = displayServerUrl(options.serverUrl);
		this.hint = options.hint;
		this.retryable = options.retryable;
	}

	/** The JSON-safe facts beyond the name, code, message and hint. */
	get fields(): Record<string, ErrorFieldValue> {
		return { serverUrl: this.serverUrl };
	}

	toJSON(): SerializedTypedError {
		const cause = serializeErrorCause(this.cause);
		return {
			name: this.name,
			code: this.code,
			message: this.message,
			...(this.hint === undefined ? {} : { hint: this.hint }),
			retryable: this.retryable,
			fields: this.fields,
			...(cause ? { cause } : {}),
		};
	}
}

/**
 * `fetch` failed before the server answered: connection refused or nothing listening on the port, DNS, or https
 * against a plain-HTTP server. `detail` is the network-level reason from the cause chain, for example `connect ECONNREFUSED ...`.
 */
export class LlamaServerUnreachableError extends LlamaServerError {
	override readonly name = "LlamaServerUnreachableError" as const;
	declare readonly code: "server-unreachable";
	readonly detail: string;

	constructor(serverUrl: string, detail: string, options?: { cause?: unknown }) {
		const displayed = displayServerUrl(serverUrl);
		const safeDetail = redactUrlCredentials(detail);
		super(
			`Could not reach llama.cpp server at ${displayed}: ${safeDetail} (server-unreachable). ${UNREACHABLE_HINT}`,
			{
				code: "server-unreachable",
				serverUrl,
				hint: UNREACHABLE_HINT,
				retryable: RETRYABLE_BY_CODE["server-unreachable"],
				cause: options?.cause,
			},
		);
		this.detail = safeDetail;
	}

	override get fields(): Record<string, ErrorFieldValue> {
		return { serverUrl: this.serverUrl, detail: this.detail };
	}
}

/**
 * The runtime refused to send the request, so the server was never contacted: for example Node's fetch rejects a URL
 * that contains a user name or password, or a port it blocks such as 6000. Retrying the same request fails the same
 * way. `detail` is the runtime's reason with URL credentials removed.
 */
export class LlamaServerRequestError extends LlamaServerError {
	override readonly name = "LlamaServerRequestError" as const;
	declare readonly code: "request-rejected";
	readonly detail: string;

	constructor(serverUrl: string, detail: string, options?: { cause?: unknown }) {
		const displayed = displayServerUrl(serverUrl);
		const safeDetail = redactUrlCredentials(detail);
		super(
			`Could not send a request to llama.cpp server at ${displayed}: ${safeDetail} (request-rejected). ${REQUEST_REJECTED_HINT}`,
			{
				code: "request-rejected",
				serverUrl,
				hint: REQUEST_REJECTED_HINT,
				retryable: RETRYABLE_BY_CODE["request-rejected"],
				cause: options?.cause,
			},
		);
		this.detail = safeDetail;
	}

	override get fields(): Record<string, ErrorFieldValue> {
		return { serverUrl: this.serverUrl, detail: this.detail };
	}
}

/** Whether `error` is a LlamaServerError, also from another realm or a rehydrated relay. */
export function isLlamaServerError(error: unknown): error is LlamaServerError {
	return (
		error instanceof LlamaServerError || hasErrorIdentity(error, LLAMA_SERVER_ERROR_NAMES, LLAMA_SERVER_ERROR_CODES)
	);
}

/** Whether `error` is a LlamaServerUnreachableError, also from another realm or a rehydrated relay. */
export function isLlamaServerUnreachableError(error: unknown): error is LlamaServerUnreachableError {
	return error instanceof LlamaServerUnreachableError || hasErrorIdentity(error, UNREACHABLE_NAMES, UNREACHABLE_CODES);
}

/** Whether `error` is a LlamaServerRequestError, also from another realm or a rehydrated relay. */
export function isLlamaServerRequestError(error: unknown): error is LlamaServerRequestError {
	return (
		error instanceof LlamaServerRequestError ||
		hasErrorIdentity(error, REQUEST_REJECTED_NAMES, REQUEST_REJECTED_CODES)
	);
}

/** The first LlamaServerError in `error`'s cause chain, for a wrapper such as a failed login. */
export function findLlamaServerError(error: unknown): LlamaServerError | undefined {
	return findInCauseChain(error, isLlamaServerError);
}

/**
 * Whether `error`, or a LlamaServerError in its cause chain, is a failure a caller may retry. Decided by `code`, so a
 * relayed error without a `retryable` field gets the same answer.
 */
export function isRetryableLlamaServerError(error: unknown): boolean {
	const found = findLlamaServerError(error);
	return found !== undefined && Object.hasOwn(RETRYABLE_BY_CODE, found.code) && RETRYABLE_BY_CODE[found.code];
}

/**
 * Rebuilds a serialized LlamaServerError. The concrete class comes back only when the name and the code agree; any
 * other pair becomes the family base with the original name and code, and URL credentials are removed from its message.
 */
export function rehydrateLlamaServerError(serialized: SerializedTypedError): LlamaServerError {
	const cause = rehydrateErrorCause(serialized.cause);
	const serverUrl = typeof serialized.fields.serverUrl === "string" ? serialized.fields.serverUrl : "";
	const detail = typeof serialized.fields.detail === "string" ? serialized.fields.detail : "";
	if (isLlamaServerUnreachableError(serialized)) return new LlamaServerUnreachableError(serverUrl, detail, { cause });
	if (isLlamaServerRequestError(serialized)) return new LlamaServerRequestError(serverUrl, detail, { cause });
	const error = new LlamaServerError(redactUrlCredentials(serialized.message), {
		code: serialized.code as LlamaServerErrorCode,
		serverUrl,
		hint: serialized.hint,
		retryable: serialized.retryable,
		cause,
	});
	Object.defineProperty(error, "name", { value: serialized.name });
	return error;
}
