// @ts-check
/** Machine-checked observations from the multi-node-resume suite. Missing evidence is a failure, never a pass. */

/**
 * @typedef {{ name?: string, code?: string, retryable?: boolean, subject?: string,
 *   problems?: readonly { code?: string }[], cause?: { name?: string, code?: string, cause?: { name?: string, code?: string } } }} ResumeError
 * @typedef {import("../node/resume-check.mjs").TreeEntry} TreeEntry
 * @typedef {{ digest?: string, entries?: readonly TreeEntry[], head?: string, cwd?: string, restoreRoot?: string, notice?: boolean, oldPathContent?: string,
 *   userMessages?: number, setupRuns?: number, provisioned?: boolean, fsck?: boolean, clean?: boolean,
 *   mappings?: readonly { from?: string, to?: string }[] }} SessionObservation
 * @typedef {{ code?: number | null, signal?: string | null, error?: ResumeError, noWorktrees?: boolean,
 *   provisioned?: boolean, marker?: boolean, dropped?: number, cleared?: boolean, clean?: boolean }} FailureObservation
 * @typedef {{ cwd?: string, effects?: string, notes?: string, repository?: string }} ChildObservation
 * @typedef {{ status?: string, error?: string | null | { name?: string, code?: string | null, message?: string },
 *   firstHost?: string, firstCwd?: string, finalHost?: string, finalCwd?: string,
 *   finalHead?: string, finalFiles?: string }} PoolChild
 * @typedef {{ git?: string, restore?: boolean, maxBusy?: number }} PoolHost
 * @typedef {{ source?: SessionObservation, hosts?: { A?: PoolHost, B?: PoolHost, C?: PoolHost },
 *   restoreRoots?: { A?: string, B?: string, C?: string }, first?: { host?: string, cwd?: string },
 *   reclaimed?: SessionObservation & { host?: string }, outcome?: { status?: string, children?: readonly PoolChild[] },
 *   setup?: { A?: readonly string[], B?: readonly string[], C?: readonly string[] }, heldOnGitless?: number,
 *   work?: readonly { state?: string, generation?: number, worker?: string }[] }} PoolObservation
 * @typedef {SessionObservation & { code?: number, recordedPath?: string,
 *   decoy?: { before?: SessionObservation, after?: SessionObservation } }} WakeObservation
 * @typedef {{ source?: SessionObservation, session?: SessionObservation, sessionPartition?: FailureObservation,
 *   sessionKilled?: FailureObservation, sessionRecoveryClean?: boolean, gitlessFailure?: FailureObservation,
 *   gitlessPartition?: FailureObservation, gitless?: SessionObservation, twoKilled?: FailureObservation,
 *   runPartition?: FailureObservation,
 *   two?: { status?: string, children?: readonly ChildObservation[], restoreRoot?: string, clean?: boolean },
 *   poolKilled?: FailureObservation, pool?: PoolObservation,
 *   released?: { away?: SessionObservation, samePath?: SessionObservation }, wakePartition?: FailureObservation,
 *   woken?: WakeObservation, wokenAtSamePath?: WakeObservation, releasedSubagent?: SessionObservation,
 *   wokenSubagent?: WakeObservation & { outcome?: string }, forkKilled?: FailureObservation,
 *   fork?: { status?: string, beforeOne?: string, beforeTwo?: string, cwd?: string, restoreRoot?: string,
 *     stateAfter?: string, gitless?: boolean, clean?: boolean },
 *   integrity?: readonly string[] }} ResumeEvidence
 * @typedef {import("./invariants.mjs").InvariantResult} InvariantResult
 */

/**
 * The faults each scenario must have been hit by, by profile; scenario 7 (chaos during each) is their union. A fault
 * counts once it was applied, its effect observed and the scenario recovered from it.
 */
export const RESUME_SCENARIO_FAULTS = Object.freeze({
	1: Object.freeze(["partition", "sigkill"]),
	2: Object.freeze(["partition", "sigkill"]),
	3: Object.freeze(["sigkill"]),
	4: Object.freeze(["sigkill"]),
	5: Object.freeze(["partition"]),
	6: Object.freeze(["partition"]),
	7: Object.freeze(["partition", "sigkill"]),
});

/** The text the recording node's model wrote, as the read tool returns it through the recorded absolute path. */
const WRITTEN = "written by the model on node A";
/** The same, for the file a released background subagent wrote on node A. */
const SUBAGENT_WRITTEN = "written by the subagent on node A";

/** @param {ResumeError | undefined} error @param {string} subject */
function timeout(error, subject) {
	return (
		error?.name === "ResumeCatalogTimeoutError" &&
		error.code === "catalog-timeout" &&
		error.retryable === true &&
		error.subject === subject
	);
}

/** A retryable catalog failure: the lookup timed out or could not reach the database. @param {ResumeError | undefined} error */
function catalogUnreachable(error) {
	return (
		error?.retryable === true &&
		((error.name === "ResumeCatalogTimeoutError" && error.code === "catalog-timeout") ||
			(error.name === "ResumeCatalogUnavailableError" && error.code === "catalog-unavailable"))
	);
}

/** @param {string | undefined} path @param {string | undefined} root */
function publishedUnder(path, root) {
	return (
		typeof path === "string" &&
		typeof root === "string" &&
		path.startsWith(`${root}/`) &&
		!path.slice(root.length + 1).startsWith(".staging-")
	);
}

/** Same bytes, paths and executable bits, and the same commit. @param {SessionObservation | undefined} source @param {SessionObservation | undefined} restored */
function sameTree(source, restored) {
	return (
		source?.digest !== undefined &&
		source.head !== undefined &&
		restored?.digest === source.digest &&
		restored.head === source.head &&
		restored.fsck === true
	);
}

/** @param {SessionObservation | undefined} source @param {SessionObservation | undefined} restored @param {number} userMessages */
function sameSession(source, restored, userMessages) {
	return (
		sameTree(source, restored) &&
		publishedUnder(restored?.cwd, restored?.restoreRoot) &&
		restored?.userMessages === userMessages &&
		restored.oldPathContent === WRITTEN &&
		restored.setupRuns === 1 &&
		restored.clean === true
	);
}

/**
 * Every file of a manifest by path, with its bytes' digest: the shape the pooled child reports of its working tree.
 * @param {readonly TreeEntry[] | undefined} entries
 */
function filesOf(entries) {
	return Object.fromEntries(
		(entries ?? []).filter((entry) => entry.type === "file").map((entry) => [entry.path, entry.digest]),
	);
}

/** @param {string | undefined} json @param {Record<string, string | undefined>} expected */
function sameFiles(json, expected) {
	if (typeof json !== "string" || Object.keys(expected).length === 0) return false;
	try {
		const files = /** @type {Record<string, string>} */ (JSON.parse(json));
		const keys = Object.keys(files).sort();
		return keys.length === Object.keys(expected).length && keys.every((key) => files[key] === expected[key]);
	} catch {
		return false;
	}
}

/**
 * A woken released session: it continues in a worktree this node restored, with the recorded tree and commit, the
 * recorded path mapped to it, the conversation continued and the recording node's path resolving there.
 * @param {SessionObservation | undefined} source @param {WakeObservation | undefined} woken
 */
function wokenElsewhere(source, woken) {
	return (
		woken?.code === 0 &&
		sameTree(source, woken) &&
		publishedUnder(woken.cwd, woken.restoreRoot) &&
		woken.cwd !== woken.recordedPath &&
		woken.mappings?.some((mapping) => mapping.from === woken.recordedPath && mapping.to === woken.cwd) === true &&
		woken.userMessages === 2 &&
		woken.oldPathContent === WRITTEN &&
		woken.clean === true
	);
}

/**
 * A woken released background subagent: it was restored, and continued in a worktree this node restored from its own
 * snapshot, with the recorded tree and commit, the recorded path mapped to it and the recording node's path resolving
 * there for its tools.
 * @param {SessionObservation | undefined} source @param {(WakeObservation & { outcome?: string }) | undefined} woken
 */
function subagentWokenElsewhere(source, woken) {
	return (
		woken?.code === 0 &&
		woken.outcome === "restored" &&
		sameTree(source, woken) &&
		publishedUnder(woken.cwd, woken.restoreRoot) &&
		woken.cwd !== woken.recordedPath &&
		woken.mappings?.some((mapping) => mapping.from === woken.recordedPath && mapping.to === woken.cwd) === true &&
		woken.oldPathContent === SUBAGENT_WRITTEN &&
		woken.clean === true
	);
}

/**
 * The scenario observations (including every requested fault). Each invariant carries only synthetic facts; no
 * credentials, storage selection or conversation content outside the fixture are reported.
 * @param {ResumeEvidence} evidence
 * @returns {InvariantResult[]}
 */
export function checkResumeInvariants(evidence) {
	const {
		source,
		session,
		sessionPartition,
		sessionKilled,
		gitlessFailure,
		gitlessPartition,
		gitless,
		twoKilled,
		runPartition,
		two,
		poolKilled,
		pool,
		released,
		wakePartition,
		woken,
		wokenAtSamePath,
		releasedSubagent,
		wokenSubagent,
		forkKilled,
		fork,
	} = evidence;
	const children = two?.children ?? [];
	const pooled = pool?.outcome?.children ?? [];
	const child = pooled[0];
	const setup = pool?.setup;
	return [
		{
			name: "session-restored-exactly-and-continued",
			passed: sameSession(source, session, 2) && session?.notice === true,
			expected: "same tree and HEAD, continuation, old path, one setup and notice",
			actual: { source: source ?? null, restored: session ?? null },
		},
		{
			name: "session-lookup-partition-typed-before-restore",
			passed:
				timeout(sessionPartition?.error, "session") &&
				sessionPartition?.code === 2 &&
				sessionPartition.noWorktrees === true &&
				(sessionPartition.dropped ?? 0) > 0,
			expected: "retryable session catalog timeout and no worktree",
			actual: sessionPartition ?? null,
		},
		{
			name: "session-killed-restore-recovers-cleanly",
			passed:
				sessionKilled?.signal === "SIGKILL" &&
				evidence.sessionRecoveryClean === true &&
				sameSession(source, session, 2),
			expected: "SIGKILL during restore, recovery, no half-restored checkout",
			actual: { killed: sessionKilled ?? null, clean: evidence.sessionRecoveryClean ?? false },
		},
		{
			name: "gitless-failure-typed-and-nondestructive",
			passed:
				gitlessFailure?.code === 2 &&
				gitlessFailure.error?.name === "ResumePreconditionError" &&
				gitlessFailure.error.code === "preconditions-unmet" &&
				gitlessFailure.error.problems?.some((problem) => problem.code === "git-unavailable") === true &&
				gitlessFailure.error.cause?.name === "GitUnavailableError" &&
				[
					"not-installed",
					"unsupported-platform",
					"offline",
					"checksum-mismatch",
					"download-failed",
					"install-failed",
				].includes(gitlessFailure.error.cause.code ?? "") &&
				gitlessFailure.noWorktrees === true &&
				gitlessFailure.provisioned === false,
			expected: "typed GitUnavailableError cause and no worktree or provisioned Git",
			actual: gitlessFailure ?? null,
		},
		{
			name: "gitless-lookup-partition-typed-before-provisioning",
			passed:
				timeout(gitlessPartition?.error, "session") &&
				gitlessPartition?.code === 2 &&
				gitlessPartition.noWorktrees === true &&
				gitlessPartition.provisioned === false &&
				(gitlessPartition.dropped ?? 0) > 0,
			expected: "retryable session catalog timeout on the git-less node, with nothing provisioned or restored",
			actual: gitlessPartition ?? null,
		},
		{
			name: "gitless-node-provisions-and-resumes",
			passed: gitless?.provisioned === true && sameSession(source, gitless, 3),
			expected: "provisioned Git, same tree and HEAD, continued session and one setup",
			actual: gitless ?? null,
		},
		{
			name: "two-worktrees-resume-without-repeating-effects",
			passed:
				twoKilled?.signal === "SIGKILL" &&
				two?.status === "completed" &&
				two.clean === true &&
				typeof two.restoreRoot === "string" &&
				children.length === 2 &&
				children[0]?.repository === "alpha\n" &&
				children[1]?.repository === "beta\n" &&
				children.every(
					(child) =>
						typeof child.cwd === "string" &&
						child.cwd.startsWith(`${two.restoreRoot}/`) &&
						child.effects === "node-a\n" &&
						child.notes === "uncommitted, written on node-a\n",
				) &&
				children[0]?.cwd !== children[1]?.cwd,
			expected: "two correctly restored checkouts, each effect once, interrupted stage continued",
			actual: { killed: twoKilled ?? null, resumed: two ?? null },
		},
		{
			name: "run-lookup-partition-typed-before-restore",
			passed:
				timeout(runPartition?.error, "run") &&
				runPartition?.code === 2 &&
				runPartition.noWorktrees === true &&
				(runPartition.dropped ?? 0) > 0,
			expected: "retryable run catalog timeout and no worktree",
			actual: runPartition ?? null,
		},
		{
			name: "pooled-child-reclaimed-after-host-sigkill",
			passed:
				poolKilled?.signal === "SIGKILL" &&
				poolKilled.marker === true &&
				pool?.outcome?.status === "completed" &&
				pooled.length === 1 &&
				child?.status === "completed" &&
				child.firstHost === "B" &&
				publishedUnder(child.firstCwd, pool.restoreRoots?.B) &&
				pool.first?.host === "B" &&
				child.finalHost === "A" &&
				pool.reclaimed?.host === "A" &&
				(pool.work ?? []).length === 1 &&
				(pool.work ?? []).every(
					(row) =>
						row.state === "completed" && (row.generation ?? 0) >= 2 && row.worker?.startsWith("A/") === true,
				),
			expected:
				"the child began on n2's host, which was SIGKILLed holding it; it was claimed again and completed on n1's host, which replayed its completed first step",
			actual: {
				killed: poolKilled ?? null,
				status: pool?.outcome?.status ?? null,
				children: pooled,
				first: pool?.first ?? null,
				work: pool?.work ?? null,
			},
		},
		{
			name: "pooled-child-restored-with-the-recorded-tree",
			passed:
				sameTree(pool?.source, pool?.reclaimed) &&
				publishedUnder(pool?.reclaimed?.cwd, pool?.restoreRoots?.A) &&
				child?.finalCwd === pool?.reclaimed?.cwd &&
				child?.finalHead === pool?.source?.head &&
				sameFiles(child?.finalFiles, filesOf(pool?.source?.entries)),
			expected: "n1's host restored the root's tree byte for byte, with its commit, and the child finished there",
			actual: { source: pool?.source ?? null, reclaimed: pool?.reclaimed ?? null },
		},
		{
			// A host's `busy` count includes a worker whose claim request is in flight, which an idle host without a
			// restore port has every time it asks for work and declines the bound child; the journal's claim count is what
			// shows who took the child.
			name: "pooled-bound-work-never-on-the-gitless-host",
			passed:
				pool?.hosts?.A?.restore === true &&
				pool.hosts.B?.restore === true &&
				pool.hosts.C?.restore === false &&
				pool.hosts.C.git === "unavailable" &&
				pool.heldOnGitless === 0 &&
				setup?.C?.length === 0 &&
				pooled.length > 0 &&
				pooled.every((item) => item.firstHost !== "C" && item.finalHost !== "C") &&
				(pool.work ?? []).length === 1 &&
				(pool.work ?? []).every((row) => row.generation === 2 && row.worker?.startsWith("C/") !== true),
			expected:
				"n3's host has no Git and no restore port and never claimed the child, including while the reclaimed one waited: no marker or setup there, and the child's only claims were n2's host's and n1's host's (generation 2)",
			actual: {
				hosts: pool?.hosts ?? null,
				heldOnGitless: pool?.heldOnGitless ?? null,
				setup: setup ?? null,
				work: pool?.work ?? null,
			},
		},
		{
			name: "pooled-setup-hook-ran-once-where-restored",
			passed:
				setup?.A?.length === 1 &&
				typeof child?.finalCwd === "string" &&
				child.finalCwd.startsWith(setup.A[0] ?? "\0") &&
				publishedUnder(setup.A[0], pool?.restoreRoots?.A) &&
				pool?.reclaimed?.setupRuns === 1 &&
				setup.B?.length === 1 &&
				typeof child.firstCwd === "string" &&
				child.firstCwd.startsWith(setup.B[0] ?? "\0") &&
				setup.C?.length === 0,
			expected:
				"each host's resume.setupCommand ran exactly once, in the worktree it restored for the child, before the child ran there",
			actual: setup ?? null,
		},
		{
			name: "released-wake-partition-typed-before-restore",
			passed:
				catalogUnreachable(wakePartition?.error) &&
				wakePartition?.code === 2 &&
				wakePartition.noWorktrees === true &&
				(wakePartition.dropped ?? 0) > 0,
			expected: "retryable session catalog timeout or unavailability, and no restored worktree",
			actual: wakePartition ?? null,
		},
		{
			name: "released-session-wakes-restored-on-another-node",
			passed: wokenElsewhere(released?.away, woken),
			expected: "rehydrate restored the recorded tree and commit, mapped n1's path into it and continued",
			actual: { source: released?.away ?? null, woken: woken ?? null },
		},
		{
			name: "released-session-ignores-a-different-checkout-at-its-path",
			passed:
				wokenElsewhere(released?.samePath, wokenAtSamePath) &&
				wokenAtSamePath?.decoy?.before?.digest !== undefined &&
				wokenAtSamePath.decoy.before.digest !== released?.samePath?.digest &&
				wokenAtSamePath.decoy.after?.digest === wokenAtSamePath.decoy.before.digest &&
				wokenAtSamePath.decoy.after.head === wokenAtSamePath.decoy.before.head,
			expected:
				"with another checkout of the repository at the recorded path, the session continued in a restored worktree and left that checkout as it was",
			actual: { source: released?.samePath ?? null, woken: wokenAtSamePath ?? null },
		},
		{
			name: "released-subagent-wakes-restored-on-another-node",
			passed: subagentWokenElsewhere(releasedSubagent, wokenSubagent),
			expected:
				"a real released background subagent woke on n2: its checkout was restored from its own snapshot with the recorded tree and commit, n1's path was mapped into it, and the subagent read n1's file through that path",
			actual: { source: releasedSubagent ?? null, woken: wokenSubagent ?? null },
		},
		{
			name: "fork-restores-the-boundary-snapshot",
			passed:
				fork?.status === "completed" &&
				fork.gitless === true &&
				fork.beforeOne === "zero\n" &&
				fork.beforeTwo === "one\n" &&
				fork.stateAfter === "two\n" &&
				fork.clean === true &&
				publishedUnder(fork.cwd, fork.restoreRoot) &&
				forkKilled?.signal === "SIGKILL" &&
				forkKilled.marker === true &&
				forkKilled.clean === true,
			expected:
				"on the third node, killed once mid-restore, the retried fork's stage sees the state after stage one in a restored worktree",
			actual: { killed: forkKilled ?? null, fork: fork ?? null },
		},
		{
			name: "shared-database-integrity",
			passed: evidence.integrity?.length === 1 && evidence.integrity[0] === "ok",
			expected: ["ok"],
			actual: evidence.integrity ?? null,
		},
	];
}
