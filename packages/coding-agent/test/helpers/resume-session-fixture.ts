import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { useTemporaryAgentDir } from "../../../../test/helpers/temporary-agent-dir.js";
import { GitSandbox } from "../../../../test/helpers/worktree-snapshot.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { openNodeSqliteDatabase } from "../../src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../../src/core/storage/session/sql-session-store.js";
import type { SessionStore } from "../../src/core/storage/session/types.js";
import { resolveToCwd } from "../../src/core/tools/path-utils.js";
import { captureWorktreeSnapshot } from "../../src/core/worktree-snapshot/capture.js";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../../src/core/worktree-snapshot/settings.js";
import {
	type GitUnavailableError,
	isWorkspaceSnapshotError,
	type PreparedSessionResume,
	type PrepareSessionResumeOptions,
	type ResumePreflightIo,
	withWorktreeRootMappings,
} from "../../src/index.js";
import { appendLineCommand } from "./hook-commands.js";

/** The shared fixture of the resume-session test files: a Git sandbox per test and the sessions recorded in it. */
export const settings = DEFAULT_WORKTREE_SNAPSHOT_SETTINGS;
export let sandbox: GitSandbox;
export const cleanups: Array<() => Promise<void> | void> = [];

/** Registers the agent directory and the per-test sandbox; call once at the top of each test file. */
export function useResumeSessionSandbox(): void {
	useTemporaryAgentDir();
	beforeEach(() => {
		sandbox = new GitSandbox();
	});
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
		sandbox.dispose();
	});
}

/** `path` as the tools of the session `manager` resolve it for work in `cwd`. */
export function resolveForSession(manager: SessionManager, path: string, cwd: string): string {
	return withWorktreeRootMappings(manager.getWorktreeRootMappings(), () => resolveToCwd(path, cwd));
}

export async function sqlStore(name: string): Promise<SessionStore> {
	const database = await openNodeSqliteDatabase(sandbox.path(`${name}.sqlite`));
	const store = await SqlSessionStore.open(database);
	cleanups.push(async () => {
		await store.close();
		await database.close();
	});
	return store;
}

/** A session on "node A" whose last turn recorded a snapshot of `root`, with its cwd at `cwd`. */
export async function recordSession(
	root: string,
	cwd = root,
	siblings: readonly string[] = [],
): Promise<SessionManager> {
	const store = await sqlStore("sessions");
	const manager = await SessionManager.create(store, cwd);
	await manager.appendMessage({ role: "user", content: "edit the files", timestamp: Date.now() });
	const capture = await captureWorktreeSnapshot(root, { settings, blobs: store.snapshotBlobs });
	assert.equal(capture.status, "captured");
	if (capture.status !== "captured") throw new Error("unreachable");
	await manager.appendWorktreeSnapshot(root, capture.snapshot.id, capture.snapshot);
	for (const sibling of siblings) {
		const recorded = await captureWorktreeSnapshot(sibling, { settings, blobs: store.snapshotBlobs });
		assert.equal(recorded.status, "captured");
		if (recorded.status !== "captured") throw new Error("unreachable");
		await manager.appendWorktreeSnapshot(sibling, recorded.snapshot.id, recorded.snapshot);
	}
	return manager;
}

/** A clone with an unpushed commit, an uncommitted edit, an untracked file and a lockfile, as scenario 1 records. */
export async function editedClone() {
	const { clone } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n", "package-lock.json": "{}\n" });
	sandbox.write(join(clone, "committed.txt"), "unpushed\n");
	const head = await sandbox.commitAll(clone, "unpushed commit");
	sandbox.write(join(clone, "README.md"), "edited\n");
	sandbox.write(join(clone, "notes", "untracked.txt"), "untracked\n");
	return { clone, head };
}

export class CountingGitIo implements ResumePreflightIo {
	probes = 0;
	constructor(private readonly gitError?: GitUnavailableError) {}
	async loadAdapter(): Promise<void> {}
	async readText(): Promise<string> {
		return "";
	}
	env(): string | undefined {
		return undefined;
	}
	async probeGit(): Promise<GitUnavailableError | undefined> {
		this.probes++;
		return this.gitError;
	}
}

/** Blueprint settings whose `resume.setupCommand` appends a line to `setup-runs.txt` in each restored worktree's build. */
export function setupBlueprint(
	overrides: Partial<PrepareSessionResumeOptions["blueprint"]> = {},
): PrepareSessionResumeOptions["blueprint"] {
	return {
		agentDir: sandbox.path("agent"),
		trusted: () => true,
		setupCommand: appendLineCommand(sandbox.path("setup-runs.txt"), "ran"),
		...overrides,
	};
}

export function options(overrides: Partial<PrepareSessionResumeOptions> = {}): PrepareSessionResumeOptions {
	return {
		entryPoint: "cli",
		launchCwd: sandbox.root,
		settings,
		storeDir: sandbox.path("host"),
		blueprint: setupBlueprint(),
		...overrides,
	};
}

export function cwdOf(prepared: PreparedSessionResume): string | undefined {
	return prepared.status === "ready" ? prepared.sessionManager.getCwd() : undefined;
}

/** The typed failure of a recorded root this user cannot read: Atomic's `unreadable-path`, caused by EACCES. */
export function assertUnreadable(error: unknown): void {
	assert.ok(isWorkspaceSnapshotError(error), String(error));
	assert.equal(error.code, "unreadable-path");
	assert.equal((error.cause as NodeJS.ErrnoException).code, "EACCES");
}

export function setupRuns(): number {
	return existsSync(sandbox.path("setup-runs.txt"))
		? readFileSync(sandbox.path("setup-runs.txt"), "utf8").trim().split("\n").length
		: 0;
}

/** Records a snapshot of a further clone `name` with an edited README, as a second checkout of `manager`'s session. */
export async function recordOtherCheckout(
	manager: SessionManager,
	name: string,
	files: Record<string, string> = { "README.md": `${name}\n`, "Cargo.lock": "# lock\n" },
): Promise<string> {
	const { clone } = await sandbox.remoteWithClone(name, files);
	sandbox.write(join(clone, "README.md"), `edited in ${name}\n`);
	const capture = await captureWorktreeSnapshot(clone, {
		settings,
		blobs: manager.getSessionStore().snapshotBlobs,
	});
	if (capture.status !== "captured") throw new Error(capture.status);
	await manager.appendWorktreeSnapshot(clone, capture.snapshot.id, capture.snapshot);
	return clone;
}

export function warningsOf(prepared: PreparedSessionResume): string[] {
	return prepared.status === "ready"
		? prepared.notices.filter((notice) => notice.type === "warning").map((notice) => notice.message)
		: [];
}

export function restoredWorktrees(): string[] {
	const worktrees = sandbox.path("host", "worktrees");
	return existsSync(worktrees) ? readdirSync(worktrees) : [];
}

export function warningsNaming(prepared: PreparedSessionResume, root: string): string[] {
	return warningsOf(prepared).filter((message) => message.includes(root));
}

/** The warnings that are not the deprecation notice of the `resume.setupCommand` alias. */
export function withoutDeprecation(messages: readonly string[]): string[] {
	return messages.filter((message) => !message.startsWith("Deprecation warning: resume.setupCommand"));
}

/** An outer clone and, inside it, a nested clone of another repository, each with an edited README and `files`. */
export async function nestedCheckouts(outerFiles: Record<string, string>, innerFiles: Record<string, string>) {
	const { clone: outer } = await sandbox.remoteWithClone("outer", { "README.md": "outer\n", ...outerFiles });
	const { remote } = await sandbox.remoteWithClone("inner-source", { "README.md": "inner\n", ...innerFiles });
	const inner = join(outer, "inner");
	await sandbox.git(sandbox.root, "clone", "-q", remote, inner);
	for (const checkout of [outer, inner]) sandbox.write(join(checkout, "README.md"), "edited\n");
	return { outer, inner };
}

/** A session that works in `inner`, a checkout nested in `outer`, and recorded a snapshot of both. */
export async function recordNestedSession(outer: string, inner: string): Promise<SessionManager> {
	const manager = await recordSession(inner);
	const capture = await captureWorktreeSnapshot(outer, { settings, blobs: manager.getSessionStore().snapshotBlobs });
	if (capture.status !== "captured") throw new Error(capture.status);
	await manager.appendWorktreeSnapshot(outer, capture.snapshot.id, capture.snapshot);
	return manager;
}
