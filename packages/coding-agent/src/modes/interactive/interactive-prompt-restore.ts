import type { InteractiveModeBase } from "./interactive-mode-base.ts";

/**
 * Markers for a submission the engine never accepted.
 *
 * These are the errors `RpcClient` raises when the transport is gone or being
 * replaced: an explicit stop, an unexpected child exit, a detached stdin, a
 * client that is not started (the window inside a restart), and a transport
 * violation. A failure with any of these causes means the prompt was never
 * handed to an agent turn, so the typed text is still user-owned.
 */
const ENGINE_SEND_FAILURE_MARKERS = [
	"Agent process stopped",
	"Agent process exited",
	"Agent process stdin is not writable",
	"Client not started",
	"Interactive engine emitted malformed JSONL",
] as const;

export function isEngineSendFailure(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return ENGINE_SEND_FAILURE_MARKERS.some((marker) => message.includes(marker));
}

/** Separator between a restored submission and text typed while it was pending. */
export const RESTORED_DRAFT_SEPARATOR = "\n\n";

/**
 * Merge a rejected submission back into the live editor buffer in temporal
 * order: the failed submission first, then whatever the user typed while the
 * send was still pending.
 *
 * Presence is measured on the raw string, never on `trim()`, so whitespace-only
 * typing is preserved too. Neither side is trimmed or normalized here.
 */
export function mergeRestoredDraft(draft: string, currentText: string): string {
	return currentText.length === 0 ? draft : `${draft}${RESTORED_DRAFT_SEPARATOR}${currentText}`;
}

export interface PromptDraftRestoreTarget {
	/** True once the submission reached an agent turn (`agent_start` observed). */
	turnStarted: boolean;
	/** Text to put back, exactly as the editor handed it to the submit callback. */
	draft: string;
	getEditorText(): string;
	setEditorText(text: string): void;
	editorOwnsInput(): boolean;
	focusEditor(): void;
	requestRender(): void;
}

/**
 * Put a rejected submission back in the editor instead of discarding it.
 *
 * Only for a send that never landed: once the agent turn has started, the text
 * belongs to the transcript and a mid-turn failure must not resurrect it.
 * Returns true when the draft was restored.
 */
export function restoreUnsentPromptDraft(error: unknown, target: PromptDraftRestoreTarget): boolean {
	if (target.turnStarted) return false;
	if (!isEngineSendFailure(error)) return false;
	target.setEditorText(mergeRestoredDraft(target.draft, target.getEditorText()));
	// Never steal focus from a modal that took over while the send was pending.
	if (target.editorOwnsInput()) target.focusEditor();
	target.requestRender();
	return true;
}

/**
 * Host-bound restore used by every submit path (the prompt loop and the direct
 * dispatch branches that bypass it).
 *
 * Returns true when the failure was a send the engine never accepted and the
 * draft is back in the editor; false means the caller owns the error.
 */
export function restoreFailedSubmissionDraft(
	mode: InteractiveModeBase,
	error: unknown,
	draft: string,
	options?: { turnStarted?: boolean },
): boolean {
	const restored = restoreUnsentPromptDraft(error, {
		turnStarted: options?.turnStarted === true,
		draft,
		// Expand first: a large paste lives in the editor's private paste registry
		// and shows only a `[paste #1 … chars]` marker in the visible buffer, and
		// setText() clears that registry. Reading the marker would round-trip dead
		// text and destroy the payload.
		getEditorText: () => mode.editor.getExpandedText?.() ?? mode.editor.getText(),
		setEditorText: (text) => mode.editor.setText(text),
		editorOwnsInput: () => mode.editorContainer.children.includes(mode.editor),
		focusEditor: () => mode.ui.setFocus(mode.editor),
		requestRender: () => mode.ui.requestRender(),
	});
	// A draft the host itself put back is a draft, never cooked startup input.
	// Without this, the next getUserInput() would run the startup-input recovery
	// over the restored text and replay a command-like draft as a submission —
	// re-running the very command whose send just failed.
	if (restored) mode.startupCookedInputRecovered = true;
	return restored;
}
