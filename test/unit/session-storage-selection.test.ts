import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import { parseArgs } from "../../packages/coding-agent/src/cli/args.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import {
	canIsolateSessionStore,
	resolveSessionStore,
	type SessionStorageOptions,
	selectSessionStorage,
} from "../../packages/coding-agent/src/core/session-storage.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { InMemorySettingsStorage } from "../../packages/coding-agent/src/core/settings-storage.js";
import { StorageConfigError, StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { StorageUnavailableError as JsonlStorageUnavailableError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { createSessionManager } from "../../packages/coding-agent/src/main-session.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { stageSessionStore } from "../../packages/workflows/src/shared/stage-session-store.js";
import {
	fileExists,
	makeTempDirectory,
	moduleDir,
	readText,
	removeTempDirectory,
	writeFileEnsuringDir,
} from "../helpers/runtime.js";

test("SessionManager defaults to the journal SQLite file", async () => {
	const root = makeTempDirectory("session-selection-");
	const previous = process.env.ATOMIC_CODING_AGENT_DIR;
	process.env.ATOMIC_CODING_AGENT_DIR = join(root, "agent");
	try {
		const manager = await SessionManager.create(root);
		try {
			assert.deepEqual(manager.getSessionStore().descriptor, {
				adapter: "node-sqlite",
				location: join(root, "workflows", "journal.sqlite"),
			});
		} finally {
			await manager.getSessionStore().close();
		}
	} finally {
		if (previous === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
		else process.env.ATOMIC_CODING_AGENT_DIR = previous;
		removeTempDirectory(root);
	}
});

test("session selection honors SDK, CLI, environment, domain and shared settings in order", async () => {
	const root = makeTempDirectory("session-precedence-");
	const previous = process.env.ATOMIC_CODING_AGENT_SESSION_DIR;
	const agentDir = join(root, "agent");
	const settings = { sessions: { storage: { path: "sessions.sqlite" } }, storage: { path: "shared.sqlite" } };
	try {
		process.env.ATOMIC_CODING_AGENT_SESSION_DIR = "environment";
		const supplied = new MemorySessionStore();
		assert.equal(
			await resolveSessionStore(root, { agentDir, settings, sessionStore: supplied, noSession: true }),
			supplied,
		);
		assert.equal(canIsolateSessionStore(supplied), false);
		const sdk = { kind: "memory" } as const;
		assert.equal(selectSessionStorage(root, { agentDir, settings, sessionStore: sdk, sessionDir: "cli" }), sdk);
		const sdkMemory = await resolveSessionStore(root, { agentDir, settings, sessionStore: sdk, noSession: true });
		assert.equal(canIsolateSessionStore(sdkMemory), false);
		await sdkMemory.close();
		assert.deepEqual(selectSessionStorage(root, { agentDir, settings, noSession: true, sessionDir: "cli" }), {
			kind: "memory",
		});
		assert.deepEqual(selectSessionStorage(root, { agentDir, settings, sessionDir: "cli" }), {
			kind: "jsonl",
			dir: join(root, "cli"),
		});
		assert.deepEqual(selectSessionStorage(root, { agentDir, settings }), {
			kind: "jsonl",
			dir: join(root, "environment"),
		});
		process.env.ATOMIC_CODING_AGENT_SESSION_DIR = "";
		assert.deepEqual(selectSessionStorage(root, { agentDir, settings }), {
			kind: "sqlite",
			path: join(root, "sessions.sqlite"),
		});
		assert.deepEqual(selectSessionStorage(root, { agentDir, settings: { storage: settings.storage } }), {
			kind: "sqlite",
			path: join(root, "shared.sqlite"),
		});
		assert.deepEqual(selectSessionStorage(root, { agentDir, settings: {} }), {
			kind: "sqlite",
			path: join(root, "workflows", "journal.sqlite"),
		});
		const memory = await createSessionManager(
			parseArgs(["--no-session"]),
			root,
			"ignored",
			SettingsManager.inMemory({ sessions: { storage: { path: join(root, "forbidden.sqlite") } } }),
		);
		assert.equal(memory.isPersisted(), false);
		assert.deepEqual(memory.getSessionStore().descriptor, { adapter: "memory", location: ":memory:" });
		await memory.appendSessionInfo("unsaved isolated session");
		assert.equal(canIsolateSessionStore(memory.getSessionStore()), true);
		assert.equal(await fileExists(join(root, "ignored")), false);
		assert.equal(await fileExists(join(root, "forbidden.sqlite")), false);
		await memory.getSessionStore().close();
		await supplied.close();
	} finally {
		if (previous === undefined) delete process.env.ATOMIC_CODING_AGENT_SESSION_DIR;
		else process.env.ATOMIC_CODING_AGENT_SESSION_DIR = previous;
		removeTempDirectory(root);
	}
});

test("nearer session and shared storage settings replace the complete selection", () => {
	const storage = new InMemorySettingsStorage();
	storage.withLock("global", () =>
		JSON.stringify({
			sessions: {
				storage: { adapter: "global", options: { retained: "no" }, secrets: { token: { env: "TOKEN" } } },
			},
			storage: { adapter: "global", prefix: "global_" },
		}),
	);
	storage.withLock("project", () =>
		JSON.stringify({
			sessions: { storage: { memory: true } },
			storage: { path: "project.sqlite" },
		}),
	);
	const settings = SettingsManager.fromStorage(storage).getSettings();
	assert.deepEqual(settings.sessions, { storage: { memory: true } });
	assert.deepEqual(settings.storage, { path: "project.sqlite" });
});

test("invalid selected session configuration raises StorageConfigError with its origin", async () => {
	const root = makeTempDirectory("session-invalid-");
	const previous = process.env.ATOMIC_CODING_AGENT_SESSION_DIR;
	delete process.env.ATOMIC_CODING_AGENT_SESSION_DIR;
	try {
		assert.throws(
			() => parseArgs(["--session-dir"]),
			(error: Error) => {
				assert.ok(error instanceof StorageConfigError);
				assert.equal(error.source, "cli");
				assert.equal(error.field, "--session-dir");
				assert.equal(error.reason, "directory-required");
				return true;
			},
		);
		const invalid: readonly [SessionStorageOptions, string, string, string][] = [
			[{ sessionStore: { kind: "bad" } as never }, "sdk", "sessionStore", "invalid-kind"],
			[{ sessionDir: null as never }, "cli", "--session-dir", "invalid-dir"],
			[
				{ settings: { sessions: { storage: { dir: "x", path: "y" } as never } } },
				"settings",
				"sessions.storage",
				"invalid-selection",
			],
			[{ settings: { sessions: { storage: null as never } } }, "settings", "sessions.storage", "invalid-selection"],
			[{ settings: { storage: { adapter: false } as never } }, "settings", "storage", "invalid-selection"],
		];
		for (const [options, source, field, reason] of invalid) {
			await assert.rejects(resolveSessionStore(root, options), (error: Error) => {
				assert.ok(error instanceof StorageConfigError);
				assert.equal(error.source, source);
				assert.equal(error.field, field);
				assert.equal(error.reason, reason);
				return true;
			});
		}
		process.env.ATOMIC_CODING_AGENT_SESSION_DIR = "file://%";
		await assert.rejects(resolveSessionStore(root), (error: Error) => {
			assert.ok(error instanceof StorageConfigError);
			assert.equal(error.source, "env");
			assert.equal(error.field, "ATOMIC_CODING_AGENT_SESSION_DIR");
			assert.equal(error.reason, "invalid-path");
			return true;
		});
	} finally {
		delete process.env.ATOMIC_CODING_AGENT_SESSION_DIR;
		if (previous !== undefined) process.env.ATOMIC_CODING_AGENT_SESSION_DIR = previous;
		removeTempDirectory(root);
	}
});

test("session and journal defaults share a file without sharing records", async () => {
	const root = makeTempDirectory("session-shared-");
	const previous = process.env.ATOMIC_CODING_AGENT_DIR;
	process.env.ATOMIC_CODING_AGENT_DIR = join(root, "agent");
	const managers: SessionManager[] = [];
	const journal = await resolveRunJournal();
	try {
		const first = await SessionManager.create(root);
		managers.push(first);
		await first.appendSessionInfo("persistent session");
		await journal.createRun({
			runId: first.getSessionId(),
			name: "journal only",
			cwd: root,
			createdAt: 1,
			status: "running",
		});
		assert.deepEqual(first.getSessionStore().descriptor, (await journal.getRun(first.getSessionId()))?.storage);
		assert.equal((await journal.getRun(first.getSessionId()))?.name, "journal only");
		assert.equal((await first.getSessionStore().load(first.getSessionId())).entries.length, 1);
		const stageStore = await stageSessionStore({ cwd: root });
		assert.deepEqual(stageStore.descriptor, first.getSessionStore().descriptor);
		assert.equal((await stageStore.load(first.getSessionId())).header.id, first.getSessionId());
		await stageStore.close();
		assert.equal((await SessionManager.list(root))[0]?.name, "persistent session");
		assert.equal((await SessionManager.listAll())[0]?.id, first.getSessionId());
		assert.equal(await SessionManager.findById(root, first.getSessionId()), first.getSessionId());
		const recent = await SessionManager.continueRecent(root);
		managers.push(recent);
		assert.equal(recent.getSessionId(), first.getSessionId());
		const cli = await createSessionManager(
			parseArgs(["--session", first.getSessionId()]),
			root,
			undefined,
			SettingsManager.inMemory(),
		);
		managers.push(cli);
		assert.equal(cli.getSessionId(), first.getSessionId());
		const fork = await first.forkTo(root);
		managers.push(fork);
		assert.equal(fork.getSessionStore().descriptor.location, first.getSessionStore().descriptor.location);
		const foreignFork = await first.forkTo(join(root, "other"));
		managers.push(foreignFork);
		const [foreignInfo] = await SessionManager.list(join(root, "other"));
		assert.equal(Object.hasOwn(foreignInfo, "parentSessionPath"), false);
		await first.getSessionStore().close();
		await journal.createRun({ runId: "still-open", name: "journal", cwd: root, createdAt: 2, status: "running" });
		assert.equal((await journal.getRun("still-open"))?.name, "journal");
	} finally {
		for (const manager of managers) await manager.getSessionStore().close();
		await journal.close();
		if (previous === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
		else process.env.ATOMIC_CODING_AGENT_DIR = previous;
		removeTempDirectory(root);
	}
});

test("configured session adapters share their database with the journal", async () => {
	const root = makeTempDirectory("session-adapter-");
	const previous = process.env.ATOMIC_CODING_AGENT_DIR;
	process.env.ATOMIC_CODING_AGENT_DIR = join(root, "agent");
	const lifecycle = join(root, "lifecycle.txt");
	const settings = {
		storage: {
			adapter: join(moduleDir(import.meta.url), "../fixtures/storage-adapter.ts"),
			options: { path: join(root, "shared.sqlite"), lifecycle },
		},
	};
	try {
		const sessions = await resolveSessionStore(root, { settings });
		const journal = await resolveRunJournal({ settings });
		assert.equal(await readText(lifecycle), "open\n");
		await sessions.close();
		assert.equal(await readText(lifecycle), "open\n");
		await journal.close();
		assert.equal(await readText(lifecycle), "open\nclose\n");
	} finally {
		if (previous === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
		else process.env.ATOMIC_CODING_AGENT_DIR = previous;
		removeTempDirectory(root);
	}
});

test("failed session selection never falls back from persistent storage", async () => {
	const root = makeTempDirectory("session-failure-");
	const obstacle = join(root, "file");
	await writeFileEnsuringDir(obstacle, "not a directory");
	try {
		for (const sessionStore of [
			{ kind: "sqlite", path: join(obstacle, "sessions.sqlite") },
			{ kind: "jsonl", dir: join(obstacle, "sessions") },
		] as const) {
			await assert.rejects(
				resolveSessionStore(root, { sessionStore }),
				sessionStore.kind === "jsonl" ? JsonlStorageUnavailableError : StorageUnavailableError,
			);
		}
	} finally {
		removeTempDirectory(root);
	}
});

test("default import and fork factories persist in SQLite without creating extra sessions", async () => {
	const root = makeTempDirectory("session-import-");
	const previous = process.env.ATOMIC_CODING_AGENT_DIR;
	process.env.ATOMIC_CODING_AGENT_DIR = join(root, "agent");
	const managers: SessionManager[] = [];
	try {
		const source = await SessionManager.create(root, join(root, "jsonl"));
		managers.push(source);
		await source.appendSessionInfo("imported");
		const imported = await SessionManager.importFromJsonl(source.getSessionFile()!, root);
		managers.push(imported);
		assert.equal(imported.getSessionStore().descriptor.adapter, "node-sqlite");
		assert.equal((await SessionManager.list(root)).length, 1);
		const forked = await SessionManager.forkFrom(source.getSessionFile()!, root);
		managers.push(forked);
		assert.equal(forked.getSessionStore().descriptor.adapter, "node-sqlite");
		assert.equal(forked.getSessionStore().descriptor.location, imported.getSessionStore().descriptor.location);
		assert.equal((await SessionManager.list(root)).length, 2);
		const secondSource = await SessionManager.create(root, join(root, "jsonl"));
		managers.push(secondSource);
		const cliImport = await createSessionManager(
			parseArgs(["--import", secondSource.getSessionFile()!]),
			root,
			undefined,
			SettingsManager.inMemory(),
		);
		managers.push(cliImport);
		assert.equal(cliImport.getSessionId(), secondSource.getSessionId());
		assert.equal((await SessionManager.list(root)).length, 3);
	} finally {
		for (const manager of managers) await manager.getSessionStore().close();
		if (previous === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
		else process.env.ATOMIC_CODING_AGENT_DIR = previous;
		removeTempDirectory(root);
	}
});
