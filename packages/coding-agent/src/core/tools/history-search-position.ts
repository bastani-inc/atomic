import { types } from "node:util";
import { clockText, compactTemplate, compactUrl, MAX_POSITION_LENGTH } from "./history-search-wire.js";
import type { HistoryNoteWindow } from "./resource-selectors.ts";

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
	if (!completed) return prior ? `${head}~${prior}` : head;
	const prefix = prior ? `${prior}.` : "";
	// A single predecessor cannot stand in for the visited group: tied runs may switch order when one
	// finishes. Drop the optional clock first, then fall back to the ordinary pin if the IDs do not fit.
	const added = packIds(window, (id) => id, room - 2 - prefix.length, 0, completed);
	if (added === undefined) return undefined;
	const ids = `${prefix}${added}`;
	return `${head.length + 1 + ids.length <= room ? head : "p"}~${ids}`;
}

/** A manual read uses the legacy position, including for its byte reserve and any line cursor it returns. */
export function withoutSearchPosition(url: string): string {
	const query = url.indexOf("?");
	const params = new URLSearchParams(url.slice(query + 1));
	params.delete("order");
	const remaining = params.toString();
	return url.slice(0, query) + (remaining ? `?${remaining}` : "");
}

/** Only protocol-generated line-zero notes are eligible, never a match or arbitrary text containing a URL. */
export class HistorySearchPositions {
	private additions?: Map<string, string>;
	private uncertain?: string;
	private readonly rootSessionGroups: number;
	private readonly selection?: HistoryNoteWindow;
	constructor(rootSessionGroups: number, selection?: HistoryNoteWindow) {
		this.rootSessionGroups = rootSessionGroups;
		this.selection = selection;
	}

	offer(
		note: string | undefined,
		domain: "sessions" | "workflows",
		make: (room: number, scalarOnly: boolean) => string | undefined,
	): void {
		const selection = this.selection;
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
		// Any caller can forward this text through another, smaller budget. Only spend room reclaimed
		// from the original URL itself; the enclosing page's spare bytes do not belong to this field.
		if (!compact) return;
		const available = Math.min(compact.room, MAX_POSITION_LENGTH);
		const value = make(available, uncertain);
		if (!value || value.length > available) return;
		const changed = `${note.slice(0, start)}${compactUrl(compact, value)}${note.slice(end)}`;
		this.additions ??= new Map();
		this.additions.set(note, changed);
		if (uncertain) this.uncertain = note;
	}

	render(lines: string[]): string {
		if (this.additions) {
			for (let i = 0; i < lines.length; i++) {
				const original = lines[i]!;
				const extended = this.additions.get(original);
				if (!extended || (original === this.uncertain && !this.selection?.includes(lines, original))) continue;
				lines[i] = extended;
			}
		}
		return lines.join("\n");
	}
}
