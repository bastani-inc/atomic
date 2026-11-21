import { Type } from "@bastani/atomic-ai/utils/typebox/index";
import type { ToolDefinition } from "../extensions/types.ts";
import type { InternalResourceRouter } from "./resource-selectors.ts";

/** Entries one `lines` read may return. */
const MAX_READ_ENTRIES = 400;
/** Characters one call may return; longer output is cut and says so. */
const MAX_OUTPUT_CHARS = 50_000;
const CURSOR_VALUE = /^\d+(?:\.\d+){0,3}$/;

const sessionHistorySchema = Type.Object({
	pattern: Type.Optional(
		Type.String({
			description:
				"Regular expression to search this session's history for. Keep it and set `lines` to a `?cursor=` URL to continue.",
		}),
	),
	lines: Type.Optional(
		Type.String({
			description:
				'An entry range of this session\'s history to read, such as "120-260", or a `?cursor=` URL to continue.',
		}),
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

function clampSpanEnd(start: number, end: number): number {
	const maxEnd = Math.min(
		Number.MAX_SAFE_INTEGER,
		start + Math.min(MAX_READ_ENTRIES - 1, Number.MAX_SAFE_INTEGER - start),
	);
	return Math.min(end, maxEnd);
}

function parseEntryRange(value: string, label: string, capSpan: boolean): { start: number; end: number } {
	const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(value.trim());
	if (!match) throw new Error(`Invalid lines "${label}": use an entry range such as "120-260".`);
	const start = Number(match[1]);
	const end = match[2] === undefined ? start : Number(match[2]);
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
		throw new Error(`Invalid lines "${label}": the entry range must start at 1 or later.`);
	}
	return { start, end: capSpan ? clampSpanEnd(start, end) : end };
}

function parseCursorQuery(query: string, label: string): { readonly query: string; readonly firstSeq: number } {
	const params = new URLSearchParams(query);
	const keys = [...params.keys()];
	const cursor = params.get("cursor");
	if (keys.length !== 1 || keys[0] !== "cursor" || !cursor || !CURSOR_VALUE.test(cursor)) {
		throw new Error(`Invalid lines "${label}": only ?cursor= continuations for this session are allowed.`);
	}
	const parts = cursor.split(".").map((part) => Number(part));
	const firstSeq = parts[0] ?? 0;
	if (parts.some((part) => !Number.isSafeInteger(part) || part < 0) || firstSeq < 1) {
		throw new Error(`Invalid lines "${label}": cursor positions must be safe positive integers.`);
	}
	return { query: `?cursor=${cursor}`, firstSeq };
}

function parseTarget(
	baseUrl: string,
	rawLines: string,
	capSpan: boolean,
): { readonly url: string; readonly range?: { readonly start: number; readonly end: number } } {
	const trimmed = rawLines.trim();
	let rest = trimmed;
	if (trimmed.startsWith("history://")) {
		if (!trimmed.startsWith(baseUrl)) {
			throw new Error(`Invalid lines "${rawLines}": only this session's history (${baseUrl}) is reachable.`);
		}
		rest = trimmed.slice(baseUrl.length);
		if (rest === "" || (rest[0] !== "?" && rest[0] !== ":")) {
			throw new Error(`Invalid lines "${rawLines}": only this session's history (${baseUrl}) is reachable.`);
		}
	}
	let query = "";
	let cursorStart = 1;
	if (rest.startsWith("?")) {
		const colon = rest.indexOf(":");
		const queryPart = colon >= 0 ? rest.slice(1, colon) : rest.slice(1);
		const parsedCursor = parseCursorQuery(queryPart, rawLines);
		query = parsedCursor.query;
		cursorStart = parsedCursor.firstSeq;
		rest = colon >= 0 ? rest.slice(colon + 1) : "";
	} else if (rest.startsWith(":")) {
		rest = rest.slice(1);
	}
	if (rest === "" && query !== "") {
		return capSpan
			? {
					url: `${baseUrl}${query}`,
					range: { start: cursorStart, end: clampSpanEnd(cursorStart, Number.MAX_SAFE_INTEGER) },
				}
			: { url: `${baseUrl}${query}` };
	}
	return {
		url: `${baseUrl}${query}`,
		range: parseEntryRange(rest, rawLines, capSpan),
	};
}

/**
 * Read-only access to this session's own history, for an agent whose tools do not include `read` and `search`. It
 * reaches only `history://sessions/<own id>`: no other session, file or project.
 */
export function createSessionHistoryToolDefinition(
	name: string,
	options: SessionHistoryToolOptions,
): ToolDefinition<typeof sessionHistorySchema> {
	return {
		name,
		label: "Session history",
		description:
			'Search or read this session\'s own history after its context was cleared. When the context-cleared message tells you to `search` or `read` `history://sessions/<id>` and those tools are not available, use this tool instead: pass {"pattern": "<regex>"} to search (each match names its entry), then {"lines": "N-M"} to read a narrow entry range verbatim. Only this session\'s history is reachable.',
		parameters: sessionHistorySchema,
		promptSnippet:
			"Search and read this session's own history after a context clear (use in place of search/read on history://sessions/<id>)",
		execute: async (_toolCallId, { pattern, lines }, signal) => {
			const baseUrl = `history://sessions/${options.sessionId()}`;
			const router = options.router();
			if (pattern !== undefined && pattern.trim() !== "") {
				const target = lines !== undefined && lines.trim() !== "" ? parseTarget(baseUrl, lines, false) : undefined;
				const searchUrl = target ? target.url : baseUrl;
				if (!router.search) {
					throw new Error(`Bounded history search is unavailable for ${baseUrl}.`);
				}
				const found = await router.search(searchUrl, {
					pattern,
					ignoreCase: false,
					literal: false,
					contextBefore: 0,
					contextAfter: 0,
					...(target?.range ? { ranges: [target.range] } : {}),
					...(signal === undefined ? {} : { signal }),
				});
				return {
					content: [{ type: "text", text: capped(found?.trim() ? found : "No matches.") }],
					details: undefined,
				};
			}
			if (lines === undefined) throw new Error('Pass {"pattern": "<regex>"} to search or {"lines": "N-M"} to read.');
			if (!router.readSelected) {
				throw new Error(`Bounded history read is unavailable for ${baseUrl}.`);
			}
			const { url, range } = parseTarget(baseUrl, lines, true);
			const transcript = await router.readSelected(url, {
				...(range ? { ranges: [range] } : {}),
				...(signal === undefined ? {} : { signal }),
			});
			if (typeof transcript !== "string") {
				throw new Error(`Bounded history read returned no transcript for ${baseUrl}.`);
			}
			return { content: [{ type: "text", text: capped(transcript) }], details: undefined };
		},
	};
}
