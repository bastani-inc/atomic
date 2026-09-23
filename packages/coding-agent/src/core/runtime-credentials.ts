import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@bastani/pi-ai";
import { containsCredential, containsCredentialValue } from "./credential-screening.ts";

/** Previously saved Jev keys and /login commands use the old provider ID. */
export function getLegacyJevProviderId(providerId: string): string {
	return providerId === "typesafe-ai" ? "typesafe" : providerId;
}

interface ReloadableCredentialStore {
	reload(): void | Promise<void>;
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
		await getReloadableStore(this.store)?.reload();
	}

	peek(providerId: string): Credential | undefined {
		const override = this.overrides.get(providerId);
		return override
			? { type: "api_key", key: override }
			: (getSnapshotStore(this.store)?.peek(providerId) ??
					(providerId === "typesafe" ? getSnapshotStore(this.store)?.peek("typesafe-ai") : undefined));
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
		return (
			(await this.store.read(providerId, options)) ??
			(providerId === "typesafe" ? await this.store.read("typesafe-ai", options) : undefined)
		);
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		const entries = new Map((await this.store.list(options)).map((entry) => [entry.providerId, entry]));
		if (!entries.has("typesafe") && entries.has("typesafe-ai")) {
			entries.set("typesafe", { providerId: "typesafe", type: entries.get("typesafe-ai")!.type });
		}
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
		if (providerId === "typesafe") await this.store.delete("typesafe-ai", options);
		await this.store.delete(providerId, options);
	}
}
