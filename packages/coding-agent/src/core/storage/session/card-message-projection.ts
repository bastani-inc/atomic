import type { Token } from "stream-json/core/parser.js";
import { type Reader, read, skip, stringValue } from "./chunked-resume-projection.js";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Fields = Record<string, (token: Token) => Reader<void>>;
function* object(first: Token, fields: Fields): Reader<void> {
	if (first.name !== "startObject") {
		yield* skip(first);
		return;
	}
	const limit = Math.max(...Object.keys(fields).map((k) => k.length)) + 1;
	for (let k = yield; k.name !== "endObject"; k = yield) {
		const key = yield* stringValue(limit);
		const value = yield;
		if (Object.hasOwn(fields, key)) yield* fields[key]!(value);
		else yield* skip(value);
	}
}
/** A copy of a string a card keeps, so it holds that text and not the decoded page a streamed value is a slice of. */
const own = (s: string) => (s.length > 12 ? ` ${s}`.slice(1) : s);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function* json(t: Token): Reader<Json> {
	if (t.name === "startObject") {
		const r: Record<string, Json> = {};
		for (let k = yield; k.name !== "endObject"; k = yield) {
			const key = yield* stringValue();
			Object.defineProperty(r, key, {
				value: yield* json(yield),
				configurable: true,
				enumerable: true,
				writable: true,
			});
		}
		return r;
	}
	if (t.name === "startArray") {
		const a: Json[] = [];
		for (let v = yield; v.name !== "endArray"; v = yield) a.push(yield* json(v));
		return a;
	}
	if (t.name === "startString") return own(yield* stringValue());
	if (t.name === "numberValue") return Number(t.value);
	if (t.name === "trueValue" || t.name === "falseValue" || t.name === "nullValue") return t.value;
	throw new SyntaxError("Invalid stored JSON value");
}
const MARKER = "\n\nTask:\n";
interface Text {
	raw?: string;
	preview: string;
	marker: boolean;
	left: string;
	right: string;
}
/** A text value read piece by piece: a streamed value in its chunks, a parsed one as one piece. */
class TextReader {
	private raw: string | undefined;
	private preview = "";
	private space = false;
	private marker = false;
	private left = "";
	private right = "";
	constructor(full: boolean) {
		this.raw = full ? "" : undefined;
	}
	add(s: string) {
		if (this.raw !== undefined) this.raw += s;
		this.marker ||= (this.right + s).includes(MARKER);
		this.left += s.slice(0, Math.max(0, MARKER.length - this.left.length));
		this.right = (this.right + s).slice(-MARKER.length);
		if (this.preview.length > 201) return;
		for (const m of s.matchAll(/\s+|\S+/gu)) {
			if (/\s/u.test(m[0][0]!)) this.space = true;
			else {
				if (this.space && this.preview) this.preview += " ";
				this.preview += m[0].slice(0, 202 - this.preview.length);
				this.space = false;
			}
			if (this.preview.length >= 202) break;
		}
	}
	done(): Text {
		return {
			raw: this.raw === undefined ? undefined : own(this.raw),
			preview: this.preview,
			marker: this.marker,
			left: this.left,
			right: this.right,
		};
	}
}
function* text(t: Token, full: boolean): Reader<Text | undefined> {
	if (t.name !== "startString") {
		yield* skip(t);
		return undefined;
	}
	const reader = new TextReader(full);
	for (let p = yield; p.name === "stringChunk"; p = yield) reader.add(p.value);
	return reader.done();
}
function textOf(s: string, full: boolean): Text {
	const reader = new TextReader(full);
	reader.add(s);
	return reader.done();
}
export interface CardCall {
	index: number;
	id: string;
	name: string;
	args?: Record<string, unknown>;
}
export interface CardPiece {
	lines: string[];
	calls: CardCall[];
	nonblank: boolean;
	marker: boolean;
	text?: string;
}
const emptyPiece = (): CardPiece => ({ lines: [], calls: [], nonblank: false, marker: false });
/** What one message's content shows on its card, whether its content was streamed or parsed. */
class PieceBuilder {
	readonly output: CardPiece;
	private pieces = 0;
	private tail = "";
	private readonly role: string;
	private readonly full: boolean;
	constructor(role: string, full: boolean) {
		this.role = role;
		this.full = full;
		this.output = { ...emptyPiece(), ...(full ? { text: "" } : {}) };
	}
	private line(s: string) {
		if (s.length > 200) {
			let end = 199;
			if (/[\uD800-\uDBFF]/.test(s.charAt(end - 1)) && /[\uDC00-\uDFFF]/.test(s.charAt(end))) end--;
			s = `${s.slice(0, end)}…`;
		}
		this.output.lines.push(own(s));
		if (this.output.lines.length > 12) this.output.lines.shift();
	}
	part(v: Text | undefined) {
		if (!v) return;
		const { output } = this;
		const join = this.pieces ? "\n" : "";
		output.nonblank ||= !!v.preview;
		output.marker ||= v.marker || (this.tail + join + v.left).includes(MARKER);
		this.tail = (this.tail + join + v.right).slice(-MARKER.length);
		if (this.full) output.text += join + (v.raw ?? "");
		this.pieces++;
		if (v.preview) this.line((this.role === "user" ? "› " : "") + v.preview);
	}
	block(index: number, type: string, name: string, id: string, v: Text | undefined, args: unknown) {
		if (type === "text") this.part(v);
		else if (type === "toolCall" && name) {
			this.line(`→ ${name}`);
			if (this.role === "assistant")
				this.output.calls.push({
					index,
					id,
					name,
					...(args === undefined ? {} : { args: isRecord(args) ? args : {} }),
				});
		}
	}
	done(): CardPiece {
		const { output } = this;
		if (output.text !== undefined) output.text = own(output.text);
		return output;
	}
}
function* content(
	t: Token,
	role: string,
	full: boolean,
	args: ReadonlySet<number> | "all" | undefined,
): Reader<CardPiece> {
	const builder = new PieceBuilder(role, full);
	if (t.name === "startString") builder.part(yield* text(t, full));
	else if (t.name === "startArray") {
		let index = 0;
		const wanted = (at: number) => args === "all" || !!args?.has(at);
		for (let b = yield; b.name !== "endArray"; b = yield, index++) {
			let type = "",
				name = "",
				id = "",
				v: Text | undefined,
				argumentsValue: Json | undefined;
			yield* object(b, {
				type: function* (x) {
					if (x.name === "startString") type = yield* stringValue(16);
					else yield* skip(x);
				},
				name: function* (x) {
					if (x.name === "startString") name = own(yield* stringValue());
					else yield* skip(x);
				},
				id: function* (x) {
					if (x.name === "startString") id = own(yield* stringValue());
					else yield* skip(x);
				},
				text: function* (x) {
					v = yield* text(x, full);
				},
				arguments: function* (x) {
					if (wanted(index)) argumentsValue = yield* json(x);
					else yield* skip(x);
				},
			});
			builder.block(index, type, name, id, v, wanted(index) ? (argumentsValue ?? null) : undefined);
		}
	} else yield* skip(t);
	return builder.done();
}
export async function cardPiece(
	chunks: AsyncIterable<Uint8Array>,
	role: string,
	edit: boolean,
	full = false,
	args?: ReadonlySet<number> | "all",
): Promise<CardPiece> {
	return read(
		chunks,
		(function* (): Reader<CardPiece> {
			let p = emptyPiece();
			yield* object(yield, {
				[edit ? "replacement" : "message"]: function* (t) {
					yield* object(t, {
						content: function* (c) {
							p = yield* content(c, role, full, args);
						},
					});
				},
			});
			return p;
		})(),
	);
}
/** The same projection as {@link cardPiece} of a message's `content`, when the row was parsed whole. */
export function cardPieceOf(value: unknown, role: string, full = false, args?: ReadonlySet<number> | "all"): CardPiece {
	if (value === undefined) return emptyPiece();
	const builder = new PieceBuilder(role, full);
	if (typeof value === "string") builder.part(textOf(value, full));
	else if (Array.isArray(value))
		value.forEach((b, index) => {
			if (!isRecord(b)) return;
			const withArgs = args === "all" || !!args?.has(index);
			builder.block(
				index,
				typeof b.type === "string" ? b.type.slice(0, 16) : "",
				typeof b.name === "string" ? b.name : "",
				typeof b.id === "string" ? b.id : "",
				typeof b.text === "string" ? textOf(b.text, full) : undefined,
				withArgs ? (b.arguments ?? null) : undefined,
			);
		});
	return builder.done();
}
export interface CardHeader {
	type?: string;
	id?: Json;
	role?: string;
	toolCallId?: Json;
}
/** A row's kind, ID, role and tool call ID, read only as far into the entry as needed. Atomic writes `type` and `id`
 * before a row's payload, and `role` and `toolCallId` before a message's content, so a large row is not streamed to
 * find them. A key written later is still found by reading on. */
export async function cardHeader(chunks: AsyncIterable<Uint8Array>): Promise<CardHeader> {
	return read(
		chunks,
		(function* (): Reader<CardHeader> {
			const h: CardHeader = {};
			const seen = new Set<string>();
			const known = () =>
				seen.has("type") &&
				(h.type !== "message" ||
					(seen.has("id") && seen.has("role") && (h.role !== "toolResult" || seen.has("toolCallId"))));
			const first = yield;
			if (first.name !== "startObject") {
				yield* skip(first);
				return h;
			}
			for (let k = yield; k.name !== "endObject"; k = yield) {
				const key = yield* stringValue(8);
				const value = yield;
				if (key === "type") {
					seen.add(key);
					if (value.name === "startString") h.type = yield* stringValue(64);
					else yield* skip(value);
				} else if (key === "id") {
					seen.add(key);
					h.id = yield* json(value);
				} else if (key === "message" && value.name === "startObject") {
					for (let m = yield; m.name !== "endObject"; m = yield) {
						const field = yield* stringValue(11);
						const v = yield;
						if (field === "role") {
							seen.add(field);
							if (v.name === "startString") h.role = yield* stringValue(64);
							else yield* skip(v);
						} else if (field === "toolCallId") {
							seen.add(field);
							h.toolCallId = yield* json(v);
						} else yield* skip(v);
						if (known()) return h;
					}
				} else yield* skip(value);
				if (known()) return h;
			}
			return h;
		})(),
	);
}
export async function cardFields(
	chunks: AsyncIterable<Uint8Array>,
	kind: "edit" | "result" | "editedResult" | "replacement" | "launch" | "boundary",
): Promise<Record<string, Json>> {
	return read(
		chunks,
		(function* (): Reader<Record<string, Json>> {
			const r: Record<string, Json> = {};
			const value = (k: string) =>
				function* (t: Token) {
					r[k] = yield* json(t);
				};
			const tag = (k: string) =>
				function* (t: Token) {
					if (t.name === "startString") r[k] = yield* stringValue(64);
					else yield* skip(t);
				};
			const child = (f: Fields) =>
				function* (t: Token) {
					yield* object(t, f);
				};
			const fields: Fields =
				kind === "boundary"
					? { details: child({ backend: tag("backend") }) }
					: kind === "edit"
						? {
								targetId: value("targetId"),
								replacement: function* (t) {
									r.omit = t.name === "nullValue";
									yield* skip(t);
								},
							}
						: kind === "replacement"
							? { replacement: child({ content: value("content") }) }
							: kind === "result" || kind === "editedResult"
								? {
										message: child({
											...(kind === "result" ? { content: value("content") } : {}),
											details: value("details"),
											toolCallId: value("toolCallId"),
											isError: value("isError"),
											durationMs: value("durationMs"),
										}),
									}
								: {
										type: tag("type"),
										customType: tag("customType"),
										id: value("id"),
										data: child({
											version: value("version"),
											state: tag("state"),
											runId: tag("runId"),
											agent: tag("agent"),
											cwd: tag("cwd"),
											index: value("index"),
											childId: value("childId"),
											launchLeafId: value("launchLeafId"),
											launchLeafSeq: value("launchLeafSeq"),
											forked: value("forked"),
										}),
									};
			yield* object(yield, fields);
			return r;
		})(),
	);
}
