import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { shellCommandPrefixFor } from "../src/core/agent-session-blueprint-environment.ts";
import { sessionEnvrcPath } from "../src/core/resume/blueprint/envrc.ts";
import { withWorktreeRootMappings } from "../src/core/resume/path-mapping.ts";

let sandbox: string;

beforeEach(() => {
	sandbox = realpathSync(mkdtempSync(join(tmpdir(), "blueprint-shell-prefix-")));
});

afterEach(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

function sessionWith(roots: readonly string[], agentDir: string | undefined, cwd = join(sandbox, "elsewhere")) {
	return {
		_storageAgentDir: agentDir,
		sessionManager: {
			getWorktreeRootMappings: () => roots.map((to) => ({ from: `${to}-recorded`, to })),
			getCwd: () => cwd,
		},
	} as never;
}

test("an empty user prefix is left out of the session's shell prefix (#4588)", () => {
	const agentDir = join(sandbox, "agent");
	const root = join(sandbox, "worktree");
	const file = sessionEnvrcPath(join(agentDir, "worktree-snapshots"), root);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, "FOO=bar\n");

	const session = sessionWith([root], agentDir);
	assert.ok(shellCommandPrefixFor(session, "")?.startsWith("set -a; . "));
	assert.ok(shellCommandPrefixFor(session, undefined)?.startsWith("set -a; . "));
	assert.ok(
		shellCommandPrefixFor(session, "shopt -s expand_aliases")?.startsWith("shopt -s expand_aliases\nset -a; . "),
	);
});

test("without a blueprint environment the prefix is the user's, or none when that is empty (#4588)", () => {
	const session = sessionWith([join(sandbox, "worktree")], join(sandbox, "agent"));
	assert.equal(shellCommandPrefixFor(session, ""), undefined);
	assert.equal(shellCommandPrefixFor(session, undefined), undefined);
	assert.equal(shellCommandPrefixFor(session, "alias x=y"), "alias x=y");
	assert.equal(shellCommandPrefixFor(sessionWith([], undefined), "alias x=y"), "alias x=y");
});

function writeEnvrc(agentDir: string, root: string): void {
	const file = sessionEnvrcPath(join(agentDir, "worktree-snapshots"), root);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, "FOO=bar\n");
}

test("a pooled child that runs inside a restored worktree gets that worktree's $ENVRC without any restore of its own (#4588)", () => {
	const agentDir = join(sandbox, "agent");
	const root = join(agentDir, "worktree-snapshots", "worktrees", "abc-123");
	writeEnvrc(agentDir, root);

	assert.ok(
		shellCommandPrefixFor(sessionWith([], agentDir, join(root, "packages", "app")), undefined)?.startsWith(
			"set -a; . ",
		),
	);
	assert.equal(
		shellCommandPrefixFor(
			sessionWith([], agentDir, join(agentDir, "worktree-snapshots", "worktrees-other")),
			undefined,
		),
		undefined,
	);
	assert.equal(shellCommandPrefixFor(sessionWith([], agentDir, join(sandbox, "elsewhere")), undefined), undefined);
});

test("a stage of a resumed run gets the $ENVRC of the worktree its run restored, through the run's restores (#4588)", () => {
	const agentDir = join(sandbox, "agent");
	const recordedRoot = join(sandbox, "recorded-on-node-a");
	const restoredRoot = join(agentDir, "worktree-snapshots", "worktrees", "def-456");
	writeEnvrc(agentDir, restoredRoot);
	const session = sessionWith([], agentDir, join(recordedRoot, "src"));

	assert.equal(shellCommandPrefixFor(session, undefined), undefined);
	const prefix = withWorktreeRootMappings(
		[{ from: recordedRoot, to: restoredRoot, snapshotId: "s", restoredAt: "t" } as never],
		() => shellCommandPrefixFor(session, undefined),
	);
	assert.ok(prefix?.startsWith("set -a; . "));
});
