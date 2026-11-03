import type { InteractiveModeBase } from "./interactive-mode-base.ts";
import { showQueueRestoreFailure } from "./interactive-queueing.ts";

/** Establish the queue hold before aborting and surface asynchronous abort failures. */
export function pauseAndAbortInteractiveSession(
	mode: InteractiveModeBase,
	options?: { restoreQueuedMessages?: boolean },
): void {
	// Establish the pause hold before draining it so messages admitted during abort settlement remain held.
	mode.session.pauseQueuedMessages();
	const showError = (error: unknown): void => {
		mode.showError(error instanceof Error ? error.message : String(error));
	};
	// The clear is sent before the abort; the editor fills when the session answers, without holding up the abort.
	if (options?.restoreQueuedMessages) {
		void mode
			.restoreQueuedMessagesToEditor({ preserveUnprotectedCustomMessages: true })
			.catch((error: unknown) => showQueueRestoreFailure(mode, error));
	}
	void mode.session.abort().catch(showError);
}
