import { convertToLlm } from "./messages.ts";
import {
	applyContextEdit,
	buildContextEntries,
	buildSessionProjection,
	collectContextEdits,
	getLatestCompactionBoundaryEntry,
} from "./session-manager-history.ts";
import type { SessionEntry } from "./session-manager-types.ts";
import { TOOL_OUTPUT_ENTRY_TYPE } from "./session-tool-output.ts";
import { SessionConflictError } from "./storage/session/errors.js";
import { historyChunks, historyPages, type SessionHistorySource } from "./storage/session/history-pages.js";
import { isExtensionCustomState } from "./storage/session/session-resume.js";
import type { OversizedSessionEntry } from "./storage/session/types.js";
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
	archives?: Map<string, OversizedSessionEntry>,
): Promise<SessionEntry[]> {
	if (!leaf || (scope === "branch" && !getLatestCompactionBoundaryEntry(entries))) return entries;
	const wanted = new Set<string>();
	const scan = (value: unknown): void => {
		if (typeof value === "string") {
			for (const hit of value.matchAll(/tool-output:\/\/([0-9a-f]{64})(?=$|[\s'"`()[\]{}<>,.:;!?])/gu))
				wanted.add(hit[1]!);
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
	const ancestors = new Set<string>();
	const positions = new Map(entries.map((entry) => [entry.id, 0]));
	let next: string | null = leaf;
	search: for await (const { items } of historyPages(store, sessionId, epoch, through, { direction: "backward" })) {
		for (let i = items.length - 1; i >= 0; i--) {
			const item = items[i]!;
			const links =
				"entry" in item
					? { id: item.entry.id, parentId: item.entry.parentId, hash: hashOf(item.entry) }
					: await (await import("./storage/session/chunked-resume-projection.js")).chunkedForkLink(() =>
							historyChunks(store, sessionId, epoch, item, {}),
						);
			if (links.id !== undefined && positions.has(links.id)) positions.set(links.id, item.seq);
			const ancestor = links.id === next;
			if (!ancestor && scope === "branch") continue;
			if (links.hash && wanted.has(links.hash)) {
				let candidate: SessionEntry | undefined;
				if ("entry" in item && archives) {
					const size = await store.readEntrySizes!(sessionId, item.seq, item.seq);
					if (
						(epoch !== undefined && size.epoch !== epoch) ||
						size.sizes[0]?.seq !== item.seq ||
						size.lastSeq < through
					)
						throw new SessionConflictError(sessionId, through, size.lastSeq);
					const { id, parentId, timestamp } = item.entry;
					archives.set(id, {
						kind: "oversized",
						sessionId,
						epoch: size.epoch,
						seq: item.seq,
						bytes: size.sizes[0].bytes,
					});
					candidate = {
						type: "custom",
						customType: TOOL_OUTPUT_ENTRY_TYPE,
						id,
						parentId,
						timestamp,
						data: { hash: links.hash },
					};
				} else if ("entry" in item) candidate = item.entry;
				else if (
					archives &&
					links.id !== undefined &&
					"timestamp" in links &&
					typeof links.timestamp === "string"
				) {
					archives.set(links.id, item);
					candidate = {
						type: "custom",
						customType: TOOL_OUTPUT_ENTRY_TYPE,
						id: links.id,
						parentId: links.parentId ?? null,
						timestamp: links.timestamp,
						data: { hash: links.hash },
					};
				} else {
					const range = await store.readRange!(sessionId, item.seq, item.seq, item.epoch);
					if (
						range.epoch !== item.epoch ||
						range.startSeq !== item.seq ||
						range.lastSeq < through ||
						range.entries.length !== 1 ||
						range.entries[0]!.id !== links.id
					)
						throw new SessionConflictError(sessionId, through, range.lastSeq);
					candidate = range.entries[0];
				}
				if (candidate && hashOf(candidate) === links.hash) {
					positions.set(candidate.id, item.seq);
					if (ancestor) ancestors.add(candidate.id);
					found.push(candidate);
					wanted.delete(links.hash);
				}
			}
			if (ancestor) next = links.parentId ?? null;
			if (!wanted.size || (!next && scope === "branch")) break search;
		}
	}
	if (!found.length) return entries;
	// Receipts that don't anchor the active branch are independent archive entries. If a boundary
	// names a receipt, replacing its anchor at the front of the file would sever earlier settings.
	const archived = new Map(found.reverse().map((entry) => [entry.id, entry]));
	const branch: SessionEntry[] = [];
	for (const entry of entries) {
		const receipt = entry.type === "custom" && entry.customType === "atomic.fork-anchor" && archived.get(entry.id);
		if (!receipt) {
			branch.push(entry);
			continue;
		}
		archived.delete(entry.id);
		if (receipt.parentId !== null && receipt.parentId !== entry.parentId)
			branch.push({ ...entry, id: receipt.parentId });
		branch.push(receipt);
	}
	// Keep detached receipts after their retained source parents: an indexed historical open at
	// the receipt can only follow parents that have already been written. The active leaf stays last.
	const detached = [...archived.values()];
	if (!detached.length) return branch;
	const ordered: SessionEntry[] = [];
	const available = new Set([...branch, ...detached].map((e) => e.id));
	let i = 0,
		prior: string | null = null;
	for (const entry of branch) {
		const position = entry === branch.at(-1) ? Infinity : (positions.get(entry.id) ?? 0);
		while (i < detached.length && positions.get(detached[i]!.id)! < position) {
			const receipt = detached[i++]!;
			// An archived ancestor may itself point to a retired turn. Keep the link, not its
			// payload: otherwise a resume at this receipt (or an active descendant) loses its settings.
			if (ancestors.has(receipt.id)) {
				if (receipt.parentId !== null && !available.has(receipt.parentId)) {
					ordered.push({
						type: "custom",
						customType: "atomic.fork-anchor",
						id: receipt.parentId,
						parentId: prior,
						timestamp: receipt.timestamp,
					});
					available.add(receipt.parentId);
				}
				prior = receipt.id;
			}
			ordered.push(receipt);
		}
		ordered.push(entry);
		prior = entry.id;
	}
	return ordered;
}

/** A new child inherits request content, not the source's admission authority or its recoverable operations.
 * Model-visible content from a notice is still the same provider input, but is no longer a deliverable card. */
export function forkContextPath(
	path: SessionEntry[],
	sourceSessionId: string,
	displayEvidence?: ReadonlySet<string>,
): SessionEntry[] {
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
	const summary = path.findLast((e) => e.type === "session_summary" || e.type === "branch_summary");
	const retained: SessionEntry[] = [];
	for (const source of path) {
		let entry: SessionEntry | undefined = source;
		if (source.type === "message" && source.message.role === "bashExecution" && source.message.excludeFromContext) {
			entry = undefined;
		} else if (
			!window.has(source.id) &&
			source.type === "message" &&
			!(source.message.role === "system" && (source.message.toolsAdded || source.message.toolsRemoved))
		) {
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
				(source.type === "session_summary" && source !== summary) ||
				source.type === "usage")
		) {
			entry = undefined;
		} else if (source.type === "custom") {
			const ref =
				source.customType === TOOL_OUTPUT_ENTRY_TYPE &&
				(source.data as { toolCallId?: string } | undefined)?.toolCallId;
			if (
				!forkSettings.has(source.customType) &&
				!isExtensionCustomState(source.customType) &&
				!displayEvidence?.has(source.id) &&
				!(source.customType === TOOL_OUTPUT_ENTRY_TYPE && (window.has(source.id) || (ref && toolResults.has(ref))))
			)
				entry = undefined;
		} else if (source.type === "custom_message") {
			if (!window.has(source.id) || source.excludeFromContext) entry = undefined;
			else if (
				source.customType === "task-completion" &&
				source.display &&
				source.stageAdmissionKey &&
				source.details &&
				typeof source.details === "object" &&
				"notification" in source.details
			) {
				// A stored completion can display its existing outcome without granting this child the
				// parent's admission key. Its already acknowledged display witness is not an outstanding task.
				const { stageAdmissionKey, protectedReconciliation: _protected, ...view } = source;
				entry = { ...view, details: { completionId: stageAdmissionKey, ...source.details } };
			} else if (source.protectedReconciliation || source.stageAdmissionKey) {
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
