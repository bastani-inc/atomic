import { type Component, decodePrintableKey, isKeyRelease, matchesKey } from "@bastani/atomic-tui";
import type { QueuedMessageReceipt } from "../../../core/queued-message-delivery.ts";
import { firstSubagentAttempt } from "../../../core/tasks/completion.js";
import type { TaskId } from "../../../core/tasks/contracts.js";
import { getOwnerTaskStore } from "../../../core/tasks/owner-store.js";
import { IsolatedInteractiveRuntime } from "../../interactive-engine/isolated-runtime.js";
import { promptHistoryFor } from "../components/agent-prompt-history.ts";
import { AtomicWorkedStatusComponent, watchAtomicWorkingClock } from "../components/atomic-working-status.ts";
import { keyText } from "../components/keybinding-hints.js";
import { clickableKeyTextHint } from "../components/nav-keys.ts";
import { WorkingStatusComponent } from "../components/working-status.ts";
import { isPhysicalCtrlC, isPhysicalEscape } from "../interactive-key-identity.ts";
import type { InteractiveModeBase } from "../interactive-mode-base.ts";
import { mergeRestoredDraft } from "../interactive-prompt-restore.ts";
import {
	engineLossSubagentNotice,
	engineLossUnconfirmedNotice,
	RECEIPT_LOOKUP_TIMEOUT_MS,
	settledWithin,
} from "../interactive-queueing.ts";
import { theme } from "../theme/theme.js";
import {
	appendPromptText,
	markMovedDraft,
	rewritePromptOwnText,
	switchPrompt,
	takePromptText,
} from "./agent-drafts.ts";
import type { AgentViewSwitcher, PendingOutcome } from "./agent-view-switcher.ts";
import type { AgentViewChange, AgentViewPort, AgentWorkingLine, ViewedTarget } from "./contracts.ts";
import { notifyViewed } from "./viewed-notices.ts";
import {
	backFromViewedAgent,
	forgetIfIdle,
	goneAgentNotice,
	liveAgentSteering,
	replayToViewedAgent,
} from "./viewed-submit.ts";

/**
 * Retarget the main prompt to the agent the screen shows. While main is shown nothing here changes what the
 * main chat does or draws. While a subagent is shown, the same prompt writes to it: its own prompt (draft, cursor,
 * pastes, undo, Up history) is in the editor, the placeholder reads `Message @<name>…` and the top rule its title, the
 * rows above the prompt are its queue, the working line and the footer's stop key are its own, and what was typed
 * while it was being opened goes to it.
 */
export function installPromptRetarget(mode: InteractiveModeBase, switcher: AgentViewSwitcher): () => void {
	const undo: (() => void)[] = [];
	// What only a shown subagent needs is set up the first time one is shown or opened: a session that only ever shows
	// main runs exactly as before, with nothing added to its keys or its status row.
	let active = false;
	const activate = () => {
		if (active) return;
		active = true;
		undo.push(drawViewedWorkingLine(mode));
		undo.push(keepBashModeMain(mode));
		undo.push(swallowReadOnlyTyping(mode));
	};
	undo.push(retargetOnSwitch(mode, switcher, activate));
	undo.push(holdWhileOpening(mode, switcher));
	undo.push(reportLostAgentQueues(mode));
	return () => {
		for (const step of undo.splice(0).reverse()) step();
	};
}

function viewedPort(mode: InteractiveModeBase): AgentViewPort | undefined {
	const viewed = mode.agentView?.viewed;
	return viewed?.kind === "agent" ? viewed.port : undefined;
}

function ownerOf(target: ViewedTarget) {
	return target.kind === "agent"
		? ({ kind: "agent", agentKey: target.port.agentKey } as const)
		: ({ kind: "main" } as const);
}

/** Swap the prompt, its history, placeholder, rule, rows and footer when the screen switches. */
function retargetOnSwitch(mode: InteractiveModeBase, switcher: AgentViewSwitcher, activate: () => void): () => void {
	const editor = mode.defaultEditor;
	const history = promptHistoryFor(editor);
	let unwatch: (() => void) | undefined;
	const onChange = ({ from, to }: AgentViewChange) => {
		if (to.kind === "agent") activate();
		unwatch?.();
		unwatch = undefined;
		// The leaving prompt is kept before the history changes: replacing the history ends Up browsing.
		switchPrompt(mode, ownerOf(to), () => {
			if (to.kind === "agent") history.viewAgent(to.port.agentKey, to.port.prompts());
			else history.viewMain();
		});
		if (to.kind === "agent") {
			const port = to.port;
			editor.setPlaceholder(() => {
				const status = port.status();
				return status.readOnlyReason ?? status.placeholder;
			});
			editor.setTopRuleLabel(() => port.status().ruleLabel);
			mode.footer.setViewedWork(() => ({ working: port.status().busy, stopVerb: "pause" }));
			// ← on its empty prompt shows main; the main chat's ← stays the editor's.
			editor.onNavBack = (input) => backFromViewedAgent(mode, input);
			unwatch = port.subscribe(() => {
				mode.updatePendingMessagesDisplay();
				mode.ui.requestRender();
			});
		} else {
			editor.setPlaceholder(undefined);
			editor.setTopRuleLabel(() => mode.sessionManager.getSessionName());
			mode.footer.setViewedWork(undefined);
			editor.onNavBack = undefined;
		}
		if (from.kind === "agent") {
			if (from.port.status().gone) moveGoneDraftToMain(mode, from.port);
			forgetIfIdle(mode, from.port);
		}
		mode.updatePendingMessagesDisplay();
		mode.ui.requestRender();
	};
	const stop = switcher.onChange(onChange);
	return () => {
		stop();
		unwatch?.();
		editor.onNavBack = undefined;
	};
}

/** What was typed for a subagent that is gone goes in front of main's prompt, with the notice. */
function moveGoneDraftToMain(mode: InteractiveModeBase, port: AgentViewPort): void {
	const text = takePromptText(mode, { kind: "agent", agentKey: port.agentKey });
	if (!text.trim()) return;
	// It joins what the reader typed into main's prompt, never a history entry main's prompt was showing.
	const moved = rewritePromptOwnText(mode, { kind: "main" }, (own) => mergeRestoredDraft(text, own));
	markMovedDraft(mode, port.status().name, moved);
	mode.showWarning(goneAgentNotice(port.status().name));
}

/** The viewed subagent's working line, drawn as its chat drew it; nothing when it shows none. */
export function renderAgentWorkingLine(line: AgentWorkingLine | undefined, width: number): string[] {
	if (line === undefined) return [];
	const messageColor = (text: string) => theme.fg("muted", text);
	switch (line.kind) {
		case "worked":
			return new AtomicWorkedStatusComponent({
				...(line.message ? { message: line.message } : {}),
				snapshot: {
					elapsedMs: line.worked?.elapsedMs ?? line.elapsedMs ?? 0,
					tokens: line.worked?.tokens ?? line.tokens ?? 0,
				},
				color: (text) => theme.fg("dim", text),
			}).render(width);
		case "busy":
			return new WorkingStatusComponent({ message: line.message, messageColor }).render(width);
		case "compacting": {
			const cancelKey = keyText("app.interrupt");
			return new WorkingStatusComponent({
				logo: true,
				message: line.message,
				meta: {
					elapsedMs: line.elapsedMs ?? 0,
					tokens: 0,
					...(cancelKey ? { note: clickableKeyTextHint(cancelKey, " to cancel") } : {}),
				},
				messageColor,
			}).render(width);
		}
		case "working":
			return new WorkingStatusComponent({
				message: line.message,
				...(line.elapsedMs === undefined ? {} : { meta: { elapsedMs: line.elapsedMs, tokens: line.tokens ?? 0 } }),
				messageColor,
			}).render(width);
	}
}

/**
 * The status row above the prompt shows the viewed subagent's working line in place of the main chat's, which the
 * main chat keeps updating behind it. With main shown it draws exactly what it always did.
 */
function drawViewedWorkingLine(mode: InteractiveModeBase): () => void {
	const status: Component = mode.statusContainer;
	const mainRender = status.render;
	let stopClock: (() => void) | undefined;
	const animate = (on: boolean) => {
		if (on && stopClock === undefined) stopClock = watchAtomicWorkingClock(() => mode.ui.requestRender());
		else if (!on && stopClock !== undefined) {
			stopClock();
			stopClock = undefined;
		}
	};
	status.render = function (this: Component, width: number): string[] {
		const port = viewedPort(mode);
		if (port === undefined) {
			animate(false);
			return mainRender.call(this, width);
		}
		const line = port.status().working;
		animate(line !== undefined && line.kind !== "worked");
		return renderAgentWorkingLine(line, width);
	};
	return () => {
		animate(false);
		status.render = mainRender;
	};
}

/**
 * `!` makes the main prompt a shell prompt; a subagent's refuses `!` commands, so its prompt never becomes one.
 */
function keepBashModeMain(mode: InteractiveModeBase): () => void {
	const editor = mode.defaultEditor;
	const mainOnChange = editor.onChange;
	const onChange = (text: string) => {
		if (viewedPort(mode) !== undefined) {
			if (mode.isBashMode) {
				mode.isBashMode = false;
				mode.updateEditorBorderColor();
			}
			return;
		}
		mainOnChange?.(text);
	};
	editor.onChange = onChange;
	return () => {
		if (editor.onChange === onChange) editor.onChange = mainOnChange;
	};
}

/** Whether the prompt is what takes the keys now. */
function promptTakesKeys(mode: InteractiveModeBase): boolean {
	if (mode.ui.hasOverlay() || !mode.editorContainer.children.includes(mode.editor)) return false;
	const focused = (mode.ui as { getFocusedComponent?(): object | null }).getFocusedComponent?.();
	return focused === undefined || focused === mode.editor;
}

/** Text the terminal sent as is, without control characters. */
function isPlainText(data: string): boolean {
	return data.length > 0 && [...data].every((ch) => ch >= " " && ch !== "\x7f");
}

/** Printable text, a paste, Enter, Backspace or Delete: keys that type into or send the prompt. */
function isTyping(data: string): boolean {
	if (matchesKey(data, "enter") || matchesKey(data, "backspace") || matchesKey(data, "delete")) return true;
	return data.includes("\x1b[200~") || isPlainText(data) || decodePrintableKey(data) !== undefined;
}

/** A subagent whose chat is read-only takes no typing; scrolling and every other key still work. */
function swallowReadOnlyTyping(mode: InteractiveModeBase): () => void {
	return mode.addTuiInputListener((data) => {
		const port = viewedPort(mode);
		if (port === undefined || port.status().readOnlyReason === undefined) return undefined;
		if (isKeyRelease(data) || !promptTakesKeys(mode) || !isTyping(data)) return undefined;
		return { consume: true };
	});
}

/** The text that `keys` type: printable keys and pastes, less what Backspace removed. Nothing else is replayed. */
export function typedText(keys: readonly string[]): string {
	let text = "";
	for (const key of keys) {
		const paste = /\x1b\[200~([\s\S]*?)\x1b\[201~/.exec(key);
		if (paste) text += paste[1];
		else if (matchesKey(key, "backspace")) text = [...text].slice(0, -1).join("");
		else if (matchesKey(key, "shift+enter")) text += "\n";
		else if (isPlainText(key)) text += key;
		else {
			const printable = decodePrintableKey(key);
			if (printable !== undefined) text += printable;
		}
	}
	return text;
}

/** The subagent `taskId` is an attempt of, as its first attempt's id, where this process holds its tasks. */
function agentKeyOf(mode: InteractiveModeBase, taskId: TaskId): TaskId {
	const tasks = getOwnerTaskStore(mode.session)?.tasks;
	return (tasks === undefined ? undefined : firstSubagentAttempt(tasks, taskId)?.ref.taskId) ?? taskId;
}

/** Text typed for a subagent that was being opened when the request did not land, kept for when it is shown. */
const heldForTask = new WeakMap<InteractiveModeBase, Map<TaskId, string>>();

/**
 * While a subagent is being opened, what the reader types is meant for it. The keys wait, and once it is shown they
 * reach its prompt in order, Enter included. When the request does not land, their text is kept for that subagent
 * (or, when it cannot be opened, shown in a notice) and the keys that send, pause or take back are dropped: nothing
 * typed for one agent reaches another. A ← among them moves its cursor and never shows main. Esc cancels the request;
 * Ctrl+C and Ctrl+D are never held.
 */
function holdWhileOpening(mode: InteractiveModeBase, switcher: AgentViewSwitcher): () => void {
	let held: { readonly taskId: TaskId; readonly keys: string[] } | undefined;
	const keptFor = () => {
		let map = heldForTask.get(mode);
		if (map === undefined) {
			map = new Map();
			heldForTask.set(mode, map);
		}
		return map;
	};
	const settle = (taskId: TaskId, outcome: PendingOutcome) => {
		const keys = held;
		if (keys === undefined || keys.taskId !== taskId) return;
		held = undefined;
		if (keys.keys.length === 0) return;
		if (outcome === "shown") {
			replayToViewedAgent(mode, keys.keys);
			mode.ui.requestRender();
			return;
		}
		// Not shown: the keys that send, pause or take back go nowhere; the text stays the subagent's.
		const text = typedText(keys.keys);
		if (!text.trim()) return;
		if (outcome === "failed") {
			mode.showWarning(`The subagent could not be shown; what you typed for it was not sent:\n${text}`);
			return;
		}
		// Kept under the subagent across its attempts where this process knows them: a resume meanwhile moves its row.
		const key = agentKeyOf(mode, taskId);
		const kept = keptFor();
		kept.set(key, `${kept.get(key) ?? ""}${text}`);
		notifyViewed(mode, "What you typed for the subagent is kept for it.", "info");
	};
	const hold = (data: string) => {
		const pending = switcher.pendingTaskId;
		if (pending === undefined || isKeyRelease(data) || !promptTakesKeys(mode)) return undefined;
		// Ctrl+C and Ctrl+D act as they always do; Esc cancels the request and the screen stays as it is.
		if (isPhysicalCtrlC(data) || mode.keybindings.matches(data, "app.clear")) return undefined;
		if (mode.keybindings.matches(data, "app.exit")) return undefined;
		if (isPhysicalEscape(data) || mode.keybindings.matches(data, "app.interrupt")) {
			switcher.cancelPending();
			return { consume: true };
		}
		if (held === undefined || held.taskId !== pending) held = { taskId: pending, keys: [] };
		held.keys.push(data);
		return { consume: true };
	};
	// The keys are listened to from the first time a subagent is being opened.
	let stopListening: (() => void) | undefined;
	const stopPending = switcher.onPending((pending, settled) => {
		if (pending !== undefined) stopListening ??= mode.addTuiInputListener(hold);
		if (settled !== undefined) settle(settled.taskId, settled.outcome);
	});
	const stopChange = switcher.onChange(({ to }) => {
		const pending = switcher.pendingTaskId;
		if (to.kind !== "agent") return;
		// Text kept for this subagent from a request that did not land joins its prompt now.
		const kept = heldForTask.get(mode);
		if (kept === undefined || kept.size === 0) return;
		for (const id of new Set([pending, to.port.status().taskId, to.port.agentKey as TaskId])) {
			const text = id === undefined ? undefined : kept.get(id);
			if (id === undefined || text === undefined) continue;
			kept.delete(id);
			appendPromptText(mode, { kind: "agent", agentKey: to.port.agentKey }, text);
		}
	});
	return () => {
		stopListening?.();
		stopPending();
		stopChange();
	};
}

/**
 * The isolated engine was lost, and the subagents' sessions with it. What each shown or still-answering
 * subagent's prompt had queued or on its way is listed in full in a warning per subagent, as origin's subagent chats
 * reported theirs; nothing is sent again. A deliberate replacement changes nothing.
 */
function reportLostAgentQueues(mode: InteractiveModeBase): () => void {
	const runtime = mode.runtimeHost;
	if (!(runtime instanceof IsolatedInteractiveRuntime)) return () => {};
	return attachLostAgentQueueNotices(mode, runtime);
}

/** What a subagent's lost engine had taken from its queue and not been seen to save, with its receipt if it has one. */
interface TakenMessage {
	readonly text: string;
	readonly receipt?: QueuedMessageReceipt;
}

/**
 * Show these notices when `runtime`'s engine generation ends unexpectedly. Answers the detach.
 *
 * A message a subagent had taken from its queue and not been seen to save may have been saved with its session. When it
 * has a receipt, its engine's replacement is asked (for up to two seconds once it is up) whether its session's store
 * holds it: one found saved is not reported; one the store provably never saved is listed with the messages that were
 * not sent; any other is listed in full as possibly undelivered, as is every one without a receipt. Nothing is sent
 * again, and nothing goes into any prompt.
 */
export function attachLostAgentQueueNotices(
	mode: InteractiveModeBase,
	runtime: Pick<IsolatedInteractiveRuntime, "onGenerationEnded"> &
		Partial<Pick<IsolatedInteractiveRuntime, "onEngineRecovered" | "findQueuedMessages">>,
): () => void {
	const stops = new Set<() => void>();
	let detached = false;
	const stopEnded = runtime.onGenerationEnded((event) => {
		if (event.expected) return;
		// Two chats of one subagent report the same message with the same receipt: it is accounted for once.
		const reported = new Set<string>();
		for (const { port, controller } of liveAgentSteering(mode)) {
			const { delivering, unsaved, receipts, name } = port.status();
			const texts = [
				...(unsaved ?? []),
				...(delivering === undefined ? [] : [...delivering.steering, ...delivering.followUp]),
			];
			// Receipts name the same messages in the same order; any other list is not theirs.
			const taken: TakenMessage[] = texts.flatMap((text, index) => {
				const receipt = receipts?.taken.length === texts.length ? receipts.taken[index] : undefined;
				if (receipt === undefined || receipt === null) return [{ text }];
				const key = JSON.stringify([receipts?.sessionId, receipt.epoch ?? null, receipt.id]);
				if (reported.has(key)) return [];
				reported.add(key);
				return [{ text, receipt }];
			});
			// Its listed queue, what it took before listing, and what was on its way: steering first, each lane in order.
			controller.loseTarget();
			const listed = controller.recoverTarget() ?? [];
			const find = runtime.findQueuedMessages?.bind(runtime);
			if (
				receipts === undefined ||
				find === undefined ||
				runtime.onEngineRecovered === undefined ||
				!taken.some((message) => message.receipt !== undefined)
			) {
				showLostAgentNotices(mode, name, taken, listed, undefined);
				continue;
			}
			const stop = runtime.onEngineRecovered((replaced) => {
				stop();
				stops.delete(stop);
				void (async () => {
					const session = {
						sessionId: receipts.sessionId,
						...(receipts.sessionFile === undefined ? {} : { sessionFile: receipts.sessionFile }),
					};
					const found = replaced
						? await settledWithin(find(taken, session), RECEIPT_LOOKUP_TIMEOUT_MS)
						: undefined;
					// A chat that stopped meanwhile shows nothing more.
					if (detached) return;
					showLostAgentNotices(mode, name, taken, listed, found);
					mode.ui.requestRender();
				})();
			});
			stops.add(stop);
		}
		mode.updatePendingMessagesDisplay();
		mode.ui.requestRender();
	});
	return () => {
		detached = true;
		stopEnded();
		for (const stop of [...stops]) stop();
		stops.clear();
	};
}

/**
 * The notices for one subagent whose engine was lost: what it had taken that `found` (its replacement's answer, if any)
 * does not account for, as possibly undelivered; what it never sent, `listed` and the taken messages its store never
 * saved, as not sent.
 */
function showLostAgentNotices(
	mode: InteractiveModeBase,
	agent: string,
	taken: readonly TakenMessage[],
	listed: readonly string[],
	found: { readonly saved: ReadonlySet<string>; readonly absent: ReadonlySet<string> } | undefined,
): void {
	const outcome = (message: TakenMessage) =>
		message.receipt === undefined
			? "unknown"
			: found?.saved.has(message.receipt.id)
				? "saved"
				: found?.absent.has(message.receipt.id)
					? "unsaved"
					: "unknown";
	const unconfirmed = taken.flatMap((message) => (outcome(message) === "unknown" ? [message.text] : []));
	if (unconfirmed.length > 0) mode.showWarning(engineLossUnconfirmedNotice(unconfirmed, agent));
	const unsent = taken.flatMap((message) =>
		outcome(message) === "unsaved" ? [message.receipt?.typed ?? message.text] : [],
	);
	const notice = engineLossSubagentNotice({ agent, steering: [...unsent, ...listed], followUp: [] });
	if (notice !== undefined) mode.showWarning(notice);
}
