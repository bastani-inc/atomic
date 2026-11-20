import type { AppKeybinding } from "../../../core/keybindings.ts";
import { BUNDLED_EXTENSION_SLASH_COMMANDS } from "../../../core/slash-commands.js";
import { copyToClipboard } from "../../../utils/clipboard.js";
import { getInteractiveEngineRemoteCommands } from "../../interactive-engine/extension-ui-bridge.ts";
import { keyDisplayText } from "../components/keybinding-hints.js";
import { applyViewedAutocomplete } from "../interactive-autocomplete.ts";
import { mainSubmit } from "../interactive-input-handling.ts";
import type { InteractiveModeBase } from "../interactive-mode-base.ts";
import { mergeRestoredDraft } from "../interactive-prompt-restore.ts";
import { type MainCommandOrigin, viewedAgentCommand } from "../subagent-chat-commands.ts";
import { markMovedDraft, type PromptHandle, promptHandle, takeMovedDraftMark } from "./agent-drafts.ts";
import type { AgentViewSwitcher } from "./agent-view-switcher.ts";
import type { AgentViewPort } from "./contracts.ts";
import { notifyViewed } from "./viewed-notices.ts";

/**
 * Where a submission typed while a subagent is shown goes: `agent` (sent to it), `main` (the caller runs it as the
 * main chat would, through `mainSubmit`), or `handled` (refused, cancelled, or run here).
 */
export type ViewedCommandRoute = "agent" | "main" | "handled";

/**
 * Route `text`, typed while `port`'s subagent is shown (see {@link viewedAgentCommand} for the table):
 * - a built-in that acts on the main session or on Atomic runs as in the main chat; one whose answer is printed into
 *   the main transcript runs with main shown;
 * - one that replaces, rewrites or switches the main conversation asks first, naming the main conversation; Yes shows
 *   main and runs it there, No or Esc puts the command back in the prompt;
 * - one that sets the main conversation's model or thinking level is refused with a notice;
 * - `/copy` copies the subagent's last message;
 * - anything else is the subagent's: its session expands its skills and templates and runs its extension commands.
 */
export async function routeViewedCommand(
	mode: InteractiveModeBase,
	port: AgentViewPort,
	text: string,
): Promise<ViewedCommandRoute> {
	const command = viewedAgentCommand(text, (name) => mainCommandOrigin(mode, name));
	switch (command.kind) {
		case "agent":
			return "agent";
		case "main":
			if (!command.showMain) return "main";
			await runWithMainShown(mode, text, promptHandle(mode, "viewed"));
			return "handled";
		case "refuse":
			notifyViewed(
				mode,
				refusalNotice(`/${command.name}`, command.name === "thinking" ? "thinking" : "model"),
				"warning",
			);
			return "handled";
		case "copy":
			await copyLastMessage(mode, port);
			return "handled";
		case "confirm": {
			const typedIn = promptHandle(mode, "viewed");
			if (!(await confirmMainConversation(mode, port, `/${command.name}`))) {
				if (port.status().gone) {
					// Its prompt went with it. Main's prompt does not take it: one Enter there would run it unasked.
					mode.showWarning(`${text} was not run.`);
				} else {
					// The command comes back in front of what the subagent's prompt holds now, as it was typed.
					typedIn.setText(mergeRestoredDraft(text, typedIn.getExpandedText()));
					mode.ui.requestRender();
				}
				return "handled";
			}
			await runWithMainShown(mode, text, typedIn);
			return "handled";
		}
	}
}

/**
 * Main's prompt submitted holding, unedited, the text a gone subagent's prompt moved there (D6): one Enter never runs a
 * command typed for a subagent that would replace, rewrite or switch the main conversation, or set its model or
 * thinking level. It asks first, as from the subagent's view; No or Esc puts main's prompt back as it was, still
 * marked. Answers undefined, synchronously, for any other submission, which main's path runs as before.
 */
export function gateMovedDraft(mode: InteractiveModeBase, text: string, draft: string): Promise<void> | undefined {
	const mark = takeMovedDraftMark(mode, text);
	if (mark === undefined) return undefined;
	const command = viewedAgentCommand(text, (name) => mainCommandOrigin(mode, name));
	if (command.kind !== "confirm" && command.kind !== "refuse") return undefined;
	const name = `/${command.name}`;
	return (async () => {
		const yes = await mode.showExtensionConfirm(
			`Run ${name} on the main conversation?`,
			`${name} was typed for ${mark.agentName}, which is gone. It acts on the main conversation.`,
		);
		if (yes) {
			await mainSubmit(mode, text, draft);
			return;
		}
		const prompt = promptHandle(mode, "main");
		const restored = mergeRestoredDraft(draft, prompt.getExpandedText());
		prompt.setText(restored);
		markMovedDraft(mode, mark.agentName, restored);
		mode.ui.requestRender();
	})();
}

/**
 * The convention for extension commands while a subagent is shown: those Atomic ships run on main, those the user or
 * the project installed go to the subagent. Main's own session answers in this process; on the isolated host the
 * engine's catalog does, and while extensions still load, the bundled commands' names stand for them.
 */
function mainCommandOrigin(mode: InteractiveModeBase, name: string): MainCommandOrigin | undefined {
	const local = mode.session.extensionRunner?.getCommand(name);
	if (local !== undefined) return local.sourceInfo.configurationOrigin === "bundled" ? "bundled" : "configured";
	const remote = getInteractiveEngineRemoteCommands(mode.runtimeHost).find(
		(command) => command.source === "extension" && command.name === name,
	);
	if (remote !== undefined) return remote.sourceInfo.configurationOrigin === "bundled" ? "bundled" : "configured";
	if (mode.deferredStartupPending && BUNDLED_EXTENSION_SLASH_COMMANDS.some((command) => command.name === name))
		return "bundled";
	return undefined;
}

/**
 * Show main, then run `text` exactly as the main chat runs it. Its handler clears and records the prompt the command
 * was typed into, `typedIn`, so main's own prompt keeps what the reader left in it.
 */
async function runWithMainShown(mode: InteractiveModeBase, text: string, typedIn: PromptHandle): Promise<void> {
	await mode.agentView?.view(undefined);
	await mainSubmit(mode, text, text, typedIn);
}

/** Yes/No before acting on the main conversation from a subagent's view; Esc answers No. */
function confirmMainConversation(mode: InteractiveModeBase, port: AgentViewPort, command: string): Promise<boolean> {
	return mode.showExtensionConfirm(
		`Run ${command} on the main conversation?`,
		`${command} acts on the main conversation, not on ${port.status().name}. The screen switches to main.`,
	);
}

/** The notice for a command or key that would set the main conversation's model or thinking level. */
export function refusalNotice(command: string, sets: "model" | "thinking"): string {
	const what = sets === "model" ? "model" : "thinking level";
	return `${command} changes the main conversation's ${what}. Switch to main to use it.`;
}

/** `/copy` while a subagent is shown copies its last message; the notices are about it alone. */
async function copyLastMessage(mode: InteractiveModeBase, port: AgentViewPort): Promise<void> {
	try {
		const text = await port.lastAgentMessageText();
		if (!text) {
			notifyViewed(mode, "No agent messages to copy yet.", "error");
			return;
		}
		await copyToClipboard(text);
		notifyViewed(mode, "Copied last agent message to clipboard", "info");
	} catch (error) {
		notifyViewed(mode, error instanceof Error ? error.message : String(error), "error");
	}
}

/** Keys that act on the main conversation: the command each stands for, and whether it asks first or is refused. */
const GATED_ACTIONS: ReadonlyMap<AppKeybinding, { readonly command: string; readonly refused?: "model" | "thinking" }> =
	new Map<AppKeybinding, { readonly command: string; readonly refused?: "model" | "thinking" }>([
		["app.session.new", { command: "/new" }],
		["app.session.tree", { command: "/tree" }],
		["app.session.fork", { command: "/fork" }],
		["app.session.resume", { command: "/resume" }],
		["app.model.select", { command: "/model", refused: "model" }],
		["app.model.cycleForward", { command: "/model", refused: "model" }],
		["app.model.cycleBackward", { command: "/model", refused: "model" }],
		["app.thinking.cycle", { command: "/thinking", refused: "thinking" }],
	]);

/**
 * Gate the prompt's keys that act on the main conversation while a subagent is shown: the session keys ask first and
 * then run on main with main shown; the model and thinking keys are refused with a notice. While main is shown each key
 * runs its own handler, untouched. The prompt's completion follows what the screen shows. Answers the uninstall.
 */
export function installViewedCommandGates(mode: InteractiveModeBase, switcher: AgentViewSwitcher): () => void {
	const unwatch = switcher.onChange(() => applyViewedAutocomplete(mode));
	// A host whose prompt takes no key actions has no keys to gate.
	if (!((mode.defaultEditor as { actionHandlers?: unknown }).actionHandlers instanceof Map)) return unwatch;
	const editors = [mode.defaultEditor, mode.editor].filter(
		(editor, index, all): editor is typeof mode.defaultEditor =>
			all.indexOf(editor) === index && (editor as { actionHandlers?: unknown }).actionHandlers instanceof Map,
	);
	const undo: (() => void)[] = [];
	for (const [action, gate] of GATED_ACTIONS) {
		const original = mode.defaultEditor.actionHandlers.get(action);
		if (original === undefined) continue;
		const gated = () => {
			const viewed = switcher.viewed;
			if (viewed.kind === "main") {
				original();
				return;
			}
			if (gate.refused !== undefined) {
				notifyViewed(mode, refusalNotice(keyDisplayText(action) || gate.command, gate.refused), "warning");
				return;
			}
			void confirmMainConversation(mode, viewed.port, gate.command).then(async (yes) => {
				if (!yes) return;
				await switcher.view(undefined);
				original();
			});
		};
		for (const editor of editors) {
			if (editor.actionHandlers.get(action) !== original) continue;
			editor.actionHandlers.set(action, gated);
			undo.push(() => {
				if (editor.actionHandlers.get(action) === gated) editor.actionHandlers.set(action, original);
			});
		}
	}
	return () => {
		unwatch();
		for (const restore of undo.splice(0)) restore();
	};
}

/**
 * Esc twice on an empty prompt while a subagent is shown and idle: the main chat's double-Esc action (its tree or its
 * fork selector) asks first, then opens on main with main shown.
 */
export function runViewedDoubleEscapeAction(mode: InteractiveModeBase, action: "tree" | "fork"): void {
	const open = () => (action === "tree" ? mode.showTreeSelector() : mode.showUserMessageSelector());
	const viewed = mode.agentView?.viewed;
	if (viewed?.kind !== "agent") {
		void open();
		return;
	}
	void confirmMainConversation(mode, viewed.port, `/${action}`).then(async (yes) => {
		if (!yes) return;
		await mode.agentView?.view(undefined);
		await open();
	});
}
