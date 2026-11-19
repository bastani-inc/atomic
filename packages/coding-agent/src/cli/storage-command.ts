/**
 * `atomic storage status` shows which storage each domain (sessions, Intercom) selects, where the selection comes
 * from, whether its adapter loads and its database answers, and what the running Intercom broker uses. `atomic storage
 * join` points this machine's global `storage` setting at a shared libSQL / Turso or PostgreSQL database. `atomic
 * storage export` and `atomic storage import` move sessions between their storage and JSONL files (#4716, #4720).
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { APP_NAME } from "../config.js";
import { getBuiltinPackageLocations } from "../core/builtin-packages.ts";
import type { IntercomBrokerControl } from "../core/intercom-broker-control.js";
import { resolveSessionStore, selectSessionStorageWithSettings } from "../core/session-storage.js";
import { exportSessions } from "../core/session-transfer.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { openAdapterSelectionDatabase } from "../core/storage/adapter-open.js";
import type { SqliteDatabase, SqliteRow } from "../core/storage/database.js";
import { dialectOf } from "../core/storage/dialect.js";
import { isTeamProfileConfigError, isTeamProfileError } from "../core/storage/errors.js";
import {
	movePostgresStorageToSchema,
	POSTGRES_ATOMIC_SCHEMA,
	strayPostgresStorageTables,
} from "../core/storage/postgres-schema.js";
import { StorageProvider, type StorageSelection } from "../core/storage/provider.js";
import {
	checkSharedDatabaseArguments,
	isFileUrl,
	isPostgresUrl,
	LIBSQL_ADAPTER_PACKAGE,
	missingTeamToken,
	POSTGRES_ADAPTER_PACKAGE,
	type PostgresAuth,
	STORAGE_TOKEN_FILE,
	type StorageSettingsSelection,
	selectStorage,
} from "../core/storage/selection.js";
import type { SessionStore } from "../core/storage/session/types.js";
import { SESSION_FORMAT_VERSION } from "../core/storage/session/types.js";
import {
	collectStorageStatus,
	type DomainStatus,
	describeStorageError,
	describeStorageSelection,
	effectiveSharedSelection,
	projectTrust,
	type StorageStatus,
} from "../core/storage/storage-status.js";
import { joinSharedDatabase } from "../core/storage/team.js";
import {
	isStorageImportIncompleteError,
	isStorageTransferError,
	type TransferredIds,
} from "../core/storage/transfer-files.js";
import { importStorage, sessionsTransferDirectory } from "../core/storage-transfer.ts";
import {
	loadWorkerHostModule,
	type WorkerDatabase,
	type WorkerHostModule,
	workerJournalSelection,
} from "./worker-command.js";

export { LIBSQL_ADAPTER_PACKAGE, STORAGE_TOKEN_FILE };

const JOIN_USAGE = `${APP_NAME} storage join <url> [--token-file <path> | --password-file <path> | --auth azure|aws|gcp]
                            [--prefix <prefix>]`;

const MIGRATE_USAGE = `${APP_NAME} storage migrate [--db <url> [--password-file <path> | --token-file <path> | --auth azure|aws|gcp]]
                            [--prefix <prefix>]`;

const HELP = `Usage:
  ${APP_NAME} storage status [--json]
  ${JOIN_USAGE}
  ${MIGRATE_USAGE}
  ${APP_NAME} storage export <dir> [--sessions] [--limit <n>] [--since <time>]
                              [--storage <json> | --storage-file <path>]
  ${APP_NAME} storage import <dir> [--sessions] [--storage <json> | --storage-file <path>]

Commands:
  status   Show, for sessions and Intercom, the selected storage and where the
           selection comes from (environment variable, project or global settings, or default),
           whether its adapter loads, whether its database answers a SELECT 1, and what the running
           Intercom broker uses. Exits 1 when a selection is invalid, an adapter cannot load, or a
           database does not answer. Nothing is created or changed.
  join     Use a shared database on this machine: a libSQL / Turso database (libsql://, https://,
           wss:// or file:) through ${LIBSQL_ADAPTER_PACKAGE}, or a PostgreSQL database
           (postgres:// or postgresql://) through ${POSTGRES_ADAPTER_PACKAGE}. Checks the credential
           and the connection (SELECT 1, within 15 seconds), then writes only the global \`storage\`
           setting; nothing is written when a check fails. A token or --password-file is stored in
           the agent directory (mode 600); --token-file is referenced where it is, and read again
           for every new connection. Settings hold a file reference, never a password or token.
           Reports environment variables and settings that override it. Creates no tables; Atomic
           creates them on first use.
  migrate  Create or upgrade Atomic's tables in a shared database (the one this machine's shared
           \`storage\` selection names, or --db): sessions and Intercom. Run it as the database's owner
           role after joining and after each Atomic upgrade, so processes that connect with a runtime
           role (DML privileges only) run no DDL. On PostgreSQL the tables live in schema atomic;
           tables an earlier release created in public are moved there, and processes of that release
           still using public are refused. Running it again on a current schema changes nothing.
  export   Write sessions to <dir>/sessions/<sessionId>.jsonl (session format version
           ${SESSION_FORMAT_VERSION}, the format \`${APP_NAME} --import\` reads), one file per session.
           Each file is replaced whole, one that already holds the same bytes is not rewritten, and
           no file is deleted. Sessions kept in a shared libSQL / Turso or PostgreSQL database are
           refused: every machine joined to it reads them already. Name the database with
           --storage or --storage-file to export from it anyway.
  import   Restore the sessions in <dir>/sessions into this directory's storage, or the one
           --storage or --storage-file names; other files are ignored. Every file is checked
           first, so a malformed or unsupported file changes nothing. Importing again adds
           nothing; a newer export of a session adds its later entries. If the import fails
           after writing part of it, it names what was and was not written; run it again to finish.

Options:
  --json                Print the status as JSON
  --token-file <path>   libSQL: file holding the database token, for example from \`turso db tokens create\`;
                        surrounding whitespace is removed. Required except for file: URLs.
                        PostgreSQL: a password or token file another process keeps fresh (a Vault agent,
                        a workload-identity sidecar); its path is saved and it is read for every new connection
  --password-file <path>
                        PostgreSQL: file holding the database password; it is copied to the agent directory
                        (mode 600)
  --auth azure|aws|gcp  PostgreSQL: use the platform's identity (Microsoft Entra ID, AWS IAM, Google Cloud
                        IAM) instead of a password
                        PostgreSQL URLs take exactly one of --password-file, --token-file and --auth, and
                        never a password in the URL
  --prefix <prefix>     Table prefix, to share one database between projects or teams
  --sessions            export, import: sessions, which is all they move
  --limit <n>           export: at most n sessions, most recently modified first
  --since <time>        export: only sessions modified at or after <time>, a date such as
                        2026-11-01 or a date and time such as 2026-11-01T09:30:00Z
  --storage <json>      export, import: read from or write to this storage instead of the one selected
                        here, given in the form of the \`storage\` setting, for example
                        {"path":"/path/to/journal.sqlite"} or an adapter with its options and secrets.
                        A shared database named this way is exported from and imported into: use it to
                        move sessions between stores
  --storage-file <path> export, import: as --storage, from a JSON file, for example the \`storage\`
                        value of another machine's settings`;

const HELP_HINT = `Use "${APP_NAME} storage --help" for usage.`;

export type StorageCommand =
	| { readonly kind: "help" }
	| { readonly kind: "status"; readonly json: boolean }
	| {
			readonly kind: "join";
			readonly url: string;
			readonly tokenFile?: string;
			/** Postgres only. */
			readonly passwordFile?: string;
			/** Postgres only. */
			readonly auth?: PostgresAuth;
			readonly prefix?: string;
	  }
	| {
			readonly kind: "migrate";
			/** `--db` and its credential; this machine's shared selection without it. */
			readonly database?: WorkerDatabase;
	  }
	| {
			readonly kind: "search-session";
			readonly file: string;
			readonly sessionId: string;
			readonly pattern: string;
			readonly cursor?: string;
	  }
	| ({
			readonly kind: "export";
			readonly directory: string;
			readonly limit?: number;
			/** `--since`, in milliseconds since the epoch. */
			readonly since?: number;
	  } & NamedStorage)
	| ({ readonly kind: "import"; readonly directory: string } & NamedStorage);

/** The storage an export reads or an import writes, named with `--storage` or `--storage-file` instead of selected. */
export interface NamedStorage {
	/** `--storage`: a selection in the settings form. */
	readonly storage?: StorageSettingsSelection;
	/** `--storage-file`: a file holding one. */
	readonly storageFile?: string;
}

export class StorageCommandError extends Error {}

/** The `storage` subcommands and the export and import options that went with workflows, removed in 0.10.0. */
const REMOVED_COMMANDS: ReadonlySet<string> = new Set(["adopt", "consolidate"]);
const REMOVED_TRANSFER_OPTIONS: ReadonlySet<string> = new Set(["--workflows", "--run", "--unfinished"]);

/** Parse the arguments after `storage`. */
export function parseStorageCommand(args: readonly string[]): StorageCommand {
	const [command, ...rest] = args;
	if (command === undefined || command === "help" || args.includes("--help") || args.includes("-h")) {
		return { kind: "help" };
	}
	if (command !== undefined && REMOVED_COMMANDS.has(command))
		throw new StorageCommandError(
			`"${APP_NAME} storage ${command}" was removed in 0.10.0 with workflows. Workflow journals and their runs are left where they are, unchanged.`,
		);
	if (command === "search-session") {
		const [file, sessionId, pattern, cursor] = rest;
		if (!file || !sessionId || !pattern || rest.length > 4)
			throw new StorageCommandError(
				`Usage: ${APP_NAME} storage search-session <sqlite-file> <session-id> <pattern> [cursor]`,
			);
		return { kind: command, file, sessionId, pattern, ...(cursor === undefined ? {} : { cursor }) };
	}
	const positional: string[] = [];
	const values = new Map<string, string>();
	let json = false;
	for (let index = 0; index < rest.length; index++) {
		const arg = rest[index]!;
		if (command === "status" && arg === "--json") {
			json = true;
			continue;
		}
		if ((command === "export" || command === "import") && arg === "--sessions") continue;
		if ((command === "export" || command === "import") && REMOVED_TRANSFER_OPTIONS.has(arg))
			throw new StorageCommandError(
				`${arg} was removed in 0.10.0 with workflows: "${APP_NAME} storage ${command}" moves sessions only.`,
			);
		if (
			((command === "join" || command === "migrate") &&
				(arg === "--token-file" || arg === "--password-file" || arg === "--auth" || arg === "--prefix")) ||
			(command === "migrate" && arg === "--db") ||
			(command === "export" && (arg === "--limit" || arg === "--since")) ||
			((command === "export" || command === "import") && (arg === "--storage" || arg === "--storage-file"))
		) {
			const value = rest[++index];
			if (value === undefined) throw new StorageCommandError(`${arg} needs a value.`);
			values.set(arg, value);
			continue;
		}
		if (arg.startsWith("-"))
			throw new StorageCommandError(`Unknown option ${arg} for "storage ${command}".\n${HELP_HINT}`);
		positional.push(arg);
	}
	if (command === "status") {
		if (positional.length > 0) throw new StorageCommandError(`Usage: ${APP_NAME} storage status [--json]`);
		return { kind: "status", json };
	}
	if (command === "join") {
		const [url, ...extra] = positional;
		if (url === undefined || extra.length > 0) throw new StorageCommandError(`Usage: ${JOIN_USAGE}`);
		const checked = checkSharedDatabaseArguments({
			url,
			tokenFile: values.get("--token-file"),
			passwordFile: values.get("--password-file"),
			auth: values.get("--auth"),
		});
		if (!isPostgresUrl(url) && checked.tokenFile === undefined && !isFileUrl(url)) throw missingTeamToken(url, "cli");
		const prefix = values.get("--prefix");
		return { kind: "join", ...checked, ...(prefix === undefined ? {} : { prefix }) };
	}
	if (command === "migrate") {
		if (positional.length > 0) throw new StorageCommandError(`Usage: ${MIGRATE_USAGE}`);
		const url = values.get("--db");
		if (url === undefined) {
			for (const option of ["--token-file", "--password-file", "--auth", "--prefix"])
				if (values.has(option))
					throw new StorageCommandError(`${option} qualifies --db; pass the database URL with --db too.`);
			return { kind: "migrate" };
		}
		const checked = checkSharedDatabaseArguments({
			url,
			tokenFile: values.get("--token-file"),
			passwordFile: values.get("--password-file"),
			auth: values.get("--auth"),
		});
		const prefix = values.get("--prefix");
		return {
			kind: "migrate",
			database: {
				url,
				...(checked.tokenFile === undefined ? {} : { tokenFile: checked.tokenFile }),
				...(checked.passwordFile === undefined ? {} : { passwordFile: checked.passwordFile }),
				...(checked.auth === undefined ? {} : { auth: checked.auth }),
				...(prefix === undefined ? {} : { prefix }),
			},
		};
	}
	const named = namedStorage(values);
	if (command === "export") {
		const [directory, ...extra] = positional;
		if (directory === undefined || extra.length > 0)
			throw new StorageCommandError(
				`Usage: ${APP_NAME} storage export <dir> [--sessions] [--limit <n>] [--since <time>]`,
			);
		const limitText = values.get("--limit");
		const limit = limitText === undefined ? undefined : Number(limitText);
		if (limit !== undefined && (!/^[0-9]+$/.test(limitText!) || !Number.isSafeInteger(limit) || limit < 1))
			throw new StorageCommandError(`--limit needs a positive whole number, not "${limitText}".`);
		const sinceText = values.get("--since");
		const since = sinceText === undefined ? undefined : Date.parse(sinceText);
		if (since !== undefined && Number.isNaN(since))
			throw new StorageCommandError(
				`--since needs a date such as 2026-11-01 or a date and time such as 2026-11-01T09:30:00Z, not "${sinceText}".`,
			);
		return {
			kind: "export",
			directory,
			...(limit === undefined ? {} : { limit }),
			...(since === undefined ? {} : { since }),
			...named,
		};
	}
	if (command === "import") {
		const [directory, ...extra] = positional;
		if (directory === undefined || extra.length > 0)
			throw new StorageCommandError(`Usage: ${APP_NAME} storage import <dir> [--sessions]`);
		return { kind: "import", directory, ...named };
	}
	throw new StorageCommandError(`Unknown storage command "${command}".\n${HELP_HINT}`);
}

function namedStorage(values: ReadonlyMap<string, string>): NamedStorage {
	const text = values.get("--storage");
	const storageFile = values.get("--storage-file");
	if (text !== undefined && storageFile !== undefined)
		throw new StorageCommandError("Pass only one of --storage and --storage-file.");
	if (storageFile !== undefined) return { storageFile };
	if (text === undefined) return {};
	return { storage: storageSelectionJson(text, "--storage") };
}

/** A selection in the settings form, from JSON text; `field` names where it came from. */
function storageSelectionJson(text: string, field: string): StorageSettingsSelection {
	let value: StorageSettingsSelection | null;
	try {
		value = JSON.parse(text) as StorageSettingsSelection | null;
	} catch {
		value = null;
	}
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new StorageCommandError(
			`${field} needs a JSON object in the form of the \`storage\` setting, for example {"path":"/path/to/journal.sqlite"}.`,
		);
	return value;
}

/** The selection `--storage` or `--storage-file` names, checked like a settings selection; undefined for neither. */
function namedSelection(command: NamedStorage, cwd: string): StorageSelection | undefined {
	let value = command.storage;
	const field = command.storageFile === undefined ? "--storage" : "--storage-file";
	if (command.storageFile !== undefined) {
		const path = resolve(cwd, command.storageFile);
		let text: string;
		try {
			text = readFileSync(path, "utf8");
		} catch (error) {
			throw new StorageCommandError(`--storage-file ${path} cannot be read: ${errorText(error as Error)}.`);
		}
		value = storageSelectionJson(text, `--storage-file ${path}`);
	}
	if (value === undefined) return undefined;
	const selection = selectStorage(value, "cli", field, "");
	if (selection.kind !== "sqlite") return selection;
	if (selection.path === ":memory:") return { kind: "memory" };
	if (selection.path === "")
		throw new StorageCommandError(`${field} names no storage: give a "path" or an "adapter" with its options.`);
	return { ...selection, path: resolve(cwd, selection.path) };
}

export interface StorageCommandOptions {
	readonly cwd: string;
	readonly agentDir: string;
	readonly log?: (line: string) => void;
	readonly error?: (line: string) => void;
	/** Defaults to the bundled Intercom package's broker control. */
	readonly loadControl?: () => Promise<IntercomBrokerControl>;
	/** `migrate`: defaults to the bundled workflows package's public entry. */
	readonly loadWorkerModule?: () => Promise<Pick<WorkerHostModule, "migrateWorkflowStorage">>;
	/** `migrate`: defaults to the bundled Intercom package's broker state opener. */
	readonly loadBrokerState?: () => Promise<BrokerStateModule>;
}

const errorText = describeStorageError;

/** The bundled Intercom package's broker control, or why it could not load. */
export async function loadBrokerControl(options: {
	readonly loadControl?: () => Promise<IntercomBrokerControl>;
}): Promise<IntercomBrokerControl | Error> {
	try {
		if (options.loadControl) return await options.loadControl();
		const { loadIntercomBrokerControl } = await import("../core/intercom-broker-control.js");
		return await loadIntercomBrokerControl();
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
}

/** Whether a domain's selection is invalid, its adapter cannot load, or its database did not answer. */
export function failed(domain: DomainStatus): boolean {
	return (
		domain.error !== undefined ||
		domain.probe?.adapter?.loaded === false ||
		domain.probe?.connection.status === "failed"
	);
}

const DOMAIN_LABELS: Record<DomainStatus["domain"], string> = {
	sessions: "Sessions",
	intercom: "Intercom",
};

/** The status as the lines `atomic storage status` prints. */
export function formatStorageStatus(status: StorageStatus): string[] {
	const lines = [
		`Agent directory: ${status.agentDir}`,
		`Project: ${status.cwd}${status.projectTrusted ? "" : " (not trusted)"}`,
	];
	for (const domain of status.domains) {
		lines.push("", `${DOMAIN_LABELS[domain.domain]}: ${domain.selection}`);
		lines.push(`  source:      ${domain.source}`);
		if (domain.overridden.length > 0) lines.push(`  overrides:   ${domain.overridden.join(", ")}`);
		if (domain.error !== undefined) lines.push(`  error:       ${domain.error}`);
		const probe = domain.probe;
		if (probe?.sameAs !== undefined) {
			lines.push(`  connection:  same as ${DOMAIN_LABELS[probe.sameAs].toLowerCase()}`);
		} else if (probe !== undefined) {
			if (probe.adapter !== undefined) {
				lines.push(
					`  adapter:     ${probe.adapter.loaded ? "loaded" : "failed to load"}${probe.adapter.detail === undefined ? "" : ` (${probe.adapter.detail})`}`,
				);
			}
			lines.push(`  connection:  ${probe.connection.status} (${probe.connection.detail})`);
		}
		if (domain.multiNode !== undefined) lines.push(`  multi-node:  ${domain.multiNode}`);
		if (domain.liveBrokers !== undefined) {
			lines.push(
				`  brokers:     ${domain.liveBrokers.length} live in the database${domain.liveBrokers.length === 0 ? "" : ` (${[...new Set(domain.liveBrokers)].join(", ")})`}`,
			);
		}
	}
	const broker = status.broker;
	if (broker !== undefined) {
		lines.push("");
		if (broker.state === "stopped") {
			lines.push(
				"Intercom broker: not running (the next session that uses Intercom starts one with the selection above)",
			);
		} else if (broker.state === "unknown") {
			lines.push(`Intercom broker: unknown (${broker.error ?? "no answer"})`);
		} else if (broker.state === "legacy") {
			lines.push(
				`Intercom broker: running${broker.pid === undefined ? "" : ` (pid ${broker.pid})`}, started by an older Atomic that does not report its storage; run \`${APP_NAME} intercom restart\``,
			);
		} else {
			lines.push(
				`Intercom broker: running (pid ${broker.pid}, ${broker.sessions} session${broker.sessions === 1 ? "" : "s"} connected)`,
			);
			lines.push(
				broker.matchesCurrent
					? "  storage:     matches the selection above"
					: `  storage:     differs from the selection above${broker.source === "env" ? " (a session started it with ATOMIC_STORAGE, ATOMIC_PROFILE=ci or --storage)" : ""}; run \`${APP_NAME} intercom restart\` to use the current one`,
			);
			if (broker.multiNodeLine !== undefined) lines.push(`  multi-node:  ${broker.multiNodeLine}`);
		}
	}
	if (status.notes.length > 0) lines.push("", "Notes:", ...status.notes.map((note) => `  - ${note}`));
	return lines;
}

async function status(json: boolean, options: StorageCommandOptions, log: (line: string) => void): Promise<number> {
	const control = await loadBrokerControl(options);
	const collected = await collectStorageStatus({
		cwd: options.cwd,
		agentDir: options.agentDir,
		probe: true,
		...(control instanceof Error ? {} : { control }),
	});
	const result: StorageStatus =
		control instanceof Error ? { ...collected, broker: { state: "unknown", error: errorText(control) } } : collected;
	if (json) log(JSON.stringify(result, null, 2));
	else for (const line of formatStorageStatus(result)) log(line);
	return result.domains.some(failed) ? 1 : 0;
}

async function joinStorage(
	command: Extract<StorageCommand, { kind: "join" }>,
	options: StorageCommandOptions,
	log: (...lines: string[]) => void,
): Promise<number> {
	const { agentDir, cwd } = options;
	const joined = await joinSharedDatabase({ ...command, agentDir, cwd, pinLocalSessions: false }, "cli");
	log(`Connected to ${command.url}.`);
	const secret = command.passwordFile === undefined ? "token" : "password";
	if (joined.tokenPath !== undefined) {
		log(
			joined.token === "reused"
				? `Kept the ${secret} in ${joined.tokenPath}; it already holds this ${secret}.`
				: `Stored the ${secret} in ${joined.tokenPath} (mode 600).`,
		);
	}
	if (joined.referencedFile !== undefined)
		log(`The password stays in ${joined.referencedFile} and is read again for every new connection.`);
	if (command.auth !== undefined) log(`The adapter obtains a ${command.auth} credential for every new connection.`);
	log(`Set \`storage\` in ${join(agentDir, "settings.json")}; other settings are unchanged.`);
	if (joined.replaced !== undefined) log(`It replaces the previous selection: ${joined.replaced}.`);

	const control = await loadBrokerControl(options);
	let collected: StorageStatus;
	try {
		collected = await collectStorageStatus({
			cwd,
			agentDir,
			probe: false,
			...(control instanceof Error ? {} : { control }),
		});
	} catch (error) {
		// Settings and the token are already committed; optional diagnostics cannot undo that success.
		log(`Storage was saved, but could not report overrides: ${errorText(error as Error)}.`);
		log(`Run \`${APP_NAME} storage status\` after fixing the reported settings error.`);
		return 0;
	}
	const overridden = collected.domains.filter(
		(domain) => domain.source !== "global settings: storage" && domain.source !== "default",
	);
	if (overridden.length > 0) {
		log("", "These take precedence over the new selection here:");
		for (const domain of overridden) log(`  - ${DOMAIN_LABELS[domain.domain]}: ${domain.source}`);
	}
	for (const note of collected.notes) log(`Note: ${note}`);
	const broker = collected.broker;
	if (broker?.state === "running" && !broker.matchesCurrent) {
		log(
			`The running Intercom broker (pid ${broker.pid}) still uses its previous selection. Run \`${APP_NAME} intercom restart\` so it uses the new one.`,
		);
	} else if (broker?.state === "legacy") {
		log(
			`An Intercom broker from an older ${APP_NAME} is running. Run \`${APP_NAME} intercom restart\` to replace it.`,
		);
	}
	log(`Run \`${APP_NAME} storage status\` to check each domain.`);
	return 0;
}

/** Run `atomic storage <args>` and return the exit code. */
export async function runStorageCommand(args: readonly string[], options: StorageCommandOptions): Promise<number> {
	const log = options.log ?? ((line: string) => console.log(line));
	const error = options.error ?? ((line: string) => console.error(line));
	try {
		const command = parseStorageCommand(args);
		if (command.kind === "help") {
			log(HELP);
			return 0;
		}
		if (command.kind === "search-session") {
			const { searchStoredSession } = await import("./storage-search-session.js");
			await searchStoredSession(command, options.cwd, options.log);
			return 0;
		}
		if (command.kind === "status") return await status(command.json, options, log);
		if (command.kind === "migrate") return await migrate(command, options, log);
		if (command.kind === "export") return await exportSessionFiles(command, options, log);
		if (command.kind === "import") return await importSessionFiles(command, options, log, error);
		return await joinStorage(command, options, (...lines) => {
			for (const line of lines) log(line);
		});
	} catch (caught) {
		error(
			caught instanceof StorageCommandError ||
				isStorageTransferError(caught) ||
				isTeamProfileError(caught) ||
				isTeamProfileConfigError(caught)
				? caught.message
				: `Error: ${errorText(caught as Error)}`,
		);
		return 1;
	}
}

/** Intercom's broker state opener, as the bundled Intercom package's `broker/open-broker-state` module exports it. */
interface BrokerStateModule {
	openIntercomBrokerState(source: {
		readonly prefix?: string;
		readonly openDatabase: () => Promise<SqliteDatabase>;
	}): Promise<{ readonly state: { close(): Promise<void> }; readonly bus: { close(): Promise<void> } }>;
}

/** Loads the bundled Intercom package's broker state opener, as extensions see the host's modules. */
async function loadBrokerStateModule(): Promise<BrokerStateModule> {
	const intercom = getBuiltinPackageLocations().find(({ distDirName }) => distDirName === "intercom");
	if (intercom === undefined) throw new Error("The bundled Intercom package was not found.");
	const modulePath = ["broker/open-broker-state.ts", "broker/open-broker-state.js"]
		.map((path) => join(intercom.packageDir, path))
		.find((path) => existsSync(path));
	if (modulePath === undefined) throw new Error("The bundled Intercom package has no broker state module.");
	const [{ createHostModuleJiti }, { getVirtualModules }] = await Promise.all([
		import("../core/extensions/loader-virtual-modules.js"),
		import("../core/extensions/loader-host-modules.js"),
	]);
	const loader = await createHostModuleJiti(pathToFileURL(modulePath).href, await getVirtualModules());
	return loader.import<BrokerStateModule>(modulePath);
}

/**
 * `atomic storage migrate` (#5218): sets up or upgrades every store's tables in the shared database, as its owner role.
 * On PostgreSQL, tables an earlier release created in `public` move to schema `atomic` first.
 */
async function migrate(
	command: Extract<StorageCommand, { kind: "migrate" }>,
	options: StorageCommandOptions,
	log: (line: string) => void,
): Promise<number> {
	const { agentDir, cwd } = options;
	const database = command.database === undefined ? undefined : { ...command.database };
	if (database?.tokenFile !== undefined) database.tokenFile = resolve(cwd, database.tokenFile);
	if (database?.passwordFile !== undefined) database.passwordFile = resolve(cwd, database.passwordFile);
	const settings = database === undefined ? undefined : workerJournalSelection(database);
	const selection =
		settings === undefined
			? effectiveSharedSelection(cwd, agentDir)
			: selectStorage(settings as StorageSettingsSelection, "cli", "--db", "");
	if (selection === undefined) {
		log(
			`No shared storage is selected here (the \`storage\` setting, --storage, ATOMIC_STORAGE or ATOMIC_PROFILE=ci), so there is nothing to migrate; name a database with --db.`,
		);
		return 0;
	}
	if (selection.kind !== "adapter") {
		log(
			`Shared storage here is ${describeStorageSelection(selection)}, which sets itself up on first use; there is nothing to migrate.`,
		);
		return 0;
	}
	const open = (domain: "sessions" | "intercom") => openAdapterSelectionDatabase(selection, { agentDir, domain });
	const opened = await open("sessions");
	try {
		const explicitSchema = (selection.options as { schema?: unknown }).schema !== undefined;
		if (dialectOf(opened).name === "postgres" && !explicitSchema) {
			const row = await opened.get<SqliteRow & { schema: string | null }>("SELECT current_schema() AS schema");
			if (row?.schema === "public") {
				const moved = await movePostgresStorageToSchema(opened);
				log(
					moved.skipped
						? `Another \`${APP_NAME} storage migrate\` moved the tables to schema ${POSTGRES_ATOMIC_SCHEMA} first.`
						: `Moved ${moved.tables.length} table${moved.tables.length === 1 ? "" : "s"} and ${moved.functions.length} trigger function${moved.functions.length === 1 ? "" : "s"} from schema public to schema ${POSTGRES_ATOMIC_SCHEMA}; processes of an earlier Atomic still using public are refused until they are upgraded.`,
				);
			}
		}
	} finally {
		await opened.close();
	}
	await (await new StorageProvider().openSessionStore(selection, { agentDir, domain: "sessions" })).close();
	const workflows = await (options.loadWorkerModule ?? loadWorkerHostModule)();
	if (workflows.migrateWorkflowStorage === undefined)
		throw new Error("The bundled workflows package cannot migrate storage; reinstall Atomic.");
	await workflows.migrateWorkflowStorage({ ...(settings === undefined ? {} : { journal: settings }), agentDir });
	const intercom = await (options.loadBrokerState ?? loadBrokerStateModule)();
	const broker = await intercom.openIntercomBrokerState({
		...(selection.prefix === undefined ? {} : { prefix: selection.prefix }),
		openDatabase: () => open("intercom"),
	});
	await broker.bus.close();
	await broker.state.close();
	// Tables created in public after the move hold state the moved ones do not (#5218).
	const checked = await open("sessions");
	let strays: string[];
	let withoutTrigrams: boolean;
	try {
		strays = await strayPostgresStorageTables(checked);
		withoutTrigrams = dialectOf(checked).name === "postgres" && !(await hasPostgresExtension(checked, "pg_trgm"));
	} finally {
		await checked.close();
	}
	if (strays.length > 0) {
		log(
			`Found ${strays.length} of Atomic's table${strays.length === 1 ? "" : "s"} in schema public that a process created after the move to schema ${POSTGRES_ATOMIC_SCHEMA}: ${strays.join(", ")}. A process of an earlier Atomic, or one started before the move, still uses public, and what it wrote there is not in schema ${POSTGRES_ATOMIC_SCHEMA}. Stop or upgrade it, then drop those tables, or copy what you need into schema ${POSTGRES_ATOMIC_SCHEMA} first.`,
		);
		return 1;
	}
	log(`Atomic's tables in ${describeStorageSelection(selection)} are set up for this version: sessions and Intercom.`);
	if (withoutTrigrams)
		log(
			`Searches of session history will read each session a page at a time: the pg_trgm extension, which their index uses, is not installed in this database and this role could not install it. On Azure Database for PostgreSQL and Azure HorizonDB, add pg_trgm to the server parameter azure.extensions; elsewhere, grant this role CREATE on the database or have an administrator run CREATE EXTENSION pg_trgm in it. Then run \`${APP_NAME} storage migrate\` again.`,
		);
	return 0;
}

/** Whether the PostgreSQL extension `name` is installed in `database`'s current database. */
async function hasPostgresExtension(database: SqliteDatabase, name: string): Promise<boolean> {
	return (
		(await database.get("SELECT 1 AS present FROM pg_catalog.pg_extension WHERE extname = ?", name)) !== undefined
	);
}

/** What an export or import of one kind reads or writes, or why that kind is refused here. */
type Transfer<T> = { readonly target: T } | { readonly refused: string };

/**
 * The session storage this directory selects, as a session started here would open it: the default database, a JSONL
 * directory, a SQLite file or an adapter. A shared libSQL / Turso or PostgreSQL database is refused, and so is
 * in-memory storage, which keeps nothing. Undefined target for an export when nothing has been stored yet, so an
 * export creates no database.
 */
async function sessionTransfer(
	options: StorageCommandOptions,
	command: "export" | "import",
	named: StorageSelection | undefined,
): Promise<Transfer<SessionStore | undefined>> {
	if (named !== undefined) {
		if (named.kind !== "sqlite" && named.kind !== "adapter")
			return {
				refused: `${APP_NAME} storage ${command} needs stored sessions, but ${describeStorageSelection(named)} keeps nothing.`,
			};
		if (command === "export" && named.kind === "sqlite" && !existsSync(named.path)) return { target: undefined };
		return {
			target: await new StorageProvider().openSessionStore(named, {
				agentDir: options.agentDir,
				domain: "sessions",
			}),
		};
	}
	const settings = SettingsManager.create(options.cwd, options.agentDir, {
		projectTrusted: projectTrust(options.cwd, options.agentDir),
	}).getSettings();
	const storageOptions = { agentDir: options.agentDir, settings };
	const selection = selectSessionStorageWithSettings(options.cwd, storageOptions);
	if (!("load" in selection)) {
		if (selection.kind === "memory" || (selection.kind === "sqlite" && selection.path === ":memory:"))
			return {
				refused: `${APP_NAME} storage ${command} needs stored sessions, but sessions here use ${describeStorageSelection(selection)}, which keeps nothing.`,
			};
		if (
			selection.kind === "adapter" &&
			(selection.module === LIBSQL_ADAPTER_PACKAGE || selection.module === POSTGRES_ADAPTER_PACKAGE)
		)
			return {
				refused: `${APP_NAME} storage ${command} works with local session storage, but sessions here use ${describeStorageSelection(selection)}. A shared database already holds the sessions of every machine joined to it, so there is nothing to export or import; use its own backups, or name it with --storage or --storage-file to copy sessions out of it or into it.`,
			};
		if (command === "export") {
			const stored =
				selection.kind === "jsonl"
					? existsSync(selection.dir)
					: selection.kind !== "sqlite" ||
						existsSync(resolve(options.cwd, selection.path)) ||
						existsSync(join(options.agentDir, "sessions"));
			if (!stored) return { target: undefined };
		}
	}
	return { target: await resolveSessionStore(options.cwd, storageOptions) };
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

async function exportSessionFiles(
	command: Extract<StorageCommand, { kind: "export" }>,
	options: StorageCommandOptions,
	log: (line: string) => void,
): Promise<number> {
	const directory = resolve(options.cwd, command.directory);
	const named = namedSelection(command, options.cwd);
	const sessions = await sessionTransfer(options, "export", named);
	try {
		if ("refused" in sessions) throw new StorageCommandError(sessions.refused);
		const target = sessionsTransferDirectory(directory);
		const report =
			sessions.target === undefined
				? { written: [], unchanged: [] }
				: await exportSessions(sessions.target, target, {
						...(command.limit === undefined ? {} : { limit: command.limit }),
						...(command.since === undefined ? {} : { since: command.since }),
					});
		const total = report.written.length + report.unchanged.length;
		log(
			`Exported ${plural(total, "session")} to ${target} (${report.written.length} written, ${report.unchanged.length} unchanged).`,
		);
		return 0;
	} finally {
		await sessionStore(sessions)?.close();
	}
}

function describeIds(ids: TransferredIds): string {
	return ids.sessions.length === 0
		? "nothing"
		: `${ids.sessions.length === 1 ? "session" : "sessions"} ${ids.sessions.join(", ")}`;
}

async function importSessionFiles(
	command: Extract<StorageCommand, { kind: "import" }>,
	options: StorageCommandOptions,
	log: (line: string) => void,
	error: (line: string) => void,
): Promise<number> {
	const directory = resolve(options.cwd, command.directory);
	if (!existsSync(directory)) throw new StorageCommandError(`${directory}: no such directory.`);
	const named = namedSelection(command, options.cwd);
	const sessions = await sessionTransfer(options, "import", named);
	try {
		if ("refused" in sessions) throw new StorageCommandError(sessions.refused);
		const target = sessions.target;
		if (target === undefined) throw new Error("Session storage to import into was not opened.");
		let report: Awaited<ReturnType<typeof importStorage>>;
		try {
			report = await importStorage(directory, { sessions: target });
		} catch (caught) {
			if (isStorageImportIncompleteError(caught)) {
				error(caught.message);
				error(`Imported before the failure: ${describeIds(caught.written)}.`);
				error(`Not imported: ${describeIds(caught.notWritten)}.`);
				error("Run the same import again to finish: it imports only what is missing.");
				return 1;
			}
			if (isStorageTransferError(caught)) {
				error(caught.message);
				error("Nothing was imported.");
				return 1;
			}
			throw caught;
		}
		const { added, updated, unchanged } = report.sessions;
		log(
			`Imported ${plural(added.length + updated.length + unchanged.length, "session")} from ${sessionsTransferDirectory(directory)} (${added.length} added, ${updated.length} updated, ${unchanged.length} already up to date).`,
		);
		return 0;
	} finally {
		await sessionStore(sessions)?.close();
	}
}

function sessionStore(transfer: Transfer<SessionStore | undefined> | undefined): SessionStore | undefined {
	return transfer !== undefined && "target" in transfer ? transfer.target : undefined;
}
