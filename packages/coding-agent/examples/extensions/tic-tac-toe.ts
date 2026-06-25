/*
 * Tic-Tac-Toe extension - demonstrates executionMode: "sequential" on tools.
 *
 * The user plays via /tic-tac-toe (arrow keys + Enter).
 * The agent plays via a single tool `tic_tac_toe` that takes ONE atomic action
 * per call. To play at (r, c) from its cursor (r0, c0) the agent must emit the
 * required move_* and a final `play` as SEPARATE tool_use blocks inside ONE
 * assistant response.
 *
 * Move actions share the agent cursor and have a 300ms delay. Under the
 * default parallel tool-execution mode this races: `play` can resolve before
 * the earlier `move_*` calls finish and O lands on the wrong cell. With
 * `executionMode: "sequential"` the runner serializes the sibling calls and O
 * lands on the intended cell.
 *
 * The user cursor (TUI-only) and the agent cursor (tool-only) are stored in
 * separate variables. Only the agent cursor is ever exposed to the agent.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, ToolExecutionMode } from "@bastani/atomic";
import { Type } from "typebox";
import { buildTicTacToeInstructions } from "./tic-tac-toe-instructions.js";
import { BannerMessageComponent, GameOverMessageComponent, TicTacToeComponent } from "./tic-tac-toe-rendering.js";
import {
	AGENT_CURSOR_HOME_COL,
	AGENT_CURSOR_HOME_ROW,
	TicTacToeError,
	boardToAscii,
	checkWin,
	createInitialState,
	delay,
	toBoardDetails,
	type BoardDetails,
	type GameState,
	type GameStatus,
} from "./tic-tac-toe-state.js";

const SAVE_TYPE = "tic-tac-toe-save";
const MOVE_MESSAGE_TYPE = "tic-tac-toe-move";
const GAME_OVER_MESSAGE_TYPE = "tic-tac-toe-game-over";

type Action = "move_up" | "move_down" | "move_left" | "move_right" | "play";

const ACTION_DELAYS: Record<Action, number> = {
	move_up: 300,
	move_down: 300,
	move_left: 300,
	move_right: 300,
	play: 0,
};

let gameState: GameState = createInitialState();
let component: TicTacToeComponent | null = null;
let gameActive = false;

function reconstructState(ctx: ExtensionContext): void {
	gameState = createInitialState();
	gameActive = false;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg.role !== "toolResult") continue;
		if (msg.toolName !== "tic_tac_toe" && msg.toolName !== "tic_tac_toe_see_board") continue;

		const details = msg.details as BoardDetails | undefined;
		if (details) {
			gameState.board = details.board.map((row) => [...row]);
			gameState.agentCursorRow = details.agentCursorRow;
			gameState.agentCursorCol = details.agentCursorCol;
			gameState.status = details.status;
			gameState.currentTurn = details.currentTurn;
		}
	}
}

function getBoardDetails(): BoardDetails {
	return toBoardDetails(gameState);
}

function applyCursorMove(action: Exclude<Action, "play">): string {
	switch (action) {
		case "move_up":
			if (gameState.agentCursorRow > 0) gameState.agentCursorRow--;
			return `Moved up. Cursor: (${gameState.agentCursorRow}, ${gameState.agentCursorCol})`;
		case "move_down":
			if (gameState.agentCursorRow < 2) gameState.agentCursorRow++;
			return `Moved down. Cursor: (${gameState.agentCursorRow}, ${gameState.agentCursorCol})`;
		case "move_left":
			if (gameState.agentCursorCol > 0) gameState.agentCursorCol--;
			return `Moved left. Cursor: (${gameState.agentCursorRow}, ${gameState.agentCursorCol})`;
		case "move_right":
			if (gameState.agentCursorCol < 2) gameState.agentCursorCol++;
			return `Moved right. Cursor: (${gameState.agentCursorRow}, ${gameState.agentCursorCol})`;
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

	// Sent once per game at end-of-game. The custom renderer paints the banner;
	// `content` is a plain-text fallback for any non-TUI consumer and for the
	// LLM (in case the message ends up in future context).
	const emitGameOverMessage = (): void => {
		const label =
			gameState.status === "win_X"
				? "Player X (human) wins"
				: gameState.status === "win_O"
					? "Player O (agent) wins"
					: gameState.status === "draw"
						? "Draw"
						: "Game over";
		pi.sendMessage({
			customType: GAME_OVER_MESSAGE_TYPE,
			content: `Game over: ${label}.`,
			display: true,
			details: getBoardDetails(),
		});
	};

	pi.registerMessageRenderer(MOVE_MESSAGE_TYPE, (message, { expanded }, theme) => {
		const details = message.details as BoardDetails | undefined;
		const turnLabel =
			details?.currentTurn === "O"
				? `${theme.fg("warning", theme.bold("O"))} (Agent)`
				: `${theme.fg("accent", theme.bold("X"))} (You)`;
		const title = `${theme.fg("accent", theme.bold("Player X played"))}  ${theme.fg("dim", "\u2192")}  next: ${turnLabel}`;
		return new BannerMessageComponent(title, details, expanded, theme);
	});

	pi.registerMessageRenderer(GAME_OVER_MESSAGE_TYPE, (message, _options, theme) => {
		const details = message.details as BoardDetails | undefined;
		const status = (details?.status ?? "draw") as GameStatus;
		return new GameOverMessageComponent(status, details, theme);
	});

	pi.on("before_agent_start", async (event) => {
		if (!gameActive) return undefined;
		return { systemPrompt: buildTicTacToeInstructions(event.systemPrompt) };
	});

	pi.registerCommand("tic-tac-toe", {
		description: "Play tic-tac-toe against the agent",

		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Tic-tac-toe requires interactive mode", "error");
				return;
			}

			reconstructState(ctx);
			if (gameState.status !== "playing") {
				gameState = createInitialState();
			}
			gameActive = true;
			pi.setSessionName("Tic-Tac-Toe");

			await ctx.ui.custom<void>((tui, _theme, _kb, done) => {
				component = new TicTacToeComponent(
					tui,
					() => {
						component = null;
						gameActive = false;
						done(undefined);
					},
					(row, col) => {
						gameState.board[row][col] = gameState.userMark;
						gameState.status = checkWin(gameState.board);
						if (gameState.status === "playing") {
							gameState.currentTurn = gameState.agentMark;
						}
						component?.updateState(gameState);
						pi.appendEntry(SAVE_TYPE, getBoardDetails());

						if (gameState.status === "playing") {
							// IMPORTANT: user play does NOT touch the agent cursor.
							// The agent cursor is only reset after a successful agent play.
							const boardAscii = boardToAscii(
								gameState.board,
								gameState.agentCursorRow,
								gameState.agentCursorCol,
							);
							pi.sendMessage(
								{
									customType: MOVE_MESSAGE_TYPE,
									content:
										`Player X played at (row=${row}, col=${col}). It is now Player O's turn.\n\n` +
										`Board (your cursor marked with <>):\n${boardAscii}\n\n` +
										`Your cursor is at (row=${gameState.agentCursorRow}, col=${gameState.agentCursorCol}). ` +
										`Decide your target cell, then emit every move_* and the final play ` +
										`as separate tic_tac_toe tool calls in THIS response.`,
									display: true,
									details: getBoardDetails(),
								},
								{ triggerTurn: true },
							);
						} else {
							emitGameOverMessage();
							gameActive = false;
						}
					},
					gameState,
				);
				return component;
			});
		},
	});

	pi.registerTool({
		name: "tic_tac_toe",
		label: "Tic-Tac-Toe",
		description:
			"Execute ONE tic-tac-toe action as Player O. `action` is exactly one of: move_up, move_down, move_left, move_right (move YOUR cursor one cell, clamped at edges), or play (place O under YOUR cursor; errors if the cell is not empty). There is no batched form. To play at (r, c) from your current cursor (r0, c0), emit the required move_down/move_up and move_right/move_left calls, then play, all as separate tool_use blocks in the SAME assistant response. Do not split the sequence across responses and do not wait for a result before emitting the next call. Your cursor position persists between turns and is reset to (0,0) only after a successful play.",
		promptSnippet: "Play a tic-tac-toe action (move_up/down/left/right or play) as Player O",
		promptGuidelines: [
			"When it is your tic-tac-toe turn, decide the target cell first, then emit every move_* plus the final play as separate tic_tac_toe tool calls in a SINGLE assistant response. Never split them across responses or wait for intermediate results.",
			"Never ask the user for the board. The board and your cursor position are included in the user's move message; use tic_tac_toe_see_board if you need them restated.",
		],
		parameters: Type.Object({
			action: StringEnum(["move_up", "move_down", "move_left", "move_right", "play"] as const, {
				description:
					"The single action to perform this call. Emit multiple tic_tac_toe calls in one response to string actions together.",
			}),
		}),
		executionMode: "sequential" as ToolExecutionMode,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const actionDelay = ACTION_DELAYS[params.action];
			if (actionDelay > 0) await delay(actionDelay);

			let result: string;
			if (params.action === "play") {
				result = handleAgentPlay(emitGameOverMessage, () => pi.appendEntry(SAVE_TYPE, getBoardDetails()));
			} else {
				result = applyCursorMove(params.action);
			}

			component?.updateState(gameState);
			pi.appendEntry(SAVE_TYPE, getBoardDetails());

			return {
				content: [{ type: "text", text: result }],
				details: getBoardDetails(),
			};
		},

		renderCall(args, theme) {
			const action = typeof args.action === "string" ? args.action : "";
			return new Text(theme.fg("toolTitle", theme.bold("tic_tac_toe ")) + theme.fg("muted", action), 0, 0);
		},

		renderResult(result, { expanded }, theme, context) {
			const details = result.details as BoardDetails | undefined;
			const text = result.content[0];
			const msg = text?.type === "text" ? text.text : "";
			const prefix = context?.isError ? theme.fg("error", "\u2717 ") : theme.fg("success", "\u2713 ");
			const summary = prefix + theme.fg("muted", msg);

			if (expanded && details) {
				return new BannerMessageComponent(summary, details, true, theme);
			}
			return new Text(summary, 0, 0);
		},
	});

	pi.registerTool({
		name: "tic_tac_toe_see_board",
		label: "See Board",
		description:
			"Return the current tic-tac-toe board state and YOUR cursor position (Player O). Takes no arguments. Use this if you need the current state restated mid-turn (for example after a failed play). The user's cursor is never exposed.",
		promptSnippet: "Inspect the tic-tac-toe board and your cursor",
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			const boardAscii = boardToAscii(gameState.board, gameState.agentCursorRow, gameState.agentCursorCol);
			const text =
				`Board (your cursor marked with <>):\n${boardAscii}\n\n` +
				`Your cursor: (row=${gameState.agentCursorRow}, col=${gameState.agentCursorCol})\n` +
				`Status: ${gameState.status}\n` +
				`Turn: ${gameState.currentTurn === gameState.agentMark ? "Player O (you)" : "Player X"}`;
			return {
				content: [{ type: "text", text }],
				details: getBoardDetails(),
			};
		},

		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("tic_tac_toe_see_board")), 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as BoardDetails | undefined;
			const summary =
				theme.fg("success", "\u2713 ") +
				theme.fg("muted", `cursor (${details?.agentCursorRow ?? 0},${details?.agentCursorCol ?? 0})`);
			if (expanded && details) {
				return new BannerMessageComponent(summary, details, true, theme);
			}
			return new Text(summary, 0, 0);
		},
	});
}

function handleAgentPlay(emitGameOverMessage: () => void, appendSave: () => void): string {
	if (gameState.status !== "playing") {
		throw new TicTacToeError(`Game is over (${gameState.status}).`);
	}
	if (gameState.currentTurn !== gameState.agentMark) {
		throw new TicTacToeError("It is not your turn.");
	}
	const r = gameState.agentCursorRow;
	const c = gameState.agentCursorCol;
	if (gameState.board[r][c] !== " ") {
		// Do NOT reset the cursor on failure. The agent can retry
		// from the cursor's current position.
		component?.updateState(gameState);
		appendSave();
		throw new TicTacToeError(
			`Cell (${r},${c}) is already ${gameState.board[r][c]}. Your cursor is still at (${r},${c}). Move to an empty cell and retry play.`,
		);
	}

	gameState.board[r][c] = gameState.agentMark;
	gameState.status = checkWin(gameState.board);
	// Reset agent cursor to home ONLY on successful play.
	gameState.agentCursorRow = AGENT_CURSOR_HOME_ROW;
	gameState.agentCursorCol = AGENT_CURSOR_HOME_COL;
	if (gameState.status === "playing") {
		gameState.currentTurn = gameState.userMark;
		return `Placed O at (${r},${c}). Cursor reset to (${AGENT_CURSOR_HOME_ROW},${AGENT_CURSOR_HOME_COL}). Your turn, X!`;
	}
	if (gameState.status === "win_O") {
		gameActive = false;
		emitGameOverMessage();
		return `Placed O at (${r},${c}). Player O wins!`;
	}
	if (gameState.status === "draw") {
		gameActive = false;
		emitGameOverMessage();
		return `Placed O at (${r},${c}). It's a draw!`;
	}
	return `Placed O at (${r},${c}).`;
}
