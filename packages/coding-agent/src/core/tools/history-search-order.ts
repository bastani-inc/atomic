import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

// A URL still carries its standalone position. The optional token adds the order in which the chain first saw the
// IDs, not permission to read them: every resume intersects that order with the current project's live listing.
const orders = new Map<string, { scope: string; ids: string[]; bytes: number }>();
const MAX_ORDERS = 32;
const MAX_ORDER_BYTES = 4 * 1024 * 1024;
let retainedBytes = 0;

export const ORDER_TOKEN = /^[A-Za-z0-9_-]{22}$/;
const TOKEN_BYTES = "&order=".length + 22;

// An ID can be a short slice of a large source record. Copy its code units, including unpaired surrogates.
function copyString(value: string): string {
	return Buffer.from(value, "utf16le").toString("utf16le");
}

function remember<T>(scope: string, rows: readonly T[], idOf: (row: T) => string): string | undefined {
	// Budget full-width string payloads, plus the token and entry overhead and each string's header and array slot.
	let bytes = 256 + 2 * scope.length;
	if (bytes > MAX_ORDER_BYTES) return undefined;
	const ids: string[] = [];
	for (const row of rows) {
		const id = idOf(row);
		bytes += 48 + 2 * id.length;
		if (bytes > MAX_ORDER_BYTES) return undefined;
		ids.push(copyString(id));
	}
	while (orders.size >= MAX_ORDERS || retainedBytes + bytes > MAX_ORDER_BYTES) {
		const oldest = orders.keys().next().value!;
		retainedBytes -= orders.get(oldest)!.bytes;
		orders.delete(oldest);
	}
	const token = Buffer.from(randomUUID().replaceAll("-", ""), "hex").toString("base64url");
	orders.set(token, { scope: copyString(scope), ids, bytes });
	retainedBytes += bytes;
	return token;
}

// A page can query the same listing through multiple selectors. Share its notes across the SDK and builtin
// router without changing the request an extension sees, even when they load separate copies of the package.
const pageKey = Symbol.for("atomic.history-search-page.v1");
type ProviderCall = { page?: HistorySearchPage };
const host = globalThis as typeof globalThis & { [pageKey]?: AsyncLocalStorage<ProviderCall> };
host[pageKey] ??= new AsyncLocalStorage<ProviderCall>();
const providerCall = host[pageKey];

export class HistorySearchPage {
	readonly notes = new Map<string, string>();
	readonly originals = new Map<string, string>();

	async read(search: () => Promise<string>): Promise<string> {
		const call: ProviderCall = { page: this };
		try {
			return await providerCall.run(call, search);
		} finally {
			// A parked store read can outlive the page.
			delete call.page;
		}
	}
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
		const page = providerCall.getStore()?.page;
		const previous = page?.notes.get(note);
		if (previous) {
			lines[0] = previous;
			return;
		}
		const token = this.saved ? this.token : this.save?.();
		if (!token) return;
		const range = note.indexOf(":", at + marker.length);
		const end = range < 0 ? note.length - 1 : range;
		lines[0] = `${note.slice(0, end)}&order=${token}${note.slice(end)}`;
		page?.notes.set(note, lines[0]);
		page?.originals.set(lines[0], note);
	}
}
