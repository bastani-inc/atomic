/**
 * A message the session could not save stops the run that hit it (#4226). The failure is recorded and reported here,
 * once per run; the request boundary (`persistenceStopError` in agent-session-events.ts) then ends the run. This
 * module imports no agent-session module at runtime, so the event, message-queue and tool-hook modules can all use it
 * without an import cycle.
 */

import type { AgentMessage } from "@bastani/atomic-agent-core";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { describeStorageError } from "./storage/errors.js";
import { SessionConflictError } from "./storage/session/errors.js";

const reportedPersistenceFailures = new WeakSet<object>();
/** The conflict that stopped a session's run, with the failure it was recorded under. */
const runConflicts = new WeakMap<object, { readonly failure: string; readonly conflict: SessionConflictError }>();

/**
 * #5135: the conflict that stopped the current run, when another process wrote to the session. Such a run saves
 * nothing more: its later messages would land after the other process's entries, inside that process's turn.
 */
export function runStoppedByConflict(session: AgentSession): SessionConflictError | undefined {
	const failure = session._persistenceFailure;
	if (failure === undefined) return undefined;
	const recorded = runConflicts.get(session);
	return recorded?.failure === failure ? recorded.conflict : undefined;
}

/**
 * For queue barriers inside the agent loop: a message that could not be saved was already reported where its
 * append failed and stops the run on its own (#4226); any other listener failure still fails the turn.
 */
export function rethrowUnlessReportedPersistenceFailure(error: unknown): void {
	if (typeof error !== "object" || error === null || !reportedPersistenceFailures.has(error)) throw error;
}

/**
 * #4226: records that `message` could not be saved. The run stops on its first unsaved message; later failures of
 * the same run are part of that stop and are not reported again.
 */
export function recordPersistenceFailure(session: AgentSession, message: AgentMessage, error: unknown): void {
	// An unsaved message has no entry for turn_end to resolve; name the cause here instead.
	session._messagesWithFailedPersistence.add(message);
	if (typeof error === "object" && error !== null) reportedPersistenceFailures.add(error);
	const failure = `could not persist the ${message.role} message: ${error instanceof Error ? describeStorageError(error) : String(error)}`;
	const firstFailure = session._persistenceFailure === undefined;
	session._persistenceFailure ??= failure;
	if (firstFailure) runConflicts.delete(session);
	if (error instanceof SessionConflictError && runStoppedByConflict(session) === undefined) {
		runConflicts.set(session, { failure: session._persistenceFailure, conflict: error });
	}
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
	/** The run's messages the session holds in memory but could not save, oldest first. */
	readonly unsavedMessages: readonly AgentMessage[];
	/** Set when the run stopped because another process wrote to the session (#5135). */
	readonly conflict?: SessionConflictError;
}

/**
 * #5210: what the current run could not save, or undefined when it saved every message. The unsaved messages stay in
 * the session's memory only, so a caller that reports the run can still name and keep them.
 */
function getPersistenceFailure(this: AgentSession): PersistenceFailure | undefined {
	const error = this._persistenceFailure;
	if (error === undefined) return undefined;
	const unsavedMessages = this.agent.state.messages.filter((message) =>
		this._messagesWithFailedPersistence.has(message),
	);
	const conflict = runStoppedByConflict(this);
	return conflict === undefined ? { error, unsavedMessages } : { error, unsavedMessages, conflict };
}

export const agentSessionPersistenceFailureMethods = { getPersistenceFailure };
