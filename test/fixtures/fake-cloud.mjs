// The state behind the fake `az`, `kubectl` and provisioner command CLIs of the provisioner conformance suite (#4768).
// Each CLI call is its own process: it takes a lock, reads `state.json` from FAKE_CLOUD_DIR, acts, writes it back, and
// appends its argv to `calls.jsonl`. A new host is pending until a list reported it once, and running at the next list.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmdirSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.FAKE_CLOUD_DIR;
if (!dir) throw new Error("FAKE_CLOUD_DIR is not set");
const statePath = join(dir, "state.json");
const lockPath = join(dir, "state.lock");

/** Every host's states: `creating` until a list saw it, then `running`; `deleting` until a list saw it, then gone. */
export function readState() {
	return JSON.parse(readFileSync(statePath, "utf8"));
}

function lock() {
	const deadline = Date.now() + 10_000;
	for (;;) {
		try {
			mkdirSync(lockPath);
			return;
		} catch (error) {
			if (error.code !== "EEXIST" || Date.now() > deadline) throw error;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
		}
	}
}

/** Runs `act` on the state under the lock and saves what it leaves. */
export function update(act) {
	lock();
	try {
		const state = readState();
		const result = act(state);
		writeFileSync(statePath, JSON.stringify(state));
		return result;
	} finally {
		rmdirSync(lockPath);
	}
}

/** Records this call, then answers the modes every CLI shares: `hang`, `auth` and `malformed`. */
export function begin(args, authMessage) {
	appendFileSync(join(dir, "calls.jsonl"), `${JSON.stringify(args)}\n`);
	const { mode } = readState();
	if (mode === "hang") {
		// A grandchild holds stdout open too, as a CLI's interpreter does: stopping the CLI must stop both.
		const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });
		appendFileSync(join(dir, "hung.jsonl"), `${JSON.stringify([process.pid, grandchild.pid])}\n`);
		setInterval(() => {}, 1000);
		return false;
	}
	if (mode === "auth") {
		fail(authMessage);
	}
	if (mode === "malformed") {
		writeSync(1, '{"items": [ {"metadata": ');
		process.exit(0);
	}
	return true;
}

/** The hosts the provider counts: not deleting, and not a pod that already ended (an evicted pod is replaced). */
export function active(state) {
	return state.hosts.filter(
		(host) => host.phase !== "deleting" && host.podPhase !== "Failed" && host.podPhase !== "Succeeded",
	);
}

/** A host's id: a scale set's instance id, a ReplicaSet pod's name, a StatefulSet pod's ordinal name, or a script's id. */
function nameOf(state, n) {
	if (state.kind === "vmss") return String(n);
	if (state.kind === "deployment") return `atomic-worker-7d9c-${(n * 7919).toString(36).padStart(5, "q")}`;
	if (state.kind === "statefulset") return `atomic-worker-${n}`;
	return `host-${n}`;
}

/** Adds one host: a StatefulSet takes the lowest free ordinal, anything else the next number. */
export function create(state) {
	const taken = new Set(active(state).map((host) => host.n));
	let n = state.nextId++;
	if (state.kind === "statefulset") for (n = 0; taken.has(n); n++);
	state.hosts.push({ id: nameOf(state, n), n, phase: "creating", seen: false, created: Date.now() });
}

/**
 * Sets the count of hosts that are not deleting to `target`. Scaling in removes what the real controller would: a
 * ReplicaSet its pending pods first, then the newest; a StatefulSet or a scale set its highest-numbered hosts.
 */
export function scale(state, target) {
	for (let count = active(state).length; count < target; count++) create(state);
	const order =
		state.kind === "deployment"
			? (a, b) => (b.phase === "creating") - (a.phase === "creating") || b.n - a.n
			: (a, b) => b.n - a.n;
	const current = active(state).toSorted(order);
	for (const host of current.slice(0, Math.max(0, current.length - target))) host.phase = "deleting";
}

export function remove(state, id) {
	for (const host of state.hosts) if (host.id === id && host.phase !== "deleting") host.phase = "deleting";
}

/** One list: hosts seen pending become running, deleting ones seen already are gone; then it reports and marks seen. */
export function observe(state) {
	state.hosts = state.hosts.filter((host) => !(host.phase === "deleting" && host.seen));
	for (const host of state.hosts) if (host.phase === "creating" && host.seen) host.phase = "running";
	const snapshot = state.hosts.map((host) => ({ ...host }));
	for (const host of state.hosts) host.seen = true;
	return snapshot;
}

/** Exits with `code` after writing `message` to stderr. Never call it under {@link update}'s lock. */
export function fail(message, code = 1) {
	writeSync(2, `${message}\n`);
	process.exit(code);
}

/** The value after `flag` in `args`, or `flag=value`. */
export function option(args, flag) {
	const index = args.indexOf(flag);
	if (index >= 0) return args[index + 1];
	const joined = args.find((arg) => arg.startsWith(`${flag}=`));
	return joined?.slice(flag.length + 1);
}
