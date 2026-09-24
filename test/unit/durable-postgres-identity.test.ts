import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import {
	chmodSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:net";
import { dirname, join, sep } from "node:path";
import { Client } from "pg";
import { afterEach, test, vi } from "vitest";
import {
	embeddedDbosSystemDatabaseUrl,
	embeddedPostgresHealth,
	embeddedPostgresTestHooks as hooks,
	loadEmbeddedPostgresBinaries,
	resetEmbeddedDbosPostgresForTests,
	shutdownEmbeddedDbosPostgres,
} from "../../packages/workflows/src/durable/dbos-embedded-postgres.js";
import {
	fingerprintPreparedRuntime,
	prepareBinariesForOwner,
} from "../../packages/workflows/src/durable/dbos-embedded-postgres-root.js";
import {
	availablePostgresPort,
	managedPostgresLaunchExecutable,
	managedPostgresRuntimeHealthy,
	managedPostmaster,
	POSTGRES_IDENTITY_SQL,
	postgresRuntimeFilesExist,
	preferredPostgresPort,
	probePostgresIdentity,
	verifyManagedPostmasterProcess,
	verifyPostgresIdentity,
} from "../../packages/workflows/src/durable/dbos-postgres-identity.js";
import {
	managedPostgresMetadata,
	publishPostgresServer,
} from "../../packages/workflows/src/durable/dbos-postgres-ownership.js";
import {
	makeDirectorySync,
	makeTempDirectory,
	readTextSync,
	removeTempDirectory,
	writeTextSync,
} from "../helpers/runtime.js";

function unsealRuntimeDirectories(path: string): void {
	if (!existsSync(path)) return;
	chmodSync(path, 0o755);
	for (const entry of readdirSync(path)) {
		const child = join(path, entry);
		if (lstatSync(child).isDirectory()) unsealRuntimeDirectories(child);
	}
}
const roots: string[] = [];
const listeners: Server[] = [];
const postmasters: ChildProcess[] = [];
afterEach(async () => {
	resetEmbeddedDbosPostgresForTests();
	vi.restoreAllMocks();
	assert.equal(windowsShutdownSignal, undefined, "shutdown guard closed");
	vi.unstubAllEnvs();
	for (const child of postmasters.splice(0)) {
		child.kill();
		await once(child, "exit");
	}
	for (const listener of listeners.splice(0)) await new Promise<void>((resolve) => listener.close(() => resolve()));
	for (const root of roots.splice(0)) {
		unsealRuntimeDirectories(join(root, "pg-runtime"));
		removeTempDirectory(root);
	}
});
async function listener() {
	const server = createServer((socket) => {
		socket.on("error", () => {});
		socket.resume();
	});
	listeners.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	return { server, port: address.port };
}
function fixture() {
	const root = makeTempDirectory("atomic-pg-identity-");
	roots.push(root);
	const data = join(root, "v18");
	makeDirectorySync(join(data, "global"), { recursive: true, mode: 0o700 });
	writeTextSync(join(data, "PG_VERSION"), "18\n");
	writeTextSync(join(data, "global", "pg_control"), "AAAAAAAA");
	const metadata = managedPostgresMetadata(root, 18, true);
	const postgres = join(root, "runtime", "native", "bin", "postgres");
	mkdirSync(dirname(postgres), { recursive: true });
	mkdirSync(join(root, "runtime", "native", "share", "postgresql", "timezonesets"), { recursive: true });
	writeTextSync(join(root, "runtime", "native", "share", "postgresql", "timezonesets", "Default"), "timezone");
	writeTextSync(postgres, "fixture");
	const pidfile = (port: number, started = 1) => {
		writeTextSync(join(data, "postmaster.pid"), `${process.pid}\n${data}\n${started}\n${port}\n`);
		writeTextSync(
			join(data, "postmaster.opts"),
			`${postgres} "-D" "${data}" "-p" "${port}" "-c" "listen_addresses=127.0.0.1"\n`,
		);
	};
	const row = (port: number) => ({
		data_dir: data,
		host: "127.0.0.1",
		port,
		started: "1",
		system_identifier: "4702111234474983745",
	});
	const options = {
		context: {
			baseDir: root,
			runAsOwner: async () => {
				throw new Error("must not initialize existing data");
			},
		},
		binaries: { pg_ctl: postgres, initdb: postgres, postgres },
		prepared: true,
		probeIdentity: async (port: number) => row(port),
	};
	return { root, data, metadata, pidfile, row, options };
}

function externalPostmaster(f: ReturnType<typeof fixture>, port: number): void {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	postmasters.push(child);
	assert.ok(child.pid);
	const { postgresProcessStartTime } = createRequire(import.meta.url)("@bastani/atomic-natives") as {
		postgresProcessStartTime(pid: number): { found: boolean; startTime?: number };
	};
	const started = postgresProcessStartTime(child.pid).startTime;
	assert.ok(started);
	writeTextSync(join(f.data, "postmaster.pid"), `${child.pid}\n${f.data}\n${started}\n${port}\n`);
}
let windowsShutdownSignal: ((mode: "fast" | "immediate") => void) | undefined;
function emulateWindowsShutdown(signal: (mode: "fast" | "immediate") => void, exited: () => boolean): void {
	if (process.platform !== "win32") return;
	hooks.setWindowsPostgresGuard(() => {
		assert.equal(windowsShutdownSignal, undefined, "previous guard closed before acquisition");
		let signaled = false;
		windowsShutdownSignal = (mode) => {
			assert.equal(signaled, false);
			signaled = true;
			signal(mode);
		};
		return {
			status: "live",
			exited,
			close: () => {
				assert.ok(signaled, "pg_ctl kill ran while guard was held");
				windowsShutdownSignal = undefined;
			},
		};
	});
}
function emulateVerifiedShutdown(f: ReturnType<typeof fixture>, onSignal: () => void): void {
	const binding = createRequire(import.meta.url)("@bastani/atomic-natives") as {
		postgresProcessStartTime(pid: number): { found: boolean; startTime?: number };
		signalVerifiedPostgres(pid: number, expectedStartTime: number, mode: "fast" | "immediate"): string;
	};
	const original = binding.postgresProcessStartTime;
	let exited = false;
	vi.spyOn(binding, "postgresProcessStartTime").mockImplementation((pid) =>
		exited ? { found: false } : original(pid),
	);
	const signal = () => {
		onSignal();
		exited = true;
		rmSync(join(f.data, "postmaster.pid"));
		return "signaled";
	};
	vi.spyOn(binding, "signalVerifiedPostgres").mockImplementation(signal);
	emulateWindowsShutdown(signal, () => exited);
}
function assertWindowsShutdown(
	command: string,
	args: readonly string[],
	pgCtl: string,
	pid: number,
	mode: "INT" | "QUIT" = "INT",
): void {
	assert.equal(command, pgCtl);
	assert.deepEqual(args, ["kill", mode, String(pid)]);
	assert.ok(windowsShutdownSignal, "guard acquired before pg_ctl kill");
	windowsShutdownSignal(mode === "INT" ? "fast" : "immediate");
}
test("OS process identity accepts a live non-self postmaster and rejects PID reuse", async () => {
	const f = fixture();
	const port = await availablePostgresPort(0);
	f.pidfile(port);
	externalPostmaster(f, port);
	const server = managedPostmaster(f.metadata)!;
	publishPostgresServer(f.root, f.metadata, server);
	const current = managedPostgresMetadata(f.root, 18, false);
	assert.deepEqual(verifyManagedPostmasterProcess(current, server), {
		status: "live",
		server,
		observedCreateTime: server.started,
	});
	writeTextSync(join(f.data, "postmaster.pid"), `${server.pid}\n${f.data}\n${server.started + 10}\n${port}\n`);
	assert.throws(() => verifyManagedPostmasterProcess(current, server), /identity mismatch/);
});

test("OS creation before PostgreSQL pidfile publication remains the same live postmaster after a long startup", async () => {
	const f = fixture();
	const port = await availablePostgresPort(0);
	f.pidfile(port);
	externalPostmaster(f, port);
	const server = managedPostmaster(f.metadata)!;
	publishPostgresServer(f.root, f.metadata, server);
	const binding = createRequire(import.meta.url)("@bastani/atomic-natives") as {
		postgresProcessStartTime(pid: number): { found: boolean; startTime?: number };
	};
	vi.spyOn(binding, "postgresProcessStartTime").mockReturnValue({ found: true, startTime: server.started - 10 });
	assert.deepEqual(verifyManagedPostmasterProcess(managedPostgresMetadata(f.root, 18, false), server), {
		status: "live",
		server,
		observedCreateTime: server.started - 10,
	});
});

test("a postmaster that exits between process probes is confirmed absent without removing its pidfile", async () => {
	const f = fixture();
	const port = await availablePostgresPort(0);
	f.pidfile(port);
	externalPostmaster(f, port);
	const server = managedPostmaster(f.metadata)!;
	publishPostgresServer(f.root, f.metadata, server);
	const binding = createRequire(import.meta.url)("@bastani/atomic-natives") as {
		postgresProcessStartTime(pid: number): { found: boolean; startTime?: number };
	};
	vi.spyOn(binding, "postgresProcessStartTime").mockReturnValue({ found: false });
	assert.deepEqual(verifyManagedPostmasterProcess(managedPostgresMetadata(f.root, 18, false), server), {
		status: "absent",
	});
	assert.ok(existsSync(join(f.data, "postmaster.pid")));
});

test("an exited and reaped child is absent from native postmaster lookup", async () => {
	const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
	assert.ok(child.pid);
	await once(child, "exit");
	const binding = createRequire(import.meta.url)("@bastani/atomic-natives") as {
		postgresProcessStartTime(pid: number): { found: boolean; startTime?: number };
	};
	assert.deepEqual(binding.postgresProcessStartTime(child.pid), { found: false });
});

test.each([
	"pid reuse",
	"OS start mismatch",
	"parent process",
	"port mismatch",
	"data directory mismatch",
	"system identifier mismatch",
	"launch mismatch",
	"start time unavailable",
])("never stops a runtime-broken server with %s", async (fault) => {
	const f = fixture();
	const port = await availablePostgresPort(0);
	f.pidfile(port);
	if (fault === "parent process") {
		const binding = createRequire(import.meta.url)("@bastani/atomic-natives") as {
			postgresProcessStartTime(pid: number): { found: boolean; startTime?: number };
		};
		const started = binding.postgresProcessStartTime(process.ppid).startTime;
		assert.ok(started);
		writeTextSync(join(f.data, "postmaster.pid"), `${process.ppid}\n${f.data}\n${started}\n${port}\n`);
	} else externalPostmaster(f, port);
	if (fault === "pid reuse") {
		const recorded = managedPostmaster(f.metadata)!;
		writeTextSync(join(f.data, "postmaster.pid"), `${recorded.pid}\n${f.data}\n${recorded.started - 10}\n${port}\n`);
	}
	const server = managedPostmaster(f.metadata)!;
	publishPostgresServer(f.root, f.metadata, server);
	writeTextSync(
		join(f.data, "postmaster.opts"),
		`${join(f.root, "removed-worktree", "bin", "postgres")} "-D" "${f.data}" "-p" "${port}" "-c" "listen_addresses=127.0.0.1"\n`,
	);
	switch (fault) {
		case "parent process":
			break;
		case "OS start mismatch": {
			const binding = createRequire(import.meta.url)("@bastani/atomic-natives") as {
				postgresProcessStartTime(pid: number): { found: boolean; startTime?: number };
			};
			vi.spyOn(binding, "postgresProcessStartTime").mockReturnValue({ found: true, startTime: server.started + 2 });
			assert.throws(
				() => verifyManagedPostmasterProcess(managedPostgresMetadata(f.root, 18, false), server),
				/OS process start identity mismatch/,
			);
			break;
		}
		case "port mismatch":
			writeTextSync(
				join(f.data, "postmaster.pid"),
				`${server.pid}\n${f.data}\n${server.started}\n${port === 65535 ? port - 1 : port + 1}\n`,
			);
			break;
		case "data directory mismatch":
			writeTextSync(join(f.data, "postmaster.pid"), `${server.pid}\n${f.root}\n${server.started}\n${port}\n`);
			break;
		case "system identifier mismatch":
			writeTextSync(join(f.data, "global", "pg_control"), "BBBBBBBB");
			break;
		case "launch mismatch":
			writeTextSync(
				join(f.data, "postmaster.opts"),
				`${join(f.root, "removed-worktree", "bin", "postgres")} "-D" "${f.data}" "-p" "${port === 65535 ? port - 1 : port + 1}" "-c" "listen_addresses=127.0.0.1"\n`,
			);
			break;
		case "start time unavailable": {
			const binding = createRequire(import.meta.url)("@bastani/atomic-natives") as {
				postgresProcessStartTime(pid: number): { found: boolean; startTime?: number };
			};
			vi.spyOn(binding, "postgresProcessStartTime").mockReturnValue({ found: true });
			break;
		}
	}
	let stops = 0;
	await assert.rejects(
		hooks.ensureCluster({
			...f.options,
			recovery: { ...f.metadata, server },
			context: {
				baseDir: f.root,
				runAsOwner: async () => {
					stops++;
					throw new Error("unsafe stop");
				},
			},
		}),
	);
	assert.equal(stops, 0);
});
test.each(["darwin", "win32"] as const)(
	"%s OS identity changing after verification is rejected before any shutdown signal",
	async (platform) => {
		const f = fixture();
		const port = await availablePostgresPort(0);
		f.pidfile(port);
		externalPostmaster(f, port);
		const server = managedPostmaster(f.metadata)!;
		publishPostgresServer(f.root, f.metadata, server);
		writeTextSync(
			join(f.data, "postmaster.opts"),
			`${join(f.root, "gone", "bin", "postgres")} "-D" "${f.data}" "-p" "${port}" "-c" "listen_addresses=127.0.0.1"\n`,
		);
		const binding = createRequire(import.meta.url)("@bastani/atomic-natives") as {
			postgresProcessStartTime(pid: number): { found: boolean; startTime?: number };
			signalVerifiedPostgres(pid: number, expectedStartTime: number, mode: "fast" | "immediate"): string;
		};
		const observed = server.started - 10;
		vi.spyOn(binding, "postgresProcessStartTime").mockReturnValue({ found: true, startTime: observed });
		const signal = vi.spyOn(binding, "signalVerifiedPostgres").mockImplementation((_pid, expected) => {
			assert.equal(expected, observed);
			return "mismatch";
		});
		const guard = vi.fn((_pid: number, expected: number) => {
			assert.equal(expected, observed);
			return { status: "mismatch" as const, exited: () => false, close: vi.fn() };
		});
		hooks.setWindowsPostgresGuard(guard);
		let pgCtlCalls = 0;
		await assert.rejects(
			hooks.stopBrokenManagedPostmaster(
				f.metadata,
				server,
				f.options.binaries.pg_ctl,
				{
					baseDir: f.root,
					runAsOwner: async () => {
						pgCtlCalls++;
						throw new Error("unsafe pg_ctl");
					},
				},
				{ ownerToken: "fixture", refresh: () => true },
				undefined,
				platform,
			),
			/OS process start identity mismatch/,
		);
		assert.equal(signal.mock.calls.length, platform === "win32" ? 0 : 1);
		assert.equal(guard.mock.calls.length, platform === "win32" ? 1 : 0);
		assert.equal(pgCtlCalls, 0);
	},
);

test.each(["mismatch", "absent"] as const)("Windows %s guard never invokes pg_ctl kill", async (status) => {
	const f = fixture();
	const port = await availablePostgresPort(0);
	f.pidfile(port);
	externalPostmaster(f, port);
	const server = managedPostmaster(f.metadata)!;
	publishPostgresServer(f.root, f.metadata, server);
	writeTextSync(
		join(f.data, "postmaster.opts"),
		`${join(f.root, "gone", "postgres.exe")} "-D" "${f.data}" "-p" "${port}" "-c" "listen_addresses=127.0.0.1"\n`,
	);
	let closed = false;
	hooks.setWindowsPostgresGuard(() => ({
		status,
		exited: () => {
			throw new Error("must not wait");
		},
		close: () => {
			closed = true;
		},
	}));
	let kills = 0;
	await assert.rejects(
		hooks.stopBrokenManagedPostmaster(
			f.metadata,
			server,
			f.options.binaries.pg_ctl,
			{
				baseDir: f.root,
				runAsOwner: async () => {
					kills++;
					throw new Error("unsafe pg_ctl");
				},
			},
			{ ownerToken: "fixture", refresh: () => true },
			async () => {},
			"win32",
		),
		/OS process start identity mismatch|shutdown did not release/,
	);
	assert.equal(kills, 0);
	assert.equal(closed, true);
});

test("Windows shutdown waits for exit before closing its guard on the first attempt", async () => {
	const f = fixture();
	const port = await availablePostgresPort(0);
	f.pidfile(port);
	externalPostmaster(f, port);
	const server = managedPostmaster(f.metadata)!;
	publishPostgresServer(f.root, f.metadata, server);
	writeTextSync(
		join(f.data, "postmaster.opts"),
		`${join(f.root, "gone", "bin", "postgres.exe")} "-D" "${f.data}" "-p" "${port}" "-c" "listen_addresses=127.0.0.1"\n`,
	);
	const binding = createRequire(import.meta.url)("@bastani/atomic-natives") as {
		postgresProcessStartTime(pid: number): { found: boolean; startTime?: number };
	};
	const original = binding.postgresProcessStartTime;
	let released = false;
	vi.spyOn(binding, "postgresProcessStartTime").mockImplementation((pid) =>
		released ? { found: false } : original(pid),
	);
	let closed = false;
	let waitFinished = false;
	let kills = 0;
	hooks.setWindowsPostgresGuard(() => ({
		status: "live",
		exited: () => {
			if (closed) throw new Error("Postgres process guard is closed");
			return released;
		},
		close: () => {
			assert.equal(waitFinished, true, "guard must remain open until exit wait completes");
			closed = true;
		},
	}));
	const stopped = await hooks.stopBrokenManagedPostmaster(
		f.metadata,
		server,
		f.options.binaries.pg_ctl,
		{
			baseDir: f.root,
			runAsOwner: async (_command, args) => {
				kills++;
				assert.deepEqual(args, ["kill", "INT", String(server.pid)]);
				return { exitCode: 0, stdout: "", stderr: "" };
			},
		},
		{ ownerToken: "fixture", refresh: () => true },
		async () => {
			await new Promise<void>((resolve) => setTimeout(resolve, 10));
			released = true;
			waitFinished = true;
			rmSync(join(f.data, "postmaster.pid"));
		},
		"win32",
	);
	assert.equal(stopped, true);
	assert.equal(kills, 1);
	assert.equal(closed, true);
});

test("Windows shutdown keeps a fresh process guard across each pg_ctl kill and wait", async () => {
	const f = fixture();
	const port = await availablePostgresPort(0);
	f.pidfile(port);
	externalPostmaster(f, port);
	const server = managedPostmaster(f.metadata)!;
	publishPostgresServer(f.root, f.metadata, server);
	writeTextSync(
		join(f.data, "postmaster.opts"),
		`${join(f.root, "gone", "bin", "postgres.exe")} "-D" "${f.data}" "-p" "${port}" "-c" "listen_addresses=127.0.0.1"\n`,
	);
	const binding = createRequire(import.meta.url)("@bastani/atomic-natives") as {
		postgresProcessStartTime(pid: number): { found: boolean; startTime?: number };
	};
	const original = binding.postgresProcessStartTime;
	let released = false;
	vi.spyOn(binding, "postgresProcessStartTime").mockImplementation((pid) =>
		released ? { found: false } : original(pid),
	);
	const events: string[] = [];
	hooks.setWindowsPostgresGuard((pid, started) => {
		assert.equal(pid, server.pid);
		assert.equal(started, server.started);
		const generation = events.filter((event) => event.startsWith("open")).length + 1;
		events.push(`open${generation}`);
		return {
			status: "live",
			exited: () => {
				events.push(`wait${generation}`);
				return released;
			},
			close: () => events.push(`close${generation}`),
		};
	});
	const commands: Array<{ command: string; args: readonly string[] }> = [];
	await hooks.stopBrokenManagedPostmaster(
		f.metadata,
		server,
		f.options.binaries.pg_ctl,
		{
			baseDir: f.root,
			runAsOwner: async (command, args) => {
				commands.push({ command, args });
				events.push(`kill${commands.length}`);
				if (commands.length === 2) {
					released = true;
					rmSync(join(f.data, "postmaster.pid"));
				}
				return { exitCode: 0, stdout: "", stderr: "" };
			},
		},
		{ ownerToken: "fixture", refresh: () => true },
		async () => {},
		"win32",
	);
	assert.deepEqual(commands, [
		{ command: f.options.binaries.pg_ctl, args: ["kill", "INT", String(server.pid)] },
		{ command: f.options.binaries.pg_ctl, args: ["kill", "QUIT", String(server.pid)] },
	]);
	assert.equal(events[0], "open1");
	assert.equal(events[1], "kill1");
	assert.ok(events.indexOf("wait1") > events.indexOf("kill1"));
	assert.ok(events.indexOf("close1") > events.indexOf("wait1"));
	assert.ok(events.indexOf("open2") > events.indexOf("close1"));
	assert.ok(events.indexOf("kill2") > events.indexOf("open2"));
	assert.ok(events.indexOf("wait2") > events.indexOf("kill2"));
	assert.ok(events.indexOf("close2") > events.indexOf("wait2"));
});

test.each(["fast exit", "timeout with matching identity", "timeout with changed identity", "lease lost after timeout"])(
	"verified shutdown handles %s without signaling a replacement process",
	async (scenario) => {
		const f = fixture();
		const port = await availablePostgresPort(0);
		f.pidfile(port);
		externalPostmaster(f, port);
		const server = managedPostmaster(f.metadata)!;
		publishPostgresServer(f.root, f.metadata, server);
		writeTextSync(
			join(f.data, "postmaster.opts"),
			`${join(f.root, "removed-worktree", "bin", "postgres")} "-D" "${f.data}" "-p" "${port}" "-c" "listen_addresses=127.0.0.1"\n`,
		);
		const binding = createRequire(import.meta.url)("@bastani/atomic-natives") as {
			postgresProcessStartTime(pid: number): { found: boolean; startTime?: number };
			signalVerifiedPostgres(pid: number, expectedStartTime: number, mode: "fast" | "immediate"): string;
		};
		const originalStartTime = binding.postgresProcessStartTime;
		let released = false;
		let signals = 0;
		vi.spyOn(binding, "postgresProcessStartTime").mockImplementation((pid) =>
			released ? { found: false } : originalStartTime(pid),
		);
		const modes: string[] = [];
		const signal = (mode: "fast" | "immediate") => {
			modes.push(mode);
			signals++;
			if (mode === "immediate" || scenario === "fast exit") {
				released = true;
				rmSync(join(f.data, "postmaster.pid"));
			}
			return "signaled";
		};
		vi.spyOn(binding, "signalVerifiedPostgres").mockImplementation((_pid, _started, mode) => signal(mode));
		emulateWindowsShutdown(signal, () => released);
		hooks.setRetainedPostgresSpawner((options) => {
			f.pidfile(port);
			writeTextSync(
				join(f.data, "postmaster.opts"),
				`${options.executable} "-D" "${f.data}" "-p" "${port}" "-c" "listen_addresses=127.0.0.1"\n`,
			);
			return {
				pid: process.pid,
				wait: async () => {
					throw new Error("Timed out waiting for the retained Postgres process to exit");
				},
				interruptAndWait: async () => {
					throw new Error("must not signal published lease");
				},
				release() {},
			};
		});
		let ticks = 0;
		const recover = hooks.ensureCluster({
			...f.options,
			recovery: { ...f.metadata, server },
			shutdownWait: async () => {
				if (++ticks === 120) {
					if (scenario === "timeout with changed identity")
						vi.spyOn(binding, "postgresProcessStartTime").mockReturnValue({
							found: true,
							startTime: server.started + 2,
						});
					if (scenario === "lease lost after timeout")
						renameSync(join(f.root, "v18.setup-lock"), join(f.root, "v18.setup-lock.displaced"));
				}
			},
			context: {
				baseDir: f.root,
				runAsOwner: async (command, args) => {
					if (process.platform !== "win32") throw new Error("POSIX shutdown must not use pg_ctl");
					assertWindowsShutdown(
						command,
						args,
						f.options.binaries.pg_ctl,
						server.pid,
						signals === 0 ? "INT" : "QUIT",
					);
					return { exitCode: 0, stdout: "", stderr: "" };
				},
			},
		});
		if (scenario === "timeout with changed identity" || scenario === "lease lost after timeout") {
			await assert.rejects(recover);
			assert.deepEqual(modes, ["fast"]);
		} else {
			await recover;
			assert.deepEqual(modes, scenario === "fast exit" ? ["fast"] : ["fast", "immediate"]);
		}
		assert.equal(signals, modes.length);
	},
);

function incompleteSourceRuntime(root: string, platform: NodeJS.Platform = process.platform) {
	const runtime = join(root, "incomplete-source");
	mkdirSync(join(runtime, "bin"), { recursive: true });
	const suffix = platform === "win32" ? ".exe" : "";
	const binaries = {
		postgres: join(runtime, "bin", `postgres${suffix}`),
		pg_ctl: join(runtime, "bin", `pg_ctl${suffix}`),
		initdb: join(runtime, "bin", `initdb${suffix}`),
	};
	for (const binary of Object.values(binaries)) writeTextSync(binary, "fixture");
	return { runtime, binaries };
}

test.each(["linux", "win32"] as const)(
	"incomplete source fixture resolves without falling back on %s",
	async (platform) => {
		const f = fixture();
		const source = incompleteSourceRuntime(f.root, platform);
		const binaries = await loadEmbeddedPostgresBinaries({
			runtimeDirectory: source.runtime,
			host: { platform, arch: "x64", libc: "glibc" },
			readOnly: true,
		});
		assert.deepEqual(binaries, source.binaries);
		assert.equal(postgresRuntimeFilesExist(binaries.postgres), false);
	},
);

// #3074: a stopped registered cluster must not start displaced data, even at the same directory inode.
test("changed PostgreSQL system identity fails before any restart", async () => {
	const f = fixture();
	f.pidfile(12345);
	publishPostgresServer(f.root, f.metadata, managedPostmaster(f.metadata)!);
	rmSync(join(f.data, "postmaster.pid"));
	writeTextSync(join(f.data, "global", "pg_control"), "BBBBBBBB");
	let starts = 0;
	hooks.setRetainedPostgresSpawner(() => {
		starts++;
		throw new Error("unexpected start");
	});
	await assert.rejects(hooks.ensureCluster(f.options), /system identity/);
	assert.equal(starts, 0);
});

// #3074: all network fixtures own ephemeral loopback listeners; no existing service is touched.
test("occupied preferred port is persisted atomically and rediscovered after reload", async () => {
	const foreign = await listener();
	vi.stubEnv("ATOMIC_POSTGRES_PORT", String(foreign.port));
	const f = fixture();
	const path = join(f.root, "v18.shared", "cluster.json");
	const inode = statSync(path).ino;
	let starts = 0,
		signals = 0;
	hooks.setRetainedPostgresSpawner((options) => {
		starts++;
		const port = Number(options.args[options.args.indexOf("-p") + 1]);
		assert.notEqual(port, foreign.port);
		assert.equal(managedPostgresMetadata(f.root, 18, false).server, undefined);
		f.pidfile(port);
		return {
			pid: process.pid,
			wait: async () => {
				throw new Error("Timed out waiting for the retained Postgres process to exit");
			},
			interruptAndWait: async () => {
				signals++;
				return { exited: true, signaled: true };
			},
			release() {},
		};
	});
	vi.resetModules();
	const reloaded = await import("../../packages/workflows/src/durable/dbos-embedded-postgres.js");
	reloaded.embeddedPostgresTestHooks.setRetainedPostgresSpawner(() => {
		throw new Error("competing starter");
	});
	await Promise.all([hooks.ensureCluster(f.options), reloaded.embeddedPostgresTestHooks.ensureCluster(f.options)]);
	const published = managedPostgresMetadata(f.root, 18, false);
	assert.ok(published.server);
	assert.notEqual(statSync(path).ino, inode);
	assert.equal(new URL(embeddedDbosSystemDatabaseUrl()).port, String(published.server.port));
	assert.equal(published.clusterId, f.metadata.clusterId);
	await shutdownEmbeddedDbosPostgres();
	await reloaded.shutdownEmbeddedDbosPostgres();
	resetEmbeddedDbosPostgresForTests();
	vi.stubEnv("ATOMIC_POSTGRES_PORT", "1");
	// Independent module generations contend through the real setup lock and rediscover the same port.
	await Promise.all([hooks.ensureCluster(f.options), reloaded.embeddedPostgresTestHooks.ensureCluster(f.options)]);
	assert.equal(reloaded.embeddedDbosSystemDatabaseUrl(), embeddedDbosSystemDatabaseUrl());
	await reloaded.shutdownEmbeddedDbosPostgres();
	assert.equal(starts, 1);
	assert.equal(signals, 0);
	assert.equal(foreign.server.listening, true);
	assert.equal(readTextSync(join(f.data, "PG_VERSION"), "utf8"), "18\n");
});

test("bind races have three elected attempts and never adopt a competitor", async () => {
	const f = fixture();
	let starts = 0;
	hooks.setRetainedPostgresSpawner(() => {
		starts++;
		throw new Error("address already in use");
	});
	await assert.rejects(hooks.ensureCluster({ ...f.options, isReachable: async () => true }), /address already in use/);
	assert.equal(starts, 3);
	assert.equal(managedPostgresMetadata(f.root, 18, false).server, undefined);
});

test("an exited bind-race child is cleaned before a verified alternate start", async () => {
	const f = fixture();
	let starts = 0,
		signals = 0;
	hooks.setRetainedPostgresSpawner((options) => {
		const failed = ++starts === 1;
		f.pidfile(Number(options.args[options.args.indexOf("-p") + 1]));
		return {
			pid: process.pid,
			wait: async () => {
				if (failed) return { exited: true, signaled: false };
				throw new Error("Timed out waiting for the retained Postgres process to exit");
			},
			interruptAndWait: async () => {
				signals++;
				return { exited: true, signaled: false };
			},
			release() {},
		};
	});
	await hooks.ensureCluster({ ...f.options, isReachable: async () => true });
	await shutdownEmbeddedDbosPostgres();
	assert.equal(starts, 2);
	assert.equal(signals, 1, "only the exact failed child is cleaned, not the ready server");
	assert.ok(managedPostgresMetadata(f.root, 18, false).server);
});

test("SQL identity rejects foreign data, port, address, pidfile start time and system identifier with field diagnostics", async () => {
	const f = fixture();
	const port = await availablePostgresPort(0);
	f.pidfile(port);
	for (const change of [
		{ data_dir: f.root },
		{ port: port + 1 },
		{ host: "::1" },
		{ started: "2" },
		{ system_identifier: "2" },
	]) {
		await assert.rejects(
			verifyPostgresIdentity(f.metadata, port, process.pid, async () => ({ ...f.row(port), ...change })),
			(error: Error) => {
				assert.match(error.message, /identity mismatch/);
				assert.ok(error.message.includes(`sql.${Object.keys(change)[0]}: expected `), error.message);
				assert.match(error.message, /observed /);
				return true;
			},
		);
	}
	await assert.rejects(
		verifyPostgresIdentity(f.metadata, port, process.pid + 1, async () => f.row(port)),
		/process.pid: expected \d+, observed \d+/,
	);
	await assert.rejects(
		verifyPostgresIdentity(f.metadata, port, null, async () => f.row(port)),
		/process.pid: expected null, observed \d+/,
	);
	await assert.rejects(
		verifyPostgresIdentity(f.metadata, port, process.pid, async () => {
			f.pidfile(port, 2);
			return f.row(port);
		}),
		/process.after.started: expected 1, observed 2/,
	);
});

test("detects missing PostgreSQL support files after its source worktree is removed", () => {
	const f = fixture();
	const postgres = join(f.root, "worktree", "native", "bin", "postgres");
	mkdirSync(join(f.root, "worktree", "native", "share", "postgresql", "timezonesets"), { recursive: true });
	writeTextSync(join(f.root, "worktree", "native", "share", "postgresql", "timezonesets", "Default"), "timezone");
	mkdirSync(dirname(postgres), { recursive: true });
	writeTextSync(postgres, "binary");
	writeTextSync(
		join(f.data, "postmaster.opts"),
		`${postgres} "-D" "${f.data}" "-p" "5439" "-c" "listen_addresses=127.0.0.1"\n`,
	);
	assert.equal(managedPostgresRuntimeHealthy(f.metadata), true);
	rmSync(join(f.root, "worktree", "native", "share", "postgresql", "timezonesets", "Default"));
	assert.equal(managedPostgresRuntimeHealthy(f.metadata), false);
	writeTextSync(join(f.root, "worktree", "native", "share", "postgresql", "timezonesets", "Default"), "timezone");
	removeTempDirectory(join(f.root, "worktree"));
	assert.equal(managedPostgresRuntimeHealthy(f.metadata), false);
});

test("Windows PostgreSQL support files use share/timezonesets, with Default required", () => {
	const f = fixture();
	const native = join(f.root, "windows", "native");
	const postgres = join(native, "bin", "postgres.exe");
	const timezone = join(native, "share", "timezonesets", "Default");
	mkdirSync(dirname(postgres), { recursive: true });
	mkdirSync(dirname(timezone), { recursive: true });
	writeTextSync(postgres, "binary");
	writeTextSync(timezone, "timezone");
	assert.equal(postgresRuntimeFilesExist(postgres), true);
	writeTextSync(
		join(f.data, "postmaster.opts"),
		`${postgres} "-D" "${f.data}" "-p" "5439" "-c" "listen_addresses=127.0.0.1"\n`,
	);
	assert.equal(managedPostgresRuntimeHealthy(f.metadata), true);
	rmSync(timezone);
	assert.equal(postgresRuntimeFilesExist(postgres), false);
	assert.equal(managedPostgresRuntimeHealthy(f.metadata), false);
});

test("a verified launch identifies its runtime even when the executable was removed", () => {
	const f = fixture();
	f.pidfile(5439);
	const launch = managedPostgresLaunchExecutable(f.metadata);
	assert.equal(launch, join(f.root, "runtime", "native", "bin", "postgres"));
	rmSync(launch);
	assert.equal(managedPostgresLaunchExecutable(f.metadata), launch);
});

test("a fresh client reserves the deleted launch generation when replacing a verified server", async () => {
	const f = fixture();
	const port = await availablePostgresPort(0);
	f.pidfile(port);
	externalPostmaster(f, port);
	const old = managedPostmaster(f.metadata)!;
	publishPostgresServer(f.root, f.metadata, old);
	const initiallyStaged = await prepareBinariesForOwner(f.options.binaries, f.options.context);
	const launchGeneration = dirname(dirname(initiallyStaged.postgres));
	unsealRuntimeDirectories(launchGeneration);
	removeTempDirectory(launchGeneration);
	assert.equal(existsSync(launchGeneration), false);
	writeTextSync(
		join(f.data, "postmaster.opts"),
		`${join(launchGeneration, "bin", "postgres")} "-D" "${f.data}" "-p" "${port}" "-c" "listen_addresses=127.0.0.1"\n`,
	);
	const replacement = await prepareBinariesForOwner(f.options.binaries, f.options.context, undefined, {
		repairCorruptGeneration: true,
		publicationLease: { ownerToken: "fixture", refresh: () => true },
		reservedGeneration: launchGeneration,
	});
	let stops = 0;
	emulateVerifiedShutdown(f, () => {
		stops++;
	});
	let starts = 0;
	hooks.setRetainedPostgresSpawner((options) => {
		starts++;
		assert.ok(options.executable.startsWith(`${join(f.root, "pg-runtime")}${sep}`));
		assert.notEqual(dirname(dirname(options.executable)), launchGeneration);
		f.pidfile(port);
		writeTextSync(
			join(f.data, "postmaster.opts"),
			`${options.executable} "-D" "${f.data}" "-p" "${port}" "-c" "listen_addresses=127.0.0.1"\n`,
		);
		return {
			pid: process.pid,
			wait: async () => {
				throw new Error("Timed out waiting for the retained Postgres process to exit");
			},
			interruptAndWait: async () => {
				throw new Error("must not signal a published server through a lease");
			},
			release() {},
		};
	});
	await hooks.ensureCluster({
		...f.options,
		prepared: false,
		context: {
			baseDir: f.root,
			runAsOwner: async (command, args) => {
				assertWindowsShutdown(command, args, replacement.pg_ctl, old.pid);
				assert.equal(existsSync(join(f.data, "postmaster.pid")), false);
				return { exitCode: 0, stdout: "", stderr: "" };
			},
		},
	});
	assert.equal(stops, 1);
	assert.equal(starts, 1);
	assert.equal(existsSync(launchGeneration), false);
	assert.equal(readTextSync(join(f.data, "PG_VERSION"), "utf8"), "18\n");
	assert.equal(managedPostgresMetadata(f.root, 18, false).clusterId, f.metadata.clusterId);
});
test("restarts exactly once from verified replacement when damaged runtime prevents new SQL probes", async () => {
	const f = fixture();
	const port = await availablePostgresPort(0);
	f.pidfile(port);
	externalPostmaster(f, port);
	const old = managedPostmaster(f.metadata)!;
	publishPostgresServer(f.root, f.metadata, old);
	writeTextSync(
		join(f.data, "postmaster.opts"),
		`${join(f.root, "removed-worktree", "bin", "postgres")} "-D" "${f.data}" "-p" "${port}" "-c" "listen_addresses=127.0.0.1"\n`,
	);
	const native = join(f.root, "pg-runtime", "native-test");
	mkdirSync(join(native, "bin"), { recursive: true });
	mkdirSync(join(native, "share", "postgresql", "timezonesets"), { recursive: true });
	writeTextSync(join(native, "share", "postgresql", "timezonesets", "Default"), "timezone");
	const binaries = {
		pg_ctl: join(native, "bin", "pg_ctl"),
		initdb: join(native, "bin", "initdb"),
		postgres: join(native, "bin", "postgres"),
	};
	for (const binary of Object.values(binaries)) writeTextSync(binary, "binary");
	let stops = 0;
	emulateVerifiedShutdown(f, () => {
		stops++;
	});
	let starts = 0;
	hooks.setRetainedPostgresSpawner((options) => {
		starts++;
		assert.equal(options.executable, binaries.postgres);
		f.pidfile(port);
		writeTextSync(
			join(f.data, "postmaster.opts"),
			`${binaries.postgres} "-D" "${f.data}" "-p" "${port}" "-c" "listen_addresses=127.0.0.1"\n`,
		);
		return {
			pid: process.pid,
			wait: async () => {
				throw new Error("Timed out waiting for the retained Postgres process to exit");
			},
			interruptAndWait: async () => {
				throw new Error("must not signal a published server through a lease");
			},
			release() {},
		};
	});
	await hooks.ensureCluster({
		...f.options,
		binaries,
		prepared: true,
		probeIdentity: async (candidatePort) => {
			if (managedPostmaster(f.metadata)?.pid === old.pid) throw new Error("new SQL backends cannot start");
			return f.row(candidatePort);
		},
		recovery: { ...f.metadata, server: old },
		context: {
			baseDir: f.root,
			runAsOwner: async (command, args) => {
				assertWindowsShutdown(command, args, binaries.pg_ctl, old.pid);
				assert.equal(existsSync(join(f.data, "postmaster.pid")), false);
				return { exitCode: 0, stdout: "", stderr: "" };
			},
		},
	});
	assert.equal(stops, 1);
	assert.equal(starts, 1);
	assert.equal(readTextSync(join(f.data, "PG_VERSION"), "utf8"), "18\n");
	assert.equal(managedPostgresMetadata(f.root, 18, false).server?.systemIdentifier, old.systemIdentifier);
	assert.equal(managedPostgresMetadata(f.root, 18, false).clusterId, f.metadata.clusterId);
});

test("a displaced setup lease cannot stop a verified managed postmaster", async () => {
	const f = fixture();
	const port = await availablePostgresPort(0);
	f.pidfile(port);
	externalPostmaster(f, port);
	const old = managedPostmaster(f.metadata)!;
	publishPostgresServer(f.root, f.metadata, old);
	writeTextSync(
		join(f.data, "postmaster.opts"),
		`${join(f.root, "removed-runtime", "bin", "postgres")} "-D" "${f.data}" "-p" "${port}" "-c" "listen_addresses=127.0.0.1"\n`,
	);
	const binding = createRequire(import.meta.url)("@bastani/atomic-natives") as {
		postgresProcessStartTime(pid: number): { found: boolean; startTime?: number };
	};
	const originalStartTime = binding.postgresProcessStartTime;
	vi.spyOn(binding, "postgresProcessStartTime").mockImplementation((pid) => {
		renameSync(join(f.root, "v18.setup-lock"), join(f.root, "v18.setup-lock.displaced"));
		return originalStartTime(pid);
	});
	let stops = 0;
	await assert.rejects(
		hooks.ensureCluster({
			...f.options,
			recovery: { ...f.metadata, server: old },
			context: {
				baseDir: f.root,
				runAsOwner: async () => {
					stops++;
					throw new Error("unsafe stop");
				},
			},
		}),
		/Postgres setup lease lost before stopping/,
	);
	assert.equal(stops, 0);
	assert.equal(managedPostgresMetadata(f.root, 18, false).server?.pid, old.pid);
});

test("preserves a running server when the replacement runtime lacks support files", async () => {
	const f = fixture();
	const port = await availablePostgresPort(0);
	f.pidfile(port);
	const old = managedPostmaster(f.metadata)!;
	publishPostgresServer(f.root, f.metadata, old);
	writeTextSync(
		join(f.data, "postmaster.opts"),
		`${join(f.root, "missing", "postgres")} "-D" "${f.data}" "-p" "${port}" "-c" "listen_addresses=127.0.0.1"\n`,
	);
	rmSync(join(f.root, "runtime", "native", "share", "postgresql", "timezonesets", "Default"));
	let stops = 0;
	await assert.rejects(
		hooks.ensureCluster({
			...f.options,
			recovery: { ...f.metadata, server: old },
			binaries: f.options.binaries,
			context: {
				baseDir: f.root,
				runAsOwner: async () => {
					stops++;
					throw new Error("unsafe stop");
				},
			},
		}),
		/Replacement managed Postgres runtime is incomplete/,
	);
	assert.equal(stops, 0);
	assert.equal(managedPostgresMetadata(f.root, 18, false).server?.pid, old.pid);
});
test("corrupt cached replacement runtime preserves the running managed server", async () => {
	const f = fixture();
	const port = await availablePostgresPort(0);
	f.pidfile(port);
	const old = managedPostmaster(f.metadata)!;
	publishPostgresServer(f.root, f.metadata, old);
	writeTextSync(
		join(f.data, "postmaster.opts"),
		`${join(f.root, "removed-worktree", "bin", "postgres")} "-D" "${f.data}" "-p" "${port}" "-c" "listen_addresses=127.0.0.1"\n`,
	);
	const runtimeIdentity = await fingerprintPreparedRuntime(f.options.binaries);
	writeTextSync(join(f.root, "runtime", "native", "bin", "postgres"), "corrupt-but-present");
	vi.stubEnv("ATOMIC_POSTGRES_RUNTIME_DIR", incompleteSourceRuntime(f.root).runtime);
	let stops = 0;
	await assert.rejects(
		hooks.ensureCluster({
			...f.options,
			recovery: { ...f.metadata, server: old },
			runtimeIdentity,
			context: {
				baseDir: f.root,
				runAsOwner: async () => {
					stops++;
					throw new Error("unsafe stop");
				},
			},
		}),
		/Replacement managed Postgres source runtime is incomplete/,
	);
	assert.equal(stops, 0);
	assert.equal(managedPostgresMetadata(f.root, 18, false).server?.pid, old.pid);
});
test.each(["regular file", "cyclic support-file link"])(
	"repairs a pinned generation damaged by %s without changing the owned cluster",
	async (damage) => {
		const f = fixture();
		const source = join(f.root, "runtime", "native");
		for (const binary of ["pg_ctl", "initdb"]) writeTextSync(join(source, "bin", binary), "fixture");
		if (process.platform === "win32") {
			for (const binary of ["postgres", "pg_ctl", "initdb"])
				writeTextSync(join(source, "bin", `${binary}.exe`), "fixture");
			mkdirSync(join(source, "share", "timezonesets"), { recursive: true });
			writeTextSync(join(source, "share", "timezonesets", "Default"), "timezone");
		}
		const pinned = join(f.root, "pinned", "native");
		cpSync(source, pinned, { recursive: true });
		const pinnedBinaries = {
			postgres: join(pinned, "bin", "postgres"),
			pg_ctl: join(pinned, "bin", "pg_ctl"),
			initdb: join(pinned, "bin", "initdb"),
		};
		const runtimeIdentity = await fingerprintPreparedRuntime(pinnedBinaries);
		if (damage === "regular file") {
			rmSync(pinned, { recursive: true });
			writeTextSync(pinned, "damaged generation");
		} else {
			const timezoneFile = join(pinned, "share", "postgresql", "timezonesets", "Default");
			rmSync(timezoneFile);
			symlinkSync("Default", timezoneFile);
		}
		vi.stubEnv("ATOMIC_POSTGRES_RUNTIME_DIR", source);
		assert.equal(
			(await loadEmbeddedPostgresBinaries()).postgres,
			join(source, "bin", process.platform === "win32" ? "postgres.exe" : "postgres"),
		);
		const port = await availablePostgresPort(0);
		f.pidfile(port);
		externalPostmaster(f, port);
		const old = managedPostmaster(f.metadata)!;
		publishPostgresServer(f.root, f.metadata, old);
		writeTextSync(
			join(f.data, "postmaster.opts"),
			`${join(f.root, "removed-runtime", "bin", "postgres")} "-D" "${f.data}" "-p" "${port}" "-c" "listen_addresses=127.0.0.1"\n`,
		);
		let stops = 0;
		emulateVerifiedShutdown(f, () => {
			stops++;
		});
		let starts = 0;
		hooks.setRetainedPostgresSpawner((options) => {
			starts++;
			assert.ok(options.executable.startsWith(join(f.root, "pg-runtime")));
			f.pidfile(port);
			return {
				pid: process.pid,
				wait: async () => {
					throw new Error("Timed out waiting for the retained Postgres process to exit");
				},
				interruptAndWait: async () => {
					throw new Error("published lease must not be signaled");
				},
				release() {},
			};
		});
		await hooks.ensureCluster({
			...f.options,
			binaries: pinnedBinaries,
			runtimeIdentity,
			recovery: { ...f.metadata, server: old },
			context: {
				baseDir: f.root,
				runAsOwner: async (command, args) => {
					assert.ok(command.startsWith(join(f.root, "pg-runtime")));
					assertWindowsShutdown(command, args, command, old.pid);
					assert.equal(existsSync(join(f.data, "postmaster.pid")), false);
					return { exitCode: 0, stdout: "", stderr: "" };
				},
			},
		});
		assert.equal(stops, 1);
		assert.equal(starts, 1);
		if (damage === "regular file") assert.equal(readTextSync(pinned, "utf8"), "damaged generation");
		else
			assert.equal(lstatSync(join(pinned, "share", "postgresql", "timezonesets", "Default")).isSymbolicLink(), true);
		assert.equal(managedPostgresMetadata(f.root, 18, false).server?.systemIdentifier, old.systemIdentifier);
		assert.equal(readTextSync(join(f.data, "PG_VERSION"), "utf8"), "18\n");
	},
);

test("corrupt cached runtime cannot restart a stopped managed server", async () => {
	const f = fixture();
	const port = await availablePostgresPort(0);
	f.pidfile(port);
	const old = managedPostmaster(f.metadata)!;
	publishPostgresServer(f.root, f.metadata, old);
	const runtimeIdentity = await fingerprintPreparedRuntime(f.options.binaries);
	rmSync(join(f.data, "postmaster.pid"));
	writeTextSync(join(f.root, "runtime", "native", "bin", "postgres"), "corrupt-but-present");
	vi.stubEnv("ATOMIC_POSTGRES_RUNTIME_DIR", incompleteSourceRuntime(f.root).runtime);
	let starts = 0;
	hooks.setRetainedPostgresSpawner(() => {
		starts++;
		throw new Error("unsafe start");
	});
	await assert.rejects(
		hooks.ensureCluster({ ...f.options, recovery: { ...f.metadata, server: old }, runtimeIdentity }),
		/Replacement managed Postgres source runtime is incomplete/,
	);
	assert.equal(starts, 0);
	assert.equal(managedPostgresMetadata(f.root, 18, false).server?.pid, old.pid);
});

test("adopts and restarts a legacy Atomic server whose launch runtime disappeared", async () => {
	const f = fixture();
	const port = await availablePostgresPort(0);
	f.pidfile(port);
	externalPostmaster(f, port);
	const legacy = managedPostmaster(f.metadata)!;
	rmSync(join(f.root, "v18.shared"), { recursive: true });
	writeTextSync(
		join(f.data, "postmaster.opts"),
		`${join(f.root, "removed-worktree", "bin", "postgres")} "-D" "${f.data}" "-p" "${port}" "-c" "listen_addresses=127.0.0.1"\n`,
	);
	let stops = 0;
	emulateVerifiedShutdown(f, () => {
		stops++;
	});
	let starts = 0;
	hooks.setRetainedPostgresSpawner((options) => {
		starts++;
		assert.equal(options.executable, f.options.binaries.postgres);
		f.pidfile(port);
		return {
			pid: process.pid,
			wait: async () => {
				throw new Error("Timed out waiting for the retained Postgres process to exit");
			},
			interruptAndWait: async () => {
				throw new Error("no published lease signal");
			},
			release() {},
		};
	});
	await hooks.ensureCluster({
		...f.options,
		context: {
			baseDir: f.root,
			runAsOwner: async (command, args) => {
				assertWindowsShutdown(command, args, f.options.binaries.pg_ctl, legacy.pid);
				assert.ok(managedPostgresMetadata(f.root, 18, false).server, "legacy server published before stop");
				assert.equal(existsSync(join(f.data, "postmaster.pid")), false);
				return { exitCode: 0, stdout: "", stderr: "" };
			},
		},
	});
	assert.equal(stops, 1);
	assert.equal(starts, 1);
	assert.equal(readTextSync(join(f.data, "PG_VERSION"), "utf8"), "18\n");
	assert.ok(managedPostgresMetadata(f.root, 18, false).server);
});

test("does not attach a server whose SQL identity differs", async () => {
	const f = fixture();
	const port = await availablePostgresPort(0);
	f.pidfile(port);
	externalPostmaster(f, port);
	const old = managedPostmaster(f.metadata)!;
	publishPostgresServer(f.root, f.metadata, old);
	let stops = 0;
	await assert.rejects(
		hooks.ensureCluster({
			...f.options,
			recovery: { ...f.metadata, server: old },
			probeIdentity: async () => ({ ...f.row(port), system_identifier: "2" }),
			context: {
				baseDir: f.root,
				runAsOwner: async () => {
					stops++;
					throw new Error("unsafe stop");
				},
			},
		}),
		/identity mismatch/,
	);
	assert.equal(stops, 0);
	assert.equal(managedPostgresMetadata(f.root, 18, false).server?.pid, old.pid);
});

test("a non-PostgreSQL listener cannot satisfy the bounded SQL probe", async () => {
	const foreign = await listener();
	const started = performance.now();
	assert.equal(await probePostgresIdentity(foreign.port), undefined);
	assert.ok(performance.now() - started < 5000, "the 1-second connection budget must bound a silent listener");
	assert.equal(foreign.server.listening, true);
});

test("unregistered existing data is never adopted or initialized", async () => {
	const f = fixture();
	removeTempDirectory(join(f.root, "v18.shared"));
	await assert.rejects(hooks.ensureCluster(f.options), /Refusing to adopt unregistered/);
	assert.equal(readTextSync(join(f.data, "PG_VERSION"), "utf8"), "18\n");
});

function legacyCluster(f: ReturnType<typeof fixture>, opts: string) {
	removeTempDirectory(join(f.root, "v18.shared"));
	writeTextSync(join(f.data, "postmaster.opts"), opts);
}
const legacyLaunch = (data: string, port = 5439) =>
	`/opt/atomic natives/postgres-runtime/bin/postgres "-D" "${data}" "-p" "${port}" "-c" "listen_addresses=127.0.0.1"\n`;

test("adopts a legacy Atomic-provisioned cluster without reinitializing (#3235)", async () => {
	const f = fixture();
	legacyCluster(f, legacyLaunch(f.data));
	const port = await availablePostgresPort(0);
	f.pidfile(port);
	let starts = 0;
	hooks.setRetainedPostgresSpawner(() => {
		starts++;
		throw new Error("unexpected start");
	});
	await hooks.ensureCluster(f.options);
	assert.equal(starts, 0);
	assert.equal(readTextSync(join(f.data, "PG_VERSION"), "utf8"), "18\n");
	const adopted = managedPostgresMetadata(f.root, 18, false);
	assert.equal(statSync(adopted.dataDir).ino, statSync(f.data).ino);
	assert.equal(adopted.directoryIdentity, f.metadata.directoryIdentity);
	assert.ok(statSync(join(f.root, "v18.shared", "cluster.json")).isFile());
});

const GENUINE_OLD_ATOMIC_POSTMASTER_OPTS =
	'/Users/norinlavaee/.bun/install/global/node_modules/@bastani/atomic-natives-darwin-arm64/postgres-runtime/bin/postgres "-D" "/Users/norinlavaee/.atomic/postgres/v18" "-p" "5439" "-c" "listen_addresses=127.0.0.1"\n';

test("adopts a cluster whose postmaster.opts is verbatim old-Atomic output (#3235)", async () => {
	const f = fixture();
	legacyCluster(
		f,
		GENUINE_OLD_ATOMIC_POSTMASTER_OPTS.replace('"/Users/norinlavaee/.atomic/postgres/v18"', `"${f.data}"`),
	);
	const port = await availablePostgresPort(0);
	f.pidfile(port);
	let starts = 0;
	hooks.setRetainedPostgresSpawner(() => {
		starts++;
		throw new Error("unexpected start");
	});
	await hooks.ensureCluster(f.options);
	assert.equal(starts, 0);
	assert.equal(readTextSync(join(f.data, "PG_VERSION"), "utf8"), "18\n");
	assert.ok(statSync(join(f.root, "v18.shared", "cluster.json")).isFile());
});

test("failed legacy adoption removes its ownership records so the next startup re-checks (#3235)", async () => {
	const f = fixture();
	legacyCluster(f, legacyLaunch(f.data));
	const port = await availablePostgresPort(0);
	f.pidfile(port);
	let starts = 0,
		signals = 0;
	hooks.setRetainedPostgresSpawner((options) => {
		starts++;
		f.pidfile(Number(options.args[options.args.indexOf("-p") + 1]));
		return {
			pid: process.pid,
			wait: async () => {
				throw new Error("Timed out waiting for the retained Postgres process to exit");
			},
			interruptAndWait: async () => {
				signals++;
				return { exited: true, signaled: true };
			},
			release() {},
		};
	});
	const unregistered = () => assert.throws(() => statSync(join(f.root, "v18.shared")), { code: "ENOENT" });
	await assert.rejects(
		hooks.ensureCluster({
			...f.options,
			probeIdentity: async () => {
				throw new Error("identity probe refused");
			},
		}),
		/identity probe refused/,
	);
	unregistered();
	rmSync(join(f.data, "postmaster.pid"));
	await assert.rejects(
		hooks.ensureCluster({
			...f.options,
			probeIdentity: async (selected) => ({ ...f.row(selected), system_identifier: "2" }),
		}),
		/identity mismatch/,
	);
	assert.equal(starts, 1);
	assert.equal(signals, 1, "the unverified started child is rolled back before its records are removed");
	unregistered();
	assert.equal(readTextSync(join(f.data, "PG_VERSION"), "utf8"), "18\n");
	f.pidfile(port);
	await hooks.ensureCluster(f.options);
	assert.equal(starts, 1);
	assert.equal(managedPostgresMetadata(f.root, 18, false).server?.port, port);
});

test("unregistered data without Atomic's recorded loopback launch stays refused (#3235)", async () => {
	for (const opts of [
		undefined,
		legacyLaunch(join("/elsewhere", "v18")),
		legacyLaunch("v18"),
		`/opt/atomic/bin/postgres "-D" "DATA" "-p" "5439" "-c" "listen_addresses=*"\n`,
		`/opt/atomic/bin/postgres "-D" "DATA" "-p" "5439"\n`,
	]) {
		const f = fixture();
		legacyCluster(f, opts === undefined ? "" : opts.replace("DATA", f.data));
		if (opts === undefined) rmSync(join(f.data, "postmaster.opts"));
		await assert.rejects(hooks.ensureCluster(f.options), /Refusing to adopt unregistered/);
		assert.equal(readTextSync(join(f.data, "PG_VERSION"), "utf8"), "18\n");
	}
});

test("a different PostgreSQL major is never adopted as a legacy cluster (#3235)", async () => {
	const f = fixture();
	legacyCluster(f, legacyLaunch(f.data));
	writeTextSync(join(f.data, "PG_VERSION"), "17\n");
	await assert.rejects(hooks.ensureCluster(f.options), /Refusing to adopt unregistered/);
	assert.equal(readTextSync(join(f.data, "PG_VERSION"), "utf8"), "17\n");
});

test("recovery never adopts a legacy cluster that lost its ownership records (#3235)", async () => {
	const f = fixture();
	legacyCluster(f, legacyLaunch(f.data));
	await assert.rejects(hooks.ensureCluster({ ...f.options, recovery: f.metadata }), /Refusing to adopt unregistered/);
	assert.equal(readTextSync(join(f.data, "PG_VERSION"), "utf8"), "18\n");
});

test("unreadable or malformed legacy launch evidence is never adopted (#3235)", async () => {
	const dir = fixture();
	legacyCluster(dir, legacyLaunch(dir.data));
	rmSync(join(dir.data, "PG_VERSION"));
	mkdirSync(join(dir.data, "PG_VERSION"));
	await assert.rejects(hooks.ensureCluster(dir.options), /Refusing to adopt unregistered/);
	assert.ok(statSync(join(dir.data, "PG_VERSION")).isDirectory());
	assert.throws(() => statSync(join(dir.root, "v18.shared")), { code: "ENOENT" });
	if (process.platform === "win32" || process.getuid?.() === 0) return;
	const f = fixture();
	legacyCluster(f, legacyLaunch(f.data));
	chmodSync(join(f.data, "postmaster.opts"), 0o000);
	try {
		await assert.rejects(hooks.ensureCluster(f.options), /Refusing to adopt unregistered/);
		assert.equal(readTextSync(join(f.data, "PG_VERSION"), "utf8"), "18\n");
		assert.throws(() => statSync(join(f.root, "v18.shared")), { code: "ENOENT" });
	} finally {
		chmodSync(join(f.data, "postmaster.opts"), 0o600);
	}
});

test("preferred port validation rejects ambiguous or out-of-range values", () => {
	for (const value of ["", "0", "65536", "1.5", "-1", " 5439", "abc"])
		assert.throws(() => preferredPostgresPort(value), /ATOMIC_POSTGRES_PORT/);
	assert.equal(preferredPostgresPort("15439"), 15439);
});

// #3074: independent module owners contend through the filesystem recovery lock.
test("live consumers elect one recovery starter and retain cluster identity", async () => {
	const f = fixture();
	f.pidfile(await availablePostgresPort(0));
	await hooks.ensureCluster(f.options);
	vi.resetModules();
	const peer = await import("../../packages/workflows/src/durable/dbos-embedded-postgres.js");
	await peer.embeddedPostgresTestHooks.ensureCluster(f.options);
	const localHealth = embeddedPostgresHealth()!;
	const peerHealth = peer.embeddedPostgresHealth()!;
	await Promise.all([localHealth.check(), peerHealth.check()]);
	let starts = 0,
		signals = 0;
	const spawn = (options: import("@bastani/atomic-natives").RetainedPostgresSpawnOptions) => {
		starts++;
		f.pidfile(Number(options.args[options.args.indexOf("-p") + 1]));
		return {
			pid: process.pid,
			wait: async () => {
				throw new Error("Timed out waiting for the retained Postgres process to exit");
			},
			interruptAndWait: async () => {
				signals++;
				return { exited: true, signaled: true };
			},
			release() {},
		};
	};
	hooks.setRetainedPostgresSpawner(spawn);
	peer.embeddedPostgresTestHooks.setRetainedPostgresSpawner(spawn);
	rmSync(join(f.data, "postmaster.pid"));
	try {
		const urls = await Promise.all([localHealth.check(), peerHealth.check()]);
		assert.equal(urls[0], urls[1]);
		assert.equal(starts, 1);
		assert.equal(signals, 0);
		assert.equal(managedPostgresMetadata(f.root, 18, false).clusterId, f.metadata.clusterId);
		assert.equal(readTextSync(join(f.data, "PG_VERSION"), "utf8"), "18\n");
	} finally {
		await peer.shutdownEmbeddedDbosPostgres();
	}
});

// #3074: shutdown during recovery must not strand the elected starter on a dead PID.
test("recovery starts once when the captured postmaster shuts down during its identity probe", async () => {
	const f = fixture();
	const port = await availablePostgresPort(0);
	f.pidfile(port);
	await hooks.ensureCluster(f.options);
	const before = managedPostgresMetadata(f.root, 18, false);
	let starts = 0;
	let signals = 0;
	hooks.setRetainedPostgresSpawner((options) => {
		starts++;
		f.pidfile(Number(options.args[options.args.indexOf("-p") + 1]));
		return {
			pid: process.pid,
			wait: async () => {
				throw new Error("Timed out waiting for the retained Postgres process to exit");
			},
			interruptAndWait: async () => {
				signals++;
				return { exited: true, signaled: true };
			},
			release() {},
		};
	});
	let shuttingDown = true;
	await hooks.ensureCluster({
		...f.options,
		recovery: before,
		probeIdentity: async (selectedPort) => {
			if (shuttingDown) {
				shuttingDown = false;
				rmSync(join(f.data, "postmaster.pid"));
				return undefined;
			}
			return f.row(selectedPort);
		},
	});
	assert.equal(starts, 1);
	assert.equal(signals, 0, "a published postmaster is never signaled by recovery");
	const after = managedPostgresMetadata(f.root, 18, false);
	assert.equal(after.clusterId, before.clusterId);
	assert.equal(after.directoryIdentity, before.directoryIdentity);
	assert.equal(after.server?.systemIdentifier, before.server?.systemIdentifier);
	assert.equal(after.server?.port, port);
});

// #3074: a failed SQL probe alone never authorizes a second server or a signal.
test("an unavailable but present postmaster stays on the attach path", async () => {
	const f = fixture();
	f.pidfile(await availablePostgresPort(0));
	await hooks.ensureCluster(f.options);
	let probes = 0;
	let starts = 0;
	hooks.setRetainedPostgresSpawner(() => {
		starts++;
		throw new Error("must not start beside a live postmaster");
	});
	await assert.rejects(
		hooks.ensureCluster({
			...f.options,
			probeIdentity: async () => {
				if (++probes === 1) return undefined;
				throw new Error("identity probe refused");
			},
		}),
		/identity probe refused/,
	);
	assert.equal(probes, 2);
	assert.equal(starts, 0);
});

test.each(["removed pidfile", "dead PID pidfile", "cold attach dead PID"])(
	"recovers damaged runtime with %s without stopping a server",
	async (condition) => {
		const f = fixture();
		const port = await availablePostgresPort(0);
		f.pidfile(port);
		const initial = managedPostmaster(f.metadata)!;
		publishPostgresServer(f.root, f.metadata, initial);
		let stops = 0;
		await hooks.ensureCluster({
			...f.options,
			context: {
				baseDir: f.root,
				runAsOwner: async () => {
					stops++;
					throw new Error("must not stop absent postmaster");
				},
			},
		});
		const health = embeddedPostgresHealth()!;
		externalPostmaster(f, port);
		const old = managedPostmaster(f.metadata)!;
		publishPostgresServer(f.root, f.metadata, old);
		writeTextSync(
			join(f.data, "postmaster.opts"),
			`${join(f.root, "missing", "bin", "postgres")} "-D" "${f.data}" "-p" "${port}" "-c" "listen_addresses=127.0.0.1"\n`,
		);
		if (condition === "removed pidfile") rmSync(join(f.data, "postmaster.pid"));
		else {
			const child = postmasters.pop()!;
			child.kill();
			await once(child, "exit");
		}
		if (condition === "cold attach dead PID") resetEmbeddedDbosPostgresForTests();
		let starts = 0;
		hooks.setRetainedPostgresSpawner((options) => {
			starts++;
			f.pidfile(Number(options.args[options.args.indexOf("-p") + 1]));
			writeTextSync(
				join(f.data, "postmaster.opts"),
				`${options.executable} "-D" "${f.data}" "-p" "${port}" "-c" "listen_addresses=127.0.0.1"\n`,
			);
			return {
				pid: process.pid,
				wait: async () => {
					throw new Error("Timed out waiting for the retained Postgres process to exit");
				},
				interruptAndWait: async () => {
					throw new Error("must not signal published server");
				},
				release() {},
			};
		});
		if (condition === "cold attach dead PID") {
			await hooks.ensureCluster({
				...f.options,
				recovery: { ...f.metadata, server: old },
				context: {
					baseDir: f.root,
					runAsOwner: async () => {
						stops++;
						throw new Error("must not stop absent postmaster");
					},
				},
			});
		} else await health.check();
		assert.equal(stops, 0);
		assert.equal(starts, 1);
		assert.equal(managedPostgresMetadata(f.root, 18, false).server?.systemIdentifier, old.systemIdentifier);
	},
);

test("health recovers a damaged runtime before attempting a new SQL connection", async () => {
	const f = fixture();
	const port = await availablePostgresPort(0);
	f.pidfile(port);
	let stops = 0;
	let starts = 0;
	let probes = 0;
	const probeIdentity = async (candidatePort: number) => {
		probes++;
		if (stops === 0 && probes > 1) throw new Error("new SQL backends cannot start");
		return f.row(candidatePort);
	};
	await hooks.ensureCluster({
		...f.options,
		probeIdentity,
		context: {
			baseDir: f.root,
			runAsOwner: async (command, args) => {
				assertWindowsShutdown(command, args, f.options.binaries.pg_ctl, old.pid);
				assert.equal(existsSync(join(f.data, "postmaster.pid")), false);
				return { exitCode: 0, stdout: "", stderr: "" };
			},
		},
	});
	const health = embeddedPostgresHealth()!;
	externalPostmaster(f, port);
	const old = managedPostmaster(f.metadata)!;
	publishPostgresServer(f.root, f.metadata, old);
	writeTextSync(
		join(f.data, "postmaster.opts"),
		`${join(f.root, "removed-worktree", "bin", "postgres")} "-D" "${f.data}" "-p" "${port}" "-c" "listen_addresses=127.0.0.1"\n`,
	);
	emulateVerifiedShutdown(f, () => {
		stops++;
	});
	hooks.setRetainedPostgresSpawner((options) => {
		starts++;
		f.pidfile(Number(options.args[options.args.indexOf("-p") + 1]));
		writeTextSync(
			join(f.data, "postmaster.opts"),
			`${options.executable} "-D" "${f.data}" "-p" "${port}" "-c" "listen_addresses=127.0.0.1"\n`,
		);
		return {
			pid: process.pid,
			wait: async () => {
				throw new Error("Timed out waiting for the retained Postgres process to exit");
			},
			interruptAndWait: async () => {
				throw new Error("published server must not be signaled by lease");
			},
			release() {},
		};
	});
	await health.check();
	assert.equal(stops, 1);
	assert.equal(starts, 1);
	assert.equal(managedPostgresMetadata(f.root, 18, false).server?.systemIdentifier, old.systemIdentifier);
});

test("live health refuses replaced ownership and never initializes missing data", async () => {
	const f = fixture();
	f.pidfile(await availablePostgresPort(0));
	await hooks.ensureCluster(f.options);
	const health = embeddedPostgresHealth()!;
	await health.check();
	let starts = 0;
	hooks.setRetainedPostgresSpawner(() => {
		starts++;
		throw new Error("must not start");
	});
	rmSync(join(f.data, "postmaster.pid"));
	rmSync(join(f.data, "PG_VERSION"));
	await assert.rejects(health.check(), /ENOENT/);
	assert.equal(starts, 0);
	assert.equal(readTextSync(join(f.root, "v18.shared", "cluster.json"), "utf8").includes(f.metadata.clusterId), true);
});

test("recovery revalidates its pinned cluster after waiting for the cross-process lock", async () => {
	const f = fixture();
	f.pidfile(await availablePostgresPort(0));
	await hooks.ensureCluster(f.options);
	const health = embeddedPostgresHealth()!;
	await health.check();
	let release!: () => void;
	let entered!: () => void;
	const locked = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const holder = hooks.withSetupLock(join(f.root, "v18.setup-lock"), async () => {
		entered();
		await new Promise<void>((resolve) => {
			release = resolve;
		});
	});
	await locked;
	let starts = 0;
	hooks.setRetainedPostgresSpawner(() => {
		starts++;
		throw new Error("must not start displaced cluster");
	});
	rmSync(join(f.data, "postmaster.pid"));
	const pending = assert.rejects(health.check(), /unavailable after bounded recovery/);
	await new Promise<void>((resolve) => setImmediate(resolve));
	const changed = { ...managedPostgresMetadata(f.root, 18, false), clusterId: crypto.randomUUID() };
	writeTextSync(join(f.root, "v18.shared", "cluster.json"), JSON.stringify(changed));
	release();
	await Promise.all([holder, pending]);
	assert.match(health.lastFailure?.message ?? "", /recovery identity changed/);
	assert.equal(starts, 0);
	assert.equal(managedPostgresMetadata(f.root, 18, false).clusterId, changed.clusterId);
});

// #3074: a prior healthy probe must not authorize a different socket on the same port.
test("borrowed connections prove their own SQL identity before caller queries", async () => {
	const f = fixture();
	const port = await availablePostgresPort(0);
	f.pidfile(port);
	await hooks.ensureCluster(f.options);
	const health = embeddedPostgresHealth()!;
	await health.check();
	const client = Object.assign(new Client(), { release() {} });
	const query = vi
		.spyOn(client, "query")
		.mockImplementation(async () => ({ rows: [{ ...f.row(port), system_identifier: "foreign" }] }));
	let invalidations = 0;
	health.subscribe(() => invalidations++);
	await assert.rejects(health.validate(client), /identity mismatch/);
	assert.equal(invalidations, 1);
	assert.equal(query.mock.calls.length, 1);
	assert.deepEqual(query.mock.calls[0], [{ text: POSTGRES_IDENTITY_SQL, query_timeout: 1000 }]);
});
