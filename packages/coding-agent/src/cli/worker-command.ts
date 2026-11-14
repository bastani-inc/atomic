/**
 * `atomic worker start|status|controller` (#4768): one command joins this machine to a shared workflow database as a
 * worker host, over the workflows package's `startWorkflowWorkerHost`, and drains on SIGTERM or SIGINT; another runs a
 * fleet controller that adds and removes hosts through a provisioner module.
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
  ${APP_NAME} worker controller --provisioner <module> [--db <url>] [--token-file <path>] [--prefix <prefix>]
                      [--min-hosts <n>] [--max-hosts <n>] [--workers-per-host <n>] [--scale-up-queue-depth <n>]
                      [--scale-up-delay <ms>] [--idle-drain <ms>] [--boot-timeout <ms>] [--json]

Commands:
  start    Run this machine as a worker host of a shared workflow database: it runs the pooled children of
           every root started with shared placement on that database, as many at once as --slots. SIGTERM
           or SIGINT drains: no new children are taken, running ones finish, then it exits 0. A second
           signal stops at once, handing running children back to other hosts, and exits 2. Exits 1 when
           setup is incomplete (every missing piece is listed) or the host fails.
  status   List the worker hosts registered in the database and the queue of each root they serve.
  controller
           Add worker hosts through a provisioner as the database's shared queues grow, and drain and remove
           hosts that sat idle. Several controllers may run; one is active at a time and another takes over
           when it stops. A provisioner failure is reported and retried, and never affects a run. SIGTERM or
           SIGINT stops it (exit 0).

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
  --json                One JSON object per line

Controller options:
  --provisioner <module>         A JavaScript module whose default export is a worker host provisioner, or a
                                 function that returns one
  --min-hosts <n>                Hosts kept however idle. Default 0
  --max-hosts <n>                Hosts never exceeded. Default 10
  --workers-per-host <n>         The --slots the hosts start with. Default 4
  --scale-up-queue-depth <n>     Ready children tolerated before hosts are added. Default: --workers-per-host
  --scale-up-delay <ms>          How long the queue stays that deep first. Default 20000
  --idle-drain <ms>              How long a host holds no child before it is drained and removed. Default 300000
  --boot-timeout <ms>            How long a new host may take to register. Default 600000

A host a provisioner starts reports the provider's id for it from ATOMIC_WORKER_PROVIDER_ID.`;

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
	| { readonly kind: "status"; readonly database?: WorkerDatabase; readonly json: boolean }
	| {
			readonly kind: "controller";
			readonly database?: WorkerDatabase;
			/** The provisioner module's absolute path. */
			readonly provisioner: string;
			readonly policy: WorkerFleetPolicy;
			readonly json: boolean;
	  };

/** The policy knobs `atomic worker controller` takes, as the workflows package's `WorkerFleetPolicyOptions`. */
export interface WorkerFleetPolicy {
	readonly minHosts?: number;
	readonly maxHosts?: number;
	readonly workersPerHost?: number;
	readonly scaleUpQueueDepth?: number;
	readonly scaleUpDelayMs?: number;
	readonly idleDrainMs?: number;
	readonly bootTimeoutMs?: number;
}

/** Each controller option, its policy field, and whether 0 is allowed. */
const POLICY_OPTIONS: Readonly<Record<string, { readonly field: keyof WorkerFleetPolicy; readonly zero: boolean }>> = {
	"--min-hosts": { field: "minHosts", zero: true },
	"--max-hosts": { field: "maxHosts", zero: true },
	"--workers-per-host": { field: "workersPerHost", zero: false },
	"--scale-up-queue-depth": { field: "scaleUpQueueDepth", zero: true },
	"--scale-up-delay": { field: "scaleUpDelayMs", zero: true },
	"--idle-drain": { field: "idleDrainMs", zero: true },
	"--boot-timeout": { field: "bootTimeoutMs", zero: false },
};

const VALUE_OPTIONS = new Set([
	"--db",
	"--token-file",
	"--prefix",
	"--slots",
	"--label",
	"--host-id",
	"--idle-exit",
	"--provisioner",
	...Object.keys(POLICY_OPTIONS),
]);
const START_ONLY = new Set(["--slots", "--label", "--host-id", "--idle-exit", "--no-restore"]);
const CONTROLLER_ONLY = new Set(["--provisioner", ...Object.keys(POLICY_OPTIONS)]);

function positiveInteger(field: string, value: string): number {
	const parsed = /^[1-9][0-9]*$/.test(value) ? Number(value) : Number.NaN;
	if (!Number.isSafeInteger(parsed)) throw new WorkerCommandError(field, "Pass a positive integer.");
	return parsed;
}

function nonNegativeInteger(field: string, value: string): number {
	const parsed = /^(0|[1-9][0-9]*)$/.test(value) ? Number(value) : Number.NaN;
	if (!Number.isSafeInteger(parsed)) throw new WorkerCommandError(field, "Pass an integer of at least 0.");
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
	if (command !== "start" && command !== "status" && command !== "controller")
		throw new WorkerCommandError("<command>", `Use start, status or controller. ${HELP_HINT}`);
	const values = new Map<string, string>();
	const labels: Record<string, string> = {};
	let json = false;
	let restore = true;
	for (let index = 0; index < rest.length; index++) {
		const arg = rest[index]!;
		const option = arg.split("=")[0]!;
		if ((command !== "start" && START_ONLY.has(option)) || (command !== "controller" && CONTROLLER_ONLY.has(option)))
			throw new WorkerCommandError(option, `"${APP_NAME} worker ${command}" does not take it. ${HELP_HINT}`);
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
	if (command === "controller") {
		const provisioner = values.get("--provisioner");
		if (provisioner === undefined)
			throw new WorkerCommandError("--provisioner", "Pass the provisioner module the controller drives.");
		const policy: Record<string, number> = {};
		for (const [option, { field, zero }] of Object.entries(POLICY_OPTIONS)) {
			const value = values.get(option);
			if (value !== undefined)
				policy[field] = zero ? nonNegativeInteger(option, value) : positiveInteger(option, value);
		}
		return {
			kind: "controller",
			...(selected === undefined ? {} : { database: selected }),
			provisioner: resolve(options.cwd, provisioner),
			policy,
			json,
		};
	}
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

// The shapes of the workflows package's public entry that this command uses (`startWorkflowWorkerHost`, `readWorkflowWorkerFleet`).

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
	| { readonly kind: "idle-exit"; readonly idleMs: number }
	| { readonly kind: "drain-requested" };

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

interface FleetHost {
	readonly host: string;
	readonly labels: Readonly<Record<string, string>>;
	readonly workers: number;
	readonly maxWorkers: number;
	readonly roots: readonly string[];
	readonly heartbeatAgoMs: number;
}

interface FleetRoot {
	readonly root: string;
	readonly ready: number;
	readonly leased: number;
	readonly completed: number;
	readonly failed: number;
	readonly hosts: readonly { readonly host: string; readonly leased: number }[];
}

export interface WorkerFleet {
	readonly hosts: readonly FleetHost[];
	readonly roots: readonly FleetRoot[];
}

/** A worker host provisioner, as the workflows package's `WorkerHostProvisioner`; the module supplies it. */
export interface WorkerProvisioner {
	readonly kind: string;
	list(signal: AbortSignal): Promise<readonly object[]>;
	scaleTo(target: number, signal: AbortSignal): Promise<void>;
	drain(id: string, signal: AbortSignal): Promise<void>;
}

export type WorkerFleetEvent =
	| { readonly kind: "active"; readonly epoch: number }
	| { readonly kind: "standby"; readonly holder: string }
	| { readonly kind: "scale-up"; readonly target: number; readonly desired: number; readonly live: number }
	| { readonly kind: "drain-requested"; readonly id: string; readonly host: string }
	| { readonly kind: "removed"; readonly id: string; readonly reason: string }
	| {
			readonly kind: "degraded";
			readonly failures: number;
			readonly retryInMs: number;
			readonly error: WorkerHostFailure;
	  }
	| { readonly kind: "recovered"; readonly failures: number };

export interface WorkerFleetControllerHandle {
	readonly holder: string;
	stop(): Promise<void>;
}

export interface WorkerHostModule {
	startWorkflowFleetController(
		options: WorkerFleetPolicy & {
			readonly journal?: WorkerJournalSelection;
			readonly agentDir: string;
			readonly provisioner: WorkerProvisioner;
			readonly onEvent: (event: WorkerFleetEvent) => void;
		},
	): Promise<WorkerFleetControllerHandle>;
	startWorkflowWorkerHost(options: WorkerHostOptions): Promise<WorkerHostHandle>;
	readWorkflowWorkerFleet(options: {
		readonly journal?: WorkerJournalSelection;
		readonly agentDir: string;
	}): Promise<WorkerFleet>;
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
	/** Where `start` and `controller` listen for SIGTERM and SIGINT. Default: this process. */
	readonly signals?: Pick<NodeJS.Process, "on" | "off">;
	/** Loads a controller's provisioner module. Default: an `import()` of its path. */
	readonly loadProvisioner?: (path: string) => Promise<WorkerProvisioner>;
}

/**
 * The provisioner a module supplies: its default export, either a provisioner or a function that returns one. The
 * module runs with this process's environment, where the provider's own credential chain is.
 */
async function importProvisioner(path: string): Promise<WorkerProvisioner> {
	const exported = ((await import(pathToFileURL(path).href)) as { default?: unknown }).default;
	const provisioner = typeof exported === "function" ? await (exported as () => unknown)() : exported;
	const candidate = provisioner as Partial<WorkerProvisioner> | undefined;
	if (
		typeof candidate?.kind !== "string" ||
		typeof candidate.list !== "function" ||
		typeof candidate.scaleTo !== "function" ||
		typeof candidate.drain !== "function"
	)
		throw new Error(
			`${path} does not export a provisioner: its default export must have a kind and list, scaleTo and drain methods, or be a function that returns one.`,
		);
	return candidate as WorkerProvisioner;
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
					case "drain-requested":
						return log(line("drain-requested"));
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

function fleetEventFields(event: WorkerFleetEvent): Readonly<Record<string, string | number>> {
	switch (event.kind) {
		case "active":
			return { epoch: event.epoch };
		case "standby":
			return { holder: event.holder };
		case "scale-up":
			return { target: event.target, desired: event.desired, live: event.live };
		case "drain-requested":
			return { id: event.id, host: event.host };
		case "removed":
			return { id: event.id, reason: event.reason };
		case "degraded":
			return {
				failures: event.failures,
				retry_in_ms: event.retryInMs,
				error: `${event.error.name}: ${event.error.message}`,
			};
		case "recovered":
			return { failures: event.failures };
	}
}

async function controller(
	command: Extract<WorkerCommand, { kind: "controller" }>,
	options: WorkerCommandOptions,
	module: WorkerHostModule,
	log: (line: string) => void,
	error: (line: string) => void,
): Promise<number> {
	const line = formatter(command.json);
	const warning = tokenFileWarning(command.database);
	if (warning !== undefined) error(command.json ? line("warning", { message: warning }) : `Warning: ${warning}`);
	let handle: WorkerFleetControllerHandle;
	try {
		const provisioner = await (options.loadProvisioner ?? importProvisioner)(command.provisioner);
		handle = await module.startWorkflowFleetController({
			...(command.database === undefined ? {} : { journal: workerJournalSelection(command.database) }),
			agentDir: options.agentDir,
			provisioner,
			...command.policy,
			onEvent: (event) => log(line(event.kind, fleetEventFields(event))),
		});
	} catch (caught) {
		for (const text of setupLines(caught as Error))
			error(command.json ? line("setup-failed", { message: text }) : text);
		return 1;
	}
	log(line("controller", { holder: handle.holder, journal: databaseLabel(command.database) }));
	const signals = options.signals ?? process;
	const stopped = Promise.withResolvers<NodeJS.Signals>();
	const onSignal = (signal: NodeJS.Signals) => stopped.resolve(signal);
	signals.on("SIGTERM", onSignal);
	signals.on("SIGINT", onSignal);
	try {
		const signal = await stopped.promise;
		log(line("stopping", { signal }));
		await handle.stop();
	} finally {
		signals.off("SIGTERM", onSignal);
		signals.off("SIGINT", onSignal);
	}
	log(line("stopped", { holder: handle.holder }));
	return 0;
}

function formatAgo(ms: number): string {
	return ms < 1_000 ? `${Math.max(0, Math.round(ms))} ms` : `${(ms / 1_000).toFixed(1)} s`;
}

function fleetLines(fleet: WorkerFleet): string[] {
	const lines = [`Hosts: ${fleet.hosts.length}`];
	for (const host of fleet.hosts) {
		const labels = Object.entries(host.labels).map(([key, value]) => `${key}=${value}`);
		lines.push(
			`  ${host.host}  workers ${host.workers}/${host.maxWorkers}  roots ${host.roots.length}  reported ${formatAgo(host.heartbeatAgoMs)} ago${labels.length === 0 ? "" : `  labels ${labels.join(",")}`}`,
		);
	}
	lines.push(`Roots: ${fleet.roots.length}`);
	for (const root of fleet.roots) {
		const hosts = root.hosts.filter((host) => host.leased > 0).map((host) => `${host.host}(${host.leased})`);
		lines.push(
			`  ${root.root}  ready ${root.ready}  running ${root.leased}  completed ${root.completed}  failed ${root.failed}${hosts.length === 0 ? "" : `  on ${hosts.join(", ")}`}`,
		);
	}
	return lines;
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
	if (command.kind === "controller") return controller(command, options, module, log, error);
	try {
		const fleet = await module.readWorkflowWorkerFleet({
			...(command.database === undefined ? {} : { journal: workerJournalSelection(command.database) }),
			agentDir: options.agentDir,
		});
		if (command.json) log(JSON.stringify(fleet, null, 2));
		else for (const text of fleetLines(fleet)) log(text);
		return 0;
	} catch (caught) {
		for (const text of setupLines(caught as Error)) error(text);
		return 1;
	}
}
