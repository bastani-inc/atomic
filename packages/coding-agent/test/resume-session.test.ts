import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "vitest";
import { gitConfigPath } from "../../../test/helpers/worktree-snapshot.js";
import { renameReplacing } from "../src/core/rename-retry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.js";
import type { WorktreeRootMapping, WorktreeSnapshot } from "../src/core/worktree-snapshot/types.js";
import {
	type DirtyCheckoutChoice,
	type DirtyCheckoutPrompt,
	GitProvisionTimeoutError,
	GitUnavailableError,
	isWorkspaceGitError,
	prepareSessionResume,
	setWorktreeSnapshotGit,
} from "../src/index.js";
import { missingGit } from "./helpers/missing-git.js";
import {
	assertUnreadable,
	CountingGitIo,
	cleanups,
	cwdOf,
	editedClone,
	options,
	recordSession,
	resolveForSession,
	sandbox,
	settings,
	setupBlueprint,
	setupRuns,
	sqlStore,
	useResumeSessionSandbox,
} from "./helpers/resume-session-fixture.js";

useResumeSessionSandbox();

describe("prepareSessionResume on a node without the recorded checkout (#4329)", () => {
	test("restores a byte-identical fresh worktree, runs the setup command once and maps old-root tool paths", async () => {
		const { clone, head } = await editedClone();
		const manager = await recordSession(clone, join(clone, "notes"));
		renameReplacing(clone, sandbox.path("node-a-gone"));
		const io = new CountingGitIo();

		const prepared = await prepareSessionResume(manager, options({ io }));

		assert.equal(prepared.status, "ready");
		if (prepared.status !== "ready") return;
		const restoredRoot = manager.getWorktreeRootMappings().at(-1)!.to;
		assert.ok(restoredRoot.startsWith(sandbox.path("host")));
		assert.equal(cwdOf(prepared), join(restoredRoot, "notes"));
		assert.equal(readFileSync(join(restoredRoot, "README.md"), "utf8"), "edited\n");
		assert.equal(readFileSync(join(restoredRoot, "committed.txt"), "utf8"), "unpushed\n");
		assert.equal(readFileSync(join(restoredRoot, "notes", "untracked.txt"), "utf8"), "untracked\n");
		assert.equal(await sandbox.git(restoredRoot, "rev-parse", "HEAD"), head);
		assert.equal(io.probes, 1);
		assert.equal(setupRuns(), 1);
		assert.deepEqual(
			prepared.notices.map((notice) => notice.type),
			["info", "warning"],
		);
		assert.match(prepared.notices[0]!.message, /^Restored worktree snapshot \w{12} of /);
		assert.ok(prepared.notices[0]!.message.includes(` of ${clone} into `), prepared.notices[0]!.message);
		assert.match(prepared.notices[1]!.message, /^Deprecation warning: resume\.setupCommand is deprecated/);
		assert.deepEqual(prepared.blueprintNotices, [prepared.notices[1]]);
		assert.equal(existsSync(sandbox.path("host", "blueprint-builds", "ledger.json")), true);
		assert.equal(
			resolveForSession(manager, join(clone, "README.md"), cwdOf(prepared)!),
			join(restoredRoot, "README.md"),
		);

		const again = await prepareSessionResume(manager, options({ io }));
		assert.equal(cwdOf(again), cwdOf(prepared));
		assert.equal(setupRuns(), 1);
		assert.equal(io.probes, 1);
	});

	test("continues without the checkout, writing no worktree, when Git cannot be started and a restore is needed (#4733)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		renameReplacing(clone, sandbox.path("node-a-gone"));
		const io = new CountingGitIo(missingGit());
		setWorktreeSnapshotGit(async () => ({ path: sandbox.path("no-git"), env: {} }));

		const prepared = await prepareSessionResume(manager, options({ io }));

		assert.equal(prepared.status, "ready");
		if (prepared.status !== "ready") return;
		assert.equal(io.probes, 1);
		assert.equal(existsSync(sandbox.path("host")), false);
		assert.deepEqual(manager.getWorktreeRootMappings(), []);
		assert.equal(cwdOf(prepared), sandbox.root, "the recorded directory is gone, so the launch directory");
		assert.deepEqual(
			prepared.notices.map((notice) => notice.type),
			["warning"],
		);
		assert.equal(
			prepared.notices[0]!.message,
			`Continuing in ${sandbox.root} (the directory the resume started from) without restoring ${clone} from snapshot ${manager.getLatestWorktreeSnapshots().get(clone)!.id.slice(0, 12)}: Git is unavailable here (not-installed), which checking and restoring it need. ${missingGit().hint}`,
		);
	});

	test("Git that cannot be provisioned is probed once, before the launch checkout is read, and is named in the notice (#4733)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		renameReplacing(clone, sandbox.path("node-a-gone"));
		const timeout = new GitProvisionTimeoutError({ phase: "download", timeoutMs: 600_000, elapsedMs: 600_004 });
		const unavailable = new GitUnavailableError(
			{ code: "not-installed", platform: "linux", arch: "x64", installDir: "/home/u/.atomic/agent/bin/git" },
			{ cause: timeout },
		);
		const io = new CountingGitIo(unavailable);
		const launchCwd = sandbox.path("launch");
		mkdirSync(launchCwd);
		setWorktreeSnapshotGit(async () => {
			throw new Error("Git must not be resolved again after the probe failed");
		});

		const prepared = await prepareSessionResume(manager, options({ io, launchCwd }));

		assert.equal(cwdOf(prepared), launchCwd);
		assert.equal(io.probes, 1);
		assert.equal(existsSync(sandbox.path("host")), false);
		assert.equal(prepared.status === "ready" && prepared.notices.length, 1);
		assert.match(
			prepared.status === "ready" ? prepared.notices[0]!.message : "",
			/Git is unavailable here \(not-installed\)/,
		);
	});

	test("restores the closest pushed commit when the unpushed history touches a denied path, with one notice (#4733)", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const pushed = await sandbox.git(clone, "rev-parse", "HEAD");
		sandbox.write(join(clone, "deploy.key"), "PRIVATE\n");
		const denied = await sandbox.commitAll(clone, "unpushed key");
		const manager = await recordSession(clone);
		renameReplacing(clone, sandbox.path("node-a-gone"));
		const prepared = await prepareSessionResume(
			manager,
			options({ blueprint: setupBlueprint({ setupCommand: undefined }) }),
		);
		assert.equal(prepared.status, "ready");
		if (prepared.status !== "ready") return;
		const restored = manager.getWorktreeRootMappings().at(-1)!;
		assert.equal(cwdOf(prepared), restored.to);
		assert.equal(await sandbox.git(restored.to, "rev-parse", "HEAD"), pushed);
		assert.equal(existsSync(join(restored.to, "deploy.key")), false);
		assert.equal(prepared.notices.length, 1);
		assert.ok(prepared.notices[0]!.message.includes(denied.slice(0, 12)), prepared.notices[0]!.message);
		assert.ok(prepared.notices[0]!.message.includes(`Push commit ${denied}`), prepared.notices[0]!.message);
	});

	test("does nothing when snapshots are disabled or the session recorded none", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		renameReplacing(clone, sandbox.path("node-a-gone"));
		const io = new CountingGitIo();
		const disabled = await prepareSessionResume(
			manager,
			options({
				io,
				settings: { ...settings, enabled: false },
				blueprint: setupBlueprint({ setupCommand: undefined }),
			}),
		);
		assert.deepEqual(disabled, {
			status: "ready",
			sessionManager: manager,
			notices: [],
			blueprintNotices: [],
			blueprintContext: undefined,
		});
		const empty = await SessionManager.create(await sqlStore("empty"), sandbox.root);
		assert.deepEqual(
			await prepareSessionResume(empty, options({ io, blueprint: setupBlueprint({ setupCommand: undefined }) })),
			{
				status: "ready",
				sessionManager: empty,
				notices: [],
				blueprintNotices: [],
				blueprintContext: undefined,
			},
		);
		assert.equal(io.probes, 0);
		assert.equal(existsSync(sandbox.path("host")), false);
	});

	test("restores every recorded checkout when the session works outside all of them (review findings 1 and 2)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone, sandbox.root);
		renameReplacing(clone, sandbox.path("node-a-gone"));
		const io = new CountingGitIo();
		const launchClone = sandbox.path("node-b", "repo");
		mkdirSync(sandbox.path("node-b"));
		await sandbox.git(sandbox.root, "clone", "-q", sandbox.path("repo.git"), launchClone);

		const prepared = await prepareSessionResume(manager, options({ io, launchCwd: launchClone }));

		assert.equal(prepared.status, "ready");
		const mappings = manager.getWorktreeRootMappings();
		assert.deepEqual(
			mappings.map((mapping) => mapping.from),
			[clone],
		);
		assert.ok(mappings[0]!.to.startsWith(sandbox.path("host")));
		assert.equal(readFileSync(join(mappings[0]!.to, "README.md"), "utf8"), "edited\n");
		assert.equal(cwdOf(prepared), sandbox.root);
		assert.equal(io.probes, 1);
		assert.equal(setupRuns(), 1);
		assert.match(prepared.status === "ready" ? prepared.notices[0]!.message : "", /^Restored worktree snapshot/);
	});
});

describe.skipIf(process.platform === "win32")(
	"prepareSessionResume when Git fails in the launch checkout (#4329)",
	() => {
		/** A Git that fails `command` with exit status 2, only when it runs in `dir`, and otherwise runs the real Git. */
		function gitFailingIn(dir: string, command: string): string {
			const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
			const shim = sandbox.path("failing-git");
			writeFileSync(
				shim,
				`#!/bin/sh\ncase "$(pwd -P):$*" in "${realpathSync(dir)}":*"${command}"*) echo "simulated failure" >&2; exit 2;; esac\nexec "${realGit}" "$@"\n`,
			);
			chmodSync(shim, 0o755);
			return shim;
		}

		async function launchedInAnotherClone() {
			const { clone } = await editedClone();
			const manager = await recordSession(clone);
			renameReplacing(clone, sandbox.path("node-a-gone"));
			const launch = sandbox.path("node-b", "repo");
			mkdirSync(sandbox.path("node-b"));
			await sandbox.git(sandbox.root, "clone", "-q", sandbox.path("repo.git"), launch);
			return { manager, launch };
		}

		test("a Git failure while locating the launch checkout stops the resume instead of being read as no checkout", async () => {
			const { manager, launch } = await launchedInAnotherClone();
			const shim = gitFailingIn(launch, "rev-parse --show-toplevel");
			setWorktreeSnapshotGit(async () => ({ path: shim, env: {} }));
			await assert.rejects(prepareSessionResume(manager, options({ launchCwd: launch })), (error: unknown) => {
				assert.ok(isWorkspaceGitError(error), String(error));
				return true;
			});
			assert.equal(existsSync(sandbox.path("host")), false);
		});

		test("a Git failure while comparing the launch checkout stops the resume instead of being read as drift", async () => {
			const { manager, launch } = await launchedInAnotherClone();
			const shim = gitFailingIn(launch, "cat-file");
			setWorktreeSnapshotGit(async () => ({ path: shim, env: {} }));
			await assert.rejects(prepareSessionResume(manager, options({ launchCwd: launch })), (error: unknown) => {
				assert.ok(isWorkspaceGitError(error), String(error));
				return true;
			});
			assert.equal(existsSync(sandbox.path("host")), false);
		});
	},
);

describe("prepareSessionResume started in a checkout of the session's repository (#4329)", () => {
	async function movedCheckout() {
		const { clone } = await editedClone();
		const manager = await recordSession(clone, join(clone, "notes"));
		const checkout = sandbox.path("node-b", "repo");
		mkdirSync(sandbox.path("node-b"));
		renameReplacing(clone, checkout);
		return { clone, manager, checkout };
	}

	test("uses a matching checkout as-is and records the mapping without restoring or running setup", async () => {
		const { clone, manager, checkout } = await movedCheckout();
		const prompts: DirtyCheckoutPrompt[] = [];
		const prepared = await prepareSessionResume(
			manager,
			options({
				launchCwd: join(checkout, "notes"),
				chooseDirtyCheckout: async (prompt) => {
					prompts.push(prompt);
					return "cancel";
				},
			}),
		);
		assert.deepEqual(cwdOf(prepared), join(checkout, "notes"));
		assert.equal(prepared.status === "ready" && prepared.notices[0]?.type, "info");
		assert.match(prepared.status === "ready" ? prepared.notices[0]!.message : "", /which matches snapshot/);
		assert.deepEqual(prompts, []);
		assert.deepEqual(
			manager.getWorktreeRootMappings().map((mapping) => [mapping.from, mapping.to]),
			[[clone, checkout]],
		);
		assert.equal(existsSync(sandbox.path("host")), false);
		assert.equal(setupRuns(), 0);
		assert.equal(
			resolveForSession(manager, join(clone, "README.md"), join(checkout, "notes")),
			join(checkout, "README.md"),
		);
	});

	const dirtyCases: ReadonlyArray<[DirtyCheckoutChoice | "non-interactive", "use" | "restore" | "cancelled"]> = [
		["use", "use"],
		["restore", "restore"],
		["cancel", "cancelled"],
		["non-interactive", "restore"],
	];
	for (const [choice, outcome] of dirtyCases) {
		test(`a dirty checkout answered '${choice}' ends in '${outcome}' and never changes the checkout`, async () => {
			const { clone, manager, checkout } = await movedCheckout();
			sandbox.write(join(checkout, "README.md"), "user edit\n");
			const prompts: DirtyCheckoutPrompt[] = [];
			const prepared = await prepareSessionResume(
				manager,
				options({
					launchCwd: checkout,
					...(choice === "non-interactive"
						? {}
						: {
								chooseDirtyCheckout: async (prompt: DirtyCheckoutPrompt) => {
									prompts.push(prompt);
									return choice;
								},
							}),
				}),
			);
			assert.equal(readFileSync(join(checkout, "README.md"), "utf8"), "user edit\n");
			assert.equal(prompts.length, choice === "non-interactive" ? 0 : 1);
			if (prompts[0]) {
				assert.equal(prompts[0].checkout, checkout);
				assert.equal(prompts[0].recordedRoot, clone);
				assert.equal(prompts[0].snapshotId, manager.getLatestWorktreeSnapshots().get(clone)!.id);
			}
			const mappings = manager.getWorktreeRootMappings();
			if (outcome === "cancelled") {
				assert.deepEqual(prepared, { status: "cancelled" });
				assert.deepEqual(mappings, []);
				assert.equal(existsSync(sandbox.path("host")), false);
			} else if (outcome === "use") {
				assert.equal(cwdOf(prepared), join(checkout, "notes"));
				assert.equal(prepared.status === "ready" && prepared.notices[0]?.type, "warning");
				assert.match(
					prepared.status === "ready" ? prepared.notices[0]!.message : "",
					/which differs from snapshot/,
				);
				assert.deepEqual(
					mappings.map((mapping) => mapping.to),
					[checkout],
				);
				assert.equal(setupRuns(), 0);
			} else {
				assert.equal(prepared.status, "ready");
				assert.ok(mappings.at(-1)!.to.startsWith(sandbox.path("host")));
				assert.equal(readFileSync(join(mappings.at(-1)!.to, "README.md"), "utf8"), "edited\n");
				assert.equal(setupRuns(), 1);
			}
		});
	}

	test("a recorded checkout that is still here is resumed in place, even when started in another clone", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone, join(clone, "notes"));
		const other = sandbox.path("node-b", "repo");
		mkdirSync(sandbox.path("node-b"));
		await sandbox.git(sandbox.root, "clone", "-q", sandbox.path("repo.git"), other);
		let asked = false;
		const prepared = await prepareSessionResume(
			manager,
			options({
				launchCwd: other,
				chooseDirtyCheckout: async () => {
					asked = true;
					return "use";
				},
			}),
		);
		assert.equal(cwdOf(prepared), join(clone, "notes"));
		assert.equal(asked, false);
		assert.deepEqual(manager.getWorktreeRootMappings(), []);
		assert.equal(existsSync(sandbox.path("host")), false);
	});

	test("a matching checkout is used when the recorded path holds another tree here (review finding 11)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone, join(clone, "notes"));
		const matching = sandbox.path("node-b", "repo");
		mkdirSync(sandbox.path("node-b"));
		renameReplacing(clone, matching);
		await sandbox.git(sandbox.root, "clone", "-q", sandbox.path("repo.git"), clone);
		sandbox.write(join(clone, "README.md"), "node B's own tree at the recorded path\n");

		const prepared = await prepareSessionResume(manager, options({ launchCwd: matching }));

		assert.equal(cwdOf(prepared), join(matching, "notes"));
		assert.deepEqual(
			manager.getWorktreeRootMappings().map((mapping) => [mapping.from, mapping.to]),
			[[clone, matching]],
		);
		assert.equal(readFileSync(join(clone, "README.md"), "utf8"), "node B's own tree at the recorded path\n");
		assert.equal(existsSync(sandbox.path("host")), false);
		assert.equal(setupRuns(), 0);
	});

	test("a checkout where the recorded edits were committed is used as-is, without asking", async () => {
		const { clone, manager, checkout } = await movedCheckout();
		await sandbox.commitAll(checkout, "commit the recorded edits");
		let asked = false;
		const prepared = await prepareSessionResume(
			manager,
			options({
				launchCwd: checkout,
				chooseDirtyCheckout: async () => {
					asked = true;
					return "restore";
				},
			}),
		);
		assert.equal(asked, false);
		assert.equal(cwdOf(prepared), join(checkout, "notes"));
		assert.deepEqual(
			manager.getWorktreeRootMappings().map((mapping) => [mapping.from, resolve(mapping.to)]),
			[[clone, checkout]],
		);
		assert.equal(existsSync(sandbox.path("host")), false);
	});

	test("a clean checkout at another commit restores a fresh worktree without asking; a dirty one asks", async () => {
		const { clone } = await editedClone();
		const [cleanSession, modifiedSession, untrackedSession] = [
			await recordSession(clone),
			await recordSession(clone),
			await recordSession(clone),
		] as const;
		renameReplacing(clone, sandbox.path("node-a-gone"));
		const prompts: DirtyCheckoutPrompt[] = [];
		const ask = async (prompt: DirtyCheckoutPrompt): Promise<DirtyCheckoutChoice> => {
			prompts.push(prompt);
			return "restore";
		};
		const teammateClone = async (name: string) => {
			const checkout = sandbox.path(name, "repo");
			mkdirSync(sandbox.path(name));
			await sandbox.git(sandbox.root, "clone", "-q", sandbox.path("repo.git"), checkout);
			return checkout;
		};

		const clean = await prepareSessionResume(
			cleanSession,
			options({ launchCwd: await teammateClone("node-clean"), chooseDirtyCheckout: ask }),
		);
		assert.deepEqual(prompts, []);
		assert.ok(cwdOf(clean)?.startsWith(sandbox.path("host")), cwdOf(clean));

		const modified = await teammateClone("node-modified");
		sandbox.write(join(modified, "README.md"), "a local edit\n");
		await prepareSessionResume(modifiedSession, options({ launchCwd: modified, chooseDirtyCheckout: ask }));
		assert.deepEqual(
			prompts.map((prompt) => prompt.checkout),
			[modified],
		);

		const untracked = await teammateClone("node-untracked");
		sandbox.write(join(untracked, "scratch.txt"), "an untracked file\n");
		await prepareSessionResume(untrackedSession, options({ launchCwd: untracked, chooseDirtyCheckout: ask }));
		assert.deepEqual(
			prompts.map((prompt) => prompt.checkout),
			[modified, untracked],
		);
	});

	test("a checkout of another repository is never reused", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		renameReplacing(clone, sandbox.path("node-a-gone"));
		const { clone: other } = await sandbox.remoteWithClone("other");
		let asked = false;
		await prepareSessionResume(
			manager,
			options({
				launchCwd: other,
				chooseDirtyCheckout: async () => {
					asked = true;
					return "use";
				},
			}),
		);
		assert.equal(asked, false);
		assert.ok(manager.getWorktreeRootMappings().at(-1)!.to.startsWith(sandbox.path("host")));
	});
});

describe("prepareSessionResume matches a launch checkout by repository, not by remote spelling (#4913)", () => {
	/** Points the hosted remote spellings the tests record at the sandbox's own bare repositories, so nothing leaves it. */
	function hostRemotes(remotes: Record<string, readonly string[]>): void {
		const sections = Object.entries(remotes).map(
			([name, spellings]) =>
				`[url "${gitConfigPath(sandbox.path(`${name}.git`))}"]\n${spellings.map((spelling) => `\tinsteadOf = ${spelling}\n`).join("")}`,
		);
		appendFileSync(sandbox.globalConfig, sections.join(""));
	}

	/** A session recorded in a clone whose origin is spelled `recorded`, then moved to a checkout spelling it `launch`. */
	async function movedCheckout(recorded: string, launch: string) {
		const { clone } = await editedClone();
		await sandbox.git(clone, "remote", "set-url", "origin", recorded);
		const manager = await recordSession(clone, join(clone, "notes"));
		assert.deepEqual(manager.getLatestWorktreeSnapshots().get(clone)!.remotes, [recorded]);
		const checkout = sandbox.path("node-b", "repo");
		mkdirSync(sandbox.path("node-b"));
		renameReplacing(clone, checkout);
		await sandbox.git(checkout, "remote", "set-url", "origin", launch);
		return { clone, manager, checkout };
	}

	const spellings: ReadonlyArray<[string, string]> = [
		["https://github.com/acme/app.git", "git@github.com:acme/app.git"],
		["https://github.com/acme/app", "https://github.com/acme/app.git"],
	];
	for (const [recorded, launch] of spellings) {
		test(`a session recorded with ${recorded} resumes in a checkout whose origin is ${launch} (#4913)`, async () => {
			hostRemotes({ repo: [recorded, launch] });
			const { clone, manager, checkout } = await movedCheckout(recorded, launch);

			const prepared = await prepareSessionResume(manager, options({ launchCwd: join(checkout, "notes") }));

			assert.equal(cwdOf(prepared), join(checkout, "notes"));
			assert.match(prepared.status === "ready" ? prepared.notices[0]!.message : "", /which matches snapshot/);
			assert.deepEqual(
				manager.getWorktreeRootMappings().map((mapping) => [mapping.from, mapping.to]),
				[[clone, checkout]],
			);
			assert.equal(existsSync(sandbox.path("host")), false);
		});
	}

	test("a checkout of another repository spelled the other way is not reused (#4913)", async () => {
		await sandbox.remoteWithClone("other");
		hostRemotes({ repo: ["https://github.com/acme/app.git"], other: ["git@github.com:acme/other.git"] });
		const { checkout, manager } = await movedCheckout(
			"https://github.com/acme/app.git",
			"git@github.com:acme/other.git",
		);

		const prepared = await prepareSessionResume(manager, options({ launchCwd: checkout }));

		assert.equal(prepared.status, "ready");
		const restored = manager.getWorktreeRootMappings().at(-1)!.to;
		assert.ok(restored.startsWith(sandbox.path("host")), restored);
		assert.equal(readFileSync(join(restored, "README.md"), "utf8"), "edited\n");
	});
});

describe("prepareSessionResume details (#4329)", () => {
	test("latestSessionSnapshot picks the innermost recorded root that contains the mapped cwd", async () => {
		const { latestSessionSnapshot } = await import("../src/core/resume/session-resume.ts");
		const outer = { id: "outer" } as WorktreeSnapshot;
		const inner = { id: "inner" } as WorktreeSnapshot;
		const source = (cwd: string, mappings: WorktreeRootMapping[] = []) => ({
			getCwd: () => cwd,
			getWorktreeRootMappings: () => mappings,
			getLatestWorktreeSnapshots: () =>
				new Map([
					["/repo", outer],
					["/repo/vendor/lib", inner],
				]),
		});
		assert.equal(latestSessionSnapshot(source("/repo/vendor/lib/src"))?.snapshot.id, "inner");
		const reversed = {
			...source("/repo/vendor/lib/src"),
			getLatestWorktreeSnapshots: () =>
				new Map([
					["/repo/vendor/lib", inner],
					["/repo", outer],
				]),
		};
		assert.equal(latestSessionSnapshot(reversed)?.snapshot.id, "inner");
		assert.equal(latestSessionSnapshot(source("/repo/src"))?.snapshot.id, "outer");
		assert.equal(latestSessionSnapshot(source("/elsewhere")), undefined);
		const moved = latestSessionSnapshot(
			source("/node-a/repo/src", [
				{ from: "/node-a/repo", to: "/repo", snapshotId: "s", tree: "t", restoredAt: "x" },
			]),
		);
		assert.deepEqual([moved?.root, moved?.cwd], ["/repo", resolve("/repo/src")]);
	});

	test("notices name the 12-character snapshot id and the checkouts", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		const id = manager.getLatestWorktreeSnapshots().get(clone)!.id;
		const checkout = sandbox.path("moved");
		renameReplacing(clone, checkout);
		const matched = await prepareSessionResume(manager, options({ launchCwd: checkout }));
		assert.deepEqual(matched.status === "ready" && matched.notices, [
			{ type: "info", message: `Resuming in ${checkout}, which matches snapshot ${id.slice(0, 12)} of ${clone}` },
		]);
	});

	test("the dirty-checkout warning names the 12-character snapshot id", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		const id = manager.getLatestWorktreeSnapshots().get(clone)!.id;
		const checkout = sandbox.path("moved");
		renameReplacing(clone, checkout);
		sandbox.write(join(checkout, "README.md"), "user edit\n");
		const used = await prepareSessionResume(
			manager,
			options({ launchCwd: checkout, chooseDirtyCheckout: async () => "use" }),
		);
		assert.deepEqual(used.status === "ready" && used.notices, [
			{
				type: "warning",
				message: `Resuming in ${checkout}, which differs from snapshot ${id.slice(0, 12)} of ${clone}`,
			},
		]);
	});

	test("a checkout sharing one of several remotes with the snapshot is the same repository", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		const checkout = sandbox.path("moved");
		renameReplacing(clone, checkout);
		await sandbox.git(checkout, "remote", "add", "mirror", sandbox.path("mirror.git"));
		const prepared = await prepareSessionResume(manager, options({ launchCwd: checkout }));
		assert.equal(cwdOf(prepared), checkout);
	});

	test("a snapshot of a repository without remotes is never matched to a checkout; it is restored", async () => {
		const root = sandbox.path("local-only");
		mkdirSync(root);
		await sandbox.git(root, "init", "-q");
		sandbox.write(join(root, "a.txt"), "a\n");
		await sandbox.commitAll(root, "initial");
		const manager = await recordSession(root);
		const checkout = sandbox.path("moved");
		renameReplacing(root, checkout);
		let asked = false;
		const prepared = await prepareSessionResume(
			manager,
			options({
				launchCwd: checkout,
				chooseDirtyCheckout: async () => {
					asked = true;
					return "use";
				},
			}),
		);
		assert.equal(asked, false);
		assert.ok(cwdOf(prepared)?.startsWith(sandbox.path("host")));
	});

	test("the checkout is compared under the session's snapshot settings", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "scratch.txt"), "untracked\n");
		const narrow = { ...settings, includeUntracked: false };
		const store = await sqlStore("narrow");
		const manager = await SessionManager.create(store, clone);
		await manager.appendMessage({ role: "user", content: "x", timestamp: Date.now() });
		const capture = await captureWorktreeSnapshot(clone, { settings: narrow, blobs: store.snapshotBlobs });
		if (capture.status !== "captured") throw new Error(capture.status);
		await manager.appendWorktreeSnapshot(clone, capture.snapshot.id, capture.snapshot);
		const checkout = sandbox.path("moved");
		renameReplacing(clone, checkout);
		const prepared = await prepareSessionResume(manager, options({ launchCwd: checkout, settings: narrow }));
		assert.equal(prepared.status === "ready" && prepared.notices[0]?.type, "info");
		assert.equal(cwdOf(prepared), checkout);
	});

	test("a user checkout verified in place never runs the setup command", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		const prepared = await prepareSessionResume(manager, options());
		assert.equal(cwdOf(prepared), clone);
		assert.equal(setupRuns(), 0);
		assert.deepEqual(prepared.status === "ready" && prepared.notices, []);
	});

	test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"a recorded root under a file is absent; one that cannot be checked fails instead of restoring",
		async () => {
			const { clone } = await editedClone();
			const manager = await recordSession(clone);
			renameReplacing(clone, sandbox.path("gone"));
			mkdirSync(dirname(clone), { recursive: true });
			writeFileSync(clone, "now a file");
			const underFile = await prepareSessionResume(manager, options());
			assert.ok(cwdOf(underFile)?.startsWith(sandbox.path("host")));

			const { clone: second } = await sandbox.remoteWithClone("second");
			const locked = await recordSession(second);
			chmodSync(dirname(second), 0o000);
			cleanups.push(() => chmodSync(dirname(second), 0o755));
			await assert.rejects(
				prepareSessionResume(locked, options({ storeDir: sandbox.path("host-2") })),
				(error: unknown) => {
					assertUnreadable(error);
					return true;
				},
			);
		},
	);
});

describe("prepareSessionResume: failure paths and notices (#4329)", () => {
	test("a recorded root below a path component that is now a file is absent", async () => {
		const remote = sandbox.path("nested-remote.git");
		await sandbox.git(sandbox.root, "init", "-q", "--bare", remote);
		const clone = sandbox.path("nested", "repo");
		await sandbox.git(sandbox.root, "clone", "-q", remote, clone);
		sandbox.write(join(clone, "a.txt"), "a\n");
		await sandbox.commitAll(clone, "initial");
		await sandbox.git(clone, "push", "-q", "origin", "HEAD:main");
		const manager = await recordSession(clone);
		renameReplacing(dirname(clone), sandbox.path("gone"));
		writeFileSync(dirname(clone), "now a file");
		const prepared = await prepareSessionResume(manager, options());
		assert.ok(cwdOf(prepared)?.startsWith(sandbox.path("host")));
	});

	test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"a recorded root that cannot be checked fails before Git is probed or anything is restored",
		async () => {
			const { clone } = await sandbox.remoteWithClone("locked/repo");
			const manager = await recordSession(clone);
			chmodSync(dirname(clone), 0o000);
			cleanups.push(() => chmodSync(dirname(clone), 0o755));
			const io = new CountingGitIo();
			await assert.rejects(prepareSessionResume(manager, options({ io })), (error: unknown) => {
				assertUnreadable(error);
				return true;
			});
			assert.equal(io.probes, 0);
			assert.equal(existsSync(sandbox.path("host")), false);
		},
	);

	test("a checkout that cannot be compared fails instead of being treated as dirty", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		const checkout = sandbox.path("moved");
		renameReplacing(clone, checkout);
		let asked = false;
		await assert.rejects(
			prepareSessionResume(
				manager,
				options({
					launchCwd: checkout,
					settings: { ...settings, maxFileBytes: -1 },
					chooseDirtyCheckout: async () => {
						asked = true;
						return "use";
					},
				}),
			),
			(error: unknown) => (error as { name?: string }).name === "WorkspaceConfigError",
		);
		assert.equal(asked, false);
	});

	test("without Git a session whose checkout is still here continues in it as it is, with one notice (#4733)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		sandbox.write(join(clone, "README.md"), "changed since the snapshot\n");
		setWorktreeSnapshotGit(async () => ({ path: sandbox.path("no-git"), env: {} }));
		const prepared = await prepareSessionResume(manager, options());
		assert.equal(cwdOf(prepared), clone);
		assert.equal(readFileSync(join(clone, "README.md"), "utf8"), "changed since the snapshot\n");
		assert.equal(existsSync(sandbox.path("host")), false);
		assert.equal(prepared.status === "ready" && prepared.notices.length, 1);
		assert.match(
			prepared.status === "ready" ? prepared.notices[0]!.message : "",
			/^Continuing in .* \(the session's own directory\) without restoring .*Git is unavailable here/,
		);
	});

	test("without Git a session already in a restored worktree continues there without running setup (#4733)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		renameReplacing(clone, sandbox.path("gone"));
		const first = await prepareSessionResume(manager, options());
		assert.equal(first.status, "ready");
		assert.equal(setupRuns(), 1);
		rmSync(sandbox.path("host", "blueprint-builds"), { recursive: true });
		setWorktreeSnapshotGit(async () => ({ path: sandbox.path("no-git"), env: {} }));
		if (first.status !== "ready") return;
		const again = await prepareSessionResume(first.sessionManager, options());
		assert.equal(cwdOf(again), cwdOf(first));
		assert.equal(setupRuns(), 1);
	});

	test("a restore with no setup command shows only the restore notice", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const manager = await recordSession(clone);
		renameReplacing(clone, sandbox.path("gone"));
		const prepared = await prepareSessionResume(
			manager,
			options({ blueprint: setupBlueprint({ setupCommand: undefined }) }),
		);
		assert.equal(prepared.status === "ready" && prepared.notices.length, 1);
		assert.equal(setupRuns(), 0);
	});
});
