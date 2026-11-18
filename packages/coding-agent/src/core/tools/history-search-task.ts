/**
 * A `search` of `history://` that runs to its end: it follows each `continue with` URL a call stops at, so one tool
 * call (in the foreground, or as a background task once it yields) covers what a chain of calls would, and prints only
 * the matches and the notes that are not stops. Its execution timeout or a stop ends it with the URL to continue from.
 */

import { createHash } from "node:crypto";
import { TOOL_TASK_OUTPUT_MAX_BYTES } from "../tasks/supervisor.js";
import { type InternalResourceContext, searchInternalSelector } from "./resource-selectors.ts";
import type { ToolTaskWork } from "./tool-task.ts";
import { formatSize } from "./truncate.ts";

/**
 * How long each step of the chain may search before it hands back a `continue with` URL. Each step lists the sessions
 * again (about 1.5 s on a store of thousands of long sessions), so a step this long spends about a tenth of its time
 * there instead of half at the router's 3 s; it does not raise the event loop's longest stall, which is one store
 * statement either way, and a stop or timeout still ends the step at once.
 */
export const HISTORY_SEARCH_STEP_MS = 10_000;

/**
 * How many of its latest steps' answers a search compares each answer with to find one that made no progress. Its
 * execution timeout still ends a source that repeats itself over a longer cycle, and its output store bounds what that
 * prints.
 */
const REMEMBERED_ANSWERS = 1_024;

/**
 * How much a search prints before it follows no more stops and ends with where to continue. A task keeps the first
 * {@link TOOL_TASK_OUTPUT_MAX_BYTES} of its output whole; a step prints at most about its 40 KB byte budget, so stopping
 * a megabyte short keeps every match the search printed instead of losing some in the middle of a very long result.
 */
export const HISTORY_SEARCH_OUTPUT_MAX_BYTES = TOOL_TASK_OUTPUT_MAX_BYTES - 1024 * 1024;

const CONTINUATION = /continue with (history:\/\/\S+?)\]\s*$/;
/** A stop a budget made (`the time budget ran out`, waiting for the store included), not the end of a page. */
const BUDGET_STOP = /\bthe (?:byte|row|time) budget ran out\b/;
/**
 * A note of the search itself: its first word is the location it is about at line 0 (`<url>:0: [...]`). A match or
 * context line (`<url>:N: …`, `<url>-N- …`) that quotes a note from history is not one, whatever it quotes.
 */
const NOTE = /^(\S+?(?::0: |-0- ))\[(.*)\]\s*$/;

/**
 * The URL a step's budget stop hands the search on to, or undefined for any other line. A page's end (`searched
 * sessions 1-25 of 230; continue with …?offset=25`) is not a stop: the search covers the page its URL names, as a
 * single call does, and that note stays in its output. Only a note of the search can be a stop: a match that quotes
 * one is kept as a match and never followed.
 */
export function historyContinuation(line: string): string | undefined {
	const note = NOTE.exec(line);
	if (note === null || !BUDGET_STOP.test(note[2]!)) return undefined;
	return CONTINUATION.exec(`[${note[2]}]`)?.[1];
}

export interface HistorySearchRun {
	/** The `history://` URLs to search, each with its `:N-M` selection if it has one. */
	readonly urls: readonly string[];
	readonly pattern: string;
	readonly ignoreCase: boolean;
	readonly contextBefore: number;
	readonly contextAfter: number;
	readonly cwd: string;
	readonly resources: InternalResourceContext | undefined;
	/** Step budget override, for tests; omitted, {@link HISTORY_SEARCH_STEP_MS}. */
	readonly stepMs?: number;
}

/**
 * What a followed stop line reports besides the stop itself, as a note of its own, or undefined when it reports
 * nothing else. The coverage, the budget that ran out and the URL are the step's own business; an entry the step could
 * not search (`entry 1 not searched: …`) or sessions it could not read (`…, 1 unreadable`) are the search's, and the
 * foreground chain would show them.
 */
export function followedStopNote(line: string): string | undefined {
	const note = NOTE.exec(line);
	if (note === null) return undefined;
	const kept = note[2]!
		.split("; ")
		// A part that says a budget ran out is the stop itself (`sessions not searched: the time budget ran out …` too),
		// which the chain goes on from; an entry the pattern ran past (`… not searched: the pattern ran past …`) is not.
		.filter((part) => !/\bthe (?:byte|row|time) budget ran out\b/.test(part) && !part.startsWith("continue with "));
	return kept.some((part) => /\bnot searched\b|\bunreadable\b/.test(part))
		? `${note[1]}[${kept.join("; ")}]`
		: undefined;
}

/**
 * The work of a `history://` search that runs to its end. Each step searches one URL for at most the step budget;
 * the notes that stop a step are not printed (only what else they report is), their URLs are searched next, in order,
 * so the chain covers each entry once. A step that fails is noted with where to continue from, and the rest goes on.
 * When the work is stopped (its timeout, a stop from `/tasks`, or the call's abort) it prints where to continue.
 */
export function historySearchWork(run: HistorySearchRun): ToolTaskWork {
	return async (write, signal) => {
		const pending = [...run.urls];
		let printedAny = false;
		let printedBytes = 0;
		let full = false;
		let failure: Error | undefined;
		let succeeded = false;
		const print = (text: string) => {
			if (text.length === 0) return;
			const chunk = `${printedAny ? "\n" : ""}${text}`;
			write(chunk);
			printedBytes += Buffer.byteLength(chunk, "utf8");
			printedAny = true;
		};
		// What the latest steps answered, by digest: a step that answers exactly as one of them did made no progress, so
		// the chain does not follow it again (a source that hands back the page it was asked for must not loop forever).
		const answered = new Set<string>();
		while (pending.length > 0) {
			// A turn of the event loop before each step: a source that answers without waiting on anything would
			// otherwise keep the loop in microtasks, where no timeout, stop or abort can ever run.
			await new Promise<void>((resolve) => setImmediate(resolve));
			if (printedBytes >= HISTORY_SEARCH_OUTPUT_MAX_BYTES) {
				full = true;
				break;
			}
			const url = pending.shift()!;
			if (signal.aborted) {
				pending.unshift(url);
				break;
			}
			let text: string;
			try {
				text = await searchInternalSelector(
					url,
					run.cwd,
					run.pattern,
					run.ignoreCase,
					false,
					run.resources,
					run.contextBefore,
					run.contextAfter,
					{ signal, timeBudgetMs: run.stepMs ?? HISTORY_SEARCH_STEP_MS },
				);
			} catch (error) {
				if (signal.aborted) {
					pending.unshift(url);
					break;
				}
				// One source failing does not lose the others: say which, and where it could continue, and go on.
				failure ??= error instanceof Error ? error : new Error(String(error));
				const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
				print(`${url}:0: [not searched: ${message}; continue with ${url}]`);
				continue;
			}
			succeeded = true;
			const digest = createHash("sha256").update(text).digest("hex");
			if (answered.has(digest)) {
				// No progress: keep where it stopped, so the caller can continue from there, and follow nothing more of it.
				const stops = text.split("\n").filter((line) => historyContinuation(line) !== undefined);
				if (stops.length > 0) print(stops.join("\n"));
				continue;
			}
			answered.add(digest);
			if (answered.size > REMEMBERED_ANSWERS) answered.delete(answered.values().next().value!);
			const next: string[] = [];
			const kept = text.split("\n").flatMap((line) => {
				const continuation = historyContinuation(line);
				if (continuation === undefined) return [line];
				next.push(continuation);
				const note = followedStopNote(line);
				return note === undefined ? [] : [note];
			});
			const shown = kept.join("\n").trim();
			if (shown.length > 0 && shown !== "No matches found") print(shown);
			// What this step stopped at is searched before anything queued after it, so results stay in order.
			pending.unshift(...next);
		}
		if (full) {
			// It found as much as one result holds: it ends here, and a new search continues from where it stopped.
			const printed = formatSize(printedBytes);
			print(pending.map((url) => `[search stopped after printing ${printed}; continue with ${url}]`).join("\n"));
			return "finished";
		}
		if (pending.length > 0) {
			print(pending.map((url) => `[search stopped before it finished; continue with ${url}]`).join("\n"));
			return "stopped";
		}
		// Nothing could be searched at all: the search failed, as a single call would.
		if (failure !== undefined && !succeeded) throw failure;
		if (!printedAny) print("No matches found");
		return "finished";
	};
}
