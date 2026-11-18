/**
 * A message the session could not save stops the run that hit it (#4226). The failure is recorded and reported here,
 * once per run; the request boundary (`persistenceStopError` in agent-session-events.ts) then ends the run. This
 * module imports no agent-session module at runtime, so the event, message-queue and tool-hook modules can all use it
 * without an import cycle.
 */

import type { AgentMessage } from "@bastani/atomic-agent-core";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import type { CustomMessage } from "./messages.ts";
import { describeStorageError } from "./storage/errors.js";
import { SessionConflictError } from "./storage/session/errors.js";

const reportedPersistenceFailures = new WeakSet<object>();

/** What runs could not save, kept apart from the transcript so a context refresh does not drop it (#5135). */
interface UnsavedInput {
	readonly error: string;
	conflict?: SessionConflictError;
	readonly messages: AgentMessage[];
}
const unsavedInputs = new WeakMap<object, UnsavedInput>();

function keepUnsaved(session: AgentSession, message: AgentMessage, failure: string, error: unknown): void {
	let kept = unsavedInputs.get(session);
	if (kept === undefined) {
		kept = { error: failure, messages: [] };
		unsavedInputs.set(session, kept);
	}
	if (error instanceof SessionConflictError) kept.conflict ??= error;
	if (!kept.messages.includes(message)) kept.messages.push(message);
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
 * writer's entries stopped it (#5135).
 */
export function clearPersistenceFailure(session: AgentSession): void {
	session._persistenceFailure = undefined;
	session.sessionManager.resumeAppends();
}

/** The user's next prompt resends or replaces what earlier runs could not save (#5135). */
export function forgetUnsavedInput(session: AgentSession): void {
	unsavedInputs.delete(session);
}

/**
 * #5135: a custom message that the halt after another writer's entries refused stays shown and recoverable, not only
 * with its sender.
 */
export function keepRefusedInput(session: AgentSession, message: CustomMessage, error: SessionConflictError): void {
	session._messagesWithFailedPersistence.add(message);
	keepUnsaved(session, message, failureOf(message, error), error);
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

/** What runs could not save, and why, until the user's next prompt (#4226, #5135). */
export interface PersistenceFailure {
	/** The reported cause, naming the storage error. */
	readonly error: string;
	/** The messages the session holds in memory but could not save, oldest first. */
	readonly unsavedMessages: readonly AgentMessage[];
	/** Set when the run stopped because another process wrote to the session (#5135). */
	readonly conflict?: SessionConflictError;
}

/**
 * #5210: what runs since the user's last prompt could not save, or undefined when they saved every message. The
 * unsaved messages stay in the session's memory only, so a caller that reports the run can still name and keep them;
 * a context refresh does not drop them (#5135).
 */
function getPersistenceFailure(this: AgentSession): PersistenceFailure | undefined {
	const kept = unsavedInputs.get(this);
	if (kept === undefined) return undefined;
	const unsavedMessages = kept.messages.filter((message) => !this._entryIdsByMessage.has(message));
	if (unsavedMessages.length === 0) return undefined;
	const { error, conflict } = kept;
	return conflict === undefined ? { error, unsavedMessages } : { error, unsavedMessages, conflict };
}

export const agentSessionPersistenceFailureMethods = { getPersistenceFailure };
