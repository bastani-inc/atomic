/**
 * The layout in effect (`getTeamProfile`, `atomic team status`) and the shared PostgreSQL database join that
 * `atomic storage join` runs.
 */

import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { getAgentDir } from "../../config.js";
import { parseJsonFileContent } from "../../utils/json.ts";
import { prepareLockTakeover } from "../lock-holder.js";
import { resolvePackageStorageAdapter } from "../package-manager-storage-adapters.js";
import { selectSessionStorageWithSettings } from "../session-storage.js";
import { SettingsManager } from "../settings-manager.ts";
import type { Settings } from "../settings-schema.ts";
import { FileSettingsStorage, writeSettingsFile } from "../settings-storage.ts";
import { openAdapterSelectionDatabase } from "./adapter-open.js";
import {
	describeStorageError,
	StorageConfigError,
	StorageError,
	TeamProfileError,
	TeamProfileTimeoutError,
} from "./errors.js";
import { defaultSessionDatabasePath, storageHomeDir } from "./file-identity.js";
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
	inMemorySecret,
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

// Removed with libSQL support; see libsql-removed.ts for why they are still exported.
export {
	assertTeamAdapterInstalled,
	joinTeam,
	joinTeamWith,
	leaveTeam,
	leaveTeamWith,
	storageFingerprint,
} from "./libsql-removed.js";

export interface TeamProfileOptions {
	readonly agentDir?: string;
	readonly cwd?: string;
}

/** `atomic storage join`'s options. */
export interface SharedDatabaseJoinOptions {
	/** A `postgres://` or `postgresql://` URL, without a password. */
	readonly url: string;
	/** A password or token file another process keeps fresh, referenced in place and read for every new connection. */
	readonly tokenFile?: string;
	/** Table prefix, to share one database between projects or teams. */
	readonly prefix?: string;
	/** Default: the Atomic agent directory. */
	readonly agentDir?: string;
	/** Default: `process.cwd()`. */
	readonly cwd?: string;
	/** A password file, copied to a private file in the agent directory. */
	readonly passwordFile?: string;
	/** The platform credential the adapter obtains instead of a password. */
	readonly auth?: PostgresAuth;
}

/** What the shared-database join wrote. */
export interface SharedDatabaseJoin {
	readonly settingsPath: string;
	/** The `storage` value written: the adapter, the URL, a password file reference and the prefix, never a password. */
	readonly storage: StorageSettingsSelection;
	/** The private password file the selection references. */
	readonly tokenPath?: string;
	/** `new`: written now; `reused`: the file the previous selection referenced already held this password. */
	readonly token: "new" | "reused" | "none";
	/** `--token-file`: the file the selection references in place, read again for every new connection. */
	readonly referencedFile?: string;
	/** The previous `storage` selection it replaced, described without its options or secrets. */
	readonly replaced?: string;
}

export type TeamProfileName = "individual" | "team" | "ci" | "custom";

/** The layout in effect, from the selections each domain actually uses. */
export interface TeamProfile {
	/**
	 * `individual`: sessions in the local default store, Intercom on this machine only.
	 * `team`: sessions in the local default store; Intercom on one shared adapter database.
	 * `ci`: sessions and Intercom on one shared adapter database.
	 * `custom`: anything else.
	 */
	readonly profile: TeamProfileName;
	readonly sessions: string;
	/** `off` when Intercom has no shared selection. */
	readonly intercom: string;
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
	readonly secretName: "password";
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

/** How long a join waits for the shared database to connect and answer `SELECT 1`, after the adapter has loaded. */
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
	const checked = checkSharedDatabaseArguments(options);
	const target = { adapter: POSTGRES_ADAPTER_PACKAGE, secretName: "password" } as const;
	if (checked.auth !== undefined) return { target: { ...target, options: { url: checked.url, auth: checked.auth } } };
	if (checked.passwordFile !== undefined) {
		const password = readTeamTokenFile(resolve(cwd, checked.passwordFile), source, "--password-file");
		return { target: { ...target, options: { url: checked.url }, secret: password }, copy: password };
	}
	const reference = resolve(cwd, checked.tokenFile as string);
	const password = readTeamTokenFile(reference, source, undefined, "as-connections-read");
	return { target: { ...target, options: { url: checked.url }, secret: password }, reference };
}

/**
 * Point the global `storage` setting at a shared PostgreSQL database, as `atomic storage join` does. Every input and
 * precondition is checked before the first write: the URL, the credential, the prefix, readable global settings, the
 * installed adapter and a `SELECT 1` on the database. A `--password-file` password is stored in a private file in the
 * agent directory (mode 600), reusing the file the current selection references when it already holds the same
 * password, and settings are written in one update. On failure nothing is changed.
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
		try {
			writeSettingsFile(settingsPath, JSON.stringify(next, null, 2));
		} catch (error) {
			const failure = settingsWriteError(settingsPath, error as Error, unchanged);
			if (created !== undefined) cleanupAfter(failure, () => rmSync(created, { force: true }));
			throw failure;
		}
		return { storage, previous, tokenPath, reused };
	});
	const { storage, previous, tokenPath, reused } = published;
	return {
		settingsPath,
		storage,
		...(tokenPath === undefined ? {} : { tokenPath }),
		token: tokenPath === undefined ? "none" : reused === undefined ? "new" : "reused",
		...(plan.reference === undefined ? {} : { referencedFile: plan.reference }),
		...(previous === undefined || JSON.stringify(previous) === JSON.stringify(storage)
			? {}
			: { replaced: describePrevious(() => selectStorage(previous, "settings", "storage", "")) }),
	};
}

function describePrevious(select: () => StorageSelection): string {
	try {
		return describeStorageSelection(select());
	} catch (error) {
		if (error instanceof StorageConfigError && error.reason === "libsql-removed")
			return "a libSQL database, which this release no longer opens";
		if (error instanceof StorageError) return "an invalid selection";
		throw error;
	}
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
