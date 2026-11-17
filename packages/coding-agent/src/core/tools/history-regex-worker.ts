import { Worker } from "node:worker_threads";

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
const { parentPort } = require("node:worker_threads");
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

function oneLine(text, limit) {
	const flat = String(text ?? "").slice(0, limit * 4).replace(/\\s+/g, " ").trim();
	return flat.length > limit ? flat.slice(0, limit) + "…" : flat;
}

function messageText(content, limit) {
	if (typeof content === "string") return content.slice(0, limit * 4);
	if (!Array.isArray(content)) return "";
	let out = "";
	for (const block of content) {
		if (block && block.type === "text" && typeof block.text === "string") {
			out += (out ? " " : "") + block.text.slice(0, limit * 4);
			if (out.length >= limit * 4) break;
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
				re.lastIndex = msg.ownedFrom;
				for (let match = re.exec(text); match !== null; match = re.exec(text)) {
					if (match.index >= msg.ownedTo) break;
					const length = match[0].length;
					const endIdx = length > 0 ? match.index + length - 1 : match.index;
					matches.push({ startLine: lineNumberAt(newlines, match.index), endLine: lineNumberAt(newlines, endIdx) });
					if (length === 0) re.lastIndex++;
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

interface PendingTask {
	readonly id: number;
	readonly payload: Record<string, unknown>;
	readonly transfer?: readonly ArrayBuffer[];
	readonly deadline: number;
	readonly settle: (
		outcome: { readonly value: unknown } | { readonly timedOut: true } | { readonly error: unknown },
	) => void;
	dispatched: boolean;
}

let activeWorker: Worker | undefined;
let activeTask: PendingTask | undefined;
const waitingQueue: PendingTask[] = [];
let nextRequestId = 1;

function getWorker(): Worker {
	if (!activeWorker) {
		const worker = new Worker(WORKER_SCRIPT, { eval: true });
		worker.on("message", (message: { id?: number; error?: string }) => {
			if (!activeTask || !message || message.id !== activeTask.id) return;
			const task = activeTask;
			activeTask = undefined;
			if (message.error !== undefined) {
				task.settle({ error: new Error(message.error) });
			} else {
				task.settle({ value: message });
			}
			pumpQueue();
		});
		worker.on("error", (error: Error) => {
			killActiveWorker();
			const task = activeTask;
			activeTask = undefined;
			task?.settle({ error });
			pumpQueue();
		});
		worker.unref();
		activeWorker = worker;
	}
	return activeWorker;
}

function killActiveWorker(): void {
	const current = activeWorker;
	activeWorker = undefined;
	if (current) void current.terminate();
}

function pumpQueue(): void {
	while (activeTask === undefined && waitingQueue.length > 0) {
		const next = waitingQueue.shift()!;
		if (performance.now() >= next.deadline) {
			next.settle({ timedOut: true });
			continue;
		}
		next.dispatched = true;
		activeTask = next;
		const worker = getWorker();
		worker.postMessage({ ...next.payload, id: next.id }, next.transfer ? [...next.transfer] : []);
	}
}

function runWorkerTask<T>(
	payload: Record<string, unknown>,
	timeoutMs: number,
	signal: AbortSignal | undefined,
	transfer?: readonly ArrayBuffer[],
): Promise<{ readonly value: T } | { readonly timedOut: true }> {
	if (signal?.aborted) {
		return Promise.reject(signal.reason ?? new Error("Operation aborted"));
	}
	const effectiveMs = Math.max(5, timeoutMs);
	const deadline = performance.now() + effectiveMs;
	const id = nextRequestId++;
	return new Promise<{ readonly value: T } | { readonly timedOut: true }>((resolve, reject) => {
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
				signal?.removeEventListener("abort", onAbort);
				if ("error" in outcome) reject(outcome.error);
				else if ("timedOut" in outcome) resolve(outcome);
				else resolve({ value: outcome.value as T });
			},
		};
		const removeOrCancel = (outcome: { readonly timedOut: true } | { readonly error: unknown }) => {
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
			}
		};
		const onAbort = () => {
			removeOrCancel({ error: signal?.reason ?? new Error("Operation aborted") });
		};
		const timer = setTimeout(() => {
			removeOrCancel({ timedOut: true });
		}, effectiveMs);
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
	const result = await runWorkerTask<{ matchedIndices: number[] }>(
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
): Promise<{ readonly matches: readonly MultilineSpan[]; readonly timedOut: boolean }> {
	const result = await runWorkerTask<{ matches: MultilineSpan[] }>(
		{ op: "multiline", text, ownedFrom, ownedTo, pattern, flags, ignoreCase, literal },
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
	const transfer: ArrayBuffer[] = [];
	for (const chunk of rawChunks) {
		if (
			chunk.buffer instanceof ArrayBuffer &&
			chunk.byteOffset === 0 &&
			chunk.byteLength === chunk.buffer.byteLength
		) {
			transfer.push(chunk.buffer);
		}
	}
	const result = await runWorkerTask<{ outline: WorkerOutlineInfo; renderedUtf8: Uint8Array }>(
		{ op: "entry", chunks: rawChunks, previewChars, formatVersion },
		timeoutMs,
		signal,
		transfer,
	);
	if ("timedOut" in result) return result;
	return { outline: result.value.outline, renderedUtf8: result.value.renderedUtf8 };
}
