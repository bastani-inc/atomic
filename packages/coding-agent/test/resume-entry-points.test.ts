import assert from "node:assert/strict";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test, vi } from "vitest";
import { parseArgs } from "../src/cli/args.js";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.js";
import { renameReplacing } from "../src/core/rename-retry.js";
import {
	blueprintBuildPending,
	blueprintBuildSettled,
	blueprintBuildsRunning,
} from "../src/core/resume/blueprint/barrier.js";
import { RESUME_CATALOG_TIMEOUT_MS } from "../src/core/resume/not-found.js";
import { sessionResumeOptions } from "../src/core/resume/session-resume.js";
import { getMissingStoredSessionCwdIssue } from "../src/core/session-cwd.js";
import { SessionManager } from "../src/core/session-manager.js";
import { resolveSessionStore } from "../src/core/session-storage.js";
import { worktreeRestoreNotices } from "../src/core/session-worktree-snapshots.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { StorageAdapterLoadError, StorageTransientError, StorageUnavailableError } from "../src/core/storage/errors.js";
import { resolveAdapterOptions, type StorageSelection } from "../src/core/storage/provider.js";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.js";
import type { SessionStore } from "../src/core/storage/session/types.js";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.js";
import {
	type GitUnavailableError,
	isResumeCatalogTimeoutError,
	isResumeCatalogUnavailableError,
	isResumePreconditionError,
	isWorkspaceRestoreError,
	type ResumePreflightIo,
	setWorktreeSnapshotGit,
} from "../src/index.js";
import {
	cliSessionStorageSelection,
	closeStoreAfter,
	createResumeProgress,
	openCliSession,
	startupResumeDiagnostics,
} from "../src/main-session.js";
import { IsolatedInteractiveRuntime } from "../src/modes/interactive-engine/isolated-runtime.js";
import { forThisHost } from "./helpers/blueprint-fixtures.js";
import { appendLineCommand, nodeCommand, shellPath } from "./helpers/hook-commands.js";
import { lastUnrestored, readWithTools, settings, useResumeEntryPointsFixture } from "./resume-entry-points-helpers.js";

const fixture = useResumeEntryPointsFixture();
const { cleanups, sqliteSelection, storeFor, recordSessionWithSnapshot, sessionRecordedElsewhere, runtimeOn } = fixture;

class CountingIo implements ResumePreflightIo {
	readonly calls: string[] = [];
	missing = false;
	async loadAdapter(module: string): Promise<void> {
		this.calls.push(`load:${module}`);
		if (this.missing) throw new StorageAdapterLoadError(module, new Error("Cannot find module"));
	}
	async readText(path: string): Promise<string> {
		this.calls.push(`read:${path}`);
		return "token";
	}
	env(name: string): string | undefined {
		this.calls.push(`env:${name}`);
		return undefined;
	}
	async probeGit(): Promise<GitUnavailableError | undefined> {
		this.calls.push("git");
		return undefined;
	}
}

/**
 * A session recorded elsewhere whose snapshot names a remote with credentials, as no capture writes: a record that
 * fails the security checks, so resuming it is refused (#4733).
 */
async function unsafeSessionRecordedElsewhere(selection: StorageSelection) {
	const recorded = await recordSessionWithSnapshot(selection, {}, ["https://user:token@example.invalid/repo.git"]);
	renameReplacing(recorded.clone, fixture.sandbox.path("node-a-offline"));
	return recorded;
}

/** The refusal of a resume whose snapshot record fails the security checks. */
function isRefusedRecord(error: unknown): boolean {
	return isWorkspaceRestoreError(error) && error.code === "invalid-snapshot" && error.reason === "unsafe-remote";
}

describe("openCliSession (#4329)", () => {
	test("resuming a cross-store fork explains where the parent history went (#5594)", async () => {
		const parent = SessionManager.inMemory(fixture.sandbox.root);
		await parent.appendMessage({ role: "user", content: "current", timestamp: 1 });
		const target = await resolveSessionStore(fixture.sandbox.root, {
			agentDir: fixture.sandbox.path("agent"),
			sessionStore: sqliteSelection("fork-target"),
		});
		cleanups.push(() => target.close());
		const child = await parent.forkTo(fixture.sandbox.root, target);
		await parent.getSessionStore().close();
		const reopened = await openCliSession(
			parseArgs(["--session", child.getSessionId()]),
			fixture.sandbox.root,
			settings(),
			{
				agentDir: fixture.sandbox.path("agent"),
				sessionStorage: target,
				trusted: () => false,
				claim: false,
			},
		);
		assert.notEqual(reopened, "cancelled");
		assert.ok(
			reopened !== "cancelled" &&
				reopened.notices.some(
					({ message }) => message === "Parent history is in its original store or is no longer available.",
				),
		);
	});

	test("a new session runs no resume preflight and prepares nothing", async () => {
		const io = new CountingIo();
		const opened = await openCliSession(parseArgs([]), fixture.sandbox.root, settings(), {
			agentDir: fixture.sandbox.path("agent"),
			sessionStorage: { kind: "adapter", module: "@acme/not-installed" } as StorageSelection,
			trusted: () => false,
			io,
		}).catch((error: unknown) => error);
		assert.deepEqual(io.calls, []);
		assert.equal(isResumePreconditionError(opened), false);
	});

	for (const flags of [["--continue"], ["--session", "abc"], ["--resume"]]) {
		test(`${flags[0]} fails before opening storage when its adapter is not installed`, async () => {
			const io = new CountingIo();
			io.missing = true;
			await assert.rejects(
				openCliSession(parseArgs(flags), fixture.sandbox.root, settings(), {
					agentDir: fixture.sandbox.path("agent"),
					sessionStorage: { kind: "adapter", module: "@acme/not-installed" },
					trusted: () => false,
					io,
				}),
				(error: unknown) => {
					assert.ok(isResumePreconditionError(error));
					assert.equal(error.entryPoint, "cli");
					assert.deepEqual(
						error.problems.map((problem) => problem.code),
						["adapter-not-installed"],
					);
					assert.match(error.problems[0]!.why, /^this node's sessions storage selects it/);
					return true;
				},
			);
			assert.deepEqual(io.calls, ["load:@acme/not-installed"]);
		});
	}

	test("a resume whose storage cannot be opened fails with that storage error, not a retryable lookup failure", async () => {
		fixture.sandbox.write(fixture.sandbox.path("not-a-directory"), "file");
		const unreachable: StorageSelection = {
			kind: "sqlite",
			path: fixture.sandbox.path("not-a-directory", "s.sqlite"),
		};
		const options = { agentDir: fixture.sandbox.path("agent"), sessionStorage: unreachable, trusted: () => false };
		await assert.rejects(
			openCliSession(parseArgs(["--session", "abc"]), fixture.sandbox.root, settings(), options),
			(error) => {
				assert.ok(error instanceof StorageUnavailableError, String(error));
				assert.equal(isResumeCatalogUnavailableError(error), false);
				assert.equal(error.adapter, "node-sqlite");
				return true;
			},
		);
		await assert.rejects(
			openCliSession(parseArgs(["--continue"]), fixture.sandbox.root, settings(), options),
			(error) => {
				assert.ok(error instanceof StorageUnavailableError, String(error));
				assert.equal(isResumeCatalogUnavailableError(error), false);
				return true;
			},
		);
		await assert.rejects(openCliSession(parseArgs([]), fixture.sandbox.root, settings(), options), (error) => {
			assert.equal(isResumeCatalogUnavailableError(error), false);
			return true;
		});
	});

	test("--session for a session recorded on another node restores its checkout and runs the configured setup command", async () => {
		const selection = sqliteSelection("shared");
		const { clone, sessionId } = await sessionRecordedElsewhere(selection, { "package-lock.json": "{}\n" });
		const marker = fixture.sandbox.path("setup-ran");
		const io = new CountingIo();
		const opened = await openCliSession(
			parseArgs(["--session", sessionId]),
			fixture.sandbox.root,
			settings(appendLineCommand(marker, "ran")),
			{
				agentDir: fixture.sandbox.path("agent"),
				sessionStorage: selection,
				trusted: () => true,
				io,
			},
		);
		assert.notEqual(opened, "cancelled");
		if (opened === "cancelled") return;
		cleanups.push(() => opened.sessionManager.getSessionStore().close());
		const cwd = opened.sessionManager.getCwd();
		assert.notEqual(cwd, clone);
		assert.ok(cwd.startsWith(join(fixture.sandbox.path("agent"), "worktree-snapshots", "worktrees")), cwd);
		assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), "edited on node A\n");
		assert.equal(readFileSync(marker, "utf8"), "ran\n");
		assert.match(opened.notices[0]!.message, /^Restored worktree snapshot/);
		assert.deepEqual(io.calls, ["git"]);
	});

	test("the user can cancel at the dirty-checkout prompt", async () => {
		const selection = sqliteSelection("shared");
		const { sessionId } = await sessionRecordedElsewhere(selection);
		const checkout = fixture.sandbox.path("node-b-checkout");
		renameReplacing(fixture.sandbox.path("node-a-offline"), checkout);
		fixture.sandbox.write(join(checkout, "README.md"), "user edit\n");
		const opened = await openCliSession(parseArgs(["--session", sessionId]), checkout, settings(), {
			agentDir: fixture.sandbox.path("agent"),
			sessionStorage: selection,
			trusted: () => false,
			chooseDirtyCheckout: async () => "cancel",
		});
		assert.equal(opened, "cancelled");
	});
});

describe("resume progress (#4660)", () => {
	function recordingProgress() {
		const events: string[] = [];
		return {
			events,
			progress: { phase: (message: string) => events.push(`phase:${message}`), done: () => events.push("done") },
		};
	}

	test("a resume tells its progress each step it starts and stops it once the session is ready (#4660)", async () => {
		const selection = sqliteSelection("shared");
		const { clone, sessionId } = await sessionRecordedElsewhere(selection);
		const { events, progress } = recordingProgress();
		const opened = await openCliSession(parseArgs(["--session", sessionId]), fixture.sandbox.root, settings(), {
			agentDir: fixture.sandbox.path("agent"),
			sessionStorage: selection,
			trusted: () => true,
			progress,
		});
		assert.notEqual(opened, "cancelled");
		if (opened !== "cancelled") cleanups.push(() => opened.sessionManager.getSessionStore().close());
		const restored = events.find((event) => event.startsWith("phase:Restoring "));
		assert.deepEqual(events, [
			"phase:Loading the session history",
			"phase:Checking 1 checkout against the session's snapshots",
			restored,
			"phase:Setting up the blueprints of restored worktrees",
			"done",
		]);
		assert.match(restored?.slice(`phase:Restoring ${clone} from snapshot `.length) ?? "", /^\w{12}$/);
		assert.ok(restored?.startsWith(`phase:Restoring ${clone} from snapshot `), restored);
	});

	test("a resume stops its progress before asking about a dirty checkout (#4660)", async () => {
		const selection = sqliteSelection("shared");
		const { sessionId } = await sessionRecordedElsewhere(selection);
		const checkout = fixture.sandbox.path("node-b-checkout");
		renameReplacing(fixture.sandbox.path("node-a-offline"), checkout);
		fixture.sandbox.write(join(checkout, "README.md"), "user edit\n");
		const { events, progress } = recordingProgress();
		const opened = await openCliSession(parseArgs(["--session", sessionId]), checkout, settings(), {
			agentDir: fixture.sandbox.path("agent"),
			sessionStorage: selection,
			trusted: () => false,
			progress,
			chooseDirtyCheckout: async () => {
				events.push("prompt");
				return "cancel";
			},
		});
		assert.equal(opened, "cancelled");
		assert.deepEqual(events.slice(-3), ["done", "prompt", "done"]);
	});

	test("only --session and --continue announce the history load (#4660)", async () => {
		const selection = sqliteSelection("shared");
		const { sessionId } = await recordSessionWithSnapshot(selection);
		for (const flags of [["--continue"], ["--session", sessionId], [], ["--fork", sessionId]]) {
			const { events, progress } = recordingProgress();
			const opened = await openCliSession(parseArgs(flags), fixture.sandbox.root, settings(), {
				agentDir: fixture.sandbox.path("agent"),
				sessionStorage: selection,
				trusted: () => true,
				progress,
			}).catch(() => "failed" as const);
			if (opened !== "cancelled" && opened !== "failed")
				cleanups.push(() => opened.sessionManager.getSessionStore().close());
			const loads = events.includes("phase:Loading the session history");
			assert.equal(loads, flags[0] === "--continue" || flags[0] === "--session", flags.join(" "));
		}
	});

	test("a resume that fails after loading still stops its progress (#4660)", async () => {
		const selection = sqliteSelection("shared");
		const { sessionId } = await unsafeSessionRecordedElsewhere(selection);
		const { events, progress } = recordingProgress();
		await assert.rejects(
			openCliSession(parseArgs(["--session", sessionId]), fixture.sandbox.root, settings(), {
				agentDir: fixture.sandbox.path("agent"),
				sessionStorage: selection,
				trusted: () => true,
				progress,
			}),
			isRefusedRecord,
		);
		assert.equal(events.at(-1), "done");
		assert.equal(events.filter((event) => event === "done").length, 1);
	});

	test("a long history is announced before it is read, not after (#4660)", async () => {
		const selection = sqliteSelection("shared");
		const { sessionId } = await recordSessionWithSnapshot(selection);
		const { events, progress } = recordingProgress();
		const atRead: string[][] = [];
		const prototype = SqlSessionStore.prototype as unknown as { readRows: (...args: unknown[]) => unknown };
		const original = prototype.readRows;
		const read = vi.spyOn(prototype, "readRows").mockImplementation(function (this: unknown, ...args: unknown[]) {
			atRead.push([...events]);
			return Reflect.apply(original, this, args);
		});
		cleanups.push(() => read.mockRestore());
		const opened = await openCliSession(parseArgs(["--session", sessionId]), fixture.sandbox.root, settings(), {
			agentDir: fixture.sandbox.path("agent"),
			sessionStorage: selection,
			trusted: () => true,
			progress,
			eagerHistoryEntries: 1,
		});
		if (opened !== "cancelled") cleanups.push(() => opened.sessionManager.getSessionStore().close());
		assert.ok(atRead.length > 0);
		assert.ok(
			atRead[0]?.some((event) => /^phase:Loading the session history \(\d+ entries\)$/.test(event)),
			JSON.stringify(atRead[0]),
		);
	});

	test("an announced step reaches the terminal's file descriptor synchronously (#4660)", () => {
		const file = fixture.sandbox.path("terminal.txt");
		const fd = openSync(file, "w");
		try {
			const progress = createResumeProgress("interactive", false, {
				isTTY: true,
				fd,
				write: () => {
					throw new Error("the stream's own write is asynchronous on some platforms");
				},
			});
			progress?.phase("Loading the session history (150000 entries)", { immediate: true });
			assert.match(readFileSync(file, "utf8"), /Loading the session history \(150000 entries\)…\r\n/);
		} finally {
			closeSync(fd);
		}
	});

	test("a short history is not announced before it is read (#4660)", async () => {
		const selection = sqliteSelection("shared");
		const { sessionId } = await recordSessionWithSnapshot(selection);
		const { events, progress } = recordingProgress();
		const opened = await openCliSession(parseArgs(["--session", sessionId]), fixture.sandbox.root, settings(), {
			agentDir: fixture.sandbox.path("agent"),
			sessionStorage: selection,
			trusted: () => true,
			progress,
		});
		if (opened !== "cancelled") cleanups.push(() => opened.sessionManager.getSessionStore().close());
		assert.ok(!events.some((event) => /entries\)$/.test(event)), JSON.stringify(events));
	});

	test("a failed lookup stops the progress too (#4660)", async () => {
		const { events, progress } = recordingProgress();
		await assert.rejects(
			openCliSession(parseArgs(["--session", "no-such-session"]), fixture.sandbox.root, settings(), {
				agentDir: fixture.sandbox.path("agent"),
				sessionStorage: sqliteSelection("shared"),
				trusted: () => true,
				progress,
			}),
		);
		assert.deepEqual(events, ["phase:Loading the session history", "done"]);
	});

	test("only an interactive host on a terminal shows resume progress (#4660)", () => {
		const terminal = { isTTY: true, write: () => true };
		assert.ok(createResumeProgress("interactive", false, terminal));
		assert.equal(createResumeProgress("interactive", true, terminal), undefined);
		assert.equal(createResumeProgress("interactive", false, { ...terminal, isTTY: false }), undefined);
		for (const mode of ["print", "json", "rpc"] as const)
			assert.equal(createResumeProgress(mode, false, terminal), undefined);
	});

	test("the progress an interactive host shows is written to its terminal (#4660)", () => {
		vi.useFakeTimers();
		try {
			const written: string[] = [];
			const progress = createResumeProgress("interactive", false, {
				isTTY: true,
				write: (text: string) => written.push(text) > 0,
			});
			progress?.phase("Loading the session history");
			vi.advanceTimersByTime(10_000);
			assert.equal(written.length, 1);
			assert.match(written[0] ?? "", /Loading the session history…/);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("openCliSession edge cases (#4329)", () => {
	test("a new CLI session gets no blueprint context, with a repository blueprint or only resume.setupCommand set (#4588)", async () => {
		fixture.sandbox.write(
			join(fixture.sandbox.root, ".atomic", "blueprint.yaml"),
			forThisHost("knowledge:\n  - name: test\n    contents: make test\n"),
		);
		for (const setupCommand of [undefined, "npm ci"]) {
			const opened = await openCliSession(parseArgs([]), fixture.sandbox.root, settings(setupCommand), {
				agentDir: fixture.sandbox.path("agent"),
				trusted: () => true,
			});
			assert.notEqual(opened, "cancelled");
			if (opened === "cancelled") return;
			cleanups.push(() => opened.sessionManager.getSessionStore().close());
			assert.equal(opened.sessionManager.getBranch().filter((entry) => entry.type === "custom_message").length, 0);
			assert.deepEqual(opened.notices, []);
		}
	});

	test("a session resumed with --continue still gets the blueprint context of its checkout (#4588)", async () => {
		const { clone } = await fixture.sandbox.remoteWithClone("continued", { "README.md": "hello\n" });
		fixture.sandbox.write(
			join(clone, ".atomic", "blueprint.yaml"),
			forThisHost("knowledge:\n  - name: test\n    contents: continue-fact\n"),
		);
		const store = await storeFor(sqliteSelection("continue"));
		const seed = await SessionManager.create(store, clone);
		await seed.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
		const opened = await openCliSession(parseArgs(["--continue"]), clone, settings(), {
			agentDir: fixture.sandbox.path("agent"),
			sessionStorage: store,
			trusted: () => true,
		});
		assert.notEqual(opened, "cancelled");
		if (opened === "cancelled") return;
		const contexts = opened.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom_message" && entry.customType === "blueprint-context");
		assert.equal(contexts.length, 1);
		assert.ok(contexts[0]?.type === "custom_message" && String(contexts[0].content).includes("continue-fact"));
	});

	test("a session forked with --fork gets the blueprint context of its checkout (#4588)", async () => {
		const { clone } = await fixture.sandbox.remoteWithClone("forked", { "README.md": "hello\n" });
		fixture.sandbox.write(
			join(clone, ".atomic", "blueprint.yaml"),
			forThisHost("knowledge:\n  - name: test\n    contents: fork-fact\n"),
		);
		const store = await storeFor(sqliteSelection("fork"));
		const source = await SessionManager.create(store, clone);
		await source.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
		const opened = await openCliSession(parseArgs(["--fork", source.getSessionId()]), clone, settings(), {
			agentDir: fixture.sandbox.path("agent"),
			sessionStorage: store,
			trusted: () => true,
		});
		assert.notEqual(opened, "cancelled");
		if (opened === "cancelled") return;
		assert.notEqual(opened.sessionManager.getSessionId(), source.getSessionId());
		const contexts = opened.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom_message" && entry.customType === "blueprint-context");
		assert.equal(contexts.length, 1);
		assert.ok(contexts[0]?.type === "custom_message" && String(contexts[0].content).includes("fork-fact"));
	});

	test("a resume from a store instance needs no storage preflight", async () => {
		const store = await storeFor(sqliteSelection("instance"));
		const io = new CountingIo();
		const opened = await openCliSession(parseArgs(["--continue"]), fixture.sandbox.root, settings(), {
			agentDir: fixture.sandbox.path("agent"),
			sessionStorage: store,
			trusted: () => false,
			io,
		});
		assert.notEqual(opened, "cancelled");
		assert.deepEqual(io.calls, []);
	});

	test("a restore with no setup command and no blueprint succeeds through the CLI (#4588)", async () => {
		const selection = sqliteSelection("shared");
		const { sessionId } = await sessionRecordedElsewhere(selection, { "package-lock.json": "{}\n" });
		const opened = await openCliSession(parseArgs(["--session", sessionId]), fixture.sandbox.root, settings(), {
			agentDir: fixture.sandbox.path("agent"),
			sessionStorage: selection,
			trusted: () => false,
		});
		assert.notEqual(opened, "cancelled");
		if (opened === "cancelled") return;
		cleanups.push(() => opened.sessionManager.getSessionStore().close());
		const cwd = opened.sessionManager.getCwd();
		assert.ok(cwd.startsWith(join(fixture.sandbox.path("agent"), "worktree-snapshots", "worktrees")), cwd);
		assert.ok(existsSync(cwd));
		assert.deepEqual(
			opened.notices.map((notice) => notice.type),
			["info"],
		);
	});

	test("the interactive engine child mirrors a resume its host built: one initialize, one context, $ENVRC kept, and a later resume still rebuilds (#4588)", async () => {
		const selection = sqliteSelection("shared");
		const counter = fixture.sandbox.path("initialize-runs.txt").replaceAll("\\", "/");
		const { sessionId } = await sessionRecordedElsewhere(selection, {
			".atomic/blueprint.yaml": forThisHost(
				[
					"initialize:",
					'  - run: echo "FROM_INITIALIZE=yes" >> "$ENVRC"',
					`  - run: echo run >> ${counter}`,
					"  - run: exit 7",
					"knowledge:",
					"  - name: test",
					"    contents: make test",
					"",
				].join("\n"),
			),
		});
		const resume = async (blueprints?: "build" | "skip") => {
			const opened = await openCliSession(parseArgs(["--session", sessionId]), fixture.sandbox.root, settings(), {
				agentDir: fixture.sandbox.path("agent"),
				sessionStorage: selection,
				trusted: () => true,
				blueprints,
			});
			assert.notEqual(opened, "cancelled");
			if (opened === "cancelled") throw new Error("cancelled");
			cleanups.push(() => opened.sessionManager.getSessionStore().close());
			return opened;
		};
		const runs = () => (existsSync(counter) ? readFileSync(counter, "utf8").trim().split("\n").length : 0);
		const contextsOf = (opened: Awaited<ReturnType<typeof resume>>) =>
			opened.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom_message" && entry.customType === "blueprint-context");
		const envrcFiles = () => {
			const directory = join(fixture.sandbox.path("agent"), "worktree-snapshots", "blueprint-env");
			return existsSync(directory) ? readdirSync(directory) : [];
		};

		const host = await resume();
		assert.equal(runs(), 1);
		assert.equal(host.notices.filter((notice) => notice.message.startsWith("Partial build: ")).length, 1);
		assert.equal(contextsOf(host).length, 1);
		assert.equal(envrcFiles().length, 1);

		const child = await resume("skip");
		assert.equal(child.sessionManager.getCwd(), host.sessionManager.getCwd());
		assert.equal(runs(), 1);
		assert.deepEqual(
			child.notices.filter((notice) => notice.message.startsWith("Partial build: ")),
			[],
		);
		assert.equal(contextsOf(child).length, 1);
		assert.equal(envrcFiles().length, 1);

		const later = await resume();
		assert.equal(runs(), 2);
		assert.equal(later.notices.filter((notice) => notice.message.startsWith("Partial build: ")).length, 1);
	});

	test("a resume that fails or is cancelled closes the store it opened, and a close failure never hides the resume failure", async () => {
		const selection = sqliteSelection("shared");
		const { sessionId } = await sessionRecordedElsewhere(selection, { "package-lock.json": "{}\n" });
		const checkout = fixture.sandbox.path("node-b-checkout");
		renameReplacing(fixture.sandbox.path("node-a-offline"), checkout);
		fixture.sandbox.write(join(checkout, "README.md"), "user edit\n");
		const unsafe = await recordSessionWithSnapshot(
			selection,
			{},
			["https://user:token@example.invalid/repo.git"],
			"unsafe",
		);
		rmSync(unsafe.clone, { recursive: true, force: true });
		const resume = (id: string, cwd: string) =>
			openCliSession(parseArgs(["--session", id]), cwd, settings(), {
				agentDir: fixture.sandbox.path("agent"),
				sessionStorage: selection,
				trusted: () => false,
				chooseDirtyCheckout: async () => "cancel",
			});
		const close = vi.spyOn(SqlSessionStore.prototype, "close");
		cleanups.push(() => close.mockRestore());

		await assert.rejects(resume(unsafe.sessionId, fixture.sandbox.root), isRefusedRecord);
		assert.equal(close.mock.calls.length, 1);
		assert.equal(await resume(sessionId, checkout), "cancelled");
		assert.equal(close.mock.calls.length, 2);

		const diskGone = new Error("disk gone");
		close.mockRejectedValue(diskGone);
		await assert.rejects(resume(unsafe.sessionId, fixture.sandbox.root), (error: unknown) => {
			assert.ok(isRefusedRecord(error));
			assert.equal((error as Error & { cleanupCause?: unknown }).cleanupCause, diskGone);
			assert.equal(Object.keys(error as object).includes("cleanupCause"), false);
			return true;
		});
		await assert.rejects(resume(sessionId, checkout), (error: unknown) => error === diskGone);
	});

	test("a resume that fails leaves a store the caller supplied open", async () => {
		const selection = sqliteSelection("shared");
		const { sessionId } = await unsafeSessionRecordedElsewhere(selection);
		const store = await storeFor(selection);
		const close = vi.spyOn(store, "close");
		cleanups.push(() => close.mockRestore());
		await assert.rejects(
			openCliSession(parseArgs(["--session", sessionId]), fixture.sandbox.root, settings(), {
				agentDir: fixture.sandbox.path("agent"),
				sessionStorage: store,
				trusted: () => false,
			}),
			isRefusedRecord,
		);
		assert.equal(close.mock.calls.length, 0);
	});

	test("closing after a failure that is not an Error keeps that failure and drops the close failure", async () => {
		const store = { close: async () => Promise.reject(new Error("disk gone")) };
		await closeStoreAfter(store, "stopped");
		await assert.rejects(closeStoreAfter(store), /disk gone/);
		await closeStoreAfter({ close: async () => {} });
	});
});

describe("resume helpers (#4329)", () => {
	test("only print-like modes report resume notices with the startup diagnostics", () => {
		const notices = [{ type: "info" as const, message: "Restored worktree snapshot 0123456789ab of /a into /b" }];
		assert.deepEqual(startupResumeDiagnostics("interactive", notices), []);
		for (const mode of ["print", "json", "rpc"] as const)
			assert.equal(startupResumeDiagnostics(mode, notices), notices);
	});

	test("the isolated interactive engine leaves resume notices to its host, which shows them once (#4660)", () => {
		const notices = [{ type: "warning" as const, message: "Resuming in /a, where this session worked" }];
		assert.deepEqual(startupResumeDiagnostics("rpc", notices, true), []);
		assert.equal(startupResumeDiagnostics("rpc", notices, false), notices);
	});

	test("sessionResumeOptions reads snapshot settings and the setup command", () => {
		const trusted = (worktree: string) => worktree === "/trusted";
		const options = sessionResumeOptions(
			"switch-session",
			"/launch",
			"/home/u/.atomic/agent",
			settings(" npm ci "),
			trusted,
		);
		assert.equal(options.storeDir, join("/home/u/.atomic/agent", "worktree-snapshots"));
		assert.equal(options.entryPoint, "switch-session");
		assert.equal(options.launchCwd, "/launch");
		assert.deepEqual(options.settings, DEFAULT_WORKTREE_SNAPSHOT_SETTINGS);
		assert.deepEqual(options.blueprint, {
			agentDir: "/home/u/.atomic/agent",
			setupCommand: "npm ci",
			trusted,
		});
		assert.equal(settings("   ").getResumeSetupCommand(), undefined);
		assert.equal(SettingsManager.inMemory({ resume: {} }).getResumeSetupCommand(), undefined);
		assert.equal(settings().getResumeSetupCommand(), undefined);
	});

	test("cliSessionStorageSelection is the selection the CLI opens, or undefined for a store instance", async () => {
		const selection = sqliteSelection("x");
		assert.deepEqual(
			cliSessionStorageSelection(parseArgs([]), fixture.sandbox.root, settings(), selection),
			selection,
		);
		const store = await storeFor(sqliteSelection("y"));
		assert.equal(cliSessionStorageSelection(parseArgs([]), fixture.sandbox.root, settings(), store), undefined);
		assert.deepEqual(cliSessionStorageSelection(parseArgs(["--no-session"]), fixture.sandbox.root, settings()), {
			kind: "memory",
		});
	});

	test("a stored session whose recorded cwd is missing here is reported; new, file and memory sessions are not", async () => {
		const stored = await SessionManager.create(await storeFor(sqliteSelection("s")), fixture.sandbox.path("gone"));
		assert.equal(getMissingStoredSessionCwdIssue(stored, fixture.sandbox.root), undefined);
		await stored.appendMessage({ role: "user", content: "x", timestamp: Date.now() });
		assert.deepEqual(getMissingStoredSessionCwdIssue(stored, fixture.sandbox.root), {
			sessionCwd: fixture.sandbox.path("gone"),
			fallbackCwd: fixture.sandbox.root,
		});
		mkdirSync(fixture.sandbox.path("gone"));
		assert.equal(getMissingStoredSessionCwdIssue(stored, fixture.sandbox.root), undefined);
		const memory = SessionManager.inMemory(fixture.sandbox.path("missing"));
		await memory.appendMessage({ role: "user", content: "x", timestamp: Date.now() });
		assert.equal(getMissingStoredSessionCwdIssue(memory, fixture.sandbox.root), undefined);
		const withFile = {
			getSessionFile: () => "/s.jsonl",
			getCwd: () => fixture.sandbox.path("missing"),
			isPersisted: () => true,
			getEntries: () => [{}],
		};
		assert.equal(getMissingStoredSessionCwdIssue(withFile, fixture.sandbox.root), undefined);
		const noCwd = {
			getSessionFile: () => undefined,
			getCwd: () => "",
			isPersisted: () => true,
			getEntries: () => [{}],
		};
		assert.equal(getMissingStoredSessionCwdIssue(noCwd, fixture.sandbox.root), undefined);
	});

	test("a relative token file in an adapter selection resolves against Atomic home", async () => {
		const agentDir = fixture.sandbox.path("home", "agent");
		fixture.sandbox.write(fixture.sandbox.path("home", "team-token"), "secret\n");
		const options = await resolveAdapterOptions(
			{ kind: "adapter", module: "x", secrets: { authToken: { file: "team-token" } } },
			{ agentDir, domain: "sessions" },
		);
		assert.equal(options.authToken, "secret");
	});
});

describe("AgentSessionRuntime.switchSession across nodes (#4329)", () => {
	test("the isolated host mirrors a /resume its engine prepared: it builds nothing and shows the engine's warnings once (#4588)", async () => {
		const agentDir = fixture.sandbox.path("agent");
		const counter = fixture.sandbox.path("mirror-runs.txt").replaceAll("\\", "/");
		const { sessionId } = await sessionRecordedElsewhere(sqliteSelection("shared"), {
			".atomic/blueprint.yaml": forThisHost(`maintenance: echo run >> ${counter}\n`),
		});
		const { runtime, createRuntime } = await runtimeOn(agentDir, { defaultProjectTrust: "always" });
		const engineWarning = { type: "warning" as const, message: "Partial build: the engine's own warning" };
		const client = {
			onEvent: () => () => {},
			onGenerationEnded: () => () => {},
			switchSession: async () => ({ cancelled: false, notices: [engineWarning] }),
			getState: async () => ({
				sessionId,
				thinkingLevel: "off",
				isStreaming: false,
				isCompacting: false,
				steeringMode: "all",
				followUpMode: "all",
				autoCompactionEnabled: true,
				compaction: { state: "idle" },
				backgroundCompactionEnabled: true,
				backgroundCompactionThresholdPercent: 75,
				messageCount: 0,
				pendingMessageCount: 0,
				queuedMessagesPaused: false,
			}),
			requestInternal: async () => ({ models: [], scopedModels: [] }),
			getCommands: async () => [],
			stop: async () => {},
		};
		const host = new IsolatedInteractiveRuntime(runtime, createRuntime, client as never);

		assert.deepEqual(await host.switchSession(sessionId), { cancelled: false });

		assert.ok(host.session.sessionManager.getCwd().startsWith(join(agentDir, "worktree-snapshots")));
		assert.equal(existsSync(counter), false);
		assert.deepEqual(host.takeResumeNotices(), [engineWarning]);
		assert.deepEqual(host.takeResumeNotices(), []);
		assert.equal(
			host.session.sessionManager.getBranch().filter((entry) => entry.type === "custom_message").length,
			0,
		);
	});

	test("/resume of a session recorded on another node continues in a restored worktree after its setup command", async () => {
		const agentDir = fixture.sandbox.path("agent");
		const marker = fixture.sandbox.path("setup-ran");
		const { clone, sessionId } = await sessionRecordedElsewhere(sqliteSelection("shared"), {
			"package-lock.json": "{}\n",
		});
		const { runtime, createRuntime } = await runtimeOn(agentDir, {
			defaultProjectTrust: "always",
			resume: { setupCommand: appendLineCommand(marker, "ran") },
		});

		assert.deepEqual(await runtime.switchSession(sessionId), { cancelled: false });
		const cwd = runtime.session.sessionManager.getCwd();
		assert.notEqual(cwd, clone);
		assert.ok(cwd.startsWith(join(agentDir, "worktree-snapshots")), cwd);
		assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), "edited on node A\n");
		assert.equal(readFileSync(marker, "utf8"), "ran\n");
		assert.equal(existsSync(clone), false);

		assert.match(await readWithTools(runtime.session, join(clone, "README.md")), /edited on node A/);
		const reopened = await createRuntime({ cwd, agentDir, sessionManager: runtime.session.sessionManager });
		cleanups.push(() => reopened.session.dispose());
		assert.match(await readWithTools(reopened.session, join(clone, "README.md")), /edited on node A/);
	});

	test("a trusted repository's blueprint maintenance runs when the default trust is always (#4588)", async () => {
		const agentDir = fixture.sandbox.path("agent");
		const { sessionId } = await sessionRecordedElsewhere(sqliteSelection("shared"), {
			".atomic/blueprint.yaml": forThisHost("maintenance: echo hook > ../hook-ran\n"),
		});
		const { runtime } = await runtimeOn(agentDir, { defaultProjectTrust: "always" });
		assert.deepEqual(await runtime.switchSession(sessionId), { cancelled: false });
		const cwd = runtime.session.sessionManager.getCwd();
		assert.equal(readFileSync(join(cwd, "..", "hook-ran"), "utf8").trim(), "hook");
	});

	test("an untrusted repository's blueprint and the setup command never run, and the resume still succeeds (#4588)", async () => {
		const agentDir = fixture.sandbox.path("agent");
		const marker = fixture.sandbox.path("command-ran");
		const { sessionId } = await sessionRecordedElsewhere(sqliteSelection("shared"), {
			".atomic/blueprint.yaml": forThisHost("maintenance: echo hook > ../hook-ran\n"),
		});
		const { runtime } = await runtimeOn(agentDir, { resume: { setupCommand: appendLineCommand(marker, "ran") } });
		assert.deepEqual(await runtime.switchSession(sessionId), { cancelled: false });
		const cwd = runtime.session.sessionManager.getCwd();
		assert.ok(cwd.startsWith(join(agentDir, "worktree-snapshots")), cwd);
		assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), "edited on node A\n");
		assert.equal(existsSync(join(cwd, "..", "hook-ran")), false);
		assert.equal(existsSync(marker), false);
	});

	test("a runtime not told of a UI switches into a restored worktree while its blueprint build runs (#4748)", async () => {
		const agentDir = fixture.sandbox.path("agent");
		const gate = fixture.sandbox.path("gate");
		const { sessionId } = await sessionRecordedElsewhere(sqliteSelection("shared"));
		const { runtime } = await runtimeOn(
			agentDir,
			{
				defaultProjectTrust: "always",
				resume: {
					setupCommand: nodeCommand(
						`(function wait(){require('fs').existsSync('${shellPath(gate)}')||setTimeout(wait,20)})()`,
					),
				},
			},
			"unset",
		);
		assert.deepEqual(await runtime.switchSession(sessionId), { cancelled: false });
		assert.ok(runtime.session.sessionManager.getCwd().startsWith(join(agentDir, "worktree-snapshots")));
		assert.equal(blueprintBuildPending(sessionId), true, "the build still runs and holds the session's tools");
		writeFileSync(gate, "");
		await blueprintBuildSettled(sessionId);
	});

	test("disposing a runtime during the build stops the build before it closes the session (#4748)", async () => {
		const agentDir = fixture.sandbox.path("agent");
		const gate = fixture.sandbox.path("gate");
		const { sessionId } = await sessionRecordedElsewhere(sqliteSelection("shared"));
		const { runtime } = await runtimeOn(
			agentDir,
			{
				defaultProjectTrust: "always",
				resume: {
					setupCommand: nodeCommand(
						`(function wait(){require('fs').existsSync('${shellPath(gate)}')||setTimeout(wait,20)})()`,
					),
				},
			},
			"unset",
		);
		assert.deepEqual(await runtime.switchSession(sessionId), { cancelled: false });
		const session = runtime.session as unknown as { readonly _disposed: boolean };
		assert.equal(blueprintBuildsRunning(), true);
		await runtime.dispose();
		assert.equal(blueprintBuildsRunning(), false, "the build was stopped");
		assert.equal(session._disposed, true, "and the session closed after it");
		writeFileSync(gate, "");
	});

	test("/resume with a failing initialize step still resumes in the restored worktree, hands its warning over once and gives the agent the failure (#4588)", async () => {
		const agentDir = fixture.sandbox.path("agent");
		const { sessionId } = await sessionRecordedElsewhere(sqliteSelection("shared"), {
			".atomic/blueprint.yaml": forThisHost(
				[
					"initialize:",
					"  - name: Install toolchain",
					"    run: exit 7",
					"maintenance: echo hook > ../hook-ran",
					"knowledge:",
					"  - name: test",
					"    contents: make test",
					"",
				].join("\n"),
			),
		});
		const { runtime } = await runtimeOn(agentDir, { defaultProjectTrust: "always" });

		assert.deepEqual(await runtime.switchSession(sessionId), { cancelled: false });

		const cwd = runtime.session.sessionManager.getCwd();
		assert.ok(cwd.startsWith(join(agentDir, "worktree-snapshots")), cwd);
		assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), "edited on node A\n");
		assert.equal(existsSync(join(cwd, "..", "hook-ran")), false);
		const notices = runtime.takeResumeNotices();
		assert.equal(notices.length, 1);
		assert.equal(notices[0]?.type, "warning");
		assert.match(notices[0]?.message ?? "", /^Partial build: .*Install toolchain/);
		assert.deepEqual(runtime.takeResumeNotices(), []);
		const context = runtime.session.sessionManager
			.getBranch()
			.flatMap((entry) =>
				entry.type === "custom_message" && entry.customType === "blueprint-context" ? [String(entry.content)] : [],
			);
		assert.equal(context.length, 1);
		assert.match(context[0] ?? "", /NOT RUN: the build of this blueprint failed before its maintenance/);
		assert.match(context[0] ?? "", /make test/);
	});

	for (const checkout of ["restored", "already here"] as const) {
		test(`/resume shows the one notice of a checkout whose snapshot record is missing when the other checkout is ${checkout} (#4744)`, async () => {
			const agentDir = fixture.sandbox.path("agent");
			const { sessionId } = await (checkout === "restored" ? sessionRecordedElsewhere : recordSessionWithSnapshot)(
				sqliteSelection("shared"),
			);
			const other = await fixture.sandbox.remoteWithClone("other", { "README.md": "other\n" });
			const store = await storeFor(sqliteSelection("shared"));
			const manager = await SessionManager.open(store, sessionId);
			const { lastSeq } = await store.load(sessionId);
			await store.append(
				sessionId,
				[
					{
						type: "worktree_snapshot",
						id: "ghost-entry",
						parentId: manager.getLeafId(),
						timestamp: new Date().toISOString(),
						root: other.clone,
						snapshotId: "0123456789abcdef0123456789abcdef",
					},
				],
				{ expectSeq: lastSeq },
			);
			const { runtime } = await runtimeOn(agentDir, {});
			const since = new Date().toISOString();

			assert.deepEqual(await runtime.switchSession(sessionId), { cancelled: false });

			// What the TUI shows after /resume: the notices the session records, then those the runtime collected.
			const shown = [
				...worktreeRestoreNotices(runtime.session.sessionManager, since),
				...runtime.takeResumeNotices(),
			].filter((notice) => /holds no record of its snapshot 0123456789ab/.test(notice.message));
			assert.equal(shown.length, 1, JSON.stringify(shown));
			assert.ok(shown[0]!.message.includes(other.clone), shown[0]!.message);
			assert.deepEqual(runtime.takeResumeNotices(), []);
		});
	}

	function aroundReads(store: SessionStore, around: <T>(read: () => Promise<T>) => Promise<T>): void {
		const load = store.load.bind(store);
		store.load = (id) => around(() => load(id));
		const { readTail, readRange, findLatestCompaction, readResume } = store;
		if (readResume) store.readResume = (id, leafId) => around(() => readResume.call(store, id, leafId));
		if (readTail) store.readTail = (id, fromSeq) => around(() => readTail.call(store, id, fromSeq));
		if (readRange) store.readRange = (id, start, end) => around(() => readRange.call(store, id, start, end));
		if (findLatestCompaction)
			store.findLatestCompaction = (id, leafId) => around(() => findLatestCompaction.call(store, id, leafId));
	}

	function slowStore(runtime: AgentSessionRuntime, adapter: string, delayMs: number): SessionStore {
		const store = runtime.session.sessionManager.getSessionStore();
		const descriptor = { ...store.descriptor, adapter };
		Object.defineProperty(store, "descriptor", { value: descriptor, configurable: true });
		aroundReads(
			store,
			(read) =>
				new Promise((resolveRead, rejectRead) => setTimeout(() => read().then(resolveRead, rejectRead), delayMs)),
		);
		return store;
	}

	test("a /resume whose shared storage does not answer fails retryable at the lookup deadline and keeps the session", async () => {
		const { sessionId } = await sessionRecordedElsewhere(sqliteSelection("shared"));
		const { runtime } = await runtimeOn(fixture.sandbox.path("agent"), {});
		const before = runtime.session.sessionId;
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			slowStore(runtime, "postgres", RESUME_CATALOG_TIMEOUT_MS * 2);
			const pending = runtime.switchSession(sessionId).then(
				() => undefined,
				(error: unknown) => error,
			);
			await vi.advanceTimersByTimeAsync(RESUME_CATALOG_TIMEOUT_MS);
			const error = await pending;
			assert.ok(isResumeCatalogTimeoutError(error), String(error));
			assert.deepEqual(
				[error.subject, error.id, error.storage, error.timeoutMs, error.retryable],
				["session", sessionId, "postgres", RESUME_CATALOG_TIMEOUT_MS, true],
			);
		} finally {
			vi.useRealTimers();
		}
		assert.equal(runtime.session.sessionId, before);
	});

	test("a /resume from storage only this node reads sets no lookup deadline", async () => {
		const { sessionId } = await sessionRecordedElsewhere(sqliteSelection("shared"));
		const { runtime } = await runtimeOn(fixture.sandbox.path("agent"), { resume: { setupCommand: "true" } });
		const store = runtime.session.sessionManager.getSessionStore();
		assert.equal(store.descriptor.adapter, "node-sqlite");
		let release!: () => void;
		let loading!: () => void;
		const released = new Promise<void>((resolveRelease) => {
			release = resolveRelease;
		});
		const loadStarted = new Promise<void>((resolveLoading) => {
			loading = resolveLoading;
		});
		aroundReads(store, async (read) => {
			loading();
			await released;
			return read();
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		let switched: Promise<{ cancelled: boolean }>;
		try {
			switched = runtime.switchSession(sessionId);
			await loadStarted;
			assert.equal(vi.getTimerCount(), 0, "no deadline waits on the lookup");
		} finally {
			vi.useRealTimers();
		}
		release();
		assert.deepEqual(await switched, { cancelled: false });
		assert.equal(runtime.session.sessionId, sessionId);
	});

	test("a /resume whose shared storage cannot be reached fails as a retryable lookup error for the session", async () => {
		const { sessionId } = await sessionRecordedElsewhere(sqliteSelection("shared"));
		const { runtime } = await runtimeOn(fixture.sandbox.path("agent"), {});
		const store = runtime.session.sessionManager.getSessionStore();
		Object.defineProperty(store, "descriptor", {
			value: { ...store.descriptor, adapter: "postgres" },
			configurable: true,
		});
		const unreachable = new StorageTransientError(
			{ adapter: "postgres", location: "remote" },
			{ code: "connection-lost", outcome: "not-applied", attempts: 1 },
			new Error("ECONNRESET"),
		);
		aroundReads(store, () => Promise.reject(unreachable));
		await assert.rejects(runtime.switchSession(sessionId), (error: unknown) => {
			assert.ok(isResumeCatalogUnavailableError(error), String(error));
			assert.deepEqual(
				[error.subject, error.id, error.retryable, error.cause],
				["session", sessionId, true, unreachable],
			);
			return true;
		});
	});

	test("a /resume that needs a restore on a node without Git opens the session without its checkout (#4733)", async () => {
		const { sessionId } = await sessionRecordedElsewhere(sqliteSelection("shared"));
		const { runtime } = await runtimeOn(fixture.sandbox.path("agent"), {});
		setWorktreeSnapshotGit(async () => ({ path: fixture.sandbox.path("no-git"), env: {} }));
		const switched = await runtime.switchSession(sessionId);
		assert.equal(switched.cancelled, false);
		const record = lastUnrestored(runtime.session.sessionManager);
		assert.equal(record?.cause, "not-installed");
		assert.equal(record?.place, "launch");
		assert.equal(runtime.session.sessionManager.getCwd(), record?.continuedIn);
	});
});

describe("bounded catalog lookups (#4329)", () => {
	test("a resume whose shared storage never answers fails within the deadline, before the session lookup", async () => {
		const adapter = fixture.sandbox.path("hanging-adapter.mjs");
		fixture.sandbox.write(
			adapter,
			`export const atomicStorageAdapter = 1;
export async function openSessionStore() {
	return {
		descriptor: { adapter: "hanging", location: "nowhere" },
		readHeader(id) { globalThis.__atomicHangingRead(id); return new Promise(() => {}); },
		async close() {},
	};
}
`,
		);
		const reads: string[] = [];
		const global = globalThis as { __atomicHangingRead?: (id: string) => void };
		const reading = new Promise<void>((resolve) => {
			global.__atomicHangingRead = (id) => {
				reads.push(id);
				resolve();
			};
		});
		const io = new CountingIo();
		// The deadline's clock moves only once the probe waits on the storage, so a host slow to load the adapter
		// cannot spend the 100 ms before the read starts.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const opening = openCliSession(parseArgs(["--session", "abc"]), fixture.sandbox.root, settings(), {
				agentDir: fixture.sandbox.path("agent"),
				sessionStorage: { kind: "adapter", module: adapter },
				trusted: () => false,
				io,
				catalogTimeoutMs: 100,
			}).then(
				() => assert.fail("the storage never answers"),
				(error: unknown) => error,
			);
			await reading;
			await vi.advanceTimersByTimeAsync(100);
			const error = await opening;
			assert.ok(isResumeCatalogTimeoutError(error));
			assert.deepEqual([error.subject, error.id, error.timeoutMs], ["session", "abc", 100]);
			assert.equal(
				error.hint,
				"Check that this node can reach the shared storage (`atomic storage status`), then resume again; nothing was changed.",
			);
		} finally {
			vi.useRealTimers();
			delete global.__atomicHangingRead;
		}
		assert.deepEqual(reads, ["abc"]);
		assert.deepEqual(io.calls, [`load:${adapter}`]);
	});

	test("a probe the storage answers with a failure is a retryable lookup error, and the probe's store is closed", async () => {
		const adapter = fixture.sandbox.path("probe-adapter.mjs");
		fixture.sandbox.write(
			adapter,
			`export const atomicStorageAdapter = 1;
export async function openSessionStore() {
	const probe = globalThis.__atomicProbe;
	return {
		descriptor: { adapter: "probe", location: "test" },
		readHeader(id) { probe.reads.push(id); return probe.read(id); },
		async close() { probe.closes += 1; },
	};
}
`,
		);
		const unavailable = new StorageTransientError(
			{ adapter: "probe", location: "test" },
			{ code: "connection-lost", outcome: "not-applied", attempts: 1 },
			new Error("ECONNRESET"),
		);
		const probe = { reads: [] as string[], closes: 0, read: async () => Promise.reject(unavailable) };
		(globalThis as { __atomicProbe?: typeof probe }).__atomicProbe = probe;
		cleanups.push(() => {
			delete (globalThis as { __atomicProbe?: typeof probe }).__atomicProbe;
		});
		const open = (args: string[]) =>
			openCliSession(parseArgs(args), fixture.sandbox.root, settings(), {
				agentDir: fixture.sandbox.path("agent"),
				sessionStorage: { kind: "adapter", module: adapter },
				trusted: () => false,
				io: new CountingIo(),
			});
		await assert.rejects(open(["--session", "abc"]), (error: unknown) => {
			assert.ok(isResumeCatalogUnavailableError(error));
			assert.deepEqual(
				[error.subject, error.id, error.storage, error.cause],
				["session", "abc", "probe", unavailable],
			);
			return true;
		});
		await assert.rejects(open(["--continue"]), (error: unknown) => {
			assert.ok(isResumeCatalogUnavailableError(error));
			assert.equal(error.id, null);
			return true;
		});
		assert.equal(probe.reads[0], "abc");
		assert.match(probe.reads[1] ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		assert.equal(probe.reads.length, 2);
		assert.equal(probe.closes, 2);
	});
});
