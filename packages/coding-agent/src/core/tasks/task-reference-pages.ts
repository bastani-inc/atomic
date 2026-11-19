import type { SessionEntry } from "../session-manager-types.ts";
import { SessionConflictError } from "../storage/session/errors.js";
import { earlierTranscriptCursor, historyChunks } from "../storage/session/history-pages.js";
import type { ReferenceCut } from "../storage/session/history-snapshot.js";
import {
	SESSION_HISTORY_PAGE_BYTES as BUDGET,
	SESSION_HISTORY_PAGE_ENTRIES as PACKET,
} from "../storage/session/types.js";
import type { Failure, Result } from "./contracts.js";
import type { TaskTranscriptSource } from "./supervisor.js";
import { streamedEarlierMatches, streamedTaskReferences, type WantedReference } from "./task-reference-stream.js";
import {
	TASK_TRANSCRIPT_PAGE_ITEMS as LIMIT,
	type TaskTranscriptItem,
	type TaskTranscriptPage,
	type TranscriptError,
	taskEntryReferences,
} from "./transcript.js";

export interface RawRow {
	seq: number;
	entry?: SessionEntry;
	bytes?: number;
	chunks?: () => AsyncIterable<Uint8Array>;
}
export interface RawTaskPage {
	latest?: boolean;
	current?: string;
	rows: RawRow[];
	cut?: ReferenceCut;
}
export type RawTaskReader = (at?: string, metadataOnly?: boolean) => AsyncIterable<RawTaskPage>;
type RawResult = Result<TaskTranscriptPage, Failure<TranscriptError>>;
interface Candidate {
	item: TaskTranscriptItem;
	seq: number;
	at?: string;
}
function suffix(id: string): { chars: number; index: number; root: string } | undefined {
	const colon = id.lastIndexOf(":");
	if (colon < 0) return undefined;
	const digits = id.slice(colon + 1);
	if (!/^(?:0|[1-9]\d{0,15})$/.test(digits)) return undefined;
	const index = Number(digits);
	return Number.isSafeInteger(index) ? { chars: digits.length + 1, index, root: id.slice(0, colon) } : undefined;
}
function rootsOf(batch: readonly Candidate[]): Map<string, WantedReference[]> {
	const roots = new Map<string, WantedReference[]>();
	const add = (root: string, w: WantedReference) => {
		const a = roots.get(root);
		if (a) a.push(w);
		else roots.set(root, [w]);
	};
	for (const { item, seq } of batch) {
		add(item.id, { key: item.id, seq });
		const part = suffix(item.id);
		if (part) add(part.root, { key: item.id, seq, index: part.index });
	}
	return roots;
}
function visible(entry: SessionEntry, index?: number): boolean {
	if (index !== undefined) {
		if (entry.type !== "message" || entry.message.role !== "assistant") return false;
		const t = entry.message.content[index]?.type;
		return t === "toolCall" || t === "text" || t === "thinking";
	}
	if (entry.type === "message" && entry.message.role === "assistant")
		return (
			["error", "length", "aborted"].includes(entry.message.stopReason) &&
			!entry.message.content.some((b) => b.type === "toolCall" || b.type === "text" || b.type === "thinking")
		);
	return !taskEntryReferences(entry, "", false).next().done;
}
async function* metadata(cut: ReferenceCut, batch: readonly Candidate[], max: number): AsyncGenerator<RawRow, void> {
	const { store, sessionId, epoch, through } = cut;
	const rows = async function* (from: number, to: number, selected?: Set<number>) {
		const head = await store.readEntrySizes!(sessionId, from, to);
		if (head.epoch !== epoch || head.lastSeq < through)
			throw new SessionConflictError(sessionId, through, head.lastSeq);
		for (const size of head.sizes) {
			if (selected && !selected.has(size.seq)) continue;
			const ref = { kind: "oversized" as const, seq: size.seq, bytes: size.bytes, sessionId, epoch };
			yield { ...size, chunks: () => historyChunks(store, sessionId, epoch, ref, {}) };
		}
	};
	const find = store.findTaskReferenceDuplicateCandidates;
	if (find && batch.every((c) => c.seq <= through)) {
		const candidates = batch.map(({ seq, item }) => ({
			seq,
			...(item.source.contentIndex === undefined
				? { suffixChars: suffix(item.id)?.chars }
				: { contentIndex: item.source.contentIndex }),
		}));
		let afterSeq: number | undefined;
		for (;;) {
			const page = await find.call(store, sessionId, {
				epoch,
				throughSeq: through,
				candidates,
				afterSeq,
				limit: PACKET,
			});
			if (!page) break;
			for (let i = 0; i < page.seqs.length; ) {
				const start = page.seqs[i]!,
					markers = new Set<number>();
				while (i < page.seqs.length && page.seqs[i]! < start + PACKET) markers.add(page.seqs[i++]!);
				yield* rows(start, page.seqs[i - 1]!, markers);
			}
			if (page.nextAfterSeq === undefined) return;
			afterSeq = page.nextAfterSeq;
		}
	}
	for (let first = 1; first < max && first <= through; first += PACKET)
		yield* rows(first, Math.min(first + PACKET - 1, max - 1, through));
}
/** An SDK reference page keeps the first visible occurrence of an item ID, not the last stored row with the
 * same ID. Only the candidate window's keys are compared; unrequested historical names are never retained. */
async function shadows(
	reader: RawTaskReader,
	cut: ReferenceCut | undefined,
	batch: Candidate[],
): Promise<Set<Candidate>> {
	const skipped = new Set<Candidate>();
	if (!batch.length) return skipped;
	const max = Math.max(...batch.map((c) => c.seq));
	if (max <= 1) return skipped;
	const roots = rootsOf(batch),
		first = new Map<string, number>();
	const visit = async (row: RawRow) => {
		if (row.seq >= max) return;
		if (row.entry) {
			for (const w of roots.get(row.entry.id) ?? [])
				if (row.seq < w.seq && (first.get(w.key) ?? Infinity) > row.seq && visible(row.entry, w.index))
					first.set(w.key, row.seq);
		} else if (row.chunks) {
			for (const key of await streamedEarlierMatches(row.chunks, roots, row.seq))
				first.set(key, Math.min(row.seq, first.get(key) ?? Infinity));
		}
	};
	if (cut?.store.readEntrySizes && cut.store.readEntryChunk && batch.every((c) => c.seq <= cut.through))
		for await (const row of metadata(cut, batch, max)) await visit(row);
	else for await (const page of reader(batch[0]?.at, true)) for (const row of page.rows) await visit(row);
	for (const candidate of batch)
		if ((first.get(candidate.item.id) ?? Infinity) < candidate.seq) skipped.add(candidate);
	return skipped;
}
/** Locate the first occurrence named by a legacy cursor; a missing name restarts at latest, as on main. */
async function locate(reader: RawTaskReader, key: string): Promise<{ at?: string; seq: number } | undefined> {
	const probe = { seq: Infinity, item: { id: key, kind: "prompt" as const, source: { sessionId: "", entryId: key } } };
	const roots = rootsOf([probe]);
	const matches = async (row: RawRow) =>
		row.entry
			? (roots.get(row.entry.id) ?? []).some((w) => visible(row.entry!, w.index))
			: row.chunks && (await streamedEarlierMatches(row.chunks, roots, row.seq)).includes(key);
	let first: { at?: string; seq: number } | undefined,
		firstPacket = true;
	for await (const page of reader(undefined, true)) {
		const cut = page.cut;
		if (
			firstPacket &&
			cut?.store.findTaskReferenceDuplicateCandidates &&
			cut.store.findEntrySeq &&
			cut.store.readEntryChunk &&
			Buffer.byteLength(key) <= 64 * 1024 &&
			(await cut.store.findTaskReferenceDuplicateCandidates(cut.sessionId, {
				epoch: cut.epoch,
				throughSeq: cut.through,
				candidates: [],
			})) !== undefined
		) {
			// Use the entry index for both legal roots of a colon-suffixed public item. Never bind a giant caller ID.
			const hits: Candidate[] = [];
			let complete = true;
			for (const [root, refs] of roots) {
				const seq = await cut.store.findEntrySeq(cut.sessionId, root);
				if (seq === undefined) continue;
				if (seq > cut.through) {
					complete = false;
					break;
				}
				const ref = refs[0]!;
				hits.push({
					seq,
					item: {
						id: key,
						kind: "prompt",
						source: {
							sessionId: cut.sessionId,
							entryId: root,
							...(ref.index !== undefined ? { contentIndex: ref.index } : {}),
						},
					},
				});
			}
			if (complete) {
				for (const candidate of hits) {
					const head = await cut.store.readEntrySizes!(cut.sessionId, candidate.seq, candidate.seq);
					if (head.epoch !== cut.epoch || head.lastSeq < cut.through)
						throw new SessionConflictError(cut.sessionId, cut.through, head.lastSeq);
					const size = head.sizes[0];
					if (!size) continue;
					const row = {
						...size,
						chunks: () =>
							historyChunks(
								cut.store,
								cut.sessionId,
								cut.epoch,
								{ ...size, kind: "oversized" as const, sessionId: cut.sessionId, epoch: cut.epoch },
								{},
							),
					};
					if ((await matches(row)) && (!first || candidate.seq < first.seq))
						first = { seq: candidate.seq, at: earlierTranscriptCursor(cut.sessionId, cut.epoch, candidate.seq) };
				}
				if (hits.length)
					for await (const row of metadata(cut, hits, Math.max(...hits.map((x) => x.seq))))
						if ((!first || row.seq < first.seq) && (await matches(row)))
							first = { seq: row.seq, at: earlierTranscriptCursor(cut.sessionId, cut.epoch, row.seq) };
				return first;
			}
		}
		firstPacket = false;
		for (const row of page.rows)
			if ((!first || row.seq < first.seq) && (await matches(row))) first = { seq: row.seq, at: page.current };
	}
	return first;
}
function detached(item: TaskTranscriptItem): TaskTranscriptItem {
	const copy = (id: string) => {
		const encoding = id.isWellFormed() ? "utf8" : "utf16le";
		return Buffer.from(id, encoding).toString(encoding);
	};
	const entryId = copy(item.source.entryId),
		part = item.source.contentIndex;
	return {
		...item,
		id: part === undefined ? entryId : `${entryId}:${part}`,
		source: { ...item.source, entryId },
		...(typeof item.toolCallId === "string" ? { toolCallId: copy(item.toolCallId) } : {}),
	};
}
const weight = (item: TaskTranscriptItem) => Buffer.byteLength(item.id) + Buffer.byteLength(item.toolCallId ?? "");
/** The continuation remains the legacy task/session/item tuple. Nothing is retained between calls. */
export async function savedTaskReferences(
	session: TaskTranscriptSource,
	taskId: string,
	cursor: string | undefined,
	reader: RawTaskReader,
): Promise<RawResult> {
	const sessionId = session.getSessionId(),
		scope = `${taskId}\n${sessionId}\n`;
	let before: string | undefined;
	if (cursor !== undefined) {
		const token = Buffer.from(cursor, "base64url").toString("utf8");
		if (!token.startsWith(scope))
			return {
				ok: false,
				error: { code: "ScopeMismatch", message: "Transcript cursor belongs to another task or session" },
			};
		before = token.slice(scope.length);
	}
	const mark = before === undefined ? undefined : await locate(reader, before);
	let seek = mark ? before : undefined;
	const out: TaskTranscriptItem[] = [],
		batch: Candidate[] = [];
	let more = false,
		budget = BUDGET,
		bytes = 0,
		cut: ReferenceCut | undefined;
	const flush = async () => {
		const skip = await shadows(reader, cut, batch);
		for (const candidate of batch) {
			if (skip.has(candidate)) continue;
			out.push(candidate.item);
			budget -= weight(candidate.item);
		}
		batch.length = 0;
		bytes = 0;
	};
	const push = async (item: TaskTranscriptItem, row: RawRow, page: RawTaskPage) => {
		if (seek !== undefined) {
			if (item.id === seek) seek = undefined;
			return true;
		}
		const n = weight(item);
		if (batch.length && (out.length + batch.length >= LIMIT || bytes + n > budget)) await flush();
		if (out.length === LIMIT || (out.length && n > budget)) {
			more = true;
			return false;
		}
		batch.push({ item: detached(item), seq: row.seq, at: page.current });
		bytes += n;
		return true;
	};
	outer: for await (const page of reader(mark?.at)) {
		cut ??= page.cut;
		for (let i = page.rows.length - 1; i >= 0; i--) {
			const row = page.rows[i]!;
			if (seek !== undefined && mark && row.seq > mark.seq) continue;
			if (row.entry) {
				const e = row.entry;
				if (seek !== undefined && seek !== e.id && !(seek.startsWith(e.id) && seek.charAt(e.id.length) === ":"))
					continue;
				for (const item of taskEntryReferences(e, sessionId, true)) if (!(await push(item, row, page))) break outer;
			} else if (row.chunks) {
				if (batch.length) await flush();
				let within = seek;
				for (;;) {
					const run = await streamedTaskReferences(
						row.chunks,
						sessionId,
						LIMIT - out.length,
						budget,
						!out.length,
						within,
					);
					if (seek !== undefined) {
						if (!run.matched) break;
						seek = undefined;
					}
					if (!run.items.length) {
						if (run.more) {
							more = true;
							break outer;
						}
						break;
					}
					for (const item of run.items) if (!(await push(item, row, page))) break outer;
					if (!run.more) break;
					within = run.items.at(-1)!.id;
					await flush();
					if (out.length === LIMIT || budget <= 0) {
						more = true;
						break outer;
					}
				}
			} else throw new TypeError("The task history source must implement readHistoryChunks for oversized entries");
		}
	}
	if (batch.length) await flush();
	if (!out.length && !mark)
		return { ok: false, error: { code: "TranscriptUnavailable", message: "Transcript unavailable" } };
	out.reverse();
	const value: TaskTranscriptPage = { items: out, omittedEarlier: more };
	if (more && out[0]) value.nextCursor = Buffer.from(`${scope}${out[0].id}`).toString("base64url");
	return { ok: true, value };
}
