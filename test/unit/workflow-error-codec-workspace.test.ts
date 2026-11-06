import assert from "node:assert/strict";
import { test } from "vitest";
import {
	GitUnavailableError,
	isGitUnavailableError,
	isWorkspaceError,
	isWorkspaceGitError,
	isWorkspaceRestoreError,
	WorkspaceError,
	WorkspaceGitError,
	WorkspaceRestoreError,
} from "../../packages/coding-agent/src/index.js";
import { MAX_CAUSE_DEPTH } from "../../packages/workflows/src/shared/error-cause-chain.js";
import {
	rehydrateError,
	type SerializedError,
	serializeError,
} from "../../packages/workflows/src/shared/error-codec.js";
import {
	isWorkspaceRestoreUnavailableError,
	WorkspaceRestoreUnavailableError,
} from "../../packages/workflows/src/workers/placement-errors.js";

/** `error` sent through the codec and back, as JSON in between, as the shared journal and the pool's IPC carry it. */
function crossed(error: unknown): Error {
	return rehydrateError(JSON.parse(JSON.stringify(serializeError(error))));
}

const notInstalled = () =>
	new GitUnavailableError({
		code: "not-installed",
		platform: "linux",
		arch: "x64",
		installDir: "/home/user/.atomic/agent/bin/git",
		installCommand: "sudo apt-get install -y git",
	});

test("a restore error crosses the pool as its own class, with its code, fields, hint and message (#4416)", () => {
	const unreachable = new WorkspaceRestoreError("commits-unavailable", {
		snapshotId: "s1",
		head: "h1",
		commits: ["h1"],
	});
	const envelope = serializeError(unreachable);
	assert.equal(envelope.family, "workspace");
	const back = crossed(unreachable);
	assert.ok(back instanceof WorkspaceRestoreError, String(back));
	assert.ok(isWorkspaceRestoreError(back));
	assert.deepEqual(
		[back.name, back.code, back.fields, back.hint, back.retryable, back.message],
		[
			"WorkspaceRestoreError",
			"commits-unavailable",
			unreachable.fields,
			unreachable.hint,
			unreachable.retryable,
			unreachable.message,
		],
	);
});

test("a git error crosses as its own class, and so does the cause it was raised with (#4416)", () => {
	const failed = new WorkspaceGitError(
		{ operation: "fetch", cwd: "/store", exitCode: 128, detail: "could not read from remote" },
		Object.assign(new Error("spawn failed"), { name: "SpawnError" }),
	);
	const back = crossed(failed);
	assert.ok(isWorkspaceGitError(back) && back instanceof WorkspaceGitError, String(back));
	assert.deepEqual([back.code, back.fields], ["git-failed", failed.fields]);
	assert.deepEqual([(back.cause as Error).name, (back.cause as Error).message], ["SpawnError", "spawn failed"]);
});

test("GitUnavailableError crosses the protocol through the git-provision registry entry (#4416)", () => {
	const git = notInstalled();
	const envelope = serializeError(git);
	assert.equal(envelope.family, "git-provision");
	const back = rehydrateError(JSON.parse(JSON.stringify(envelope)));
	assert.ok(back instanceof GitUnavailableError);
	assert.ok(isGitUnavailableError(back));
	assert.deepEqual(back.toJSON(), git.toJSON());
	const twice = crossed(back);
	assert.ok(twice instanceof GitUnavailableError);
	assert.deepEqual(twice.toJSON(), git.toJSON());
});

test("a refusal whose git does not run keeps that git error as its cause, with its hint (#4416)", () => {
	const git = notInstalled();
	const refusal = new WorkspaceRestoreUnavailableError(
		"no-restore-port",
		{ remotes: [], head: "h", tree: "t", envHash: "e" },
		{ cause: git },
	);
	const back = crossed(refusal);
	assert.ok(isWorkspaceRestoreUnavailableError(back) && back instanceof WorkspaceRestoreUnavailableError);
	assert.equal(back.reason, "no-restore-port");
	assert.ok(isGitUnavailableError(back.cause) && back.cause instanceof GitUnavailableError, String(back.cause));
	assert.deepEqual([back.cause.code, back.cause.hint, back.cause.platform], ["not-installed", git.hint, "linux"]);
	const unclaimed = new WorkspaceRestoreUnavailableError("no-capable-host", back.binding, {
		childRunId: "child-1",
		claimWindowMs: 5,
		cause: back,
	});
	const twice = crossed(unclaimed);
	assert.ok(isWorkspaceRestoreUnavailableError(twice));
	assert.ok(isWorkspaceRestoreUnavailableError(twice.cause) && isGitUnavailableError(twice.cause.cause));
});

test("a workspace error of a class this version does not know keeps its name, code, fields and sub-case (#4416)", () => {
	const future = new WorkspaceError({
		name: "WorkspaceFutureError",
		code: "git-failed",
		summary: "A future failure",
		hint: "Do the future thing.",
		fields: { depth: 2 },
		reason: "sub-case",
		cleanupCause: new Error("cleanup failed"),
	});
	const envelope = serializeError(future);
	assert.equal(envelope.extra?.reason, "sub-case");
	const back = crossed(future);
	assert.ok(isWorkspaceError(back) && back instanceof WorkspaceError, String(back));
	assert.deepEqual(
		[back.name, back.code, back.fields, back.reason, back.hint, back.message],
		["WorkspaceFutureError", "git-failed", { depth: 2 }, "sub-case", "Do the future thing.", future.message],
	);
	assert.equal((back.cleanupCause as Error | undefined)?.message, "cleanup failed", "its cleanup failure crosses too");
	const plain = crossed(new WorkspaceError({ code: "git-failed", summary: "s", hint: "h", fields: { depth: 1 } }));
	assert.equal((plain as WorkspaceError).reason, undefined, "no sub-case, none made up");
	assert.deepEqual((plain as WorkspaceError).fields, { depth: 1 });
});

test("an error outside every family still crosses by name and message alone (#4416)", () => {
	const back = crossed(new TypeError("the remote is unreachable"));
	assert.deepEqual(
		[back.name, back.message, isWorkspaceError(back), back instanceof TypeError],
		["TypeError", "the remote is unreachable", false, false],
	);
	assert.equal(serializeError(new TypeError("x")).family, undefined);
});

test("a workspace error's causes and cleanup causes cross as deep as any error's, and no deeper (#4416)", () => {
	const chain = (link: "cause" | "cleanupCause") => {
		let error: WorkspaceError | undefined;
		for (let index = 0; index < MAX_CAUSE_DEPTH + 2; index++)
			error = new WorkspaceError({
				code: "git-failed",
				summary: `link ${index}`,
				hint: "h",
				fields: { index },
				...(error === undefined ? {} : { [link]: error }),
			});
		return error!;
	};
	for (const link of ["cause", "cleanupCause"] as const) {
		let depth = 0;
		for (let node: SerializedError | undefined = serializeError(chain(link)); node !== undefined; node = node[link])
			depth++;
		assert.equal(depth, MAX_CAUSE_DEPTH, link);
	}
});
