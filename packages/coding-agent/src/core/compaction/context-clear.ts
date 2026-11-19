import type { CompactionHistoryLocation, HistoryAccess } from "./compaction-types.js";

/** The tool a restricted agent gets after a clear to search and read its own session's history. */
export const SESSION_HISTORY_TOOL_NAME = "session_history";

export type { HistoryAccess } from "./compaction-types.js";

export interface BoundaryTextInput {
	readonly sessionId: string;
	readonly tokensBefore: number;
	readonly entriesBefore: number;
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
					`- Search first: use \`search\` with paths "${url}" (a plain "history://sessions" search skips this session). Then read narrow ranges with \`read ${url}:N-M\`, about 200 entries at a time. Follow any continuation URL to finish the selected range or search.`,
				]
			: [
					`- Use the \`${SESSION_HISTORY_TOOL_NAME}\` tool, which reaches only ${url}, reading about 200 entries at a time.`,
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
		`1. Every <keepContext> span, verbatim and whole: search ${url} for "keepContext". Tagged text is what the user marked as needed for the rest of the task.`,
		"2. The user's objectives and latest requests; constraints and prohibitions (what must and must not be done); decisions and the reasons for them; identifiers such as branches, worktrees, pull requests, run ids, file paths and commands; open work and blockers; and tool results you still need.",
		"Prefer the most recent records, at the end of the range: later requests supersede earlier ones, and an approach that was abandoned stays abandoned. Assistant text holds decisions and rationale, not only tool output.",
	];
}

/**
 * The whole boundary message the model sees after a clear or a compaction: what happened, where the earlier
 * conversation is, what to recover from it first and how, any `/compact` instructions, then "continue".
 */
export function buildBoundaryText(input: BoundaryTextInput, totalEntries: number): string {
	const url = historyUrl(input.sessionId);
	const tokens = input.tokensBefore.toLocaleString("en-US");
	const location = `It is stored verbatim in this session's history at ${url}: entries 1-${input.entriesBefore} hold the earlier conversation, this boundary is entry ${input.entriesBefore + 1}, and the history has ${totalEntries} entries now.`;
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

export function buildBoundaryTextWithLocation(input: BoundaryTextInput): {
	text: string;
	history: CompactionHistoryLocation;
} {
	const boundaryEntry = input.entriesBefore + 1;
	return {
		text: buildBoundaryText(input, boundaryEntry),
		history: {
			sessionId: input.sessionId,
			rangeUnit: "entries",
			entriesBefore: input.entriesBefore,
			boundaryEntry,
			totalEntries: boundaryEntry,
		},
	};
}
