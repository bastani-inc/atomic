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
	if (t.name === "startString") return yield* stringValue();
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
function* text(t: Token, full: boolean): Reader<Text | undefined> {
	if (t.name !== "startString") {
		yield* skip(t);
		return undefined;
	}
	let raw = full ? "" : undefined,
		preview = "",
		space = false,
		marker = false,
		left = "",
		right = "";
	for (let p = yield; p.name === "stringChunk"; p = yield) {
		const s = p.value;
		if (raw !== undefined) raw += s;
		marker ||= (right + s).includes(MARKER);
		left += s.slice(0, Math.max(0, MARKER.length - left.length));
		right = (right + s).slice(-MARKER.length);
		if (preview.length > 201) continue;
		for (const m of s.matchAll(/\s+|\S+/gu)) {
			if (/\s/u.test(m[0][0]!)) space = true;
			else {
				if (space && preview) preview += " ";
				preview += m[0].slice(0, 202 - preview.length);
				space = false;
			}
			if (preview.length >= 202) break;
		}
	}
	return { raw, preview, marker, left, right };
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
function* content(t: Token, role: string, full: boolean, args: ReadonlySet<number> | undefined): Reader<CardPiece> {
	const output: CardPiece = { lines: [], calls: [], nonblank: false, marker: false, ...(full ? { text: "" } : {}) };
	let pieces = 0,
		tail = "";
	const line = (s: string) => {
		if (s.length > 200) {
			let end = 199;
			if (/[\uD800-\uDBFF]/.test(s.charAt(end - 1)) && /[\uDC00-\uDFFF]/.test(s.charAt(end))) end--;
			s = s.slice(0, end) + "…";
		}
		output.lines.push(s);
		if (output.lines.length > 12) output.lines.shift();
	};
	const part = (v: Text | undefined) => {
		if (!v) return;
		output.nonblank ||= !!v.preview;
		output.marker ||= v.marker || (tail + (pieces ? "\n" : "") + v.left).includes(MARKER);
		tail = (tail + (pieces ? "\n" : "") + v.right).slice(-MARKER.length);
		if (full) output.text += (pieces ? "\n" : "") + (v.raw ?? "");
		pieces++;
		if (v.preview) line((role === "user" ? "› " : "") + v.preview);
	};
	if (t.name === "startString") part(yield* text(t, full));
	else if (t.name === "startArray") {
		let index = 0;
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
					if (x.name === "startString") name = yield* stringValue();
					else yield* skip(x);
				},
				id: function* (x) {
					if (x.name === "startString") id = yield* stringValue();
					else yield* skip(x);
				},
				text: function* (x) {
					v = yield* text(x, full);
				},
				arguments: function* (x) {
					if (args?.has(index)) argumentsValue = yield* json(x);
					else yield* skip(x);
				},
			});
			if (type === "text") part(v);
			else if (type === "toolCall" && name) {
				line(`→ ${name}`);
				if (role === "assistant")
					output.calls.push({
						index,
						id,
						name,
						...(args?.has(index)
							? {
									args:
										argumentsValue && typeof argumentsValue === "object" && !Array.isArray(argumentsValue)
											? argumentsValue
											: {},
								}
							: {}),
					});
			}
		}
	} else yield* skip(t);
	return output;
}
export async function cardPiece(
	chunks: AsyncIterable<Uint8Array>,
	role: string,
	edit: boolean,
	full = false,
	args?: ReadonlySet<number>,
): Promise<CardPiece> {
	return read(
		chunks,
		(function* (): Reader<CardPiece> {
			let p: CardPiece = { lines: [], calls: [], nonblank: false, marker: false };
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
export async function cardFields(
	chunks: AsyncIterable<Uint8Array>,
	kind: "header" | "edit" | "result" | "editedResult" | "replacement" | "launch" | "boundary",
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
				kind === "header"
					? {
							type: tag("type"),
							id: value("id"),
							message: child({ role: tag("role"), toolCallId: value("toolCallId") }),
						}
					: kind === "boundary"
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
