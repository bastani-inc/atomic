import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { readLedger } from "../src/core/resume/blueprint/ledger.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.ts";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.ts";
import type { SessionStore } from "../src/core/storage/session/types.ts";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.ts";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.ts";
import {
	BLUEPRINT_CONTEXT_TYPE,
	continueSessionWhereItWorked,
	type PreparedSessionResume,
	type PrepareSessionResumeOptions,
	prepareSessionResume,
	removeRestoredWorktree,
	setUpRestoredRunWorktrees,
} from "../src/index.ts";

useTemporaryAgentDir();

const settings = DEFAULT_WORKTREE_SNAPSHOT_SETTINGS;
let sandbox: GitSandbox;
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	sandbox.dispose();
});

async function sqlStore(name: string): Promise<SessionStore> {
	const database = await openNodeSqliteDatabase(sandbox.path(`${name}.sqlite`));
	const store = await SqlSessionStore.open(database);
	cleanups.push(async () => {
		await store.close();
		await database.close();
	});
	return store;
}

async function recordSession(root: string, cwd = root): Promise<SessionManager> {
	const store = await sqlStore("sessions");
	const manager = await SessionManager.create(store, cwd);
	await manager.appendMessage({ role: "user", content: "work on it", timestamp: Date.now() });
	const capture = await captureWorktreeSnapshot(root, { settings, blobs: store.snapshotBlobs });
	assert.equal(capture.status, "captured");
	if (capture.status !== "captured") throw new Error("unreachable");
	await manager.appendWorktreeSnapshot(root, capture.snapshot.id, capture.snapshot);
	return manager;
}

const markers = () => sandbox.path("markers.txt");
const mark = (label: string) => `echo "${label} $(pwd -P)" >> "${markers().replaceAll("\\", "/")}"`;
const ran = () => (existsSync(markers()) ? readFileSync(markers(), "utf8").trim().split("\n") : []);

function options(overrides: Partial<PrepareSessionResumeOptions["blueprint"]> = {}): PrepareSessionResumeOptions {
	return {
		entryPoint: "cli",
		launchCwd: sandbox.root,
		settings,
		storeDir: sandbox.path("host"),
		blueprint: {
			agentDir: sandbox.path("agent"),
			trusted: () => true,
			homeDir: sandbox.path("home"),
			environment: { PATH: process.env.PATH ?? "", HOME: sandbox.path("home") },
			...overrides,
		},
	};
}

function ready(prepared: PreparedSessionResume) {
	assert.equal(prepared.status, "ready");
	if (prepared.status !== "ready") throw new Error("unreachable");
	return prepared;
}

function contexts(manager: SessionManager): string[] {
	return manager
		.getBranch()
		.flatMap((entry) =>
			entry.type === "custom_message" &&
			entry.customType === BLUEPRINT_CONTEXT_TYPE &&
			typeof entry.content === "string"
				? [entry.content]
				: [],
		);
}

describe("resuming sessions with several checkouts and without any (#4588)", () => {
	async function recordTwoCheckouts(firstBlueprint: string, secondBlueprint: string) {
		const { clone: first } = await sandbox.remoteWithClone("first", { "README.md": "first\n" });
		const { clone: second } = await sandbox.remoteWithClone("second", { "README.md": "second\n" });
		sandbox.write(join(first, ".atomic", "blueprint.yaml"), firstBlueprint);
		sandbox.write(join(second, ".atomic", "blueprint.yaml"), secondBlueprint);
		const manager = await recordSession(first);
		const store = manager.getSessionStore();
		const capture = await captureWorktreeSnapshot(second, { settings, blobs: store.snapshotBlobs });
		assert.equal(capture.status, "captured");
		if (capture.status !== "captured") throw new Error("unreachable");
		await manager.appendWorktreeSnapshot(second, capture.snapshot.id, capture.snapshot);
		renameSync(first, sandbox.path("first-gone"));
		renameSync(second, sandbox.path("second-gone"));
		return { manager, first, second };
	}

	test("a worktree whose last build failed is rebuilt while one built earlier is only described as set up earlier (#4588)", async () => {
		const { manager } = await recordTwoCheckouts(
			`initialize: exit 3\nmaintenance: ${mark("first-maintenance")}\n`,
			`maintenance: ${mark("second-maintenance")}\n`,
		);
		const first = ready(await prepareSessionResume(manager, options()));
		const restored = manager.getWorktreeRootMappings().map((mapping) => mapping.to);
		assert.equal(restored.length, 2);
		assert.deepEqual(ran(), [`second-maintenance ${restored[1]}`]);
		assert.equal(first.blueprintNotices.length, 1);

		const again = ready(await prepareSessionResume(manager, options()));
		assert.equal(again.blueprintNotices.length, 1);
		assert.match(again.blueprintNotices[0]?.message ?? "", /^Partial build: /);
		assert.ok((again.blueprintNotices[0]?.message ?? "").includes(restored[0]!));
		assert.deepEqual(ran(), [`second-maintenance ${restored[1]}`]);
		const context = again.blueprintContext ?? "";
		assert.equal(context.split("<blueprint>").length - 1, 2);
		assert.equal(context.split(`repository: ${restored[0]}`).length - 1, 1);
		assert.equal(context.split(`repository: ${restored[1]}`).length - 1, 1);
		assert.equal(context.split("SET UP EARLIER on this machine").length - 1, 1);
		const earlierBlock = context.slice(context.indexOf(`repository: ${restored[1]}`));
		assert.match(earlierBlock, /SET UP EARLIER on this machine/);
	});

	test("a dirty checkout the user chose to use is described with the configured global blueprint and no notices (#4588)", async () => {
		const { clone } = await sandbox.remoteWithClone("dirty", { "README.md": "hello\n" });
		sandbox.write(
			join(clone, ".atomic", "blueprint.yaml"),
			"knowledge:\n  - name: test\n    contents: make dirty-test\n",
		);
		sandbox.write(
			join(sandbox.path("agent"), "blueprint.yaml"),
			"knowledge:\n  - name: global\n    contents: global-knowledge\n",
		);
		const manager = await recordSession(clone);
		const checkout = sandbox.path("node-b", "dirty");
		mkdirSync(sandbox.path("node-b"));
		renameSync(clone, checkout);
		sandbox.write(join(checkout, "README.md"), "user edit\n");
		const prepared = ready(
			await prepareSessionResume(manager, {
				...options(),
				launchCwd: checkout,
				chooseDirtyCheckout: async () => "use",
			}),
		);
		assert.equal(prepared.sessionManager.getCwd(), checkout);
		assert.deepEqual(prepared.blueprintNotices, []);
		assert.match(prepared.blueprintContext ?? "", /global-knowledge/);
		assert.match(prepared.blueprintContext ?? "", /make dirty-test/);
		assert.equal(contexts(prepared.sessionManager).length, 1);
	});

	test("a session outside any repository gets only the global blueprint's context (#4588)", async () => {
		const outside = sandbox.path("not-a-repository");
		mkdirSync(outside, { recursive: true });
		sandbox.write(
			join(sandbox.path("agent"), "blueprint.yaml"),
			"knowledge:\n  - name: global\n    contents: global-only\n",
		);
		const store = await sqlStore("outside-sessions");
		const manager = await SessionManager.create(store, outside);
		await manager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
		const prepared = ready(await prepareSessionResume(manager, { ...options(), launchCwd: outside }));
		assert.match(prepared.blueprintContext ?? "", /global-only/);
		assert.equal((prepared.blueprintContext ?? "").split("<blueprint>").length - 1, 1);
	});

	test("waking a session that recorded no checkout records the context of its working directory's repository (#4588)", async () => {
		const { clone } = await sandbox.remoteWithClone("woken", { "README.md": "hello\n" });
		sandbox.write(
			join(clone, ".atomic", "blueprint.yaml"),
			"knowledge:\n  - name: test\n    contents: woken-knowledge\n",
		);
		const store = await sqlStore("woken-sessions");
		const manager = await SessionManager.create(store, clone);
		await manager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
		await continueSessionWhereItWorked(manager, options());
		const [context] = contexts(manager);
		assert.match(context ?? "", /woken-knowledge/);
		assert.match(context ?? "", /NOT YET RUN on this machine: this checkout is used as it is/);
		assert.deepEqual(ran(), []);
	});

	test("waking a session whose checkouts all stay builds nothing and records one context (#4588)", async () => {
		const { clone } = await sandbox.remoteWithClone("stays", { "README.md": "hello\n" });
		sandbox.write(join(clone, ".atomic", "blueprint.yaml"), `maintenance: ${mark("never")}\n`);
		const manager = await recordSession(clone);
		await continueSessionWhereItWorked(manager, options());
		await continueSessionWhereItWorked(manager, options());
		assert.deepEqual(ran(), []);
		assert.equal(contexts(manager).length, 1);
	});

	test("waking a session whose checkouts are gone restores them and hands over the blueprint warnings once (#4588)", async () => {
		const { manager } = await recordTwoCheckouts(
			"initialize: exit 3\n",
			`maintenance: ${mark("second-maintenance")}\n`,
		);
		const heard: string[][] = [];
		const onNotices = (notices: readonly { message: string }[]) =>
			heard.push(notices.map((notice) => notice.message));
		await continueSessionWhereItWorked(manager, { ...options(), onNotices });
		assert.equal(heard.length, 1);
		assert.equal(heard[0]?.length, 1);
		assert.match(heard[0]?.[0] ?? "", /^Partial build: /);
	});

	test("waking a session whose worktrees were restored earlier hands over the warnings of rebuilding the failed one (#4588)", async () => {
		const { manager } = await recordTwoCheckouts("initialize: exit 3\n", "maintenance: echo ok\n");
		const woken = ready(await prepareSessionResume(manager, options())).sessionManager;
		const heard: string[][] = [];
		const onNotices = (notices: readonly { message: string }[]) =>
			heard.push(notices.map((notice) => notice.message));
		await continueSessionWhereItWorked(woken, { ...options(), onNotices });
		assert.equal(heard.length, 1);
		assert.match(heard[0]?.[0] ?? "", /^Partial build: /);
	});

	test("waking a session whose worktrees all built well hands over no warning (#4588)", async () => {
		const { manager } = await recordTwoCheckouts("maintenance: echo ok\n", "maintenance: echo ok\n");
		const woken = ready(await prepareSessionResume(manager, options())).sessionManager;
		const heard: string[][] = [];
		await continueSessionWhereItWorked(woken, {
			...options(),
			onNotices: (notices) => heard.push(notices.map((notice) => notice.message)),
		});
		assert.deepEqual(heard, []);
	});

	test("waking a session with failing blueprints and no onNotices callback resolves and still records the context (#4588)", async () => {
		const { manager } = await recordTwoCheckouts("initialize: exit 3\n", "initialize: exit 4\n");
		const woken = await continueSessionWhereItWorked(manager, options());
		assert.equal(contexts(woken).length, 1);
		assert.match(contexts(woken)[0] ?? "", /Failure: /);

		const again = await continueSessionWhereItWorked(woken, options());
		assert.equal(contexts(again).length, 2);
	});

	test("waking a session whose blueprints say nothing is wrong never calls onNotices, whether its checkout stays or is restored (#4588)", async () => {
		const { clone } = await sandbox.remoteWithClone("quiet", { "README.md": "hello\n" });
		sandbox.write(join(clone, ".atomic", "blueprint.yaml"), "maintenance: echo ok\n");
		const manager = await recordSession(clone);
		let calls = 0;
		const onNotices = () => {
			calls++;
		};
		await continueSessionWhereItWorked(manager, { ...options(), onNotices });
		renameSync(clone, sandbox.path("quiet-gone"));
		const restored = await continueSessionWhereItWorked(manager, { ...options(), onNotices });
		assert.ok(restored.getCwd().startsWith(sandbox.path("host")));
		await continueSessionWhereItWorked(restored, { ...options(), onNotices });
		assert.equal(calls, 0);
	});

	test("a wake the user cancels at the dirty-checkout prompt returns the session as it was and reports nothing (#4588)", async () => {
		const { clone } = await sandbox.remoteWithClone("cancelled", { "README.md": "hello\n" });
		sandbox.write(join(clone, ".atomic", "blueprint.yaml"), "initialize: exit 3\n");
		const manager = await recordSession(clone);
		const checkout = sandbox.path("node-b", "cancelled");
		mkdirSync(sandbox.path("node-b"));
		renameSync(clone, checkout);
		sandbox.write(join(checkout, "README.md"), "user edit\n");
		const heard: string[] = [];
		const woken = await continueSessionWhereItWorked(manager, {
			...options(),
			launchCwd: checkout,
			chooseDirtyCheckout: async () => "cancel",
			onNotices: (notices) => heard.push(...notices.map((notice) => notice.message)),
		});
		assert.equal(woken, manager);
		assert.deepEqual(heard, []);
		assert.equal(existsSync(sandbox.path("host")), false);
	});

	test("a build ledger that cannot be read still gives the agent every restored repository's maintenance and knowledge, and the failure (#4588)", async () => {
		const { manager } = await recordTwoCheckouts(
			"maintenance: echo first-step\nknowledge:\n  - name: test\n    contents: first-fact\n",
			"knowledge:\n  - name: test\n    contents: second-fact\n",
		);
		mkdirSync(join(sandbox.path("host"), "blueprint-builds", "ledger.json"), { recursive: true });
		const prepared = ready(await prepareSessionResume(manager, options()));
		assert.equal(prepared.blueprintNotices.length, 1);
		const context = contexts(prepared.sessionManager);
		assert.equal(context.length, 1);
		for (const text of ["first-step", "first-fact", "second-fact", "Failure: ", "NOT CONFIRMED"]) {
			assert.ok(context[0]?.includes(text), text);
		}
	});

	test("a second resume from a worktree Atomic restored still inherits the unchanged workspace: one repository identity, initialize ran once (#4588)", async () => {
		const { clone } = await sandbox.remoteWithClone("two-hops", { "README.md": "hello\n" });
		sandbox.write(
			join(clone, ".atomic", "blueprint.yaml"),
			`initialize: ${mark("initialize")}\nmaintenance: ${mark("maintenance")}\n`,
		);
		const recorded = await recordSession(clone);
		renameSync(clone, sandbox.path("two-hops-gone"));
		const manager = ready(await prepareSessionResume(recorded, options())).sessionManager;
		const firstHop = manager.getWorktreeRootMappings().at(-1)!.to;
		assert.deepEqual(ran(), [`initialize ${firstHop}`, `maintenance ${firstHop}`]);

		const capture = await captureWorktreeSnapshot(firstHop, {
			settings,
			blobs: manager.getSessionStore().snapshotBlobs,
		});
		assert.equal(capture.status, "captured");
		if (capture.status !== "captured") throw new Error("unreachable");
		assert.deepEqual(capture.snapshot.remotes, [], "a worktree restored from the object store has no remotes");
		await manager.appendWorktreeSnapshot(firstHop, capture.snapshot.id, capture.snapshot);
		await removeRestoredWorktree(firstHop, { storeDir: sandbox.path("host") });

		const again = ready(await prepareSessionResume(manager, options())).sessionManager;
		const secondHop = again.getWorktreeRootMappings().at(-1)!.to;
		assert.notEqual(secondHop, firstHop);
		assert.deepEqual(ran().slice(2), [`maintenance ${secondHop}`]);

		const ledger = await readLedger(sandbox.path("host"));
		assert.equal(new Set(Object.keys(ledger.workspaces).map((key) => key.split(":")[0])).size, 1);
		assert.equal(Object.keys(ledger.workspaces).length, 1);
	});

	test("cancelling the build of a worktree that was really restored removes it from the store again (#4588)", async () => {
		const { clone } = await sandbox.remoteWithClone("restorable", { "README.md": "hello\n" });
		const manager = await recordSession(clone);
		renameSync(clone, sandbox.path("restorable-gone"));
		const storeDir = sandbox.path("agent", "worktree-snapshots");
		ready(await prepareSessionResume(manager, { ...options(), storeDir }));
		const root = manager.getWorktreeRootMappings().at(-1)!.to;
		assert.ok(root.startsWith(storeDir));
		assert.equal(existsSync(root), true);
		const stop = new Error("stop the resume");
		await assert.rejects(
			setUpRestoredRunWorktrees([{ root, remotes: [] }], {
				agentDir: sandbox.path("agent"),
				signal: AbortSignal.abort(stop),
			}),
			(error: unknown) => {
				assert.equal(error, stop);
				assert.equal("cleanupCause" in (error as object), false);
				return true;
			},
		);
		assert.equal(existsSync(root), false);
	});

	test("a snapshot-less resume whose repository blueprint is a directory still resumes with no warning (#4588)", async () => {
		const { clone } = await sandbox.remoteWithClone("dir-blueprint", { "README.md": "hello\n" });
		mkdirSync(join(clone, ".atomic", "blueprint.yaml"), { recursive: true });
		const store = await sqlStore("dir-sessions");
		const manager = await SessionManager.create(store, clone);
		await manager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
		const prepared = ready(await prepareSessionResume(manager, { ...options(), launchCwd: clone }));
		assert.deepEqual(prepared.blueprintNotices, []);
		await continueSessionWhereItWorked(manager, options());
	});

	test("an unreadable global blueprint never rejects a resume that restores a worktree or one that restores nothing (#4588)", async () => {
		mkdirSync(join(sandbox.path("agent"), "blueprint.yaml"), { recursive: true });
		const { clone } = await sandbox.remoteWithClone("global-dir", { "README.md": "hello\n" });
		sandbox.write(join(clone, ".atomic", "blueprint.yaml"), `maintenance: ${mark("repo")}\n`);
		const manager = await recordSession(clone);
		renameSync(clone, sandbox.path("global-dir-gone"));
		const restored = ready(await prepareSessionResume(manager, options()));
		assert.equal(restored.blueprintNotices.length, 1);
		assert.match(restored.blueprintNotices[0]?.message ?? "", /^Blueprint build FAILED: /);
		assert.deepEqual(ran(), []);

		const outside = sandbox.path("outside");
		mkdirSync(outside, { recursive: true });
		const plain = await SessionManager.create(await sqlStore("outside-sessions"), outside);
		await plain.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
		ready(await prepareSessionResume(plain, { ...options(), launchCwd: outside }));
	});

	test("a build ledger that cannot be read never rejects a resume and rebuilds the restored worktrees it cannot vouch for (#4588)", async () => {
		const { manager } = await recordTwoCheckouts("maintenance: echo one\n", "maintenance: echo two\n");
		ready(await prepareSessionResume(manager, options()));
		const ledger = join(sandbox.path("host"), "blueprint-builds", "ledger.json");
		rmSync(ledger);
		mkdirSync(ledger);
		const again = ready(await prepareSessionResume(manager, options()));
		assert.equal(again.blueprintNotices.length, 1);
		assert.match(again.blueprintNotices[0]?.message ?? "", /^Blueprint build FAILED: /);
	});

	test("an engine child that skips blueprints records no context for a snapshot-less session or a chosen dirty checkout (#4588)", async () => {
		const { clone } = await sandbox.remoteWithClone("skipped", { "README.md": "hello\n" });
		sandbox.write(
			join(clone, ".atomic", "blueprint.yaml"),
			"knowledge:\n  - name: test\n    contents: skipped-fact\n",
		);
		const skipping = { ...options(), blueprints: "skip" as const };

		const plain = await SessionManager.create(await sqlStore("skip-plain"), clone);
		await plain.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
		const preparedPlain = ready(await prepareSessionResume(plain, { ...skipping, launchCwd: clone }));
		assert.equal(preparedPlain.blueprintContext, undefined);
		assert.equal(contexts(plain).length, 0);

		const manager = await recordSession(clone);
		const checkout = sandbox.path("node-b", "skipped");
		mkdirSync(sandbox.path("node-b"));
		renameSync(clone, checkout);
		sandbox.write(join(checkout, "README.md"), "user edit\n");
		const chosen = ready(
			await prepareSessionResume(manager, {
				...skipping,
				launchCwd: checkout,
				chooseDirtyCheckout: async () => "use",
			}),
		);
		assert.equal(chosen.blueprintContext, undefined);
		assert.equal(contexts(chosen.sessionManager).length, 0);
	});

	test("the temporary directory is not a repository either (#4588)", () => {
		assert.equal(existsSync(join(tmpdir(), ".git")), false);
	});
});
