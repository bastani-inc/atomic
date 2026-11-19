/**
 * CredentialStore implementation backed by auth.json.
 * Provider auth orchestration belongs to ModelRuntime and pi-ai Models.
 */

import {
	type AuthOperationOptions,
	type Credential,
	type CredentialInfo,
	type CredentialStore,
	normalizeProviderId,
} from "@bastani/atomic-ai";
import { join } from "path";
import { isDeepStrictEqual } from "util";
import { getAgentConfigPaths, getAgentDir } from "../config.js";
import { raceWithAbortSignal } from "../utils/abort.js";
import { stripBom } from "../utils/text.ts";
import {
	type AsyncAuthStorageReads,
	type AuthStorageBackend,
	asyncAuthStorageReads,
	FileAuthStorageBackend,
	InMemoryAuthStorageBackend,
} from "./auth-storage-backends.ts";
import { LEGACY_AZURE_PROVIDER, normalizeProviderKeys } from "./azure-provider-compat.js";
import { resolveConfigValueAsync } from "./resolve-config-value.ts";

export {
	type AuthStorageBackend,
	FileAuthStorageBackend,
	InMemoryAuthStorageBackend,
} from "./auth-storage-backends.ts";

export type AuthStorageData = Record<string, Credential>;

/** Internal snapshot check for optional account discovery. Never open a changed file just to check an account. */
export const accountSnapshotVersion = Symbol("accountSnapshotVersion");

export class AuthStorage implements CredentialStore {
	private data: AuthStorageData = {};
	private loadedVersion: string | undefined;
	private generation = 0;
	private storage: AuthStorageBackend;
	private reads: AsyncAuthStorageReads;

	private constructor(storage: AuthStorageBackend) {
		this.storage = storage;
		this.reads = asyncAuthStorageReads(storage);
	}

	static create(authPath?: string | string[]): AuthStorage {
		return AuthStorage.fromStorage(AuthStorage.fileBackend(authPath));
	}

	static async createAsync(authPath?: string | string[]): Promise<AuthStorage> {
		const storage = new AuthStorage(AuthStorage.fileBackend(authPath));
		await storage.reloadAsync();
		return storage;
	}

	private static fileBackend(authPath: string | string[] | undefined): FileAuthStorageBackend {
		const paths =
			authPath === undefined ? getAgentConfigPaths("auth.json") : Array.isArray(authPath) ? authPath : [authPath];
		return new FileAuthStorageBackend(paths[0] ?? join(getAgentDir(), "auth.json"), paths);
	}

	static fromStorage(storage: AuthStorageBackend): AuthStorage {
		const authStorage = new AuthStorage(storage);
		authStorage.reload();
		return authStorage;
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
		return normalizeProviderKeys(JSON.parse(stripBom(content)) as AuthStorageData);
	}

	private readStorageContent(): string | undefined {
		if (this.storage.read) return this.storage.read();
		let content: string | undefined;
		this.storage.withLock((current) => {
			content = current;
			return { result: undefined };
		});
		return content;
	}

	private async readStorageContentAsync(): Promise<string | undefined> {
		if (this.reads.readAsync) return this.reads.readAsync();
		let content: string | undefined;
		await this.storage.withLockAsync(async (current) => {
			content = current;
			return { result: undefined };
		});
		return content;
	}

	/**
	 * Reload credentials from storage.
	 */
	reload(): void {
		this.loadFromStorage(this.readStorageVersion());
	}

	async reloadAsync(): Promise<void> {
		const generation = this.generation;
		await this.loadFromStorageAsync(await this.readStorageVersionAsync(), generation);
	}

	reloadIfChanged(): boolean {
		if (!this.storage.version && !this.storage.read) return false;
		const version = this.readStorageVersion();
		if (version !== undefined && version === this.loadedVersion) return false;
		return this.loadFromStorage(version);
	}

	async reloadIfChangedAsync(): Promise<boolean> {
		if (!this.reads.versionAsync && !this.reads.readAsync) return false;
		const generation = this.generation;
		const version = await this.readStorageVersionAsync();
		if (version !== undefined && version === this.loadedVersion) return false;
		return this.loadFromStorageAsync(version, generation);
	}

	private readStorageVersion(): string | undefined {
		try {
			return this.storage.version?.();
		} catch {
			return undefined;
		}
	}

	private async readStorageVersionAsync(): Promise<string | undefined> {
		try {
			return await this.reads.versionAsync?.();
		} catch {
			return undefined;
		}
	}

	private loadFromStorage(version: string | undefined): boolean {
		try {
			return this.applyStorageContent(version, this.readStorageContent());
		} catch (error) {
			if (error instanceof SyntaxError) this.loadedVersion = version;
			return false;
		}
	}

	private async loadFromStorageAsync(version: string | undefined, generation: number): Promise<boolean> {
		try {
			const content = await this.readStorageContentAsync();
			if (generation !== this.generation) return false;
			return this.applyStorageContent(version, content);
		} catch (error) {
			if (error instanceof SyntaxError && generation === this.generation) this.loadedVersion = version;
			return false;
		}
	}

	private applyStorageContent(version: string | undefined, content: string | undefined): boolean {
		const next = this.parseStorageData(content);
		this.loadedVersion = version;
		if (isDeepStrictEqual(next, this.data)) return false;
		this.data = next;
		this.generation++;
		return true;
	}

	[accountSnapshotVersion](): string | null | undefined {
		if (this.storage instanceof InMemoryAuthStorageBackend) return undefined;
		if (!(this.storage instanceof FileAuthStorageBackend)) return null;
		const version = this.readStorageVersion();
		return version !== undefined && version === this.loadedVersion ? version : null;
	}

	/** Read the current in-memory credential snapshot without triggering refresh or I/O. */
	peek(provider: string): Credential | undefined {
		return this.data[normalizeProviderId(provider)];
	}

	async read(provider: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		await this.reloadIfChangedAsync();
		const credential = this.peek(provider);
		if (credential?.type !== "api_key") return credential;
		if (credential.key === undefined) return credential;
		return { ...credential, key: await resolveConfigValueAsync(credential.key, credential.env) };
	}

	async modify(
		provider: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		provider = normalizeProviderId(provider);
		const signal = options?.signal;
		signal?.throwIfAborted();
		if (this.storage.modifyProviderAsync) {
			const operation = this.storage.modifyProviderAsync(
				provider,
				async (current) => {
					signal?.throwIfAborted();
					const pending = fn(current);
					const next = signal === undefined ? await pending : await raceWithAbortSignal(pending, signal);
					signal?.throwIfAborted();
					return next;
				},
				signal,
			);
			const snapshot = signal === undefined ? await operation : await raceWithAbortSignal(operation, signal);
			this.data = this.parseStorageData(snapshot.next);
			if (snapshot.result !== undefined) this.data[provider] = snapshot.result;
			this.loadedVersion = undefined;
			this.generation++;
			return snapshot.result;
		}
		let persistedData: AuthStorageData | undefined;
		const operation = this.storage.withLockAsync(async (content) => {
			signal?.throwIfAborted();
			const currentData = this.parseStorageData(content);
			const pending = fn(currentData[provider]);
			const next = signal === undefined ? await pending : await raceWithAbortSignal(pending, signal);
			signal?.throwIfAborted();
			if (next === undefined) {
				persistedData = currentData;
				return { result: currentData[provider] };
			}

			const merged: AuthStorageData = { ...currentData, [provider]: next };
			persistedData = merged;
			return { result: next, next: JSON.stringify(merged, null, 2) };
		});
		const result = signal === undefined ? await operation : await raceWithAbortSignal(operation, signal);
		if (persistedData) this.data = persistedData;
		this.loadedVersion = undefined;
		this.generation++;
		return result;
	}

	async delete(provider: string): Promise<void> {
		provider = normalizeProviderId(provider);
		if (this.storage.deleteProviderAsync) {
			if (provider === "azure") await this.storage.deleteProviderAsync(LEGACY_AZURE_PROVIDER);
			const content = await this.storage.deleteProviderAsync(provider);
			this.data = this.parseStorageData(content);
			this.loadedVersion = undefined;
			this.generation++;
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
		this.loadedVersion = undefined;
		this.generation++;
	}

	/** List credential metadata without resolving configured key values. */
	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		options?.signal?.throwIfAborted();
		await this.reloadIfChangedAsync();
		return Object.entries(this.data).map(([providerId, credential]) => ({ providerId, type: credential.type }));
	}
}

/**
 * Read credentials without acquiring a lock, creating auth.json, or allowing a
 * refresh to persist a mutation. `auth check --no-refresh` uses this store.
 * It resolves configured key values, including `!command`, like `AuthStorage`.
 * Unlike `AuthStorage.reload()`, malformed data fails closed so the probe can
 * report invalid auth state instead of silently treating it as no credentials.
 */
export class ReadOnlyAuthStorage implements CredentialStore {
	private data: AuthStorageData | undefined;
	private readonly storage: FileAuthStorageBackend;

	constructor(authPath?: string | string[]) {
		const paths =
			authPath === undefined ? getAgentConfigPaths("auth.json") : Array.isArray(authPath) ? authPath : [authPath];
		this.storage = new FileAuthStorageBackend(paths[0] ?? join(getAgentDir(), "auth.json"), paths);
	}

	private load(): AuthStorageData {
		if (this.data !== undefined) return this.data;
		let content: string | undefined;
		try {
			content = this.storage.read();
		} catch (error) {
			throw readFailure(error);
		}
		this.data = parseReadOnlyAuth(content);
		return this.data;
	}

	private async loadAsync(): Promise<AuthStorageData> {
		if (this.data !== undefined) return this.data;
		let content: string | undefined;
		try {
			content = await this.storage.readAsync();
		} catch (error) {
			throw readFailure(error);
		}
		this.data ??= parseReadOnlyAuth(content);
		return this.data;
	}

	/** Raw configured values for privacy screening; never execute API-key commands. */
	peek(providerId: string): Credential | undefined {
		return this.load()[normalizeProviderId(providerId)];
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		const credential = (await this.loadAsync())[normalizeProviderId(providerId)];
		options?.signal?.throwIfAborted();
		if (!credential) return undefined;
		if (credential.type !== "api_key" || credential.key === undefined) {
			return structuredClone(credential);
		}
		return { ...credential, key: await resolveConfigValueAsync(credential.key, credential.env) };
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		options?.signal?.throwIfAborted();
		const credentials = Object.entries(await this.loadAsync()).map(([providerId, credential]) => ({
			providerId,
			type: credential.type,
		}));
		options?.signal?.throwIfAborted();
		return credentials;
	}

	async modify(
		_providerId: string,
		_fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		_options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		throw new Error("Read-only credential storage cannot modify auth.json");
	}

	async delete(_providerId: string, _options?: AuthOperationOptions): Promise<void> {
		throw new Error("Read-only credential storage cannot modify auth.json");
	}
}

function readFailure(error: unknown): Error {
	return new Error(`Failed to read auth.json: ${error instanceof Error ? error.message : String(error)}`);
}

function parseReadOnlyAuth(content: string | undefined): AuthStorageData {
	let parsed: unknown;
	try {
		parsed = content === undefined ? {} : JSON.parse(stripBom(content));
	} catch (error) {
		throw readFailure(error);
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Invalid auth.json: expected an object");
	}
	for (const [providerId, credential] of Object.entries(parsed)) {
		if (typeof credential !== "object" || credential === null || Array.isArray(credential)) {
			throw new Error(`Invalid auth.json credential for provider "${providerId}"`);
		}
		const value = credential as Record<string, unknown>;
		if (value.type === "api_key") {
			const env = value.env;
			const validKey = value.key === undefined || typeof value.key === "string";
			const validEnv =
				env === undefined ||
				(typeof env === "object" &&
					env !== null &&
					!Array.isArray(env) &&
					Object.values(env).every((entry) => typeof entry === "string"));
			if (validKey && validEnv) continue;
		} else if (
			value.type === "oauth" &&
			typeof value.access === "string" &&
			typeof value.refresh === "string" &&
			typeof value.expires === "number" &&
			Number.isFinite(value.expires)
		) {
			continue;
		}
		throw new Error(`Invalid auth.json credential for provider "${providerId}"`);
	}
	return normalizeProviderKeys(parsed as AuthStorageData);
}

/** Read one persisted provider credential using Atomic's layered auth.json paths. */
export function readStoredCredential(providerId: string, authPath?: string | string[]): Credential | undefined {
	const paths =
		authPath === undefined ? getAgentConfigPaths("auth.json") : Array.isArray(authPath) ? authPath : [authPath];
	const storage = new FileAuthStorageBackend(paths[0] ?? join(getAgentDir(), "auth.json"), paths);
	try {
		let credential: Credential | undefined;
		storage.withLock((content) => {
			credential = content
				? normalizeProviderKeys(JSON.parse(stripBom(content)) as AuthStorageData)[normalizeProviderId(providerId)]
				: undefined;
			return { result: undefined };
		});
		return credential;
	} catch {
		return undefined;
	}
}
