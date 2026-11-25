import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test, vi } from "vitest";
import { parseArgs } from "../src/cli/args.js";
import type { AgentSession } from "../src/core/agent-session.js";
import { renameReplacing } from "../src/core/rename-retry.js";
import { blueprintBuildSettled } from "../src/core/resume/blueprint/barrier.js";
import { RESUME_CATALOG_TIMEOUT_MS } from "../src/core/resume/not-found.js";
import type { CreateAgentSessionOptions } from "../src/core/sdk-types.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { isSyntheticPath } from "../src/core/source-info.js";
import { StorageConfigError } from "../src/core/storage/errors.js";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.js";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.js";
import {
	isResumeCatalogTimeoutError,
	resolveWorkspace,
	setWorktreeSnapshotGit,
	withWorktreeRootMappings,
	workspace,
} from "../src/index.js";
import { openCliSession } from "../src/main-session.js";
import { forThisHost } from "./helpers/blueprint-fixtures.js";
import { appendLineCommand, nodeCommand, shellPath } from "./helpers/hook-commands.js";
import { lastUnrestored, readWithTools, settings, useResumeEntryPointsFixture } from "./resume-entry-points-helpers.js";

const fixture = useResumeEntryPointsFixture();
const { cleanups, sqliteSelection, storeFor, recordSessionWithSnapshot, sessionRecordedElsewhere, runtimeOn } = fixture;

/** Node B's own clone of the session's repository at the session's recorded path, which never held node A's snapshot. */
async function anotherCloneAtRecordedPath(clone: string): Promise<void> {
	renameReplacing(clone, fixture.sandbox.path("node-a-offline"));
	await fixture.sandbox.git(fixture.sandbox.root, "clone", "-q", fixture.sandbox.path("repo.git"), clone);
	fixture.sandbox.write(join(clone, "README.md"), "node B's own checkout at the same path\n");
}

const NO_BUILTINS = { subagents: false, mcp: false, "web-access": false, intercom: false } as const;

const extensionFilesLoadedBy = (session: AgentSession) =>
	session.extensionRunner.getExtensionPaths().filter((path) => !isSyntheticPath(path));

describe("AgentSessionRuntime.switchSession across nodes (#4329)", () => {
	test("rehydrating a session released on another node restores its checkout before it continues", async () => {
		const agentDir = fixture.sandbox.path("agent");
		const { clone, sessionId } = await sessionRecordedElsewhere(sqliteSelection("shared"));
		const { runtime } = await runtimeOn(agentDir, { resume: { setupCommand: "true" } });
		const woken = await runtime.rehydrate(sessionId);
		const cwd = woken.sessionManager.getCwd();
		assert.ok(cwd.startsWith(join(agentDir, "worktree-snapshots")), cwd);
		assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), "edited on node A\n");
		assert.deepEqual(
			woken.sessionManager.getWorktreeRootMappings().map((mapping) => mapping.from),
			[clone],
		);
		assert.match(await readWithTools(woken, join(clone, "README.md")), /edited on node A/);
	});

	test("rehydrating a session whose checkout is here and matches starts it there without restoring anything", async () => {
		const agentDir = fixture.sandbox.path("agent");
		const { clone, sessionId } = await recordSessionWithSnapshot(sqliteSelection("shared"));
		const { runtime } = await runtimeOn(agentDir, {});
		const woken = await runtime.rehydrate(sessionId);
		assert.equal(woken.sessionManager.getCwd(), clone);
		assert.deepEqual(woken.sessionManager.getWorktreeRootMappings(), []);
		assert.equal(existsSync(join(agentDir, "worktree-snapshots")), false);
	});

	test("rehydrating on a node where the recorded path holds another clone continues in a restored worktree, not there", async () => {
		const agentDir = fixture.sandbox.path("agent");
		const { clone, sessionId } = await sessionRecordedElsewhere(sqliteSelection("shared"));
		await fixture.sandbox.git(fixture.sandbox.root, "clone", "-q", fixture.sandbox.path("repo.git"), clone);
		fixture.sandbox.write(join(clone, "README.md"), "another tree at the same path\n");
		const { runtime } = await runtimeOn(agentDir, { resume: { setupCommand: "true" } });

		const woken = await runtime.rehydrate(sessionId);

		const cwd = woken.sessionManager.getCwd();
		assert.ok(cwd.startsWith(join(agentDir, "worktree-snapshots")), cwd);
		assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), "edited on node A\n");
		assert.equal(readFileSync(join(clone, "README.md"), "utf8"), "another tree at the same path\n");
	});

	test("rehydrating a session that worked outside its checkouts restores the one that is missing here", async () => {
		const agentDir = fixture.sandbox.path("agent");
		const { clone } = await fixture.sandbox.remoteWithClone("repo", { "README.md": "hello\n" });
		fixture.sandbox.write(join(clone, "README.md"), "edited on node A\n");
		const store = await storeFor(sqliteSelection("shared"));
		const manager = await SessionManager.create(store, fixture.sandbox.root);
		await manager.appendMessage({ role: "user", content: "edit", timestamp: Date.now() });
		const capture = await captureWorktreeSnapshot(clone, {
			settings: DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
			blobs: store.snapshotBlobs,
		});
		if (capture.status !== "captured") throw new Error(capture.status);
		await manager.appendWorktreeSnapshot(clone, capture.snapshot.id, capture.snapshot);
		renameReplacing(clone, fixture.sandbox.path("node-a-offline"));
		const { runtime } = await runtimeOn(agentDir, { resume: { setupCommand: "true" } });

		const woken = await runtime.rehydrate(manager.getSessionId());

		const [restore] = woken.sessionManager.getWorktreeRootMappings();
		assert.equal(restore?.from, clone);
		assert.equal(readFileSync(join(restore!.to, "README.md"), "utf8"), "edited on node A\n");
	});

	test("rehydrating a session in its own checkout here continues there after the checkout changed, with nothing built", async () => {
		const agentDir = fixture.sandbox.path("agent");
		const { clone, sessionId } = await recordSessionWithSnapshot(sqliteSelection("shared"), {
			"package-lock.json": "{}\n",
		});
		fixture.sandbox.write(join(clone, "written-after-the-release.txt"), "later\n");
		const { runtime } = await runtimeOn(agentDir, {});

		const woken = await runtime.rehydrate(sessionId);

		assert.equal(woken.sessionManager.getCwd(), clone);
		assert.deepEqual(woken.sessionManager.getWorktreeRootMappings(), []);
		assert.equal(existsSync(join(agentDir, "worktree-snapshots")), false);
	});

	/**
	 * Sessions X and Y released on this node. X worked in `repo-b`. Y worked in `repo-a`, which has a lockfile, and edited `repo-b` after X, so `repo-b` now holds Y's edit.
	 */
	async function sessionsSharingACheckout() {
		const store = await storeFor(sqliteSelection("shared"));
		const { clone: repoA } = await fixture.sandbox.remoteWithClone("repo-a", {
			"README.md": "a\n",
			"package-lock.json": "{}\n",
		});
		const { clone: repoB } = await fixture.sandbox.remoteWithClone("repo-b", { "README.md": "b\n" });
		const record = async (cwd: string, edits: ReadonlyArray<readonly [string, string]>) => {
			const manager = await SessionManager.create(store, cwd);
			await manager.appendMessage({ role: "user", content: "edit", timestamp: Date.now() });
			for (const [root, text] of edits) {
				fixture.sandbox.write(join(root, "README.md"), text);
				const capture = await captureWorktreeSnapshot(root, {
					settings: DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
					blobs: store.snapshotBlobs,
				});
				if (capture.status !== "captured") throw new Error(capture.status);
				await manager.appendWorktreeSnapshot(root, capture.snapshot.id, capture.snapshot);
			}
			return manager.getSessionId();
		};
		const x = await record(repoB, [[repoB, "X's edit\n"]]);
		const y = await record(repoA, [
			[repoA, "Y's work in repo-a\n"],
			[repoB, "Y's edit\n"],
		]);
		return { repoA, repoB, x, y };
	}

	test("rehydrating keeps the session's own changed checkout and restores only a sibling another clone holds here; its tools follow that restore (#4329)", async () => {
		const agentDir = fixture.sandbox.path("agent");
		const { repoA, repoB, y } = await sessionsSharingACheckout();
		fixture.sandbox.write(join(repoA, "written-after-the-release.txt"), "later\n");
		renameReplacing(repoB, fixture.sandbox.path("repo-b-offline"));
		await fixture.sandbox.git(fixture.sandbox.root, "clone", "-q", fixture.sandbox.path("repo-b.git"), repoB);
		fixture.sandbox.write(join(repoB, "README.md"), "this node's own work\n");
		const { runtime } = await runtimeOn(agentDir, {});

		const woken = await runtime.rehydrate(y);

		assert.equal(woken.sessionManager.getCwd(), repoA);
		const [restore, ...others] = woken.sessionManager.getWorktreeRootMappings();
		assert.deepEqual([restore?.from, others], [repoB, []]);
		assert.equal(readFileSync(join(restore!.to, "README.md"), "utf8"), "Y's edit\n");
		assert.equal(readFileSync(join(repoB, "README.md"), "utf8"), "this node's own work\n");
		assert.match(await readWithTools(woken, join(repoB, "README.md")), /Y's edit/);
		assert.match(await readWithTools(woken, join(repoA, "written-after-the-release.txt")), /later/);
	});

	test("two sessions woken in one process each resolve a checkout both recorded into their own restore (#4329)", async () => {
		const { repoB, x, y } = await sessionsSharingACheckout();
		renameReplacing(repoB, fixture.sandbox.path("repo-b-offline"));
		const { runtime } = await runtimeOn(fixture.sandbox.path("agent"), {});

		const wokenX = await runtime.rehydrate(x);
		const wokenY = await runtime.rehydrate(y);

		assert.match(await readWithTools(wokenX, join(repoB, "README.md")), /X's edit/);
		assert.match(await readWithTools(wokenY, join(repoB, "README.md")), /Y's edit/);
		await assert.rejects(readWithTools(runtime.session, join(repoB, "README.md")), /ENOENT|not found/i);
	});

	test("rehydrating again after a failed setup command builds the worktree it restored again (#4588)", async () => {
		const agentDir = fixture.sandbox.path("agent");
		const marker = fixture.sandbox.path("setup-runs");
		const { sessionId } = await sessionRecordedElsewhere(sqliteSelection("shared"), { "package-lock.json": "{}\n" });
		const failing = await runtimeOn(agentDir, {
			defaultProjectTrust: "always",
			resume: { setupCommand: nodeCommand("process.exit(3)") },
		});
		const failed = await failing.runtime.rehydrate(sessionId);
		const restored = failed.sessionManager.getCwd();
		assert.ok(restored.startsWith(join(agentDir, "worktree-snapshots")));
		assert.equal(existsSync(marker), false);
		const warnings = failing.runtime.takeResumeNotices();
		assert.equal(warnings.length, 2);
		assert.ok(warnings.every((notice) => notice.type === "warning"));
		assert.ok(warnings[0]?.message.startsWith("Blueprint build FAILED: "));
		assert.ok(warnings[1]?.message.startsWith("Deprecation warning: "));
		assert.deepEqual(failing.runtime.takeResumeNotices(), []);

		const { runtime } = await runtimeOn(agentDir, {
			defaultProjectTrust: "always",
			resume: { setupCommand: appendLineCommand(marker, "ran") },
		});
		const woken = await runtime.rehydrate(sessionId);

		assert.equal(woken.sessionManager.getCwd(), restored);
		assert.equal(readFileSync(marker, "utf8"), "ran\n");
	});

	/** A session that node B woke in a restored worktree, edited there and released again. */
	async function sessionEditedOnNodeB(agentDir: string) {
		const { clone, sessionId } = await sessionRecordedElsewhere(sqliteSelection("shared"));
		const { runtime } = await runtimeOn(agentDir, { resume: { setupCommand: "true" } });
		const onB = await runtime.rehydrate(sessionId);
		const worktree = onB.sessionManager.getCwd();
		fixture.sandbox.write(join(worktree, "README.md"), "edited on node B\n");
		const capture = await captureWorktreeSnapshot(worktree, {
			settings: DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
			blobs: onB.sessionManager.getSessionStore().snapshotBlobs,
		});
		if (capture.status !== "captured") throw new Error(capture.status);
		await onB.sessionManager.appendWorktreeSnapshot(worktree, capture.snapshot.id, capture.snapshot);
		await onB.release();
		return { clone, sessionId, runtime, worktree };
	}

	test("rehydrating after a failed setup command, with none configured now, still continues in the restored worktree (#4588)", async () => {
		const agentDir = fixture.sandbox.path("agent");
		const { sessionId } = await sessionRecordedElsewhere(sqliteSelection("shared"), { "package-lock.json": "{}\n" });
		const failing = await runtimeOn(agentDir, {
			defaultProjectTrust: "always",
			resume: { setupCommand: nodeCommand("process.exit(3)") },
		});
		const failed = await failing.runtime.rehydrate(sessionId);

		const { runtime } = await runtimeOn(agentDir, {});
		const woken = await runtime.rehydrate(sessionId);

		assert.equal(woken.sessionManager.getCwd(), failed.sessionManager.getCwd());
	});

	test("rehydrating a session in a worktree this node restored needs no Git", async () => {
		const { sessionId, runtime, worktree } = await sessionEditedOnNodeB(fixture.sandbox.path("agent"));
		setWorktreeSnapshotGit(async () => ({ path: fixture.sandbox.path("no-git"), env: {} }));

		const woken = await runtime.rehydrate(sessionId);

		assert.equal(woken.sessionManager.getCwd(), worktree);
	});

	test("rehydrating a session again on the node that restored it continues in that worktree as it is", async () => {
		const { sessionId, runtime, worktree } = await sessionEditedOnNodeB(fixture.sandbox.path("agent"));
		fixture.sandbox.write(join(worktree, "notes.txt"), "written after the release\n");

		const woken = await runtime.rehydrate(sessionId);

		assert.equal(woken.sessionManager.getCwd(), worktree);
		assert.equal(woken.sessionManager.getWorktreeRootMappings().length, 1);
		assert.equal(readFileSync(join(worktree, "notes.txt"), "utf8"), "written after the release\n");
	});

	test("rehydrating with snapshots turned off still continues in the worktree this node restored for the session", async () => {
		const agentDir = fixture.sandbox.path("agent");
		const { sessionId, worktree } = await sessionEditedOnNodeB(agentDir);
		const { runtime } = await runtimeOn(agentDir, { snapshots: { enabled: false } });

		const woken = await runtime.rehydrate(sessionId);

		assert.equal(woken.sessionManager.getCwd(), worktree);
	});

	test("rehydrating on the first node a session that worked on in node B's worktree continues from node B's work", async () => {
		const { clone, sessionId, runtime, worktree } = await sessionEditedOnNodeB(fixture.sandbox.path("agent"));
		renameReplacing(worktree, fixture.sandbox.path("node-b-offline"));
		renameReplacing(fixture.sandbox.path("node-a-offline"), clone);

		const woken = await runtime.rehydrate(sessionId);

		const cwd = woken.sessionManager.getCwd();
		assert.notEqual(cwd, clone);
		assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), "edited on node B\n");
		assert.equal(readFileSync(join(clone, "README.md"), "utf8"), "edited on node A\n");
	});

	test("rehydrating a session released on another node, on a node without Git, continues without its checkout (#4733)", async () => {
		const { sessionId } = await sessionRecordedElsewhere(sqliteSelection("shared"));
		const { runtime } = await runtimeOn(fixture.sandbox.path("agent"), {});
		setWorktreeSnapshotGit(async () => ({ path: fixture.sandbox.path("no-git"), env: {} }));
		const rehydrated = await runtime.rehydrate(sessionId);
		assert.equal(rehydrated.sessionManager.getSessionId(), sessionId);
		assert.equal(lastUnrestored(rehydrated.sessionManager)?.cause, "not-installed");
		assert.equal(existsSync(fixture.sandbox.path("agent", "worktree-snapshots", "worktrees")), false);
	});

	test("a rehydration whose shared storage does not answer fails at the lookup deadline", async () => {
		const { sessionId } = await sessionRecordedElsewhere(sqliteSelection("shared"));
		const { runtime } = await runtimeOn(fixture.sandbox.path("agent"), {});
		const store = runtime.session.sessionManager.getSessionStore();
		Object.defineProperty(store, "descriptor", {
			value: { ...store.descriptor, adapter: "libsql" },
			configurable: true,
		});
		store.readHeader = () => new Promise(() => {});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const pending = runtime.rehydrate(sessionId).then(
				() => undefined,
				(error: unknown) => error,
			);
			await vi.advanceTimersByTimeAsync(RESUME_CATALOG_TIMEOUT_MS);
			const error = await pending;
			assert.ok(isResumeCatalogTimeoutError(error), String(error));
			assert.deepEqual([error.subject, error.id], ["session", sessionId]);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("createAgentSession with a session recorded on another node (#4329)", () => {
	test("continues in a restored worktree after its setup command", async () => {
		const agentDir = fixture.sandbox.path("agent");
		const marker = fixture.sandbox.path("setup-ran");
		const selection = sqliteSelection("shared");
		const { clone, sessionId } = await sessionRecordedElsewhere(selection, { "package-lock.json": "{}\n" });
		const store = await storeFor(selection);
		const settingsManager = settings(appendLineCommand(marker, "ran"));
		const { createAgentSession } = await import("../src/core/sdk.js");
		const { getModel } = await import("@bastani/atomic-ai/compat");
		const { session } = await createAgentSession({
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			builtins: NO_BUILTINS,
			settingsManager,
			sessionManager: await SessionManager.open(store, sessionId),
		});
		cleanups.push(() => session.dispose());
		assert.deepEqual(extensionFilesLoadedBy(session), []);
		const cwd = session.sessionManager.getCwd();
		assert.ok(cwd.startsWith(join(agentDir, "worktree-snapshots", "worktrees")), cwd);
		assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), "edited on node A\n");
		// Without a UI the build runs behind the first turn (#4748).
		await blueprintBuildSettled(session.sessionManager.getSessionId());
		assert.equal(readFileSync(marker, "utf8"), "ran\n");
		assert.match(await readWithTools(session, join(clone, "README.md")), /edited on node A/);
	});

	test("a session opened inside a run's restores follows them in turns started outside the run (#4329)", async () => {
		const recorded = fixture.sandbox.path("recorded-on-node-a");
		const restored = fixture.sandbox.path("restored-for-the-run");
		fixture.sandbox.write(join(restored, "state.txt"), "in the run's restored worktree\n");
		const { createAgentSession } = await import("../src/core/sdk.js");
		const { getModel } = await import("@bastani/atomic-ai/compat");
		const restore = {
			from: recorded,
			to: restored,
			snapshotId: "s".repeat(64),
			tree: "t".repeat(40),
			restoredAt: "2026-11-07T00:00:00.000Z",
		};

		const { session } = await withWorktreeRootMappings([restore], () =>
			createAgentSession({
				agentDir: fixture.sandbox.path("agent"),
				cwd: restored,
				model: getModel("anthropic", "claude-sonnet-4-5")!,
				builtins: NO_BUILTINS,
				settingsManager: settings(),
				sessionManager: SessionManager.inMemory(restored),
			}),
		);
		cleanups.push(() => session.dispose());

		assert.match(await readWithTools(session, join(recorded, "state.txt")), /in the run's restored worktree/);
	});

	test("continues without the checkout, in the launch directory, when Git is missing (#4733)", async () => {
		const selection = sqliteSelection("shared");
		const { sessionId, clone } = await sessionRecordedElsewhere(selection);
		const store = await storeFor(selection);
		const { createAgentSession } = await import("../src/core/sdk.js");
		const { getModel } = await import("@bastani/atomic-ai/compat");
		setWorktreeSnapshotGit(async () => ({ path: fixture.sandbox.path("no-git"), env: {} }));
		const { session } = await createAgentSession({
			agentDir: fixture.sandbox.path("agent"),
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			builtins: NO_BUILTINS,
			settingsManager: settings(),
			sessionManager: await SessionManager.open(store, sessionId),
		});
		cleanups.push(() => session.dispose());
		const record = lastUnrestored(session.sessionManager);
		assert.equal(record?.cause, "not-installed");
		assert.notEqual(session.sessionManager.getCwd(), clone);
		assert.equal(session.sessionManager.getCwd(), record?.continuedIn);
	});

	const createOn = async (options: Partial<CreateAgentSessionOptions>) => {
		const { createAgentSession } = await import("../src/core/sdk.js");
		const { getModel } = await import("@bastani/atomic-ai/compat");
		const { session } = await createAgentSession({
			agentDir: fixture.sandbox.path("agent"),
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			builtins: NO_BUILTINS,
			...options,
		});
		cleanups.push(() => session.dispose());
		return session;
	};

	test("a supplied session bound with workspace is not prepared: the binding decides where it runs", async () => {
		const selection = sqliteSelection("shared");
		const { clone } = await fixture.sandbox.remoteWithClone("bound", { "README.md": "bound\n" });
		const bound = await resolveWorkspace(workspace({ repo: clone, branch: "feat/bound" }));
		const sub = join(bound.worktree, "sub");
		mkdirSync(sub);
		const store = await storeFor(selection);
		const sessionManager = await SessionManager.create(store, sub);
		await sessionManager.appendMessage({ role: "user", content: "edit", timestamp: Date.now() });
		const capture = await captureWorktreeSnapshot(bound.worktree, {
			settings: DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
			blobs: store.snapshotBlobs,
		});
		if (capture.status !== "captured") throw new Error(capture.status);
		await sessionManager.appendWorktreeSnapshot(bound.worktree, capture.snapshot.id, capture.snapshot);
		writeFileSync(join(bound.worktree, "README.md"), "changed after the snapshot\n");
		const session = await createOn({ settingsManager: settings(), sessionManager, workspace: bound });
		assert.deepEqual(session.sessionManager.getWorktreeRootMappings(), []);
		assert.equal(existsSync(fixture.sandbox.path("agent", "worktree-snapshots")), false);
		assert.equal(readFileSync(join(bound.worktree, "README.md"), "utf8"), "changed after the snapshot\n");
	});

	test("a trusted repository's blueprint maintenance runs for the restored worktree (#4588)", async () => {
		const marker = fixture.sandbox.path("setup-ran");
		const selection = sqliteSelection("shared");
		const { sessionId } = await sessionRecordedElsewhere(selection, {
			".atomic/blueprint.yaml": forThisHost(`maintenance: echo hook >> "${shellPath(marker)}"\n`),
		});
		const store = await storeFor(selection);
		const session = await createOn({
			settingsManager: SettingsManager.inMemory({ defaultProjectTrust: "always" }),
			sessionManager: await SessionManager.open(store, sessionId),
		});
		// Without a UI the build runs behind the first turn (#4748).
		await blueprintBuildSettled(session.sessionManager.getSessionId());
		assert.equal(readFileSync(marker, "utf8").trim(), "hook");
	});

	test("an untrusted repository's blueprint never runs, and the session still starts in the restored worktree (#4588)", async () => {
		const marker = fixture.sandbox.path("setup-ran");
		const selection = sqliteSelection("shared");
		const { sessionId } = await sessionRecordedElsewhere(selection, {
			".atomic/blueprint.yaml": forThisHost(`maintenance: echo hook >> "${shellPath(marker)}"\n`),
		});
		const store = await storeFor(selection);
		const session = await createOn({
			settingsManager: settings(),
			sessionManager: await SessionManager.open(store, sessionId),
		});
		assert.ok(
			session.sessionManager.getCwd().startsWith(fixture.sandbox.path("agent", "worktree-snapshots", "worktrees")),
		);
		// The build runs behind the first turn (#4748): only once it has settled does the missing marker mean it never ran.
		await blueprintBuildSettled(session.sessionManager.getSessionId());
		assert.equal(existsSync(marker), false);
	});

	test("an invalid storage selection fails before anything about a session recorded elsewhere is prepared", async () => {
		const marker = fixture.sandbox.path("setup-ran");
		const selection = sqliteSelection("shared");
		const { sessionId } = await sessionRecordedElsewhere(selection, { "package-lock.json": "{}\n" });
		const store = await storeFor(selection);
		const sessionManager = await SessionManager.open(store, sessionId);
		let gitResolutions = 0;
		const previousGit = setWorktreeSnapshotGit(async () => {
			gitResolutions++;
			return previousGit();
		});
		cleanups.push(() => {
			setWorktreeSnapshotGit(previousGit);
		});
		vi.stubEnv("ATOMIC_STORAGE", "{not json");
		cleanups.push(() => {
			vi.unstubAllEnvs();
		});
		await assert.rejects(
			createOn({ settingsManager: settings(appendLineCommand(marker, "ran")), sessionManager }),
			StorageConfigError,
		);
		await assert.rejects(
			openCliSession(
				parseArgs(["--session", sessionId]),
				fixture.sandbox.root,
				settings(appendLineCommand(marker, "ran")),
				{
					agentDir: fixture.sandbox.path("agent"),
					trusted: () => false,
				},
			),
			StorageConfigError,
		);
		assert.equal(gitResolutions, 0);
		assert.deepEqual(sessionManager.getWorktreeRootMappings(), []);
		assert.equal(existsSync(fixture.sandbox.path("agent", "worktree-snapshots")), false);
		assert.equal(existsSync(marker), false);
	});

	const countGitResolutions = () => {
		const counter = { resolutions: 0 };
		const previousGit = setWorktreeSnapshotGit(async () => {
			counter.resolutions++;
			return previousGit();
		});
		cleanups.push(() => {
			setWorktreeSnapshotGit(previousGit);
		});
		return counter;
	};

	test("a session whose checkout here still matches its snapshot starts there as recorded", async () => {
		const selection = sqliteSelection("shared");
		const { clone, sessionId } = await recordSessionWithSnapshot(selection);
		const store = await storeFor(selection);
		const session = await createOn({
			settingsManager: settings(),
			sessionManager: await SessionManager.open(store, sessionId),
		});
		assert.equal(session.sessionManager.getCwd(), clone);
		assert.deepEqual(session.sessionManager.getWorktreeRootMappings(), []);
		assert.equal(existsSync(fixture.sandbox.path("agent", "worktree-snapshots", "worktrees")), false);
	});

	test("a session whose recorded path holds a different tree here continues in a restored worktree, like the CLI", async () => {
		const selection = sqliteSelection("shared");
		const { clone, sessionId } = await recordSessionWithSnapshot(selection);
		await anotherCloneAtRecordedPath(clone);
		const store = await storeFor(selection);
		const session = await createOn({
			settingsManager: settings(),
			sessionManager: await SessionManager.open(store, sessionId),
		});
		const cwd = session.sessionManager.getCwd();
		assert.ok(cwd.startsWith(join(fixture.sandbox.path("agent"), "worktree-snapshots", "worktrees")), cwd);
		assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), "edited on node A\n");
		assert.equal(readFileSync(join(clone, "README.md"), "utf8"), "node B's own checkout at the same path\n");
		assert.deepEqual(
			session.sessionManager.getWorktreeRootMappings().map((mapping) => [mapping.from, mapping.to]),
			[[clone, cwd]],
		);
	});

	test("a session whose recorded path holds a different tree continues there untouched when Git is missing (#4733)", async () => {
		const selection = sqliteSelection("shared");
		const { clone, sessionId } = await recordSessionWithSnapshot(selection);
		await anotherCloneAtRecordedPath(clone);
		const store = await storeFor(selection);
		const sessionManager = await SessionManager.open(store, sessionId);
		setWorktreeSnapshotGit(async () => ({ path: fixture.sandbox.path("no-git"), env: {} }));
		const session = await createOn({ settingsManager: settings(), sessionManager });
		assert.equal(session.sessionManager.getCwd(), clone);
		assert.equal(readFileSync(join(clone, "README.md"), "utf8"), "node B's own checkout at the same path\n");
		assert.equal(lastUnrestored(session.sessionManager)?.cause, "not-installed");
		assert.deepEqual(session.sessionManager.getWorktreeRootMappings(), []);
		assert.equal(existsSync(fixture.sandbox.path("agent", "worktree-snapshots", "worktrees")), false);
	});

	test("the host's snapshots option decides whether a supplied session's checkout changed, and can turn preparation off", async () => {
		const selection = sqliteSelection("shared");
		const { clone } = await fixture.sandbox.remoteWithClone("repo", { "README.md": "hello\n" });
		fixture.sandbox.write(join(clone, "notes.txt"), "untracked and not recorded\n");
		const store = await storeFor(selection);
		const manager = await SessionManager.create(store, clone);
		await manager.appendMessage({ role: "user", content: "edit", timestamp: Date.now() });
		const capture = await captureWorktreeSnapshot(clone, {
			settings: { ...DEFAULT_WORKTREE_SNAPSHOT_SETTINGS, includeUntracked: false },
			blobs: store.snapshotBlobs,
		});
		if (capture.status !== "captured") throw new Error(capture.status);
		await manager.appendWorktreeSnapshot(clone, capture.snapshot.id, capture.snapshot);
		const sessionId = manager.getSessionId();

		const untrackedLeftOut = await createOn({
			settingsManager: settings(),
			snapshots: { includeUntracked: false },
			sessionManager: await SessionManager.open(store, sessionId),
		});
		assert.equal(untrackedLeftOut.sessionManager.getCwd(), clone);
		assert.deepEqual(untrackedLeftOut.sessionManager.getWorktreeRootMappings(), []);

		fixture.sandbox.write(join(clone, "README.md"), "changed after the snapshot\n");
		const git = countGitResolutions();
		const disabled = await createOn({
			settingsManager: settings(),
			snapshots: { enabled: false },
			sessionManager: await SessionManager.open(store, sessionId),
		});
		assert.equal(git.resolutions, 0);
		assert.equal(disabled.sessionManager.getCwd(), clone);
		assert.equal(existsSync(fixture.sandbox.path("agent", "worktree-snapshots")), false);
	});

	test("a supplied session without snapshots, or with an explicit cwd, costs no Git call", async () => {
		const selection = sqliteSelection("shared");
		const { clone, sessionId } = await recordSessionWithSnapshot(selection);
		fixture.sandbox.write(join(clone, "README.md"), "node B's own checkout at the same path\n");
		const store = await storeFor(selection);
		const plain = await SessionManager.create(store, clone);
		await plain.appendMessage({ role: "user", content: "no tool ran", timestamp: Date.now() });
		const git = countGitResolutions();

		const withoutSnapshots = await createOn({ settingsManager: settings(), sessionManager: plain });
		const explicitCwd = await createOn({
			cwd: clone,
			settingsManager: settings(),
			sessionManager: await SessionManager.open(store, sessionId),
		});

		assert.equal(git.resolutions, 0);
		assert.equal(withoutSnapshots.sessionManager.getCwd(), clone);
		assert.equal(explicitCwd.sessionManager.getCwd(), clone);
		assert.equal(existsSync(fixture.sandbox.path("agent", "worktree-snapshots")), false);
	});

	test("an explicit cwd keeps a session recorded elsewhere as supplied, and no session starts in process.cwd()", async () => {
		const selection = sqliteSelection("shared");
		const { clone, sessionId } = await sessionRecordedElsewhere(selection);
		const store = await storeFor(selection);
		const explicit = await createOn({
			cwd: fixture.sandbox.root,
			settingsManager: settings(),
			sessionManager: await SessionManager.open(store, sessionId),
		});
		assert.equal(explicit.sessionManager.getCwd(), clone);
		assert.equal((explicit as unknown as { _cwd: string })._cwd, fixture.sandbox.root);
		assert.equal(existsSync(fixture.sandbox.path("agent", "worktree-snapshots")), false);
		const fresh = await createOn({ settingsManager: settings() });
		assert.equal((fresh as unknown as { _cwd: string })._cwd, process.cwd());
	});
});
