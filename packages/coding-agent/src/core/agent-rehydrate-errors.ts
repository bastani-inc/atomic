import {
	isStorageError,
	rehydrateStorageError,
	type SerializedStorageError,
	serializeStorageError,
} from "./storage/errors.js";
import {
	deserializeToolDetachmentError,
	MAX_TOOL_DETACHMENT_AFTER_MS,
	type SerializedToolDetachmentError,
	ToolDetachmentError,
} from "./tool-detachment-errors.ts";

/**
 * Why releasing an idle agent, or waking and rehydrating a released one, was refused or failed. Codes are public
 * API: never rename or reuse one.
 */
export type AgentRehydrateErrorCode =
	| "invalid-release-policy"
	| "session-busy"
	| "not-reopenable"
	| "session-not-found"
	| "no-wake-handler"
	| "wake-handler-conflict"
	| "wake-failed"
	| "release-failed";

/** What kept a session from being released. */
export type AgentSessionActivity =
	| "streaming"
	| "prompt"
	| "compaction"
	| "shell"
	| "queued-messages"
	| "background-tasks";

/** Where an invalid input entered. */
export type AgentReleaseConfigSource = "sdk" | "settings";

/** JSON-safe facts about a refused or failed release or wake. Never carries prompt text or transcripts. */
export interface AgentRehydrateErrorFields {
	readonly sessionId?: string;
	readonly wakeKey?: string;
	readonly namespace?: string;
	/** What was still running when a release was refused. */
	readonly activity?: AgentSessionActivity;
	/** The session store's adapter, for example `node-sqlite`, `jsonl`, `memory` or `libsql`. */
	readonly storage?: string;
	/** True when the store holds only this node's sessions: it is not shared storage. */
	readonly localOnly?: boolean;
	/** How many wakes the failed delivery carried. */
	readonly wakes?: number;
	readonly source?: AgentReleaseConfigSource;
	/** The option that was rejected. */
	readonly field?: string;
	/** The rejected value, as text. */
	readonly value?: string;
}

/** A cause that belongs to a family that rebuilds itself, in that family's own serialized form. */
export type SerializedAgentErrorFamily =
	| { readonly kind: "agent-rehydrate"; readonly error: SerializedAgentRehydrateError }
	| { readonly kind: "tool-detachment"; readonly error: SerializedToolDetachmentError }
	| { readonly kind: "storage"; readonly error: SerializedStorageError };

/**
 * A cause in serialized form: name, message, code and retryable flag only, so nothing secret crosses a process
 * boundary. A cause from the agent, tool-detachment or storage family also carries `family`, which rebuilds it as its
 * own class.
 */
export interface SerializedAgentErrorCause {
	readonly name: string;
	readonly message: string;
	readonly code?: string;
	readonly retryable?: boolean;
	readonly cause?: SerializedAgentErrorCause;
	readonly family?: SerializedAgentErrorFamily;
}

/** An {@link AgentRehydrateError} as it crosses a worker, RPC or broker boundary. */
export interface SerializedAgentRehydrateError {
	readonly name: string;
	readonly code: string;
	readonly message: string;
	readonly hint: string;
	readonly retryable: boolean;
	readonly fields: AgentRehydrateErrorFields;
	readonly cause?: SerializedAgentErrorCause;
}

/** Session stores that hold only this node's sessions. Any other adapter is shared storage. */
const LOCAL_ONLY_STORAGE: ReadonlySet<string> = new Set(["node-sqlite", "jsonl", "memory"]);

/** Whether sessions in a store with this adapter stay on this node. */
export function isLocalOnlySessionStorage(adapter: string): boolean {
	return LOCAL_ONLY_STORAGE.has(adapter);
}

/** The command that joins this node to shared storage, named in hints when a lookup misses on local-only storage. */
export const TEAM_JOIN_COMMAND = "atomic team join <url> --token-file <path>";

/** The command that points this node's storage at a shared database, keeping the rest of its layout. */
export const STORAGE_JOIN_COMMAND = "atomic storage join <url> --token-file <path>";

/**
 * How a node puts its sessions in shared storage, named in hints when a session lookup misses on local-only storage.
 * `atomic team join` keeps sessions on each machine, so a machine joined that way leaves the team first.
 */
export const SESSION_STORAGE_JOIN = `\`${STORAGE_JOIN_COMMAND}\` (after \`atomic team leave\` on a machine joined with \`atomic team join\`, which keeps sessions on each machine)`;

/** How deep cause chains are serialized and walked. */
const MAX_CAUSE_DEPTH = 8;

const AGENT_REHYDRATE_ERROR_NAME = "AgentRehydrateError";
const AGENT_RELEASE_CONFIG_ERROR_NAME = "AgentReleaseConfigError";

const AGENT_REHYDRATE_ERROR_CODES: ReadonlySet<string> = new Set<AgentRehydrateErrorCode>([
	"invalid-release-policy",
	"session-busy",
	"not-reopenable",
	"session-not-found",
	"no-wake-handler",
	"wake-handler-conflict",
	"wake-failed",
	"release-failed",
]);

function hintFor(code: AgentRehydrateErrorCode, fields: AgentRehydrateErrorFields): string {
	switch (code) {
		case "invalid-release-policy":
			return fields.field === "maxConcurrent"
				? "Pass maxConcurrent as a whole number of at least 1, or leave it unset for no limit."
				: `Pass releaseWhenIdle as { afterMs } with afterMs a number of milliseconds from 0 to ${MAX_TOOL_DETACHMENT_AFTER_MS}, or leave it unset.`;
		case "session-busy":
			return fields.activity === "background-tasks"
				? "Wait until the session's background tasks finish, or cancel them, then release it again."
				: "Wait until the session settles (its agent_settled event), then release it again.";
		case "not-reopenable":
			return "Create the session over a store that outlives it: a SQLite or JSONL session store, or a MemorySessionStore the host keeps and passes as `sessionStore`. A session from `SessionManager.inMemory()` has nowhere to be reopened from.";
		case "session-not-found":
			return fields.storage === "memory"
				? "This node keeps this session store in memory, and a session released from a private in-memory session manager is gone with it. Pass the MemorySessionStore the host keeps as `sessionStore`, or use a SQLite or JSONL session store."
				: fields.localOnly === true
					? `This node keeps sessions in local-only storage (${fields.storage}) and is not joined to shared storage, so a session saved on another node is not here. Join shared storage with ${SESSION_STORAGE_JOIN}, or pass the id of a session saved on this node.`
					: `Check the session id: the ${fields.storage} storage this node uses has no session with it.`;
		case "no-wake-handler":
			return `Register a handler for the "${fields.namespace}" wake namespace with AgentWakeDispatcher.handle() before delivering wakes to its keys.`;
		case "wake-handler-conflict":
			return `Dispose the handler already registered for the "${fields.namespace}" wake namespace first; each namespace has one handler.`;
		case "wake-failed":
			return "The agent was not rehydrated and its wakes were not handled; fix the cause, then deliver them again.";
		case "release-failed":
			return "The session's memory is released either way, but its last writes may not be stored. Rehydrate it with AgentSessionRuntime.rehydrate(sessionId) and check its history before you continue.";
	}
}

function subjectFor(code: AgentRehydrateErrorCode, fields: AgentRehydrateErrorFields): string {
	switch (code) {
		case "invalid-release-policy":
			return `Invalid ${fields.field} from ${fields.source}: ${fields.value}`;
		case "session-busy":
			return fields.activity === "background-tasks"
				? `Session ${fields.sessionId} cannot be released while its background tasks are running`
				: `Session ${fields.sessionId} cannot be released while its ${fields.activity} is active`;
		case "not-reopenable":
			return `Session ${fields.sessionId} cannot be released: its ${fields.storage} store cannot be reopened`;
		case "session-not-found":
			return `Session ${fields.sessionId} is not in this node's ${fields.storage} storage`;
		case "no-wake-handler":
			return `No wake handler for ${fields.wakeKey}`;
		case "wake-handler-conflict":
			return `A wake handler for namespace "${fields.namespace}" is already registered`;
		case "wake-failed":
			return `Waking ${fields.wakeKey} failed`;
		case "release-failed":
			return `Session ${fields.sessionId} was released, but closing it failed`;
	}
}

/**
 * Releasing an idle agent or rehydrating a released one was refused or failed. `code` says why; `fields` carries
 * the ids involved; `hint` says what to do next. `retryable` is true only when trying again later can succeed.
 */
export class AgentRehydrateError extends Error {
	override readonly name: string = AGENT_REHYDRATE_ERROR_NAME;
	readonly code: AgentRehydrateErrorCode;
	readonly hint: string;
	readonly retryable: boolean;
	readonly fields: AgentRehydrateErrorFields;

	constructor(code: AgentRehydrateErrorCode, fields: AgentRehydrateErrorFields, options?: ErrorOptions) {
		const hint = hintFor(code, fields);
		super(`${subjectFor(code, fields)} (${code}). ${hint}`, options);
		this.code = code;
		this.hint = hint;
		this.retryable = code === "session-busy";
		this.fields = fields;
	}

	toJSON(): SerializedAgentRehydrateError {
		return serializeAt(this, 0);
	}
}

function serializeAt(error: AgentRehydrateError, depth: number): SerializedAgentRehydrateError {
	const cause = serializeCause(error.cause, depth);
	return {
		name: error.name,
		code: error.code,
		message: error.message,
		hint: error.hint,
		retryable: error.retryable,
		fields: error.fields,
		...(cause === undefined ? {} : { cause }),
	};
}

/** An SDK option for releasing idle sessions was invalid. Thrown before any session, store or timer is created. */
export class AgentReleaseConfigError extends AgentRehydrateError {
	override readonly name: string = AGENT_RELEASE_CONFIG_ERROR_NAME;
	declare readonly code: "invalid-release-policy";
	readonly source: AgentReleaseConfigSource;
	readonly field: string;
	readonly value: string;

	constructor(fields: { readonly source: AgentReleaseConfigSource; readonly field: string; readonly value: string }) {
		super("invalid-release-policy", fields);
		this.source = fields.source;
		this.field = fields.field;
		this.value = fields.value;
	}
}

type ErrorCause = {
	readonly name?: string;
	readonly message?: string;
	readonly code?: string | number;
	readonly retryable?: boolean;
	readonly cause?: ErrorOptions["cause"];
};

function serializeFamily(cause: Error | object, depth: number): SerializedAgentErrorFamily | undefined {
	if (cause instanceof AgentRehydrateError) return { kind: "agent-rehydrate", error: serializeAt(cause, depth) };
	if (cause instanceof ToolDetachmentError) return { kind: "tool-detachment", error: cause.toJSON() };
	if (isStorageError(cause)) return { kind: "storage", error: serializeStorageError(cause) };
	return undefined;
}

function serializeCause(cause: ErrorOptions["cause"], depth: number): SerializedAgentErrorCause | undefined {
	if (cause === undefined || cause === null || depth >= MAX_CAUSE_DEPTH) return undefined;
	if (typeof cause !== "object") return { name: "Error", message: String(cause) };
	const candidate = cause as ErrorCause;
	const family = serializeFamily(cause, depth + 1);
	const nested = family === undefined ? serializeCause(candidate.cause, depth + 1) : undefined;
	return {
		name: typeof candidate.name === "string" ? candidate.name : "Error",
		message: typeof candidate.message === "string" ? candidate.message : "",
		...(typeof candidate.code === "string" ? { code: candidate.code } : {}),
		...(typeof candidate.retryable === "boolean" ? { retryable: candidate.retryable } : {}),
		...(nested === undefined ? {} : { cause: nested }),
		...(family === undefined ? {} : { family }),
	};
}

function rehydrateFamily(family: SerializedAgentErrorFamily): Error {
	switch (family.kind) {
		case "agent-rehydrate":
			return rehydrateAgentRehydrateError(family.error);
		case "tool-detachment":
			return deserializeToolDetachmentError(family.error);
		case "storage":
			return rehydrateStorageError(family.error);
	}
}

function rehydrateCause(cause: SerializedAgentErrorCause | undefined, depth: number): Error | undefined {
	if (cause === undefined || depth >= MAX_CAUSE_DEPTH) return undefined;
	if (cause.family !== undefined) return rehydrateFamily(cause.family);
	const nested = rehydrateCause(cause.cause, depth + 1);
	const error: Error & { code?: string; retryable?: boolean } = new Error(
		cause.message,
		nested === undefined ? undefined : { cause: nested },
	);
	error.name = cause.name;
	if (cause.code !== undefined) error.code = cause.code;
	if (cause.retryable !== undefined) error.retryable = cause.retryable;
	return error;
}

/** Serialize for a worker, RPC or broker boundary: `{ name, code, message, hint, retryable, fields, cause }`. */
export function serializeAgentRehydrateError(error: AgentRehydrateError): SerializedAgentRehydrateError {
	return error.toJSON();
}

/**
 * Rebuild an error serialized on the other side of a process boundary as the same class. An unknown name or code
 * becomes an {@link AgentRehydrateError} that keeps the original `name`, `code`, `message` and `hint`.
 */
export function rehydrateAgentRehydrateError(serialized: SerializedAgentRehydrateError): AgentRehydrateError {
	const cause = rehydrateCause(serialized.cause, 0);
	const options = cause === undefined ? undefined : { cause };
	if (serialized.name === AGENT_RELEASE_CONFIG_ERROR_NAME && serialized.code === "invalid-release-policy") {
		const { source, field, value } = serialized.fields;
		return new AgentReleaseConfigError({ source: source ?? "sdk", field: field ?? "", value: value ?? "" });
	}
	if (serialized.name === AGENT_REHYDRATE_ERROR_NAME && AGENT_REHYDRATE_ERROR_CODES.has(serialized.code))
		return new AgentRehydrateError(serialized.code as AgentRehydrateErrorCode, serialized.fields, options);
	const { name, code, message, hint, retryable } = serialized;
	return Object.assign(new AgentRehydrateError("wake-failed", serialized.fields, options), {
		name,
		code,
		message,
		hint,
		retryable,
	});
}

function hasFamilyName(error: object, name: string): boolean {
	return (error as { readonly name?: string }).name === name;
}

/** True for an {@link AgentRehydrateError} of any code, including one from another realm or a structural copy. */
export function isAgentRehydrateError(error: Error | object | null | undefined): error is AgentRehydrateError {
	if (error instanceof AgentRehydrateError) return true;
	if (typeof error !== "object" || error === null) return false;
	return (
		(hasFamilyName(error, AGENT_REHYDRATE_ERROR_NAME) &&
			AGENT_REHYDRATE_ERROR_CODES.has((error as { readonly code: string }).code)) ||
		isAgentReleaseConfigError(error)
	);
}

/** True for an {@link AgentReleaseConfigError}, including a structural copy. */
export function isAgentReleaseConfigError(error: Error | object | null | undefined): error is AgentReleaseConfigError {
	if (typeof error !== "object" || error === null) return false;
	return (
		hasFamilyName(error, AGENT_RELEASE_CONFIG_ERROR_NAME) &&
		(error as { readonly code: string }).code === "invalid-release-policy"
	);
}

/** True when `error` or anything in its cause chain is a retryable {@link AgentRehydrateError}. */
export function isRetryableAgentRehydrateError(error: Error | object | null | undefined): boolean {
	let current: Error | object | null | undefined = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null; depth++) {
		if (isAgentRehydrateError(current) && current.retryable === true) return true;
		current = (current as { readonly cause?: Error | object }).cause;
	}
	return false;
}
