/**
 * `atomic worker start|status` (#4768): one command joins this machine to a shared workflow database as a worker host,
 * over the workflows package's `startWorkflowWorkerHost`, and drains on SIGTERM or SIGINT.
 */

import { readFileSync, statSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { APP_NAME } from "../config.js";
import { getBuiltinPackageLocations } from "../core/builtin-packages.ts";
import { isTeamProfileConfigError } from "../core/storage/errors.js";
import { checkTeamPrefix, checkTeamUrl, LIBSQL_ADAPTER_PACKAGE } from "../core/storage/selection.js";

/** Most worker slots the default gives a host: past 16, a host's own checkpoint rate stops growing (#4768). */
const MAX_DEFAULT_SLOTS = 16;

/** Half the CPUs, at least 1 and at most 16: pooled children run CPU-heavy tools too (#4768). */
export function defaultWorkerSlots(cpus: number = availableParallelism()): number {
	return Math.max(1, Math.min(MAX_DEFAULT_SLOTS, Math.floor(cpus / 2)));
}

const HELP = `Usage:
  ${APP_NAME} worker start [--db <url>] [--token-file <path>] [--prefix <prefix>] [--slots <n>]
                      [--label <key=value>]... [--host-id <id>] [--no-restore] [--idle-exit <ms>] [--json]
  ${APP_NAME} worker status [--db <url>] [--token-file <path>] [--prefix <prefix>] [--json]

Commands:
  start    Run this machine as a worker host of a shared workflow database: it runs the pooled children of
           every root started with shared placement on that database, as many at once as --slots. SIGTERM
           or SIGINT drains: no new children are taken, running ones finish, then it exits 0. A second
           signal stops at once, handing running children back to other hosts, and exits 2. Exits 1 when
           setup is incomplete (every missing piece is listed) or the host fails.
  status   List the worker hosts registered in the database, each busy, idle, draining, degraded or stale,
           the fleet's queue, and the queue of each root they serve. Exits 1 when the database cannot be
           read or does not answer within 5 seconds, and says why.

Options:
  --db <url>            The shared libSQL / Turso database (libsql://, https://, wss:// or file:), for this
                        process only; nothing is written to settings. Default: the journal this machine
                        selects, for example after \`${APP_NAME} team join\`
  --token-file <path>   File holding the database token (mode 600). Only its path is passed on; the token is
                        never printed, logged or put in a command line
  --prefix <prefix>     Table prefix of the shared database
  --slots <n>           Most children this host runs at once. Default: half the CPUs, from 1 to 16 (here ${defaultWorkerSlots()})
  --label <key=value>   A label this host reports in status; repeat for more
  --host-id <id>        This host's id. Default: the id this machine keeps in its agent directory
  --no-restore          Take only work whose repository tree is already here; never restore one
  --idle-exit <ms>      Drain and exit 0 after no child ran for this many milliseconds
  --json                One JSON object per line`;

const HELP_HINT = `Use "${APP_NAME} worker --help" for usage.`;

/** A command line `atomic worker` refuses. It names the option, never its value, which could hold a secret. */
export class WorkerCommandError extends Error {
	override readonly name = "WorkerCommandError";
	readonly field: string;
	readonly hint: string;
	constructor(field: string, hint: string) {
		super(`Invalid worker command: ${field}. ${hint}`);
		this.field = field;
		this.hint = hint;
	}
}

/** The shared database a command names, or none for the journal this machine selects. */
export interface WorkerDatabase {
	readonly url: string;
	readonly tokenFile?: string;
	readonly prefix?: string;
}

export type WorkerCommand =
	| { readonly kind: "help" }
	| {
			readonly kind: "start";
			readonly database?: WorkerDatabase;
			readonly slots: number;
			readonly labels: Readonly<Record<string, string>>;
			readonly hostId?: string;
			readonly restore: boolean;
			readonly idleExitMs?: number;
			readonly json: boolean;
	  }
	| { readonly kind: "status"; readonly database?: WorkerDatabase; readonly json: boolean };

const VALUE_OPTIONS = new Set(["--db", "--token-file", "--prefix", "--slots", "--label", "--host-id", "--idle-exit"]);
const START_ONLY = new Set(["--slots", "--label", "--host-id", "--idle-exit", "--no-restore"]);

function positiveInteger(field: string, value: string): number {
	const parsed = /^[1-9][0-9]*$/.test(value) ? Number(value) : Number.NaN;
	if (!Number.isSafeInteger(parsed)) throw new WorkerCommandError(field, "Pass a positive integer.");
	return parsed;
}

function database(values: ReadonlyMap<string, string>, cwd: string): WorkerDatabase | undefined {
	const url = values.get("--db");
	if (url === undefined) {
		for (const option of ["--token-file", "--prefix"])
			if (values.has(option))
				throw new WorkerCommandError(option, "It qualifies --db; pass the database URL with --db too.");
		return undefined;
	}
	const tokenFile = values.get("--token-file");
	try {
		checkTeamUrl(url, "cli");
		const prefix = checkTeamPrefix(values.get("--prefix"), "cli");
		return {
			url,
			...(tokenFile === undefined ? {} : { tokenFile: resolve(cwd, tokenFile) }),
			...(prefix === undefined ? {} : { prefix }),
		};
	} catch (error) {
		if (!isTeamProfileConfigError(error)) throw error;
		throw new WorkerCommandError(error.field === "<url>" ? "--db" : error.field, error.hint);
	}
}

/** Parse the arguments after `worker`. */
export function parseWorkerCommand(
	args: readonly string[],
	options: { readonly cwd: string; readonly cpus?: number },
): WorkerCommand {
	const [command, ...rest] = args;
	if (command === undefined || command === "help" || args.includes("--help") || args.includes("-h"))
		return { kind: "help" };
	if (command !== "start" && command !== "status")
		throw new WorkerCommandError("<command>", `Use start or status. ${HELP_HINT}`);
	const values = new Map<string, string>();
	const labels: Record<string, string> = {};
	let json = false;
	let restore = true;
	for (let index = 0; index < rest.length; index++) {
		const arg = rest[index]!;
		const option = arg.split("=")[0]!;
		if (command === "status" && START_ONLY.has(option))
			throw new WorkerCommandError(option, `"${APP_NAME} worker status" does not take it. ${HELP_HINT}`);
		if (arg === "--json") json = true;
		else if (arg === "--no-restore") restore = false;
		else if (VALUE_OPTIONS.has(arg)) {
			const value = rest[++index];
			if (value === undefined) throw new WorkerCommandError(arg, `Pass a value after ${arg}.`);
			if (arg === "--label") {
				const separator = value.indexOf("=");
				if (separator < 1) throw new WorkerCommandError("--label", "Pass a label as key=value.");
				labels[value.slice(0, separator)] = value.slice(separator + 1);
			} else values.set(arg, value);
		} else if (arg.startsWith("-"))
			throw new WorkerCommandError(option, `It is not an option of worker ${command}. ${HELP_HINT}`);
		else
			throw new WorkerCommandError("arguments", `"${APP_NAME} worker ${command}" takes options only. ${HELP_HINT}`);
	}
	const selected = database(values, options.cwd);
	if (command === "status") return { kind: "status", ...(selected === undefined ? {} : { database: selected }), json };
	const hostId = values.get("--host-id");
	if (hostId !== undefined && (hostId === "" || hostId.includes("/")))
		throw new WorkerCommandError("--host-id", "Pass a non-empty id without '/'.");
	const slots = values.get("--slots");
	const idleExit = values.get("--idle-exit");
	return {
		kind: "start",
		...(selected === undefined ? {} : { database: selected }),
		slots: slots === undefined ? defaultWorkerSlots(options.cpus) : positiveInteger("--slots", slots),
		labels,
		...(hostId === undefined ? {} : { hostId }),
		restore,
		...(idleExit === undefined ? {} : { idleExitMs: positiveInteger("--idle-exit", idleExit) }),
		json,
	};
}

/** The journal selection a worker host opens for `database`: the token by file reference, never its value. */
export function workerJournalSelection(database: WorkerDatabase): WorkerJournalSelection {
	return {
		adapter: LIBSQL_ADAPTER_PACKAGE,
		options: { url: database.url },
		...(database.tokenFile === undefined ? {} : { secrets: { authToken: { file: database.tokenFile } } }),
		...(database.prefix === undefined ? {} : { prefix: database.prefix }),
	};
}

/** The database as output names it: the URL without query or fragment, where a credential could sit. */
function databaseLabel(database: WorkerDatabase | undefined): string {
	if (database === undefined) return "selected";
	const url = new URL(database.url);
	url.search = "";
	url.hash = "";
	return `${url.href}${database.prefix === undefined ? "" : ` prefix=${database.prefix}`}`;
}

// The shapes of the workflows package's public entry that this command uses (`startWorkflowWorkerHost`,
// `readWorkflowWorkerFleet`, `workflowWorkerFleetLines`).

export interface WorkerJournalSelection {
	readonly adapter: string;
	readonly options: { readonly url: string };
	readonly secrets?: { readonly authToken: { readonly file: string } };
	readonly prefix?: string;
}

interface WorkerHostFailure {
	readonly name: string;
	readonly message: string;
}

export type WorkerHostEvent =
	| {
			readonly kind: "claimed" | "released";
			readonly root: string;
			readonly childRunId: string;
			readonly work: string;
			readonly generation: number;
	  }
	| {
			readonly kind: "degraded";
			readonly failures: number;
			readonly retryInMs: number;
			readonly error: WorkerHostFailure;
	  }
	| { readonly kind: "recovered"; readonly failures: number }
	| { readonly kind: "idle-exit"; readonly idleMs: number };

export interface WorkerHostHandle {
	readonly hostId: string;
	stop(): Promise<void>;
	drain(): Promise<void>;
	readonly closed: Promise<void>;
}

export interface WorkerHostOptions {
	readonly journal?: WorkerJournalSelection;
	readonly agentDir: string;
	readonly maxWorkers: number;
	readonly labels: Readonly<Record<string, string>>;
	readonly hostId?: string;
	readonly restore?: false;
	readonly idleExitMs?: number;
	readonly onEvent: (event: WorkerHostEvent) => void;
}

/** A shared journal's fleet as the workflows package reads it; output prints it whole. */
export interface WorkerFleet {
	readonly fleet: { readonly store: { readonly state: "ok" | "degraded" | "unknown" }; readonly queue?: object };
}

export interface WorkerHostModule {
	startWorkflowWorkerHost(options: WorkerHostOptions): Promise<WorkerHostHandle>;
	readWorkflowWorkerFleet(options: {
		readonly journal?: WorkerJournalSelection;
		readonly agentDir: string;
	}): Promise<WorkerFleet>;
	/** The fleet as status lines, the same lines `/workflow status` shows of it. */
	workflowWorkerFleetLines(fleet: WorkerFleet): string[];
}

/**
 * Loads the bundled workflows package's public entry (its `main`: the source in a checkout, the shipped bundle in a
 * build), as extensions see the host's modules.
 */
async function loadWorkerHostModule(): Promise<WorkerHostModule> {
	const workflows = getBuiltinPackageLocations().find(({ distDirName }) => distDirName === "workflows");
	if (workflows === undefined) throw new Error("The bundled workflows package was not found.");
	const manifest = JSON.parse(readFileSync(join(workflows.packageDir, "package.json"), "utf8")) as { main: string };
	const modulePath = join(workflows.packageDir, manifest.main);
	const [{ createHostModuleJiti }, { getVirtualModules }] = await Promise.all([
		import("../core/extensions/loader-virtual-modules.js"),
		import("../core/extensions/loader-host-modules.js"),
	]);
	const loader = await createHostModuleJiti(pathToFileURL(modulePath).href, await getVirtualModules());
	return loader.import<WorkerHostModule>(modulePath);
}

export interface WorkerCommandOptions {
	readonly cwd: string;
	readonly agentDir: string;
	readonly log?: (line: string) => void;
	readonly error?: (line: string) => void;
	/** Defaults to the bundled workflows package's worker host module. */
	readonly loadModule?: () => Promise<WorkerHostModule>;
	/** Where `start` listens for SIGTERM and SIGINT. Default: this process. */
	readonly signals?: Pick<NodeJS.Process, "on" | "off">;
}

/** One output line: `event key=value …`, or a JSON object with `event` for `--json`. */
function formatter(json: boolean): (event: string, fields?: Readonly<Record<string, string | number>>) => string {
	return (event, fields = {}) =>
		json
			? JSON.stringify({ event, time: new Date().toISOString(), ...fields })
			: [
					event,
					...Object.entries(fields).map(([key, value]) => `${key}=${String(value).replace(/\s+/g, " ")}`),
				].join(" ");
}

/** Problems a setup error lists, one per line: the shared pool's own, or else the error's message. */
function setupLines(error: Error): string[] {
	const problems = (
		error as {
			readonly problems?: readonly { readonly subject: string; readonly code: string; readonly hint: string }[];
		}
	).problems;
	if (error.name !== "SharedPoolSetupError" || problems === undefined) return [error.message];
	return [
		`Worker host setup is incomplete:`,
		...problems.map((problem) => `  - ${problem.subject} (${problem.code}): ${problem.hint}`),
	];
}

/** Warns when the token file is readable by other users of this machine. */
function tokenFileWarning(database: WorkerDatabase | undefined): string | undefined {
	if (database?.tokenFile === undefined || process.platform === "win32") return undefined;
	try {
		if ((statSync(database.tokenFile).mode & 0o077) === 0) return undefined;
	} catch {
		// A missing file is a setup problem the host reports with the rest.
		return undefined;
	}
	return `The token file ${database.tokenFile} is readable by other users; restrict it with chmod 600.`;
}

async function start(
	command: Extract<WorkerCommand, { kind: "start" }>,
	options: WorkerCommandOptions,
	module: WorkerHostModule,
	log: (line: string) => void,
	error: (line: string) => void,
): Promise<number> {
	const line = formatter(command.json);
	const warning = tokenFileWarning(command.database);
	if (warning !== undefined) error(command.json ? line("warning", { message: warning }) : `Warning: ${warning}`);
	let host: WorkerHostHandle;
	try {
		host = await module.startWorkflowWorkerHost({
			...(command.database === undefined ? {} : { journal: workerJournalSelection(command.database) }),
			agentDir: options.agentDir,
			maxWorkers: command.slots,
			labels: command.labels,
			...(command.hostId === undefined ? {} : { hostId: command.hostId }),
			...(command.restore ? {} : { restore: false as const }),
			...(command.idleExitMs === undefined ? {} : { idleExitMs: command.idleExitMs }),
			onEvent: (event) => {
				switch (event.kind) {
					case "claimed":
					case "released":
						return log(
							line(event.kind, { child: event.childRunId, root: event.root, attempt: event.generation }),
						);
					case "degraded":
						return log(
							line("degraded", {
								failures: event.failures,
								retry_in_ms: event.retryInMs,
								error: `${event.error.name}: ${event.error.message}`,
							}),
						);
					case "recovered":
						return log(line("recovered", { failures: event.failures }));
					case "idle-exit":
						return log(line("idle-exit", { idle_ms: event.idleMs }));
				}
			},
		});
	} catch (caught) {
		for (const text of setupLines(caught as Error))
			error(command.json ? line("setup-failed", { message: text }) : text);
		return 1;
	}
	log(
		line("ready", {
			host: host.hostId,
			slots: command.slots,
			journal: databaseLabel(command.database),
			...(Object.keys(command.labels).length === 0
				? {}
				: {
						labels: Object.entries(command.labels)
							.map(([key, value]) => `${key}=${value}`)
							.join(","),
					}),
		}),
	);
	const signals = options.signals ?? process;
	let forced = false;
	let stopping: Promise<void> | undefined;
	const onSignal = (signal: NodeJS.Signals) => {
		if (stopping === undefined) {
			log(line("draining", { signal }));
			stopping = host.drain();
		} else if (!forced) {
			forced = true;
			log(line("stopping", { signal }));
			stopping = host.stop();
		}
		// A failure of either is reported once the host has closed.
		stopping.catch(() => {});
	};
	signals.on("SIGTERM", onSignal);
	signals.on("SIGINT", onSignal);
	try {
		await host.closed;
		// An idle exit drained without a signal; its failure, if any, is the host's own and already stopped it.
		await stopping;
	} catch (caught) {
		error(line("failed", { error: `${(caught as Error).name}: ${(caught as Error).message}` }));
		return 1;
	} finally {
		signals.off("SIGTERM", onSignal);
		signals.off("SIGINT", onSignal);
	}
	log(line(forced ? "stopped" : "drained", { host: host.hostId }));
	return forced ? 2 : 0;
}

/** Run `atomic worker <args>` and return the exit code. */
export async function runWorkerCommand(args: readonly string[], options: WorkerCommandOptions): Promise<number> {
	const log = options.log ?? ((line: string) => console.log(line));
	const error = options.error ?? ((line: string) => console.error(line));
	let command: WorkerCommand;
	try {
		command = parseWorkerCommand(args, { cwd: options.cwd });
	} catch (caught) {
		if (!(caught instanceof WorkerCommandError)) throw caught;
		error(caught.message);
		return 1;
	}
	if (command.kind === "help") {
		log(HELP);
		return 0;
	}
	let module: WorkerHostModule;
	try {
		module = await (options.loadModule ?? loadWorkerHostModule)();
	} catch (caught) {
		error(`Error: ${(caught as Error).message}`);
		return 1;
	}
	if (command.kind === "start") return start(command, options, module, log, error);
	try {
		const fleet = await module.readWorkflowWorkerFleet({
			...(command.database === undefined ? {} : { journal: workerJournalSelection(command.database) }),
			agentDir: options.agentDir,
		});
		if (command.json) log(JSON.stringify(fleet, null, 2));
		else for (const text of module.workflowWorkerFleetLines(fleet)) log(text);
		// A store that could not be read, unknown or degraded without a queue, is a failed status, though it printed why.
		return fleet.fleet.store.state === "ok" || fleet.fleet.queue !== undefined ? 0 : 1;
	} catch (caught) {
		for (const text of setupLines(caught as Error)) error(text);
		return 1;
	}
}
