import { TRANSCRIPT_JUMP_TO_END_URL } from "@bastani/atomic";

import { APP_ACTION, isKeybindingsLike, matchesAction, TUI_ACTION } from "./keybindings-adapter.js";
import { parseTerminalMouseInput, terminalMouseWheelDirection } from "./mouse-input.js";
import { defaultResponseFor, handlePromptCardInput, isPromptEscapeInput } from "./prompt-card.js";
import {
	closeStageChatSearch,
	navigateStageChatSearch,
	openStageChatSearch,
	typeIntoStageChatSearch,
} from "./stage-chat-search.js";
import { releaseMountedCustomUi } from "./stage-chat-view-custom-ui.js";
import { setComponentFocused, setEditorFocused } from "./stage-chat-view-render-helpers.js";
import {
	canSubmitPrompt,
	currentStage,
	isAbortableStreamingSession,
	isBlocked,
	isReadOnlyArchive,
	promptPageSize,
	recordCurrentPromptDraft,
	resolvePromptResponse,
	syncPromptState,
} from "./stage-chat-view-state.js";
import { PROMPT_SCROLL_STEP_ROWS, type StageChatViewContext } from "./stage-chat-view-types.js";
import { Key, matchesKey } from "./text-helpers.js";

export function handleStageChatInput(ctx: StageChatViewContext, data: string): boolean {
	if (data === TRANSCRIPT_JUMP_TO_END_URL) return handleStageChatJumpToBottom(ctx, data);
	const keybindings = isKeybindingsLike(ctx.piKeybindings) ? ctx.piKeybindings : undefined;
	// Only the default physical Ctrl+T belongs to the host thinking action. A
	// user remap may reuse an editor key, so let that key reach the composer.
	if (matchesKey(data, Key.ctrl("t")) && matchesAction(keybindings, data, APP_ACTION.thinkingToggle)) {
		return false;
	}
	if (matchesKey(data, Key.ctrl("x"))) {
		// Leaving for the graph takes the find box with it: a chat reattached
		// later opens on its transcript, not on someone's stale query.
		closeStageChatSearch(ctx);
		if (ctx.mountedCustomUi) releaseMountedCustomUi(ctx);
		else {
			const stage = currentStage(ctx);
			syncPromptState(ctx, stage?.pendingPrompt);
			recordCurrentPromptDraft(ctx);
		}
		ctx.onDetach();
		return true;
	}
	if (ctx.mountedCustomUi) {
		// A mounted custom UI replaces the transcript body; a find box left open
		// over it would search rows nobody can see.
		closeStageChatSearch(ctx);
		return handleMountedCustomUiInput(ctx, data);
	}
	const stage = currentStage(ctx);
	syncPromptState(ctx, stage?.pendingPrompt);
	const readOnlyArchive = isReadOnlyArchive(ctx, stage);
	const readOnlyPromptArchive = readOnlyArchive && stage?.promptFootprint !== undefined;

	// A prompt card or a blocked stage swaps the transcript out of the body for
	// the same reason, so the search goes with it.
	if (ctx.search && (ctx.promptState || isBlocked(ctx))) closeStageChatSearch(ctx);
	if (ctx.search) return handleStageChatSearchKeys(ctx, data);
	if (ctx.promptState) {
		if (handlePromptScrollInput(ctx, data, ctx.promptEditor === null)) return true;
		handlePromptInput(ctx, data);
		return true;
	}
	if (handleToolsExpandInput(ctx, data)) return true;
	if (readOnlyPromptArchive && handlePromptScrollInput(ctx, data, true)) {
		return true;
	}
	if (handleStageChatJumpToBottom(ctx, data)) return true;
	if (ctx.chatHost.handleScrollInput(data)) return true;
	if (matchesAction(keybindings, data, TUI_ACTION.altScreenSearch) && !isBlocked(ctx)) {
		openStageChatSearch(ctx);
		return true;
	}
	if (matchesKey(data, Key.escape)) {
		if (ctx.chatHost.isCompacting() || ctx.chatHost.isBashRunning() || ctx.chatHost.isEditingBashCommand()) {
			return ctx.chatHost.handleInput(data);
		}
		if (isAbortableStreamingSession(ctx)) {
			void ctx.chatHost.interrupt({ restoreQueuedMessages: true });
			return true;
		}
		ctx.onClose();
		return true;
	}
	if (matchesKey(data, Key.ctrl("c"))) {
		ctx.onClose();
		return true;
	}
	if (readOnlyArchive) return true;
	const blocked = isBlocked(ctx);
	if (matchesKey(data, Key.ctrl("f"))) {
		if (blocked) return true;
		// The mode travels with this submission and reaches the stage-chat prompt
		// command, so an idle-looking Ctrl+F stays a follow-up.
		void ctx.chatHost.submit("followUp");
		return true;
	}
	if (blocked) return true;
	return ctx.chatHost.handleInput(data);
}

/**
 * Input while the find box is open.
 *
 * Escape is the contended key: the ladder below this function maps it to
 * interrupt-the-stage or close-the-pane, and both are the wrong answer for a
 * reader who just wants the find box gone. It is answered here, first, and only
 * while a search is open — which is also why the literal key closes the search
 * even for a host that wired no keybindings manager or bound `searchClose`
 * elsewhere.
 *
 * Scrolling stays live underneath, matching the fullscreen surface: a reader
 * can page through the transcript without dismissing the box. Everything else
 * is query text.
 */
function handleStageChatSearchKeys(ctx: StageChatViewContext, data: string): boolean {
	const keybindings = isKeybindingsLike(ctx.piKeybindings) ? ctx.piKeybindings : undefined;
	if (matchesKey(data, Key.escape) || matchesAction(keybindings, data, TUI_ACTION.altScreenSearchClose)) {
		closeStageChatSearch(ctx);
		return true;
	}
	if (matchesKey(data, Key.ctrl("c"))) {
		closeStageChatSearch(ctx);
		ctx.onClose();
		return true;
	}
	if (matchesAction(keybindings, data, TUI_ACTION.altScreenSearchPrevious)) {
		navigateStageChatSearch(ctx, -1);
		return true;
	}
	// Enter advances even with no keybindings manager wired, so the box is
	// navigable on a host that supplies none.
	if (matchesAction(keybindings, data, TUI_ACTION.altScreenSearchNext) || matchesKey(data, Key.enter)) {
		navigateStageChatSearch(ctx, 1);
		return true;
	}
	if (matchesAction(keybindings, data, TUI_ACTION.altScreenSearch)) {
		ctx.requestRender?.();
		return true;
	}
	if (handleStageChatJumpToBottom(ctx, data)) return true;
	if (ctx.chatHost.handleScrollInput(data)) return true;
	typeIntoStageChatSearch(ctx, data);
	return true;
}

function handleStageChatJumpToBottom(ctx: StageChatViewContext, data: string): boolean {
	const keybindings = isKeybindingsLike(ctx.piKeybindings) ? ctx.piKeybindings : undefined;
	if (data !== TRANSCRIPT_JUMP_TO_END_URL && !matchesAction(keybindings, data, TUI_ACTION.altScreenBottom))
		return false;
	ctx.chatHost.scrollToBottom();
	return true;
}
function handleToolsExpandInput(ctx: StageChatViewContext, data: string): boolean {
	const keybindings = isKeybindingsLike(ctx.piKeybindings) ? ctx.piKeybindings : undefined;
	if (!matchesAction(keybindings, data, APP_ACTION.toolsExpand)) return false;
	const expanded = ctx.getToolsExpanded?.() === true;
	ctx.setToolsExpanded?.(!expanded);
	ctx.chatHost.invalidate();
	ctx.requestRender?.();
	return true;
}

function handleMountedCustomUiInput(ctx: StageChatViewContext, data: string): boolean {
	const mounted = ctx.mountedCustomUi;
	if (!mounted) return false;
	if (!canSubmitPrompt(ctx, mounted.request.id)) {
		ctx.requestRender?.();
		return true;
	}

	if (matchesKey(data, Key.ctrl("c"))) {
		// Close hides the overlay; the background run — and its pending human-input
		// request — keep living. Release the local display only.
		releaseMountedCustomUi(ctx);
		ctx.onClose();
		return true;
	}
	// Let scroll input reach the transcript so history stays scrollable while the
	// question is shown, matching the standalone ask_user_question tool.
	if (handleStageChatJumpToBottom(ctx, data)) {
		ctx.requestRender?.();
		return true;
	}
	if (ctx.chatHost.handleScrollInput(data)) {
		ctx.requestRender?.();
		return true;
	}

	const component = mounted.component;
	setComponentFocused(component, ctx.focused);
	const handled = component.handleInput?.(data) === true;
	ctx.requestRender?.();
	return handled;
}

function handlePromptInput(ctx: StageChatViewContext, data: string): void {
	const state = ctx.promptState;
	if (!state) return;
	if (ctx.promptEditor && ctx.promptEditorPromptId === state.prompt.id) {
		if (matchesKey(data, Key.ctrl("c"))) {
			resolvePromptResponse(ctx, state.prompt.id, defaultResponseFor(state.prompt), {
				suppressNextGraphSubmit: false,
			});
			return;
		}
		if (isPromptEscapeInput(data)) {
			ctx.requestRender?.();
			return;
		}
		setEditorFocused(ctx.promptEditor, ctx.focused);
		ctx.promptEditorSubmitFromEnter = matchesKey(data, Key.enter);
		try {
			ctx.promptEditor.handleInput(data);
		} finally {
			ctx.promptEditorSubmitFromEnter = false;
		}
		ctx.requestRender?.();
		return;
	}
	const keybindings = isKeybindingsLike(ctx.piKeybindings) ? ctx.piKeybindings : undefined;
	const action = handlePromptCardInput(data, state, keybindings);
	const prompt = state.prompt;
	if (prompt.kind === "input" || prompt.kind === "editor") {
		ctx.store.recordStagePromptDraft(ctx.runId, ctx.stageId, prompt.id, state.rawText);
	}
	if (action.kind === "noop") {
		ctx.requestRender?.();
		return;
	}
	const response = action.kind === "submit" ? action.response : defaultResponseFor(prompt);
	resolvePromptResponse(ctx, prompt.id, response, {
		suppressNextGraphSubmit: action.kind === "submit" && matchesKey(data, Key.enter),
	});
}

function handlePromptScrollInput(ctx: StageChatViewContext, data: string, includeKeyboard = true): boolean {
	const mouse = parseTerminalMouseInput(data);
	const wheelDirection = mouse ? terminalMouseWheelDirection(mouse) : null;
	const wheelStep = promptScrollStep(ctx, PROMPT_SCROLL_STEP_ROWS);
	const wheelDeltaRows = wheelDirection === "up" ? -wheelStep : wheelDirection === "down" ? wheelStep : 0;
	if (wheelDeltaRows !== 0) {
		scrollPromptBy(ctx, wheelDeltaRows);
		return true;
	}
	if (mouse) return true;
	if (!includeKeyboard) return false;
	if (matchesKey(data, "pageUp")) {
		scrollPromptBy(ctx, -promptScrollStep(ctx, promptPageSize(ctx)));
		return true;
	}
	if (matchesKey(data, "pageDown")) {
		scrollPromptBy(ctx, promptScrollStep(ctx, promptPageSize(ctx)));
		return true;
	}
	if (!ctx.promptEditor && matchesKey(data, "home")) {
		ctx.promptScrollOffset = 0;
		ctx.requestRender?.();
		return true;
	}
	if (!ctx.promptEditor && matchesKey(data, "end")) {
		ctx.promptScrollOffset = ctx.promptMaxScroll;
		ctx.requestRender?.();
		return true;
	}
	return false;
}

function promptScrollStep(ctx: StageChatViewContext, requestedRows: number): number {
	return Math.max(1, Math.min(requestedRows, Math.max(1, ctx.promptVisibleRows)));
}

function scrollPromptBy(ctx: StageChatViewContext, deltaRows: number): void {
	ctx.promptScrollOffset = Math.max(0, Math.min(ctx.promptMaxScroll, ctx.promptScrollOffset + deltaRows));
	ctx.requestRender?.();
}
