import { AsyncLocalStorage } from "node:async_hooks";
import { types } from "node:util";
import { clockText, compactTemplate, compactUrl, MAX_POSITION_LENGTH } from "./history-search-wire.js";

// A length check before encoding bounds both allocation and URL size, even for long or malformed UTF-16 IDs.
export function packIds<T>(
	rows: readonly T[],
	idOf: (row: T) => string,
	room: number,
	first = 0,
	end = rows.length,
): string | undefined {
	const limit = Math.min(room, MAX_POSITION_LENGTH);
	let size = Math.max(0, end - first - 1);
	if (size > limit) return undefined;
	for (let i = first; i < end; i++) {
		size += Math.ceil((idOf(rows[i]!).length * 8) / 3);
		if (size > limit) return undefined;
	}
	const parts: string[] = [];
	for (let i = first; i < end; i++) parts.push(Buffer.from(idOf(rows[i]!), "utf16le").toString("base64url"));
	return parts.join(".");
}

export function unpackIds(text: string): string[] {
	return text.split(".").map((part) => Buffer.from(part, "base64url").toString("utf16le"));
}

interface CreatedKey {
	readonly id: string;
	readonly createdMs: number;
}

export function compareCreated(a: CreatedKey, b: CreatedKey): number {
	return b.createdMs - a.createdMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function compareFrozen(clocks: ReadonlyMap<number, number>, a: CreatedKey, b: CreatedKey): number {
	return (clocks.get(b.createdMs) ?? b.createdMs) - (clocks.get(a.createdMs) ?? a.createdMs) || compareCreated(a, b);
}

function eachPromotion(keys: readonly CreatedKey[], accept: (created: number, promoted: number) => boolean): boolean {
	let nextTime = keys.at(-1)?.createdMs ?? 0;
	for (let i = keys.length - 2; i >= 0; i--) {
		const key = keys[i]!;
		nextTime = Math.max(key.createdMs, nextTime + (compareCreated(key, keys[i + 1]!) > 0 ? 1 : 0));
		if (
			nextTime !== key.createdMs &&
			(!Number.isSafeInteger(nextTime - key.createdMs) ||
				!Number.isSafeInteger(nextTime) ||
				!accept(key.createdMs, nextTime))
		)
			return false;
	}
	return true;
}

function base36Width(value: number): number {
	let width = value < 0 ? 2 : 1;
	for (let n = Math.abs(value); n >= 36; n = Math.floor(n / 36)) width++;
	return width;
}

export function sessionPosition(keys: readonly CreatedKey[], room: number): string | undefined {
	// Walk backwards, promoting a creation time only if it would otherwise put the row behind its successor.
	// Size the sparse correction before allocating it. A single active old session usually needs just one pair.
	let size = 0,
		lastCreated: number | undefined,
		lastPromoted: number | undefined;
	const fits = eachPromotion(keys, (created, promoted) => {
		if (created !== lastCreated || promoted !== lastPromoted)
			size += 2 + base36Width(created) + base36Width(promoted - created);
		lastCreated = created;
		lastPromoted = promoted;
		return size <= room;
	});
	if (fits && size === 0) return "c";
	if (fits) {
		const clocks = new Map<number, number>();
		eachPromotion(keys, (created, promoted) => {
			clocks.set(created, promoted);
			return true;
		});
		// Check unpromoted members of equal-creation-time groups too: all get the same clock on resume.
		if (keys.every((key, i) => !i || compareFrozen(clocks, keys[i - 1]!, key) <= 0))
			return `v${Array.from(clocks, ([c, time]) => `${c.toString(36)}.${(time - c).toString(36)}`).join("~")}`;
	}
	const ids = packIds(keys, (key) => key.id, room - 2);
	return ids === undefined ? undefined : `s.${ids}`;
}

/** Optional metadata must not call a lazy getter (or even a proxy descriptor trap) for a second time. */
export function storedRunStart(run: { readonly startedAt: number }): number | undefined {
	if (types.isProxy(run)) return undefined;
	const value: unknown = Object.getOwnPropertyDescriptor(run, "startedAt")?.value;
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Store only IDs already consumed; never enumerate the unseen suffix to construct a workflow continuation. */
export function runPosition(
	prior: string | undefined,
	window: readonly string[],
	completed: number,
	time: number | undefined,
	fromStart: boolean,
	room: number,
): string | undefined {
	const head = fromStart ? clockText(time) : "p";
	const base = prior ? `${head}~${prior}` : head;
	if (!completed) return base;
	const added = packIds(window, (id) => id, room - base.length - 1, 0, completed);
	if (added !== undefined) return `${base}${prior ? "." : "~"}${added}`;
	// On a long chain keep a nearby predecessor if it fits. Without the full prefix, do not infer a time boundary.
	const last = packIds(window, (id) => id, room - 2, completed - 1, completed);
	return last ? `p~${last}` : undefined;
}

/** A manual read uses the legacy position, including for its byte reserve and any line cursor it returns. */
export function withoutSearchPosition(url: string): string {
	const query = url.indexOf("?");
	const params = new URLSearchParams(url.slice(query + 1));
	params.delete("order");
	const remaining = params.toString();
	return url.slice(0, query) + (remaining ? `?${remaining}` : "");
}

// A search tool and its builtin router can come from independent package copies. Share only the current
// provider call, never a cursor cache or listing. Don't add an observable field to extension requests.
type RecordNote = (extended: string, original: string) => void;
export interface HistoryNoteWindow {
	first: number;
	end: number;
	includes: (lines: readonly string[], note: string) => boolean;
}
type Selector = { record?: RecordNote; window?: HistoryNoteWindow };
const scopeKey = Symbol.for("atomic.history-search-selector.v1");
const host = globalThis as typeof globalThis & { [scopeKey]?: AsyncLocalStorage<Selector> };
host[scopeKey] ??= new AsyncLocalStorage<Selector>();
const scope = host[scopeKey];

export async function collectHistorySearchNotes<T>(
	read: () => Promise<T>,
	record?: RecordNote,
	window?: HistoryNoteWindow,
): Promise<T> {
	const selector: Selector = { record, window };
	try {
		return await scope.run(selector, read);
	} finally {
		// A parked store operation can outlive the selector.
		delete selector.record;
		delete selector.window;
	}
}

/** Only protocol-generated line-zero notes are eligible, never a match or arbitrary text containing a URL. */
export class HistorySearchPositions {
	private additions?: Map<string, string>;
	private uncertain?: string;
	private grows = false;
	private readonly rootSessionGroups: number;
	constructor(rootSessionGroups: number) {
		this.rootSessionGroups = rootSessionGroups;
	}

	offer(
		note: string | undefined,
		domain: "sessions" | "workflows",
		make: (room: number, scalarOnly: boolean) => string | undefined,
		room: () => number,
	): void {
		const selector = scope.getStore();
		if (selector && !selector.record) return;
		const selection = selector?.window;
		const maxBefore = domain === "workflows" ? this.rootSessionGroups : 0;
		if (selection && (selection.first > maxBefore || selection.end <= 0)) return;
		// A root's workflow branch may finish while its session branch is stalled. If the result still depends
		// on group selection, offer a scalar fence only; don't copy or save any IDs for a possibly discarded note.
		const uncertain = !!selection && (selection.first > 0 || selection.end <= maxBefore);
		const path = `history://${domain}`;
		if (!note?.startsWith(path) || !["?", ":"].includes(note[path.length]!) || !note.endsWith("]")) return;
		const label = note.indexOf(":0: [");
		if (label < 0 || !/^\[searched |^\[the time budget ran out waiting for the store;/.test(note.slice(label + 4)))
			return;
		const marker = `; continue with history://${domain}?`;
		const at = note.lastIndexOf(marker);
		if (at < 0) return;
		const range = note.indexOf(":", at + marker.length);
		const end = range < 0 ? note.length - 1 : range;
		const start = at + "; continue with ".length;
		const compact = compactTemplate(note.slice(start, end), note.includes(" budget ran out"));
		const available = Math.min(
			Math.max(compact?.room ?? 0, selector ? room() - "&order=".length : 0),
			MAX_POSITION_LENGTH,
		);
		if (available <= 0) return;
		const value = make(available, uncertain);
		if (!value || value.length > available) return;
		const changed =
			compact && value.length <= compact.room
				? `${note.slice(0, start)}${compactUrl(compact, value)}${note.slice(end)}`
				: `${note.slice(0, end)}&order=${value}${note.slice(end)}`;
		this.grows ||= changed.length > note.length;
		this.additions ??= new Map();
		this.additions.set(note, changed);
		if (uncertain) this.uncertain = note;
	}

	render(lines: string[], bytes: number): string {
		if (this.additions) {
			let room = bytes + 1;
			if (this.grows) for (const line of lines) room -= Buffer.byteLength(line) + 1;
			for (let i = 0; i < lines.length; i++) {
				const original = lines[i]!;
				const extended = this.additions.get(original);
				if (!extended || extended.length - original.length > room) continue;
				if (original === this.uncertain && !scope.getStore()?.window?.includes(lines, original)) continue;
				room -= extended.length - original.length;
				lines[i] = extended;
				scope.getStore()?.record?.(extended, original);
			}
		}
		return lines.join("\n");
	}
}
