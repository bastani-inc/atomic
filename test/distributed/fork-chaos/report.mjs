#!/usr/bin/env node
/**
 * Assembles results.json and summary.md of a fork chaos run (#4321) from the artifacts the other scripts wrote:
 * manifest.json, security-verification.json, timeline.json, check.json, node-local-sqlite.json and, once teardown ran,
 * teardown-proof.json.
 *
 *   ARTIFACT_DIR=<dir> node test/distributed/fork-chaos/report.mjs
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const dir = process.env.ARTIFACT_DIR;
if (!dir) throw new Error("set ARTIFACT_DIR");
/** The control host's network is environment-specific: the report names it only by placeholder. */
const controlValues = [
	["ATOMIC_DISTRIBUTED_CONTROL_SSH_PREFIX", "<control-ssh-prefix>"],
	["ATOMIC_DISTRIBUTED_CONTROL_VNET", "<control-vnet>"],
	["ATOMIC_DISTRIBUTED_CONTROL_RESOURCE_GROUP", "<control-resource-group>"],
].map(([name, placeholder]) => {
	const value = process.env[name];
	if (!value)
		throw new Error(`${name} is not set; the report replaces the control host's network values with placeholders`);
	return [value, placeholder];
});
const scrub = (text) =>
	controlValues.reduce((result, [value, placeholder]) => result.split(value).join(placeholder), text);
/** A round's artifact, or the run-level one (manifest, security verification, teardown proof) one level up. */
const load = (name) => {
	for (const candidate of [join(dir, name), join(dirname(dir), name)])
		if (existsSync(candidate)) return JSON.parse(readFileSync(candidate, "utf8"));
	return null;
};
const deviations = existsSync(join(dir, "harness-deviations.jsonl"))
	? readFileSync(join(dir, "harness-deviations.jsonl"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line))
	: [];
const manifest = load("manifest.json");
const security = load("security-verification.json");
const timeline = load("timeline.json");
const check = load("check.json");
const local = load("node-local-sqlite.json");
const teardown = load("teardown-proof.json");

const faults = {
	netem: [],
	partitions: [],
	sigkill: [],
	selfKill: check?.numbers?.selfKillsByPoint ?? {},
	sigstop: [],
	skew: [],
	slowFsync: [],
	diskFull: [],
};
for (const event of timeline?.events ?? []) {
	if (event.action === "netem")
		faults.netem.push({
			at: event.iso,
			nodes: event.nodes,
			delayMs: event.delayMs,
			lossPct: event.lossPct,
			tlsConnectSeconds: event.tlsConnectSeconds,
		});
	if (event.action === "partition")
		faults.partitions.push({
			at: event.iso,
			node: event.node,
			durationMs: event.durationMs,
			probe: event.probeDuringPartition,
		});
	if (event.action === "sigkill") faults.sigkill.push({ at: event.iso, node: event.node, processes: event.processes });
	if (event.action === "sigstop" || event.action === "sigcont")
		faults.sigstop.push({
			at: event.iso,
			action: event.action,
			node: event.node,
			stoppedForMs: event.stoppedForMs ?? null,
		});
	if (event.action === "clock-skew" || event.action === "clock-restored")
		faults.skew.push({
			at: event.iso,
			action: event.action,
			node: event.node,
			offsetSeconds: event.offsetSeconds ?? 0,
			nodeMinusControllerMs: event.nodeClockMs - event.controllerClockMs,
		});
	if (event.action === "slow-fsync" || event.action === "slow-fsync-cleared")
		faults.slowFsync.push({ at: event.iso, action: event.action, ioMax: event.ioMax });
	if (event.action === "disk-full" || event.action === "disk-freed")
		faults.diskFull.push({ at: event.iso, action: event.action, df: event.df });
}
const results = {
	runId: manifest?.runId,
	topology: manifest,
	securityVerification: security,
	phases: timeline?.phases ?? [],
	faults,
	convergence: timeline?.convergence ?? null,
	invariants: check?.invariants ?? null,
	numbers: check?.numbers ?? null,
	nodeLocalSqlite: local,
	harnessDeviations: deviations,
	teardown,
};
writeFileSync(join(dir, "results.json"), scrub(JSON.stringify(results, null, 2)));

const pass = (value) => (value?.pass === true ? "PASS" : value?.pass === false ? "**FAIL**" : "n/a");
const lines = [];
lines.push(`# Distributed fork chaos run ${manifest?.runId ?? "?"} (#4321)`, "");
lines.push("## Topology", "");
lines.push("| VM | Role | Region | Private IP | Size |", "| --- | --- | --- | --- | --- |");
for (const node of manifest?.nodes ?? [])
	lines.push(`| ${node.vm} | ${node.role} | ${node.region} | ${node.ip} | ${node.size ?? "?"} |`);
lines.push(
	"",
	`Image ${manifest?.image}; VNets ${(manifest?.regions ?? []).map((region) => `${region.region} ${region.addressSpace}`).join(", ")}; global peerings between all test VNets and with the control host's VNet.`,
	"",
);
lines.push("## Security verification", "");
lines.push(
	`Passed: **${security?.passed}**. Public IPs on ${security?.publicIps?.vms} VMs: ${security?.publicIps?.publicIpCount} (public IP resources ${security?.publicIps?.publicIpResources}, load balancers ${security?.publicIps?.loadBalancers}).`,
);
lines.push(
	`Inbound allows from Internet/* in effective NSG rules: ${(security?.effectiveNsg?.nics ?? []).map((nic) => `${nic.nic}=${nic.internetOrAnyInboundAllows.length}`).join(", ")}.`,
);
for (const [node, probe] of Object.entries(security?.sqldAuthAndTls ?? {}))
	lines.push(
		`From ${node}: token+CA ${probe.withTokenAndCa}, no token ${probe.withoutToken}, plain HTTP ${probe.plainHttpToTlsPort}, curl without run CA exit ${probe.curlWithoutRunCaExit}, port 8080 exit ${probe.sqldBackendPort8080Exit}; Atomic client: token+CA ${JSON.stringify(probe.atomicClient?.withTokenAndCa)}, no token rejected ${probe.atomicClient?.withoutToken?.rejected}, plain HTTP rejected ${probe.atomicClient?.plainHttpWithoutTls?.rejected}, without run CA ${JSON.stringify(probe.atomicClientWithoutRunCa?.withTokenAndCa?.name ?? probe.atomicClientWithoutRunCa?.withTokenAndCa)}.`,
	);
lines.push(
	`sqld listeners: ${(security?.sqldExposure?.sqldListeners ?? []).join(", ")}; control host (peered, not an allowed source) to :8443: ${security?.sqldExposure?.controlHostPeeredButNotAllowedTcp8443}.`,
	"",
);
lines.push("## Phases", "", "| Phase | Duration (s) |", "| --- | --- |");
for (const phase of timeline?.phases ?? []) lines.push(`| ${phase.phase} | ${Math.round(phase.ms / 1000)} |`);
lines.push("", "## Faults", "");
lines.push(
	`- netem cycles: ${faults.netem.length} (${faults.netem.map((cycle) => `${cycle.delayMs} ms/${cycle.lossPct}%`).join(", ")})`,
);
lines.push(
	`- partitions: ${faults.partitions.map((cut) => `${cut.node} ${Math.round(cut.durationMs / 1000)} s`).join(", ")}`,
);
lines.push(
	`- external SIGKILLs: ${faults.sigkill.length} (${faults.sigkill.reduce((sum, kill) => sum + kill.processes, 0)} processes); self-kills: ${JSON.stringify(faults.selfKill)}`,
);
lines.push(
	`- SIGSTOP/SIGCONT: ${faults.sigstop.map((stop) => `${stop.action} ${stop.node}${stop.stoppedForMs ? ` after ${Math.round(stop.stoppedForMs / 1000)} s` : ""}`).join(", ")}`,
);
lines.push(
	`- clock skew: ${faults.skew.map((skew) => `${skew.action} ${skew.node} ${skew.offsetSeconds} s (node−controller ${Math.round(skew.nodeMinusControllerMs / 1000)} s)`).join(", ")}`,
);
lines.push(`- slow fsync: ${faults.slowFsync.map((entry) => `${entry.action} ${entry.ioMax.join(" ")}`).join("; ")}`);
lines.push(`- disk full: ${faults.diskFull.map((entry) => `${entry.action} ${entry.df.join(" ")}`).join("; ")}`, "");
lines.push("## Invariants", "", "| Invariant | Result | Numbers |", "| --- | --- | --- |");
for (const [name, value] of Object.entries(check?.invariants ?? {})) {
	const { pass: _pass, violations: _violations, ...numbers } = value;
	lines.push(`| ${name} | ${pass(value)} | ${JSON.stringify(numbers).replaceAll("|", "\\|").slice(0, 900)} |`);
}
lines.push("", "## Numbers", "", "```json", JSON.stringify(check?.numbers ?? {}, null, 2), "```", "");
lines.push(
	`Convergence after heal: ${timeline?.convergence ? `${Math.round(timeline.convergence.msToConverge / 1000)} s, manual steps ${timeline.convergence.manualSteps}` : "n/a"}.`,
	"",
);
lines.push("## Node-local SQLite", "", "```json", JSON.stringify(local ?? {}, null, 2), "```", "");
if (deviations.length > 0) {
	lines.push("## Harness deviations", "");
	for (const deviation of deviations) lines.push(`- ${deviation.at}: ${deviation.action}. ${deviation.why}`);
	lines.push("");
}
lines.push("## Teardown", "", teardown ? `Clean: **${teardown.clean}**` : "not yet run", "");
if (teardown) {
	lines.push("```json", JSON.stringify(teardown.queries, null, 2), "```");
}
writeFileSync(join(dir, "summary.md"), scrub(`${lines.join("\n")}\n`));
console.log(`wrote ${join(dir, "results.json")} and summary.md`);
