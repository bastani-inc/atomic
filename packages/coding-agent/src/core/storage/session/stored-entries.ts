import type { SessionEntry } from "../../session-manager-types.ts";

/**
 * Where an entry a store read or wrote came from (#6560): the session, the seq and the generation it was read in, and
 * its JSON as stored, kept as the length and a fingerprint of it. A fork of that session in the same store shares the
 * rows of the entries it carries unchanged instead of storing a copy: an entry is unchanged when it is the very object
 * the store returned and its JSON is still the stored one, so an edit in place shows too. The fork checks, inside its
 * own transaction, that the session is still in that generation, in which a stored row never changes, so it reads no
 * entry back.
 *
 * A read pays only for the note itself. The JSON string the driver returned is kept until the fingerprint is taken, a
 * few at a time once the read is done, so neither the read waits for it nor a second copy of every resident entry
 * stays in memory. A fork that asks before then compares the string itself.
 */
interface StoredAt {
	readonly sessionId: string;
	readonly seq: number;
	readonly epoch: string;
	readonly length: number;
	/** The stored JSON, until its fingerprint is taken. */
	json: string | undefined;
	/** How much of `json` the fingerprint covers so far, and the fingerprint up to there. */
	taken: number;
	fingerprint: number;
}

const stored = new WeakMap<object, StoredAt>();

/** Notes whose fingerprint is still to take. */
const unprinted: StoredAt[] = [];

/** The most time one turn spends taking fingerprints, so the event loop moves on between them. */
const FINGERPRINT_SLICE_MS = 2;

/** Characters fingerprinted between looks at the clock: a long entry's fingerprint is taken over several turns. */
const FINGERPRINT_STRIDE = 16_384;
const FNV_OFFSET = 0x811c9dc5;

/**
 * Continues a 32-bit FNV-1a fingerprint `hash` of `text` from `from` through `until`: not to keep anyone from forging a
 * match, only to notice an entry changed in place. Each step is a bijection of the state, so an edit of one character
 * always changes it; with the length, a larger edit goes unnoticed about once in 2^32.
 */
function fingerprintRange(text: string, hash: number, from: number, until: number): number {
	for (let index = from; index < until; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
	return hash;
}

/**
 * Takes the fingerprints of the notes waiting for one, a slice at a time, each in a turn of its own. A long entry's is
 * taken a stride at a time, carried over from turn to turn, so no turn holds the event loop for a whole entry.
 */
function takeFingerprints(): void {
	const until = performance.now() + FINGERPRINT_SLICE_MS;
	do {
		const at = unprinted.at(-1)!;
		const json = at.json!;
		const end = Math.min(json.length, at.taken + FINGERPRINT_STRIDE);
		at.fingerprint = fingerprintRange(json, at.fingerprint, at.taken, end);
		at.taken = end;
		if (end === json.length) {
			at.json = undefined;
			unprinted.pop();
		}
	} while (unprinted.length > 0 && performance.now() < until);
	if (unprinted.length > 0) setImmediate(takeFingerprints);
}

/** Records that `entry`, parsed from `json`, is session `sessionId`'s row at seq `seq` in generation `epoch`. */
export function noteStoredEntry(
	entry: SessionEntry,
	sessionId: string,
	seq: number,
	epoch: string,
	json: string,
): void {
	const at: StoredAt = { sessionId, seq, epoch, length: json.length, json, taken: 0, fingerprint: FNV_OFFSET };
	stored.set(entry, at);
	if (unprinted.push(at) === 1) setImmediate(takeFingerprints);
}

/**
 * The seq at which session `sessionId` stores `entry` unchanged in generation `epoch`, or undefined when the entry was
 * not read from it in that generation, or changed since.
 */
export function storedSeqOf(entry: SessionEntry, sessionId: string, epoch: string | undefined): number | undefined {
	const at = stored.get(entry);
	if (at === undefined || epoch === undefined || at.sessionId !== sessionId || at.epoch !== epoch) return undefined;
	const json = JSON.stringify(entry);
	const unchanged =
		at.json !== undefined
			? json === at.json
			: json.length === at.length && fingerprintRange(json, FNV_OFFSET, 0, json.length) === at.fingerprint;
	return unchanged ? at.seq : undefined;
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
