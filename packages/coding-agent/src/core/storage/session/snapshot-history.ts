import { createHash } from "node:crypto";
import { getBranchPath } from "../../session-manager-history.ts";
import { SessionConflictError } from "./errors.js";
import { foldSessionResume, sessionResumeOf, transcriptBranchSpan } from "./session-resume.js";
import {
	type OversizedSessionEntry,
	SESSION_HISTORY_CHUNK_BYTES,
	SESSION_HISTORY_PAGE_BYTES,
	SESSION_HISTORY_PAGE_ENTRIES,
	type SessionBranchPageCut,
	type SessionHistoryItem,
	type SessionSnapshot,
	type SessionStore,
} from "./types.js";
import { type AssistantAnswer, lastBranchAnswer } from "./window-answer.js";

/** A snapshot-only adapter need not version replacements. Pin its complete observed prefix instead;
 * this stamp is for reads only and must never be passed to the adapter as its write epoch. */
export function snapshotStamp(snapshot: SessionSnapshot, through = snapshot.lastSeq): string {
	if (snapshot.epoch !== undefined) return snapshot.epoch;
	const hash = createHash("sha256").update(JSON.stringify(snapshot.header));
	for (let i = 0; i < through; i++) hash.update("\n").update(JSON.stringify(snapshot.entries[i]));
	return `snapshot/${through}/${hash.digest("base64url")}`;
}

export function assertSnapshotCut(snapshot: SessionSnapshot, expected: string | undefined, through: number): void {
	const count =
		expected !== undefined && snapshot.epoch === undefined
			? Number(/^snapshot\/(\d+)\//.exec(expected)?.[1])
			: through;
	if (
		snapshot.lastSeq < through ||
		(expected !== undefined &&
			(!Number.isSafeInteger(count) || count > snapshot.lastSeq || snapshotStamp(snapshot, count) !== expected))
	)
		throw new SessionConflictError(snapshot.header.id, through, snapshot.lastSeq);
}

export async function snapshotWindow(
	store: SessionStore,
	sessionId: string,
	leaf?: string,
	through?: number,
	expected?: string,
) {
	const snapshot = await store.load(sessionId);
	const cut = through ?? snapshot.lastSeq;
	assertSnapshotCut(snapshot, expected, cut);
	const entries = cut === snapshot.entries.length ? snapshot.entries : snapshot.entries.slice(0, cut);
	const resume = sessionResumeOf(snapshot.header, entries, leaf);
	let priorAnswer: AssistantAnswer | undefined;
	if (resume.compaction && resume.leafId) {
		const resident = new Set(resume.branch.map(({ entry }) => entry.id));
		const branch = getBranchPath(resume.leafId, new Map(entries.map((entry) => [entry.id, entry])));
		priorAnswer = lastBranchAnswer(branch, (entry) => !resident.has(entry.id));
	}
	return {
		...resume,
		epoch: snapshotStamp(snapshot, cut),
		...(snapshot.epoch === undefined ? { archiveOnlyEpoch: true as const } : {}),
		priorAnswer,
	};
}

export async function snapshotPage(
	store: SessionStore,
	id: string,
	from: number,
	to: number,
	reverse: boolean,
	through: number,
	expected?: string,
) {
	const snapshot = await store.load(id);
	assertSnapshotCut(snapshot, expected, through);
	const epoch = snapshotStamp(snapshot, through);
	const items: SessionHistoryItem[] = [];
	let total = 0;
	for (
		let seq = reverse ? to : from;
		seq >= from && seq <= to && items.length < SESSION_HISTORY_PAGE_ENTRIES;
		seq += reverse ? -1 : 1
	) {
		const entry = snapshot.entries[seq - 1]!;
		const bytes = Buffer.byteLength(JSON.stringify(entry));
		if (bytes > SESSION_HISTORY_PAGE_BYTES && !items.length) {
			items.push({ kind: "oversized", sessionId: id, seq, epoch, bytes });
			break;
		}
		if (total + bytes > SESSION_HISTORY_PAGE_BYTES) break;
		total += bytes;
		items.push({ seq, entry });
	}
	if (reverse) items.reverse();
	return { epoch, items };
}

export async function snapshotChunk(store: SessionStore, ref: OversizedSessionEntry, offset: number) {
	const snapshot = await store.load(ref.sessionId);
	assertSnapshotCut(snapshot, ref.epoch, ref.seq);
	const bytes = Buffer.from(JSON.stringify(snapshot.entries[ref.seq - 1]));
	if (bytes.length !== ref.bytes) throw new SessionConflictError(ref.sessionId, ref.seq, snapshot.lastSeq);
	// Never let a chunk's backing buffer retain the remainder of an oversized entry.
	return Uint8Array.from(bytes.subarray(offset, offset + SESSION_HISTORY_CHUNK_BYTES));
}

export async function snapshotBranchSpan(store: SessionStore, id: string, cut: SessionBranchPageCut) {
	const snapshot = await store.load(id);
	assertSnapshotCut(snapshot, cut.epoch, cut.leaf);
	const index = foldSessionResume(undefined, snapshot.entries);
	return transcriptBranchSpan(id, { ...index, epoch: cut.epoch ?? snapshotStamp(snapshot) }, cut);
}

export async function snapshotHead(store: SessionStore, id: string) {
	const snapshot = await store.load(id);
	return { header: snapshot.header, epoch: snapshotStamp(snapshot), lastSeq: snapshot.lastSeq };
}
