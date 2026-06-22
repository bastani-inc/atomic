import type { Theme } from "@bastani/atomic";
import { type Component, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type BoardDetails, type Cell, type GameState, type GameStatus, getWinLine } from "./tic-tac-toe-state.js";

// ---------------------------------------------------------------------------
// Visual board rendering (ANSI).
// - Cells have NO background fill. Only the centered glyph is drawn.
// - Played cells color their glyph AND their surrounding borders in the
//   player's color, so each mark reads as a colored boxed region.
// - Cursor is indicated with colored borders around the cursor cell.
// ---------------------------------------------------------------------------

const CELL_WIDTH = 7;
const CELL_HEIGHT = 3;

// Player colors (SGR fg codes). Also used for the borders of played cells.
const FG_CODE_X = "34"; // blue
const FG_CODE_O = "33"; // yellow
const FG_CODE_WIN = "32"; // green (overrides on the winning line)

// Single-character glyphs, picked for maximum visual size without emoji.
// - \u2573 (BOX DRAWINGS LIGHT DIAGONAL CROSS) for X
// - \u25ef (LARGE CIRCLE) for O
const GLYPH_X = "\u2573";
const GLYPH_O = "\u25ef";

const DIM = (s: string) => `\x1b[2m${s}\x1b[22m`;
const RESET = "\x1b[0m";

function centerPad(content: string, width: number): string {
	const contentLen = visibleWidth(content);
	if (contentLen >= width) return truncateToWidth(content, width);
	const pad = width - contentLen;
	const left = Math.floor(pad / 2);
	return " ".repeat(left) + content + " ".repeat(pad - left);
}

// Fg color for a played cell's glyph and its surrounding borders. Undefined
// for empty cells.
function cellFgCode(cell: Cell, isWin: boolean): string | undefined {
	if (cell === " ") return undefined;
	if (isWin) return FG_CODE_WIN;
	return cell === "X" ? FG_CODE_X : FG_CODE_O;
}

function buildCellContent(mark: Cell, lineIdx: number, isWin: boolean): string {
	const empty = " ".repeat(CELL_WIDTH);
	if (mark === " ") return empty;

	const isMidLine = lineIdx === Math.floor(CELL_HEIGHT / 2);
	if (!isMidLine) return empty;

	const glyph = mark === "X" ? GLYPH_X : GLYPH_O;
	const fg = cellFgCode(mark, isWin) as string;
	const padLen = CELL_WIDTH - visibleWidth(glyph);
	const leftPad = Math.floor(padLen / 2);
	const rightPad = padLen - leftPad;
	return `${" ".repeat(leftPad)}\x1b[${fg};1m${glyph}${RESET}${" ".repeat(rightPad)}`;
}

// Fg color for a border char based on its adjacent cells. Undefined when no
// adjacent cell is played or when adjacent plays disagree (border stays dim
// to show the separation).
function borderFgCode(adjacent: ReadonlyArray<{ cell: Cell; isWin: boolean }>): string | undefined {
	const fgs = adjacent.map((a) => cellFgCode(a.cell, a.isWin)).filter((f): f is string => !!f);
	if (fgs.length === 0) return undefined;
	const first = fgs[0];
	return fgs.every((f) => f === first) ? first : undefined;
}

interface BoardRenderOpts {
	board: Cell[][];
	maxWidth: number;
	// Optional cursor overlay. Omit to render a static snapshot (used in tool
	// results, move messages, and the game-over banner).
	cursor?: { row: number; col: number; owner: "user" | "agent" };
}

function renderBoard(opts: BoardRenderOpts): string[] {
	const { board, maxWidth, cursor } = opts;
	const showCursor = !!cursor;
	const cr = cursor?.row ?? -1;
	const cc = cursor?.col ?? -1;

	// Green for user cursor, yellow for agent cursor.
	const cursorSgr = cursor?.owner === "agent" ? "\x1b[33;1m" : "\x1b[32;1m";

	const winLine = getWinLine(board);
	const winCells = new Set((winLine ?? []).map(([r, c]) => `${r},${c}`));
	const cellAt = (r: number, c: number) => ({ cell: board[r][c], isWin: winCells.has(`${r},${c}`) });

	const isCursorCorner = (gridR: number, gridC: number): boolean =>
		showCursor && (gridR === cr || gridR === cr + 1) && (gridC === cc || gridC === cc + 1);
	const isCursorHSegment = (gridR: number, c: number): boolean =>
		showCursor && c === cc && (gridR === cr || gridR === cr + 1);
	const isCursorVBorder = (r: number, gridC: number): boolean =>
		showCursor && r === cr && (gridC === cc || gridC === cc + 1);

	const paintBorder = (ch: string, highlighted: boolean, fgCode: string | undefined): string => {
		if (highlighted) return `${cursorSgr}${ch}${RESET}`;
		if (fgCode) return `\x1b[${fgCode};1m${ch}${RESET}`;
		return DIM(ch);
	};

	const cornerChar = (gridR: number, gridC: number): string => {
		if (gridR === 0 && gridC === 0) return "\u250c";
		if (gridR === 0 && gridC === 3) return "\u2510";
		if (gridR === 3 && gridC === 0) return "\u2514";
		if (gridR === 3 && gridC === 3) return "\u2518";
		if (gridR === 0) return "\u252c";
		if (gridR === 3) return "\u2534";
		if (gridC === 0) return "\u251c";
		if (gridC === 3) return "\u2524";
		return "\u253c";
	};

	const cornerAdjacent = (gridR: number, gridC: number) => {
		const out: { cell: Cell; isWin: boolean }[] = [];
		for (const [dr, dc] of [
			[-1, -1],
			[-1, 0],
			[0, -1],
			[0, 0],
		]) {
			const r = gridR + dr;
			const c = gridC + dc;
			if (r >= 0 && r < 3 && c >= 0 && c < 3) out.push(cellAt(r, c));
		}
		return out;
	};

	const lines: string[] = [];

	for (let gridR = 0; gridR <= 3; gridR++) {
		// Horizontal border row.
		let row = "";
		for (let gridC = 0; gridC <= 3; gridC++) {
			const cornerColor = borderFgCode(cornerAdjacent(gridR, gridC));
			row += paintBorder(cornerChar(gridR, gridC), isCursorCorner(gridR, gridC), cornerColor);
			if (gridC < 3) {
				const adj: { cell: Cell; isWin: boolean }[] = [];
				if (gridR > 0) adj.push(cellAt(gridR - 1, gridC));
				if (gridR < 3) adj.push(cellAt(gridR, gridC));
				const segColor = borderFgCode(adj);
				row += paintBorder("\u2500".repeat(CELL_WIDTH), isCursorHSegment(gridR, gridC), segColor);
			}
		}
		lines.push(centerPad(row, maxWidth));

		if (gridR === 3) break;

		for (let lineIdx = 0; lineIdx < CELL_HEIGHT; lineIdx++) {
			let contentRow = "";
			for (let gridC = 0; gridC <= 3; gridC++) {
				const adj: { cell: Cell; isWin: boolean }[] = [];
				if (gridC > 0) adj.push(cellAt(gridR, gridC - 1));
				if (gridC < 3) adj.push(cellAt(gridR, gridC));
				const vColor = borderFgCode(adj);
				contentRow += paintBorder("\u2502", isCursorVBorder(gridR, gridC), vColor);
				if (gridC < 3) {
					contentRow += buildCellContent(board[gridR][gridC], lineIdx, winCells.has(`${gridR},${gridC}`));
				}
			}
			lines.push(centerPad(contentRow, maxWidth));
		}
	}

	return lines;
}

// Full TUI board with the right cursor overlayed for the current turn.
function renderVisualBoard(state: GameState, maxWidth: number): string[] {
	const isUserTurn = state.currentTurn === state.userMark;
	const cursor =
		state.status !== "playing"
			? undefined
			: {
					row: isUserTurn ? state.userCursorRow : state.agentCursorRow,
					col: isUserTurn ? state.userCursorCol : state.agentCursorCol,
					owner: (isUserTurn ? "user" : "agent") as "user" | "agent",
				};
	return renderBoard({ board: state.board, maxWidth, cursor });
}

/** Static snapshot used inside tool results and custom messages. */
export function renderBoardSnapshot(board: Cell[][], maxWidth: number): string[] {
	return renderBoard({ board, maxWidth });
}

export class TicTacToeComponent implements Component {
	private state: GameState;
	private onClose: () => void;
	private onUserPlay: (row: number, col: number) => void;
	private tui: { requestRender: () => void };
	private cachedLines: string[] = [];
	private cachedWidth = 0;
	private version = 0;
	private cachedVersion = -1;

	constructor(
		tui: { requestRender: () => void },
		onClose: () => void,
		onUserPlay: (row: number, col: number) => void,
		state: GameState,
	) {
		this.tui = tui;
		this.onClose = onClose;
		this.onUserPlay = onUserPlay;
		this.state = state;
	}

	updateState(state: GameState): void {
		this.state = state;
		this.version++;
		this.tui.requestRender();
	}

	handleInput(data: string): boolean {
		if (matchesKey(data, "escape") || data === "q" || data === "Q") {
			this.onClose();
			return true;
		}
		if (this.state.status !== "playing") {
			if (data === "r" || data === "R") {
				this.onClose();
				return true;
			}
			return true;
		}
		if (this.state.currentTurn !== this.state.userMark) return true;

		if (matchesKey(data, "up") && this.state.userCursorRow > 0) {
			this.state.userCursorRow--;
			this.version++;
			this.tui.requestRender();
		} else if (matchesKey(data, "down") && this.state.userCursorRow < 2) {
			this.state.userCursorRow++;
			this.version++;
			this.tui.requestRender();
		} else if (matchesKey(data, "left") && this.state.userCursorCol > 0) {
			this.state.userCursorCol--;
			this.version++;
			this.tui.requestRender();
		} else if (matchesKey(data, "right") && this.state.userCursorCol < 2) {
			this.state.userCursorCol++;
			this.version++;
			this.tui.requestRender();
		} else if (matchesKey(data, "return") || data === " ") {
			const { userCursorRow, userCursorCol } = this.state;
			if (this.state.board[userCursorRow][userCursorCol] === " ") {
				this.onUserPlay(userCursorRow, userCursorCol);
			}
		}
		return true;
	}

	invalidate(): void {
		this.cachedWidth = 0;
	}

	render(width: number): string[] {
		if (width === this.cachedWidth && this.cachedVersion === this.version) {
			return this.cachedLines;
		}

		const ESC = "\x1b[";
		const reset = `${ESC}0m`;
		const bold = (s: string) => `${ESC}1m${s}${reset}`;
		const dim = (s: string) => `${ESC}2m${s}${reset}`;
		const blue = (s: string) => `${ESC}34m${s}${reset}`;
		const yellow = (s: string) => `${ESC}33m${s}${reset}`;
		const green = (s: string) => `${ESC}32m${s}${reset}`;

		const lines: string[] = [];

		// Top title banner, full width.
		const titleText = " Tic-Tac-Toe ";
		const titleLen = visibleWidth(titleText);
		const borderLen = Math.max(0, width - titleLen);
		const leftBorder = Math.floor(borderLen / 2);
		const rightBorder = borderLen - leftBorder;
		lines.push(dim("\u2500".repeat(leftBorder)) + bold(blue(titleText)) + dim("\u2500".repeat(rightBorder)));

		lines.push("");

		// Status line.
		if (this.state.status !== "playing") {
			const statusText =
				this.state.status === "draw"
					? bold(yellow("Draw!"))
					: this.state.status === "win_X"
						? bold(green("X wins!"))
						: bold(yellow("O wins!"));
			lines.push(centerPad(statusText, width));
		} else if (this.state.currentTurn === "X") {
			lines.push(centerPad(`Turn: ${bold(blue("X"))} (You)  ${dim("|")}  ${bold(yellow("O"))} (Agent)`, width));
		} else {
			lines.push(centerPad(`${blue("X")} (You)  ${dim("|")}  Turn: ${bold(yellow("O"))} (Agent)`, width));
		}

		lines.push("", "", ...renderVisualBoard(this.state, width), "", "");

		// Footer.
		let footer: string;
		if (this.state.status !== "playing") {
			footer = `${bold("R")} restart  ${dim("|")}  ${bold("Q")}/${bold("ESC")} quit`;
		} else if (this.state.currentTurn !== this.state.userMark) {
			footer = dim("Agent is thinking...");
		} else {
			footer = `${bold("\u2190\u2191\u2193\u2192")} move  ${dim("|")}  ${bold("ENTER")} play  ${dim("|")}  ${bold("ESC")} quit`;
		}
		lines.push(centerPad(footer, width));

		// Bottom separator between the component and the editor below.
		lines.push("", dim("\u2500".repeat(width)));

		this.cachedLines = lines;
		this.cachedWidth = width;
		this.cachedVersion = this.version;
		return lines;
	}
}

// Full-width banner message with an optional board snapshot underneath.
export class BannerMessageComponent implements Component {
	private readonly title: string;
	private readonly details: BoardDetails | undefined;
	private readonly expanded: boolean;
	private readonly theme: Theme;

	constructor(title: string, details: BoardDetails | undefined, expanded: boolean, theme: Theme) {
		this.title = title;
		this.details = details;
		this.expanded = expanded;
		this.theme = theme;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const dim = (s: string) => this.theme.fg("dim", s);
		const lines: string[] = [];
		const titleLen = visibleWidth(this.title);
		const fillLen = Math.max(0, width - titleLen - 2);
		const leftFill = Math.floor(fillLen / 2);
		const rightFill = fillLen - leftFill;
		lines.push(`${dim("\u2500".repeat(leftFill))} ${this.title} ${dim("\u2500".repeat(rightFill))}`);

		if (this.expanded && this.details) {
			lines.push("", ...renderBoardSnapshot(this.details.board, width));
		}

		return lines;
	}
}

// End-of-game banner: two dim hrs, a big colored title line, and the final
// board with the winning line highlighted.
export class GameOverMessageComponent implements Component {
	private readonly status: GameStatus;
	private readonly details: BoardDetails | undefined;
	private readonly theme: Theme;

	constructor(status: GameStatus, details: BoardDetails | undefined, theme: Theme) {
		this.status = status;
		this.details = details;
		this.theme = theme;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const dim = (s: string) => this.theme.fg("dim", s);
		const bold = (s: string) => this.theme.bold(s);

		const hr = dim("\u2500".repeat(width));
		const lines: string[] = [];
		lines.push(hr, "");

		let title: string;
		let sub: string;
		switch (this.status) {
			case "win_X":
				title = bold(this.theme.fg("accent", "\u2605 Player X wins \u2605"));
				sub = "You beat the agent.";
				break;
			case "win_O":
				title = bold(this.theme.fg("warning", "\u2605 Player O wins \u2605"));
				sub = "The agent beat you.";
				break;
			case "draw":
				title = bold(this.theme.fg("muted", "\u2014 Draw \u2014"));
				sub = "No winner.";
				break;
			default:
				title = bold("Game over");
				sub = "";
				break;
		}

		for (const line of [title, dim(sub)]) {
			const pad = Math.max(0, width - visibleWidth(line));
			lines.push(`${" ".repeat(Math.floor(pad / 2))}${line}`);
		}

		lines.push("");
		if (this.details) {
			lines.push(...renderBoardSnapshot(this.details.board, width), "");
		}
		lines.push(hr);

		return lines;
	}
}
