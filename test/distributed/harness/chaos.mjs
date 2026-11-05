// @ts-check
/**
 * The chaos plane's catalog and command builders, as pure functions. Each profile names its mechanism, the effect
 * that must be observed before it counts, and how it is reverted. Builders return shell scripts that touch only
 * objects owned by the run: iptables rules carrying the run's comment, a prio/netem qdisc filtered to the database
 * address and port, device-mapper targets named for the run, and a cgroup of the run's own.
 */
import { CHAOS_PROFILES } from "./config.mjs";

/**
 * @typedef {{ layer: "network" | "process" | "disk" | "clock" | "memory" | "vm", mechanism: string, effect: string, recovery: string }} ProfileSpec
 */

/** @type {Readonly<Record<string, ProfileSpec>>} */
export const PROFILE_SPECS = Object.freeze({
	partition: {
		layer: "network",
		mechanism: "iptables DROP in both directions between a node and the database gateway",
		effect: "drop counters rise and no checkpoint is acknowledged during the window",
		recovery: "delete the run's rules; acknowledgements resume",
	},
	sigkill: {
		layer: "process",
		mechanism: "SIGKILL of the run-owned writer unit",
		effect: "the unit's main process is gone with result 'signal'",
		recovery: "a replacement on another node takes the expired lease over at the next epoch",
	},
	latency: {
		layer: "network",
		mechanism: "tc prio + netem delay on traffic to the database gateway",
		effect: "median append latency rises by at least half the configured delay",
		recovery: "delete the run's qdisc",
	},
	jitter: {
		layer: "network",
		mechanism: "tc netem delay with normal-distributed jitter",
		effect: "append latency spread widens",
		recovery: "delete the run's qdisc",
	},
	loss: {
		layer: "network",
		mechanism: "tc netem random loss with the run seed",
		effect: "netem drop counter is non-zero",
		recovery: "delete the run's qdisc",
	},
	bandwidth: {
		layer: "network",
		mechanism: "tc netem rate limit",
		effect: "netem reports the configured rate and traffic passed through it",
		recovery: "delete the run's qdisc",
	},
	reset: {
		layer: "network",
		mechanism: "iptables REJECT --reject-with tcp-reset towards the gateway",
		effect: "reject counters rise and the writer records connection failures",
		recovery: "delete the run's rules",
	},
	"asymmetric-partition": {
		layer: "network",
		mechanism: "iptables DROP of gateway responses only",
		effect: "the node's INPUT rule drops packets while the gateway keeps receiving requests",
		recovery: "delete the run's rule; replays of the same key return 'exists'",
	},
	sigstop: {
		layer: "process",
		mechanism: "SIGSTOP of the writer, a takeover elsewhere, then SIGCONT",
		effect: "process state 'T' and a takeover at the next epoch",
		recovery: "after SIGCONT the stale writer is fenced with StaleLeaseError",
	},
	"clock-skew": {
		layer: "clock",
		mechanism: "chrony stopped and the node clock stepped forward",
		effect: "the node's wall clock differs from the controller's by the offset",
		recovery: "clock stepped back and chrony restarted; a skewed node never took a live lease",
	},
	"disk-full": {
		layer: "disk",
		mechanism: "loop-mounted ext4 filled with a filler file",
		effect: "local journal appends fail and the filesystem has no free blocks",
		recovery: "delete the filler; appends resume and integrity_check is ok",
	},
	"slow-disk": {
		layer: "disk",
		mechanism: "dm-delay target swapped in under the local journal's filesystem",
		effect: "synchronous direct writes take at least the configured delay",
		recovery: "swap the linear target back",
	},
	"io-error": {
		layer: "disk",
		mechanism: "dm-error target swapped in under the local journal's filesystem",
		effect: "direct writes fail with EIO",
		recovery:
			"linear target restored, filesystem checked and remounted; every checkpoint acknowledged before the fault survives",
	},
	oom: {
		layer: "memory",
		mechanism: "writer in a cgroup v2 with memory.max and no swap, then allocating",
		effect: "memory.events oom_kill counter is at least 1",
		recovery: "a replacement outside the cgroup takes the lease over",
	},
	"vm-restart": {
		layer: "vm",
		mechanism: "az vm restart",
		effect: "boot id changes and the writer unit is gone",
		recovery: "SSH returns; a replacement takes the lease over",
	},
	"vm-deallocate": {
		layer: "vm",
		mechanism: "az vm deallocate, then az vm start",
		effect: "power state 'VM deallocated' and a new boot id",
		recovery: "the node returns and writes again",
	},
	"nic-detach": {
		layer: "vm",
		mechanism: "deallocate, az vm nic remove of the secondary NIC, start; later re-add",
		effect: "the VM runs with one NIC fewer, then with it again",
		recovery: "the node writes with the NIC removed and after it is restored",
	},
});

/**
 * @param {string} tag
 * @param {"full" | "asymmetric" | "reset"} kind
 * @param {{ dbIp: string, port: number }} target
 */
export function iptablesRules(tag, kind, { dbIp, port }) {
	const out = `OUTPUT -d ${dbIp}/32 -p tcp --dport ${port} -m comment --comment ${tag}`;
	const inbound = `INPUT -s ${dbIp}/32 -p tcp --sport ${port} -m comment --comment ${tag}`;
	/** @type {string[]} */
	const rules =
		kind === "full"
			? [`${out} -j DROP`, `${inbound} -j DROP`]
			: kind === "asymmetric"
				? [`${inbound} -j DROP`]
				: [`${out} -j REJECT --reject-with tcp-reset`];
	return {
		apply: rules.map((rule) => `sudo iptables -I ${rule}`).join(" && "),
		clear: rules
			.map((rule) => `while sudo iptables -C ${rule} 2>/dev/null; do sudo iptables -D ${rule}; done`)
			.join("; "),
		counters: `sudo iptables -L INPUT -v -n -x | awk '/${tag}/{print "INPUT",$1}'; sudo iptables -L OUTPUT -v -n -x | awk '/${tag}/{print "OUTPUT",$1}'`,
	};
}

/**
 * Parses `counters` output into packet counts per chain.
 * @param {string} text
 */
export function parseCounters(text) {
	/** @type {Record<string, number>} */
	const counts = {};
	for (const line of text.split("\n")) {
		const match = /^\s*(\S+)\s+(\d+)\s*$/.exec(line);
		if (match !== null) counts[match[1]] = (counts[match[1]] ?? 0) + Number(match[2]);
	}
	return counts;
}

/**
 * netem parameters for a network profile; `seed` makes random loss reproducible.
 * @param {string} profile
 * @param {number} seed
 */
export function netemParameters(profile, seed) {
	switch (profile) {
		case "latency":
			return "delay 150ms";
		case "jitter":
			return "delay 100ms 80ms distribution normal";
		case "loss":
			return `loss 20% seed ${seed}`;
		case "bandwidth":
			return "rate 256kbit";
		default:
			throw new RangeError(`${profile} is not a netem profile`);
	}
}

/**
 * A prio qdisc whose third band carries a netem qdisc, with a filter sending only traffic to the database gateway
 * through it, so SSH and every other flow are untouched.
 * @param {{ dbIp: string, port: number, parameters: string }} input
 */
export function netemScript({ dbIp, port, parameters }) {
	const dev = `DEV=$(ip -o route get ${dbIp} | sed -n 's/.* dev \\([^ ]*\\).*/\\1/p')`;
	return {
		apply: `${dev}; sudo tc qdisc add dev "$DEV" root handle 1: prio && sudo tc qdisc add dev "$DEV" parent 1:3 handle 30: netem ${parameters} && sudo tc filter add dev "$DEV" protocol ip parent 1:0 prio 3 u32 match ip dst ${dbIp}/32 match ip dport ${port} 0xffff flowid 1:3`,
		clear: `${dev}; if sudo tc qdisc show dev "$DEV" | grep -q 'qdisc prio 1:'; then sudo tc qdisc del dev "$DEV" root; fi`,
		stats: `${dev}; tc -s qdisc show dev "$DEV" parent 1:3`,
	};
}

/**
 * Sent packets and drops from `tc -s qdisc` output for the netem qdisc.
 * @param {string} text
 */
export function parseNetemStats(text) {
	const sent = /Sent (\d+) bytes (\d+) pkt \(dropped (\d+)/.exec(text);
	return sent === null ? undefined : { bytes: Number(sent[1]), packets: Number(sent[2]), dropped: Number(sent[3]) };
}

/**
 * A loop-backed device-mapper volume mounted at `/mnt/<name>`; its table can be swapped for delay or error.
 * @param {{ name: string, sizeMb: number, user: string }} input
 */
export function dmVolumeScript({ name, sizeMb, user }) {
	const table = `0 $(sudo blockdev --getsz "$LOOP") linear "$LOOP" 0`;
	const removal = `if mountpoint -q /mnt/${name}; then sudo umount /mnt/${name} || sudo umount -l /mnt/${name}; fi; if sudo dmsetup info ${name} >/dev/null 2>&1; then sudo dmsetup remove --force ${name}; fi; if [ -f /var/lib/adt-disk/${name}.loop ]; then sudo losetup -d "$(cat /var/lib/adt-disk/${name}.loop)" 2>/dev/null || true; sudo rm -f /var/lib/adt-disk/${name}.loop /var/lib/adt-disk/${name}.img; fi;`;
	return {
		create: `${removal} sudo mkdir -p /var/lib/adt-disk /mnt/${name} && sudo truncate -s ${sizeMb}M /var/lib/adt-disk/${name}.img && LOOP=$(sudo losetup -f --show /var/lib/adt-disk/${name}.img) && echo "${table}" | sudo dmsetup create ${name} && sudo mkfs.ext4 -q -F /dev/mapper/${name} && sudo mount -o errors=continue /dev/mapper/${name} /mnt/${name} && sudo chown ${user}:${user} /mnt/${name} && echo "$LOOP" | sudo tee /var/lib/adt-disk/${name}.loop >/dev/null`,
		/** @param {"linear" | "delay" | "error"} target @param {number} [delayMs] */
		swap: (target, delayMs = 0) => {
			const line =
				target === "linear"
					? `0 $S linear $LOOP 0`
					: target === "delay"
						? `0 $S delay $LOOP 0 ${delayMs}`
						: `0 $S error`;
			return `LOOP=$(cat /var/lib/adt-disk/${name}.loop); S=$(sudo blockdev --getsz "$LOOP"); sudo dmsetup suspend --nolockfs --noflush ${name} && echo "${line}" | sudo dmsetup reload ${name} && sudo dmsetup resume ${name} && sudo dmsetup table ${name}`;
		},
		remount: `sudo umount /mnt/${name} 2>/dev/null || sudo umount -l /mnt/${name} || true; E=0; sudo e2fsck -fy /dev/mapper/${name} >/dev/null 2>&1 || E=$?; M=false; if sudo mount -o errors=continue /dev/mapper/${name} /mnt/${name}; then M=true; fi; echo "{\\"fsck\\":$E,\\"mounted\\":$M}"`,
		remove: removal,
		probe: `S=$(date +%s%N); if dd if=/dev/zero of=/mnt/${name}/.probe bs=4k count=8 oflag=direct,dsync 2>/tmp/${name}.dd; then R=ok; else R=$(grep -o 'Input/output error\\|No space left on device' /tmp/${name}.dd | head -1); fi; E=$(date +%s%N); rm -f /mnt/${name}/.probe; echo "{\\"result\\":\\"$R\\",\\"ms\\":$(( (E - S) / 1000000 ))}"`,
	};
}

/**
 * @param {readonly { profile: string, applied: boolean, effectObserved: boolean, recovered: boolean, skipped?: { code: string } }[]} results
 * @param {readonly string[]} selected
 */
export function profileCoverage(results, selected) {
	return selected.map((profile) => {
		const result = results.find((item) => item.profile === profile);
		if (result === undefined) return { profile, status: /** @type {const} */ ("missing") };
		if (result.skipped !== undefined)
			return { profile, status: /** @type {const} */ ("skipped"), reason: result.skipped.code };
		return {
			profile,
			status:
				result.applied && result.effectObserved && result.recovered
					? /** @type {const} */ ("exercised")
					: /** @type {const} */ ("incomplete"),
		};
	});
}

/**
 * Whether every profile the CLI accepts has a spec, and nothing else does.
 * @param {Readonly<Record<string, ProfileSpec>>} [specs]
 * @param {readonly string[]} [profiles]
 */
export function catalogIsComplete(specs = PROFILE_SPECS, profiles = CHAOS_PROFILES) {
	const specified = Object.keys(specs);
	return specified.length === profiles.length && profiles.every((profile) => specified.includes(profile));
}
