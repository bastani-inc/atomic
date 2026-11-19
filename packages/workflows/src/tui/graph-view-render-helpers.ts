import {
	type NavKey,
	type NavKeybindings,
	type NavKeyStyle,
	navEntryKeyParts,
	navEntryKeys,
	sliceHead,
} from "@bastani/atomic";
import { clickableKeysHint } from "@bastani/atomic-tui";
import type { RunSnapshot, StageSnapshot } from "../shared/store-types.js";
import { sanitizeToolTitleText } from "../shared/tool-payload-bounds.js";
import { boldOn, DEFAULT_BG, fillBackground, hexBg, hexToAnsi, RESET } from "./color-utils.js";
import { inertDisplayLine } from "./display-text.js";
import type { GraphCanvas } from "./graph-canvas.js";
import { MODE_PILL_LABEL } from "./graph-view-constants.js";
import { GraphViewState } from "./graph-view-state.js";
import { renderOutlinePill } from "./header.js";
import { APP_ACTION, isKeybindingsLike } from "./keybindings-adapter.js";
import { NODE_H, NODE_W } from "./layout.js";
import { BoundedTextCache, sliceColumns, truncateToWidth, visibleWidth } from "./text-helpers.js";
import { OVERLAY_HIDDEN_STATUS_KEYS, WORKFLOW_STATUS_KEY } from "./workflow-status.js";

const slicedColumnSegments = new BoundedTextCache(1024);
const GRAPH_STOP_PRIORITY_KEYS = new Set([
	"escape",
	"esc",
	"up",
	"down",
	"left",
	"right",
	"enter",
	"return",
	"j",
	"k",
	"g",
	"/",
	"f",
	"o",
]);

function displayedBinding(key: string): string {
	return navEntryKeys({ matches: () => false, getKeys: () => [key] }, { action: APP_ACTION.listStop, label: "" });
}

function noticeDisplayText(value: string, width: number): string {
	const head = sliceHead(value, Math.max(0, width + 1));
	return inertDisplayLine(sanitizeToolTitleText(head)) + (head.length < value.length ? "…" : "");
}

function ellipsizeQuitName(name: string, budget: number): string {
	if (budget <= 0) return "";
	if (visibleWidth(name) <= budget) return name;
	return truncateToWidth(name, budget, "\u2026");
}

export type GraphKeyTier = "full" | "compact" | "tight" | "minimal" | "keys";

export function toolExpandKey(piKeybindings: unknown): string {
	const keybindings = isKeybindingsLike(piKeybindings) ? piKeybindings : undefined;
	const keys = keybindings?.getKeys?.(APP_ACTION.toolsExpand);
	// Missing manager → default. Empty list → explicitly unbound; do not
	// invent a keyless `expand` label the way `"".join` used to.
	if (keys === undefined) return "ctrl+o";
	return keys.filter((key) => key.length > 0).join("/");
}
/** Low-level overlay geometry, chrome, ANSI canvas, and edge helpers. */
export abstract class GraphViewRenderHelpers extends GraphViewState {
	/**
	 * Three-row statusline pinned to the bottom of the overlay. Mirrors
	 * the header band: `backgroundPanel` chrome, outlined accent pill
	 * flush-left, hints flowing right on the centre row.
	 */
	protected _externalStatusText(): string | null {
		const entries = Array.from(this.footerData?.getExtensionStatuses() ?? [])
			.filter(
				([key, value]) =>
					value.trim().length > 0 &&
					key !== WORKFLOW_STATUS_KEY &&
					!key.startsWith(`${WORKFLOW_STATUS_KEY}:`) &&
					!OVERLAY_HIDDEN_STATUS_KEYS.has(key),
			)
			.sort(([a], [b]) => a.localeCompare(b));
		if (entries.length === 0) return null;
		return entries.map(([, value]) => value.trim()).join(" · ");
	}

	protected _movableArrows(): string {
		return this.cachedNavigation[this.focusedIndex]?.arrows ?? "";
	}

	protected _navKeybindings(): NavKeybindings | undefined {
		return isKeybindingsLike(this.piKeybindings) ? (this.piKeybindings as NavKeybindings) : undefined;
	}

	protected _navKeyStyle(): NavKeyStyle {
		const t = this.graphTheme;
		return {
			dim: (text) => `${hexToAnsi(t.dim)}${text}${RESET}`,
			text: (text) => `${hexToAnsi(t.text)}${text}${RESET}`,
			muted: (text) => `${hexToAnsi(t.textMuted)}${text}${RESET}`,
			border: (text) => `${hexToAnsi(t.borderActive)}${text}${RESET}`,
			bold: (text) => `${hexToAnsi(t.text)}${boldOn()}${text}${RESET}`,
		};
	}

	protected _actionKey(action: string, fallback: string, label: string): NavKey {
		return this._navKeybindings()?.getKeys ? { action, label } : { keys: fallback, label };
	}

	private _stopNavKey(label: string): NavKey {
		const keybindings = this._navKeybindings();
		const keys = keybindings?.getKeys?.(APP_ACTION.listStop);
		if (keys === undefined) return { keys: "x", label };
		const helpKeys = (keybindings?.getKeys?.(APP_ACTION.keysHelp) ?? []).map(displayedBinding);
		const available = keys.filter(
			(key) => !GRAPH_STOP_PRIORITY_KEYS.has(key.toLowerCase()) && !helpKeys.includes(displayedBinding(key)),
		);
		return { keys: available.map(displayedBinding).join("/"), label };
	}

	protected _focusedStageStoppable(
		stage: StageSnapshot | undefined = this.cachedLayout[this.focusedIndex]?.stage,
	): boolean {
		if (this.stageActions?.stop === undefined) return false;
		if (stage === undefined || this._stageChatTarget(stage) === undefined) return false;
		return stage.status === "running";
	}

	protected _keyShadowed(key: string): boolean {
		const keybindings = this._navKeybindings();
		return (
			keybindings?.matches(key, APP_ACTION.listStop) === true ||
			keybindings?.matches(key, APP_ACTION.keysHelp) === true
		);
	}

	protected _toolDetailKeyShadowed(key: string): boolean {
		const keybindings = this._navKeybindings();
		return (
			keybindings?.matches(key, APP_ACTION.toolsExpand) === true ||
			keybindings?.matches(key, APP_ACTION.keysHelp) === true
		);
	}

	protected _graphKeys(
		compact: boolean | GraphKeyTier = "full",
		frameContext?: { readonly run: RunSnapshot | null; readonly focused: StageSnapshot | undefined },
	): NavKey[] {
		const mode: GraphKeyTier = typeof compact === "boolean" ? (compact ? "compact" : "full") : compact;
		const keyOnly = mode === "keys";
		const quitArmed = this._isQuitArmed(frameContext?.run);
		const help: NavKey = this._actionKey(APP_ACTION.keysHelp, "?", keyOnly && !quitArmed ? "" : "keys");
		if (this.toolDetail !== null) {
			const expandKey = toolExpandKey(this.piKeybindings);
			const homeEndKeys = ["home", "end"].filter((key) => !this._toolDetailKeyShadowed(key)).join("/");
			return [
				{
					keys: "esc",
					label: keyOnly ? "" : mode === "full" ? "back to graph" : "back",
				},
				{ keys: "\u2191\u2193 pgup/pgdn", label: keyOnly ? "" : "scroll" },
				...(homeEndKeys.length > 0
					? [
							{
								keys: homeEndKeys,
								label: mode === "full" ? "top/bottom" : mode === "compact" ? "ends" : "",
							},
						]
					: []),
				...(expandKey.length > 0
					? [
							{
								keys: expandKey,
								label: keyOnly ? "" : this.toolDetailExpanded ? "collapse" : "expand",
							},
						]
					: []),
				help,
			];
		}
		if (this.stageDetail !== null && this.forkConfirm !== null) {
			return [
				{ keys: "enter", label: "confirm" },
				{ keys: "esc", label: "cancel" },
			];
		}
		if (this.stageDetail !== null) {
			const actions = this.stageActions;
			const canFork = actions?.fork !== undefined && actions.forkTarget !== undefined && this.runId !== null;
			const canRetry = this.stageDetail.status === "failed" && actions?.retry !== undefined;
			const short = mode !== "full";
			return [
				...(canRetry ? [{ keys: "r", label: keyOnly ? "" : short ? "retry" : "retry from stage" }] : []),
				...(canFork ? [{ keys: "f", label: keyOnly ? "" : short ? "fork" : "fork from stage" }] : []),
				...(this.onStageAttach
					? [
							{
								keys: "t",
								label: keyOnly ? "" : mode === "tight" || mode === "minimal" ? "chat" : "transcript",
							},
						]
					: []),
				{ keys: "l", label: keyOnly ? "" : this.stageDetail.logs ? "summary" : "logs" },
				{ keys: "esc", label: keyOnly ? "" : "back" },
				...(this.stageDetail.logs
					? [
							{
								keys: mode === "minimal" || keyOnly ? "\u2191\u2193" : "\u2191\u2193 pgup/pgdn",
								label: mode === "tight" || mode === "minimal" || keyOnly ? "" : "scroll",
							},
						]
					: []),
				help,
			];
		}
		if (this.runDetail !== null) {
			const blockers = this.runDetail.logs ? 0 : this._runDetailBlockers().length;
			const keybindings = this._navKeybindings();
			const helpKeys = new Set((keybindings?.getKeys?.(APP_ACTION.keysHelp) ?? []).map(displayedBinding));
			const available = (key: string) =>
				!helpKeys.has(displayedBinding(key)) && keybindings?.matches(key, APP_ACTION.keysHelp) !== true;
			const arrows = ["up", "down"].filter(available).map(displayedBinding).join("");
			const open = ["right", "enter"]
				.filter(available)
				.map((key) => (key === "enter" ? "\u21b5" : displayedBinding(key)))
				.join("/");
			const pages = ["pageUp", "pageDown"].filter(available).map(displayedBinding).join("/");
			const scroll = [blockers > 1 ? "" : arrows, pages].filter(Boolean).join(" ");
			return [
				...(available("escape")
					? [{ keys: "esc", label: keyOnly ? "" : mode === "full" ? "back to graph" : "back" }]
					: []),
				...(blockers > 1 && arrows ? [{ keys: arrows, label: keyOnly ? "" : "select" }] : []),
				...(blockers > 0 && open ? [{ keys: open, label: keyOnly ? "" : "open" }] : []),
				...(available("l") ? [{ keys: "l", label: keyOnly ? "" : this.runDetail.logs ? "summary" : "logs" }] : []),
				...(scroll ? [{ keys: scroll, label: keyOnly ? "" : "scroll" }] : []),
				help,
			];
		}
		const run = frameContext !== undefined ? frameContext.run : this._getCurrentRun();
		if (run === null) {
			return [
				{ keys: "esc", label: keyOnly ? "" : "back" },
				help,
				...(this.onHide && !this._keyShadowed("h") ? [{ keys: "h", label: keyOnly ? "" : "hide" }] : []),
			];
		}
		const focused = frameContext !== undefined ? frameContext.focused : this.cachedLayout[this.focusedIndex]?.stage;
		const focusedTarget = this._stageChatTarget(focused);
		const moveKeys = this._movableArrows();
		const filtered = this.statusFilter !== "all";
		const openLabel =
			focused?.nodeKind === "tool"
				? "open tool detail"
				: focused?.status === "failed" && focusedTarget !== undefined
					? "open failure detail"
					: focusedTarget !== undefined
						? "open stage chat"
						: undefined;
		const backLabel = mode === "minimal" || (keyOnly && quitArmed) ? "" : "back";
		const back: NavKey = { keys: "esc", label: backLabel };
		const openText = mode === "full" ? openLabel! : mode === "compact" ? "open" : "";
		const open: NavKey[] = openLabel ? [{ keys: "\u21b5", label: openText }] : [];
		const detailsText = mode === "full" || mode === "compact" ? "details" : "";
		const details: NavKey[] =
			this._focusedStageDetailsAvailable(focused) && !this._keyShadowed("d")
				? [{ keys: "d", label: detailsText }]
				: [];
		const moveText = mode === "full" || mode === "compact" ? "move" : "";
		const move: NavKey[] = moveKeys ? [{ keys: moveKeys, label: moveText }] : [];

		const stopText = mode === "full" ? "stop stage" : keyOnly || (mode === "minimal" && quitArmed) ? "" : "stop";
		const stop = this._focusedStageStoppable(focused) ? [this._stopNavKey(stopText)] : [];
		const pauseText = mode === "full" ? "pause run" : keyOnly || (mode === "minimal" && quitArmed) ? "" : "pause";
		const resumeText = mode === "full" ? "resume run" : keyOnly || (mode === "minimal" && quitArmed) ? "" : "resume";
		const pauseOrResume: NavKey[] = [];
		if (this._runPausable(run) && !this._keyShadowed("p")) pauseOrResume.push({ keys: "p", label: pauseText });
		if (this._runResumable(run) && !this._keyShadowed("r")) pauseOrResume.push({ keys: "r", label: resumeText });
		const quitRunName = sanitizeToolTitleText(sliceHead(run.name, 24)).trim() || run.id;
		const quitNameBudget =
			mode === "full" ? 12 : mode === "compact" ? 10 : mode === "tight" ? 7 : mode === "minimal" ? 6 : 0;
		const armedQuitName = ellipsizeQuitName(quitRunName, quitNameBudget);
		const quitText = quitArmed
			? armedQuitName.length > 0
				? `again to quit ${armedQuitName}`
				: "again to quit"
			: mode === "full"
				? "quit run"
				: keyOnly
					? ""
					: "quit";
		const quit: NavKey[] = this._runQuittable(run) && !this._keyShadowed("q") ? [{ keys: "q", label: quitText }] : [];
		const stagesText = mode === "full" || mode === "compact" ? "stages" : "";
		const stages: NavKey[] = this._keyShadowed("/") ? [] : [{ keys: "/", label: stagesText }];
		const filterText =
			mode === "full"
				? `filter: ${this.statusFilter}`
				: mode === "compact"
					? filtered
						? `filter: ${this.statusFilter}`
						: "filter"
					: mode === "tight"
						? filtered
							? `filter: ${this.statusFilter}`
							: ""
						: "";
		const filter: NavKey[] = this._keyShadowed("f") ? [] : [{ keys: "f", label: filterText }];
		const hideText = mode === "full" || mode === "compact" ? "hide" : "";
		const hide: NavKey[] = this.onHide && !this._keyShadowed("h") ? [{ keys: "h", label: hideText }] : [];
		return [
			back,
			...open,
			...details,
			...move,
			...stop,
			...pauseOrResume,
			...quit,
			...stages,
			...filter,
			help,
			...hide,
			...(!this._navKeybindings()?.matches("o", APP_ACTION.keysHelp) ? [{ keys: "o", label: "run details" }] : []),
		];
	}

	private _fitGraphKeys(
		frameContext: { readonly run: RunSnapshot | null; readonly focused: StageSnapshot | undefined } | undefined,
		budget: number,
		render: (entries: readonly NavKey[]) => { width: number; styled: string },
	): { width: number; styled: string } {
		const tiers = (["compact", "tight", "minimal", "keys"] as const).map((tier) =>
			this._graphKeys(tier, frameContext),
		);
		const base = tiers[tiers.length - 1]!;
		const isHelp = (entry: NavKey) =>
			entry.action === APP_ACTION.keysHelp || (entry.action === undefined && entry.keys === "?");
		const backIndex = base.findIndex((entry) => entry.keys === "esc");
		const helpIndex = base.findIndex(isHelp);
		const quitIndex = base.findIndex((entry) => entry.keys === "q" && entry.label.startsWith("again"));
		const labels = new Map<number, string>();
		if (backIndex >= 0) labels.set(backIndex, tiers[0]![backIndex]?.label || "back");
		if (helpIndex >= 0) labels.set(helpIndex, "keys");
		const kept = new Set([backIndex, helpIndex].filter((index) => index >= 0));
		const measure = () =>
			render(
				base.flatMap((entry, index) =>
					kept.has(index) ? [{ ...entry, label: labels.get(index) ?? entry.label }] : [],
				),
			);
		if (quitIndex >= 0) {
			const variants = [...new Set([...tiers.map((tier) => tier[quitIndex]?.label ?? ""), "again"])];
			kept.add(quitIndex);
			const fitting = variants.find((label) => {
				labels.set(quitIndex, label);
				return measure().width <= budget;
			});
			if (fitting === undefined) {
				kept.delete(quitIndex);
				labels.delete(quitIndex);
			}
		}
		for (let index = 0; index < base.length; index++) {
			if (kept.has(index)) continue;
			kept.add(index);
			if (measure().width > budget) {
				kept.delete(index);
				break;
			}
		}
		return measure();
	}

	protected _activeGraphNotice(): { text: string; tone: "info" | "error" } | null {
		const notice = this.graphNotice;
		if (notice === null) return null;
		if (Date.now() > notice.until) {
			this.graphNotice = null;
			return null;
		}
		return notice;
	}

	protected _renderStatusline(width: number): string[] {
		const t = this.graphTheme;
		const chromeBg = hexBg(t.backgroundPanel);
		const text = hexToAnsi(t.text);
		const muted = hexToAnsi(t.textMuted);
		const dim = hexToAnsi(t.dim);
		const accent = hexToAnsi(t.accent);

		const { top, mid, bot, visibleWidth: pillW } = renderOutlinePill(MODE_PILL_LABEL, t.accent, chromeBg);

		const wideSep = `${chromeBg}  ${dim}\u00b7${RESET}${chromeBg}  `;
		const tightSep = `${chromeBg} ${dim}\u00b7${RESET}${chromeBg} `;
		const leftEdgePad = 1;
		const rightEdgePad = 2;
		const hintsBudget = Math.max(0, width - leftEdgePad - pillW - rightEdgePad);
		const keybindings = this._navKeybindings();

		const frameContext =
			this.toolDetail === null && this.stageDetail === null
				? {
						run: this._getCurrentRun(),
						focused: this.cachedLayout[this.focusedIndex]?.stage,
					}
				: undefined;
		const renderEntries = (
			entries: readonly NavKey[],
			sepText: string,
			sepStyled: string,
			includeRunDetails = false,
		) => {
			const taken = new Set<string>();
			const plainParts: string[] = [];
			const styledParts: string[] = [];
			for (const entry of entries) {
				if (entry.keys === "o" && entry.label === "run details" && !includeRunDetails) continue;
				const parts = navEntryKeyParts(keybindings, entry, taken);
				const keys = parts.map((part) => part.text).join("");
				if (!keys) continue;
				plainParts.push(entry.label.length > 0 ? `${keys} ${entry.label}` : keys);
				styledParts.push(
					clickableKeysHint(
						parts.map((part) => ({ ...part, text: `${text}${boldOn()}${part.text}${RESET}${chromeBg}` })),
						entry.label.length > 0 ? ` ${muted}${entry.label}${RESET}${chromeBg}` : "",
					),
				);
			}
			return {
				width: visibleWidth(plainParts.join(sepText)),
				styled: styledParts.join(sepStyled),
			};
		};
		const buildRendered = (mode: GraphKeyTier, sepText: string, sepStyled: string, includeRunDetails = false) =>
			renderEntries(this._graphKeys(mode, frameContext), sepText, sepStyled, includeRunDetails);
		const candidates: ReadonlyArray<readonly [GraphKeyTier, string, string]> = [
			["full", "  \u00b7  ", wideSep],
			["full", " \u00b7 ", tightSep],
			["compact", "  \u00b7  ", wideSep],
			["compact", " \u00b7 ", tightSep],
			["tight", " \u00b7 ", tightSep],
			["minimal", " \u00b7 ", tightSep],
			["keys", " \u00b7 ", tightSep],
		];
		const keepsExits = (mode: GraphKeyTier): boolean =>
			this._graphKeys(mode, frameContext).every((entry) =>
				entry.keys === "esc" ||
				entry.action === APP_ACTION.keysHelp ||
				(entry.action === undefined && entry.keys === "?")
					? entry.label.length > 0
					: true,
			);
		let chosen: { width: number; styled: string } | undefined;
		for (const [mode, sepText, sepStyled] of candidates) {
			const candidate = buildRendered(mode, sepText, sepStyled);
			chosen = candidate;
			if (candidate.width <= hintsBudget && keepsExits(mode)) {
				const withRunDetails = buildRendered(mode, sepText, sepStyled, true);
				if (mode === "full" && withRunDetails.width <= hintsBudget) chosen = withRunDetails;
				break;
			}
			chosen = { width: Number.POSITIVE_INFINITY, styled: candidate.styled };
		}
		if (chosen !== undefined && chosen.width > hintsBudget) {
			chosen = this._fitGraphKeys(frameContext, hintsBudget, (entries) =>
				renderEntries(entries, " \u00b7 ", tightSep),
			);
		}
		const chosenHints = chosen ?? buildRendered("keys", " \u00b7 ", tightSep);
		const notice = this._activeGraphNotice();
		const statusText = this._externalStatusText();

		const toastText = notice?.text ?? statusText;
		const toastColor = notice ? hexToAnsi(notice.tone === "error" ? t.error : t.accent) : accent;
		const hintsStyled = truncateToWidth(chosenHints.styled, hintsBudget, "");
		const hintsVisibleLen = visibleWidth(hintsStyled);
		const fillerVisible = Math.max(0, hintsBudget - hintsVisibleLen);
		const filler = " ".repeat(fillerVisible);
		const acrossWidth = Math.max(0, width - leftEdgePad - pillW);
		const blankAcross = " ".repeat(acrossWidth);
		const toastBudget = Math.max(0, acrossWidth - rightEdgePad);
		const toast = toastText ? truncateToWidth(noticeDisplayText(toastText, toastBudget), toastBudget, "\u2026") : "";
		const toastRow = toast
			? `${chromeBg}${" ".repeat(Math.max(0, toastBudget - visibleWidth(toast)))}${toastColor}${toast}${RESET}${chromeBg}${" ".repeat(rightEdgePad)}`
			: blankAcross;

		return [
			`${chromeBg} ${RESET}${top}${chromeBg}${toastRow}${RESET}`,
			`${chromeBg} ${RESET}${mid}${chromeBg}${filler}${hintsStyled}${chromeBg}${" ".repeat(rightEdgePad)}${RESET}`,
			`${chromeBg} ${RESET}${bot}${chromeBg}${blankAcross}${RESET}`,
		].map((line) => fillBackground(line, width, chromeBg));
	}

	/** Blank canvas row uses the terminal's background. */
	protected _blankRow(width: number): string {
		return `${DEFAULT_BG}${" ".repeat(width)}${RESET}`;
	}

	protected _centerCanvasContent(content: string, width: number): string {
		const truncated = truncateToWidth(content, width, "…");
		const leftPad = Math.max(0, Math.floor((width - visibleWidth(truncated)) / 2));
		return `${" ".repeat(leftPad)}${truncated}`;
	}

	/** Restore the terminal background around content and trailing fill. */
	protected _canvasRow(content: string, width: number): string {
		const bg = DEFAULT_BG;
		const truncated = truncateToWidth(content, width, "…");
		const padLen = Math.max(0, width - visibleWidth(truncated));
		return `${bg}${truncated}${bg}${" ".repeat(padLen)}${RESET}`;
	}

	/** Pad pre-styled content without carrying a card background into the fill. */
	protected _padCanvas(content: string, width: number): string {
		const bg = DEFAULT_BG;
		const padLen = Math.max(0, width - visibleWidth(content));
		return `${bg}${content}${bg}${" ".repeat(padLen)}${RESET}`;
	}

	/**
	 * Compose a pre-styled card line over a canvas row at `leftPad` columns.
	 * The base row keeps its `bg` (so background colour matches canvas);
	 * the card slice replaces the cells starting at `leftPad`, and the
	 * residual columns to the right are repainted with bg.
	 *
	 * We don't try to keep the parts of `base` that fall *under* the card
	 * — pi-tui paints flat lines, not z-buffered cells, so the card's panel
	 * background winning is fine.
	 */
	protected _overlayCard(_base: string, cardLine: string, leftPad: number, totalWidth: number): string {
		const bg = DEFAULT_BG;
		const cardW = visibleWidth(cardLine);
		const rightPadLen = Math.max(0, totalWidth - leftPad - cardW);
		return `${bg}${" ".repeat(leftPad)}${RESET}${cardLine}${bg}${" ".repeat(rightPadLen)}${RESET}`;
	}

	protected _clampGraphHorizontalScroll(totalCols: number, viewportCols: number): void {
		const maxOffset = Math.max(0, totalCols - viewportCols);
		this.graphScrollColOffset = Math.max(0, Math.min(maxOffset, this.graphScrollColOffset));
	}

	protected _scrollFocusedColumnIntoView(viewportCols: number, totalCols: number): void {
		const node = this.cachedLayout[this.focusedIndex];
		if (!node) return;
		const start = node.x;
		const end = node.x + NODE_W - 1;
		if (start < this.graphScrollColOffset) {
			this.graphScrollColOffset = start;
		} else if (end >= this.graphScrollColOffset + viewportCols) {
			this.graphScrollColOffset = end - viewportCols + 1;
		}
		this._clampGraphHorizontalScroll(totalCols, viewportCols);
	}
	/**
	 * Plot a parent → child edge for the vertical orientation. The edge
	 * exits from the parent's bottom-centre, runs through a horizontal
	 * spine half-way down the gap, and re-enters from the child's
	 * top-centre. Cells are merged by direction set so fan-out, fan-in,
	 * and crossings produce stable orthogonal junctions instead of
	 * stacked rounded corners.
	 */
	protected _plotEdge(
		canvas: GraphCanvas,
		px: number,
		py: number,
		cx: number,
		cy: number,
		color: string,
		parentHeight = NODE_H,
	): void {
		const parentCol = px + Math.floor(NODE_W / 2);
		const childCol = cx + Math.floor(NODE_W / 2);
		const parentExitRow = py + parentHeight; // first row below parent's bottom border
		const childEntryRow = cy - 1; // last row above child's top border
		if (childEntryRow < parentExitRow) return;

		if (parentCol === childCol) {
			canvas.vline(parentCol, parentExitRow, childEntryRow, color);
			return;
		}

		const spineRow = Math.max(
			parentExitRow,
			Math.min(childEntryRow, Math.floor((parentExitRow + childEntryRow) / 2)),
		);

		// Down stub from parent into the spine row.
		if (spineRow > parentExitRow) {
			canvas.vline(parentCol, parentExitRow, spineRow - 1, color);
		}
		this._placeJunction(canvas, spineRow, parentCol, ["u", childCol > parentCol ? "r" : "l"], color);

		// Horizontal spine segment.
		const hloCol = Math.min(parentCol, childCol) + 1;
		const hhiCol = Math.max(parentCol, childCol) - 1;
		if (hhiCol >= hloCol) {
			canvas.hline(spineRow, hloCol, hhiCol, color);
		}
		this._placeJunction(canvas, spineRow, childCol, [childCol > parentCol ? "l" : "r", "d"], color);

		// Down stub from spine into child.
		if (childEntryRow > spineRow) {
			canvas.vline(childCol, spineRow + 1, childEntryRow, color);
		}
	}

	protected _placeJunction(
		canvas: GraphCanvas,
		row: number,
		col: number,
		newDirs: Array<"u" | "d" | "l" | "r">,
		color: string,
	): void {
		canvas.mergeCell(row, col, newDirs, color);
	}

	/**
	 * Split the canvas-rendered edge row at card boundaries into spans of
	 * `{ startCol, visibleWidth, content }` so the composer can interleave
	 * cards without colliding.
	 */
	protected _edgeRowToCells(line: string): string {
		return line;
	}

	/**
	 * Interleave a single edge row with the node cards that cross it.
	 * Cards take precedence at their column ranges; edge characters fill
	 * the gaps. Returns one composed line padded with spaces.
	 */
	protected _composeRow(
		edgeRow: string,
		cards: Array<{ startCol: number; width: number; line: string }>,
		_edgeColor: string,
	): string {
		const bg = DEFAULT_BG;
		const sorted = cards.slice().sort((a, b) => a.startCol - b.startCol);
		let cursor = 0;
		let out = "";
		for (const card of sorted) {
			if (card.startCol > cursor) {
				// Restore the canvas background after any preceding card.
				out += `${bg}${this._edgeSegment(edgeRow, cursor, card.startCol)}`;
				cursor = card.startCol;
			}
			// Column slicing can drop the closing reset. Keep the card's style inside its border.
			out += `${card.line}${RESET}`;
			cursor += card.width;
		}
		// Trailing edge tail — same bg re-priming.
		out += `${bg}${this._edgeSegment(edgeRow, cursor, Math.max(cursor, visibleWidth(edgeRow)))}`;
		return out;
	}

	protected _edgeSegment(line: string, fromCol: number, toCol: number): string {
		if (fromCol >= toCol) return "";
		const segment = this._sliceColumns(line, fromCol, toCol);
		const visible = visibleWidth(segment);
		return `${segment}${" ".repeat(Math.max(0, toCol - fromCol - visible))}`;
	}

	protected _sliceColumns(line: string, fromCol: number, toCol: number): string {
		if (fromCol >= toCol) return "";
		return slicedColumnSegments.get(`${fromCol}\0${toCol}\0${line}`, () =>
			sliceColumns(line, fromCol, toCol - fromCol, true),
		);
	}
}
