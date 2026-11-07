import assert from "node:assert/strict";
import { test } from "vitest";
import { checkResumeInvariants } from "../distributed/harness/resume-invariants.mjs";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

test("multi-node resume evidence is never accepted when a required scenario observation is missing (#4329)", () => {
	const invariants = checkResumeInvariants({});
	assert.ok(invariants.length > 0);
	assert.ok(
		invariants.every((item) => !item.passed),
		JSON.stringify(invariants),
	);
});

test("the suite runs the three-node resume and chaos sequence, and refuses false evidence (#4329)", async () => {
	const { runMultiNodeResume } = await import("../distributed/harness/resume-suite.mjs");
	const calls: string[] = [];
	const tree = { digest: "sha", head: "head", fsck: true };
	const resumed = {
		...tree,
		cwd: "/restored/tree",
		restoreRoot: "/restored",
		notice: true,
		clean: true,
		setupRuns: 1,
		userMessages: 2,
		oldPathContent: "written by the model on node A",
	};
	const remote = {
		prepare: async () => {
			calls.push("prepare");
		},
		recordSession: async () => {
			calls.push("record-session");
			return { id: "s", source: tree };
		},
		partitionSession: async () => {
			calls.push("partition-session");
			return {
				code: 2,
				noWorktrees: true,
				dropped: 2,
				cleared: true,
				error: { name: "ResumeCatalogTimeoutError", code: "catalog-timeout", retryable: true, subject: "session" },
			};
		},
		killSessionRestore: async () => {
			calls.push("kill-session-restore");
			return { signal: "SIGKILL", marker: true };
		},
		resumeSession: async () => {
			calls.push("resume-session");
			return { observation: resumed, clean: true };
		},
		gitlessFailure: async () => {
			calls.push("gitless-failure");
			return {
				code: 2,
				noWorktrees: true,
				provisioned: false,
				error: {
					name: "ResumePreconditionError",
					code: "preconditions-unmet",
					problems: [{ code: "git-unavailable" }],
					cause: { name: "GitUnavailableError", code: "download-failed" },
				},
			};
		},
		gitlessResume: async () => {
			calls.push("gitless-resume");
			return { ...resumed, userMessages: 3, provisioned: true };
		},
		recordRun: async () => {
			calls.push("record-run");
			return { id: "r", killed: { signal: "SIGKILL" } };
		},
		waitForLease: async () => {
			calls.push("wait-lease");
		},
		partitionRun: async () => {
			calls.push("partition-run");
			return {
				code: 2,
				noWorktrees: true,
				dropped: 3,
				cleared: true,
				error: { name: "ResumeCatalogTimeoutError", code: "catalog-timeout", retryable: true, subject: "run" },
			};
		},
		resumeRun: async () => {
			calls.push("resume-run");
			return {
				status: "completed",
				clean: true,
				restoreRoot: "/w",
				children: ["alpha", "beta"].map((repository) => ({
					cwd: `/w/${repository}`,
					repository: `${repository}\n`,
					effects: "node-a\n",
					notes: "uncommitted, written on node-a\n",
				})),
			};
		},
		fork: async () => {
			calls.push("fork");
			return { status: "completed", beforeOne: "zero\n", beforeTwo: "one\n", cwd: "/f/tree", restoreRoot: "/f" };
		},
		integrity: async () => {
			calls.push("integrity");
			return ["ok"];
		},
		undo: async <T>(action: () => Promise<T>) => action(),
		close: async () => {
			calls.push("close");
		},
	};
	const faults: Parameters<typeof runMultiNodeResume>[0]["faults"] = [];
	const context = {
		profiles: ["partition", "sigkill"],
		faults,
		started: performance.now(),
		log: () => {},
	} as unknown as Parameters<typeof runMultiNodeResume>[0];
	const result = await runMultiNodeResume(context, remote);
	assert.ok(
		result.invariants.every((item) => item.passed),
		JSON.stringify(result.invariants),
	);
	assert.deepEqual(calls, [
		"prepare",
		"record-session",
		"partition-session",
		"kill-session-restore",
		"resume-session",
		"record-run",
		"wait-lease",
		"partition-run",
		"resume-run",
		"fork",
		"gitless-failure",
		"gitless-resume",
		"integrity",
		"close",
	]);
	assert.match(result.profileSpecs.partition!.effect, /catalog timeout/);
	assert.match(result.profileSpecs.sigkill!.mechanism, /worktree add/);
	assert.deepEqual(
		faults.map((item) => item.profile),
		["partition", "sigkill", "partition"],
	);
	const rejected = await runMultiNodeResume(
		{ ...context, faults: [] },
		{ ...remote, resumeRun: async () => ({ status: "completed", children: [], clean: true, restoreRoot: "/w" }) },
	);
	assert.equal(
		rejected.invariants.find((item) => item.name === "two-worktrees-resume-without-repeating-effects")?.passed,
		false,
	);
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
