import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { connect } from "node:net";
import { test } from "vitest";
import {
	parseWorkerCommand,
	runWorkerCommand,
	WorkerCommandError,
	type WorkerFleet,
	type WorkerHostModule,
} from "../../packages/coding-agent/src/cli/worker-command.js";
import {
	prometheusText,
	READ_INTERVAL_MS,
	serveWorkerMetrics,
	type WorkerFleetScaling,
} from "../../packages/coding-agent/src/cli/worker-metrics.js";
import type { SharedPoolHost } from "../../packages/workflows/src/durable/journal/shared-pool-types.js";
import { fleetScaling } from "../../packages/workflows/src/workers/fleet-scaling.js";
import { isWorkerPlacementConfigError } from "../../packages/workflows/src/workers/placement-errors.js";

function host(state: SharedPoolHost["state"], maxWorkers: number, busy?: number): SharedPoolHost {
	return {
		host: `h-${state}-${maxWorkers}`,
		labels: {},
		git: "system",
		restore: true,
		workers: maxWorkers,
		maxWorkers,
		roots: [],
		...(busy === undefined ? {} : { busy }),
		heartbeatAgoMs: 0,
		state,
	};
}

test("the scaling signal follows the policy's target, and counts live slots (#4768)", () => {
	const roots = [
		{ ready: 9, leased: 3, blocked: false },
		{ ready: 50, leased: 1, sessionLimit: 4, blocked: false },
		{ ready: 7, leased: 2, blocked: true },
	];
	const hosts = [host("busy", 4, 3), host("idle", 4, 0), host("draining", 2, 1), host("stale", 8, 8), host("live", 3)];
	assert.deepEqual(fleetScaling(roots, hosts, { workersPerHost: 4, maxHosts: 20 }), {
		// 12 + min(51, 4) + 2 leased of the blocked root = 18 children: ceil(18 / 4) = 5 hosts.
		desiredHosts: 5,
		desiredWorkers: 20,
		demand: 18,
		queueDepth: 59,
		running: 6,
		hosts: 4,
		busySlots: 4,
		idleSlots: 4 - 3 + 4 + 3,
		minHosts: 0,
		maxHosts: 20,
		workersPerHost: 4,
	});
	assert.equal(fleetScaling(roots, hosts, { workersPerHost: 4, maxHosts: 3 }).desiredHosts, 3);
	assert.equal(fleetScaling([], [], { minHosts: 2 }).desiredHosts, 2);
	assert.deepEqual(fleetScaling([], [host("busy", 2, 5)]), {
		desiredHosts: 0,
		desiredWorkers: 0,
		demand: 0,
		queueDepth: 0,
		running: 0,
		hosts: 1,
		busySlots: 2,
		idleSlots: 0,
		minHosts: 0,
		maxHosts: 10,
		workersPerHost: 4,
	});
	assert.throws(() => fleetScaling([], [], { minHosts: 3, maxHosts: 2 }), isWorkerPlacementConfigError);
});

const SCALING: WorkerFleetScaling = {
	desiredHosts: 3,
	desiredWorkers: 12,
	demand: 10,
	queueDepth: 7,
	running: 3,
	hosts: 2,
	busySlots: 3,
	idleSlots: 5,
	minHosts: 0,
	maxHosts: 10,
	workersPerHost: 4,
};

test("Prometheus text names each gauge once, with no host or root in it (#4768)", () => {
	const text = prometheusText({ fleet: { store: { state: "ok" } }, scaling: SCALING });
	const samples = text.split("\n").filter((line) => line !== "" && !line.startsWith("#"));
	assert.deepEqual(samples, [
		"atomic_fleet_store_up 1",
		"atomic_fleet_desired_hosts 3",
		"atomic_fleet_desired_workers 12",
		"atomic_fleet_demand 10",
		"atomic_fleet_queue_depth 7",
		"atomic_fleet_running 3",
		"atomic_fleet_hosts 2",
		"atomic_fleet_min_hosts 0",
		"atomic_fleet_max_hosts 10",
		"atomic_fleet_workers_per_host 4",
		'atomic_fleet_slots{state="busy"} 3',
		'atomic_fleet_slots{state="idle"} 5',
	]);
	for (const sample of samples) {
		const name = sample.split(/[{ ]/)[0]!;
		assert.ok(text.includes(`# TYPE ${name} gauge\n`), name);
		assert.ok(text.includes(`# HELP ${name} `), name);
	}
	assert.ok(text.endsWith("\n"));
	assert.equal(
		prometheusText({ fleet: { store: { state: "unknown" } } }),
		"# HELP atomic_fleet_store_up Whether the shared store answered the last read and took writes.\n# TYPE atomic_fleet_store_up gauge\natomic_fleet_store_up 0\n",
	);
	assert.match(
		prometheusText({ fleet: { store: { state: "degraded" } }, scaling: SCALING }),
		/^atomic_fleet_store_up 0$/m,
	);
});

test("the metrics server serves /metrics and /scaling from one read per interval, and refuses the rest (#4768)", async () => {
	let clock = 1_000;
	let reads = 0;
	let answer: () => Promise<{ fleet: { store: { state: "ok" | "unknown" } }; scaling?: WorkerFleetScaling }> =
		async () => ({ fleet: { store: { state: "ok" } }, scaling: SCALING });
	const server = await serveWorkerMetrics({
		host: "127.0.0.1",
		port: 0,
		now: () => clock,
		read: () => {
			reads++;
			return answer();
		},
	});
	try {
		assert.match(server.address, /^127\.0\.0\.1:\d+$/);
		const get = (path: string, method = "GET") => fetch(`http://${server.address}${path}`, { method });
		const scaling = await get("/scaling");
		assert.equal(scaling.status, 200);
		assert.equal(scaling.headers.get("content-type"), "application/json");
		assert.deepEqual(await scaling.json(), SCALING);
		const metrics = await get("/metrics?x=1");
		assert.equal(metrics.headers.get("content-type"), "text/plain; version=0.0.4; charset=utf-8");
		assert.match(await metrics.text(), /^atomic_fleet_desired_hosts 3$/m);
		assert.equal((await get("/metrics", "HEAD")).status, 200);
		assert.equal(reads, 1, "scrapes within the interval share one read");
		clock += READ_INTERVAL_MS - 1;
		await get("/metrics");
		assert.equal(reads, 1);
		clock += 1;
		await get("/metrics");
		assert.equal(reads, 2);
		assert.equal((await get("/")).status, 404);
		assert.equal((await get("/metricsx")).status, 404);
		const post = await get("/scaling", "POST");
		assert.equal(post.status, 405);
		assert.equal(post.headers.get("allow"), "GET, HEAD");
		// A failed read answers 503 and is not kept: the next scrape reads again.
		clock += READ_INTERVAL_MS;
		answer = async () => {
			throw new Error("secret-bearing failure");
		};
		const failed = await get("/scaling");
		assert.equal(failed.status, 503);
		assert.doesNotMatch(await failed.text(), /secret/);
		answer = async () => ({ fleet: { store: { state: "unknown" } } });
		const unknown = await get("/scaling");
		assert.equal(unknown.status, 503);
		assert.deepEqual(await unknown.json(), { error: "The shared store could not be read.", store: "unknown" });
		assert.match(await (await get("/metrics")).text(), /^atomic_fleet_store_up 0$/m);
		assert.equal(reads, 4);
		// A request target that is not a URL answers 400, and the server keeps serving.
		const raw = await new Promise<string>((resolve, reject) => {
			const [host, port] = [
				server.address.slice(0, server.address.lastIndexOf(":")),
				server.address.slice(server.address.lastIndexOf(":") + 1),
			];
			const socket = connect(Number(port), host, () =>
				socket.end("GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"),
			);
			let text = "";
			socket.on("data", (chunk) => {
				text += String(chunk);
			});
			socket.on("end", () => resolve(text));
			socket.on("error", reject);
		});
		assert.match(raw, /^HTTP\/1\.1 400 /);
		assert.equal((await get("/metrics")).status, 200);
	} finally {
		await server.close();
	}
});

test("worker metrics and status parse --listen and the signal's policy, and refuse the rest (#4768)", () => {
	const cwd = "/work";
	assert.deepEqual(parseWorkerCommand(["metrics"], { cwd }), {
		kind: "metrics",
		policy: {},
		listen: { host: "127.0.0.1", port: 9464 },
		json: false,
	});
	for (const [listen, host, port] of [
		["0.0.0.0:9100", "0.0.0.0", 9100],
		[":9100", "127.0.0.1", 9100],
		["9100", "127.0.0.1", 9100],
		["[::]:9100", "::", 9100],
		["localhost:0", "localhost", 0],
		["metrics.internal:65535", "metrics.internal", 65535],
	] as const) {
		const parsed = parseWorkerCommand(["metrics", "--listen", listen], { cwd });
		assert.deepEqual(parsed.kind === "metrics" && parsed.listen, { host, port }, listen);
	}
	for (const listen of ["", "host:", "host:65536", "a:b:1", "host:port", "[::1]9100", "1:2:3"])
		assert.throws(
			() => parseWorkerCommand(["metrics", "--listen", listen], { cwd }),
			(error: Error) => error instanceof WorkerCommandError && error.field === "--listen",
			listen,
		);
	assert.deepEqual(
		parseWorkerCommand(["status", "--min-hosts", "1", "--max-hosts", "4", "--workers-per-host", "2"], { cwd }),
		{ kind: "status", policy: { minHosts: 1, maxHosts: 4, workersPerHost: 2 }, json: false },
	);
	const metrics = parseWorkerCommand(["metrics", "--workers-per-host", "8", "--json"], { cwd });
	assert.deepEqual(metrics.kind === "metrics" && [metrics.policy, metrics.json], [{ workersPerHost: 8 }, true]);
	for (const [args, field] of [
		[["metrics", "--idle-drain", "5"], "--idle-drain"],
		[["metrics", "--provisioner", "p.json"], "--provisioner"],
		[["metrics", "--slots", "2"], "--slots"],
		[["status", "--listen", ":9100"], "--listen"],
		[["controller", "--provisioner", "p.json", "--listen", ":9100"], "--listen"],
		[["start", "--listen", ":9100"], "--listen"],
		[["start", "--workers-per-host", "2"], "--workers-per-host"],
	] as const)
		assert.throws(
			() => parseWorkerCommand(args, { cwd }),
			(error: Error) => error instanceof WorkerCommandError && error.field === field,
			args.join(" "),
		);
});

function metricsModule(read: WorkerHostModule["readWorkflowWorkerFleet"]): WorkerHostModule {
	return {
		startWorkflowWorkerHost: () => assert.fail("metrics starts no host"),
		startWorkflowFleetController: () => assert.fail("metrics runs no controller"),
		createWorkerHostProvisioner: () => assert.fail("metrics builds no provisioner"),
		workflowWorkerFleetLines: () => assert.fail("metrics prints no status"),
		readWorkflowWorkerFleet: read,
	};
}

test("worker metrics serves the scaling signal read without writes, and stops on SIGTERM (#4768)", async () => {
	const out: string[] = [];
	const err: string[] = [];
	const signals = new EventEmitter();
	const asked: Parameters<WorkerHostModule["readWorkflowWorkerFleet"]>[0][] = [];
	const fleet: WorkerFleet = { fleet: { store: { state: "ok" } }, scaling: SCALING };
	const exit = runWorkerCommand(["metrics", "--listen", "127.0.0.1:0", "--workers-per-host", "4"], {
		cwd: "/work",
		agentDir: "/agent",
		log: (line) => out.push(line),
		error: (line) => err.push(line),
		signals: signals as unknown as Pick<NodeJS.Process, "on" | "off">,
		loadModule: async () =>
			metricsModule(async (options) => {
				asked.push(options);
				return fleet;
			}),
	});
	const deadline = Date.now() + 10_000;
	while (out.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
	const address = /^listening address=(\S+) journal=/.exec(out[0] ?? "")?.[1];
	assert.ok(address !== undefined, out.join("\n"));
	assert.deepEqual(await (await fetch(`http://${address}/scaling`)).json(), SCALING);
	signals.emit("SIGTERM", "SIGTERM");
	assert.equal(await exit, 0);
	assert.deepEqual(out.slice(1), ["stopping signal=SIGTERM", "stopped"]);
	assert.deepEqual(err, []);
	assert.equal(signals.listenerCount("SIGTERM"), 0);
	assert.ok(asked.length >= 1);
	for (const options of asked)
		assert.deepEqual(options, { agentDir: "/agent", policy: { workersPerHost: 4 }, probeWrites: false });
	await assert.rejects(fetch(`http://${address}/scaling`));
});

test("worker metrics exits 1 on a setup problem, or a port it cannot take, and starts no server (#4768)", async () => {
	const err: string[] = [];
	const setup = await runWorkerCommand(["metrics", "--listen", "127.0.0.1:0", "--json"], {
		cwd: "/work",
		agentDir: "/agent",
		log: () => assert.fail("nothing is served"),
		error: (line) => err.push(line),
		loadModule: async () =>
			metricsModule(async () => {
				throw new Error("The libSQL adapter is not installed.");
			}),
	});
	assert.equal(setup, 1);
	assert.deepEqual(
		err
			.map((line) => JSON.parse(line) as { event: string; message: string })
			.map(({ event, message }) => [event, message]),
		[["setup-failed", "The libSQL adapter is not installed."]],
	);
	const taken = await serveWorkerMetrics({
		host: "127.0.0.1",
		port: 0,
		read: async () => ({ fleet: { store: { state: "ok" } } }),
	});
	try {
		err.length = 0;
		const code = await runWorkerCommand(["metrics", "--listen", taken.address], {
			cwd: "/work",
			agentDir: "/agent",
			log: () => assert.fail("nothing is served"),
			error: (line) => err.push(line),
			loadModule: async () => metricsModule(async () => ({ fleet: { store: { state: "ok" } } })),
		});
		assert.equal(code, 1);
		assert.match(err[0] ?? "", /EADDRINUSE/);
	} finally {
		await taken.close();
	}
});
