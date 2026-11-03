/**
 * A message the session could not save stops the run that hit it (#4226). The failure is recorded and reported here,
 * once per run; the request boundary (`persistenceStopError` in agent-session-events.ts) then ends the run. This
 * module imports no agent-session module at runtime, so the event, boundary, prompt and tool-hook modules can all use
 * it without an import cycle.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { describeStorageError } from "./storage/errors.js";

const reportedPersistenceFailures = new WeakSet<object>();

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

/**
 * #4254: saves the custom messages a run buffered while it streamed (`triggerTurn: false`). One that cannot be saved
 * stops the run like any other unsaved message: it is reported once and stays buffered for the next prompt, and the
 * run saves nothing more.
 */
export async function flushPendingCustomMessagesInRun(session: AgentSession): Promise<void> {
	if (session._persistenceFailure !== undefined) return;
	try {
		await session._flushPendingCustomMessages();
	} catch (error) {
		const unsaved = session._pendingCustomMessages[0];
		// A listener that throws after the message was saved is no save failure; it still fails the turn.
		if (unsaved === undefined || session._entryIdsByMessage.has(unsaved)) throw error;
		recordPersistenceFailure(session, unsaved, error);
	}
}
