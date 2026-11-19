import { getBranchPath } from "../../session-manager-history.ts";
import { foldSessionResume, sessionResumeOf, transcriptBranchSpan } from "./session-resume.js";
import { assertSnapshotCut, snapshotStamp } from "./snapshot-cut.js";
import type { SessionBranchPageCut, SessionRecordHeader, SessionStore, SessionWriteOptions } from "./types.js";
import { type AssistantAnswer, lastBranchAnswer } from "./window-answer.js";

export { assertSnapshotCut, snapshotChunk, snapshotHead, snapshotPage, snapshotStamp } from "./snapshot-cut.js";

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
export async function snapshotBranchSpan(store: SessionStore, id: string, cut: SessionBranchPageCut) {
	const snapshot = await store.load(id);
	assertSnapshotCut(snapshot, cut.epoch, cut.leaf);
	const index = foldSessionResume(undefined, snapshot.entries);
	return transcriptBranchSpan(id, { ...index, epoch: cut.epoch ?? snapshotStamp(snapshot) }, cut);
}
export async function snapshotOutline(store: SessionStore, id: string, from: number, to: number, epoch?: string) {
	const snapshot = await store.load(id);
	assertSnapshotCut(snapshot, epoch, to);
	const { treeOutlineEntry } = await import("./tree-outline.js");
	return snapshot.entries.slice(from - 1, to).map((entry, i) => treeOutlineEntry(from + i, entry));
}
export async function updateStoredHeader(
	store: SessionStore,
	header: SessionRecordHeader,
	options: SessionWriteOptions,
) {
	if (store.updateHeader) return store.updateHeader(header, options);
	const snapshot = await store.load(header.id);
	return store.replace(header.id, header, snapshot.entries, options);
}
