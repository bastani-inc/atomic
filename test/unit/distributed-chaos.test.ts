import assert from "node:assert/strict";
import { test } from "vitest";
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
import { createRandom, PRNG_NAME } from "../distributed/harness/prng.mjs";

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
