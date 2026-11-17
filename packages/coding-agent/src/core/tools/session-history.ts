import { Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { InternalResourceRouter } from "./resource-selectors.ts";

/** Lines one `lines` read may return. */
const MAX_READ_LINES = 400;
/** Characters one call may return; longer output is cut and says so. */
const MAX_OUTPUT_CHARS = 50_000;

const sessionHistorySchema = Type.Object({
	pattern: Type.Optional(
		Type.String({ description: "Regular expression to search this session's history for. Search first." }),
	),
	lines: Type.Optional(
		Type.String({ description: 'A line range of this session\'s history to read, such as "120-260".' }),
	),
});

export interface SessionHistoryToolOptions {
	/** The session whose history the tool reads; nothing else is reachable. */
	readonly sessionId: () => string;
	readonly router: () => InternalResourceRouter;
}

function capped(text: string): string {
	return text.length <= MAX_OUTPUT_CHARS
		? text
		: `${text.slice(0, MAX_OUTPUT_CHARS)}\n[output cut at ${MAX_OUTPUT_CHARS} characters; narrow the search or the range]`;
}

function parseRange(lines: string): { start: number; end: number } {
	const match = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(lines);
	if (!match) throw new Error(`Invalid lines "${lines}": use a range such as "120-260".`);
	const start = Number(match[1]);
	const end = match[2] === undefined ? start : Number(match[2]);
	if (start < 1 || end < start) throw new Error(`Invalid lines "${lines}": the range must start at 1 or later.`);
	return { start, end: Math.min(end, start + MAX_READ_LINES - 1) };
}

/**
 * Read-only access to this session's own history, for an agent whose tools do not include `read` and `search`. It
 * reaches only `history://sessions/<own id>`: no other session, workflow run, file or project.
 */
export function createSessionHistoryToolDefinition(
	name: string,
	options: SessionHistoryToolOptions,
): ToolDefinition<typeof sessionHistorySchema> {
	return {
		name,
		label: "Session history",
		description:
			'Search or read this session\'s own history after its context was cleared. Pass {"pattern": "<regex>"} to search (each match names its line), then {"lines": "N-M"} to read a narrow range verbatim. Only this session\'s history is reachable.',
		parameters: sessionHistorySchema,
		promptSnippet: "Search and read this session's own history after a context clear",
		execute: async (_toolCallId, { pattern, lines }) => {
			const url = `history://sessions/${options.sessionId()}`;
			const router = options.router();
			if (pattern !== undefined && pattern.trim() !== "") {
				const found = await router.search?.(url, {
					pattern,
					ignoreCase: false,
					literal: false,
					contextBefore: 0,
					contextAfter: 0,
				});
				return {
					content: [{ type: "text", text: capped(found?.trim() ? found : "No matches.") }],
					details: undefined,
				};
			}
			if (lines === undefined) throw new Error('Pass {"pattern": "<regex>"} to search or {"lines": "N-M"} to read.');
			const { start, end } = parseRange(lines);
			const transcript = await router.read?.(url);
			const all = typeof transcript === "string" ? transcript.split("\n") : [];
			if (start > all.length) throw new Error(`Line ${start} is past the end of the history (${all.length} lines).`);
			const slice = all
				.slice(start - 1, end)
				.map((line, index) => `${start + index}: ${line}`)
				.join("\n");
			const more = end < all.length ? `\n[lines ${start}-${Math.min(end, all.length)} of ${all.length}]` : "";
			return { content: [{ type: "text", text: capped(slice + more) }], details: undefined };
		},
	};
}
