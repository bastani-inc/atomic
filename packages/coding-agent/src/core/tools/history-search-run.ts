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
import { formatTimeoutSeconds, longerRunAdvice } from "../tasks/cancel-reason.js";
import { taskOutputText } from "../tasks/command-output.js";
import type { TaskId, WaitOutcome, WaitPolicy } from "../tasks/contracts.js";
import { ToolTaskOutput } from "../tasks/supervisor.js";
import { lookupOwnedTask, type SupervisedCommandOwner } from "./bash-pty-native.js";
import { type HistorySearchRun, historySearchWork } from "./history-search-task.ts";
import { PersistedOutputFile, truncateBufferAtUtf8Boundary } from "./persisted-output-file.ts";
import type { SearchToolDetails } from "./search-details.ts";
import { TaskToolError } from "./shell-task-status.ts";
import { executeSupervisedToolTask } from "./tool-task.ts";
import { formatSize } from "./truncate.ts";

/** Most of a history:// search's output its result shows; the rest is saved to a file, as a shell's is. */
export const HISTORY_SEARCH_INLINE_BYTES = 40_000;
/** How often a search observed in the foreground reports its progress. */
const UPDATE_INTERVAL_MS = 250;

/** What `output` holds, up to `maxBytes` from its start, with a note for any bytes it no longer keeps. */
function outputText(output: ToolTaskOutput, maxBytes = Number.MAX_SAFE_INTEGER): string {
	const pages: string[] = [];
	let offset = "0";
	let read = 0;
	while (read < maxBytes) {
		const page = output.page({ start: offset, maximumBytes: Math.min(64 * 1024, maxBytes - read) });
		if (!page.ok) break;
		pages.push(taskOutputText(page.value));
		read += Number(page.value.requested.end) - Number(offset);
		if (page.value.nextOffset === undefined) break;
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

export interface HistorySearchCall extends HistorySearchRun {
	readonly timeoutSeconds: number;
	readonly wait?: WaitPolicy;
	readonly signal?: AbortSignal;
	readonly owner: SupervisedCommandOwner | undefined;
	readonly tempDir: string | undefined;
	readonly onUpdate?: (text: string) => void;
}

/**
 * Most bytes of the notes that end a search's output a result whose output is cut still shows after its start: where
 * the search stopped, and where to continue from, are printed last and must not be only in the saved file.
 */
const HISTORY_SEARCH_END_NOTE_BYTES = 4_000;
/**
 * A note that names where to continue, a stop or a page's end: the search's own (`<url>:0: [...]`, or `[...]` where it
 * stopped), not a match that quotes one.
 */
const CONTINUE_NOTE = /^(?:\S+?(?::0: |-0- ))?\[.*\bcontinue with history:\/\/\S+?\]\s*$/;

/** The notes `rest` ends with that name where to continue, in order, within {@link HISTORY_SEARCH_END_NOTE_BYTES}. */
function endNotes(rest: string): string[] {
	const notes: string[] = [];
	let bytes = 0;
	const lines = rest.split("\n");
	for (let index = lines.length - 1; index >= 0; index--) {
		const line = lines[index]!;
		if (line.trim().length === 0) continue;
		if (!CONTINUE_NOTE.test(line)) break;
		const size = Buffer.byteLength(line, "utf8") + 1;
		if (bytes + size > HISTORY_SEARCH_END_NOTE_BYTES) break;
		notes.unshift(line);
		bytes += size;
	}
	return notes;
}

/**
 * What a search printed, as its result shows it: the start, and all of it in a file when there is more. A result cut
 * short still shows the notes its output ends with, so where to continue from is always in the result.
 */
async function formatHistoryOutput(
	text: string,
	tempDir: string | undefined,
): Promise<{ readonly text: string; readonly fullOutputPath?: string }> {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= HISTORY_SEARCH_INLINE_BYTES) return { text };
	let head = truncateBufferAtUtf8Boundary(bytes, HISTORY_SEARCH_INLINE_BYTES - HISTORY_SEARCH_END_NOTE_BYTES).toString(
		"utf8",
	);
	const lastNewline = head.lastIndexOf("\n");
	if (lastNewline > 0) head = head.slice(0, lastNewline);
	const notes = endNotes(text.slice(head.length));
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
	const shown = `the first ${formatSize(Buffer.byteLength(head, "utf8"))} of ${formatSize(bytes.length)}${notes.length > 0 ? " and the notes it ends with" : ""}`;
	const note = `[Showing ${shown}.${fullOutputPath ? ` Full output: ${fullOutputPath}` : ""}]`;
	return {
		text: [head, "", note, ...notes].join("\n"),
		...(fullOutputPath === undefined ? {} : { fullOutputPath }),
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

function stillRunning(taskId: string, timeoutSeconds: number | undefined): string {
	const timeout =
		timeoutSeconds === undefined
			? ""
			: ` Its execution timeout stops it after ${formatTimeoutSeconds(timeoutSeconds * 1000)}; ${longerRunAdvice(timeoutSeconds * 1000, "launch")}`;
	return `Search is still running (task ${taskId}).${timeout} Wait for it with search({ action: "wait", id: "${taskId}" }) or stop it with kill; do not start it again.`;
}

function settledResult(
	observation: WaitOutcome,
	output: { readonly text: string; readonly fullOutputPath?: string },
	timeoutSeconds: number | undefined,
): AgentToolResult<HistorySearchDetails> {
	const details: HistorySearchDetails = {
		observation,
		...(output.fullOutputPath === undefined ? {} : { fullOutputPath: output.fullOutputPath }),
		...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
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
	const work = historySearchWork(call);
	if (call.owner?.startToolTask !== undefined) {
		const label = `search ${call.pattern.replace(/\s+/g, " ").slice(0, 80)} in ${call.urls.join(", ")}`;
		const result = await executeSupervisedToolTask(call.owner, {
			tool: "search",
			label,
			cwd: call.cwd,
			timeoutMs: call.timeoutSeconds * 1000,
			...(call.wait === undefined ? {} : { wait: call.wait }),
			...(call.signal === undefined ? {} : { signal: call.signal }),
			onData: collect,
			work,
		});
		if (result.observation?.kind === "yielded") remember(launchTimeouts, result.taskId, call.timeoutSeconds);
		const formatted = await formatHistoryOutput(outputText(output), call.tempDir);
		return settledResult(result.observation!, formatted, call.timeoutSeconds);
	}
	// No owner runs it as a task: it runs here until it ends, as an unbound bash command waits until it completes.
	const stop = new AbortController();
	const forward = () => stop.abort(call.signal?.reason ?? "user");
	call.signal?.addEventListener("abort", forward, { once: true });
	if (call.signal?.aborted) forward();
	const timer = setTimeout(() => stop.abort("execution-timeout"), call.timeoutSeconds * 1000);
	const taskId = "foreground" as TaskId;
	let ended: "finished" | "stopped";
	try {
		ended = await work((text) => collect(Buffer.from(text, "utf8")), stop.signal);
	} finally {
		clearTimeout(timer);
		call.signal?.removeEventListener("abort", forward);
	}
	if (call.signal?.aborted && ended === "stopped") throw new Error("aborted");
	const formatted = await formatHistoryOutput(outputText(output), call.tempDir);
	const cause =
		ended === "finished" ? undefined : stop.signal.reason === "execution-timeout" ? "execution-timeout" : "user";
	const outputRef = { ownerId: "" as never, taskId, artifactId: "", byteCount: "0", omittedRanges: [] };
	return settledResult(
		{
			kind: "settled",
			taskId,
			result:
				cause === undefined
					? { kind: "completed", output: outputRef }
					: { kind: "cancelled", cause, output: outputRef },
		},
		formatted,
		call.timeoutSeconds,
	);
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
	if (signal?.aborted) throw new Error("aborted");
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
		if (signal?.aborted) throw new Error("aborted");
		if (!observed.ok) throw new TaskToolError(observed.error, id);
		// A wait that yields shows what followed the last one; the wait that sees it settle shows all of it.
		let offset = observed.value.kind === "yielded" ? (shownThrough.get(id) ?? "0") : "0";
		const pages: string[] = [];
		for (;;) {
			const page = await owner.supervisor.readTaskOutput(task, { start: offset, maximumBytes: 64 * 1024 });
			if (!page.ok) throw new TaskToolError(page.error, id);
			pages.push(taskOutputText(page.value));
			const end = page.value.chunks.at(-1)?.offsets.end ?? page.value.omittedRanges.at(-1)?.end ?? offset;
			if (page.value.nextOffset === undefined) {
				offset = end;
				break;
			}
			offset = page.value.nextOffset;
		}
		const timeoutSeconds = launchTimeouts.get(id);
		if (observed.value.kind === "yielded") remember(shownThrough, id, offset);
		else {
			shownThrough.delete(id);
			launchTimeouts.delete(id);
		}
		const output = await formatHistoryOutput(pages.join(""), tempDir);
		return settledResult(observed.value, output, timeoutSeconds);
	} finally {
		signal?.removeEventListener("abort", abort);
	}
}
