import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import {
	defaultWorkerSlots,
	parseWorkerCommand,
	runWorkerCommand,
	WorkerCommandError,
	type WorkerHostEvent,
	type WorkerHostModule,
	type WorkerHostOptions,
} from "../../packages/coding-agent/src/cli/worker-command.js";
import { LIBSQL_ADAPTER_PACKAGE } from "../../packages/coding-agent/src/core/storage/selection.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const TOKEN = "tok-secret-4768-do-not-print";
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
