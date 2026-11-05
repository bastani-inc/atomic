import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { canonicalizeWorktreePath } from "../../packages/coding-agent/src/core/worktree-snapshot/index.ts";
import { assertUnreadablePath } from "../helpers/worktree-snapshot.js";

let root: string;
beforeEach(() => {
	root = realpathSync.native(mkdtempSync(join(tmpdir(), "atomic-canonical-")));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe.skipIf(process.platform === "win32")("canonical worktree paths (#4245)", () => {
	test("a directory reached through a link becomes its real path", () => {
		mkdirSync(join(root, "real", "repo"), { recursive: true });
		symlinkSync(join(root, "real"), join(root, "link"));
		assert.equal(canonicalizeWorktreePath(join(root, "link", "repo")), join(root, "real", "repo"));
		assert.equal(canonicalizeWorktreePath(join(root, "link", "repo", "")), join(root, "real", "repo"));
	});

	test("components that do not exist keep their spelling below the real path of what does", () => {
		mkdirSync(join(root, "real"));
		symlinkSync(join(root, "real"), join(root, "link"));
		assert.equal(
			canonicalizeWorktreePath(join(root, "link", "gone", "deeper")),
			join(root, "real", "gone", "deeper"),
		);
		assert.equal(canonicalizeWorktreePath(join(root, "missing")), join(root, "missing"));
	});

	test("a link that loops fails as an unreadable path instead of being guessed", () => {
		symlinkSync(join(root, "loop"), join(root, "loop"));
		assert.throws(
			() => canonicalizeWorktreePath(join(root, "loop", "repo")),
			(error: unknown) => {
				assertUnreadablePath(error, join(root, "loop", "repo"), "ELOOP");
				return true;
			},
		);
	});
});
