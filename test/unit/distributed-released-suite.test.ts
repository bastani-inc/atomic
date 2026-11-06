import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test, vi } from "vitest";
import { profileCoverage } from "../distributed/harness/chaos.mjs";
import {
	CHAOS_PROFILES,
	parseRunArgs,
	parseTopology,
	resolveRunOptions,
	SUITE_PROFILES,
	suiteProfiles,
} from "../distributed/harness/config.mjs";
import {
	DistributedConfigError,
	type DistributedTimeoutError,
	isDistributedConfigError,
	isDistributedFaultError,
	isDistributedTimeoutError,
} from "../distributed/harness/errors.mjs";
import { createRandom } from "../distributed/harness/prng.mjs";
import { RELEASED_SETTINGS, runReleased } from "../distributed/harness/released-suite.mjs";
import { AGENT, Host, RELEASED, stageHarness, startAgentUnit } from "../distributed/harness/remote.mjs";

type Remote = NonNullable<Parameters<typeof runReleased>[1]>;
type FaultRecord = Parameters<typeof runReleased>[0]["faults"][number];
type OwnerRecord = NonNullable<Awaited<ReturnType<Remote["ownerLog"]>>>[number];
type SenderRecord = NonNullable<Awaited<ReturnType<Remote["senderLog"]>>>[number];

const FAST = {
	children: 2,
	windowMs: 0,
	pollMs: 1,
	launchTimeoutMs: 200,
	progressTimeoutMs: 200,
	recoveryTimeoutMs: 200,
	sendersStopTimeoutMs: 200,
	settleMinMs: 0,
	settleMaxMs: 50,
};

const field = (value: unknown, key: string) => Reflect.get(Object(value), key);

const host = (name: string) => ({ name, ip: name, user: "adt", roles: [], vmName: name, region: "r" }) as never;

/**
 * A fleet that behaves as the node driver does: the owner releases its children, senders deliver every message, the
 * owner restarts after a kill and a killed broker is replaced. Each fault mechanism records what it was asked to do.
 */
class FakeRemote {
	readonly calls: string[] = [];
	readonly owner = host("n1");
	readonly senders = [
		{ name: "s1", host: host("n2") },
		{ name: "s2", host: host("n3") },
	];
	readonly database = "db";
	readonly ownerRecords: OwnerRecord[] = [{ event: "owner-start", reopened: false, children: 2, at: 1 }];
	readonly sent = new Map<string, SenderRecord[]>();
	restarts = 0;
	brokers = new Map<string, number>([
		["n1", 100],
		["n2", 200],
		["n3", 300],
	]);
	states = new Map<number, string>();
	offset = 0;
	throttled = false;
	full = false;
	stopped = false;
	childrenReady = true;
	sqld = true;
	tick = 0;
	failOn: string | undefined;
	stopAllFailure: Error | undefined;

	private record(call: string) {
		this.calls.push(call);
		if (this.failOn === call) throw new Error(`${call} failed`);
	}
	undo = <T>(step: () => Promise<T>) => {
		this.calls.push("undo");
		return step();
	};
	startOwner = async (children: number) => {
		this.record(`start owner ${children}`);
	};
	children = async () => (this.childrenReady ? ["c1", "c2"] : undefined);
	startSender = async (sender: { name: string }, children: readonly string[]) => {
		this.record(`start ${sender.name} ${children.join(",")}`);
		this.sent.set(sender.name, []);
	};
	tally = async (sender: { name: string }) => {
		const records = this.sent.get(sender.name) ?? [];
		if (!this.stopped) {
			const k = records.filter((record) => record.event === "send").length + 1;
			for (const child of ["c1", "c2"]) {
				const id = `${sender.name}-${child}-${k}`;
				records.push(
					{ event: "send-start", child, k, id },
					{ event: "send", child, k, id, delivered: true, queued: false, at: ++this.tick + 1000 },
				);
			}
		}
		const outcomes = records.filter((record) => record.event === "send").length;
		return { outcomes, delivered: outcomes };
	};
	status: OwnerRecord = { event: "status", children: 2, released: 2, running: 0, other: 0 };
	ownerLog: () => Promise<OwnerRecord[] | undefined> = async () => [
		...this.ownerRecords,
		this.status,
		{ event: "heartbeat" },
	];
	senderLog = async (sender: { name: string }) => this.sent.get(sender.name);
	stopSenders = async () => {
		this.record("stop senders");
		this.stopped = true;
		for (const records of this.sent.values()) records.push({ event: "sender-done" });
	};
	stopOwner = async () => {
		this.record("stop owner");
		this.ownerRecords.push({ event: "final-status", children: 2, released: 2, running: 0, other: 0 });
	};
	stopAll = async () => {
		this.calls.push("stop all");
		if (this.stopAllFailure) throw this.stopAllFailure;
	};
	inspect = async () => {
		this.record("inspect");
		return {
			status: { children: 2, released: 2, running: 0, other: 0, wakeFailures: 0 },
			children: ["c1", "c2"].map((child) => ({
				name: child,
				state: "terminal",
				terminalStatus: "released",
				wakeFailure: false,
				readable: true,
				messages: [...this.sent.entries()].flatMap(([sender, records]) =>
					records
						.filter((record) => record.event === "send" && record.child === child)
						.map((record) => ({ id: record.id ?? "", text: `ADT ${sender} ${child} ${record.k}` })),
				),
			})),
		};
	};
	integrity = async (store: "shared" | "owner") => {
		this.record(`integrity ${store}`);
		return ["ok"];
	};
	ownerRestarts = async () => this.restarts;
	killOwner = async () => {
		this.record("kill owner");
		this.restarts++;
		this.ownerRecords.push(
			{ event: "owner-start", reopened: true, children: 2, at: 2 },
			{ event: "owner-rebound", children: 2, released: 2, running: 0, other: 0, at: 3 },
			{ event: "owner-recovery", children: 2, released: 2, running: 0, other: 0, at: 4 },
		);
	};
	brokerPid = async (target: { name: string }) => this.brokers.get(target.name);
	signal = async (target: { name: string }, pid: number, signal: "KILL" | "STOP" | "CONT") => {
		this.record(`${signal} ${target.name} ${pid}`);
		if (signal === "KILL") this.brokers.set(target.name, pid + 1);
		this.states.set(pid, signal === "STOP" ? "T" : "S");
	};
	processState = async (_target: unknown, pid: number) => this.states.get(pid) ?? "S";
	network = (target: { name: string }, profile: string, seed: number) => {
		let active = false;
		return {
			apply: async () => {
				this.record(`${profile} apply ${target.name}`);
				active = true;
			},
			clear: async () => {
				this.record(`${profile} clear ${target.name}`);
				active = false;
			},
			observe: async () => ({ seed, packets: active ? 5 : 0 }),
			effect: (observed: Record<string, unknown>) => observed.packets === 5,
			cleared: async () => !active,
		};
	};
	clockOffsetMs = async () => this.offset;
	skewClock = async (target: { name: string }, seconds: number) => {
		this.record(`skew ${target.name} ${seconds}`);
		this.offset = seconds * 1000;
	};
	restoreClock = async (target: { name: string }) => {
		this.record(`restore ${target.name}`);
		this.offset = 0;
	};
	throttleDisk = async () => {
		this.record("throttle");
		this.throttled = true;
		return "8:32 wiops=20";
	};
	unthrottleDisk = async () => {
		this.record("unthrottle");
		this.throttled = false;
		return "";
	};
	fillDisk = async () => {
		this.record("fill");
		this.full = true;
		return 0;
	};
	freeDisk = async () => {
		this.record("free");
		this.full = false;
	};
	probeDisk = async () =>
		this.full ? { result: "No space left on device", ms: 3 } : { result: "ok", ms: this.throttled ? 900 : 10 };
	sqldActive = async () => this.sqld;
}

type RunOptions = {
	signal?: AbortSignal;
	settings?: Partial<typeof FAST>;
	log?: (line: string) => void;
	faults?: FaultRecord[];
};

function released(
	remote: FakeRemote,
	profiles: readonly string[] = SUITE_PROFILES["idle-density"],
	options: RunOptions = {},
) {
	return runReleased(
		{
			runId: "adtrun",
			attempt: "a1",
			nodes: [],
			primary: host("db"),
			random: createRandom(7),
			profiles,
			gatewayPort: 8443,
			namespace: "smoke",
			log: options.log ?? (() => {}),
			started: performance.now(),
			faults: options.faults ?? [],
			settings: { ...FAST, ...options.settings },
			...(options.signal === undefined ? {} : { signal: options.signal }),
		},
		remote as unknown as Remote,
	);
}

test("idle-density runs every fault once, in order, each reverted before the next (#4394)", async () => {
	const remote = new FakeRemote();
	const result = await released(remote);
	assert.deepEqual(
		remote.calls.filter((call) => call !== "undo"),
		[
			"start owner 2",
			"start s1 c1,c2",
			"start s2 c1,c2",
			"latency apply n1",
			"latency clear n1",
			"loss apply n1",
			"loss clear n1",
			"partition apply n2",
			"partition clear n2",
			"STOP n3 300",
			"CONT n3 300",
			"skew n2 300",
			"restore n2",
			"throttle",
			"unthrottle",
			"fill",
			"free",
			"KILL n1 100",
			"kill owner",
			"stop senders",
			"stop owner",
			"inspect",
			"integrity shared",
			"integrity owner",
			"stop all",
		],
	);
	assert.deepEqual(
		result.faults.map((fault) => [
			fault.profile,
			fault.target,
			fault.applied,
			fault.effectObserved,
			fault.recovered,
			fault.error,
		]),
		[
			["latency", "n1", true, true, true, undefined],
			["loss", "n1", true, true, true, undefined],
			["partition", "n2", true, true, true, undefined],
			["sigstop", "n3 broker", true, true, true, undefined],
			["clock-skew", "n2", true, true, true, undefined],
			["slow-disk", "db", true, true, true, undefined],
			["disk-full", "db", true, true, true, undefined],
			["sigkill", "n1 broker", true, true, true, undefined],
			["sigkill", "n1 owner", true, true, true, undefined],
		],
	);
	assert.deepEqual(
		result.invariants.filter((item) => !item.passed),
		[],
	);
	assert.equal(field(result.invariants.find((item) => item.name === "owner-recovered")?.expected, "starts"), 2);
	assert.deepEqual(
		profileCoverage(result.faults, SUITE_PROFILES["idle-density"]).map((entry) => entry.status),
		Array(8).fill("exercised"),
	);
	assert.deepEqual(Object.keys(result.profileSpecs), [...SUITE_PROFILES["idle-density"]]);
	const fault = (target: string) => result.faults.find((item) => item.target === target);
	assert.deepEqual(fault("n1 owner")?.observed, {
		restartsBefore: 0,
		restartsAfter: 1,
		startsBefore: 1,
		startsAfter: 2,
	});
	assert.deepEqual(fault("n1 broker")?.observed, { pid: 100, replacement: 101 });
	assert.deepEqual(fault("n3 broker")?.observed, { pid: 300, state: "T", stateAfter: "S" });
	assert.deepEqual(fault("db")?.observed, {
		baselineMs: 10,
		throttledMs: 900,
		limit: "8:32 wiops=20",
		limitAfter: "",
		restoredMs: 10,
	});
	assert.deepEqual(result.faults.find((item) => item.profile === "disk-full")?.observed, {
		freeBytes: 0,
		probe: "No space left on device",
		sqldActive: true,
		probeAfter: "ok",
	});
	assert.deepEqual(result.faults.find((item) => item.profile === "clock-skew")?.observed, {
		offsetMs: 300_000,
		offsetAfterMs: 0,
	});
	assert.deepEqual(result.faults.find((item) => item.profile === "partition")?.observed, {
		seed: result.faults.find((item) => item.profile === "partition")?.observed.seed,
		packets: 5,
		cleared: true,
	});
	assert.equal(result.metrics.children, 2);
	assert.equal(result.metrics.senders, 2);
	assert.equal(result.metrics.settled, true);
	assert.deepEqual(result.metrics.evidenceErrors, []);
	assert.equal(result.metrics.classes.delivered, result.metrics.sends);
	assert.ok(result.metrics.sends > 0);
});

test("idle-density runs only the selected profiles and still checks every invariant (#4394)", async () => {
	const remote = new FakeRemote();
	const result = await released(remote, ["clock-skew"]);
	assert.deepEqual(
		remote.calls.filter((call) => !["undo", "inspect", "stop all"].includes(call) && !call.startsWith("integrity")),
		["start owner 2", "start s1 c1,c2", "start s2 c1,c2", "skew n2 300", "restore n2", "stop senders", "stop owner"],
	);
	assert.deepEqual(
		result.faults.map((fault) => fault.profile),
		["clock-skew"],
	);
	assert.equal(result.invariants.length, 11);
	assert.ok(result.invariants.every((item) => item.passed));
	assert.equal(field(result.invariants.find((item) => item.name === "owner-recovered")?.expected, "starts"), 1);
	assert.deepEqual(Object.keys(result.profileSpecs), ["clock-skew"]);
});

test("a fault whose effect was not observed or whose target did not recover is recorded, not hidden (#4394)", async () => {
	const remote = new FakeRemote();
	remote.network = (target, profile, seed) => ({
		...new FakeRemote().network(target, profile, seed),
		effect: () => false,
		cleared: async () => false,
	});
	remote.sqld = false;
	const result = await released(remote, ["partition", "disk-full", "sigstop"]);
	const partition = result.faults.find((fault) => fault.profile === "partition");
	assert.equal(partition?.effectObserved, false);
	assert.equal(partition?.recovered, false);
	assert.equal(result.faults.find((fault) => fault.profile === "disk-full")?.recovered, false);
	assert.deepEqual(
		profileCoverage(result.faults, ["partition", "disk-full", "sigstop"]).map((entry) => entry.status),
		["incomplete", "incomplete", "exercised"],
	);
});

test("an effect is only observed when the fault really changed the target (#4394)", async () => {
	const remote = new FakeRemote();
	remote.probeDisk = async () => ({ result: "ok", ms: 10 });
	remote.signal = async (target, pid, signal) => {
		remote.calls.push(`${signal} ${target.name} ${pid}`);
		if (signal === "KILL") remote.brokers.set(target.name, pid + 1);
	};
	remote.skewClock = async () => {
		remote.offset = 289_000;
	};
	const result = await released(remote, ["slow-disk", "disk-full", "sigstop", "clock-skew"]);
	assert.deepEqual(
		result.faults.map((fault) => [fault.profile, fault.effectObserved, fault.recovered]),
		[
			["sigstop", false, true],
			["clock-skew", false, true],
			["slow-disk", false, false],
			["disk-full", false, true],
		],
	);
	const edge = new FakeRemote();
	edge.probeDisk = async () => (edge.throttled ? { result: "ok", ms: 210 } : { result: "ok", ms: 10 });
	edge.skewClock = async () => {
		edge.offset = 290_001;
	};
	edge.restoreClock = async () => {
		edge.offset = -4999;
	};
	const [skew, slow] = (await released(edge, ["clock-skew", "slow-disk"])).faults;
	assert.equal(skew?.effectObserved, true);
	assert.equal(skew?.recovered, true);
	assert.equal(slow?.effectObserved, true);
	const late = new FakeRemote();
	late.skewClock = async () => {
		late.offset = 290_001;
	};
	late.restoreClock = async () => {
		late.offset = 5000;
	};
	late.probeDisk = async () => (late.throttled ? { result: "ok", ms: 209 } : { result: "ok", ms: 10 });
	const [skewed, slower] = (await released(late, ["clock-skew", "slow-disk"])).faults;
	assert.equal(skewed?.recovered, false);
	assert.equal(slower?.effectObserved, false);
	const throttledWrite = new FakeRemote();
	throttledWrite.probeDisk = async () =>
		throttledWrite.throttled ? { result: "No space left on device", ms: 900 } : { result: "ok", ms: 10 };
	const [failedProbe] = (await released(throttledWrite, ["slow-disk"])).faults;
	assert.equal(failedProbe?.effectObserved, false);
	const stuck = new FakeRemote();
	stuck.unthrottleDisk = async () => "8:32 wiops=20";
	stuck.probeDisk = async () => ({ result: "ok", ms: stuck.calls.includes("throttle") ? 900 : 10 });
	const [unrecovered] = (await released(stuck, ["slow-disk"])).faults;
	assert.equal(unrecovered?.recovered, false);
	const stillFull = new FakeRemote();
	stillFull.freeDisk = async () => {};
	const [full] = (await released(stillFull, ["disk-full"])).faults;
	assert.equal(full?.recovered, false);
	const stillStopped = new FakeRemote();
	stillStopped.signal = async (_target, pid, signal) => {
		if (signal === "STOP") stillStopped.states.set(pid, "T");
	};
	const [stop] = (await released(stillStopped, ["sigstop"])).faults;
	assert.equal(stop?.effectObserved, true);
	assert.equal(stop?.recovered, false);
	const exact = new FakeRemote();
	exact.skewClock = async () => {
		exact.offset = 290_000;
	};
	exact.probeDisk = async () =>
		exact.calls.includes("unthrottle") ? { result: "ok", ms: 450 } : { result: "ok", ms: exact.throttled ? 900 : 10 };
	const [atBoundary, halved] = (await released(exact, ["clock-skew", "slow-disk"])).faults;
	assert.equal(atBoundary?.effectObserved, false, "an offset just short of the skew is not the skew");
	assert.equal(halved?.recovered, false, "writes only half as slow have not recovered");
	const failing = new FakeRemote();
	failing.probeDisk = async () =>
		failing.calls.includes("unthrottle")
			? { result: "Input/output error", ms: 5 }
			: { result: "ok", ms: failing.throttled ? 900 : 10 };
	const [broken] = (await released(failing, ["slow-disk"])).faults;
	assert.equal(broken?.recovered, false, "a fast but failing write has not recovered");
	const restartedNothing = new FakeRemote();
	const kill = restartedNothing.killOwner;
	restartedNothing.killOwner = async () => {
		await kill();
		restartedNothing.restarts--;
	};
	const owner = (await released(restartedNothing, ["sigkill"])).faults.find((fault) => fault.target === "n1 owner");
	assert.equal(owner?.effectObserved, false);
});

test("a fault that cannot be applied fails with a typed error and its revert still runs (#4394)", async () => {
	const remote = new FakeRemote();
	remote.failOn = "fill";
	const result = await released(remote, ["disk-full", "clock-skew"]);
	const full = result.faults.find((fault) => fault.profile === "disk-full");
	assert.equal(full?.error?.code, "fault-failed");
	assert.equal(full?.error?.fields.stage, "apply");
	assert.ok(remote.calls.includes("free"), "the filler is removed even though filling failed");
	assert.deepEqual(
		result.faults.map((fault) => fault.profile),
		["clock-skew", "disk-full"],
	);
	assert.ok(remote.calls.indexOf("free") < remote.calls.indexOf("stop senders"));
});

test("a broker that never comes back fails its fault with a typed timeout (#4394)", async () => {
	const remote = new FakeRemote();
	remote.signal = async (target, pid, signal) => {
		remote.calls.push(`${signal} ${target.name} ${pid}`);
		if (signal === "KILL") remote.brokers.delete(target.name);
	};
	const [broker] = (await released(remote, ["sigkill"])).faults.filter((fault) => fault.target === "n1 broker");
	assert.equal(broker?.error?.code, "fault-failed");
	assert.equal(broker?.error?.cause?.name, "DistributedTimeoutError");
	assert.equal(broker?.error?.cause?.fields.phase, "broker replacement");
	const absent = new FakeRemote();
	absent.brokers.clear();
	const faults = (await released(absent, ["sigkill", "sigstop"])).faults;
	assert.deepEqual(
		faults.map((fault) => [fault.target, fault.applied, fault.error?.cause?.fields.phase]),
		[
			["n3 broker", false, "sender broker"],
			["n1 broker", false, "owner broker"],
			["n1 owner", true, undefined],
		],
	);
	assert.equal(
		absent.calls.some((call) => call.startsWith("CONT")),
		false,
		"a broker never stopped is never continued",
	);
});

test("senders that stop making progress fail the gate with a typed timeout naming the phase (#4394)", async () => {
	const remote = new FakeRemote();
	remote.tally = async () => ({ outcomes: 1, delivered: 1 });
	await assert.rejects(released(remote, []), (error) => {
		assert.ok(isDistributedTimeoutError(error));
		assert.equal((error as DistributedTimeoutError).fields.phase, "baseline: sender outcomes");
		assert.equal((error as DistributedTimeoutError).fields.timeoutMs, FAST.progressTimeoutMs);
		return true;
	});
	assert.deepEqual(remote.calls.at(-1), "stop all");
});

test("children that never release fail the launch with a typed timeout, and the units are stopped (#4394)", async () => {
	const remote = new FakeRemote();
	remote.childrenReady = false;
	const failure = new Error("ssh failed");
	remote.stopAllFailure = failure;
	await assert.rejects(released(remote), (error) => {
		assert.ok(isDistributedTimeoutError(error));
		assert.equal((error as DistributedTimeoutError).fields.phase, "released children");
		assert.equal(Reflect.get(error as object, "cleanupCause"), failure);
		return true;
	});
	assert.deepEqual(remote.calls, ["start owner 2", "stop all"]);
});

test("a failure to stop the units after a passing scenario is not swallowed (#4394)", async () => {
	const remote = new FakeRemote();
	remote.stopAllFailure = new Error("ssh failed");
	await assert.rejects(released(remote, []), /ssh failed/);
});

test("evidence that cannot be read fails its invariants and is reported by type (#4394)", async () => {
	const remote = new FakeRemote();
	remote.failOn = "inspect";
	const result = await released(remote, []);
	assert.deepEqual(
		result.metrics.evidenceErrors.map((error) => error.name),
		["Error"],
	);
	assert.equal(result.invariants.find((item) => item.name === "delivered-exactly-once")?.passed, false);
	assert.equal(result.invariants.find((item) => item.name === "evidence-complete")?.passed, false);
	const integrity = new FakeRemote();
	integrity.failOn = "integrity owner";
	const checked = await released(integrity, []);
	assert.deepEqual(checked.invariants.find((item) => item.name === "session-integrity")?.actual, {
		shared: ["ok"],
		owner: null,
		unreadableChildren: 0,
	});
});

test("cancellation while reading evidence stays a cancellation (#4394)", async () => {
	const remote = new FakeRemote();
	const controller = new AbortController();
	remote.inspect = async () => {
		const reason = new DOMException("cancelled", "AbortError");
		controller.abort(reason);
		throw reason;
	};
	await assert.rejects(
		runReleased(
			{
				runId: "adtrun",
				attempt: "a1",
				nodes: [],
				primary: host("db"),
				random: createRandom(7),
				profiles: [],
				gatewayPort: 8443,
				namespace: "smoke",
				signal: controller.signal,
				log: () => {},
				started: performance.now(),
				faults: [],
				settings: FAST,
			},
			remote as unknown as Remote,
		),
		{ name: "AbortError" },
	);
});

test("children still running after the settle window are reported, not waited for forever (#4394)", async () => {
	const remote = new FakeRemote();
	remote.status = { event: "status", children: 2, released: 1, running: 1, other: 0 };
	const result = await releasedOnFakeTime(remote, {});
	assert.equal(result.metrics.settled, false);
	assert.ok(result.metrics.settleMs >= FAST.settleMaxMs);
	const sizes = { ...RELEASED_SETTINGS };
	assert.ok(sizes.settleMinMs >= 3 * 30_000, "the settle window covers multi-node Intercom's three recovery windows");
	assert.ok(sizes.settleMaxMs > sizes.settleMinMs);
});

const topology = parseTopology(
	JSON.parse(readFileSync(new URL("../distributed/topology.json", import.meta.url), "utf8")),
);
const options = (argv: string[]) => resolveRunOptions(parseRunArgs(argv), topology, { randomSeed: 1 });

test("each suite runs the selected chaos profiles it supports (#4394)", () => {
	assert.deepEqual(SUITE_PROFILES.smoke, CHAOS_PROFILES);
	assert.deepEqual(suiteProfiles("idle-density", CHAOS_PROFILES), [
		"partition",
		"sigkill",
		"latency",
		"loss",
		"sigstop",
		"clock-skew",
		"disk-full",
		"slow-disk",
	]);
	assert.deepEqual(suiteProfiles("idle-density", ["oom", "clock-skew", "partition"]), ["clock-skew", "partition"]);
	assert.deepEqual(suiteProfiles("smoke", ["oom", "clock-skew"]), ["oom", "clock-skew"]);
	assert.deepEqual(suiteProfiles("compaction", CHAOS_PROFILES), []);
	assert.deepEqual(options(["--ref", "m", "--suite", "idle-density"]).chaos, [...CHAOS_PROFILES]);
	assert.deepEqual(options(["--ref", "m", "--suite", "idle-density", "--chaos", "sigkill,clock-skew"]).chaos, [
		"sigkill",
		"clock-skew",
	]);
	assert.deepEqual(options(["--ref", "m", "--suite", "all", "--chaos", "oom"]).chaos, ["oom"]);
	assert.deepEqual(options(["--ref", "m", "--suite", "compaction", "--chaos", "oom"]).chaos, ["oom"]);
	assert.deepEqual(options(["--ref", "m", "--suite", "idle-density", "--chaos", "none"]).chaos, []);
});

test("a profile the selected suite cannot run, or too few nodes, is rejected before any side effect (#4394)", () => {
	const rejected = (argv: string[]) => {
		try {
			options(argv);
		} catch (error) {
			assert.ok(isDistributedConfigError(error));
			assert.ok(error instanceof DistributedConfigError);
			return error.fields;
		}
		assert.fail(`${argv.join(" ")} was accepted`);
	};
	assert.deepEqual(rejected(["--ref", "m", "--suite", "idle-density", "--chaos", "partition,oom,vm-restart"]), {
		source: "cli",
		field: "--chaos",
		reason: "invalid-value",
		expected:
			"profiles the idle-density suite runs: partition, sigkill, latency, loss, sigstop, clock-skew, disk-full, slow-disk",
		actual: "oom,vm-restart",
	});
	assert.deepEqual(rejected(["--ref", "m", "--suite", "idle-density", "--nodes", "1"]), {
		source: "cli",
		field: "--nodes",
		reason: "invalid-value",
		expected: "at least 2: the idle-density suite runs its owner and its senders on different nodes",
		actual: "1",
	});
	assert.equal(rejected(["--ref", "m", "--suite", "all", "--nodes", "1"]).field, "--nodes");
	assert.equal(options(["--ref", "m", "--suite", "idle-density", "--nodes", "2"]).nodes, 2);
	assert.equal(options(["--ref", "m", "--nodes", "1"]).nodes, 1);
	assert.equal(options(["--ref", "m", "--suite", "compaction", "--nodes", "1"]).nodes, 1);
});

test("a profile counts as exercised only when every fault of it was (#4394)", () => {
	const ok = { applied: true, effectObserved: true, recovered: true };
	assert.deepEqual(
		profileCoverage(
			[
				{ profile: "sigkill", ...ok },
				{ profile: "sigkill", ...ok, recovered: false },
				{ profile: "loss", ...ok },
				{ profile: "loss", ...ok },
				{ profile: "oom", ...ok, skipped: { code: "no-cgroup" } },
				{ profile: "partition", ...ok },
				{ profile: "partition", ...ok, skipped: { code: "later" } },
			],
			["sigkill", "loss", "oom", "partition", "latency"],
		),
		[
			{ profile: "sigkill", status: "incomplete" },
			{ profile: "loss", status: "exercised" },
			{ profile: "oom", status: "skipped", reason: "no-cgroup" },
			{ profile: "partition", status: "skipped", reason: "later" },
			{ profile: "latency", status: "missing" },
		],
	);
});

test("a fault error is a typed fault failure (#4394)", async () => {
	const remote = new FakeRemote();
	remote.failOn = "throttle";
	const [slow] = (await released(remote, ["slow-disk"])).faults;
	assert.ok(isDistributedFaultError({ name: slow?.error?.name, code: slow?.error?.code }));
	assert.equal(slow?.applied, false);
	assert.ok(remote.calls.includes("unthrottle"), "a throttle that may be half-applied is still reverted");
});

const posixOnly = test.skipIf(process.platform === "win32");

/** Runs `body` with fake `ssh` and `scp` on PATH that record what they were asked to do instead of reaching a VM. */
async function withRecordedRemote(
	body: (host: InstanceType<typeof Host>, recorded: () => string) => Promise<void>,
	scpExit = 0,
) {
	const scratch = mkdtempSync(join(tmpdir(), "adt-released-remote-"));
	const log = join(scratch, "remote.log");
	for (const tool of ["ssh", "scp"]) {
		writeFileSync(
			join(scratch, tool),
			`#!/bin/sh\nprintf '%s ' ${tool} "$@" >> ${log}\necho >> ${log}\n[ ${tool} = scp ] && exit ${scpExit}\ncat >> ${log}\nprintf '{"result":["ok"]}\\n'\n`,
		);
		chmodSync(join(scratch, tool), 0o755);
	}
	const originalPath = process.env.PATH;
	process.env.PATH = `${scratch}${delimiter}${originalPath ?? ""}`;
	try {
		const host = new Host({
			context: { secrets: new Set() },
			name: "node-1",
			ip: "10.60.0.4",
			user: "adt",
			key: "unused",
			knownHosts: "unused",
		});
		await body(host, () => readFileSync(log, "utf8"));
	} finally {
		process.env.PATH = originalPath;
		rmSync(scratch, { recursive: true, force: true });
	}
}

posixOnly("the released driver is staged with the harness and started as its own unit (#4394)", async () => {
	await withRecordedRemote(async (host, recorded) => {
		await stageHarness(host, "/harness");
		for (const file of ["agent.mjs", "gateway.mjs", "released.mjs"])
			assert.ok(recorded().includes(`/harness/${file} adt@10.60.0.4:/opt/adt/harness/${file}`), file);
		await startAgentUnit(host, {
			unit: "adt-run-owner",
			script: RELEASED,
			args: ["owner"],
			properties: ["Restart=on-failure"],
		});
		assert.ok(
			recorded().includes(
				`--property=Restart=on-failure /opt/adt/node/bin/node /opt/adt/harness/released.mjs owner`,
			),
		);
		await startAgentUnit(host, { unit: "adt-run-writer", args: ["writer"] });
		assert.ok(
			recorded().includes(
				"--property=StandardError=append:/opt/adt/logs/adt-run-writer.log /opt/adt/node/bin/node /opt/adt/harness/agent.mjs writer",
			),
		);
		assert.deepEqual(await host.agent("integrity", ["--path", "p"], { script: RELEASED }), { result: ["ok"] });
		assert.ok(
			recorded().includes(
				`NODE_EXTRA_CA_CERTS=/opt/adt/secrets/ca.pem /opt/adt/node/bin/node ${RELEASED} integrity --path p`,
			),
		);
		await host.agent("integrity", []);
		assert.ok(recorded().trimEnd().endsWith(`/opt/adt/node/bin/node ${AGENT} integrity`));
	});
	await withRecordedRemote(async (host) => {
		await assert.rejects(stageHarness(host, "/missing-harness"), (error) => {
			assert.equal(Reflect.get(Reflect.get(Object(error), "fields"), "operation"), "node-1: upload agent.mjs");
			return true;
		});
	}, 2);
});

const timeline = (fault: FaultRecord | undefined) => fault?.timeline.map((entry) => entry.event);

test("every fault records what it did, when, and with which parameters (#4394)", async () => {
	const lines: string[] = [];
	const result = await released(new FakeRemote(), SUITE_PROFILES["idle-density"], { log: (line) => lines.push(line) });
	const seeds = createRandom(7);
	const [latencySeed, lossSeed, partitionSeed] = [1, 2, 3].map(() => seeds.integer(1, 2 ** 31 - 1));
	assert.deepEqual(
		result.faults.map((fault) => [fault.profile, fault.target, fault.parameters, timeline(fault)]),
		[
			["latency", "n1", { windowMs: 0 }, ["begin", "applied", "cleared", "senders progressed", "end"]],
			["loss", "n1", { windowMs: 0 }, ["begin", "applied", "cleared", "senders progressed", "end"]],
			["partition", "n2", { windowMs: 0 }, ["begin", "applied", "cleared", "senders progressed", "end"]],
			[
				"sigstop",
				"n3 broker",
				{ signal: "SIGSTOP", windowMs: 0 },
				["begin", "stopped broker 300", "continued", "sender progressed", "end"],
			],
			[
				"clock-skew",
				"n2",
				{ offsetSeconds: 300, windowMs: 0 },
				["begin", "skewed", "restored", "sender progressed", "end"],
			],
			["slow-disk", "db", { windowMs: 0 }, ["begin", "throttled", "unthrottled", "senders progressed", "end"]],
			["disk-full", "db", { windowMs: 0 }, ["begin", "filled", "freed", "senders progressed", "end"]],
			[
				"sigkill",
				"n1 broker",
				{ signal: "SIGKILL", process: "broker" },
				["begin", "killed broker 100", "broker 101 replaced it", "deliveries resumed", "end"],
			],
			[
				"sigkill",
				"n1 owner",
				{ signal: "SIGKILL", process: "owner" },
				["begin", "killed", "owner restarted and rebound its children", "deliveries resumed", "end"],
			],
		],
	);
	assert.deepEqual(
		result.faults.slice(0, 3).map((fault) => fault.observed.seed),
		[latencySeed, lossSeed, partitionSeed],
	);
	assert.deepEqual(
		lines.filter((line) => !line.includes(": ")),
		["owner started on n1", "2 children released", "senders stopped; letting the children settle"],
	);
	assert.ok(lines.includes("latency: applied"));
});

test("a step that fails after it began changing its target is still reverted (#4394)", async () => {
	for (const [profile, call, revert] of [
		["clock-skew", "skew", "restore n2"],
		["sigstop", "STOP n3 300", "CONT n3 300"],
		["partition", "partition apply n2", "partition clear n2"],
		["loss", "loss apply n1", "loss clear n1"],
	] as const) {
		const remote = new FakeRemote();
		if (profile === "clock-skew")
			remote.skewClock = async () => {
				remote.calls.push("skew");
				throw new Error("date failed");
			};
		else remote.failOn = call;
		const [fault] = (await released(remote, [profile])).faults;
		assert.equal(fault?.applied, false, profile);
		assert.equal(Reflect.get(fault?.error?.fields ?? {}, "stage"), "apply", profile);
		assert.ok(remote.calls.includes(revert), `${profile} was reverted`);
	}
	const killed = new FakeRemote();
	killed.failOn = "kill owner";
	const owner = (await released(killed, ["sigkill"])).faults.find((fault) => fault.target === "n1 owner");
	assert.equal(owner?.applied, false);
	assert.equal(owner?.error?.code, "fault-failed");
});

test("the owner fault waits for the restart and checks it rebound every child (#4394)", async () => {
	const late = new FakeRemote();
	let polls = 0;
	const log = late.ownerLog;
	late.killOwner = async () => {
		late.calls.push("kill owner");
		late.restarts++;
	};
	late.ownerLog = async () => {
		if (late.calls.includes("kill owner") && ++polls === 3)
			late.ownerRecords.push(
				{ event: "owner-start", reopened: true, children: 2 },
				{ event: "owner-rebound", children: 2, released: 2, running: 0, other: 0 },
			);
		return log();
	};
	const delayed = (await released(late, ["sigkill"])).faults.find((fault) => fault.target === "n1 owner");
	assert.equal(delayed?.effectObserved, true);
	assert.deepEqual(delayed?.observed, { restartsBefore: 0, restartsAfter: 1, startsBefore: 1, startsAfter: 2 });

	const partial = new FakeRemote();
	partial.killOwner = async () => {
		partial.restarts++;
		partial.ownerRecords.push(
			{ event: "owner-start", reopened: true, children: 2 },
			{ event: "owner-rebound", children: 1, released: 1, running: 0, other: 0 },
		);
	};
	const unbound = (await released(partial, ["sigkill"])).faults.find((fault) => fault.target === "n1 owner");
	assert.equal(unbound?.error?.cause?.fields.phase, "owner restart");

	const notStarted = new FakeRemote();
	notStarted.killOwner = async () => {
		notStarted.restarts++;
		notStarted.ownerRecords.push({ event: "owner-rebound", children: 2, released: 2, running: 0, other: 0 });
	};
	const missing = (await released(notStarted, ["sigkill"])).faults.find((fault) => fault.target === "n1 owner");
	assert.equal(missing?.effectObserved, false);
});

test("a broker counts as replaced only once another process answers (#4394)", async () => {
	const remote = new FakeRemote();
	let polls = 0;
	remote.brokerPid = async (target: { name: string }) => {
		if (target.name === "n1" && remote.calls.includes("KILL n1 100")) return ++polls < 3 ? 100 : 105;
		return remote.brokers.get(target.name);
	};
	const broker = (await released(remote, ["sigkill"])).faults.find((fault) => fault.target === "n1 broker");
	assert.deepEqual(broker?.observed, { pid: 100, replacement: 105 });
});

test("timeouts are typed, name their phase and report the time they took (#4394)", async () => {
	const remote = new FakeRemote();
	remote.childrenReady = false;
	const started = performance.now();
	await assert.rejects(released(remote, [], { settings: { launchTimeoutMs: 40 } }), (error) => {
		assert.ok(isDistributedTimeoutError(error));
		const { phase, timeoutMs, elapsedMs } = (error as DistributedTimeoutError).fields;
		assert.equal(phase, "released children");
		assert.equal(timeoutMs, 40);
		assert.ok(Number(elapsedMs) >= 40 && Number(elapsedMs) <= performance.now() - started + 1, String(elapsedMs));
		return true;
	});
	const silent = new FakeRemote();
	silent.stopSenders = async () => {
		silent.stopped = true;
		silent.sent.get("s1")?.push({ event: "sender-done" });
	};
	await assert.rejects(released(silent, []), (error) => {
		assert.ok(isDistributedTimeoutError(error));
		assert.equal((error as DistributedTimeoutError).fields.phase, "senders stopping");
		return true;
	});
	const unread = new FakeRemote();
	const read = unread.senderLog;
	unread.senderLog = async (sender: { name: string }) => (sender.name === "s2" ? undefined : read(sender));
	await assert.rejects(released(unread, []), (error) => isDistributedTimeoutError(error));
});

/** Runs the scenario on fake timers, so its time windows are exact rather than dependent on the machine's load. */
async function releasedOnFakeTime(remote: FakeRemote, settings: Partial<typeof FAST>) {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	try {
		await vi.advanceTimersByTimeAsync(10_000);
		let finished = false;
		const run = released(remote, [], { settings });
		run.then(
			() => {
				finished = true;
			},
			() => {
				finished = true;
			},
		);
		while (!finished) await vi.advanceTimersByTimeAsync(10);
		return await run;
	} finally {
		vi.useRealTimers();
	}
}

test("the settle window lasts at least its minimum and ends when every child is released (#4394)", async () => {
	const settledRun = await releasedOnFakeTime(new FakeRemote(), { settleMinMs: 30, settleMaxMs: 400 });
	assert.equal(settledRun.metrics.settled, true);
	assert.equal(settledRun.metrics.settleMs, 30);
	for (const status of [
		{ children: 3, released: 2, running: 0 },
		{ children: 2, released: 1, running: 0 },
		{ children: 2, released: 2, running: 1 },
	]) {
		const remote = new FakeRemote();
		remote.status = { event: "status", other: 0, ...status };
		const run = await releasedOnFakeTime(remote, { settleMinMs: 20, settleMaxMs: 60 });
		assert.equal(run.metrics.settled, false, JSON.stringify(status));
		assert.ok(run.metrics.settleMs >= 60 && run.metrics.settleMs <= 65, String(run.metrics.settleMs));
	}
	assert.deepEqual(RELEASED_SETTINGS, {
		children: 20,
		workers: 4,
		paceMs: 1000,
		windowMs: 30_000,
		skewSeconds: 300,
		pollMs: 3000,
		launchTimeoutMs: 900_000,
		progressTimeoutMs: 300_000,
		recoveryTimeoutMs: 180_000,
		sendersStopTimeoutMs: 180_000,
		settleMinMs: 120_000,
		settleMaxMs: 300_000,
	});
});

test("a cancellation is never recorded as a failed fault or a missed settle (#4394)", async () => {
	const reason = new Error("run cancelled");
	const during = new FakeRemote();
	const controller = new AbortController();
	during.skewClock = async () => {
		controller.abort(reason);
		throw reason;
	};
	const faults: FaultRecord[] = [];
	await assert.rejects(
		released(during, ["clock-skew"], { signal: controller.signal, faults }),
		(error) => error === reason,
	);
	assert.ok(during.calls.includes("restore n2"), "the skew is reverted although the run was cancelled");
	assert.equal(faults[0]?.error, undefined, "a cancelled fault is not recorded as failed");

	const waiting = new FakeRemote();
	const stop = new AbortController();
	waiting.childrenReady = false;
	setTimeout(() => stop.abort(reason), 5);
	const begin = performance.now();
	await assert.rejects(
		released(waiting, [], { signal: stop.signal, settings: { launchTimeoutMs: 5000 } }),
		(error) => error === reason,
	);
	assert.ok(performance.now() - begin < 2000, "a cancelled wait does not run to its timeout");

	const settling = new FakeRemote();
	const halt = new AbortController();
	settling.status = { event: "status", children: 2, released: 1, running: 1, other: 0 };
	const stopSenders = settling.stopSenders;
	settling.stopSenders = async () => {
		await stopSenders();
		setTimeout(() => halt.abort(reason), 5);
	};
	await assert.rejects(
		released(settling, [], { signal: halt.signal, settings: { settleMinMs: 0, settleMaxMs: 5000 } }),
		(error) => error === reason,
	);
	assert.equal(settling.calls.includes("stop owner"), false);
});

test("each sender gate names its fault and phase when the senders stall there (#4394)", async () => {
	const stalls: [string, string, string][] = [
		["latency", "begin", "latency: sender outcomes"],
		["latency", "cleared", "latency recovery: sender outcomes"],
		["loss", "begin", "loss: sender outcomes"],
		["loss", "cleared", "loss recovery: sender outcomes"],
		["n2", "begin", "partition: sender outcomes"],
		["n2", "cleared", "partition recovery: sender outcomes"],
		["n3 broker", "begin", "sigstop: sender outcomes"],
		["n3 broker", "continued", "sigstop recovery: sender outcomes"],
		["clock-skew", "begin", "clock-skew: sender outcomes"],
		["clock-skew", "skewed", "skewed sending: sender outcomes"],
		["clock-skew", "restored", "clock-skew recovery: sender outcomes"],
		["slow-disk", "begin", "slow-disk: sender outcomes"],
		["slow-disk", "unthrottled", "slow-disk recovery: sender outcomes"],
		["disk-full", "begin", "disk-full: sender outcomes"],
		["disk-full", "freed", "disk-full recovery: sender outcomes"],
		["n1 broker", "begin", "sigkill broker: sender outcomes"],
		["n1 broker", "broker 101 replaced it", "broker recovery: sender delivered"],
		["n1 owner", "begin", "sigkill owner: sender outcomes"],
		["n1 owner", "owner restarted and rebound its children", "owner recovery: sender delivered"],
	];
	for (const [fault, event, phase] of stalls) {
		const remote = new FakeRemote();
		const faults: FaultRecord[] = [];
		const tally = remote.tally;
		remote.tally = async (sender) => {
			const last = faults.at(-1);
			const stalled =
				last !== undefined && [last.profile, last.target].includes(fault) && last.timeline.at(-1)?.event === event;
			return stalled ? { outcomes: 0, delivered: 0 } : tally(sender);
		};
		await released(remote, SUITE_PROFILES["idle-density"], { faults, settings: { progressTimeoutMs: 30 } });
		const stalled = faults.find((item) => [item.profile, item.target].includes(fault));
		assert.equal(stalled?.error?.cause?.fields.phase, phase, `${fault} after ${event}`);
	}
});

test("the settle window is bounded by its maximum, not by the maximum plus the minimum (#4394)", async () => {
	const remote = new FakeRemote();
	remote.status = { event: "status", children: 2, released: 1, running: 1, other: 0 };
	const run = await releasedOnFakeTime(remote, { settleMinMs: 100, settleMaxMs: 300 });
	assert.equal(run.metrics.settled, false);
	assert.ok(run.metrics.settleMs >= 300 && run.metrics.settleMs <= 305, String(run.metrics.settleMs));
});

test("an owner log that is not there yet counts as no start and no status (#4394)", async () => {
	const remote = new FakeRemote();
	const log = remote.ownerLog;
	let reads = 0;
	remote.ownerLog = async () => (++reads <= 2 ? undefined : log());
	const result = await released(remote, ["sigkill"]);
	assert.equal(result.faults.find((fault) => fault.target === "n1 owner")?.effectObserved, true);
	const silent = new FakeRemote();
	silent.ownerLog = async () => undefined;
	const settledRun = await releasedOnFakeTime(silent, { settleMinMs: 0, settleMaxMs: 50 });
	assert.equal(settledRun.metrics.settled, false);
	assert.equal(settledRun.invariants.find((item) => item.name === "evidence-complete")?.passed, false);
});
