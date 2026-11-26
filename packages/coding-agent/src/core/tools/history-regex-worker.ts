import { Worker } from "node:worker_threads";
import { EVAL_WORKER_BUILTIN, evalWorkerExecArgv } from "../../utils/worker-threads.js";

export type WorkerOutlineKind = "user" | "compaction" | "branch summary";

export interface WorkerOutlineInfo {
	readonly count:
		| "user"
		| "assistant"
		| "toolResult"
		| "bash"
		| "compaction"
		| "branchSummary"
		| "sessionSummary"
		| "customMessage"
		| "other";
	readonly item?: {
		readonly at: string;
		readonly kind: WorkerOutlineKind;
		readonly preview: string;
	};
}

export interface MultilineSpan {
	readonly startLine: number;
	readonly endLine: number;
}

const WORKER_SCRIPT = `
${EVAL_WORKER_BUILTIN}
const { parentPort } = builtin("node:worker_threads");
const LINE_WIDTH = 4000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function wrapLine(line) {
	const parts = [];
	let rest = line;
	while (rest.length > LINE_WIDTH) {
		let cut = rest.lastIndexOf(" ", LINE_WIDTH - 1) + 1;
		if (cut < LINE_WIDTH * 0.75) {
			cut = LINE_WIDTH;
			const last = rest.charCodeAt(cut - 1);
			if (last >= 0xd800 && last <= 0xdbff) cut--;
		}
		parts.push(rest.slice(0, cut));
		rest = rest.slice(cut);
	}
	parts.push(rest);
	return parts;
}

function textLines(text) {
	return String(text ?? "").split("\\n").flatMap(wrapLine);
}

function timestamp(value) {
	if (value === undefined) return "unknown time";
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function cutAt(text, end) {
	if (text.length <= end) return text;
	const high = text.charCodeAt(end - 1);
	const low = text.charCodeAt(end);
	const splitsPair = high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
	return text.slice(0, splitsPair ? end - 1 : end);
}

function oneLine(text, limit) {
	const source = String(text ?? "");
	let flat = "";
	let pendingSpace = false;
	for (let i = 0; i < source.length && flat.length <= limit; i++) {
		const ch = source[i];
		if (/\\s/.test(ch)) {
			if (flat.length > 0) pendingSpace = true;
			continue;
		}
		if (pendingSpace) {
			flat += " ";
			pendingSpace = false;
			if (flat.length > limit) break;
		}
		flat += ch;
	}
	return flat.length > limit ? cutAt(flat, limit) + "…" : flat;
}

function messageText(content, limit) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let out = "";
	for (const block of content) {
		if (block && block.type === "text" && typeof block.text === "string") {
			const piece = oneLine(block.text, limit + 1);
			if (!piece) continue;
			out += (out ? " " : "") + piece;
			if (out.length > limit + 1) break;
		}
	}
	return out;
}

function classify(entry, previewChars) {
	const at = timestamp(entry.timestamp);
	switch (entry.type) {
		case "message": {
			const msg = entry.message || {};
			switch (msg.role) {
				case "user":
					return { count: "user", item: { at, kind: "user", preview: oneLine(messageText(msg.content, previewChars), previewChars) } };
				case "assistant":
					return { count: "assistant" };
				case "toolResult":
					return { count: "toolResult" };
				case "bashExecution":
					return { count: "bash" };
				case "custom":
					return { count: "customMessage" };
				case "branchSummary":
					return { count: "branchSummary", item: { at, kind: "branch summary", preview: oneLine(msg.summary, previewChars) } };
				default:
					return { count: "other" };
			}
		}
		case "compaction":
			return { count: "compaction", item: { at, kind: "compaction", preview: oneLine(entry.summary, previewChars) } };
		case "branch_summary":
			return { count: "branchSummary", item: { at, kind: "branch summary", preview: oneLine(entry.summary, previewChars) } };
		case "session_summary":
			return { count: "sessionSummary" };
		case "custom_message":
			return { count: "customMessage" };
		default:
			return { count: "other" };
	}
}

function contentLines(content) {
	if (typeof content === "string") return textLines(content);
	if (!Array.isArray(content)) return [];
	const lines = [];
	for (const block of content) {
		if (!block) continue;
		if (block.type === "text" && typeof block.text === "string") lines.push(...textLines(block.text));
		else if (block.type === "toolCall")
			lines.push(...wrapLine("[tool call] " + (block.name ?? "unknown") + " " + JSON.stringify(block.arguments ?? {})));
		else if (block.type === "image") lines.push("[image]");
	}
	return lines;
}

function entryLines(entry) {
	const heading = (label) => textLines("## " + timestamp(entry.timestamp) + " " + label);
	switch (entry.type) {
		case "message": {
			const message = entry.message || {};
			switch (message.role) {
				case "user":
					return [...heading("user"), ...contentLines(message.content)];
				case "assistant":
					return [...heading("assistant"), ...contentLines(message.content)];
				case "toolResult":
					return [...heading("tool result " + message.toolName), ...contentLines(message.content)];
				case "bashExecution":
					return [...heading("bash"), ...textLines("$ " + message.command), ...textLines(message.output)];
				case "custom":
					return [...heading("custom " + message.customType), ...contentLines(message.content)];
				case "branchSummary":
					return [...heading("branch summary"), ...textLines(message.summary)];
				default:
					return [];
			}
		}
		case "custom_message":
			return [...heading("custom " + entry.customType), ...contentLines(entry.content)];
		case "compaction":
		case "branch_summary":
		case "session_summary":
			return [...heading(String(entry.type).replace("_", " ")), ...textLines(entry.summary)];
		case "session_info":
			return entry.name ? heading("session name: " + entry.name) : [];
		default:
			return [];
	}
}

function lineNumberAt(newlines, index) {
	let low = 0;
	let high = newlines.length;
	while (low < high) {
		const mid = (low + high) >> 1;
		if (newlines[mid] < index) low = mid + 1;
		else high = mid;
	}
	return low;
}

parentPort.on("message", (msg) => {
	if (!msg || typeof msg.id !== "number") return;
	try {
		if (msg.op === "lines") {
			const re = msg.literal ? undefined : new RegExp(msg.pattern, msg.flags);
			const needle = msg.ignoreCase ? msg.pattern.toLowerCase() : msg.pattern;
			const matchedIndices = [];
			for (let i = 0; i < msg.lines.length; i++) {
				const line = msg.lines[i];
				const hit = re ? re.test(line) : (msg.ignoreCase ? line.toLowerCase() : line).includes(needle);
				if (hit) matchedIndices.push(i);
			}
			parentPort.postMessage({ id: msg.id, matchedIndices });
			return;
		}
		if (msg.op === "multiline") {
			const text = msg.text;
			const newlines = [];
			for (let i = text.indexOf("\\n"); i !== -1; i = text.indexOf("\\n", i + 1)) newlines.push(i);
			const matches = [];
			if (msg.literal) {
				const haystack = msg.ignoreCase ? text.toLowerCase() : text;
				const needle = msg.ignoreCase ? msg.pattern.toLowerCase() : msg.pattern;
				if (needle.length > 0) {
					for (let at = haystack.indexOf(needle, msg.ownedFrom); at !== -1 && at < msg.ownedTo; at = haystack.indexOf(needle, at + 1)) {
						const endIdx = Math.max(at, at + needle.length - 1);
						matches.push({ startLine: lineNumberAt(newlines, at), endLine: lineNumberAt(newlines, endIdx) });
					}
				}
			} else {
				const flags = msg.flags.includes("g") ? msg.flags : msg.flags + "g";
				const re = new RegExp(msg.pattern, flags);
				const record = (match) => {
					const length = match[0].length;
					const endIdx = length > 0 ? match.index + length - 1 : match.index;
					matches.push({ startLine: lineNumberAt(newlines, match.index), endLine: lineNumberAt(newlines, endIdx) });
				};
				re.lastIndex = msg.ownedFrom;
				if (msg.startPattern !== undefined) {
					const sticky = new RegExp(msg.startPattern, flags.replace("g", "") + "y");
					sticky.lastIndex = msg.ownedFrom;
					const match = sticky.exec(text);
					if (match !== null && match.index < msg.ownedTo) {
						record(match);
						re.lastIndex = match.index + Math.max(1, match[0].length);
					} else re.lastIndex = msg.ownedFrom + 1;
				}
				for (let match = re.exec(text); match !== null; match = re.exec(text)) {
					if (match.index >= msg.ownedTo) break;
					record(match);
					if (match[0].length === 0) re.lastIndex++;
				}
			}
			parentPort.postMessage({ id: msg.id, matches });
			return;
		}
		if (msg.op === "entry") {
			const chunks = msg.chunks;
			let bytes;
			if (chunks.length === 1) bytes = chunks[0];
			else {
				const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
				bytes = new Uint8Array(total);
				let offset = 0;
				for (const c of chunks) {
					bytes.set(c, offset);
					offset += c.byteLength;
				}
			}
			const parsed = JSON.parse(decoder.decode(bytes));
			const entry =
				msg.formatVersion !== undefined && msg.formatVersion < 3 && parsed && parsed.type === "message" && parsed.message && parsed.message.role === "hookMessage"
					? { ...parsed, message: { ...parsed.message, role: "custom" } }
					: parsed;
			const outline = classify(entry, msg.previewChars);
			const lines = entryLines(entry);
			const renderedUtf8 = encoder.encode(lines.join("\\n"));
			parentPort.postMessage({ id: msg.id, outline, renderedUtf8 }, [renderedUtf8.buffer]);
			return;
		}
	} catch (err) {
		parentPort.postMessage({ id: msg.id, error: err instanceof Error ? err.message : String(err) });
	}
});
`;

interface WorkerReplies {
	readonly lines: { readonly matchedIndices: readonly number[] };
	readonly multiline: { readonly matches: readonly MultilineSpan[] };
	readonly entry: { readonly outline: WorkerOutlineInfo; readonly renderedUtf8: Uint8Array };
}

interface PatternRequest {
	readonly pattern: string;
	readonly flags: string;
	readonly ignoreCase: boolean;
	readonly literal: boolean;
}

interface WorkerRequests {
	readonly lines: PatternRequest & { readonly op: "lines"; readonly lines: readonly string[] };
	readonly multiline: PatternRequest & {
		readonly op: "multiline";
		readonly text: string;
		readonly ownedFrom: number;
		readonly ownedTo: number;
		readonly startPattern: string | undefined;
	};
	readonly entry: {
		readonly op: "entry";
		readonly chunks: readonly Uint8Array[];
		readonly previewChars: number;
		readonly formatVersion: number | undefined;
	};
}

type WorkerOp = keyof WorkerReplies;

type WorkerReply = { readonly id: number; readonly error?: string } & Partial<
	WorkerReplies["lines"] & WorkerReplies["multiline"] & WorkerReplies["entry"]
>;

type TaskOutcome = { readonly reply: WorkerReply } | { readonly timedOut: true } | { readonly error: Error };

interface PendingTask {
	readonly id: number;
	readonly payload: WorkerRequests[WorkerOp];
	readonly transfer?: readonly ArrayBuffer[];
	readonly deadline: number;
	readonly settle: (outcome: TaskOutcome) => void;
	dispatched: boolean;
	/** Hands a task with no time limit the shared worker as its own once it has run {@link OWN_WORKER_AFTER_MS}. */
	handOff?: ReturnType<typeof setTimeout>;
}

/**
 * How long a task with no time limit (a background history task's) runs on the shared worker before it gets that
 * worker to itself and the tasks after it get a new one. Its pattern may backtrack for minutes, and nothing but its
 * own stop would end it, so every other history call would otherwise wait behind it.
 */
const OWN_WORKER_AFTER_MS = 200;

let activeWorker: Worker | undefined;
let activeTask: PendingTask | undefined;
const waitingQueue: PendingTask[] = [];
/** Workers handed to one long task with no time limit; each runs only that task and ends with it. */
const ownWorkers = new Map<Worker, PendingTask>();
let nextRequestId = 1;

function spawnWorker(): Worker {
	const worker = new Worker(WORKER_SCRIPT, { eval: true, execArgv: evalWorkerExecArgv() });
	worker.on("message", (message: WorkerReply) => {
		const task = worker === activeWorker ? activeTask : ownWorkers.get(worker);
		if (!task || !message || message.id !== task.id) return;
		if (worker === activeWorker) activeTask = undefined;
		else endOwnWorker(worker);
		if (message.error !== undefined) {
			task.settle({ error: new Error(message.error) });
		} else {
			task.settle({ reply: message });
		}
		pumpQueue();
	});
	worker.on("error", (error: Error) => {
		let task: PendingTask | undefined;
		if (worker === activeWorker) {
			killActiveWorker();
			task = activeTask;
			activeTask = undefined;
		} else {
			task = ownWorkers.get(worker);
			if (!task) return;
			endOwnWorker(worker);
		}
		task?.settle({ error });
		pumpQueue();
	});
	worker.unref();
	return worker;
}

function getWorker(): Worker {
	activeWorker ??= spawnWorker();
	return activeWorker;
}

function killActiveWorker(): void {
	const current = activeWorker;
	activeWorker = undefined;
	if (current) void current.terminate();
}

function endOwnWorker(worker: Worker): void {
	ownWorkers.delete(worker);
	void worker.terminate();
}

function handOffActiveWorker(task: PendingTask): void {
	if (activeTask !== task || !activeWorker) return;
	ownWorkers.set(activeWorker, task);
	activeWorker = undefined;
	activeTask = undefined;
	pumpQueue();
}

function pumpQueue(): void {
	while (activeTask === undefined && waitingQueue.length > 0) {
		const next = waitingQueue.shift()!;
		if (performance.now() >= next.deadline) {
			next.settle({ timedOut: true });
			continue;
		}
		try {
			const worker = getWorker();
			worker.postMessage({ ...next.payload, id: next.id }, next.transfer ? [...next.transfer] : []);
			next.dispatched = true;
			activeTask = next;
			if (!Number.isFinite(next.deadline)) {
				next.handOff = setTimeout(() => handOffActiveWorker(next), OWN_WORKER_AFTER_MS);
				next.handOff.unref?.();
			}
		} catch (error) {
			activeTask = undefined;
			next.dispatched = false;
			next.settle({ error: error instanceof Error ? error : new Error(String(error)) });
		}
	}
}

function runWorkerTask<Op extends WorkerOp>(
	payload: WorkerRequests[Op],
	timeoutMs: number,
	signal: AbortSignal | undefined,
	transfer?: readonly ArrayBuffer[],
): Promise<{ readonly value: WorkerReplies[Op] } | { readonly timedOut: true }> {
	if (signal?.aborted) {
		return Promise.reject(signal.reason ?? new Error("Operation aborted"));
	}
	const effectiveMs = Math.max(5, timeoutMs);
	const deadline = performance.now() + effectiveMs;
	const id = nextRequestId++;
	return new Promise<{ readonly value: WorkerReplies[Op] } | { readonly timedOut: true }>((resolve, reject) => {
		let settled = false;
		const task: PendingTask = {
			id,
			payload,
			...(transfer === undefined ? {} : { transfer }),
			deadline,
			dispatched: false,
			settle(outcome) {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				clearTimeout(task.handOff);
				signal?.removeEventListener("abort", onAbort);
				if ("error" in outcome) reject(outcome.error);
				else if ("timedOut" in outcome) resolve(outcome);
				else resolve({ value: outcome.reply as WorkerReplies[Op] });
			},
		};
		const removeOrCancel = (outcome: { readonly timedOut: true } | { readonly error: Error }) => {
			if (settled) return;
			if (!task.dispatched) {
				const index = waitingQueue.indexOf(task);
				if (index >= 0) waitingQueue.splice(index, 1);
				task.settle(outcome);
				return;
			}
			if (activeTask === task) {
				activeTask = undefined;
				killActiveWorker();
				task.settle(outcome);
				pumpQueue();
				return;
			}
			for (const [worker, owner] of ownWorkers) {
				if (owner !== task) continue;
				endOwnWorker(worker);
				task.settle(outcome);
				return;
			}
		};
		const onAbort = () => {
			removeOrCancel({ error: signal?.reason ?? new Error("Operation aborted") });
		};
		// A call with no time limit (a background history task's) has no timer: only its signal stops it.
		const timer = Number.isFinite(effectiveMs)
			? setTimeout(() => {
					removeOrCancel({ timedOut: true });
				}, effectiveMs)
			: undefined;
		signal?.addEventListener("abort", onAbort, { once: true });
		waitingQueue.push(task);
		pumpQueue();
	});
}

export async function matchLinesInWorker(
	lines: readonly string[],
	pattern: string,
	flags: string,
	ignoreCase: boolean,
	literal: boolean,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<{ readonly matchedIndices: readonly number[]; readonly timedOut: boolean }> {
	const result = await runWorkerTask<"lines">(
		{ op: "lines", lines, pattern, flags, ignoreCase, literal },
		timeoutMs,
		signal,
	);
	if ("timedOut" in result) return { matchedIndices: [], timedOut: true };
	return { matchedIndices: result.value.matchedIndices, timedOut: false };
}

export async function matchMultilineInWorker(
	text: string,
	ownedFrom: number,
	ownedTo: number,
	pattern: string,
	flags: string,
	ignoreCase: boolean,
	literal: boolean,
	timeoutMs: number,
	signal?: AbortSignal,
	startPattern?: string,
): Promise<{ readonly matches: readonly MultilineSpan[]; readonly timedOut: boolean }> {
	const result = await runWorkerTask<"multiline">(
		{ op: "multiline", text, ownedFrom, ownedTo, pattern, flags, ignoreCase, literal, startPattern },
		timeoutMs,
		signal,
	);
	if ("timedOut" in result) return { matches: [], timedOut: true };
	return { matches: result.value.matches, timedOut: false };
}

export async function renderRawEntryInWorker(
	rawChunks: readonly Uint8Array[],
	previewChars: number,
	timeoutMs: number,
	signal?: AbortSignal,
	formatVersion?: number,
): Promise<{ readonly outline: WorkerOutlineInfo; readonly renderedUtf8: Uint8Array } | { readonly timedOut: true }> {
	const transfer = new Set<ArrayBuffer>();
	for (const chunk of rawChunks) {
		if (
			chunk.buffer instanceof ArrayBuffer &&
			chunk.byteOffset === 0 &&
			chunk.byteLength === chunk.buffer.byteLength
		) {
			transfer.add(chunk.buffer);
		}
	}
	const result = await runWorkerTask<"entry">(
		{ op: "entry", chunks: rawChunks, previewChars, formatVersion },
		timeoutMs,
		signal,
		[...transfer],
	);
	if ("timedOut" in result) return result;
	return { outline: result.value.outline, renderedUtf8: result.value.renderedUtf8 };
}
