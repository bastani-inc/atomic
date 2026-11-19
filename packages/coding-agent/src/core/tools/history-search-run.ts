/**
 * The `search` tool's `history://` path: a search that runs to its end, as a background task of the session's owner
 * observed exactly like a bash command (automatic yield, task id, `action: "wait"`, `kill`, heartbeats, one completion
 * notice), or in the foreground where no owner can run it. Its result shows the start of what it found, up to
 * {@link HISTORY_SEARCH_INLINE_BYTES}, and saves all of it to a file when there is more, as a shell's result does.
 */

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@bastani/atomic-agent-core";
import { graphemeHead } from "../../utils/terminal-text.ts";
import { formatTimeoutSeconds, longerRunAdvice } from "../tasks/cancel-reason.js";
import { TaskOutputDecoder } from "../tasks/command-output.js";
import type { TaskId, WaitOutcome, WaitPolicy } from "../tasks/contracts.js";
import { ToolTaskOutput } from "../tasks/supervisor.js";
import { lookupOwnedTask, type SupervisedCommandOwner } from "./bash-pty-native.js";
import {
	type HistorySearchRun,
	type HistorySearchStep,
	historyContinuation,
	historySearchWork,
} from "./history-search-task.ts";
import { PersistedOutputFile, truncateBufferAtUtf8Boundary } from "./persisted-output-file.ts";
import { buildSearchDetails, type SearchToolDetails } from "./search-details.ts";
import { TaskToolError } from "./shell-task-status.ts";
import { executeSupervisedToolTask } from "./tool-task.ts";
import { formatSize } from "./truncate.ts";

/** Most of a history:// search's output its result shows; the rest is saved to a file, as a shell's is. */
export const HISTORY_SEARCH_INLINE_BYTES = 40_000;
/** How often a search observed in the foreground reports its progress. */
const UPDATE_INTERVAL_MS = 250;

/**
 * What `output` holds, up to `maxBytes` from its start, with a note for any bytes it no longer keeps. A character its
 * pages split stays whole, and one that `maxBytes` cuts is left out.
 */
function outputText(output: ToolTaskOutput, maxBytes = Number.MAX_SAFE_INTEGER): string {
	const decoder = new TaskOutputDecoder();
	const pages: string[] = [];
	let offset = "0";
	let read = 0;
	while (read < maxBytes) {
		const page = output.page({ start: offset, maximumBytes: Math.min(64 * 1024, maxBytes - read) });
		if (!page.ok) break;
		pages.push(decoder.decode(page.value));
		read += Number(page.value.requested.end) - Number(offset);
		if (page.value.nextOffset === undefined) {
			pages.push(decoder.end());
			break;
		}
		offset = page.value.nextOffset;
	}
	return pages.join("");
}

export type HistorySearchDetails = SearchToolDetails & {
	/** How the call observed the search: settled, or yielded while it goes on as a task. */
	observation?: WaitOutcome;
	/** Where all of the search's output was saved when its result shows only the start. */
	fullOutputPath?: string;
	timeoutSeconds?: number;
};

/** How a finished search's result reads where it stands for one `search` call: its details, and the page `skip` selects. */
export interface HistorySearchShape {
	readonly cwd: string;
	/** What the call searched, as its result's details name it: its URLs without their `:N-M` selections. */
	readonly scopePath: string;
	/** The page selected from the targets, or undefined for the full output of a continuation chain. */
	readonly page: (
		text: string,
	) => { readonly text: string; readonly details?: SearchToolDetails | undefined } | undefined;
}

interface HistoryPage {
	readonly text: string;
	readonly details?: SearchToolDetails | undefined;
}

export interface HistorySearchCall extends HistorySearchRun {
	/** The ordinary search page. Records only provider answers that contributed, never the lookahead. */
	readonly firstPage?: (signal: AbortSignal, first: HistorySearchStep[]) => Promise<HistoryPage>;
	readonly timeoutSeconds: number;
	readonly wait?: WaitPolicy;
	readonly signal?: AbortSignal;
	readonly owner: SupervisedCommandOwner | undefined;
	readonly tempDir: string | undefined;
	readonly onUpdate?: (text: string) => void;
	readonly shape?: HistorySearchShape;
}

/**
 * Most bytes of notes a result whose output is cut still shows after its start: what the search could not read or
 * search, and where it stopped and continues from, must not be only in the saved file.
 */
const HISTORY_SEARCH_END_NOTE_BYTES = 4_000;
/**
 * A note that names where to continue, a stop or a page's end: the search's own (`<url>:0: [...]`, or `[...]` where it
 * stopped), not a match that quotes one.
 */
const CONTINUE_NOTE = /^(?:\S+?(?::0: |-0- ))?\[.*\bcontinue with history:\/\/\S+?\]\s*$/;
/** A note of the search that something was not covered: an entry it could not search, records it could not read. */
const GAP_NOTE = /^\S+?(?::0: |-0- )\[.*\b(?:not searched|unreadable)\b.*\]\s*$/;

/** Whether `line` is a note a cut result shows again: what was not covered, or where the search continues. */
function isKeptNote(line: string): boolean {
	if (line.includes("continue with history://") && CONTINUE_NOTE.test(line)) return true;
	return (line.includes("not searched") || line.includes("unreadable")) && GAP_NOTE.test(line);
}

/**
 * The notes of `rest`, the part of a search's output its cut result does not show, that the result shows after its
 * start, in order and within {@link HISTORY_SEARCH_END_NOTE_BYTES}: wherever they were printed, what the search could
 * not read or search and the pages it left for the next call (`continue with`), then the notes the output ends with,
 * which say where it stopped. Those come first when not all fit, and a line says how many of the others only the saved
 * output holds.
 */
function hiddenNotes(rest: string): string[] {
	const lines = rest.split("\n");
	const ending = new Set<number>();
	let bytes = 0;
	for (let index = lines.length - 1; index >= 0; index--) {
		const line = lines[index]!;
		if (line.trim().length === 0) continue;
		if (!CONTINUE_NOTE.test(line)) break;
		const size = Buffer.byteLength(line, "utf8") + 1;
		if (bytes + size > HISTORY_SEARCH_END_NOTE_BYTES) break;
		ending.add(index);
		bytes += size;
	}
	const kept: string[] = [];
	let left = 0;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		if (ending.has(index) || !isKeptNote(line)) continue;
		const size = Buffer.byteLength(line, "utf8") + 1;
		if (left > 0 || bytes + size > HISTORY_SEARCH_END_NOTE_BYTES) left++;
		else {
			kept.push(line);
			bytes += size;
		}
	}
	const more = left === 0 ? [] : [`[${left} more ${left === 1 ? "note" : "notes"} in the full output]`];
	return [...kept, ...more, ...[...ending].sort((a, b) => a - b).map((index) => lines[index]!)];
}

/** The first row delimiter ends the decoded URL, which can contain spaces. Context and line zero aren't hits. */
const HISTORY_ROW = /^(history:\/\/.+?)(?::(\d+): |-\d+- )/;

/** How many matches `text`, all a search printed, holds, and in how many sessions, runs or entries. */
function matchCounts(text: string): { readonly matchCount: number; readonly fileCount: number } {
	const files = new Set<string>();
	let matchCount = 0;
	for (const line of text.split("\n")) {
		const row = HISTORY_ROW.exec(line);
		if (!row?.[2] || Number(row[2]) === 0) continue;
		matchCount++;
		files.add(row[1]!);
	}
	return { matchCount, fileCount: files.size };
}

interface HistoryOutput {
	readonly text: string;
	readonly fullOutputPath?: string;
	/** How many matches all of the output holds: its notes and context rows are not matches. */
	readonly matchCount: number;
	readonly fileCount: number;
}

/**
 * What a search printed, as its result shows it: the start, and all of it in a file when there is more. A result cut
 * short still shows what the search could not read or search and the notes its output ends with, so what it missed and
 * where to continue from are always in the result.
 */
async function formatHistoryOutput(text: string, tempDir: string | undefined): Promise<HistoryOutput> {
	const counts = matchCounts(text);
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= HISTORY_SEARCH_INLINE_BYTES) return { text, ...counts };
	let head = truncateBufferAtUtf8Boundary(bytes, HISTORY_SEARCH_INLINE_BYTES - HISTORY_SEARCH_END_NOTE_BYTES).toString(
		"utf8",
	);
	const lastNewline = head.lastIndexOf("\n");
	if (lastNewline > 0) head = head.slice(0, lastNewline);
	const notes = hiddenNotes(text.slice(head.length));
	let fullOutputPath: string | undefined;
	try {
		const directory = tempDir ?? tmpdir();
		await mkdir(directory, { recursive: true });
		const path = join(directory, `search-${randomUUID()}.txt`);
		const file = await PersistedOutputFile.create(path);
		file.write(bytes);
		await file.close();
		if (file.error === undefined) fullOutputPath = path;
	} catch {
		// The file could not be written: the result still shows the start, and names no path.
	}
	const shown = `the first ${formatSize(Buffer.byteLength(head, "utf8"))} of ${formatSize(bytes.length)}${notes.length > 0 ? " and the notes below" : ""}`;
	const note = `[Showing ${shown}.${fullOutputPath ? ` Full output: ${fullOutputPath}` : ""}]`;
	return {
		text: [head, "", note, ...notes].join("\n"),
		...(fullOutputPath === undefined ? {} : { fullOutputPath }),
		...counts,
	};
}

/** Most background searches whose timeout and shown output this process remembers for their waits. */
const REMEMBERED_SEARCHES = 256;

/** Set `key` in `map`, forgetting the oldest entries past {@link REMEMBERED_SEARCHES}. */
function remember<V>(map: Map<string, V>, key: string, value: V): void {
	map.delete(key);
	map.set(key, value);
	while (map.size > REMEMBERED_SEARCHES) map.delete(map.keys().next().value!);
}

/** The execution timeout each background search launched in this process runs under, by task id. */
const launchTimeouts = new Map<string, number>();
/** How the result of each background search launched in this process reads once it ends, by task id. */
const launchShapes = new Map<string, HistorySearchShape>();

function stillRunning(taskId: string, timeoutSeconds: number | undefined): string {
	const timeout =
		timeoutSeconds === undefined
			? ""
			: ` Its execution timeout stops it after ${formatTimeoutSeconds(timeoutSeconds * 1000)}; ${longerRunAdvice(timeoutSeconds * 1000, "launch")}`;
	return `Search is still running (task ${taskId}).${timeout} Wait for it with search({ action: "wait", id: "${taskId}" }) or stop it with kill; do not start it again.`;
}

function settledResult(
	observation: WaitOutcome,
	output: HistoryOutput,
	timeoutSeconds: number | undefined,
): AgentToolResult<HistorySearchDetails> {
	const details: HistorySearchDetails = {
		observation,
		...(output.fullOutputPath === undefined ? {} : { fullOutputPath: output.fullOutputPath }),
		...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
		// What it found once it ended; a search still running has no count yet.
		...(observation.kind === "settled" ? { matchCount: output.matchCount, fileCount: output.fileCount } : {}),
	};
	if (observation.kind === "yielded")
		return {
			content: [
				{
					type: "text",
					text: `${output.text ? `${output.text}\n\n` : ""}${stillRunning(observation.taskId, timeoutSeconds)}`,
				},
			],
			details,
		};
	const result = observation.result;
	if (result.kind === "completed")
		return { content: [{ type: "text", text: output.text || "No matches found" }], details };
	if (result.kind === "failed")
		throw new Error(`${output.text ? `${output.text}\n\n` : ""}Search failed: ${result.message}`);
	const timedOut = result.cause === "execution-timeout";
	const status = timedOut
		? `Search timed out${timeoutSeconds === undefined ? "" : ` after ${formatTimeoutSeconds(timeoutSeconds * 1000)}`} before it finished. Continue with the URL above, or ${longerRunAdvice(timeoutSeconds === undefined ? undefined : timeoutSeconds * 1000, "rerun")}`
		: "Search was stopped before it finished; continue with the URL above if its results are still needed.";
	return {
		content: [{ type: "text", text: `${output.text ? `${output.text}\n\n` : ""}${status}` }],
		details,
		isError: true,
	};
}

/**
 * The result of a search the call observed, from all it printed: the page its `skip` selects once it has finished, and
 * once it has ended the details a search result carries (what it covered, each match's location, the text shown).
 */
async function historyResult(
	observation: WaitOutcome,
	text: string,
	timeoutSeconds: number | undefined,
	tempDir: string | undefined,
	shape: HistorySearchShape | undefined,
): Promise<AgentToolResult<HistorySearchDetails>> {
	const page =
		observation.kind === "settled" && observation.result.kind === "completed" ? shape?.page(text) : undefined;
	if (page) {
		return {
			content: [{ type: "text", text: page.text }],
			details: {
				...page.details,
				observation,
				...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
				...matchCounts(page.text),
			},
		};
	}
	const result = settledResult(observation, await formatHistoryOutput(text, tempDir), timeoutSeconds);
	if (shape === undefined || observation.kind !== "settled") return result;
	const shown = result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
	return {
		...result,
		details: { ...buildSearchDetails(undefined, shown, shape.cwd, shape.scopePath), ...result.details },
	};
}

/** Run a history:// search: as a task of `call.owner` when it can run one, else in the foreground. */
export async function runHistorySearch(call: HistorySearchCall): Promise<AgentToolResult<HistorySearchDetails>> {
	// What the call observed, kept to the same bound as a tool task's output; the rest is counted, not kept.
	const output = new ToolTaskOutput();
	let lastUpdate = 0;
	const collect = (bytes: Buffer) => {
		output.append(bytes);
		// Progress shows the start of what was found, at most every quarter second.
		const now = Date.now();
		if (call.onUpdate === undefined || now - lastUpdate < UPDATE_INTERVAL_MS) return;
		lastUpdate = now;
		call.onUpdate(outputText(output, HISTORY_SEARCH_INLINE_BYTES));
	};
	const deadline = performance.now() + call.timeoutSeconds * 1000;
	let shape = call.shape;
	let firstPage: HistoryPage | undefined;
	let work = historySearchWork(call);
	let deliver: (() => void) | undefined;
	if (call.firstPage) {
		const first: HistorySearchStep[] = [];
		const timeout = new AbortController();
		const signal = call.signal ? AbortSignal.any([call.signal, timeout.signal]) : timeout.signal;
		const timer = setTimeout(() => timeout.abort("execution-timeout"), call.timeoutSeconds * 1000);
		try {
			firstPage = await call.firstPage(signal, first);
			signal.throwIfAborted();
		} catch (error) {
			call.signal?.throwIfAborted();
			if (!timeout.signal.aborted) throw error;
			const pending = call.urls.slice(first.length);
			const text = [
				...first.map((step) => step.answer ?? ""),
				...pending.map((url) => `[search stopped before it finished; continue with ${url}]`),
			].join("\n");
			return historyResult(
				foregroundObservation("execution-timeout"),
				text,
				call.timeoutSeconds,
				call.tempDir,
				shape,
			);
		} finally {
			clearTimeout(timer);
		}
		const page = firstPage;
		if (!first.some(({ answer }) => answer?.split("\n").some((line) => historyContinuation(line) !== undefined))) {
			if (call.wait?.kind !== "background") {
				return {
					content: [{ type: "text", text: page.text }],
					details: { ...page.details, ...matchCounts(page.text) },
				};
			}
			// An explicit background caller still gets its task ID. Delivery does not read any provider again.
			const delivery = Promise.withResolvers<void>();
			deliver = delivery.resolve;
			work = async (write, signal) => {
				await delivery.promise;
				if (signal.aborted) return "stopped";
				write(page.text);
				return "finished";
			};
			if (shape) shape = { ...shape, page: () => page };
		} else work = historySearchWork(call, first);
	}
	const remainingMs = Math.max(1, deadline - performance.now());
	if (call.owner?.startToolTask !== undefined) {
		const label = `search ${graphemeHead(call.pattern.replace(/\s+/g, " "), 80)} in ${call.urls.join(", ")}`;
		const result = await executeSupervisedToolTask(call.owner, {
			tool: "search",
			label,
			cwd: call.cwd,
			timeoutMs: remainingMs,
			...(call.wait === undefined ? {} : { wait: call.wait }),
			...(call.signal === undefined ? {} : { signal: call.signal }),
			onData: collect,
			work,
		}).finally(() => deliver?.());
		if (result.observation?.kind === "yielded") {
			remember(launchTimeouts, result.taskId, call.timeoutSeconds);
			if (shape !== undefined) remember(launchShapes, result.taskId, shape);
			if (firstPage) {
				const yielded = settledResult(
					result.observation,
					{ ...firstPage, ...matchCounts(firstPage.text) },
					call.timeoutSeconds,
				);
				return { ...yielded, details: { ...firstPage.details, ...yielded.details } };
			}
		}
		return historyResult(result.observation!, outputText(output), call.timeoutSeconds, call.tempDir, shape);
	}
	// No owner runs it as a task: it runs here until it ends, as an unbound bash command waits until it completes.
	const stop = new AbortController();
	const forward = () => stop.abort(call.signal?.reason ?? "user");
	call.signal?.addEventListener("abort", forward, { once: true });
	if (call.signal?.aborted) forward();
	const timer = setTimeout(() => stop.abort("execution-timeout"), remainingMs);
	let ended: "finished" | "stopped";
	try {
		ended = await work((text) => collect(Buffer.from(text, "utf8")), stop.signal);
	} finally {
		clearTimeout(timer);
		call.signal?.removeEventListener("abort", forward);
	}
	if (ended === "stopped") call.signal?.throwIfAborted();
	const cause =
		ended === "finished" ? undefined : stop.signal.reason === "execution-timeout" ? "execution-timeout" : "user";
	return historyResult(foregroundObservation(cause), outputText(output), call.timeoutSeconds, call.tempDir, shape);
}

function foregroundObservation(cause?: "execution-timeout" | "user"): WaitOutcome {
	const taskId = "foreground" as TaskId;
	const output = { ownerId: "" as never, taskId, artifactId: "", byteCount: "0", omittedRanges: [] };
	return {
		kind: "settled",
		taskId,
		result: cause === undefined ? { kind: "completed", output } : { kind: "cancelled", cause, output },
	};
}

/** How far a yielded wait already showed a task's output, so the next wait shows only what followed. */
const shownThrough = new Map<string, string>();

/** `search({ action: "wait", id })`: observe a background search as `bash` waits observe a shell. */
export async function waitForHistorySearch(
	owner: SupervisedCommandOwner | undefined,
	id: string,
	budgetMs: number | undefined,
	signal: AbortSignal | undefined,
	tempDir: string | undefined,
): Promise<AgentToolResult<HistorySearchDetails>> {
	if (!owner) throw new Error("Search task wait requires a supported task owner");
	signal?.throwIfAborted();
	const task = lookupOwnedTask(owner, id);
	const record = owner.supervisor.taskRecords(owner.owner, new Set([id as TaskId]))[0];
	if (record !== undefined && record.kind !== "tool")
		throw new TaskToolError(
			{ code: "UnknownTask", message: "not a background search; wait for it with its own tool" },
			id,
		);
	let lease: Parameters<NonNullable<SupervisedCommandOwner["waitForTask"]>>[2] extends
		| ((wait: infer W) => void)
		| undefined
		? W | undefined
		: never;
	const abort = () => {
		if (lease) owner.supervisor.disposeTaskWait(lease);
	};
	signal?.addEventListener("abort", abort, { once: true });
	try {
		const observed = await (owner.waitForTask
			? owner.waitForTask(id as TaskId, budgetMs, (wait) => {
					lease = wait;
					if (signal?.aborted) abort();
				})
			: owner.supervisor.waitForTaskId(owner.owner, id as TaskId, budgetMs, (wait) => {
					lease = wait;
					if (signal?.aborted) abort();
				}));
		signal?.throwIfAborted();
		if (!observed.ok) throw new TaskToolError(observed.error, id);
		// A wait that yields shows what followed the last one; the wait that sees it settle shows all of it.
		let offset = observed.value.kind === "yielded" ? (shownThrough.get(id) ?? "0") : "0";
		const decoder = new TaskOutputDecoder();
		const pages: string[] = [];
		for (;;) {
			const page = await owner.supervisor.readTaskOutput(task, { start: offset, maximumBytes: 64 * 1024 });
			if (!page.ok) throw new TaskToolError(page.error, id);
			pages.push(decoder.decode(page.value));
			const end = page.value.chunks.at(-1)?.offsets.end ?? page.value.omittedRanges.at(-1)?.end ?? offset;
			if (page.value.nextOffset === undefined) {
				pages.push(decoder.end());
				offset = end;
				break;
			}
			offset = page.value.nextOffset;
		}
		const timeoutSeconds = launchTimeouts.get(id);
		const shape = launchShapes.get(id);
		if (observed.value.kind === "yielded") remember(shownThrough, id, offset);
		else shownThrough.delete(id);
		// A later wait can reread a settled task. Keep its bounded launch metadata for that read too.
		return historyResult(observed.value, pages.join(""), timeoutSeconds, tempDir, shape);
	} finally {
		signal?.removeEventListener("abort", abort);
	}
}
