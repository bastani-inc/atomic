import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@bastani/pi-ai/compat";
import { afterEach, beforeEach, describe, test } from "vitest";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.ts";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.ts";
import { type PoolSlotRecord, pooledWorktreeHolder } from "../src/core/worktree-snapshot/pool.js";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.ts";
import { formatWorktreeRestoreNotice, isWorkspaceConfigError, openSessionInWorktree } from "../src/index.ts";
import { createHarness } from "./suite/harness.js";

let sandbox: GitSandbox;
const cleanups: Array<() => Promise<void> | void> = [];
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	sandbox.dispose();
});

const NO_BUILTINS = { workflows: false, subagents: false, mcp: false, "web-access": false, intercom: false } as const;

async function fauxSession(options: {
	settings?: Record<string, unknown>;
	snapshots?: Record<string, unknown>;
	cwd?: string;
	sessionManager?: SessionManager;
}) {
	const faux = registerFauxProvider();
	cleanups.push(() => faux.unregister());
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({
		credentials: authStorage,
		modelsPath: sandbox.path("models.json"),
	});
	const model = faux.getModel();
	modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: model.api, models: [{ ...model }] });
	const agentDir = sandbox.path("agent");
	mkdirSync(agentDir, { recursive: true });
	const { session } = await createAgentSession({
		cwd: options.cwd,
		agentDir,
		modelRuntime,
		model,
		settingsManager: SettingsManager.inMemory(options.settings),
		...(options.sessionManager
			? { sessionManager: options.sessionManager }
			: { sessionStore: { kind: "sqlite" as const, path: sandbox.path("sessions.sqlite") } }),
		builtins: NO_BUILTINS,
		...(options.snapshots ? { snapshots: options.snapshots } : {}),
	});
	cleanups.push(() => session.dispose());
	return { session, faux };
}

const recordedRoots = (session: Awaited<ReturnType<typeof fauxSession>>["session"]) =>
	session.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "worktree_snapshot")
		.map((entry) => (entry as { root: string }).root);

async function writeTurn(
	{ session, faux }: Awaited<ReturnType<typeof fauxSession>>,
	path: string,
	content: string,
): Promise<void> {
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("write", { path, content })], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await session.prompt("write it");
}

describe("snapshot options of createAgentSession", () => {
	test("an invalid option fails before anything is created, naming the option", async () => {
		const agentDir = sandbox.path("agent");
		await assert.rejects(
			createAgentSession({
				cwd: sandbox.root,
				agentDir,
				snapshots: { fullEvery: 0 },
				builtins: NO_BUILTINS,
			}),
			(error: unknown) => {
				assert.ok(isWorkspaceConfigError(error));
				assert.deepEqual(error.fields, {
					source: "sdk",
					field: "snapshots.fullEvery",
					expected: "a positive integer",
				});
				return true;
			},
		);
		assert.equal(existsSync(agentDir), false);
		assert.equal(existsSync(sandbox.path("sessions.sqlite")), false);
	});

	test("an option overrides the settings, and fields it leaves out come from them", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const off = await fauxSession({
			cwd: clone,
			settings: { snapshots: { enabled: true } },
			snapshots: { enabled: false },
		});
		await writeTurn(off, join(clone, "a.txt"), "a\n");
		assert.deepEqual(recordedRoots(off.session), []);
		await off.session.dispose();

		const on = await fauxSession({
			cwd: clone,
			settings: { snapshots: { enabled: false } },
			snapshots: { enabled: true },
		});
		await writeTurn(on, join(clone, "b.txt"), "b\n");
		assert.deepEqual(recordedRoots(on.session), [clone]);
		await on.session.dispose();

		const merged = await fauxSession({
			cwd: clone,
			settings: { snapshots: { maxFileBytes: 4 } },
			snapshots: { includeUntracked: true },
		});
		await writeTurn(merged, join(clone, "big.txt"), "more than four bytes\n");
		const [entry] = merged.session.sessionManager.getEntries().filter((e) => e.type === "worktree_snapshot");
		const omitted = (entry as { snapshot?: { omitted: unknown[] } }).snapshot?.omitted;
		assert.deepEqual(omitted, [{ reason: "over-file-cap", path: "big.txt", bytes: 21 }]);
	});

	test("without an option the session follows the settings as they are at each turn", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const run = await fauxSession({ cwd: clone, settings: { snapshots: { enabled: true } } });
		await writeTurn(run, join(clone, "a.txt"), "a\n");
		assert.deepEqual(recordedRoots(run.session), [clone]);
		run.session.settingsManager.applyOverrides({ snapshots: { enabled: false } });
		await writeTurn(run, join(clone, "b.txt"), "b\n");
		assert.deepEqual(recordedRoots(run.session), [clone]);
	});
});

describe("resuming through the SDK (#4245)", () => {
	test("openSessionInWorktree restores a drifted checkout, and createAgentSession continues in it", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const first = await fauxSession({ cwd: clone, settings: { snapshots: { enabled: true } } });
		await writeTurn(first, join(clone, "a.txt"), "recorded\n");
		assert.deepEqual(recordedRoots(first.session), [clone]);
		const sessionId = first.session.sessionManager.getSessionId();
		writeFileSync(join(clone, "a.txt"), "drifted\n");
		const database = await openNodeSqliteDatabase(sandbox.path("sessions.sqlite"));
		const store = await SqlSessionStore.open(database);
		cleanups.push(async () => {
			await store.close();
			await database.close();
		});
		const stored = await SessionManager.open(store, sessionId);
		const { sessionManager, notices } = await openSessionInWorktree(stored, {
			settings: DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
			storeDir: sandbox.path("host"),
		});
		const [mapping] = sessionManager.getWorktreeRootMappings();
		assert.ok(mapping);
		assert.deepEqual(notices, [{ type: "info", message: formatWorktreeRestoreNotice(mapping) }]);
		const resumed = await fauxSession({ sessionManager });
		assert.equal(resumed.session.sessionManager.getCwd(), mapping.to);
		assert.equal(readFileSync(join(mapping.to, "a.txt"), "utf8"), "recorded\n");
		assert.equal(readFileSync(join(clone, "a.txt"), "utf8"), "drifted\n");
	});

	test("createAgentSession holds the pooled worktree it restores until the session closes, then records its last snapshot (#4748)", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const first = await fauxSession({ cwd: clone, settings: { snapshots: { enabled: true } } });
		await writeTurn(first, join(clone, "a.txt"), "recorded\n");
		const sessionId = first.session.sessionManager.getSessionId();
		await first.session.dispose();
		renameSync(clone, sandbox.path("moved-away"));
		const database = await openNodeSqliteDatabase(sandbox.path("sessions.sqlite"));
		const store = await SqlSessionStore.open(database);
		cleanups.push(async () => {
			await store.close();
			await database.close();
		});
		const resumed = await fauxSession({ sessionManager: await SessionManager.open(store, sessionId) });
		const storeDir = join(sandbox.path("agent"), "worktree-snapshots");
		const root = resumed.session.sessionManager.getCwd();
		assert.match(root, /[\\/]worktrees[\\/][0-9a-f]{24}-0$/);
		const owner = { kind: "session", id: sessionId };
		assert.deepEqual(await pooledWorktreeHolder(storeDir, root), { owner, held: true });
		await writeTurn(resumed, join(root, "a.txt"), "changed here\n");
		const latest = resumed.session.sessionManager.getLatestWorktreeSnapshots().get(root);
		assert.ok(latest);

		await resumed.session.dispose();

		assert.deepEqual(await pooledWorktreeHolder(storeDir, root), { owner, held: false });
		const [record] = readdirSync(join(storeDir, "pool"), { recursive: true, encoding: "utf8" })
			.filter((name) => name.endsWith("0.json"))
			.map((name) => JSON.parse(readFileSync(join(storeDir, "pool", name), "utf8")) as PoolSlotRecord);
		assert.deepEqual(record?.lastState, { snapshotId: latest.id, head: latest.head, tree: latest.tree });
	});
});

describe("turn boundaries", () => {
	test("a call to a tool that is not registered does not break the turn or its recording", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const harness = await createHarness({
			sessionManager: await SessionManager.create(sandbox.path("unknown-tool"), clone),
		});
		cleanups.push(() => harness.cleanup());
		harness.appendResponses([
			fauxAssistantMessage([fauxToolCall("no_such_tool", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("carried on"),
		]);
		await harness.session.prompt("call something that does not exist");
		const last = harness.session.messages.at(-1);
		assert.equal(last?.role, "assistant");
		assert.equal(
			last?.role === "assistant" && last.stopReason,
			"stop",
			"the turn after the unknown call ran to its end",
		);
		assert.deepEqual(last?.role === "assistant" && last.content, [{ type: "text", text: "carried on" }]);
		assert.deepEqual(harness.eventsOfType("worktree_snapshot_unavailable"), []);
	});

	async function jsonlHarness() {
		const directory = sandbox.path("jsonl-session");
		mkdirSync(directory, { recursive: true });
		const manager = await SessionManager.create(directory, directory);
		const harness = await createHarness({ sessionManager: manager });
		cleanups.push(() => harness.cleanup());
		return { directory, manager, harness, target: join(harness.tempDir, "written.txt") };
	}

	test("control: a turn that writes in a session whose store cannot hold blobs reports that once", async () => {
		const { harness, target } = await jsonlHarness();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: target, content: "x\n" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("write it");
		assert.deepEqual(
			harness.eventsOfType("worktree_snapshot_unavailable").map((event) => event.reason.code),
			["blob-store-unsupported"],
		);
	});

	test("a turn whose own messages could not be saved is not snapshotted or reported", async () => {
		const { directory, manager, harness, target } = await jsonlHarness();
		harness.setResponses([
			async () => {
				const other = await SessionManager.open(manager.getSessionFile()!, directory);
				await other.appendCustomEntry("other-writer", {});
				return fauxAssistantMessage([fauxToolCall("write", { path: target, content: "x\n" })], {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage("must not run"),
		]);
		await harness.session.prompt("write it");
		assert.deepEqual(harness.eventsOfType("worktree_snapshot_unavailable"), []);
		assert.deepEqual(
			manager.getEntries().filter((entry) => entry.type === "worktree_snapshot"),
			[],
		);
	});
});
