import {
	type AgentSession,
	applyAttachedComposer,
	hintKeyParts,
	type NavKeybindings,
	type NavKeyStyle,
	navEntryKeys,
	renderNavHintLine,
	renderNavKeyOverlay,
	TASK_CHAT_OVERLAY_KEYS,
	taskChatKeys,
} from "@bastani/atomic";
import { Box, clickableKeysHint, getKeybindings, Text } from "@bastani/atomic-tui";
import { isTerminalStageStatus } from "../shared/store-internal.js";
import type { StageSnapshot } from "../shared/store-types.js";
import { elapsedStageMs } from "../shared/timing.js";
import { hexToAnsi, RESET } from "./color-utils.js";
import { APP_ACTION, isKeybindingsLike } from "./keybindings-adapter.js";
import { wrapIdentifierLines } from "./run-identity-rows.js";
import {
	bgFn,
	blendBg,
	paint,
	paintOnFill,
	stripAnsi,
	stripStyles,
	trailingWidgetBorderChar,
	widgetHintTargetLineIndex,
} from "./stage-chat-view-render-helpers.js";
import { isAbortableStreamingSession, isBlocked } from "./stage-chat-view-state.js";
import type { StageChatViewContext } from "./stage-chat-view-types.js";
import {
	applyStageLabelToEditorTopRule,
	applyStageLabelToWidgetTopRule,
	resolvedStageName,
} from "./stage-input-label.js";
import { truncateToWidth, visibleWidth } from "./text-helpers.js";

interface HostTheme {
	fg(color: string, text: string): string;
	bold?(text: string): string;
}

function hostThemeOf(candidate: unknown): HostTheme | undefined {
	return typeof candidate === "object" &&
		candidate !== null &&
		typeof (candidate as { fg?: unknown }).fg === "function"
		? (candidate as HostTheme)
		: undefined;
}

export function injectStageLabelIntoEditorTopRule(
	ctx: StageChatViewContext,
	stageName: string | undefined,
	editorLines: readonly string[],
	stage?: StageSnapshot,
	now = Date.now(),
): string[] {
	const cleanStageName = resolvedStageName(stageName);
	if (cleanStageName === undefined) return applyStageLabelToEditorTopRule(ctx.theme, cleanStageName, editorLines);
	const waiting = stage?.status === "awaiting_input";
	const elapsed = stage?.status === "running" ? elapsedStageMs(stage, now) : undefined;
	const state =
		stage === undefined
			? undefined
			: waiting
				? "needs input"
				: elapsed !== undefined
					? formatStageElapsed(elapsed)
					: stage.status === "completed"
						? "done"
						: stage.status;
	const label = ["stage", cleanStageName, state].filter(Boolean).join(" · ");
	const t = ctx.theme;
	const hostTheme = hostThemeOf(ctx.piTheme);
	return applyAttachedComposer(
		{
			accent: (text) => (hostTheme ? hostTheme.fg("accent", text) : paint(text, t.accent)),
			text: (text) => (hostTheme ? hostTheme.fg("text", text) : paint(text, t.text)),
			dim: (text) => (hostTheme ? hostTheme.fg("dim", text) : paint(text, t.dim)),
		},
		label,
		ctx.chatHost.hasInputText() ? undefined : `${waiting ? "Answer" : "Message"} ${cleanStageName}…`,
		editorLines,
	);
}

function formatStageElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function renderHeader(ctx: StageChatViewContext, width: number, stage: StageSnapshot | undefined): string[] {
	const t = ctx.theme;
	// While a pooled stage moves to a replacement attempt, its run may be republished before the stage is.
	const stageName = resolvedStageName(stage?.name ?? ctx.handle?.stageName) ?? "stage";
	const workflowName = resolvedStageName(ctx.workflowName) ?? "workflow";
	const sid = ctx.handle?.sessionId ?? stage?.sessionId;
	const prefixWidth = visibleWidth("   STAGE  ");
	const separatorWidth = visibleWidth(" / ");
	const placement = ctx.handle?.placement;
	// A finished stage runs on no worker: its post-mortem chat runs in the root, like an in-process stage's.
	const finished = stage !== undefined && isTerminalStageStatus(stage.status);
	const onLocalWorker = !finished && (placement?.kind === "local-worker" || stage?.workerExecution !== undefined);
	const redelivered = placement?.redelivered ?? 0;
	const status = [
		onLocalWorker ? "on local worker" : "",
		placement?.reconnecting === true ? "RECONNECTING" : "",
		redelivered > 0 ? `redelivered ${redelivered} message${redelivered === 1 ? "" : "s"}` : "",
		(placement?.undelivered ?? 0) > 0
			? `${placement!.undelivered} message${placement!.undelivered === 1 ? "" : "s"} not delivered`
			: "",
	]
		.filter(Boolean)
		.join(" · ");
	const meta = [status, sid ? `session ${sid}` : ""].filter(Boolean).join(" · ");
	const rightWidth = meta ? visibleWidth(meta) + 1 : 0;
	const singleRowNameBudget = width - prefixWidth - separatorWidth - rightWidth - (meta ? 1 : 0);

	const fullNameWidth = visibleWidth(workflowName) + visibleWidth(stageName);
	if (!sid || singleRowNameBudget >= fullNameWidth) {
		const names = fitHeaderNames(workflowName, stageName, Math.max(2, singleRowNameBudget));
		const left = renderHeaderLeft(ctx, names.workflow, names.stage);
		const right = meta ? `${paint(meta, t.dim)} ` : "";
		const gap = Math.max(0, width - visibleWidth(left) - visibleWidth(right));
		return [left + " ".repeat(gap) + right];
	}

	const names = fitHeaderNames(workflowName, stageName, Math.max(2, width - prefixWidth - separatorWidth));
	const left = renderHeaderLeft(ctx, names.workflow, names.stage);
	const lines = [left + " ".repeat(Math.max(0, width - visibleWidth(left)))];
	if (visibleWidth(meta) + 1 <= width) {
		lines.push(`${" ".repeat(Math.max(0, width - visibleWidth(meta) - 1))}${paint(meta, t.dim)} `);
		return lines;
	}
	// Worker status keeps its own row, so a narrow chat still shows reconnects and redelivery.
	if (status) {
		const row = `   ${paint(truncateToWidth(status, Math.max(1, width - 3), "…"), t.dim)}`;
		lines.push(row + " ".repeat(Math.max(0, width - visibleWidth(row))));
	}
	for (const row of wrapIdentifierLines(sid, width, "   ", "   ")) {
		const value = `${row.prefix}${paint(row.chunk, t.dim)}`;
		lines.push(value + " ".repeat(Math.max(0, width - visibleWidth(value))));
	}
	return lines;
}

function renderHeaderLeft(ctx: StageChatViewContext, workflowName: string, stageName: string): string {
	const t = ctx.theme;
	return (
		paint("   ", t.mauve, { bold: true }) +
		paint("STAGE", t.textMuted, { bold: true }) +
		"  " +
		paint(workflowName, t.textMuted) +
		paint(" / ", t.dim) +
		paint(stageName, t.text, { bold: true })
	);
}

function fitHeaderNames(workflowName: string, stageName: string, budget: number): { workflow: string; stage: string } {
	const available = Math.max(2, budget);
	const workflowWidth = visibleWidth(workflowName);
	const stageWidth = visibleWidth(stageName);
	let workflowBudget = Math.min(workflowWidth, Math.max(1, Math.ceil(available / 2)));
	let stageBudget = Math.min(stageWidth, Math.max(1, available - workflowBudget));
	let remaining = available - workflowBudget - stageBudget;
	const workflowExtra = Math.min(remaining, Math.max(0, workflowWidth - workflowBudget));
	workflowBudget += workflowExtra;
	remaining -= workflowExtra;
	stageBudget += Math.min(remaining, Math.max(0, stageWidth - stageBudget));
	return {
		workflow: truncateToWidth(workflowName, workflowBudget, "…"),
		stage: truncateToWidth(stageName, stageBudget, "…"),
	};
}

export function sepRule(ctx: StageChatViewContext, width: number): string {
	return hexToAnsi(ctx.theme.borderDim) + "─".repeat(width) + RESET;
}

export function stageNavKeyStyle(ctx: StageChatViewContext): NavKeyStyle {
	const t = ctx.theme;
	const hostTheme = hostThemeOf(ctx.piTheme);
	if (hostTheme) {
		return {
			dim: (text) => hostTheme.fg("dim", text),
			text: (text) => hostTheme.fg("text", text),
			muted: (text) => hostTheme.fg("muted", text),
			border: (text) => hostTheme.fg("borderMuted", text),
			bold: (text) =>
				typeof hostTheme.bold === "function" ? hostTheme.bold(text) : paint(text, t.text, { bold: true }),
		};
	}
	return {
		dim: (text) => paint(text, t.dim),
		text: (text) => paint(text, t.text),
		muted: (text) => paint(text, t.textMuted),
		border: (text) => paint(text, t.borderDim),
		bold: (text) => paint(text, t.text, { bold: true }),
	};
}

function stageNavKeybindings(ctx: Pick<StageChatViewContext, "piKeybindings">): NavKeybindings {
	const candidate = isKeybindingsLike(ctx.piKeybindings) ? ctx.piKeybindings : undefined;
	const fallback = getKeybindings();
	return {
		matches: (data, action) =>
			candidate
				? candidate.matches(data, action)
				: fallback.matches(data, action as Parameters<typeof fallback.matches>[1]),
		getKeys: (action) => {
			const keys =
				candidate && typeof candidate.getKeys === "function"
					? candidate.getKeys(action)
					: fallback.getKeys(action as Parameters<typeof fallback.getKeys>[0]);
			return action === "app.interrupt" ? keys : keys.filter((key) => key !== "esc" && key !== "escape");
		},
	};
}

export function isStageChatInterruptible(ctx: StageChatViewContext): boolean {
	return (
		isAbortableStreamingSession(ctx) ||
		ctx.chatHost.isCompacting() ||
		ctx.chatHost.isBashRunning() ||
		ctx.chatHost.isEditingBashCommand()
	);
}

export function hasStageChatTasks(ctx: StageChatViewContext): boolean {
	return ctx.chatHost.hasBackgroundTasks();
}

export function renderStageChatKeyOverlay(ctx: StageChatViewContext, width: number): string[] {
	const keybindings = stageNavKeybindings(ctx);
	const interruptible = isStageChatInterruptible(ctx);
	const hasTasks = hasStageChatTasks(ctx);
	const expandable = ctx.setToolsExpanded !== undefined;
	const overlayKeys = TASK_CHAT_OVERLAY_KEYS.flatMap((entry) => {
		if (entry.keys === "esc" && !interruptible) return [];
		if (entry.action === "app.tools.expand" && !expandable) return [];
		if (entry.action === "app.nav.back" && hasTasks)
			return [entry, { action: "app.agents.focus", label: "agents, on an empty prompt" }];
		return [entry];
	});
	return renderNavKeyOverlay("keys · stage chat", overlayKeys, width, stageNavKeyStyle(ctx), keybindings);
}

export function renderStageChatHintLine(ctx: StageChatViewContext, width: number): string {
	const keybindings = stageNavKeybindings(ctx);
	const blocked = isBlocked(ctx);
	const chatKeys = taskChatKeys(
		"graph",
		isStageChatInterruptible(ctx),
		!blocked && hasStageChatTasks(ctx),
		ctx.setToolsExpanded !== undefined,
	).filter((entry) => !blocked || entry.action !== APP_ACTION.keysHelp);
	return renderNavHintLine(chatKeys, width, stageNavKeyStyle(ctx), keybindings);
}

export function renderFooterWithOrchestratorReturnHint(
	ctx: StageChatViewContext,
	width: number,
	footerLines: readonly string[],
): string[] {
	if (stackedStageDialogOpen(ctx) || closableQuestionCardOpen(ctx)) {
		return [mergeOrchestratorReturnHintIntoLine(ctx, footerLines[0] ?? "", width)];
	}
	if (ctx.chatHost?.hasTransientModal) return [...footerLines];
	return [...footerLines, renderStageChatHintLine(ctx, width)];
}
export function renderReadOnlyArchiveFooter(ctx: StageChatViewContext, width: number): string[] {
	const closeHint = clickableKeysHint(
		[{ text: paint("ctrl+c", ctx.theme.text, { bold: true }), key: "ctrl+c" }],
		paint(" to close", ctx.theme.textMuted),
	);
	return [
		mergeOrchestratorReturnHintIntoLine(ctx, closeHint, width, {
			minimumPrefixWidth: visibleWidth(closeHint) + 1,
		}),
	];
}

/**
 * Inject `[stage: name]` into the widget top rule (Case 2 of issue #2886).
 *
 * Accepts a pure `─` DynamicBorder and empty boxed fill. Titled boxes and
 * unrelated first rows are left unchanged. The back-to-graph hint is merged
 * separately by embedOrchestratorReturnHintInWidget.
 */
export function embedStageLabelInWidgetTopRule(
	ctx: StageChatViewContext,
	stageName: string | undefined,
	widgetLines: readonly string[],
	width: number,
): string[] {
	return applyStageLabelToWidgetTopRule(ctx.theme, stageName, widgetLines, width);
}

export function embedCustomUiBackHint(
	ctx: StageChatViewContext,
	widgetLines: readonly string[],
	width: number,
): string[] {
	const backKey = backToGraphKey(ctx);
	if (!backKey || widgetLines.length < 2 || ctx.mountedCustomUi?.component.capturesBack?.() === true) {
		return [...widgetLines];
	}
	let bottomBorderIndex = -1;
	for (let index = widgetLines.length - 1; index >= 0; index -= 1) {
		const plain = stripAnsi(widgetLines[index] ?? "").trim();
		if (plain.length >= 2 && "╰└+".includes(plain[0] ?? "") && "╯┘+".includes(plain.at(-1) ?? "")) {
			bottomBorderIndex = index;
			break;
		}
	}
	if (bottomBorderIndex < 0 || bottomBorderIndex + 1 >= widgetLines.length) return [...widgetLines];
	const hintIndex = bottomBorderIndex + 1;
	const hintLine = widgetLines[hintIndex] ?? "";
	const hintPlain = stripAnsi(hintLine).trim();
	if (hintPlain.length === 0 || hintPlain.includes(`${backKey} graph`)) return [...widgetLines];
	const suffixPlain = ` · ${backKey} graph`;
	const hostTheme = hostThemeOf(ctx.piTheme);
	const suffixHint = ` · ${clickableKeysHint(hintKeyParts(backKey), " graph")}`;
	const suffixStyled = hostTheme ? hostTheme.fg("dim", suffixHint) : paint(suffixHint, ctx.theme.dim);
	const suffixWidth = visibleWidth(suffixPlain);
	const trimmedLine = hintLine.trimEnd();
	const nextHint =
		visibleWidth(trimmedLine) + suffixWidth <= width
			? `${trimmedLine}${suffixStyled}`
			: `${truncateToWidth(trimmedLine, Math.max(0, width - suffixWidth), "")}${suffixStyled}`;
	const lines = [...widgetLines];
	lines[hintIndex] = nextHint;
	return lines;
}

export function embedOrchestratorReturnHintInWidget(
	ctx: StageChatViewContext,
	widgetLines: readonly string[],
	width: number,
): string[] {
	if (widgetLines.length === 0) {
		return [mergeOrchestratorReturnHintIntoLine(ctx, "", width)];
	}
	const lines = [...widgetLines];
	const targetIndex = widgetHintTargetLineIndex(lines);
	const targetLine = lines[targetIndex] ?? "";
	const trailingBorder = trailingWidgetBorderChar(targetLine);
	const plainPrefix = stripAnsi(targetLine)
		.slice(0, trailingBorder.length > 0 ? -trailingBorder.length : undefined)
		.trimEnd();
	lines[targetIndex] = mergeOrchestratorReturnHintIntoLine(ctx, targetLine, width, {
		preserveTrailingBorder: true,
		rightMargin: 2,
		minimumPrefixWidth: visibleWidth(plainPrefix) + 1,
	});
	return lines;
}

function mergeOrchestratorReturnHintIntoLine(
	ctx: StageChatViewContext,
	line: string,
	width: number,
	options: {
		preserveTrailingBorder?: boolean;
		rightMargin?: number;
		minimumPrefixWidth?: number;
	} = {},
): string {
	const stackedDialog = stackedStageDialogOpen(ctx);
	const cardOpen = stackedDialog || closableQuestionCardOpen(ctx);
	const backKey = stackedDialog ? "" : backToGraphKey(ctx);
	if (!cardOpen && !backKey) return line;
	const key = backKey || "esc";
	const action = stackedDialog ? " cancel" : " close";
	const full = cardOpen ? (backKey ? ` graph · esc${action}` : action) : " return to graph";
	const compact = cardOpen ? full : " graph";
	const keyHint = (keys: string, label: string) =>
		clickableKeysHint(
			hintKeyParts(keys).map((part) => ({ ...part, text: paint(part.text, ctx.theme.text, { bold: true }) })),
			paint(label, ctx.theme.textMuted),
		);
	const styledHint = (label: string) =>
		cardOpen && backKey
			? keyHint(key, " graph") + paint(" · ", ctx.theme.textMuted) + keyHint("esc", action)
			: keyHint(key, label);
	const fullHint = { plain: `${key}${full}`, styled: styledHint(full) };
	const compactHint = { plain: `${key}${compact}`, styled: styledHint(compact) };
	const trailingBorder = options.preserveTrailingBorder === true ? trailingWidgetBorderChar(line) : "";
	const suffixWidth = visibleWidth(trailingBorder);
	const requestedRightMargin = Math.max(0, Math.floor(options.rightMargin ?? 0));
	const minimumPrefixWidth = Math.max(0, Math.floor(options.minimumPrefixWidth ?? 0));
	const fullRequiredWidth = suffixWidth + requestedRightMargin + minimumPrefixWidth + visibleWidth(fullHint.plain);
	const hint = fullRequiredWidth <= width ? fullHint : compactHint;
	const hintWidth = visibleWidth(hint.plain);
	const rightMargin = Math.min(requestedRightMargin, Math.max(0, width - suffixWidth - hintWidth));
	const hintStart = Math.max(0, width - suffixWidth - rightMargin - hintWidth);
	const prefixWidth = Math.max(0, hintStart - 1);
	const prefix = truncateToWidth(line, prefixWidth, "");
	const gap = Math.max(0, hintStart - visibleWidth(prefix));
	return prefix + " ".repeat(gap) + hint.styled + " ".repeat(rightMargin) + trailingBorder;
}

export function banner(
	ctx: StageChatViewContext,
	kind: "warning" | "success" | "error" | "info",
	glyph: string,
	label: string,
	meta: string,
): Box {
	const t = ctx.theme;
	const fg = kind === "warning" ? t.warning : kind === "success" ? t.success : kind === "info" ? t.info : t.error;
	const bg = blendBg(t.bg, fg, 0.1);
	const head =
		paintOnFill(glyph, fg, { bold: true }) +
		"  " +
		paintOnFill(label, fg, { bold: true }) +
		"  " +
		paintOnFill(stripStyles(meta), t.dim);
	const box = new Box(2, 0, bgFn(bg));
	box.addChild(new Text(head, 0, 0));
	return box;
}

export function bannerLines(
	ctx: StageChatViewContext,
	width: number,
	kind: "warning" | "success" | "error" | "info",
	glyph: string,
	label: string,
	meta: string,
): string[] {
	return banner(ctx, kind, glyph, label, meta).render(width);
}

export function editorRuleColor(
	ctx: StageChatViewContext,
	disabled: boolean,
	agentSession: AgentSession | undefined,
	state?: { isBashMode: boolean },
): string {
	if (disabled) return ctx.theme.borderDim;
	if (state?.isBashMode) return ctx.theme.warning;
	const level = agentSession?.state.thinkingLevel ?? "off";
	switch (level) {
		case "minimal":
			return ctx.theme.borderDim;
		case "low":
			return ctx.theme.info;
		case "medium":
			return ctx.theme.accent;
		case "high":
			return ctx.theme.mauve;
		case "xhigh":
			return ctx.theme.error;
		case "max":
			return ctx.theme.error;
		default:
			return ctx.theme.border;
	}
}

/** Whether a choice or yes/no question card owns the composer's place (not closed back to the prompt with Esc). */
export function closableQuestionCardOpen(
	ctx: Pick<StageChatViewContext, "promptState"> & Partial<Pick<StageChatViewContext, "dismissedPromptId">>,
): boolean {
	const prompt = ctx.promptState?.prompt;
	return (
		prompt !== undefined && prompt.kind !== "input" && prompt.kind !== "editor" && prompt.id !== ctx.dismissedPromptId
	);
}

export function stackedStageDialogOpen(
	ctx: Pick<StageChatViewContext, "promptState"> &
		Partial<Pick<StageChatViewContext, "dismissedPromptId" | "mountedCustomUi">>,
): boolean {
	const prompt = ctx.promptState?.prompt;
	return (
		ctx.mountedCustomUi !== null &&
		ctx.mountedCustomUi !== undefined &&
		prompt?.source === "stage-dialog" &&
		prompt.id !== ctx.dismissedPromptId
	);
}

/** The key that returns from a stage chat to its graph, as its hints name it. */
export function backToGraphKey(ctx: Pick<StageChatViewContext, "piKeybindings">): string {
	return navEntryKeys(stageNavKeybindings(ctx), { action: APP_ACTION.navBack, label: "graph" });
}
