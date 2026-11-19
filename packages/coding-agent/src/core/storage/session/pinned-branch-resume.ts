import { hash } from "fast-sha256";
import { historyChunks, historyPages } from "./history-pages.js";
import type { SessionResumeIndex } from "./session-resume.js";
import { foldSessionResume, selectResumeLeaf, sessionResumeFrom, sessionResumePlan } from "./session-resume.js";
import type { SessionRecordHeader, SessionResume, SessionStore, SessionStoredEntry } from "./types.js";

/** A local branch operation on a stale manager still observes that manager's original watermark. A store with
 * pages but no historical index gets two metadata folds and reads only the resulting selected window. */
export async function pinnedBranchResume(
	store: SessionStore,
	header: SessionRecordHeader,
	epoch: string | undefined,
	through: number,
	leafId: string,
): Promise<SessionResume> {
	const sessionId = header.id;
	const positions = new Map<string, number>();
	const key = (id: string) => Buffer.from(hash(Buffer.from(id, "utf16le"))).toString("hex");
	let extraCalls = 0;
	async function* fields(firstPass: boolean) {
		for await (const { items } of historyPages(store, sessionId, epoch, through, {})) {
			const page: SessionStoredEntry[] = [];
			for (const item of items) {
				if ("entry" in item) page.push(item);
				else {
					const { chunkedPrefixFields, chunkedBranchState } = await import("./chunked-resume-projection.js");
					const chunks = () => historyChunks(store, sessionId, epoch, item, {});
					if (firstPass) {
						const { entry, toolCalls } = await chunkedPrefixFields(chunks);
						extraCalls += toolCalls;
						page.push({ seq: item.seq, entry });
					} else page.push({ seq: item.seq, entry: await chunkedBranchState(chunks) });
				}
			}
			yield page;
		}
	}
	let index: SessionResumeIndex = foldSessionResume(undefined, []);
	for await (const page of fields(true)) {
		index = foldSessionResume(
			index,
			page.map((x) => x.entry),
			(id) => positions.get(key(id)),
			() => true,
		);
		for (const { seq, entry } of page) positions.set(key(entry.id), seq);
	}
	const leaf = positions.get(key(leafId)) ?? 0;
	positions.clear();
	index = {
		...index,
		epoch: epoch ?? index.epoch,
		totals: { ...index.totals, toolCalls: index.totals.toolCalls + extraCalls },
	};
	const selected = await selectResumeLeaf(index, leaf, fields(false));
	const plan = sessionResumePlan(selected, selected.leafSeq, true);
	const branch: SessionStoredEntry[] = [],
		state: SessionStoredEntry[] = [];
	const stateSeqs = new Set(plan.state);
	// Never decode an oversized entry merely to decide whether it belongs in the selected window.
	for await (const { items } of historyPages(store, sessionId, epoch, through, {})) {
		for (const item of items) {
			const output = stateSeqs.has(item.seq)
				? state
				: plan.branch.some(([a, b]) => item.seq >= a && item.seq <= b)
					? branch
					: undefined;
			if (!output) continue;
			if ("entry" in item) output.push(item);
			else {
				const kept = await store.readRange!(sessionId, item.seq, item.seq, epoch);
				if (kept.entries.length !== 1 || (epoch !== undefined && kept.epoch !== epoch))
					throw new Error("The selected session entry changed during navigation");
				output.push({ seq: item.seq, entry: kept.entries[0]! });
			}
		}
	}
	return sessionResumeFrom(selected, header, branch, state, leaf > 0 ? leafId : null, plan.children);
}
