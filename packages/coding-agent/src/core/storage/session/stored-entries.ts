import type { SessionEntry } from "../../session-manager-types.ts";

/**
 * Where an entry a store read or wrote came from (#6560): the session, the seq and the generation it was read in, and
 * its JSON as stored, kept as the length and a fingerprint of it. A fork of that session in the same store shares the
 * rows of the entries it carries unchanged instead of storing a copy: an entry is unchanged when it is the very object
 * the store returned and its JSON is still the stored one, so an edit in place shows too. The fork checks, inside its
 * own transaction, that the session is still in that generation, in which a stored row never changes, so it reads no
 * entry back.
 *
 * A read or a write pays only for the note itself. The JSON string the driver returned, or the write encoded, is kept
 * until its fingerprint is taken in the background, once the store has been idle a moment, in slices that never hold
 * the event loop for more than {@link FINGERPRINT_SLICE_MS}; the string is then let go, so no second copy of the
 * resident entries stays in memory. A fork that asks before then compares the string itself. Notes whose fingerprint
 * a store's close leaves untaken are dropped: their entries are then copied, as any entry no store noted is.
 */
interface StoredAt {
	readonly sessionId: string;
	readonly seq: number;
	readonly epoch: string;
	readonly length: number;
	/** The notes made with it, whose fingerprints are taken together: see {@link NoteBatch}. */
	readonly batch: NoteBatch;
	/** The stored JSON, until its fingerprint is taken. */
	json: string | undefined;
	/** How much of `json` the fingerprint covers so far, and the fingerprint up to there. */
	taken: number;
	fingerprint: number;
	dropped: boolean;
}

/**
 * The notes one read or write made, held by each of them, so as long as any of its entries is, and only weakly by the
 * queue of fingerprints to take: the notes of entries no longer held need none, and their JSON goes with them.
 */
interface NoteBatch {
	/** The store that made them, whose close drops those whose fingerprint is untaken. */
	readonly owner: object;
	readonly notes: StoredAt[];
}

/** Each noted entry's note, held as long as the entry is. */
const stored = new WeakMap<object, StoredAt>();

/** Batches whose fingerprints may still be to take, oldest first, from `next` on, and in the first, from `nextNote`. */
let unprinted: WeakRef<NoteBatch>[] = [];
let next = 0;
let nextNote = 0;
/** Whether a note was made since the background work last looked: the stores are not idle yet. */
let notedSinceLook = false;
let scheduled: ReturnType<typeof setTimeout> | undefined;

/** The longest the background work holds the event loop at once. */
const FINGERPRINT_SLICE_MS = 1;
/** How long the stores must have noted nothing before fingerprints are taken: reads in a burst are not slowed. */
const FINGERPRINT_IDLE_MS = 20;
/** Batches waiting past which fingerprints are taken without waiting for the stores to go idle. */
const FINGERPRINT_WAITING = 100_000;
/** Characters fingerprinted between looks at the clock. */
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

function schedule(delayMs: number): void {
	if (scheduled !== undefined) return;
	scheduled = setTimeout(takeFingerprints, delayMs);
	// Never keeps a process alive: a note whose fingerprint is never taken only means its entry is copied.
	(scheduled as { unref?: () => void }).unref?.();
}

/** Takes the fingerprints waiting, one slice a turn, once the stores have been idle, or at once while too many wait. */
function takeFingerprints(): void {
	scheduled = undefined;
	if (notedSinceLook && unprinted.length - next < FINGERPRINT_WAITING) {
		notedSinceLook = false;
		schedule(FINGERPRINT_IDLE_MS);
		return;
	}
	const until = performance.now() + FINGERPRINT_SLICE_MS;
	while (next < unprinted.length) {
		const notes = unprinted[next]!.deref()?.notes;
		const at = notes?.[nextNote];
		if (at === undefined) {
			next++;
			nextNote = 0;
			continue;
		}
		const json = at.json;
		if (json !== undefined) {
			const end = Math.min(json.length, at.taken + FINGERPRINT_STRIDE);
			at.fingerprint = fingerprintRange(json, at.fingerprint, at.taken, end);
			at.taken = end;
			if (end === json.length) at.json = undefined;
		}
		if (at.json === undefined) nextNote++;
		if (performance.now() >= until) break;
	}
	if (next < unprinted.length) schedule(0);
	else {
		unprinted = [];
		next = 0;
		nextNote = 0;
	}
}

/**
 * What notes the entries one read or write of store `owner` stores for session `sessionId` in generation `epoch`:
 * called with each entry, its seq and the JSON it was parsed from or encoded as.
 */
export function storedEntryNotes(
	owner: object,
	sessionId: string,
	epoch: string,
): (entry: SessionEntry, seq: number, json: string) => void {
	let batch: NoteBatch | undefined;
	return (entry, seq, json) => {
		if (batch === undefined) {
			batch = { owner, notes: [] };
			unprinted.push(new WeakRef(batch));
			notedSinceLook = true;
			schedule(unprinted.length - next >= FINGERPRINT_WAITING ? 0 : FINGERPRINT_IDLE_MS);
		}
		const at: StoredAt = {
			sessionId,
			seq,
			epoch,
			length: json.length,
			batch,
			json,
			taken: 0,
			fingerprint: FNV_OFFSET,
			dropped: false,
		};
		batch.notes.push(at);
		stored.set(entry, at);
	};
}

/** Drops the notes of store `owner` whose fingerprint is not taken yet, as it closes: their entries are copied. */
export function dropStoredNotes(owner: object): void {
	for (let index = next; index < unprinted.length; index++) {
		const batch = unprinted[index]!.deref();
		if (batch?.owner !== owner) continue;
		for (const at of batch.notes)
			if (at.json !== undefined) {
				at.json = undefined;
				at.dropped = true;
			}
	}
}

/**
 * The seq at which session `sessionId` stores `entry` unchanged in generation `epoch`, or undefined when the entry was
 * not read from it in that generation, or changed since.
 */
export function storedSeqOf(entry: SessionEntry, sessionId: string, epoch: string | undefined): number | undefined {
	const at = stored.get(entry);
	if (at === undefined || at.dropped || epoch === undefined || at.sessionId !== sessionId || at.epoch !== epoch)
		return undefined;
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
