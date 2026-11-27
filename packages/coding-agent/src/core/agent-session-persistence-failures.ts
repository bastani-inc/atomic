/**
 * A message the session could not save stops the run that hit it (#4226). The failure is recorded and reported here,
 * once per run; the request boundary (`persistenceStopError` in agent-session-events.ts) then ends the run. This
 * module imports no agent-session module at runtime, so the event, message-queue and tool-hook modules can all use it
 * without an import cycle.
 */

import { createHash } from "node:crypto";
import type { AgentMessage } from "@bastani/atomic-agent-core";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import type { CustomMessage, StageAdmittedCustomMessage } from "./messages.ts";
import { describeStorageError } from "./storage/errors.js";
import { SessionConflictError } from "./storage/session/errors.js";

const reportedPersistenceFailures = new WeakSet<object>();

/** How many unsaved inputs a session keeps for resending; past it the oldest are dropped and counted (#5135). */
export const MAX_RETAINED_UNSAVED_INPUTS = 64;

/**
 * #5135: prompts and custom messages that could not be saved, kept apart from the transcript under a stable identity
 * until one carrying the same input is saved or the user discards them. A refresh of the context does not drop them.
 */
interface RetainedInput {
	error: string;
	readonly messages: Map<string, AgentMessage>;
	dropped: number;
}
const retainedInputs = new WeakMap<object, RetainedInput>();

/** What the current run could not save beyond its input: its model replies, tool results and prompt records. */
interface RunFailure {
	conflict?: SessionConflictError;
	readonly outputs: AgentMessage[];
}
const runFailures = new WeakMap<object, RunFailure>();

/** The identity two sends of one input share, or undefined for what a run produces rather than receives. */
function inputIdentity(message: AgentMessage): string | undefined {
	if (message.role !== "user" && message.role !== "custom") return undefined;
	if (message.role === "custom") {
		const key = (message as StageAdmittedCustomMessage).stageAdmissionKey;
		if (key !== undefined) return `custom-key:${key}`;
	}
	const kind = message.role === "custom" ? `custom:${message.customType}` : "user";
	return `${kind}:${createHash("sha256").update(JSON.stringify(message.content)).digest("hex")}`;
}

/** Keeps `message` as unsaved. Resolves true when it is new input, so a caller shows it once. */
function keepUnsaved(session: AgentSession, message: AgentMessage, failure: string, error: unknown): boolean {
	const identity = inputIdentity(message);
	if (identity === undefined) {
		const run = runFailures.get(session) ?? { outputs: [] };
		runFailures.set(session, run);
		if (error instanceof SessionConflictError) run.conflict ??= error;
		if (!run.outputs.includes(message)) run.outputs.push(message);
		return false;
	}
	const run = runFailures.get(session) ?? { outputs: [] };
	runFailures.set(session, run);
	if (error instanceof SessionConflictError) run.conflict ??= error;
	let retained = retainedInputs.get(session);
	if (retained === undefined) {
		retained = { error: failure, messages: new Map(), dropped: 0 };
		retainedInputs.set(session, retained);
	}
	if (retained.messages.has(identity)) return false;
	retained.messages.set(identity, message);
	while (retained.messages.size > MAX_RETAINED_UNSAVED_INPUTS) {
		const oldest = retained.messages.keys().next().value;
		if (oldest === undefined) break;
		retained.messages.delete(oldest);
		retained.dropped += 1;
	}
	return true;
}

function failureOf(message: AgentMessage, error: unknown): string {
	return `could not persist the ${message.role} message: ${error instanceof Error ? describeStorageError(error) : String(error)}`;
}

/**
 * For queue barriers inside the agent loop: a message that could not be saved was already reported where its
 * append failed and stops the run on its own (#4226); any other listener failure still fails the turn.
 */
export function rethrowUnlessReportedPersistenceFailure(error: unknown): void {
	if (typeof error !== "object" || error === null || !reportedPersistenceFailures.has(error)) throw error;
}

/**
 * #4226: a new run saves again after an earlier run stopped on a message it could not save, also when another
 * writer's entries stopped it (#5135). Input that run could not save stays retained for resending.
 */
export function clearPersistenceFailure(session: AgentSession): void {
	session._persistenceFailure = undefined;
	runFailures.delete(session);
	session.sessionManager.resumeAppends();
}

/** #5135: a saved message settles the retained input that carries the same identity, every copy of it. */
export function noteMessageSaved(session: AgentSession, message: AgentMessage): void {
	const identity = inputIdentity(message);
	const retained = identity === undefined ? undefined : retainedInputs.get(session);
	if (identity === undefined || retained === undefined) return;
	retained.messages.delete(identity);
	if (retained.messages.size === 0 && retained.dropped === 0) retainedInputs.delete(session);
}

/** Messages a run sends again that repeat unsaved input already shown; their display events are not shown again. */
const repeatedInputs = new WeakSet<object>();

/**
 * #5135: whether `message` repeats input the session could not save and already showed: the earlier display stands
 * for it, so its own message events are not shown again. Earlier unsaved copies leave the live transcript.
 */
export function repeatsShownUnsavedInput(session: AgentSession, message: AgentMessage): boolean {
	if (repeatedInputs.has(message)) return true;
	const identity = inputIdentity(message);
	const earlier = identity === undefined ? undefined : retainedInputs.get(session)?.messages.get(identity);
	if (identity === undefined || earlier === undefined || earlier === message) return false;
	repeatedInputs.add(message);
	const messages = session.agent.state.messages;
	const kept = messages.filter(
		(candidate) =>
			candidate === message ||
			!session._messagesWithFailedPersistence.has(candidate) ||
			inputIdentity(candidate) !== identity,
	);
	if (kept.length !== messages.length) session.agent.state.messages = kept;
	return true;
}

/** #5135: the user discards the input the session could not save. */
function discardUnsavedInput(this: AgentSession): void {
	retainedInputs.delete(this);
}

/**
 * #5135: a custom message that the halt after another writer's entries refused stays shown and recoverable, not only
 * with its sender. One input is shown once, however often it is sent again.
 */
export function keepRefusedInput(session: AgentSession, message: CustomMessage, error: SessionConflictError): void {
	session._messagesWithFailedPersistence.add(message);
	if (!keepUnsaved(session, message, failureOf(message, error), error)) return;
	session._emit({ type: "message_start", message });
	session._emit({ type: "message_end", message });
}

/**
 * #4226: records that `message` could not be saved. The run stops on its first unsaved message; later failures of
 * the same run are part of that stop and are not reported again.
 */
export function recordPersistenceFailure(session: AgentSession, message: AgentMessage, error: unknown): void {
	// An unsaved message has no entry for turn_end to resolve; name the cause here instead.
	session._messagesWithFailedPersistence.add(message);
	if (typeof error === "object" && error !== null) reportedPersistenceFailures.add(error);
	const failure = failureOf(message, error);
	keepUnsaved(session, message, failure, error);
	const firstFailure = session._persistenceFailure === undefined;
	session._persistenceFailure ??= failure;
	// #3105: disposal reports failures that interrupt it through its own rejection.
	if (firstFailure && !session._disposed) {
		session._extensionRunner.emitError({
			extensionPath: "<session>",
			event: "message_end",
			error: failure,
			stack: error instanceof Error ? error.stack : undefined,
		});
	}
}

/** What the current run could not save, and why, while its stop stands (#4226). */
export interface PersistenceFailure {
	/** The reported cause, naming the storage error. */
	readonly error: string;
	/** The messages the session holds in memory but could not save, oldest input first. */
	readonly unsavedMessages: readonly AgentMessage[];
	/** Set when the run stopped because another process wrote to the session (#5135). */
	readonly conflict?: SessionConflictError;
	/** How many older unsaved inputs were dropped past {@link MAX_RETAINED_UNSAVED_INPUTS} (#5135). */
	readonly droppedUnsavedMessages?: number;
}

/** Input the session could not save, kept until it is saved or discarded (#5135). */
export interface UnsavedInput {
	readonly error: string;
	/** The unsaved prompts and custom messages, one per input, oldest first. */
	readonly messages: readonly AgentMessage[];
	/** How many older ones were dropped past {@link MAX_RETAINED_UNSAVED_INPUTS}. */
	readonly dropped: number;
}

/** #5135: the input the session could not save, until it is saved or discarded; undefined when there is none. */
function getUnsavedInput(this: AgentSession): UnsavedInput | undefined {
	const retained = retainedInputs.get(this);
	if (retained === undefined) return undefined;
	return { error: retained.error, messages: [...retained.messages.values()], dropped: retained.dropped };
}

/**
 * #5210: what the current run could not save, or undefined when it saved every message. The unsaved messages stay in
 * the session's memory only, so a caller that reports the run can still name and keep them. They include input that
 * an earlier run could not save and nothing has saved since, and a context refresh does not drop them (#5135).
 */
function getPersistenceFailure(this: AgentSession): PersistenceFailure | undefined {
	const run = runFailures.get(this);
	// After an uncertain write, the last message can be confirmed saved even though a peer's newer entry stopped us.
	const conflict = run?.conflict ?? this.sessionManager.getAppendHalt();
	const error = this._persistenceFailure ?? conflict?.message;
	if (error === undefined) return undefined;
	const retained = retainedInputs.get(this);
	const unsavedMessages = [...(retained?.messages.values() ?? []), ...(run?.outputs ?? [])];
	return {
		error,
		unsavedMessages,
		...(conflict === undefined ? {} : { conflict }),
		...(retained === undefined || retained.dropped === 0 ? {} : { droppedUnsavedMessages: retained.dropped }),
	};
}

export const agentSessionPersistenceFailureMethods = { getPersistenceFailure, getUnsavedInput, discardUnsavedInput };
