/**
 * A `search` of `history://` that runs to its end: it follows each `continue with` URL a call stops at, so one tool
 * call (in the foreground, or as a background task once it yields) covers what a chain of calls would, and prints only
 * the matches and the notes that are not stops. Its execution timeout or a stop ends it with the URL to continue from.
 */

import { type InternalResourceContext, searchInternalSelector } from "./resource-selectors.ts";
import type { ToolTaskWork } from "./tool-task.ts";

/** How long each step of the chain may search before it hands back a `continue with` URL: the router's default. */
export const HISTORY_SEARCH_STEP_MS = 3_000;

const CONTINUATION = /continue with (history:\/\/\S+?)\]\s*$/;

/** The URL a note line hands the search on to, or undefined for any other line. */
export function historyContinuation(line: string): string | undefined {
	return CONTINUATION.exec(line)?.[1];
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
 * The work of a `history://` search that runs to its end. Each step searches one URL for at most the step budget;
 * the notes that stop a step are not printed, their URLs are searched next, in order, so the chain covers each entry
 * once. When the work is stopped (its timeout, a stop from `/tasks`, or the call's abort) it prints where to continue.
 */
export function historySearchWork(run: HistorySearchRun): ToolTaskWork {
	return async (write, signal) => {
		const pending = [...run.urls];
		let printedAny = false;
		const print = (text: string) => {
			if (text.length === 0) return;
			write(`${printedAny ? "\n" : ""}${text}`);
			printedAny = true;
		};
		while (pending.length > 0) {
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
				if (!signal.aborted) throw error;
				pending.unshift(url);
				break;
			}
			const next: string[] = [];
			const kept = text.split("\n").filter((line) => {
				const continuation = historyContinuation(line);
				if (continuation === undefined) return true;
				next.push(continuation);
				return false;
			});
			const shown = kept.join("\n").trim();
			if (shown.length > 0 && shown !== "No matches found") print(shown);
			// What this step stopped at is searched before anything queued after it, so results stay in order.
			pending.unshift(...next);
		}
		if (pending.length > 0) {
			print(pending.map((url) => `[search stopped before it finished; continue with ${url}]`).join("\n"));
			return;
		}
		if (!printedAny) print("No matches found");
	};
}
