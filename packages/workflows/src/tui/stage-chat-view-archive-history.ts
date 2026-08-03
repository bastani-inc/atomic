import { Box, Text } from "@earendil-works/pi-tui";
import type { PendingPrompt, StageSnapshot } from "../shared/store-types.js";
import { renderRoundedBoxLines } from "./chat-surface.js";
import { hexToAnsi, RESET } from "./color-utils.js";
import {
	type PromptCardLayout,
	renderPromptCardLayout,
	renderPromptIdentityBanner,
	renderPromptRunIdBanner,
} from "./prompt-card-render.js";
import { bannerLines, embedOrchestratorReturnHintInWidget } from "./stage-chat-view-footer-status.js";
import {
	blankLine,
	paint,
	renderHintsForPrompt,
	setEditorBorderColor,
	setEditorFocused,
} from "./stage-chat-view-render-helpers.js";
import type { StageChatViewContext } from "./stage-chat-view-types.js";

function postMortemUnavailableMessage(reason: StageChatViewContext["postMortemUnavailableReason"]): string | undefined {
	switch (reason) {
		case "no_adapter":
			return "Post-mortem chat is unavailable because no agent session adapter is configured.";
		case "not_terminal":
			return "Post-mortem chat is available only after the stage completes.";
		case "no_session":
			return "No retained agent session is available for this stage.";
		case "invalid_session":
			return "The retained session is missing, unreadable, or invalid. Check that the session file still exists and is readable.";
		case undefined:
			return undefined;
	}
}

export function renderReadOnlyArchiveBody(
	ctx: StageChatViewContext,
	width: number,
	budget: number,
	stage: StageSnapshot | undefined,
): string[] {
	if (stage?.promptFootprint) {
		return renderReadOnlyPromptArchiveBody(ctx, width, budget, stage);
	}

	const t = ctx.theme;
	const unavailableMessage = postMortemUnavailableMessage(ctx.postMortemUnavailableReason);
	const callout: string[] = [];
	callout.push(blankLine(width));
	callout.push(
		...bannerLines(
			ctx,
			width,
			unavailableMessage === undefined ? "info" : "warning",
			unavailableMessage === undefined ? "◌" : "!",
			unavailableMessage === undefined ? "READ-ONLY SESSION" : "SESSION UNAVAILABLE",
			unavailableMessage === undefined
				? stage?.sessionFile
					? "archived transcript"
					: "no live chat session"
				: "post-mortem chat cannot be reopened",
		),
	);
	callout.push(
		...new Text(
			paint(unavailableMessage ?? "This node is no longer attached to a live chat session.", t.textMuted),
			2,
			0,
		).render(width),
	);
	const transcriptBudget = Math.max(0, budget - callout.length);
	const lines = transcriptBudget > 0 ? ctx.chatHost.renderBody(width, transcriptBudget) : [];
	lines.push(...callout);
	while (lines.length < budget) lines.push(blankLine(width));
	if (lines.length > budget) lines.length = budget;
	return lines;
}

function renderReadOnlyPromptArchiveBody(
	ctx: StageChatViewContext,
	width: number,
	budget: number,
	stage: StageSnapshot,
): string[] {
	const t = ctx.theme;
	const prompt = stage.promptFootprint;
	if (!prompt) return fitBodyLines(width, budget, []);

	const innerWidth = Math.max(2, width - 2);
	const bodyLines: string[] = [];
	const messageBox = new Box(2, 1);
	messageBox.addChild(new Text(paint(prompt.message, t.text), 0, 0));
	bodyLines.push(...messageBox.render(innerWidth));
	bodyLines.push(
		...new Text(paint("prompt type", t.textMuted, { bold: true }) + paint(`  ${prompt.kind}`, t.text), 2, 0).render(
			innerWidth,
		),
	);

	if (prompt.kind === "select" && prompt.choices && prompt.choices.length > 0) {
		bodyLines.push(...new Text(paint("choices", t.textMuted, { bold: true }), 2, 0).render(innerWidth));
		for (const choice of prompt.choices) {
			bodyLines.push(...new Text(paint("• ", t.dim) + paint(choice, t.text), 4, 0).render(innerWidth));
		}
	} else if (prompt.kind === "confirm") {
		bodyLines.push(
			...new Text(paint("choices", t.textMuted, { bold: true }) + paint("  yes / no", t.text), 2, 0).render(
				innerWidth,
			),
		);
	}

	if ((prompt.kind === "input" || prompt.kind === "editor") && prompt.initial && prompt.initial.length > 0) {
		bodyLines.push(...new Text(paint("initial value shown", t.textMuted, { bold: true }), 2, 0).render(innerWidth));
		bodyLines.push(...new Text(paint(prompt.initial, t.dim), 4, 0).render(innerWidth));
	}

	const answer = readOnlyPromptAnswer(ctx, stage, prompt);
	bodyLines.push("");
	bodyLines.push(...new Text(paint("your response", t.textMuted, { bold: true }), 2, 0).render(innerWidth));
	bodyLines.push(...new Text(paint(answer, answer.startsWith("(") ? t.dim : t.text), 4, 0).render(innerWidth));
	bodyLines.push("");

	const title = stage.status === "skipped" ? "QUESTION SKIPPED" : "QUESTION ASKED";
	const cardLines = renderRoundedBoxLines({
		title,
		bodyLines,
		width,
		theme: t,
		accent: t.border,
	});
	return fitPromptBodyLines(ctx, cardLines, width, budget);
}

function readOnlyPromptAnswer(ctx: StageChatViewContext, stage: StageSnapshot, prompt: PendingPrompt): string {
	const answer = ctx.store.getStagePromptAnswer(ctx.runId, stage.id);
	if (answer && answer.promptId === prompt.id) {
		return formatReadOnlyPromptAnswer(answer.value, prompt.kind);
	}
	switch (stage.promptAnswerState) {
		case "ambiguous":
			return "(response replay is ambiguous)";
		case "unavailable":
			return "(response unavailable)";
		case "available":
			return "(response no longer in live memory)";
		default:
			return "(no response saved)";
	}
}

function formatReadOnlyPromptAnswer(value: unknown, kind: PendingPrompt["kind"]): string {
	if (kind === "confirm") return value === true ? "yes" : "no";
	if (typeof value === "string") return value.length > 0 ? value : "(empty response)";
	if (typeof value === "number" || typeof value === "boolean" || value === null) {
		return String(value);
	}
	try {
		const encoded = JSON.stringify(value);
		return encoded ?? String(value);
	} catch {
		return String(value);
	}
}

export function renderPausedBody(ctx: StageChatViewContext, width: number, budget: number): string[] {
	const t = ctx.theme;
	const callout: string[] = [];
	callout.push(blankLine(width));
	callout.push(...bannerLines(ctx, width, "warning", "❚❚", "PAUSED", "enter resumes · ctrl+x return to graph"));
	callout.push(
		...new Text(
			paint("This workflow stage is paused. Type a message below and press Enter to resume.", t.textMuted),
			2,
			0,
		).render(width),
	);

	const calloutRows = Math.min(callout.length, Math.max(0, budget - 1));
	const transcriptBudget = Math.max(1, budget - calloutRows);
	const lines = ctx.chatHost.renderBody(width, transcriptBudget);
	lines.push(...callout.slice(0, calloutRows));
	while (lines.length < budget) lines.push(blankLine(width));
	if (lines.length > budget) lines.length = budget;
	return lines;
}

export function renderBlockedBody(
	ctx: StageChatViewContext,
	width: number,
	budget: number,
	stage: StageSnapshot | undefined,
): string[] {
	const t = ctx.theme;
	const upstream = stage?.blockedByStageId ?? "upstream stage";
	const lines: string[] = [];
	lines.push(...bannerLines(ctx, width, "warning", "↑", "BLOCKED", `waiting on ${upstream}`));
	lines.push(blankLine(width));
	lines.push(
		...new Text(paint("This stage is waiting for the upstream stage to resume.", t.textMuted), 2, 0).render(width),
	);
	lines.push(
		...new Text(paint("ctrl+x", t.accent, { bold: true }) + paint(" return to graph", t.textMuted), 2, 0).render(
			width,
		),
	);
	while (lines.length < budget) lines.push(blankLine(width));
	if (lines.length > budget) lines.length = budget;
	return lines;
}

export function renderPromptBody(ctx: StageChatViewContext, width: number, budget: number): string[] {
	const primitiveLayout = renderPrimitivePromptBody(ctx, width, budget);
	if (primitiveLayout) {
		return fitPromptBodyLines(
			ctx,
			embedPromptReturnHint(ctx, primitiveLayout.lines, width),
			width,
			budget,
			Math.max(0, primitiveLayout.totalQuestionRows - primitiveLayout.visibleQuestionRows),
			true,
			primitiveLayout.visibleQuestionRows,
		);
	}

	const state = ctx.promptState;
	if (!state) return fitPromptBodyLines(ctx, [], width, budget);
	const layout = renderPromptCardLayout({
		state,
		theme: ctx.theme,
		width,
		cursorOn: ctx.focused,
		identity: { runId: ctx.runId, name: ctx.workflowName },
		maxRows: budget,
		messageOffset: ctx.promptScrollOffset,
	});
	return fitPromptBodyLines(
		ctx,
		embedPromptReturnHint(ctx, layout.lines, width),
		width,
		budget,
		Math.max(0, layout.totalQuestionRows - layout.visibleQuestionRows),
		true,
		layout.visibleQuestionRows,
	);
}

function embedPromptReturnHint(ctx: StageChatViewContext, lines: readonly string[], width: number): string[] {
	return lines.length < 3 ? [...lines] : embedOrchestratorReturnHintInWidget(ctx, lines, width);
}

function renderPrimitivePromptBody(ctx: StageChatViewContext, width: number, budget: number): PromptCardLayout | null {
	const state = ctx.promptState;
	const editor = ctx.promptEditor;
	if (!state || !editor) return null;
	setEditorFocused(editor, ctx.focused);
	setEditorBorderColor(editor, (text) => hexToAnsi(ctx.theme.accent) + text + RESET);

	const innerWidth = Math.max(2, width - 2);
	const messageLines = new Text(paint(state.prompt.message, ctx.theme.text), 2, 0).render(innerWidth);
	const responseLines = new Text(paint("response", ctx.theme.textMuted, { bold: true }), 2, 0).render(innerWidth);
	const editorLines = editor.render(Math.max(20, innerWidth - 4)).map((line) => `  ${line}`);
	const hintLines = new Text(renderHintsForPrompt(state.prompt.kind, ctx.theme), 2, 0).render(innerWidth);
	const identity = { runId: ctx.runId, name: ctx.workflowName };
	const unattributed = renderPrimitivePromptBlockLayout(
		ctx,
		width,
		budget,
		"AWAITING INPUT",
		messageLines,
		responseLines,
		editorLines,
		hintLines,
	);
	const minimumPromptRows = 2 + editorLines.length + hintLines.length + (messageLines.length > 0 ? 1 : 0);
	// Same degradation ladder as the standard prompt surface: two identity rows,
	// then the run id alone, then no banner. The middle rung matters most here,
	// because the editor and hint rows leave the least room for attribution.
	const banners = [
		renderPromptIdentityBanner(identity, ctx.theme, width),
		renderPromptRunIdBanner(identity, ctx.theme, width),
	];
	for (const banner of banners) {
		const promptBudget = Math.max(0, budget - banner.length);
		const attributed = renderPrimitivePromptBlockLayout(
			ctx,
			width,
			promptBudget,
			"",
			messageLines,
			responseLines,
			editorLines,
			hintLines,
		);
		if (
			banner.length + minimumPromptRows > budget ||
			attributed.visibleQuestionRows === 0 ||
			attributed.visibleQuestionRows < unattributed.visibleQuestionRows
		) {
			continue;
		}
		return {
			lines: [...banner, ...attributed.lines],
			totalQuestionRows: attributed.totalQuestionRows,
			visibleQuestionRows: attributed.visibleQuestionRows,
		};
	}
	return unattributed;
}

function renderPrimitivePromptBlockLayout(
	ctx: StageChatViewContext,
	width: number,
	maxRows: number,
	title: string,
	messageLines: readonly string[],
	responseLines: readonly string[],
	editorLines: readonly string[],
	hintLines: readonly string[],
): PromptCardLayout {
	const totalQuestionRows = messageLines.length;
	if (maxRows === 0) return { lines: [], totalQuestionRows, visibleQuestionRows: 0 };
	const fixedRows = 2 + editorLines.length + hintLines.length;
	if (maxRows < fixedRows + (totalQuestionRows > 0 ? 1 : 0)) {
		return renderReducedPrimitivePrompt(ctx, width, maxRows, messageLines, title);
	}

	let remaining = maxRows - fixedRows;
	let messageCount = totalQuestionRows > 0 ? 1 : 0;
	remaining -= messageCount;
	const includeResponse = remaining >= responseLines.length;
	if (includeResponse) remaining -= responseLines.length;
	const extraMessageRows = Math.min(remaining, Math.max(0, totalQuestionRows - messageCount));
	messageCount += extraMessageRows;
	remaining -= extraMessageRows;
	const includeBlank = remaining > 0;
	const safeOffset = Math.min(ctx.promptScrollOffset, Math.max(0, totalQuestionRows - messageCount));
	const bodyLines = [
		...messageLines.slice(safeOffset, safeOffset + messageCount),
		...(includeResponse ? responseLines : []),
		...editorLines,
		...(includeBlank ? [""] : []),
		...hintLines,
	];
	return {
		lines: renderPrimitivePromptBlock(ctx, width, title, bodyLines),
		totalQuestionRows,
		visibleQuestionRows: messageCount,
	};
}

function renderReducedPrimitivePrompt(
	ctx: StageChatViewContext,
	width: number,
	maxRows: number,
	messageLines: readonly string[],
	title: string,
): PromptCardLayout {
	const totalQuestionRows = messageLines.length;
	const compactTitle = "AWAITING INPUT";
	if (maxRows === 1) {
		return {
			lines: [paint(`${compactTitle} · enter Submit`, ctx.theme.textMuted, { bold: true })],
			totalQuestionRows,
			visibleQuestionRows: 0,
		};
	}
	if (maxRows === 2) {
		const closed = renderPrimitivePromptBlock(ctx, width, compactTitle, []);
		return {
			lines: [closed[0]!, closed.at(-1)!],
			totalQuestionRows,
			visibleQuestionRows: 0,
		};
	}

	const availableBodyRows = maxRows - 2;
	const supportingRows = availableBodyRows >= 3 ? 2 : Math.max(0, availableBodyRows - 1);
	const messageCount = Math.min(totalQuestionRows, Math.max(1, availableBodyRows - supportingRows));
	const safeOffset = Math.min(ctx.promptScrollOffset, Math.max(0, totalQuestionRows - messageCount));
	const responseLine = paint(
		availableBodyRows >= 3 ? "  response" : "  response · enter Submit",
		ctx.theme.textMuted,
		{ bold: true },
	);
	const hintLine = renderHintsForPrompt(ctx.promptState?.prompt.kind ?? "input", ctx.theme);
	return {
		lines: renderPrimitivePromptBlock(ctx, width, maxRows < 5 ? compactTitle : title || "AWAITING INPUT", [
			...messageLines.slice(safeOffset, safeOffset + messageCount),
			...(availableBodyRows >= 2 ? [responseLine] : []),
			...(availableBodyRows >= 3 ? [hintLine] : []),
		]),
		totalQuestionRows,
		visibleQuestionRows: messageCount,
	};
}
function renderPrimitivePromptBlock(
	ctx: StageChatViewContext,
	width: number,
	title: string,
	bodyLines: readonly string[],
): string[] {
	return renderRoundedBoxLines({
		title,
		bodyLines,
		width,
		theme: ctx.theme,
		accent: ctx.theme.border,
	});
}

export function fitPromptBodyLines(
	ctx: StageChatViewContext,
	lines: readonly string[],
	width: number,
	budget: number,
	maxScroll = Math.max(0, lines.length - budget),
	scrollApplied = false,
	visibleRows = Math.min(lines.length, budget),
): string[] {
	ctx.promptMaxScroll = Math.max(0, maxScroll);
	ctx.promptVisibleRows = Math.max(0, visibleRows);
	ctx.promptScrollOffset = Math.max(0, Math.min(ctx.promptScrollOffset, ctx.promptMaxScroll));
	const start = scrollApplied ? 0 : ctx.promptScrollOffset;
	const framed = lines.slice(start, start + budget);
	while (framed.length < budget) framed.push(blankLine(width));
	return framed;
}

function fitBodyLines(width: number, budget: number, lines: readonly string[]): string[] {
	const framed = lines.slice(0, budget);
	while (framed.length < budget) framed.push(blankLine(width));
	return framed;
}
