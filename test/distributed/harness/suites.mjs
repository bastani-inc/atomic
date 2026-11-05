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
	attachCleanupFailure,
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
	readJsonLinesFile,
	readWriterEvidence,
	SECRETS,
	startAgentUnit,
	UndoScope,
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
		capability: "export ResumeError",
		present: exported("ResumeError"),
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
 * @param {Readonly<Record<string, FeatureProbe>>} [probes]
 * @returns {DistributedFeatureUnavailableError | DistributedScenarioPendingError | undefined}
 */
export function featureSkip(suite, capabilities, probes = FEATURE_PROBES) {
	const probe = probes[suite];
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
 *   gatewayPort: number, namespace: string, signal?: AbortSignal, log: (line: string) => void, started: number,
 *   faults: FaultRecord[] }} SmokeContext
 * @typedef {(fault: FaultRecord, mark: (event: string) => void) => Promise<void>} FaultStep
 * @typedef {(fault: FaultRecord, mark: (event: string) => void, injecting: () => void) => Promise<void>} ApplyStep
 * @typedef {{ profile: string, target: string, parameters: Record<string, unknown>, apply: ApplyStep, revert?: FaultStep,
 *   recover?: FaultStep, cleanup?: FaultStep }} FaultSpec
 * @typedef {{ profiles: readonly string[], faults: FaultRecord[], started: number, log: (line: string) => void, signal?: AbortSignal,
 *   undo?: <T>(step: () => Promise<T>) => Promise<T> }} FaultRun
 */

/**
 * Runs one chaos profile when it is selected: `apply` injects the fault and observes its effect, calling `injecting`
 * right before its first change to the target; `revert` undoes it whenever that change was attempted, even when it or
 * the observation failed, so a revert must tolerate a fault that was only partly applied; `recover` observes recovery
 * when nothing failed; `cleanup` always runs last. The first failure becomes the fault's `fault-failed` error and
 * every later one is attached to it as its cleanup cause. A cancellation from any step is rethrown once the revert and
 * cleanup ran. With `run.undo`, `revert` and `cleanup` run inside it.
 * @param {FaultRun} run
 * @param {FaultSpec} spec
 * @returns {Promise<FaultRecord | undefined>}
 */
export async function exerciseProfile(run, { profile, target, parameters, apply, revert, recover, cleanup }) {
	if (!run.profiles.includes(profile)) return undefined;
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
	run.faults.push(fault);
	const mark = (/** @type {string} */ event) => {
		fault.timeline.push({ at: Math.round(performance.now() - run.started), event });
		run.log(`${profile}: ${event}`);
	};
	/** @typedef {"apply" | "observe" | "recover"} FaultStage */
	/** @type {{ error: unknown, stage: FaultStage }[]} */
	const failures = [];
	let injected = false;
	/** @param {(() => Promise<void>) | undefined} step @param {() => FaultStage} stageOf */
	const attempt = async (step, stageOf) => {
		if (step === undefined) return;
		try {
			await step();
		} catch (error) {
			failures.push({ error, stage: stageOf() });
		}
	};
	/** @param {FaultStep | undefined} step */
	const after = (step) => (step === undefined ? undefined : () => step(fault, mark));
	/** @param {FaultStep | undefined} step */
	const undoing = (step) => {
		const undo = run.undo;
		return step === undefined || undo === undefined ? after(step) : () => undo(() => step(fault, mark));
	};
	mark("begin");
	await attempt(
		() =>
			apply(fault, mark, () => {
				injected = true;
			}),
		() => (fault.applied ? "observe" : "apply"),
	);
	if (injected || fault.applied) await attempt(undoing(revert), () => "recover");
	if (failures.length === 0) await attempt(after(recover), () => "recover");
	await attempt(undoing(cleanup), () => "recover");
	if (failures.length === 0) {
		mark("end");
		return fault;
	}
	const [first, ...later] = failures;
	if (later.length > 0) {
		const errors = later.map((item) => item.error);
		attachCleanupFailure(
			first.error,
			errors.length === 1
				? errors[0]
				: new AggregateError(errors, `${errors.length} later steps of ${profile} failed`),
		);
	}
	const cancellation = failures.find((item) => isCancellation(item.error, run.signal));
	if (cancellation === first) throw first.error;
	fault.error = serializeDistributedError(
		new DistributedFaultError({ profile, stage: first.stage, target, cause: first.error }),
	);
	mark(`failed: ${fault.error.message}`);
	if (cancellation !== undefined) throw cancellation.error;
	return fault;
}

const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs the smoke scenario and returns its fault records, invariant results and metrics.
 * @param {SmokeContext} ctx
 */
export async function runSmoke(ctx) {
	const { attempt } = ctx;
	const scope = new UndoScope({ signal: ctx.signal });
	const nodes = ctx.nodes.map((node) => scope.bind(node));
	const primary = scope.bind(ctx.primary);
	const replicaHost = scope.bind(ctx.replica);
	const azure = scope.bind(ctx.azure);
	const journalRun = `${ctx.runId}-smoke-${attempt}`;
	const shared = (/** @type {Host} */ via = primary) => [
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
	const faults = ctx.faults;
	/** @type {FaultRun} */
	const faultRun = {
		profiles: ctx.profiles,
		faults,
		started: ctx.started,
		log: ctx.log,
		undo: (step) => scope.undo(step),
		...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
	};
	/** @type {{ holder: string, epoch: number, outcome: "rejected" | "appended", error?: { name: string } }[]} */
	const fencing = [];
	/** @type {Map<string, { host: Host, unit: string, acks: string }>} */
	const writers = new Map();
	/** @type {Record<string, unknown>} */
	const metrics = {};
	const vmNode = nodes.find((node) => node.roles.includes("vm-faults")) ?? nodes[nodes.length - 1];
	const others = nodes.filter((node) => node !== vmNode);
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

	const dbIp = primary.ip;
	const port = ctx.gatewayPort;
	let current = await startWriter(first, { lease: "acquire" });
	await waitAcks(current, 5);
	const holderHost = () => /** @type {{ host: Host }} */ (writers.get(current)).host;
	/** @param {string} label */
	const resumed = async (label) => {
		const after = await ackCount(current);
		await waitAcks(current, after + 3, 240_000);
		return label;
	};

	/** @param {Host} host @param {"full" | "asymmetric" | "reset"} kind @param {string} profile */
	const iptablesFault = (host, kind, profile) => {
		const rules = iptablesRules(`adt-${ctx.runId}-${profile}`, kind, { dbIp, port });
		return exerciseProfile(faultRun, {
			profile,
			target: host.name,
			parameters: { kind, windowMs: 20_000 },
			apply: async (fault, mark, injecting) => {
				const gatewayBefore = await gatewayRequests(primary);
				injecting();
				await host.run(rules.apply, { operation: `${profile} apply` });
				fault.applied = true;
				mark("applied");
				const before = await ackCount(current);
				await sleep(20_000);
				const during = (await ackCount(current)) - before;
				const counters = parseCounters(
					(await host.run(rules.counters, { operation: `${profile} counters` })).stdout,
				);
				const gatewayDuring = (await gatewayRequests(primary)) - gatewayBefore;
				fault.observed = { acksDuringWindow: during, counters, gatewayRequestsDuringWindow: gatewayDuring };
				fault.effectObserved =
					kind === "full"
						? (counters.OUTPUT ?? 0) > 0 && during <= 1
						: kind === "asymmetric"
							? (counters.INPUT ?? 0) > 0 && counters.OUTPUT === undefined && gatewayDuring > 0
							: (counters.OUTPUT ?? 0) > 0;
			},
			revert: async (_fault, mark) => {
				await host.run(rules.clear, { operation: `${profile} clear` });
				mark("cleared");
			},
			recover: async (fault, mark) => {
				mark(await resumed("acknowledgements resumed"));
				fault.recovered = true;
			},
		});
	};

	/** @param {Host} host @param {string} profile */
	const netemFault = (host, profile) => {
		const parameters = netemParameters(profile, ctx.random.integer(1, 2 ** 31 - 1));
		const script = netemScript({ dbIp, port, parameters });
		return exerciseProfile(faultRun, {
			profile,
			target: host.name,
			parameters: { netem: parameters, windowMs: 20_000 },
			apply: async (fault, mark, injecting) => {
				const baselineFrom = Date.now();
				await sleep(15_000);
				const baselineTo = Date.now();
				injecting();
				await host.run(script.apply, { operation: `${profile} apply` });
				fault.applied = true;
				mark("applied");
				await sleep(20_000);
				const stats = parseNetemStats((await host.run(script.stats, { operation: `${profile} stats` })).stdout);
				const all = await records(current);
				const before = latencyStats(all, { from: baselineFrom, to: baselineTo });
				const during = latencyStats(all, { from: baselineTo, to: Date.now() });
				fault.observed = { before, during, netem: stats ?? null };
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
			},
			revert: async (_fault, mark) => {
				await host.run(script.clear, { operation: `${profile} clear` });
				mark("cleared");
			},
			recover: async (fault, mark) => {
				const qdisc = Number(
					(
						await host.run("tc qdisc show | grep -c netem || true", { operation: `${profile} verify cleared` })
					).stdout.trim(),
				);
				fault.observed = { ...fault.observed, netemQdiscsAfterClear: qdisc };
				mark(await resumed("acknowledgements resumed"));
				fault.recovered = qdisc === 0;
			},
		});
	};

	await iptablesFault(first, "full", "partition");

	await exerciseProfile(faultRun, {
		profile: "sigkill",
		target: first.name,
		parameters: { signal: "SIGKILL", replacement: second.name },
		apply: async (fault, mark) => {
			const victim = current;
			const writer = /** @type {{ host: Host, unit: string }} */ (writers.get(victim));
			const before = await records(victim);
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
			fault.observed = {
				victim,
				lastEpoch: before.filter((record) => record.event === "lease").at(-1)?.epoch ?? 1,
				unit: state,
				acksBeforeKill: before.filter((record) => record.event === "ack").length,
			};
			fault.effectObserved = state.pid === 0 && state.result === "signal";
		},
		recover: async (fault, mark) => {
			const victim = String(fault.observed.victim);
			const lastEpoch = Number(fault.observed.lastEpoch);
			const writer = /** @type {{ host: Host }} */ (writers.get(victim));
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
		},
	});

	for (const profile of ["latency", "jitter", "loss", "bandwidth"]) await netemFault(holderHost(), profile);
	await iptablesFault(holderHost(), "reset", "reset");
	await iptablesFault(holderHost(), "asymmetric", "asymmetric-partition");

	{
		const stopped = current;
		const writer = /** @type {{ host: Host, unit: string }} */ (writers.get(stopped));
		await exerciseProfile(faultRun, {
			profile: "sigstop",
			target: writer.host.name,
			parameters: { signal: "SIGSTOP", takeover: vmNode.name },
			apply: async (fault, mark, injecting) => {
				injecting();
				await writer.host.run(`sudo systemctl kill --signal=SIGSTOP --kill-whom=main ${shellQuote(writer.unit)}`, {
					operation: "sigstop writer",
				});
				fault.applied = true;
				mark("stopped");
				const state = await unitState(writer.host, writer.unit);
				const replacement = await startWriter(vmNode, {});
				current = replacement;
				const lease = await waitEvent(replacement, "lease", 240_000);
				await waitAcks(replacement, 3);
				fault.observed = { processState: state.state, takeoverEpoch: lease.epoch ?? null };
				fault.effectObserved = state.state === "T" && typeof lease.epoch === "number";
			},
			revert: async (_fault, mark) => {
				await writer.host.run(`sudo systemctl kill --signal=SIGCONT --kill-whom=main ${shellQuote(writer.unit)}`, {
					operation: "sigcont writer",
				});
				mark("continued");
			},
			recover: async (fault, mark) => {
				const fenced = await waitEvent(stopped, "fenced", 120_000);
				const takeoverEpoch = Number(fault.observed.takeoverEpoch);
				fencing.push({
					holder: stopped,
					epoch: takeoverEpoch - 1,
					outcome: "rejected",
					...(fenced.error === undefined ? {} : { error: fenced.error }),
				});
				fault.observed = { ...fault.observed, staleWriter: fenced };
				fault.recovered = fenced.error?.name === "StaleLeaseError";
				mark("stale writer fenced");
			},
		});
	}

	const skewHost = first;
	await exerciseProfile(faultRun, {
		profile: "clock-skew",
		target: skewHost.name,
		parameters: { offsetSeconds: 600 },
		apply: async (fault, mark, injecting) => {
			injecting();
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
		},
		revert: async (_fault, mark) => {
			await skewHost.run(
				`sudo date -s @${(Date.now() / 1000).toFixed(3)} >/dev/null; sudo systemctl start chrony 2>/dev/null || sudo systemctl start chronyd 2>/dev/null || true`,
				{ operation: "restore clock" },
			);
			mark("restored");
		},
		recover: async (fault) => {
			const restored = (await skewHost.agent("facts", [])).clockMs - Date.now();
			fault.observed = { ...fault.observed, offsetAfterMs: restored };
			fault.recovered = Math.abs(restored) < 5000 && fault.observed.skewedTakeover === "refused";
		},
	});

	{
		const holder = `w${++sequence}-oom-${attempt}-${first.name}`;
		const acks = `${REMOTE_ROOT}/logs/${holder}.jsonl`;
		const cgroup = `/sys/fs/cgroup/adt-${ctx.runId}-oom-${attempt}`;
		await exerciseProfile(faultRun, {
			profile: "oom",
			target: first.name,
			parameters: { memoryMaxMb: 384, hogMb: 2048 },
			apply: async (fault, mark, injecting) => {
				await stopWriter(current);
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
				injecting();
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
						const text = (await first.run(`cat ${cgroup}/memory.events`, { operation: "read memory.events" }))
							.stdout;
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
				const procs = (
					await first.run(`cat ${cgroup}/cgroup.procs`, { operation: "read cgroup procs" })
				).stdout.trim();
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
			},
			revert: async (_fault, mark) => {
				await first.run(
					`if [ -d ${cgroup} ]; then for pid in $(cat ${cgroup}/cgroup.procs); do sudo kill -KILL "$pid" || true; done; sudo rmdir ${cgroup}; fi`,
					{
						operation: "remove cgroup",
					},
				);
				mark("cgroup removed");
			},
			recover: async (fault, mark) => {
				current = await startWriter(second, {});
				const lease = await waitEvent(current, "lease", 240_000);
				await waitAcks(current, 3);
				fault.recovered = typeof lease.epoch === "number";
				mark(`replacement at epoch ${lease.epoch}`);
			},
		});
	}

	/**
	 * Starts the VM-fault node unless Azure reports it running, then waits until SSH answers.
	 * @param {(event: string) => void} mark
	 */
	const ensureRunning = async (mark) => {
		if ((await azure.vmFacts(vmNode.vmName)).powerState !== "VM running") {
			await azure.vmPower(vmNode.vmName, "start", { wait: false });
			mark("start requested");
		}
		await vmNode.waitForSsh();
		mark("running");
	};

	await exerciseProfile(faultRun, {
		profile: "vm-restart",
		target: vmNode.vmName,
		parameters: {},
		apply: async (fault, mark, injecting) => {
			await stopWriter(current);
			const holder = await startWriter(vmNode, {});
			current = holder;
			await waitAcks(holder, 3);
			const bootBefore = (await vmNode.agent("facts", [])).bootId;
			injecting();
			await azure.vmPower(vmNode.vmName, "restart", { wait: false });
			fault.applied = true;
			mark("restart requested");
			const bootAfter = await waitFor(
				async () => {
					const { bootId } = await vmNode.agent("facts", []);
					return bootId === bootBefore ? undefined : bootId;
				},
				{
					timeoutMs: 600_000,
					intervalMs: 5000,
					signal: ctx.signal,
					onTimeout: () => new Error("the VM did not boot again within 10 minutes"),
				},
			);
			mark("rebooted");
			const unit = await unitState(vmNode, /** @type {{ unit: string }} */ (writers.get(holder)).unit);
			fault.observed = { bootBefore, bootAfter, writerUnit: unit };
			fault.effectObserved = unit.pid === 0;
		},
		revert: (_fault, mark) => ensureRunning(mark),
		recover: async (fault, mark) => {
			current = await startWriter(first, {});
			const lease = await waitEvent(current, "lease", 240_000);
			await waitAcks(current, 3);
			fault.recovered = typeof lease.epoch === "number";
			mark(`replacement at epoch ${lease.epoch}`);
		},
	});

	await exerciseProfile(faultRun, {
		profile: "vm-deallocate",
		target: vmNode.vmName,
		parameters: {},
		apply: async (fault, mark, injecting) => {
			const bootBefore = (await vmNode.agent("facts", [])).bootId;
			injecting();
			await azure.vmPower(vmNode.vmName, "deallocate");
			fault.applied = true;
			const power = (await azure.vmFacts(vmNode.vmName)).powerState;
			mark(`power state ${power}`);
			fault.observed = { powerStateWhileDeallocated: power, bootBefore };
			fault.effectObserved = power === "VM deallocated";
		},
		revert: (_fault, mark) => ensureRunning(mark),
		recover: async (fault, mark) => {
			const bootAfter = (await vmNode.agent("facts", [])).bootId;
			fault.observed = { ...fault.observed, bootAfter };
			await stopWriter(current);
			const holder = await startWriter(vmNode, { count: "5" });
			await waitEvent(holder, "done", 240_000);
			current = holder;
			fault.recovered = bootAfter !== fault.observed.bootBefore;
			mark("node wrote again");
		},
	});

	{
		const nic = `${vmNode.vmName}-nic2`;
		await exerciseProfile(faultRun, {
			profile: "nic-detach",
			target: vmNode.vmName,
			parameters: { nic },
			apply: async (fault, mark, injecting) => {
				await stopWriter(current);
				const before = await azure.vmFacts(vmNode.vmName);
				fault.observed = { nicsBefore: before.nics };
				injecting();
				await azure.vmPower(vmNode.vmName, "deallocate");
				await azure.vmNic(vmNode.vmName, nic, "remove");
				fault.applied = true;
				await azure.vmPower(vmNode.vmName, "start", { wait: false });
				await vmNode.waitForSsh();
				const detached = await azure.vmFacts(vmNode.vmName);
				const guestLinks = Number(
					(await vmNode.run("ip -o link show | grep -vc ' lo:'", { operation: "count links" })).stdout.trim(),
				);
				mark(`running with ${detached.nics} NIC(s)`);
				const holder = await startWriter(vmNode, { count: "5" });
				await waitEvent(holder, "done", 240_000);
				fault.observed = { nicsBefore: before.nics, nicsDetached: detached.nics, guestLinksDetached: guestLinks };
				fault.effectObserved = detached.nics === before.nics - 1;
			},
			revert: async (fault, mark) => {
				/** @type {unknown} */
				let failure;
				try {
					if ((await azure.vmFacts(vmNode.vmName)).nics < Number(fault.observed.nicsBefore)) {
						await azure.vmPower(vmNode.vmName, "deallocate");
						await azure.vmNic(vmNode.vmName, nic, "add");
						mark("NIC re-added");
					}
				} catch (error) {
					failure = error;
				}
				try {
					await ensureRunning(mark);
				} catch (error) {
					if (failure === undefined) throw error;
					attachCleanupFailure(failure, error);
				}
				if (failure !== undefined) throw failure;
			},
			recover: async (fault, mark) => {
				const restored = await azure.vmFacts(vmNode.vmName);
				fault.observed = { ...fault.observed, nicsRestored: restored.nics };
				current = await startWriter(vmNode, { count: "5" });
				await waitEvent(current, "done", 240_000);
				fault.recovered = restored.nics === fault.observed.nicsBefore;
				mark("node wrote again");
			},
		});
	}

	const disk = await runDiskProfiles(ctx, second, faultRun);

	if (writers.get(current)?.unit !== "") await stopWriter(current);
	const finalHolder = await startWriter(first, { count: "5" });
	await waitEvent(finalHolder, "done", 240_000);
	const read = await first.agent("read", [...shared(), "--run", journalRun]);
	const integrity = await first.agent("integrity", shared());
	const replica = await waitFor(
		async () => {
			const copy = await first.agent("read", [...shared(replicaHost), "--run", journalRun]);
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
	const evidence = await readWriterEvidence([...writers].map(([holder, writer]) => ({ holder, ...writer })));
	const allRecords = evidence.records;
	const invariants = checkJournalInvariants({
		entries: read.entries,
		records: allRecords,
		fencing,
		integrity: integrity.result,
		expectations: { minAcks: 10, requireCompletion: true },
	});
	invariants.push({
		name: "writer-evidence-complete",
		passed: evidence.missing.length === 0,
		expected: { writers: writers.size, missing: [] },
		actual: { writers: writers.size, missing: evidence.missing.map((item) => item.holder) },
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
 * @param {FaultRun} faultRun
 */
async function runDiskProfiles(ctx, host, faultRun) {
	/** @type {import("./invariants.mjs").InvariantResult[]} */
	const invariants = [];
	/**
	 * @typedef {{ records: () => Promise<import("./invariants.mjs").WriterRecord[]>, acks: () => Promise<number> }} LocalWriter
	 * @typedef {(volume: ReturnType<typeof dmVolumeScript>, writer: LocalWriter, fault: FaultRecord, mark: (event: string) => void) => Promise<void>} DiskStep
	 * @typedef {(volume: ReturnType<typeof dmVolumeScript>, writer: LocalWriter, fault: FaultRecord, mark: (event: string) => void, injecting: () => void) => Promise<void>} DiskApply
	 */
	/**
	 * @param {string} profile
	 * @param {number} sizeMb
	 * @param {{ apply: DiskApply, revert: DiskStep, recover?: DiskStep }} steps
	 */
	const local = (profile, sizeMb, steps) => {
		const name = `adt-${profile}`;
		const volume = dmVolumeScript({ name, sizeMb, user: host.user });
		const holder = `local-${profile}-${ctx.attempt}`;
		const unit = `adt-${ctx.runId}-${holder}`;
		const acks = `${REMOTE_ROOT}/logs/${holder}.jsonl`;
		const journal = ["--ref-dir", REF_DIR, "--journal", "local", "--path", `/mnt/${name}/journal.sqlite`];
		const journalRun = `${ctx.runId}-${profile}-${ctx.attempt}`;
		/** @type {LocalWriter} */
		const writer = {
			records: () => readJsonLines(host, acks),
			acks: async () => (await readJsonLines(host, acks)).filter((record) => record.event === "ack").length,
		};
		const stopWriter = () =>
			host.run(`sudo systemctl stop ${shellQuote(unit)} || true`, { operation: `stop ${unit}`, timeoutMs: 120_000 });
		let created = false;
		return exerciseProfile(faultRun, {
			profile,
			target: host.name,
			parameters: { sizeMb },
			apply: async (fault, mark, injecting) => {
				await host.run(volume.create, { operation: `create ${name}` });
				created = true;
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
				await waitFor(async () => (await writer.acks()) >= 5, {
					timeoutMs: 120_000,
					intervalMs: 1000,
					signal: ctx.signal,
					onTimeout: () => new Error(`${holder} did not start`),
				});
				await steps.apply(volume, writer, fault, mark, injecting);
			},
			revert: (fault, mark) => steps.revert(volume, writer, fault, mark),
			recover: async (fault, mark) => {
				await steps.recover?.(volume, writer, fault, mark);
				await stopWriter();
				if (profile === "io-error") {
					const fsck = await host.json(volume.remount, { operation: "check and remount" });
					fault.observed = { ...fault.observed, fsckExit: fsck.fsck, remounted: fsck.mounted };
					fault.recovered = fsck.mounted === true;
					mark(`filesystem checked (e2fsck exit ${fsck.fsck}) and remounted`);
				}
				const read = await host.agent("read", [...journal, "--run", journalRun]);
				const integrity = await host.agent("integrity", journal);
				const evidence = await readJsonLinesFile(host, acks);
				invariants.push({
					name: `${profile}/writer-evidence-complete`,
					passed: evidence !== undefined,
					expected: { writers: 1, missing: [] },
					actual: { writers: 1, missing: evidence === undefined ? [holder] : [] },
				});
				const all = evidence ?? [];
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
			},
			cleanup: async () => {
				await stopWriter();
				if (created) await host.run(volume.remove, { operation: `remove ${name}` });
			},
		});
	};

	await local("disk-full", 64, {
		apply: async (volume, writer, fault, mark, injecting) => {
			const before = await writer.acks();
			injecting();
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
		},
		revert: async (_volume, _writer, _fault, mark) => {
			await host.run("rm -f /mnt/adt-disk-full/filler", { operation: "remove filler" });
			mark("filler removed");
		},
		recover: async (_volume, writer, fault) => {
			const resumedAt = await writer.acks();
			await waitFor(async () => (await writer.acks()) >= resumedAt + 3, {
				timeoutMs: 120_000,
				intervalMs: 1000,
				signal: ctx.signal,
				onTimeout: () => new Error("appends did not resume"),
			});
			fault.recovered = true;
		},
	});

	await local("slow-disk", 256, {
		apply: async (volume, writer, fault, mark, injecting) => {
			const baseline = await host.json(volume.probe, { operation: "baseline probe" });
			injecting();
			await host.run(volume.swap("delay", 100), { operation: "swap in dm-delay" });
			fault.applied = true;
			mark("delay target active");
			const before = await writer.acks();
			const slow = await host.json(volume.probe, { operation: "delayed probe", timeoutMs: 120_000 });
			await sleep(10_000);
			fault.observed = {
				baselineProbeMs: baseline.ms,
				delayedProbeMs: slow.ms,
				acksDuringWindow: (await writer.acks()) - before,
			};
			fault.effectObserved = slow.result === "ok" && slow.ms >= 8 * 100;
		},
		revert: async (volume, _writer, _fault, mark) => {
			await host.run(volume.swap("linear"), { operation: "swap linear back" });
			mark("linear target restored");
		},
		recover: async (volume, _writer, fault) => {
			const after = await host.json(volume.probe, { operation: "restored probe" });
			fault.observed = { ...fault.observed, restoredProbeMs: after.ms };
			fault.recovered = after.ms < Number(fault.observed.delayedProbeMs) / 2;
		},
	});

	await local("io-error", 256, {
		apply: async (volume, writer, fault, mark, injecting) => {
			await host.run("sync", { operation: "flush before fault" });
			const acked = (await writer.records()).filter((record) => record.event === "ack");
			fault.observed = { acksBeforeFault: (acked.at(-1)?.index ?? -1) + 1 };
			injecting();
			await host.run(volume.swap("error"), { operation: "swap in dm-error" });
			fault.applied = true;
			mark("error target active");
			const probe = await host.json(volume.probe, { operation: "probe with errors" });
			await sleep(10_000);
			fault.observed = { ...fault.observed, probe };
			fault.effectObserved = probe.result === "Input/output error";
		},
		revert: async (volume, _writer, _fault, mark) => {
			await host.run(volume.swap("linear"), { operation: "swap linear back" });
			mark("linear target restored");
		},
	});
	return { invariants };
}
