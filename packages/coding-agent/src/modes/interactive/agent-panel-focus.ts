import type { AgentsFocusInput, CustomEditor } from "./components/custom-editor.js";

type FocusAgentPanel = (input: AgentsFocusInput) => boolean;

/** What the agent panel's key does from the prompt of each interactive mode. */
const focusers = new WeakMap<object, FocusAgentPanel>();

/** Set what the agent panel's key (`app.agents.focus`) does from the prompt of `mode`. */
export function setAgentPanelFocuser(mode: object, focus: FocusAgentPanel): void {
	focusers.set(mode, focus);
}

/**
 * The agent panel's key for an extension's editor built on the prompt's editor: what that key does from the prompt,
 * asked when the key arrives. The editor gets the key first, so it can keep the key for itself; when it leaves the key
 * to the prompt's editor, ↓ on its empty prompt focuses the agent panel as on the prompt's own.
 */
export function agentsFocusForwarder(mode: object): NonNullable<CustomEditor["onAgentsFocus"]> {
	return (input) => focusers.get(mode)?.(input) ?? false;
}
