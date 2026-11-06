const MANAGED_TOOL_ERROR_NAME = "ManagedToolError";
const MANAGED_TOOL_DOWNLOAD_ERROR_NAME = "ManagedToolDownloadError";
const MANAGED_TOOL_TIMEOUT_ERROR_NAME = "ManagedToolTimeoutError";
const MAX_CAUSE_DEPTH = 8;
const RETRYABLE_HTTP_STATUSES: ReadonlySet<number> = new Set([408, 425, 429, 500, 502, 503, 504]);

/** A tool Atomic downloads into `getBinDir()` when it is not on `PATH`. */
export type ManagedToolName = "fd" | "rg";
/** The request that failed: the latest-release redirect lookup, or the release archive download. */
export type ManagedToolRequestPhase = "resolve-version" | "download";
export type ManagedToolDownloadCode = "download-failed";
export type ManagedToolTimeoutCode = "download-timeout";
export type ManagedToolErrorCode = ManagedToolDownloadCode | ManagedToolTimeoutCode;

interface ManagedToolRequestFields {
	readonly tool: ManagedToolName;
	readonly phase: ManagedToolRequestPhase;
	/** The URL of the request that failed. */
	readonly url: string;
}

export interface ManagedToolDownloadFields extends ManagedToolRequestFields {
	/** The response status; absent when no response arrived. */
	readonly httpStatus?: number;
	/** The underlying failure in a few words, kept in `message` for readers that see nothing else. */
	readonly detail?: string;
}

export interface ManagedToolTimeoutFields extends ManagedToolRequestFields {
	readonly timeoutMs: number;
	readonly elapsedMs: number;
}

export type ManagedToolErrorFields = ManagedToolDownloadFields | ManagedToolTimeoutFields;

interface ManagedToolErrorInit {
	readonly code: ManagedToolErrorCode;
	readonly message: string;
	readonly hint: string;
	readonly retryable: boolean;
	readonly fields: ManagedToolErrorFields;
}

const TOOL_NAMES: Readonly<Record<ManagedToolName, string>> = { fd: "fd", rg: "ripgrep" };

function requestSubject(fields: ManagedToolRequestFields): string {
	return fields.phase === "resolve-version"
		? `resolving the latest release at ${fields.url}`
		: `downloading ${fields.url}`;
}

function composeMessage(
	fields: ManagedToolRequestFields,
	outcome: string,
	code: ManagedToolErrorCode,
	hint: string,
): string {
	return `Could not download ${TOOL_NAMES[fields.tool]}: ${requestSubject(fields)} ${outcome} (${code}). ${hint}`;
}

function installYourself(tool: ManagedToolName): string {
	return `install ${TOOL_NAMES[tool]} with your system package manager`;
}

/** Base of every failure to download a managed tool. Nothing is installed when one is thrown. */
export class ManagedToolError extends Error {
	override readonly name: string = MANAGED_TOOL_ERROR_NAME;
	readonly code: ManagedToolErrorCode;
	readonly hint: string;
	readonly retryable: boolean;
	readonly fields: ManagedToolErrorFields;

	protected constructor(init: ManagedToolErrorInit, options?: ErrorOptions) {
		super(init.message, options);
		this.code = init.code;
		this.hint = init.hint;
		this.retryable = init.retryable;
		this.fields = init.fields;
	}
}

/** A release lookup or archive request failed, or answered with something other than what was asked for. */
export class ManagedToolDownloadError extends ManagedToolError {
	override readonly name = MANAGED_TOOL_DOWNLOAD_ERROR_NAME;
	declare readonly code: ManagedToolDownloadCode;
	declare readonly fields: ManagedToolDownloadFields;

	constructor(fields: ManagedToolDownloadFields, options?: ErrorOptions) {
		const hint = `Check that github.com is reachable from this machine and try again, or ${installYourself(fields.tool)}.`;
		const status = fields.httpStatus === undefined ? "" : ` with HTTP ${fields.httpStatus}`;
		const detail = fields.detail === undefined ? "" : `: ${fields.detail}`;
		super(
			{
				code: "download-failed",
				message: composeMessage(fields, `failed${status}${detail}`, "download-failed", hint),
				hint,
				retryable: fields.httpStatus === undefined || RETRYABLE_HTTP_STATUSES.has(fields.httpStatus),
				fields,
			},
			options,
		);
	}
}

/** A release lookup or archive request did not finish within its time limit. Retrying may succeed. */
export class ManagedToolTimeoutError extends ManagedToolError {
	override readonly name = MANAGED_TOOL_TIMEOUT_ERROR_NAME;
	declare readonly code: ManagedToolTimeoutCode;
	declare readonly fields: ManagedToolTimeoutFields;
	declare readonly retryable: true;

	constructor(fields: ManagedToolTimeoutFields, options?: ErrorOptions) {
		const hint = `Check the network connection to github.com and try again, or ${installYourself(fields.tool)}.`;
		super(
			{
				code: "download-timeout",
				message: composeMessage(
					fields,
					`did not finish within ${fields.timeoutMs}ms (stopped after ${fields.elapsedMs}ms)`,
					"download-timeout",
					hint,
				),
				hint,
				retryable: true,
				fields,
			},
			options,
		);
	}
}

function hasNameAndCode(value: unknown, name: string, code: ManagedToolErrorCode): boolean {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { readonly name?: unknown; readonly code?: unknown };
	return candidate.name === name && candidate.code === code;
}

export function isManagedToolDownloadError(value: unknown): value is ManagedToolDownloadError {
	return (
		value instanceof ManagedToolDownloadError ||
		hasNameAndCode(value, MANAGED_TOOL_DOWNLOAD_ERROR_NAME, "download-failed")
	);
}

export function isManagedToolTimeoutError(value: unknown): value is ManagedToolTimeoutError {
	return (
		value instanceof ManagedToolTimeoutError ||
		hasNameAndCode(value, MANAGED_TOOL_TIMEOUT_ERROR_NAME, "download-timeout")
	);
}

export function isManagedToolError(value: unknown): value is ManagedToolError {
	return value instanceof ManagedToolError || isManagedToolDownloadError(value) || isManagedToolTimeoutError(value);
}

/** Whether anything in `error`'s cause chain is a managed tool download failure a caller may retry. */
export function isRetryableManagedToolError(error: unknown): boolean {
	let current = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null; depth++) {
		if (isManagedToolError(current) && current.retryable === true) return true;
		current = (current as { readonly cause?: unknown }).cause;
	}
	return false;
}
