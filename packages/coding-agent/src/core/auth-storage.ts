/**
 * CredentialStore implementation backed by auth.json.
 * Provider auth orchestration belongs to ModelRuntime and pi-ai Models.
 */

import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { join } from "path";
import { getAgentConfigPaths, getAgentDir } from "../config.ts";
import {
	type AuthStorageBackend,
	FileAuthStorageBackend,
	InMemoryAuthStorageBackend,
} from "./auth-storage-backends.ts";
import { resolveConfigValue } from "./resolve-config-value.ts";

export {
	type AuthStorageBackend,
	FileAuthStorageBackend,
	InMemoryAuthStorageBackend,
} from "./auth-storage-backends.ts";

export type AuthStorageData = Record<string, Credential>;

export class AuthStorage implements CredentialStore {
	private data: AuthStorageData = {};
	private storage: AuthStorageBackend;

	private constructor(storage: AuthStorageBackend) {
		this.storage = storage;
		this.reload();
	}

	static create(authPath?: string | string[]): AuthStorage {
		const paths =
			authPath === undefined ? getAgentConfigPaths("auth.json") : Array.isArray(authPath) ? authPath : [authPath];
		return new AuthStorage(new FileAuthStorageBackend(paths[0] ?? join(getAgentDir(), "auth.json"), paths));
	}

	static fromStorage(storage: AuthStorageBackend): AuthStorage {
		return new AuthStorage(storage);
	}

	static inMemory(data: AuthStorageData = {}): AuthStorage {
		const storage = new InMemoryAuthStorageBackend();
		storage.withLock(() => ({ result: undefined, next: JSON.stringify(data, null, 2) }));
		return AuthStorage.fromStorage(storage);
	}

	private parseStorageData(content: string | undefined): AuthStorageData {
		if (!content) {
			return {};
		}
		return JSON.parse(content) as AuthStorageData;
	}

	/**
	 * Reload credentials from storage.
	 */
	reload(): void {
		try {
			let content: string | undefined;
			if (this.storage.read) {
				content = this.storage.read();
			} else {
				this.storage.withLock((current) => {
					content = current;
					return { result: undefined };
				});
			}
			this.data = this.parseStorageData(content);
		} catch {
			// Preserve the last valid in-memory snapshot.
		}
	}

	async read(provider: string): Promise<Credential | undefined> {
		const credential = this.data[provider];
		if (credential?.type !== "api_key") return credential;
		if (credential.key === undefined) return credential;
		return { ...credential, key: resolveConfigValue(credential.key, credential.env) };
	}

	async modify(
		provider: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		let persistedData: AuthStorageData | undefined;
		const result = await this.storage.withLockAsync(async (content) => {
			const currentData = this.parseStorageData(content);
			const next = await fn(currentData[provider]);
			if (next === undefined) {
				persistedData = currentData;
				return { result: currentData[provider] };
			}

			const merged: AuthStorageData = { ...currentData, [provider]: next };
			persistedData = merged;
			return { result: next, next: JSON.stringify(merged, null, 2) };
		});
		if (persistedData) this.data = persistedData;
		return result;
	}

	async delete(provider: string): Promise<void> {
		if (this.storage.deleteProviderAsync) {
			const content = await this.storage.deleteProviderAsync(provider);
			this.data = this.parseStorageData(content);
			return;
		}
		let persistedData: AuthStorageData | undefined;
		await this.storage.withLockAsync(async (content) => {
			const currentData = this.parseStorageData(content);
			delete currentData[provider];
			persistedData = currentData;
			return { result: undefined, next: JSON.stringify(currentData, null, 2) };
		});
		if (persistedData) this.data = persistedData;
	}

	/** List credential metadata without resolving configured key values. */
	async list(): Promise<readonly CredentialInfo[]> {
		return Object.entries(this.data).map(([providerId, credential]) => ({ providerId, type: credential.type }));
	}
}

/** Read one persisted provider credential using Atomic's layered auth.json paths. */
export function readStoredCredential(providerId: string, authPath?: string | string[]): Credential | undefined {
	const paths =
		authPath === undefined ? getAgentConfigPaths("auth.json") : Array.isArray(authPath) ? authPath : [authPath];
	const storage = new FileAuthStorageBackend(paths[0] ?? join(getAgentDir(), "auth.json"), paths);
	try {
		let credential: Credential | undefined;
		storage.withLock((content) => {
			credential = content ? (JSON.parse(content) as AuthStorageData)[providerId] : undefined;
			return { result: undefined };
		});
		return credential;
	} catch {
		return undefined;
	}
}
