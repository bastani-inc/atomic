import { AsyncLocalStorage } from "node:async_hooks";

interface SearchPageScope {
	readonly notes: Map<string, string>;
	readonly taskCursors?: WeakMap<object, object>;
}
const scope = new AsyncLocalStorage<SearchPageScope>();

/** A provider may offer a task the exact URL of a seekable budget stop, along with the row it prints for it. */
export function seekableHistoryStop(note: string, url: string): string {
	scope.getStore()?.notes.set(note, url);
	return note;
}

/** A task never takes, replaces or evicts the ordinary reader's parked state. */
export function historyCursorCache<T extends object>(ordinary: T, create: () => T): T {
	const caches = scope.getStore()?.taskCursors;
	if (!caches) return ordinary;
	let cache = caches.get(ordinary) as T | undefined;
	if (!cache) {
		cache = create();
		caches.set(ordinary, cache);
	}
	return cache;
}

export async function collectHistoryContinuations<T extends { content: { type: string; text?: string }[] }>(
	execute: () => Promise<T>,
	taskCursors?: WeakMap<object, object>,
): Promise<{ page: T; urls: string[] }> {
	const notes = new Map<string, string>();
	try {
		const page = await scope.run({ notes, taskCursors }, execute);
		const urls: string[] = [];
		// Skip, lookahead and output limits can exclude a provider's stop. Select only whole, visible
		// control rows already identified by that provider; IDs, matched prose and hints never supply URLs.
		if (notes.size)
			for (const block of page.content) {
				if (block.type !== "text" || !block.text) continue;
				for (const row of block.text.split("\n")) {
					const url = notes.get(row);
					if (url !== undefined) urls.push(url);
				}
			}
		return { page, urls };
	} finally {
		// A provider's cursor-expiry timer can outlive the call. Don't retain its page metadata with it.
		notes.clear();
	}
}
