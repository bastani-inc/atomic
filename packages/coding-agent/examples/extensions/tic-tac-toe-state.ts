// Thrown from the tool on illegal actions. The agent runtime surfaces thrown
// errors as tool errors (isError=true) without resetting any of our state.
export class TicTacToeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TicTacToeError";
	}
}

export type Cell = " " | "X" | "O";
export type GameStatus = "playing" | "win_X" | "win_O" | "draw";

export interface GameState {
	board: Cell[][];
	// User cursor (TUI-only, never exposed to the agent).
	userCursorRow: number;
	userCursorCol: number;
	// Agent cursor (manipulated by the tool, shown in the TUI during O's turn).
	agentCursorRow: number;
	agentCursorCol: number;
	status: GameStatus;
	userMark: Cell;
	agentMark: Cell;
	currentTurn: Cell;
}

// Persisted with each toolResult for state reconstruction AND sent to the
// agent as `details`. Only the agent cursor is included: the user cursor is
// private to the TUI.
export interface BoardDetails {
	board: Cell[][];
	agentCursorRow: number;
	agentCursorCol: number;
	status: GameStatus;
	currentTurn: Cell;
}

// Agent cursor home: where the cursor is reset to after a SUCCESSFUL play.
// Pinned at (0,0) so every non-origin play requires at least one move, which
// guarantees multiple tool calls per turn and makes the parallel-vs-sequential
// behavior observable in the demo. The cursor is NOT reset when the user plays
// nor on a failed `play` (cell taken), so the agent can retry without
// starting over.
export const AGENT_CURSOR_HOME_ROW = 0;
export const AGENT_CURSOR_HOME_COL = 0;

export function createInitialState(): GameState {
	return {
		board: [
			[" ", " ", " "],
			[" ", " ", " "],
			[" ", " ", " "],
		],
		userCursorRow: 1,
		userCursorCol: 1,
		agentCursorRow: AGENT_CURSOR_HOME_ROW,
		agentCursorCol: AGENT_CURSOR_HOME_COL,
		status: "playing",
		userMark: "X",
		agentMark: "O",
		currentTurn: "X",
	};
}

export function getWinLine(board: Cell[][]): [number, number][] | null {
	const lines: [number, number][][] = [
		[
			[0, 0],
			[0, 1],
			[0, 2],
		],
		[
			[1, 0],
			[1, 1],
			[1, 2],
		],
		[
			[2, 0],
			[2, 1],
			[2, 2],
		],
		[
			[0, 0],
			[1, 0],
			[2, 0],
		],
		[
			[0, 1],
			[1, 1],
			[2, 1],
		],
		[
			[0, 2],
			[1, 2],
			[2, 2],
		],
		[
			[0, 0],
			[1, 1],
			[2, 2],
		],
		[
			[0, 2],
			[1, 1],
			[2, 0],
		],
	];
	for (const line of lines) {
		const vals = line.map(([r, c]) => board[r][c]);
		if (vals[0] !== " " && vals[0] === vals[1] && vals[1] === vals[2]) {
			return line;
		}
	}
	return null;
}

export function checkWin(board: Cell[][]): GameStatus {
	const winLine = getWinLine(board);
	if (winLine) {
		const [r, c] = winLine[0];
		return board[r][c] === "X" ? "win_X" : "win_O";
	}
	if (board.every((row) => row.every((c) => c !== " "))) {
		return "draw";
	}
	return "playing";
}

export function boardToAscii(board: Cell[][], agentCursorRow: number, agentCursorCol: number): string {
	// Plain grid with coordinates for empty cells, marking the agent cursor
	// position with angle brackets. The user cursor is NEVER included: it is a
	// TUI-only concept and must not leak to the agent.
	const rows = board.map((row, r) =>
		row
			.map((c, cIdx) => {
				const onCursor = r === agentCursorRow && cIdx === agentCursorCol;
				if (c === " ") return onCursor ? `<[${r},${cIdx}]>` : ` [${r},${cIdx}] `;
				return onCursor ? `   <${c}>   ` : `    ${c}    `;
			})
			.join("|"),
	);
	const separator = "---------+---------+---------";
	return rows.join(`\n${separator}\n`);
}

export function toBoardDetails(state: GameState): BoardDetails {
	return {
		board: state.board.map((row) => [...row]),
		agentCursorRow: state.agentCursorRow,
		agentCursorCol: state.agentCursorCol,
		status: state.status,
		currentTurn: state.currentTurn,
	};
}

export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
