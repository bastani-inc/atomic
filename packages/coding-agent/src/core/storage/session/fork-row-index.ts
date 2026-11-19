import { foldSessionResume, foreignResumeIds, type SessionResumeIndex } from "./session-resume.js";
import type { SessionForkRow } from "./types.js";

/** A streamed human fork is linear. Only links the current row names need a lookup in the
 * destination's staged index; never retain an ID-to-body map to generate the persisted resume state. */
export async function foldForkRow(
	previous: SessionResumeIndex,
	row: SessionForkRow,
	lookup: (id: string) => Promise<number | undefined>,
): Promise<SessionResumeIndex> {
	const positions = new Map<string, number>();
	for (const id of foreignResumeIds(previous, [row.entry])) {
		const at = await lookup(id);
		if (at !== undefined) positions.set(id, at);
	}
	const next = foldSessionResume(previous, [row.entry], (id) => positions.get(id));
	return row.extraToolCalls
		? { ...next, totals: { ...next.totals, toolCalls: next.totals.toolCalls + row.extraToolCalls } }
		: next;
}

export function forkIdHash(id: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 0x01000193);
	return hash >>> 0;
}

/** Confirm a collision against stored bytes, not a javascript object containing the whole record. */
export async function findForkRow(
	id: string,
	hashes: readonly number[],
	chunks: (seq: number) => AsyncIterable<Uint8Array>,
): Promise<number | undefined> {
	const hash = forkIdHash(id);
	for (let i = hashes.length - 1; i >= 0; i--)
		if (hashes[i] === hash) {
			const { chunkedEntryHasId } = await import("./chunked-resume-projection.js");
			if (await chunkedEntryHasId(chunks(i + 1), id)) return i + 1;
		}
	return undefined;
}
