import { jsonParser, type Token } from "stream-json/core/parser.js";
import type { SqliteRow, SqliteValue } from "../database.js";
import type { ForkMetadata } from "./fork-window.js";

// A projection only constructs values consumed by the resume fold. The stream parser must not pack
// strings or keys: even a single unselected JSON string (or property name) can span many chunks.
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Fields = { readonly [key: string]: Shape };
type Shape =
	| true
	| Fields
	| "child"
	| "tools"
	| "groups"
	| "tasks"
	| "array"
	| "truth"
	| "short"
	| "hash"
	| "owner"
	| "op"
	| "usage"
	| "number";
type Reader<T> = Generator<void, T, Token>;

const protocolMessage = { id: true, replyTo: true, expectsReply: true } as const;
const usageTotals = {
	input: "number",
	output: "number",
	cacheRead: "number",
	cacheWrite: "number",
	cost: { total: "number" },
} as const;
const childFields = {
	version: true,
	index: true,
	agent: "short",
	cwd: "short",
	runId: "short",
	childId: true,
	state: "short",
	owner: "owner",
} as const;
const customFields: Fields = {
	"subagent-child": "child",
	"atomic-pooled-delivery-op": { op: "op" },
	intercom_session_identity: { sessionId: true, intercomSessionId: "short" },
	intercom_session_memberships: { sessionId: true, homeGroup: "short", groups: "groups" },
	workspace_binding: { kind: "short", worktree: "short", sessionId: true, id: true },
	"web-search-results": { id: true, sessionId: true, timestamp: true, type: true, queries: "array", urls: "array" },
	"subagent-slash-final-snapshot": { sessionId: true, id: true },
	resume_timings: { sessionId: true, id: true },
	intercom_inbox: { message: protocolMessage },
	intercom_received: { message: protocolMessage, messageId: true },
	intercom_inbox_handled: { messageId: true },
	intercom_ask: { askId: true },
	intercom_ask_settled: { askId: true },
	intercom_sent: { message: protocolMessage },
	intercom_reply_wait: { toolCallId: true },
	"workflow.run.start": { runId: true },
	"workflow.stage.start": { runId: true },
	"workflow.stage.end": { runId: true },
	"workflow.run.end": { runId: true },
	"workflow-stage-parked-tasks": { tasks: "tasks" },
	"task-completion-intent": { completionId: true, ownerId: true, taskId: true },
	"task-completion-ack": { completionId: true },
};

function field(fields: Fields, key: string): Shape | undefined {
	return Object.hasOwn(fields, key) ? fields[key] : undefined;
}

/** Consume the rest of one value without retaining any constituent token or nesting frame. */
function* skip(first: Token): Reader<void> {
	let depth = first.name.startsWith("start") ? 1 : 0;
	while (depth > 0) {
		const { name } = yield;
		if (name.startsWith("start")) depth++;
		else if (name.startsWith("end")) depth--;
	}
}

function* stringValue(limit = Infinity): Reader<string> {
	let value = "";
	for (let token = yield; token.name === "stringChunk"; token = yield) {
		if (value.length < limit) value += token.value.slice(0, limit - value.length);
	}
	return value;
}

// Feed a suspended selector without ever packing all of a token's text. The same reader can consume JSON
// embedded in a string: legacy SQL decodes those strings in tool blocks and in owner/tasks/groups fields.
function feed<T>(reader: Reader<T>) {
	const parse = jsonParser({ packValues: false, packNumbers: true, streamNumbers: false, maxDepth: Infinity });
	reader.next();
	return (text: string) => {
		const tokens = parse(text);
		if (typeof tokens !== "symbol")
			for (const token of tokens.values) {
				const next = reader.next(token);
				if (next.done) return next;
			}
		return undefined;
	};
}

function* embedded(shape: Shape, tool = false): Reader<Json> {
	const consume = feed(
		(function* (): Reader<Json> {
			return yield* readValue(yield, shape);
		})(),
	);
	let started = false;
	let result: Json | undefined;
	for (let token = yield; token.name === "stringChunk"; token = yield) {
		if (result !== undefined) continue;
		const text = !started && tool ? token.value.trimStart() : token.value;
		if (!text.length) continue;
		if (!started && text[0] !== "{" && text[0] !== "[") result = "not JSON";
		else {
			started = true;
			result = consume(text)?.value;
		}
	}
	return result ?? "not JSON";
}

function* readValue(first: Token, shape: Shape | undefined): Reader<Json> {
	if (
		shape === undefined ||
		(shape === "op" && first.name !== "startString") ||
		(shape === "number" && first.name !== "numberValue") ||
		(shape === "tools" && first.name !== "startArray")
	) {
		yield* skip(first);
		return null;
	}
	if (shape === "truth" && (first.name === "startObject" || first.name === "startArray")) {
		yield* skip(first);
		return true;
	}
	switch (first.name) {
		case "startObject": {
			const fields =
				shape === "child"
					? childFields
					: shape === "usage"
						? usageTotals
						: shape === "owner"
							? { sessionId: true as const }
							: typeof shape === "object"
								? shape
								: {};
			const allKeys = shape === "child" || shape === true;
			const limit = allKeys ? Infinity : Math.max(0, ...Object.keys(fields).map((key) => key.length)) + 1;
			const out: { [key: string]: Json } = Object.create(null);
			while ((yield).name !== "endObject") {
				const key = yield* stringValue(limit);
				const child = shape === true ? true : field(fields, key);
				const value = yield* readValue(yield, child);
				if (child !== undefined || allKeys) out[key] = value;
			}
			return out;
		}
		case "startArray": {
			const out: Json[] = [];
			let tools = 0;
			for (let token = yield; token.name !== "endArray"; token = yield) {
				if (shape === "groups") {
					if (token.name !== "startString" && out.length === 0) out.push(null);
					yield* skip(token);
				} else if (shape === "tools") {
					const item =
						token.name === "startString"
							? yield* embedded({ type: "short" }, true)
							: yield* readValue(token, { type: "short" });
					if (typeof item === "object" && item !== null && "type" in item && item.type === "toolCall") tools++;
				} else if (shape === "tasks" || shape === true) {
					out.push(yield* readValue(token, shape === true ? true : { ownerId: true, taskId: true }));
				} else yield* skip(token);
			}
			return shape === "tools" ? tools : out;
		}
		case "startString":
			// Object selectors cannot enter a string. Some legacy fields, however, accept JSON encoded as text.
			if (typeof shape === "object" || shape === "child" || shape === "array") {
				yield* skip(first);
				return null;
			}
			if (shape === "owner" || shape === "tasks" || shape === "groups" || shape === "usage")
				return JSON.stringify(yield* embedded(shape));
			if (shape === "truth") return (yield* stringValue(1)) === "" ? "" : "x";
			return yield* stringValue(shape === "short" ? 64 : shape === "hash" ? 65 : Infinity);
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

function* discriminator(key: string, parent?: string): Reader<string> {
	if ((yield).name !== "startObject") throw new SyntaxError("Expected a session entry");
	while ((yield).name !== "endObject") {
		const name = yield* stringValue((parent ?? key).length + 1);
		const value = yield;
		if (parent !== undefined && name === parent && value.name === "startObject") {
			while ((yield).name !== "endObject") {
				const name = yield* stringValue(key.length + 1);
				const child = yield;
				if (name === key && child.name === "startString") return yield* stringValue(64);
				yield* skip(child);
			}
			return "";
		}
		if (parent === undefined && name === key && value.name === "startString") return yield* stringValue(64);
		yield* skip(value);
	}
	return "";
}

function* project(type: string, customType: string, role: string): Reader<Json> {
	const fields: Record<string, Shape> = { type: true, parentId: true, timestamp: true };
	switch (type) {
		case "custom": {
			const data = field(customFields, customType);
			if (data !== undefined) fields.data = data;
			break;
		}
		case "custom_message":
			fields.stageAdmissionKey = true;
			fields.protectedReconciliation = "truth";
			fields.details = {
				protectedReconciliationOf: true,
				...(customType === "subagent-slash-result" ? { requestId: true } : {}),
				...(customType === "intercom_message" ? { message: protocolMessage, historyOnly: true } : {}),
			};
			break;
		case "thinking_level_change":
			fields.thinkingLevel = true;
			break;
		case "model_change":
			fields.provider = true;
			fields.modelId = true;
			break;
		case "label":
			fields.targetId = true;
			break;
		case "message":
			fields.message =
				role === "assistant"
					? { role: true, provider: true, model: true, usage: true, content: "tools" }
					: role === "toolResult"
						? { role: true, toolCallId: true, usage: "usage" }
						: { role: "short" };
			break;
		case "compaction":
			fields.firstKeptEntryId = true;
			fields.coveredThroughEntryId = true;
			fields.details = { strategy: "short" };
			fields.usage = "usage";
			break;
		case "session_summary":
		case "branch_summary":
		case "usage":
			fields.usage = "usage";
			break;
	}
	return yield* readValue(yield, fields);
}

// Limit the number of short tokens a single tokenizer call can return as well as the bytes read from storage.
const TOKEN_PAGE_BYTES = 16 * 1024;
async function read<T>(chunks: AsyncIterable<Uint8Array>, reader: Reader<T>): Promise<T> {
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const consume = feed(reader);
	for await (const chunk of chunks) {
		for (let offset = 0; offset < chunk.length; offset += TOKEN_PAGE_BYTES) {
			const next = consume(decoder.decode(chunk.subarray(offset, offset + TOKEN_PAGE_BYTES), { stream: true }));
			if (next !== undefined) return next.value;
		}
	}
	throw new SyntaxError("Incomplete chunked session entry");
}

/**
 * The role of the session message entry whose stored JSON begins with `prefix`, or undefined when the prefix ends
 * before the role is known. A message normally begins with its `role`, so a short prefix tells a system message apart
 * without reading the message's payload.
 */
export function messageRoleIn(prefix: Uint8Array): string | undefined {
	try {
		return feed(discriminator("role", "message"))(
			new TextDecoder("utf-8", { fatal: true }).decode(prefix, { stream: true }),
		)?.value;
	} catch {
		// A prefix that cannot be read decides nothing. Reading the whole entry reports what is wrong with it.
		return undefined;
	}
}

export async function projectForkMetadata(seq: number, chunks: AsyncIterable<Uint8Array>): Promise<ForkMetadata> {
	const e = object(
		await read(
			chunks,
			(function* (): Reader<Json> {
				return yield* readValue(yield, {
					type: "short",
					customType: "short",
					details: { strategy: "short" },
					firstKeptEntryId: true,
					coveredThroughEntryId: true,
					targetId: true,
					label: "truth",
					data: { hash: "hash", completionId: "op" },
					id: true,
					parentId: true,
					timestamp: true,
					message: { role: "short", provider: true, model: true },
				});
			})(),
		),
	);
	const type = String(e.type);
	const link = { id: String(e.id), parentId: e.parentId === null ? null : String(e.parentId) };
	if (type === "label" && typeof e.targetId === "string")
		return { seq, type, ...link, labelTarget: e.targetId, labelSet: Boolean(e.label) };
	if (type === "compaction" && object(e.details).strategy === "verbatim-lines")
		return {
			seq,
			type,
			...link,
			boundary: {
				first: typeof e.firstKeptEntryId === "string" ? e.firstKeptEntryId : null,
				covered: typeof e.coveredThroughEntryId === "string" ? e.coveredThroughEntryId : undefined,
			},
		};
	const m = object(e.message);
	if (type === "message" && m.role === "system") return { seq, type, ...link, system: true };
	if (type === "message" && m.role === "assistant")
		return {
			seq,
			type,
			...link,
			assistantModel: {
				type: "model_change",
				id: String(e.id),
				parentId: e.parentId === null ? null : String(e.parentId),
				timestamp: String(e.timestamp),
				provider: String(m.provider),
				modelId: String(m.model),
			},
		};
	const hash = object(e.data).hash;
	return {
		seq,
		type,
		...link,
		customType: typeof e.customType === "string" ? e.customType : undefined,
		hash: e.customType === "atomic.tool-output" && typeof hash === "string" ? hash : undefined,
		completionId:
			(e.customType === "task-completion-intent" || e.customType === "task-completion-ack") &&
			typeof object(e.data).completionId === "string"
				? String(object(e.data).completionId)
				: undefined,
	};
}

function object(value: Json | undefined): Record<string, Json> {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

// jsonb orders keys by UTF-8 byte length, then unsigned bytes. Its ->> operator returns text even for numbers
// and nested objects. Preserve that order/coercion, including in the latest assistant usage saved in the index.
function orderedKeys(value: Record<string, Json>, postgres: boolean): string[] {
	const keys = Object.keys(value);
	return postgres
		? keys
				.map((key) => ({ key, bytes: Buffer.from(key) }))
				.sort((a, b) => a.bytes.length - b.bytes.length || Buffer.compare(a.bytes, b.bytes))
				.map(({ key }) => key)
		: keys.map(sqliteText);
}

function sqliteText(text: string): string {
	// SQLite's json_extract encodes an unpaired surrogate with three invalid UTF-8 bytes. Its text reader
	// replaces each byte; JSON embedded in an object or array, in contrast, keeps the original escape.
	return text.replace(/\p{Surrogate}/gu, "\ufffd\ufffd\ufffd");
}

function postgresText(text: string): string {
	return text.replace(/\u0000|\p{Surrogate}/gu, "\ufffd");
}

function jsonbText(value: Json): string {
	if (value === null || typeof value === "boolean") return String(value);
	if (typeof value === "string") return JSON.stringify(postgresText(value));
	if (typeof value === "number") {
		const [mantissa, exponent] = String(value).split("e");
		if (exponent === undefined) return mantissa!;
		const sign = mantissa!.startsWith("-") ? "-" : "";
		const [integer, fraction = ""] = mantissa!.slice(sign.length).split(".");
		const digits = integer! + fraction;
		const point = integer!.length + Number(exponent);
		if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
		if (point >= digits.length) return sign + digits.padEnd(point, "0");
		return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
	}
	if (Array.isArray(value)) return `[${value.map(jsonbText).join(", ")}]`;
	return `{${orderedKeys(value, true)
		.map((key) => `${JSON.stringify(postgresText(key))}: ${jsonbText(value[key]!)}`)
		.join(", ")}}`;
}

function extracted(value: Json | undefined, postgres: boolean): Json {
	if (value === undefined || value === null) return null;
	if (postgres) return typeof value === "string" ? postgresText(value) : jsonbText(value);
	if (typeof value === "string") return sqliteText(value);
	return typeof value === "boolean" ? Number(value) : value;
}

/** Fill the inline projection of the stub with the streamed fields. No reconstructed value is sent back to SQL. */
export async function chunkedResumeProjection(
	stub: SqliteRow,
	postgres: boolean,
	chunks: () => AsyncIterable<Uint8Array>,
): Promise<SqliteRow> {
	const type = String(stub.resume_type);
	const custom = type === "custom" || type === "custom_message";
	const customType = custom ? await read(chunks(), discriminator("customType")) : "";
	const role = type === "message" ? await read(chunks(), discriminator("role", "message")) : "";
	const entry = object(await read(chunks(), project(type, customType, role)));
	if (custom) entry.customType = customType;
	const result: Record<string, SqliteValue> = { ...stub };
	for (const [key, value] of Object.entries(entry)) {
		const column = `resume_${key.toLowerCase()}`;
		if (key !== "data" && key !== "details" && key !== "message") {
			const v = extracted(value, postgres);
			result[column] = v !== null && typeof v === "object" ? JSON.stringify(v) : (v as SqliteValue);
			continue;
		}
		const projected = JSON.parse(String(stub[column])) as Record<string, Json>;
		const source = object(value);
		if (key === "data") result.resume_datafields = JSON.stringify(orderedKeys(source, postgres));
		if (key === "message") result.resume_toolcalls = typeof source.content === "number" ? source.content : 0;
		if (key === "details" && type === "compaction")
			result.resume_compactiondetails = extracted(source.strategy, postgres) as SqliteValue;
		for (const [field, v] of Object.entries(source)) {
			if (!Object.hasOwn(projected, field)) continue;
			if (key === "data" && ["version", "index", "timestamp"].includes(field))
				projected[field] = typeof v === "number" ? v : null;
			else if (key === "data" && ["queries", "urls"].includes(field))
				projected[field] = Array.isArray(v) ? "[]" : null;
			else if (field === "message" && key !== "message") {
				const nested = object(projected.message);
				for (const name of Object.keys(nested)) nested[name] = extracted(object(v)[name], postgres);
			} else projected[field] = extracted(v, postgres);
		}
		result[column] = JSON.stringify(projected);
	}
	return result;
}
