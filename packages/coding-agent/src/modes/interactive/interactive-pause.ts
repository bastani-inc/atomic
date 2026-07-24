import type { InteractiveModeBase } from "./interactive-mode-base.ts";

/** Establish the queue hold before aborting and surface asynchronous abort failures. */
export function pauseAndAbortInteractiveSession(mode: InteractiveModeBase): void {
  mode.session.pauseQueuedMessages();
  void mode.session.abort().catch((error) => {
    mode.showError(error instanceof Error ? error.message : String(error));
  });
}
