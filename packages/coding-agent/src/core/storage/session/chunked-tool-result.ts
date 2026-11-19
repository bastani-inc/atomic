import type { AgentMessage } from "@bastani/atomic-agent-core";
import type { Token } from "stream-json/core/parser.js";
import type { SessionEntry } from "../../session-manager-types.ts";
import { type Reader, read, skip, stringValue } from "./chunked-resume-projection.js";

/**
 * What a tool card needs of a saved tool result too large to read whole: which call it answers, under which tool
 * name, whether it failed and how long it took. Its content and details are never decoded into values.
 */
export interface ChunkedToolResult {
	readonly id: string | undefined;
	readonly parentId: string | null | undefined;
	readonly timestamp: string | undefined;
	readonly toolCallId: string;
	readonly toolName: string;
	readonly isError: boolean;
	readonly durationMs: number | undefined;
	readonly messageTimestamp: number | undefined;
}

/** Keys are compared exactly; any longer key is not one read here. */
const KEY_CHARS = 32;
/** Identities and names are short: a longer value is not kept whole and matches no call. */
const VALUE_CHARS = 1024;
const ENTRY_KEYS = new Set(["type", "id", "parentId", "timestamp"]);
const MESSAGE_KEYS = new Set(["role", "toolCallId", "toolName", "isError", "durationMs", "timestamp"]);

function* scalar(first: Token): Reader<string | number | boolean | null | undefined> {
	switch (first.name) {
		case "startString":
			return yield* stringValue(VALUE_CHARS);
		case "numberValue":
			return Number(first.value);
		case "trueValue":
			return true;
		case "falseValue":
			return false;
		case "nullValue":
			return null;
		default:
			yield* skip(first);
			return undefined;
	}
}

/** A row whose kind (`type`, then `role`) shows it is not a tool result: the rest of it is not read. */
const OTHER = Symbol("not a tool result");

/**
 * The selected scalar fields of the object whose `startObject` was just read; duplicate keys, the last one wins.
 * Writers put an entry's kind first, so a row of another kind is left after its first bytes.
 */
function* fields(
	keys: ReadonlySet<string>,
	kind: readonly [string, unknown],
	nested?: string,
): Reader<Record<string, unknown> | typeof OTHER> {
	const selected: Record<string, unknown> = {};
	while ((yield).name !== "endObject") {
		const key = yield* stringValue(KEY_CHARS);
		const first = yield;
		if (key === nested && first.name === "startObject") {
			const message = yield* fields(MESSAGE_KEYS, ["role", "toolResult"]);
			if (message === OTHER) return OTHER;
			selected[key] = message;
		} else if (keys.has(key)) {
			selected[key] = yield* scalar(first);
			if (key === kind[0] && selected[key] !== kind[1]) return OTHER;
		} else yield* skip(first);
	}
	return selected;
}

function* entryFields(): Reader<Record<string, unknown> | typeof OTHER | undefined> {
	if ((yield).name !== "startObject") return undefined;
	return yield* fields(ENTRY_KEYS, ["type", "message"], "message");
}

const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/**
 * The tool result a saved entry holds, read field by field from its stored JSON text, or undefined when the entry is
 * not a tool result. The text is streamed through once; no part of the content or details is retained.
 */
export async function chunkedToolResult(chunks: AsyncIterable<Uint8Array>): Promise<ChunkedToolResult | undefined> {
	const entry = await read(chunks, entryFields());
	if (entry === OTHER) return undefined;
	const message = entry?.message as Record<string, unknown> | undefined;
	if (entry?.type !== "message" || message?.role !== "toolResult") return undefined;
	const toolCallId = text(message.toolCallId);
	if (toolCallId === undefined) return undefined;
	const parentId = entry.parentId;
	return {
		id: text(entry.id),
		parentId: parentId === null ? null : text(parentId),
		timestamp: text(entry.timestamp),
		toolCallId,
		toolName: text(message.toolName) ?? "tool",
		isError: message.isError === true,
		durationMs: number(message.durationMs),
		messageTimestamp: number(message.timestamp),
	};
}

/**
 * The saved entry a card draws for such a result: the call it answers and its outcome, with `note` (where to read
 * the original bytes) in place of the body.
 */
export function chunkedToolResultEntry(result: ChunkedToolResult, fallbackId: string, note: string): SessionEntry {
	const message = {
		role: "toolResult",
		toolCallId: result.toolCallId,
		toolName: result.toolName,
		content: [{ type: "text", text: note }],
		isError: result.isError,
		timestamp: result.messageTimestamp ?? 0,
		...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
	} as AgentMessage;
	return {
		type: "message",
		id: result.id ?? fallbackId,
		parentId: result.parentId ?? null,
		timestamp: result.timestamp ?? "1970-01-01T00:00:00Z",
		message,
	} as SessionEntry;
}
