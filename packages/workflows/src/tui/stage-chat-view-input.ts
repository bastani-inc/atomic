import { isNavHelpKey, TRANSCRIPT_JUMP_TO_END_URL } from "@bastani/atomic";
import { getKeybindings, isHintActivation } from "@bastani/atomic-tui";
import {
	coercePrimitivePromptAnswer,
	isPrimitivePrompt,
	primitivePromptAnswerExpectation,
} from "../shared/prompt-answer.js";
import { isWorkflowPromptStage } from "../shared/stage-prompt.js";

import { APP_ACTION, isKeybindingsLike, matchesAction, matchesNavAction, TUI_ACTION } from "./keybindings-adapter.js";
import { parseTerminalMouseInput, terminalMouseWheelDirection } from "./mouse-input.js";
import { defaultResponseFor, handlePromptCardInput, isPromptEscapeInput } from "./prompt-card.js";
import { releaseMountedCustomUi } from "./stage-chat-view-custom-ui.js";
import { hasStageChatTasks, stackedStageDialogOpen } from "./stage-chat-view-footer-status.js";
import { setComponentFocused, setEditorFocused } from "./stage-chat-view-render-helpers.js";
import {
	canSubmitPrompt,
	currentStage,
	isAbortableStreamingSession,
	isBlocked,
	isReadOnlyArchive,
	promptCardShown,
	promptPageSize,
	recordCurrentPromptDraft,
	recordStageEscapeInterrupt,
	resolvePromptResponse,
	syncPromptState,
} from "./stage-chat-view-state.js";
import { PROMPT_SCROLL_STEP_ROWS, type StageChatViewContext } from "./stage-chat-view-types.js";
import { Key, matchesKey } from "./text-helpers.js";

export function handleStageChatInput(ctx: StageChatViewContext, data: string): boolean {
	// Task inspection is modal: neither parent transcript scrolling nor the
	// stage composer may receive input hidden behind the inspector. The thinking
	// and tool-output toggles stay the stage's, so a task transcript follows them.
	if (ctx.chatHost.hasTaskInspector) {
		if (matchesKey(data, Key.ctrl("c"))) ctx.chatHost.closeTasks();
		else if (!handleToolsExpandInput(ctx, data) && !ctx.chatHost.handleTaskInput(data))
			return !isHostThinkingToggle(ctx, data);
		return true;
	}
	if (data === TRANSCRIPT_JUMP_TO_END_URL) return handleStageChatJumpToBottom(ctx, data);
	if (ctx.helpOpen) {
		const keybindings = isKeybindingsLike(ctx.piKeybindings) ? ctx.piKeybindings : getKeybindings();
		if (matchesKey(data, Key.escape) || isNavHelpKey(keybindings, data)) {
			ctx.helpOpen = false;
			ctx.requestRender?.();
		}
		return true;
	}
	if (isHostThinkingToggle(ctx, data)) return false;
	const stage = currentStage(ctx);
	if (ctx.mountedCustomUi && stage?.pendingPrompt?.source !== "stage-dialog") {
		return handleMountedCustomUiInput(ctx, data);
	}
	syncPromptState(ctx, stage?.pendingPrompt);
	const readOnlyArchive = isReadOnlyArchive(ctx, stage);
	const readOnlyPromptArchive = readOnlyArchive && isWorkflowPromptStage(stage);

	if (ctx.promptState && promptCardShown(ctx)) {
		if (ctx.mountedCustomUi && ctx.promptState.prompt.source === "stage-dialog" && matchesKey(data, Key.escape)) {
			resolvePromptResponse(
				ctx,
				ctx.promptState.prompt.id,
				ctx.promptState.prompt.kind === "confirm" ? false : undefined,
			);
			return true;
		}
		if (isClosableQuestion(ctx.promptState.prompt.kind) && matchesKey(data, Key.escape)) {
			ctx.dismissedPromptId = ctx.promptState.prompt.id;
			return true;
		}
		if (isPromptBackInput(ctx, data)) {
			recordCurrentPromptDraft(ctx);
			ctx.onDetach();
			return true;
		}
		if (handlePromptScrollInput(ctx, data, ctx.promptEditor === null)) return true;
		handlePromptInput(ctx, data);
		return true;
	}
	if (!readOnlyArchive && !isBlocked(ctx) && ctx.chatHost.hasTransientModal) {
		return ctx.chatHost.handleInput(data);
	}
	if (ctx.promptState && !promptCardShown(ctx) && matchesKey(data, Key.enter)) {
		if (!ctx.chatHost.hasInputText()) {
			ctx.dismissedPromptId = null;
			return true;
		}
		const trimmed = ctx.chatHost.inputText().trim();
		if (trimmed.length === 0) {
			ctx.chatHost.setInputText("");
			ctx.dismissedPromptId = null;
			return true;
		}
		const prompt = ctx.promptState.prompt;
		if (isPrimitivePrompt(prompt)) {
			const coerced = coercePrimitivePromptAnswer(prompt, trimmed);
			if (!coerced.ok) {
				ctx.chatHost.showWarning(primitivePromptAnswerExpectation(prompt));
				return true;
			}
			ctx.chatHost.showWarning("");
			ctx.chatHost.setInputText("");
			ctx.dismissedPromptId = null;
			resolvePromptResponse(ctx, prompt.id, coerced.value, { suppressNextGraphSubmit: true });
			return true;
		}
		ctx.chatHost.showWarning("");
		ctx.chatHost.setInputText("");
		ctx.dismissedPromptId = null;
		resolvePromptResponse(ctx, prompt.id, trimmed, { suppressNextGraphSubmit: true });
		return true;
	}
	if (ctx.mountedCustomUi) {
		return handleMountedCustomUiInput(ctx, data);
	}
	if (matchesKey(data, Key.escape)) {
		if (ctx.chatHost.isCompacting() || ctx.chatHost.isBashRunning() || ctx.chatHost.isEditingBashCommand()) {
			return ctx.chatHost.handleInput(data);
		}
		if (isAbortableStreamingSession(ctx)) {
			recordStageEscapeInterrupt(ctx);
		}
		return true;
	}
	if (handleToolsExpandInput(ctx, data)) return true;
	if (readOnlyPromptArchive && handlePromptScrollInput(ctx, data, true)) {
		return true;
	}
	if (handleStageChatJumpToBottom(ctx, data)) return true;
	if (ctx.chatHost.handleScrollInput(data)) return true;
	if (isBackToGraphInput(ctx, data)) {
		recordCurrentPromptDraft(ctx);
		ctx.onDetach();
		return true;
	}
	const keybindings = isKeybindingsLike(ctx.piKeybindings) ? ctx.piKeybindings : getKeybindings();
	if (
		!readOnlyArchive &&
		!isBlocked(ctx) &&
		(!ctx.chatHost.hasInputText() || isHintActivation()) &&
		hasStageChatTasks(ctx) &&
		matchesAction(keybindings, data, "app.agents.focus")
	) {
		ctx.chatHost.openTasks();
		return true;
	}
	if (
		!readOnlyArchive &&
		!isBlocked(ctx) &&
		isNavHelpKey(keybindings, data) &&
		(!ctx.chatHost.hasInputText() || isHintActivation())
	) {
		ctx.helpOpen = true;
		ctx.requestRender?.();
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

function isBackToGraphInput(ctx: StageChatViewContext, data: string): boolean {
	if (matchesKey(data, Key.escape)) return false;
	const keybindings = isKeybindingsLike(ctx.piKeybindings) ? ctx.piKeybindings : undefined;
	// At the start of a typed prompt, ← leaves too; the draft stays for the return.
	return (
		matchesNavAction(keybindings, data, APP_ACTION.navBack) &&
		(ctx.chatHost.inputCursorAtStart() || isHintActivation())
	);
}

function isClosableQuestion(kind: string): boolean {
	return kind !== "input" && kind !== "editor";
}

function isPromptBackInput(ctx: StageChatViewContext, data: string): boolean {
	const state = ctx.promptState;
	if (!state || matchesKey(data, Key.escape) || stackedStageDialogOpen(ctx)) return false;
	const keybindings = isKeybindingsLike(ctx.piKeybindings) ? ctx.piKeybindings : undefined;
	const isNavBack = matchesNavAction(keybindings, data, APP_ACTION.navBack) || matchesKey(data, Key.left);
	const isBackspace = matchesKey(data, Key.backspace);
	if (!isNavBack && !isBackspace) return false;
	if (isClosableQuestion(state.prompt.kind)) return true;
	if (ctx.promptEditor && ctx.promptEditorPromptId === state.prompt.id) {
		const text = ctx.promptEditor.getText();
		if (text.length === 0) return true;
		if (isBackspace) return false;
		const cursor = (ctx.promptEditor as { getCursor?(): { line: number; col: number } }).getCursor?.();
		return cursor?.line === 0 && cursor.col === 0;
	}
	if (state.rawText.length === 0) return true;
	return !isBackspace && state.caret === 0;
}

function isCustomUiBackInput(ctx: StageChatViewContext, data: string): boolean {
	if (matchesKey(data, Key.escape)) return false;
	const keybindings = isKeybindingsLike(ctx.piKeybindings) ? ctx.piKeybindings : undefined;
	return (
		matchesNavAction(keybindings, data, APP_ACTION.navBack) ||
		matchesKey(data, Key.left) ||
		matchesKey(data, Key.backspace)
	);
}

/** Only the default physical Ctrl+T belongs to the host thinking action; a remap may reuse an editor key. */
function isHostThinkingToggle(ctx: StageChatViewContext, data: string): boolean {
	const keybindings = isKeybindingsLike(ctx.piKeybindings) ? ctx.piKeybindings : undefined;
	return matchesKey(data, Key.ctrl("t")) && matchesAction(keybindings, data, APP_ACTION.thinkingToggle);
}

function handleStageChatJumpToBottom(ctx: StageChatViewContext, data: string): boolean {
	const keybindings = isKeybindingsLike(ctx.piKeybindings) ? ctx.piKeybindings : undefined;
	if (data !== TRANSCRIPT_JUMP_TO_END_URL && !matchesAction(keybindings, data, TUI_ACTION.altScreenBottom))
		return false;
	ctx.chatHost.scrollToBottom();
	return true;
}
function handleToolsExpandInput(ctx: StageChatViewContext, data: string): boolean {
	if (!ctx.setToolsExpanded) return false;
	const keybindings = isKeybindingsLike(ctx.piKeybindings) ? ctx.piKeybindings : getKeybindings();
	if (!matchesAction(keybindings, data, APP_ACTION.toolsExpand)) return false;
	const expanded = ctx.getToolsExpanded?.() === true;
	ctx.setToolsExpanded(!expanded);
	ctx.chatHost.toolOutputToggled();
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
	if (component.capturesBack !== undefined && isCustomUiBackInput(ctx, data) && component.capturesBack() !== true) {
		recordCurrentPromptDraft(ctx);
		ctx.onDetach();
		return true;
	}
	const handled = component.handleInput?.(data) === true;
	if (!handled && isCustomUiBackInput(ctx, data)) {
		recordCurrentPromptDraft(ctx);
		ctx.onDetach();
		return true;
	}
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
