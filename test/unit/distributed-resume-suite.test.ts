import assert from "node:assert/strict";
import { test } from "vitest";
import { profileCoverage } from "../distributed/harness/chaos.mjs";
import { SUITE_PROFILES } from "../distributed/harness/config.mjs";
import { renderMarkdown } from "../distributed/harness/report.mjs";
import { checkResumeInvariants, type ResumeEvidence } from "../distributed/harness/resume-invariants.mjs";
import type { ResumeRemote } from "../distributed/harness/resume-suite.mjs";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

type Context = Parameters<typeof import("../distributed/harness/resume-suite.mjs").runMultiNodeResume>[0];
type Fault = Context["faults"][number];

const WRITTEN = "written by the model on node A";
const SUBAGENT_WRITTEN = "written by the subagent on node A";
/** A recorded tree as the node's manifest reports it: two files and their directory. */
const tree = {
	digest: "sha",
	head: "head",
	fsck: true,
	entries: [
		{ path: "README.md", type: "file" as const, digest: "readme", executable: false },
		{ path: "lib", type: "directory" as const },
		{ path: "lib/util.txt", type: "file" as const, digest: "util", executable: false },
	],
};
const resumed = {
	...tree,
	cwd: "/restored/tree",
	restoreRoot: "/restored",
	notice: true,
	clean: true,
	setupRuns: 1,
	userMessages: 2,
	oldPathContent: WRITTEN,
};
const catalogTimeout = (subject: string) => ({
	name: "ResumeCatalogTimeoutError",
	code: "catalog-timeout",
	retryable: true,
	subject,
});
const pool = {
	source: tree,
	hosts: {
		A: { git: "system", restore: true },
		B: { git: "system", restore: true },
		C: { git: "unavailable", restore: false, maxBusy: 0 },
	},
	restoreRoots: { A: "/a/worktrees", B: "/b/worktrees", C: "/c/worktrees" },
	first: { host: "B", cwd: "/b/worktrees/pool-1" },
	reclaimed: { ...tree, host: "A", cwd: "/a/worktrees/pool-2", setupRuns: 1 },
	outcome: {
		status: "completed",
		children: [
			{
				status: "completed",
				error: null,
				firstHost: "B",
				firstCwd: "/b/worktrees/pool-1",
				finalHost: "A",
				finalCwd: "/a/worktrees/pool-2",
				finalHead: "head",
				finalFiles: JSON.stringify({ "README.md": "readme", "lib/util.txt": "util" }),
			},
		],
	},
	setup: { A: ["/a/worktrees/pool-2"], B: ["/b/worktrees/pool-1"], C: [] },
	heldOnGitless: 0,
	work: [{ state: "completed", generation: 2, worker: "A/1" }],
};
const releasedSource = { away: tree, samePath: { ...tree, digest: "sha-same-path", head: "head-same-path" } };
const woken = (path: string, source: typeof tree) => ({
	...source,
	code: 0,
	cwd: `/b/wake/${path}`,
	restoreRoot: "/b/wake",
	recordedPath: `/a/${path}`,
	mappings: [{ from: `/a/${path}`, to: `/b/wake/${path}` }],
	userMessages: 2,
	oldPathContent: WRITTEN,
	clean: true,
	setupRuns: 0,
});
const subagentSource = { ...tree, digest: "sha-subagent", head: "head-subagent" };
const wokenSubagent = {
	...subagentSource,
	code: 0,
	outcome: "restored",
	cwd: "/b/subagent-wake/released-subagent",
	restoreRoot: "/b/subagent-wake",
	recordedPath: "/a/released-subagent",
	mappings: [{ from: "/a/released-subagent", to: "/b/subagent-wake/released-subagent" }],
	oldPathContent: SUBAGENT_WRITTEN,
	clean: true,
};
const decoy = { before: { digest: "fresh-clone", head: "base" }, after: { digest: "fresh-clone", head: "base" } };

/** Evidence of every scenario as a passing three-node run reports it. */
function passingEvidence(): ResumeEvidence {
	return {
		source: tree,
		session: resumed,
		sessionPartition: { code: 2, noWorktrees: true, dropped: 2, cleared: true, error: catalogTimeout("session") },
		sessionKilled: { signal: "SIGKILL", marker: true },
		sessionRecoveryClean: true,
		gitlessFailure: {
			code: 2,
			noWorktrees: true,
			provisioned: false,
			error: {
				name: "ResumePreconditionError",
				code: "preconditions-unmet",
				problems: [{ code: "git-unavailable" }],
				cause: { name: "GitUnavailableError", code: "download-failed" },
			},
		},
		gitlessPartition: {
			code: 2,
			noWorktrees: true,
			provisioned: false,
			dropped: 1,
			cleared: true,
			error: catalogTimeout("session"),
		},
		gitless: { ...resumed, userMessages: 3, provisioned: true },
		twoKilled: { signal: "SIGKILL", marker: true },
		runPartition: { code: 2, noWorktrees: true, dropped: 3, cleared: true, error: catalogTimeout("run") },
		two: {
			status: "completed",
			clean: true,
			restoreRoot: "/w",
			children: ["alpha", "beta"].map((repository) => ({
				cwd: `/w/${repository}`,
				repository: `${repository}\n`,
				effects: "node-a\n",
				notes: "uncommitted, written on node-a\n",
			})),
		},
		poolKilled: { signal: "SIGKILL", marker: true },
		pool,
		released: releasedSource,
		wakePartition: {
			code: 2,
			noWorktrees: true,
			dropped: 4,
			cleared: true,
			error: { name: "ResumeCatalogUnavailableError", code: "catalog-unavailable", retryable: true },
		},
		woken: woken("released-away", releasedSource.away),
		wokenAtSamePath: { ...woken("released-same-path", releasedSource.samePath), decoy },
		releasedSubagent: subagentSource,
		wokenSubagent,
		forkKilled: { signal: "SIGKILL", marker: true, clean: true },
		fork: {
			status: "completed",
			beforeOne: "zero\n",
			beforeTwo: "one\n",
			stateAfter: "two\n",
			cwd: "/f/tree",
			restoreRoot: "/f",
			gitless: true,
			clean: true,
		},
		integrity: ["ok"],
	};
}

/** A fake three-node fleet whose every step reports the passing evidence, recording the order it was driven in. */
function fleet(overrides: Partial<ResumeRemote> = {}): { remote: ResumeRemote; calls: string[] } {
	const calls: string[] = [];
	const evidence = passingEvidence();
	const record =
		<T>(name: string, value: () => T) =>
		async () => {
			calls.push(name);
			return value();
		};
	const remote: ResumeRemote = {
		prepare: record("prepare", () => undefined),
		recordSession: record("record-session", () => ({ id: "s", source: tree })),
		partitionSession: record("partition-session", () => evidence.sessionPartition!),
		killSessionRestore: record("kill-session-restore", () => evidence.sessionKilled!),
		resumeSession: record("resume-session", () => ({ observation: resumed, clean: true })),
		recordRun: record("record-run", () => ({ id: "r", killed: evidence.twoKilled! })),
		startPool: record("start-pool", () => undefined),
		killPoolHost: record("kill-pool-host", () => evidence.poolKilled!),
		finishPool: record("finish-pool", () => pool),
		releaseSessions: record("release-sessions", () => ({
			away: { id: "ra", path: "/a/released-away", source: releasedSource.away },
			samePath: { id: "rs", path: "/a/released-same-path", source: releasedSource.samePath },
		})),
		partitionWake: record("partition-wake", () => evidence.wakePartition!),
		wake: record("wake", () => evidence.woken!),
		wakeAtSamePath: record("wake-at-same-path", () => evidence.wokenAtSamePath!),
		releaseSubagent: record("release-subagent", () => ({
			ownerSessionId: "owner",
			childId: "released-subagent:0",
			path: "/a/released-subagent",
			source: subagentSource,
		})),
		wakeSubagent: record("wake-subagent", () => evidence.wokenSubagent!),
		waitForLease: record("wait-lease", () => undefined),
		partitionRun: record("partition-run", () => evidence.runPartition!),
		resumeRun: record("resume-run", () => evidence.two!),
		gitlessFailure: record("gitless-failure", () => evidence.gitlessFailure!),
		partitionGitless: record("partition-gitless", () => evidence.gitlessPartition!),
		gitlessResume: record("gitless-resume", () => evidence.gitless!),
		recordFork: record("record-fork", () => "f"),
		killFork: record("kill-fork", () => evidence.forkKilled!),
		fork: record("fork", () => evidence.fork!),
		integrity: record("integrity", () => ["ok"]),
		undo: async <T>(action: () => Promise<T>) => action(),
		close: record("close", () => undefined),
		...overrides,
	};
	return { remote, calls };
}

function context(profiles: readonly string[] = SUITE_PROFILES["multi-node-resume"]): Context {
	return { profiles, faults: [] as Fault[], started: performance.now(), log: () => {} } as unknown as Context;
}

test("multi-node resume evidence is never accepted when a required scenario observation is missing (#4329)", () => {
	const invariants = checkResumeInvariants({});
	assert.ok(invariants.length > 0);
	assert.ok(
		invariants.every((item) => !item.passed),
		JSON.stringify(invariants),
	);
});

test("passing evidence of all seven scenarios is accepted, invariant by invariant (#4329)", () => {
	const invariants = checkResumeInvariants(passingEvidence());
	assert.deepEqual(
		invariants.filter((item) => !item.passed).map((item) => item.name),
		[],
	);
});

test("the suite drives all seven scenarios across three nodes, with chaos in each, and refuses false evidence (#4329)", async () => {
	const { runMultiNodeResume } = await import("../distributed/harness/resume-suite.mjs");
	const { remote, calls } = fleet();
	const ctx = context();
	const result = await runMultiNodeResume(ctx, remote);
	assert.deepEqual(
		result.invariants.filter((item) => !item.passed).map((item) => item.name),
		[],
	);
	assert.deepEqual(calls, [
		"prepare",
		"record-session",
		"partition-session",
		"kill-session-restore",
		"resume-session",
		"record-run",
		// The pooled campaign and the wakes run while the killed workflow owner's lease runs out.
		"start-pool",
		"kill-pool-host",
		"finish-pool",
		"release-sessions",
		"partition-wake",
		"wake",
		"wake-at-same-path",
		"release-subagent",
		"wake-subagent",
		"wait-lease",
		"partition-run",
		"resume-run",
		"gitless-failure",
		"partition-gitless",
		"gitless-resume",
		"record-fork",
		"kill-fork",
		"fork",
		"integrity",
		"close",
	]);
	assert.deepEqual(
		result.faults.map((fault) => [fault.parameters.scenario, fault.profile]),
		[
			[1, "partition"],
			[1, "sigkill"],
			[2, "sigkill"],
			[3, "sigkill"],
			[5, "partition"],
			[2, "partition"],
			[6, "partition"],
			[4, "sigkill"],
		],
	);
	assert.ok(result.faults.every((fault) => fault.target.startsWith(`scenario ${fault.parameters.scenario}: `)));
	// Every record counts: each fault was applied, its effect observed and its scenario recovered.
	assert.deepEqual(
		profileCoverage(result.faults, SUITE_PROFILES["multi-node-resume"]).map((entry) => entry.status),
		["exercised", "exercised"],
	);
	assert.deepEqual(result.metrics.chaosByScenario, {
		1: ["partition", "sigkill"],
		2: ["partition", "sigkill"],
		3: ["sigkill"],
		4: ["sigkill"],
		5: ["partition"],
		6: ["partition"],
		7: ["partition", "sigkill"],
	});
	assert.match(result.profileSpecs.partition!.effect, /catalog timeout/);
	assert.match(result.profileSpecs.sigkill!.mechanism, /worktree add/);

	const rejected = await runMultiNodeResume(
		context(),
		fleet({ resumeRun: async () => ({ status: "completed", children: [], clean: true, restoreRoot: "/w" }) }).remote,
	);
	assert.equal(
		rejected.invariants.find((item) => item.name === "two-worktrees-resume-without-repeating-effects")?.passed,
		false,
	);
	// A scenario that did not recover leaves its fault incomplete, and the scenario unhit by chaos.
	const unrecovered = await runMultiNodeResume(
		context(),
		fleet({ finishPool: async () => ({ ...pool, reclaimed: { ...pool.reclaimed, host: "R" } }) }).remote,
	);
	assert.equal(unrecovered.faults.find((fault) => fault.parameters.scenario === 3)?.recovered, false);
	assert.equal(unrecovered.invariants.find((item) => item.name === "chaos-hit-every-scenario")?.passed, false);
	assert.equal(unrecovered.metrics.chaosByScenario[3], undefined);
});

test("the report lists every fault a profile hit, with its scenario (#4329)", async () => {
	const { runMultiNodeResume } = await import("../distributed/harness/resume-suite.mjs");
	const result = await runMultiNodeResume(context(), fleet().remote);
	const markdown = renderMarkdown({
		schemaVersion: 1,
		runId: "r",
		startedAt: "2026-11-07T00:00:00.000Z",
		command: "run",
		replay: {
			ref: "main",
			suite: "multi-node-resume",
			chaos: "partition,sigkill",
			nodes: 3,
			regions: ["eastus2"],
			seed: 1,
			prng: "mulberry32/v1",
			dbStorage: "premium-ssd",
			dbRegion: "westus3",
		},
		topology: { resourceGroup: "r-rg", expiresAt: "2026-11-07T06:00:00.000Z", vms: [] },
		suites: [
			{
				name: "multi-node-resume",
				issue: "#4329",
				status: "passed",
				invariants: result.invariants,
				faults: result.faults,
			},
		],
		coverage: profileCoverage(result.faults, SUITE_PROFILES["multi-node-resume"]).map((entry) => ({
			suite: "multi-node-resume",
			...entry,
		})),
		durations: {},
		environment: {},
	});
	const coverage = markdown.slice(markdown.indexOf("## Chaos coverage"), markdown.indexOf("## Invariants"));
	const rows = coverage.split("\n").filter((line) => line.startsWith("| multi-node-resume | "));
	assert.deepEqual(
		rows.map((line) => line.split(" | ").slice(1, 4)),
		[
			["partition", "exercised", "scenario 1: session lookup on n2"],
			["partition", "exercised", "scenario 5: released session wake on n2"],
			["partition", "exercised", "scenario 2: run lookup on n2"],
			["partition", "exercised", "scenario 6: session lookup on the git-less n3"],
			["sigkill", "exercised", "scenario 1: session restore on n2"],
			["sigkill", "exercised", "scenario 2: workflow owner mid-step on n1"],
			["sigkill", "exercised", "scenario 3: worker host on n2 holding a bound child"],
			["sigkill", "exercised", "scenario 4: fork restore on n3"],
		],
	);
});

test("a failed scenario is recorded and the independent scenarios still run (#4329)", async () => {
	const { runMultiNodeResume } = await import("../distributed/harness/resume-suite.mjs");
	const { remote, calls } = fleet({
		startPool: async () => {
			throw new Error("no host claimed the child");
		},
	});
	const result = await runMultiNodeResume(context(), remote);
	assert.ok(!calls.includes("kill-pool-host") && !calls.includes("finish-pool"));
	for (const later of ["wake-at-same-path", "resume-run", "gitless-resume", "fork", "integrity", "close"])
		assert.ok(calls.includes(later), later);
	assert.deepEqual(
		result.metrics.scenarioErrors?.map((item) => [item.scenario, item.error.message]),
		[["3", "no host claimed the child"]],
	);
	assert.equal(result.metrics.executionError?.message, "no host claimed the child");
	const failed = result.invariants.filter((item) => !item.passed).map((item) => item.name);
	assert.deepEqual(failed, [
		"pooled-child-reclaimed-after-host-sigkill",
		"pooled-child-restored-with-the-recorded-tree",
		"pooled-bound-work-never-on-the-gitless-host",
		"pooled-blueprint-built-once-where-restored",
		"chaos-hit-every-scenario",
		"suite-execution-completed",
	]);
});

test("a lost owner or worker host is part of its scenario whether or not sigkill is selected (#4329)", async () => {
	const { runMultiNodeResume } = await import("../distributed/harness/resume-suite.mjs");
	const { remote, calls } = fleet();
	const result = await runMultiNodeResume(context(["partition"]), remote);
	assert.ok(calls.includes("record-run") && calls.includes("kill-pool-host"));
	assert.ok(!calls.includes("kill-session-restore") && !calls.includes("kill-fork"));
	assert.deepEqual(
		result.faults.map((fault) => fault.profile),
		["partition", "partition", "partition", "partition"],
	);
	assert.equal(result.invariants.find((item) => item.name === "chaos-hit-every-scenario")?.passed, false);
	assert.equal(
		result.invariants.find((item) => item.name === "pooled-child-reclaimed-after-host-sigkill")?.passed,
		true,
	);
});

test("a pooled child is accepted only when it was restored where it finished, built once there, and never ran on the git-less host (#4329)", () => {
	const check = (change: Partial<typeof pool>, killed = { signal: "SIGKILL", marker: true }) =>
		Object.fromEntries(
			checkResumeInvariants({ ...passingEvidence(), pool: { ...pool, ...change }, poolKilled: killed })
				.filter((item) => item.name.startsWith("pooled-"))
				.map((item) => [item.name, item.passed]),
		);
	const passing = {
		"pooled-child-reclaimed-after-host-sigkill": true,
		"pooled-child-restored-with-the-recorded-tree": true,
		"pooled-bound-work-never-on-the-gitless-host": true,
		"pooled-blueprint-built-once-where-restored": true,
	};
	assert.deepEqual(check({}), passing);
	// The killed host's worker survived the kill.
	assert.deepEqual(check({}, { signal: "SIGKILL", marker: false }), {
		...passing,
		"pooled-child-reclaimed-after-host-sigkill": false,
	});
	// The restored tree lost the uncommitted edit.
	assert.deepEqual(check({ reclaimed: { ...pool.reclaimed, digest: "other" } }), {
		...passing,
		"pooled-child-restored-with-the-recorded-tree": false,
	});
	// The child reported a tree without one of the recorded files.
	const [child] = pool.outcome.children;
	assert.deepEqual(
		check({
			outcome: {
				status: "completed",
				children: [{ ...child!, finalFiles: JSON.stringify({ "README.md": "readme" }) }],
			},
		}),
		{ ...passing, "pooled-child-restored-with-the-recorded-tree": false },
	);
	// The blueprint was built twice in the reclaimed worktree, or not at all on the host that first restored it.
	assert.deepEqual(check({ setup: { ...pool.setup, A: [...pool.setup.A, ...pool.setup.A] } }), {
		...passing,
		"pooled-blueprint-built-once-where-restored": false,
	});
	assert.deepEqual(check({ setup: { ...pool.setup, B: [] } }), {
		...passing,
		"pooled-blueprint-built-once-where-restored": false,
	});
	// A git-less host that asked for work while the child waited counts a busy worker during each claim request, but
	// declined it: that alone is no violation.
	assert.deepEqual(check({ hosts: { ...pool.hosts, C: { ...pool.hosts.C, maxBusy: 1 } } }), passing);
	// The child was claimed once more than by the two hosts that held it: by the git-less host, which then gave it back.
	assert.deepEqual(check({ work: [{ state: "completed", generation: 3, worker: "A/1" }] }), {
		...passing,
		"pooled-bound-work-never-on-the-gitless-host": false,
	});
});

test("a woken released subagent is refused unless it was restored and continued in a restored checkout (#4329)", () => {
	const check = (wokenSubagent: ResumeEvidence["wokenSubagent"]) =>
		checkResumeInvariants({ ...passingEvidence(), wokenSubagent }).find(
			(item) => item.name === "released-subagent-wakes-restored-on-another-node",
		)?.passed;
	assert.equal(check(wokenSubagent), true);
	// The wake ended as the typed unrestorable outcome the subagent had before its directory was mapped.
	assert.equal(check({ ...wokenSubagent, outcome: "unrestorable" }), false);
	// It continued where it was recorded, in a checkout that is not a restored worktree.
	assert.equal(check({ ...wokenSubagent, cwd: wokenSubagent.recordedPath, mappings: [] }), false);
	// A different tree, or the recording node's path not resolving in the restored checkout.
	assert.equal(check({ ...wokenSubagent, digest: "other" }), false);
	assert.equal(check({ ...wokenSubagent, oldPathContent: WRITTEN }), false);
	assert.equal(check({ ...wokenSubagent, clean: false }), false);
	assert.equal(check(undefined), false);
});

test("a woken session is refused when it continues in another checkout at its recorded path (#4329)", () => {
	const check = (wokenAtSamePath: ResumeEvidence["wokenAtSamePath"]) =>
		checkResumeInvariants({ ...passingEvidence(), wokenAtSamePath }).find(
			(item) => item.name === "released-session-ignores-a-different-checkout-at-its-path",
		)?.passed;
	const restored = passingEvidence().wokenAtSamePath!;
	assert.equal(check(restored), true);
	// It continued where the other checkout is: no mapping, and that checkout's tree.
	assert.equal(
		check({
			...restored,
			...decoy.before,
			cwd: restored.recordedPath,
			restoreRoot: "/b/wake",
			mappings: [],
		}),
		false,
	);
	// It restored the recorded tree, but the restore replaced the other checkout's contents.
	assert.equal(
		check({ ...restored, decoy: { ...decoy, after: { digest: "sha-same-path", head: "head-same-path" } } }),
		false,
	);
	// The recording node's path did not resolve in the restored worktree.
	assert.equal(check({ ...restored, oldPathContent: "" }), false);
});

test("the fork counts only on the git-less third node, after a SIGKILL mid-restore it recovered from (#4329)", () => {
	const check = (change: ResumeEvidence) =>
		checkResumeInvariants({ ...passingEvidence(), ...change }).find(
			(item) => item.name === "fork-restores-the-boundary-snapshot",
		)?.passed;
	const { fork, forkKilled } = passingEvidence();
	assert.equal(check({}), true);
	assert.equal(check({ fork: { ...fork, gitless: false } }), false);
	assert.equal(check({ forkKilled: { ...forkKilled, clean: false } }), false);
	assert.equal(check({ forkKilled: undefined }), false);
	assert.equal(check({ fork: { ...fork, beforeTwo: "zero\n" } }), false);
});

test("the suite always cleans up its own resources after a failed step, retaining a cleanup failure (#4329)", async () => {
	const { runMultiNodeResume } = await import("../distributed/harness/resume-suite.mjs");
	const original = new Error("setup failed");
	const cleanup = new Error("cleanup failed");
	let closed = false;
	const remote = {
		prepare: async () => {
			throw original;
		},
		undo: async <T>(action: () => Promise<T>) => action(),
		close: async () => {
			closed = true;
			throw cleanup;
		},
	} as unknown as NonNullable<Parameters<typeof runMultiNodeResume>[1]>;
	const context = { profiles: [], faults: [], started: performance.now(), log: () => {} } as unknown as Parameters<
		typeof runMultiNodeResume
	>[0];
	const result = await runMultiNodeResume(context, remote);
	assert.equal(result.invariants.find((item) => item.name === "suite-execution-completed")?.passed, false);
	assert.equal(result.metrics.executionError?.message, "setup failed");
	assert.equal(result.metrics.executionError?.cleanupCause?.message, "cleanup failed");
	assert.equal(closed, true);
	assert.equal((original as Error & { cleanupCause?: unknown }).cleanupCause, cleanup);
});

test("an interrupted staging directory is not a published worktree, but a broken published checkout fails the check (#4329)", async () => {
	const { execFileSync } = await import("node:child_process");
	const { mkdirSync, rmSync, writeFileSync } = await import("node:fs");
	const { join } = await import("node:path");
	const { makeTempDirectory } = await import("../helpers/runtime.js");
	const { checkPublishedWorktrees } = await import("../distributed/node/resume-check.mjs");
	const root = makeTempDirectory("distributed-resume-check-");
	try {
		const complete = join(root, "complete");
		mkdirSync(complete);
		execFileSync("git", ["init", "-q", complete]);
		execFileSync("git", ["-C", complete, "config", "user.name", "Fixture"]);
		execFileSync("git", ["-C", complete, "config", "user.email", "fixture@example.com"]);
		execFileSync("git", ["-C", complete, "config", "commit.gpgsign", "false"]);
		writeFileSync(join(complete, "file"), "contents\n");
		execFileSync("git", ["-C", complete, "add", "file"]);
		execFileSync("git", ["-C", complete, "commit", "-qm", "fixture"]);
		execFileSync("git", ["-C", complete, "worktree", "add", "-q", "-b", "fixture-worktree", join(root, "linked")]);
		mkdirSync(join(root, ".staging-interrupted"));
		assert.deepEqual(checkPublishedWorktrees(root, "git"), {
			clean: true,
			incomplete: [],
			staging: [".staging-interrupted"],
		});
		mkdirSync(join(root, "broken"));
		assert.deepEqual(checkPublishedWorktrees(root, "git"), {
			clean: false,
			incomplete: ["broken"],
			staging: [".staging-interrupted"],
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("cancellation preserves the abort reason after cleanup (#4329)", async () => {
	const { runMultiNodeResume } = await import("../distributed/harness/resume-suite.mjs");
	const controller = new AbortController();
	const cancelled = new Error("cancelled by caller");
	controller.abort(cancelled);
	let closed = false;
	const remote = {
		prepare: async () => {
			throw controller.signal.reason;
		},
		undo: async <T>(action: () => Promise<T>) => action(),
		close: async () => {
			closed = true;
		},
	} as unknown as NonNullable<Parameters<typeof runMultiNodeResume>[1]>;
	const context = {
		profiles: [],
		faults: [],
		signal: controller.signal,
		started: performance.now(),
		log: () => {},
	} as unknown as Parameters<typeof runMultiNodeResume>[0];
	await assert.rejects(runMultiNodeResume(context, remote), (error: unknown) => error === cancelled);
	assert.equal(closed, true);
});

test("git-less failure requires a GitUnavailableError cause, retaining a nested provisioning timeout (#4329)", () => {
	const error = {
		name: "ResumePreconditionError",
		code: "preconditions-unmet",
		problems: [{ code: "git-unavailable" }],
		cause: {
			name: "GitUnavailableError",
			code: "not-installed",
			cause: { name: "GitProvisionTimeoutError", code: "provision-timeout" },
		},
	};
	const check = (cause: typeof error.cause | { name: string; code: string }) =>
		checkResumeInvariants({
			gitlessFailure: { code: 2, noWorktrees: true, provisioned: false, error: { ...error, cause } },
		}).find((item) => item.name === "gitless-failure-typed-and-nondestructive");
	assert.equal(check(error.cause)?.passed, true);
	assert.equal(check({ name: "GitProvisionTimeoutError", code: "provision-timeout" })?.passed, false);
	assert.equal(check({ name: "GitUnavailableError", code: "future-code" })?.passed, false);
});

test("tree manifests compare bytes, paths and executable bits rather than host permission or time metadata (#4329)", async () => {
	const { chmodSync, lstatSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
	const { join } = await import("node:path");
	const { makeTempDirectory } = await import("../helpers/runtime.js");
	const { treeManifest } = await import("../distributed/node/resume-check.mjs");
	const root = makeTempDirectory("distributed-resume-manifest-");
	try {
		const a = join(root, "a");
		const b = join(root, "b");
		mkdirSync(a, { mode: 0o700 });
		mkdirSync(b, { mode: 0o755 });
		writeFileSync(join(a, "file"), "same bytes\n", { mode: 0o600 });
		writeFileSync(join(b, "file"), "same bytes\n", { mode: 0o644 });
		assert.deepEqual(treeManifest(a), treeManifest(b));
		writeFileSync(join(b, "file"), "different bytes\n");
		assert.notEqual(treeManifest(a).digest, treeManifest(b).digest);
		writeFileSync(join(b, "file"), "same bytes\n");
		writeFileSync(join(b, "extra"), "same bytes\n");
		assert.notEqual(treeManifest(a).digest, treeManifest(b).digest);
		rmSync(join(b, "extra"));
		chmodSync(join(b, "file"), 0o755);
		const left = treeManifest(a);
		const right = treeManifest(b);
		const executable = (lstatSync(join(b, "file")).mode & 0o111) !== 0;
		assert.equal(right.entries[0]?.executable, executable);
		assert.equal(right.digest !== left.digest, right.entries[0]?.executable !== left.entries[0]?.executable);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
