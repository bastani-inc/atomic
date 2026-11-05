import assert from "node:assert/strict";
import { test } from "vitest";
import { ARTIFACT_REMOTE_DIR, artifactBuildScript } from "../distributed/harness/artifact.mjs";
import {
	catalogIsComplete,
	dmVolumeScript,
	iptablesRules,
	netemParameters,
	netemScript,
	PROFILE_SPECS,
	parseCounters,
	parseNetemStats,
	profileCoverage,
} from "../distributed/harness/chaos.mjs";
import { CHAOS_PROFILES } from "../distributed/harness/config.mjs";
import { isDistributedFaultError, rehydrateDistributedError } from "../distributed/harness/errors.mjs";
import { createRandom, PRNG_NAME } from "../distributed/harness/prng.mjs";
import { exerciseProfile } from "../distributed/harness/suites.mjs";

test("every advertised chaos profile has a mechanism, an observable effect and a recovery", () => {
	assert.ok(catalogIsComplete());
	assert.deepEqual(Object.keys(PROFILE_SPECS).sort(), [...CHAOS_PROFILES].sort());
	for (const [profile, spec] of Object.entries(PROFILE_SPECS)) {
		assert.ok(["network", "process", "disk", "clock", "memory", "vm"].includes(spec.layer), profile);
		for (const field of ["mechanism", "effect", "recovery"] as const)
			assert.ok(spec[field].length > 10, `${profile} ${field}`);
	}
	assert.deepEqual(Object.fromEntries(Object.entries(PROFILE_SPECS).map(([profile, spec]) => [profile, spec.layer])), {
		partition: "network",
		sigkill: "process",
		latency: "network",
		jitter: "network",
		loss: "network",
		bandwidth: "network",
		reset: "network",
		"asymmetric-partition": "network",
		sigstop: "process",
		"clock-skew": "clock",
		"disk-full": "disk",
		"slow-disk": "disk",
		"io-error": "disk",
		oom: "memory",
		"vm-restart": "vm",
		"vm-deallocate": "vm",
		"nic-detach": "vm",
	});
});

test("iptables faults touch only the run's tagged rules, in the right directions", () => {
	const target = { dbIp: "10.60.0.10", port: 8443 };
	const full = iptablesRules("adt-x-partition", "full", target);
	assert.equal(
		full.apply,
		"sudo iptables -I OUTPUT -d 10.60.0.10/32 -p tcp --dport 8443 -m comment --comment adt-x-partition -j DROP && sudo iptables -I INPUT -s 10.60.0.10/32 -p tcp --sport 8443 -m comment --comment adt-x-partition -j DROP",
	);
	assert.equal(
		full.clear,
		"while sudo iptables -C OUTPUT -d 10.60.0.10/32 -p tcp --dport 8443 -m comment --comment adt-x-partition -j DROP 2>/dev/null; do sudo iptables -D OUTPUT -d 10.60.0.10/32 -p tcp --dport 8443 -m comment --comment adt-x-partition -j DROP; done; while sudo iptables -C INPUT -s 10.60.0.10/32 -p tcp --sport 8443 -m comment --comment adt-x-partition -j DROP 2>/dev/null; do sudo iptables -D INPUT -s 10.60.0.10/32 -p tcp --sport 8443 -m comment --comment adt-x-partition -j DROP; done",
	);
	assert.equal(
		full.counters,
		"sudo iptables -L INPUT -v -n -x | awk '/adt-x-partition/{print \"INPUT\",$1}'; sudo iptables -L OUTPUT -v -n -x | awk '/adt-x-partition/{print \"OUTPUT\",$1}'",
	);
	assert.equal(
		iptablesRules("t", "asymmetric", target).apply,
		"sudo iptables -I INPUT -s 10.60.0.10/32 -p tcp --sport 8443 -m comment --comment t -j DROP",
	);
	assert.equal(
		iptablesRules("t", "reset", target).apply,
		"sudo iptables -I OUTPUT -d 10.60.0.10/32 -p tcp --dport 8443 -m comment --comment t -j REJECT --reject-with tcp-reset",
	);
	assert.deepEqual(parseCounters("INPUT 12\nOUTPUT 3\nOUTPUT 4\n"), { INPUT: 12, OUTPUT: 7 });
	assert.deepEqual(parseCounters(""), {});
	assert.deepEqual(parseCounters("INPUT x\nOUTPUT\n  INPUT 5  "), { INPUT: 5 });
});

test("netem faults are filtered to the database flow and seeded", () => {
	assert.equal(netemParameters("latency", 1), "delay 150ms");
	assert.equal(netemParameters("jitter", 1), "delay 100ms 80ms distribution normal");
	assert.equal(netemParameters("loss", 42), "loss 20% seed 42");
	assert.equal(netemParameters("bandwidth", 1), "rate 256kbit");
	assert.throws(() => netemParameters("partition", 1), RangeError);
	const script = netemScript({ dbIp: "10.60.0.10", port: 8443, parameters: "delay 150ms" });
	const dev = "DEV=$(ip -o route get 10.60.0.10 | sed -n 's/.* dev \\([^ ]*\\).*/\\1/p')";
	assert.equal(
		script.apply,
		`${dev}; sudo tc qdisc add dev "$DEV" root handle 1: prio && sudo tc qdisc add dev "$DEV" parent 1:3 handle 30: netem delay 150ms && sudo tc filter add dev "$DEV" protocol ip parent 1:0 prio 3 u32 match ip dst 10.60.0.10/32 match ip dport 8443 0xffff flowid 1:3`,
	);
	assert.equal(
		script.clear,
		`${dev}; if sudo tc qdisc show dev "$DEV" | grep -q 'qdisc prio 1:'; then sudo tc qdisc del dev "$DEV" root; fi`,
	);
	assert.equal(script.stats, `${dev}; tc -s qdisc show dev "$DEV" parent 1:3`);
	assert.deepEqual(
		parseNetemStats(
			"qdisc netem 30: parent 1:3 limit 1000 delay 150ms\n Sent 1234 bytes 17 pkt (dropped 3, overlimits 0 requeues 0)",
		),
		{ bytes: 1234, packets: 17, dropped: 3 },
	);
	assert.equal(parseNetemStats("qdisc noqueue 0: root"), undefined);
});

test("device-mapper volumes swap linear, delay and error targets on the run's own device", () => {
	const volume = dmVolumeScript({ name: "adt-slow-disk", sizeMb: 256, user: "atomic" });
	const removal =
		'if mountpoint -q /mnt/adt-slow-disk; then sudo umount /mnt/adt-slow-disk || sudo umount -l /mnt/adt-slow-disk; fi; if sudo dmsetup info adt-slow-disk >/dev/null 2>&1; then sudo dmsetup remove --force adt-slow-disk; fi; if [ -f /var/lib/adt-disk/adt-slow-disk.loop ]; then sudo losetup -d "$(cat /var/lib/adt-disk/adt-slow-disk.loop)" 2>/dev/null || true; sudo rm -f /var/lib/adt-disk/adt-slow-disk.loop /var/lib/adt-disk/adt-slow-disk.img; fi;';
	assert.equal(volume.remove, removal);
	assert.ok(
		volume.create.startsWith(
			`${removal} sudo mkdir -p /var/lib/adt-disk /mnt/adt-slow-disk && sudo truncate -s 256M /var/lib/adt-disk/adt-slow-disk.img`,
		),
	);
	assert.ok(
		volume.create.includes(
			"| sudo dmsetup create adt-slow-disk && sudo mkfs.ext4 -q -F /dev/mapper/adt-slow-disk && sudo mount -o errors=continue /dev/mapper/adt-slow-disk /mnt/adt-slow-disk && sudo chown atomic:atomic /mnt/adt-slow-disk",
		),
	);
	assert.ok(volume.create.includes('echo "0 $(sudo blockdev --getsz "$LOOP") linear "$LOOP" 0"'));
	const prefix =
		'LOOP=$(cat /var/lib/adt-disk/adt-slow-disk.loop); S=$(sudo blockdev --getsz "$LOOP"); sudo dmsetup suspend --nolockfs --noflush adt-slow-disk && echo "';
	const suffix =
		'" | sudo dmsetup reload adt-slow-disk && sudo dmsetup resume adt-slow-disk && sudo dmsetup table adt-slow-disk';
	assert.equal(volume.swap("linear"), `${prefix}0 $S linear $LOOP 0${suffix}`);
	assert.equal(volume.swap("delay", 100), `${prefix}0 $S delay $LOOP 0 100${suffix}`);
	assert.equal(volume.swap("delay"), `${prefix}0 $S delay $LOOP 0 0${suffix}`);
	assert.equal(volume.swap("error"), `${prefix}0 $S error${suffix}`);
	assert.equal(
		volume.remount,
		'sudo umount /mnt/adt-slow-disk 2>/dev/null || sudo umount -l /mnt/adt-slow-disk || true; E=0; sudo e2fsck -fy /dev/mapper/adt-slow-disk >/dev/null 2>&1 || E=$?; M=false; if sudo mount -o errors=continue /dev/mapper/adt-slow-disk /mnt/adt-slow-disk; then M=true; fi; echo "{\\"fsck\\":$E,\\"mounted\\":$M}"',
	);
	assert.ok(volume.probe.includes("dd if=/dev/zero of=/mnt/adt-slow-disk/.probe bs=4k count=8 oflag=direct,dsync"));
});

test("a profile counts as exercised only with an observed effect and a recovery", () => {
	const base = { applied: true, effectObserved: true, recovered: true };
	const coverage = profileCoverage(
		[
			{ profile: "partition", ...base },
			{ profile: "sigkill", ...base, effectObserved: false },
			{ profile: "latency", ...base, recovered: false },
			{ profile: "loss", ...base, applied: false },
			{ profile: "oom", ...base, skipped: { code: "no-cgroup2" } },
		],
		["partition", "sigkill", "latency", "loss", "oom", "nic-detach"],
	);
	assert.deepEqual(coverage, [
		{ profile: "partition", status: "exercised" },
		{ profile: "sigkill", status: "incomplete" },
		{ profile: "latency", status: "incomplete" },
		{ profile: "loss", status: "incomplete" },
		{ profile: "oom", status: "skipped", reason: "no-cgroup2" },
		{ profile: "nic-detach", status: "missing" },
	]);
	assert.deepEqual(profileCoverage([], []), []);
});

test("the seeded PRNG replays the same choices", () => {
	assert.equal(PRNG_NAME, "mulberry32/v1");
	const first = createRandom(4331);
	const second = createRandom(4331);
	const draws = Array.from({ length: 5 }, () => first.next());
	assert.deepEqual(
		Array.from({ length: 5 }, () => second.next()),
		draws,
	);
	assert.deepEqual(draws.slice(0, 3), [0.18441753811202943, 0.8450064116623253, 0.3952915461268276]);
	assert.ok(draws.every((value) => value >= 0 && value < 1));
	assert.notEqual(createRandom(4332).next(), draws[0]);
	assert.equal(createRandom(0).next() < 1, true);
	assert.equal(createRandom(0).next(), 0.26642920868471265);
	assert.equal(createRandom(4331).next(), draws[0]);
	const random = createRandom(7);
	const picks = Array.from({ length: 200 }, () => random.pick(["a", "b", "c"]));
	assert.deepEqual([...new Set(picks)].sort(), ["a", "b", "c"]);
	const integers = Array.from({ length: 500 }, () => createRandom(9).integer(3, 5));
	assert.ok(integers.every((value) => value === integers[0]));
	const spread = createRandom(11);
	const values = Array.from({ length: 500 }, () => spread.integer(3, 5));
	assert.deepEqual([...new Set(values)].sort(), [3, 4, 5]);
	assert.throws(() => createRandom(1).pick([]), RangeError);
	assert.equal(createRandom(2 ** 32 + 5).next(), createRandom(5).next());
});

test("counter, netem and catalog parsing edge cases", () => {
	assert.deepEqual(parseCounters("\n  INPUT    12  \nOUTPUT 3x\nOUTPUT\nFORWARD 4 extra\n"), { INPUT: 12 });
	assert.throws(() => netemParameters("partition", 1), {
		name: "RangeError",
		message: "partition is not a netem profile",
	});
	assert.deepEqual(parseNetemStats(" Sent 9 bytes 2 pkt (dropped 56, overlimits 0 requeues 0)"), {
		bytes: 9,
		packets: 2,
		dropped: 56,
	});
	const spec = { layer: "network" as const, mechanism: "m", effect: "e", recovery: "r" };
	assert.equal(catalogIsComplete({ a: spec, b: spec }, ["a", "b"]), true);
	assert.equal(catalogIsComplete({ a: spec }, ["a", "b"]), false);
	assert.equal(catalogIsComplete({ a: spec, c: spec }, ["a", "b"]), false);
	assert.equal(catalogIsComplete({ a: spec, b: spec, c: spec }, ["a", "b"]), false);
	assert.throws(() => createRandom(1).pick([]), { name: "RangeError", message: "pick needs at least one item" });
});

test("counter lines must start with the chain name", () => {
	assert.deepEqual(parseCounters("junk OUTPUT 5\nINPUT 2"), { INPUT: 2 });
});

type FaultRecord = NonNullable<Awaited<ReturnType<typeof exerciseProfile>>>;
type Step = (fault: FaultRecord, mark: (event: string) => void) => Promise<void>;

/** Runs one profile with steps that record their order and fail where asked. */
const exercised = async (
	failures: Partial<Record<"apply" | "applyAfterInjecting" | "revert" | "recover" | "cleanup", unknown>> = {},
	options: { profiles?: readonly string[]; signal?: AbortSignal; withoutRevert?: boolean } = {},
) => {
	const calls: string[] = [];
	const logged: string[] = [];
	const faults: FaultRecord[] = [];
	const step =
		(name: "revert" | "recover" | "cleanup"): Step =>
		async (fault, mark) => {
			calls.push(name);
			mark(name);
			if (name === "recover") fault.recovered = true;
			if (failures[name] !== undefined) throw failures[name];
		};
	const record = await exerciseProfile(
		{
			profiles: options.profiles ?? ["partition"],
			faults,
			started: performance.now(),
			log: (line) => logged.push(line),
			...(options.signal === undefined ? {} : { signal: options.signal }),
		},
		{
			profile: "partition",
			target: "n1",
			parameters: { windowMs: 20_000 },
			apply: async (fault, mark) => {
				calls.push("apply");
				if (failures.apply !== undefined) throw failures.apply;
				fault.applied = true;
				mark("applied");
				if (failures.applyAfterInjecting !== undefined) throw failures.applyAfterInjecting;
				fault.effectObserved = true;
			},
			...(options.withoutRevert === true ? {} : { revert: step("revert") }),
			recover: step("recover"),
			cleanup: step("cleanup"),
		},
	);
	return { record, calls, logged, faults };
};

test("a profile applies, reverts, recovers and cleans up in that order, recording each step (#4331)", async () => {
	const { record, calls, logged, faults } = await exercised();
	assert.deepEqual(calls, ["apply", "revert", "recover", "cleanup"]);
	assert.deepEqual(faults, [record]);
	assert.deepEqual(
		{ ...record, timeline: undefined },
		{
			profile: "partition",
			target: "n1",
			parameters: { windowMs: 20_000 },
			applied: true,
			effectObserved: true,
			recovered: true,
			observed: {},
			timeline: undefined,
		},
	);
	assert.deepEqual(
		record?.timeline.map((entry) => entry.event),
		["begin", "applied", "revert", "recover", "cleanup", "end"],
	);
	assert.ok(record?.timeline.every((entry) => Number.isInteger(entry.at) && entry.at >= 0 && entry.at < 10_000));
	assert.deepEqual(logged, [
		"partition: begin",
		"partition: applied",
		"partition: revert",
		"partition: recover",
		"partition: cleanup",
		"partition: end",
	]);
	const skipped = await exercised({}, { profiles: ["sigkill"] });
	assert.equal(skipped.record, undefined);
	assert.deepEqual([skipped.calls, skipped.faults, skipped.logged], [[], [], []]);
	const unreverted = await exercised({}, { withoutRevert: true });
	assert.deepEqual(unreverted.calls, ["apply", "recover", "cleanup"]);
});

test("a fault is reverted whenever it was injected, even when observing it failed (#4331)", async () => {
	const observing = new Error("counters unreadable");
	const { record, calls } = await exercised({ applyAfterInjecting: observing });
	assert.deepEqual(calls, ["apply", "revert", "cleanup"]);
	assert.deepEqual([record?.applied, record?.effectObserved, record?.recovered], [true, false, false]);
	const error = rehydrateDistributedError(record?.error as NonNullable<FaultRecord["error"]>);
	assert.ok(isDistributedFaultError(error));
	assert.deepEqual(Reflect.get(error, "fields"), { profile: "partition", stage: "observe", target: "n1", detail: "" });
	assert.equal((error.cause as Error).message, "counters unreadable");
	assert.equal(record?.timeline.at(-1)?.event, `failed: ${error.message}`);
	assert.ok(!record?.timeline.some((entry) => entry.event === "end"));
});

test("a fault is reverted once its injection started, even when the injecting command itself failed (#4331)", async () => {
	const calls: string[] = [];
	const faults: FaultRecord[] = [];
	const record = await exerciseProfile(
		{ profiles: ["nic-detach"], faults, started: performance.now(), log: () => {} },
		{
			profile: "nic-detach",
			target: "n3",
			parameters: {},
			apply: async (fault, _mark, injecting) => {
				fault.observed = { nicsBefore: 2 };
				injecting();
				calls.push("deallocate");
				throw new Error("nic remove failed");
			},
			revert: async (fault) => {
				calls.push(`revert with ${String(fault.observed.nicsBefore)} NICs`);
			},
			recover: async () => void calls.push("recover"),
			cleanup: async () => void calls.push("cleanup"),
		},
	);
	assert.deepEqual(calls, ["deallocate", "revert with 2 NICs", "cleanup"]);
	assert.equal(record?.applied, false);
	assert.equal(Reflect.get(record?.error?.fields ?? {}, "stage"), "apply");
	assert.equal(record?.error?.cause?.message, "nic remove failed");
});

test("a fault that was never injected is not reverted, and cleanup still runs (#4331)", async () => {
	const { record, calls } = await exercised({ apply: new Error("iptables missing") });
	assert.deepEqual(calls, ["apply", "cleanup"]);
	assert.equal(Reflect.get(record?.error?.fields ?? {}, "stage"), "apply");
	assert.deepEqual([record?.applied, record?.effectObserved, record?.recovered], [false, false, false]);
	assert.equal(record?.error?.cause?.message, "iptables missing");
	assert.equal(record?.error?.cause?.cleanupCause, undefined);
});

test("revert and recovery failures are recorded at the recover stage, and later failures never replace the first", async () => {
	const revertFailure = new Error("rule still present");
	const reverted = await exercised({ revert: revertFailure });
	assert.deepEqual(reverted.calls, ["apply", "revert", "cleanup"]);
	assert.equal(Reflect.get(reverted.record?.error?.fields ?? {}, "stage"), "recover");
	assert.equal(reverted.record?.error?.cause?.message, "rule still present");
	const recovering = await exercised({ recover: new Error("acks did not resume") });
	assert.deepEqual(recovering.calls, ["apply", "revert", "recover", "cleanup"]);
	assert.equal(Reflect.get(recovering.record?.error?.fields ?? {}, "stage"), "recover");
	const cleaning = await exercised({ cleanup: new Error("volume busy") });
	assert.equal(Reflect.get(cleaning.record?.error?.fields ?? {}, "stage"), "recover");
	assert.equal(cleaning.record?.error?.cause?.message, "volume busy");
	const observing = new Error("observe failed");
	const both = await exercised({
		applyAfterInjecting: observing,
		revert: new Error("revert failed"),
		cleanup: "cleanup failed",
	});
	assert.deepEqual(both.calls, ["apply", "revert", "cleanup"]);
	assert.equal(Reflect.get(both.record?.error?.fields ?? {}, "stage"), "observe");
	assert.equal(both.record?.error?.cause?.message, "observe failed");
	const later = both.record?.error?.cause?.cleanupCause;
	assert.deepEqual([later?.name, later?.message], ["AggregateError", "2 later steps of partition failed"]);
	assert.deepEqual(
		later?.errors?.map((item) => item.message),
		["revert failed", "cleanup failed"],
	);
	const one = await exercised({ applyAfterInjecting: observing, revert: new Error("only revert failed") });
	assert.equal(one.record?.error?.cause?.cleanupCause?.message, "only revert failed");
});

test("a cancellation still reverts and cleans up, then propagates as the cancellation", async () => {
	const controller = new AbortController();
	const reason = new Error("operator stopped the run");
	controller.abort(reason);
	let thrown: unknown;
	const faults: FaultRecord[] = [];
	const calls: string[] = [];
	try {
		await exerciseProfile(
			{ profiles: ["partition"], faults, started: performance.now(), log: () => {}, signal: controller.signal },
			{
				profile: "partition",
				target: "n1",
				parameters: {},
				apply: async (fault) => {
					fault.applied = true;
					throw reason;
				},
				revert: async () => void calls.push("revert"),
				recover: async () => void calls.push("recover"),
				cleanup: async () => void calls.push("cleanup"),
			},
		);
	} catch (error) {
		thrown = error;
	}
	assert.equal(thrown, reason);
	assert.deepEqual(calls, ["revert", "cleanup"]);
	assert.equal(faults[0]?.error, undefined);
	const unsignalled = await exercised({ applyAfterInjecting: reason });
	assert.equal(Reflect.get(unsignalled.record?.error?.fields ?? {}, "stage"), "observe");
	const abort = new DOMException("stop", "AbortError");
	const recorded: FaultRecord[] = [];
	await assert.rejects(
		exerciseProfile(
			{ profiles: ["partition"], faults: recorded, started: performance.now(), log: () => {} },
			{
				profile: "partition",
				target: "n1",
				parameters: {},
				apply: async () => {
					throw new Error("iptables missing");
				},
				cleanup: async () => {
					throw abort;
				},
			},
		),
		(error) => error === abort,
	);
	assert.equal(Reflect.get(recorded[0]?.error?.fields ?? {}, "stage"), "apply");
	assert.equal(recorded[0]?.error?.cause?.cleanupCause?.name, "AbortError");
	assert.match(String(recorded[0]?.timeline.at(-1)?.event), /^failed: Chaos profile partition could not apply on n1/);
	await assert.rejects(
		exerciseProfile(
			{ profiles: ["partition"], faults: [], started: performance.now(), log: () => {} },
			{
				profile: "partition",
				target: "n1",
				parameters: {},
				apply: async (fault) => {
					fault.applied = true;
				},
				revert: async () => {
					throw abort;
				},
				cleanup: async () => void calls.push("cleanup after abort"),
			},
		),
		(error) => error === abort,
	);
	assert.equal(calls.at(-1), "cleanup after abort");
});

test("the artifact build fetches exactly the requested commit, builds it and prints the tarball digest last", () => {
	const sha = "0123456789abcdef0123456789abcdef01234567";
	assert.equal(ARTIFACT_REMOTE_DIR, "/tmp/atomic-distributed-test-build");
	const script = artifactBuildScript({
		sha,
		repository: "https://github.com/example/atomic.git",
		nodeVersion: "v24.22.0",
		bunVersion: "1.4.4",
	});
	assert.deepEqual(script.split("\n"), [
		"set -euo pipefail",
		"if ! command -v cc >/dev/null || ! command -v zstd >/dev/null; then sudo apt-get update -qq >/dev/null && sudo apt-get install -y -qq build-essential pkg-config unzip zstd git >/dev/null; fi",
		'export PATH="$HOME/.local/node/bin:$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"',
		'if [ "$(node --version 2>/dev/null)" != "v24.22.0" ]; then mkdir -p "$HOME/.local/node" && curl -fsSL https://nodejs.org/dist/v24.22.0/node-v24.22.0-linux-x64.tar.xz | tar -xJ -C "$HOME/.local/node" --strip-components=1; fi',
		'if [ "$(bun --version 2>/dev/null)" != "1.4.4" ]; then curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.4" >/dev/null; fi',
		"if ! command -v cargo >/dev/null; then curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable >/dev/null; fi",
		"rm -rf /tmp/atomic-distributed-test-build && mkdir -p /tmp/atomic-distributed-test-build/atomic && cd /tmp/atomic-distributed-test-build/atomic",
		"git init -q . && git remote add origin https://github.com/example/atomic.git",
		`git fetch -q --depth 1 origin ${sha} && git checkout -q FETCH_HEAD`,
		`test "$(git rev-parse HEAD)" = "${sha}"`,
		"npm ci --ignore-scripts --no-audit --no-fund >/tmp/adt-npm-ci.log 2>&1 || { tail -40 /tmp/adt-npm-ci.log; exit 1; }",
		"npm run build >/tmp/adt-build.log 2>&1 || { tail -60 /tmp/adt-build.log; exit 1; }",
		`printf '{"sha":"%s","node":"%s","builtAt":"%s"}\\n' ${sha} "$(node --version)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > .atomic-distributed-artifact.json`,
		"rm -rf .git",
		"find . -type d -name target -prune -path '*/crates/*' -exec rm -rf {} + 2>/dev/null || true",
		"rm -rf target packages/natives/target",
		"cd /tmp/atomic-distributed-test-build && tar -I 'zstd -T0 -6' -cf atomic.tar.zst atomic",
		"sha256sum /tmp/atomic-distributed-test-build/atomic.tar.zst | cut -d' ' -f1",
	]);
	assert.equal(
		artifactBuildScript({
			sha,
			repository: "https://example.com/a b.git; rm -rf ~",
			nodeVersion: "v24.22.0",
			bunVersion: "1.4.4",
		}).split("\n")[7],
		"git init -q . && git remote add origin 'https://example.com/a b.git; rm -rf ~'",
	);
	for (const ref of ["main", sha.toUpperCase(), sha.slice(1), `${sha}0`, `x${sha}`, `${sha}x`, `${sha};rm -rf /`]) {
		assert.throws(
			() => artifactBuildScript({ sha: ref, repository: "r", nodeVersion: "v", bunVersion: "b" }),
			(error) =>
				error instanceof TypeError && error.message === "artifactBuildScript needs a full lowercase commit SHA",
			ref,
		);
	}
});
