import type { CompactionEntry, SessionEntry } from "./session-manager-types.ts";

function anchor(entry: SessionEntry): boolean {
	return entry.type === "custom" && entry.customType === "atomic.fork-anchor";
}

type ReadBranch = () => AsyncIterable<SessionEntry>;

/** A v4 reader takes a missing coverage target to mean the entry immediately before the boundary. When a cut
 * precedes even the first visible turn, keep one payload-free predecessor. Only a branch starting with hidden
 * links needs this lookahead; the second iterator reads the same captured cut, not today's branch. */
async function leadingRoot(read: ReadBranch, leading: ReadonlyMap<string, string>): Promise<string | undefined> {
	let sawVisible = false;
	for await (const entry of read()) {
		if (anchor(entry)) continue;
		if (
			sawVisible &&
			entry.type === "compaction" &&
			entry.coveredThroughEntryId &&
			leading.has(entry.coveredThroughEntryId)
		)
			return entry.coveredThroughEntryId;
		sawVisible = true;
	}
	return undefined;
}

/** Project an archive a row at a time. Only hidden IDs and their visible neighbours are kept, never a
 * retired message, snapshot, or receipt. The writer chains the returned rows in their original order. */
export async function* forkTranscriptEntries(read: ReadBranch): AsyncGenerator<SessionEntry, void> {
	type Gap = { before: string | null; after?: string };
	const hidden = new Map<string, Gap>();
	let leading: Map<string, string> | undefined;
	let last: string | null = null,
		gap: Gap | undefined,
		root: string | undefined;
	for await (const entry of read()) {
		if (anchor(entry)) {
			gap ??= { before: last };
			hidden.set(entry.id, gap);
			if (last === null) {
				leading ??= new Map();
				leading.set(entry.id, entry.timestamp);
			}
			continue;
		}
		if (leading) {
			root = await leadingRoot(read, leading);
			if (root !== undefined)
				yield {
					type: "custom",
					customType: "atomic.fork-anchor",
					id: root,
					parentId: null,
					timestamp: leading.get(root)!,
				};
			leading = undefined;
		}
		let visible = entry;
		if (hidden.size && entry.type === "compaction") {
			const first = entry.firstKeptEntryId ? hidden.get(entry.firstKeptEntryId) : undefined;
			const covered = entry.coveredThroughEntryId ? hidden.get(entry.coveredThroughEntryId) : undefined;
			if (first || covered) {
				const projected: CompactionEntry = { ...entry };
				if (first) projected.firstKeptEntryId = first.after ?? null;
				if (covered) {
					const through = covered.before ?? root;
					if (through === undefined) delete projected.coveredThroughEntryId;
					else projected.coveredThroughEntryId = through;
				}
				visible = projected;
			}
		}
		if (gap) gap.after = entry.id;
		gap = undefined;
		hidden.delete(entry.id);
		last = entry.id;
		yield visible;
	}
}
