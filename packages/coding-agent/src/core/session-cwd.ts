import { existsSync } from "node:fs";

export interface SessionCwdIssue {
	sessionFile?: string;
	sessionCwd: string;
	fallbackCwd: string;
}

interface SessionCwdSource {
	getCwd(): string;
	getSessionFile(): string | undefined;
}

export function getMissingSessionCwdIssue(
	sessionManager: SessionCwdSource,
	fallbackCwd: string,
): SessionCwdIssue | undefined {
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile) {
		return undefined;
	}

	const sessionCwd = sessionManager.getCwd();
	if (!sessionCwd || existsSync(sessionCwd)) {
		return undefined;
	}

	return {
		sessionFile,
		sessionCwd,
		fallbackCwd,
	};
}

export function formatMissingSessionCwdError(issue: SessionCwdIssue): string {
	const sessionFile = issue.sessionFile ? `\nSession file: ${issue.sessionFile}` : "";
	return `Stored session working directory does not exist: ${issue.sessionCwd}${sessionFile}\nCurrent working directory: ${issue.fallbackCwd}`;
}

export function formatMissingSessionCwdPrompt(issue: SessionCwdIssue): string {
	return `Session cwd does not exist: ${issue.sessionCwd}`;
}

/** How to open a session whose stored cwd is missing: run it in the current cwd once, or fork it there. */
export type MissingSessionCwdChoice = "continue" | "fork";

/** Prompt options for a missing session cwd, naming the current cwd; `undefined` cancels. */
export function getMissingSessionCwdOptions(
	issue: SessionCwdIssue,
): Array<{ label: string; value: MissingSessionCwdChoice | undefined }> {
	return [
		{ label: `Continue in ${issue.fallbackCwd} (asks again next time)`, value: "continue" },
		{ label: `Fork into ${issue.fallbackCwd} (new session ID, original kept)`, value: "fork" },
		{ label: "Cancel", value: undefined },
	];
}

/** Every code of {@link MissingSessionCwdError}. */
export type MissingSessionCwdErrorCode = "session-cwd-missing";

/** The facts a {@link MissingSessionCwdError} carries, as JSON-safe text. */
export interface MissingSessionCwdFields {
	readonly sessionCwd: string;
	readonly fallbackCwd: string;
	readonly sessionFile?: string;
}

const MISSING_SESSION_CWD_HINT =
	"Open the session from its original working directory, or continue or fork it when asked.";

/**
 * A session's recorded working directory does not exist on this machine. Nothing was opened or written. Interactive
 * mode answers it with a prompt to continue in the current directory or fork there; other modes report it.
 */
export class MissingSessionCwdError extends Error {
	override readonly name = "MissingSessionCwdError" as const;
	readonly code: MissingSessionCwdErrorCode = "session-cwd-missing";
	readonly retryable = false as const;
	readonly hint: string = MISSING_SESSION_CWD_HINT;
	readonly issue: SessionCwdIssue;

	constructor(issue: SessionCwdIssue, options?: ErrorOptions) {
		super(formatMissingSessionCwdError(issue), options);
		this.issue = issue;
	}

	/** The facts this error carries, as JSON-safe text. */
	fields(): MissingSessionCwdFields {
		const { sessionCwd, fallbackCwd, sessionFile } = this.issue;
		return sessionFile === undefined ? { sessionCwd, fallbackCwd } : { sessionCwd, fallbackCwd, sessionFile };
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSessionCwdIssue(value: unknown): value is SessionCwdIssue {
	return (
		isRecord(value) &&
		typeof value.sessionCwd === "string" &&
		typeof value.fallbackCwd === "string" &&
		(value.sessionFile === undefined || typeof value.sessionFile === "string")
	);
}

/** Whether `error` is a {@link MissingSessionCwdError}, here or rebuilt from another process or realm. */
export function isMissingSessionCwdError(error: unknown): error is MissingSessionCwdError {
	return (
		error instanceof MissingSessionCwdError ||
		(isRecord(error) &&
			error.name === "MissingSessionCwdError" &&
			error.code === "session-cwd-missing" &&
			isSessionCwdIssue(error.issue))
	);
}

/** A {@link MissingSessionCwdError} as it crosses a process boundary. */
export interface SerializedMissingSessionCwdError {
	readonly name: "MissingSessionCwdError";
	readonly code: MissingSessionCwdErrorCode;
	readonly message: string;
	readonly hint: string;
	readonly retryable: false;
	readonly fields: MissingSessionCwdFields;
	/** The cause's name and message only; a cause outside this family does not cross as an object. */
	readonly cause?: { readonly name: string; readonly message: string };
}

/** `error` as JSON-safe data. {@link rehydrateMissingSessionCwdError} reverses it. */
export function serializeMissingSessionCwdError(error: MissingSessionCwdError): SerializedMissingSessionCwdError {
	const serialized = {
		name: error.name,
		code: error.code,
		message: error.message,
		hint: error.hint,
		retryable: error.retryable,
		fields: error.fields(),
	};
	const { cause } = error;
	if (cause === undefined) return serialized;
	const other = cause instanceof Error ? cause : new Error(String(cause));
	return { ...serialized, cause: { name: other.name, message: other.message } };
}

/** Whether `value` is a well-formed {@link SerializedMissingSessionCwdError}; anything else must not be rehydrated. */
export function isSerializedMissingSessionCwdError(value: unknown): value is SerializedMissingSessionCwdError {
	if (!isRecord(value)) return false;
	const { cause } = value;
	return (
		value.name === "MissingSessionCwdError" &&
		value.code === "session-cwd-missing" &&
		typeof value.message === "string" &&
		typeof value.hint === "string" &&
		value.retryable === false &&
		isSessionCwdIssue(value.fields) &&
		(cause === undefined || (isRecord(cause) && typeof cause.name === "string" && typeof cause.message === "string"))
	);
}

/**
 * Rebuilds the {@link MissingSessionCwdError} a serialized one describes, with the same fields. Its cause is `cause`, or
 * the serialized cause rebuilt as a plain error that keeps its name and message.
 */
export function rehydrateMissingSessionCwdError(
	serialized: SerializedMissingSessionCwdError,
	cause?: Error,
): MissingSessionCwdError {
	const { sessionCwd, fallbackCwd, sessionFile } = serialized.fields;
	const issue: SessionCwdIssue =
		sessionFile === undefined ? { sessionCwd, fallbackCwd } : { sessionCwd, fallbackCwd, sessionFile };
	if (cause !== undefined) return new MissingSessionCwdError(issue, { cause });
	if (serialized.cause === undefined) return new MissingSessionCwdError(issue);
	const rebuilt = new Error(serialized.cause.message);
	rebuilt.name = serialized.cause.name;
	return new MissingSessionCwdError(issue, { cause: rebuilt });
}

export function assertSessionCwdExists(sessionManager: SessionCwdSource, fallbackCwd: string): void {
	const issue = getMissingSessionCwdIssue(sessionManager, fallbackCwd);
	if (issue) {
		throw new MissingSessionCwdError(issue);
	}
}

interface StoredSessionCwdSource extends SessionCwdSource {
	isPersisted(): boolean;
	getEntries(): readonly object[];
}

/**
 * The missing-cwd issue for a resumed session kept in database storage, which has no session file: its recorded cwd
 * may be another machine's path. New sessions and in-memory sessions have none.
 */
export function getMissingStoredSessionCwdIssue(
	sessionManager: StoredSessionCwdSource,
	fallbackCwd: string,
): SessionCwdIssue | undefined {
	if (sessionManager.getSessionFile() || !sessionManager.isPersisted() || sessionManager.getEntries().length === 0) {
		return undefined;
	}
	const sessionCwd = sessionManager.getCwd();
	if (!sessionCwd || existsSync(sessionCwd)) return undefined;
	return { sessionCwd, fallbackCwd };
}

/**
 * The missing-cwd issue for a session just opened, whether it lives in a session file or in database storage, which
 * has none.
 */
export function findMissingSessionCwdIssue(
	sessionManager: StoredSessionCwdSource,
	fallbackCwd: string,
): SessionCwdIssue | undefined {
	return (
		getMissingSessionCwdIssue(sessionManager, fallbackCwd) ??
		getMissingStoredSessionCwdIssue(sessionManager, fallbackCwd)
	);
}
