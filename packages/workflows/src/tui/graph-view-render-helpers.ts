import { type NavKey, type NavKeybindings, type NavKeyStyle, navEntryKeys } from "@bastani/atomic";
import { BOLD, DEFAULT_BG, fillBackground, hexBg, hexToAnsi, RESET } from "./color-utils.js";
import type { GraphCanvas } from "./graph-canvas.js";
import { MODE_PILL_LABEL } from "./graph-view-constants.js";
import { GraphViewState } from "./graph-view-state.js";
import { renderOutlinePill } from "./header.js";
import { APP_ACTION, isKeybindingsLike } from "./keybindings-adapter.js";
import { NODE_H, NODE_W } from "./layout.js";
import { BoundedTextCache, sliceColumns, truncateToWidth, visibleWidth } from "./text-helpers.js";
import { OVERLAY_HIDDEN_STATUS_KEYS, WORKFLOW_STATUS_KEY } from "./workflow-status.js";

const slicedColumnSegments = new BoundedTextCache(1024);

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

	/** Keybindings manager the hint line and `?` overlay resolve action keys through. */
	protected _navKeybindings(): NavKeybindings | undefined {
		return isKeybindingsLike(this.piKeybindings) ? (this.piKeybindings as NavKeybindings) : undefined;
	}

	/** The graph theme as the shared hint line and key overlay paint it. */
	protected _navKeyStyle(): NavKeyStyle {
		const t = this.graphTheme;
		return {
			dim: (text) => `${hexToAnsi(t.dim)}${text}${RESET}`,
			text: (text) => `${hexToAnsi(t.text)}${text}${RESET}`,
			muted: (text) => `${hexToAnsi(t.textMuted)}${text}${RESET}`,
			border: (text) => `${hexToAnsi(t.borderActive)}${text}${RESET}`,
			bold: (text) => `${hexToAnsi(t.text)}${BOLD}${text}${RESET}`,
		};
	}

	/**
	 * A remappable key: named by its action when the host's manager can resolve keys, otherwise by its default, which is
	 * what the graph matches without a manager.
	 */
	protected _actionKey(action: string, fallback: string, label: string): NavKey {
		return this._navKeybindings()?.getKeys ? { action, label } : { keys: fallback, label };
	}

	/** Whether `x x` can stop the focused stage: a host stop action and a stage that is still working. */
	protected _focusedStageStoppable(): boolean {
		if (this.stageActions?.stop === undefined) return false;
		const stage = this.cachedLayout[this.focusedIndex]?.stage;
		if (stage === undefined || this._stageChatTarget(stage) === undefined) return false;
		return stage.status === "running";
	}

	/**
	 * Every key the graph's current state answers to, in the order the hint line keeps them under width pressure: the
	 * way back first. The `?` overlay lists all of them; the hint line drops entries from the end until it fits.
	 */
	protected _graphKeys(compact = false): NavKey[] {
		const help = this._actionKey(APP_ACTION.keysHelp, "?", "keys");
		if (this.toolDetail !== null) {
			const expandKey = toolExpandKey(this.piKeybindings);
			return [
				{ keys: "esc", label: "back to graph" },
				{ keys: "\u2191\u2193 pgup/pgdn", label: "scroll" },
				...(expandKey.length > 0
					? [{ keys: expandKey, label: this.toolDetailExpanded ? "collapse" : "expand" }]
					: []),
				help,
			];
		}
		if (this.stageDetail !== null && this.forkConfirm !== null) {
			return [
				{ keys: "enter", label: "fork" },
				{ keys: "esc", label: "cancel" },
			];
		}
		if (this.stageDetail !== null) {
			const actions = this.stageActions;
			const canFork = actions?.fork !== undefined && actions.forkTarget !== undefined && this.runId !== null;
			return [
				{ keys: "esc", label: "back to graph" },
				...(actions?.retry ? [{ keys: "r", label: compact ? "retry" : "retry in place" }] : []),
				...(canFork ? [{ keys: "f", label: compact ? "fork from here" : "fork from this stage (reruns it)" }] : []),
				...(this.onStageAttach ? [{ keys: "t", label: "transcript" }] : []),
				{ keys: "l", label: this.stageDetail.logs ? "summary" : "logs" },
				...(this.stageDetail.logs ? [{ keys: "\u2191\u2193 pgup/pgdn", label: "scroll" }] : []),
				help,
			];
		}
		const focused = this.cachedLayout[this.focusedIndex]?.stage;
		const moveKeys = this._movableArrows();
		const filter: NavKey = { keys: "f", label: `filter: ${this.statusFilter}` };
		const filtered = this.statusFilter !== "all";
		const openLabel =
			focused?.nodeKind === "tool"
				? "open tool detail"
				: focused?.status === "failed" && this._focusedStageChatTarget() !== undefined
					? "open failure detail"
					: this._focusedStageChatTarget() !== undefined
						? "open stage chat"
						: undefined;
		const back: NavKey = { keys: "esc", label: "back" };
		const open: NavKey[] = openLabel ? [{ keys: "\u21b5", label: compact ? "open" : openLabel }] : [];
		const move: NavKey[] = moveKeys ? [{ keys: moveKeys, label: "move" }] : [];
		// What the focused stage and the view's state make possible comes before the always-available keys, so a
		// narrow hint line drops `/ stages` and `h hide` first; compact, it also comes ahead of opening and moving.
		const stop = this._focusedStageStoppable()
			? [this._actionKey(APP_ACTION.listStop, "x", compact ? "stop" : "stop stage")]
			: [];
		const stateful = [...stop, ...(filtered ? [filter] : [])];
		return [
			back,
			...(compact ? [...stateful, ...open, ...move] : [...open, ...move, ...stateful]),
			{ keys: "/", label: "stages" },
			...(filtered ? [] : [filter]),
			help,
			...(this.onHide ? [{ keys: "h", label: "hide" }] : []),
		];
	}

	/** The hint line's transient message, while it lasts. */
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
		// Hints use `<key> <label>` segments: the way back first and `? keys` last, which stay; under width pressure the
		// keys between them drop from the end, and `?` lists them all.
		const sep = `${chromeBg}  ${dim}\u00b7${RESET}${chromeBg}  `;
		const leftEdgePad = 1;
		const rightEdgePad = 2;
		const hintsBudget = Math.max(0, width - leftEdgePad - pillW - rightEdgePad);
		const keybindings = this._navKeybindings();
		const taken = new Set<string>();
		// Full labels while the keys that never drop (all but `/ stages`, `f filter: all` and `h hide`) fit; compact ones
		// otherwise, so the keys for this stage stay on screen.
		const fits = (entries: readonly NavKey[]): boolean => {
			const taken = new Set<string>();
			const kept = entries.filter(
				(entry) =>
					entry.keys !== "/" && entry.keys !== "h" && !(entry.keys === "f" && entry.label === "filter: all"),
			);
			const texts = kept.flatMap((entry) => {
				const keys = navEntryKeys(keybindings, entry, taken);
				return keys ? [`${keys} ${entry.label}`] : [];
			});
			return visibleWidth(texts.join("  \u00b7  ")) <= hintsBudget;
		};
		const full = this._graphKeys();
		const entries = fits(full) ? full : this._graphKeys(true);
		let helpSegment: string | undefined;
		const segments = entries.flatMap((entry) => {
			const keys = navEntryKeys(keybindings, entry, taken);
			if (!keys) return [];
			const segment = `${text}${BOLD}${keys}${RESET}${chromeBg} ${muted}${entry.label}${RESET}${chromeBg}`;
			if (entry.action === APP_ACTION.keysHelp || (entry.keys === "?" && entry.label === "keys")) {
				helpSegment = segment;
				return [];
			}
			return [segment];
		});
		const withHelp = (): string[] => (helpSegment ? [...segments, helpSegment] : segments);
		const notice = this._activeGraphNotice();
		const statusText = this._externalStatusText();
		// A notice (the first `x`, an action's result, a stop-all prompt or an extension status) gets its own row above
		// the hint line, so the hint line keeps every key it can fit at any width.
		const toastText = notice?.text ?? statusText;
		const toastColor = notice ? hexToAnsi(notice.tone === "error" ? t.error : t.accent) : accent;
		while (segments.length > 1 && visibleWidth(withHelp().join(sep)) > hintsBudget) segments.pop();
		const hintsStyled = truncateToWidth(withHelp().join(sep), hintsBudget, "");
		const hintsVisibleLen = visibleWidth(hintsStyled);
		const fillerVisible = Math.max(0, hintsBudget - hintsVisibleLen);
		const filler = " ".repeat(fillerVisible);
		const acrossWidth = Math.max(0, width - leftEdgePad - pillW);
		const blankAcross = " ".repeat(acrossWidth);
		const toastBudget = Math.max(0, acrossWidth - rightEdgePad);
		const toast = toastText ? truncateToWidth(toastText, toastBudget, "\u2026") : "";
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
			out += card.line;
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
