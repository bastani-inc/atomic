// @ts-check
/**
 * Scenario suites. `smoke` drives a chain of lease-holding writers through every chaos profile against the shared
 * namespaced journal on sqld, plus local journals on device-mapper volumes for the disk profiles, and checks the
 * journal invariants at the end. Feature suites probe the deployed ref for the interface their issue introduces and
 * skip with a typed reason when it is absent.
 */

import {
	dmVolumeScript,
	iptablesRules,
	netemParameters,
	netemScript,
	PROFILE_SPECS,
	parseCounters,
	parseNetemStats,
} from "./chaos.mjs";
import { shellQuote } from "./commands.mjs";
import { SUITES } from "./config.mjs";
import {
	DistributedFaultError,
	DistributedFeatureUnavailableError,
	DistributedScenarioPendingError,
	isCancellation,
	serializeDistributedError,
} from "./errors.mjs";
import { atLeastOnceReplays, checkJournalInvariants, latencyStats } from "./invariants.mjs";
import {
	AGENT,
	NODE_BIN,
	REF_DIR,
	REMOTE_ROOT,
	readJsonLines,
	SECRETS,
	startAgentUnit,
	unitState,
	waitFor,
} from "./remote.mjs";

/**
 * @typedef {{ workflows: string[], atomic: string[], members: Record<string, string[]> }} Capabilities
 * @typedef {{ issue: string, capability: string, present: (capabilities: Capabilities) => boolean, implemented: boolean }} FeatureProbe
 */

/** @param {string} name */
const exported = (name) => (/** @type {Capabilities} */ capabilities) =>
	capabilities.workflows.includes(name) || capabilities.atomic.includes(name);
/** @param {string} owner @param {string} member */
const memberOf = (owner, member) => (/** @type {Capabilities} */ capabilities) =>
	(capabilities.members[owner] ?? []).includes(member);

/** @type {Readonly<Record<string, FeatureProbe>>} */
export const FEATURE_PROBES = Object.freeze({
	"multi-node-resume": {
		issue: "#4329",
		capability: "export WorkspaceError",
		present: exported("WorkspaceError"),
		implemented: false,
	},
	"cross-host-pools": {
		issue: "#4310",
		capability: "export WorkerPlacementError",
		present: exported("WorkerPlacementError"),
		implemented: false,
	},
	"shard-contention": {
		issue: "#4325",
		capability: "export JournalShardUnavailableError",
		present: exported("JournalShardUnavailableError"),
		implemented: false,
	},
	"idle-density": {
		issue: "#4309/#4326",
		capability: "AgentSessionRuntime.rehydrate",
		present: memberOf("atomic.AgentSessionRuntime", "rehydrate"),
		implemented: false,
	},
	"subscription-flood": {
		issue: "#4311",
		capability: "export SubscriptionError",
		present: exported("SubscriptionError"),
		implemented: false,
	},
	"fork-under-load": {
		issue: "#4321",
		capability: "export forkRun",
		present: exported("forkRun"),
		implemented: false,
	},
	"restore-cold": {
		issue: "#4245",
		capability: "export GitProvisionError",
		present: exported("GitProvisionError"),
		implemented: false,
	},
	"team-ci": {
		issue: "#4320",
		capability: "export TeamProfileError",
		present: exported("TeamProfileError"),
		implemented: false,
	},
	"pool-scale": {
		issue: "#4312",
		capability: "export createRegistry (local worker pools)",
		present: exported("createRegistry"),
		implemented: false,
	},
	compaction: {
		issue: "#4330",
		capability: "AgentSession.awaitBackgroundCompaction",
		present: memberOf("atomic.AgentSession", "awaitBackgroundCompaction"),
		implemented: false,
	},
});

/**
 * Validates the agent's capabilities document; a malformed one is a broken deployment, not a missing feature.
 * @param {unknown} document
 * @returns {Capabilities | undefined}
 */
export function parseCapabilities(document) {
	if (typeof document !== "object" || document === null) return undefined;
	const workflows = Reflect.get(document, "workflows");
	const atomic = Reflect.get(document, "atomic");
	const members = Reflect.get(document, "members");
	const strings = (/** @type {unknown} */ value) =>
		Array.isArray(value) && value.every((item) => typeof item === "string");
	if (!strings(workflows) || !strings(atomic) || typeof members !== "object" || members === null) return undefined;
	if (!Object.values(members).every(strings)) return undefined;
	return { workflows, atomic, members: /** @type {Record<string, string[]>} */ (members) };
}

/**
 * Whether a feature suite can run on the ref: undefined when it can, otherwise the typed skip reason.
 * @param {string} suite
 * @param {Capabilities} capabilities
 * @returns {DistributedFeatureUnavailableError | DistributedScenarioPendingError | undefined}
 */
export function featureSkip(suite, capabilities) {
	const probe = FEATURE_PROBES[suite];
	if (probe === undefined) return undefined;
	if (!probe.present(capabilities))
		return new DistributedFeatureUnavailableError({ suite, issue: probe.issue, capability: probe.capability });
	if (!probe.implemented)
		return new DistributedScenarioPendingError({ suite, issue: probe.issue, capability: probe.capability });
	return undefined;
}

/** @param {string} selection */
export function selectedSuites(selection) {
	return selection === "all" ? Object.keys(SUITES) : [selection];
}

/**
 * @typedef {import("./remote.mjs").Host} Host
 * @typedef {Host & { roles: string[], vmName: string, region: string }} NodeHost
 * @typedef {{ profile: string, target: string, parameters: Record<string, unknown>, applied: boolean, effectObserved: boolean,
 *   recovered: boolean, observed: Record<string, unknown>, timeline: { at: number, event: string }[], skipped?: { code: string, detail: string },
 *   error?: import("./errors.mjs").SerializedError }} FaultRecord
 * @typedef {{ runId: string, attempt: string, nodes: NodeHost[], primary: Host, replica: Host,
 *   azure: import("./azure.mjs").AzureRun, random: ReturnType<typeof import("./prng.mjs").createRandom>, profiles: readonly string[],
 *   gatewayPort: number, namespace: string, signal?: AbortSignal, log: (line: string) => void, started: number }} SmokeContext
 * @typedef {(profile: string, target: string, parameters: Record<string, unknown>, body: (fault: FaultRecord, mark: (event: string) => void) => Promise<void>) => Promise<void>} Exercise
 */

const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs the smoke scenario and returns its fault records, invariant results and metrics.
 * @param {SmokeContext} ctx
 */
export async function runSmoke(ctx) {
	const { attempt } = ctx;
	const journalRun = `${ctx.runId}-smoke-${attempt}`;
	const shared = (/** @type {Host} */ via = ctx.primary) => [
		"--ref-dir",
		REF_DIR,
		"--journal",
		"shared",
		"--url",
		`https://${via.ip}:${ctx.gatewayPort}`,
		"--namespace",
		ctx.namespace,
		"--token-file",
		`${SECRETS}/token`,
	];
	/** @type {FaultRecord[]} */
	const faults = [];
	/** @type {{ holder: string, epoch: number, outcome: "rejected" | "appended", error?: { name: string } }[]} */
	const fencing = [];
	/** @type {Map<string, { host: Host, unit: string, acks: string }>} */
	const writers = new Map();
	/** @type {Record<string, unknown>} */
	const metrics = {};
	const vmNode = ctx.nodes.find((node) => node.roles.includes("vm-faults")) ?? ctx.nodes[ctx.nodes.length - 1];
	const others = ctx.nodes.filter((node) => node !== vmNode);
	const first = others.length > 0 ? ctx.random.pick(others) : vmNode;
	const second =
		others.find((node) => node !== first && node.region !== first.region) ??
		others.find((node) => node !== first) ??
		vmNode;
	let sequence = 0;

	/** @param {Host} host @param {{ count?: string, interval?: string, lease?: string }} options */
	const startWriter = async (host, options) => {
		const holder = `w${++sequence}-${attempt}-${host.name}`;
		const unit = `adt-${ctx.runId}-${holder}`;
		const acks = `${REMOTE_ROOT}/logs/${holder}.jsonl`;
		const args = [
			"writer",
			...shared(),
			"--run",
			journalRun,
			"--holder",
			holder,
			"--acks",
			acks,
			"--count",
			options.count ?? "1000000",
			"--interval-ms",
			options.interval ?? "200",
			"--lease",
			options.lease ?? "takeover-expired",
			"--stale-ms",
			"10000",
		];
		await startAgentUnit(host, { unit, args });
		writers.set(holder, { host, unit, acks });
		ctx.log(`started ${holder} on ${host.name}`);
		return holder;
	};
	/** @param {string} holder */
	const records = (holder) => {
		const writer = /** @type {{ host: Host, acks: string }} */ (writers.get(holder));
		return readJsonLines(writer.host, writer.acks);
	};
	/** @param {string} holder */
	const ackCount = async (holder) => (await records(holder)).filter((record) => record.event === "ack").length;
	/** @param {string} holder @param {number} atLeast @param {number} [timeoutMs] */
	const waitAcks = (holder, atLeast, timeoutMs = 180_000) =>
		waitFor(async () => (await ackCount(holder)) >= atLeast, {
			timeoutMs,
			intervalMs: 2000,
			signal: ctx.signal,
			onTimeout: () =>
				new DistributedFaultError({
					profile: "baseline",
					stage: "observe",
					target: holder,
					detail: `fewer than ${atLeast} acknowledgements`,
				}),
		});
	/** @param {string} holder @param {string} event @param {number} [timeoutMs] */
	const waitEvent = (holder, event, timeoutMs = 180_000) =>
		waitFor(async () => (await records(holder)).find((record) => record.event === event), {
			timeoutMs,
			intervalMs: 2000,
			signal: ctx.signal,
			onTimeout: () =>
				new DistributedFaultError({
					profile: "baseline",
					stage: "observe",
					target: holder,
					detail: `no ${event} record`,
				}),
		});
	/** @param {string} holder */
	const stopWriter = async (holder) => {
		const writer = /** @type {{ host: Host, unit: string }} */ (writers.get(holder));
		await writer.host.run(`sudo systemctl stop ${shellQuote(writer.unit)} || true`, {
			operation: `stop ${writer.unit}`,
		});
		await waitEvent(holder, "done", 60_000).catch((error) => {
			if (isCancellation(error, ctx.signal)) throw error;
			ctx.log(`${holder} stopped without a done record`);
		});
	};

	/** @type {Exercise} */
	const exercise = async (profile, target, parameters, body) => {
		if (!ctx.profiles.includes(profile)) return;
		/** @type {FaultRecord} */
		const fault = {
			profile,
			target,
			parameters,
			applied: false,
			effectObserved: false,
			recovered: false,
			observed: {},
			timeline: [],
		};
		faults.push(fault);
		const mark = (/** @type {string} */ event) => {
			fault.timeline.push({ at: Math.round(performance.now() - ctx.started), event });
			ctx.log(`${profile}: ${event}`);
		};
		try {
			mark("begin");
			await body(fault, mark);
			mark("end");
		} catch (error) {
			if (isCancellation(error, ctx.signal)) throw error;
			const stage = fault.applied ? (fault.effectObserved ? "recover" : "observe") : "apply";
			fault.error = serializeDistributedError(new DistributedFaultError({ profile, stage, target, cause: error }));
			mark(`failed: ${fault.error.message}`);
		}
	};

	const dbIp = ctx.primary.ip;
	const port = ctx.gatewayPort;
	let current = await startWriter(first, { lease: "acquire" });
	await waitAcks(current, 5);
	const holderHost = () => /** @type {{ host: Host }} */ (writers.get(current)).host;

	/** @param {Host} host @param {"full" | "asymmetric" | "reset"} kind @param {string} profile */
	const iptablesFault = (host, kind, profile) =>
		exercise(profile, host.name, { kind, windowMs: 20_000 }, async (fault, mark) => {
			const tag = `adt-${ctx.runId}-${profile}`;
			const rules = iptablesRules(tag, kind, { dbIp, port });
			const gatewayBefore = await gatewayRequests(ctx.primary);
			await host.run(rules.apply, { operation: `${profile} apply` });
			fault.applied = true;
			mark("applied");
			const before = await ackCount(current);
			await sleep(20_000);
			const during = (await ackCount(current)) - before;
			const counters = parseCounters((await host.run(rules.counters, { operation: `${profile} counters` })).stdout);
			const gatewayDuring = (await gatewayRequests(ctx.primary)) - gatewayBefore;
			fault.observed = { acksDuringWindow: during, counters, gatewayRequestsDuringWindow: gatewayDuring };
			fault.effectObserved =
				kind === "full"
					? (counters.OUTPUT ?? 0) > 0 && during <= 1
					: kind === "asymmetric"
						? (counters.INPUT ?? 0) > 0 && counters.OUTPUT === undefined && gatewayDuring > 0
						: (counters.OUTPUT ?? 0) > 0;
			await host.run(rules.clear, { operation: `${profile} clear` });
			mark("cleared");
			const after = await ackCount(current);
			await waitAcks(current, after + 3, 240_000);
			fault.recovered = true;
			mark("acknowledgements resumed");
		});

	/** @param {Host} host @param {string} profile */
	const netemFault = (host, profile) =>
		exercise(
			profile,
			host.name,
			{ netem: netemParameters(profile, ctx.random.integer(1, 2 ** 31 - 1)), windowMs: 20_000 },
			async (fault, mark) => {
				const script = netemScript({ dbIp, port, parameters: String(fault.parameters.netem) });
				const baselineFrom = Date.now();
				await sleep(15_000);
				const baselineTo = Date.now();
				await host.run(script.apply, { operation: `${profile} apply` });
				fault.applied = true;
				mark("applied");
				await sleep(20_000);
				const stats = parseNetemStats((await host.run(script.stats, { operation: `${profile} stats` })).stdout);
				const duringTo = Date.now();
				await host.run(script.clear, { operation: `${profile} clear` });
				mark("cleared");
				const all = await records(current);
				const before = latencyStats(all, { from: baselineFrom, to: baselineTo });
				const during = latencyStats(all, { from: baselineTo, to: duringTo });
				const qdisc = (
					await host.run("tc qdisc show | grep -c netem || true", { operation: `${profile} verify cleared` })
				).stdout.trim();
				fault.observed = { before, during, netem: stats ?? null, netemQdiscsAfterClear: Number(qdisc) };
				const spread = (/** @type {{ p10: number | null, p90: number | null }} */ s) => (s.p90 ?? 0) - (s.p10 ?? 0);
				fault.effectObserved =
					stats !== undefined &&
					stats.packets > 0 &&
					(profile === "latency"
						? (during.median ?? 0) >= (before.median ?? 0) + 75
						: profile === "jitter"
							? spread(during) > spread(before) + 40
							: profile === "loss"
								? stats.dropped > 0
								: true);
				const after = await ackCount(current);
				await waitAcks(current, after + 3, 240_000);
				fault.recovered = Number(qdisc) === 0;
				mark("acknowledgements resumed");
			},
		);

	await iptablesFault(first, "full", "partition");

	await exercise("sigkill", first.name, { signal: "SIGKILL", replacement: second.name }, async (fault, mark) => {
		const victim = current;
		const writer = /** @type {{ host: Host, unit: string }} */ (writers.get(victim));
		const before = await records(victim);
		const lastEpoch = before.filter((record) => record.event === "lease").at(-1)?.epoch ?? 1;
		await writer.host.run(`sudo systemctl kill --signal=SIGKILL --kill-whom=main ${shellQuote(writer.unit)}`, {
			operation: "sigkill writer",
		});
		fault.applied = true;
		mark("killed");
		const state = await waitFor(
			async () => {
				const observed = await unitState(writer.host, writer.unit);
				return observed.pid === 0 ? observed : undefined;
			},
			{
				timeoutMs: 30_000,
				intervalMs: 1000,
				signal: ctx.signal,
				onTimeout: () => new Error("writer survived SIGKILL"),
			},
		);
		fault.observed = { unit: state, acksBeforeKill: before.filter((record) => record.event === "ack").length };
		fault.effectObserved = state.pid === 0 && state.result === "signal";
		current = await startWriter(second, {});
		const lease = await waitEvent(current, "lease", 240_000);
		await waitAcks(current, 3);
		const probe = await writer.host.agent("stale-append", [
			...shared(),
			"--run",
			journalRun,
			"--holder",
			victim,
			"--epoch",
			String(lastEpoch),
			"--key",
			`stale-${victim}`,
		]);
		fencing.push({ holder: victim, epoch: lastEpoch, outcome: probe.outcome, error: probe.error });
		fault.observed = {
			...fault.observed,
			replacementEpoch: lease.epoch ?? null,
			previousEpoch: lastEpoch,
			staleAppend: probe,
		};
		fault.recovered = lease.epoch === lastEpoch + 1;
		mark(`replacement at epoch ${lease.epoch}`);
	});

	for (const profile of ["latency", "jitter", "loss", "bandwidth"]) await netemFault(holderHost(), profile);
	await iptablesFault(holderHost(), "reset", "reset");
	await iptablesFault(holderHost(), "asymmetric", "asymmetric-partition");

	await exercise("sigstop", holderHost().name, { signal: "SIGSTOP", takeover: vmNode.name }, async (fault, mark) => {
		const stopped = current;
		const writer = /** @type {{ host: Host, unit: string }} */ (writers.get(stopped));
		await writer.host.run(`sudo systemctl kill --signal=SIGSTOP --kill-whom=main ${shellQuote(writer.unit)}`, {
			operation: "sigstop writer",
		});
		fault.applied = true;
		mark("stopped");
		const state = await unitState(writer.host, writer.unit);
		const replacement = await startWriter(vmNode, {});
		const lease = await waitEvent(replacement, "lease", 240_000);
		await waitAcks(replacement, 3);
		fault.effectObserved = state.state === "T" && typeof lease.epoch === "number";
		await writer.host.run(`sudo systemctl kill --signal=SIGCONT --kill-whom=main ${shellQuote(writer.unit)}`, {
			operation: "sigcont writer",
		});
		mark("continued");
		const fenced = await waitEvent(stopped, "fenced", 120_000);
		fencing.push({
			holder: stopped,
			epoch: (lease.epoch ?? 0) - 1,
			outcome: "rejected",
			...(fenced.error === undefined ? {} : { error: fenced.error }),
		});
		fault.observed = { processState: state.state, takeoverEpoch: lease.epoch ?? null, staleWriter: fenced };
		fault.recovered = fenced.error?.name === "StaleLeaseError";
		current = replacement;
		mark("stale writer fenced");
	});

	const skewHost = first;
	await exercise("clock-skew", skewHost.name, { offsetSeconds: 600 }, async (fault, mark) => {
		await skewHost.run(
			"sudo systemctl stop chrony 2>/dev/null || sudo systemctl stop chronyd 2>/dev/null || true; sudo date -s @$(( $(date +%s) + 600 )) >/dev/null",
			{ operation: "skew clock" },
		);
		fault.applied = true;
		mark("skewed");
		const facts = await skewHost.agent("facts", []);
		const offsetMs = facts.clockMs - Date.now();
		const holder = `skewed-${attempt}-${skewHost.name}`;
		const acks = `${REMOTE_ROOT}/logs/${holder}.jsonl`;
		await skewHost.run(
			[
				`NODE_EXTRA_CA_CERTS=${SECRETS}/ca.pem`,
				NODE_BIN,
				AGENT,
				"writer",
				...shared(),
				"--run",
				journalRun,
				"--holder",
				holder,
				"--acks",
				acks,
				"--count",
				"1",
				"--lease",
				"takeover-expired",
				"--stale-ms",
				"30000",
				"--takeover-timeout-ms",
				"20000",
			]
				.map(shellQuote)
				.join(" "),
			{ operation: "skewed takeover attempt", timeoutMs: 120_000, allowExitCodes: [4] },
		);
		const attemptRecords = await readJsonLines(skewHost, acks);
		const tookLease = attemptRecords.some((record) => record.event === "lease");
		fault.observed = {
			offsetMs,
			skewedTakeover: tookLease ? "acquired" : "refused",
			attempts: attemptRecords.filter((record) => record.event !== "ack").length,
		};
		fault.effectObserved = offsetMs > 590_000;
		await skewHost.run(
			`sudo date -s @${(Date.now() / 1000).toFixed(3)} >/dev/null; sudo systemctl start chrony 2>/dev/null || sudo systemctl start chronyd 2>/dev/null || true`,
			{ operation: "restore clock" },
		);
		const restored = (await skewHost.agent("facts", [])).clockMs - Date.now();
		fault.observed = { ...fault.observed, offsetAfterMs: restored };
		fault.recovered = Math.abs(restored) < 5000 && !tookLease;
		mark("restored");
	});

	await exercise("oom", first.name, { memoryMaxMb: 384, hogMb: 2048 }, async (fault, mark) => {
		await stopWriter(current);
		const holder = `w${++sequence}-oom-${attempt}-${first.name}`;
		const acks = `${REMOTE_ROOT}/logs/${holder}.jsonl`;
		const cgroup = `/sys/fs/cgroup/adt-${ctx.runId}-oom-${attempt}`;
		const command = [
			`NODE_EXTRA_CA_CERTS=${SECRETS}/ca.pem`,
			NODE_BIN,
			AGENT,
			"writer",
			...shared(),
			"--run",
			journalRun,
			"--holder",
			holder,
			"--acks",
			acks,
			"--count",
			"1000000",
			"--interval-ms",
			"200",
			"--lease",
			"takeover-expired",
			"--stale-ms",
			"10000",
			"--hog-after",
			"5",
			"--hog-mb",
			"2048",
		]
			.map(shellQuote)
			.join(" ");
		await first.run(
			`echo +memory | sudo tee /sys/fs/cgroup/cgroup.subtree_control >/dev/null; sudo mkdir -p ${cgroup} && echo 384M | sudo tee ${cgroup}/memory.max >/dev/null && echo 0 | sudo tee ${cgroup}/memory.swap.max >/dev/null
sudo setsid bash -c 'echo $$ > ${cgroup}/cgroup.procs; exec setpriv --reuid=${first.user} --regid=${first.user} --init-groups env ${command.replaceAll("'", "")} >> ${REMOTE_ROOT}/logs/${holder}.log 2>&1' </dev/null >/dev/null 2>&1 &`,
			{ operation: "start writer in memory-limited cgroup" },
		);
		writers.set(holder, { host: first, unit: "", acks });
		fault.applied = true;
		mark("started under memory.max");
		const events = await waitFor(
			async () => {
				const text = (await first.run(`cat ${cgroup}/memory.events`, { operation: "read memory.events" })).stdout;
				const oomKill = Number(/oom_kill (\d+)/.exec(text)?.[1] ?? 0);
				return oomKill >= 1 ? { text, oomKill } : undefined;
			},
			{
				timeoutMs: 240_000,
				intervalMs: 2000,
				signal: ctx.signal,
				onTimeout: () => new Error("no OOM kill recorded"),
			},
		);
		const procs = (await first.run(`cat ${cgroup}/cgroup.procs`, { operation: "read cgroup procs" })).stdout.trim();
		fault.observed = {
			memoryEvents: Object.fromEntries(
				events.text
					.trim()
					.split("\n")
					.map((line) => {
						const [key, value] = line.split(" ");
						return [key, Number(value)];
					}),
			),
			processesLeft: procs === "" ? 0 : procs.split("\n").length,
			acksBeforeOom: await ackCount(holder),
		};
		fault.effectObserved = events.oomKill >= 1 && procs === "";
		current = await startWriter(second, {});
		const lease = await waitEvent(current, "lease", 240_000);
		await waitAcks(current, 3);
		await first.run(`sudo rmdir ${cgroup} || true`, { operation: "remove cgroup" });
		fault.recovered = typeof lease.epoch === "number";
		mark(`replacement at epoch ${lease.epoch}`);
	});

	await exercise("vm-restart", vmNode.vmName, {}, async (fault, mark) => {
		await stopWriter(current);
		const holder = await startWriter(vmNode, {});
		await waitAcks(holder, 3);
		const bootBefore = (await vmNode.agent("facts", [])).bootId;
		await ctx.azure.vmPower(vmNode.vmName, "restart");
		fault.applied = true;
		mark("restarted");
		await vmNode.waitForSsh();
		const bootAfter = (await vmNode.agent("facts", [])).bootId;
		const unit = await unitState(vmNode, /** @type {{ unit: string }} */ (writers.get(holder)).unit);
		fault.observed = { bootBefore, bootAfter, writerUnit: unit };
		fault.effectObserved = bootBefore !== bootAfter && unit.pid === 0;
		current = await startWriter(first, {});
		const lease = await waitEvent(current, "lease", 240_000);
		await waitAcks(current, 3);
		fault.recovered = typeof lease.epoch === "number";
		mark(`replacement at epoch ${lease.epoch}`);
	});

	await exercise("vm-deallocate", vmNode.vmName, {}, async (fault, mark) => {
		const bootBefore = (await vmNode.agent("facts", [])).bootId;
		await ctx.azure.vmPower(vmNode.vmName, "deallocate");
		fault.applied = true;
		const power = (await ctx.azure.vmFacts(vmNode.vmName)).powerState;
		mark(`power state ${power}`);
		await ctx.azure.vmPower(vmNode.vmName, "start");
		await vmNode.waitForSsh();
		const bootAfter = (await vmNode.agent("facts", [])).bootId;
		fault.observed = { powerStateWhileDeallocated: power, bootBefore, bootAfter };
		fault.effectObserved = power === "VM deallocated" && bootBefore !== bootAfter;
		await stopWriter(current);
		const holder = await startWriter(vmNode, { count: "5" });
		await waitEvent(holder, "done", 240_000);
		current = holder;
		fault.recovered = true;
		mark("node wrote again");
	});

	await exercise("nic-detach", vmNode.vmName, { nic: `${vmNode.vmName}-nic2` }, async (fault, mark) => {
		const nic = `${vmNode.vmName}-nic2`;
		const before = await ctx.azure.vmFacts(vmNode.vmName);
		await ctx.azure.vmPower(vmNode.vmName, "deallocate");
		await ctx.azure.vmNic(vmNode.vmName, nic, "remove");
		fault.applied = true;
		await ctx.azure.vmPower(vmNode.vmName, "start");
		await vmNode.waitForSsh();
		const detached = await ctx.azure.vmFacts(vmNode.vmName);
		const guestLinks = Number(
			(await vmNode.run("ip -o link show | grep -vc ' lo:'", { operation: "count links" })).stdout.trim(),
		);
		mark(`running with ${detached.nics} NIC(s)`);
		const holder = await startWriter(vmNode, { count: "5" });
		await waitEvent(holder, "done", 240_000);
		await ctx.azure.vmPower(vmNode.vmName, "deallocate");
		await ctx.azure.vmNic(vmNode.vmName, nic, "add");
		await ctx.azure.vmPower(vmNode.vmName, "start");
		await vmNode.waitForSsh();
		const restored = await ctx.azure.vmFacts(vmNode.vmName);
		fault.observed = {
			nicsBefore: before.nics,
			nicsDetached: detached.nics,
			guestLinksDetached: guestLinks,
			nicsRestored: restored.nics,
		};
		fault.effectObserved = detached.nics === before.nics - 1;
		current = await startWriter(vmNode, { count: "5" });
		await waitEvent(current, "done", 240_000);
		fault.recovered = restored.nics === before.nics;
		mark("NIC restored and node wrote again");
	});

	const disk = await runDiskProfiles(ctx, second, exercise);

	if (writers.get(current)?.unit !== "") await stopWriter(current);
	const finalHolder = await startWriter(first, { count: "5" });
	await waitEvent(finalHolder, "done", 240_000);
	const read = await first.agent("read", [...shared(), "--run", journalRun]);
	const integrity = await first.agent("integrity", shared());
	const replica = await waitFor(
		async () => {
			const copy = await first.agent("read", [...shared(ctx.replica), "--run", journalRun]);
			return copy.entries.length === read.entries.length ? copy : undefined;
		},
		{
			timeoutMs: 120_000,
			intervalMs: 3000,
			signal: ctx.signal,
			onTimeout: () => new Error("replica did not catch up"),
		},
	).catch((error) => {
		if (isCancellation(error, ctx.signal)) throw error;
		return { error: serializeDistributedError(error) };
	});
	/** @type {import("./invariants.mjs").WriterRecord[]} */
	const allRecords = [];
	for (const holder of writers.keys()) allRecords.push(...(await records(holder)));
	const invariants = checkJournalInvariants({
		entries: read.entries,
		records: allRecords,
		fencing,
		integrity: integrity.result,
		expectations: { minAcks: 20, requireCompletion: true },
	});
	const lastEntry = read.entries.at(-1);
	invariants.push({
		name: "replica-caught-up",
		passed:
			"entries" in replica &&
			replica.entries.length === read.entries.length &&
			replica.entries.at(-1)?.seq === lastEntry?.seq,
		expected: { entries: read.entries.length, lastSeq: lastEntry?.seq ?? null },
		actual:
			"entries" in replica
				? { entries: replica.entries.length, lastSeq: replica.entries.at(-1)?.seq ?? null }
				: { error: replica.error.code },
	});
	const skew = faults.find((fault) => fault.profile === "clock-skew");
	if (skew !== undefined) {
		invariants.push({
			name: "skewed-node-took-no-live-lease",
			passed: skew.observed.skewedTakeover === "refused",
			expected: "refused",
			actual: String(skew.observed.skewedTakeover ?? "not run"),
		});
	}
	invariants.push(...disk.invariants);
	metrics.sharedJournal = {
		entries: read.entries.length,
		epochs: [...new Set(read.entries.map((/** @type {{ epoch: number }} */ entry) => entry.epoch))],
		atLeastOnceReplays: atLeastOnceReplays(allRecords),
		writers: writers.size,
	};
	/** @type {Map<string, number>} */
	const errorCounts = new Map();
	for (const record of allRecords) {
		if (record.event !== "error") continue;
		const name = record.error?.name ?? "unknown";
		errorCounts.set(name, (errorCounts.get(name) ?? 0) + 1);
	}
	metrics.writerErrors = [...errorCounts].map(([name, count]) => ({ name, count }));
	metrics.appendLatencyMs = latencyStats(allRecords, { from: 0, to: Number.MAX_SAFE_INTEGER });
	return {
		faults,
		invariants,
		metrics,
		profileSpecs: Object.fromEntries(ctx.profiles.map((profile) => [profile, PROFILE_SPECS[profile]])),
	};
}

/**
 * @param {Host} host
 */
async function gatewayRequests(host) {
	const result = await host.run(`cat ${REMOTE_ROOT}/logs/gateway-stats.json 2>/dev/null || echo '{}'`, {
		operation: "read gateway stats",
	});
	return Number(JSON.parse(result.stdout.trim() || "{}").requests ?? 0);
}

/**
 * Disk profiles against local journals on device-mapper volumes of one node.
 * @param {SmokeContext} ctx
 * @param {Host} host
 * @param {Exercise} exercise
 */
async function runDiskProfiles(ctx, host, exercise) {
	/** @type {import("./invariants.mjs").InvariantResult[]} */
	const invariants = [];
	/**
	 * @param {string} profile
	 * @param {number} sizeMb
	 * @param {(volume: ReturnType<typeof dmVolumeScript>, writer: { records: () => Promise<import("./invariants.mjs").WriterRecord[]>, acks: () => Promise<number> }, fault: FaultRecord, mark: (event: string) => void) => Promise<void>} body
	 */
	const local = (profile, sizeMb, body) =>
		exercise(profile, host.name, { sizeMb }, async (fault, mark) => {
			const name = `adt-${profile}`;
			const volume = dmVolumeScript({ name, sizeMb, user: host.user });
			await host.run(volume.create, { operation: `create ${name}` });
			try {
				const holder = `local-${profile}-${ctx.attempt}`;
				const unit = `adt-${ctx.runId}-${holder}`;
				const acks = `${REMOTE_ROOT}/logs/${holder}.jsonl`;
				const journal = ["--ref-dir", REF_DIR, "--journal", "local", "--path", `/mnt/${name}/journal.sqlite`];
				const journalRun = `${ctx.runId}-${profile}-${ctx.attempt}`;
				await startAgentUnit(host, {
					unit,
					args: [
						"writer",
						...journal,
						"--run",
						journalRun,
						"--holder",
						holder,
						"--acks",
						acks,
						"--count",
						"1000000",
						"--interval-ms",
						"100",
						"--max-error-ms",
						"600000",
					],
				});
				const writer = {
					records: () => readJsonLines(host, acks),
					acks: async () => (await readJsonLines(host, acks)).filter((record) => record.event === "ack").length,
				};
				await waitFor(async () => (await writer.acks()) >= 5, {
					timeoutMs: 120_000,
					intervalMs: 1000,
					signal: ctx.signal,
					onTimeout: () => new Error(`${holder} did not start`),
				});
				try {
					await body(volume, writer, fault, mark);
				} finally {
					await host.run(`sudo systemctl stop ${shellQuote(unit)} || true`, {
						operation: `stop ${unit}`,
						timeoutMs: 120_000,
					});
				}
				if (profile === "io-error") {
					const fsck = await host.json(volume.remount, { operation: "check and remount" });
					fault.observed = { ...fault.observed, fsckExit: fsck.fsck, remounted: fsck.mounted };
					fault.recovered = fsck.mounted === true;
					mark(`filesystem checked (e2fsck exit ${fsck.fsck}) and remounted`);
				}
				const read = await host.agent("read", [...journal, "--run", journalRun]);
				const integrity = await host.agent("integrity", journal);
				const all = await writer.records();
				const preFault =
					typeof fault.observed.acksBeforeFault === "number" ? fault.observed.acksBeforeFault : undefined;
				const considered =
					preFault === undefined
						? all
						: all.filter((record) => record.event !== "ack" || (record.index ?? 0) < preFault);
				for (const result of checkJournalInvariants({
					entries: read.entries,
					records: considered,
					fencing: [],
					integrity: integrity.result,
					expectations: { minAcks: 5, requireCompletion: false },
				})) {
					invariants.push({ ...result, name: `${profile}/${result.name}` });
				}
			} finally {
				await host.run(volume.remove, { operation: `remove ${name}` });
			}
		});

	await local("disk-full", 64, async (volume, writer, fault, mark) => {
		const before = await writer.acks();
		await host.run(
			"fallocate -l $(( $(df --output=avail -B1 /mnt/adt-disk-full | tail -1) )) /mnt/adt-disk-full/filler || dd if=/dev/zero of=/mnt/adt-disk-full/filler bs=1M 2>/dev/null || true",
			{ operation: "fill volume" },
		);
		fault.applied = true;
		const filledAt = Date.now();
		mark("filled");
		const failure = await waitFor(
			async () =>
				(await writer.records()).find((record) => record.event === "error" && (record.at ?? 0) >= filledAt),
			{
				timeoutMs: 60_000,
				intervalMs: 1000,
				signal: ctx.signal,
				onTimeout: () => new Error("no append failed on the full volume"),
			},
		).catch((error) => {
			if (isCancellation(error, ctx.signal)) throw error;
			return undefined;
		});
		const free = (
			await host.run("df --output=avail -B1 /mnt/adt-disk-full | tail -1", { operation: "free space" })
		).stdout.trim();
		fault.observed = {
			acksBeforeFill: before,
			freeBytesWhileFull: Number(free),
			appendError: failure?.error ?? null,
			probe: await host.json(volume.probe, { operation: "probe write" }),
		};
		fault.effectObserved = failure !== undefined && Number(free) < 1024 * 1024;
		await host.run("rm -f /mnt/adt-disk-full/filler", { operation: "remove filler" });
		mark("filler removed");
		const resumed = await writer.acks();
		await waitFor(async () => (await writer.acks()) >= resumed + 3, {
			timeoutMs: 120_000,
			intervalMs: 1000,
			signal: ctx.signal,
			onTimeout: () => new Error("appends did not resume"),
		});
		fault.recovered = true;
	});

	await local("slow-disk", 256, async (volume, writer, fault, mark) => {
		const baseline = await host.json(volume.probe, { operation: "baseline probe" });
		await host.run(volume.swap("delay", 100), { operation: "swap in dm-delay" });
		fault.applied = true;
		mark("delay target active");
		const before = await writer.acks();
		const slow = await host.json(volume.probe, { operation: "delayed probe", timeoutMs: 120_000 });
		await sleep(10_000);
		const acksDuring = (await writer.acks()) - before;
		await host.run(volume.swap("linear"), { operation: "swap linear back" });
		mark("linear target restored");
		const after = await host.json(volume.probe, { operation: "restored probe" });
		fault.observed = {
			baselineProbeMs: baseline.ms,
			delayedProbeMs: slow.ms,
			restoredProbeMs: after.ms,
			acksDuringWindow: acksDuring,
		};
		fault.effectObserved = slow.result === "ok" && slow.ms >= 8 * 100;
		fault.recovered = after.ms < slow.ms / 2;
	});

	await local("io-error", 256, async (volume, writer, fault, mark) => {
		await host.run("sync", { operation: "flush before fault" });
		const acked = (await writer.records()).filter((record) => record.event === "ack");
		const lastIndex = acked.at(-1)?.index ?? -1;
		await host.run(volume.swap("error"), { operation: "swap in dm-error" });
		fault.applied = true;
		mark("error target active");
		const probe = await host.json(volume.probe, { operation: "probe with errors" });
		await sleep(10_000);
		await host.run(volume.swap("linear"), { operation: "swap linear back" });
		mark("linear target restored");
		fault.observed = { acksBeforeFault: lastIndex + 1, probe };
		fault.effectObserved = probe.result === "Input/output error";
	});
	return { invariants };
}
