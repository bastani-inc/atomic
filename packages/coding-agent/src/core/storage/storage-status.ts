import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENV_SESSION_DIR, isBunBinary } from "../../config.js";
import { resolvePath } from "../../utils/paths.ts";
import type { BrokerMultiNodeStatus, IntercomBrokerControl } from "../intercom-broker-control.js";
import { selectSessionStorageWithSettings } from "../session-storage.js";
import { SettingsManager } from "../settings-manager.ts";
import type { Settings } from "../settings-schema.ts";
import { hasProjectTrustInputs, ProjectTrustStore } from "../trust-manager.ts";
import { openAdapterSelectionDatabase } from "./adapter-open.js";
import type { SqliteDatabase, SqliteRow } from "./database.js";
import { describeStorageError, StorageAdapterLoadError } from "./errors.js";
import { defaultSharedStoragePath, storagePathBaseDir, takeStorageAdoptionNotice } from "./file-identity.js";
import {
	processSharedStorageSelection,
	processStorageEnvironment,
	SESSIONS_STORAGE_ENV,
	STORAGE_ENV,
	selectProcessStorage,
} from "./process-selection.js";
import {
	loadStorageAdapter,
	resolveAdapterOptions,
	type StorageOpenContext,
	type StorageSelection,
	storageSelectionKey,
} from "./provider.js";
import { POSTGRES_ADAPTER_PACKAGE, type StorageSettingsSelection, selectStorage } from "./selection.js";

export type StorageStatusDomain = "sessions" | "intercom";

/** Removed with libSQL support; see libsql-removed.ts for why it is still exported. */
export { TEAM_PROFILE_SOURCE } from "./libsql-removed.js";

/** How long one database connectivity check may take, from opening the database to the answer of its `SELECT 1`. */
export const STORAGE_PROBE_TIMEOUT_MS = 15_000;

/**
 * How long `storage status` waits for an adapter module to load before giving up on a hung evaluation; separate from
 * {@link STORAGE_PROBE_TIMEOUT_MS} so the server-probe timer starts only once the connection attempt starts.
 */
export const STORAGE_ADAPTER_LOAD_TIMEOUT_MS = 15_000;

export interface StorageProbe {
	readonly adapter?: { readonly module: string; readonly loaded: boolean; readonly detail?: string };
	readonly connection: { readonly status: "ok" | "failed" | "skipped"; readonly detail: string };
	/** The adapter loaded but has no `openDatabase` hook, so nothing was opened. */
	readonly noDatabaseHook?: true;
	/** The domain whose identical selection was already checked. */
	readonly sameAs?: StorageStatusDomain;
}

export interface DomainStatus {
	readonly domain: StorageStatusDomain;
	/** The effective selection, for example `adapter @x/y (prefix t_)`; `off` for Intercom without a shared one. */
	readonly selection: string;
	/** Where the selection comes from, for example `ATOMIC_STORAGE`, `global settings: storage`, or `default`. */
	readonly source: string;
	/** Lower-precedence selections that are set but overridden by `source`. */
	readonly overridden: readonly string[];
	/** An invalid selection; Atomic stops rather than choosing another store. */
	readonly error?: string;
	readonly probe?: StorageProbe;
	/** Intercom: whether a broker started now would route across machines, and why not. */
	readonly multiNode?: string;
	/** Intercom: host names of the brokers live in the shared database, when it could be read. */
	readonly liveBrokers?: readonly string[];
}

export interface BrokerStatusSection {
	readonly state: "stopped" | "running" | "legacy" | "unknown";
	readonly pid?: number;
	readonly sessions?: number;
	/** Whether the running broker reads the selection a broker started now would read. */
	readonly matchesCurrent?: boolean;
	readonly source?: "env" | "settings";
	readonly multiNode?: BrokerMultiNodeStatus;
	readonly multiNodeLine?: string;
	/** Why the broker could not be asked. */
	readonly error?: string;
}

export interface StorageStatus {
	readonly agentDir: string;
	readonly cwd: string;
	readonly projectTrusted: boolean;
	readonly domains: readonly DomainStatus[];
	readonly notes: readonly string[];
	readonly broker?: BrokerStatusSection;
}

export interface StorageStatusOptions {
	readonly cwd: string;
	readonly agentDir: string;
	/** Load adapters and run a `SELECT 1` on each selected database. */
	readonly probe: boolean;
	/** How long each database step of one check may take, after the adapter has loaded. Default {@link STORAGE_PROBE_TIMEOUT_MS}. */
	readonly probeTimeoutMs?: number;
	/** Ask the running Intercom broker about itself; needs `probe`-independent access to the bundled Intercom package. */
	readonly control?: IntercomBrokerControl;
}

interface Layer {
	readonly label: string;
	readonly present: boolean;
}

export { describeStorageError };

const errorText = describeStorageError;

function envSet(name: string): boolean {
	const value = process.env[name];
	return value !== undefined && value.length > 0;
}

function prefixSuffix(prefix: string | undefined): string {
	return prefix ? ` (prefix ${prefix})` : "";
}

export function describeStorageSelection(selection: StorageSelection): string {
	switch (selection.kind) {
		case "memory":
			return "memory";
		case "jsonl":
			return `JSONL directory ${selection.dir}`;
		case "sqlite":
			return `SQLite ${selection.path}${prefixSuffix(selection.prefix)}`;
		case "database":
			return `database ${selection.database.descriptor.adapter}${prefixSuffix(selection.prefix)}`;
		case "adapter": {
			const server = postgresServer(selection);
			if (server !== undefined)
				return `PostgreSQL ${server} via ${selection.module}${prefixSuffix(selection.prefix)}`;
			return `adapter ${selection.module}${prefixSuffix(selection.prefix)}`;
		}
	}
}

/** A Postgres selection's server, without the user name, the query and the fragment; undefined for other selections. */
function postgresServer(selection: Extract<StorageSelection, { kind: "adapter" }>): string | undefined {
	const url = selection.options?.url;
	if (selection.module !== POSTGRES_ADAPTER_PACKAGE || typeof url !== "string" || !URL.canParse(url)) return undefined;
	const server = new URL(url);
	server.username = "";
	server.password = "";
	server.search = "";
	server.hash = "";
	return server.href;
}

function withTimeout<T>(operation: Promise<T>, label: string, timeoutMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		operation,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${label} did not answer within ${timeoutMs / 1000} s`)), timeoutMs);
		}),
	]).finally(() => clearTimeout(timer));
}

/**
 * Load the selection's adapter and run `SELECT 1` on its database; `inspect` reads it before it closes. Nothing is
 * created: a SQLite file that does not exist yet is not opened, and no Atomic table is touched.
 */
async function probeSelection(
	selection: StorageSelection,
	context: StorageOpenContext,
	inspect: ((database: SqliteDatabase) => Promise<void>) | undefined,
	timeoutMs: number,
): Promise<StorageProbe> {
	if (selection.kind === "memory") return { connection: { status: "skipped", detail: "in memory; nothing to open" } };
	if (selection.kind === "jsonl") {
		return {
			connection: {
				status: "skipped",
				detail: existsSync(selection.dir) ? "directory exists" : "directory not created yet",
			},
		};
	}
	if (selection.kind === "database") return { connection: { status: "skipped", detail: "caller-owned database" } };
	if (selection.kind === "sqlite") {
		if (selection.path === "" || selection.path === ":memory:") {
			return { connection: { status: "skipped", detail: "in memory; nothing to open" } };
		}
		if (!existsSync(selection.path)) {
			return { connection: { status: "skipped", detail: "file not created yet; Atomic creates it on first use" } };
		}
		const { openNodeSqliteDatabase } = await import("./node-sqlite.js");
		return {
			connection: await roundTrip(
				() => openNodeSqliteDatabase(selection.path, { readOnly: true }),
				"SQLite file",
				inspect,
				timeoutMs,
			),
		};
	}
	const module = selection.module;
	let adapter: Awaited<ReturnType<typeof loadStorageAdapter>>;
	try {
		adapter = await withTimeout(
			loadStorageAdapter(module, context),
			"Loading the adapter",
			Math.max(timeoutMs, STORAGE_ADAPTER_LOAD_TIMEOUT_MS),
		);
	} catch (error) {
		return {
			adapter: { module, loaded: false, detail: errorText(error as Error) },
			connection: { status: "skipped", detail: "adapter not loaded" },
		};
	}
	const { resolvePackageStorageAdapter } = await import("../package-manager-storage-adapters.js");
	const resolved = await resolvePackageStorageAdapter(module, context.agentDir);
	const loaded = { module, loaded: true, ...(resolved === undefined ? {} : { detail: `from ${resolved}` }) };
	if (adapter.openDatabase === undefined) {
		return {
			adapter: loaded,
			noDatabaseHook: true,
			connection: { status: "skipped", detail: "the adapter has no openDatabase hook; its stores were not opened" },
		};
	}
	let options: Awaited<ReturnType<typeof resolveAdapterOptions>>;
	try {
		options = await resolveAdapterOptions(selection, context, adapter.liveSecrets);
	} catch (error) {
		return { adapter: loaded, connection: { status: "failed", detail: errorText(error as Error) } };
	}
	if (typeof options.url === "string" && options.url.startsWith("file:")) {
		// Normal adapter hooks may create files. Probe local SQLite through the read-only opener instead.
		if (!options.url.startsWith("file:/")) {
			return {
				adapter: loaded,
				connection: { status: "skipped", detail: "relative file: URL cannot be safely probed" },
			};
		}
		try {
			const path = fileURLToPath(options.url);
			if (!existsSync(path)) {
				return {
					adapter: loaded,
					connection: { status: "skipped", detail: "file not found; Atomic creates it on first use" },
				};
			}
			const local = await probeSelection({ kind: "sqlite", path }, context, inspect, timeoutMs);
			return { adapter: loaded, connection: local.connection };
		} catch (error) {
			return { adapter: loaded, connection: { status: "failed", detail: errorText(error as Error) } };
		}
	}
	return {
		adapter: loaded,
		connection: await roundTrip(
			() => openAdapterSelectionDatabase(selection, context, adapter),
			"The database",
			inspect,
			timeoutMs,
			postgresServer(selection),
		),
	};
}

/** The server version a Postgres database reports, as status shows it after the `SELECT 1` answer. */
async function postgresServerVersion(database: SqliteDatabase): Promise<string> {
	const row = await database.get<SqliteRow & { version: string }>(
		"SELECT current_setting('server_version') AS version",
	);
	return `PostgreSQL ${(row as SqliteRow & { version: string }).version}`;
}

/**
 * How a Postgres database's wake-ups reach this process (#5103): through `LISTEN`, or by polling alone, and why. Undefined
 * for a database without notifications.
 */
async function postgresWakeUps(database: SqliteDatabase): Promise<string | undefined> {
	const state = await database.notifications?.state();
	if (state === undefined) return undefined;
	if (state.status === "listening") return "wake-ups: LISTEN/NOTIFY";
	if (state.status === "connecting") return "wake-ups: connecting";
	return state.reason === "pooler"
		? "wake-ups: polling only, notifications do not pass the URL's transaction pooler (set listenUrl to a direct endpoint)"
		: "wake-ups: polling only, the listen connection failed";
}

async function roundTrip(
	open: () => Promise<SqliteDatabase>,
	label: string,
	inspect: ((database: SqliteDatabase) => Promise<void>) | undefined,
	timeoutMs: number,
	postgres?: string,
): Promise<StorageProbe["connection"]> {
	const started = Date.now();
	let database: SqliteDatabase | undefined;
	try {
		database = await withTimeout(open(), label, timeoutMs);
		const opened = database;
		await withTimeout(opened.get("SELECT 1 AS ok"), label, timeoutMs);
		const elapsed = Date.now() - started;
		// What `inspect` and the server version read is extra detail; the database already answered.
		if (inspect) await withTimeout(inspect(opened), "Inspecting the database", timeoutMs).catch(() => {});
		if (postgres !== undefined) {
			// The adapter's own location holds the whole URL; status names the server only.
			const version = await withTimeout(
				postgresServerVersion(opened),
				"Reading the server version",
				timeoutMs,
			).catch(() => undefined);
			const wakeUps = await withTimeout(postgresWakeUps(opened), "Probing wake-ups", timeoutMs).catch(
				() => undefined,
			);
			return {
				status: "ok",
				detail: `postgres ${postgres} answered in ${elapsed} ms${version === undefined ? "" : `, ${version}`}${wakeUps === undefined ? "" : `; ${wakeUps}`}`,
			};
		}
		return {
			status: "ok",
			detail: `${opened.descriptor.adapter} ${opened.descriptor.location} answered in ${elapsed} ms`,
		};
	} catch (error) {
		return { status: "failed", detail: errorText(error as Error) };
	} finally {
		if (database) await withTimeout(database.close(), "Closing the database", timeoutMs).catch(() => {});
	}
}

function settingLayers(
	global: Settings,
	project: Settings,
	projectTrusted: boolean,
	read: (settings: Settings) => object | undefined,
	field: string,
): Layer[] {
	return [
		{ label: `project settings: ${field}`, present: projectTrusted && read(project) !== undefined },
		{ label: `global settings: ${field}`, present: read(global) !== undefined },
	];
}

function sourceOf(layers: readonly Layer[]): { source: string; overridden: string[] } {
	const present = layers.filter((layer) => layer.present).map((layer) => layer.label);
	return { source: present[0] ?? "default", overridden: present.slice(1) };
}

/**
 * The shared selection this process and these settings make: `--storage` or `ATOMIC_STORAGE`, else the `storage`
 * setting; `undefined` when none of them is set.
 */
export function selectSharedStorage(agentDir: string, settings: Settings): StorageSelection | undefined {
	const processChoice = selectProcessStorage("shared", agentDir, undefined, settings);
	if (processChoice !== undefined) return processChoice.selection;
	const value = settings.storage;
	if (value === undefined) return undefined;
	const selection = selectStorage(value, "settings", "storage", () => defaultSharedStoragePath(agentDir, settings));
	return selection.kind === "sqlite" && !isAbsolute(selection.path)
		? { ...selection, path: join(storagePathBaseDir(selection.path, agentDir, settings), selection.path) }
		: selection;
}

/**
 * The raw shared selection a broker started from this process would read: `--storage` or `ATOMIC_STORAGE`, else
 * global `storage`.
 */
function sharedSelection(
	globalStorage: StorageSettingsSelection | undefined,
	processSelection: string | undefined = processSharedStorageSelection(),
): StorageSettingsSelection | undefined {
	if (processSelection === undefined) return globalStorage;
	const parsed: StorageSettingsSelection | null = JSON.parse(processSelection);
	return parsed === null || typeof parsed !== "object" || Array.isArray(parsed) ? undefined : parsed;
}

/**
 * The shared selection Intercom's multi-node routing would use, resolved like the broker resolves it; `undefined`
 * when there is none or it is in memory, which leaves multi-node routing off.
 */
export function selectIntercomStorage(
	agentDir: string,
	globalStorage: StorageSettingsSelection | undefined,
): StorageSelection | undefined {
	const processSelection = processSharedStorageSelection();
	const value = sharedSelection(globalStorage, processSelection);
	if (value === undefined) return undefined;
	const settings = globalStorage === undefined ? undefined : { storage: globalStorage };
	const selection = selectStorage(value, processSelection === undefined ? "settings" : "env", "storage", () =>
		defaultSharedStoragePath(agentDir, settings),
	);
	if (selection.kind === "memory" || (selection.kind === "sqlite" && selection.path === ":memory:")) return undefined;
	return selection.kind === "sqlite" && !isAbsolute(selection.path)
		? { ...selection, path: resolvePath(selection.path, storagePathBaseDir(selection.path, agentDir, settings)) }
		: selection;
}

export function projectTrust(cwd: string, agentDir: string): boolean {
	if (!hasProjectTrustInputs(cwd)) return true;
	return (
		new ProjectTrustStore(agentDir).get(cwd) ??
		SettingsManager.create(cwd, agentDir, { projectTrusted: false }).getDefaultProjectTrust() === "always"
	);
}

/** The shared selection {@link selectSharedStorage} makes in this directory, with its trusted project settings. */
export function effectiveSharedSelection(cwd: string, agentDir: string): StorageSelection | undefined {
	const manager = SettingsManager.create(cwd, agentDir, { projectTrusted: projectTrust(cwd, agentDir) });
	return selectSharedStorage(agentDir, manager.getSettings());
}

/**
 * Which storage each domain selects and where that selection comes from, following the same precedence as
 * sessions and the Intercom broker; with `probe`, whether each adapter loads and each database answers, and what the
 * running broker uses.
 */
export async function collectStorageStatus(options: StorageStatusOptions): Promise<StorageStatus> {
	const { cwd, agentDir } = options;
	const projectTrusted = projectTrust(cwd, agentDir);
	const manager = SettingsManager.create(cwd, agentDir, { projectTrusted });
	const settingsErrors = manager.drainErrors().filter(({ invalidKey }) => invalidKey === undefined);
	if (settingsErrors.length > 0) {
		throw new Error(
			`Cannot load settings: ${settingsErrors.map(({ scope, error }) => `${scope} settings: ${error.message}`).join("; ")}`,
		);
	}
	const global = manager.getGlobalSettings();
	const project = manager.getProjectSettings();
	const merged = manager.getSettings();
	const notes: string[] = [];
	let usesLocalStorage = false;
	const unappliedProject = projectTrusted
		? {}
		: SettingsManager.create(cwd, agentDir, { projectTrusted: true }).getProjectSettings();
	if (unappliedProject.storage !== undefined || unappliedProject.sessions?.storage !== undefined) {
		notes.push("Project settings select storage, but the project is not trusted, so they are not applied.");
	}
	if (projectTrusted && project.storage !== undefined) {
		notes.push(
			"Project settings set `storage`, which Intercom ignores: multi-node routing reads only global settings or ATOMIC_STORAGE.",
		);
	}
	const env = (name: string): Layer => ({ label: name, present: envSet(name) });
	const sessionsSetting = (settings: Settings) => settings.sessions?.storage;
	const storageSetting = (settings: Settings) => settings.storage;
	const layers: Record<StorageStatusDomain, Layer[]> = {
		sessions: [
			env(SESSIONS_STORAGE_ENV),
			env(ENV_SESSION_DIR),
			env(STORAGE_ENV),
			...settingLayers(global, project, projectTrusted, sessionsSetting, "sessions.storage"),
			...settingLayers(global, project, projectTrusted, storageSetting, "storage"),
		],
		intercom: [env(STORAGE_ENV), { label: "global settings: storage", present: global.storage !== undefined }],
	};

	const checked = new Map<string, { domain: StorageStatusDomain; probe: StorageProbe }>();
	const probeOnce = async (
		domain: StorageStatusDomain,
		selection: StorageSelection,
		inspect?: (database: SqliteDatabase) => Promise<void>,
	): Promise<StorageProbe | undefined> => {
		if (!options.probe) return undefined;
		const key = storageSelectionKey(selection, agentDir);
		const earlier = checked.get(key);
		if (earlier !== undefined && inspect === undefined) return { ...earlier.probe, sameAs: earlier.domain };
		const probe = await probeSelection(
			selection,
			{ agentDir, domain },
			inspect,
			options.probeTimeoutMs ?? STORAGE_PROBE_TIMEOUT_MS,
		);
		if (earlier === undefined) checked.set(key, { domain, probe });
		return probe;
	};

	const domains: DomainStatus[] = [];
	const sessions = sourceOf(layers.sessions);
	try {
		const selection = selectSessionStorageWithSettings(cwd, { agentDir, settings: merged }) as StorageSelection;
		if (selection.kind === "sqlite" || selection.kind === "jsonl") usesLocalStorage = true;
		const probe = await probeOnce("sessions", selection);
		domains.push({
			domain: "sessions",
			selection: describeStorageSelection(selection),
			source: sessions.source,
			overridden: sessions.overridden,
			...(probe === undefined ? {} : { probe }),
		});
	} catch (error) {
		domains.push({
			domain: "sessions",
			selection: "invalid",
			source: sessions.source,
			overridden: sessions.overridden,
			error: errorText(error as Error),
		});
	}

	const intercom = sourceOf(layers.intercom);
	try {
		const resolved = selectIntercomStorage(agentDir, global.storage);
		if (resolved === undefined) {
			domains.push({
				domain: "intercom",
				selection: "off",
				source: intercom.source,
				overridden: intercom.overridden,
				multiNode:
					sharedSelection(global.storage) === undefined
						? "off: no shared storage selection (top-level `storage` in global settings, or ATOMIC_STORAGE)"
						: "off: the shared storage selection is in memory",
			});
		} else {
			if (resolved.kind === "sqlite") usesLocalStorage = true;
			let liveBrokers: string[] | undefined;
			const control = options.control;
			const probe = await probeOnce(
				"intercom",
				resolved,
				control === undefined
					? undefined
					: async (database) => {
							// No Intercom tables yet: no broker has used this database.
							liveBrokers =
								(await control.readLiveBrokers(
									database,
									resolved.kind === "adapter" || resolved.kind === "sqlite" ? resolved.prefix : undefined,
								)) ?? [];
						},
			);
			const multiNode =
				probe === undefined
					? undefined
					: probe.adapter?.loaded === false
						? "off: the adapter cannot be loaded"
						: probe.noDatabaseHook
							? "off: the adapter has no openDatabase hook"
							: probe.connection.status === "failed"
								? "unavailable: the database did not answer"
								: resolved.kind === "sqlite"
									? "on (a local SQLite file: only brokers on this machine share it)"
									: "on";
			domains.push({
				domain: "intercom",
				selection: describeStorageSelection(resolved),
				source: intercom.source,
				overridden: intercom.overridden,
				...(probe === undefined ? {} : { probe }),
				...(multiNode === undefined ? {} : { multiNode }),
				...(liveBrokers === undefined ? {} : { liveBrokers }),
			});
		}
	} catch (error) {
		domains.push({
			domain: "intercom",
			selection: "invalid",
			source: intercom.source,
			overridden: intercom.overridden,
			error: errorText(error as Error),
		});
	}

	if (usesLocalStorage) {
		const adoptionNotice = takeStorageAdoptionNotice(agentDir, merged);
		if (adoptionNotice !== undefined) notes.unshift(adoptionNotice);
	}
	return {
		agentDir,
		cwd,
		projectTrusted,
		domains,
		notes,
		...(options.control === undefined ? {} : { broker: await brokerSection(options.control, agentDir) }),
	};
}

async function brokerSection(control: IntercomBrokerControl, agentDir: string): Promise<BrokerStatusSection> {
	try {
		const query = await control.queryIntercomBroker(agentDir);
		if (query.state === "stopped") return { state: "stopped" };
		if (query.state === "legacy")
			return query.pid === undefined ? { state: "legacy" } : { state: "legacy", pid: query.pid };
		const { report } = query;
		const expected = control.expectedBrokerStorage(agentDir, processStorageEnvironment());
		return {
			state: "running",
			pid: report.pid,
			sessions: report.sessions,
			matchesCurrent: report.storage?.digest === expected?.digest,
			...(report.storage === undefined ? {} : { source: report.storage.source }),
			multiNode: report.multiNode,
			multiNodeLine: control.describeMultiNodeStatus(report.multiNode),
		};
	} catch (error) {
		return { state: "unknown", error: errorText(error as Error) };
	}
}

/**
 * The launch warning for a shared storage adapter this executable cannot load: the Intercom broker would leave
 * multi-node routing off with only a `broker.log` line. Load-only: no database is opened. `undefined` when the
 * shared selection names no adapter or it loads.
 */
export async function checkSharedStorageAdapter(
	agentDir: string,
	globalStorage: StorageSettingsSelection | undefined,
): Promise<string | undefined> {
	let value: StorageSettingsSelection | undefined;
	try {
		value = sharedSelection(globalStorage);
	} catch {
		// An invalid ATOMIC_STORAGE is reported by its own validation.
		return undefined;
	}
	const module = value?.adapter;
	if (typeof module !== "string" || module.length === 0) return undefined;
	try {
		await loadStorageAdapter(module, { agentDir, domain: "intercom" });
		return undefined;
	} catch (error) {
		const executable = isBunBinary ? process.execPath : (process.argv[1] ?? process.execPath);
		const cause = error instanceof StorageAdapterLoadError && error.cause instanceof Error ? error.cause : error;
		return `Storage adapter "${module}" cannot be loaded by this Atomic (${executable}): ${errorText(cause as Error)}. Intercom multi-node routing stays off, and sessions that select this adapter fail to open. Run "atomic storage status" for details.`;
	}
}
