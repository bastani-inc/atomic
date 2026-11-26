import type { SessionEntry } from "../../session-manager-types.ts";

/**
 * What this process knows a session stores (#6560): for each seq a store read or wrote in the session's current
 * generation, the length of the entry's JSON as stored and a fingerprint of it. A fork of that session in the same
 * store shares the row of each entry it carries whose JSON is still the stored one, instead of storing a copy: in a
 * generation a stored row never changes, and the fork checks, inside its own transaction, that the session is still in
 * the generation the rows were read in, so it reads no entry back. An entry edited in place, or a new one, has other
 * JSON, and is stored.
 *
 * A read or a write pays only for the note: the JSON string the driver returned, or the write encoded, is kept until
 * its fingerprint is taken in the background, once the stores have been idle a moment, in slices that never hold the
 * event loop for more than {@link FINGERPRINT_SLICE_MS}; the string is then let go, so no second copy of the resident
 * entries stays in memory. A fork that asks before then compares the string itself. Notes are kept per session, 12
 * bytes a seq, in pages, not per entry, and as long as some entry a read or write of them returned is held.
 */
interface SessionNotes {
	readonly epoch: string;
	/** By page of {@link PAGE_SEQS} seqs: see {@link NotePage}. */
	readonly pages: (NotePage | undefined)[];
}

/**
 * The notes of {@link PAGE_SEQS} seqs: `prints` holds, for each, the length of its JSON (-1 for none) and the two
 * halves of its fingerprint; `jsons`, while some fingerprint of the page is untaken, the JSON of those seqs.
 */
interface NotePage {
	prints: Int32Array;
	jsons: (string | undefined)[] | undefined;
	pending: number;
}

/** The seqs one read or write noted, whose fingerprints the background takes, the notes held weakly. */
interface NoteBatch {
	/** The store that noted them, whose close drops those whose fingerprint is untaken. */
	readonly owner: object;
	readonly notes: WeakRef<SessionNotes>;
	readonly seqs: number[];
}

const PAGE_BITS = 8;
const PAGE_SEQS = 1 << PAGE_BITS;
/** The fewest seqs a page holds notes for: a short session's page grows as its seqs do. */
const PAGE_MIN_SEQS = 8;

/** Each session's notes, held weakly: the entries a read or write of them returned hold them. */
const sessions = new Map<string, WeakRef<SessionNotes>>();
/** The first entry of each read or write, holding the session's notes as long as it is held. */
const holders = new WeakMap<object, SessionNotes>();

/** Batches whose fingerprints may still be to take, oldest first, from `next` on, and in the first, from `nextSeq`. */
let unprinted: NoteBatch[] = [];
let next = 0;
let nextSeq = 0;
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
const OFFSET_A = 0x811c9dc5 | 0;
const OFFSET_B = 0x9e3779b9 | 0;
/** How far the fingerprint of the seq the background is in covers its JSON, and the fingerprint up to there. */
let taken = 0;
let takenA = OFFSET_A;
let takenB = OFFSET_B;

/**
 * Continues a 64-bit fingerprint, in two 32-bit halves, of `text` from `from` through `until`: not to keep anyone from
 * forging a match, only to tell an entry's JSON from another's. Each step of each half is a bijection of its state, so
 * an edit of one character always changes both; with the length, other JSON matches about once in 2^64.
 */
function fingerprintRange(text: string, a: number, b: number, from: number, until: number): [number, number] {
	for (let index = from; index < until; index++) {
		const code = text.charCodeAt(index);
		a = Math.imul(a ^ code, 16777619);
		b = Math.imul(b ^ code, 0x5bd1e995);
		b = (b << 13) | (b >>> 19);
	}
	return [a, b];
}

function schedule(delayMs: number): void {
	if (scheduled !== undefined) return;
	scheduled = setTimeout(takeFingerprints, delayMs);
	// Never keeps a process alive: a note whose fingerprint is never taken only means its entry is copied.
	(scheduled as { unref?: () => void }).unref?.();
}

/** The page of `notes` that holds `seq`, made large enough for it when `make`. */
function pageOf(notes: SessionNotes, seq: number, make: true): NotePage;
function pageOf(notes: SessionNotes, seq: number, make?: false): NotePage | undefined;
function pageOf(notes: SessionNotes, seq: number, make = false): NotePage | undefined {
	const index = seq >>> PAGE_BITS;
	let page = notes.pages[index];
	if (!make) return page;
	const slots = (seq & (PAGE_SEQS - 1)) + 1;
	if (page === undefined) {
		page = { prints: new Int32Array(0), jsons: undefined, pending: 0 };
		notes.pages[index] = page;
	}
	if (page.prints.length < slots * 3) {
		let size = Math.max(PAGE_MIN_SEQS, page.prints.length / 3);
		while (size < slots) size *= 2;
		const prints = new Int32Array(size * 3).fill(-1);
		prints.set(page.prints);
		page.prints = prints;
	}
	return page;
}

/** Takes the fingerprint of `seq` in `page` from `json`, `taken` characters of it done, as far as `until`. */
function takeFingerprint(page: NotePage, seq: number, json: string, until: number): void {
	const end = Math.min(json.length, until);
	[takenA, takenB] = fingerprintRange(json, takenA, takenB, taken, end);
	taken = end;
	if (end < json.length) return;
	const slot = (seq & (PAGE_SEQS - 1)) * 3;
	page.prints[slot + 1] = takenA;
	page.prints[slot + 2] = takenB;
	page.jsons![seq & (PAGE_SEQS - 1)] = undefined;
	if (--page.pending === 0) page.jsons = undefined;
	taken = 0;
	takenA = OFFSET_A;
	takenB = OFFSET_B;
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
		const batch = unprinted[next]!;
		const notes = batch.notes.deref();
		const seq = batch.seqs[nextSeq];
		const page = notes === undefined || seq === undefined ? undefined : pageOf(notes, seq);
		const json = page?.jsons?.[seq! & (PAGE_SEQS - 1)];
		if (json === undefined) {
			// Done, dropped or let go: the next seq, from its start.
			taken = 0;
			takenA = OFFSET_A;
			takenB = OFFSET_B;
			if (seq === undefined || notes === undefined) {
				next++;
				nextSeq = 0;
			} else nextSeq++;
			continue;
		}
		takeFingerprint(page!, seq!, json, taken + FINGERPRINT_STRIDE);
		if (taken === 0) nextSeq++;
		if (performance.now() >= until) break;
	}
	if (next < unprinted.length) schedule(0);
	else {
		unprinted = [];
		next = 0;
		nextSeq = 0;
		for (const [sessionId, notes] of sessions) if (notes.deref() === undefined) sessions.delete(sessionId);
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
	let notes: SessionNotes | undefined;
	let batch: NoteBatch | undefined;
	return (entry, seq, json) => {
		if (notes === undefined) {
			notes = sessions.get(sessionId)?.deref();
			// Another generation's notes say nothing of this one's rows.
			if (notes?.epoch !== epoch) {
				notes = { epoch, pages: [] };
				sessions.set(sessionId, new WeakRef(notes));
			}
			holders.set(entry, notes);
		}
		const page = pageOf(notes, seq, true);
		const slot = seq & (PAGE_SEQS - 1);
		// A row stored in this generation never changes: one noted already is noted as it is.
		if (page.prints[slot * 3]! >= 0) return;
		page.prints[slot * 3] = json.length;
		page.jsons ??= [];
		page.jsons[slot] = json;
		page.pending++;
		if (batch === undefined) {
			batch = { owner, notes: new WeakRef(notes), seqs: [] };
			unprinted.push(batch);
			notedSinceLook = true;
			schedule(unprinted.length - next >= FINGERPRINT_WAITING ? 0 : FINGERPRINT_IDLE_MS);
		}
		batch.seqs.push(seq);
	};
}

/** Drops the notes of store `owner` whose fingerprint is not taken yet, as it closes: their entries are copied. */
export function dropStoredNotes(owner: object): void {
	for (let index = next; index < unprinted.length; index++) {
		const batch = unprinted[index]!;
		const notes = batch.owner === owner ? batch.notes.deref() : undefined;
		if (notes === undefined) continue;
		for (const seq of batch.seqs) {
			const page = pageOf(notes, seq);
			const slot = seq & (PAGE_SEQS - 1);
			if (page?.jsons?.[slot] === undefined) continue;
			page.prints[slot * 3] = -1;
			page.jsons[slot] = undefined;
			if (--page.pending === 0) page.jsons = undefined;
		}
	}
}

/**
 * Where session `sessionId` stores entries in generation `epoch`, as far as this process read or wrote them: undefined
 * when it knows of none, so a fork with nothing to share looks at no entry.
 */
export function storedRows(sessionId: string, epoch: string | undefined): StoredRows | undefined {
	if (epoch === undefined) return undefined;
	const notes = sessions.get(sessionId)?.deref();
	return notes?.epoch === epoch ? new StoredRows(notes) : undefined;
}

/** See {@link storedRows}. */
export class StoredRows {
	private readonly notes: SessionNotes;
	/** The seqs by the first half of their fingerprint, made when an entry is not where the one before it suggests. */
	private bySeqPrint: Map<number, number[]> | undefined;

	constructor(notes: SessionNotes) {
		this.notes = notes;
	}

	/**
	 * The first seq after `after` at which the session stores `entry` unchanged, or undefined when it stores it at none
	 * this process knows of. The seq right after `after` is looked at first: a fork carries its source's rows in order.
	 */
	seqOf(entry: SessionEntry, after: number): number | undefined {
		const json = JSON.stringify(entry);
		let print: [number, number] | undefined;
		const fingerprint = (): [number, number] => {
			print ??= fingerprintRange(json, OFFSET_A, OFFSET_B, 0, json.length);
			return print;
		};
		const at = (seq: number): boolean => {
			const page = pageOf(this.notes, seq);
			if (page === undefined) return false;
			const slot = seq & (PAGE_SEQS - 1);
			if (slot * 3 >= page.prints.length || page.prints[slot * 3] !== json.length) return false;
			const stored = page.jsons?.[slot];
			if (stored !== undefined) return stored === json;
			const [a, b] = fingerprint();
			return page.prints[slot * 3 + 1] === a && page.prints[slot * 3 + 2] === b;
		};
		if (at(after + 1)) return after + 1;
		const [a] = fingerprint();
		for (const seq of this.seqsByPrint().get(a) ?? []) if (seq > after && at(seq)) return seq;
		return undefined;
	}

	/** {@link bySeqPrint}, every fingerprint of the session taken first. */
	private seqsByPrint(): Map<number, number[]> {
		if (this.bySeqPrint !== undefined) return this.bySeqPrint;
		const index = new Map<number, number[]>();
		for (const [number, page] of this.notes.pages.entries()) {
			if (page === undefined) continue;
			for (let slot = 0; slot * 3 < page.prints.length; slot++) {
				if (page.prints[slot * 3]! < 0) continue;
				const seq = (number << PAGE_BITS) + slot;
				const json = page.jsons?.[slot];
				if (json !== undefined) {
					taken = 0;
					takenA = OFFSET_A;
					takenB = OFFSET_B;
					takeFingerprint(page, seq, json, json.length);
				}
				const print = page.prints[slot * 3 + 1]!;
				const seqs = index.get(print);
				if (seqs === undefined) index.set(print, [seq]);
				else seqs.push(seq);
			}
		}
		this.bySeqPrint = index;
		return index;
	}
}

/** The seq at which session `sessionId` stores `entry` unchanged in generation `epoch`, if this process knows one. */
export function storedSeqOf(entry: SessionEntry, sessionId: string, epoch: string | undefined): number | undefined {
	return storedRows(sessionId, epoch)?.seqOf(entry, 0);
}
