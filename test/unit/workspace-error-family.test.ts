/**
 * Worktree snapshot errors (#4245) and workspace binding errors (#3109) are one family exported from
 * `@bastani/atomic`: one base class, one code union, and one set of guards, cause search and wire form.
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import * as snapshotErrors from "../../packages/coding-agent/src/core/worktree-snapshot/errors.ts";
import {
	findWorkspaceError,
	GitUnavailableError,
	isRetryableWorkspaceError,
	isWorkspaceBindingError,
	isWorkspaceConfigError,
	isWorkspaceDriftError,
	isWorkspaceError,
	isWorkspaceRestoreError,
	rehydrateWorkspaceError,
	serializeWorkspaceError,
	WorkspaceBindingError,
	WorkspaceCollectionError,
	WorkspaceConfigError,
	WorkspaceDriftError,
	WorkspaceError,
	WorkspaceRestoreError,
} from "../../packages/coding-agent/src/index.ts";

const OID = "a".repeat(40);

describe("the workspace error family (#3109, #4245)", () => {
	test("the snapshot module and the package root export the same classes and guards", () => {
		assert.equal(snapshotErrors.WorkspaceError, WorkspaceError);
		assert.equal(snapshotErrors.WorkspaceRestoreError, WorkspaceRestoreError);
		assert.equal(snapshotErrors.WorkspaceConfigError, WorkspaceConfigError);
		assert.equal(snapshotErrors.serializeWorkspaceError, serializeWorkspaceError);
		assert.equal(snapshotErrors.GitUnavailableError, GitUnavailableError);
	});

	test("snapshot and binding errors share one base, guards and cause search", () => {
		const drift = new WorkspaceDriftError({
			root: "/r",
			expectedHead: OID,
			actualHead: null,
			expectedTree: OID,
			actualTree: null,
			snapshotId: null,
		});
		const binding = new WorkspaceBindingError({ code: "writer-conflict", fields: { worktree: "/wt" }, cause: drift });
		for (const error of [drift, binding, new WorkspaceCollectionError({ table: "t", phase: "sweep", deleted: 0 })]) {
			assert.ok(error instanceof WorkspaceError);
			assert.ok(isWorkspaceError(error));
			assert.equal(error.message, `${error.summary} (${error.code}). ${error.hint}`);
		}
		assert.equal(findWorkspaceError(new Error("wrapped", { cause: binding }), isWorkspaceDriftError), drift);
		assert.equal(isRetryableWorkspaceError(binding), true);
	});

	test("one restore class holds both snapshot restore codes and binding restores", () => {
		const snapshot = new WorkspaceRestoreError("blob-missing", { snapshotId: "s1", blob: "b", role: "patch" });
		const recorded = new WorkspaceRestoreError({
			reason: "branch-missing",
			fields: { branch: "feat", worktree: "/wt" },
		});
		for (const original of [snapshot, recorded]) {
			const back = rehydrateWorkspaceError(JSON.parse(JSON.stringify(serializeWorkspaceError(original))));
			assert.ok(back instanceof WorkspaceRestoreError);
			assert.ok(isWorkspaceRestoreError(back));
			assert.equal(back.code, original.code);
			assert.equal(back.reason, original.reason);
			assert.equal(back.message, original.message);
			assert.deepEqual(back.fields, original.fields);
		}
		assert.equal(recorded.code, "restore-failed");
		assert.equal(recorded.reason, "branch-missing");
	});

	test("one config class serves snapshot settings and workspace options", () => {
		const setting = new WorkspaceConfigError("settings", "snapshots.fullEvery", "a positive integer");
		const option = new WorkspaceConfigError({
			source: "sdk",
			field: "workspace.repo",
			reason: "missing",
			expected: "a path",
			received: "undefined",
		});
		for (const original of [setting, option]) {
			assert.ok(isWorkspaceConfigError(original));
			const back = rehydrateWorkspaceError(JSON.parse(JSON.stringify(serializeWorkspaceError(original))));
			assert.ok(back instanceof WorkspaceConfigError);
			assert.equal(back.message, original.message);
			assert.equal(back.reason, original.reason);
			assert.deepEqual(back.fields, original.fields);
		}
	});

	test("a binding error caused by Git provisioning's GitUnavailableError keeps it through a round trip", () => {
		const unavailable = new GitUnavailableError({
			code: "offline",
			platform: "linux",
			arch: "x64",
			offlineVariable: "ATOMIC_OFFLINE",
		});
		const binding = new WorkspaceBindingError({
			code: "git-unavailable",
			fields: { gitPath: "git", installCommand: "sudo apt-get install git" },
			cause: unavailable,
		});
		const back = rehydrateWorkspaceError(JSON.parse(JSON.stringify(serializeWorkspaceError(binding))));
		assert.ok(isWorkspaceBindingError(back));
		assert.ok(back.cause instanceof GitUnavailableError);
		assert.equal(back.cause.code, "offline");
	});
});
