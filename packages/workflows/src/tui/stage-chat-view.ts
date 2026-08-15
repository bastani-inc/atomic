/**
 * StageChatView — attached workflow-stage chat surface.
 *
 * This file is the compatibility facade for the historical
 * `src/tui/stage-chat-view.js` import path. The implementation is split by
 * responsibility into sibling `stage-chat-view-*` modules so each authored
 * source file stays focused while preserving the
 * same public class, options, detach metadata, and test seams.
 *
 * Behaviour:
 *  - Idle stage (empty transcript, not streaming, not settled): Enter prompts.
 *  - Running live stages: Enter steers, Ctrl+F queues a follow-up, Escape uses
 *    the host chat interrupt path.
 *  - Paused stages: Enter resumes with composer text; Ctrl+X returns to graph.
 *  - Blocked and read-only archive stages absorb mutation keystrokes.
 *  - Workflow notices and prompt/custom UI panels keep workflow-specific chrome.
 *
 * cross-ref:
 *  - ui/stage-chat-mockup.html (canonical visual)
 *  - DESIGN.md §5 (Components — pill / box / banner vocabulary)
 *  - src/runs/foreground/stage-control-registry.ts (StageControlHandle)
 *  - src/shared/store-types.ts (StageSnapshot.notices, StageNotice)
 *  - https://pi.dev/docs/latest/tui (canonical Pi-tui component contract)
 */

import { keyText, TranscriptFollowIndicator } from "@bastani/atomic";
import type { Component, Focusable } from "@earendil-works/pi-tui";
import { fitStageChatFrame, planStageChatFrame } from "./stage-chat-layout.js";
import {
	closeStageChatSearch,
	highlightStageChatSearchRows,
	refreshStageChatSearch,
	renderStageChatSearchBar,
	STAGE_CHAT_SEARCH_ROWS,
} from "./stage-chat-search.js";
import {
	renderBlockedBody,
	renderPausedBody,
	renderPromptBody,
	renderReadOnlyArchiveBody,
} from "./stage-chat-view-archive-history.js";
import { renderCustomUi } from "./stage-chat-view-custom-ui.js";
import {
	renderFooterWithOrchestratorReturnHint,
	renderHeader,
	renderReadOnlyArchiveFooter,
	sepRule,
} from "./stage-chat-view-footer-status.js";
import { handleStageChatInput } from "./stage-chat-view-input.js";
import { blankLine, takeRows } from "./stage-chat-view-render-helpers.js";
import {
	currentStage,
	disposeStageChatView,
	initializeStageChatView,
	invalidateStageChatView,
	isBlocked,
	isPaused,
	isReadOnlyArchive,
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
	private search!: StageChatViewContext["search"];
	private promptEditor!: StageChatViewContext["promptEditor"];
	private promptEditorPromptId!: StageChatViewContext["promptEditorPromptId"];
	private promptEditorSubmitFromEnter!: StageChatViewContext["promptEditorSubmitFromEnter"];
	private promptScrollOffset!: StageChatViewContext["promptScrollOffset"];
	private promptMaxScroll!: StageChatViewContext["promptMaxScroll"];
	private promptVisibleRows!: StageChatViewContext["promptVisibleRows"];
	private localPaused!: StageChatViewContext["localPaused"];
	private seenNoticeIds!: StageChatViewContext["seenNoticeIds"];
	private _unsubscribeStore!: StageChatViewContext["_unsubscribeStore"];
	private _unsubscribeHandle!: StageChatViewContext["_unsubscribeHandle"];
	private _unsubscribeFooterData!: StageChatViewContext["_unsubscribeFooterData"];
	private _unregisterStageUiHost!: StageChatViewContext["_unregisterStageUiHost"];

	constructor(opts: StageChatViewOpts) {
		initializeStageChatView(this._ctx(), opts);
	}

	render(width: number): string[] {
		const ctx = this._ctx();
		const w = Math.max(40, width);
		const stage = currentStage(ctx);
		const blocked = isBlocked(ctx);

		const customUiActive = this.mountedCustomUi !== null;
		syncPromptState(ctx, stage?.pendingPrompt);
		const promptActive = !customUiActive && this.promptState !== null;
		const readOnlyArchive = isReadOnlyArchive(ctx, stage);
		const chatChromeHidden = customUiActive || promptActive || readOnlyArchive || blocked;

		// Whatever swaps the transcript out of the body takes the find box with
		// it. A bar left painted over a body it cannot search is the one state
		// where Escape has two plausible meanings, and the reader would have to
		// guess which one this frame means.
		if (chatChromeHidden) closeStageChatSearch(ctx);
		// The find box owns the caret while it is open, so the composer paints
		// unfocused and only one component emits a cursor.
		const searchActive = this.search !== null;
		this.chatHost.focused = this.focused && !searchActive;
		const headerLines = renderHeader(ctx, w, stage);
		const sepLines = [sepRule(ctx, w)];

		const customUiLines = customUiActive ? renderCustomUi(ctx, w) : [];
		const pendingLines = chatChromeHidden ? [] : this.chatHost.renderPendingMessages(w);
		const workingLines = chatChromeHidden ? [] : this.chatHost.renderWorkingStatus(w);
		const usageLines = chatChromeHidden ? [] : this.chatHost.renderUsage(w);
		const editorLines = chatChromeHidden ? [] : this.chatHost.renderEditor(w);
		const footerLines =
			customUiActive || promptActive
				? []
				: readOnlyArchive
					? renderReadOnlyArchiveFooter(ctx, w)
					: renderFooterWithOrchestratorReturnHint(ctx, w, this.chatHost.renderFooter(w));

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
			searchRows: searchActive ? STAGE_CHAT_SEARCH_ROWS : 0,
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
		let transcriptBodyActive = false;
		let reservedIndicatorLines: readonly string[] = [];
		const indicator = new TranscriptFollowIndicator({
			isFollowing: () => this.chatHost.bodyScrollFromBottom() === 0,
			keyLabel: () => keyText("tui.altScreen.bottom"),
		});
		if (bodyBudget <= 0) {
			bodyLines = [];
		} else if (promptActive) {
			bodyLines = renderPromptBody(ctx, w, bodyBudget);
		} else if (blocked) {
			bodyLines = renderBlockedBody(ctx, w, bodyBudget, stage);
		} else if (!readOnlyArchive && isPaused(ctx, stage)) {
			reservedIndicatorLines = bodyBudget > 1 ? indicator.render(w) : [];
			bodyLines = renderPausedBody(ctx, w, bodyBudget, reservedIndicatorLines, () => indicator.render(w));
		} else if (readOnlyArchive) {
			reservedIndicatorLines = bodyBudget > 1 ? indicator.render(w) : [];
			bodyLines = renderReadOnlyArchiveBody(ctx, w, bodyBudget, stage, reservedIndicatorLines, () =>
				indicator.render(w),
			);
		} else {
			transcriptBodyActive = true;
			// Match before painting: the search reads every row of the transcript
			// and may scroll the body to reveal one the window does not hold.
			refreshStageChatSearch(ctx, w, bodyBudget);
			bodyLines = this.chatHost.renderBody(w, bodyBudget);
			bodyLines = highlightStageChatSearchRows(
				ctx,
				bodyLines,
				Math.max(0, this.chatHost.bodyMaxScroll() - this.chatHost.bodyScrollFromBottom()),
			);
		}
		const indicatorLines = transcriptBodyActive && bodyBudget > 1 ? indicator.render(w) : [];
		const indicatorVisible = indicatorLines.length > 0;
		const dropBodyRow = transcriptBodyActive && indicatorVisible && bodyLines.length >= bodyBudget;
		// The indicator's row comes out of the body, and the end it comes from
		// decides which rows the reader can reach at all. Taken off the top, the
		// first transcript row is unpaintable: the reader is already parked as
		// high as the viewport goes and the row is still clipped, so a search
		// that reveals a match there counts it and shows the row under it. A body
		// already parked at row zero therefore gives up its last row instead.
		// Either way the body is rendered at the full budget, which is what keeps
		// the viewport size — and the page arithmetic that reads it — stable
		// while the indicator is visible.
		const parkedAtTop = this.chatHost.bodyMaxScroll() - this.chatHost.bodyScrollFromBottom() <= 0;
		const visibleBodyLines = dropBodyRow
			? parkedAtTop
				? bodyLines.slice(0, bodyBudget - 1)
				: bodyLines.slice(1, bodyBudget)
			: bodyLines.slice(0, bodyBudget);

		const searchLines = searchActive ? renderStageChatSearchBar(ctx, w).slice(0, plan.searchRows) : [];
		const lines = [
			...headerLines,
			...sepLines,
			...visibleBodyLines,
			...indicatorLines,
			...searchLines,
			...visiblePendingLines,
			...visibleWorkingLines,
			...visibleUsageLines,
			...visibleEditorLines,
			...visibleFooterLines,
		];
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
