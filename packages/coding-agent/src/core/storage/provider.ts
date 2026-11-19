import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Jiti, JitiResolveOptions } from "jiti";
import { createSessionCwdMatcherAsync } from "../../utils/canonical-path.ts";
import { pathExists } from "../../utils/path-exists.ts";
import { abortSnapshotCollectionsOn, runningSnapshotCollectionsOn } from "../worktree-snapshot/blob-store.ts";
import type { SqliteDatabase, SqliteValue } from "./database.js";
import {
	StorageAdapterLoadError,
	StorageConfigError,
	StorageError,
	type StorageFailureCause,
	StorageUnavailableError,
	StoreClosedError,
} from "./errors.js";
import { storageHomeDir, storageHomeDirAsync } from "./file-identity.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { validateStoragePrefix } from "./prefix.js";
import type { InMemorySecretRef } from "./selection.js";
import { selectStorage } from "./selection.js";
import type { SessionStore } from "./session/types.js";

/**
 * Where an adapter option's secret comes from: an environment variable, a file, or (SDK only) a value held in this
 * process's memory, which is never serialized; see {@link inMemorySecret}.
 */
export type SecretRef = { readonly env: string } | { readonly file: string } | InMemorySecretRef;

interface RelativeSecretPaths {
	readonly home: string;
	readonly agentDir: string;
	readonly cwd: string | undefined;
	readonly file: string;
	readonly primary: string;
	readonly legacy: string;
	readonly managedLegacyToken: boolean;
}

let lastRelativeSecretPaths: RelativeSecretPaths | undefined;

/** Where a `secrets` `{ file }` reference points: an absolute path, or a path relative to Atomic home. */
export function secretFilePath(file: string, agentDir: string): string {
	if (isAbsolute(file)) return file;
	const paths = relativeSecretPaths(file, agentDir, storageHomeDir(agentDir));
	if (paths.primary === paths.legacy) return paths.primary;
	if (!existsSync(paths.legacy) && !paths.managedLegacyToken) return paths.primary;
	return existsSync(paths.primary) ? paths.primary : paths.legacy;
}

export async function secretFilePathAsync(file: string, agentDir: string): Promise<string> {
	if (isAbsolute(file)) return file;
	const paths = relativeSecretPaths(file, agentDir, await storageHomeDirAsync(agentDir));
	if (paths.primary === paths.legacy) return paths.primary;
	if (!(await pathExists(paths.legacy)) && !paths.managedLegacyToken) return paths.primary;
	return (await pathExists(paths.primary)) ? paths.primary : paths.legacy;
}

function relativeSecretPaths(file: string, agentDir: string, home: string): RelativeSecretPaths {
	const cwd = isAbsolute(agentDir) ? undefined : process.cwd();
	let paths = lastRelativeSecretPaths;
	if (
		paths === undefined ||
		paths.home !== home ||
		paths.agentDir !== agentDir ||
		paths.cwd !== cwd ||
		paths.file !== file
	) {
		const resolvedAgentDir = resolve(agentDir);
		const legacy = join(dirname(resolvedAgentDir), file);
		const sameDir =
			process.platform === "win32"
				? resolve(dirname(legacy)).toLowerCase() === resolvedAgentDir.toLowerCase()
				: resolve(dirname(legacy)) === resolvedAgentDir;
		paths = {
			home,
			agentDir,
			cwd,
			file,
			primary: join(home, file),
			legacy,
			managedLegacyToken: sameDir && basename(legacy).startsWith("storage-token."),
		};
		lastRelativeSecretPaths = paths;
	}
	return paths;
}
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
	/** `intercom`: the shared Intercom broker state that multi-node brokers open on the top-level selection. */
	readonly domain: "sessions" | "intercom";
	readonly signal?: AbortSignal;
	/**
	 * Reads the selection's `secrets[name]` reference again, on every call: a file rotated in place yields its new
	 * contents. The provider passes it to adapter hooks; it is how an adapter reads its `liveSecrets`.
	 */
	readonly secret?: (name: string) => Promise<string>;
}
export interface StorageAdapterModule {
	readonly atomicStorageAdapter: 1;
	/**
	 * Secrets the adapter reads itself through `context.secret(name)`, every time it needs them (for example once per
	 * new connection), instead of once in `options`. The provider leaves these names out of `options`.
	 */
	readonly liveSecrets?: readonly string[];
	openDatabase?(options: AdapterOptions, context: StorageOpenContext): Promise<SqliteDatabase>;
	openSessionStore?(
		options: AdapterOptions,
		context: StorageOpenContext,
		storage: { readonly prefix?: string },
	): Promise<SessionStore>;
}

const databaseIds = new WeakMap<SqliteDatabase, number>();
let nextDatabaseId = 0;
const secretIds = new WeakMap<InMemorySecretRef, number>();
let nextSecretId = 0;

/** An in-memory secret keys by identity, never by its value. */
function secretId(secret: InMemorySecretRef): number {
	let id = secretIds.get(secret);
	if (id === undefined) {
		id = ++nextSecretId;
		secretIds.set(secret, id);
	}
	return id;
}

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
		const secrets = Object.entries(selection.secrets ?? {})
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([name, ref]) => [name, "value" in ref ? { value: secretId(ref) } : ref]);
		return JSON.stringify(["adapter", agentDir, selection.module, options, secrets, selection.prefix ?? ""]);
	}
	return JSON.stringify(selection);
}

/** Virtual module through which transformed adapter modules make their imports. */
const ADAPTER_IMPORTS = "atomic:storage-adapter-imports";
/**
 * Appended to every module the adapter loader transforms. The hoisted declaration replaces the `jitiImport` that jiti
 * passes each module, so the module's static and dynamic imports reach {@link createAdapterImports} with its own loader
 * and the importing module's filename.
 */
const ADAPTER_IMPORT_HOOK = `\nfunction jitiImport(id, options) { return require(${JSON.stringify(ADAPTER_IMPORTS)}).import(require, id, options, __filename); }\n`;

/** Whether Node loads a file as ESM: jiti imports such files natively, outside the loader's host modules. */
function isNativeEsm(filename: string): boolean {
	if (filename.endsWith(".mjs")) return true;
	if (!filename.endsWith(".js")) return false;
	for (let directory = dirname(filename); ; directory = dirname(directory)) {
		const manifest = join(directory, "package.json");
		if (existsSync(manifest)) {
			const { type } = JSON.parse(readFileSync(manifest, "utf8")) as { type?: string };
			return type === "module";
		}
		if (directory === dirname(directory)) return false;
	}
}

interface AdapterImports {
	import(jiti: Jiti, id: string, options: JitiResolveOptions | undefined, importer: string): Promise<object>;
}

/**
 * Evaluates the ESM files an adapter module imports by path through the adapter loader, once per load, so their own
 * imports get the host modules too. Package imports, such as an adapter's driver, load as jiti loads them. A module
 * imported again waits for its evaluation, top-level `await` included, unless the importer is part of that evaluation:
 * an import cycle gets the partly evaluated module, as it would natively. Other files imported by path load as jiti
 * loads them, but still count as part of their importer's evaluation, so cycles through them are detected too.
 * Filenames are jiti's resolved paths, the keys of its module cache.
 */
function createAdapterImports(): AdapterImports {
	const evaluations = new Map<string, Promise<object>>();
	const awaiting = new Map<string, Set<string>>();
	const awaits = (importer: string, filename: string, seen = new Set<string>()): boolean => {
		if (importer === filename) return true;
		if (seen.has(importer)) return false;
		seen.add(importer);
		return [...(awaiting.get(importer) ?? [])].some((next) => awaits(next, filename, seen));
	};
	const wait = async (importer: string, filename: string, load: () => Promise<object>): Promise<object> => {
		const pending = awaiting.get(importer) ?? new Set<string>();
		awaiting.set(importer, pending.add(filename));
		try {
			return await load();
		} finally {
			pending.delete(filename);
		}
	};
	return {
		import(jiti, id, options, importer) {
			const byPath = id.startsWith(".") || id.startsWith("file:") || isAbsolute(id);
			const filename = byPath ? jiti.resolve(id) : undefined;
			if (filename === undefined) return jiti.import<object>(id, options);
			if (!isNativeEsm(filename)) return wait(importer, filename, () => jiti.import<object>(id, options));
			const evaluation = evaluations.get(filename);
			if (evaluation === undefined) {
				const source = readFileSync(filename, "utf8");
				const started = Promise.resolve().then(
					() => jiti.evalModule(source, { filename, async: true, forceTranspile: true }) as Promise<object>,
				);
				evaluations.set(filename, started);
				return wait(importer, filename, () => started);
			}
			if (awaits(filename, importer)) return jiti.import<object>(id, options);
			return wait(importer, filename, () => evaluation);
		},
	};
}

/**
 * Loads an adapter module the way the extension loader loads extensions: `@bastani/atomic/storage` (and
 * `@bastani/atomic`) resolve to this host's own modules, so adapters need no installed copy of Atomic and share its
 * error classes. `hostModules` adds live modules by specifier. The ES module and TypeScript files the adapter imports
 * by path get the same host modules; nested CommonJS files resolve them from `node_modules`. A package name selects an
 * adapter listed by an installed Atomic package; other specifiers, and package names no installed package lists,
 * resolve from the agent directory.
 */
export async function loadStorageAdapter(
	module: string,
	context: StorageOpenContext,
	hostModules: Readonly<Record<string, object>> = {},
): Promise<StorageAdapterModule> {
	try {
		const [{ createHostModuleJiti }, { getStorageAdapterHostModules }, { resolvePackageStorageAdapter }] =
			await Promise.all([
				import("../extensions/loader-virtual-modules.js"),
				import("../extensions/loader-host-modules.js"),
				import("../package-manager-storage-adapters.js"),
			]);
		const id = pathToFileURL(join(context.agentDir, "storage-adapter.js")).href;
		const babel = await createHostModuleJiti(id, {});
		const loader = await createHostModuleJiti(
			id,
			{ ...(await getStorageAdapterHostModules()), ...hostModules, [ADAPTER_IMPORTS]: createAdapterImports() },
			// JS adapters must also pass through virtual host modules, not native-import a second host copy. A load
			// given extra host modules must not reuse a module another load evaluated without them: the cached
			// module's imports stay bound to that first loader, so a .ts adapter serving several domains would miss
			// them. Such loads evaluate afresh, as JS adapters always do. jiti's source cache would return transforms
			// without the import hook, so only the Babel step uses it.
			{
				interopDefault: true,
				tryNative: false,
				fsCache: false,
				moduleCache: Object.keys(hostModules).length === 0,
				transform: (options) => ({ code: `${babel.transform(options)}${ADAPTER_IMPORT_HOOK}` }),
			},
		);
		const specifier = (await resolvePackageStorageAdapter(module, context.agentDir)) ?? module;
		const location = loader.esmResolve(specifier);
		const filename = location.startsWith("file:") ? fileURLToPath(location) : location;
		// jiti's async JS fast path uses native import even with tryNative:false. Force only JS entrypoints
		// through its transform so their host imports use the live virtual modules, just like TS adapters.
		const loaded = /\.[cm]?js$/.test(filename)
			? await loader.evalModule(await readFile(filename, "utf8"), { filename, async: true, forceTranspile: true })
			: await loader.import<StorageAdapterModule>(specifier, { default: true });
		const adapter = ((loaded as { default?: StorageAdapterModule })?.default ?? loaded) as StorageAdapterModule;
		if (
			adapter === null ||
			typeof adapter !== "object" ||
			adapter.atomicStorageAdapter !== 1 ||
			[adapter.openDatabase, adapter.openSessionStore].some(
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

/** Reads one `secrets` reference: an environment variable, a file without its final line ending, or a value. */
async function readSecret(
	selection: Extract<StorageSelection, { kind: "adapter" }>,
	name: string,
	ref: SecretRef,
	agentDir: string,
): Promise<string> {
	if ("value" in ref) return ref.value;
	if ("env" in ref) {
		const environment = process.env[ref.env];
		if (environment === undefined) throw new StorageConfigError("sdk", `secrets.${name}`, "secret-env-missing");
		return environment;
	}
	let text: string;
	try {
		text = await readFile(await secretFilePathAsync(ref.file, agentDir), "utf8");
	} catch (cause) {
		throw new StorageUnavailableError(
			{ adapter: selection.module, location: ref.file },
			cause as StorageFailureCause,
		);
	}
	return text.endsWith("\r\n") ? text.slice(0, -2) : text.endsWith("\n") ? text.slice(0, -1) : text;
}

/**
 * The adapter's options with every `secrets` reference resolved, as the provider passes them to its hooks. Names in
 * `liveSecrets` (the adapter's own `liveSecrets`) are left out: the adapter reads them through `context.secret`.
 */
export async function resolveAdapterOptions(
	selection: Extract<StorageSelection, { kind: "adapter" }>,
	context: StorageOpenContext,
	liveSecrets: readonly string[] = [],
): Promise<AdapterOptions> {
	const options = { ...selection.options };
	for (const [name, ref] of Object.entries(selection.secrets ?? {})) {
		if (liveSecrets.includes(name)) {
			delete options[name];
			continue;
		}
		const value = await readSecret(selection, name, ref, context.agentDir);
		Object.defineProperty(options, name, { value, enumerable: true, writable: true, configurable: true });
	}
	return options;
}

/**
 * `context` with `secret(name)`, which reads `selection.secrets[name]` again on every call, as the provider passes it
 * to adapter hooks. A name the selection does not reference is a `StorageConfigError`.
 */
export function adapterOpenContext(
	selection: Extract<StorageSelection, { kind: "adapter" }>,
	context: StorageOpenContext,
): StorageOpenContext {
	return {
		...context,
		secret: async (name) => {
			const ref = Object.hasOwn(selection.secrets ?? {}, name) ? selection.secrets?.[name] : undefined;
			if (ref === undefined) throw new StorageConfigError("sdk", `secrets.${name}`, "secret-missing");
			return readSecret(selection, name, ref, context.agentDir);
		},
	};
}

async function closeAfterSnapshotCollections(database: SqliteDatabase): Promise<void> {
	const running = runningSnapshotCollectionsOn(database.descriptor);
	if (running.length === 0) return database.close();
	abortSnapshotCollectionsOn(database.descriptor, new StoreClosedError(database.descriptor));
	await Promise.all(running);
	try {
		await database.close();
	} catch (cause) {
		if (cause instanceof StorageError) throw cause;
		throw new StorageUnavailableError(database.descriptor, cause as StorageFailureCause);
	}
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
}

export const StorageProvider: new () => StorageProvider = class {
	private readonly databases = sharedDatabases;

	async openSessionStore(selection: StorageSelection, context: StorageOpenContext): Promise<SessionStore> {
		return this.open<SessionStore>(selection, context, {
			memory: async () =>
				new (await import("./session/memory-session-store.js")).MemorySessionStore(
					createSessionCwdMatcherAsync,
					(await import("./session/released-history-files.js")).releasedHistoryFiles(
						context.agentDir || (await import("../../config.js")).getAgentDir(),
					),
				),
			jsonl: async (dir) =>
				(await import("./session/jsonl-session-store.js")).JsonlSessionStore.open(dir, { exactDirectory: true }),
			direct: (adapter, options, storage, adapterContext) =>
				adapter.openSessionStore?.(options, adapterContext, storage),
			sql: async (database, options) =>
				(await import("./session/sql-session-store.js")).SqlSessionStore.open(database, {
					...options,
					cwdMatcher: createSessionCwdMatcherAsync,
				}),
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
				context: StorageOpenContext,
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
			const adapterContext = adapterOpenContext(selection, context);
			const options = await resolveAdapterOptions(selection, adapterContext, adapter.liveSecrets);
			try {
				const direct = factories.direct(adapter, options, { prefix: selection.prefix }, adapterContext);
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
					return await hook(options, adapterContext);
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
				await closeAfterSnapshotCollections(database);
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
