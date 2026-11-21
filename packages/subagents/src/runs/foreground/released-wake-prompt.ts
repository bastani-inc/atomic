/**
 * What a woken child is told when nothing else the wake brings starts its turn: no turn it continues, no message held
 * for it and no late result. It is that turn's own prompt, never a message queued behind a turn.
 */
export const SUBAGENT_RELEASED_WAKE_PROMPT =
	"You were released while you waited, and something you were waiting for arrived: read the new messages and tool results, then continue your task. If you have finished, stop.";
