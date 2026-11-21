import type { QueuedTaskMessages } from "../../../core/tasks/supervisor.js";
import { combineQueuedMessagesForEditor } from "../chat-input-actions.ts";
import type { NavBackInput } from "../components/custom-editor.ts";
import { mainSubmit } from "../interactive-input-handling.ts";
import type { InteractiveModeBase } from "../interactive-mode-base.ts";
import { mergeRestoredDraft } from "../interactive-prompt-restore.ts";
import {
	type SteeringEditorQueue,
	SteeringQueueController,
	type SteeringSubmitLane,
} from "../steering-queue-controller.ts";
import { markMovedDraft, type PromptHandle, promptHandle, rewritePromptOwnText } from "./agent-drafts.ts";
import type { AgentViewPort } from "./contracts.ts";
import { routeViewedCommand } from "./viewed-commands.ts";
import { type ViewedAgentKey, type ViewedAgentKeyAction, viewedAgentKeyAction } from "./viewed-keys.ts";
import { notifyViewed } from "./viewed-notices.ts";

/**
 * What the one prompt does while a subagent is shown: it steers that subagent exactly as it steers the main chat,
 * through the shared steering controller over the subagent's own session (#6008). Enter steers and Alt+Enter queues a
 * follow-up while it works, each shown as a queued row until the subagent takes it; Alt+Up takes every queued message
 * back; Esc pauses it and its queued messages come back to its prompt; the next message continues it. ← on an empty
 * prompt shows main and leaves it running.
 */

/** `!` commands run in the main chat's shell; a subagent's view refuses them. */
export const VIEWED_BASH_REFUSED = "`!` commands run in the main chat. Switch to main to run them.";

/** The notice when text meant for a subagent that is gone comes back in front of main's prompt. */
export function goneAgentNotice(name: string): string {
	return `${name} is gone; your message to it is in the prompt.`;
}

interface AgentSteeringEntry {
	readonly controller: SteeringQueueController;
	/** Submissions and restores still on their way to or from it; the port stays open until they settle. */
	busy: number;
	release: (() => void) | undefined;
}

const entries = new WeakMap<InteractiveModeBase, Map<AgentViewPort, AgentSteeringEntry>>();

function entriesOf(mode: InteractiveModeBase): Map<AgentViewPort, AgentSteeringEntry> {
	let map = entries.get(mode);
	if (map === undefined) {
		map = new Map();
		entries.set(mode, map);
	}
	return map;
}

function isViewed(mode: InteractiveModeBase, port: AgentViewPort): boolean {
	const viewed = mode.agentView?.viewed;
	return viewed?.kind === "agent" && viewed.port === port;
}

/** The rows drawn above the prompt changed: they are the viewed agent's, so redraw them when it is this one. */
function agentEditorQueue(mode: InteractiveModeBase, port: AgentViewPort): SteeringEditorQueue {
	return {
		held: () => [],
		takeHeld: () => ({ messages: [], putBack: () => {} }),
		changed: () => {
			if (isViewed(mode, port)) mode.updatePendingMessagesDisplay();
		},
		requestRender: () => mode.ui.requestRender(),
	};
}

function entryOf(mode: InteractiveModeBase, port: AgentViewPort): AgentSteeringEntry {
	const map = entriesOf(mode);
	let entry = map.get(port);
	if (entry === undefined) {
		entry = {
			controller: new SteeringQueueController(port.steering, agentEditorQueue(mode, port)),
			busy: 0,
			release: undefined,
		};
		map.set(port, entry);
	}
	return entry;
}

/** The steering controller of `port`'s subagent: one per open port, as the main chat's is one per chat. */
export function agentSteering(mode: InteractiveModeBase, port: AgentViewPort): SteeringQueueController {
	return entryOf(mode, port).controller;
}

/** The steering controller of the subagent the screen shows; undefined while it shows main. */
export function viewedSteering(mode: InteractiveModeBase): SteeringQueueController | undefined {
	const viewed = mode.agentView?.viewed;
	return viewed?.kind === "agent" ? agentSteering(mode, viewed.port) : undefined;
}

/** Keep `port` open while something is on its way to or from its subagent. */
function hold(mode: InteractiveModeBase, port: AgentViewPort): () => void {
	const entry = entryOf(mode, port);
	if (entry.busy++ === 0) entry.release = port.retain();
	let done = false;
	return () => {
		if (done) return;
		done = true;
		if (--entry.busy > 0) return;
		const release = entry.release;
		entry.release = undefined;
		forgetIfIdle(mode, port);
		release?.();
	};
}

/**
 * Drop `port`'s controller once it is neither shown nor waiting on its subagent. A subagent that is gone keeps it until
 * the current task ends: when its engine was lost, its view closes and the screen shows main within the same report of
 * the loss, and the loss's own notice still needs what its controller held.
 */
export function forgetIfIdle(mode: InteractiveModeBase, port: AgentViewPort): void {
	if (port.status().gone) {
		queueMicrotask(() => drop(mode, port));
		return;
	}
	drop(mode, port);
}

function drop(mode: InteractiveModeBase, port: AgentViewPort): void {
	const map = entriesOf(mode);
	const entry = map.get(port);
	if (entry === undefined || entry.busy > 0 || isViewed(mode, port)) return;
	entry.controller.dispose();
	map.delete(port);
}

/** Every subagent controller still in use, with the port it steers (the engine was lost: they report what they held). */
export function liveAgentSteering(
	mode: InteractiveModeBase,
): readonly { readonly port: AgentViewPort; readonly controller: SteeringQueueController }[] {
	return [...entriesOf(mode)].map(([port, entry]) => ({ port, controller: entry.controller }));
}

/**
 * Text that belongs to `port`'s subagent comes back to its prompt, in front of what it holds. Once the subagent is
 * gone, it comes back in front of main's prompt instead, with the notice.
 */
function giveBack(
	mode: InteractiveModeBase,
	port: AgentViewPort,
	prompt: PromptHandle,
	combine: (current: string) => string,
): void {
	if (port.status().gone) {
		// It joins what the reader typed into main's prompt, never a history entry main's prompt was showing.
		const moved = rewritePromptOwnText(mode, { kind: "main" }, combine);
		markMovedDraft(mode, port.status().name, moved);
		mode.showWarning(goneAgentNotice(port.status().name));
	} else prompt.setText(combine(prompt.getExpandedText()));
	mode.updatePendingMessagesDisplay();
	mode.ui.requestRender();
}

/** Messages taken back from the subagent's queue go in front of its prompt, steering first, as Alt+Up does. */
function giveBackQueued(
	mode: InteractiveModeBase,
	port: AgentViewPort,
	prompt: PromptHandle,
	taken: QueuedTaskMessages,
): number {
	const messages = [...taken.steering, ...taken.followUp];
	if (messages.length > 0)
		giveBack(mode, port, prompt, (current) => combineQueuedMessagesForEditor(messages, current));
	return messages.length;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * What the prompt submits while `port`'s subagent is shown: `text` trimmed, `draft` as typed. A command the main chat
 * runs goes there; a `!` command is refused; anything else is sent to the subagent through its steering controller,
 * queued in `lane` while it works, continuing it while it is paused or finished. A message it refuses comes back to
 * its prompt above what was typed since.
 */
export async function submitToViewedAgent(
	mode: InteractiveModeBase,
	port: AgentViewPort,
	text: string,
	draft: string,
	lane: SteeringSubmitLane = "auto",
): Promise<void> {
	// Bound to this subagent's prompt now: a switch while this is on its way leaves it there.
	const prompt = promptHandle(mode, "viewed");
	if (text.startsWith("!")) {
		prompt.setText(draft);
		notifyViewed(mode, VIEWED_BASH_REFUSED, "warning");
		return;
	}
	const release = hold(mode, port);
	try {
		const route = await routeViewedCommand(mode, port, text);
		if (route === "main") {
			await mainSubmit(mode, text, draft, prompt);
			return;
		}
		if (route === "handled") return;
		if (port.status().readOnlyReason !== undefined) {
			prompt.setText(mergeRestoredDraft(draft, prompt.getText()));
			notifyViewed(mode, port.status().readOnlyReason ?? "", "warning");
			return;
		}
		prompt.addToHistory(text);
		prompt.setText("");
		const controller = agentSteering(mode, port);
		mode.ui.requestRender();
		const result = await controller.submit(text, lane);
		if (result.kind === "refused") {
			giveBack(mode, port, prompt, (current) => mergeRestoredDraft(draft, current));
			notifyViewed(mode, errorText(result.error), "warning");
		} else if (result.kind === "lost" || result.kind === "failed") {
			notifyViewed(mode, errorText(result.error), "warning");
		}
		mode.updatePendingMessagesDisplay();
		mode.ui.requestRender();
	} finally {
		release();
	}
}

/** Pause `port`'s subagent (Esc): its turn ends, it keeps its task, and its queued messages come back to its prompt. */
function pauseViewedAgent(mode: InteractiveModeBase, port: AgentViewPort): void {
	const prompt = promptHandle(mode, "viewed");
	const release = hold(mode, port);
	void port
		.pause()
		.then(
			(paused) => {
				if (!paused.ok) {
					notifyViewed(mode, paused.error.message, "warning");
					return;
				}
				// A pause a restart would not keep says why: under the subagent while it is shown, else in the main chat.
				if (paused.value.warning !== undefined) notifyViewed(mode, paused.value.warning, "warning");
				giveBackQueued(mode, port, prompt, paused.value);
			},
			(error: unknown) => notifyViewed(mode, errorText(error), "warning"),
		)
		.finally(release);
	mode.ui.requestRender();
}

/** Whether Esc pauses the subagent now: it works, waits to retry, or has messages queued, as in the main chat. */
function pausable(mode: InteractiveModeBase, port: AgentViewPort): boolean {
	const status = port.status();
	return status.busy || status.retrying || agentSteering(mode, port).hasQueued();
}

/** Do what {@link viewedAgentKeyAction} decided for `key` on the subagent `port` shows; `editor` leaves the key to it. */
function actOnViewedAgent(mode: InteractiveModeBase, port: AgentViewPort, key: ViewedAgentKey): ViewedAgentKeyAction {
	const action = viewedAgentKeyAction(key);
	if (action === "pause") pauseViewedAgent(mode, port);
	if (action === "showMain") void mode.agentView?.view(undefined);
	return action;
}

/**
 * Esc while a subagent is shown: pause it when it works, waits to retry or has messages queued. It never shows main,
 * and it is never the first press of main's double-Esc. Answers false while main is shown, which keeps the main chat's
 * Esc.
 */
export function escapeViewedAgent(mode: InteractiveModeBase): boolean {
	const viewed = mode.agentView?.viewed;
	if (viewed?.kind !== "agent") return false;
	mode.lastEscapeTime = 0;
	actOnViewedAgent(mode, viewed.port, { key: "escape", pausable: pausable(mode, viewed.port) });
	return true;
}

/** Keys pressed while a subagent was being opened are being typed into its prompt. */
const replaying = new WeakSet<InteractiveModeBase>();

/** Type `keys`, pressed while the subagent now shown was being opened, into its prompt. None of them shows main. */
export function replayToViewedAgent(mode: InteractiveModeBase, keys: readonly string[]): void {
	replaying.add(mode);
	try {
		for (const key of keys) mode.editor.handleInput(key);
	} finally {
		replaying.delete(mode);
	}
}

/**
 * The back key while a subagent is shown: on an empty prompt, or from a click on its hint, it shows main and leaves the
 * subagent's run, its queue and both prompts as they are. That press is not the first of main's double-Esc. Answers
 * false when the key is the prompt's: text is typed, or another handler has that key.
 */
export function backFromViewedAgent(mode: InteractiveModeBase, input: NavBackInput): boolean {
	const viewed = mode.agentView?.viewed;
	if (viewed?.kind !== "agent") return false;
	const key: ViewedAgentKey = {
		key: "back",
		promptEmpty: input.promptEmpty,
		clicked: input.clicked,
		replayed: replaying.has(mode),
	};
	if (viewedAgentKeyAction(key) === "editor" || !input.isBackKey()) return false;
	mode.lastEscapeTime = 0;
	actOnViewedAgent(mode, viewed.port, key);
	return true;
}

/**
 * Ctrl+C on an empty prompt while a subagent is shown: it pauses the subagent's running work, as Esc does, and keeps it
 * shown. It never counts toward exiting Atomic. Answers false while main is shown.
 */
export function leaveViewedAgent(mode: InteractiveModeBase): boolean {
	const viewed = mode.agentView?.viewed;
	if (viewed?.kind !== "agent") return false;
	actOnViewedAgent(mode, viewed.port, { key: "leave", pausable: pausable(mode, viewed.port) });
	return true;
}

/**
 * A stop request from outside the keyboard (a SIGINT signal) while a subagent is shown: it stops the subagent's running
 * work as Esc does, never main's, and changes nothing else. Answers whether it paused it, or undefined while main is
 * shown.
 */
export function interruptViewedAgent(mode: InteractiveModeBase): boolean | undefined {
	const viewed = mode.agentView?.viewed;
	if (viewed?.kind !== "agent") return undefined;
	return actOnViewedAgent(mode, viewed.port, { key: "signal", pausable: pausable(mode, viewed.port) }) === "pause";
}

/** Alt+Up while a subagent is shown: every message queued for it comes back to its prompt. False while main is shown. */
export function dequeueViewedAgent(mode: InteractiveModeBase): boolean {
	const viewed = mode.agentView?.viewed;
	if (viewed?.kind !== "agent") return false;
	const port = viewed.port;
	const prompt = promptHandle(mode, "viewed");
	const release = hold(mode, port);
	void agentSteering(mode, port)
		.restoreAll(() => prompt.getExpandedText())
		.then(
			(restored) => {
				if (restored === undefined) notifyViewed(mode, "No queued messages to restore", "info");
				else giveBack(mode, port, prompt, () => restored.text);
			},
			(error: unknown) => notifyViewed(mode, `Failed to restore queued messages: ${errorText(error)}`, "error"),
		)
		.finally(release);
	return true;
}

/**
 * Alt+Enter while a subagent is shown: a follow-up while it works, and like Enter otherwise, as in the main chat.
 * False while main is shown.
 */
export function followUpViewedAgent(mode: InteractiveModeBase): boolean {
	const viewed = mode.agentView?.viewed;
	if (viewed?.kind !== "agent") return false;
	const raw = mode.editor.getExpandedText?.() ?? mode.editor.getText();
	const text = raw.trim();
	if (!text) return true;
	const status = viewed.port.status();
	mode.editor.setText("");
	const sent =
		status.busy && !status.paused
			? submitToViewedAgent(mode, viewed.port, text, raw, "followUp")
			: Promise.resolve(mode.editor.onSubmit?.(raw));
	void sent.catch((error: unknown) => notifyViewed(mode, errorText(error), "error"));
	return true;
}
