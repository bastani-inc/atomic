import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelsStore, ModelsStoreEntry } from "@bastani/atomic-ai";
import { getAgentDir } from "../config.js";
import { normalizePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";
import { type AuthStorageBackend, FileAuthStorageBackend } from "./auth-storage-backends.ts";
import { normalizeProviderKeys } from "./azure-provider-compat.js";

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
	private readonly path: string;
	private readonly storage: AuthStorageBackend;
	/**
	 * The file's text as last read, and its parse. The parse is reused only for the same text: a save can leave the
	 * file's size, inode number and times as they were (two saves within one coarse timestamp tick can give the second
	 * file the inode number the first freed), but never its text.
	 */
	private parsed: { readonly text: string | undefined; readonly models: StoredModels } | undefined;

	constructor(path: string = join(getAgentDir(), "models-store.json")) {
		this.path = normalizePath(path);
		this.storage = new FileAuthStorageBackend(path);
	}

	private parse(content: string | undefined): StoredModels {
		return content ? (JSON.parse(stripBom(content)) as StoredModels) : {};
	}

	/**
	 * Reads take no lock: writers replace the file atomically, so a read sees a complete previous or next file. A
	 * refresh reads every provider's entry in turn; each read reads the file, and parses it again only when its text
	 * changed. Provider ids are canonicalized as a locked read of the file canonicalizes them.
	 */
	async read(providerId: string): Promise<ModelsStoreEntry | undefined> {
		const text = await readTextIfPresent(this.path);
		if (!this.parsed || this.parsed.text !== text) {
			this.parsed = { text, models: text ? normalizeProviderKeys(this.parse(text)) : {} };
		}
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

async function readTextIfPresent(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}
