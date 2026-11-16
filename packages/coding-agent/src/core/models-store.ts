import { join } from "node:path";
import type { ModelsStore, ModelsStoreEntry } from "@bastani/atomic-ai";
import { getAgentDir } from "../config.js";
import { stripBom } from "../utils/text.ts";
import { type AuthStorageBackend, FileAuthStorageBackend } from "./auth-storage-backends.ts";

type StoredModels = Record<string, ModelsStoreEntry>;

export class InMemoryCodingAgentModelsStore implements ModelsStore {
	private readonly entries = new Map<string, ModelsStoreEntry>();

	async read(providerId: string): Promise<ModelsStoreEntry | undefined> {
		return this.entries.get(providerId);
	}

	async write(providerId: string, entry: ModelsStoreEntry): Promise<void> {
		this.entries.set(providerId, entry);
	}

	async delete(providerId: string): Promise<void> {
		this.entries.delete(providerId);
	}
}

/** Locked JSON-backed storage for dynamically refreshed provider catalogs. */
export class FileModelsStore implements ModelsStore {
	private readonly storage: AuthStorageBackend;
	/** The file as last parsed, and the version (device, inode, size, mtime and ctime) it was parsed at. */
	private parsed: { readonly version: string; readonly models: StoredModels } | undefined;

	constructor(path: string = join(getAgentDir(), "models-store.json")) {
		this.storage = new FileAuthStorageBackend(path);
	}

	private parse(content: string | undefined): StoredModels {
		return content ? (JSON.parse(stripBom(content)) as StoredModels) : {};
	}

	/**
	 * Reads take no lock: writers replace the file atomically, so a read sees a complete previous or next file. A
	 * refresh reads every provider's entry in turn; the file is parsed again only once its version changed, as any
	 * write does (a replacement is a new inode, an edit in place moves its ctime).
	 */
	async read(providerId: string): Promise<ModelsStoreEntry | undefined> {
		const read = this.storage.read;
		const version = this.storage.version;
		if (!read || !version) {
			return this.storage.withLock((content) => ({ result: structuredClone(this.parse(content)[providerId]) }));
		}
		const current = version.call(this.storage);
		if (this.parsed?.version !== current)
			this.parsed = { version: current, models: this.parse(read.call(this.storage)) };
		return structuredClone(this.parsed.models[providerId]);
	}

	async write(providerId: string, entry: ModelsStoreEntry): Promise<void> {
		await this.storage.withLockAsync(async (content) => {
			const current = this.parse(content);
			current[providerId] = structuredClone(entry);
			return { result: undefined, next: JSON.stringify(current, null, 2) };
		});
	}

	async delete(providerId: string): Promise<void> {
		await this.storage.withLockAsync(async (content) => {
			const current = this.parse(content);
			delete current[providerId];
			return { result: undefined, next: JSON.stringify(current, null, 2) };
		});
	}
}
