import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, test } from "vitest";
import {
	defaultWorkerSlots,
	parseWorkerCommand,
	runWorkerCommand,
	WorkerCommandError,
	type WorkerFleet,
	type WorkerHostEvent,
	type WorkerHostModule,
	type WorkerHostOptions,
} from "../../packages/coding-agent/src/cli/worker-command.js";
import { LIBSQL_ADAPTER_PACKAGE } from "../../packages/coding-agent/src/core/storage/selection.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const TOKEN = "tok-secret-4768-do-not-print";
const libsqlPackage = fileURLToPath(new URL("../../packages/storage-libsql", import.meta.url));
let root: string;
let tokenFile: string;

beforeEach(() => {
	root = makeTempDirectory("worker-command-");
	tokenFile = join(root, "token");
	writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
});

afterEach(() => removeTempDirectory(root));

function refused(args: readonly string[], field: string): void {
	assert.throws(
		() => parseWorkerCommand(args, { cwd: root, cpus: 8 }),
		(error: unknown) => error instanceof WorkerCommandError && error.field === field,
		`${args.join(" ")} is refused naming ${field}`,
	);
}

test("worker start parses every option into one host configuration (#4768)", () => {
	const command = parseWorkerCommand(
		[
			"start",
			"--db",
			"libsql://pool.example.turso.io",
			"--token-file",
			"token",
			"--prefix",
			"team_",
			"--slots",
			"4",
			"--label",
			"zone=east",
			"--label",
			"rack=r=2",
			"--host-id",
			"node-1",
			"--no-restore",
			"--idle-exit",
			"60000",
			"--json",
		],
		{ cwd: root, cpus: 8 },
	);
	assert.deepEqual(command, {
		kind: "start",
		database: { url: "libsql://pool.example.turso.io", tokenFile, prefix: "team_" },
		slots: 4,
		labels: { zone: "east", rack: "r=2" },
		hostId: "node-1",
		restore: false,
		idleExitMs: 60_000,
		json: true,
	});
	assert.deepEqual(parseWorkerCommand(["status", "--json"], { cwd: root }), { kind: "status", json: true });
	assert.deepEqual(parseWorkerCommand(["--help"], { cwd: root }), { kind: "help" });
	assert.deepEqual(parseWorkerCommand([], { cwd: root }), { kind: "help" });
});

test("worker start refuses bad arguments by option name, never echoing a value (#4768)", () => {
	refused(["serve"], "<command>");
	refused(["start", "--slots", "0"], "--slots");
	refused(["start", "--slots", "1.5"], "--slots");
	refused(["start", "--idle-exit", "-1"], "--idle-exit");
	refused(["start", "--label", "zone"], "--label");
	refused(["start", "--label", "=east"], "--label");
	refused(["start", "--slots"], "--slots");
	refused(["start", "--token-file", "token"], "--token-file");
	refused(["start", "--prefix", "p_"], "--prefix");
	refused(["start", "--host-id", "a/b"], "--host-id");
	refused(["start", "--verbose"], "--verbose");
	refused(["start", "extra"], "arguments");
	refused(["status", "--slots", "2"], "--slots");
	refused(["start", "--db", "ftp://pool"], "--db");
	refused(["start", "--db", "file:relative.db"], "--db");
	refused(["start", "--db", "libsql://pool", "--prefix", "1bad"], "--prefix");
	// A credential in the URL is refused, and the message does not repeat it.
	const url = `libsql://pool.example.turso.io?authToken=${TOKEN}`;
	assert.throws(
		() => parseWorkerCommand(["start", "--db", url], { cwd: root }),
		(error: unknown) =>
			error instanceof WorkerCommandError && error.field === "--db" && !error.message.includes(TOKEN),
	);
});

test("worker slots default to half the CPUs, from 1 to 16 (#4768)", () => {
	assert.deepEqual(
		[1, 2, 3, 4, 7, 8, 31, 32, 33, 64, 128].map((cpus) => defaultWorkerSlots(cpus)),
		[1, 1, 1, 2, 3, 4, 15, 16, 16, 16, 16],
	);
	const command = parseWorkerCommand(["start"], { cwd: root, cpus: 12 });
	assert.equal(command.kind === "start" && command.slots, 6);
	assert.ok(defaultWorkerSlots() >= 1);
});

/** A worker host module that records what it was given and lets the test drive the host. */
function fakeModule(behavior: { readonly setup?: Error; readonly drain?: Error } = {}) {
	const given: WorkerHostOptions[] = [];
	const calls: string[] = [];
	let close!: () => void;
	const closed = new Promise<void>((resolve) => {
		close = resolve;
	});
	let emit: (event: WorkerHostEvent) => void = () => {};
	const module: WorkerHostModule = {
		async startWorkflowWorkerHost(options) {
			given.push(options);
			if (behavior.setup !== undefined) throw behavior.setup;
			emit = options.onEvent;
			return {
				hostId: options.hostId ?? "host-a",
				closed,
				async drain() {
					calls.push("drain");
					await new Promise((resolve) => setTimeout(resolve, 20));
					close();
					if (behavior.drain !== undefined) throw behavior.drain;
				},
				async stop() {
					calls.push("stop");
					close();
				},
			};
		},
		async readWorkflowWorkerFleet() {
			return { hosts: [], roots: [] };
		},
	};
	return { module, given, calls, emit: (event: WorkerHostEvent) => emit(event) };
}

async function started(args: readonly string[], fake: ReturnType<typeof fakeModule>) {
	const out: string[] = [];
	const err: string[] = [];
	const signals = new EventEmitter();
	const exit = runWorkerCommand(args, {
		cwd: root,
		agentDir: join(root, "agent"),
		log: (line) => out.push(line),
		error: (line) => err.push(line),
		loadModule: async () => fake.module,
		signals: signals as unknown as Pick<NodeJS.Process, "on" | "off">,
	});
	while (fake.given.length === 0 || out.length === 0) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	return { out, err, signals, exit };
}

test("the token is passed by file reference and never appears in output, even in failures (#4768)", async () => {
	chmodSync(tokenFile, 0o600);
	const fake = fakeModule();
	const args = ["start", "--db", "libsql://pool.example.turso.io", "--token-file", tokenFile, "--slots", "2"];
	const host = await started(args, fake);
	fake.emit({ kind: "claimed", root: "r1", childRunId: "c1", work: "w1", generation: 1 });
	fake.emit({
		kind: "degraded",
		failures: 1,
		retryInMs: 1_000,
		error: { name: "StorageUnavailableError", message: "fetch failed\nconnection refused" },
	});
	fake.emit({ kind: "recovered", failures: 1 });
	fake.emit({ kind: "released", root: "r1", childRunId: "c1", work: "w1", generation: 1 });
	host.signals.emit("SIGTERM", "SIGTERM");
	assert.equal(await host.exit, 0);
	const [options] = fake.given;
	assert.deepEqual(options?.journal, {
		adapter: LIBSQL_ADAPTER_PACKAGE,
		options: { url: "libsql://pool.example.turso.io" },
		secrets: { authToken: { file: tokenFile } },
	});
	assert.equal(options?.maxWorkers, 2);
	assert.ok(!JSON.stringify(options).includes(TOKEN), "the host is given the token's file, not the token");
	assert.deepEqual(host.out, [
		"ready host=host-a slots=2 journal=libsql://pool.example.turso.io",
		"claimed child=c1 root=r1 attempt=1",
		"degraded failures=1 retry_in_ms=1000 error=StorageUnavailableError: fetch failed connection refused",
		"recovered failures=1",
		"released child=c1 root=r1 attempt=1",
		"draining signal=SIGTERM",
		"drained host=host-a",
	]);
	assert.deepEqual(host.err, []);
	assert.deepEqual(fake.calls, ["drain"]);

	// A setup failure lists every problem and exits 1, still without the token.
	const failing = fakeModule({
		setup: Object.assign(new Error("Shared worker pool setup incomplete"), {
			name: "SharedPoolSetupError",
			problems: [
				{ subject: "@bastani/atomic-storage-libsql", code: "storage-adapter-unavailable", hint: "Install it." },
				{ subject: "secret authToken", code: "journal-secret-unavailable", hint: "Create the file." },
			],
		}),
	});
	const out: string[] = [];
	const err: string[] = [];
	const code = await runWorkerCommand([...args, "--json"], {
		cwd: root,
		agentDir: join(root, "agent"),
		log: (line) => out.push(line),
		error: (line) => err.push(line),
		loadModule: async () => failing.module,
	});
	assert.equal(code, 1);
	assert.deepEqual(out, []);
	assert.deepEqual(
		err.map((line) => (JSON.parse(line) as { event: string; message: string }).message),
		[
			"Worker host setup is incomplete:",
			"  - @bastani/atomic-storage-libsql (storage-adapter-unavailable): Install it.",
			"  - secret authToken (journal-secret-unavailable): Create the file.",
		],
	);
	for (const line of [...host.out, ...host.err, ...out, ...err]) assert.ok(!line.includes(TOKEN), line);
});

test("a second signal stops at once and exits 2; a failed drain exits 1 (#4768)", async () => {
	const fake = fakeModule();
	const host = await started(["start", "--json"], fake);
	host.signals.emit("SIGINT", "SIGINT");
	host.signals.emit("SIGINT", "SIGINT");
	assert.equal(await host.exit, 2);
	assert.deepEqual(fake.calls, ["drain", "stop"]);
	assert.equal(fake.given[0]?.journal, undefined, "without --db the host opens the journal this machine selects");
	assert.deepEqual(
		host.out.map((line) => (JSON.parse(line) as { event: string }).event),
		["ready", "draining", "stopping", "stopped"],
	);
	assert.equal(host.signals.listenerCount("SIGINT"), 0, "the handlers are removed once the host closed");

	const failing = fakeModule({ drain: new Error("journal closed badly") });
	const drained = await started(["start"], failing);
	drained.signals.emit("SIGTERM", "SIGTERM");
	assert.equal(await drained.exit, 1);
	assert.deepEqual(drained.err, ["failed error=Error: journal closed badly"]);
});

test("worker start warns about a token file other users can read (#4768)", async () => {
	if (process.platform === "win32") return;
	chmodSync(tokenFile, 0o644);
	const fake = fakeModule();
	const host = await started(["start", "--db", "file:///tmp/pool.db", "--token-file", tokenFile], fake);
	host.signals.emit("SIGTERM", "SIGTERM");
	assert.equal(await host.exit, 0);
	assert.deepEqual(host.err, [
		`Warning: The token file ${tokenFile} is readable by other users; restrict it with chmod 600.`,
	]);
});

async function run(args: readonly string[], loadModule: () => Promise<WorkerHostModule>) {
	const out: string[] = [];
	const err: string[] = [];
	const code = await runWorkerCommand(args, {
		cwd: root,
		agentDir: join(root, "agent"),
		log: (line) => out.push(line),
		error: (line) => err.push(line),
		loadModule,
	});
	return { code, out, err };
}

const unloadable = async (): Promise<WorkerHostModule> => {
	throw new Error("the workflows package did not load");
};

test("worker help and refused command lines exit without loading the workflows package (#4768)", async () => {
	for (const args of [["--help"], ["help"], ["start", "-h"], []]) {
		const help = await run(args, unloadable);
		assert.equal(help.code, 0);
		assert.match(help.out[0] ?? "", /^Usage:\n {2}atomic worker start \[--db <url>\]/);
		assert.match(help.out[0] ?? "", /--slots <n> +Most children this host runs at once/);
	}
	const refusedRun = await run(["start", "--slots", "3 "], unloadable);
	assert.deepEqual(refusedRun, {
		code: 1,
		out: [],
		err: ["Invalid worker command: --slots. Pass a positive integer."],
	});
	const unknown = await run(["serve"], unloadable);
	assert.deepEqual(unknown.err, [
		'Invalid worker command: <command>. Use start or status. Use "atomic worker --help" for usage.',
	]);
	const broken = await run(["status"], unloadable);
	assert.deepEqual(broken, { code: 1, out: [], err: ["Error: the workflows package did not load"] });
});

test("worker status refuses every start-only option, and labels may hold '=' or nothing (#4768)", () => {
	for (const option of ["--label", "--host-id", "--idle-exit", "--slots"]) refused(["status", option, "x"], option);
	refused(["status", "--no-restore"], "--no-restore");
	refused(["start", "--no-such"], "--no-such");
	refused(["start", "--host-id", ""], "--host-id");
	const command = parseWorkerCommand(["start", "--label", "a=b", "--label", "empty="], { cwd: root, cpus: 2 });
	assert.deepEqual(command.kind === "start" && command.labels, { a: "b", empty: "" });
	assert.deepEqual(parseWorkerCommand(["status", "--db", "file:///tmp/p.db", "--prefix", "p_"], { cwd: root }), {
		kind: "status",
		database: { url: "file:///tmp/p.db", prefix: "p_" },
		json: false,
	});
});

const FLEET: WorkerFleet = {
	hosts: [
		{
			host: "n1",
			labels: { zone: "east", rack: "2" },
			workers: 2,
			maxWorkers: 4,
			roots: ["r1"],
			heartbeatAgoMs: 1_500,
		},
		{ host: "n2", labels: {}, workers: 0, maxWorkers: 1, roots: [], heartbeatAgoMs: 999.4 },
		{ host: "n3", labels: {}, workers: 0, maxWorkers: 1, roots: [], heartbeatAgoMs: -3 },
	],
	roots: [
		{
			root: "r1",
			ready: 3,
			leased: 2,
			completed: 10,
			failed: 1,
			hosts: [
				{ host: "n1", leased: 2 },
				{ host: "n2", leased: 0 },
			],
		},
		{ root: "r2", ready: 1, leased: 0, completed: 0, failed: 0, hosts: [{ host: "n2", leased: 0 }] },
	],
};

test("worker status lists each host and root's queue, as text or JSON, from the database it names (#4768)", async () => {
	const asked: unknown[] = [];
	const module = (fleet: object | Error) => async (): Promise<WorkerHostModule> => ({
		startWorkflowWorkerHost: () => assert.fail("status starts no host"),
		async readWorkflowWorkerFleet(options) {
			asked.push(options);
			if (fleet instanceof Error) throw fleet;
			return fleet as WorkerFleet;
		},
	});
	const text = await run(
		["status", "--db", "libsql://pool.example.turso.io", "--token-file", tokenFile],
		module(FLEET),
	);
	assert.equal(text.code, 0);
	assert.deepEqual(text.out, [
		"Hosts: 3",
		"  n1  workers 2/4  roots 1  reported 1.5 s ago  labels zone=east,rack=2",
		"  n2  workers 0/1  roots 0  reported 999 ms ago",
		"  n3  workers 0/1  roots 0  reported 0 ms ago",
		"Roots: 2",
		"  r1  ready 3  running 2  completed 10  failed 1  on n1(2)",
		"  r2  ready 1  running 0  completed 0  failed 0",
	]);
	assert.deepEqual(asked[0], {
		journal: {
			adapter: LIBSQL_ADAPTER_PACKAGE,
			options: { url: "libsql://pool.example.turso.io" },
			secrets: { authToken: { file: tokenFile } },
		},
		agentDir: join(root, "agent"),
	});
	const json = await run(["status", "--json"], module(FLEET));
	assert.deepEqual(JSON.parse(json.out.join("\n")), FLEET);
	assert.deepEqual(asked[1], { agentDir: join(root, "agent") }, "without --db, the journal this machine selects");
	const setup = Object.assign(new Error("incomplete"), {
		name: "SharedPoolSetupError",
		problems: [{ subject: "a shared journal", code: "shared-journal-required", hint: "Pass --db." }],
	});
	const failed = await run(["status"], module(setup));
	assert.deepEqual(failed, {
		code: 1,
		out: [],
		err: ["Worker host setup is incomplete:", "  - a shared journal (shared-journal-required): Pass --db."],
	});
	const other = await run(["status"], module(new Error("database is locked")));
	assert.deepEqual(other.err, ["database is locked"]);
});

test("worker start passes every host option on, and prints idle exit and JSON events with their time (#4768)", async () => {
	const fake = fakeModule();
	const host = await started(
		["start", "--host-id", "n9", "--no-restore", "--idle-exit", "500", "--label", "zone=east", "--json"],
		fake,
	);
	const options = fake.given[0]!;
	assert.equal(options.hostId, "n9");
	assert.equal(options.restore, false);
	assert.equal(options.idleExitMs, 500);
	assert.deepEqual(options.labels, { zone: "east" });
	fake.emit({ kind: "idle-exit", idleMs: 512 });
	fake.emit({
		kind: "degraded",
		failures: 2,
		retryInMs: 1_800,
		error: { name: "StorageUnavailableError", message: "a\n\nb" },
	});
	host.signals.emit("SIGTERM", "SIGTERM");
	assert.equal(await host.exit, 0);
	const events = host.out.map((line) => JSON.parse(line) as Record<string, unknown>);
	assert.deepEqual(
		events.map(({ time, ...rest }) => {
			assert.match(String(time), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
			return rest;
		}),
		[
			{ event: "ready", host: "n9", slots: defaultWorkerSlots(), journal: "selected", labels: "zone=east" },
			{ event: "idle-exit", idle_ms: 512 },
			{ event: "degraded", failures: 2, retry_in_ms: 1_800, error: "StorageUnavailableError: a\n\nb" },
			{ event: "draining", signal: "SIGTERM" },
			{ event: "drained", host: "n9" },
		],
	);
	const plain = fakeModule();
	const text = await started(["start", "--db", "libsql://pool.example.turso.io/db?x=1#frag", "--prefix", "p_"], plain);
	assert.equal(plain.given[0]?.restore, undefined, "restoring is the host's default");
	assert.equal(plain.given[0]?.hostId, undefined);
	assert.equal(plain.given[0]?.idleExitMs, undefined);
	plain.emit({ kind: "idle-exit", idleMs: 7 });
	plain.emit({ kind: "degraded", failures: 1, retryInMs: 9, error: { name: "E", message: "a \n\t b" } });
	text.signals.emit("SIGINT", "SIGINT");
	text.signals.emit("SIGINT", "SIGINT");
	text.signals.emit("SIGINT", "SIGINT");
	assert.equal(await text.exit, 2);
	assert.deepEqual(plain.calls, ["drain", "stop"], "a third signal changes nothing");
	assert.deepEqual(text.out, [
		`ready host=host-a slots=${defaultWorkerSlots()} journal=libsql://pool.example.turso.io/db prefix=p_`,
		"idle-exit idle_ms=7",
		"degraded failures=1 retry_in_ms=9 error=E: a b",
		"draining signal=SIGINT",
		"stopping signal=SIGINT",
		"stopped host=host-a",
	]);
});

test("worker start reports a setup failure that is not a shared pool's by its message, and a token warning as JSON (#4768)", async () => {
	chmodSync(tokenFile, 0o640);
	// Windows has no group or other permission bits to warn about.
	const warns = process.platform !== "win32";
	const warning = `The token file ${tokenFile} is readable by other users; restrict it with chmod 600.`;
	const failing = fakeModule({ setup: new Error("process containment is not available") });
	const failed = await run(
		["start", "--db", "file:///tmp/p.db", "--token-file", tokenFile],
		async () => failing.module,
	);
	assert.deepEqual(failed, {
		code: 1,
		out: [],
		err: [...(warns ? [`Warning: ${warning}`] : []), "process containment is not available"],
	});
	const json = await run(
		["start", "--json", "--db", "file:///tmp/p.db", "--token-file", tokenFile],
		async () => failing.module,
	);
	assert.deepEqual(
		json.err.map((line) => {
			const { time: _time, ...rest } = JSON.parse(line) as Record<string, unknown>;
			return rest;
		}),
		[
			...(warns ? [{ event: "warning", message: warning }] : []),
			{ event: "setup-failed", message: "process containment is not available" },
		],
	);
	const missing = await run(
		["start", "--db", "file:///tmp/p.db", "--token-file", join(root, "none")],
		async () => failing.module,
	);
	assert.deepEqual(
		missing.err,
		["process containment is not available"],
		"a missing token file is the host's to report",
	);
});

/** The real command loads the bundled workflows package through the extension host's module loader. */
const REAL_PACKAGE_TIMEOUT_MS = 120_000;

test(
	"worker status loads the bundled workflows package and reads a shared database, or lists what setup lacks (#4768)",
	async () => {
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		const db = pathToFileURL(join(root, "shared.db")).href;
		const out: string[] = [];
		const err: string[] = [];
		const options = {
			cwd: root,
			agentDir,
			log: (line: string) => out.push(line),
			error: (line: string) => err.push(line),
		};
		// Without the libSQL adapter installed, setup lists it.
		assert.equal(await runWorkerCommand(["status", "--db", db], options), 1);
		assert.equal(err[0], "Worker host setup is incomplete:");
		assert.match(
			err[1] ?? "",
			/^ {2}- the storage adapter @bastani\/atomic-storage-libsql, .*\(storage-adapter-unavailable\): Install it/,
		);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [libsqlPackage] }));
		err.length = 0;
		assert.equal(await runWorkerCommand(["status", "--db", db], options), 0, err.join("\n"));
		assert.deepEqual(out, ["Hosts: 0", "Roots: 0"]);
	},
	REAL_PACKAGE_TIMEOUT_MS,
);
