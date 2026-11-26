import type { SessionEntry } from "../../session-manager-types.ts";

/**
 * Where an entry a store read came from (#6560): the session, the seq and the generation it was read in, and a digest
 * of its JSON as read. A fork of that session in the same store shares the rows of the entries it carries unchanged
 * instead of storing a copy: an entry is unchanged when it is the very object the read returned and its JSON still has
 * the digest it was read with, so an edit in place shows too. The fork checks, inside its own transaction, that the
 * session is still in that generation, in which a stored row never changes, so it reads no entry back.
 */
interface StoredAt {
	readonly sessionId: string;
	readonly seq: number;
	readonly epoch: string;
	readonly length: number;
	readonly digest: number;
}

const stored = new WeakMap<object, StoredAt>();

/** A 53-bit digest of `text`: not to keep anyone from forging a match, only to notice an entry changed in place. */
function digestOf(text: string): number {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		h1 = Math.imul(h1 ^ code, 2654435761);
		h2 = Math.imul(h2 ^ code, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Records that `entry`, parsed from `json`, is session `sessionId`'s row at seq `seq` in generation `epoch`. */
export function noteStoredEntry(
	entry: SessionEntry,
	sessionId: string,
	seq: number,
	epoch: string,
	json: string,
): void {
	stored.set(entry, { sessionId, seq, epoch, length: json.length, digest: digestOf(json) });
}

/**
 * The seq at which session `sessionId` stores `entry` unchanged in generation `epoch`, or undefined when the entry was
 * not read from it in that generation, or changed since.
 */
export function storedSeqOf(entry: SessionEntry, sessionId: string, epoch: string | undefined): number | undefined {
	const at = stored.get(entry);
	if (at === undefined || epoch === undefined || at.sessionId !== sessionId || at.epoch !== epoch) return undefined;
	const json = JSON.stringify(entry);
	return json.length === at.length && digestOf(json) === at.digest ? at.seq : undefined;
}

/** Gives `copy`, a copy of `entry` with the same JSON, the place `entry` was read from. */
export function copyStoredEntry(entry: SessionEntry, copy: SessionEntry): void {
	const at = stored.get(entry);
	if (at !== undefined) stored.set(copy, at);
}

/** Whether some entry of `entries` was read from session `sessionId`. */
export function readFromSession(entries: readonly SessionEntry[], sessionId: string): boolean {
	return entries.some((entry) => stored.get(entry)?.sessionId === sessionId);
}
