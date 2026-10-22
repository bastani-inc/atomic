/**
 * `atomic storage status` shows which storage each domain (sessions, workflow runs, Intercom) selects, where the
 * selection comes from, whether its adapter loads and its database answers, and what the running Intercom broker
 * uses. `atomic storage join` points this machine's global `storage` setting at a shared libSQL / Turso database.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { APP_NAME } from "../config.js";
import type { IntercomBrokerControl } from "../core/intercom-broker-control.ts";
import { resolvePackageStorageAdapter } from "../core/package-manager-storage-adapters.js";
import { SettingsManager } from "../core/settings-manager.ts";
import type { Settings } from "../core/settings-schema.ts";
import { validateStoragePrefix } from "../core/storage/prefix.js";
import { loadStorageAdapter } from "../core/storage/provider.js";
import { selectStorage } from "../core/storage/selection.js";
import {
	collectStorageStatus,
	type DomainStatus,
	describeStorageError,
	describeStorageSelection,
	type StorageStatus,
} from "../core/storage/storage-status.ts";

/** The first-party libSQL / Turso adapter package that `atomic storage join` selects. */
export const LIBSQL_ADAPTER_PACKAGE = "@bastani/atomic-storage-libsql";
/** Where `atomic storage join` keeps the database token, in the agent directory. */
export const STORAGE_TOKEN_FILE = "storage-token";

const HELP = `Usage:
  ${APP_NAME} storage status [--json]
  ${APP_NAME} storage join <url> [--token-file <path>] [--prefix <prefix>]

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

Options:
  --json                Print the status as JSON
  --token-file <path>   File holding the database token, for example from \`turso db tokens create\`;
                        surrounding whitespace is removed. Required except for file: URLs
  --prefix <prefix>     Table prefix, to share one database between projects or teams`;

const HELP_HINT = `Use "${APP_NAME} storage --help" for usage.`;

export type StorageCommand =
	| { readonly kind: "help" }
	| { readonly kind: "status"; readonly json: boolean }
	| { readonly kind: "join"; readonly url: string; readonly tokenFile?: string; readonly prefix?: string };

export class StorageCommandError extends Error {}

/** Whether a database URL holds the token itself: userinfo, or the `authToken` query parameter libSQL URLs accept. */
function carriesCredential(url: string): boolean {
	try {
		const { username, password, searchParams } = new URL(url);
		return username !== "" || password !== "" || searchParams.has("authToken");
	} catch {
		return false;
	}
}

/** Parse the arguments after `storage`. */
export function parseStorageCommand(args: readonly string[]): StorageCommand {
	const [command, ...rest] = args;
	if (command === undefined || command === "help" || args.includes("--help") || args.includes("-h")) {
		return { kind: "help" };
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
		if (command === "join" && (arg === "--token-file" || arg === "--prefix")) {
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
		if (!/^(libsql|https?|wss?):\/\/[^/]/.test(url) && !url.startsWith("file:")) {
			throw new StorageCommandError(
				`Unsupported database URL "${url}". Use a libsql://, https://, wss://, or file: URL.`,
			);
		}
		if (!url.startsWith("file:") && carriesCredential(url)) {
			throw new StorageCommandError(
				"The database URL carries a credential (user name, password, or authToken). Pass the token with --token-file instead, so it is kept in a private file and not in settings.",
			);
		}
		const tokenFile = values.get("--token-file");
		if (tokenFile === undefined && !url.startsWith("file:")) {
			throw new StorageCommandError(`--token-file is required for ${url.split(":")[0]}: URLs.`);
		}
		const prefix = values.get("--prefix");
		return {
			kind: "join",
			url,
			...(tokenFile === undefined ? {} : { tokenFile }),
			...(prefix === undefined ? {} : { prefix }),
		};
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

async function loadControl(options: StorageCommandOptions): Promise<IntercomBrokerControl | Error> {
	try {
		if (options.loadControl) return await options.loadControl();
		const { loadIntercomBrokerControl } = await import("../core/intercom-broker-control.ts");
		return await loadIntercomBrokerControl();
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
}

function failed(domain: DomainStatus): boolean {
	return (
		domain.error !== undefined ||
		domain.probe?.adapter?.loaded === false ||
		domain.probe?.connection.status === "failed"
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
					: `  storage:     differs from the selection above${broker.source === "env" ? " (a session started it with ATOMIC_STORAGE or --storage)" : ""}; run \`${APP_NAME} intercom restart\` to use the current one`,
			);
			if (broker.multiNodeLine !== undefined) lines.push(`  multi-node:  ${broker.multiNodeLine}`);
		}
	}
	if (status.notes.length > 0) lines.push("", "Notes:", ...status.notes.map((note) => `  - ${note}`));
	return lines;
}

async function status(json: boolean, options: StorageCommandOptions, log: (line: string) => void): Promise<number> {
	const control = await loadControl(options);
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

/** Write `token` to `path` with mode 0600 without leaving a partly written file. */
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

async function joinStorage(
	command: Extract<StorageCommand, { kind: "join" }>,
	options: StorageCommandOptions,
	log: (...lines: string[]) => void,
): Promise<number> {
	const { agentDir, cwd } = options;
	if (command.prefix !== undefined) {
		try {
			validateStoragePrefix(command.prefix);
		} catch (error) {
			throw new StorageCommandError(`Invalid --prefix "${command.prefix}": ${errorText(error as Error)}.`);
		}
	}
	let token: string | undefined;
	let tokenSource: string | undefined;
	if (command.tokenFile !== undefined) {
		tokenSource = resolve(cwd, command.tokenFile);
		try {
			token = readFileSync(tokenSource, "utf8").trim();
		} catch (error) {
			throw new StorageCommandError(`Cannot read the token file ${tokenSource}: ${errorText(error as Error)}`);
		}
		if (token.length === 0) throw new StorageCommandError(`The token file ${tokenSource} is empty.`);
	}
	if ((await resolvePackageStorageAdapter(LIBSQL_ADAPTER_PACKAGE, agentDir)) === undefined) {
		throw new StorageCommandError(
			`The libSQL storage adapter is not installed for ${agentDir}. Install it, then run this command again:\n  ${APP_NAME} install npm:${LIBSQL_ADAPTER_PACKAGE}`,
		);
	}
	const manager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	const settingsErrors = manager.drainErrors().filter(({ scope }) => scope === "global");
	if (settingsErrors.length > 0) {
		throw new StorageCommandError(
			`Cannot update the global settings: ${settingsErrors.map(({ error }) => error.message).join("; ")}. Fix ${join(agentDir, "settings.json")} first.`,
		);
	}
	try {
		await checkConnection(command.url, token, agentDir);
	} catch (error) {
		throw new StorageCommandError(
			`Could not connect to ${command.url}: ${errorText(error as Error)}. Nothing was changed.`,
		);
	}
	log(`Connected to ${command.url}.`);

	const tokenPath = join(agentDir, STORAGE_TOKEN_FILE);
	if (token !== undefined && tokenSource !== undefined) {
		if (resolve(tokenSource) === resolve(tokenPath)) {
			if (readFileSync(tokenPath, "utf8") !== token) {
				throw new StorageCommandError(
					`${tokenPath} is where ${APP_NAME} keeps the token; pass a token file from another location so it is not rewritten in place.`,
				);
			}
			chmodSync(tokenPath, 0o600);
		} else {
			writePrivateFile(tokenPath, token);
		}
		log(`Stored the token in ${tokenPath} (mode 600).`);
	}

	const previous = manager.getGlobalSettings().storage;
	const storage: NonNullable<Settings["storage"]> = {
		adapter: LIBSQL_ADAPTER_PACKAGE,
		options: { url: command.url },
		...(token === undefined
			? {}
			: { secrets: { authToken: { file: relative(dirname(agentDir), tokenPath).split(sep).join("/") } } }),
		...(command.prefix === undefined ? {} : { prefix: command.prefix }),
	};
	manager.setStorage(storage);
	await manager.flush();
	const writeErrors = manager.drainErrors();
	if (writeErrors.length > 0) {
		throw new StorageCommandError(
			`Could not write the global settings: ${writeErrors.map(({ error }) => error.message).join("; ")}`,
		);
	}
	log(`Set \`storage\` in ${join(agentDir, "settings.json")}; other settings are unchanged.`);
	if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(storage)) {
		const described = (() => {
			try {
				return describeStorageSelection(selectStorage(previous, "settings", "storage", ""));
			} catch {
				return "an invalid selection";
			}
		})();
		log(`It replaces the previous selection: ${described}.`);
	}

	const control = await loadControl(options);
	const collected = await collectStorageStatus({
		cwd,
		agentDir,
		probe: false,
		...(control instanceof Error ? {} : { control }),
	});
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
		return await joinStorage(command, options, (...lines) => {
			for (const line of lines) log(line);
		});
	} catch (caught) {
		error(caught instanceof StorageCommandError ? caught.message : `Error: ${errorText(caught as Error)}`);
		return 1;
	}
}
