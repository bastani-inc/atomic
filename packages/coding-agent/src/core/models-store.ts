import type { ModelsStore, ModelsStoreEntry } from "@earendil-works/pi-ai";
import { join } from "node:path";
import { getAgentDir } from "../config.ts";
import { FileAuthStorageBackend, type AuthStorageBackend } from "./auth-storage-backends.ts";

type StoredModels = Record<string, ModelsStoreEntry>;

export interface CodingAgentModelsStore extends ModelsStore {
	writeIf(providerId: string, entry: ModelsStoreEntry, predicate: () => boolean): Promise<void>;
	deleteIf(providerId: string, predicate: () => boolean): Promise<void>;
}

export class InMemoryCodingAgentModelsStore implements CodingAgentModelsStore {
	private readonly entries = new Map<string, ModelsStoreEntry>();

	async read(providerId: string): Promise<ModelsStoreEntry | undefined> {
		const entry = this.entries.get(providerId);
		return entry === undefined ? undefined : structuredClone(entry);
	}

	async write(providerId: string, entry: ModelsStoreEntry): Promise<void> {
		this.entries.set(providerId, structuredClone(entry));
	}

	async delete(providerId: string): Promise<void> {
		this.entries.delete(providerId);
	}

	async writeIf(providerId: string, entry: ModelsStoreEntry, predicate: () => boolean): Promise<void> {
		if (predicate()) await this.write(providerId, entry);
	}

	async deleteIf(providerId: string, predicate: () => boolean): Promise<void> {
		if (predicate()) await this.delete(providerId);
	}
}

/** Locked JSON-backed storage for dynamically refreshed provider catalogs. */
export class FileModelsStore implements CodingAgentModelsStore {
	private readonly storage: AuthStorageBackend;

	constructor(path: string = join(getAgentDir(), "models-store.json")) {
		this.storage = new FileAuthStorageBackend(path);
	}

	private parse(content: string | undefined): StoredModels {
		return content ? (JSON.parse(content) as StoredModels) : {};
	}

	async read(providerId: string): Promise<ModelsStoreEntry | undefined> {
		return this.storage.withLock((content) => ({
			result: structuredClone(this.parse(content)[providerId]),
		}));
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

	async writeIf(providerId: string, entry: ModelsStoreEntry, predicate: () => boolean): Promise<void> {
		await this.storage.withLockAsync(async (content) => {
			if (!predicate()) return { result: undefined };
			const current = this.parse(content);
			current[providerId] = structuredClone(entry);
			return { result: undefined, next: JSON.stringify(current, null, 2) };
		});
	}

	async deleteIf(providerId: string, predicate: () => boolean): Promise<void> {
		await this.storage.withLockAsync(async (content) => {
			if (!predicate()) return { result: undefined };
			const current = this.parse(content);
			delete current[providerId];
			return { result: undefined, next: JSON.stringify(current, null, 2) };
		});
	}
}
