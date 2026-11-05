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

const LLAMA_SERVER_ERROR_CODES: ReadonlySet<string> = new Set<LlamaServerErrorCode>([
	"server-unreachable",
	"request-rejected",
]);
const LLAMA_SERVER_ERROR_NAMES: ReadonlySet<string> = new Set([
	"LlamaServerError",
	"LlamaServerUnreachableError",
	"LlamaServerRequestError",
]);

const UNREACHABLE_HINT =
	"Check that llama-server is running, and that the URL, port and http or https scheme in /login llama.cpp or LLAMA_BASE_URL are right.";
const REQUEST_REJECTED_HINT =
	"Check the server URL in /login llama.cpp or LLAMA_BASE_URL: use a plain http or https address without a user name or password, and give an API key separately.";

/** The server URL without user information, so it can go into messages and fields. */
function displayServerUrl(serverUrl: string): string {
	try {
		const url = new URL(serverUrl);
		url.username = "";
		url.password = "";
		return url.toString().replace(/\/$/u, "");
	} catch {
		return serverUrl;
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
 * `fetch` failed before the server answered: connection refused, wrong port, DNS, or https against a plain-HTTP
 * server. `detail` is the network-level reason from the cause chain, for example `connect ECONNREFUSED ...`.
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
				retryable: true,
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
 * that contains a user name or password. Retrying the same request fails the same way. `detail` is the runtime's
 * reason with URL credentials removed.
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
			{ code: "request-rejected", serverUrl, hint: REQUEST_REJECTED_HINT, retryable: false, cause: options?.cause },
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
	return (
		error instanceof LlamaServerUnreachableError ||
		hasErrorIdentity(error, new Set(["LlamaServerUnreachableError"]), LLAMA_SERVER_ERROR_CODES)
	);
}

/** Whether `error` is a LlamaServerRequestError, also from another realm or a rehydrated relay. */
export function isLlamaServerRequestError(error: unknown): error is LlamaServerRequestError {
	return (
		error instanceof LlamaServerRequestError ||
		hasErrorIdentity(error, new Set(["LlamaServerRequestError"]), LLAMA_SERVER_ERROR_CODES)
	);
}

/** The first LlamaServerError in `error`'s cause chain, for a wrapper such as a failed login. */
export function findLlamaServerError(error: unknown): LlamaServerError | undefined {
	return findInCauseChain(error, isLlamaServerError);
}

/** Rebuilds a serialized LlamaServerError; an unknown name becomes the family base with its name and code kept. */
export function rehydrateLlamaServerError(serialized: SerializedTypedError): LlamaServerError {
	const cause = rehydrateErrorCause(serialized.cause);
	const serverUrl = typeof serialized.fields.serverUrl === "string" ? serialized.fields.serverUrl : "";
	const detail = typeof serialized.fields.detail === "string" ? serialized.fields.detail : "";
	if (serialized.name === "LlamaServerUnreachableError")
		return new LlamaServerUnreachableError(serverUrl, detail, { cause });
	if (serialized.name === "LlamaServerRequestError") return new LlamaServerRequestError(serverUrl, detail, { cause });
	const error = new LlamaServerError(serialized.message, {
		code: serialized.code as LlamaServerErrorCode,
		serverUrl,
		hint: serialized.hint,
		retryable: serialized.retryable,
		cause,
	});
	Object.defineProperty(error, "name", { value: serialized.name });
	return error;
}
