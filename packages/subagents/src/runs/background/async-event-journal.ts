import * as fs from "node:fs";
import type { DrainableSource, JsonlWriteStream } from "../../shared/jsonl-writer.ts";
import { acquireEventWriter } from "../../shared/event-jsonl-writer.ts";

const DEFAULT_TELEMETRY_BYTES = 512 * 1024;
const CAPPED_CHILD_EVENT_TYPES = new Set([
	"message_update", "tool_execution_update", "subagent.child.stdout", "subagent.child.stderr",
]);

interface ChildEventJournalContext {
	runId: string;
	stepIndex?: number;
	agent: string;
}

interface ChildEventJournalDeps {
	maxTelemetryBytes?: number;
	createWriteStream?: (filePath: string) => JsonlWriteStream;
	now?: () => number;
}

export interface ChildEventJournal {
	append(event: Record<string, unknown>): void;
	close(): Promise<void>;
}

function withoutKey(record: Record<string, unknown>, key: string): Record<string, unknown> {
	const { [key]: _removed, ...rest } = record;
	return rest;
}

/** Remove cumulative streaming snapshots while retaining compact delta metadata. */
export function sanitizeChildEvent(event: Record<string, unknown>): Record<string, unknown> {
	let sanitized = event;
	if (event.type === "message_update") {
		sanitized = withoutKey(event, "message");
		const assistantEvent = sanitized.assistantMessageEvent;
		if (assistantEvent && typeof assistantEvent === "object" && !Array.isArray(assistantEvent)) {
			let compactEvent = withoutKey(withoutKey(assistantEvent as Record<string, unknown>, "partial"), "message");
			if (!("delta" in compactEvent)) {
				compactEvent = withoutKey(withoutKey(compactEvent, "content"), "toolCall");
			}
			sanitized = { ...sanitized, assistantMessageEvent: compactEvent };
		}
	}
	if (event.type === "message_start") sanitized = withoutKey(sanitized, "message");
	if (event.type === "tool_execution_update") sanitized = withoutKey(sanitized, "partialResult");
	if (event.type === "turn_end") sanitized = withoutKey(sanitized, "message");
	if (event.type === "agent_end") sanitized = withoutKey(sanitized, "messages");
	return sanitized;
}

export function createChildEventJournal(
	filePath: string | undefined,
	source: DrainableSource,
	context: ChildEventJournalContext,
	deps: ChildEventJournalDeps = {},
): ChildEventJournal {
	if (!filePath) return { append() {}, async close() {} };
	const createStream = deps.createWriteStream ?? ((target: string) => fs.createWriteStream(target, { flags: "a" }));
	const writer = acquireEventWriter(filePath, source, createStream);
	if (!writer) return { append() {}, async close() {} };
	const maxTelemetryBytes = deps.maxTelemetryBytes ?? DEFAULT_TELEMETRY_BYTES;
	const now = deps.now ?? Date.now;
	let closed = false;
	let closePromise: Promise<void> | undefined;
	const write = (record: Record<string, unknown>): void => writer.writeLine(JSON.stringify(record));

	const enrich = (event: Record<string, unknown>): Record<string, unknown> => ({
		...event,
		subagentSource: "child",
		subagentRunId: context.runId,
		subagentStepIndex: context.stepIndex,
		subagentAgent: context.agent,
		observedAt: now(),
	});

	return {
		append(event) {
			if (closed) return;
			const sanitized = sanitizeChildEvent(event);
			const record = enrich(sanitized);
			const lineBytes = Buffer.byteLength(`${JSON.stringify(record)}\n`, "utf-8");
			const assistantEvent = event.type === "message_update" && event.assistantMessageEvent
				&& typeof event.assistantMessageEvent === "object" && !Array.isArray(event.assistantMessageEvent)
				? event.assistantMessageEvent as Record<string, unknown>
				: undefined;
			const nestedTerminal = assistantEvent?.type === "done" || assistantEvent?.type === "error";
			const capped = !nestedTerminal && typeof event.type === "string" && CAPPED_CHILD_EVENT_TYPES.has(event.type);
			if (capped && !writer.reserveTelemetry(lineBytes, maxTelemetryBytes)) {
				if (writer.claimTruncationMarker()) {
					write(enrich({ type: "subagent.child.telemetry_truncated", maxTelemetryBytes }));
				}
				return;
			}
			write(record);
		},
		close() {
			if (!closePromise) {
				closed = true;
				closePromise = writer.close();
			}
			return closePromise;
		},
	};
}
