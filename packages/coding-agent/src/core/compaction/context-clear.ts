import { textLines } from "../tools/history-transcript.ts";
import type { CompactionHistoryLocation } from "./compaction-types.js";

/** The tool a restricted agent gets after a clear to search and read its own session's history. */
export const SESSION_HISTORY_TOOL_NAME = "session_history";

/** How the agent reaches its history: its own `read` and `search` tools, or the restricted history tool. */
export type HistoryAccess = "read-search" | "session-history-tool";

export interface BoundaryTextInput {
	readonly sessionId: string;
	readonly tokensBefore: number;
	/** The last line of the earlier conversation in `history://sessions/<sessionId>`. */
	readonly linesBefore: number;
	readonly access: HistoryAccess;
	/** The `/compact` instructions, when the user gave any. */
	readonly instructions?: string;
	/** Replacement text from a compactor model or an extension, and who produced it. */
	readonly compacted?: { readonly text: string; readonly source: string };
}

function historyUrl(sessionId: string): string {
	return `history://sessions/${sessionId}`;
}

function howToRecover(input: BoundaryTextInput): string[] {
	const url = historyUrl(input.sessionId);
	const access =
		input.access === "read-search"
			? [
					`- Search first: use \`search\` with paths "${url}" (a plain "history://sessions" search skips this session). Then read narrow ranges with \`read ${url}:N-M\`, about 200 lines at a time.`,
				]
			: [
					`- Use the \`${SESSION_HISTORY_TOOL_NAME}\` tool, which reaches only ${url}: search first with {"pattern": "<regex>"}, then read narrow ranges with {"lines": "N-M"}, about 200 lines at a time.`,
				];
	return [
		"How to recover:",
		...access,
		"- Copy what you need verbatim. Do not paraphrase identifiers, paths, commands, error messages or the user's wording.",
		'- A tool result that shows "Full output saved to: <location>" or "Full output: <location>" kept its whole output at that location: open the path, tool-output:// or artifact:// URL in narrow ranges. It may have been cleaned up since.',
	];
}

function whatToRecover(input: BoundaryTextInput): string[] {
	const url = historyUrl(input.sessionId);
	return [
		"Recover what you need, in this order:",
		`1. Every <keepContext> span, verbatim and whole: search ${url} for "keepContext". Tagged text is what the user or a workflow marked as needed for the rest of the task.`,
		"2. The user's objectives and latest requests; constraints and prohibitions (what must and must not be done); decisions and the reasons for them; identifiers such as branches, worktrees, pull requests, run ids, file paths and commands; open work and blockers; and tool results you still need.",
		"Prefer the most recent records, at the end of the range: later requests supersede earlier ones, and an approach that was abandoned stays abandoned. Assistant text holds decisions and rationale, not only tool output.",
	];
}

/**
 * The whole boundary message the model sees after a clear or a compaction: what happened, where the earlier
 * conversation is, what to recover from it first and how, any `/compact` instructions, then "continue".
 */
export function buildBoundaryText(input: BoundaryTextInput, totalLines: number): string {
	const url = historyUrl(input.sessionId);
	const tokens = input.tokensBefore.toLocaleString("en-US");
	const location = `It is stored verbatim in this session's history at ${url}: lines 1-${input.linesBefore} hold the earlier conversation, this boundary starts at line ${input.linesBefore + 1}, and the history has ${totalLines} lines now.`;
	const sections: string[][] = input.compacted
		? [
				[
					`Context compacted. Your earlier conversation (${tokens} tokens) was replaced by the compacted text below, produced by ${input.compacted.source}. It keeps only part of the conversation.`,
				],
				["<compacted-context>", input.compacted.text, "</compacted-context>"],
				[
					`The earlier conversation is not lost. ${location} Before you rely on a detail the compacted text does not show, recover it from there.`,
				],
			]
		: [
				[
					`Context cleared. Your earlier conversation (${tokens} tokens) is no longer in your context window. ${location} Before you continue, recover what the task needs from there.`,
				],
			];
	sections.push(whatToRecover(input), howToRecover(input));
	const instructions = input.instructions?.trim();
	if (instructions) sections.push(["Compaction instructions from the user:", instructions]);
	sections.push(["Then continue the task."]);
	return sections.map((lines) => lines.join("\n")).join("\n\n");
}

/** Lines the boundary entry occupies in the history view: its heading plus its text. */
function boundaryEntryLineCount(text: string): number {
	return 1 + textLines(text).length;
}

/**
 * Build the boundary text with the history's line count right after the boundary is written. The count depends on
 * the text, which states the count, so it is recomputed until it is stable (one extra pass at most in practice).
 */
export function buildBoundaryTextWithLocation(input: BoundaryTextInput): {
	text: string;
	history: CompactionHistoryLocation;
} {
	let totalLines = input.linesBefore + boundaryEntryLineCount(buildBoundaryText(input, input.linesBefore + 1));
	let text = buildBoundaryText(input, totalLines);
	for (let pass = 0; pass < 3; pass++) {
		const counted = input.linesBefore + boundaryEntryLineCount(text);
		if (counted === totalLines) break;
		totalLines = counted;
		text = buildBoundaryText(input, totalLines);
	}
	return {
		text,
		history: {
			sessionId: input.sessionId,
			linesBefore: input.linesBefore,
			boundaryLine: input.linesBefore + 1,
			totalLines,
		},
	};
}
