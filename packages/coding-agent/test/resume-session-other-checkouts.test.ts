import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, test } from "vitest";
import { renameReplacing } from "../src/core/rename-retry.js";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.js";
import {
	type DirtyCheckoutPrompt,
	isWorkspaceGitError,
	prepareSessionResume,
	setWorktreeSnapshotGit,
} from "../src/index.js";
import { nodeCommand, startedSleepingCommand } from "./helpers/hook-commands.js";
import { missingGit } from "./helpers/missing-git.js";
import {
	CountingGitIo,
	cleanups,
	cwdOf,
	editedClone,
	nestedCheckouts,
	options,
	recordNestedSession,
	recordOtherCheckout,
	recordSession,
	resolveForSession,
	restoredWorktrees,
	sandbox,
	settings,
	setupBlueprint,
	setupRuns,
	useResumeSessionSandbox,
	warningsNaming,
	warningsOf,
	withoutDeprecation,
} from "./helpers/resume-session-fixture.js";

useResumeSessionSandbox();

describe("prepareSessionResume for a session that recorded two checkouts (#4329)", () => {
	/** A session whose cwd's checkout is `first` and that also recorded a second repository with a Cargo lockfile. */
	async function twoCheckoutSession(first: string) {
		const { clone: second } = await sandbox.remoteWithClone("second", {
			"README.md": "second\n",
			"Cargo.lock": "# lock\n",
		});
		sandbox.write(join(second, "README.md"), "edited in the second repository\n");
		const manager = await recordSession(first);
		const capture = await captureWorktreeSnapshot(second, {
			settings,
			blobs: manager.getSessionStore().snapshotBlobs,
		});
		if (capture.status !== "captured") throw new Error(capture.status);
		await manager.appendWorktreeSnapshot(second, capture.snapshot.id, capture.snapshot);
		return { second, manager };
	}

	test("every checkout a resume restores gets its setup command", async () => {
		const { clone } = await editedClone();
		const { second, manager } = await twoCheckoutSession(clone);
		renameReplacing(clone, sandbox.path("first-gone"));
		renameReplacing(second, sandbox.path("second-gone"));

		const prepared = await prepareSessionResume(manager, options());

		assert.equal(prepared.status, "ready");
		const mappings = manager.getWorktreeRootMappings();
		assert.deepEqual(mappings.map((mapping) => resolve(mapping.from)).sort(), [clone, second].sort());
		assert.ok(mappings.every((mapping) => mapping.to.startsWith(sandbox.path("host"))));
		assert.equal(setupRuns(), 2);
	});

	test("a checkout kept in place is neither verified nor restored after it changed, while its missing sibling is (#4329)", async () => {
		const { clone } = await editedClone();
		const { second, manager } = await twoCheckoutSession(clone);
		sandbox.write(join(clone, "README.md"), "changed after the release\n");
		renameReplacing(second, sandbox.path("second-gone"));
		const prompts: DirtyCheckoutPrompt[] = [];

		const prepared = await prepareSessionResume(
			manager,
			options({
				launchCwd: clone,
				keepInPlace: new Set([clone]),
				chooseDirtyCheckout: async (prompt) => {
					prompts.push(prompt);
					return "cancel";
				},
			}),
		);

		assert.equal(cwdOf(prepared), clone);
		assert.deepEqual(prompts, []);
		assert.deepEqual(
			manager.getWorktreeRootMappings().map((mapping) => resolve(mapping.from)),
			[second],
		);
		assert.equal(readFileSync(join(clone, "README.md"), "utf8"), "changed after the release\n");
		assert.equal(setupRuns(), 1);
	});

	test("a setup command that fails in every restored checkout keeps both worktrees and warns (#4588)", async () => {
		const { clone } = await editedClone();
		const { second, manager } = await twoCheckoutSession(clone);
		renameReplacing(clone, sandbox.path("first-gone"));
		renameReplacing(second, sandbox.path("second-gone"));

		const prepared = await prepareSessionResume(
			manager,
			options({ blueprint: setupBlueprint({ setupCommand: nodeCommand("process.exit(3)") }) }),
		);

		assert.equal(prepared.status, "ready");
		if (prepared.status !== "ready") return;
		const mappings = manager.getWorktreeRootMappings();
		assert.deepEqual(mappings.map((mapping) => resolve(mapping.from)).sort(), [clone, second].sort());
		for (const mapping of mappings) assert.ok(existsSync(mapping.to), mapping.to);
		assert.equal(readdirSync(sandbox.path("host", "worktrees")).length, 2);
		assert.ok(prepared.blueprintNotices.length > 0);
		assert.ok(prepared.blueprintNotices.every((notice) => notice.type === "warning"));
	});

	test("without Git a matching checkout here is not verified, and the resume continues in it without restoring either checkout (#4733)", async () => {
		const { clone } = await editedClone();
		const { second, manager } = await twoCheckoutSession(clone);
		const checkout = sandbox.path("node-b", "repo");
		mkdirSync(sandbox.path("node-b"));
		renameReplacing(clone, checkout);
		renameReplacing(second, sandbox.path("second-gone"));
		setWorktreeSnapshotGit(async () => ({ path: sandbox.path("no-git"), env: {} }));

		const prepared = await prepareSessionResume(
			manager,
			options({ launchCwd: checkout, io: new CountingGitIo(missingGit()) }),
		);

		assert.equal(cwdOf(prepared), checkout);
		assert.deepEqual(manager.getWorktreeRootMappings(), []);
		assert.equal(existsSync(sandbox.path("host", "worktrees")), false);
		assert.equal(warningsNaming(prepared, clone).length, 1, warningsOf(prepared).join("\n"));
		assert.equal(warningsNaming(prepared, second).length, 1, warningsOf(prepared).join("\n"));
	});

	test("continuing in a matching checkout restores another checkout whose history is denied at its closest commit (#4733)", async () => {
		const { clone } = await editedClone();
		const { clone: keyed } = await sandbox.remoteWithClone("keyed", { "README.md": "keyed\n" });
		sandbox.write(join(keyed, "deploy.key"), "PRIVATE\n");
		await sandbox.commitAll(keyed, "unpushed key");
		const manager = await recordSession(clone);
		const capture = await captureWorktreeSnapshot(keyed, {
			settings,
			blobs: manager.getSessionStore().snapshotBlobs,
		});
		if (capture.status !== "captured") throw new Error(capture.status);
		await manager.appendWorktreeSnapshot(keyed, capture.snapshot.id, capture.snapshot);
		const checkout = sandbox.path("node-b", "repo");
		mkdirSync(sandbox.path("node-b"));
		renameReplacing(clone, checkout);
		renameReplacing(keyed, sandbox.path("keyed-gone"));

		const prepared = await prepareSessionResume(manager, options({ launchCwd: checkout }));

		assert.equal(cwdOf(prepared), checkout);
		const mappings = manager.getWorktreeRootMappings();
		assert.deepEqual(
			mappings.map((mapping) => resolve(mapping.from)),
			[clone, keyed],
		);
		assert.equal(mappings[1]?.degraded?.stage, "closest-commit");
		assert.equal(existsSync(join(mappings[1]!.to, "deploy.key")), false);
		const warnings =
			prepared.status === "ready" ? prepared.notices.filter((notice) => notice.type === "warning") : [];
		assert.equal(warnings.filter((notice) => notice.message.includes(keyed)).length, 1);
	});

	test("a matching checkout of the first repository is used and the second repository is still restored", async () => {
		const { clone } = await editedClone();
		const { second, manager } = await twoCheckoutSession(clone);
		const checkout = sandbox.path("node-b", "repo");
		mkdirSync(sandbox.path("node-b"));
		renameReplacing(clone, checkout);
		renameReplacing(second, sandbox.path("second-gone"));

		const prepared = await prepareSessionResume(manager, options({ launchCwd: checkout }));

		assert.equal(cwdOf(prepared), checkout);
		const mappings = manager.getWorktreeRootMappings();
		assert.deepEqual(
			mappings.map((mapping) => resolve(mapping.from)),
			[clone, second],
		);
		assert.equal(resolve(mappings[0]!.to), checkout);
		const restoredSecond = mappings[1]!.to;
		assert.ok(restoredSecond.startsWith(sandbox.path("host")), restoredSecond);
		assert.equal(
			readFileSync(resolveForSession(manager, join(second, "README.md"), checkout), "utf8"),
			"edited in the second repository\n",
		);
		assert.equal(setupRuns(), 1);
		const messages = prepared.status === "ready" ? prepared.notices.map((notice) => notice.message) : [];
		assert.equal(
			messages.filter((message) => message.includes(checkout) && message.startsWith("Restored")).length,
			0,
		);
		assert.ok(messages.some((message) => message.startsWith(`Resuming in ${checkout}, which matches`)));
	});

	test("continuing in a differing checkout by choice restores nothing else and says which checkouts were left out", async () => {
		const { clone } = await editedClone();
		const { second, manager } = await twoCheckoutSession(clone);
		const checkout = sandbox.path("node-b", "repo");
		mkdirSync(sandbox.path("node-b"));
		renameReplacing(clone, checkout);
		sandbox.write(join(checkout, "README.md"), "user edit\n");
		renameReplacing(second, sandbox.path("second-gone"));

		const prepared = await prepareSessionResume(
			manager,
			options({ launchCwd: checkout, chooseDirtyCheckout: async () => "use" }),
		);

		assert.equal(cwdOf(prepared), checkout);
		assert.deepEqual(
			manager.getWorktreeRootMappings().map((mapping) => resolve(mapping.to)),
			[checkout],
		);
		assert.equal(existsSync(sandbox.path("host")), false);
		const warnings =
			prepared.status === "ready" ? prepared.notices.filter((notice) => notice.type === "warning") : [];
		assert.deepEqual(
			warnings.map((notice) => notice.message),
			[
				`Resuming in ${checkout}, which differs from snapshot ${manager.getLatestWorktreeSnapshots().get(clone)!.id.slice(0, 12)} of ${clone}`,
				`Continuing without restoring ${second} (snapshot ${manager.getLatestWorktreeSnapshots().get(second)!.id.slice(0, 12)}): it does not exist on this node, and the session continues in the checkout you chose, which restores nothing else`,
			],
		);
	});

	test("continuing in a differing checkout by choice warns about nothing else when the other checkout is here", async () => {
		const { clone } = await editedClone();
		const { manager } = await twoCheckoutSession(clone);
		const checkout = sandbox.path("node-b", "repo");
		mkdirSync(sandbox.path("node-b"));
		renameReplacing(clone, checkout);
		sandbox.write(join(checkout, "README.md"), "user edit\n");

		const prepared = await prepareSessionResume(
			manager,
			options({ launchCwd: checkout, chooseDirtyCheckout: async () => "use" }),
		);

		assert.equal(cwdOf(prepared), checkout);
		assert.deepEqual(prepared.status === "ready" ? prepared.notices.map((notice) => notice.type) : [], ["warning"]);
	});

	test("a missing Git leaves out every checkout the resume would restore, with one notice each (#4733)", async () => {
		const { clone } = await editedClone();
		const { second, manager } = await twoCheckoutSession(clone);
		renameReplacing(clone, sandbox.path("first-gone"));
		renameReplacing(second, sandbox.path("second-gone"));
		const snapshots = manager.getLatestWorktreeSnapshots();
		const io = new CountingGitIo(missingGit());

		const prepared = await prepareSessionResume(manager, options({ io }));

		assert.equal(cwdOf(prepared), sandbox.root);
		for (const root of [clone, second]) {
			const named = warningsNaming(prepared, root);
			assert.equal(named.length, 1, warningsOf(prepared).join("\n"));
			assert.ok(named[0]!.includes(snapshots.get(root)!.id.slice(0, 12)), named[0]);
		}
	});
});

describe("prepareSessionResume when a checkout other than the current one needs a restore (#4584)", () => {
	test("an unchanged current checkout resumes when another recorded checkout is gone and Git is unavailable (#4584)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		const second = await recordOtherCheckout(manager, "second");
		renameReplacing(second, sandbox.path("second-gone"));

		const prepared = await prepareSessionResume(
			manager,
			options({ launchCwd: clone, io: new CountingGitIo(missingGit()) }),
		);

		assert.equal(prepared.status, "ready");
		assert.equal(prepared.status === "ready" ? prepared.sessionManager : undefined, manager);
		assert.equal(cwdOf(prepared), clone);
		assert.deepEqual(manager.getWorktreeRootMappings(), []);
		assert.equal(existsSync(sandbox.path("host")), false);
		assert.equal(setupRuns(), 0);
		const warnings = warningsNaming(prepared, second);
		assert.equal(warnings.length, 1, warningsOf(prepared).join("\n"));
		assert.equal(warningsOf(prepared).length, 1);
		assert.ok(warnings[0]!.includes(manager.getLatestWorktreeSnapshots().get(second)!.id.slice(0, 12)), warnings[0]);
		assert.match(warnings[0]!, /does not exist on this node/);
		assert.match(warnings[0]!, /Git is unavailable here \(not-installed\)/);
	});

	test("an unchanged current checkout resumes when another recorded checkout changed since its snapshot, leaving it as it is (#4584)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		const second = await recordOtherCheckout(manager, "second");
		sandbox.write(join(second, "README.md"), "changed after the snapshot\n");

		const prepared = await prepareSessionResume(manager, options({ launchCwd: clone }));

		assert.equal(cwdOf(prepared), clone);
		assert.deepEqual(manager.getWorktreeRootMappings(), []);
		assert.equal(existsSync(sandbox.path("host")), false);
		assert.equal(setupRuns(), 0);
		assert.equal(readFileSync(join(second, "README.md"), "utf8"), "changed after the snapshot\n");
		assert.equal(warningsOf(prepared).length, 1);
		assert.equal(warningsNaming(prepared, second).length, 1);
		assert.match(warningsOf(prepared)[0]!, /changed since/);
	});

	test("sibling git worktrees that were changed or removed after quitting never refuse the resume (#4584)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		const siblings = [sandbox.path("repo-slice-changed"), sandbox.path("repo-slice-removed")];
		for (const [index, sibling] of siblings.entries()) {
			await sandbox.git(clone, "worktree", "add", "-q", "-b", `slice-${index}`, sibling);
			sandbox.write(join(sibling, "slice.txt"), `slice ${index}\n`);
			const capture = await captureWorktreeSnapshot(sibling, {
				settings,
				blobs: manager.getSessionStore().snapshotBlobs,
			});
			if (capture.status !== "captured") throw new Error(capture.status);
			await manager.appendWorktreeSnapshot(sibling, capture.snapshot.id, capture.snapshot);
		}
		sandbox.write(join(siblings[0]!, "slice.txt"), "changed after quitting\n");
		await sandbox.git(clone, "worktree", "remove", "--force", siblings[1]!);

		const prepared = await prepareSessionResume(
			manager,
			options({ launchCwd: clone, io: new CountingGitIo(missingGit()) }),
		);

		assert.equal(cwdOf(prepared), clone);
		assert.deepEqual(manager.getWorktreeRootMappings(), []);
		assert.equal(setupRuns(), 0);
		assert.equal(readFileSync(join(siblings[0]!, "slice.txt"), "utf8"), "changed after quitting\n");
		assert.deepEqual(
			siblings.map((sibling) => warningsNaming(prepared, sibling).length),
			[1, 1],
		);
		assert.equal(warningsOf(prepared).length, 2);
	});

	test("every other checkout that cannot be restored is named once in the warnings (#4584)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		const removed = await recordOtherCheckout(manager, "removed");
		const alsoRemoved = await recordOtherCheckout(manager, "also-removed");
		const changed = await recordOtherCheckout(manager, "changed");
		renameReplacing(removed, sandbox.path("removed-gone"));
		renameReplacing(alsoRemoved, sandbox.path("also-removed-gone"));
		sandbox.write(join(changed, "README.md"), "changed after the snapshot\n");

		const prepared = await prepareSessionResume(
			manager,
			options({ launchCwd: clone, io: new CountingGitIo(missingGit()) }),
		);

		assert.equal(cwdOf(prepared), clone);
		assert.deepEqual(
			[removed, alsoRemoved, changed].map((root) => warningsNaming(prepared, root).length),
			[1, 1, 1],
		);
		assert.equal(warningsOf(prepared).length, 3);
		assert.equal(setupRuns(), 0);
	});

	test("a checkout the session runs in that cannot be restored without Git is recorded as left out, and the resume goes on (#4733)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		const second = await recordOtherCheckout(manager, "second");
		renameReplacing(clone, sandbox.path("first-gone"));
		renameReplacing(second, sandbox.path("second-gone"));
		const io = new CountingGitIo(missingGit());

		const prepared = await prepareSessionResume(manager, options({ io }));

		assert.equal(prepared.status, "ready");
		assert.equal(io.probes, 1);
		assert.deepEqual(manager.getWorktreeRootMappings(), []);
		assert.equal(existsSync(sandbox.path("host")), false);
		const left = manager
			.getBranch()
			.flatMap((entry) =>
				entry.type === "worktree_snapshot" && entry.unrestored ? [[entry.root, entry.unrestored.cause]] : [],
			);
		assert.deepEqual(left, [[clone, "not-installed"]]);
		assert.equal(warningsNaming(prepared, second).length, 1);
	});

	test("a failing setup command in the checkout the session runs in resumes with a warning and is not a refusal (#4588)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		const second = await recordOtherCheckout(manager, "second");
		renameReplacing(clone, sandbox.path("first-gone"));
		renameReplacing(second, sandbox.path("second-gone"));

		const prepared = await prepareSessionResume(
			manager,
			options({ blueprint: setupBlueprint({ setupCommand: nodeCommand("process.exit(3)") }) }),
		);

		assert.ok(cwdOf(prepared)?.startsWith(sandbox.path("host", "worktrees")), cwdOf(prepared));
		assert.deepEqual(
			manager.getWorktreeRootMappings().map((mapping) => resolve(mapping.from)),
			[clone, second],
		);
		assert.equal(restoredWorktrees().length, 2);
		assert.ok(warningsOf(prepared).some((message) => !message.startsWith("Continuing without restoring")));
		assert.deepEqual(
			warningsOf(prepared).filter((message) => message.startsWith("Continuing without restoring")),
			[],
		);
	});

	test("a session that works outside every recorded checkout has no checkout whose restore can refuse the resume (#4584)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone, sandbox.root);
		renameReplacing(clone, sandbox.path("first-gone"));

		const prepared = await prepareSessionResume(manager, options({ io: new CountingGitIo(missingGit()) }));

		assert.equal(cwdOf(prepared), sandbox.root);
		assert.deepEqual(manager.getWorktreeRootMappings(), []);
		assert.equal(warningsNaming(prepared, clone).length, 1);
	});

	test("another checkout restored for a repository without a blueprint or setup command is kept without a warning (#4588)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		const second = await recordOtherCheckout(manager, "second");
		renameReplacing(second, sandbox.path("second-gone"));

		const prepared = await prepareSessionResume(
			manager,
			options({ launchCwd: clone, blueprint: { agentDir: sandbox.path("agent"), trusted: () => true } }),
		);

		assert.equal(cwdOf(prepared), clone);
		assert.deepEqual(
			manager.getWorktreeRootMappings().map((mapping) => resolve(mapping.from)),
			[second],
		);
		assert.equal(restoredWorktrees().length, 1);
		assert.deepEqual(warningsOf(prepared), []);
	});

	test("another checkout whose history is denied is restored at its closest commit with one notice, and the resume goes on (#4733)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		const { clone: keyed } = await sandbox.remoteWithClone("keyed", { "README.md": "keyed\n" });
		sandbox.write(join(keyed, "deploy.key"), "PRIVATE\n");
		const denied = await sandbox.commitAll(keyed, "unpushed key");
		const capture = await captureWorktreeSnapshot(keyed, {
			settings,
			blobs: manager.getSessionStore().snapshotBlobs,
		});
		if (capture.status !== "captured") throw new Error(capture.status);
		await manager.appendWorktreeSnapshot(keyed, capture.snapshot.id, capture.snapshot);
		renameReplacing(keyed, sandbox.path("keyed-gone"));

		const prepared = await prepareSessionResume(manager, options({ launchCwd: clone }));

		assert.equal(cwdOf(prepared), clone);
		const mappings = manager.getWorktreeRootMappings();
		assert.deepEqual(
			mappings.map((mapping) => resolve(mapping.from)),
			[keyed],
		);
		assert.deepEqual(mappings[0]?.degraded?.missingCommits, [denied]);
		assert.equal(restoredWorktrees().length, 1);
		const warnings = warningsNaming(prepared, keyed);
		assert.equal(warnings.length, 1, warningsOf(prepared).join("\n"));
		assert.match(warnings[0]!, /the closest commit available here/);
		assert.doesNotMatch(warnings[0]!, /fail/i);
	});

	test("a setup command that fails in a restored checkout other than the current one is a warning, the worktree is kept, and the next resume runs it again (#4588)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		const second = await recordOtherCheckout(manager, "second");
		renameReplacing(second, sandbox.path("second-gone"));

		const prepared = await prepareSessionResume(
			manager,
			options({ launchCwd: clone, blueprint: setupBlueprint({ setupCommand: nodeCommand("process.exit(3)") }) }),
		);

		assert.equal(cwdOf(prepared), clone);
		const mappings = manager.getWorktreeRootMappings();
		assert.deepEqual(
			mappings.map((mapping) => resolve(mapping.from)),
			[second],
		);
		assert.ok(existsSync(mappings[0]!.to));
		assert.equal(restoredWorktrees().length, 1);
		assert.deepEqual(
			warningsOf(prepared).filter((message) => message.startsWith("Continuing without restoring")),
			[],
		);
		assert.ok(withoutDeprecation(warningsOf(prepared)).length > 0, warningsOf(prepared).join("\n"));

		const again = await prepareSessionResume(manager, options({ launchCwd: clone }));

		assert.equal(cwdOf(again), clone);
		assert.equal(setupRuns(), 1);
		assert.deepEqual(withoutDeprecation(warningsOf(again)), []);
	});

	test("another clone at the recorded path of another checkout is restored into a fresh worktree, not left out, when Git is available (#4588)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		const second = await recordOtherCheckout(manager, "second");
		renameReplacing(second, sandbox.path("second-original"));
		await sandbox.git(sandbox.root, "clone", "-q", sandbox.path("second.git"), second);

		const prepared = await prepareSessionResume(manager, options({ launchCwd: clone }));

		assert.equal(cwdOf(prepared), clone);
		assert.deepEqual(
			manager.getWorktreeRootMappings().map((mapping) => resolve(mapping.from)),
			[second],
		);
		assert.equal(readFileSync(join(second, "README.md"), "utf8"), "second\n");
		assert.equal(warningsNaming(prepared, second).filter((m) => m.startsWith("Continuing without")).length, 0);
	});

	test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"another checkout that Git fails to compare is skipped with its typed failure named (#4584)",
		async () => {
			const { clone } = await editedClone();
			const manager = await recordSession(clone);
			const second = await recordOtherCheckout(manager, "second");
			sandbox.write(join(second, "README.md"), "changed after the snapshot\n");
			chmodSync(join(second, "README.md"), 0o000);
			cleanups.push(() => chmodSync(join(second, "README.md"), 0o644));

			const prepared = await prepareSessionResume(manager, options({ launchCwd: clone }));

			assert.equal(cwdOf(prepared), clone);
			assert.deepEqual(manager.getWorktreeRootMappings(), []);
			const warnings = warningsNaming(prepared, second);
			assert.equal(warnings.length, 1, warningsOf(prepared).join("\n"));
			assert.match(warnings[0]!, /could not be compared with the snapshot/);
			assert.match(warnings[0]!, /\(git-failed\)/);
		},
	);
});

describe("prepareSessionResume cases the other-checkout planning leaves as they are", () => {
	test("a local resume right after quitting needs no Git, no blueprint build and shows no warning", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		await recordOtherCheckout(manager, "second");
		const io = new CountingGitIo();

		const prepared = await prepareSessionResume(manager, options({ io, launchCwd: clone }));

		assert.equal(cwdOf(prepared), clone);
		assert.equal(io.probes, 0);
		assert.equal(setupRuns(), 0);
		assert.equal(existsSync(sandbox.path("host")), false);
		assert.deepEqual(manager.getWorktreeRootMappings(), []);
		assert.deepEqual(prepared.status === "ready" ? prepared.notices : undefined, []);
	});

	test("cancelling while another checkout is restored rejects with the reason instead of skipping it", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		const second = await recordOtherCheckout(manager, "second");
		renameReplacing(second, sandbox.path("second-gone"));
		const controller = new AbortController();
		const started = sandbox.path("setup-started");
		const pending = prepareSessionResume(
			manager,
			options({
				launchCwd: clone,
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
	});

	test("a setting that is wrong for every checkout stops the resume also when only another checkout is compared", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		const second = await recordOtherCheckout(manager, "second");
		sandbox.write(join(second, "README.md"), "changed after the snapshot\n");

		await assert.rejects(
			prepareSessionResume(
				manager,
				options({ keepInPlace: new Set([clone]), settings: { ...settings, maxFileBytes: -1 } }),
			),
			(error: unknown) => (error as { name?: string }).name === "WorkspaceConfigError",
		);
	});

	test("a failure that is not a typed one is never read as a problem of another checkout", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		const second = await recordOtherCheckout(manager, "second");
		sandbox.write(join(second, "README.md"), "changed after the snapshot\n");
		const bug = new TypeError("not a typed failure");
		setWorktreeSnapshotGit(async () => {
			throw bug;
		});

		await assert.rejects(
			prepareSessionResume(manager, options({ keepInPlace: new Set([clone]) })),
			(error: unknown) => error === bug,
		);
	});

	test("cancelling while another checkout is compared rejects with the signal's reason, even when it is a typed failure", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		const second = await recordOtherCheckout(manager, "second");
		sandbox.write(join(second, "README.md"), "changed after the snapshot\n");
		const reason = missingGit();
		const controller = new AbortController();
		setWorktreeSnapshotGit(async () => {
			controller.abort(reason);
			throw reason;
		});

		await assert.rejects(
			prepareSessionResume(manager, options({ keepInPlace: new Set([clone]), signal: controller.signal })),
			(error: unknown) => error === reason,
		);
	});

	test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"a checkout containing the session's directory that Git fails to compare refuses the resume",
		async () => {
			const { outer, inner } = await nestedCheckouts({ "README.md": "outer\n" }, { "README.md": "inner\n" });
			const manager = await recordNestedSession(outer, inner);
			chmodSync(join(outer, "README.md"), 0o000);
			cleanups.push(() => chmodSync(join(outer, "README.md"), 0o644));

			await assert.rejects(prepareSessionResume(manager, options()), (error: unknown) => isWorkspaceGitError(error));
			assert.deepEqual(manager.getWorktreeRootMappings(), []);
		},
	);
});
