import type { Token } from "stream-json/core/parser.js";
import type { SessionEntry } from "../../session-manager-types.ts";
import { type Reader, read, readValue, type Shape, skip, stringValue } from "./chunked-resume-projection.js";

// Search tokens never contain whitespace, so a token cannot straddle the separator between two fields.
// Track substring state across chunks, including the two possible folds of a context-sensitive Greek sigma.
class FoldMatches {
	private tail = "";
	private hits: Set<string>;
	private readonly words: readonly string[];
	private readonly keep: number;
	constructor(words: readonly string[], keep: number, other?: FoldMatches) {
		this.words = words;
		this.keep = keep;
		this.tail = other?.tail ?? "";
		this.hits = new Set(other?.hits);
	}
	copy() {
		return new FoldMatches(this.words, this.keep, this);
	}
	add(s: string) {
		const text = this.tail + s;
		for (const w of this.words) if (!this.hits.has(w) && text.includes(w)) this.hits.add(w);
		this.tail = this.keep ? text.slice(-this.keep) : "";
	}
	result() {
		return [...this.hits].join(" ");
	}
}
const ignorable = /\p{Case_Ignorable}/u,
	cased = /\p{Cased}/u;
function* matchedString(words: readonly string[]): Reader<string> {
	let match = new FoldMatches(
			words,
			words.reduce((n, w) => Math.max(n, w.length - 1), 0),
		),
		ordinary: FoldMatches | undefined,
		prior = false,
		high = "";
	const process = (s: string) => {
		if (!ordinary && !s.includes("Σ")) {
			match.add(s.toLowerCase());
			for (let i = s.length - 1; i >= 0; ) {
				const lo = s.charCodeAt(i);
				const at = lo >= 0xdc00 && lo <= 0xdfff && i > 0 ? i - 1 : i;
				const ch = s.slice(at, i + 1);
				if (!ignorable.test(ch)) {
					prior = cased.test(ch);
					break;
				}
				i = at - 1;
			}
			return;
		}
		for (const ch of s) {
			const ignore = ignorable.test(ch);
			if (ordinary && !ignore) {
				if (cased.test(ch)) match = ordinary;
				ordinary = undefined;
			}
			if (ch === "Σ" && prior) {
				ordinary = match.copy();
				ordinary.add("σ");
				match.add("ς");
			} else {
				const lower = ch.toLowerCase();
				match.add(lower);
				ordinary?.add(lower);
			}
			if (!ignore) prior = cased.test(ch);
		}
	};
	for (let t = yield; t.name === "stringChunk"; t = yield) {
		let s = high + t.value;
		high = "";
		const last = s.charCodeAt(s.length - 1);
		if (last >= 0xd800 && last <= 0xdbff) {
			high = s.slice(-1);
			s = s.slice(0, -1);
		}
		process(s);
	}
	if (high) process(high);
	return match.result();
}
/** A string's first `limit` code units, reporting through `clip` when it had more. */
function* clippedString(limit: number, clip?: () => void): Reader<string> {
	let value = "";
	for (let token = yield; token.name === "stringChunk"; token = yield) {
		const room = limit - value.length;
		if (token.value.length > room) clip?.();
		if (room > 0) value += token.value.slice(0, room);
	}
	return value;
}
function* trimmedPrefix(limit: number, clip?: () => void): Reader<string> {
	let text = "",
		leading = true,
		cut = false,
		nonblankTail = false;
	for (let part = yield; part.name === "stringChunk"; part = yield) {
		let s = part.value;
		if (leading) {
			s = s.trimStart();
			if (!s) continue;
			leading = false;
		}
		const take = Math.min(s.length, Math.max(0, limit - text.length));
		text += s.slice(0, take);
		if (take < s.length) {
			cut = true;
			nonblankTail ||= !!s.slice(take).trim();
		}
	}
	if (cut) clip?.();
	return text + (nonblankTail ? "x" : "");
}
const stringField = (limit: number, words?: readonly string[], clip?: () => void, trim = false): Shape =>
	function* (t: Token) {
		if (t.name !== "startString") {
			yield* skip(t);
			return null;
		}
		return words
			? yield* matchedString(words)
			: trim
				? yield* trimmedPrefix(limit, clip)
				: yield* clippedString(limit, clip);
	};
const textBlocks = (max: number, stringWords?: readonly string[], clip?: () => void, trim = false): Shape =>
	function* (t: Token) {
		if (t.name === "startString")
			return stringWords
				? yield* matchedString(stringWords)
				: trim
					? yield* trimmedPrefix(max, clip)
					: yield* clippedString(max, clip);
		if (t.name !== "startArray") {
			yield* skip(t);
			return null;
		}
		let out = "";
		for (let item = yield; item.name !== "endArray"; item = yield) {
			if (out.length >= max) {
				clip?.();
				yield* skip(item);
			} else {
				const block = yield* readValue(item, {
					type: "short",
					text: stringField(max - out.length, undefined, clip, trim && out.length === 0),
				});
				if (
					block &&
					typeof block === "object" &&
					!Array.isArray(block) &&
					block.type === "text" &&
					typeof block.text === "string"
				)
					out += block.text;
			}
		}
		return out;
	};
/** All fields consumed by the ordinary row renderer/searcher, projected independently of JSON key order.
 * Long searchable strings return just the token hits. Tool input, images and signed thinking are never parsed into objects. */
export async function treePresentation(
	chunks: AsyncIterable<Uint8Array>,
	limit: number,
	words?: readonly string[],
	clip?: () => void,
): Promise<SessionEntry> {
	const text = stringField(limit, words, clip);
	const e = await read(
		chunks,
		(function* (): Reader<unknown> {
			return yield* readValue(yield, {
				type: "short",
				id: "string",
				timestamp: "string",
				parentId: "string",
				customType: text,
				summary: stringField(limit, words, clip, true),
				name: text,
				provider: text,
				modelId: text,
				thinkingLevel: text,
				root: text,
				snapshotId: stringField(12),
				tokensBefore: "number",
				label: text,
				replacement: "objectPresent",
				targetId: text,
				content: textBlocks(words ? 200 : limit, words, clip, words === undefined),
				message: {
					role: "short",
					content: textBlocks(200),
					command: stringField(limit, words, clip, true),
					stopReason: "short",
					errorMessage: stringField(160, undefined, undefined, true),
					toolName: stringField(limit, undefined, clip),
					toolCallId: "string",
				},
			});
		})(),
	);
	if (!e || typeof e !== "object") throw new Error("Missing tree entry");
	const entry = e as SessionEntry;
	if (entry.type === "context_edit" && !entry.replacement) entry.replacement = null;
	return entry;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** The characters of `JSON.stringify(arguments)` a custom tool's row shows, plus one to tell whether it continues. */
export const TOOL_CALL_JSON_PREVIEW = 41;
// A path is normalized as a whole before it is shortened, so read the longest path an operating system accepts.
const PATH_CHARS = 32_768;
// A key is cut only beyond every array index (at most 10 digits), so the cut never changes the key order.
const KEY_CHARS = 11;

/**
 * A bounded copy of a JSON value. Its `JSON.stringify` equals the stored value's when that is shorter than `budget`;
 * otherwise it is at least `budget` long and agrees on the first `budget` characters. It follows `JSON.parse`: canonical
 * numbers, re-escaped strings, array-index keys first in ascending order, and a repeated key keeping its first place
 * with its last value. Object members are dropped only where even one-character values put them past the budget, so a
 * repeated key that later shortens an earlier value cannot bring a dropped member back into view.
 * `own` reads the members a caller needs whole, wherever they are.
 */
function* jsonPrefix(
	first: Token,
	budget: number,
	own?: (key: string, first: Token) => Reader<Json> | undefined,
): Reader<Json> {
	switch (first.name) {
		case "startString":
			return yield* stringValue(Math.max(0, budget));
		case "numberValue":
			return Number(first.value);
		case "trueValue":
		case "falseValue":
		case "nullValue":
			return first.value;
		case "startArray": {
			const out: Json[] = [];
			let length = 1;
			for (let item = yield; item.name !== "endArray"; item = yield) {
				if (length >= budget) {
					yield* skip(item);
					continue;
				}
				if (out.length) length++;
				const value = yield* jsonPrefix(item, budget - length);
				out.push(value);
				length += JSON.stringify(value).length;
			}
			return out;
		}
		case "startObject": {
			const out: { [key: string]: Json } = Object.create(null);
			const owned = new Set<string>();
			// The least column a member can start at: every value before it takes at least one character.
			const columns = function* () {
				let at = 1;
				for (const key of Object.keys(out)) {
					yield [key, at] as const;
					at += JSON.stringify(key).length + 3;
				}
			};
			while ((yield).name !== "endObject") {
				let cut = false;
				let key = yield* clippedString(Math.max(KEY_CHARS, budget + 1), () => {
					cut = true;
				});
				// Never end a cut key inside a surrogate pair: its escape would be longer than the stored key.
				if (cut && /[\uD800-\uDBFF]$/.test(key)) key = key.slice(0, -1);
				const token = yield;
				const repeated = key in out;
				if (!repeated) out[key] = null;
				let at = budget;
				for (const [k, column] of columns())
					if (k === key) {
						at = column;
						break;
					}
				const whole = own?.(key, token);
				if (whole) owned.add(key);
				else if (at >= budget) {
					if (!owned.has(key)) delete out[key];
					yield* skip(token);
					continue;
				}
				out[key] = whole ? yield* whole : yield* jsonPrefix(token, budget - at - JSON.stringify(key).length - 1);
				// An array-index key is placed before the others, so it can push them past the budget.
				if (!repeated) for (const [k, column] of columns()) if (column >= budget && !owned.has(k)) delete out[k];
			}
			return out;
		}
		default:
			throw new SyntaxError(`Unexpected JSON token ${first.name}`);
	}
}

/** `String(command).replace(/[\n\t]/g, " ").trim().slice(0, 50)` and `command.length > 50` without the whole command:
 * up to 51 leading blanks as stored, the next 50 characters, and one character telling whether anything but blanks follows. */
function* bashCommand(): Reader<string> {
	let lead = "",
		leading = true,
		rest = "",
		tail = "";
	for (let token = yield; token.name === "stringChunk"; token = yield) {
		let s = token.value;
		if (leading) {
			const blank = s.length - s.trimStart().length;
			if (lead.length < 51) lead += s.slice(0, Math.min(blank, 51 - lead.length));
			s = s.slice(blank);
			if (!s) continue;
			leading = false;
		}
		const take = Math.max(0, 50 - rest.length);
		rest += s.slice(0, take);
		s = s.slice(take);
		if (s && tail !== "x") tail = s.trim() ? "x" : " ";
	}
	return lead + rest + tail;
}

const ownArguments = new Set(["path", "file_path", "command", "pattern", "offset", "limit"]);

/** The arguments `formatToolCall` reads: the members built-in tools show, and the JSON prefix custom tools show. */
function callArguments(limit: number, clip: () => void): Shape {
	const own = (key: string, first: Token): Reader<Json> | undefined => {
		if (!ownArguments.has(key)) return undefined;
		if (first.name !== "startString") return jsonPrefix(first, TOOL_CALL_JSON_PREVIEW);
		if (key === "command") return bashCommand();
		return clippedString(key === "pattern" ? Math.max(limit, TOOL_CALL_JSON_PREVIEW) : PATH_CHARS, clip);
	};
	return (first) => jsonPrefix(first, TOOL_CALL_JSON_PREVIEW, own);
}

/** Select the formatting inputs `formatToolCall` reads, never the whole input of a call. */
export async function treeToolCall(chunks: AsyncIterable<Uint8Array>, id: string, limit: number, clip?: () => void) {
	let match: { name: string; arguments: Record<string, unknown> } | undefined;
	let matchCut = false;
	const blocks: Shape = function* (t) {
		if (t.name !== "startArray") {
			yield* skip(t);
			return null;
		}
		for (let item = yield; item.name !== "endArray"; item = yield) {
			let cut = false;
			const args = callArguments(limit, () => {
				cut = true;
			});
			const b = yield* readValue(item, { type: "short", id: "string", name: "string", arguments: args });
			if (
				b &&
				typeof b === "object" &&
				!Array.isArray(b) &&
				b.type === "toolCall" &&
				b.id === id &&
				typeof b.name === "string" &&
				b.arguments !== undefined &&
				b.arguments !== null
			) {
				match = { name: b.name, arguments: b.arguments as Record<string, unknown> };
				matchCut = cut;
			}
		}
		return null;
	};
	await read(
		chunks,
		(function* (): Reader<unknown> {
			return yield* readValue(yield, { message: { content: blocks } });
		})(),
	);
	if (matchCut) clip?.();
	return match;
}

/** The whole text of a saved label, for editing it. A row shows only what fits on the screen. */
export async function treeLabel(chunks: AsyncIterable<Uint8Array>): Promise<string | undefined> {
	const e = await read(
		chunks,
		(function* (): Reader<Json> {
			return yield* readValue(yield, { type: "short", label: "string" });
		})(),
	);
	if (!e || typeof e !== "object" || Array.isArray(e) || e.type !== "label") throw new Error("Missing label entry");
	return typeof e.label === "string" ? e.label : undefined;
}
