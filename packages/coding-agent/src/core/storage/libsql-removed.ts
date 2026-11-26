import { createHash } from "node:crypto";
import { TeamProfileConfigError } from "./errors.js";
import type { StorageSettingsSelection } from "./selection.js";

/**
 * What refuses libSQL now that its support is removed (0.10.11), and the exports that went with it.
 *
 * This is a module no earlier release has. A process of an earlier release that an in-place update caught keeps the
 * copies of `selection.js`, `team.js` and the rest it loaded, and can load this build's modules later: a named import
 * of a name those copies lack would fail to link, so the modules that refuse libSQL take it from here. The removed
 * exports below stay, re-exported from the paths that had them, so that the earlier release's own code still links
 * against this build's modules: the constants keep their values, and every function throws the `libsql-removed`
 * refusal.
 */

/** The removed libSQL adapter package, which a settings file, variable or SDK selection may still name. */
export const REMOVED_LIBSQL_ADAPTER = "@bastani/atomic-storage-libsql";
/** The variables of the removed `ATOMIC_PROFILE=ci` team profile, which selected a libSQL database. */
export const REMOVED_TEAM_VARIABLES: readonly string[] = [
	"ATOMIC_PROFILE",
	"ATOMIC_TEAM_URL",
	"ATOMIC_TEAM_TOKEN",
	"ATOMIC_TEAM_TOKEN_FILE",
	"ATOMIC_TEAM_PREFIX",
];
/** Where the docs say how to move sessions off libSQL. */
export const LIBSQL_MIGRATION_DOCS_URL = "https://docs.bastani.ai/storage#moving-off-libsql";
/** What every refusal of a libSQL selection, URL or team variable says after its own first sentence. */
export const LIBSQL_REMOVED_HINT = `libSQL support (Turso, sqld and libSQL file: databases) was removed in Atomic 0.10.11. To keep your sessions, export them with Atomic 0.10.11-alpha.2, which reads every libSQL database (npx -y @bastani/atomic@0.10.11-alpha.2 storage export <dir> --storage-file <old-storage.json>), then import them into SQLite or PostgreSQL with this release (atomic storage import <dir>). See ${LIBSQL_MIGRATION_DOCS_URL}`;

/** Whether a database URL is one only the removed libSQL adapter opened. */
export function isLibsqlUrl(url: string): boolean {
	return /^(libsql|https?|wss?):\/\//.test(url) || url.startsWith("file:");
}

/**
 * Refuse the variables of the removed `ATOMIC_PROFILE=ci` team profile, all named at once, so a CI job that still sets
 * them fails before any store opens instead of silently using another one.
 */
export function rejectRemovedTeamProfile(env: NodeJS.ProcessEnv = process.env): void {
	const set = REMOVED_TEAM_VARIABLES.filter((name) => (env[name] ?? "").length > 0);
	if (set.length === 0) return;
	throw new TeamProfileConfigError("libsql-removed", {
		source: "env",
		field: set.join(", "),
		hint: `${set.join(", ")} ${set.length === 1 ? "is" : "are"} set, but the ATOMIC_PROFILE=ci team profile they select was removed with libSQL support. Unset ${set.length === 1 ? "it" : "them"} and select a PostgreSQL database instead: run atomic storage join postgres://… or set ATOMIC_STORAGE. ${LIBSQL_REMOVED_HINT}`,
	});
}

/** The refusal a removed libSQL team setup function throws when called. */
function removedTeamSetup(name: string): TeamProfileConfigError {
	return new TeamProfileConfigError("libsql-removed", {
		source: "sdk",
		field: name,
		hint: `${name}() was removed with libSQL support. Select a PostgreSQL database instead: run atomic storage join postgres://…, or pass createAgentSession({ storage }) a PostgreSQL selection. ${LIBSQL_REMOVED_HINT}`,
	});
}

/** @deprecated libSQL support was removed in 0.10.11. Use `POSTGRES_ADAPTER_PACKAGE`. */
export const LIBSQL_ADAPTER_PACKAGE = REMOVED_LIBSQL_ADAPTER;
/** @deprecated The `ATOMIC_PROFILE=ci` team profile was removed with libSQL support in 0.10.11; setting it fails. */
export const TEAM_PROFILE_ENV = "ATOMIC_PROFILE";
/** @deprecated Removed with the `ATOMIC_PROFILE=ci` team profile in 0.10.11; setting it fails. */
export const TEAM_URL_ENV = "ATOMIC_TEAM_URL";
/** @deprecated Removed with the `ATOMIC_PROFILE=ci` team profile in 0.10.11; setting it fails. */
export const TEAM_TOKEN_ENV = "ATOMIC_TEAM_TOKEN";
/** @deprecated Removed with the `ATOMIC_PROFILE=ci` team profile in 0.10.11; setting it fails. */
export const TEAM_TOKEN_FILE_ENV = "ATOMIC_TEAM_TOKEN_FILE";
/** @deprecated Removed with the `ATOMIC_PROFILE=ci` team profile in 0.10.11; setting it fails. */
export const TEAM_PREFIX_ENV = "ATOMIC_TEAM_PREFIX";
/** @deprecated Removed with the `ATOMIC_PROFILE=ci` team profile in 0.10.11. */
export const TEAM_PROFILE_SOURCE = "ATOMIC_PROFILE=ci";
/** @deprecated `atomic team join` was removed with libSQL support in 0.10.11; this names `atomic storage join`. */
export const TEAM_JOIN_COMMAND = "atomic storage join <postgres-url> --password-file <path>";
/** @deprecated `atomic team join` was removed with libSQL support in 0.10.11; this names `atomic storage join`. */
export const SHARED_STORAGE_JOIN_HINT = TEAM_JOIN_COMMAND;

/**
 * @deprecated libSQL support was removed in 0.10.11: always throws `TeamProfileConfigError` code `libsql-removed`.
 * Pass `createAgentSession({ storage })` a PostgreSQL selection instead.
 */
export function teamProfileSelection(_options?: object): never {
	throw removedTeamSetup("teamProfileSelection");
}

/**
 * @deprecated libSQL support was removed in 0.10.11: always rejects with `TeamProfileConfigError` code
 * `libsql-removed`. Run `atomic storage join postgres://…` instead.
 */
export async function joinTeam(_options?: object): Promise<never> {
	throw removedTeamSetup("joinTeam");
}

/** @deprecated Removed with libSQL support in 0.10.11: always rejects like {@link joinTeam}. */
export async function joinTeamWith(_options?: object): Promise<never> {
	throw removedTeamSetup("joinTeam");
}

/**
 * @deprecated libSQL support was removed in 0.10.11: always rejects with `TeamProfileConfigError` code
 * `libsql-removed`. Remove the `storage` setting instead.
 */
export async function leaveTeam(_options?: object): Promise<never> {
	throw removedTeamSetup("leaveTeam");
}

/** @deprecated Removed with libSQL support in 0.10.11: always rejects like {@link leaveTeam}. */
export async function leaveTeamWith(_options?: object): Promise<never> {
	throw removedTeamSetup("leaveTeam");
}

/**
 * @deprecated Removed with libSQL support in 0.10.11: rejects with `TeamProfileConfigError` code `libsql-removed` when
 * the selection names the removed adapter, and otherwise resolves.
 */
export async function assertTeamAdapterInstalled(_agentDir: string, selection?: object): Promise<void> {
	if (selection !== undefined && "adapter" in selection && selection.adapter === REMOVED_LIBSQL_ADAPTER)
		throw removedTeamSetup("assertTeamAdapterInstalled");
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

/** @deprecated The fingerprint the removed `teamJoin` setting recorded; nothing in this release reads it. */
export function storageFingerprint(storage: StorageSettingsSelection): string {
	return `sha256:${createHash("sha256").update(canonicalJson(storage)).digest("hex")}`;
}
