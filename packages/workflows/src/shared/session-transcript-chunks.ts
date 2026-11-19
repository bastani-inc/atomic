import { jsonParser, type Token } from "stream-json/core/parser.js";

type Reader<T> = Generator<void, T, Token>;
type Check = (first: Token) => Reader<boolean>;

function* skip(first: Token): Reader<void> {
	let depth = first.name.startsWith("start") ? 1 : 0;
	while (depth > 0) {
		const { name } = yield;
		if (name.startsWith("start")) depth++;
		else if (name.startsWith("end")) depth--;
	}
}
function* stringField(first: Token): Reader<boolean> {
	yield* skip(first);
	return first.name === "startString";
}
/** Test the exact old trim/nonempty condition without collecting the body's string chunks. */
function* nonblank(first: Token): Reader<boolean> {
	if (first.name !== "startString") {
		yield* skip(first);
		return false;
	}
	let seen = false;
	for (let t = yield; t.name === "stringChunk"; t = yield) if (!seen && /\S/u.test(t.value)) seen = true;
	return seen;
}
function* shortText(limit: number): Reader<string> {
	let text = "";
	for (let t = yield; t.name === "stringChunk"; t = yield)
		if (text.length < limit) text += t.value.slice(0, limit - text.length);
	return text;
}
function* messageType(first: Token): Reader<boolean> {
	if (first.name !== "startString") {
		yield* skip(first);
		return false;
	}
	return (yield* shortText(8)) === "message";
}
function* objectFields(first: Token, fields: Readonly<Record<string, Check>>): Reader<Record<string, boolean>> {
	const found: Record<string, boolean> = Object.create(null);
	if (first.name !== "startObject") {
		yield* skip(first);
		return found;
	}
	const limit = 1 + Math.max(...Object.keys(fields).map((k) => k.length));
	while ((yield).name !== "endObject") {
		const key = yield* shortText(limit),
			value = yield;
		if (Object.hasOwn(fields, key)) found[key] = yield* fields[key]!(value);
		else yield* skip(value);
	}
	return found;
}
const textFields = { text: nonblank, thinking: nonblank, data: nonblank, name: nonblank };
function* content(first: Token): Reader<boolean> {
	if (first.name !== "startArray") return yield* nonblank(first);
	let found = false;
	for (let item = yield; item.name !== "endArray"; item = yield) {
		if (found) yield* skip(item);
		else found = Object.values(yield* objectFields(item, textFields)).some(Boolean);
	}
	return found;
}
function* message(first: Token): Reader<boolean> {
	const fields = yield* objectFields(first, { role: stringField, content });
	return fields.role === true && fields.content === true;
}
function* usable(): Reader<boolean> {
	const fields = yield* objectFields(yield, { type: messageType, id: stringField, timestamp: stringField, message });
	return fields.type === true && fields.id === true && fields.timestamp === true && fields.message === true;
}

/** A post-mortem eligibility check needs one bit, not a decoded conversation entry. No packed keys, strings or
 * number values: a giant ignored property has the same memory bound as a giant primary text field. */
export async function hasUsableMessageInChunks(chunks: AsyncIterable<Uint8Array>): Promise<boolean> {
	const decode = new TextDecoder("utf-8", { fatal: true });
	const tokenize = jsonParser({ packValues: false, packNumbers: false, streamNumbers: true, maxDepth: Infinity });
	const check = usable();
	check.next();
	for await (const chunk of chunks) {
		const tokenPageBytes = 16 * 1024;
		for (let start = 0; start < chunk.length; start += tokenPageBytes) {
			const batch = tokenize(decode.decode(chunk.subarray(start, start + tokenPageBytes), { stream: true }));
			if (typeof batch === "symbol") continue;
			for (const t of batch.values) {
				const result = check.next(t);
				if (result.done) return result.value;
			}
		}
	}
	return false;
}
