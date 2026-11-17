import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, test } from "vitest";
import { renameReplacing } from "../src/core/rename-retry.js";
import { holdsSnapshotCommit } from "../src/core/resume/session-resume.js";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.js";
import {
	isWorkspaceRestoreError,
	prepareSessionResume,
	ResumePreconditionError,
	setWorktreeSnapshotGit,
	WorkspaceDriftError,
} from "../src/index.js";
import { nodeCommand, startedSleepingCommand } from "./helpers/hook-commands.js";
import { missingGit } from "./helpers/missing-git.js";
import {
	CountingGitIo,
	cwdOf,
	editedClone,
	options,
	recordSession,
	resolveForSession,
	sandbox,
	settings,
	setupBlueprint,
	setupRuns,
	useResumeSessionSandbox,
} from "./helpers/resume-session-fixture.js";

useResumeSessionSandbox();

describe("a setup command or blueprint never blocks a restore (#4329)", () => {
	const hostWorktrees = () => sandbox.path("host", "worktrees");

	test("an untrusted restore runs nothing and still succeeds, with only the restore notice (#4588)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		renameReplacing(clone, sandbox.path("gone"));

		const prepared = await prepareSessionResume(
			manager,
			options({ blueprint: setupBlueprint({ trusted: () => false }) }),
		);

		const restored = manager.getWorktreeRootMappings().at(-1)!.to;
		assert.ok(cwdOf(prepared)?.startsWith(hostWorktrees()), cwdOf(prepared));
		assert.ok(existsSync(restored));
		assert.equal(setupRuns(), 0);
		assert.deepEqual(prepared.status === "ready" && prepared.notices.map((notice) => notice.type), ["info"]);
		assert.deepEqual(prepared.status === "ready" && prepared.blueprintNotices, []);
	});

	test("a checkout whose recorded edits were committed here resumes in place, with no restore", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		await sandbox.commitAll(clone, "commit the recorded edits");
		const io = new CountingGitIo();
		const prepared = await prepareSessionResume(manager, options({ io }));
		assert.equal(cwdOf(prepared), clone);
		assert.equal(io.probes, 0);
		assert.deepEqual(manager.getWorktreeRootMappings(), []);
		assert.equal(existsSync(sandbox.path("host")), false);
		assert.equal(setupRuns(), 0);
	});

	test("the session's own checkout that changed since the snapshot is resumed in place without a notice, even without Git (#4660)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone, join(clone, "notes"));
		sandbox.write(join(clone, "README.md"), "changed after the snapshot\n");
		const io = new CountingGitIo(missingGit());
		let asked = false;
		const prepared = await prepareSessionResume(
			manager,
			options({
				io,
				chooseDirtyCheckout: async () => {
					asked = true;
					return "restore";
				},
			}),
		);
		assert.equal(cwdOf(prepared), join(clone, "notes"));
		assert.equal(asked, false);
		assert.equal(io.probes, 0);
		assert.deepEqual(prepared.status === "ready" && prepared.notices, []);
		assert.equal(existsSync(sandbox.path("host")), false);
		assert.deepEqual(manager.getWorktreeRootMappings(), []);
		assert.equal(readFileSync(join(clone, "README.md"), "utf8"), "changed after the snapshot\n");
	});

	test("the session's own clean checkout at a later commit is resumed in place, not restored into a worktree (#4660)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		sandbox.write(join(clone, "README.md"), "merged later\n");
		sandbox.write(join(clone, "notes", "untracked.txt"), "merged later\n");
		await sandbox.commitAll(clone, "work merged after the snapshot");
		const prepared = await prepareSessionResume(manager, options({ launchCwd: clone }));
		assert.equal(cwdOf(prepared), clone);
		assert.deepEqual(prepared.status === "ready" && prepared.notices, []);
		assert.equal(existsSync(sandbox.path("host")), false);
		assert.equal(setupRuns(), 0);
	});

	test("a session moved into a restored worktree returns to the checkout it was restored from (#4660)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone, join(clone, "notes"));
		renameReplacing(clone, sandbox.path("away"));
		const first = await prepareSessionResume(manager, options());
		const worktree = manager.getWorktreeRootMappings().at(-1)!.to;
		assert.equal(cwdOf(first), join(worktree, "notes"));
		renameReplacing(sandbox.path("away"), clone);
		sandbox.write(join(clone, "README.md"), "merged later\n");
		await sandbox.commitAll(clone, "work merged after the snapshot");

		const reopened = first.status === "ready" ? first.sessionManager : manager;
		const second = await prepareSessionResume(reopened, options());

		assert.equal(cwdOf(second), join(clone, "notes"));
		const id = reopened.getLatestWorktreeSnapshots().get(worktree)!.id;
		assert.deepEqual(second.status === "ready" && second.notices, [
			{
				type: "info",
				message: `Resuming in ${clone}, the checkout this session was restored from, instead of the worktree ${worktree}. It has changed since snapshot ${id.slice(0, 12)}; that snapshot was not restored.`,
			},
		]);
		assert.deepEqual(
			reopened.getWorktreeRootMappings().map((mapping) => [mapping.from, mapping.to]),
			[
				[clone, worktree],
				[worktree, clone],
			],
		);
		assert.equal(
			resolveForSession(reopened, join(worktree, "README.md"), join(clone, "notes")),
			join(clone, "README.md"),
		);
	});

	test("a resume reports each slow step as it starts it (#4660)", async () => {
		const { clone } = await editedClone();
		const restored = await recordSession(clone);
		const inPlace = await recordSession(clone);
		const id = restored.getLatestWorktreeSnapshots().get(clone)!.id.slice(0, 12);
		const steps: string[] = [];
		await prepareSessionResume(inPlace, options({ onProgress: (step) => steps.push(step) }));
		assert.deepEqual(steps, ["Checking 1 checkout against the session's snapshots"]);

		steps.length = 0;
		renameReplacing(clone, sandbox.path("away"));
		await prepareSessionResume(restored, options({ onProgress: (step) => steps.push(step) }));
		assert.deepEqual(steps, [
			"Checking 1 checkout against the session's snapshots",
			`Restoring ${clone} from snapshot ${id}`,
			"Setting up the blueprints of restored worktrees",
		]);
	});

	test("a session that returns to its original checkout still restores a sibling checkout that is missing (#4660)", async () => {
		const { clone } = await editedClone();
		const { clone: sibling } = await sandbox.remoteWithClone("sibling");
		sandbox.write(join(sibling, "sibling-work.txt"), "saved sibling work\n");
		const manager = await recordSession(clone, join(clone, "notes"), [sibling]);
		renameReplacing(clone, sandbox.path("away"));
		const first = await prepareSessionResume(manager, options());
		const worktree = manager.getWorktreeRootMappings().at(-1)!.to;
		renameReplacing(sandbox.path("away"), clone);
		sandbox.write(join(clone, "README.md"), "merged later\n");
		await sandbox.commitAll(clone, "work merged after the snapshot");
		renameReplacing(sibling, sandbox.path("sibling-gone"));

		const reopened = first.status === "ready" ? first.sessionManager : manager;
		const second = await prepareSessionResume(reopened, options());

		assert.equal(cwdOf(second), join(clone, "notes"));
		const restored = reopened.getWorktreeRootMappings().find((mapping) => mapping.from === sibling);
		assert.ok(restored, "the missing sibling checkout was not restored");
		assert.ok(restored.to.startsWith(sandbox.path("host")), restored.to);
		assert.equal(readFileSync(join(restored.to, "sibling-work.txt"), "utf8"), "saved sibling work\n");
		assert.equal(reopened.getWorktreeRootMappings().find((mapping) => mapping.from === worktree)?.to, clone);
	});

	test("a Git failure while looking for the checkout a session came from keeps it where it is, and the resume completes (#4660)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone, join(clone, "notes"));
		renameReplacing(clone, sandbox.path("away"));
		const first = await prepareSessionResume(manager, options());
		const worktree = manager.getWorktreeRootMappings().at(-1)!.to;
		rmSync(sandbox.path("away"), { recursive: true, force: true });
		writeFileSync(clone, "not a directory");

		const reopened = first.status === "ready" ? first.sessionManager : manager;
		const second = await prepareSessionResume(reopened, options());

		assert.equal(cwdOf(second), join(worktree, "notes"));
		assert.deepEqual(second.status === "ready" && second.notices, []);
	});

	test("progress counts several checkouts and skips the blueprint step when blueprints are skipped (#4660)", async () => {
		const { clone } = await editedClone();
		const { clone: second } = await sandbox.remoteWithClone("second");
		const manager = await recordSession(clone);
		const capture = await captureWorktreeSnapshot(second, {
			settings,
			blobs: manager.getSessionStore().snapshotBlobs,
		});
		assert.equal(capture.status, "captured");
		if (capture.status !== "captured") return;
		await manager.appendWorktreeSnapshot(second, capture.snapshot.id, capture.snapshot);
		const steps: string[] = [];
		await prepareSessionResume(manager, options({ onProgress: (step) => steps.push(step) }));
		assert.deepEqual(steps, ["Checking 2 checkouts against the session's snapshots"]);

		const restoring = await recordSession(clone);
		renameReplacing(clone, sandbox.path("away"));
		steps.length = 0;
		await prepareSessionResume(restoring, options({ blueprints: "skip", onProgress: (step) => steps.push(step) }));
		assert.equal(steps.length, 2);
		assert.match(steps[1] ?? "", /^Restoring /);
	});

	test("a session in a restored worktree whose latest snapshot is a later one stays there (#4660)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		renameReplacing(clone, sandbox.path("away"));
		const first = await prepareSessionResume(manager, options());
		const worktree = manager.getWorktreeRootMappings().at(-1)!.to;
		renameReplacing(sandbox.path("away"), clone);
		const reopened = first.status === "ready" ? first.sessionManager : manager;
		const current = reopened.getLatestWorktreeSnapshots().get(worktree)!;
		await reopened.appendWorktreeSnapshot(worktree, "abcdef012345", { ...current, id: "abcdef012345" });

		const second = await prepareSessionResume(reopened, options());

		assert.equal(cwdOf(second), worktree);
	});

	/** A Git that fails the commands matching the shell `pattern` with exit status 2 only when it runs in `dir`; otherwise the real Git. */
	function gitFailingCommandIn(dir: string, pattern: string): string {
		const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
		const shim = sandbox.path("failing-git-4660");
		writeFileSync(
			shim,
			`#!/bin/sh\ncase "$(pwd -P):$*" in "${realpathSync(dir)}":*${pattern}*) echo "simulated failure" >&2; exit 2;; esac\nexec "${realGit}" "$@"\n`,
		);
		chmodSync(shim, 0o755);
		return shim;
	}

	test.skipIf(process.platform === "win32")(
		"when looking for the session's own checkout throws, the session stays in it and nothing is restored (#4660)",
		async () => {
			const { clone } = await editedClone();
			const manager = await recordSession(clone, join(clone, "notes"));
			sandbox.write(join(clone, "README.md"), "changed after the snapshot\n");
			const shim = gitFailingCommandIn(clone, "cat-file*^{commit}");
			setWorktreeSnapshotGit(async () => ({ path: shim, env: {} }));

			const prepared = await prepareSessionResume(manager, options());

			assert.equal(cwdOf(prepared), join(clone, "notes"));
			assert.deepEqual(prepared.status === "ready" && prepared.notices, []);
			assert.equal(existsSync(sandbox.path("host")), false);
			assert.deepEqual(manager.getWorktreeRootMappings(), []);
		},
	);

	test.skipIf(process.platform === "win32")(
		"when examining the checkout a session came from throws, the session still goes back to it (#4660)",
		async () => {
			const { clone } = await editedClone();
			const manager = await recordSession(clone, join(clone, "notes"));
			renameReplacing(clone, sandbox.path("away"));
			const first = await prepareSessionResume(manager, options());
			const worktree = manager.getWorktreeRootMappings().at(-1)!.to;
			renameReplacing(sandbox.path("away"), clone);
			const shim = gitFailingCommandIn(clone, "cat-file*^{commit}");
			setWorktreeSnapshotGit(async () => ({ path: shim, env: {} }));

			const reopened = first.status === "ready" ? first.sessionManager : manager;
			const second = await prepareSessionResume(reopened, options());

			assert.equal(cwdOf(second), join(clone, "notes"));
			assert.deepEqual(second.status === "ready" && second.notices, [
				{
					type: "info",
					message: `Resuming in ${clone}, the checkout this session was restored from, instead of the worktree ${worktree}.`,
				},
			]);
		},
	);

	test("a session that worked in its restored worktree stays there (#4660)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		renameReplacing(clone, sandbox.path("away"));
		const first = await prepareSessionResume(manager, options());
		const worktree = manager.getWorktreeRootMappings().at(-1)!.to;
		renameReplacing(sandbox.path("away"), clone);
		sandbox.write(join(worktree, "README.md"), "the session's own work\n");

		const reopened = first.status === "ready" ? first.sessionManager : manager;
		const second = await prepareSessionResume(reopened, options());

		assert.equal(cwdOf(second), worktree);
		assert.equal(readFileSync(join(worktree, "README.md"), "utf8"), "the session's own work\n");
	});

	test("a restored worktree is kept when the checkout it came from is another clone (#4660)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		renameReplacing(clone, sandbox.path("away"));
		const first = await prepareSessionResume(manager, options());
		const worktree = manager.getWorktreeRootMappings().at(-1)!.to;
		await sandbox.git(sandbox.root, "clone", "-q", sandbox.path("repo.git"), clone);

		const reopened = first.status === "ready" ? first.sessionManager : manager;
		const second = await prepareSessionResume(reopened, options());

		assert.equal(cwdOf(second), worktree);
	});

	test("a repository with no blueprint and no setup command is restored, recorded and kept (#4588)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		renameReplacing(clone, sandbox.path("gone"));
		const trustedPaths: string[] = [];

		const prepared = await prepareSessionResume(
			manager,
			options({
				blueprint: setupBlueprint({
					setupCommand: undefined,
					trusted: (path) => {
						trustedPaths.push(path);
						return true;
					},
				}),
			}),
		);

		const mappings = manager.getWorktreeRootMappings();
		assert.deepEqual(
			mappings.map((mapping) => resolve(mapping.from)),
			[clone],
		);
		assert.deepEqual(trustedPaths, [mappings[0]!.to]);
		assert.ok(mappings[0]!.to.startsWith(hostWorktrees()), mappings[0]!.to);
		assert.equal(cwdOf(prepared), mappings[0]!.to);
		assert.equal(readdirSync(hostWorktrees()).length, 1);
		assert.deepEqual(prepared.status === "ready" && prepared.notices.map((notice) => notice.type), ["info"]);
	});

	test("a failing setup command keeps the restored worktree and warns; the next resume builds it again (#4588)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		renameReplacing(clone, sandbox.path("gone"));

		const failed = await prepareSessionResume(
			manager,
			options({ blueprint: setupBlueprint({ setupCommand: nodeCommand("console.log('broken');process.exit(3)") }) }),
		);

		assert.equal(failed.status, "ready");
		if (failed.status !== "ready") return;
		const restored = manager.getWorktreeRootMappings().at(-1)!.to;
		assert.equal(cwdOf(failed), restored);
		assert.ok(existsSync(restored));
		assert.equal(readFileSync(join(restored, "README.md"), "utf8"), "edited\n");
		assert.equal(failed.notices[0]?.type, "info");
		assert.ok(failed.blueprintNotices.length > 0);
		assert.ok(failed.blueprintNotices.every((notice) => notice.type === "warning"));
		assert.deepEqual(failed.notices.slice(1), failed.blueprintNotices);

		const fixed = await prepareSessionResume(manager, options());

		assert.equal(cwdOf(fixed), restored);
		assert.equal(manager.getWorktreeRootMappings().length, 1);
		assert.equal(setupRuns(), 1);

		await prepareSessionResume(manager, options());
		assert.equal(setupRuns(), 1);
	});

	test("a setup command stopped before it finished runs again on the next resume", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		renameReplacing(clone, sandbox.path("gone"));
		const controller = new AbortController();
		const started = sandbox.path("setup-started");
		const pending = prepareSessionResume(
			manager,
			options({
				signal: controller.signal,
				blueprint: setupBlueprint({ setupCommand: startedSleepingCommand(started) }),
			}),
		);
		// Stopped once it runs: on Windows a tree kill that lands while Git Bash is still starting it can miss it.
		for (let waited = 0; !existsSync(started); waited += 50) {
			if (waited > 20_000) assert.fail("the setup command never started");
			await new Promise((resolveWait) => setTimeout(resolveWait, 50));
		}
		controller.abort(new Error("stop"));
		await assert.rejects(pending, /stop/);

		const prepared = await prepareSessionResume(manager, options());

		assert.ok(cwdOf(prepared)?.startsWith(hostWorktrees()), cwdOf(prepared));
		assert.equal(setupRuns(), 1);
	});

	test("a worktree an earlier resume restored and built is not built again after the session changes its files", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		renameReplacing(clone, sandbox.path("gone"));
		const first = await prepareSessionResume(manager, options());
		if (first.status !== "ready") throw new Error(first.status);
		const restored = cwdOf(first)!;
		assert.equal(setupRuns(), 1);
		sandbox.write(join(restored, "package-lock.json"), '{ "changed": true }\n');
		const capture = await captureWorktreeSnapshot(restored, {
			settings,
			blobs: first.sessionManager.getSessionStore().snapshotBlobs,
		});
		if (capture.status !== "captured") throw new Error(capture.status);
		await first.sessionManager.appendWorktreeSnapshot(restored, capture.snapshot.id, capture.snapshot);

		const prepared = await prepareSessionResume(first.sessionManager, options());

		assert.equal(cwdOf(prepared), restored);
		assert.equal(setupRuns(), 1);
	});
});

describe("whether a checkout holds a snapshot's commit (#4329)", () => {
	test("the recorded checkout does; a node without Git does not; a cancelled check rejects", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		const snapshot = manager.getLatestWorktreeSnapshots().get(clone)!;
		assert.equal(await holdsSnapshotCommit(snapshot, clone), true);
		const cancelled = new AbortController();
		cancelled.abort(new Error("cancelled"));
		await assert.rejects(holdsSnapshotCommit(snapshot, clone, cancelled.signal), /cancelled/);

		setWorktreeSnapshotGit(async () => ({ path: sandbox.path("no-git"), env: {} }));

		assert.equal(await holdsSnapshotCommit(snapshot, clone), false);
	});
});

describe("resume failure presentation (#4329)", () => {
	test("a snapshot record with a credentialed remote refuses the resume, naming the field and the remedy (#4733)", async () => {
		const { resumeFailureMessage } = await import("../src/core/resume/failure.ts");
		const { clone } = await sandbox.remoteWithClone();
		const manager = await recordSession(clone);
		const recorded = manager.getLatestWorktreeSnapshots().get(clone)!;
		const unsafe = { ...recorded, remotes: ["https://user:token@example.invalid/repo.git"] };
		await manager.appendWorktreeSnapshot(clone, unsafe.id, unsafe);
		renameReplacing(clone, sandbox.path("gone"));
		const error = await prepareSessionResume(manager, options()).then(
			() => assert.fail("the resume must be refused"),
			(failure: Error) => failure,
		);
		assert.ok(isWorkspaceRestoreError(error), String(error));
		assert.deepEqual([error.code, error.reason, error.field], ["invalid-snapshot", "unsafe-remote", "remotes[0]"]);
		assert.doesNotMatch(error.message, /token/);
		assert.equal(resumeFailureMessage(error), error.message);
		assert.equal(resumeFailureMessage(new TypeError("bug")), undefined);
		assert.deepEqual(manager.getWorktreeRootMappings(), []);
	});

	test("typed resume, workspace and Git failures are shown with their own message; anything else is not one", async () => {
		const { isResumeFailure, resumeFailureMessage } = await import("../src/core/resume/failure.ts");
		const precondition = new ResumePreconditionError({
			entryPoint: "cli",
			problems: [{ code: "git-unavailable", subject: "git", why: "w", fix: "f" }],
		});
		const drift = new WorkspaceDriftError({
			root: "/r",
			expectedHead: "h",
			actualHead: null,
			expectedTree: "t",
			actualTree: null,
			snapshotId: "s",
		});
		const git = missingGit();
		for (const failure of [precondition, drift, git]) {
			assert.ok(isResumeFailure(failure));
			assert.equal(resumeFailureMessage(failure), failure.message);
		}
		assert.equal(isResumeFailure(new Error("x")), false);
	});
});
