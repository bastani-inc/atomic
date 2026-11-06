// @ts-check
/**
 * The `idle-density` suite (#4394): background subagents released on one node and woken across nodes. The first
 * node runs the owner, a session whose background subagents each wait on a shell task of their own and are released.
 * Every other node runs a sender that messages each child through its own Intercom broker, which routes through the
 * shared store on sqld. Faults are injected one at a time, each only after the senders made progress, and each
 * reverted before the next: latency and loss towards the database from the owner's node, a partition of a sender
 * node, SIGSTOP of a sender's broker, a skewed sender clock, a throttled and a full disk under sqld, and last SIGKILL
 * of the owner node's broker and of the owner, so the faults before them run against a recovered owner. Then the
 * senders stop, the children settle, the owner stops, and the children's transcripts are read back and checked
 * (`released-invariants.mjs`).
 *
 * The orchestration talks to the nodes only through a `ReleasedRemote`, so it runs the same against a fake fleet.
 */

import {
	iptablesRules,
	netemParameters,
	netemScript,
	PROFILE_SPECS,
	parseCounters,
	parseNetemStats,
} from "./chaos.mjs";
import { shellQuote } from "./commands.mjs";
import { attachCleanupFailure, DistributedTimeoutError, isCancellation, serializeDistributedError } from "./errors.mjs";
import { checkReleasedInvariants, releasedMetrics } from "./released-invariants.mjs";
import {
	REF_DIR,
	RELEASED,
	REMOTE_ROOT,
	readJsonLinesFile,
	SECRETS,
	startAgentUnit,
	UndoScope,
	waitFor,
} from "./remote.mjs";
import { exerciseProfile } from "./suites.mjs";

/**
 * The scenario's sizes and time budgets. The settle window starts after the senders stopped and lasts at least
 * `settleMinMs`: the three 30-second recovery windows of multi-node Intercom (a stale outbox claim, a stale broker
 * lease and the outbox's backup poll) plus 30 seconds, so an accepted message that waits for one of them can still
 * arrive before the children are read back.
 * @type {Readonly<ReleasedSettings>}
 */
export const RELEASED_SETTINGS = Object.freeze({
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

/**
 * @typedef {{ children: number, workers: number, paceMs: number, windowMs: number, skewSeconds: number, pollMs: number,
 *   launchTimeoutMs: number, progressTimeoutMs: number, recoveryTimeoutMs: number, sendersStopTimeoutMs: number,
 *   settleMinMs: number, settleMaxMs: number }} ReleasedSettings
 * @typedef {import("./suites.mjs").NodeHost} NodeHost
 * @typedef {import("./suites.mjs").FaultRecord} FaultRecord
 * @typedef {import("./suites.mjs").FaultRun} FaultRun
 * @typedef {import("./released-invariants.mjs").OwnerRecord} OwnerRecord
 * @typedef {import("./released-invariants.mjs").SenderRecord} SenderRecord
 * @typedef {import("./released-invariants.mjs").Inspection} Inspection
 * @typedef {{ name: string, host: NodeHost }} SenderSlot
 * @typedef {{ outcomes: number, delivered: number }} Tally
 * @typedef {{ result: string, ms: number }} DiskProbe
 * @typedef {{ apply: () => Promise<void>, clear: () => Promise<void>, observe: () => Promise<Record<string, unknown>>,
 *   effect: (observed: Record<string, unknown>) => boolean, cleared: () => Promise<boolean> }} NetworkFault
 * @typedef {{
 *   owner: NodeHost, senders: SenderSlot[], database: string,
 *   undo: <T>(step: () => Promise<T>) => Promise<T>,
 *   startOwner: (children: number) => Promise<void>,
 *   children: () => Promise<string[] | undefined>,
 *   startSender: (sender: SenderSlot, children: readonly string[]) => Promise<void>,
 *   tally: (sender: SenderSlot) => Promise<Tally>,
 *   ownerLog: () => Promise<OwnerRecord[] | undefined>,
 *   senderLog: (sender: SenderSlot) => Promise<SenderRecord[] | undefined>,
 *   stopSenders: () => Promise<void>,
 *   stopOwner: () => Promise<void>,
 *   stopAll: () => Promise<void>,
 *   inspect: () => Promise<Inspection>,
 *   integrity: (store: "shared" | "owner") => Promise<string[]>,
 *   ownerRestarts: () => Promise<number>,
 *   killOwner: () => Promise<void>,
 *   brokerPid: (host: NodeHost) => Promise<number | undefined>,
 *   signal: (host: NodeHost, pid: number, signal: "KILL" | "STOP" | "CONT") => Promise<void>,
 *   processState: (host: NodeHost, pid: number) => Promise<string>,
 *   network: (host: NodeHost, profile: "latency" | "loss" | "partition", seed: number) => NetworkFault,
 *   clockOffsetMs: (host: NodeHost) => Promise<number>,
 *   skewClock: (host: NodeHost, seconds: number) => Promise<void>,
 *   restoreClock: (host: NodeHost) => Promise<void>,
 *   throttleDisk: () => Promise<string>,
 *   unthrottleDisk: () => Promise<string>,
 *   fillDisk: () => Promise<number>,
 *   freeDisk: () => Promise<void>,
 *   probeDisk: () => Promise<DiskProbe>,
 *   sqldActive: () => Promise<boolean>,
 * }} ReleasedRemote
 * @typedef {{ runId: string, attempt: string, nodes: NodeHost[], primary: import("./remote.mjs").Host,
 *   random: ReturnType<typeof import("./prng.mjs").createRandom>, profiles: readonly string[], gatewayPort: number,
 *   namespace: string, signal?: AbortSignal, log: (line: string) => void, started: number, faults: FaultRecord[],
 *   settings?: Partial<ReleasedSettings> }} ReleasedContext
 * @typedef {ReturnType<typeof releasedMetrics> & { children: number, senders: number, settleMs: number, settled: boolean,
 *   evidenceErrors: import("./errors.mjs").SerializedError[] }} ReleasedMetrics
 */

/**
 * Runs the scenario and returns its fault records, invariant results and metrics.
 * @param {ReleasedContext} ctx
 * @param {ReleasedRemote} [remote]
 */
export async function runReleased(ctx, remote = releasedRemote(ctx)) {
	const settings = { ...RELEASED_SETTINGS, ...ctx.settings };
	const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const { senders, owner } = remote;
	const first = senders[0];
	const last = senders[senders.length - 1];
	/** @type {FaultRun} */
	const faultRun = {
		profiles: ctx.profiles,
		faults: ctx.faults,
		started: ctx.started,
		log: ctx.log,
		undo: remote.undo,
		...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
	};
	/**
	 * @template T
	 * @param {string} phase
	 * @param {number} timeoutMs
	 * @param {() => Promise<T>} probe
	 */
	const until = (phase, timeoutMs, probe) => {
		const begin = performance.now();
		return waitFor(probe, {
			timeoutMs,
			intervalMs: settings.pollMs,
			...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
			onTimeout: () =>
				new DistributedTimeoutError({ phase, timeoutMs, elapsedMs: Math.round(performance.now() - begin) }),
		});
	};
	/** @param {readonly SenderSlot[]} subset */
	const tally = async (subset) => {
		const total = { outcomes: 0, delivered: 0 };
		for (const sender of subset) {
			const counts = await remote.tally(sender);
			total.outcomes += counts.outcomes;
			total.delivered += counts.delivered;
		}
		return total;
	};
	/**
	 * Waits until the senders logged more outcomes (or more deliveries) than they had when it was called.
	 * @param {string} phase
	 * @param {readonly SenderSlot[]} [subset]
	 * @param {keyof Tally} [kind]
	 */
	const progressed = async (phase, subset = senders, kind = "outcomes") => {
		const before = (await tally(subset))[kind];
		await until(
			`${phase}: sender ${kind}`,
			settings.progressTimeoutMs,
			async () => (await tally(subset))[kind] > before,
		);
	};
	let ownerKills = 0;

	/**
	 * A network fault held for one window: injected after the senders made progress, its effect read before it is
	 * cleared, and recovered once nothing of it is left and the senders made progress again.
	 * @param {"latency" | "loss" | "partition"} profile
	 * @param {NodeHost} host
	 * @param {readonly SenderSlot[]} watched
	 */
	const networkFault = (profile, host, watched) => {
		const fault = remote.network(host, profile, ctx.random.integer(1, 2 ** 31 - 1));
		return exerciseProfile(faultRun, {
			profile,
			target: host.name,
			parameters: { windowMs: settings.windowMs },
			apply: async (record, mark, injecting) => {
				await progressed(profile, watched);
				injecting();
				await fault.apply();
				record.applied = true;
				mark("applied");
				await sleep(settings.windowMs);
				record.observed = await fault.observe();
				record.effectObserved = fault.effect(record.observed);
			},
			revert: async (_record, mark) => {
				await fault.clear();
				mark("cleared");
			},
			recover: async (record, mark) => {
				const cleared = await fault.cleared();
				await progressed(`${profile} recovery`, watched);
				record.observed = { ...record.observed, cleared };
				record.recovered = cleared;
				mark("senders progressed");
			},
		});
	};

	/** @param {number} children */
	const ownerStarted = async (children) => {
		const log = (await remote.ownerLog()) ?? [];
		return {
			starts: log.filter((record) => record.event === "owner-start").length,
			rebound: log.filter((record) => record.event === "owner-rebound" && record.children === children),
		};
	};

	const scenario = async () => {
		await remote.startOwner(settings.children);
		ctx.log(`owner started on ${owner.name}`);
		const children = await until("released children", settings.launchTimeoutMs, () => remote.children());
		ctx.log(`${children.length} children released`);
		for (const sender of senders) await remote.startSender(sender, children);
		await progressed("baseline");

		await networkFault("latency", owner, senders);
		await networkFault("loss", owner, senders);
		await networkFault("partition", first.host, [first]);

		{
			/** @type {number | undefined} */
			let stopped;
			await exerciseProfile(faultRun, {
				profile: "sigstop",
				target: `${last.host.name} broker`,
				parameters: { signal: "SIGSTOP", windowMs: settings.windowMs },
				apply: async (record, mark, injecting) => {
					await progressed("sigstop", [last]);
					const pid = await until("sender broker", settings.recoveryTimeoutMs, () => remote.brokerPid(last.host));
					stopped = pid;
					injecting();
					await remote.signal(last.host, pid, "STOP");
					record.applied = true;
					mark(`stopped broker ${pid}`);
					const state = await remote.processState(last.host, pid);
					await sleep(settings.windowMs);
					record.observed = { pid, state };
					record.effectObserved = state === "T";
				},
				revert: async (_record, mark) => {
					await remote.signal(last.host, /** @type {number} */ (stopped), "CONT");
					mark("continued");
				},
				recover: async (record, mark) => {
					const state = await remote.processState(last.host, /** @type {number} */ (stopped));
					await progressed("sigstop recovery", [last]);
					record.observed = { ...record.observed, stateAfter: state };
					record.recovered = state !== "T";
					mark("sender progressed");
				},
			});
		}

		await exerciseProfile(faultRun, {
			profile: "clock-skew",
			target: first.host.name,
			parameters: { offsetSeconds: settings.skewSeconds, windowMs: settings.windowMs },
			apply: async (record, mark, injecting) => {
				await progressed("clock-skew", [first]);
				injecting();
				await remote.skewClock(first.host, settings.skewSeconds);
				record.applied = true;
				mark("skewed");
				const offsetMs = await remote.clockOffsetMs(first.host);
				await progressed("skewed sending", [first]);
				await sleep(settings.windowMs);
				record.observed = { offsetMs };
				record.effectObserved = offsetMs > settings.skewSeconds * 1000 - 10_000;
			},
			revert: async (_record, mark) => {
				await remote.restoreClock(first.host);
				mark("restored");
			},
			recover: async (record, mark) => {
				const offsetAfterMs = await remote.clockOffsetMs(first.host);
				await progressed("clock-skew recovery", [first]);
				record.observed = { ...record.observed, offsetAfterMs };
				record.recovered = Math.abs(offsetAfterMs) < 5000;
				mark("sender progressed");
			},
		});

		await exerciseProfile(faultRun, {
			profile: "slow-disk",
			target: remote.database,
			parameters: { windowMs: settings.windowMs },
			apply: async (record, mark, injecting) => {
				await progressed("slow-disk");
				const baseline = await remote.probeDisk();
				injecting();
				const limit = await remote.throttleDisk();
				record.applied = true;
				mark("throttled");
				const throttled = await remote.probeDisk();
				await sleep(settings.windowMs);
				record.observed = { baselineMs: baseline.ms, throttledMs: throttled.ms, limit };
				record.effectObserved = throttled.result === "ok" && throttled.ms >= baseline.ms + 200;
			},
			revert: async (record, mark) => {
				record.observed = { ...record.observed, limitAfter: await remote.unthrottleDisk() };
				mark("unthrottled");
			},
			recover: async (record, mark) => {
				const restored = await remote.probeDisk();
				await progressed("slow-disk recovery");
				record.observed = { ...record.observed, restoredMs: restored.ms };
				record.recovered = restored.result === "ok" && restored.ms < Number(record.observed.throttledMs) / 2;
				mark("senders progressed");
			},
		});

		await exerciseProfile(faultRun, {
			profile: "disk-full",
			target: remote.database,
			parameters: { windowMs: settings.windowMs },
			apply: async (record, mark, injecting) => {
				await progressed("disk-full");
				injecting();
				const freeBytes = await remote.fillDisk();
				record.applied = true;
				mark("filled");
				const probe = await remote.probeDisk();
				await sleep(settings.windowMs);
				record.observed = { freeBytes, probe: probe.result };
				record.effectObserved = probe.result === "No space left on device";
			},
			revert: async (_record, mark) => {
				await remote.freeDisk();
				mark("freed");
			},
			recover: async (record, mark) => {
				const active = await remote.sqldActive();
				const probe = await remote.probeDisk();
				await progressed("disk-full recovery");
				record.observed = { ...record.observed, sqldActive: active, probeAfter: probe.result };
				record.recovered = active && probe.result === "ok";
				mark("senders progressed");
			},
		});

		await exerciseProfile(faultRun, {
			profile: "sigkill",
			target: `${owner.name} broker`,
			parameters: { signal: "SIGKILL", process: "broker" },
			apply: async (record, mark) => {
				await progressed("sigkill broker");
				const pid = await until("owner broker", settings.recoveryTimeoutMs, () => remote.brokerPid(owner));
				await remote.signal(owner, pid, "KILL");
				record.applied = true;
				mark(`killed broker ${pid}`);
				const replacement = await until("broker replacement", settings.recoveryTimeoutMs, async () => {
					const next = await remote.brokerPid(owner);
					return next !== pid ? next : undefined;
				});
				record.observed = { pid, replacement };
				record.effectObserved = true;
				mark(`broker ${replacement} replaced it`);
			},
			recover: async (record, mark) => {
				await progressed("broker recovery", senders, "delivered");
				record.recovered = true;
				mark("deliveries resumed");
			},
		});

		await exerciseProfile(faultRun, {
			profile: "sigkill",
			target: `${owner.name} owner`,
			parameters: { signal: "SIGKILL", process: "owner" },
			apply: async (record, mark) => {
				await progressed("sigkill owner");
				const before = await ownerStarted(children.length);
				const restartsBefore = await remote.ownerRestarts();
				await remote.killOwner();
				ownerKills++;
				record.applied = true;
				mark("killed");
				const after = await until("owner restart", settings.recoveryTimeoutMs, async () => {
					const current = await ownerStarted(children.length);
					return current.rebound.length > before.rebound.length ? current : undefined;
				});
				const restartsAfter = await remote.ownerRestarts();
				record.observed = { restartsBefore, restartsAfter, startsBefore: before.starts, startsAfter: after.starts };
				record.effectObserved = restartsAfter > restartsBefore && after.starts > before.starts;
				mark("owner restarted and rebound its children");
			},
			recover: async (record, mark) => {
				await progressed("owner recovery", senders, "delivered");
				record.recovered = true;
				mark("deliveries resumed");
			},
		});

		await remote.stopSenders();
		const senderLogs = await until("senders stopping", settings.sendersStopTimeoutMs, async () => {
			const logs = [];
			for (const sender of senders) logs.push({ name: sender.name, records: await remote.senderLog(sender) });
			return logs.every((item) => item.records?.some((record) => record.event === "sender-done")) ? logs : undefined;
		});
		ctx.log("senders stopped; letting the children settle");
		const settleStarted = performance.now();
		await sleep(settings.settleMinMs);
		const settled = await until("children settling", settings.settleMaxMs - settings.settleMinMs, async () => {
			const status = ((await remote.ownerLog()) ?? []).findLast((record) => record.event === "status");
			return status !== undefined &&
				status.children === children.length &&
				status.released === children.length &&
				status.running === 0
				? status
				: undefined;
		}).catch((error) => {
			if (isCancellation(error, ctx.signal)) throw error;
			return undefined;
		});
		const settleMs = Math.round(performance.now() - settleStarted);
		await remote.stopOwner();
		/** @type {import("./errors.mjs").SerializedError[]} */
		const evidenceErrors = [];
		/** @template T @param {() => Promise<T>} read @returns {Promise<T | undefined>} */
		const evidence = async (read) => {
			try {
				return await read();
			} catch (error) {
				if (isCancellation(error, ctx.signal)) throw error;
				evidenceErrors.push(serializeDistributedError(error));
				return undefined;
			}
		};
		const ownerLog = await evidence(() => remote.ownerLog());
		const inspection = await evidence(() => remote.inspect());
		const integrity = {
			shared: await evidence(() => remote.integrity("shared")),
			owner: await evidence(() => remote.integrity("owner")),
		};
		const invariants = checkReleasedInvariants({
			senders: senderLogs,
			owner: ownerLog,
			inspection,
			children,
			integrity,
			ownerKills,
		});
		/** @type {ReleasedMetrics} */
		const metrics = {
			...releasedMetrics(senderLogs),
			children: children.length,
			senders: senders.length,
			settleMs,
			settled: settled !== undefined,
			evidenceErrors,
		};
		/** @type {Record<string, import("./chaos.mjs").ProfileSpec>} */
		const profileSpecs = Object.fromEntries(ctx.profiles.map((profile) => [profile, PROFILE_SPECS[profile]]));
		return { faults: ctx.faults, invariants, metrics, profileSpecs };
	};
	let result;
	try {
		result = await scenario();
	} catch (error) {
		try {
			await remote.stopAll();
		} catch (cleanup) {
			attachCleanupFailure(error, cleanup);
		}
		throw error;
	}
	await remote.stopAll();
	return result;
}

/**
 * The production `ReleasedRemote`: SSH to the run's VMs, the node driver `released.mjs` in systemd units, and fault
 * scripts that touch only the run's own rules, qdiscs, processes and files.
 * @param {ReleasedContext} ctx
 * @returns {ReleasedRemote}
 */
export function releasedRemote(ctx) {
	const scope = new UndoScope({ signal: ctx.signal });
	const nodes = ctx.nodes.map((node) => scope.bind(node));
	const primary = scope.bind(ctx.primary);
	const [owner, ...senderHosts] = nodes;
	const work = `${REMOTE_ROOT}/released-${ctx.attempt}`;
	const storage = [
		"--url",
		`https://${primary.ip}:${ctx.gatewayPort}`,
		"--namespace",
		ctx.namespace,
		"--token-file",
		`${SECRETS}/token`,
		"--prefix",
		`adt_${ctx.attempt.replace(/[^0-9a-z]/gi, "")}_`,
	];
	const settings = { ...RELEASED_SETTINGS, ...ctx.settings };
	const unit = (/** @type {string} */ role) => `adt-${ctx.runId}-released-${role}-${ctx.attempt}`;
	const ownerUnit = unit("owner");
	const senders = senderHosts.map((host, index) => ({ name: `s${index + 1}`, host }));
	const driver = ["--ref-dir", REF_DIR, "--dir", work];
	const data = "/var/lib/adt-sqld";
	const sqldCgroup = "/sys/fs/cgroup/system.slice/adt-sqld.service";
	const device = `DEV=$(findmnt -no SOURCE ${data})`;
	/** @param {import("./remote.mjs").Host} host @param {string} script @param {string} operation */
	const text = async (host, script, operation) => (await host.run(script, { operation })).stdout.trim();
	/** @param {import("./remote.mjs").Host} host @param {string} path */
	const lines = async (host, path) => readJsonLinesFile(host, path);
	return {
		owner,
		senders,
		database: primary.name,
		undo: (step) => scope.undo(step),
		startOwner: (children) =>
			startAgentUnit(owner, {
				unit: ownerUnit,
				script: RELEASED,
				args: ["owner", ...driver, "--children", String(children), ...storage],
				properties: ["Restart=on-failure", "RestartSec=3"],
			}),
		children: async () => {
			const json = await text(owner, `cat ${work}/children.json 2>/dev/null || true`, "read released children");
			return json === "" ? undefined : JSON.parse(json).map((/** @type {{ name: string }} */ child) => child.name);
		},
		startSender: async (sender, children) => {
			const names = Buffer.from(JSON.stringify(children.map((name) => ({ name })))).toString("base64");
			await sender.host.run(`mkdir -p ${work} && echo ${names} | base64 -d > ${work}/children.json`, {
				operation: "write released children",
			});
			await startAgentUnit(sender.host, {
				unit: unit(sender.name),
				script: RELEASED,
				args: [
					"sender",
					...driver,
					"--name",
					sender.name,
					"--children-file",
					`${work}/children.json`,
					"--workers",
					String(settings.workers),
					"--pace-ms",
					String(settings.paceMs),
					...storage,
				],
			});
		},
		tally: async (sender) => {
			const log = `${work}/sender-${sender.name}.jsonl`;
			const [outcomes, delivered] = (
				await text(
					sender.host,
					`grep -cE '"event":"send(-failed)?",' ${log} 2>/dev/null || true; grep -c '"delivered":true' ${log} 2>/dev/null || true`,
					`tally ${sender.name}`,
				)
			)
				.split("\n")
				.map((line) => Number(line) || 0);
			return { outcomes: outcomes ?? 0, delivered: delivered ?? 0 };
		},
		ownerLog: async () =>
			/** @type {OwnerRecord[] | undefined} */ (/** @type {unknown} */ (await lines(owner, `${work}/owner.jsonl`))),
		senderLog: async (sender) =>
			/** @type {SenderRecord[] | undefined} */ (
				/** @type {unknown} */ (await lines(sender.host, `${work}/sender-${sender.name}.jsonl`))
			),
		stopSenders: async () => {
			for (const sender of senders)
				await sender.host.run(`touch ${work}/stop`, { operation: `stop sender ${sender.name}` });
		},
		stopOwner: async () => {
			await owner.run(`sudo systemctl stop ${shellQuote(ownerUnit)}`, {
				operation: "stop released owner",
				timeoutMs: 300_000,
			});
		},
		stopAll: () =>
			scope.undo(async () => {
				const units = [
					{ host: owner, role: "owner" },
					...senders.map((sender) => ({ host: sender.host, role: sender.name })),
				];
				for (const { host, role } of units)
					await host.run(`sudo systemctl stop ${shellQuote(unit(role))} 2>/dev/null || true`, {
						operation: `stop released ${role}`,
						timeoutMs: 300_000,
					});
			}),
		inspect: () => owner.agent("inspect", driver, { script: RELEASED, timeoutMs: 600_000 }),
		integrity: async (store) =>
			(
				await owner.agent(
					"integrity",
					store === "shared"
						? ["--ref-dir", REF_DIR, "--journal", "shared", ...storage.slice(0, 6)]
						: ["--ref-dir", REF_DIR, "--journal", "local", "--path", `${work}/owner.sqlite`],
				)
			).result,
		ownerRestarts: async () =>
			Number(await text(owner, `systemctl show -p NRestarts --value ${shellQuote(ownerUnit)}`, "owner restarts")),
		killOwner: async () => {
			await owner.run(`sudo systemctl kill --signal=SIGKILL --kill-whom=main ${shellQuote(ownerUnit)}`, {
				operation: "sigkill released owner",
			});
		},
		brokerPid: async (host) => {
			const pid = await text(
				host,
				`P=$(cat ${work}/agent/intercom/broker.pid 2>/dev/null || true); if [ -n "$P" ] && kill -0 "$P" 2>/dev/null; then echo "$P"; fi`,
				"broker pid",
			);
			return pid === "" ? undefined : Number(pid);
		},
		signal: async (host, pid, signal) => {
			await host.run(`kill -${signal} ${pid}`, { operation: `${signal} broker ${pid}` });
		},
		processState: async (host, pid) =>
			text(host, `awk '{print $3}' /proc/${pid}/stat 2>/dev/null || echo gone`, `state of ${pid}`),
		network: (host, profile, seed) => {
			const dbIp = primary.ip;
			const port = ctx.gatewayPort;
			if (profile === "partition") {
				const rules = iptablesRules(`adt-${ctx.runId}-released-partition`, "full", { dbIp, port });
				return {
					apply: async () => void (await host.run(rules.apply, { operation: "partition apply" })),
					clear: async () => void (await host.run(rules.clear, { operation: "partition clear" })),
					observe: async () => ({
						counters: parseCounters(await text(host, rules.counters, "partition counters")),
					}),
					effect: (observed) => (Reflect.get(Object(observed.counters), "OUTPUT") ?? 0) > 0,
					cleared: async () =>
						(await text(host, `sudo iptables -S | grep -c 'adt-${ctx.runId}-released' || true`, "rules left")) ===
						"0",
				};
			}
			const script = netemScript({ dbIp, port, parameters: netemParameters(profile, seed) });
			return {
				apply: async () => void (await host.run(script.apply, { operation: `${profile} apply` })),
				clear: async () => void (await host.run(script.clear, { operation: `${profile} clear` })),
				observe: async () => {
					const stats = parseNetemStats(await text(host, script.stats, `${profile} stats`));
					return { netem: stats ?? null };
				},
				effect: (observed) => {
					const packets = Number(Reflect.get(Object(observed.netem), "packets") ?? 0);
					const dropped = Number(Reflect.get(Object(observed.netem), "dropped") ?? 0);
					return packets > 0 && (profile !== "loss" || dropped > 0);
				},
				cleared: async () =>
					(await text(host, "tc qdisc show | grep -c netem || true", `${profile} verify cleared`)) === "0",
			};
		},
		clockOffsetMs: async (host) => (await host.agent("facts", [])).clockMs - Date.now(),
		skewClock: async (host, seconds) => {
			await host.run(
				`sudo systemctl stop chrony 2>/dev/null || sudo systemctl stop chronyd 2>/dev/null || true; sudo date -s @$(( $(date +%s) + ${seconds} )) >/dev/null`,
				{ operation: "skew clock" },
			);
		},
		restoreClock: async (host) => {
			await host.run(
				`sudo date -s @${(Date.now() / 1000).toFixed(3)} >/dev/null; sudo systemctl start chrony 2>/dev/null || sudo systemctl start chronyd 2>/dev/null || true`,
				{ operation: "restore clock" },
			);
		},
		throttleDisk: () =>
			text(
				primary,
				`${device}; sudo systemctl set-property --runtime adt-sqld "IOWriteIOPSMax=$DEV 20" "IOWriteBandwidthMax=$DEV 1M"; cat ${sqldCgroup}/io.max`,
				"throttle sqld writes",
			),
		unthrottleDisk: () =>
			text(
				primary,
				`${device}; sudo systemctl set-property --runtime adt-sqld IOWriteIOPSMax= IOWriteBandwidthMax=; M=$(lsblk -dno MAJ:MIN "$DEV" | tr -d ' '); if grep -q "^$M " ${sqldCgroup}/io.max; then echo "$M wiops=max wbps=max" | sudo tee ${sqldCgroup}/io.max >/dev/null; fi; cat ${sqldCgroup}/io.max`,
				"unthrottle sqld writes",
			),
		fillDisk: async () =>
			Number(
				await text(
					primary,
					`A=$(df -B1 --output=avail ${data} | tail -1 | tr -d ' '); fallocate -l "$A" ${data}/.adt-filler 2>/dev/null || fallocate -l $(( A - 4194304 )) ${data}/.adt-filler; dd if=/dev/zero of=${data}/.adt-filler2 bs=64k 2>/dev/null || true; df -B1 --output=avail ${data} | tail -1 | tr -d ' '`,
					"fill sqld volume",
				),
			),
		freeDisk: async () => {
			await primary.run(`rm -f ${data}/.adt-filler ${data}/.adt-filler2`, { operation: "free sqld volume" });
		},
		probeDisk: () =>
			primary.json(
				`S=$(date +%s%N); if sudo bash -c 'echo $$ > ${sqldCgroup}/cgroup.procs; exec setpriv --reuid=${primary.user} --regid=${primary.user} --init-groups dd if=/dev/zero of=${data}/.adt-probe bs=256k count=16 oflag=direct,dsync' 2>/tmp/adt-probe.err; then R=ok; else R=$(grep -o 'No space left on device\\|Input/output error' /tmp/adt-probe.err | head -1); fi; E=$(date +%s%N); rm -f ${data}/.adt-probe; echo "{\\"result\\":\\"$R\\",\\"ms\\":$(( (E - S) / 1000000 ))}"`,
				{ operation: "probe sqld volume", timeoutMs: 120_000 },
			),
		sqldActive: async () => (await text(primary, "systemctl is-active adt-sqld || true", "sqld state")) === "active",
	};
}
