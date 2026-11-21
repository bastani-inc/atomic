import type { CustomEditor, NavBackInput } from "../components/custom-editor.ts";
import type { InteractiveModeBase } from "../interactive-mode-base.ts";

/**
 * The keys the prompt answers itself while a subagent is shown, with what the screen holds when each arrives. Esc acts
 * on the subagent's turn and never leaves its view. The back key (`app.nav.back`, ← by default) on an empty prompt is
 * the way back to main, and leaves the subagent's run and queue as they are; with text typed, it is the editor's.
 * Ctrl+C on an empty prompt pauses the subagent's work and shows main in one press.
 */
export type ViewedAgentKey =
	/** Esc. `pausable`: the subagent works, waits to retry, or has messages queued. */
	| { readonly key: "escape"; readonly pausable: boolean }
	/** A SIGINT signal from outside the keyboard. */
	| { readonly key: "signal"; readonly pausable: boolean }
	/** Ctrl+C on an empty prompt. */
	| { readonly key: "leave"; readonly pausable: boolean }
	/**
	 * The back key. `promptEmpty`: the prompt holds nothing (whitespace, a newline or a paste is text) and shows no
	 * completion menu. `clicked`: a click on its hint pressed it. `replayed`: it was pressed while the subagent was
	 * being opened, and types into its prompt as every key pressed then does.
	 */
	| { readonly key: "back"; readonly promptEmpty: boolean; readonly clicked: boolean; readonly replayed: boolean };

/** What the key does: `editor` leaves it to the prompt, which moves its cursor. */
export type ViewedAgentKeyAction = "pause" | "showMain" | "pauseAndShowMain" | "none" | "editor";

export function viewedAgentKeyAction(input: ViewedAgentKey): ViewedAgentKeyAction {
	switch (input.key) {
		case "escape":
		case "signal":
			return input.pausable ? "pause" : "none";
		case "leave":
			return input.pausable ? "pauseAndShowMain" : "showMain";
		case "back":
			return !input.replayed && (input.promptEmpty || input.clicked) ? "showMain" : "editor";
	}
}

/** Where the back key leads, as its hint names it. */
export const VIEWED_AGENT_BACK_LABEL = "main chat";

type BackHandler = (input: NavBackInput) => boolean;

/** Back handlers that hand the key to the prompt's own, given to extension editors built on the prompt. */
const forwarders = new WeakSet<BackHandler>();

/**
 * The back handler for an extension's editor built on the prompt's editor: the prompt's own, whichever it is when the
 * key arrives, so ← on that editor's empty prompt leads back to main as it does on the prompt's.
 */
export function navBackForwarder(mode: InteractiveModeBase): BackHandler {
	const forward: BackHandler = (input) => mode.defaultEditor.onNavBack?.(input) ?? false;
	forwarders.add(forward);
	return forward;
}

type BackRoutingEditor = Pick<CustomEditor, "navBackKeys" | "navBackEmpty">;

/**
 * The editor in the prompt's place that routes the back key to main while a subagent is shown: the prompt's own, or an
 * extension's editor built on it that left the key to the prompt. Undefined while main is shown or for any other editor.
 */
function backRoutingEditor(mode: InteractiveModeBase): BackRoutingEditor | undefined {
	if (mode.agentView?.viewed.kind !== "agent") return undefined;
	if (mode.editor === mode.defaultEditor) return mode.defaultEditor;
	const editor = mode.editor as Partial<Pick<CustomEditor, "navBackKeys" | "navBackEmpty" | "onNavBack">>;
	const { navBackKeys, navBackEmpty, onNavBack } = editor;
	if (onNavBack === undefined || !forwarders.has(onNavBack)) return undefined;
	if (typeof navBackKeys !== "function" || typeof navBackEmpty !== "function") return undefined;
	return editor as BackRoutingEditor;
}

/** The keys that lead back to main from the shown subagent's empty prompt, for its key list; empty while main is shown. */
export function viewedAgentBackKeyList(mode: InteractiveModeBase): readonly string[] {
	return backRoutingEditor(mode)?.navBackKeys() ?? [];
}

/**
 * The keys that take the screen back to main if pressed now, for the hint by the prompt: while a subagent is shown, its
 * prompt has the keys and is empty, and no other subagent is being opened. They are the keys the prompt itself routes
 * to the back action. Undefined when a press would not go back.
 */
export function viewedAgentBackKeys(mode: InteractiveModeBase): readonly string[] | undefined {
	const editor = backRoutingEditor(mode);
	if (editor === undefined || mode.agentView?.pendingTaskId !== undefined || !editor.navBackEmpty()) return undefined;
	if (mode.ui.hasOverlay() || !mode.editorContainer.children.includes(mode.editor)) return undefined;
	const focused = (mode.ui as { getFocusedComponent?(): object | null }).getFocusedComponent?.();
	if (focused !== undefined && focused !== mode.editor) return undefined;
	const keys = editor.navBackKeys();
	return keys.length > 0 ? keys : undefined;
}
