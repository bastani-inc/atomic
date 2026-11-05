import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@bastani/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { ENV_AGENT_DIR } from "../src/config.js";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionFactory } from "../src/core/extensions/index.js";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import type { SessionEntry, WorktreeSnapshotEntry } from "../src/core/session-manager.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { resumeSessionWorktree } from "../src/core/session-worktree-snapshots.ts";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.ts";
import { JsonlSessionStore } from "../src/core/storage/session/jsonl-session-store.ts";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.ts";
import type { SessionStore } from "../src/core/storage/session/types.ts";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.ts";
import {
	GitUnavailableError,
	isWorkspaceDriftError,
	isWorkspaceRestoreError,
	setWorktreeSnapshotGit,
	WorkspaceConfigError,
	WorkspaceRestoreError,
} from "../src/index.ts";
import { createHarness, type Harness } from "./suite/harness.js";

let sandbox: GitSandbox;
const cleanups: Array<() => Promise<void> | void> = [];
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	vi.unstubAllEnvs();
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

async function harnessFor(sessionManager: SessionManager, extensionFactories?: ExtensionFactory[]): Promise<Harness> {
	const harness = await createHarness({ sessionManager, ...(extensionFactories ? { extensionFactories } : {}) });
	cleanups.push(() => harness.cleanup());
	return harness;
}

function snapshotEntries(manager: SessionManager): WorktreeSnapshotEntry[] {
	return manager.getEntries().filter((entry): entry is WorktreeSnapshotEntry => entry.type === "worktree_snapshot");
}

async function writeTurn(harness: Harness, path: string, content: string): Promise<void> {
	harness.appendResponses([
		fauxAssistantMessage([fauxToolCall("write", { path, content })], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt(`write ${path}`);
}

describe("session worktree snapshots", () => {
	test("a turn that writes records a snapshot, an unchanged turn a reference, a read-only turn nothing (#4245)", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const manager = await SessionManager.create(await sqlStore("sessions"), clone);
		const harness = await harnessFor(manager);
		const file = join(clone, "notes.txt");
		await writeTurn(harness, file, "first\n");
		const [first] = snapshotEntries(manager);
		assert.ok(first?.snapshot);
		assert.equal(first.root, clone);
		assert.equal(first.snapshotId, first.snapshot.id);
		assert.equal(await sandbox.git(clone, "cat-file", "-p", `${first.snapshot.tree}:notes.txt`), "first");
		const blob = await manager.getSessionStore().snapshotBlobs?.getBlob(first.snapshot.chain[0]!.patch!);
		assert.ok(blob, "the patch is stored in the session store's blob table");

		await writeTurn(harness, file, "first\n");
		const second = snapshotEntries(manager)[1];
		assert.deepEqual(
			{ root: second?.root, snapshotId: second?.snapshotId, snapshot: second?.snapshot },
			{ root: clone, snapshotId: first.snapshotId, snapshot: undefined },
		);

		harness.appendResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: file })], { stopReason: "toolUse" }),
			fauxAssistantMessage("read it"),
		]);
		await harness.session.prompt("read");
		assert.equal(snapshotEntries(manager).length, 2);
		assert.equal(manager.getLatestWorktreeSnapshots().get(clone)?.id, first.snapshotId);
	});

	test("only tools that can write files trigger a capture: built-ins and extension tools declaring writesFiles", async () => {
		const manager = await SessionManager.create(await sqlStore("sessions"), sandbox.root);
		const tool =
			(name: string, writesFiles: boolean): ExtensionFactory =>
			(pi) => {
				pi.registerTool({
					name,
					label: name,
					description: name,
					parameters: Type.Object({}),
					...(writesFiles ? { writesFiles } : {}),
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
				});
			};
		const harness = await harnessFor(manager, [tool("inspect", false), tool("generate", true)]);
		harness.appendResponses([
			fauxAssistantMessage([fauxToolCall("inspect", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("inspected"),
		]);
		await harness.session.prompt("inspect");
		assert.deepEqual(harness.eventsOfType("worktree_snapshot_unavailable"), []);
		harness.appendResponses([
			fauxAssistantMessage([fauxToolCall("generate", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("generated"),
		]);
		await harness.session.prompt("generate");
		const reasons = harness.eventsOfType("worktree_snapshot_unavailable").map((event) => event.reason);
		assert.deepEqual(
			reasons.map((reason) => [reason.code, reason.fields.subject]),
			[["not-a-repository", harness.tempDir]],
		);
	});

	test("a persisted store without a blob table reports blob-store-unsupported once", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const store = await JsonlSessionStore.open(sandbox.path("jsonl"), { exactDirectory: true });
		cleanups.push(() => store.close());
		const manager = await SessionManager.create(store, clone);
		const harness = await harnessFor(manager);
		await writeTurn(harness, join(clone, "a.txt"), "a\n");
		await writeTurn(harness, join(clone, "a.txt"), "b\n");
		const reasons = harness.eventsOfType("worktree_snapshot_unavailable").map((event) => event.reason);
		assert.equal(reasons.length, 1);
		assert.equal(reasons[0]?.name, "WorkspaceSnapshotError");
		assert.equal(reasons[0]?.code, "blob-store-unsupported");
		assert.equal(snapshotEntries(manager).length, 0);
	});

	test("without Git the turn records nothing and reports GitUnavailableError once (#4245)", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const manager = await SessionManager.create(await sqlStore("sessions"), clone);
		const harness = await harnessFor(manager);
		let resolutions = 0;
		setWorktreeSnapshotGit(async () => {
			resolutions++;
			return { path: sandbox.path("no-git"), env: {} };
		});
		await writeTurn(harness, join(clone, "a.txt"), "a\n");
		await writeTurn(harness, join(clone, "a.txt"), "b\n");
		const reasons = harness.eventsOfType("worktree_snapshot_unavailable").map((event) => event.reason);
		assert.equal(reasons.length, 1);
		assert.ok(reasons[0] instanceof GitUnavailableError);
		assert.equal(snapshotEntries(manager).length, 0);
		assert.equal(readFileSync(join(clone, "a.txt"), "utf8"), "b\n");
		assert.ok(resolutions <= 4, `Git was looked up ${resolutions} times`);
	});

	test("appendWorktreeSnapshot rejects a reference to a snapshot the session never recorded", async () => {
		const manager = await SessionManager.create(await sqlStore("sessions"), sandbox.root);
		await assert.rejects(
			manager.appendWorktreeSnapshot(sandbox.root, "unknown"),
			(error: unknown) => error instanceof WorkspaceConfigError && error.field === "snapshotId",
		);
	});
});

describe("session export and import", () => {
	async function recordedSession() {
		const { clone } = await sandbox.remoteWithClone();
		const manager = await SessionManager.create(await sqlStore("machine-a"), clone);
		const harness = await harnessFor(manager);
		await writeTurn(harness, join(clone, "a.txt"), "one\n");
		await writeTurn(harness, join(clone, "a.txt"), "two\n");
		return { clone, manager, harness };
	}

	test("an exported file carries every needed blob once and import moves them into the target store (#4245)", async () => {
		const { manager, harness } = await recordedSession();
		const file = await harness.session.exportToJsonl(sandbox.path("export.jsonl"));
		const exported = readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as SessionEntry & { blobs?: Record<string, string> });
		const latest = manager.getLatestWorktreeSnapshots().values().next().value!;
		const carried = exported.flatMap((entry) => Object.keys(entry.blobs ?? {}));
		assert.deepEqual(carried.sort(), latest.chain.map((link) => link.patch!).sort());
		assert.equal(new Set(carried).size, carried.length);

		const target = await sqlStore("machine-b");
		const imported = await SessionManager.importFromJsonl(file, sandbox.root, target);
		for (const hash of carried) assert.ok(await target.snapshotBlobs?.getBlob(hash));
		assert.ok(snapshotEntries(imported).every((entry) => entry.blobs === undefined));
		assert.equal(imported.getLatestWorktreeSnapshots().values().next().value?.id, latest.id);
	});

	test("an export for sharing leaves snapshot content out", async () => {
		const { harness } = await recordedSession();
		const file = await harness.session.exportToJsonl(sandbox.path("share.jsonl"), { snapshotContent: false });
		assert.doesNotMatch(readFileSync(file, "utf8"), /"blobs"/);
	});

	test("import rejects a blob that does not match its hash before writing anything", async () => {
		const { harness } = await recordedSession();
		const file = await harness.session.exportToJsonl(sandbox.path("export.jsonl"));
		const lines = readFileSync(file, "utf8").trim().split("\n");
		const tampered = lines.map((line) => {
			const entry = JSON.parse(line) as { blobs?: Record<string, string> };
			if (!entry.blobs) return line;
			for (const hash of Object.keys(entry.blobs)) entry.blobs[hash] = Buffer.from("tampered").toString("base64");
			return JSON.stringify(entry);
		});
		writeFileSync(file, `${tampered.join("\n")}\n`);
		const target = await sqlStore("machine-b");
		await assert.rejects(SessionManager.importFromJsonl(file, sandbox.root, target), (error: unknown) => {
			assert.ok(error instanceof WorkspaceRestoreError);
			assert.equal(error.code, "blob-corrupt");
			return true;
		});
		assert.deepEqual(await target.snapshotBlobs?.listBlobHashes(), []);
	});
});

describe("resumeSessionWorktree", () => {
	const settings = DEFAULT_WORKTREE_SNAPSHOT_SETTINGS;

	test("resumes in place when the checkout matches its last snapshot", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const manager = await SessionManager.create(await sqlStore("sessions"), clone);
		await writeTurn(await harnessFor(manager), join(clone, "a.txt"), "a\n");
		const resume = await resumeSessionWorktree(manager, { settings, storeDir: sandbox.path("host") });
		assert.equal(resume.status, "verified");
		assert.equal(existsSync(sandbox.path("host")), false);
	});

	test("restores a drifted checkout into a fresh worktree and records the root mapping (#4245)", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const manager = await SessionManager.create(await sqlStore("sessions"), join(clone));
		await writeTurn(await harnessFor(manager), join(clone, "a.txt"), "recorded\n");
		writeFileSync(join(clone, "a.txt"), "edited after the session\n");
		const resume = await resumeSessionWorktree(manager, { settings, storeDir: sandbox.path("host") });
		assert.equal(resume.status, "restored");
		if (resume.status !== "restored") return;
		assert.equal(readFileSync(join(resume.cwd, "a.txt"), "utf8"), "recorded\n");
		assert.equal(readFileSync(join(clone, "a.txt"), "utf8"), "edited after the session\n");
		assert.equal(resume.mapping.from, clone);
		assert.equal(resume.mapping.to, resume.cwd);
		assert.deepEqual(manager.getWorktreeRootMappings(), [resume.mapping]);
		const again = await resumeSessionWorktree(manager, { settings, storeDir: sandbox.path("host") });
		assert.deepEqual(again.status === "verified" && again.cwd, resume.cwd);
	});

	test("fails closed with a drift error when the snapshot cannot be restored (#4245)", async () => {
		const { clone } = await sandbox.remoteWithClone();
		writeFileSync(join(clone, "deploy.key"), "PRIVATE\n");
		await sandbox.commitAll(clone, "unpushed key");
		const manager = await SessionManager.create(await sqlStore("sessions"), clone);
		await writeTurn(await harnessFor(manager), join(clone, "a.txt"), "a\n");
		renameSync(clone, sandbox.path("moved-away"));
		await assert.rejects(
			resumeSessionWorktree(manager, { settings, storeDir: sandbox.path("host") }),
			(error: unknown) => {
				assert.ok(isWorkspaceDriftError(error));
				assert.equal(error.root, clone);
				assert.equal(error.actualTree, null);
				assert.ok(isWorkspaceRestoreError(error.cause));
				assert.equal(error.cause.code, "commits-unavailable");
				assert.deepEqual(error.cause.paths, ["deploy.key"]);
				return true;
			},
		);
	});

	test("reports Git as unavailable and leaves the session where it was", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const manager = await SessionManager.create(await sqlStore("sessions"), clone);
		await writeTurn(await harnessFor(manager), join(clone, "a.txt"), "a\n");
		setWorktreeSnapshotGit(async () => ({ path: sandbox.path("no-git"), env: {} }));
		const resume = await resumeSessionWorktree(manager, { settings });
		assert.equal(resume.status, "unavailable");
		assert.ok(resume.status === "unavailable" && resume.reason instanceof GitUnavailableError);
	});
});

describe("cross-machine session resume", () => {
	function filesUnder(root: string): Map<string, Buffer> {
		const files = new Map<string, Buffer>();
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (entry.name === ".git") continue;
				const path = join(dir, entry.name);
				if (entry.isDirectory()) walk(path);
				else files.set(relative(root, path).split("\\").join("/"), readFileSync(path));
			}
		};
		walk(root);
		return files;
	}

	test("a session moved to another machine resumes in a restored worktree whose bytes match, and its tools run there (#4245)", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", {
			"a.txt": "one\n",
			"data.bin": new Uint8Array([0, 1, 2]),
		});
		writeFileSync(join(clone, "feature.txt"), "unpushed\n");
		await sandbox.commitAll(clone, "unpushed work");
		writeFileSync(join(clone, "a.txt"), "staged\n");
		await sandbox.git(clone, "add", "a.txt");
		writeFileSync(join(clone, "data.bin"), new Uint8Array([9, 0, 255]));

		vi.stubEnv(ENV_AGENT_DIR, sandbox.path("machine-a", "agent"));
		const manager = await SessionManager.create(await sqlStore("machine-a"), clone);
		const recorder = await harnessFor(manager);
		await writeTurn(recorder, join(clone, "untracked", "u.txt"), "written by the agent\n");
		const exported = await recorder.session.exportToJsonl(sandbox.path("moved.jsonl"));
		const expected = filesUnder(clone);
		renameSync(clone, sandbox.path("machine-a-gone"));

		vi.stubEnv(ENV_AGENT_DIR, sandbox.path("machine-b", "agent"));
		const storeB = await sqlStore("machine-b");
		const imported = await SessionManager.importFromJsonl(exported, clone, storeB);
		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: sandbox.path("models.json"),
		});
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [{ ...model }],
		});
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: sandbox.path("machine-b", "agent"),
				modelRuntime,
				model,
				resourceLoaderOptions: {
					builtinPackagePaths: [],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model })),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const start = await SessionManager.create(storeB, sandbox.root);
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: sandbox.root,
			agentDir: sandbox.path("machine-b", "agent"),
			sessionManager: start,
		});
		cleanups.push(() => runtime.dispose());
		assert.deepEqual(await runtime.switchSession(imported.getSessionId()), { cancelled: false });

		const [mapping] = runtime.session.sessionManager.getWorktreeRootMappings();
		assert.ok(mapping);
		assert.equal(mapping.from, clone);
		assert.ok(mapping.to.startsWith(sandbox.path("machine-b", "agent", "worktree-snapshots", "worktrees")));
		assert.equal(runtime.session.sessionManager.getCwd(), mapping.to);
		assert.deepEqual(filesUnder(mapping.to), expected);

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "pwd && cat untracked/u.txt" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await runtime.session.prompt("where are we");
		const result = runtime.session.messages.findLast((message) => message.role === "toolResult");
		const text = (result?.content as Array<{ type: string; text?: string }>).map((part) => part.text ?? "").join("");
		assert.match(
			text,
			new RegExp(`${realpathSync(mapping.to).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+written by the agent`),
		);
	}, 60_000);
});
