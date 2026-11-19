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
const stringField = (limit: number, words?: readonly string[]): Shape =>
	function* (t: Token) {
		if (t.name !== "startString") {
			yield* skip(t);
			return null;
		}
		return words ? yield* matchedString(words) : yield* stringValue(limit);
	};
const textBlocks = (max: number, stringWords?: readonly string[]): Shape =>
	function* (t: Token) {
		if (t.name === "startString") return stringWords ? yield* matchedString(stringWords) : yield* stringValue(max);
		if (t.name !== "startArray") {
			yield* skip(t);
			return null;
		}
		let out = "";
		for (let item = yield; item.name !== "endArray"; item = yield) {
			if (out.length >= max) yield* skip(item);
			else {
				const block = yield* readValue(item, { type: "short", text: stringField(max - out.length) });
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
): Promise<SessionEntry> {
	const text = stringField(limit, words);
	const e = await read(
		chunks,
		(function* (): Reader<unknown> {
			return yield* readValue(yield, {
				type: "short",
				id: "string",
				timestamp: "string",
				parentId: "string",
				customType: text,
				summary: text,
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
				content: textBlocks(words ? 200 : limit, words),
				message: {
					role: "short",
					content: textBlocks(200),
					command: text,
					stopReason: "short",
					errorMessage: stringField(160),
					toolName: stringField(limit),
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

/** Select just the formatting inputs used by the built-in tools. Unknown tools display a short JSON preview. */
export async function treeToolCall(chunks: AsyncIterable<Uint8Array>, id: string, limit: number) {
	let match: { name: string; arguments: Record<string, unknown> } | undefined;
	const args = {
		path: stringField(limit),
		file_path: stringField(limit),
		command: stringField(limit),
		pattern: stringField(limit),
		offset: true,
		limit: true,
	} as const;
	const blocks: Shape = function* (t) {
		if (t.name !== "startArray") {
			yield* skip(t);
			return null;
		}
		for (let item = yield; item.name !== "endArray"; item = yield) {
			const b = yield* readValue(item, { type: "short", id: "string", name: "string", arguments: args });
			if (
				b &&
				typeof b === "object" &&
				!Array.isArray(b) &&
				b.type === "toolCall" &&
				b.id === id &&
				typeof b.name === "string" &&
				b.arguments &&
				typeof b.arguments === "object" &&
				!Array.isArray(b.arguments)
			)
				match = { name: b.name, arguments: b.arguments };
		}
		return null;
	};
	await read(
		chunks,
		(function* (): Reader<unknown> {
			return yield* readValue(yield, { message: { content: blocks } });
		})(),
	);
	return match;
}
