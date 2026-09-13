/**
 * DAG node card — rounded, status-coloured, with an accent focus tab.
 *
 * Visual contract (DESIGN.md §5):
 *  - Rounded border `╭╮╰╯` only. No square or ASCII art.
 *  - Border colour carries status. `running` pulses via sine lerp
 *    against the dim border (focus locks the pulse). `paused`,
 *    `completed` / `failed` stay status-coloured regardless of focus.
 *    `pending` sits on `borderDim` and lifts to `borderActive` when focused.
 *  - When focused, the centred title segment becomes a compact accent
 *    tab painted with `theme.accent` bg + `theme.surface` fg + bold.
 *    The tab is the only focus signal — the surrounding border is
 *    reserved for status. No `[focused]` text, no glow, no resize.
 *  - Single centred duration line in the body, coloured by status.
 *
 * Reuses the existing `paint(...)` color-utils helper (a thin wrapper
 * over `hexBg` + `hexToAnsi` + `BOLD` + `RESET`) so the tab matches
 * the same ANSI shape Pi's renderer uses for every other styled run.
 *
 * cross-ref:
 *   - github.com/bastani-inc/atomic packages/atomic-sdk/src/components/node-card.tsx
 *   - DESIGN.md §5 "Node Cards (orchestrator graph)"
 *   - src/tui/graph-theme.ts `deriveGraphThemeFromPiTheme` — the
 *     accent/surface tokens used below are sourced from Pi's live
 *     `Theme` when the overlay mounts.
 */

import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { StageSnapshot, StageStatus } from "../shared/store-types.js";
import { elapsedStageMs } from "../shared/timing.js";
import { BOLD, DEFAULT_BG, hexToAnsi, lerpColor, paint, RESET } from "./color-utils.js";
import type { GraphTheme } from "./graph-theme.js";
import { NODE_H, NODE_W } from "./layout.js";
import { wrapIdentifierLines } from "./run-identity-rows.js";
import { fmtDuration, statusIcon } from "./status-helpers.js";
import { truncateToWidth, visibleWidth } from "./text-helpers.js";

export interface NodeCardOpts {
	width?: number;
	height?: number;
	focused?: boolean;
	/** 0–1; ignored when status is terminal (complete/failed). */
	pulsePhase?: number;
	theme: GraphTheme;
	/** Run stages, used to resolve blockedByStageId into a short upstream name. */
	stages?: readonly StageSnapshot[];
	/**
	 * Counts occupy their own row, reusing empty space before increasing height.
	 */
	queuedMessageCount?: number;
}

/** Sine-eased pulse `t ∈ [0, 1]`. Phase 0 ≈ quiet, 0.5 ≈ peak. */
function pulseT(phase: number): number {
	return (Math.sin(phase * Math.PI * 2 - Math.PI / 2) + 1) / 2;
}

/** Normalize a caller-supplied queue count to a non-negative whole number. */
function queuedBadgeCount(count: number | undefined): number {
	if (typeof count !== "number" || !Number.isFinite(count)) return 0;
	return Math.max(0, Math.trunc(count));
}

function queuedBadgeText(count: number): string {
	return `✉ ${count} queued`;
}

function pickBorder(status: StageStatus, focused: boolean, phase: number, theme: GraphTheme): string {
	switch (status) {
		case "running":
			// Focus locks the pulse at peak. Status colour wins either way.
			if (focused) return theme.warning;
			return lerpColor(theme.borderDim, theme.warning, pulseT(phase));
		case "paused":
			return theme.warning;
		case "awaiting_input":
			if (focused) return theme.info;
			return lerpColor(theme.borderDim, theme.info, pulseT(phase));
		case "completed":
			return theme.success;
		case "failed":
			return theme.error;
		case "blocked":
			return theme.dim;
		case "skipped":
			return theme.dim;
		default:
			// Pending has no semantic colour; the focused-tab carries the
			// cursor signal, so we only lift the border one step.
			return focused ? theme.borderActive : theme.borderDim;
	}
}

function durationColor(status: StageStatus, theme: GraphTheme): string {
	switch (status) {
		case "running":
			return theme.warning;
		case "paused":
			return theme.warning;
		case "awaiting_input":
			return theme.info;
		case "completed":
			return theme.success;
		case "failed":
			return theme.error;
		default:
			return theme.dim;
	}
}

function blockedBadgeText(stage: StageSnapshot, stages: readonly StageSnapshot[] | undefined, width: number): string {
	const base = "↑ blocked";
	const blockedBy = stage.blockedByStageId;
	if (!blockedBy) return base;

	const upstream = stages?.find((s) => s.id === blockedBy)?.name ?? blockedBy;
	const withUpstream = `${base} by ${upstream}`;
	if (visibleWidth(withUpstream) <= width) return withUpstream;
	return base;
}

function durationText(stage: StageSnapshot): string {
	const elapsed = elapsedStageMs(stage);
	return elapsed === undefined ? "—" : fmtDuration(elapsed);
}

function metaText(stage: StageSnapshot): string {
	return stage.topologyState === "unavailable" ? "topology unavailable" : "";
}

/**
 * Compact model label for the card's dedicated model row (~22 cells): the
 * provider prefix is dropped, the thinking level is appended when set (omitted
 * when off). On overflow the model name is truncated first, preserving the
 * canonical `-fast` identity suffix and the complete thinking level.
 * Empty when no model is resolved yet.
 */
function modelText(stage: StageSnapshot, innerWidth: number): string {
	const model = stage.model;
	if (model === undefined || model === "") return "";
	const slash = model.lastIndexOf("/");
	const short = slash >= 0 ? model.slice(slash + 1) : model;
	const level = stage.thinkingLevel;
	const showLevel = level !== undefined && level !== "" && level !== "off";
	const suffix = showLevel ? ` · ${level}` : "";
	const full = `${short}${suffix}`;
	if (visibleWidth(full) <= innerWidth) return full;
	// #1859: preserve identity text, without inferring routing from the suffix.
	const modelSuffix = short.endsWith("-fast") ? "-fast" : "";
	const name = modelSuffix ? short.slice(0, -modelSuffix.length) : short;
	const room = Math.max(1, innerWidth - visibleWidth(modelSuffix + suffix));
	return `${truncateToWidth(name, room, "…")}${modelSuffix}${suffix}`;
}

function workflowChildRunRows(stage: StageSnapshot, width: number): string[] {
	const child = stage.workflowChild ?? stage.workflowChildRun;
	if (child === undefined) return [];
	return wrapIdentifierLines(child.runId, Math.max(1, width), "run ", "").map((row) => `${row.prefix}${row.chunk}`);
}

function workflowChildMetaText(stage: StageSnapshot): string | undefined {
	const completed = stage.workflowChild;
	if (completed !== undefined) {
		// #2140 moved the child run id onto its own wrapped row, so the meta
		// line carries only the output count. Prefer the payload-free
		// `outputCount` the compact graph projection supplies; fall back to
		// counting a full `outputs` map on the legacy snapshot path.
		const outputCount = completed.outputCount ?? Object.keys(completed.outputs).length;
		return outputCount === 1 ? "1 out" : `${outputCount} outs`;
	}
	if (stage.workflowChildRun !== undefined) return "live";
	return undefined;
}

function joinCompactStatusMeta(status: string, meta: string, width: number): string {
	const candidates = [`${status} · ${meta}`, `${status} ·${meta}`, `${status}· ${meta}`, `${status}·${meta}`];
	return candidates.find((candidate) => visibleWidth(candidate) <= width) ?? status;
}

/** Minimum height that preserves content and a separate queued-message row. */
export function nodeCardHeight(
	stage: StageSnapshot,
	opts: Pick<NodeCardOpts, "width" | "queuedMessageCount"> = {},
): number {
	const queuedRows = queuedBadgeCount(opts.queuedMessageCount) > 0 ? 1 : 0;
	const modelRows = stage.model !== undefined && stage.model !== "" ? 1 : 0;
	let bodyRows: number;
	if (stage.status === "awaiting_input") {
		bodyRows = 2 + modelRows + queuedRows;
	} else if (stage.workflowChild !== undefined || stage.workflowChildRun !== undefined) {
		const innerWidth = Math.max(2, (opts.width ?? NODE_W) - 2);
		bodyRows = workflowChildRunRows(stage, innerWidth).length + 1 + queuedRows;
	} else {
		bodyRows = 2 + modelRows + (metaText(stage) ? 1 : 0) + queuedRows;
	}
	return Math.max(NODE_H, bodyRows + 2);
}

function statusLabel(status: StageStatus): string {
	switch (status) {
		case "awaiting_input":
			return "awaiting input";
		case "completed":
			return "complete";
		default:
			return status.replace(/_/g, " ");
	}
}

function truncate(s: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (visibleWidth(s) <= maxWidth) return s;
	return truncateToWidth(s, maxWidth, "…");
}

/**
 * Centre a visible string inside `width` cells, wrapping it with `fg`
 * (and optional bold) ANSI escapes. The visible width is computed before
 * the colour escapes are added so padding stays correct. `bg` is
 * re-emitted around the coloured run so trailing pad cells stay on the
 * card stratum instead of dropping to the terminal default.
 */
function centreColored(content: string, width: number, fg: string, bg: string, opts: { bold?: boolean } = {}): string {
	const safe = truncate(content, width);
	const safeWidth = visibleWidth(safe);
	const pad = Math.max(0, width - safeWidth);
	const left = Math.max(0, Math.floor(pad / 2));
	const right = Math.max(0, pad - left);
	const bold = opts.bold ? BOLD : "";
	return `${bg}${" ".repeat(left)}` + `${hexToAnsi(fg)}${bold}${safe}${RESET}` + `${bg}${" ".repeat(right)}`;
}

/**
 * Build the title slot — the run of cells between the rounded corners
 * on the top border. Returns a pre-styled fragment plus its visible
 * width so the caller can pad the surrounding dashes correctly.
 *
 * When `focused`, the slot reads as a small accent-coloured tab:
 *   `╭── stage ──╮`
 * Otherwise it falls back to the historical bold-title shape:
 *   `╭── stage ──╮`
 *
 * The visible-width contract is preserved (length of the title slot
 * is included in the dash math) so the card geometry never shifts
 * between the two states — focus only changes the styling of the
 * existing slot, not its size.
 */
function buildTitleSlot(
	name: string,
	innerWidth: number,
	focused: boolean,
	theme: GraphTheme,
	cardBg: string,
	compact = false,
): { slot: string; visibleWidth: number } {
	const maxName = Math.max(2, compact ? innerWidth - 1 : innerWidth - 4);
	// Labels are plain text. Remove the truncator's resets before styling the
	// whole tab so its ellipsis keeps the same background, foreground and weight.
	const safeName = stripTerminalSequences(truncate(name, maxName));
	if (focused) {
		// Flanking spaces sit on the accent tab so the pill reads as a
		// single coloured run. Use `paint` to combine bg + fg + bold +
		// RESET in one ANSI sequence, then re-prime the card stratum so
		// the dashes outside the slot stay on the body bg.
		const tabText = compact ? safeName : ` ${safeName} `;
		const styled = `${paint(tabText, theme.surface, {
			bg: theme.accent,
			bold: true,
		})}${cardBg}`;
		return { slot: styled, visibleWidth: visibleWidth(tabText) };
	}
	const titleRaw = compact ? safeName : ` ${safeName} `;
	const styled = `${BOLD}${titleRaw}${RESET}${cardBg}`;
	return { slot: styled, visibleWidth: visibleWidth(titleRaw) };
}

/**
 * Render a stage as a multi-line card string.
 * Returns array of exactly `height` lines, each `width` cells wide.
 */
export function renderNodeCard(stage: StageSnapshot, opts: NodeCardOpts): string[] {
	const width = opts.width ?? NODE_W;
	const height = opts.height ?? nodeCardHeight(stage, opts);
	const focused = opts.focused ?? false;
	const phase = opts.pulsePhase ?? 0;
	const theme = opts.theme;

	const borderHex = pickBorder(stage.status, focused, phase, theme);
	const bc = hexToAnsi(borderHex);
	// Node interiors share the unpainted canvas. Reset after the focused
	// title tab so its accent background does not spill into the card.
	const bg = DEFAULT_BG;
	const innerWidth = Math.max(2, width - 2);

	// Child workflow boundaries use the compact title path so their workflow
	// identity remains visible without changing the fixed card geometry.
	const child = stage.workflowChild ?? stage.workflowChildRun;
	const { slot: titleSlot, visibleWidth: titleVisibleWidth } = buildTitleSlot(
		child === undefined ? stage.name : `↳ ${child.workflow}`,
		innerWidth,
		focused,
		theme,
		bg,
		child !== undefined,
	);
	const titleStart = Math.max(1, Math.floor((innerWidth - titleVisibleWidth) / 2));
	const titleEnd = titleStart + titleVisibleWidth;
	const topMiddle =
		`${bc}${"─".repeat(titleStart)}` + `${titleSlot}${bc}` + `${"─".repeat(Math.max(0, innerWidth - titleEnd))}`;
	const top = `${bg}${bc}╭${topMiddle}╮${RESET}`;
	const bottom = `${bg}${bc}╰${"─".repeat(innerWidth)}╯${RESET}`;

	// A tool card is a fixed-size graph node, not a result preview: the read-only
	// detail view owns args, result, error, and timing. The body is constant in
	// every state so the card stops competing with it, while status and model
	// information occupy the remaining rows.
	const bodyText =
		stage.nodeKind === "tool"
			? "durable tool"
			: stage.status === "blocked"
				? blockedBadgeText(stage, opts.stages, innerWidth)
				: durationText(stage);
	const bodyHex = durationColor(stage.status, theme);
	const statusText = `${statusIcon(stage.status)} ${stage.toolStatus ?? statusLabel(stage.status)}`;
	const queuedCount = queuedBadgeCount(opts.queuedMessageCount);
	const statusLine =
		`${bg}${bc}│${RESET}` +
		centreColored(statusText, innerWidth, bodyHex, bg, {
			bold: stage.status === "running" || stage.status === "awaiting_input",
		}) +
		`${bg}${bc}│${RESET}`;
	const durLine =
		`${bg}${bc}│${RESET}` +
		centreColored(bodyText, innerWidth, bodyHex, bg, {
			bold: stage.status === "blocked",
		}) +
		`${bg}${bc}│${RESET}`;

	const contentRows = Math.max(0, height - 2);
	const metaLine = `${bg}${bc}│${RESET}${centreColored(metaText(stage), innerWidth, theme.dim, bg)}${bg}${bc}│${RESET}`;
	const model = modelText(stage, innerWidth);
	const modelLine = `${bg}${bc}│${RESET}${centreColored(model, innerWidth, theme.textMuted, bg)}${bg}${bc}│${RESET}`;
	const childRunLines = workflowChildRunRows(stage, innerWidth).map(
		(row) => `${bg}${bc}│${RESET}${centreColored(row, innerWidth, theme.dim, bg)}${bg}${bc}│${RESET}`,
	);
	const childMeta = workflowChildMetaText(stage);
	const childSummary = childMeta === undefined ? undefined : joinCompactStatusMeta(statusText, childMeta, innerWidth);
	const childSummaryLine =
		childSummary === undefined
			? undefined
			: `${bg}${bc}│${RESET}` +
				centreColored(childSummary, innerWidth, bodyHex, bg, {
					bold: stage.status === "running" || stage.status === "awaiting_input",
				}) +
				`${bg}${bc}│${RESET}`;

	const queuedLines =
		queuedCount > 0
			? [
					`${bg}${bc}│${RESET}` +
						centreColored(queuedBadgeText(queuedCount), innerWidth, theme.info, bg, { bold: true }) +
						`${bg}${bc}│${RESET}`,
				]
			: [];
	const modelLines = model === "" ? [] : [modelLine];
	const interior: string[] =
		stage.status === "awaiting_input"
			? [
					...modelLines,
					statusLine,
					...(model === "" && queuedCount === 0
						? [
								`${bg}${bc}│${RESET}` +
									centreColored("waiting for response", innerWidth, theme.info, bg) +
									`${bg}${bc}│${RESET}`,
							]
						: []),
					...queuedLines,
					`${bg}${bc}│${RESET}` +
						centreColored("↵ enter to respond", innerWidth, theme.dim, bg) +
						`${bg}${bc}│${RESET}`,
				]
			: childSummaryLine === undefined
				? [durLine, ...modelLines, statusLine, ...(metaText(stage) ? [metaLine] : []), ...queuedLines]
				: [...childRunLines, childSummaryLine, ...queuedLines];

	// Pad / clip to exactly `height` lines.
	while (interior.length < contentRows) {
		interior.push(`${bg}${bc}│${RESET}${bg}${" ".repeat(innerWidth)}${bg}${bc}│${RESET}`);
	}
	if (interior.length > contentRows) interior.length = contentRows;

	return [top, ...interior, bottom];
}
