import { convertToLlm } from "./messages.js";
import {
	applyContextEdit,
	buildContextEntries,
	buildSessionProjection,
	collectContextEdits,
	getLatestCompactionBoundaryEntry,
} from "./session-manager-history.ts";
import type { SessionEntry } from "./session-manager-types.ts";
import { TOOL_OUTPUT_ENTRY_TYPE } from "./session-tool-output.ts";
import { historyChunks, historyPages, type SessionHistorySource } from "./storage/session/history-pages.js";
import { TOOL_DEACTIVATION_ENTRY_TYPE } from "./tool-deactivation.ts";

const forkSettings = new Set(["workspace_binding", TOOL_DEACTIVATION_ENTRY_TYPE, "codemode-store"]);

/** A fork at a specific point can inherit only ancestor receipts. An unqualified current-leaf fork can also
 * keep a named output that the same session stored on another branch before the boundary. Neither copies
 * receipts just because they exist, or reads past its captured watermark. */
export async function includeNamedForkOutputs(
	entries: SessionEntry[],
	store: SessionHistorySource,
	sessionId: string,
	leaf: string | null,
	epoch: string | undefined,
	through: number,
	scope: "branch" | "session",
	boundarySeq?: number,
): Promise<SessionEntry[]> {
	const boundary = getLatestCompactionBoundaryEntry(entries);
	if (!leaf || !boundary) return entries;
	const wanted = new Set<string>();
	const scan = (value: unknown): void => {
		if (typeof value === "string") {
			for (const hit of value.matchAll(/tool-output:\/\/([0-9a-f]{64})(?![0-9a-f])/gu)) wanted.add(hit[1]!);
		} else if (value && typeof value === "object") {
			for (const v of Object.values(value)) scan(v);
		}
	};
	for (const m of convertToLlm(
		buildSessionProjection(entries, entries.at(-1)?.id, undefined, sessionId, entries).messages,
	))
		scan(m.content);
	const hashOf = (entry: SessionEntry): string | undefined =>
		entry.type === "custom" && entry.customType === TOOL_OUTPUT_ENTRY_TYPE
			? (entry.data as { hash?: string } | undefined)?.hash
			: undefined;
	for (const entry of entries) {
		const hash = hashOf(entry);
		if (hash) wanted.delete(hash);
	}
	if (!wanted.size) return entries;
	const found: SessionEntry[] = [];
	let next: string | null = leaf;
	let beforeBoundary = scope === "session" && boundarySeq !== undefined;
	search: for await (const { items } of historyPages(store, sessionId, epoch, through, {
		direction: "backward",
		...(beforeBoundary && boundarySeq !== undefined ? { toSeq: boundarySeq - 1 } : {}),
	})) {
		for (let i = items.length - 1; i >= 0; i--) {
			const item = items[i]!;
			const links =
				"entry" in item
					? { id: item.entry.id, parentId: item.entry.parentId, hash: hashOf(item.entry) }
					: await (await import("./storage/session/chunked-resume-projection.js")).chunkedForkLink(() =>
							historyChunks(store, sessionId, epoch, item, {}),
						);
			const ancestor = links.id === next;
			if (ancestor && links.id === boundary.id) beforeBoundary = true;
			if (!ancestor && !(scope === "session" && beforeBoundary)) continue;
			if (links.hash && wanted.has(links.hash)) {
				const candidate =
					"entry" in item
						? item.entry
						: (await store.readRange!(sessionId, item.seq, item.seq, item.epoch)).entries[0];
				if (candidate && hashOf(candidate) === links.hash) {
					found.push(candidate);
					wanted.delete(links.hash);
				}
			}
			if (ancestor) next = links.parentId ?? null;
			if (!wanted.size || (!next && scope === "branch")) break search;
		}
	}
	// A named historical receipt is archived with its original links. It need not become part of the active branch.
	if (!found.length) return entries;
	const restored = new Set(found.map((entry) => entry.id));
	return [
		...found.reverse(),
		...entries.filter(
			(entry) => !(entry.type === "custom" && entry.customType === "atomic.fork-anchor" && restored.has(entry.id)),
		),
	];
}

/** A new child inherits request content, not the source's admission authority or its recoverable operations.
 * Model-visible content from a notice is still the same provider input, but is no longer a deliverable card. */
export function forkContextPath(path: SessionEntry[], sourceSessionId: string): SessionEntry[] {
	const leaf = path.at(-1);
	if (!leaf) return [];
	const current = buildContextEntries(path, leaf.id, undefined, path);
	const edits = collectContextEdits(current);
	const window = new Set(current.map((e) => e.id));
	const anchors = new Set<string>();
	const toolResults = new Set<string>();
	for (const entry of path) {
		if (!window.has(entry.id)) continue;
		if (entry.type === "custom" && entry.customType === TOOL_OUTPUT_ENTRY_TYPE && entry.parentId !== null)
			anchors.add(entry.parentId);
		if (entry.type === "compaction") {
			if (entry.firstKeptEntryId !== null) anchors.add(entry.firstKeptEntryId);
			if (entry.coveredThroughEntryId !== undefined) anchors.add(entry.coveredThroughEntryId);
		}
		if (entry.type === "message" && entry.message.role === "toolResult" && !edits.has(entry.id))
			toolResults.add(entry.message.toolCallId);
	}
	const before = path.filter((e) => !window.has(e.id));
	const model = before.findLast(
		(e) => e.type === "model_change" || (e.type === "message" && e.message.role === "assistant"),
	);
	const thinking = before.findLast((e) => e.type === "thinking_level_change");
	const retained: SessionEntry[] = [];
	for (const source of path) {
		let entry: SessionEntry | undefined = source;
		if (!window.has(source.id) && source.type === "message") {
			// A previous assistant can have selected the effective model even without a model change entry. Keep
			// the setting, never its covered answer or reasoning.
			entry =
				source === model && source.message.role === "assistant"
					? {
							type: "model_change",
							id: source.id,
							parentId: source.parentId,
							timestamp: source.timestamp,
							provider: source.message.provider,
							modelId: source.message.model,
						}
					: undefined;
		} else if (
			!window.has(source.id) &&
			(source.type === "model_change" || source.type === "thinking_level_change")
		) {
			if (source !== model && source !== thinking) entry = undefined;
		} else if (
			!window.has(source.id) &&
			(source.type === "compaction" ||
				source.type === "context_edit" ||
				source.type === "branch_summary" ||
				source.type === "session_summary" ||
				source.type === "usage")
		) {
			entry = undefined;
		} else if (source.type === "custom") {
			const ref =
				source.customType === TOOL_OUTPUT_ENTRY_TYPE &&
				(source.data as { toolCallId?: string } | undefined)?.toolCallId;
			if (
				!forkSettings.has(source.customType) &&
				!(source.customType === TOOL_OUTPUT_ENTRY_TYPE && (window.has(source.id) || (ref && toolResults.has(ref))))
			)
				entry = undefined;
		} else if (source.type === "custom_message") {
			if (!window.has(source.id) || source.excludeFromContext) entry = undefined;
			else if (
				source.protectedReconciliation ||
				source.stageAdmissionKey ||
				/^(intercom|subagent|workflow|task)[._:-]/.test(source.customType)
			) {
				entry = {
					type: "custom_message",
					id: source.id,
					parentId: source.parentId,
					timestamp: source.timestamp,
					customType: "atomic.inherited-context",
					content: source.content,
					display: false,
				};
			}
		}
		if (
			entry?.type === "compaction" &&
			entry.recallSessionId === undefined &&
			!(typeof entry.details === "object" && entry.details && "form" in entry.details)
		)
			entry = { ...entry, recallSessionId: sourceSessionId };
		if (entry?.type === "context_edit" && edits.get(entry.targetId)?.id !== entry.id) entry = undefined;
		const edit = edits.get(source.id);
		if (edit && entry?.type === "message") {
			// The edit stays on the copied branch, so an omission remains omitted; do not copy the inaccessible
			// bytes of its old target just to apply the same edit to them a second time.
			entry = { ...entry, message: applyContextEdit([entry.message], edit)[0] ?? { ...entry.message, content: [] } };
		} else if (edit && entry?.type === "custom_message")
			entry = { ...entry, content: (edit.replacement?.content ?? []) as typeof entry.content };
		if (!entry && anchors.has(source.id))
			entry = {
				type: "custom",
				customType: "atomic.fork-anchor",
				id: source.id,
				parentId: source.parentId,
				timestamp: source.timestamp,
			};
		if (!entry) continue;
		const parentId = retained.at(-1)?.id ?? null;
		if (entry.type === "custom" && entry.customType === TOOL_OUTPUT_ENTRY_TYPE) {
			// The receipt's parent can lie outside an already trimmed window. Preserve the receipt verbatim and
			// bridge that omitted parent, not the parent's lifecycle state, into this branch.
			if (entry.parentId !== null && entry.parentId !== parentId)
				retained.push({
					type: "custom",
					customType: "atomic.fork-anchor",
					id: entry.parentId,
					parentId,
					timestamp: entry.timestamp,
				});
			retained.push(entry);
		} else retained.push(entry.parentId === parentId ? entry : { ...entry, parentId });
	}
	return retained.length
		? retained
		: [{ type: "custom", customType: "atomic.fork-anchor", id: leaf.id, parentId: null, timestamp: leaf.timestamp }];
}
