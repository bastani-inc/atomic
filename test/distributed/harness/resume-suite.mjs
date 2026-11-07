// @ts-check
/**
 * The multi-node-resume suite (#4329). Three private nodes run the same TypeScript fixtures as the reduced CI tests,
 * against one authenticated sqld namespace. The remote interface is injectable so orchestration can be tested without
 * Azure; each observation comes from the actual fixture or filesystem on its node, not from a simulated worker.
 */
import { attachCleanupFailure, isCancellation, serializeDistributedError } from "./errors.mjs";
import { checkResumeInvariants } from "./resume-invariants.mjs";
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
		mechanism: "iptables DROP between the resuming node and the database gateway",
		effect: "packet drops and a retryable session or run catalog timeout before restoration",
		recovery: "remove the run's rules and resume against the restored connection",
	},
	sigkill: {
		layer: "process",
		mechanism: "SIGKILL of the resume process immediately after git worktree add",
		effect: "the run-owned kill marker and SIGKILL exit are observed",
		recovery: "retry the resume and verify the restored tree without a partial published worktree",
	},
};

/**
 * @typedef {import("./suites.mjs").NodeHost} NodeHost
 * @typedef {import("./suites.mjs").FaultRecord} FaultRecord
 * @typedef {import("./resume-invariants.mjs").ResumeEvidence} ResumeEvidence
 * @typedef {{ durations: Record<string, number>, executionError?: import("./errors.mjs").SerializedError }} ResumeMetrics
 * @typedef {{ runId: string, attempt: string, nodes: NodeHost[], primary: import("./remote.mjs").Host,
 *   profiles: readonly string[], gatewayPort: number, namespace: string, signal?: AbortSignal,
 *   log: (line: string) => void, started: number, faults: FaultRecord[] }} ResumeContext
 * @typedef {{ id: string, source: NonNullable<ResumeEvidence["source"]> }} RecordedSession
 * @typedef {{ sessionId?: string, snapshots?: number, cwd?: string, userMessages?: number, status?: string,
 *   notices?: readonly { message?: string }[], toolResult?: readonly { text?: string }[],
 *   result?: Readonly<Record<string, string>>, error?: import("./resume-invariants.mjs").ResumeError }} DriverOutput
 * @typedef {{ code: number, signal: string | null, output: DriverOutput }} DriverResult
 * @typedef {{ prepare: () => Promise<void>, recordSession: () => Promise<RecordedSession>,
 *   partitionSession: (id: string) => Promise<NonNullable<ResumeEvidence["sessionPartition"]>>,
 *   killSessionRestore: (id: string) => Promise<NonNullable<ResumeEvidence["sessionKilled"]>>,
 *   resumeSession: (id: string) => Promise<{ observation: NonNullable<ResumeEvidence["session"]>, clean: boolean }>,
 *   gitlessFailure: (id: string) => Promise<NonNullable<ResumeEvidence["gitlessFailure"]>>,
 *   gitlessResume: (id: string) => Promise<NonNullable<ResumeEvidence["gitless"]>>,
 *   recordRun: () => Promise<{ id: string, killed: NonNullable<ResumeEvidence["twoKilled"]> }>,
 *   waitForLease: () => Promise<void>, partitionRun: (id: string) => Promise<NonNullable<ResumeEvidence["runPartition"]>>,
 *   resumeRun: (id: string) => Promise<NonNullable<ResumeEvidence["two"]>>,
 *   fork: () => Promise<NonNullable<ResumeEvidence["fork"]>>, integrity: () => Promise<readonly string[]>,
 *   undo: <T>(step: () => Promise<T>) => Promise<T>, close: () => Promise<void> }} ResumeRemote
 */

/**
 * Runs every baseline and the selected fault profiles. A fault that is not selected leaves its required evidence
 * absent, so it cannot make the full acceptance suite pass without actually exercising it.
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
	/** @param {"partition" | "sigkill"} profile @param {string} target @param {() => Promise<NonNullable<ResumeEvidence["sessionKilled"]>>} action */
	const fault = (profile, target, action) =>
		exerciseProfile(faultRun, {
			profile,
			target,
			parameters: {},
			apply: async (record, mark, injecting) => {
				injecting();
				const observed = await action();
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
	/** @type {unknown} */
	let failure;
	try {
		await step("prepare", remote.prepare);
		const session = await step("record-session", remote.recordSession);
		evidence.source = session.source;
		await fault("partition", "session catalog", () =>
			step("partition-session", async () => {
				evidence.sessionPartition = await remote.partitionSession(session.id);
				return evidence.sessionPartition;
			}),
		);
		const killed = await fault("sigkill", "session restore", () =>
			step("kill-session-restore", async () => {
				evidence.sessionKilled = await remote.killSessionRestore(session.id);
				return evidence.sessionKilled;
			}),
		);
		const resumed = await step("resume-session", () => remote.resumeSession(session.id));
		evidence.session = resumed.observation;
		evidence.sessionRecoveryClean = resumed.clean;
		if (killed !== undefined)
			killed.recovered =
				resumed.clean &&
				resumed.observation.digest === session.source.digest &&
				resumed.observation.head === session.source.head;
		const run = await step("record-two-repos", remote.recordRun);
		evidence.twoKilled = run.killed;
		await step("wait-for-owner-lease", remote.waitForLease);
		await fault("partition", "run catalog", () =>
			step("partition-run", async () => {
				evidence.runPartition = await remote.partitionRun(run.id);
				return evidence.runPartition;
			}),
		);
		evidence.two = await step("resume-two-repos", () => remote.resumeRun(run.id));
		evidence.fork = await step("fork", remote.fork);
		evidence.gitlessFailure = await step("gitless-failure", () => remote.gitlessFailure(session.id));
		evidence.gitless = await step("gitless-resume", () => remote.gitlessResume(session.id));
		evidence.integrity = await step("database-integrity", remote.integrity);
	} catch (error) {
		failure = error;
	}
	try {
		await remote.close();
	} catch (cleanup) {
		if (failure === undefined) failure = cleanup;
		else attachCleanupFailure(failure, cleanup);
	}
	if (failure !== undefined && isCancellation(failure, ctx.signal)) throw failure;
	const executionError = failure === undefined ? undefined : serializeDistributedError(failure);
	return {
		faults: ctx.faults,
		invariants: [
			...checkResumeInvariants(evidence),
			{
				name: "suite-execution-completed",
				passed: failure === undefined,
				expected: true,
				actual: executionError === undefined ? true : { name: executionError.name, code: executionError.code },
			},
		],
		metrics: { durations, ...(executionError === undefined ? {} : { executionError }) },
		profileSpecs: Object.fromEntries(
			ctx.profiles.map((profile) => [
				profile,
				RESUME_PROFILE_SPECS[/** @type {keyof typeof RESUME_PROFILE_SPECS} */ (profile)],
			]),
		),
	};
}
