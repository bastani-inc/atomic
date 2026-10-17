import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import type { SqliteDatabase, SqliteValue, StorageDescriptor } from "./database.js";
import {
	StorageAdapterLoadError,
	StorageConfigError,
	StorageError,
	type StorageFailureCause,
	StorageUnavailableError,
} from "./errors.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { validateStoragePrefix } from "./prefix.js";
import type { RunJournal } from "./run-journal.js";
import { selectStorage } from "./selection.js";
import type { SessionStore } from "./session/types.js";

export type SecretRef = { readonly env: string } | { readonly file: string };
export type AdapterOptions = Readonly<Record<string, SqliteValue | boolean>>;
export type StorageSelection =
	| { readonly kind: "memory" }
	| { readonly kind: "jsonl"; readonly dir: string }
	| { readonly kind: "sqlite"; readonly path: string; readonly prefix?: string }
	| { readonly kind: "database"; readonly database: SqliteDatabase; readonly prefix?: string }
	| {
			readonly kind: "adapter";
			readonly module: string;
			readonly options?: AdapterOptions;
			readonly secrets?: Readonly<Record<string, SecretRef>>;
			readonly prefix?: string;
	  };
export interface StorageOpenContext {
	readonly agentDir: string;
	readonly domain: "sessions" | "journal";
	readonly signal?: AbortSignal;
}
export interface StorageAdapterModule {
	readonly atomicStorageAdapter: 1;
	openDatabase?(options: AdapterOptions, context: StorageOpenContext): Promise<SqliteDatabase>;
	openSessionStore?(
		options: AdapterOptions,
		context: StorageOpenContext,
		storage: { readonly prefix?: string },
	): Promise<SessionStore>;
	openRunJournal?(
		options: AdapterOptions,
		context: StorageOpenContext,
		storage: { readonly prefix?: string },
	): Promise<RunJournal>;
}
export interface JournalFactories {
	memory(descriptor: StorageDescriptor): RunJournal;
	sql(database: SqliteDatabase, options: { readonly prefix?: string }): Promise<RunJournal>;
}

const databaseIds = new WeakMap<SqliteDatabase, number>();
let nextDatabaseId = 0;

function storageOptionKey(
	value: SqliteValue | boolean,
): readonly [string, string | boolean | readonly number[] | null] {
	if (value instanceof Uint8Array) return ["bytes", Array.from(value)];
	if (value === null) return ["null", null];
	if (typeof value === "number") return ["number", Object.is(value, -0) ? "-0" : String(value)];
	if (typeof value === "bigint") return ["bigint", String(value)];
	return [typeof value, value];
}

export function storageSelectionKey(selection: StorageSelection, agentDir?: string): string {
	if (selection.kind === "database") {
		let id = databaseIds.get(selection.database);
		if (id === undefined) {
			id = ++nextDatabaseId;
			databaseIds.set(selection.database, id);
		}
		return JSON.stringify(["database", id, selection.prefix ?? ""]);
	}
	if (selection.kind === "sqlite") {
		const path = selection.path === "" || selection.path === ":memory:" ? selection.path : resolve(selection.path);
		return JSON.stringify(["sqlite", path, selection.prefix ?? ""]);
	}
	if (selection.kind === "adapter") {
		const options = Object.entries(selection.options ?? {})
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([name, value]) => [name, storageOptionKey(value)]);
		const secrets = Object.entries(selection.secrets ?? {}).sort(([a], [b]) => a.localeCompare(b));
		return JSON.stringify(["adapter", agentDir, selection.module, options, secrets, selection.prefix ?? ""]);
	}
	return JSON.stringify(selection);
}

export async function loadStorageAdapter(module: string, context: StorageOpenContext): Promise<StorageAdapterModule> {
	try {
		const loader = createJiti(pathToFileURL(join(context.agentDir, "storage-adapter.js")).href, {
			interopDefault: true,
		});
		const adapter = await loader.import<StorageAdapterModule>(module, { default: true });
		if (
			adapter === null ||
			typeof adapter !== "object" ||
			adapter.atomicStorageAdapter !== 1 ||
			[adapter.openDatabase, adapter.openSessionStore, adapter.openRunJournal].some(
				(hook) => hook !== undefined && typeof hook !== "function",
			)
		) {
			throw new StorageConfigError("sdk", "adapter", "invalid-module-contract");
		}
		return adapter;
	} catch (cause) {
		throw new StorageAdapterLoadError(module, cause as StorageFailureCause);
	}
}

async function adapterOptions(
	selection: Extract<StorageSelection, { kind: "adapter" }>,
	context: StorageOpenContext,
): Promise<AdapterOptions> {
	const options = { ...selection.options };
	for (const [name, ref] of Object.entries(selection.secrets ?? {})) {
		let value: string;
		if ("env" in ref) {
			const environment = process.env[ref.env];
			if (environment === undefined) throw new StorageConfigError("sdk", `secrets.${name}`, "secret-env-missing");
			value = environment;
		} else {
			try {
				value = await readFile(isAbsolute(ref.file) ? ref.file : join(dirname(context.agentDir), ref.file), "utf8");
			} catch (cause) {
				throw new StorageUnavailableError(
					{ adapter: selection.module, location: ref.file },
					cause as StorageFailureCause,
				);
			}
		}
		Object.defineProperty(options, name, { value, enumerable: true, writable: true, configurable: true });
	}
	return options;
}

function withIdempotentClose<T extends { close(): Promise<void> }>(store: T, release?: () => Promise<void>): T {
	const close = store.close.bind(store);
	let closing: Promise<void> | undefined;
	store.close = () => {
		closing ??= (async () => {
			try {
				await close();
			} finally {
				await release?.();
			}
		})();
		return closing;
	};
	return store;
}

interface SharedDatabase {
	readonly ready: Promise<SqliteDatabase>;
	references: number;
}

const sharedDatabases = new Map<string, SharedDatabase>();

export interface StorageProvider {
	openSessionStore(selection: StorageSelection, context: StorageOpenContext): Promise<SessionStore>;
	openRunJournal(selection: StorageSelection, context: StorageOpenContext): Promise<RunJournal>;
}

export const StorageProvider: new (journals?: JournalFactories) => StorageProvider = class {
	private readonly journals?: JournalFactories;
	private readonly databases = sharedDatabases;

	constructor(journals?: JournalFactories) {
		this.journals = journals;
	}

	async openSessionStore(selection: StorageSelection, context: StorageOpenContext): Promise<SessionStore> {
		return this.open<SessionStore>(selection, context, {
			memory: async () => new (await import("./session/memory-session-store.js")).MemorySessionStore(),
			jsonl: async (dir) =>
				(await import("./session/jsonl-session-store.js")).JsonlSessionStore.open(dir, { exactDirectory: true }),
			direct: (adapter, options, storage) => adapter.openSessionStore?.(options, context, storage),
			sql: async (database, options) =>
				(await import("./session/sql-session-store.js")).SqlSessionStore.open(database, options),
		});
	}

	async openRunJournal(selection: StorageSelection, context: StorageOpenContext): Promise<RunJournal> {
		const journals = this.journals;
		if (!journals) throw new StorageConfigError("sdk", "journal", "adapter-domain-unsupported");
		return this.open<RunJournal>(selection, context, {
			memory: () => journals.memory({ adapter: "memory", location: ":memory:" }),
			direct: (adapter, options, storage) => adapter.openRunJournal?.(options, context, storage),
			sql: async (database, options) => {
				const journal = await journals.sql(database, options);
				const createRun = journal.createRun.bind(journal);
				journal.createRun = (header) => createRun({ ...header, storage: { ...database.descriptor } });
				return journal;
			},
		});
	}

	private async open<T extends { close(): Promise<void> }>(
		selection: StorageSelection,
		context: StorageOpenContext,
		factories: {
			memory(): T | Promise<T>;
			jsonl?(dir: string): Promise<T>;
			direct(
				adapter: StorageAdapterModule,
				options: AdapterOptions,
				storage: { readonly prefix?: string },
			): Promise<T> | undefined;
			sql(database: SqliteDatabase, options: { readonly prefix?: string }): Promise<T>;
		},
	): Promise<T> {
		if (selection === null || typeof selection !== "object" || Array.isArray(selection)) {
			throw new StorageConfigError("sdk", "storage", "selection-object-required");
		}
		if (!["memory", "jsonl", "sqlite", "database", "adapter"].includes(selection.kind)) {
			throw new StorageConfigError("sdk", "storage", "invalid-kind");
		}
		const selector = { memory: undefined, jsonl: "dir", sqlite: "path", database: "database", adapter: "module" }[
			selection.kind
		];
		if (
			["path", "dir", "database", "module", "memory", "adapter"].some((key) => key in selection && key !== selector)
		) {
			throw new StorageConfigError("sdk", "storage", "multiple-selection-forms");
		}
		if (selection.kind === "sqlite" && typeof selection.path !== "string") {
			throw new StorageConfigError("sdk", "storage", "invalid-path");
		}
		if (selection.kind === "adapter" && (typeof selection.module !== "string" || selection.module.length === 0)) {
			throw new StorageConfigError("sdk", "storage", "invalid-adapter");
		}
		if (selection.kind === "database" && !("database" in selection)) {
			throw new StorageConfigError("sdk", "storage", "async-database-required");
		}
		if (selection.kind === "sqlite" || selection.kind === "database" || selection.kind === "adapter") {
			selectStorage(
				selection.kind === "adapter" ? { ...selection, adapter: selection.module } : selection,
				"sdk",
				"storage",
				"",
			);
		}
		if (selection.kind === "memory") return withIdempotentClose(await factories.memory());
		if (selection.kind === "jsonl") {
			if (typeof selection.dir !== "string") throw new StorageConfigError("sdk", "dir", "invalid-dir");
			if (factories.jsonl) return withIdempotentClose(await factories.jsonl(selection.dir));
			throw new StorageConfigError("sdk", "dir", "adapter-domain-unsupported");
		}
		validateStoragePrefix(selection.prefix);
		let openDatabase: () => Promise<SqliteDatabase>;
		if (selection.kind === "adapter") {
			const adapter = await loadStorageAdapter(selection.module, context);
			const options = await adapterOptions(selection, context);
			try {
				const direct = factories.direct(adapter, options, { prefix: selection.prefix });
				if (direct !== undefined) return withIdempotentClose(await direct);
			} catch (cause) {
				if (cause instanceof StorageError) throw cause;
				throw new StorageUnavailableError(
					{ adapter: selection.module, location: selection.module },
					cause as StorageFailureCause,
				);
			}
			if (!adapter.openDatabase) throw new StorageConfigError("sdk", "adapter", "adapter-domain-unsupported");
			const hook = adapter.openDatabase.bind(adapter);
			openDatabase = async () => {
				try {
					return await hook(options, context);
				} catch (cause) {
					if (cause instanceof StorageError) throw cause;
					throw new StorageUnavailableError(
						{ adapter: selection.module, location: selection.module },
						cause as StorageFailureCause,
					);
				}
			};
		} else if (selection.kind === "database") {
			return withIdempotentClose(await factories.sql(selection.database, { prefix: selection.prefix }));
		} else {
			openDatabase = () => openNodeSqliteDatabase(selection.path);
		}
		const key = storageSelectionKey({ ...selection, prefix: undefined }, context.agentDir);
		let shared = this.databases.get(key);
		if (!shared) {
			shared = { ready: openDatabase(), references: 0 };
			this.databases.set(key, shared);
		}
		shared.references++;
		const entry = shared;
		let database: SqliteDatabase;
		try {
			database = await entry.ready;
		} catch (cause) {
			if (this.databases.get(key) === entry) this.databases.delete(key);
			throw cause;
		}
		const release = async () => {
			if (--entry.references === 0) {
				if (this.databases.get(key) === entry) this.databases.delete(key);
				await database.close();
			}
		};
		try {
			return withIdempotentClose(await factories.sql(database, { prefix: selection.prefix }), release);
		} catch (cause) {
			try {
				await release();
			} catch (cleanupCause) {
				const openingError =
					cause instanceof Error
						? cause
						: new StorageUnavailableError(database.descriptor, cause as StorageFailureCause);
				Object.defineProperty(openingError, "cleanupCause", { value: cleanupCause, configurable: true });
				throw openingError;
			}
			throw cause;
		}
	}
};
