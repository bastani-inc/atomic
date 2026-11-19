import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@bastani/atomic-ai";
import { AuthStorage, accountSnapshotVersion, ReadOnlyAuthStorage } from "./auth-storage.ts";
import { containsCredential, containsCredentialValue } from "./credential-screening.ts";
import { resolveConfigValue } from "./resolve-config-value.ts";

interface ReloadableCredentialStore {
	reload(): void | Promise<void>;
	reloadAsync?(): Promise<void>;
	reloadIfChanged?(): boolean;
}

function getReloadableStore(store: CredentialStore): ReloadableCredentialStore | undefined {
	const reloadable = store as CredentialStore & Partial<ReloadableCredentialStore>;
	return typeof reloadable.reload === "function" ? (reloadable as ReloadableCredentialStore) : undefined;
}

interface SnapshotCredentialStore {
	peek(providerId: string): Credential | undefined;
}

function getSnapshotStore(store: CredentialStore): SnapshotCredentialStore | undefined {
	const snapshotStore = store as CredentialStore & Partial<SnapshotCredentialStore>;
	return typeof snapshotStore.peek === "function" ? (snapshotStore as SnapshotCredentialStore) : undefined;
}

/** Async credential store overlay for non-persistent runtime API keys. */
export class RuntimeCredentials implements CredentialStore {
	private readonly store: CredentialStore;
	private readonly overrides = new Map<string, string>();

	constructor(store: CredentialStore) {
		this.store = store;
	}

	setRuntimeApiKey(providerId: string, apiKey: string): void {
		this.overrides.set(providerId, apiKey);
	}

	removeRuntimeApiKey(providerId: string): void {
		this.overrides.delete(providerId);
	}

	hasRuntimeApiKey(providerId: string): boolean {
		return this.overrides.has(providerId);
	}

	async reload(): Promise<void> {
		const store = getReloadableStore(this.store);
		await (store?.reloadAsync ? store.reloadAsync() : store?.reload());
	}

	reloadIfChanged(): void {
		getReloadableStore(this.store)?.reloadIfChanged?.();
	}

	hasCredentialSnapshot(): boolean {
		return getSnapshotStore(this.store) !== undefined;
	}

	peek(providerId: string): Credential | undefined {
		const override = this.overrides.get(providerId);
		return override ? { type: "api_key", key: override } : getSnapshotStore(this.store)?.peek(providerId);
	}

	/** A current credential for optional discovery, without entering the store's read queue or executing a key command. */
	accountSnapshot(providerId: string): { credential?: Credential; version?: string } | undefined {
		const override = this.overrides.get(providerId);
		if (override) return override.startsWith("!") ? undefined : { credential: { type: "api_key", key: override } };
		const snapshot = getSnapshotStore(this.store);
		if (!snapshot) return undefined;
		const native = this.store instanceof AuthStorage;
		const version = native ? this.store[accountSnapshotVersion]() : undefined;
		if (version === null) return undefined;
		const raw = snapshot.peek(providerId);
		if (!raw) return { version };
		if (raw.type === "oauth") {
			// The list uses only the access grant and its endpoint. Never copy a refresh token into discovery.
			const { type, access, expires, enterpriseUrl } = raw;
			return { credential: { type, access, refresh: "", expires, enterpriseUrl }, version };
		}
		const { key, env } = raw;
		if (key?.startsWith("!")) return undefined;
		return {
			credential: {
				type: "api_key",
				key: (native || this.store instanceof ReadOnlyAuthStorage) && key ? resolveConfigValue(key, env) : key,
				env,
			},
			version,
		};
	}

	/** Keep credential values internal, including stored values shadowed by runtime overrides. */
	async containsConfiguredCredential(serialized: string): Promise<boolean> {
		for (const value of this.overrides.values()) {
			if (containsCredentialValue(serialized, value)) return true;
		}
		const snapshot = getSnapshotStore(this.store);
		for (const { providerId } of await this.store.list()) {
			const credential = snapshot ? snapshot.peek(providerId) : await this.store.read(providerId);
			if (containsCredential(serialized, credential)) return true;
		}
		return false;
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		const override = this.overrides.get(providerId);
		if (override) return { type: "api_key", key: override };
		return this.store.read(providerId, options);
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		const entries = new Map((await this.store.list(options)).map((entry) => [entry.providerId, entry]));
		for (const providerId of this.overrides.keys()) {
			entries.set(providerId, { providerId, type: "api_key" });
		}
		return [...entries.values()];
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return this.store.modify(providerId, fn, options);
	}

	async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		this.overrides.delete(providerId);
		await this.store.delete(providerId, options);
	}
}
