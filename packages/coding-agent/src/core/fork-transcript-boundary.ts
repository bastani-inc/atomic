import type { CompactionEntry, SessionEntry } from "./session-manager-types.ts";

function anchor(entry: SessionEntry): boolean {
	return entry.type === "custom" && entry.customType === "atomic.fork-anchor";
}

/** A v4 reader treats a missing covered-through target as the entry immediately preceding the
 * boundary. Usually a hidden link can be translated to a visible neighbour; a cut before the
 * very first visible turn needs one payload-free predecessor in the exported branch. No source
 * record, payload, sequence number or auxiliary array is copied by this projection. */
export function forkTranscriptBoundary(
	branch: readonly SessionEntry[],
): (entry: SessionEntry) => SessionEntry | undefined {
	let firstVisible = 0;
	while (firstVisible < branch.length && anchor(branch[firstVisible]!)) firstVisible++;
	let root: string | undefined;
	if (firstVisible > 0) {
		for (let i = firstVisible + 1; i < branch.length && root === undefined; i++) {
			const entry = branch[i]!;
			if (entry.type !== "compaction" || !entry.coveredThroughEntryId) continue;
			for (let j = 0; j < firstVisible; j++) {
				if (branch[j]!.id === entry.coveredThroughEntryId) {
					root = entry.coveredThroughEntryId;
					break;
				}
			}
		}
	}
	let index = 0,
		sawAnchor = false;
	return (entry) => {
		const current = index++;
		if (anchor(entry)) {
			sawAnchor = true;
			return entry.id === root
				? {
						type: "custom",
						customType: "atomic.fork-anchor",
						id: entry.id,
						parentId: null,
						timestamp: entry.timestamp,
					}
				: undefined;
		}
		if (!sawAnchor || entry.type !== "compaction") return entry;
		const neighbour = (id: string | undefined | null, direction: 1 | -1) => {
			if (id == null) return id;
			let found = current - 1;
			while (found >= 0 && branch[found]!.id !== id) found--;
			if (found < 0 || !anchor(branch[found]!)) return id;
			while (found >= 0 && found < current && anchor(branch[found]!)) found += direction;
			return found >= 0 && found < current ? branch[found]!.id : direction === 1 ? null : root;
		};
		const firstKeptEntryId = neighbour(entry.firstKeptEntryId, 1) ?? null;
		const coveredThroughEntryId = neighbour(entry.coveredThroughEntryId, -1) ?? undefined;
		if (firstKeptEntryId === entry.firstKeptEntryId && coveredThroughEntryId === entry.coveredThroughEntryId)
			return entry;
		const projected: CompactionEntry = { ...entry, firstKeptEntryId };
		if (coveredThroughEntryId === undefined) delete projected.coveredThroughEntryId;
		else projected.coveredThroughEntryId = coveredThroughEntryId;
		return projected;
	};
}
