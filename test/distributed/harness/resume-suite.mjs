// @ts-check
/**
 * The multi-node-resume suite (#4329). Three private nodes run the same TypeScript fixtures as the reduced CI tests,
 * against one authenticated sqld namespace, through all seven acceptance scenarios: a session (1), a workflow bound to
 * two repositories (2), a pooled campaign that loses a worker host (3), a fork on a third node (4), a released session
 * woken on another node (5) and a node without Git (6), each with chaos (7). The remote interface is injectable so
 * orchestration can be tested without Azure; each observation comes from the actual fixture or filesystem on its node,
 * not from a simulated worker.
 */
import { attachCleanupFailure, isCancellation, serializeDistributedError } from "./errors.mjs";
import { checkResumeInvariants, RESUME_SCENARIO_FAULTS } from "./resume-invariants.mjs";
import { resumeRemote } from "./resume-remote.mjs";
import { exerciseProfile } from "./suites.mjs";

/** A killed owner remains live to other journal users for two minutes; wait out the real window rather than editing its lease. */
export const RESUME_LEASE_WAIT_MS = 125_000;
/** Fixture startup, a real git restore, or Git provisioning may each do network and filesystem work. */
export const RESUME_STEP_TIMEOUT_MS = 300_000;

/** Fault descriptions specific to resume, rather than the smoke suite's writer workload.
 * @type {Readonly<Record<"partition" | "sigkill", import("./chaos.mjs").ProfileSpec>>}
 */
const RESUME_PROFILE_SPECS = {
	partition: {
		layer: "network",
		mechanism:
			"iptables DROP between a node and the database gateway: during a session, run or wake lookup (scenarios 1, 2, 5) and on the git-less node before Git is provisioned (scenario 6)",
		effect: "packet drops and a retryable session or run catalog timeout before restoration",
		recovery: "remove the run's rules and resume against the restored connection",
	},
	sigkill: {
		layer: "process",
		mechanism:
			"SIGKILL of a resume or fork process immediately after git worktree add (scenarios 1, 4), of a workflow owner mid-step (scenario 2) and of a worker host holding a bound child (scenario 3)",
		effect: "the run-owned kill marker and SIGKILL exit are observed",
		recovery: "retry or reclaim the work and verify the restored tree without a partial published worktree",
	},
};

/**
 * @typedef {import("./suites.mjs").NodeHost} NodeHost
 * @typedef {import("./suites.mjs").FaultRecord} FaultRecord
 * @typedef {import("./resume-invariants.mjs").ResumeEvidence} ResumeEvidence
 * @typedef {import("./resume-invariants.mjs").FailureObservation} FailureObservation
 * @typedef {{ durations: Record<string, number>, chaosByScenario: Record<string, string[]>,
 *   executionError?: import("./errors.mjs").SerializedError,
 *   scenarioErrors?: { scenario: string, error: import("./errors.mjs").SerializedError }[] }} ResumeMetrics
 * @typedef {{ runId: string, attempt: string, nodes: NodeHost[], primary: import("./remote.mjs").Host,
 *   profiles: readonly string[], gatewayPort: number, namespace: string, signal?: AbortSignal,
 *   log: (line: string) => void, started: number, faults: FaultRecord[] }} ResumeContext
 * @typedef {{ id: string, source: NonNullable<ResumeEvidence["source"]> }} RecordedSession
 * @typedef {{ sessionId?: string, snapshots?: number, cwd?: string, userMessages?: number, status?: string,
 *   notices?: readonly { message?: string }[], toolResult?: readonly { text?: string }[],
 *   mappings?: readonly { from?: string, to?: string }[], ready?: boolean, releasedCwd?: string,
 *   result?: Readonly<Record<string, string>>, error?: import("./resume-invariants.mjs").ResumeError }} DriverOutput
 * @typedef {{ code: number, signal: string | null, output: DriverOutput }} DriverResult
 * @typedef {{ away: RecordedSession & { path: string }, samePath: RecordedSession & { path: string } }} ReleasedSessions
 * @typedef {{ prepare: () => Promise<void>, recordSession: () => Promise<RecordedSession>,
 *   partitionSession: (id: string) => Promise<NonNullable<ResumeEvidence["sessionPartition"]>>,
 *   killSessionRestore: (id: string) => Promise<NonNullable<ResumeEvidence["sessionKilled"]>>,
 *   resumeSession: (id: string) => Promise<{ observation: NonNullable<ResumeEvidence["session"]>, clean: boolean }>,
 *   gitlessFailure: (id: string) => Promise<NonNullable<ResumeEvidence["gitlessFailure"]>>,
 *   partitionGitless: (id: string) => Promise<NonNullable<ResumeEvidence["gitlessPartition"]>>,
 *   gitlessResume: (id: string) => Promise<NonNullable<ResumeEvidence["gitless"]>>,
 *   recordRun: () => Promise<{ id: string, killed: NonNullable<ResumeEvidence["twoKilled"]> }>,
 *   waitForLease: () => Promise<void>, partitionRun: (id: string) => Promise<NonNullable<ResumeEvidence["runPartition"]>>,
 *   resumeRun: (id: string) => Promise<NonNullable<ResumeEvidence["two"]>>,
 *   startPool: () => Promise<void>, killPoolHost: () => Promise<NonNullable<ResumeEvidence["poolKilled"]>>,
 *   finishPool: () => Promise<NonNullable<ResumeEvidence["pool"]>>,
 *   releaseSessions: () => Promise<ReleasedSessions>,
 *   partitionWake: (id: string, path: string) => Promise<NonNullable<ResumeEvidence["wakePartition"]>>,
 *   wake: (id: string, path: string) => Promise<NonNullable<ResumeEvidence["woken"]>>,
 *   wakeAtSamePath: (id: string, path: string) => Promise<NonNullable<ResumeEvidence["wokenAtSamePath"]>>,
 *   recordFork: () => Promise<string>, killFork: (id: string) => Promise<NonNullable<ResumeEvidence["forkKilled"]>>,
 *   fork: (id: string) => Promise<NonNullable<ResumeEvidence["fork"]>>, integrity: () => Promise<readonly string[]>,
 *   undo: <T>(step: () => Promise<T>) => Promise<T>, close: () => Promise<void> }} ResumeRemote
 */

/**
 * Which selected profile hit which scenario, as the fault records show it: a profile counts for a scenario when one of
 * its records there was applied, observed and recovered. Scenario 7 (chaos during each) is the union of the others.
 * @param {readonly FaultRecord[]} faults
 * @returns {Record<string, string[]>}
 */
export function chaosByScenario(faults) {
	/** @type {Record<string, string[]>} */
	const hit = {};
	for (const fault of faults) {
		const scenario = fault.parameters.scenario;
		if (typeof scenario !== "number" || !(fault.applied && fault.effectObserved && fault.recovered)) continue;
		for (const key of [String(scenario), "7"]) {
			const profiles = hit[key] ?? [];
			if (!profiles.includes(fault.profile)) profiles.push(fault.profile);
			hit[key] = profiles;
		}
	}
	for (const profiles of Object.values(hit)) profiles.sort();
	return hit;
}

/**
 * Runs every scenario and the selected fault profiles. A fault that is not selected leaves its required evidence
 * absent, so it cannot make the full acceptance suite pass without actually exercising it; a fault that is part of the
 * scenario itself (a lost owner or worker host) happens either way and is recorded when its profile is selected. A
 * scenario that fails is recorded and the independent ones still run.
 * @param {ResumeContext} ctx
 * @param {ResumeRemote} [remote]
 */
export async function runMultiNodeResume(ctx, remote = resumeRemote(ctx)) {
	/** @type {ResumeEvidence} */
	const evidence = {};
	/** @type {Record<string, number>} */
	const durations = {};
	/** @template T @param {string} name @param {() => Promise<T>} action */
	const step = async (name, action) => {
		const start = performance.now();
		try {
			ctx.log(`multi-node-resume: ${name}`);
			return await action();
		} finally {
			durations[name] = Math.round(performance.now() - start);
		}
	};
	/** @type {import("./suites.mjs").FaultRun} */
	const faultRun = {
		profiles: ctx.profiles,
		faults: ctx.faults,
		started: ctx.started,
		log: ctx.log,
		undo: remote.undo,
		signal: ctx.signal,
	};
	/**
	 * Runs `action` as the fault `profile` on `scenario` when that profile is selected. An `inherent` action runs either
	 * way, and its failure ends the scenario; any other fault's failure is kept on its record, as in every suite.
	 * @template T
	 * @param {{ profile: "partition" | "sigkill", scenario: number, target: string, inherent?: boolean,
	 *   action: () => Promise<T>, observe: (result: T) => FailureObservation }} spec
	 * @returns {Promise<{ result?: T, record?: FaultRecord }>}
	 */
	const fault = async ({ profile, scenario, target, inherent = false, action, observe }) => {
		if (!ctx.profiles.includes(profile)) return inherent ? { result: await action() } : {};
		/** @type {{ value: T } | undefined} */
		let done;
		/** @type {{ error: unknown } | undefined} */
		let thrown;
		const record = await exerciseProfile(faultRun, {
			profile,
			target: `scenario ${scenario}: ${target}`,
			parameters: { scenario },
			apply: async (record, mark, injecting) => {
				injecting();
				try {
					done = { value: await action() };
				} catch (error) {
					thrown = { error };
					throw error;
				}
				const observed = observe(done.value);
				record.applied = true;
				record.effectObserved =
					profile === "partition"
						? (observed.dropped ?? 0) > 0
						: observed.signal === "SIGKILL" && observed.marker === true;
				record.recovered = profile === "partition" && observed.cleared === true;
				record.observed = {
					dropped: observed.dropped ?? 0,
					cleared: observed.cleared ?? false,
					signal: observed.signal ?? null,
					marker: observed.marker ?? false,
				};
				mark("fault observed");
			},
		});
		if (inherent && thrown !== undefined) throw thrown.error;
		return { result: done?.value, record };
	};
	/** @type {{ scenario: string, error: unknown }[]} */
	const scenarioErrors = [];
	/** @template T @param {string} name @param {() => Promise<T>} action @returns {Promise<T | undefined>} */
	const scenario = async (name, action) => {
		try {
			return await action();
		} catch (error) {
			if (isCancellation(error, ctx.signal)) throw error;
			ctx.log(`multi-node-resume: scenario ${name} failed`);
			scenarioErrors.push({ scenario: name, error });
			return undefined;
		}
	};
	/** @type {unknown} */
	let failure;
	try {
		await step("prepare", remote.prepare);
		const session = await scenario("1", async () => {
			const recorded = await step("record-session", remote.recordSession);
			evidence.source = recorded.source;
			await fault({
				profile: "partition",
				scenario: 1,
				target: "session lookup on n2",
				action: () =>
					step("partition-session", async () => {
						evidence.sessionPartition = await remote.partitionSession(recorded.id);
						return evidence.sessionPartition;
					}),
				observe: (observed) => observed,
			});
			const { record: killed } = await fault({
				profile: "sigkill",
				scenario: 1,
				target: "session restore on n2",
				action: () =>
					step("kill-session-restore", async () => {
						evidence.sessionKilled = await remote.killSessionRestore(recorded.id);
						return evidence.sessionKilled;
					}),
				observe: (observed) => observed,
			});
			const resumed = await step("resume-session", () => remote.resumeSession(recorded.id));
			evidence.session = resumed.observation;
			evidence.sessionRecoveryClean = resumed.clean;
			if (killed !== undefined)
				killed.recovered =
					resumed.clean &&
					resumed.observation.digest === recorded.source.digest &&
					resumed.observation.head === recorded.source.head;
			return recorded;
		});
		/** @type {FaultRecord | undefined} */
		let ownerKill;
		const run = await scenario("2", async () => {
			const { result, record } = await fault({
				profile: "sigkill",
				scenario: 2,
				target: "workflow owner mid-step on n1",
				inherent: true,
				action: () => step("record-two-repos", remote.recordRun),
				observe: (recorded) => recorded.killed,
			});
			ownerKill = record;
			if (result === undefined) throw new TypeError("the workflow owner was not recorded");
			evidence.twoKilled = result.killed;
			return result;
		});
		// The killed owner's lease runs out meanwhile: the pooled campaign and the wakes run on other tables and units.
		await scenario("3", async () => {
			await step("pool-start", remote.startPool);
			const { result: killed, record } = await fault({
				profile: "sigkill",
				scenario: 3,
				target: "worker host on n2 holding a bound child",
				inherent: true,
				action: () => step("pool-kill-host", remote.killPoolHost),
				observe: (observed) => observed,
			});
			evidence.poolKilled = killed;
			evidence.pool = await step("pool-reclaim", remote.finishPool);
			if (record !== undefined)
				record.recovered =
					evidence.pool.reclaimed?.host === "A" &&
					evidence.pool.outcome?.status === "completed" &&
					evidence.pool.reclaimed.digest === evidence.pool.source?.digest;
		});
		await scenario("5", async () => {
			const released = await step("release-sessions", remote.releaseSessions);
			evidence.released = { away: released.away.source, samePath: released.samePath.source };
			await fault({
				profile: "partition",
				scenario: 5,
				target: "released session wake on n2",
				action: () =>
					step("partition-wake", async () => {
						evidence.wakePartition = await remote.partitionWake(released.away.id, released.away.path);
						return evidence.wakePartition;
					}),
				observe: (observed) => observed,
			});
			evidence.woken = await step("wake", () => remote.wake(released.away.id, released.away.path));
			evidence.wokenAtSamePath = await step("wake-at-same-path", () =>
				remote.wakeAtSamePath(released.samePath.id, released.samePath.path),
			);
		});
		if (run !== undefined)
			await scenario("2", async () => {
				await step("wait-for-owner-lease", remote.waitForLease);
				await fault({
					profile: "partition",
					scenario: 2,
					target: "run lookup on n2",
					action: () =>
						step("partition-run", async () => {
							evidence.runPartition = await remote.partitionRun(run.id);
							return evidence.runPartition;
						}),
					observe: (observed) => observed,
				});
				evidence.two = await step("resume-two-repos", () => remote.resumeRun(run.id));
				if (ownerKill !== undefined)
					ownerKill.recovered =
						evidence.two.status === "completed" &&
						evidence.two.clean === true &&
						(evidence.two.children ?? []).every((child) => child.effects === "node-a\n");
			});
		if (session !== undefined)
			await scenario("6", async () => {
				evidence.gitlessFailure = await step("gitless-failure", () => remote.gitlessFailure(session.id));
				await fault({
					profile: "partition",
					scenario: 6,
					target: "session lookup on the git-less n3",
					action: () =>
						step("partition-gitless", async () => {
							evidence.gitlessPartition = await remote.partitionGitless(session.id);
							return evidence.gitlessPartition;
						}),
					observe: (observed) => observed,
				});
				evidence.gitless = await step("gitless-resume", () => remote.gitlessResume(session.id));
			});
		await scenario("4", async () => {
			const source = await step("fork-source", remote.recordFork);
			const { record: killed } = await fault({
				profile: "sigkill",
				scenario: 4,
				target: "fork restore on n3",
				action: () =>
					step("kill-fork-restore", async () => {
						evidence.forkKilled = await remote.killFork(source);
						return evidence.forkKilled;
					}),
				observe: (observed) => observed,
			});
			evidence.fork = await step("fork", () => remote.fork(source));
			if (killed !== undefined)
				killed.recovered =
					evidence.forkKilled?.clean === true &&
					evidence.fork.status === "completed" &&
					evidence.fork.beforeTwo === "one\n";
		});
		evidence.integrity = await step("database-integrity", remote.integrity);
	} catch (error) {
		failure = error;
	}
	try {
		await remote.close();
	} catch (cleanup) {
		const primary = failure ?? scenarioErrors[0]?.error;
		if (primary === undefined) failure = cleanup;
		else attachCleanupFailure(primary, cleanup);
	}
	if (failure !== undefined && isCancellation(failure, ctx.signal)) throw failure;
	const first = failure ?? scenarioErrors[0]?.error;
	const executionError = first === undefined ? undefined : serializeDistributedError(first);
	const failedScenarios = scenarioErrors.map((item) => ({
		scenario: item.scenario,
		error: serializeDistributedError(item.error),
	}));
	const hit = chaosByScenario(ctx.faults);
	return {
		faults: ctx.faults,
		invariants: [
			...checkResumeInvariants(evidence),
			{
				name: "chaos-hit-every-scenario",
				passed: Object.entries(RESUME_SCENARIO_FAULTS).every(([name, profiles]) =>
					profiles.every((profile) => hit[name]?.includes(profile) === true),
				),
				expected: RESUME_SCENARIO_FAULTS,
				actual: hit,
			},
			{
				name: "suite-execution-completed",
				passed: executionError === undefined,
				expected: true,
				actual:
					executionError === undefined
						? true
						: {
								name: executionError.name,
								code: executionError.code,
								scenarios: failedScenarios.map((item) => item.scenario),
							},
			},
		],
		metrics: {
			durations,
			chaosByScenario: hit,
			...(executionError === undefined ? {} : { executionError }),
			...(failedScenarios.length === 0 ? {} : { scenarioErrors: failedScenarios }),
		},
		profileSpecs: Object.fromEntries(
			ctx.profiles.map((profile) => [
				profile,
				RESUME_PROFILE_SPECS[/** @type {keyof typeof RESUME_PROFILE_SPECS} */ (profile)],
			]),
		),
	};
}
