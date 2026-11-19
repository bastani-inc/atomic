/**
 * StageChatView — attached workflow-stage chat surface.
 *
 * Rendering, input, and lifecycle helpers live in sibling `stage-chat-view-*` modules.
 *
 * Behaviour:
 *  - Idle stage (empty transcript, not streaming, not settled): Enter prompts.
 *  - Running live stages: Enter steers, Ctrl+F queues a follow-up, Escape uses
 *    the host chat interrupt path.
 *  - Paused stages: Enter resumes with composer text; ← on an empty prompt returns to graph.
 *  - Blocked and read-only archive stages absorb mutation keystrokes.
 *  - Workflow notices and prompt/custom UI panels keep workflow-specific chrome.
 *
 * cross-ref:
 *  - DESIGN.md §5 (Components — pill / box / banner vocabulary)
 *  - src/runs/foreground/stage-control-registry.ts (StageControlHandle)
 *  - src/shared/store-types.ts (StageSnapshot.notices, StageNotice)
 *  - packages/coding-agent/docs/tui.md (the @bastani/atomic-tui component contract)
 */

import { clickableHintText, repaintAfterSingleClick } from "@bastani/atomic";
import type { Component, Focusable, TuiMouseEvent, TuiMouseEventResult } from "@bastani/atomic-tui";
import { fitStageChatFrame, planStageChatFrame } from "./stage-chat-layout.js";
import {
	renderBlockedBody,
	renderPausedBody,
	renderPromptBody,
	renderReadOnlyArchiveBody,
	renderStartingBody,
} from "./stage-chat-view-archive-history.js";
import { renderCustomUi } from "./stage-chat-view-custom-ui.js";
import {
	injectStageLabelIntoEditorTopRule,
	renderFooterWithOrchestratorReturnHint,
	renderHeader,
	renderReadOnlyArchiveFooter,
	renderStageChatKeyOverlay,
	sepRule,
} from "./stage-chat-view-footer-status.js";
import { handleStageChatInput } from "./stage-chat-view-input.js";
import { blankLine, paint, setComponentFocused, takeRows } from "./stage-chat-view-render-helpers.js";
import {
	currentStage,
	disposeStageChatView,
	initializeStageChatView,
	invalidateStageChatView,
	isBlocked,
	isPaused,
	isReadOnlyArchive,
	pooledStageWaitingNotice,
	promptCardShown,
	publishedStageChatActivity,
	syncPromptState,
	viewLineCount,
} from "./stage-chat-view-state.js";
import { transcriptDebugEntries } from "./stage-chat-view-transcript.js";
import {
	SEP_ROWS,
	type StageChatViewContext,
	type StageChatViewOpts,
	type TranscriptDebugEntry,
} from "./stage-chat-view-types.js";
import { truncateToWidth } from "./text-helpers.js";

export type {
	StageChatDetachMetadata,
	StageChatDetachReason,
	StageChatViewOpts,
} from "./stage-chat-view-types.js";

export class StageChatView implements Component, Focusable {
	focused = true;
	private store!: StageChatViewContext["store"];
	private theme!: StageChatViewContext["theme"];
	private runId!: StageChatViewContext["runId"];
	private stageId!: StageChatViewContext["stageId"];
	private workflowName!: StageChatViewContext["workflowName"];
	private handle!: StageChatViewContext["handle"];
	private postMortemUnavailableReason!: StageChatViewContext["postMortemUnavailableReason"];
	private onDetach!: StageChatViewContext["onDetach"];
	private onClose!: StageChatViewContext["onClose"];
	private requestRender!: StageChatViewContext["requestRender"];
	private requestFocus!: StageChatViewContext["requestFocus"];
	private focusHoldTimer!: StageChatViewContext["focusHoldTimer"];
	private piTui!: StageChatViewContext["piTui"];
	private piTheme!: StageChatViewContext["piTheme"];
	private piKeybindings!: StageChatViewContext["piKeybindings"];
	private piEditorFactory!: StageChatViewContext["piEditorFactory"];
	private getToolsExpanded!: StageChatViewContext["getToolsExpanded"];
	private setToolsExpanded!: StageChatViewContext["setToolsExpanded"];
	private footerData!: StageChatViewContext["footerData"];
	private chatHost!: StageChatViewContext["chatHost"];
	private stageUiBroker!: StageChatViewContext["stageUiBroker"];
	private canSubmitPrompt!: StageChatViewContext["canSubmitPrompt"];
	private mountedCustomUi!: StageChatViewContext["mountedCustomUi"];
	private mountingRequestId!: StageChatViewContext["mountingRequestId"];
	private promptState!: StageChatViewContext["promptState"];
	private dismissedPromptId!: StageChatViewContext["dismissedPromptId"];
	private promptEditor!: StageChatViewContext["promptEditor"];
	private promptEditorPromptId!: StageChatViewContext["promptEditorPromptId"];
	private promptEditorSubmitFromEnter!: StageChatViewContext["promptEditorSubmitFromEnter"];
	private promptScrollOffset!: StageChatViewContext["promptScrollOffset"];
	private promptMaxScroll!: StageChatViewContext["promptMaxScroll"];
	private promptVisibleRows!: StageChatViewContext["promptVisibleRows"];
	private helpOpen!: StageChatViewContext["helpOpen"];
	private interruptedByEscape!: StageChatViewContext["interruptedByEscape"];
	private localPaused!: StageChatViewContext["localPaused"];
	private seenNoticeIds!: StageChatViewContext["seenNoticeIds"];
	private _unsubscribeStore!: StageChatViewContext["_unsubscribeStore"];
	private _unsubscribeHandle!: StageChatViewContext["_unsubscribeHandle"];
	private _unsubscribeFooterData!: StageChatViewContext["_unsubscribeFooterData"];
	private _unregisterStageUiHost!: StageChatViewContext["_unregisterStageUiHost"];

	/** The frame rows the stage's transcript took in the last render, while the plain chat was drawn. */
	private transcriptRows: { readonly top: number; readonly rows: number } | undefined;

	constructor(opts: StageChatViewOpts) {
		initializeStageChatView(this._ctx(), opts);
	}

	/** A single click on any row of a block in the stage's transcript expands or collapses that block. */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const region = this.transcriptRows;
		if (region === undefined || event.y < region.top || event.y >= region.top + region.rows) return undefined;
		// While a dialog the stage opened, its question or the key help owns input, a click on the transcript does nothing.
		if (this.mountedCustomUi !== null || promptCardShown(this._ctx()) || this.helpOpen) return undefined;
		const result = this.chatHost.handleBodyClick({ ...event, y: event.y - region.top });
		return repaintAfterSingleClick(result, () => this.requestRender?.());
	}

	/** What the last frame drew on `row` of the transcript: the entry there and the row within it. */
	paintedRowKey(row: number): string | undefined {
		const region = this.transcriptRows;
		if (region === undefined || row < region.top || row >= region.top + region.rows) return undefined;
		return this.chatHost.bodyRowKey(row - region.top);
	}

	render(width: number): string[] {
		const ctx = this._ctx();
		this.transcriptRows = undefined;
		if (this.chatHost.hasTaskInspector) {
			const taskWidth = Math.max(1, width);
			const rows = viewLineCount(ctx);
			const footer = this.chatHost.taskInspectorFullscreen ? [] : this.chatHost.renderFooter(taskWidth);
			const visibleFooter = footer.slice(0, Math.max(0, rows - 1));
			const body = this.chatHost.renderBody(taskWidth, rows - visibleFooter.length);
			// The chat's body, with the task list or a task's transcript it shows, starts at the top row.
			this.transcriptRows = { top: 0, rows: body.length };
			return fitStageChatFrame([...body, ...visibleFooter], rows, blankLine(taskWidth));
		}
		const w = Math.max(40, width);
		const stage = currentStage(ctx);
		const blocked = isBlocked(ctx);

		syncPromptState(ctx, stage?.pendingPrompt);
		const promptActive =
			promptCardShown(ctx) && (this.mountedCustomUi === null || this.promptState?.prompt.source === "stage-dialog");
		const customUiActive = this.mountedCustomUi !== null && !promptActive;
		if (this.mountedCustomUi) setComponentFocused(this.mountedCustomUi.component, this.focused && customUiActive);
		const readOnlyArchive = isReadOnlyArchive(ctx, stage);
		const chatChromeHidden = customUiActive || promptActive || readOnlyArchive || blocked;
		this.chatHost.focused = this.focused;
		const headerLines = renderHeader(ctx, w, stage);
		const sepLines = [sepRule(ctx, w)];
		if (this.helpOpen) {
			const totalRows = viewLineCount(ctx);
			return fitStageChatFrame(
				[...headerLines, ...sepLines, ...renderStageChatKeyOverlay(ctx, w)],
				totalRows,
				blankLine(w),
			);
		}

		const customUiLines = customUiActive ? renderCustomUi(ctx, w) : [];
		// A question closed with Esc waits above the chat's prompt until Enter reopens it.
		const closedQuestion =
			!chatChromeHidden && this.promptState !== null && this.promptState.prompt.id === this.dismissedPromptId
				? [
						truncateToWidth(
							` ${paint("◆", ctx.theme.warning)} ${paint(`${this.promptState.prompt.message} · ${clickableHintText("enter to answer")}`, ctx.theme.textMuted)}`,
							w,
						),
					]
				: [];
		const pendingLines = chatChromeHidden ? [] : [...closedQuestion, ...this.chatHost.renderPendingMessages(w)];
		const workingLines = chatChromeHidden
			? []
			: this.chatHost.renderWorkingStatus(w, publishedStageChatActivity(ctx, stage));
		const usageLines = chatChromeHidden ? [] : this.chatHost.renderUsageRow(w);
		const editorLines = chatChromeHidden
			? []
			: injectStageLabelIntoEditorTopRule(
					ctx,
					currentStage(ctx)?.name,
					this.chatHost.renderEditor(w),
					currentStage(ctx),
				);
		const footerLines = customUiActive
			? []
			: promptActive
				? this.chatHost.renderTaskFooter(w)
				: readOnlyArchive
					? renderReadOnlyArchiveFooter(ctx, w)
					: renderFooterWithOrchestratorReturnHint(ctx, w, this.chatHost.renderFooter(w, true));

		const totalRows = viewLineCount(ctx);
		const plan = planStageChatFrame({
			viewportRows: totalRows,
			headerRows: headerLines.length,
			separatorRows: SEP_ROWS,
			pendingRows: pendingLines.length,
			workingRows: workingLines.length,
			usageRows: usageLines.length,
			editorRows: customUiActive ? customUiLines.length : editorLines.length,
			footerRows: footerLines.length,
		});
		const visiblePendingLines = takeRows(pendingLines, plan.pendingRows);
		const visibleWorkingLines = workingLines.slice(Math.max(0, workingLines.length - plan.workingRows));
		const visibleUsageLines = takeRows(usageLines, plan.usageRows);
		const editorSlotLines = customUiActive ? customUiLines : editorLines;
		const visibleEditorLines = takeRows(editorSlotLines, plan.editorRows);
		const visibleFooterLines = takeRows(footerLines, plan.footerRows);
		const bodyBudget = plan.bodyRows;
		if (blocked) this.chatHost.scrollToBottom();

		let bodyLines: string[];
		// Every body that shows the transcript draws it from the body's first row; this records how many rows it took.
		let transcriptLines: number | undefined;
		const renderTranscript = (rows: number): string[] => {
			const lines = this.chatHost.renderBody(w, rows);
			transcriptLines = lines.length;
			return lines;
		};
		const waitingNotice = pooledStageWaitingNotice(ctx, stage);
		if (bodyBudget <= 0) {
			bodyLines = [];
		} else if (promptActive) {
			bodyLines = renderPromptBody(ctx, w, bodyBudget);
		} else if (blocked) {
			bodyLines = renderBlockedBody(ctx, w, bodyBudget, stage);
		} else if (!readOnlyArchive && isPaused(ctx, stage) && !this.interruptedByEscape) {
			bodyLines = renderPausedBody(ctx, w, bodyBudget, renderTranscript);
		} else if (waitingNotice !== undefined) {
			bodyLines = renderStartingBody(ctx, w, bodyBudget, waitingNotice, renderTranscript);
		} else if (readOnlyArchive) {
			bodyLines = renderReadOnlyArchiveBody(ctx, w, bodyBudget, stage, renderTranscript);
		} else {
			bodyLines = renderTranscript(bodyBudget);
		}
		if (transcriptLines !== undefined) {
			this.transcriptRows = {
				top: headerLines.length + sepLines.length,
				rows: Math.min(transcriptLines, bodyBudget),
			};
		}
		const visibleBodyLines = bodyLines.slice(0, bodyBudget);
		const lines = [
			...headerLines,
			...sepLines,
			...visibleBodyLines,
			...visiblePendingLines,
			...visibleWorkingLines,
			...visibleUsageLines,
			...visibleEditorLines,
			...visibleFooterLines,
		];
		// A frame taller than the view loses rows from its top, and the transcript rows with them.
		if (lines.length > totalRows) this.transcriptRows = undefined;
		return fitStageChatFrame(lines, totalRows, blankLine(w));
	}

	handleInput(data: string): boolean {
		return handleStageChatInput(this._ctx(), data);
	}

	invalidate(): void {
		invalidateStageChatView(this._ctx());
	}

	dispose(): void {
		disposeStageChatView(this._ctx());
	}

	private _ctx(): StageChatViewContext {
		// Helper modules operate on the same runtime object; these reads keep the
		// private fields visible to noUnusedLocals while preserving the historical
		// non-public TypeScript surface of StageChatView.
		void this.store;
		void this.theme;
		void this.runId;
		void this.stageId;
		void this.workflowName;
		void this.handle;
		void this.postMortemUnavailableReason;
		void this.onDetach;
		void this.onClose;
		void this.requestRender;
		void this.requestFocus;
		void this.focusHoldTimer;
		void this.piTui;
		void this.piTheme;
		void this.piKeybindings;
		void this.piEditorFactory;
		void this.getToolsExpanded;
		void this.setToolsExpanded;
		void this.footerData;
		void this.stageUiBroker;
		void this.canSubmitPrompt;
		void this.mountingRequestId;
		void this.promptEditor;
		void this.promptEditorPromptId;
		void this.promptEditorSubmitFromEnter;
		void this.promptScrollOffset;
		void this.promptMaxScroll;
		void this.promptVisibleRows;
		void this.helpOpen;
		void this.interruptedByEscape;
		void this.seenNoticeIds;
		void this._unsubscribeStore;
		void this._unsubscribeHandle;
		void this._unsubscribeFooterData;
		void this._unregisterStageUiHost;
		return this as unknown as StageChatViewContext;
	}

	get _inputBuffer(): string {
		return this.chatHost.inputText();
	}

	get _transcript(): ReadonlyArray<TranscriptDebugEntry> {
		return this.chatHost.entries().flatMap((entry) => transcriptDebugEntries(entry));
	}

	get _taskDiagnostics(): { taskIds: string[]; emptyCompletionComponents: number } {
		return {
			taskIds: this.chatHost.entries().flatMap((entry) => (entry.kind === "task" ? [entry.task.ref.taskId] : [])),
			emptyCompletionComponents: this.chatHost
				.entries()
				.filter((entry) => entry.kind === "custom" && entry.message.customType === "task-completion").length,
		};
	}
	get _statusMessage(): string {
		return this.chatHost.statusText();
	}

	get _isLocalPaused(): boolean {
		return this.localPaused;
	}

	get _hasAnimationTick(): boolean {
		return this.chatHost.hasAnimationTick();
	}

	get _bodyScrollFromBottom(): number {
		return this.chatHost.bodyScrollFromBottom();
	}

	get _lastBodyMaxScroll(): number {
		return this.chatHost.bodyMaxScroll();
	}
}
