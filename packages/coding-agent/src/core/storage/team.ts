/**
 * Team setup: one settings write that shares Intercom routing through a team database while
 * sessions stay in the local store (`joinTeam`), its exact undo (`leaveTeam`), the layout in effect
 * (`getTeamProfile`), and the shared-database join that `atomic storage join` and `atomic team join` both run.
 */

import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { getAgentConfigPaths, getAgentDir, getProjectConfigPaths } from "../../config.js";
import { parseJsonFileContent } from "../../utils/json.ts";
import type { IntercomBrokerControl, RestartOutcome } from "../intercom-broker-control.js";
import { prepareLockTakeover } from "../lock-holder.js";
import { resolvePackageStorageAdapter } from "../package-manager-storage-adapters.js";
import { selectSessionSetting, selectSessionStorageWithSettings } from "../session-storage.js";
import { SettingsManager } from "../settings-manager.ts";
import { deepMergeSettings } from "../settings-merge.js";
import type { Settings } from "../settings-schema.ts";
import { FileSettingsStorage, writeSettingsFile } from "../settings-storage.ts";
import { openAdapterSelectionDatabase } from "./adapter-open.js";
import {
	describeStorageError,
	StorageAdapterLoadError,
	StorageConfigError,
	StorageError,
	TeamProfileError,
	TeamProfileTimeoutError,
} from "./errors.js";
import { defaultSessionDatabasePath, storageHomeDir } from "./file-identity.js";
import { processSharedStorageSelectionAsync } from "./process-selection.js";
import {
	loadStorageAdapter,
	secretFilePath as resolveProviderSecretFilePath,
	type SecretRef,
	type StorageAdapterModule,
	type StorageSelection,
	storageSelectionKey,
} from "./provider.js";
import {
	checkSharedDatabaseArguments,
	checkTeamPrefix,
	checkTeamUrl,
	conflictingTeamToken,
	emptyTeamToken,
	environmentTeamProfileAsync,
	inMemorySecret,
	isFileUrl,
	isPostgresUrl,
	LIBSQL_ADAPTER_PACKAGE,
	LOCAL_SESSIONS_STORAGE,
	missingTeamToken,
	POSTGRES_ADAPTER_PACKAGE,
	type PostgresAuth,
	readTeamTokenFile,
	STORAGE_TOKEN_FILE,
	type StorageSettingsSelection,
	selectStorage,
	type TeamInputSource,
} from "./selection.js";
import {
	describeStorageSelection,
	projectTrust,
	selectIntercomStorage,
	selectSharedStorage,
} from "./storage-status.js";

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

/** `atomic storage join`'s options: {@link JoinTeamOptions} plus the Postgres credential sources. */
export interface SharedDatabaseJoinOptions extends JoinTeamOptions {
	/** Also pin `sessions.storage` to the local default store, as `atomic team join` does; libSQL URLs only. */
	readonly pinLocalSessions: boolean;
	/** Postgres: a password file, copied to a private file in the agent directory. */
	readonly passwordFile?: string;
	/** Postgres: the platform credential the adapter obtains instead of a password. */
	readonly auth?: PostgresAuth;
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
	/** Postgres `--token-file`: the file the selection references in place, read again for every new connection. */
	readonly referencedFile?: string;
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
	 * `individual`: sessions in the local default store, Intercom on this machine only.
	 * `team`: sessions in the local default store; Intercom on one shared adapter database.
	 * `ci`: sessions and Intercom on one shared adapter database (what `ATOMIC_PROFILE=ci` selects).
	 * `custom`: anything else.
	 */
	readonly profile: TeamProfileName;
	readonly sessions: string;
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

function unreadableSettingsError(subject: string, cause: Error): TeamProfileError {
	return new TeamProfileError("settings-unreadable", {
		subject,
		detail: unreadableSettingsDetail(cause),
		hint: `Fix ${subject} first, then run the command again.`,
		cause,
	});
}

function openGlobalSettings(cwd: string, agentDir: string): SettingsManager {
	const manager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	// Project settings are not read here. A wrong-typed value is ignored and reported at startup; only an unreadable file
	// stops a command.
	const failure = manager.drainErrors().find(({ invalidKey }) => invalidKey === undefined);
	if (failure !== undefined) {
		const settingsPath = failure.path ?? settingsPathOf(agentDir);
		if (isLocked(failure.error)) throw lockedError(settingsPath, failure.error, "Nothing was changed.");
		throw unreadableSettingsError(settingsPath, failure.error);
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

/** What a join checks: the adapter, its options, and the secret it will reference, held in memory for the check. */
interface JoinTarget {
	readonly adapter: string;
	readonly options: Readonly<Record<string, string>>;
	readonly secretName: "authToken" | "password";
	readonly secret?: string;
}

async function checkConnection(target: JoinTarget, agentDir: string, adapter: StorageAdapterModule): Promise<void> {
	const database = await openAdapterSelectionDatabase(
		{
			kind: "adapter",
			module: target.adapter,
			options: target.options,
			...(target.secret === undefined ? {} : { secrets: { [target.secretName]: inMemorySecret(target.secret) } }),
		},
		{ agentDir, domain: "sessions" },
		adapter,
	);
	try {
		await database.get("SELECT 1 AS ok");
	} finally {
		await database.close();
	}
}

/** The `StorageConfigError` `error` is, or was caused by, if any. */
function storageConfigCause(error: unknown): StorageConfigError | undefined {
	let current = error;
	for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
		if (current instanceof StorageConfigError) return current;
		current = current.cause;
	}
	return undefined;
}

/** How long a join waits for the team database to connect and answer `SELECT 1`, after the adapter has loaded. */
export const TEAM_CONNECTION_TIMEOUT_MS = 15_000;

/**
 * `checkConnection`, bounded by `timeoutMs` once the adapter module has loaded: a database that does not answer fails
 * with a retryable {@link TeamProfileTimeoutError} instead of waiting for the operating system's connection timeout. A
 * check that fails after the deadline is recorded as the timeout error's `cleanupCause`. `elapsedMs` is never below
 * `timeoutMs`: Node can fire a timer a millisecond before the wall clock shows its delay has passed.
 */
async function checkConnectionWithin(target: JoinTarget, agentDir: string, timeoutMs: number): Promise<void> {
	const url = target.options.url as string;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let started = 0;
	let check: Promise<"answered"> | undefined;
	let outcome: "answered" | "timed-out";
	try {
		const adapter = await loadStorageAdapter(target.adapter, { agentDir, domain: "sessions" });
		started = Date.now();
		check = checkConnection(target, agentDir, adapter).then(() => "answered" as const);
		const deadline = new Promise<"timed-out">((resolveDeadline) => {
			timer = setTimeout(() => resolveDeadline("timed-out"), timeoutMs);
		});
		outcome = await Promise.race([check, deadline]);
	} catch (error) {
		// A cloud identity that cannot sign in, such as one whose SDK is not installed, is no connection failure that
		// passes: it fails at once and says what to install or change (#5218).
		const config = storageConfigCause(error);
		if (config?.reason === "auth-unavailable")
			throw new TeamProfileError("auth-unavailable", {
				subject: url,
				detail: "auth-unavailable",
				hint: `Nothing was changed. ${config.hint ?? "Check the cloud identity's sign-in"}`,
				cause: error as Error,
			});
		if (config !== undefined) throw config;
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
		elapsedMs: Math.max(Date.now() - started, timeoutMs),
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
	return resolve(resolveProviderSecretFilePath(ref.file, agentDir));
}

/** Whether a path is a token file that a join created in this agent directory. */
function isJoinTokenFile(path: string, agentDir: string): boolean {
	return dirname(path) === resolve(agentDir) && basename(path).startsWith(`${STORAGE_TOKEN_FILE}.`);
}

/** The join-created token file `storage` references as `secretName`, when it already holds `token`. */
function reusableTokenFile(
	storage: StorageSettingsSelection | undefined,
	secretName: JoinTarget["secretName"],
	token: string,
	agentDir: string,
): string | undefined {
	const path = secretFilePath(storage?.secrets?.[secretName], agentDir);
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

function withGlobalSettings<T>(agentDir: string, outcome: string, run: (settings: Settings) => T): T {
	const settingsPath = settingsPathOf(agentDir);
	let result: T | undefined;
	try {
		new FileSettingsStorage(dirname(agentDir), agentDir).withPrimaryWriteLock("global", (current) => {
			let settings: Settings = {};
			if (current !== undefined) {
				try {
					const parsed: unknown = parseJsonFileContent(current);
					if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
						throw new TypeError("not a JSON object");
					settings = parsed as Settings;
				} catch (error) {
					throw unreadableSettingsError(settingsPath, error as Error);
				}
			}
			result = run(settings);
			return undefined;
		});
	} catch (error) {
		if (error instanceof TeamProfileError) throw error;
		throw settingsWriteError(settingsPath, error as Error, outcome);
	}
	return result as T;
}

function cleanupAfter(primary: Error, cleanup: () => void): void {
	try {
		cleanup();
	} catch (cleanupCause) {
		Object.defineProperty(primary, "cleanupCause", { value: cleanupCause, configurable: true });
	}
}

/**
 * What a join checks and writes: the adapter selection, the secret to copy into a private file (`copy`), or the
 * absolute path of a file the selection references in place (`reference`). Every input is checked here, before
 * anything is read from settings or the network.
 */
interface JoinPlan {
	readonly target: JoinTarget;
	readonly copy?: string;
	readonly reference?: string;
}

function joinPlan(options: SharedDatabaseJoinOptions, source: Exclude<TeamInputSource, "env">, cwd: string): JoinPlan {
	if (!options.pinLocalSessions && isPostgresUrl(options.url)) {
		const checked = checkSharedDatabaseArguments(options);
		const target = { adapter: POSTGRES_ADAPTER_PACKAGE, secretName: "password" } as const;
		if (checked.auth !== undefined)
			return { target: { ...target, options: { url: checked.url, auth: checked.auth } } };
		if (checked.passwordFile !== undefined) {
			const password = readTeamTokenFile(resolve(cwd, checked.passwordFile), source, "--password-file");
			return { target: { ...target, options: { url: checked.url }, secret: password }, copy: password };
		}
		const reference = resolve(cwd, checked.tokenFile as string);
		const password = readTeamTokenFile(reference, source, undefined, "as-connections-read");
		return { target: { ...target, options: { url: checked.url }, secret: password }, reference };
	}
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
	return {
		target: { adapter: LIBSQL_ADAPTER_PACKAGE, options: { url }, secretName: "authToken", secret: token },
		copy: token,
	};
}

/**
 * Point the global `storage` setting at a shared libSQL / Turso or PostgreSQL database, as `atomic storage join` and
 * `atomic team join` do. Every input and precondition is checked before the first write: the URL, the token, the
 * prefix, readable global settings, the installed adapter and a `SELECT 1` on the database. The token is stored in a
 * private file in the agent directory (mode 600), reusing the file the current selection references when it already
 * holds the same token, and settings are written in one update; with `pinLocalSessions`, that update also sets
 * `sessions.storage` to the local default store. On failure nothing is changed.
 */
export async function joinSharedDatabase(
	options: SharedDatabaseJoinOptions,
	source: Exclude<TeamInputSource, "env">,
	connectionTimeoutMs: number = TEAM_CONNECTION_TIMEOUT_MS,
): Promise<SharedDatabaseJoin> {
	const agentDir = resolve(options.agentDir ?? getAgentDir());
	const cwd = resolve(options.cwd ?? process.cwd());
	const plan = joinPlan(options, source, cwd);
	const { target } = plan;
	const token = plan.copy;
	const prefix = checkTeamPrefix(options.prefix, source);

	openGlobalSettings(cwd, agentDir);
	const settingsPath = settingsPathOf(agentDir);
	// An unreadable settings file looks like one with no packages installed, so it is reported first.
	if ((await resolvePackageStorageAdapter(target.adapter, agentDir)) === undefined) {
		throw new TeamProfileError("adapter-not-installed", {
			subject: `${target.adapter} for ${agentDir}`,
			hint: `Install it, then run this command again: atomic install npm:${target.adapter}`,
		});
	}
	await checkConnectionWithin(target, agentDir, connectionTimeoutMs);

	const unchanged = "Nothing was changed: the previous selection and its token are kept.";
	await prepareLockTakeover(`${settingsPath}.lock`);
	const published = withGlobalSettings(agentDir, unchanged, (settings) => {
		const previous = settings.storage;
		// Without a token there is nothing to compare, so no token file is read.
		const reused = token === undefined ? undefined : reusableTokenFile(previous, target.secretName, token, agentDir);
		const tokenPath =
			token === undefined ? undefined : (reused ?? join(agentDir, `${STORAGE_TOKEN_FILE}.${randomUUID()}`));
		const created = token !== undefined && tokenPath !== undefined && reused === undefined ? tokenPath : undefined;
		if (token !== undefined && created !== undefined) {
			try {
				writePrivateFile(created, token);
			} catch (error) {
				throw new TeamProfileError("token-write-failed", {
					subject: created,
					detail: describeStorageError(error as Error),
					hint: "Nothing was changed. Check that the agent directory is writable, then run the command again.",
					cause: error as Error,
				});
			}
		}
		const file =
			tokenPath === undefined ? plan.reference : relative(storageHomeDir(agentDir), tokenPath).split(sep).join("/");
		const storage: StorageSettingsSelection = {
			adapter: target.adapter,
			options: target.options,
			...(file === undefined ? {} : { secrets: { [target.secretName]: { file } } }),
			...(prefix === undefined ? {} : { prefix }),
		};
		const next: Settings = { ...settings, storage };
		if (options.pinLocalSessions) {
			next.sessions = { ...settings.sessions, storage: LOCAL_SESSIONS_STORAGE };
			next.teamJoin = { storage: storageFingerprint(storage) };
		}
		try {
			writeSettingsFile(settingsPath, JSON.stringify(next, null, 2));
		} catch (error) {
			const failure = settingsWriteError(settingsPath, error as Error, unchanged);
			if (created !== undefined) cleanupAfter(failure, () => rmSync(created, { force: true }));
			throw failure;
		}
		return { storage, previous, previousPin: settings.sessions?.storage, tokenPath, reused };
	});
	const { storage, previous, previousPin, tokenPath, reused } = published;
	return {
		settingsPath,
		storage,
		...(options.pinLocalSessions ? { sessionsStorage: LOCAL_SESSIONS_STORAGE } : {}),
		...(tokenPath === undefined ? {} : { tokenPath }),
		token: tokenPath === undefined ? "none" : reused === undefined ? "new" : "reused",
		...(plan.reference === undefined ? {} : { referencedFile: plan.reference }),
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
 * Whether `ATOMIC_PROFILE=ci` still selects the team database in this process. `--storage` and `ATOMIC_STORAGE`
 * outrank it for sessions and the Intercom broker alike, while a domain variable outranks it only for
 * its own store. So the profile selects some store exactly when it is the shared selection the broker receives.
 */
async function teamProfileInEffect(): Promise<boolean> {
	const team = await environmentTeamProfileAsync();
	return team !== undefined && (await processSharedStorageSelectionAsync()) === JSON.stringify(team);
}

/**
 * Fail fast, before any store opens, when this process selects the team database but cannot load the libSQL
 * adapter: `ATOMIC_PROFILE=ci` while it selects a store, or an SDK `storage` selection naming the adapter. The
 * adapter is loaded, not opened, once per agent directory and process. The CLI checks at startup and
 * `createAgentSession` before it creates a session.
 */
export async function assertTeamAdapterInstalled(
	agentDir: string,
	selection?: { readonly adapter?: string } | object,
): Promise<void> {
	const reason = (await teamProfileInEffect())
		? "ATOMIC_PROFILE=ci"
		: selection !== undefined && "adapter" in selection && selection.adapter === LIBSQL_ADAPTER_PACKAGE
			? "The storage selection"
			: undefined;
	if (reason === undefined) return;
	const key = resolve(agentDir);
	let check = installedAdapters.get(key);
	if (check === undefined) {
		const current = loadTeamAdapter(key, reason).catch((error: unknown) => {
			if (installedAdapters.get(key) === current) installedAdapters.delete(key);
			throw error;
		});
		installedAdapters.set(key, current);
		check = current;
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
 * Use a team database for Intercom while sessions stay private: checks every input and the
 * connection first, then sets the global `storage` setting to the team database and `sessions.storage` to the local
 * default store in one settings write, and restarts the Intercom broker so it routes through the team database.
 * Throws {@link TeamProfileConfigError} for an invalid input and {@link TeamProfileError} otherwise; on any thrown
 * failure nothing was changed. A failed broker restart is reported in `broker`, not thrown.
 */
export function joinTeam(options: JoinTeamOptions): Promise<TeamJoinResult> {
	return joinTeamWith(options, "sdk");
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, entry]) => entry !== undefined)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
		return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

export function storageFingerprint(storage: StorageSettingsSelection): string {
	return `sha256:${createHash("sha256").update(canonicalJson(storage)).digest("hex")}`;
}

/** Whether `storage` is exactly the selection the last team join recorded, for this agent directory. */
function isJoinedStorage(
	storage: StorageSettingsSelection | undefined,
	record: Settings["teamJoin"],
	agentDir: string,
): boolean {
	if (storage === undefined || record?.storage !== storageFingerprint(storage)) return false;
	if (storage.adapter !== LIBSQL_ADAPTER_PACKAGE) return false;
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
	// A `workflows.journal` selection an earlier release used still references its token file, which leaving keeps.
	const workflows = (settings as { readonly workflows?: unknown }).workflows;
	const journal =
		workflows !== null && typeof workflows === "object" && !Array.isArray(workflows)
			? (workflows as { readonly journal?: StorageSettingsSelection }).journal
			: undefined;
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

function projectSettingsPathOf(cwd: string): string {
	return getProjectConfigPaths(cwd, "settings.json")[0] as string;
}

function isSameFile(first: string, second: string): boolean {
	return existsSync(first) && existsSync(second) && realpathSync(first) === realpathSync(second);
}

function readIndependentProjectSettings(cwd: string, settingsPath: string): Settings {
	let merged: Settings = {};
	for (const path of getProjectConfigPaths(cwd, "settings.json").reverse()) {
		if (!existsSync(path) || isSameFile(settingsPath, path)) continue;
		try {
			merged = deepMergeSettings(merged, parseJsonFileContent(readFileSync(path, "utf-8")) as Settings);
		} catch (error) {
			throw unreadableSettingsError(path, error as Error);
		}
	}
	return merged;
}

function readIndependentGlobalSettings(agentDir: string, settingsPath: string): Settings {
	const paths = agentDir === getAgentDir() ? getAgentConfigPaths("settings.json") : [settingsPath];
	let merged: Settings = {};
	for (const path of paths.reverse()) {
		if (!existsSync(path) || isSameFile(settingsPath, path)) continue;
		try {
			merged = deepMergeSettings(merged, parseJsonFileContent(readFileSync(path, "utf-8")) as Settings);
		} catch (error) {
			throw unreadableSettingsError(path, error as Error);
		}
	}
	return merged;
}

function readProjectSettings(cwd: string, agentDir: string): Settings {
	const projectPath = projectSettingsPathOf(cwd);
	const storage = new FileSettingsStorage(cwd, agentDir, {
		projectReadPaths: getProjectConfigPaths(cwd, "settings.json"),
	});
	try {
		let merged: string | undefined;
		storage.withLock("project", (current) => {
			merged = current;
			return undefined;
		});
		return merged === undefined ? {} : (parseJsonFileContent(merged) as Settings);
	} catch (error) {
		if (isLocked(error as Error)) throw lockedError(projectPath, error as Error, "Nothing was changed.");
		throw unreadableSettingsError(projectPath, error as Error);
	}
}

/** `leaveTeam` with the CLI's broker control. */
export async function leaveTeamWith(
	options: LeaveTeamOptions = {},
	context: TeamOperationContext = {},
): Promise<TeamLeaveResult> {
	const agentDir = resolve(options.agentDir ?? getAgentDir());
	const cwd = resolve(options.cwd ?? process.cwd());
	const settingsPath = settingsPathOf(agentDir);
	openGlobalSettings(cwd, agentDir);
	const unchanged = "Nothing was changed.";
	const empty: TeamLeaveResult = { settingsPath, removed: [], kept: [], deletedTokenFiles: [], keptTokenFiles: [] };
	if (!existsSync(settingsPath)) return empty;
	const trusted = projectTrust(cwd, agentDir);
	await Promise.all([
		prepareLockTakeover(`${settingsPath}.lock`),
		prepareLockTakeover(`${projectSettingsPathOf(cwd)}.lock`),
	]);
	const outcome = withGlobalSettings(agentDir, unchanged, (global) => {
		const project = isSameFile(settingsPath, projectSettingsPathOf(cwd))
			? readIndependentProjectSettings(cwd, settingsPath)
			: readProjectSettings(cwd, agentDir);
		const inherited = readIndependentGlobalSettings(agentDir, settingsPath);
		const storage: StorageSettingsSelection | undefined = global.storage;
		const removed: TeamSettingKey[] = [];
		const kept: TeamKeptSetting[] = [];
		if (isJoinedStorage(storage, global.teamJoin, agentDir)) removed.push("storage");
		else if (storage !== undefined) kept.push({ key: "storage", reason: "changed" });
		const pin = global.sessions?.storage;
		const storageRemains =
			(storage !== undefined && !removed.includes("storage")) ||
			inherited.storage !== undefined ||
			(trusted && project.storage !== undefined);
		if (isLocalSessionsPin(pin)) {
			if (storageRemains) kept.push({ key: "sessions.storage", reason: "storage-remains" });
			else removed.push("sessions.storage");
		} else if (pin !== undefined) kept.push({ key: "sessions.storage", reason: "changed" });
		if (removed.length === 0) return { ...empty, kept };

		const tokenPath = removed.includes("storage") ? secretFilePath(storage?.secrets?.authToken, agentDir) : undefined;
		const next: Settings = { ...global };
		if (removed.includes("storage")) delete next.storage;
		if (next.storage === undefined) delete next.teamJoin;
		if (removed.includes("sessions.storage")) {
			const { storage: _pin, ...sessions } = { ...global.sessions };
			if (Object.keys(sessions).length === 0) delete next.sessions;
			else next.sessions = sessions;
		}
		try {
			writeSettingsFile(settingsPath, JSON.stringify(next, null, 2));
		} catch (error) {
			throw settingsWriteError(settingsPath, error as Error, unchanged);
		}
		const deletedTokenFiles: string[] = [];
		const keptTokenFiles: string[] = [];
		let tokenFailure: TeamProfileError | undefined;
		if (tokenPath !== undefined) {
			const references = [next, inherited, project].flatMap((settings) => referencedTokenFiles(settings, agentDir));
			if (references.includes(tokenPath)) keptTokenFiles.push(tokenPath);
			else {
				try {
					rmSync(tokenPath, { force: true });
					deletedTokenFiles.push(tokenPath);
				} catch (error) {
					tokenFailure = new TeamProfileError("token-delete-failed", {
						subject: tokenPath,
						detail: describeStorageError(error as Error),
						hint: "The team settings were removed. Delete the token file yourself.",
						cause: error as Error,
					});
				}
			}
		}
		return { settingsPath, removed, kept, deletedTokenFiles, keptTokenFiles, tokenFailure };
	});
	if (outcome.removed.length === 0) return outcome;
	context.onLeft?.({ settingsPath, removed: outcome.removed, kept: outcome.kept });
	const broker = outcome.removed.includes("storage")
		? await restartBroker(agentDir, context, options.onProgress)
		: undefined;
	if ("tokenFailure" in outcome && outcome.tokenFailure !== undefined) throw outcome.tokenFailure;
	return {
		settingsPath,
		removed: outcome.removed,
		kept: outcome.kept,
		deletedTokenFiles: outcome.deletedTokenFiles,
		keptTokenFiles: outcome.keptTokenFiles,
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

function isLocalDefault(selection: StorageSelection, agentDir: string, settings?: Settings): boolean {
	return (
		selection.kind === "sqlite" &&
		!selection.prefix &&
		resolve(selection.path) === resolve(defaultSessionDatabasePath(agentDir, settings))
	);
}

/**
 * The layout in effect for this process and working directory, from the storage each domain selects (process-level
 * selections, `ATOMIC_PROFILE=ci`, trusted project settings and global settings, as sessions and the Intercom broker
 * resolve them). Reads only; an invalid selection throws its `StorageConfigError`.
 */
export function selectTeamProfile(options: TeamProfileOptions = {}): TeamProfile {
	const agentDir = resolve(options.agentDir ?? getAgentDir());
	const cwd = resolve(options.cwd ?? process.cwd());
	const manager = SettingsManager.create(cwd, agentDir, { projectTrusted: projectTrust(cwd, agentDir) });
	const failure = manager.drainErrors().find(({ invalidKey }) => invalidKey === undefined);
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
	const sessions = selectSessionStorageWithSettings(cwd, { agentDir, settings: merged }) as StorageSelection;
	// The shared selection as this directory's settings make it, project settings included: Intercom reads only the
	// global one, so a project that selects another `storage` makes the layout custom.
	const selected = selectSharedStorage(agentDir, merged);
	const intercom = selectIntercomStorage(agentDir, manager.getGlobalSettings().storage);
	const shared = intercom?.kind === "adapter" ? storageSelectionKey(intercom, agentDir) : undefined;
	const sharesStorage =
		shared !== undefined && selected !== undefined && storageSelectionKey(selected, agentDir) === shared;
	const profile: TeamProfileName =
		isLocalDefault(sessions, agentDir, merged) &&
		(selected === undefined || isLocalDefault(selected, agentDir, merged)) &&
		intercom === undefined
			? "individual"
			: sharesStorage && isLocalDefault(sessions, agentDir, merged)
				? "team"
				: sharesStorage && storageSelectionKey(sessions, agentDir) === shared
					? "ci"
					: "custom";
	return {
		profile,
		sessions: describeStorageSelection(sessions),
		intercom: intercom === undefined ? "off" : describeStorageSelection(intercom),
	};
}
