import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Credential, ModelsStore, ModelsStoreEntry, ModelsStoreOperationOptions } from "@bastani/atomic-ai";

/** Account metadata (including the list itself) can change without changing the authenticating secret. */
export function modelListKey(provider: string, credential: Credential): string | undefined {
	const secret = credential.type === "oauth" ? credential.access : credential.key;
	return secret ? `${provider}:${credential.type}:${createHash("sha256").update(secret).digest("hex")}` : undefined;
}

export interface ModelListRead {
	promise: Promise<boolean>;
	readonly reader: symbol;
	readonly controller: AbortController;
	waiters: number;
	settled: boolean;
	entry?: AccountRow;
}

type Reads = Map<string, ModelListRead>;
const paths = new Map<string, WeakRef<Reads>>();
const released = new FinalizationRegistry<{ path: string; ref: WeakRef<Reads> }>(({ path, ref }) => {
	if (paths.get(path) === ref) paths.delete(path);
});
const stores = new WeakMap<ModelsStore, Reads>();

/** Only live runtimes (or the owner of an injected store) keep the store's once-per-account reads alive. */
export function sharedModelListReads(store: string | ModelsStore, create: boolean): Reads | undefined {
	const existing = typeof store === "string" ? paths.get(store)?.deref() : stores.get(store);
	if (existing || !create) return existing;
	const reads: Reads = new Map();
	if (typeof store === "string") {
		const ref = new WeakRef(reads);
		paths.set(store, ref);
		released.register(reads, { path: store, ref });
	} else stores.set(store, reads);
	return reads;
}

type AccountRow = ModelsStoreEntry & { accountListKey?: string };
interface ReadScope {
	provider: string;
	key: string;
	read: ModelListRead;
}

/**
 * A regular refresh still owns the provider's atomic store write. Tag only entries produced by automatic discovery,
 * so a later runtime cannot restore an unrelated account's restrictions. Legacy, untagged cache entries are unchanged.
 */
export class AccountModelListStore implements ModelsStore {
	readonly scope = new AsyncLocalStorage<ReadScope>();
	private readonly store: ModelsStore;
	private readonly previousRead: (key: string) => ModelListRead | undefined;
	private readonly currentKey: (provider: string, signal?: AbortSignal) => Promise<string | undefined>;

	constructor(
		store: ModelsStore,
		previousRead: AccountModelListStore["previousRead"],
		currentKey: AccountModelListStore["currentKey"],
	) {
		this.store = store;
		this.previousRead = previousRead;
		this.currentKey = currentKey;
	}

	async read(provider: string, options?: ModelsStoreOperationOptions): Promise<ModelsStoreEntry | undefined> {
		const row: AccountRow | undefined = await this.store.read(provider, options);
		if (!row?.accountListKey) return row;
		const scope = this.scope.getStore();
		const key = scope?.provider === provider ? scope.key : await this.currentKey(provider, options?.signal);
		if (row.accountListKey === key) return row;
		const own = key ? this.previousRead(key)?.entry : undefined;
		return own?.accountListKey === key ? own : undefined;
	}

	async isCurrent(provider: string, entry: ModelsStoreEntry, signal: AbortSignal): Promise<boolean> {
		return isDeepStrictEqual(await this.read(provider, { signal }), entry);
	}

	async write(provider: string, entry: ModelsStoreEntry, options?: ModelsStoreOperationOptions): Promise<void> {
		const scope = this.scope.getStore();
		if (scope?.provider !== provider) return this.store.write(provider, entry, options);
		const row: AccountRow = { ...entry, accountListKey: scope.key };
		await this.store.write(provider, row, options);
		scope.read.entry = row;
	}

	delete(provider: string, options?: ModelsStoreOperationOptions): Promise<void> {
		return this.store.delete(provider, options);
	}
}
