/**
 * Team setup: one settings write that shares workflow runs and Intercom routing through a team database while
 * sessions stay in the local store (`joinTeam`), its exact undo (`leaveTeam`), the layout in effect
 * (`getTeamProfile`), and the shared-database join that `atomic storage join` and `atomic team join` both run.
 */

import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getAgentDir } from "../../config.js";
import type { IntercomBrokerControl, RestartOutcome } from "../intercom-broker-control.js";
import { resolvePackageStorageAdapter } from "../package-manager-storage-adapters.js";
import { selectSessionSetting, selectSessionStorage } from "../session-storage.js";
import { SettingsManager } from "../settings-manager.ts";
import type { Settings } from "../settings-schema.ts";
import {
	describeStorageError,
	StorageAdapterLoadError,
	StorageError,
	TeamProfileError,
	TeamProfileTimeoutError,
} from "./errors.js";
import { loadStorageAdapter, type SecretRef, type StorageSelection, storageSelectionKey } from "./provider.js";
import {
	checkTeamPrefix,
	checkTeamUrl,
	conflictingTeamToken,
	emptyTeamToken,
	environmentTeamProfile,
	isFileUrl,
	LIBSQL_ADAPTER_PACKAGE,
	LOCAL_SESSIONS_STORAGE,
	missingTeamToken,
	readTeamTokenFile,
	STORAGE_TOKEN_FILE,
	type StorageSettingsSelection,
	selectStorage,
	type TeamInputSource,
} from "./selection.js";
import { describeStorageSelection, projectTrust, selectIntercomStorage, selectJournal } from "./storage-status.js";

export interface JoinTeamOptions {
	/** `libsql://`, `https://`, `wss://` or absolute `file:` URL, without a credential. */
	readonly url: string;
	/** The database token; it is stored in a private file in the agent directory. */
	readonly token?: string;
	/** A file holding the database token; surrounding whitespace is removed. Relative paths resolve against `cwd`. */
	readonly tokenFile?: string;
	/** Table prefix, to share one database between teams. */
	readonly prefix?: string;
	/** Default: the Atomic agent directory. */
	readonly agentDir?: string;
	/** Default: `process.cwd()`. */
	readonly cwd?: string;
	/** Progress lines while the Intercom broker restarts. */
	readonly onProgress?: (line: string) => void;
}

export interface TeamProfileOptions {
	readonly agentDir?: string;
	readonly cwd?: string;
}

export interface LeaveTeamOptions {
	readonly agentDir?: string;
	readonly cwd?: string;
	readonly onProgress?: (line: string) => void;
}

/** What the shared-database join wrote. */
export interface SharedDatabaseJoin {
	readonly settingsPath: string;
	/** The `storage` value written: the adapter, the URL, a token file reference and the prefix, never a token. */
	readonly storage: StorageSettingsSelection;
	/** The `sessions.storage` value written, when sessions were pinned to the local store. */
	readonly sessionsStorage?: typeof LOCAL_SESSIONS_STORAGE;
	/** The private token file the selection references. */
	readonly tokenPath?: string;
	/** `new`: written now; `reused`: the file the previous selection referenced already held this token. */
	readonly token: "new" | "reused" | "none";
	/** The previous `storage` selection it replaced, described without its options or secrets. */
	readonly replaced?: string;
	/** The previous global `sessions.storage` the local pin replaced, when it was not already the local default store. */
	readonly replacedSessionsStorage?: string;
}

/** The Intercom broker restart after a team settings change; a failed restart does not undo the change. */
export type TeamBrokerRestart = RestartOutcome | { readonly status: "failed"; readonly error: TeamProfileError };

export interface TeamJoinResult extends SharedDatabaseJoin {
	readonly sessionsStorage: typeof LOCAL_SESSIONS_STORAGE;
	readonly broker: TeamBrokerRestart;
}

export type TeamSettingKey = "storage" | "sessions.storage";

/**
 * A key `team leave` left in place. `changed`: it holds something other than what `team join` writes.
 * `storage-remains`: it is the local sessions pin, kept because `storage` stays set and sessions would follow it.
 */
export interface TeamKeptSetting {
	readonly key: TeamSettingKey;
	readonly reason: "changed" | "storage-remains";
}

export interface TeamLeaveResult {
	readonly settingsPath: string;
	/** Keys removed because they held exactly what `team join` writes. */
	readonly removed: readonly TeamSettingKey[];
	/** Keys left in place, and why. */
	readonly kept: readonly TeamKeptSetting[];
	/** The token file of the removed selection, deleted because no remaining setting references it. */
	readonly deletedTokenFiles: readonly string[];
	/** The token file of the removed selection, kept because another setting still references it. */
	readonly keptTokenFiles: readonly string[];
	/** Present when `storage` was removed. */
	readonly broker?: TeamBrokerRestart;
}

export type TeamProfileName = "individual" | "team" | "ci" | "custom";

/** The layout in effect, from the selections each domain actually uses. */
export interface TeamProfile {
	/**
	 * `individual`: sessions and workflow runs in the local default store, Intercom on this machine only.
	 * `team`: sessions in the local default store; workflow runs and Intercom on one shared adapter database.
	 * `ci`: sessions, workflow runs and Intercom all on one shared adapter database (what `ATOMIC_PROFILE=ci` selects).
	 * `custom`: anything else.
	 */
	readonly profile: TeamProfileName;
	readonly sessions: string;
	readonly journal: string;
	/** `off` when Intercom has no shared selection. */
	readonly intercom: string;
}

/** Test seam: the CLI and tests pass their broker control. */
export interface TeamOperationContext {
	readonly loadControl?: () => Promise<IntercomBrokerControl>;
	readonly connectionTimeoutMs?: number;
	/** Called once a join wrote its settings, before the broker restarts, so the CLI reports the join first. */
	readonly onJoined?: (joined: SharedDatabaseJoin) => void;
	/** Called once a leave wrote its settings, before the broker restarts, so the CLI reports the change first. */
	readonly onLeft?: (left: Pick<TeamLeaveResult, "settingsPath" | "removed" | "kept">) => void;
}

function settingsPathOf(agentDir: string): string {
	return join(agentDir, "settings.json");
}

/**
 * Why a settings file cannot be read, without any of its content: the file-system error code, or where its JSON
 * breaks. A parser message can quote part of the file, such as a key, so it is never shown.
 */
function unreadableSettingsDetail(error: Error): string {
	const code = (error as NodeJS.ErrnoException).code;
	if (typeof code === "string") return code;
	if (!(error instanceof SyntaxError)) return error.name;
	const position = /\(line (\d+) column (\d+)\)/.exec(error.message);
	return position === null ? "not valid JSON" : `not valid JSON at line ${position[1]}, column ${position[2]}`;
}

function openGlobalSettings(cwd: string, agentDir: string): SettingsManager {
	const manager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	const failure = manager.drainErrors().find(({ scope }) => scope === "global");
	if (failure !== undefined) {
		const settingsPath = settingsPathOf(agentDir);
		if (isLocked(failure.error)) throw lockedError(settingsPath, failure.error, "Nothing was changed.");
		throw new TeamProfileError("settings-unreadable", {
			subject: settingsPath,
			detail: unreadableSettingsDetail(failure.error),
			hint: `Fix ${settingsPath} first, then run the command again.`,
			cause: failure.error,
		});
	}
	return manager;
}

function writePrivateFile(path: string, token: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(temporary, token, { mode: 0o600 });
		chmodSync(temporary, 0o600);
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

async function checkConnection(url: string, token: string | undefined, agentDir: string): Promise<void> {
	const context = { agentDir, domain: "sessions" } as const;
	const adapter = await loadStorageAdapter(LIBSQL_ADAPTER_PACKAGE, context);
	if (adapter.openDatabase === undefined) throw new Error(`${LIBSQL_ADAPTER_PACKAGE} has no openDatabase hook`);
	const database = await adapter.openDatabase({ url, ...(token === undefined ? {} : { authToken: token }) }, context);
	try {
		await database.get("SELECT 1 AS ok");
	} finally {
		await database.close();
	}
}

/** How long a join waits for the team database to load its adapter, connect and answer `SELECT 1`. */
export const TEAM_CONNECTION_TIMEOUT_MS = 15_000;

/**
 * `checkConnection`, bounded by `timeoutMs`: a database that does not answer fails with a retryable
 * {@link TeamProfileTimeoutError} instead of waiting for the operating system's connection timeout. A check that
 * fails after the deadline is recorded as the timeout error's `cleanupCause`.
 */
async function checkConnectionWithin(
	url: string,
	token: string | undefined,
	agentDir: string,
	timeoutMs: number,
): Promise<void> {
	const started = Date.now();
	const check = checkConnection(url, token, agentDir).then(() => "answered" as const);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<"timed-out">((resolveDeadline) => {
		timer = setTimeout(() => resolveDeadline("timed-out"), timeoutMs);
	});
	let outcome: "answered" | "timed-out";
	try {
		outcome = await Promise.race([check, deadline]);
	} catch (error) {
		throw new TeamProfileError("connection-failed", {
			subject: url,
			detail: describeStorageError(error as Error),
			hint: "Nothing was changed. Check the URL, the token and the network, then run the command again.",
			cause: error as Error,
		});
	} finally {
		clearTimeout(timer);
	}
	if (outcome === "answered") return;
	const timeout = new TeamProfileTimeoutError({
		subject: url,
		timeoutMs,
		elapsedMs: Date.now() - started,
		phase: "connect",
		hint: "Nothing was changed. Check that the database is reachable from this machine, then run the command again.",
	});
	check.catch((late: Error) => {
		Object.defineProperty(timeout, "cleanupCause", { value: late, configurable: true });
	});
	throw timeout;
}

/** The token file a `{ file }` reference names, resolved like the storage provider resolves it. */
function secretFilePath(ref: SecretRef | undefined, agentDir: string): string | undefined {
	if (ref === undefined || !("file" in ref)) return undefined;
	return resolve(isAbsolute(ref.file) ? ref.file : join(dirname(agentDir), ref.file));
}

/** Whether a path is a token file that a join created in this agent directory. */
function isJoinTokenFile(path: string, agentDir: string): boolean {
	return dirname(path) === resolve(agentDir) && basename(path).startsWith(`${STORAGE_TOKEN_FILE}.`);
}

/** The join-created token file `storage` references, when it already holds `token`. */
function reusableTokenFile(
	storage: StorageSettingsSelection | undefined,
	token: string,
	agentDir: string,
): string | undefined {
	const path = secretFilePath(storage?.secrets?.authToken, agentDir);
	if (path === undefined || !isJoinTokenFile(path, agentDir)) return undefined;
	let stored: string;
	try {
		stored = readFileSync(path, "utf8");
	} catch (error) {
		// Documented fallback, visible as `token: "new"` in the result: a token file that cannot be read is not reused.
		if (error instanceof Error) return undefined;
		throw error;
	}
	return stored === token ? path : undefined;
}

function isLocked(error: Error): boolean {
	return (error as NodeJS.ErrnoException).code === "ELOCKED";
}

/** Another process holds the settings lock: retryable, since a lock left by a killed process expires. */
function lockedError(settingsPath: string, cause: Error, outcome: string): TeamProfileError {
	return new TeamProfileError("settings-locked", {
		subject: settingsPath,
		hint: `${outcome} Run the command again in a few seconds; a lock left by a killed process expires after 10 seconds.`,
		cause,
	});
}

/** A failed settings write: `settings-locked` while another process holds the lock, else the I/O error. */
function settingsWriteError(settingsPath: string, cause: Error, outcome: string): TeamProfileError {
	if (isLocked(cause)) return lockedError(settingsPath, cause, outcome);
	return new TeamProfileError("settings-write-failed", {
		subject: settingsPath,
		detail: describeStorageError(cause),
		hint: `${outcome} Check that the file and its directory are writable and the disk has space, then run the command again.`,
		cause,
	});
}

function cleanupAfter(primary: Error, cleanup: () => void): void {
	try {
		cleanup();
	} catch (cleanupCause) {
		Object.defineProperty(primary, "cleanupCause", { value: cleanupCause, configurable: true });
	}
}

/**
 * Point the global `storage` setting at a shared libSQL / Turso database, as `atomic storage join` and
 * `atomic team join` do. Every input and precondition is checked before the first write: the URL, the token, the
 * prefix, readable global settings, the installed adapter and a `SELECT 1` on the database. The token is stored in a
 * private file in the agent directory (mode 600), reusing the file the current selection references when it already
 * holds the same token, and settings are written in one update; with `pinLocalSessions`, that update also sets
 * `sessions.storage` to the local default store. On failure nothing is changed.
 */
export async function joinSharedDatabase(
	options: JoinTeamOptions & { readonly pinLocalSessions: boolean },
	source: Exclude<TeamInputSource, "env">,
	connectionTimeoutMs: number = TEAM_CONNECTION_TIMEOUT_MS,
): Promise<SharedDatabaseJoin> {
	const agentDir = resolve(options.agentDir ?? getAgentDir());
	const cwd = resolve(options.cwd ?? process.cwd());
	const url = checkTeamUrl(options.url, source);
	if (options.token !== undefined && options.tokenFile !== undefined) {
		throw conflictingTeamToken(source, source === "cli" ? ["--token-file"] : ["token", "tokenFile"]);
	}
	let token: string | undefined;
	if (options.tokenFile !== undefined) token = readTeamTokenFile(resolve(cwd, options.tokenFile), source);
	else if (options.token !== undefined) {
		token = options.token.trim();
		if (token.length === 0) throw emptyTeamToken(source);
	} else if (!isFileUrl(url)) throw missingTeamToken(url, source);
	const prefix = checkTeamPrefix(options.prefix, source);

	const manager = openGlobalSettings(cwd, agentDir);
	const settingsPath = settingsPathOf(agentDir);
	// An unreadable settings file looks like one with no packages installed, so it is reported first.
	if ((await resolvePackageStorageAdapter(LIBSQL_ADAPTER_PACKAGE, agentDir)) === undefined) {
		throw new TeamProfileError("adapter-not-installed", {
			subject: `${LIBSQL_ADAPTER_PACKAGE} for ${agentDir}`,
			hint: `Install it, then run this command again: atomic install npm:${LIBSQL_ADAPTER_PACKAGE}`,
		});
	}
	await checkConnectionWithin(url, token, agentDir, connectionTimeoutMs);

	const previous: StorageSettingsSelection | undefined = manager.getGlobalSettings().storage;
	const previousPin = manager.getGlobalSettings().sessions?.storage;
	const reused = token === undefined ? undefined : reusableTokenFile(previous, token, agentDir);
	const tokenPath =
		token === undefined ? undefined : (reused ?? join(agentDir, `${STORAGE_TOKEN_FILE}.${randomUUID()}`));
	if (token !== undefined && tokenPath !== undefined && reused === undefined) {
		try {
			writePrivateFile(tokenPath, token);
		} catch (error) {
			throw new TeamProfileError("token-write-failed", {
				subject: tokenPath,
				detail: describeStorageError(error as Error),
				hint: "Nothing was changed. Check that the agent directory is writable, then run the command again.",
				cause: error as Error,
			});
		}
	}
	const storage: StorageSettingsSelection = {
		adapter: LIBSQL_ADAPTER_PACKAGE,
		options: { url },
		...(tokenPath === undefined
			? {}
			: { secrets: { authToken: { file: relative(dirname(agentDir), tokenPath).split(sep).join("/") } } }),
		...(prefix === undefined ? {} : { prefix }),
	};
	// Publishing settings is the commit point; an unsuccessful write removes only a token file it created.
	if (options.pinLocalSessions) manager.setStorageLayout({ storage, sessionsStorage: LOCAL_SESSIONS_STORAGE });
	else manager.setStorage(storage);
	await manager.flush();
	const writeFailure = manager.drainErrors()[0];
	if (writeFailure !== undefined) {
		const error = settingsWriteError(
			settingsPath,
			writeFailure.error,
			"Nothing was changed: the previous selection and its token are kept.",
		);
		if (tokenPath !== undefined && reused === undefined)
			cleanupAfter(error, () => rmSync(tokenPath, { force: true }));
		throw error;
	}
	return {
		settingsPath,
		storage,
		...(options.pinLocalSessions ? { sessionsStorage: LOCAL_SESSIONS_STORAGE } : {}),
		...(tokenPath === undefined ? {} : { tokenPath }),
		token: tokenPath === undefined ? "none" : reused === undefined ? "new" : "reused",
		...(previous === undefined || JSON.stringify(previous) === JSON.stringify(storage)
			? {}
			: { replaced: describePrevious(() => selectStorage(previous, "settings", "storage", "")) }),
		...(options.pinLocalSessions && previousPin !== undefined && !isLocalSessionsPin(previousPin)
			? {
					replacedSessionsStorage: describePrevious(() =>
						selectSessionSetting(previousPin, "sessions.storage", agentDir),
					),
				}
			: {}),
	};
}

function describePrevious(select: () => StorageSelection): string {
	try {
		return describeStorageSelection(select());
	} catch (error) {
		if (error instanceof StorageError) return "an invalid selection";
		throw error;
	}
}

async function restartBroker(
	agentDir: string,
	context: TeamOperationContext,
	onProgress: ((line: string) => void) | undefined,
): Promise<TeamBrokerRestart> {
	try {
		const control = context.loadControl
			? await context.loadControl()
			: await (await import("../intercom-broker-control.js")).loadIntercomBrokerControl();
		return await control.restartIntercomBroker(agentDir, onProgress === undefined ? {} : { onProgress });
	} catch (error) {
		return {
			status: "failed",
			error: new TeamProfileError("broker-restart-failed", {
				subject: agentDir,
				detail: describeStorageError(error as Error),
				hint: "The settings are saved. Run `atomic intercom restart` so the broker uses them.",
				cause: error as Error,
			}),
		};
	}
}

const installedAdapters = new Map<string, Promise<void>>();

async function loadTeamAdapter(agentDir: string, reason: string): Promise<void> {
	try {
		await loadStorageAdapter(LIBSQL_ADAPTER_PACKAGE, { agentDir, domain: "sessions" });
	} catch (error) {
		if (!(error instanceof StorageAdapterLoadError)) throw error;
		throw new TeamProfileError("adapter-not-installed", {
			subject: `${LIBSQL_ADAPTER_PACKAGE} for ${agentDir}`,
			detail: describeStorageError(error.cause instanceof Error ? error.cause : error),
			hint: `${reason} opens the team database through it. Install it, then run again: atomic install npm:${LIBSQL_ADAPTER_PACKAGE}`,
			cause: error,
		});
	}
}

/**
 * Fail fast, before any store opens, when this process selects the team database but cannot load the libSQL
 * adapter: `ATOMIC_PROFILE=ci`, or an SDK `storage` selection naming the adapter. The adapter is loaded, not
 * opened, once per agent directory and process. The CLI checks at startup and `createAgentSession` before it
 * creates a session.
 */
export function assertTeamAdapterInstalled(
	agentDir: string,
	selection?: { readonly adapter?: string } | object,
): Promise<void> {
	const reason =
		environmentTeamProfile() !== undefined
			? "ATOMIC_PROFILE=ci"
			: selection !== undefined && "adapter" in selection && selection.adapter === LIBSQL_ADAPTER_PACKAGE
				? "The storage selection"
				: undefined;
	if (reason === undefined) return Promise.resolve();
	const key = resolve(agentDir);
	let check = installedAdapters.get(key);
	if (check === undefined) {
		check = loadTeamAdapter(key, reason);
		installedAdapters.set(key, check);
		check.catch(() => installedAdapters.delete(key));
	}
	return check;
}

/** `joinTeam` with the input source its errors name and the CLI's broker control. */
export async function joinTeamWith(
	options: JoinTeamOptions,
	source: Exclude<TeamInputSource, "env">,
	context: TeamOperationContext = {},
): Promise<TeamJoinResult> {
	const joined = await joinSharedDatabase(
		{ ...options, pinLocalSessions: true },
		source,
		context.connectionTimeoutMs ?? TEAM_CONNECTION_TIMEOUT_MS,
	);
	context.onJoined?.(joined);
	const broker = await restartBroker(dirname(joined.settingsPath), context, options.onProgress);
	return { ...joined, sessionsStorage: LOCAL_SESSIONS_STORAGE, broker };
}

/**
 * Use a team database for workflow runs and Intercom while sessions stay private: checks every input and the
 * connection first, then sets the global `storage` setting to the team database and `sessions.storage` to the local
 * default store in one settings write, and restarts the Intercom broker so it routes through the team database.
 * Throws {@link TeamProfileConfigError} for an invalid input and {@link TeamProfileError} otherwise; on any thrown
 * failure nothing was changed. A failed broker restart is reported in `broker`, not thrown.
 */
export function joinTeam(options: JoinTeamOptions): Promise<TeamJoinResult> {
	return joinTeamWith(options, "sdk");
}

/** Whether `storage` is exactly the selection a join writes for this agent directory. */
function isJoinedStorage(storage: StorageSettingsSelection | undefined, agentDir: string): boolean {
	if (storage === undefined || storage.adapter !== LIBSQL_ADAPTER_PACKAGE) return false;
	const keys = Object.keys(storage).filter((key) => key !== "prefix" && key !== "secrets");
	if (keys.length !== 2 || !keys.includes("adapter") || !keys.includes("options")) return false;
	const options = storage.options ?? {};
	if (Object.keys(options).length !== 1 || typeof options.url !== "string") return false;
	if (storage.secrets === undefined) return isFileUrl(options.url);
	const names = Object.keys(storage.secrets);
	const path = secretFilePath(storage.secrets.authToken, agentDir);
	return names.length === 1 && path !== undefined && isJoinTokenFile(path, agentDir);
}

function isLocalSessionsPin(value: NonNullable<Settings["sessions"]>["storage"]): boolean {
	return (
		value !== undefined &&
		JSON.stringify(Object.keys(value)) === JSON.stringify(["path"]) &&
		"path" in value &&
		value.path === LOCAL_SESSIONS_STORAGE.path
	);
}

/** Every token file the given settings reference. */
function referencedTokenFiles(settings: Settings, agentDir: string): string[] {
	const journal = Array.isArray(settings.workflows) ? undefined : settings.workflows?.journal;
	const sessions = settings.sessions?.storage;
	const selections: (StorageSettingsSelection | undefined)[] = [
		settings.storage,
		journal,
		sessions && !("dir" in sessions) ? sessions : undefined,
	];
	return selections.flatMap((selection) =>
		Object.values(selection?.secrets ?? {}).flatMap((ref) => secretFilePath(ref, agentDir) ?? []),
	);
}

/** `leaveTeam` with the CLI's broker control. */
export async function leaveTeamWith(
	options: LeaveTeamOptions = {},
	context: TeamOperationContext = {},
): Promise<TeamLeaveResult> {
	const agentDir = resolve(options.agentDir ?? getAgentDir());
	const cwd = resolve(options.cwd ?? process.cwd());
	const settingsPath = settingsPathOf(agentDir);
	const manager = openGlobalSettings(cwd, agentDir);
	const global = manager.getGlobalSettings();
	const storage: StorageSettingsSelection | undefined = global.storage;
	const removed: TeamSettingKey[] = [];
	const kept: TeamKeptSetting[] = [];
	if (isJoinedStorage(storage, agentDir)) removed.push("storage");
	else if (storage !== undefined) kept.push({ key: "storage", reason: "changed" });
	const pin = global.sessions?.storage;
	const storageRemains = storage !== undefined && !removed.includes("storage");
	if (isLocalSessionsPin(pin)) {
		if (storageRemains) kept.push({ key: "sessions.storage", reason: "storage-remains" });
		else removed.push("sessions.storage");
	} else if (pin !== undefined) kept.push({ key: "sessions.storage", reason: "changed" });
	if (removed.length === 0) return { settingsPath, removed, kept, deletedTokenFiles: [], keptTokenFiles: [] };

	const tokenPath = removed.includes("storage") ? secretFilePath(storage?.secrets?.authToken, agentDir) : undefined;
	manager.setStorageLayout({
		...(removed.includes("storage") ? { storage: undefined } : {}),
		...(removed.includes("sessions.storage") ? { sessionsStorage: undefined } : {}),
	});
	await manager.flush();
	const writeFailure = manager.drainErrors()[0];
	if (writeFailure !== undefined) throw settingsWriteError(settingsPath, writeFailure.error, "Nothing was changed.");
	context.onLeft?.({ settingsPath, removed, kept });
	const broker = removed.includes("storage") ? await restartBroker(agentDir, context, options.onProgress) : undefined;
	const deletedTokenFiles: string[] = [];
	const keptTokenFiles: string[] = [];
	if (tokenPath !== undefined) {
		const remaining = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
		const references = [
			...referencedTokenFiles(remaining.getGlobalSettings(), agentDir),
			...referencedTokenFiles(remaining.getProjectSettings(), agentDir),
		];
		if (references.includes(tokenPath)) keptTokenFiles.push(tokenPath);
		else {
			try {
				rmSync(tokenPath, { force: true });
			} catch (error) {
				throw new TeamProfileError("token-delete-failed", {
					subject: tokenPath,
					detail: describeStorageError(error as Error),
					hint: "The team settings were removed. Delete the token file yourself.",
					cause: error as Error,
				});
			}
			deletedTokenFiles.push(tokenPath);
		}
	}
	return {
		settingsPath,
		removed,
		kept,
		deletedTokenFiles,
		keptTokenFiles,
		...(broker === undefined ? {} : { broker }),
	};
}

/**
 * Restore the individual layout: remove the global `storage` setting and the `sessions.storage` pin when they hold
 * exactly what `joinTeam` writes, leave every other value in place, delete the removed selection's token file unless
 * another setting references it, and restart the Intercom broker when `storage` was removed. The pin is kept while
 * another `storage` remains, because sessions would otherwise move to it. Running it again changes nothing.
 */
export function leaveTeam(options: LeaveTeamOptions = {}): Promise<TeamLeaveResult> {
	return leaveTeamWith(options);
}

function isLocalDefault(selection: StorageSelection, agentDir: string): boolean {
	return (
		selection.kind === "sqlite" &&
		!selection.prefix &&
		resolve(selection.path) === resolve(join(dirname(agentDir), "workflows", "journal.sqlite"))
	);
}

/**
 * The layout in effect for this process and working directory, from the storage each domain selects (process-level
 * selections, `ATOMIC_PROFILE=ci`, trusted project settings and global settings, as sessions, the workflows extension
 * and the Intercom broker resolve them). Reads only; an invalid selection throws its `StorageConfigError`.
 */
export function selectTeamProfile(options: TeamProfileOptions = {}): TeamProfile {
	const agentDir = resolve(options.agentDir ?? getAgentDir());
	const cwd = resolve(options.cwd ?? process.cwd());
	const manager = SettingsManager.create(cwd, agentDir, { projectTrusted: projectTrust(cwd, agentDir) });
	const failure = manager.drainErrors()[0];
	if (failure !== undefined) {
		if (isLocked(failure.error)) throw lockedError(`${failure.scope} settings`, failure.error, "Nothing was read.");
		throw new TeamProfileError("settings-unreadable", {
			subject: `${failure.scope} settings`,
			detail: unreadableSettingsDetail(failure.error),
			hint: "Fix the settings file, then run the command again.",
			cause: failure.error,
		});
	}
	const merged = manager.getSettings();
	const sessions = selectSessionStorage(cwd, { agentDir, settings: merged }) as StorageSelection;
	const journal = selectJournal(agentDir, merged);
	const intercom = selectIntercomStorage(agentDir, manager.getGlobalSettings().storage);
	const shared = intercom?.kind === "adapter" ? storageSelectionKey(intercom, agentDir) : undefined;
	const sharesJournal = shared !== undefined && storageSelectionKey(journal, agentDir) === shared;
	const profile: TeamProfileName =
		isLocalDefault(sessions, agentDir) && isLocalDefault(journal, agentDir) && intercom === undefined
			? "individual"
			: sharesJournal && isLocalDefault(sessions, agentDir)
				? "team"
				: sharesJournal && storageSelectionKey(sessions, agentDir) === shared
					? "ci"
					: "custom";
	return {
		profile,
		sessions: describeStorageSelection(sessions),
		journal: describeStorageSelection(journal),
		intercom: intercom === undefined ? "off" : describeStorageSelection(intercom),
	};
}
