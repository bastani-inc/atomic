import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import {
	captureWorktreeSnapshot,
	type WorktreeSnapshotCapture,
} from "../../packages/coding-agent/src/core/worktree-snapshot/capture.ts";
import type { WorktreeSnapshotOmission } from "../../packages/coding-agent/src/core/worktree-snapshot/types.ts";
import { GitSandbox, startedGitProcesses } from "../helpers/worktree-snapshot.js";

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(() => sandbox.dispose());

/**
 * A cap that one edit of {@link dataFile} bundles far under while Git deltifies it against the pushed version, and far
 * over when an attribute turns delta compression off for it, which stores the whole file again.
 */
const settings = { maxSnapshotBytes: 16 * 1024 };

/** Text that does not compress much: 64 KiB of random bytes, in base64 lines. */
function dataFile(): string {
	return `${randomBytes(48 * 1024)
		.toString("base64")
		.replace(/.{76}/g, "$&\n")}\n`;
}

function captured(result: WorktreeSnapshotCapture): Extract<WorktreeSnapshotCapture, { status: "captured" }> {
	assert.equal(result.status, "captured", JSON.stringify(result));
	return result as Extract<WorktreeSnapshotCapture, { status: "captured" }>;
}

function historyOmissions(omitted: readonly WorktreeSnapshotOmission[]): WorktreeSnapshotOmission[] {
	return omitted.filter((omission) => !("path" in omission));
}

/** The Git commands started since `trace` was last emptied, by name, which empties it again. */
function commandsIn(trace: string): string[] {
	if (!existsSync(trace)) return [];
	const commands = startedGitProcesses(trace).map(({ argv = [] }) => {
		const command = argv.slice(1).filter((arg, index, all) => arg !== "-c" && all[index - 1] !== "-c");
		return command[0] === "bundle" ? `bundle ${command[1]}` : (command[0] ?? "");
	});
	rmSync(trace, { force: true });
	return commands;
}

/**
 * `captureWorktreeSnapshot` of the modules loaded again, as in a new process, which has not asked Git anything yet,
 * running `executable` traced to `trace`.
 */
async function inNewProcess(
	trace: string,
	executable: string = sandbox.executable.path,
): Promise<typeof captureWorktreeSnapshot> {
	vi.resetModules();
	const capture = await import("../../packages/coding-agent/src/core/worktree-snapshot/capture.ts");
	const git = await import("../../packages/coding-agent/src/core/worktree-snapshot/git.ts");
	const traced = { path: executable, env: { ...sandbox.executable.env, GIT_TRACE2_EVENT: trace } };
	git.setWorktreeSnapshotGit(async () => traced);
	return capture.captureWorktreeSnapshot;
}

/** A clone of a remote that has `sub/data.txt`, with one unpushed commit that edits its first line. */
async function cloneWithEditedData(): Promise<{ clone: string; commit: string }> {
	const data = dataFile();
	const { clone } = await sandbox.remoteWithClone("repo", { "sub/data.txt": data });
	sandbox.write(join(clone, "sub", "data.txt"), `edited ${data}`);
	const commit = await sandbox.commitAll(clone, "edit data");
	return { clone, commit };
}

/** Captures `clone` after an edit of a file of its own, so the capture records a snapshot. */
async function captureAfterEdit(clone: string, edit: string) {
	sandbox.write(join(clone, "edit.txt"), `${edit}\n`);
	return captured(await captureWorktreeSnapshot(clone, { settings }));
}

describe("unpushed history over the cap because an attribute turned delta compression off", () => {
	test("a .gitattributes in the directory of the commits' files, removed, has them bundled again", async () => {
		const { clone, commit } = await cloneWithEditedData();
		sandbox.write(join(clone, "sub", ".gitattributes"), "data.txt -delta\n");
		const first = await captureAfterEdit(clone, "one");
		assert.equal(historyOmissions(first.snapshot.omitted)[0]?.reason, "bundle-over-cap");

		rmSync(join(clone, "sub", ".gitattributes"));
		const second = await captureAfterEdit(clone, "two");
		assert.deepEqual(historyOmissions(second.snapshot.omitted), []);
		assert.deepEqual(second.snapshot.bundle?.commits, [commit]);
	});

	test("the repository's info/attributes, emptied, has them bundled again", async () => {
		const { clone, commit } = await cloneWithEditedData();
		const info = join(clone, ".git", "info", "attributes");
		sandbox.write(info, "sub/data.txt -delta\n");
		const first = await captureAfterEdit(clone, "one");
		assert.equal(historyOmissions(first.snapshot.omitted)[0]?.reason, "bundle-over-cap");

		sandbox.write(info, "");
		const second = await captureAfterEdit(clone, "two");
		assert.deepEqual(historyOmissions(second.snapshot.omitted), []);
		assert.deepEqual(second.snapshot.bundle?.commits, [commit]);
	});

	test("the user's attributes file (core.attributesFile), edited in place, has them bundled again", async () => {
		const { clone, commit } = await cloneWithEditedData();
		const user = sandbox.path("user-attributes");
		sandbox.write(user, "sub/data.txt -delta\n");
		await sandbox.git(clone, "config", "core.attributesFile", user.replace(/\\/g, "/"));
		const first = await captureAfterEdit(clone, "one");
		assert.equal(historyOmissions(first.snapshot.omitted)[0]?.reason, "bundle-over-cap");

		sandbox.write(user, "*.png binary\n");
		const second = await captureAfterEdit(clone, "two");
		assert.deepEqual(historyOmissions(second.snapshot.omitted), []);
		assert.deepEqual(second.snapshot.bundle?.commits, [commit]);
	});

	test("attributes written again as they were, and elsewhere, keep the commits left out without bundling", async () => {
		const { clone } = await cloneWithEditedData();
		sandbox.write(join(clone, "sub", ".gitattributes"), "data.txt -delta\n");
		const trace = sandbox.traceGitProcesses();
		const first = await captureAfterEdit(clone, "one");
		const [omission] = historyOmissions(first.snapshot.omitted);
		assert.equal(omission?.reason, "bundle-over-cap");
		assert.ok(commandsIn(trace).includes("bundle create"));

		sandbox.write(join(clone, "sub", ".gitattributes"), "data.txt -delta\n");
		sandbox.write(join(clone, "other", ".gitattributes"), "*.bin -delta\n");
		const second = await captureAfterEdit(clone, "two");
		assert.deepEqual(historyOmissions(second.snapshot.omitted), [omission]);
		const commands = commandsIn(trace);
		assert.ok(!commands.includes("bundle create") && !commands.includes("var"), commands.join(" "));
	});

	test("a capture whose unpushed commits fit asks Git nothing more about attributes", async () => {
		const { clone } = await cloneWithEditedData();
		const trace = sandbox.path("fits-trace.jsonl");
		const capture = await inNewProcess(trace);
		sandbox.write(join(clone, "edit.txt"), "one\n");
		const fits = captured(await capture(clone, { settings }));
		assert.equal(fits.snapshot.bundle?.commits.length, 1);
		assert.ok(!commandsIn(trace).includes("var"));
	});

	test("a .gitattributes above files the commits only delete has them bundled again", async () => {
		const data = dataFile();
		const { clone } = await sandbox.remoteWithClone("repo", { "sub/data.txt": data, "gone/inner/old.txt": "old\n" });
		sandbox.write(join(clone, ".git", "info", "attributes"), "sub/data.txt -delta\n");
		sandbox.write(join(clone, "sub", "data.txt"), `edited ${data}`);
		await sandbox.git(clone, "rm", "-q", "-r", "gone");
		await sandbox.commitAll(clone, "delete old");
		const trace = sandbox.traceGitProcesses();
		const first = await captureAfterEdit(clone, "one");
		assert.equal(historyOmissions(first.snapshot.omitted)[0]?.reason, "bundle-over-cap");
		commandsIn(trace);

		// Git reads it for the tree of the directory the files were deleted from.
		sandbox.write(join(clone, "gone", ".gitattributes"), "inner -delta\n");
		const second = await captureAfterEdit(clone, "two");
		assert.equal(historyOmissions(second.snapshot.omitted)[0]?.reason, "bundle-over-cap");
		assert.ok(commandsIn(trace).includes("bundle create"), "bundled again");
	});
});

/**
 * A `git` that names `system` as the system's attributes file (`git var GIT_ATTR_SYSTEM`), noting each time it is asked
 * in `asked`, and runs the installed Git for everything else.
 */
function gitNamingSystemAttributes(system: string, asked: string): string {
	const script = sandbox.path("git-with-system-attributes");
	const real = sandbox.executable.path;
	writeFileSync(
		script,
		`#!/bin/sh
case " $* " in
*" var GIT_ATTR_SYSTEM "*) echo asked >> '${asked}'; printf '%s\\n' '${system}'; exit 0 ;;
esac
exec '${real}' "$@"
`,
	);
	chmodSync(script, 0o755);
	return script;
}

test.skipIf(process.platform === "win32")(
	"the system's attributes file Git names, edited, has the commits bundled again",
	async () => {
		const { clone } = await cloneWithEditedData();
		sandbox.write(join(clone, ".git", "info", "attributes"), "sub/data.txt -delta\n");
		const system = sandbox.path("system-attributes");
		sandbox.write(system, "*.png binary\n");
		const asked = sandbox.path("asked");
		const timesAsked = () => (existsSync(asked) ? readFileSync(asked, "utf8").split("\n").filter(Boolean).length : 0);
		const trace = sandbox.path("system-trace.jsonl");
		const capture = await inNewProcess(trace, gitNamingSystemAttributes(system, asked));
		sandbox.write(join(clone, "edit.txt"), "one\n");
		const first = captured(await capture(clone, { settings }));
		assert.equal(historyOmissions(first.snapshot.omitted)[0]?.reason, "bundle-over-cap");
		assert.equal(timesAsked(), 1);
		commandsIn(trace);

		sandbox.write(system, "*.jpg binary\n");
		sandbox.write(join(clone, "edit.txt"), "two\n");
		const second = captured(await capture(clone, { settings }));
		assert.equal(historyOmissions(second.snapshot.omitted)[0]?.reason, "bundle-over-cap");
		const commands = commandsIn(trace);
		assert.ok(commands.includes("bundle create"), "bundled again");
		assert.equal(timesAsked(), 1, "Git is asked once per process");
	},
);
