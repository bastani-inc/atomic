import { randomUUID } from "node:crypto";
import type { SessionEntry } from "../../../packages/coding-agent/src/core/session-manager-types.ts";
import type { SqliteDatabase } from "../../../packages/coding-agent/src/core/storage/database.js";
import type { SessionRecordHeader } from "../../../packages/coding-agent/src/core/storage/session/types.js";
import type { DurableCheckpoint } from "../../../packages/workflows/src/durable/types.js";

const WORDS = (
	"refactor parser token stream session resume workflow journal sqlite cache invalidation lease expiry " +
	"picker render selector branch commit review build test vitest biome typecheck module import export " +
	"function class interface stage checkpoint prompt message assistant user tool output error retry"
).split(" ");

export function words(seed: number, count: number): string {
	let state = seed >>> 0 || 1;
	const out: string[] = [];
	for (let index = 0; index < count; index++) {
		state = (state * 1_103_515_245 + 12_345) >>> 0;
		out.push(WORDS[state % WORDS.length]!);
	}
	return out.join(" ");
}

export function sessionCwd(root: string, index: number, projects: number): string {
	return `${root}/project-${index % projects}`;
}

export function messageEntry(
	id: string,
	parentId: string | null,
	time: number,
	role: "user" | "assistant",
	text: string,
) {
	const timestamp = new Date(time).toISOString();
	const message =
		role === "user"
			? { role, content: text, timestamp: time }
			: {
					role,
					content: [{ type: "text", text }],
					api: "openai-completions",
					provider: "bench",
					model: "bench",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: time,
				};
	return { type: "message", id, parentId, timestamp, message } as SessionEntry;
}

/** A realistic session: alternating user/assistant messages whose text feeds `session_search_texts`. */
export function sessionFixture(
	root: string,
	index: number,
	options: { readonly projects: number; readonly messages: number; readonly wordsPerMessage: number },
): { header: SessionRecordHeader; entries: SessionEntry[] } {
	const id = randomUUID();
	const created = Date.UTC(2026, 0, 1) + index * 60_000;
	const header: SessionRecordHeader = {
		id,
		version: 4,
		createdAt: new Date(created).toISOString(),
		cwd: sessionCwd(root, index, options.projects),
	};
	const entries: SessionEntry[] = [];
	let parent: string | null = null;
	for (let message = 0; message < options.messages; message++) {
		const entryId = `${index}-${message}`;
		entries.push(
			messageEntry(
				entryId,
				parent,
				created + message * 1_000,
				message % 2 === 0 ? "user" : "assistant",
				words(index * 1_000 + message, options.wordsPerMessage),
			),
		);
		parent = entryId;
	}
	if (index % 5 === 0) {
		entries.push({
			type: "session_info",
			id: `${index}-name`,
			parentId: parent,
			timestamp: new Date(created + options.messages * 1_000).toISOString(),
			name: `Session ${index}`,
		} as SessionEntry);
	}
	return { header, entries };
}

export function toolCheckpoint(workflowId: string, index: number, outputWords: number): DurableCheckpoint {
	return {
		kind: "tool",
		workflowId,
		checkpointId: `cp-${index}`,
		name: `tool-${index}`,
		argsHash: `hash-${index}`,
		output: words(index + workflowId.length, outputWords),
		completedAt: Date.UTC(2026, 0, 1) + index,
	};
}

/** Seeding only: skip per-commit fsync so a large fixture builds in seconds. */
export async function fastSeeding(database: SqliteDatabase): Promise<void> {
	await database.exec("PRAGMA synchronous=OFF");
}
