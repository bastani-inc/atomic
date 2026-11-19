import { jsonlEntryProjection } from "./jsonl-entry-projection.js";
import {
	SESSION_HISTORY_CHUNK_BYTES,
	SESSION_HISTORY_PAGE_BYTES,
	SESSION_HISTORY_PAGE_ENTRIES,
	type SessionStoredEntry,
	yieldSessionTurn as yieldToEventLoop,
} from "./types.js";

/** A scan of a known session generation. Read whole entries only while a page fits the history budget. A single
 * oversized entry contributes only the fields its validation and the resume fold read; never decode its conversation
 * body. With `prefixToolCalls`, its tool calls are counted there, not in its skipped content. */
export async function* branchStatePages(
	lastSeq: number,
	source: {
		readonly bytes: (seq: number) => number;
		readonly read: (seqs: readonly number[]) => Promise<readonly SessionStoredEntry[]>;
		readonly chunk: (seq: number, offset: number, length: number) => Promise<Uint8Array>;
	},
	prefixToolCalls?: (count: number) => void,
): AsyncGenerator<readonly SessionStoredEntry[]> {
	for (let seq = 1; seq <= lastSeq; ) {
		const size = source.bytes(seq);
		if (size > SESSION_HISTORY_PAGE_BYTES) {
			const current = seq++;
			async function* chunks() {
				for (let offset = 0; offset < size; ) {
					const bytes = await source.chunk(current, offset, Math.min(size - offset, SESSION_HISTORY_CHUNK_BYTES));
					if (!bytes.length) throw new Error(`Incomplete historical entry ${current}`);
					offset += bytes.length;
					yield bytes;
					if (offset < size) await yieldToEventLoop();
				}
			}
			const projected = await jsonlEntryProjection(chunks());
			if (!projected) throw new SyntaxError(`Invalid historical entry ${current}`);
			prefixToolCalls?.(projected.toolCalls);
			yield [{ seq: current, entry: projected.entry }];
		} else {
			const seqs = [seq++];
			let total = size;
			while (
				seq <= lastSeq &&
				seqs.length < SESSION_HISTORY_PAGE_ENTRIES &&
				total + 1 + source.bytes(seq) <= SESSION_HISTORY_PAGE_BYTES
			) {
				total += 1 + source.bytes(seq);
				seqs.push(seq++);
			}
			yield await source.read(seqs);
		}
		if (seq <= lastSeq) await yieldToEventLoop();
	}
}
