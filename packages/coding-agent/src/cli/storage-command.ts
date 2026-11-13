/**
 * `atomic storage status` shows which storage each domain (sessions, workflow runs, Intercom) selects, where the
 * selection comes from, whether its adapter loads and its database answers, and what the running Intercom broker
 * uses. `atomic storage join` points this machine's global `storage` setting at a shared libSQL / Turso database.
 * `atomic storage adopt` registers existing journal files in the journal store in place, and `atomic storage
 * consolidate` moves their finished runs into the store's own shards. `atomic storage export` and `atomic storage
 * import` move sessions and workflow runs between their storage and JSONL files (#4716, #4720).
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { APP_NAME } from "../config.js";
import type { IntercomBrokerControl } from "../core/intercom-broker-control.js";
import { resolveSessionStore, selectSessionStorage } from "../core/session-storage.js";
import { exportSessions } from "../core/session-transfer.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { isJournalStoreError, isTeamProfileConfigError, isTeamProfileError } from "../core/storage/errors.js";
import {
	adoptJournals,
	consolidateJournalStore,
	defaultJournalStoreDirectory,
} from "../core/storage/journal-adoption.js";
import {
	exportWorkflowRuns,
	WORKFLOW_RUN_EXPORT_VERSION,
	type WorkflowRunTransferStorage,
} from "../core/storage/journal-transfer.js";
import {
	checkTeamUrl,
	isFileUrl,
	LIBSQL_ADAPTER_PACKAGE,
	missingTeamToken,
	STORAGE_TOKEN_FILE,
} from "../core/storage/selection.js";
import type { SessionStore } from "../core/storage/session/types.js";
import { SESSION_FORMAT_VERSION } from "../core/storage/session/types.js";
import {
	collectStorageStatus,
	type DomainStatus,
	describeStorageError,
	describeStorageSelection,
	effectiveJournalSelection,
	projectTrust,
	type StorageStatus,
} from "../core/storage/storage-status.js";
import { joinSharedDatabase } from "../core/storage/team.js";
import {
	isStorageImportIncompleteError,
	isStorageTransferError,
	type TransferredIds,
} from "../core/storage/transfer-files.js";
import { importStorage, sessionsTransferDirectory, workflowsTransferDirectory } from "../core/storage-transfer.ts";

export { LIBSQL_ADAPTER_PACKAGE, STORAGE_TOKEN_FILE };

const HELP = `Usage:
  ${APP_NAME} storage status [--json]
  ${APP_NAME} storage join <url> [--token-file <path>] [--prefix <prefix>]
  ${APP_NAME} storage adopt <path>... [--no-discover]
  ${APP_NAME} storage consolidate
  ${APP_NAME} storage export <dir> [--sessions] [--workflows] [--run <id>]... [--unfinished]
                              [--limit <n>] [--since <time>]
  ${APP_NAME} storage import <dir> [--sessions] [--workflows]

Commands:
  status   Show, for sessions, workflow runs, and Intercom, the selected storage and where the
           selection comes from (environment variable, project or global settings, or default),
           whether its adapter loads, whether its database answers a SELECT 1, and what the running
           Intercom broker uses. Exits 1 when a selection is invalid, an adapter cannot load, or a
           database does not answer. Nothing is created or changed.
  join     Use a shared libSQL / Turso database on this machine: check the token and the connection
           with ${LIBSQL_ADAPTER_PACKAGE}, store the token in the agent directory (mode 600), and
           write only the global \`storage\` setting. Reports environment variables and settings that
           override it. Creates no tables; Atomic creates them on first use.
  adopt    Register existing workflow journal files in the journal store in place, without copying,
           so their runs resolve by ID for status, resume, attach, fork and history://. Each <path>
           is a journal .sqlite file or a directory holding journal.sqlite. Every path is checked
           before the first is registered. Journals the adopted runs were written to are adopted
           too unless --no-discover is given.
  consolidate
           Move finished runs (completed, failed or cancelled, not leased, without local workers)
           from adopted journals into the journal store's own shards. Other runs stay where they
           are. An interrupted consolidation leaves every run readable; run it again to finish.
  export   Write sessions to <dir>/sessions/<sessionId>.jsonl (session format version
           ${SESSION_FORMAT_VERSION}, the format \`${APP_NAME} --import\` reads) and workflow runs to
           <dir>/workflows/<runId>.jsonl (workflow run export version ${WORKFLOW_RUN_EXPORT_VERSION}), one file per
           session or run. Both kinds by default; --sessions or --workflows limits it to one. Each
           file is replaced whole, one that already holds the same bytes is not rewritten, and no
           file is deleted. A kind kept in a shared libSQL / Turso database is skipped (an error
           when --sessions or --workflows asks for it): every machine joined to it reads it already.
  import   Restore the sessions in <dir>/sessions and the workflow runs in <dir>/workflows into
           this directory's storage; other files are ignored. Every file of both kinds is checked
           first, so a malformed or unsupported file changes nothing. Importing again adds
           nothing; a newer export of a session or run adds its later entries. Imported runs are
           not owned by any process: an interrupted one can be resumed here. If the import fails
           after writing part of it, it names what was and was not written; run it again to finish.

Options:
  --json                Print the status as JSON
  --token-file <path>   File holding the database token, for example from \`turso db tokens create\`;
                        surrounding whitespace is removed. Required except for file: URLs
  --prefix <prefix>     Table prefix, to share one database between projects or teams
  --no-discover         adopt: register only the given paths
  --sessions            export, import: sessions only (with --workflows too: both)
  --workflows           export, import: workflow runs only (with --sessions too: both)
  --run <id>            export: only this workflow run; repeat for more
  --unfinished          export: only workflow runs that are not completed, failed or cancelled
  --limit <n>           export: at most n workflow runs, newest first, and at most n sessions,
                        most recently modified first
  --since <time>        export: only sessions modified at or after <time>, a date such as
                        2026-11-01 or a date and time such as 2026-11-01T09:30:00Z`;

const HELP_HINT = `Use "${APP_NAME} storage --help" for usage.`;

export type StorageCommand =
	| { readonly kind: "help" }
	| { readonly kind: "status"; readonly json: boolean }
	| { readonly kind: "join"; readonly url: string; readonly tokenFile?: string; readonly prefix?: string }
	| { readonly kind: "adopt"; readonly paths: readonly string[]; readonly discover: boolean }
	| { readonly kind: "consolidate" }
	| {
			readonly kind: "export";
			readonly directory: string;
			/** The kinds to export; both when neither `--sessions` nor `--workflows` is given. */
			readonly kinds: TransferKinds;
			readonly runs?: readonly string[];
			readonly unfinished: boolean;
			readonly limit?: number;
			/** `--since`, in milliseconds since the epoch. */
			readonly since?: number;
	  }
	| { readonly kind: "import"; readonly directory: string; readonly kinds: TransferKinds };

/** Which kinds an export or import covers, and whether `--sessions` or `--workflows` named them. */
export interface TransferKinds {
	readonly sessions: boolean;
	readonly workflows: boolean;
	readonly explicit: boolean;
}

export class StorageCommandError extends Error {}

/** Parse the arguments after `storage`. */
export function parseStorageCommand(args: readonly string[]): StorageCommand {
	const [command, ...rest] = args;
	if (command === undefined || command === "help" || args.includes("--help") || args.includes("-h")) {
		return { kind: "help" };
	}
	const positional: string[] = [];
	const values = new Map<string, string>();
	let json = false;
	let discover = true;
	let unfinished = false;
	let sessions = false;
	let workflows = false;
	const runs: string[] = [];
	for (let index = 0; index < rest.length; index++) {
		const arg = rest[index]!;
		if (command === "status" && arg === "--json") {
			json = true;
			continue;
		}
		if (command === "adopt" && arg === "--no-discover") {
			discover = false;
			continue;
		}
		if ((command === "export" || command === "import") && (arg === "--sessions" || arg === "--workflows")) {
			if (arg === "--sessions") sessions = true;
			else workflows = true;
			continue;
		}
		if (command === "export" && arg === "--unfinished") {
			unfinished = true;
			continue;
		}
		if (command === "export" && arg === "--run") {
			const value = rest[++index];
			if (value === undefined || value === "") throw new StorageCommandError("--run needs a run ID.");
			runs.push(value);
			continue;
		}
		if (
			(command === "join" && (arg === "--token-file" || arg === "--prefix")) ||
			(command === "export" && (arg === "--limit" || arg === "--since"))
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
		if (url === undefined || extra.length > 0) {
			throw new StorageCommandError(
				`Usage: ${APP_NAME} storage join <url> [--token-file <path>] [--prefix <prefix>]`,
			);
		}
		checkTeamUrl(url, "cli");
		const tokenFile = values.get("--token-file");
		if (tokenFile === undefined && !isFileUrl(url)) throw missingTeamToken(url, "cli");
		const prefix = values.get("--prefix");
		return {
			kind: "join",
			url,
			...(tokenFile === undefined ? {} : { tokenFile }),
			...(prefix === undefined ? {} : { prefix }),
		};
	}
	if (command === "adopt") {
		if (positional.length === 0)
			throw new StorageCommandError(`Usage: ${APP_NAME} storage adopt <path>... [--no-discover]`);
		return { kind: "adopt", paths: positional, discover };
	}
	if (command === "consolidate") {
		if (positional.length > 0) throw new StorageCommandError(`Usage: ${APP_NAME} storage consolidate`);
		return { kind: "consolidate" };
	}
	const kinds: TransferKinds =
		sessions || workflows
			? { sessions, workflows, explicit: true }
			: { sessions: true, workflows: true, explicit: false };
	if (command === "export") {
		const [directory, ...extra] = positional;
		if (directory === undefined || extra.length > 0)
			throw new StorageCommandError(
				`Usage: ${APP_NAME} storage export <dir> [--sessions] [--workflows] [--run <id>]... [--unfinished] [--limit <n>] [--since <time>]`,
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
		if (!kinds.workflows && (runs.length > 0 || unfinished))
			throw new StorageCommandError(
				`${runs.length > 0 ? "--run" : "--unfinished"} selects workflow runs, which --sessions alone does not export.`,
			);
		if (!kinds.sessions && since !== undefined)
			throw new StorageCommandError("--since selects sessions, which --workflows alone does not export.");
		return {
			kind: "export",
			directory,
			kinds,
			unfinished,
			...(runs.length === 0 ? {} : { runs }),
			...(limit === undefined ? {} : { limit }),
			...(since === undefined ? {} : { since }),
		};
	}
	if (command === "import") {
		const [directory, ...extra] = positional;
		if (directory === undefined || extra.length > 0)
			throw new StorageCommandError(`Usage: ${APP_NAME} storage import <dir> [--sessions] [--workflows]`);
		return { kind: "import", directory, kinds };
	}
	throw new StorageCommandError(`Unknown storage command "${command}".\n${HELP_HINT}`);
}

export interface StorageCommandOptions {
	readonly cwd: string;
	readonly agentDir: string;
	readonly log?: (line: string) => void;
	readonly error?: (line: string) => void;
	/** Defaults to the bundled Intercom package's broker control. */
	readonly loadControl?: () => Promise<IntercomBrokerControl>;
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
		domain.probe?.connection.status === "failed" ||
		(domain.journalStore?.unavailable.length ?? 0) > 0
	);
}

const DOMAIN_LABELS: Record<DomainStatus["domain"], string> = {
	sessions: "Sessions",
	journal: "Workflow runs",
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
		const store = domain.journalStore;
		if (store !== undefined) {
			lines.push(
				`  journals:    ${store.shards} shard${store.shards === 1 ? "" : "s"}, ${store.adopted} adopted journal${store.adopted === 1 ? "" : "s"}, ${store.runs} run${store.runs === 1 ? "" : "s"}`,
			);
			for (const shard of store.unavailable)
				lines.push(
					`  unavailable: ${shard.path} (${shard.kind}, ${shard.code === "shard-missing" ? "no longer exists" : "cannot be opened"}: ${shard.code}${shard.detail === undefined ? "" : `, ${shard.detail}`})`,
				);
			for (const skipped of store.skipped) lines.push(`  skipped:     ${skipped.path} (${skipped.reason})`);
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
	if (joined.tokenPath !== undefined) {
		log(
			joined.token === "reused"
				? `Kept the token in ${joined.tokenPath}; it already holds this token.`
				: `Stored the token in ${joined.tokenPath} (mode 600).`,
		);
	}
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
		if (command.kind === "status") return await status(command.json, options, log);
		if (command.kind === "adopt") return await adopt(command, options, log);
		if (command.kind === "consolidate") return await consolidate(options, log);
		if (command.kind === "export") return await exportRuns(command, options, log, error);
		if (command.kind === "import") return await importRuns(command, options, log, error);
		return await joinStorage(command, options, (...lines) => {
			for (const line of lines) log(line);
		});
	} catch (caught) {
		if (isJournalStoreError(caught)) {
			error(caught.message);
			if (caught.hint !== undefined) error(caught.hint);
			return 1;
		}
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

/** A note when this directory's workflow runs use another journal than the journal store `adopt` writes to. */
function storeSelectionNote(options: StorageCommandOptions, directory: string): string | undefined {
	const selection = effectiveJournalSelection(options.cwd, options.agentDir);
	if (selection.kind === "sharded") return undefined;
	return `Note: workflow runs here use ${describeStorageSelection(selection)}, so they see the journal store ${directory} only once that selection is removed.`;
}

async function adopt(
	command: Extract<StorageCommand, { kind: "adopt" }>,
	options: StorageCommandOptions,
	log: (line: string) => void,
): Promise<number> {
	const directory = defaultJournalStoreDirectory(options.agentDir);
	const report = await adoptJournals(
		directory,
		command.paths.map((path) => resolve(options.cwd, path)),
		{ discover: command.discover },
	);
	for (const outcome of report.adopted) {
		log(
			outcome.status === "adopted"
				? `Adopted ${outcome.path} in place (shard ${outcome.shardId}, ${outcome.runs} run${outcome.runs === 1 ? "" : "s"}).`
				: `Already registered: ${outcome.path} (shard ${outcome.shardId}).`,
		);
	}
	for (const record of report.discovered) {
		log(
			record.outcome === "skipped"
				? `Skipped ${record.path}, referenced by runs in ${record.referencedBy} (${record.reason}).`
				: `Adopted ${record.path}, referenced by runs in ${record.referencedBy}.`,
		);
	}
	const note = storeSelectionNote(options, directory);
	if (note !== undefined) log(note);
	return 0;
}

async function consolidate(options: StorageCommandOptions, log: (line: string) => void): Promise<number> {
	const directory = defaultJournalStoreDirectory(options.agentDir);
	const report = await consolidateJournalStore(directory);
	log(`Moved ${report.moved} finished run${report.moved === 1 ? "" : "s"} into the journal store's shards.`);
	const reasons = new Map<string, number>();
	for (const run of report.runs)
		if (run.outcome === "skipped") reasons.set(run.reason, (reasons.get(run.reason) ?? 0) + 1);
	for (const [reason, count] of reasons)
		log(`Skipped completing consolidation for ${count} run${count === 1 ? "" : "s"}: ${reason}.`);
	const failures = new Map<string, string>();
	for (const run of report.runs)
		if (run.error !== undefined) failures.set(run.error.message, `${run.error.message} ${run.error.hint}`);
	for (const failure of failures.values()) log(failure);
	const note = storeSelectionNote(options, directory);
	if (note !== undefined) log(note);
	return failures.size === 0 ? 0 : 1;
}

/** What an export or import of one kind reads or writes, or why that kind is refused here. */
type Transfer<T> = { readonly target: T } | { readonly refused: string };

/**
 * The local workflow journal this directory's runs use, which `export` and `import` read and write. A shared database
 * is refused: every machine joined to it already reads its runs, so there is nothing to carry between them.
 */
function workflowTransfer(
	options: StorageCommandOptions,
	command: "export" | "import",
): Transfer<WorkflowRunTransferStorage> {
	const selection = effectiveJournalSelection(options.cwd, options.agentDir);
	if (selection.kind === "sharded") return { target: { kind: "store", directory: selection.dir } };
	if (selection.kind === "sqlite" && selection.path !== ":memory:")
		return {
			target: {
				kind: "sqlite",
				path: resolve(options.cwd, selection.path),
				...(selection.prefix === undefined ? {} : { prefix: selection.prefix }),
			},
		};
	return {
		refused:
			`${APP_NAME} storage ${command} works with a local workflow journal (the journal store or a SQLite file), but workflow runs here use ${describeStorageSelection(selection)}.` +
			(selection.kind === "adapter"
				? " A shared database already holds the runs of every machine joined to it, so there is nothing to export or import; use its own backups instead."
				: ""),
	};
}

/**
 * The session storage this directory selects, as a session started here would open it: the default database, a JSONL
 * directory, a SQLite file or an adapter. A shared libSQL / Turso database is refused as it is for workflow runs, and so
 * is in-memory storage, which keeps nothing. Undefined target for an export when nothing has been stored yet, so an
 * export creates no database.
 */
async function sessionTransfer(
	options: StorageCommandOptions,
	command: "export" | "import",
): Promise<Transfer<SessionStore | undefined>> {
	const settings = SettingsManager.create(options.cwd, options.agentDir, {
		projectTrusted: projectTrust(options.cwd, options.agentDir),
	}).getSettings();
	const storageOptions = { agentDir: options.agentDir, settings };
	const selection = selectSessionStorage(options.cwd, storageOptions);
	if (!("load" in selection)) {
		if (selection.kind === "memory" || (selection.kind === "sqlite" && selection.path === ":memory:"))
			return {
				refused: `${APP_NAME} storage ${command} needs stored sessions, but sessions here use ${describeStorageSelection(selection)}, which keeps nothing.`,
			};
		if (selection.kind === "adapter" && selection.module === LIBSQL_ADAPTER_PACKAGE)
			return {
				refused: `${APP_NAME} storage ${command} works with local session storage, but sessions here use ${describeStorageSelection(selection)}. A shared database already holds the sessions of every machine joined to it, so there is nothing to export or import; use its own backups instead.`,
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

async function exportRuns(
	command: Extract<StorageCommand, { kind: "export" }>,
	options: StorageCommandOptions,
	log: (line: string) => void,
	error: (line: string) => void,
): Promise<number> {
	const directory = resolve(options.cwd, command.directory);
	const workflows = command.kinds.workflows ? workflowTransfer(options, "export") : undefined;
	const sessions = command.kinds.sessions ? await sessionTransfer(options, "export") : undefined;
	try {
		const refusals = [workflows, sessions].flatMap((transfer) =>
			transfer !== undefined && "refused" in transfer ? [transfer.refused] : [],
		);
		const kinds = Number(command.kinds.sessions) + Number(command.kinds.workflows);
		if (refusals.length > 0 && (command.kinds.explicit || refusals.length === kinds))
			throw new StorageCommandError(refusals.join("\n"));
		for (const refused of refusals) error(`Skipped: ${refused}`);
		// Workflow runs first: an unknown --run fails the export before any file of either kind is written.
		if (workflows !== undefined && "target" in workflows) {
			const target = workflowsTransferDirectory(directory);
			const report = await exportWorkflowRuns(workflows.target, target, {
				unfinished: command.unfinished,
				...(command.runs === undefined ? {} : { runs: command.runs }),
				...(command.limit === undefined ? {} : { limit: command.limit }),
			});
			const total = report.written.length + report.unchanged.length;
			log(
				`Exported ${plural(total, "workflow run")} to ${target} (${report.written.length} written, ${report.unchanged.length} unchanged).`,
			);
			for (const skipped of report.skipped)
				error(
					`Skipped ${skipped.runId === undefined ? skipped.path : `run ${skipped.runId} (${skipped.path})`}: ${skipped.reason}.`,
				);
		}
		if (sessions !== undefined && "target" in sessions) {
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
		}
		return 0;
	} finally {
		await sessionStore(sessions)?.close();
	}
}

function describeIds(ids: TransferredIds): string {
	const parts = [
		ids.sessions.length === 0
			? undefined
			: `${ids.sessions.length === 1 ? "session" : "sessions"} ${ids.sessions.join(", ")}`,
		ids.workflows.length === 0
			? undefined
			: `${ids.workflows.length === 1 ? "workflow run" : "workflow runs"} ${ids.workflows.join(", ")}`,
	].filter((part) => part !== undefined);
	return parts.length === 0 ? "nothing" : parts.join("; ");
}

async function importRuns(
	command: Extract<StorageCommand, { kind: "import" }>,
	options: StorageCommandOptions,
	log: (line: string) => void,
	error: (line: string) => void,
): Promise<number> {
	const directory = resolve(options.cwd, command.directory);
	if (!existsSync(directory)) throw new StorageCommandError(`${directory}: no such directory.`);
	const workflows = command.kinds.workflows ? workflowTransfer(options, "import") : undefined;
	const sessions = command.kinds.sessions ? await sessionTransfer(options, "import") : undefined;
	try {
		const refusals = [workflows, sessions].flatMap((transfer) =>
			transfer !== undefined && "refused" in transfer ? [transfer.refused] : [],
		);
		const kinds = Number(command.kinds.sessions) + Number(command.kinds.workflows);
		if (refusals.length > 0 && (command.kinds.explicit || refusals.length === kinds))
			throw new StorageCommandError(refusals.join("\n"));
		for (const refused of refusals) error(`Skipped: ${refused}`);
		const sessionTarget = sessionStore(sessions);
		const workflowStorage = workflows !== undefined && "target" in workflows ? workflows.target : undefined;
		let report: Awaited<ReturnType<typeof importStorage>>;
		try {
			report = await importStorage(directory, {
				...(sessionTarget === undefined ? {} : { sessions: sessionTarget }),
				...(workflowStorage === undefined ? {} : { workflows: workflowStorage }),
			});
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
		if (report.sessions !== undefined) {
			const { added, updated, unchanged } = report.sessions;
			log(
				`Imported ${plural(added.length + updated.length + unchanged.length, "session")} from ${sessionsTransferDirectory(directory)} (${added.length} added, ${updated.length} updated, ${unchanged.length} already up to date).`,
			);
		}
		if (report.workflows !== undefined) {
			const { added, updated, unchanged } = report.workflows;
			log(
				`Imported ${plural(added.length + updated.length + unchanged.length, "workflow run")} from ${workflowsTransferDirectory(directory)} (${added.length} added, ${updated.length} updated, ${unchanged.length} already up to date).`,
			);
		}
		return 0;
	} finally {
		await sessionStore(sessions)?.close();
	}
}

function sessionStore(transfer: Transfer<SessionStore | undefined> | undefined): SessionStore | undefined {
	return transfer !== undefined && "target" in transfer ? transfer.target : undefined;
}
