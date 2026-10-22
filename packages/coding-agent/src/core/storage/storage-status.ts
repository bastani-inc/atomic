import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENV_SESSION_DIR, isBunBinary } from "../../config.js";
import { resolvePath } from "../../utils/paths.ts";
import type { BrokerMultiNodeStatus, IntercomBrokerControl } from "../intercom-broker-control.ts";
import { selectSessionStorage } from "../session-storage.js";
import { SettingsManager } from "../settings-manager.ts";
import type { Settings } from "../settings-schema.ts";
import { hasProjectTrustInputs, ProjectTrustStore } from "../trust-manager.ts";
import type { SqliteDatabase } from "./database.js";
import { StorageAdapterLoadError } from "./errors.js";
import {
	processSharedStorageSelection,
	SESSIONS_STORAGE_ENV,
	STORAGE_ENV,
	selectProcessStorage,
	WORKFLOW_JOURNAL_PATH_ENV,
	WORKFLOWS_JOURNAL_ENV,
} from "./process-selection.js";
import {
	loadStorageAdapter,
	resolveAdapterOptions,
	type StorageOpenContext,
	type StorageSelection,
	storageSelectionKey,
} from "./provider.js";
import { type StorageSettingsSelection, selectStorage } from "./selection.js";

export type StorageStatusDomain = "sessions" | "journal" | "intercom";

/** How long one connectivity check may take, from loading the adapter to the answer of its `SELECT 1`. */
export const STORAGE_PROBE_TIMEOUT_MS = 15_000;

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
	/** Ask the running Intercom broker about itself; needs `probe`-independent access to the bundled Intercom package. */
	readonly control?: IntercomBrokerControl;
}

interface Layer {
	readonly label: string;
	readonly present: boolean;
}

/** An error and its direct cause on one line, for status output (a module-resolution "Require stack" is dropped). */
export function describeStorageError(error: Error | object | string | undefined): string {
	const firstLine = (text: string): string => text.split("\n", 1)[0]!.trim();
	if (!(error instanceof Error)) return firstLine(String(error));
	const message = firstLine(error.message);
	const cause = error.cause instanceof Error ? firstLine(error.cause.message) : undefined;
	return cause === undefined || message.includes(cause) ? message : `${message}: ${cause}`;
}

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
		case "adapter":
			return `adapter ${selection.module}${prefixSuffix(selection.prefix)}`;
	}
}

function withTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		operation,
		new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error(`${label} did not answer within ${STORAGE_PROBE_TIMEOUT_MS / 1000} s`)),
				STORAGE_PROBE_TIMEOUT_MS,
			);
			timer.unref?.();
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
	inspect?: (database: SqliteDatabase) => Promise<void>,
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
			),
		};
	}
	const module = selection.module;
	let adapter: Awaited<ReturnType<typeof loadStorageAdapter>>;
	try {
		adapter = await withTimeout(loadStorageAdapter(module, context), "Loading the adapter");
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
	const hook = adapter.openDatabase.bind(adapter);
	let options: Awaited<ReturnType<typeof resolveAdapterOptions>>;
	try {
		options = await resolveAdapterOptions(selection, context);
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
			const local = await probeSelection({ kind: "sqlite", path }, context, inspect);
			return { adapter: loaded, connection: local.connection };
		} catch (error) {
			return { adapter: loaded, connection: { status: "failed", detail: errorText(error as Error) } };
		}
	}
	return { adapter: loaded, connection: await roundTrip(() => hook(options, context), "The database", inspect) };
}

async function roundTrip(
	open: () => Promise<SqliteDatabase>,
	label: string,
	inspect?: (database: SqliteDatabase) => Promise<void>,
): Promise<StorageProbe["connection"]> {
	const started = Date.now();
	let database: SqliteDatabase | undefined;
	try {
		database = await withTimeout(open(), label);
		const opened = database;
		await withTimeout(opened.get("SELECT 1 AS ok"), label);
		const elapsed = Date.now() - started;
		// What `inspect` reads is extra detail; the database already answered.
		if (inspect) await withTimeout(inspect(opened), "Inspecting the database").catch(() => {});
		return {
			status: "ok",
			detail: `${opened.descriptor.adapter} ${opened.descriptor.location} answered in ${elapsed} ms`,
		};
	} catch (error) {
		return { status: "failed", detail: errorText(error as Error) };
	} finally {
		if (database) await withTimeout(database.close(), "Closing the database").catch(() => {});
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

function journalSetting(settings: Settings): StorageSettingsSelection | undefined {
	return Array.isArray(settings.workflows) ? undefined : settings.workflows?.journal;
}

function sourceOf(layers: readonly Layer[]): { source: string; overridden: string[] } {
	const present = layers.filter((layer) => layer.present).map((layer) => layer.label);
	return { source: present[0] ?? "default", overridden: present.slice(1) };
}

/** The journal selection exactly as the workflows extension makes it from these settings. */
function selectJournal(agentDir: string, settings: Settings): StorageSelection {
	const processChoice = selectProcessStorage("journal", agentDir);
	if (processChoice !== undefined) return processChoice.selection;
	const defaultPath = join(dirname(agentDir), "workflows", "journal.sqlite");
	const journal = journalSetting(settings);
	const value = journal ?? settings.storage;
	if (value === undefined) return { kind: "sqlite", path: defaultPath };
	const selection = selectStorage(
		value,
		"settings",
		journal !== undefined ? "workflows.journal" : "storage",
		journal !== undefined ? defaultPath : join(dirname(agentDir), "storage.sqlite"),
	);
	return selection.kind === "sqlite" && !isAbsolute(selection.path)
		? { ...selection, path: join(dirname(agentDir), selection.path) }
		: selection;
}

/** The raw shared selection a broker started from this process would read: `ATOMIC_STORAGE`, else global `storage`. */
function sharedSelection(globalStorage: StorageSettingsSelection | undefined): StorageSettingsSelection | undefined {
	const processSelection = processSharedStorageSelection();
	if (processSelection === undefined) return globalStorage;
	const parsed: StorageSettingsSelection | null = JSON.parse(processSelection);
	return parsed === null || typeof parsed !== "object" || Array.isArray(parsed) ? undefined : parsed;
}

function projectTrust(cwd: string, agentDir: string): boolean {
	if (!hasProjectTrustInputs(cwd)) return true;
	return (
		new ProjectTrustStore(agentDir).get(cwd) ??
		SettingsManager.create(cwd, agentDir, { projectTrusted: false }).getDefaultProjectTrust() === "always"
	);
}

/**
 * Which storage each domain selects and where that selection comes from, following the same precedence as
 * sessions, the workflows extension and the Intercom broker; with `probe`, whether each adapter loads and each
 * database answers, and what the running broker uses.
 */
export async function collectStorageStatus(options: StorageStatusOptions): Promise<StorageStatus> {
	const { cwd, agentDir } = options;
	const projectTrusted = projectTrust(cwd, agentDir);
	const manager = SettingsManager.create(cwd, agentDir, { projectTrusted });
	const settingsErrors = manager.drainErrors();
	if (settingsErrors.length > 0) {
		throw new Error(
			`Cannot load settings: ${settingsErrors.map(({ scope, error }) => `${scope} settings: ${error.message}`).join("; ")}`,
		);
	}
	const global = manager.getGlobalSettings();
	const project = manager.getProjectSettings();
	const merged = manager.getSettings();
	const notes: string[] = [];
	const unappliedProject = projectTrusted
		? {}
		: SettingsManager.create(cwd, agentDir, { projectTrusted: true }).getProjectSettings();
	if (
		unappliedProject.storage !== undefined ||
		unappliedProject.sessions?.storage !== undefined ||
		journalSetting(unappliedProject) !== undefined
	) {
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
		journal: [
			env(WORKFLOWS_JOURNAL_ENV),
			env(WORKFLOW_JOURNAL_PATH_ENV),
			env(STORAGE_ENV),
			...settingLayers(global, project, projectTrusted, journalSetting, "workflows.journal"),
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
		const probe = await probeSelection(selection, { agentDir, domain }, inspect);
		if (earlier === undefined) checked.set(key, { domain, probe });
		return probe;
	};

	const domains: DomainStatus[] = [];
	for (const domain of ["sessions", "journal"] as const) {
		const { source, overridden } = sourceOf(layers[domain]);
		try {
			const chosen =
				domain === "sessions"
					? selectSessionStorage(cwd, { agentDir, settings: merged })
					: selectJournal(agentDir, merged);
			const selection = chosen as StorageSelection;
			const probe = await probeOnce(domain, selection);
			domains.push({
				domain,
				selection: describeStorageSelection(selection),
				source,
				overridden,
				...(probe === undefined ? {} : { probe }),
			});
		} catch (error) {
			domains.push({ domain, selection: "invalid", source, overridden, error: errorText(error as Error) });
		}
	}

	const intercom = sourceOf(layers.intercom);
	try {
		const value = sharedSelection(global.storage);
		const selection =
			value === undefined
				? undefined
				: selectStorage(
						value,
						intercom.source === STORAGE_ENV ? "env" : "settings",
						"storage",
						join(dirname(agentDir), "storage.sqlite"),
					);
		if (
			selection === undefined ||
			selection.kind === "memory" ||
			(selection.kind === "sqlite" && selection.path === ":memory:")
		) {
			domains.push({
				domain: "intercom",
				selection: "off",
				source: intercom.source,
				overridden: intercom.overridden,
				multiNode:
					selection === undefined
						? "off: no shared storage selection (top-level `storage` in global settings, or ATOMIC_STORAGE)"
						: "off: the shared storage selection is in memory",
			});
		} else {
			const resolved =
				selection.kind === "sqlite" && !isAbsolute(selection.path)
					? { ...selection, path: resolvePath(selection.path, dirname(agentDir)) }
					: selection;
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
		const expected = control.expectedBrokerStorage(agentDir, process.env);
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
		return `Storage adapter "${module}" cannot be loaded by this Atomic (${executable}): ${errorText(cause as Error)}. Intercom multi-node routing stays off, and sessions or workflow runs that select this adapter fail to open. Run "atomic storage status" for details.`;
	}
}
