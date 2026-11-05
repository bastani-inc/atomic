import {
	type ErrorFieldValue,
	findInCauseChain,
	hasErrorIdentity,
	rehydrateErrorCause,
	type SerializedTypedError,
	serializeErrorCause,
} from "../../core/error-contract.ts";

/** Stable codes of LlamaServerError. Codes are public API: never rename or reuse one. */
export type LlamaServerErrorCode = "server-unreachable";

const LLAMA_SERVER_ERROR_CODES: ReadonlySet<string> = new Set<LlamaServerErrorCode>(["server-unreachable"]);
const LLAMA_SERVER_ERROR_NAMES: ReadonlySet<string> = new Set(["LlamaServerError", "LlamaServerUnreachableError"]);

const UNREACHABLE_HINT =
	"Check that llama-server is running, and that the URL, port and http or https scheme in /login llama.cpp or LLAMA_BASE_URL are right.";

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
		super(`Could not reach llama.cpp server at ${displayed}: ${detail} (server-unreachable). ${UNREACHABLE_HINT}`, {
			code: "server-unreachable",
			serverUrl,
			hint: UNREACHABLE_HINT,
			retryable: true,
			cause: options?.cause,
		});
		this.detail = detail;
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

/** The first LlamaServerError in `error`'s cause chain, for a wrapper such as a failed login. */
export function findLlamaServerError(error: unknown): LlamaServerError | undefined {
	return findInCauseChain(error, isLlamaServerError);
}

/** Rebuilds a serialized LlamaServerError; an unknown name becomes the family base with its name and code kept. */
export function rehydrateLlamaServerError(serialized: SerializedTypedError): LlamaServerError {
	const cause = rehydrateErrorCause(serialized.cause);
	const serverUrl = typeof serialized.fields.serverUrl === "string" ? serialized.fields.serverUrl : "";
	if (serialized.name === "LlamaServerUnreachableError") {
		const detail = typeof serialized.fields.detail === "string" ? serialized.fields.detail : "";
		return new LlamaServerUnreachableError(serverUrl, detail, { cause });
	}
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
