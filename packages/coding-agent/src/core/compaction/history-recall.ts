import type { InternalResourceRouter, InternalSearchRequest } from "../tools/resource-selectors.ts";
import { COMPACTION_AUTO_QUERY } from "./compaction-parameters.js";
import { ROLE_HEADER_RE } from "./transcript-serialization.js";

/** Share of the kept context's tokens that recalled snippets may add. */
export const COMPACTION_RECALL_TOKEN_FRACTION = 0.1;
/** Most tokens recalled snippets may add, however large the kept context is. */
export const COMPACTION_RECALL_MAX_TOKENS = 1_500;
/** Longest the whole recall step may take; past it compaction goes on without recalled context. */
export const COMPACTION_RECALL_TIME_LIMIT_MS = 3_000;
export const COMPACTION_RECALL_HEADING = "Recalled context";

const MAX_QUERY_TERMS = 12;
const MAX_QUERY_CHARS = 8_000;
const MIN_ORDINARY_TERM_LENGTH = 5;
const MIN_IDENTIFIER_TERM_LENGTH = 3;
const IDENTIFIER_TERM_WEIGHT = 2;
const ORDINARY_TERM_WEIGHT = 1;
const MIN_SNIPPET_SCORE = 3;
const MAX_SNIPPET_LINES = 6;
const MAX_SNIPPET_LINE_CHARS = 300;
const MIN_PREFIX_CHARS_TO_COMPARE = 40;
const APPEND_SEPARATOR = "\n\n";
const SEARCH_TRUNCATION_SUFFIX = "… [truncated]";
const QUOTE_PREFIX = "> ";
const HEADING_TEXT = `${COMPACTION_RECALL_HEADING} (earlier lines matching this task; open a source with \`read\`):`;

const TOKEN = /[A-Za-z0-9_][A-Za-z0-9_./#-]*/g;
const IDENTIFIER_SHAPE = /[0-9_./#-]|[a-z][A-Z]|^[A-Z]{3,}$/;
const ORDINARY_WORD = /^[A-Za-z]+$/;
const SHORT_NUMBER = /^\d{1,3}$/;
const ROW_LABEL = /^(history:\/\/.+)([:-])(\d+)\2$/;
const STRUCTURAL_LINES: readonly RegExp[] = [
	/^## (?:\S+|unknown time) (?:user|assistant|bash|tool result |custom |branch summary|session summary|compaction|session name: )/,
	/^# (?:session|workflow run) /,
	/^(?:created|workflow stage): /,
	/^\[tool call\] /,
	/^history:\/\/\S+:\d+-\d+$/,
	new RegExp(`^${COMPACTION_RECALL_HEADING}\\b`),
];
const STOP_WORDS: ReadonlySet<string> = new Set(
	(
		"about after again being below could doing during every first further having other please should since " +
		"their there these those through under until using which while would"
	).split(" "),
);

export interface HistoryRecallRequest {
	readonly router: InternalResourceRouter;
	readonly sessionId: string;
	/** The current task: the latest user request and the compaction relevance query. */
	readonly queries: readonly string[];
	/** Every line the compacted context will still show, so recall never repeats one. */
	readonly keptLines: readonly string[];
	readonly keptTokens: number;
	readonly signal?: AbortSignal;
	readonly timeLimitMs?: number;
}

interface QueryTerm {
	readonly text: string;
	readonly lower: string;
	readonly weight: number;
}

interface SearchRow {
	readonly source: string;
	readonly line: number;
	readonly text: string;
}

interface Snippet {
	readonly rows: readonly SearchRow[];
	readonly score: number;
	readonly own: boolean;
}

export function recallBudgetTokens(keptTokens: number): number {
	return Math.min(COMPACTION_RECALL_MAX_TOKENS, Math.floor(keptTokens * COMPACTION_RECALL_TOKEN_FRACTION));
}

/** The compacted text followed by the recalled section. */
export function withRecalledContext(compactedText: string, section: string): string {
	return `${compactedText}${APPEND_SEPARATOR}${section}`;
}

function estimateTokens(chars: number): number {
	return Math.ceil(chars / 4);
}

function queryTerms(queries: readonly string[]): QueryTerm[] {
	const counts = new Map<string, { text: string; weight: number; count: number; order: number }>();
	for (const query of new Set(queries)) {
		if (query.trim() === COMPACTION_AUTO_QUERY) continue;
		for (const [raw] of query.slice(0, MAX_QUERY_CHARS).matchAll(TOKEN)) {
			const text = raw.replace(/[./#-]+$/, "");
			const lower = text.toLowerCase();
			const identifier =
				IDENTIFIER_SHAPE.test(text) && text.length >= MIN_IDENTIFIER_TERM_LENGTH && !SHORT_NUMBER.test(text);
			const ordinary = ORDINARY_WORD.test(text) && text.length >= MIN_ORDINARY_TERM_LENGTH;
			if ((!identifier && !ordinary) || STOP_WORDS.has(lower)) continue;
			const known = counts.get(lower);
			if (known) known.count++;
			else
				counts.set(lower, {
					text,
					weight: identifier ? IDENTIFIER_TERM_WEIGHT : ORDINARY_TERM_WEIGHT,
					count: 1,
					order: counts.size,
				});
		}
	}
	return [...counts.entries()]
		.sort(
			([, a], [, b]) =>
				b.weight - a.weight || b.count - a.count || b.text.length - a.text.length || a.order - b.order,
		)
		.slice(0, MAX_QUERY_TERMS)
		.map(([lower, { text, weight }]) => ({ text, lower, weight }));
}

function searchRequest(terms: readonly QueryTerm[]): InternalSearchRequest {
	return {
		pattern: terms.map((term) => term.text.replace(/\./g, "\\.")).join("|"),
		ignoreCase: true,
		literal: false,
		contextBefore: 0,
		contextAfter: 0,
	};
}

function parseRows(output: string | undefined): SearchRow[] {
	const rows: SearchRow[] = [];
	for (const raw of (output ?? "").split("\n")) {
		const space = raw.indexOf(" ");
		const label = space < 0 ? undefined : ROW_LABEL.exec(raw.slice(0, space));
		if (!label) continue;
		const line = Number(label[3]);
		if (line >= 1) rows.push({ source: label[1], line, text: raw.slice(space + 1) });
	}
	return rows;
}

function comparable(line: string): string {
	const withoutQuote = line.startsWith(QUOTE_PREFIX) ? line.slice(QUOTE_PREFIX.length) : line;
	return withoutQuote.replace(ROLE_HEADER_RE, "").replace(/\s+/g, " ").trim();
}

function isBlank(row: SearchRow): boolean {
	return row.text.trim() === "";
}

class KeptLines {
	private readonly exact = new Set<string>();
	private readonly all: string[] = [];

	constructor(lines: readonly string[]) {
		for (const line of lines) {
			const text = comparable(line);
			if (text !== "" && !this.exact.has(text)) {
				this.exact.add(text);
				this.all.push(text);
			}
		}
	}

	has(row: SearchRow): boolean {
		const text = comparable(row.text);
		if (text === "") return false;
		if (this.exact.has(text)) return true;
		if (!row.text.endsWith(SEARCH_TRUNCATION_SUFFIX)) return false;
		const prefix = comparable(row.text.slice(0, -SEARCH_TRUNCATION_SUFFIX.length));
		return prefix.length >= MIN_PREFIX_CHARS_TO_COMPARE && this.all.some((kept) => kept.startsWith(prefix));
	}
}

function contiguousRuns(rows: readonly SearchRow[], keep: (row: SearchRow) => boolean): SearchRow[][] {
	const runs: SearchRow[][] = [];
	let current: SearchRow[] = [];
	for (const row of rows) {
		if (!keep(row)) {
			if (current.length > 0) runs.push(current);
			current = [];
			continue;
		}
		const previous = current[current.length - 1];
		if (previous && (previous.source !== row.source || previous.line + 1 !== row.line)) {
			runs.push(current);
			current = [];
		}
		current.push(row);
	}
	if (current.length > 0) runs.push(current);
	return runs;
}

function trimmedChunks(run: readonly SearchRow[]): SearchRow[][] {
	const chunks: SearchRow[][] = [];
	for (let start = 0; start < run.length; start += MAX_SNIPPET_LINES) {
		const chunk = run.slice(start, start + MAX_SNIPPET_LINES);
		let first = 0;
		let last = chunk.length;
		while (first < last && isBlank(chunk[first])) first++;
		while (last > first && isBlank(chunk[last - 1])) last--;
		if (first < last) chunks.push(chunk.slice(first, last));
	}
	return chunks;
}

function score(rows: readonly SearchRow[], terms: readonly QueryTerm[]): number {
	const text = rows
		.map((row) => row.text)
		.join("\n")
		.toLowerCase();
	return terms.reduce((sum, term) => (text.includes(term.lower) ? sum + term.weight : sum), 0);
}

function cut(text: string): string {
	if (text.length <= MAX_SNIPPET_LINE_CHARS) return text;
	const end = text.charCodeAt(MAX_SNIPPET_LINE_CHARS - 1);
	return `${text.slice(0, end >= 0xd800 && end <= 0xdbff ? MAX_SNIPPET_LINE_CHARS - 1 : MAX_SNIPPET_LINE_CHARS)}…`;
}

function renderSnippet(rows: readonly SearchRow[]): string[] {
	const first = rows[0];
	const last = rows[rows.length - 1];
	return [
		`${first.source}:${first.line}-${last.line}`,
		...rows.map((row) => `${QUOTE_PREFIX}${cut(row.text)}`.trimEnd()),
	];
}

function candidateSnippets(
	rows: readonly SearchRow[],
	terms: readonly QueryTerm[],
	kept: KeptLines,
	ownSource: string,
): Snippet[] {
	const eligible = (row: SearchRow): boolean =>
		!STRUCTURAL_LINES.some((pattern) => pattern.test(row.text)) && !kept.has(row);
	return contiguousRuns(rows, eligible)
		.flatMap(trimmedChunks)
		.map((chunk): Snippet => ({ rows: chunk, score: score(chunk, terms), own: chunk[0].source === ownSource }))
		.filter((snippet) => snippet.score >= MIN_SNIPPET_SCORE)
		.map((snippet, order) => ({ snippet, order }))
		.sort(
			(a, b) =>
				b.snippet.score - a.snippet.score || Number(b.snippet.own) - Number(a.snippet.own) || a.order - b.order,
		)
		.map(({ snippet }) => snippet);
}

function selectWithinBudget(
	candidates: readonly Snippet[],
	terms: readonly QueryTerm[],
	budgetTokens: number,
): string | undefined {
	const section = [HEADING_TEXT];
	let chars = HEADING_TEXT.length + APPEND_SEPARATOR.length;
	const emitted = new Set<string>();
	let added = 0;
	for (const candidate of candidates) {
		const fresh = contiguousRuns(candidate.rows, (row) => isBlank(row) || !emitted.has(comparable(row.text)));
		for (const snippet of fresh.flatMap(trimmedChunks)) {
			if (score(snippet, terms) < MIN_SNIPPET_SCORE) continue;
			const rendered = renderSnippet(snippet);
			const renderedChars = rendered.reduce((sum, line) => sum + line.length + 1, 0);
			if (estimateTokens(chars + renderedChars) > budgetTokens) continue;
			section.push(...rendered);
			chars += renderedChars;
			added++;
			for (const row of snippet) emitted.add(comparable(row.text));
		}
	}
	return added === 0 ? undefined : section.join("\n");
}

async function untilInterrupted<T>(work: Promise<T>, timeLimitMs: number, signal: AbortSignal | undefined): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	const interrupted = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error("History recall timed out")), timeLimitMs);
		if (signal) {
			onAbort = () => reject(new Error("History recall cancelled"));
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
		}
	});
	try {
		return await Promise.race([work, interrupted]);
	} finally {
		clearTimeout(timer);
		if (onAbort) signal?.removeEventListener("abort", onAbort);
	}
}

/**
 * Find lines of this session's history, other sessions and workflow runs that bear on the current task, and render
 * them as a short `Recalled context` section. Resolves `undefined` when there is nothing to add, whatever the reason:
 * no matches, an exhausted budget, a failed search, the time limit or cancellation. It never rejects.
 *
 * Every snippet line is quoted with `> `, so recalled text can never be read as compaction structure on the next pass:
 * a role header, a `(filtered N lines)` marker or a `<keepContext>` tag.
 */
export async function recallHistory(request: HistoryRecallRequest): Promise<string | undefined> {
	const budgetTokens = recallBudgetTokens(request.keptTokens);
	const terms = queryTerms(request.queries);
	const search = request.router.search?.bind(request.router);
	if (budgetTokens <= 0 || terms.length === 0 || !search || request.signal?.aborted) return undefined;
	const timeLimitMs = request.timeLimitMs ?? COMPACTION_RECALL_TIME_LIMIT_MS;
	const ownSource = `history://sessions/${request.sessionId}`;
	const searchRequestForTerms = searchRequest(terms);
	const startedAt = performance.now();
	try {
		const [own, others] = await untilInterrupted(
			Promise.all([search(ownSource, searchRequestForTerms), search("history://", searchRequestForTerms)]),
			timeLimitMs,
			request.signal,
		);
		if (request.signal?.aborted || performance.now() - startedAt > timeLimitMs) return undefined;
		const rows = [...parseRows(own), ...parseRows(others)];
		const candidates = candidateSnippets(rows, terms, new KeptLines(request.keptLines), ownSource);
		return selectWithinBudget(candidates, terms, budgetTokens);
	} catch {
		return undefined;
	}
}
