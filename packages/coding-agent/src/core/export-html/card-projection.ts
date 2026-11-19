import type { Token } from "stream-json/core/parser.js";
import type { SessionEntry } from "../session-manager.ts";
import { type Reader, read, skip, stringValue } from "../storage/session/chunked-resume-projection.js";

// Standalone HTML only needs to prove that a saved receipt belongs to a launch. Oversized calls/results
// remain byte-for-byte in the output stream: do not decode images, nested tool arguments or a child's answer.
type Value = string | number | boolean | null | Value[] | { [key: string]: Value };
type Selector = (token: Token) => Reader<Value>;
const obj = (v: Value | undefined): Record<string, Value> =>
	v !== null && typeof v === "object" && !Array.isArray(v) ? v : {};
const fields = (shape: Record<string, Selector>): Selector =>
	function* (t) {
		if (t.name !== "startObject") {
			yield* skip(t);
			return null;
		}
		const result: Record<string, Value> = Object.create(null);
		const max = Math.max(...Object.keys(shape).map((k) => k.length)) + 1;
		for (let k = yield; k.name !== "endObject"; k = yield) {
			const key = yield* stringValue(max);
			const value = yield;
			if (Object.hasOwn(shape, key)) result[key] = yield* shape[key]!(value);
			else yield* skip(value);
		}
		return result;
	};
const arr = (select: Selector, create: () => { visit(value: Value, index: number): void; done(): Value }): Selector =>
	function* (t) {
		if (t.name !== "startArray") {
			yield* skip(t);
			return null;
		}
		const acc = create();
		let i = 0;
		for (let token = yield; token.name !== "endArray"; token = yield) acc.visit(yield* select(token), i++);
		return acc.done();
	};
const str = (limit: number): Selector =>
	function* (t) {
		if (t.name !== "startString") {
			yield* skip(t);
			return null;
		}
		return yield* stringValue(limit);
	};
const text: Selector = function* (t) {
	if (t.name !== "startString") {
		yield* skip(t);
		return null;
	}
	let present = false,
		nonblank = false;
	for (let p = yield; p.name === "stringChunk"; p = yield) {
		present ||= p.value.length > 0;
		nonblank ||= p.value.trim().length > 0;
	}
	return nonblank ? "x" : present ? " " : "";
};
const scalar: Selector = function* (t) {
	if (t.name === "startString") return yield* stringValue(1);
	if (t.name === "numberValue") return Number(t.value);
	if (t.name === "trueValue" || t.name === "falseValue" || t.name === "nullValue") return t.value;
	yield* skip(t);
	return true;
};
const string = str(Infinity),
	tag = str(64);
const block = fields({
	type: tag,
	text,
	data: str(0),
	mimeType: str(0),
	name: tag,
	id: string,
	arguments: fields({ agent: string, task: string, action: scalar, tasks: scalar }),
});
// Keep only enough blocks to decide whether there was one launch; together with the last eligible answer block and ordinal.
const selectContent = (select: Selector) =>
	arr(select, () => {
		const calls: Value[] = [];
		let last = -1,
			hasTool = false,
			readable = true;
		return {
			visit(v, i) {
				const b = obj(v);
				if (b.type === "toolCall") {
					hasTool ||= typeof b.name === "string";
					if (calls.length < 2) calls.push(v);
				}
				if (b.type === "text" && b.text === "x") last = i;
				readable &&=
					(b.type === "text" && typeof b.text === "string") ||
					(b.type === "image" && typeof b.mimeType === "string" && typeof b.data === "string");
			},
			done() {
				return { calls, last, hasTool, readable };
			},
		};
	});
const content = selectContent(block);
const childContent = selectContent(fields({ type: tag, text, name: str(0) }));
const nested = arr(
	fields({ name: str(0), status: str(0), error: scalar, durationMs: scalar, argumentsBytes: scalar }),
	() => {
		let valid = true;
		return {
			visit(v) {
				const c = obj(v);
				valid &&=
					typeof c.name === "string" &&
					typeof c.status === "string" &&
					(c.error === undefined || typeof c.error === "string") &&
					(c.durationMs === undefined || typeof c.durationMs === "number") &&
					(c.argumentsBytes === undefined || typeof c.argumentsBytes === "number");
			},
			done() {
				return valid ? [] : [null];
			},
		};
	},
);
const messages = arr(fields({ role: tag, stopReason: tag, errorMessage: scalar, content: childContent }), () => {
	let last: Value = null,
		tools = false;
	return {
		visit(v) {
			const m = obj(v);
			last = v;
			tools ||= m.role === "assistant" && obj(m.content).hasTool === true;
		},
		done() {
			return { last, tools };
		},
	};
});
const toolCalls = arr(fields({ expandedText: scalar, text: scalar }), () => {
	let ok = true,
		count = 0;
	return {
		visit(v) {
			count++;
			const s = obj(v),
				line = s.expandedText || s.text;
			ok &&= typeof line === "string" && line.length > 0;
		},
		done() {
			return ok && count ? [{ text: "x" }] : [];
		},
	};
});
const results = arr(
	fields({ agent: string, task: string, status: tag, detached: scalar, finalOutput: text, messages, toolCalls }),
	() => {
		const r: Value[] = [];
		return {
			visit(v) {
				if (r.length < 2) r.push(v);
			},
			done() {
				return r;
			},
		};
	},
);
const details = fields({
	ownerSessionId: string,
	mode: tag,
	results,
	taskResponse: fields({ kind: tag, observation: fields({ kind: tag, taskId: str(0) }) }),
});
const message = fields({
	role: tag,
	content,
	toolCallId: string,
	toolName: tag,
	isError: scalar,
	details,
	nestedCalls: fields({ calls: nested }),
});
const entry = fields({ id: string, parentId: string, type: tag, customType: tag, message });
export async function chunkedCardEntry(
	chunks: AsyncIterable<Uint8Array>,
): Promise<{ entry: SessionEntry; answerBlock?: number }> {
	const e = obj(
		await read(
			chunks,
			(function* (): Reader<Value> {
				return yield* entry(yield);
			})(),
		),
	);
	const m = obj(e.message),
		c = obj(m.content),
		d = obj(m.details);
	let answerBlock: number | undefined;
	if (m.role === "assistant") m.content = Array.isArray(c.calls) ? c.calls : [];
	if (m.role === "toolResult") {
		m.content = c.readable === true ? [{ type: "text", text: "" }] : [null];
		if (Array.isArray(d.results) && d.results.length === 1) {
			const child = obj(d.results[0]),
				history = obj(child.messages),
				last = obj(history.last),
				info = obj(last.content);
			if (child.messages && typeof child.messages === "object") {
				const answer = typeof info.last === "number" && info.last >= 0;
				last.content = answer ? [{ type: "text", text: "x" }] : [];
				child.messages = history.tools
					? [{ role: "assistant", content: [{ type: "toolCall", name: "tool" }] }, last]
					: [last];
				if (answer) answerBlock = Number(info.last);
			}
		}
	}
	return { entry: e as unknown as SessionEntry, answerBlock };
}
