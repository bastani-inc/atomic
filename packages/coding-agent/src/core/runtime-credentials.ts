import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

interface ReloadableCredentialStore {
	reload(): void | Promise<void>;
}

function getReloadableStore(store: CredentialStore): ReloadableCredentialStore | undefined {
	const reloadable = store as CredentialStore & Partial<ReloadableCredentialStore>;
	return typeof reloadable.reload === "function" ? (reloadable as ReloadableCredentialStore) : undefined;
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
		await getReloadableStore(this.store)?.reload();
	}

	async read(providerId: string): Promise<Credential | undefined> {
		const override = this.overrides.get(providerId);
		return override ? { type: "api_key", key: override } : this.store.read(providerId);
	}

	async list(): Promise<readonly CredentialInfo[]> {
		const entries = new Map((await this.store.list()).map((entry) => [entry.providerId, entry]));
		for (const providerId of this.overrides.keys()) {
			entries.set(providerId, { providerId, type: "api_key" });
		}
		return [...entries.values()];
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		return this.store.modify(providerId, fn);
	}

	async delete(providerId: string): Promise<void> {
		this.overrides.delete(providerId);
		await this.store.delete(providerId);
	}
}
