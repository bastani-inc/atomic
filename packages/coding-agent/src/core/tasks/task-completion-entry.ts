import type { Token } from "stream-json/core/parser.js";
import { type Reader, read, skip, stringValue } from "../storage/session/chunked-resume-projection.js";

// An oversized saved entry is read field by field from its chunks. Only what an expanded completion card shows is
// built: a prompt's text, a call's ID, name and arguments, a matched result's content and details. Thinking, answers,
// unmatched results and every other field are skipped as they stream past, however large.
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Fields = Readonly<Record<string, (token: Token) => Reader<void>>>;

function* object(first: Token, fields: Fields): Reader<boolean> {
	if (first.name !== "startObject") {
		yield* skip(first);
		return false;
	}
	const limit = Math.max(...Object.keys(fields).map((key) => key.length)) + 1;
	for (let token = yield; token.name !== "endObject"; token = yield) {
		const key = yield* stringValue(limit);
		const value = yield;
		if (Object.hasOwn(fields, key)) yield* fields[key]!(value);
		else yield* skip(value);
	}
	return true;
}

/** The whole value, as `JSON.parse` builds it, own `__proto__` keys included. */
function* value(first: Token): Reader<Json> {
	switch (first.name) {
		case "startObject": {
			const result: Record<string, Json> = {};
			for (let token = yield; token.name !== "endObject"; token = yield) {
				const key = yield* stringValue();
				Object.defineProperty(result, key, {
					value: yield* value(yield),
					configurable: true,
					enumerable: true,
					writable: true,
				});
			}
			return result;
		}
		case "startArray": {
			const result: Json[] = [];
			for (let token = yield; token.name !== "endArray"; token = yield) result.push(yield* value(token));
			return result;
		}
		case "startString":
			return yield* stringValue();
		case "numberValue":
			return Number(first.value);
		case "trueValue":
		case "falseValue":
		case "nullValue":
			return first.value;
		default:
			throw new SyntaxError(`Unexpected JSON token ${first.name}`);
	}
}

function* tag(first: Token): Reader<string | undefined> {
	if (first.name === "startString") return yield* stringValue(64);
	yield* skip(first);
	return undefined;
}

/** Compare a saved string with `expected` as it streams, without building it. */
function* equals(first: Token, expected: string): Reader<boolean> {
	if (first.name !== "startString") {
		yield* skip(first);
		return false;
	}
	let offset = 0;
	let same = true;
	for (let part = yield; part.name === "stringChunk"; part = yield) {
		same &&= expected.startsWith(part.value, offset);
		offset += part.value.length;
	}
	return same && offset === expected.length;
}

/** Select `fields` of the entry's message; a repeated `message` key replaces the earlier one, as in `JSON.parse`. */
function* message(fields: Fields, reset: () => void): Reader<void> {
	yield* object(yield, {
		*message(token) {
			reset();
			yield* object(token, fields);
		},
	});
}

export interface SavedEntryHeader {
	/** Its ID is the last inherited entry's. */
	readonly boundary: boolean;
	readonly type?: string;
	readonly role?: string;
	/** The call a tool result answers, when its ID is a string of at most the requested length. */
	readonly toolCallId?: string;
	/** A string call ID longer than the requested length. */
	readonly longToolCallId?: true;
}

// Ends a header read once its fields are known: the rest of a large row is not tokenized.
const HEADER_READ = Symbol("header read");

/**
 * The fields that decide what an entry adds to a card, in one pass that keeps none of its content. The pass ends as
 * soon as they are known, which in a saved row is before its message content.
 */
export function savedEntryHeader(
	chunks: AsyncIterable<Uint8Array>,
	throughId: string | undefined,
	idLimit: number,
): Promise<SavedEntryHeader> {
	return read(
		chunks,
		(function* (): Reader<SavedEntryHeader> {
			let boundary = false;
			let seenId = throughId === undefined;
			let type: string | undefined;
			let fields: { role?: string; toolCallId?: string; longToolCallId?: true } = {};
			let seenCallId = false;
			const known = () =>
				seenId &&
				type !== undefined &&
				(type !== "message" || (fields.role !== undefined && (fields.role !== "toolResult" || seenCallId)));
			try {
				yield* object(yield, {
					*id(token) {
						if (throughId === undefined) yield* skip(token);
						else boundary = yield* equals(token, throughId);
						seenId = true;
						if (known()) throw HEADER_READ;
					},
					*type(token) {
						type = yield* tag(token);
						if (known()) throw HEADER_READ;
					},
					*message(token) {
						fields = {};
						seenCallId = false;
						yield* object(token, {
							*role(role) {
								fields.role = yield* tag(role);
								if (known()) throw HEADER_READ;
							},
							*toolCallId(id) {
								delete fields.toolCallId;
								delete fields.longToolCallId;
								seenCallId = true;
								if (id.name !== "startString") yield* skip(id);
								else {
									const text = yield* stringValue(idLimit + 1);
									if (text.length > idLimit) fields.longToolCallId = true;
									else fields.toolCallId = text;
								}
								if (known()) throw HEADER_READ;
							},
						});
					},
				});
			} catch (error) {
				if (error !== HEADER_READ) throw error;
			}
			return { boundary, ...(type === undefined ? {} : { type }), ...fields };
		})(),
	);
}

const ESCAPE = new TextEncoder().encode("\\u");

function indexOf(bytes: Uint8Array, needle: Uint8Array): number {
	search: for (
		let at = bytes.indexOf(needle[0]!);
		at >= 0 && at <= bytes.length - needle.length;
		at = bytes.indexOf(needle[0]!, at + 1)
	) {
		for (let i = 1; i < needle.length; i++) if (bytes[at + i] !== needle[i]) continue search;
		return at;
	}
	return -1;
}

/**
 * Whether a saved row can hold the string `text` anywhere: its bytes spell it, or escape a character somewhere.
 * A row that can't is passed over without tokenizing it.
 */
export async function savedRowMayHold(chunks: AsyncIterable<Uint8Array>, text: string): Promise<boolean> {
	const needle = new TextEncoder().encode(text);
	const overlap = Math.max(needle.length, ESCAPE.length) - 1;
	let tail = new Uint8Array(0);
	for await (const chunk of chunks) {
		const bytes = new Uint8Array(tail.length + chunk.length);
		bytes.set(tail);
		bytes.set(chunk, tail.length);
		if (indexOf(bytes, needle) >= 0 || indexOf(bytes, ESCAPE) >= 0) return true;
		tail = bytes.slice(Math.max(0, bytes.length - overlap));
	}
	return false;
}

/** A user message's text as a card's prompt reads it: its string, or its text blocks joined by newlines. */
export function savedUserText(chunks: AsyncIterable<Uint8Array>): Promise<string | undefined> {
	return read(
		chunks,
		(function* (): Reader<string | undefined> {
			let text: string | undefined;
			yield* message(
				{
					*content(token) {
						text = undefined;
						if (token.name === "startString") {
							text = yield* stringValue();
							return;
						}
						if (token.name !== "startArray") {
							yield* skip(token);
							return;
						}
						const parts: string[] = [];
						for (let part = yield; part.name !== "endArray"; part = yield) {
							let type: string | undefined;
							let partText: string | undefined;
							yield* object(part, {
								*type(t) {
									type = yield* tag(t);
								},
								*text(t) {
									partText = undefined;
									if (t.name === "startString") partText = yield* stringValue();
									else yield* skip(t);
								},
							});
							if (type === "text" && partText !== undefined) parts.push(partText);
						}
						text = parts.join("\n");
					},
				},
				() => {
					text = undefined;
				},
			);
			return text;
		})(),
	);
}

export interface SavedToolCall {
	readonly id?: Json;
	readonly name?: Json;
	readonly arguments?: Json;
}

/** An assistant message's tool calls, in order: each one's ID, name and arguments. */
export function savedToolCalls(chunks: AsyncIterable<Uint8Array>): Promise<SavedToolCall[]> {
	return read(
		chunks,
		(function* (): Reader<SavedToolCall[]> {
			let calls: SavedToolCall[] = [];
			const content = function* (token: Token): Reader<void> {
				calls = [];
				if (token.name !== "startArray") {
					yield* skip(token);
					return;
				}
				for (let part = yield; part.name !== "endArray"; part = yield) {
					let type: string | undefined;
					const call: { id?: Json; name?: Json; arguments?: Json } = {};
					yield* object(part, {
						*type(t) {
							type = yield* tag(t);
						},
						*id(t) {
							call.id = yield* value(t);
						},
						*name(t) {
							call.name = yield* value(t);
						},
						*arguments(t) {
							call.arguments = yield* value(t);
						},
					});
					if (type === "toolCall") calls.push(call);
				}
			};
			yield* message({ content }, () => {
				calls = [];
			});
			return calls;
		})(),
	);
}

export interface SavedToolResult {
	readonly content?: Json;
	readonly hasDetails: boolean;
	readonly details?: Json;
	readonly isError?: Json;
	readonly durationMs?: Json;
}

/** What a card shows of a tool result: its content, details, error flag and duration. */
export function savedToolResult(chunks: AsyncIterable<Uint8Array>): Promise<SavedToolResult> {
	return read(
		chunks,
		(function* (): Reader<SavedToolResult> {
			let result: { content?: Json; hasDetails: boolean; details?: Json; isError?: Json; durationMs?: Json } = {
				hasDetails: false,
			};
			yield* message(
				{
					*content(t) {
						result.content = yield* value(t);
					},
					*details(t) {
						result.hasDetails = true;
						result.details = yield* value(t);
					},
					*isError(t) {
						result.isError = yield* value(t);
					},
					*durationMs(t) {
						result.durationMs = yield* value(t);
					},
				},
				() => {
					result = { hasDetails: false };
				},
			);
			return result;
		})(),
	);
}
