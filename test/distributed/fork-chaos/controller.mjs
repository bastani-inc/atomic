#!/usr/bin/env node
/**
 * Controller of the distributed fork chaos scenario (#4321). Runs on the control host and drives every test VM over SSH to
 * private IPs: seeds source runs, runs forkers on every worker, injects faults phase by phase, heals, waits for
 * convergence, runs the node-local SQLite scenario and the invariant checker, and writes results.json.
 *
 *   RUN_ID=<id> ARTIFACT_DIR=<dir> node test/distributed/fork-chaos/controller.mjs
 *
 * Phase lengths scale with PHASE_SCALE (default 1). No secret is read here: the token stays in its mode-600 files.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertChaosInvariants, assertLocalSqliteReport, findChaosInvariantError } from "./verdict.mjs";

const runId = process.env.RUN_ID;
if (!runId) throw new Error("set RUN_ID");
const stateDir = process.env.STATE_DIR ?? join(homedir(), ".fork-chaos", runId);
const artifactDir = process.env.ARTIFACT_DIR ?? join(stateDir, "artifacts");
const scale = Number(process.env.PHASE_SCALE ?? "1");
const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(artifactDir, "raw"), { recursive: true });
const manifest = JSON.parse(readFileSync(join(stateDir, "manifest.json"), "utf8"));
const nodes = Object.fromEntries(manifest.nodes.map((node) => [node.name, node]));
const workers = manifest.nodes.filter((node) => node.role === "worker").map((node) => node.name);
const sqldIp = nodes.sqld.ip;
const sshOptions = [
	"-i",
	join(stateDir, "ssh_key"),
	"-o",
	"StrictHostKeyChecking=accept-new",
	"-o",
	`UserKnownHostsFile=${join(stateDir, "known_hosts")}`,
	"-o",
	"ConnectTimeout=15",
	"-o",
	"ServerAliveInterval=15",
	"-o",
	"BatchMode=yes",
	"-o",
	"LogLevel=ERROR",
];
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const seconds = (value) => Math.round(value * 1000 * scale);
const random = (low, high) => low + Math.random() * (high - low);

const timeline = { runId, startedAt: Date.now(), events: [], stops: [], phases: [] };
function record(action, details = {}) {
	const event = { at: Date.now(), iso: new Date().toISOString(), action, ...details };
	timeline.events.push(event);
	writeFileSync(join(artifactDir, "timeline.json"), JSON.stringify(timeline, null, 2));
	console.log(`${event.iso} ${action} ${JSON.stringify(details)}`);
}

function exec(command, args, { input, timeoutMs = 600_000, binary = false } = {}) {
	return new Promise((resolve) => {
		const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
		const out = [];
		const err = [];
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.stdout.on("data", (chunk) => out.push(chunk));
		child.stderr.on("data", (chunk) => err.push(chunk));
		child.on("close", (code) => {
			clearTimeout(timer);
			const stdout = Buffer.concat(out);
			resolve({ code, stdout: binary ? stdout : stdout.toString(), stderr: Buffer.concat(err).toString() });
		});
		child.stdin.end(input ?? "");
	});
}

/** Runs a bash script on a node; the script travels on stdin, never on a command line. */
const ssh = (node, script, options) =>
	exec("ssh", [...sshOptions, `azureuser@${nodes[node].ip}`, "bash -s"], { ...options, input: script });

async function sshOk(node, script, options) {
	const result = await ssh(node, script, options);
	if (result.code !== 0) throw new Error(`${node}: exit ${result.code}: ${result.stderr.slice(-800)}`);
	return result.stdout;
}

const env = "source /opt/fork-chaos/env; cd /opt/fork-chaos/repo";
const state = "/opt/fork-chaos/state";

async function writeControl(node, control, file = "control.json") {
	await sshOk(node, `cat > ${state}/${file}.tmp <<'JSON'\n${JSON.stringify(control)}\nJSON\nmv ${state}/${file}.tmp ${state}/${file}`);
}

let baseControl;
const controls = {};
async function setControl(nodesToSet, patch) {
	await Promise.all(
		nodesToSet.map(async (node) => {
			controls[node] = { ...(controls[node] ?? baseControl), ...patch };
			await writeControl(node, controls[node]);
		}),
	);
}

async function pushScenarioFiles() {
	const tar = await exec("tar", ["-C", join(here, "../../.."), "-czf", "-", "test/distributed/fork-chaos"], { binary: true });
	await Promise.all(
		workers.map((node) =>
			exec("ssh", [...sshOptions, `azureuser@${nodes[node].ip}`, "tar -xzf - -C /opt/fork-chaos/repo"], { input: tar.stdout }),
		),
	);
}

async function startForker(node) {
	await sshOk(node, `setsid nohup bash /opt/fork-chaos/repo/test/distributed/fork-chaos/supervise.sh >/dev/null 2>&1 < /dev/null &\nsleep 0.2`);
	record("forker-start", { node });
}

async function waitForExit(node, pattern, limitMs) {
	const deadline = Date.now() + limitMs;
	while (Date.now() < deadline) {
		const result = await ssh(node, `pgrep -f '${pattern}' >/dev/null && echo yes || echo no`);
		if (result.stdout.trim() === "no") return true;
		await sleep(5_000);
	}
	return false;
}

async function progress(label) {
	const counts = {};
	await Promise.all(
		workers.map(async (node) => {
			const result = await ssh(
				node,
				`cat ${state}/attempts-*.jsonl ${state}/stopper-*.jsonl 2>/dev/null | grep -o '"t":"[a-z-]*"' | sort | uniq -c | awk '{printf "%s=%s ", $2, $1}'`,
			);
			counts[node] = result.stdout.trim().replaceAll('"t":', "").replaceAll('"', "");
		}),
	);
	record("progress", { label, counts });
}

// --- Faults ------------------------------------------------------------------------------------------------
// The device that carries traffic to `peer`. Never resolve it with the host's own address: that route is `lo`.
const devOf = (peer) => `dev=$(ip route get ${peer} | awk '{for (i = 1; i < NF; i++) if ($i == "dev") print $(i + 1)}')`;
const defaultDev = "dev=$(ip route show default | awk '{print $5; exit}')";

async function measureConnect(node) {
	const result = await ssh(
		node,
		`for i in 1 2 3; do curl -s -o /dev/null -w '%{time_connect}\\n' --max-time 20 --cacert /opt/fork-chaos/tls/ca.crt https://${sqldIp}:8443/health || echo timeout; done`,
	);
	return result.stdout.trim().split("\n");
}

async function netem(impaired, delayMs, lossPct) {
	const jitter = Math.round(delayMs / 10);
	const qdisc = (peerFilters) =>
		`sudo tc qdisc del dev $dev root 2>/dev/null; sudo tc qdisc add dev $dev root handle 1: prio bands 3 priomap 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 && sudo tc qdisc add dev $dev parent 1:1 handle 10: netem delay ${delayMs}ms ${jitter}ms loss ${lossPct}% && ${peerFilters}`;
	const filter = (peer) => `sudo tc filter add dev $dev protocol ip parent 1:0 prio 1 u32 match ip dst ${peer}/32 flowid 1:1`;
	await Promise.all([
		...impaired.map((node) => sshOk(node, `${devOf(sqldIp)}\n${qdisc(filter(sqldIp))}`)),
		sshOk("sqld", `${devOf(nodes[impaired[0]].ip)}\n${qdisc(impaired.map((node) => filter(nodes[node].ip)).join(" && "))}`),
	]);
	const connect = await measureConnect(impaired[0]);
	record("netem", { nodes: impaired, delayMs, jitterMs: jitter, lossPct, bothDirections: true, tlsConnectSeconds: connect });
}

async function clearNetem(targets) {
	const left = await Promise.all(
		targets.map((node) => ssh(node, `${defaultDev}\nsudo tc qdisc del dev $dev root 2>/dev/null; tc qdisc show dev $dev | grep -c netem`)),
	);
	record("netem-cleared", { nodes: targets, netemQdiscsLeft: Object.fromEntries(targets.map((node, index) => [node, Number(left[index].stdout.trim())])) });
}

async function partition(node, durationMs) {
	await sshOk(node, `sudo iptables -I OUTPUT -d ${sqldIp} -j DROP && sudo iptables -I INPUT -s ${sqldIp} -j DROP`);
	const probe = await ssh(node, `curl -s -o /dev/null -w '%{http_code}' --max-time 5 --cacert /opt/fork-chaos/tls/ca.crt https://${sqldIp}:8443/health; echo " exit=$?"`);
	record("partition", { node, durationMs, probeDuringPartition: probe.stdout.trim() });
	await sleep(durationMs);
	await sshOk(node, `sudo iptables -D OUTPUT -d ${sqldIp} -j DROP; sudo iptables -D INPUT -s ${sqldIp} -j DROP; true`);
	record("partition-healed", { node });
}

async function externalKill(node) {
	const result = await ssh(node, "n=$(pgrep -f 'workload[.]ts forker' | wc -l); pkill -KILL -f 'workload[.]ts forker'; echo $n");
	record("sigkill", { node, processes: Number(result.stdout.trim()) });
}

async function skew(node, offsetSeconds) {
	const result = await sshOk(
		node,
		`sudo systemctl stop chrony chronyd systemd-timesyncd 2>/dev/null; sudo timedatectl set-ntp false 2>/dev/null; sudo date -s "@$(( $(date +%s) + (${offsetSeconds}) ))" >/dev/null; date +%s%3N`,
	);
	record("clock-skew", { node, offsetSeconds, nodeClockMs: Number(result.trim()), controllerClockMs: Date.now() });
}

async function unskew(node, offsetSeconds) {
	const result = await sshOk(
		node,
		`sudo date -s "@$(( $(date +%s) - (${offsetSeconds}) ))" >/dev/null; sudo systemctl start chrony 2>/dev/null || sudo systemctl start chronyd 2>/dev/null || sudo systemctl start systemd-timesyncd 2>/dev/null; sudo chronyc -a makestep >/dev/null 2>&1; sleep 2; date +%s%3N`,
	);
	record("clock-restored", { node, nodeClockMs: Number(result.trim()), controllerClockMs: Date.now() });
}

const dataDev = "dev=$(findmnt -no SOURCE /data)";
async function slowFsync(on) {
	if (on) {
		const result = await sshOk(
			"sqld",
			`${dataDev}\nsudo systemctl set-property --runtime sqld.service "IOWriteBandwidthMax=$dev 262144" "IOWriteIOPSMax=$dev 20" "IOReadIOPSMax=$dev 200"\ncat /sys/fs/cgroup/system.slice/sqld.service/io.max\nstart=$(date +%s%N); sudo systemd-run --quiet --wait --pipe -p "IOWriteIOPSMax=$dev 20" -p "IOWriteBandwidthMax=$dev 262144" dd if=/dev/zero of=/data/fc-probe bs=4k count=40 oflag=dsync 2>/dev/null; end=$(date +%s%N); sudo rm -f /data/fc-probe; echo "probe_ms=$(( (end - start) / 1000000 ))"`,
		);
		record("slow-fsync", { ioMax: result.trim().split("\n") });
	} else {
		const result = await sshOk(
			"sqld",
			`${dataDev}\nsudo systemctl set-property --runtime sqld.service "IOWriteBandwidthMax=" "IOWriteIOPSMax=" "IOReadIOPSMax="\ncat /sys/fs/cgroup/system.slice/sqld.service/io.max; echo cleared`,
		);
		record("slow-fsync-cleared", { ioMax: result.trim().split("\n") });
	}
}

async function diskFull(on) {
	if (on) {
		const result = await sshOk(
			"sqld",
			`avail=$(df --output=avail -B1 /data | tail -1); sudo fallocate -l $avail /data/fc-fill.bin; df -B1 --output=size,used,avail /data | tail -1; sudo -u sqld bash -c 'echo x > /data/sqld/fc-write-probe 2>&1; echo write_probe_exit=$?'; sudo rm -f /data/sqld/fc-write-probe`,
		);
		record("disk-full", { df: result.trim().split("\n") });
	} else {
		const result = await sshOk("sqld", "sudo rm -f /data/fc-fill.bin; df -B1 --output=size,used,avail /data | tail -1; systemctl is-active sqld; systemctl show sqld -p NRestarts");
		record("disk-freed", { df: result.trim().split("\n") });
	}
}

async function healAll() {
	await clearNetem([...workers, "sqld"]);
	await Promise.all(
		workers.map((node) =>
			ssh(node, `for i in 1 2 3; do sudo iptables -D OUTPUT -d ${sqldIp} -j DROP 2>/dev/null; sudo iptables -D INPUT -s ${sqldIp} -j DROP 2>/dev/null; done; true`),
		),
	);
	await ssh("sqld", "sudo rm -f /data/fc-fill.bin; true");
	record("healed");
}

// --- Phases ------------------------------------------------------------------------------------------------
async function phase(name, body) {
	const started = Date.now();
	record("phase-start", { phase: name });
	await body();
	timeline.phases.push({ phase: name, startedAt: started, endedAt: Date.now(), ms: Date.now() - started });
	record("phase-end", { phase: name, ms: Date.now() - started });
	await progress(name);
}

async function main() {
	record("controller-start", { scale, workers, sqldIp });
	// A fresh start: no forker, fault or journal left from an earlier attempt of this run.
	await Promise.all(
		workers.map((node) =>
			ssh(node, `pkill -KILL -f 'fork-chaos/supervise[.]sh'; pkill -KILL -f 'workload[.]ts'; sleep 1; rm -rf ${state}/* /opt/fork-chaos/collected; ${devOf(sqldIp)}; sudo tc qdisc del dev $dev root 2>/dev/null; for i in 1 2 3; do sudo iptables -D OUTPUT -d ${sqldIp} -j DROP 2>/dev/null; sudo iptables -D INPUT -s ${sqldIp} -j DROP 2>/dev/null; done; true`),
		),
	);
	await sshOk(
		"sqld",
		`sudo tc qdisc del dev eth0 root 2>/dev/null; sudo rm -f /data/fc-fill.bin; sudo systemctl stop sqld && sudo rm -rf /data/sqld/data.sqld && sudo systemctl start sqld && for i in $(seq 1 30); do curl -sf -o /dev/null http://127.0.0.1:8080/health && break; sleep 1; done; systemctl is-active sqld`,
	);
	record("reset", { workers, sqld: "fresh database" });
	await pushScenarioFiles();

	let sources;
	await phase("seed", async () => {
		const out = await sshOk("a", `${env}\nbun run test/distributed/fork-chaos/workload.ts seed 6 2>>${state}/seed-stderr.log | tail -1`);
		sources = JSON.parse(out.trim()).sources;
		if (sources.some((source) => source.status !== "completed")) throw new Error(`seed failed: ${out}`);
		await sshOk("a", `${env}\nbun run test/distributed/fork-chaos/check.ts snapshot ${state}/sources.json ${state}/before.json`);
		const before = await sshOk("a", `cat ${state}/before.json`);
		writeFileSync(join(artifactDir, "sources-before.json"), before);
		const sourcesJson = await sshOk("a", `cat ${state}/sources.json`);
		await Promise.all(workers.filter((node) => node !== "a").map((node) => sshOk(node, `cat > ${state}/sources.json <<'JSON'\n${sourcesJson}\nJSON`)));
		record("seeded", { sources });
	});
	const sourceIds = sources.map((source) => source.runId);
	const hot = sourceIds[0];
	baseControl = {
		concurrency: 2,
		sources: sourceIds,
		hotSource: hot,
		hotP: 0.3,
		killAfterClaimP: 0,
		killMidTxP: 0,
		killAfterCommitP: 0,
		killInToolP: 0,
		abortP: 0.05,
		probeP: 0.04,
		forkOfForkP: 0.1,
		inputsP: 0.3,
		carryAllP: 0.5,
		wholeRunP: 0.08,
		otherCwdP: 0.15,
		drain: false,
	};
	await setControl(workers, {});
	for (const node of workers) await startForker(node);

	await phase("baseline", () => sleep(seconds(90)));

	await phase("network", async () => {
		const impaired = workers.filter((node) => node !== "a");
		const cycles = (async () => {
			const end = Date.now() + seconds(360);
			while (Date.now() < end) {
				await netem(impaired, Math.round(random(100, 500)), Math.round(random(5, 30)));
				await sleep(seconds(45));
			}
			await clearNetem([...impaired, "sqld"]);
		})();
		const partitions = (async () => {
			await sleep(seconds(40));
			await partition("b", seconds(30));
			await sleep(seconds(30));
			await partition("c", seconds(45));
			await sleep(seconds(30));
			await partition("d", seconds(20));
			await sleep(seconds(20));
			await partition("a", seconds(60));
			await sleep(seconds(20));
			await partition("b", seconds(15));
		})();
		await Promise.all([cycles, partitions]);
	});

	await phase("kills", async () => {
		await setControl(workers, { killAfterClaimP: 0.05, killMidTxP: 0.1, killAfterCommitP: 0.08, killInToolP: 0.02 });
		record("self-kill-hooks-armed", { killAfterClaimP: 0.05, killMidTxP: 0.1, killAfterCommitP: 0.08, killInToolP: 0.02 });
		const end = Date.now() + seconds(300);
		while (Date.now() < end) {
			await sleep(Math.round(random(seconds(15), seconds(30))));
			await externalKill(workers[Math.floor(Math.random() * workers.length)]);
		}
		await setControl(workers, { killAfterClaimP: 0, killMidTxP: 0, killAfterCommitP: 0, killInToolP: 0 });
		record("self-kill-hooks-disarmed");
	});

	await phase("fencing-and-clock-skew", async () => {
		const skews = { b: 600, c: -600 };
		await setControl(["a"], { drain: true });
		if (!(await waitForExit("a", "fork-chaos/supervise[.]sh", 900_000))) throw new Error("forker on a did not drain");
		record("drained", { node: "a" });
		for (const [node, offset] of Object.entries(skews)) await skew(node, offset);
		await setControl(["b", "c", "d"], { hotP: 0.9 });
		const token = randomUUID().slice(0, 8);
		await writeControl(
			"a",
			{ ...baseControl, concurrency: 1, hotP: 1, probeP: 0, abortP: 0, forkOfForkP: 0, wholeRunP: 0, maxAttempts: 1, stopAfterClaim: { source: hot, token } },
			"control-stopper.json",
		);
		await sshOk("a", `${env}\nFC_CONTROL=${state}/control-stopper.json setsid nohup bun run test/distributed/fork-chaos/workload.ts stopper >>${state}/stopper-stdout.log 2>&1 < /dev/null &\nsleep 0.2`);
		let stoppedAt;
		for (let poll = 0; poll < 600; poll++) {
			const result = await ssh("a", `test -f ${state}/stop-${token}.used && ps -o stat= -p $(pgrep -f 'workload[.]ts stopper' | head -1)`);
			if (result.stdout.trim().startsWith("T")) {
				stoppedAt = Date.now();
				break;
			}
			await sleep(500);
		}
		if (stoppedAt === undefined) throw new Error("stopper never stopped");
		record("sigstop", { node: "a", source: hot, token, processState: "T (stopped by SIGSTOP after claiming)" });
		await sleep(150_000);
		await sshOk("a", "pkill -CONT -f 'workload[.]ts stopper'");
		const continuedAt = Date.now();
		record("sigcont", { node: "a", stoppedForMs: continuedAt - stoppedAt });
		timeline.stops.push({ token, node: "a", source: hot, stoppedAtController: stoppedAt, continuedAtController: continuedAt, skew: skews });
		await waitForExit("a", "workload[.]ts stopper", 600_000);
		record("stopper-exited");
		for (const [node, offset] of Object.entries(skews)) await unskew(node, offset);
		await setControl(["b", "c", "d"], { hotP: 0.3 });
		await setControl(["a"], { drain: false });
		await startForker("a");
	});

	await phase("storage", async () => {
		await slowFsync(true);
		await sleep(seconds(90));
		await slowFsync(false);
		await sleep(seconds(20));
		await diskFull(true);
		await sleep(seconds(60));
		await diskFull(false);
		await sleep(seconds(30));
	});

	await phase("mixed", async () => {
		await setControl(workers, { killMidTxP: 0.04, killAfterCommitP: 0.03 });
		await netem(["b", "d"], 250, 10);
		const killer = (async () => {
			await sleep(seconds(20));
			await externalKill("c");
			await sleep(seconds(30));
			await externalKill("b");
		})();
		await partition("c", seconds(25));
		await killer;
		await sleep(seconds(30));
		await setControl(workers, { killMidTxP: 0, killAfterCommitP: 0 });
		await clearNetem(["b", "d", "sqld"]);
	});

	const healAt = Date.now();
	await phase("heal-and-converge", async () => {
		await healAll();
		await setControl(workers, { drain: true, killAfterClaimP: 0, killMidTxP: 0, killAfterCommitP: 0, killInToolP: 0 });
		const drained = await Promise.all(workers.map((node) => waitForExit(node, "fork-chaos/supervise[.]sh", 1_800_000)));
		record("forkers-drained", { drained: Object.fromEntries(workers.map((node, index) => [node, drained[index]])), msSinceHeal: Date.now() - healAt });
		const resumed = await Promise.all(
			workers.map((node) => ssh(node, `${env}\nbun run test/distributed/fork-chaos/workload.ts resume 2>>${state}/resume-stderr.log | tail -1`, { timeoutMs: 1_800_000 })),
		);
		record("node-resume", Object.fromEntries(workers.map((node, index) => [node, resumed[index].stdout.trim()])));
		const swept = await ssh("a", `${env}\nbun run test/distributed/fork-chaos/workload.ts resume --global 2>>${state}/resume-stderr.log | tail -1`, { timeoutMs: 1_800_000 });
		record("global-sweep", { result: swept.stdout.trim() });
	});
	const convergedAt = Date.now();
	timeline.convergence = { healAt, convergedAt, msToConverge: convergedAt - healAt, manualSteps: 0 };
	record("converged", timeline.convergence);

	let localFailure;
	await phase("node-local-sqlite", async () => {
		// The workload's own exit status is kept (no pipeline), and its report is the last line it printed.
		const result = await ssh(
			"b",
			`${env}\nbun run test/distributed/fork-chaos/workload.ts local ${hot} /opt/fork-chaos/localfs >${state}/local-stdout.log 2>>${state}/local-stderr.log; status=$?; tail -1 ${state}/local-stdout.log; exit $status`,
			{ timeoutMs: 600_000 },
		);
		const reportText = result.stdout.trim();
		writeFileSync(join(artifactDir, "node-local-sqlite.json"), reportText || JSON.stringify({ error: result.stderr.slice(-2000) }));
		try {
			assertLocalSqliteReport(reportText, { workloadExitCode: result.code });
		} catch (error) {
			localFailure = findChaosInvariantError(error);
			if (localFailure === undefined) throw error;
		}
		record("node-local-sqlite", { exit: result.code, passed: localFailure === undefined, localFailures: localFailure?.localFailures ?? [] });
	});

	await phase("check", async () => {
		writeFileSync(join(artifactDir, "timeline.json"), JSON.stringify(timeline, null, 2));
		await sshOk("a", "mkdir -p /opt/fork-chaos/collected");
		for (const node of workers) {
			const tar = await exec("ssh", [...sshOptions, `azureuser@${nodes[node].ip}`, `tar -C ${state} -czf - $(cd ${state} && ls *.jsonl *.log sources.json 2>/dev/null)`], { binary: true });
			writeFileSync(join(artifactDir, "raw", `${node}-state.tgz`), tar.stdout);
			await exec("ssh", [...sshOptions, `azureuser@${nodes.a.ip}`, `mkdir -p /opt/fork-chaos/collected/${node} && tar -xzf - -C /opt/fork-chaos/collected/${node} --wildcards '*.jsonl'`], { input: tar.stdout });
		}
		await sshOk("a", `cat > /opt/fork-chaos/collected/timeline.json <<'JSON'\n${JSON.stringify(timeline)}\nJSON`);
		const checked = await ssh(
			"a",
			`${env}\nbun run test/distributed/fork-chaos/check.ts check /opt/fork-chaos/collected ${state}/before.json /opt/fork-chaos/collected/timeline.json ${state}/check.json >${state}/check-stdout.log 2>${state}/check-stderr.log; status=$?; tail -1 ${state}/check-stdout.log; tail -20 ${state}/check-stderr.log; exit $status`,
			{ timeoutMs: 1_800_000 },
		);
		record("checker", { exit: checked.code, summary: checked.stdout.trim() });
		const report = await ssh("a", `cat ${state}/check.json`);
		if (report.code === 0) writeFileSync(join(artifactDir, "check.json"), report.stdout);
		const sqldState = await ssh("sqld", "systemctl show sqld -p NRestarts -p ActiveState; df -B1 --output=size,used,avail /data | tail -1; sudo du -sb /data/sqld");
		record("sqld-state", { state: sqldState.stdout.trim().split("\n") });
		// A missing, unreadable, incomplete or failing report fails the round; main's catch records it and exits 1.
		assertChaosInvariants(report.code === 0 ? report.stdout : undefined, { checkerExitCode: checked.code });
	});
	// The shared checker does not cover the node-local scenario; its failure fails the round once the check ran.
	if (localFailure !== undefined) throw localFailure;
	record("controller-done");
}

main().catch((error) => {
	const failure = findChaosInvariantError(error);
	const verdict = failure
		? {
				code: failure.code,
				failedInvariants: failure.failedInvariants,
				missingInvariants: failure.missingInvariants,
				localFailures: failure.localFailures,
				hint: failure.hint,
			}
		: {};
	record("controller-error", { ...verdict, message: String(error?.stack ?? error).slice(0, 2000) });
	process.exitCode = 1;
});
