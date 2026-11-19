import { randomUUID } from "node:crypto";

// A URL still carries its standalone position. The optional token adds the order in which the chain first saw the
// IDs, not permission to read them: every resume intersects that order with the current project's live listing.
const orders = new Map<string, { scope: string; ids: string[]; units: number }>();
const MAX_ORDERS = 32;
const MAX_UNITS = 2 ** 21; // UTF-16 code units, including a charge per ID (also bounds the array slots).
let retainedUnits = 0;

export const ORDER_TOKEN = /^[A-Za-z0-9_-]{22}$/;
const TOKEN_BYTES = "&order=".length + 22;

function remember<T>(scope: string, rows: readonly T[], idOf: (row: T) => string): string | undefined {
	let units = scope.length;
	if (units > MAX_UNITS) return undefined;
	for (const row of rows) {
		units += 1 + idOf(row).length;
		if (units > MAX_UNITS) return undefined;
	}
	while (orders.size >= MAX_ORDERS || retainedUnits + units > MAX_UNITS) {
		const oldest = orders.keys().next().value!;
		retainedUnits -= orders.get(oldest)!.units;
		orders.delete(oldest);
	}
	const token = Buffer.from(randomUUID().replaceAll("-", ""), "hex").toString("base64url");
	orders.set(token, { scope, ids: rows.map(idOf), units });
	retainedUnits += units;
	return token;
}

export class HistorySearchOrder {
	private readonly saved?: readonly string[];
	private save?: () => string | undefined;

	private readonly scope: string;
	private readonly token?: string;
	private readonly fresh: boolean;

	constructor(scope: string, token: string | undefined, fresh: boolean) {
		this.scope = scope;
		this.token = token;
		this.fresh = fresh;
		const order = token === undefined ? undefined : orders.get(token);
		if (order && order.scope === scope && token !== undefined) {
			this.saved = order.ids;
			orders.delete(token);
			orders.set(token, order);
		}
	}

	/** The anchor keeps its original index even if it is gone. Count only currently visible predecessors for coverage. */
	arrange<T>(
		rows: T[],
		idOf: (row: T) => string,
		anchor: string | undefined,
		after: boolean,
	): { rows: T[]; start?: number } {
		if (this.saved && anchor !== undefined) {
			const at = this.saved.indexOf(anchor);
			if (at !== -1) {
				const boundary = at + (after ? 1 : 0);
				if (rows.length === this.saved.length && this.saved.every((id, i) => idOf(rows[i]!) === id))
					return { rows, start: boundary };
				const current = new Map(rows.map((row) => [idOf(row), row]));
				const ordered: T[] = [];
				let start = 0;
				for (const [i, id] of this.saved.entries()) {
					const row = current.get(id);
					if (row === undefined) continue;
					ordered.push(row);
					if (i < boundary) start++;
				}
				return { rows: ordered, start };
			}
		} else if (this.fresh) {
			this.save = () => remember(this.scope, rows, idOf);
		}
		return { rows };
	}

	/** Attach only to our coverage note, after budget fitting; never displace a match or a legacy continuation. */
	attach(lines: string[], domain: "sessions" | "workflows", spareBytes: () => number): void {
		const note = lines[0];
		if ((!this.saved && !this.save) || !note?.startsWith(`history://${domain}`)) return;
		const marker = `; continue with history://${domain}?`;
		const at = note.lastIndexOf(marker);
		if (
			at < 0 ||
			!/^history:\/\/(?:sessions|workflows)(?:\?[^:\n]*)?:0: \[(?:searched |the time budget ran out waiting for the store;)/.test(
				note,
			) ||
			!note.endsWith("]") ||
			spareBytes() < TOKEN_BYTES
		)
			return;
		const token = this.saved ? this.token : this.save?.();
		if (!token) return;
		const range = note.indexOf(":", at + marker.length);
		const end = range < 0 ? note.length - 1 : range;
		lines[0] = `${note.slice(0, end)}&order=${token}${note.slice(end)}`;
	}
}
