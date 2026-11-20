import { jsonParser, type Token } from "stream-json/core/parser.js";
import type { SessionEntry } from "../../session-manager-types.ts";
import type { SqliteRow, SqliteValue } from "../database.js";
import type { ForkMetadata } from "./fork-window.js";
import type { SessionTreeOutlineEntry } from "./types.js";

// A projection only constructs values consumed by the resume fold. The stream parser must not pack
// strings or keys: even a single unselected JSON string (or property name) can span many chunks.
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Fields = { readonly [key: string]: Shape };
export type Shape =
	| ((first: Token) => Reader<Json>)
	| true
	| Fields
	| "child"
	| "tools"
	| "groups"
	| "tasks"
	| "array"
	| "truth"
	| "short"
	| "answerText"
	| "searchText"
	| "nonBlank"
	| "treeContent"
	| "labelPreview"
	| "string"
	| "stringPresent"
	| "objectPresent"
	| "hash"
	| "owner"
	| "op"
	| "usage"
	| "number";
export type Reader<T> = Generator<void, T, Token>;

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
	taskId: "string",
	terminalStatus: "short",
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
	"workflow.run.start": { runId: "string", name: "stringPresent", ts: "number" },
	"workflow.run.end": { runId: "string" },
	"workflow-stage-parked-tasks": { tasks: "tasks" },
	"task-completion-intent": { completionId: true, ownerId: true, taskId: true },
	"task-completion-ack": { completionId: true },
};

function field(fields: Fields, key: string): Shape | undefined {
	return Object.hasOwn(fields, key) ? fields[key] : undefined;
}

/** Consume the rest of one value without retaining any constituent token or nesting frame. */
export function* skip(first: Token): Reader<void> {
	let depth = first.name.startsWith("start") ? 1 : 0;
	while (depth > 0) {
		const { name } = yield;
		if (name.startsWith("start")) depth++;
		else if (name.startsWith("end")) depth--;
	}
}

export function* stringValue(limit = Infinity): Reader<string> {
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

export function* readValue(first: Token, shape: Shape | undefined): Reader<Json> {
	if (typeof shape === "function") return yield* shape(first);
	if (shape === "objectPresent") {
		yield* skip(first);
		return first.name === "startObject";
	}
	if (shape === "stringPresent") {
		yield* skip(first);
		return first.name === "startString" ? "" : null;
	}
	if (
		shape === undefined ||
		((shape === "op" || shape === "string") && first.name !== "startString") ||
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
			if (shape === "searchText") {
				let text = "",
					seen = false;
				for (let part = yield; part.name !== "endArray"; part = yield) {
					if (text.length >= 65537) {
						yield* skip(part);
						continue;
					}
					const b = object(yield* readValue(part, { type: "short", text: "searchText" }));
					if (b.type === "text" && typeof b.text === "string") {
						if (seen) text += " ";
						text += b.text.slice(0, 65537 - text.length);
						seen = true;
					}
				}
				return text;
			}
			if (shape === "treeContent") {
				let present = false;
				const calls: string[] = [];
				for (let token = yield; token.name !== "endArray"; token = yield) {
					const block = object(
						yield* readValue(token, { type: "short", id: "string", ...(present ? {} : { text: "nonBlank" }) }),
					);
					present ||= block.type === "text" && block.text === true;
					if (block.type === "toolCall" && typeof block.id === "string") calls.push(block.id);
				}
				return { present, calls };
			}
			if (shape === "answerText") {
				let text = "";
				for (let token = yield; token.name !== "endArray"; token = yield) {
					const block = object(yield* readValue(token, { type: "short", text: "string" }));
					if (block.type === "text" && typeof block.text === "string") text += block.text;
				}
				return text;
			}
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
			if (shape === "labelPreview") return yield* stringValue(128);
			if (shape === "nonBlank" || shape === "treeContent") {
				let present = false;
				for (let token = yield; token.name === "stringChunk"; token = yield)
					present ||= token.value.trim().length > 0;
				return present;
			}
			return yield* stringValue(
				shape === "short" ? 64 : shape === "hash" ? 65 : shape === "searchText" ? 65537 : Infinity,
			);
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

function* project(
	type: string,
	customType: string,
	role: string,
	branchStateOnly = false,
	includeId = false,
): Reader<Json> {
	const fields: Record<string, Shape> = branchStateOnly
		? { type: true, id: true }
		: { type: true, parentId: true, timestamp: true };
	if (includeId) fields.id = true;
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
		case "worktree_snapshot":
			fields.root = true;
			fields.snapshotId = true;
			fields.captureMs = "number";
			fields.degradedFrom = "truth";
			fields.snapshot = fields.restore = fields.unrestored = "objectPresent";
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
			fields.message = branchStateOnly
				? { role: "short", toolCallId: "string" }
				: role === "assistant"
					? { role: true, provider: true, model: true, usage: true, content: "tools" }
					: role === "toolResult"
						? { role: true, toolCallId: true, usage: "usage" }
						: role === "system"
							? { role: "short", toolsAdded: "truth", toolsRemoved: "truth" }
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
	if (branchStateOnly) delete fields.usage;
	return yield* readValue(yield, fields);
}

// Limit the number of short tokens a single tokenizer call can return as well as the bytes read from storage.
const TOKEN_PAGE_BYTES = 16 * 1024;
export async function read<T>(chunks: AsyncIterable<Uint8Array>, reader: Reader<T>): Promise<T> {
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

/** The fields of a stored entry's head that `messageHeadIn` reads, each a string or `null` when it is not one. */
export interface MessageHead {
	type?: string | null;
	role?: string | null;
	toolCallId?: string | null;
	toolName?: string | null;
}

const MESSAGE_HEAD_TEXT = 1024;

/** A string value of at most `limit` characters, or `null` when it is longer. */
function* boundedString(limit: number): Reader<string | null> {
	let value = "";
	let longer = false;
	for (let token = yield; token.name === "stringChunk"; token = yield) {
		if (value.length + token.value.length > limit) longer = true;
		else value += token.value;
	}
	return longer ? null : value;
}

/**
 * The top-level `type` and the message's `role`, `toolCallId` and `toolName` that the stored JSON beginning with `prefix`
 * states before the prefix ends; a field it does not reach is absent. A stored entry is `JSON.stringify`'s output, so no
 * key repeats and a key read in the prefix keeps that value in the whole entry (#5571).
 */
export function messageHeadIn(prefix: Uint8Array): MessageHead {
	const head: MessageHead = {};
	const text = function* (value: Token): Reader<string | null> {
		if (value.name === "startString") return yield* boundedString(MESSAGE_HEAD_TEXT);
		yield* skip(value);
		return null;
	};
	try {
		feed(
			(function* (): Reader<void> {
				if ((yield).name !== "startObject") return;
				while ((yield).name !== "endObject") {
					const name = yield* stringValue(8);
					const value = yield;
					if (name === "type") head.type = yield* text(value);
					else if (name === "message" && value.name === "startObject")
						while ((yield).name !== "endObject") {
							const key = yield* stringValue(11);
							const child = yield;
							if (key === "role" || key === "toolCallId" || key === "toolName") head[key] = yield* text(child);
							else yield* skip(child);
						}
					else yield* skip(value);
				}
			})(),
		)(new TextDecoder("utf-8", { fatal: true }).decode(prefix, { stream: true }));
	} catch {
		// A prefix that cannot be read tells nothing more. Reading the whole entry reports what is wrong with it.
	}
	return head;
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

/** Test the exact saved ID against caller-owned text without retaining the entry, even when the ID spans chunks. */
export function chunkedEntryHasId(chunks: AsyncIterable<Uint8Array>, id: string): Promise<boolean> {
	return read(
		chunks,
		(function* (): Reader<boolean> {
			if ((yield).name !== "startObject") throw new SyntaxError("Expected a session entry");
			let matched = false;
			while ((yield).name !== "endObject") {
				const key = yield* stringValue(3);
				const first = yield;
				if (key !== "id" || first.name !== "startString") {
					if (key === "id") matched = false;
					yield* skip(first);
					continue;
				}
				let offset = 0;
				matched = true;
				for (let part = yield; part.name === "stringChunk"; part = yield) {
					if (!id.startsWith(part.value, offset)) matched = false;
					offset += part.value.length;
				}
				matched = matched && offset === id.length;
			}
			return matched;
		})(),
	);
}

/** Read an interrupted run's exact JSON string without decoding its unrelated start inputs or normalizing SQL text. */
export async function readChunkedWorkflowRunId(chunks: AsyncIterable<Uint8Array>): Promise<string | undefined> {
	const selected = await read(
		chunks,
		(function* (): Reader<Json> {
			return yield* readValue(yield, { data: { runId: "string" } });
		})(),
	);
	const id = object(object(selected).data).runId;
	return typeof id === "string" ? id : undefined;
}

/** Only the fields consumed by the branch-state fold, without converting JSON strings to a SQL dialect's text. */
export async function chunkedBranchState(chunks: () => AsyncIterable<Uint8Array>): Promise<SessionEntry> {
	const type = await read(chunks(), discriminator("type"));
	const custom = type === "custom" || type === "custom_message";
	const customType = custom ? await read(chunks(), discriminator("customType")) : "";
	const entry = object(await read(chunks(), project(type, customType, "", true)));
	if (custom) entry.customType = customType;
	return entry as unknown as SessionEntry;
}

/** Identity and parent of a historical entry, plus its hash when it is a tool-output receipt. Never collect the receipt's inline bytes here. */
export async function chunkedForkLink(
	chunks: () => AsyncIterable<Uint8Array>,
): Promise<{ id?: string; parentId?: string | null; timestamp?: string; hash?: string; anchor: boolean }> {
	const selected = object(
		await read(
			chunks(),
			(function* (): Reader<Json> {
				return yield* readValue(yield, {
					id: "string",
					parentId: "string",
					timestamp: "string",
					type: "short",
					customType: "short",
					data: { hash: "short" },
				});
			})(),
		),
	);
	const hash =
		selected.type === "custom" && selected.customType === "atomic.tool-output"
			? object(selected.data).hash
			: undefined;
	return {
		id: typeof selected.id === "string" ? selected.id : undefined,
		parentId: typeof selected.parentId === "string" ? selected.parentId : null,
		timestamp: typeof selected.timestamp === "string" ? selected.timestamp : undefined,
		hash: typeof hash === "string" ? hash : undefined,
		anchor: selected.type === "custom" && selected.customType === "atomic.fork-anchor",
	};
}

/** Fold a pinned prefix that has no native resume index. Read the stored ID, ancestry and billing fields, never
 * the message body. The tool-call count is kept separate so no array of dummy content blocks is allocated. */
export async function chunkedPrefixFields(
	chunks: () => AsyncIterable<Uint8Array>,
): Promise<{ entry: SessionEntry; toolCalls: number }> {
	const type = await read(chunks(), discriminator("type"));
	const custom = type === "custom" || type === "custom_message";
	const customType = custom ? await read(chunks(), discriminator("customType")) : "";
	const role = type === "message" ? await read(chunks(), discriminator("role", "message")) : "";
	const value = object(await read(chunks(), project(type, customType, role, false, true)));
	if (custom) value.customType = customType;
	if (type === "worktree_snapshot" && !value.snapshot) delete value.snapshot;
	const count = object(value.message).content;
	return { entry: value as unknown as SessionEntry, toolCalls: typeof count === "number" ? count : 0 };
}

export async function chunkedTreeOutline(
	seq: number,
	chunks: AsyncIterable<Uint8Array>,
): Promise<SessionTreeOutlineEntry> {
	const e = object(
		await read(
			chunks,
			(function* (): Reader<Json> {
				return yield* readValue(yield, {
					id: "string",
					parentId: "string",
					type: "short",
					timestamp: "string",
					customType: "short",
					targetId: "string",
					label: "labelPreview",
					message: { role: "short", stopReason: "short", content: "treeContent" },
				});
			})(),
		),
	);
	const m = object(e.message);
	const content = object(m.content);
	return {
		seq,
		id: String(e.id),
		parentId: typeof e.parentId === "string" ? e.parentId : null,
		timestamp: String(e.timestamp),
		type: e.type as SessionEntry["type"],
		...(e.type === "message"
			? {
					role: String(m.role),
					...(m.role === "assistant" && Array.isArray(content.calls) && content.calls.length
						? { callIds: content.calls as string[] }
						: {}),
					...(m.role === "assistant" &&
					!(m.content === true || content.present) &&
					(!m.stopReason || m.stopReason === "stop" || m.stopReason === "toolUse")
						? { hideAssistant: true }
						: {}),
				}
			: {}),
		...(e.type === "custom" && e.customType === "atomic.leaf" ? { leafMove: true } : {}),
		...(e.type === "custom" && e.customType === "subagent-child" ? { childRecord: true } : {}),
		...(e.type === "label"
			? { labelTarget: String(e.targetId), label: typeof e.label === "string" ? e.label : undefined }
			: {}),
	};
}

const hasItems: Shape = function* (t) {
	if (t.name !== "startArray") {
		yield* skip(t);
		return null;
	}
	let present = false;
	for (let token = yield; token.name !== "endArray"; token = yield) {
		present = true;
		yield* skip(token);
	}
	return present ? [true] : [];
};
// Unknown property names (not values) identify the older observations needed to reconstruct a partial record.
const retainingKeys = (fields: Fields): Shape =>
	function* (t) {
		if (t.name !== "startObject") {
			yield* skip(t);
			return null;
		}
		const data: Record<string, Json> = Object.create(null);
		while ((yield).name !== "endObject") {
			const key = yield* stringValue();
			data[key] = yield* readValue(yield, field(fields, key));
		}
		return data;
	};
export async function chunkedChildHeading(chunks: AsyncIterable<Uint8Array>): Promise<SessionEntry> {
	const e = await read(
		chunks,
		(function* (): Reader<Json> {
			return yield* readValue(yield, {
				id: "string",
				type: "short",
				customType: "short",
				data: retainingKeys({
					waitingOn: hasItems,
					stillRunning: hasItems,
					heldToolResults: hasItems,
					wakeFailure: { taskId: "string" },
					worktree: { named: "truth" },
					heldMessages: { taskId: "string", messages: hasItems },
					version: "number",
					childId: "string",
					runId: "string",
					index: "number",
					agent: "string",
					cwd: "string",
					state: "short",
					owner: { kind: "short", sessionId: "string" },
					terminalStatus: "string",
					taskId: "string",
					childSessionId: "string",
					childSessionFile: "string",
					intercomTarget: "string",
					intercomGroup: "string",
					releasedIntercomId: "string",
					elapsedMs: "number",
					elapsedSpan: { dispatchedAt: "number", endedAt: "number" },
				}),
			});
		})(),
	);
	return e as unknown as SessionEntry;
}

export async function chunkedAnswerHeader(chunks: AsyncIterable<Uint8Array>) {
	const entry = object(
		await read(
			chunks,
			(function* (): Reader<Json> {
				return yield* readValue(yield, {
					id: "string",
					parentId: "string",
					type: "short",
					targetId: "string",
					message: { role: "short", stopReason: "short" },
				});
			})(),
		),
	);
	const msg = object(entry.message);
	return {
		id: String(entry.id),
		parentId: typeof entry.parentId === "string" ? entry.parentId : null,
		type: String(entry.type),
		targetId: entry.type === "context_edit" && typeof entry.targetId === "string" ? entry.targetId : undefined,
		role: typeof msg.role === "string" ? msg.role : undefined,
		stop: msg.stopReason === "stop",
	};
}

/** Once a candidate is selected, keep only the text that /copy may actually return, not tool arguments or images. */
export async function chunkedAnswerContent(
	chunks: AsyncIterable<Uint8Array>,
	edit: boolean,
): Promise<string | null | undefined> {
	const field = edit ? "replacement" : "message";
	const entry = object(
		await read(
			chunks,
			(function* (): Reader<Json> {
				return yield* readValue(yield, { [field]: { content: "answerText" } });
			})(),
		),
	);
	if (edit && entry.replacement === null) return null;
	const text = object(entry[field]).content;
	return typeof text === "string" ? text.trim() || undefined : undefined;
}

/** The bounded listing contribution and index fields of a raw backup row. The original bytes, not
 * these fields, are written into the child. Model usage/tool counts remain from the resume projection. */
export async function forkSeedFields(chunks: () => AsyncIterable<Uint8Array>) {
	const { entry, toolCalls } = await chunkedPrefixFields(chunks);
	const extra = object(
		await read(
			chunks(),
			(function* (): Reader<Json> {
				return yield* readValue(
					yield,
					entry.type === "message"
						? { message: { timestamp: "number", content: "searchText" } }
						: entry.type === "session_info"
							? { name: "string" }
							: entry.type === "session_summary"
								? { summary: "string", summarizedThroughId: "string" }
								: entry.type === "custom" && entry.customType === "atomic.tool-output"
									? { data: { hash: "hash" } }
									: {},
				);
			})(),
		),
	);
	if (entry.type === "message") {
		const fields = object(extra.message);
		Object.assign(entry.message, {
			timestamp: fields.timestamp,
			content:
				typeof fields.content === "string"
					? entry.message.role === "assistant"
						? [{ type: "text", text: fields.content }]
						: fields.content
					: [],
		});
	} else Object.assign(entry, extra);
	return { entry, extraToolCalls: toolCalls };
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
		if (type === "worktree_snapshot" && ["snapshot", "restore", "unrestored"].includes(key)) {
			result[column] = value ? (key === "snapshot" ? "{}" : 1) : null;
			continue;
		}
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
			if (key === "data" && ["version", "index", "timestamp", "ts"].includes(field))
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
