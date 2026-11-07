// @ts-check
/** Machine-checked observations from the multi-node-resume suite. Missing evidence is a failure, never a pass. */

/**
 * @typedef {{ name?: string, code?: string, retryable?: boolean, subject?: string,
 *   problems?: readonly { code?: string }[], cause?: { name?: string, code?: string, cause?: { name?: string, code?: string } } }} ResumeError
 * @typedef {{ digest?: string, entries?: readonly import("../node/resume-check.mjs").TreeEntry[], head?: string, cwd?: string, restoreRoot?: string, notice?: boolean, oldPathContent?: string,
 *   userMessages?: number, setupRuns?: number, provisioned?: boolean, fsck?: boolean, clean?: boolean }} SessionObservation
 * @typedef {{ code?: number | null, signal?: string | null, error?: ResumeError, noWorktrees?: boolean,
 *   provisioned?: boolean, marker?: boolean, dropped?: number, cleared?: boolean }} FailureObservation
 * @typedef {{ cwd?: string, effects?: string, notes?: string, repository?: string }} ChildObservation
 * @typedef {{ source?: SessionObservation, session?: SessionObservation, sessionPartition?: FailureObservation,
 *   sessionKilled?: FailureObservation, sessionRecoveryClean?: boolean, gitlessFailure?: FailureObservation,
 *   gitless?: SessionObservation, twoKilled?: FailureObservation, runPartition?: FailureObservation,
 *   two?: { status?: string, children?: readonly ChildObservation[], restoreRoot?: string, clean?: boolean },
 *   fork?: { status?: string, beforeOne?: string, beforeTwo?: string, cwd?: string, restoreRoot?: string },
 *   integrity?: readonly string[] }} ResumeEvidence
 * @typedef {import("./invariants.mjs").InvariantResult} InvariantResult
 */

/** @param {ResumeError | undefined} error @param {string} subject */
function timeout(error, subject) {
	return (
		error?.name === "ResumeCatalogTimeoutError" &&
		error.code === "catalog-timeout" &&
		error.retryable === true &&
		error.subject === subject
	);
}

/** @param {SessionObservation | undefined} source @param {SessionObservation | undefined} restored @param {number} userMessages */
function sameSession(source, restored, userMessages) {
	return (
		source?.digest !== undefined &&
		source.head !== undefined &&
		typeof restored?.cwd === "string" &&
		typeof restored.restoreRoot === "string" &&
		restored.cwd.startsWith(`${restored.restoreRoot}/`) &&
		!restored.cwd.slice(restored.restoreRoot.length + 1).startsWith(".staging-") &&
		restored.digest === source.digest &&
		restored.head === source.head &&
		restored.userMessages === userMessages &&
		restored.oldPathContent === "written by the model on node A" &&
		restored.setupRuns === 1 &&
		restored.fsck === true &&
		restored.clean === true
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
		gitless,
		twoKilled,
		runPartition,
		two,
		fork,
	} = evidence;
	const children = two?.children ?? [];
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
			name: "fork-restores-the-boundary-snapshot",
			passed:
				fork?.status === "completed" &&
				fork.beforeOne === "zero\n" &&
				fork.beforeTwo === "one\n" &&
				typeof fork.restoreRoot === "string" &&
				typeof fork.cwd === "string" &&
				fork.cwd.startsWith(`${fork.restoreRoot}/`),
			expected: "forked stage sees state after stage one on another node",
			actual: fork ?? null,
		},
		{
			name: "shared-database-integrity",
			passed: evidence.integrity?.length === 1 && evidence.integrity[0] === "ok",
			expected: ["ok"],
			actual: evidence.integrity ?? null,
		},
	];
}
