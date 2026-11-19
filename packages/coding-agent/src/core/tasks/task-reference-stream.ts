import type { Token } from "stream-json/core/parser.js";
import {
	chunkedEntryHasId,
	type Reader,
	read,
	skip,
	stringValue,
} from "../storage/session/chunked-resume-projection.js";
import type { TaskTranscriptItem } from "./transcript.js";

type Source = () => AsyncIterable<Uint8Array>;
function arrayIndex(k: string): boolean {
	const i = Number(k);
	return i >= 0 && i < 0xffffffff && Number.isInteger(i) && String(i) === k;
}
/** Compare a saved JSON value to one already resident unsaved answer. Neither the stored text nor a serialized
 * copy of the answer is built. Duplicate JSON object fields use their last value and first insertion order. */
function* sameValue(t: Token, v: unknown): Reader<boolean> {
	if (t.name === "startString") {
		if (typeof v !== "string") {
			yield* skip(t);
			return false;
		}
		let offset = 0,
			ok = true;
		for (let p = yield; p.name === "stringChunk"; p = yield) {
			if (ok) ok = v.startsWith(p.value, offset);
			offset += p.value.length;
		}
		return ok && offset === v.length;
	}
	if (t.name === "startArray") {
		if (!Array.isArray(v)) {
			yield* skip(t);
			return false;
		}
		let i = 0,
			ok = true;
		for (let e = yield; e.name !== "endArray"; e = yield) {
			if (ok && i < v.length) ok = yield* sameValue(e, v[i] ?? null);
			else {
				ok = false;
				yield* skip(e);
			}
			i++;
		}
		return ok && i === v.length;
	}
	if (t.name === "startObject") {
		if (!v || typeof v !== "object" || Array.isArray(v)) {
			yield* skip(t);
			return false;
		}
		const object = v as Record<string, unknown>,
			keys = Object.keys(object).filter(
				(k) => object[k] !== undefined && typeof object[k] !== "function" && typeof object[k] !== "symbol",
			),
			ordered = keys.filter((k) => !arrayIndex(k));
		const limit = keys.reduce((m, k) => Math.max(m, k.length), 0) + 1,
			kept = new Map<string, boolean>();
		let correctOrder = true,
			at = 0;
		for (let k = yield; k.name !== "endObject"; k = yield) {
			const key = yield* stringValue(limit),
				value = yield;
			if (!Object.hasOwn(object, key)) {
				correctOrder = false;
				yield* skip(value);
				continue;
			}
			if (!kept.has(key) && !arrayIndex(key) && ordered[at++] !== key) correctOrder = false;
			kept.set(key, yield* sameValue(value, object[key]));
		}
		return correctOrder && keys.length === kept.size && keys.every((k) => kept.get(k) === true);
	}
	if (t.name === "numberValue") return typeof v === "number" && Number(t.value) === v;
	if (t.name === "trueValue" || t.name === "falseValue" || t.name === "nullValue")
		return t.value === v || (t.name === "nullValue" && typeof v === "number" && !Number.isFinite(v));
	yield* skip(t);
	return false;
}
export function compareTaskAnswer(chunks: Source, answer: unknown): Promise<"same" | "different" | "not-message"> {
	return read(
		chunks(),
		(function* (): Reader<"same" | "different" | "not-message"> {
			let type = "",
				equal = false;
			yield* fields(yield, {
				type: function* (t) {
					type = yield* text(t, 16);
				},
				message: function* (t) {
					equal = yield* sameValue(t, answer);
				},
			});
			return type !== "message" ? "not-message" : equal ? "same" : "different";
		})(),
	);
}
type Fields = Record<string, (first: Token) => Reader<void>>;
function* fields(first: Token, select: Fields): Reader<void> {
	if (first.name !== "startObject") {
		yield* skip(first);
		return;
	}
	const max = Math.max(...Object.keys(select).map((s) => s.length)) + 1;
	for (let t = yield; t.name !== "endObject"; t = yield) {
		const key = yield* stringValue(max);
		const value = yield;
		if (Object.hasOwn(select, key)) yield* select[key]!(value);
		else yield* skip(value);
	}
}
function* text(t: Token, max: number): Reader<string> {
	if (t.name !== "startString") {
		yield* skip(t);
		return "";
	}
	return yield* stringValue(max);
}
function* bytes(t: Token): Reader<number> {
	if (t.name !== "startString") {
		yield* skip(t);
		return 0;
	}
	let count = 0,
		high = "";
	for (let part = yield; part.name === "stringChunk"; part = yield) {
		let s = high + part.value;
		high = "";
		const tail = s.charCodeAt(s.length - 1);
		if (tail >= 0xd800 && tail <= 0xdbff) {
			high = s.slice(-1);
			s = s.slice(0, -1);
		}
		count += Buffer.byteLength(s);
	}
	return count + Buffer.byteLength(high);
}
interface Block {
	i: number;
	type: "text" | "toolCall" | "thinking";
	toolIdBytes: number;
}
interface Header {
	idBytes: number;
	resultIdBytes: number;
	type: string;
	role: string;
	stop: string;
	display: boolean;
	strategy: string;
	summary: boolean;
	total: number;
	blocks: Block[];
	selected: number;
	anchor: boolean;
}
/** Get the number/kinds of visible blocks and the last requested block positions below the anchor. Never retain
 * argument, message or identifier strings. A field after the content array governs that array just as in JSON.parse. */
async function describe(chunks: Source, before: number, limit: number, observe?: (i: number) => void): Promise<Header> {
	return read(
		chunks(),
		(function* (): Reader<Header> {
			const h: Header = {
				idBytes: 0,
				resultIdBytes: 0,
				type: "",
				role: "",
				stop: "",
				display: false,
				strategy: "",
				summary: false,
				total: 0,
				blocks: [],
				selected: 0,
				anchor: false,
			};
			let topDisplay = false,
				msgDisplay = false;
			yield* fields(yield, {
				id: function* (v) {
					h.idBytes = yield* bytes(v);
				},
				type: function* (v) {
					h.type = yield* text(v, 64);
				},
				display: function* (v) {
					topDisplay = v.name === "trueValue";
					yield* skip(v);
				},
				summary: function* (v) {
					h.summary = (yield* text(v, 1)).length > 0;
				},
				details: function* (v) {
					h.strategy = "";
					yield* fields(v, {
						strategy: function* (t) {
							h.strategy = yield* text(t, 64);
						},
					});
				},
				message: function* (v) {
					h.role = "";
					h.stop = "";
					h.total = h.selected = 0;
					h.blocks = [];
					h.anchor = false;
					msgDisplay = false;
					yield* fields(v, {
						toolCallId: function* (t) {
							h.resultIdBytes = yield* bytes(t);
						},
						role: function* (t) {
							h.role = yield* text(t, 64);
						},
						stopReason: function* (t) {
							h.stop = yield* text(t, 64);
						},
						display: function* (t) {
							msgDisplay = t.name === "trueValue";
							yield* skip(t);
						},
						content: function* (t) {
							h.total = h.selected = 0;
							h.blocks = [];
							h.anchor = false;
							if (t.name !== "startArray") {
								yield* skip(t);
								return;
							}
							let i = 0;
							for (let block = yield; block.name !== "endArray"; block = yield, i++) {
								let kind = "",
									toolIdBytes = 0;
								yield* fields(block, {
									type: function* (x) {
										kind = yield* text(x, 16);
									},
									id: function* (x) {
										toolIdBytes = yield* bytes(x);
									},
								});
								if (kind !== "text" && kind !== "toolCall" && kind !== "thinking") continue;
								h.total++;
								observe?.(i);
								if (i === before) h.anchor = true;
								if (i >= before) continue;
								if (limit > 0) h.blocks[h.selected % limit] = { i, type: kind, toolIdBytes };
								h.selected++;
							}
						},
					});
				},
			});
			h.display = h.type === "message" ? msgDisplay : topDisplay;
			if (h.blocks.length && h.selected > limit) {
				const split = h.selected % limit;
				h.blocks = [...h.blocks.slice(split), ...h.blocks.slice(0, split)];
			}
			return h;
		})(),
	);
}
export interface WantedReference {
	key: string;
	index?: number;
	seq: number;
}
/** Read just the root ID, comparing code units against caller-owned candidate strings as they stream. Even a
 * multi-megabyte unrelated ID is never collected to check the earliest occurrence of a small key. */
export async function streamedEarlierMatches(
	chunks: Source,
	roots: ReadonlyMap<string, readonly WantedReference[]>,
	seq: number,
): Promise<string[]> {
	const id = await read(
		chunks(),
		(function* (): Reader<string | undefined> {
			let result: string | undefined;
			yield* fields(yield, {
				id: function* (v) {
					result = undefined;
					if (v.name !== "startString") {
						yield* skip(v);
						return;
					}
					let viable = [...roots.keys()],
						offset = 0;
					for (let part = yield; part.name === "stringChunk"; part = yield) {
						if (viable.length) viable = viable.filter((key) => key.startsWith(part.value, offset));
						offset += part.value.length;
					}
					result = viable.find((key) => key.length === offset);
				},
			});
			return result;
		})(),
	);
	if (id === undefined) return [];
	const wanted = roots.get(id)!.filter((w) => w.seq > seq);
	if (!wanted.length) return [];
	const indexes = new Set(wanted.map((w) => w.index)),
		present = new Set<number>();
	const header = await describe(chunks, Infinity, 0, (i) => {
		if (indexes.has(i)) present.add(i);
	});
	return wanted
		.filter((w) =>
			w.index === undefined
				? singleKind(header) !== undefined
				: header.type === "message" && header.role === "assistant" && present.has(w.index),
		)
		.map((w) => w.key);
}
function singleKind(h: Header): TaskTranscriptItem["kind"] | undefined {
	if (h.type === "compaction") return h.strategy === "verbatim-lines" ? "compaction" : undefined;
	if (h.type === "branch_summary") return h.summary ? "branch-summary" : undefined;
	if (h.type === "custom_message") return h.display ? "custom-message" : undefined;
	if (h.type !== "message") return undefined;
	switch (h.role) {
		case "user":
			return "prompt";
		case "toolResult":
			return "tool-result";
		case "bashExecution":
			return "shell";
		case "custom":
			return h.display ? "custom-message" : undefined;
		case "branchSummary":
			return "branch-summary";
		case "assistant":
			return !h.total && ["error", "aborted", "length"].includes(h.stop) ? "assistant" : undefined;
		default:
			return undefined;
	}
}
async function selectedIds(chunks: Source, toolResult: boolean, indices: Set<number>) {
	return read(
		chunks(),
		(function* (): Reader<{ id: string; result?: string; calls: Map<number, string> }> {
			const r: { id: string; result?: string; calls: Map<number, string> } = { id: "", calls: new Map() };
			yield* fields(yield, {
				id: function* (v) {
					r.id = yield* text(v, Infinity);
				},
				message: function* (v) {
					r.result = undefined;
					r.calls.clear();
					if (!toolResult && !indices.size) {
						yield* skip(v);
						return;
					}
					yield* fields(v, {
						toolCallId: function* (x) {
							if (toolResult) r.result = yield* text(x, Infinity);
							else yield* skip(x);
						},
						content: function* (x) {
							r.calls.clear();
							if (!indices.size || x.name !== "startArray") {
								yield* skip(x);
								return;
							}
							let index = 0;
							for (let b = yield; b.name !== "endArray"; b = yield, index++) {
								if (!indices.has(index)) {
									yield* skip(b);
									continue;
								}
								yield* fields(b, {
									id: function* (i) {
										r.calls.set(index, yield* text(i, Infinity));
									},
								});
							}
						},
					});
				},
			});
			return r;
		})(),
	);
}
/** Read references, latest first. Looking for a legacy continuation or probing for one more item doesn't allocate
 * an unrequested oversized ID. The sole unbounded output is an identifier of a requested item, an SDK string. */
export async function streamedTaskReferences(
	chunks: Source,
	sessionId: string,
	limit: number,
	budget: number,
	empty: boolean,
	before?: string,
): Promise<{ matched: boolean; items: TaskTranscriptItem[]; more: boolean }> {
	const split = before?.lastIndexOf(":") ?? -1;
	const suffix = split >= 0 ? before!.slice(split + 1) : "";
	const at = /^(?:0|[1-9]\d{0,15})$/.test(suffix) && Number.isSafeInteger(Number(suffix)) ? Number(suffix) : Infinity;
	const h = await describe(chunks, at, limit);
	const kind = singleKind(h),
		assistant = h.type === "message" && h.role === "assistant" && h.total > 0;
	if (before !== undefined) {
		if (kind && (await chunkedEntryHasId(chunks(), before))) return { matched: true, items: [], more: false };
		if (!assistant || !h.anchor || !(await chunkedEntryHasId(chunks(), before.slice(0, split))))
			return { matched: false, items: [], more: false };
	}
	const n = assistant ? h.selected : kind ? 1 : 0;
	if (!n || limit === 0) return { matched: before !== undefined, items: [], more: n > 0 };
	if (kind && !empty && h.idBytes + (kind === "tool-result" ? h.resultIdBytes : 0) > budget)
		return { matched: before !== undefined, items: [], more: true };
	const selected: Block[] = [];
	if (assistant)
		for (const b of h.blocks.reverse()) {
			const size = h.idBytes + 1 + String(b.i).length + (b.type === "toolCall" ? b.toolIdBytes : 0);
			if (size > budget && (!empty || selected.length)) break;
			selected.push(b);
			budget -= size;
		}
	if (assistant && !selected.length) return { matched: before !== undefined, items: [], more: true };
	const ids = await selectedIds(
		chunks,
		kind === "tool-result",
		new Set(selected.filter((b) => b.type === "toolCall").map((b) => b.i)),
	);
	const source = { sessionId, entryId: ids.id };
	if (kind)
		return {
			matched: before !== undefined,
			items: [{ id: ids.id, kind, source, ...(kind === "tool-result" ? { toolCallId: ids.result } : {}) }],
			more: false,
		};
	return {
		matched: before !== undefined,
		items: selected.map((b) => ({
			id: `${ids.id}:${b.i}`,
			source: { ...source, contentIndex: b.i },
			kind:
				b.type === "toolCall"
					? "tool-call"
					: b.type === "thinking"
						? "thinking"
						: h.stop === "stop"
							? "response"
							: "assistant",
			...(b.type === "toolCall" ? { toolCallId: ids.calls.get(b.i) } : {}),
		})),
		more: n > selected.length,
	};
}
