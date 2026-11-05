import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	unreadablePathError,
	unwritablePathError,
} from "../../packages/coding-agent/src/core/worktree-snapshot/errors.ts";
import {
	DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
	findWorkspaceError,
	GitUnavailableError,
	type GitUnavailableErrorCode,
	gitInstallCommand,
	isGitUnavailableError,
	isWorkspaceConfigError,
	isWorkspaceDriftError,
	isWorkspaceError,
	isWorkspaceGitError,
	isWorkspaceRestoreError,
	isWorkspaceSnapshotError,
	rehydrateWorkspaceError,
	resolveWorktreeSnapshotSettings,
	type SerializedWorkspaceError,
	serializeWorkspaceError,
	WorkspaceConfigError,
	WorkspaceDriftError,
	WorkspaceError,
	WorkspaceGitError,
	WorkspaceRestoreError,
	type WorkspaceRestoreErrorCode,
	type WorkspaceRestoreErrorFields,
	WorkspaceSnapshotError,
} from "../../packages/coding-agent/src/index.ts";

const HEAD = "a".repeat(40);
const TREE = "b".repeat(40);

describe("WorkspaceError base", () => {
	test("renders <summary> (<code>). <hint>, keeps a frozen copy of its fields and exposes them as properties", () => {
		const fields = { subject: "/repo", count: 2 };
		const error = new WorkspaceError("git-failed", "Something failed", "Try again.", fields);
		assert.equal(error.name, "WorkspaceError");
		assert.equal(error.message, "Something failed (git-failed). Try again.");
		assert.equal(error.code, "git-failed");
		assert.equal(error.hint, "Try again.");
		assert.equal(error.retryable, false);
		assert.deepEqual(error.fields, { subject: "/repo", count: 2 });
		assert.ok(Object.isFrozen(error.fields));
		fields.count = 3;
		assert.equal(error.fields.count, 2);
		assert.equal((error as unknown as { subject: string }).subject, "/repo");
		assert.equal(Object.hasOwn(error, "cause"), false);
		assert.equal(Object.hasOwn(error, "cleanupCause"), false);
	});

	test("wraps a lower-level failure as its cause", () => {
		const cause = new Error("disk");
		const error = new WorkspaceError("git-failed", "Failed", "Retry.", {}, cause);
		assert.equal(error.cause, cause);
	});
});

describe("GitUnavailableError", () => {
	const summaries: Record<GitUnavailableErrorCode, string> = {
		"not-installed": "could not be started",
		"unsupported-platform": "cannot be provisioned on this platform",
		offline: "could not be downloaded while offline",
		"checksum-mismatch": "failed its checksum after download",
	};

	test("each code renders its own reason, the platform's install command and no stray cause", () => {
		const alternative = process.platform === "linux" ? " (or your distribution's package manager)" : "";
		const hint = `Install Git with \`${gitInstallCommand()}\`${alternative} or put it on PATH, then retry.`;
		for (const [code, summary] of Object.entries(summaries) as [GitUnavailableErrorCode, string][]) {
			const error = new GitUnavailableError(code, "/opt/git");
			assert.equal(
				error.message,
				`Git is unavailable: /opt/git ${summary}, and worktree snapshots need it to read and rebuild repository state (${code}). ${hint}`,
			);
			assert.equal(error.code, code);
			assert.equal(error.hint, hint);
			assert.equal(error.name, "GitUnavailableError");
			assert.equal(error.retryable, false);
			assert.equal(error.platform, process.platform);
			assert.equal(error.executable, "/opt/git");
			assert.deepEqual(error.fields, { platform: process.platform, executable: "/opt/git" });
			assert.ok(Object.isFrozen(error.fields));
			assert.equal(Object.hasOwn(error, "cause"), false);
		}
	});

	test("keeps the lower-level failure as its cause", () => {
		const cause = Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
		assert.equal(new GitUnavailableError("not-installed", "git", { cause }).cause, cause);
	});

	test("names the install command of each platform", () => {
		assert.equal(gitInstallCommand("darwin"), "xcode-select --install");
		assert.equal(gitInstallCommand("win32"), "winget install --id Git.Git -e");
		assert.equal(gitInstallCommand("linux"), "sudo apt-get install git");
		assert.equal(gitInstallCommand("freebsd"), "install Git from https://git-scm.com/downloads");
	});
});

describe("WorkspaceGitError and WorkspaceSnapshotError", () => {
	test("a Git failure names the operation, directory and first line of detail, and omits an empty detail", () => {
		const cause = new Error("spawn");
		const failed = new WorkspaceGitError(
			{ operation: "fetch", cwd: "/store", exitCode: 128, detail: "fatal: no such remote" },
			cause,
		);
		assert.equal(
			failed.message,
			"Git fetch failed in /store: fatal: no such remote (git-failed). Check that the repository is readable, its disk has free space, and no other Git process holds its lock, then retry.",
		);
		assert.equal(failed.cause, cause);
		assert.deepEqual(failed.fields, {
			operation: "fetch",
			cwd: "/store",
			exitCode: 128,
			detail: "fatal: no such remote",
		});
		const quiet = new WorkspaceGitError({ operation: "gc", cwd: "/store", exitCode: null, detail: "" });
		assert.equal(
			quiet.message,
			"Git gc failed in /store (git-failed). Check that the repository is readable, its disk has free space, and no other Git process holds its lock, then retry.",
		);
		assert.equal(Object.hasOwn(quiet, "cause"), false);
	});

	test("each snapshot-unavailable code renders its subject, remedy and cause", () => {
		const cause = new Error("ENOENT");
		const cases = [
			[
				"not-a-repository",
				"Worktree snapshot unavailable: /w is not inside a Git repository (not-a-repository). Work inside a Git checkout to record snapshots.",
			],
			[
				"unborn-head",
				"Worktree snapshot unavailable: /w has no commits yet (unborn-head). Create a first commit to record snapshots.",
			],
			[
				"blob-store-unsupported",
				'Worktree snapshot unavailable: /w storage cannot hold snapshot blobs (blob-store-unsupported). Select a SQLite session store, for example `--session-store <path>` or `"sessions": { "storage": { "path": "sessions.sqlite" } }` in settings.json, to record snapshots.',
			],
			[
				"unreadable-path",
				"Worktree snapshot unavailable: /w cannot be read (unreadable-path). Make /w readable by the current user (for example `chmod u+rwX` on it and its parent directories), replace a symbolic link that loops or points nowhere, or list the path in .gitignore or .atomic/snapshot-ignore, then retry.",
			],
		] as const;
		for (const [code, message] of cases) {
			const error = new WorkspaceSnapshotError(code, "/w", cause);
			assert.equal(error.message, message);
			assert.equal(error.code, code);
			assert.deepEqual(error.fields, { subject: "/w" });
			assert.equal(error.subject, "/w");
			assert.equal(error.cause, cause);
		}
	});
});

describe("WorkspaceRestoreError messages", () => {
	const restoreHint = {
		blobMissing:
			"Use the storage the snapshot was recorded in, or import (`atomic --import <file>`) a session saved with `/export <file>.jsonl`, which carries its blobs.",
	};
	const cases: readonly [string, WorkspaceRestoreErrorCode, WorkspaceRestoreErrorFields, string][] = [
		[
			"snapshot-not-found",
			"snapshot-not-found",
			{ snapshotId: null, head: HEAD, tree: TREE },
			`Cannot restore workspace: no retained snapshot or warm object store has tree ${TREE} (snapshot-not-found). Pass the recorded snapshot, or restore on a host that already materialized this tree.`,
		],
		[
			"blob-missing patch",
			"blob-missing",
			{ snapshotId: "snap1", blob: "h1", role: "patch", deltaIndex: 2 },
			`Cannot restore snapshot snap1: patch blob h1 is missing from storage (blob-missing). ${restoreHint.blobMissing}`,
		],
		[
			"blob-missing bundle without a snapshot id",
			"blob-missing",
			{ snapshotId: null, blob: "h2", role: "bundle" },
			`Cannot restore snapshot binding: bundle blob h2 is missing from storage (blob-missing). ${restoreHint.blobMissing}`,
		],
		[
			"blob-corrupt",
			"blob-corrupt",
			{ snapshotId: "snap1", blob: "h3", role: "bundle" },
			"Cannot restore snapshot snap1: bundle blob h3 does not match its hash (blob-corrupt). The stored snapshot is damaged; restore an earlier snapshot or re-import the session.",
		],
		[
			"commits-unavailable not-fetched with two remotes",
			"commits-unavailable",
			{
				snapshotId: "snap1",
				head: HEAD,
				commits: [HEAD],
				remotes: ["https://a/r.git", "https://b/r.git"],
				reason: "not-fetched",
			},
			`Cannot restore snapshot snap1: commit ${HEAD} could not be fetched from https://a/r.git, https://b/r.git (commits-unavailable). Check access with \`git ls-remote https://a/r.git\` and that ${HEAD} is pushed, then retry.`,
		],
		[
			"commits-unavailable not-fetched without remotes",
			"commits-unavailable",
			{ snapshotId: "snap1", head: HEAD, commits: [HEAD], remotes: [], reason: "not-fetched" },
			`Cannot restore snapshot snap1: commit ${HEAD} could not be fetched from no recorded remote (commits-unavailable). Push ${HEAD} to a remote and record it, then retry.`,
		],
		[
			"commits-unavailable denied-history",
			"commits-unavailable",
			{
				snapshotId: "snap1",
				head: HEAD,
				commits: ["c1", "c2"],
				paths: [".env", "id_rsa"],
				remotes: ["https://a/r.git", "https://b/r.git"],
				reason: "denied-history",
			},
			`Cannot restore snapshot snap1: commit ${HEAD} is not on https://a/r.git, https://b/r.git and its unpushed history touches denied paths .env, id_rsa (commits-unavailable). Push commit ${HEAD} (with its history) to a recorded remote, then retry. Commits c1, c2 add or change denied paths .env, id_rsa, so pushing publishes those files.`,
		],
		[
			"commits-unavailable bundle-over-cap without remotes",
			"commits-unavailable",
			{ snapshotId: "snap1", head: HEAD, commits: ["c1"], reason: "bundle-over-cap" },
			`Cannot restore snapshot snap1: commit ${HEAD} is not on no recorded remote and its unpushed history exceeded the snapshot size cap (commits-unavailable). Push commit ${HEAD} (with its history) to a recorded remote, or raise snapshots.maxSnapshotBytes and record a new snapshot, then retry.`,
		],
		[
			"delta-failed with a patch",
			"delta-failed",
			{ snapshotId: "snap1", deltaIndex: 3, blob: "p3", expectedTree: TREE, actualTree: null },
			`Cannot restore snapshot snap1: delta 3 (patch p3) did not produce tree ${TREE} (delta-failed). The patch chain does not apply to its base; restore an earlier snapshot.`,
		],
		[
			"delta-failed without a patch",
			"delta-failed",
			{ snapshotId: "snap1", deltaIndex: 0, expectedTree: TREE, actualTree: HEAD },
			`Cannot restore snapshot snap1: delta 0 (patch none) did not produce tree ${TREE} (delta-failed). The patch chain does not apply to its base; restore an earlier snapshot.`,
		],
		[
			"tree-mismatch",
			"tree-mismatch",
			{ snapshotId: "snap1", target: "/restored", expectedTree: TREE, actualTree: HEAD },
			`Restored worktree does not match snapshot snap1: /restored has tree ${HEAD}, expected ${TREE} (tree-mismatch). Check the repository's .gitattributes filters, then retry the restore into a new directory.`,
		],
		[
			"unsafe-target not-empty",
			"unsafe-target",
			{ snapshotId: null, target: "/dir", reason: "not-empty" },
			"Cannot restore into /dir: it is not an empty directory (unsafe-target). Choose a new or empty directory, or omit `into` to restore under Atomic home.",
		],
		[
			"unsafe-target not-restored",
			"unsafe-target",
			{ snapshotId: null, target: "/dir", reason: "not-restored" },
			"Cannot remove /dir: it is not a worktree that a snapshot restore created (unsafe-target). Remove only paths returned by restoreWorktreeSnapshot, with the same storeDir.",
		],
		[
			"unwritable-path during a restore",
			"unwritable-path",
			{ snapshotId: "snap1", target: "/host/repositories" },
			"Cannot write /host/repositories while restoring snapshot snap1 (unwritable-path). Free space on the volume that holds /host/repositories, or make it and its parent directory writable by the current user (for example `chmod u+rwX`), then retry.",
		],
		[
			"unwritable-path without a snapshot",
			"unwritable-path",
			{ snapshotId: null, target: "/dir" },
			"Cannot write /dir (unwritable-path). Free space on the volume that holds /dir, or make it and its parent directory writable by the current user (for example `chmod u+rwX`), then retry.",
		],
	];

	test.each(cases)("%s", (_name, code, fields, message) => {
		const cause = new Error("underlying");
		const error = new WorkspaceRestoreError(code, fields, cause);
		assert.equal(error.message, message);
		assert.equal(error.code, code);
		assert.equal(error.name, "WorkspaceRestoreError");
		assert.equal(error.cause, cause);
		assert.deepEqual(error.fields, fields);
		assert.equal(error.snapshotId, fields.snapshotId);
		assert.ok(message.endsWith(error.hint));
	});

	test("fields left undefined are not part of the JSON-safe fields", () => {
		const error = new WorkspaceRestoreError("unsafe-target", {
			snapshotId: null,
			target: "/x",
			reason: "not-empty",
			head: undefined,
			commits: undefined,
		});
		assert.deepEqual(Object.keys(error.fields).sort(), ["reason", "snapshotId", "target"]);
		assert.equal(Object.hasOwn(error, "cause"), false);
	});
});

describe("WorkspaceDriftError", () => {
	test("names the root, both trees and heads, and says none when the checkout has neither", () => {
		const drifted = new WorkspaceDriftError({
			root: "/r",
			expectedHead: HEAD,
			actualHead: "c".repeat(40),
			expectedTree: TREE,
			actualTree: "d".repeat(40),
			snapshotId: "snap1",
		});
		assert.equal(
			drifted.message,
			`Worktree drifted from its recorded snapshot: /r has tree ${"d".repeat(40)} at ${"c".repeat(40)}, expected ${TREE} at ${HEAD} (tree-drift). Restore the recorded snapshot into a new worktree, or undo the changes, then resume.`,
		);
		const gone = new WorkspaceDriftError(
			{ root: "/r", expectedHead: HEAD, actualHead: null, expectedTree: TREE, actualTree: null, snapshotId: null },
			new Error("not-a-repository"),
		);
		assert.equal(
			gone.message,
			`Worktree drifted from its recorded snapshot: /r has tree none at no HEAD, expected ${TREE} at ${HEAD} (tree-drift). Restore the recorded snapshot into a new worktree, or undo the changes, then resume.`,
		);
		assert.deepEqual(gone.fields, {
			root: "/r",
			expectedHead: HEAD,
			actualHead: null,
			expectedTree: TREE,
			actualTree: null,
			snapshotId: null,
		});
		assert.equal((gone.cause as Error).message, "not-a-repository");
	});
});

describe("WorkspaceConfigError and settings resolution", () => {
	test("a config error names its source, field and the expected value", () => {
		const error = new WorkspaceConfigError("env", "snapshots.fullEvery", "a positive integer");
		assert.equal(
			error.message,
			"Invalid worktree snapshot setting: snapshots.fullEvery from env (invalid-setting). Set snapshots.fullEvery to a positive integer.",
		);
		assert.deepEqual(error.fields, { source: "env", field: "snapshots.fullEvery", expected: "a positive integer" });
	});

	test("defaults apply without input and an overlay keeps the base for unset fields", () => {
		assert.equal(resolveWorktreeSnapshotSettings(undefined, "sdk", "snapshots"), DEFAULT_WORKTREE_SNAPSHOT_SETTINGS);
		assert.deepEqual(DEFAULT_WORKTREE_SNAPSHOT_SETTINGS, {
			enabled: true,
			includeUntracked: true,
			maxFileBytes: 5 * 1024 * 1024,
			maxSnapshotBytes: 50 * 1024 * 1024,
			fullEvery: 10,
		});
		const base = { enabled: false, includeUntracked: false, maxFileBytes: 7, maxSnapshotBytes: 9, fullEvery: 3 };
		assert.deepEqual(resolveWorktreeSnapshotSettings({}, "sdk", "snapshots", base), base);
		assert.deepEqual(resolveWorktreeSnapshotSettings({ enabled: true, fullEvery: 1 }, "sdk", "snapshots", base), {
			...base,
			enabled: true,
			fullEvery: 1,
		});
		assert.ok(Object.isFrozen(resolveWorktreeSnapshotSettings({}, "sdk", "snapshots")));
	});

	test("input that is not an object fails naming the whole option", () => {
		for (const input of [null, "yes", 5, true, []]) {
			assert.throws(
				() => resolveWorktreeSnapshotSettings(input as never, "settings", "snapshots"),
				(error: unknown) => {
					assert.ok(isWorkspaceConfigError(error));
					assert.deepEqual(error.fields, { source: "settings", field: "snapshots", expected: "an object" });
					return true;
				},
			);
		}
	});

	test("a non-boolean flag fails naming its field", () => {
		for (const field of ["enabled", "includeUntracked"] as const) {
			for (const value of ["yes", 1, null]) {
				assert.throws(
					() => resolveWorktreeSnapshotSettings({ [field]: value } as never, "cli", "opts"),
					(error: unknown) => {
						assert.ok(isWorkspaceConfigError(error));
						assert.deepEqual(error.fields, { source: "cli", field: `opts.${field}`, expected: "true or false" });
						return true;
					},
				);
			}
		}
	});

	test("sizes and cadence accept any positive safe integer and reject everything else", () => {
		for (const field of ["maxFileBytes", "maxSnapshotBytes", "fullEvery"] as const) {
			assert.equal(resolveWorktreeSnapshotSettings({ [field]: 1 }, "sdk", "s")[field], 1);
			assert.equal(
				resolveWorktreeSnapshotSettings({ [field]: Number.MAX_SAFE_INTEGER }, "sdk", "s")[field],
				Number.MAX_SAFE_INTEGER,
			);
			for (const value of [
				0,
				-1,
				1.5,
				Number.NaN,
				Number.POSITIVE_INFINITY,
				Number.MAX_SAFE_INTEGER + 1,
				"5",
				null,
			]) {
				assert.throws(
					() => resolveWorktreeSnapshotSettings({ [field]: value } as never, "sdk", "s"),
					(error: unknown) => {
						assert.ok(isWorkspaceConfigError(error));
						assert.deepEqual(error.fields, {
							source: "sdk",
							field: `s.${field}`,
							expected: "a positive integer",
						});
						return true;
					},
				);
			}
		}
	});
});

describe("guards", () => {
	const named = (name: string, code: string) => ({ name, code, message: "m" });
	const guards = [
		["isWorkspaceConfigError", isWorkspaceConfigError, "WorkspaceConfigError", "invalid-setting"],
		["isWorkspaceGitError", isWorkspaceGitError, "WorkspaceGitError", "git-failed"],
		["isWorkspaceSnapshotError", isWorkspaceSnapshotError, "WorkspaceSnapshotError", "unborn-head"],
		["isWorkspaceRestoreError", isWorkspaceRestoreError, "WorkspaceRestoreError", "delta-failed"],
		["isWorkspaceDriftError", isWorkspaceDriftError, "WorkspaceDriftError", "tree-drift"],
		["isGitUnavailableError", isGitUnavailableError, "GitUnavailableError", "offline"],
	] as const;

	test.each(guards)(
		"%s accepts its class by name and code from another realm and nothing else",
		(_n, guard, name, code) => {
			assert.equal(guard(named(name, code)), true);
			assert.equal(guard(named("Error", code)), false);
			assert.equal(guard(named(name, "not-a-code")), false);
			assert.equal(guard({ name, code: 5 }), false);
			assert.equal(guard({ name }), false);
			assert.equal(guard({ code }), false);
			for (const value of [null, undefined, name, code, 5, true]) assert.equal(guard(value), false);
		},
	);

	test("the family guard accepts every concrete name with a code of the family and nothing else", () => {
		for (const [, , name, code] of guards.filter(([, , name]) => name !== "GitUnavailableError")) {
			assert.equal(isWorkspaceError(named(name, code)), true, name);
		}
		assert.equal(isWorkspaceError(named("WorkspaceError", "git-failed")), true);
		assert.equal(isWorkspaceError(named("GitUnavailableError", "offline")), false);
		assert.equal(isWorkspaceError(named("Error", "git-failed")), false);
		assert.equal(isWorkspaceError(named("WorkspaceDriftError", "no-such-code")), false);
		assert.equal(isWorkspaceError({ name: "WorkspaceDriftError", code: 7 }), false);
		assert.equal(isWorkspaceError({ name: 7, code: "tree-drift" }), false);
		assert.equal(isWorkspaceError(null), false);
		assert.equal(isWorkspaceError("tree-drift"), false);
	});

	test("a name that only exists on Object.prototype is not a workspace error name", () => {
		for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
			assert.equal(isWorkspaceError({ name, code: "git-failed" }), false, name);
		}
	});

	test("the class guards accept instances of their own class only", () => {
		assert.equal(
			isWorkspaceRestoreError(
				new WorkspaceDriftError({
					root: "/",
					expectedHead: "h",
					actualHead: null,
					expectedTree: "t",
					actualTree: null,
					snapshotId: null,
				}),
			),
			false,
		);
		assert.equal(isWorkspaceSnapshotError(new WorkspaceSnapshotError("unborn-head", "/")), true);
		assert.equal(
			isWorkspaceGitError(new WorkspaceGitError({ operation: "x", cwd: "/", exitCode: 1, detail: "" })),
			true,
		);
		assert.equal(isGitUnavailableError(new GitUnavailableError("offline", "git")), true);
		assert.equal(isGitUnavailableError(new Error("offline")), false);
	});
});

describe("findWorkspaceError", () => {
	test("finds the first match walking causes, tolerates a null or undefined cause, and stops after eight levels", () => {
		const drift = new WorkspaceDriftError({
			root: "/",
			expectedHead: "h",
			actualHead: null,
			expectedTree: "t",
			actualTree: null,
			snapshotId: null,
		});
		const wrapped = new Error("outer", { cause: new Error("middle", { cause: drift }) });
		assert.equal(findWorkspaceError(wrapped, isWorkspaceDriftError), drift);
		assert.equal(findWorkspaceError(wrapped), drift);
		assert.equal(findWorkspaceError(drift), drift);
		assert.equal(findWorkspaceError(new Error("x", { cause: null })), undefined);
		assert.equal(findWorkspaceError(new Error("x", { cause: undefined })), undefined);
		assert.equal(findWorkspaceError(new Error("x", { cause: "text" })), undefined);
		assert.equal(findWorkspaceError(null), undefined);
		assert.equal(findWorkspaceError(undefined), undefined);
		assert.equal(findWorkspaceError(drift, isWorkspaceRestoreError), undefined);
		let deep: Error = drift;
		for (let level = 0; level < 7; level++) deep = new Error(`level ${level}`, { cause: deep });
		assert.equal(findWorkspaceError(deep), drift);
		assert.equal(findWorkspaceError(new Error("one more", { cause: deep })), undefined);
	});
});

describe("serialization across a process boundary", () => {
	test("keeps at most four levels: the error and three causes", () => {
		let error: Error = new Error("level 5");
		for (let level = 4; level >= 0; level--) error = new Error(`level ${level}`, { cause: error });
		let serialized: SerializedWorkspaceError | undefined = serializeWorkspaceError(error);
		const messages: string[] = [];
		while (serialized) {
			messages.push(serialized.message);
			serialized = serialized.cause;
		}
		assert.deepEqual(messages, ["level 0", "level 1", "level 2", "level 3"]);
	});

	test("a plain error serializes as name and message only; a workspace error adds code, hint and fields", () => {
		assert.deepEqual(serializeWorkspaceError(new TypeError("plain")), { name: "TypeError", message: "plain" });
		const git = new WorkspaceGitError({ operation: "x", cwd: "/", exitCode: 2, detail: "d" });
		assert.deepEqual(serializeWorkspaceError(git), {
			name: "WorkspaceGitError",
			code: "git-failed",
			hint: git.hint,
			fields: { operation: "x", cwd: "/", exitCode: 2, detail: "d" },
			message: git.message,
		});
		const unavailable = new GitUnavailableError("offline", "git");
		const wire = serializeWorkspaceError(unavailable);
		assert.equal(wire.code, "offline");
		assert.deepEqual(wire.fields, { platform: process.platform, executable: "git" });
		assert.equal(wire.hint, unavailable.hint);
	});

	test("a Git unavailability keeps its cause through a round trip", () => {
		const original = new GitUnavailableError("not-installed", "git", { cause: new Error("spawn git ENOENT") });
		const back = rehydrateWorkspaceError(JSON.parse(JSON.stringify(serializeWorkspaceError(original))));
		assert.ok(back instanceof GitUnavailableError);
		assert.equal(back.code, "not-installed");
		assert.equal(back.message, original.message);
		assert.equal((back.cause as Error).message, "spawn git ENOENT");
	});

	test("filesystem failures keep their class, code, path and cause message through a round trip", () => {
		const loop = Object.assign(new Error("ELOOP: too many symbolic links encountered, stat '/w/loop'"), {
			code: "ELOOP",
			syscall: "stat",
		});
		const full = Object.assign(new Error("ENOSPC: no space left on device, mkdir '/host/repositories'"), {
			code: "ENOSPC",
			syscall: "mkdir",
		});
		const unreadable = unreadablePathError("/w/loop", loop);
		const unwritable = unwritablePathError("/host/repositories", "snap1", full);
		for (const [original, guard, subject] of [
			[unreadable, isWorkspaceSnapshotError, { subject: "/w/loop" }],
			[unwritable, isWorkspaceRestoreError, { snapshotId: "snap1", target: "/host/repositories" }],
		] as const) {
			assert.ok(guard(original));
			const back = rehydrateWorkspaceError(JSON.parse(JSON.stringify(serializeWorkspaceError(original))));
			assert.equal(back.constructor, original.constructor);
			assert.ok(guard(back));
			assert.equal(back.code, original.code);
			assert.deepEqual(back.fields, subject);
			assert.equal(back.message, original.message);
			assert.equal((back.cause as Error).message, (original.cause as Error).message);
		}
	});
	test("a plain error keeps its name and cause", () => {
		const back = rehydrateWorkspaceError({
			name: "RangeError",
			message: "outer",
			cause: { name: "TypeError", message: "inner" },
		});
		assert.equal(back.constructor, Error);
		assert.equal(back.name, "RangeError");
		assert.equal(back.message, "outer");
		assert.equal((back.cause as Error).name, "TypeError");
		assert.equal((back.cause as Error).message, "inner");
		assert.equal(Object.hasOwn(rehydrateWorkspaceError({ name: "Error", message: "m" }), "cause"), false);
	});

	test("a name or code this version does not know stays a WorkspaceError with every field preserved", () => {
		const cause = {
			name: "WorkspaceGitError",
			code: "git-failed",
			message: "g",
			fields: { operation: "x", cwd: "/", exitCode: 1, detail: "" },
		};
		const future = rehydrateWorkspaceError({
			name: "WorkspaceLeaseError",
			code: "lease-lost",
			message: "lease lost (lease-lost). Renew it.",
			hint: "Renew it.",
			fields: { holder: "h1" },
			cause,
		}) as WorkspaceError;
		assert.ok(future instanceof WorkspaceError);
		assert.equal(future.name, "WorkspaceLeaseError");
		assert.equal(future.code as string, "lease-lost");
		assert.equal(future.message, "lease lost (lease-lost). Renew it.");
		assert.equal(future.hint, "Renew it.");
		assert.equal(future.retryable, false);
		assert.deepEqual(future.fields, { holder: "h1" });
		assert.ok(Object.isFrozen(future.fields));
		assert.ok(future.cause instanceof WorkspaceGitError);
		const descriptor = (key: string) => Object.getOwnPropertyDescriptor(future, key);
		for (const key of ["code", "hint", "retryable", "fields"]) assert.equal(descriptor(key)?.enumerable, true, key);
		for (const key of ["name", "message", "cause"]) assert.equal(descriptor(key)?.enumerable, false, key);
		assert.equal(descriptor("retryable")?.value, false);

		const bare = rehydrateWorkspaceError({
			name: "WorkspaceLeaseError",
			code: "lease-lost",
			message: "m",
		}) as WorkspaceError;
		assert.equal(bare.hint, "");
		assert.deepEqual(bare.fields, {});
		assert.ok(Object.isFrozen(bare.fields));
		assert.equal(Object.hasOwn(bare, "cause"), false);
	});

	test("a known name with an unknown code, or without fields, is not rebuilt as that class", () => {
		const unknownCode = rehydrateWorkspaceError({
			name: "WorkspaceDriftError",
			code: "future-code",
			message: "m",
			fields: { root: "/" },
		});
		assert.ok(unknownCode instanceof WorkspaceError);
		assert.ok(!(unknownCode instanceof WorkspaceDriftError));
		assert.equal((unknownCode as WorkspaceError).code as string, "future-code");
		const noFields = rehydrateWorkspaceError({ name: "WorkspaceDriftError", code: "tree-drift", message: "m" });
		assert.ok(!(noFields instanceof WorkspaceDriftError));
		assert.equal(noFields.name, "WorkspaceDriftError");
		assert.equal((noFields as WorkspaceError).code, "tree-drift");
	});

	test("a serialized name that exists on Object.prototype cannot crash or masquerade", () => {
		for (const name of ["constructor", "toString", "__proto__"]) {
			const back = rehydrateWorkspaceError({ name, code: "tree-drift", message: "m", fields: {} });
			assert.ok(back instanceof WorkspaceError);
			assert.ok(!(back instanceof WorkspaceDriftError));
			assert.equal(back.message, "m");
		}
	});
});

describe("filesystem failure wrappers", () => {
	const failure = (code: string, syscall: string) =>
		Object.assign(new Error(`${code}: failed, ${syscall} '/w/a'`), { code, syscall });

	test("an unreadable path wraps a filesystem error with the path as its subject", () => {
		const cause = failure("EACCES", "lstat");
		const error = unreadablePathError("/w/a", cause);
		assert.ok(error instanceof WorkspaceSnapshotError);
		assert.equal(error.code, "unreadable-path");
		assert.deepEqual(error.fields, { subject: "/w/a" });
		assert.equal(error.cause, cause);
		assert.equal(error.retryable, false);
	});

	test("an unwritable path wraps a filesystem error with the target and snapshot", () => {
		const cause = failure("ENOSPC", "write");
		const error = unwritablePathError("/w/a", null, cause);
		assert.ok(error instanceof WorkspaceRestoreError);
		assert.equal(error.code, "unwritable-path");
		assert.deepEqual(error.fields, { snapshotId: null, target: "/w/a" });
		assert.equal(error.cause, cause);
	});

	test("errors that are not filesystem failures pass through both unchanged", () => {
		const coded = Object.assign(new Error("no syscall"), { code: "EACCES" });
		const typed = new GitUnavailableError("offline", "git");
		for (const error of [coded, typed, "text", undefined]) {
			assert.equal(unreadablePathError("/w/a", error), error);
			assert.equal(unwritablePathError("/w/a", "snap1", error), error);
		}
	});
});

describe("a drift whose automatic restore failed shows that failure (#4245)", () => {
	const drift = {
		root: "/r",
		expectedHead: HEAD,
		actualHead: null,
		expectedTree: TREE,
		actualTree: null,
		snapshotId: "s1",
	};
	const prefix = `Worktree drifted from its recorded snapshot: /r has tree none at no HEAD, expected ${TREE} at ${HEAD}`;
	const restoreFailures = [
		[
			"denied history",
			new WorkspaceRestoreError("commits-unavailable", {
				snapshotId: "s1",
				head: HEAD,
				commits: ["c1"],
				paths: [".env"],
				remotes: ["https://a/r.git"],
				reason: "denied-history",
			}),
		],
		["a missing blob", new WorkspaceRestoreError("blob-missing", { snapshotId: "s1", blob: "h1", role: "patch" })],
		[
			"an unfetched commit",
			new WorkspaceRestoreError("commits-unavailable", {
				snapshotId: "s1",
				head: HEAD,
				commits: [HEAD],
				remotes: ["https://a/r.git"],
				reason: "not-fetched",
			}),
		],
		[
			"an invalid record",
			new WorkspaceRestoreError("invalid-snapshot", {
				snapshotId: "s1",
				field: "remotes[0]",
				reason: "unsafe-remote",
			}),
		],
	] as const;

	test.each(restoreFailures)("%s: the message names it and the hint is its fix", (_name, failure) => {
		const error = new WorkspaceDriftError({ ...drift, reason: "restore-failed" }, failure);
		assert.equal(
			error.message,
			`${prefix}, and the automatic restore failed: ${failure.summary} (tree-drift). ${failure.hint}`,
		);
		assert.equal(error.hint, failure.hint);
		assert.equal(error.reason, "restore-failed");
		assert.equal(error.restoreCode, failure.code);
		assert.deepEqual(error.fields, { ...drift, reason: "restore-failed", restoreCode: failure.code });
		const back = rehydrateWorkspaceError(JSON.parse(JSON.stringify(serializeWorkspaceError(error))));
		assert.ok(back instanceof WorkspaceDriftError);
		assert.equal(back.message, error.message);
		assert.deepEqual(back.fields, error.fields);
	});

	test("a restore failure deeper in the cause chain, or Git being unavailable, is shown the same way", () => {
		const missing = new WorkspaceRestoreError("blob-missing", { snapshotId: "s1", blob: "h1", role: "bundle" });
		const wrapped = new WorkspaceDriftError(
			{ ...drift, reason: "restore-failed" },
			new Error("outer", { cause: missing }),
		);
		assert.equal(wrapped.restoreCode, "blob-missing");
		assert.equal(wrapped.hint, missing.hint);
		const git = new GitUnavailableError("not-installed", "git");
		const unavailable = new WorkspaceDriftError({ ...drift, reason: "restore-failed" }, git);
		assert.equal(
			unavailable.message,
			`${prefix}, and the automatic restore failed: Git is unavailable (not-installed) (tree-drift). ${git.hint}`,
		);
		assert.equal(unavailable.restoreCode, "not-installed");
	});

	test("an untyped failure, no cause, or a drift that was never restored keeps the drift's own remedy", () => {
		const generic = "Restore the recorded snapshot into a new worktree, or undo the changes, then resume.";
		for (const error of [
			new WorkspaceDriftError({ ...drift, reason: "restore-failed" }, new Error("disk on fire")),
			new WorkspaceDriftError({ ...drift, reason: "restore-failed" }),
			new WorkspaceDriftError(drift, new WorkspaceRestoreError("blob-missing", { snapshotId: "s1", blob: "h1" })),
		]) {
			assert.equal(error.message, `${prefix} (tree-drift). ${generic}`);
			assert.equal(error.hint, generic);
			assert.equal(error.restoreCode, undefined);
			assert.equal(error.message.includes("disk on fire"), false);
		}
	});

	test("every workspace error exposes what failed apart from its code and hint", () => {
		const error = new WorkspaceSnapshotError("unborn-head", "/w");
		assert.equal(error.summary, "Worktree snapshot unavailable: /w has no commits yet");
		assert.equal(error.message, `${error.summary} (unborn-head). ${error.hint}`);
	});
});

describe("blob-store-unsupported names the setting that selects SQLite for its store (#4245)", () => {
	test("a session store and a workflow journal each get their own fix", () => {
		assert.equal(
			new WorkspaceSnapshotError("blob-store-unsupported", "jsonl").hint,
			'Select a SQLite session store, for example `--session-store <path>` or `"sessions": { "storage": { "path": "sessions.sqlite" } }` in settings.json, to record snapshots.',
		);
		assert.equal(
			new WorkspaceSnapshotError("blob-store-unsupported", "workflow journal").message,
			'Worktree snapshot unavailable: workflow journal storage cannot hold snapshot blobs (blob-store-unsupported). Select a SQLite workflow journal, for example `"workflows": { "journal": { "path": "workflows/journal.sqlite" } }` in settings.json, to record snapshots.',
		);
	});
});
