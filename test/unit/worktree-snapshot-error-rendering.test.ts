import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	isWorkspaceError,
	WorkspaceRestoreError,
	type WorkspaceRestoreErrorFields,
} from "../../packages/coding-agent/src/index.ts";

const HEAD = "a".repeat(40);

describe("a restore error built from only its required fields still renders", () => {
	const bare = (code: ConstructorParameters<typeof WorkspaceRestoreError>[0], fields: WorkspaceRestoreErrorFields) =>
		new WorkspaceRestoreError(code, fields);

	test("a missing blob without a role names the snapshot and the blob", () => {
		const error = bare("blob-missing", { snapshotId: "snap-1", blob: "deadbeef" });
		assert.equal(error.code, "blob-missing");
		assert.match(error.message, /^Cannot restore snapshot snap-1: snapshot blob deadbeef is missing from storage/);
		assert.equal(error.role, undefined);
	});

	test("a corrupt blob without a role names the snapshot and the blob", () => {
		const error = bare("blob-corrupt", { snapshotId: "snap-1", blob: "deadbeef" });
		assert.match(error.message, /^Cannot restore snapshot snap-1: snapshot blob deadbeef does not match its hash/);
	});

	test("a commit that was not fetched and has no recorded remote says to push it", () => {
		const error = bare("commits-unavailable", { snapshotId: "snap-1", head: HEAD, reason: "not-fetched" });
		assert.equal(error.code, "commits-unavailable");
		assert.match(error.message, new RegExp(`commit ${HEAD} could not be fetched from no recorded remote`));
		assert.equal(error.hint, `Push ${HEAD} to a remote and record it, then retry.`);
	});

	test("unpushed history that touches denied paths renders without the optional path and commit lists", () => {
		const error = bare("commits-unavailable", { snapshotId: "snap-1", head: HEAD, reason: "denied-history" });
		assert.equal(error.code, "commits-unavailable");
		assert.equal(error.reason, "denied-history");
		assert.match(error.message, /its unpushed history touches denied paths/);
		assert.match(error.hint ?? "", /^Push commits .* to a recorded remote, then retry\.$/);
	});

	test("unpushed history over the size cap renders without the optional commit list", () => {
		const error = bare("commits-unavailable", { snapshotId: "snap-1", head: HEAD, reason: "bundle-over-cap" });
		assert.match(error.message, /its unpushed history exceeded the snapshot size cap/);
	});
});

describe("the structural guard for the whole family", () => {
	test("a name that is not a string but reads as a family name does not make an error a workspace error", () => {
		const impostor = { name: ["WorkspaceGitError"], code: "git-failed", message: "x" };
		assert.equal(isWorkspaceError(impostor), false);
		const spelled = { name: { toString: () => "WorkspaceGitError" }, code: "git-failed", message: "x" };
		assert.equal(isWorkspaceError(spelled), false);
		const genuine = { name: "WorkspaceGitError", code: "git-failed", message: "x" };
		assert.equal(isWorkspaceError(genuine), true);
	});
});
