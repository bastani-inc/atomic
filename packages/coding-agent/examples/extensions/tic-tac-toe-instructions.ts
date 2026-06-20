import { AGENT_CURSOR_HOME_COL, AGENT_CURSOR_HOME_ROW } from "./tic-tac-toe-state.js";

export function buildTicTacToeInstructions(systemPrompt: string): string {
	const instructions = `

## Tic-Tac-Toe (you are Player O)

A tic-tac-toe game is in progress. The human is Player X. You are Player O.
The human plays through a TUI; you play through the \`tic_tac_toe\` tool.

### Turn protocol

When the human plays, you receive a message that contains the cell X marked,
the full board, and YOUR cursor position (Player O's cursor). The message is
the source of truth for the board.

Player O's cursor persists between O turns. It is reset to (row=${AGENT_CURSOR_HOME_ROW}, col=${AGENT_CURSOR_HOME_COL})
only after a successful \`play\`. If a \`play\` fails (cell already taken), the
cursor stays where it was, so you can move and retry.

You may also call \`tic_tac_toe_see_board\` if you want the current board and
your cursor position restated at any point. The user's cursor is private and
is never shown to you.

### The tool

\`tic_tac_toe\` takes ONE action per call:
- \`move_up\` / \`move_down\` / \`move_left\` / \`move_right\`: move YOUR cursor one cell (clamped at edges)
- \`play\`: place O on the cell under YOUR cursor. Errors if the cell is not empty.

There is no batched form. One call = one action.

### CRITICAL: emit the whole turn in a single response

To play at (r, c) from your cursor (r0, c0) emit, in order:
- \`move_down\` (r - r0) times (or \`move_up\` (r0 - r) times if r < r0)
- \`move_right\` (c - c0) times (or \`move_left\` (c0 - c) times if c < c0)
- one call of \`play\`

All of these tool calls MUST be emitted in the SAME assistant response, as
separate tool_use blocks, before you stop. Do not:
- split the sequence across multiple assistant responses,
- wait for a move result before emitting the next move or \`play\`,
- write any explanation or text between the tool calls,
- call any other tool during your turn (except \`tic_tac_toe_see_board\` when you
  explicitly need the state restated).

Decide the target cell first, then dump every action for the turn in one go.

### Examples (cursor starts at (${AGENT_CURSOR_HOME_ROW}, ${AGENT_CURSOR_HOME_COL}))

- Target (0,0): one call, \`play\`.
- Target (0,2): \`move_right\`, \`move_right\`, \`play\`. Three calls, one response.
- Target (1,1): \`move_down\`, \`move_right\`, \`play\`. Three calls, one response.
- Target (2,2): \`move_down\`, \`move_down\`, \`move_right\`, \`move_right\`, \`play\`. Five calls, one response.

### Strategy

1. If you have two O's in a line with the third cell empty, win by playing there.
2. Otherwise, if X has two in a line with the third cell empty, block there.
3. Otherwise, prefer center, then corners, then edges.
`;

	return systemPrompt + instructions;
}
