import type { InteractiveModeBase } from "./interactive-mode-base.ts";

/** Establish the queue hold before aborting and surface asynchronous abort failures. */
export function pauseAndAbortInteractiveSession(
	mode: InteractiveModeBase,
	options?: { restoreQueuedMessages?: boolean },
): void {
	// Establish the pause hold before draining it so messages admitted during abort settlement remain held.
	mode.session.pauseQueuedMessages();
	if (options?.restoreQueuedMessages) {
		mode.restoreQueuedMessagesToEditor({ preserveUnprotectedCustomMessages: true });
	}
	void mode.session.abort().catch((error) => {
		mode.showError(error instanceof Error ? error.message : String(error));
	});
}
