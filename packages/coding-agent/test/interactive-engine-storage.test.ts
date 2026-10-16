import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getModel } from "@bastani/pi-ai/compat";
import { test } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	createUnstartedAgentSessionFromServices,
} from "../src/core/agent-session-services.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { resolveSessionStore, takeEngineSessionStorageArg } from "../src/core/session-storage.js";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { JsonlSessionStore } from "../src/core/storage/session/jsonl-session-store.js";
import { createSessionManager } from "../src/main-session.ts";
import { createRuntimeForMode } from "../src/modes/interactive-engine/create-isolated-runtime.ts";
import { buildInteractiveEngineArgs } from "../src/modes/interactive-engine/engine-args.ts";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import { restartCliArgs } from "../src/modes/rpc/rpc-client-process.js";

test("the built engine resumes the selected SQLite database and prefix from a different project", async () => {
	const root = mkdtempSync(join(tmpdir(), "engine-storage-"));
	const projectA = join(root, "project-a");
	const projectB = join(root, "project-b");
	const agentDir = join(root, "agent");
	for (const directory of [projectA, projectB, agentDir]) mkdirSync(directory, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ onboardedVersion: "0.0.0" }));
	const store = await resolveSessionStore(projectA, {
		agentDir,
		settings: { sessions: { storage: { path: "selected.sqlite", prefix: "kept_" } } },
	});
	const manager = await SessionManager.create(store, projectB);
	await manager.appendSessionInfo("selected conversation");
	const parsed = parseArgs([
		"--offline",
		"--no-extensions",
		"--no-mcp",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"--approve",
	]);
	const client = new RpcClient({
		cliPath: fileURLToPath(new URL("../dist/cli.js", import.meta.url)),
		cwd: projectB,
		runtimeExecutable: process.execPath,
		args: buildInteractiveEngineArgs(parsed, manager, {}),
		env: { ATOMIC_CODING_AGENT_DIR: agentDir, ANTHROPIC_API_KEY: "test-only-no-requests" },
	});
	try {
		await client.start();
		const state = await client.getState();
		assert.equal(state.sessionId, manager.getSessionId());
		assert.equal(state.sessionName, "selected conversation");
		assert.equal(state.sessionLocation, manager.getSessionFile());
		assert.deepEqual((await store.load(manager.getSessionId())).entries[0], manager.getEntries()[0]);
		const beforeMirror = await store.load(manager.getSessionId());
		const modelRuntime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const services = await createAgentSessionServices({
			cwd: projectB,
			agentDir,
			modelRuntime,
			settingsManager: SettingsManager.inMemory(),
			resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true },
		});
		const mirror = await createUnstartedAgentSessionFromServices(
			{ services, sessionManager: await SessionManager.open(store, manager.getSessionId()) },
			false,
		);
		try {
			assert.deepEqual(await store.load(manager.getSessionId()), beforeMirror);
			await client.setSessionName("child still writes");
			const latest = (await store.load(manager.getSessionId())).entries.at(-1);
			assert.ok(latest?.type === "session_info");
			assert.equal(latest.name, "child still writes");
		} finally {
			await mirror.session.dispose();
		}
	} finally {
		await client.stop();
		await store.close();
		rmSync(root, { recursive: true, force: true });
	}
}, 90_000);

test("memory and caller-owned databases keep the selected store in the host runtime", async () => {
	const root = mkdtempSync(join(tmpdir(), "engine-owned-store-"));
	const database = await openNodeSqliteDatabase(join(root, "owned.sqlite"));
	const modelRuntime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	try {
		for (const sessionStore of [{ kind: "memory" }, { kind: "database", database }] as const) {
			const store = await resolveSessionStore(root, { sessionStore });
			const manager = await SessionManager.create(store, root);
			const runtime = await createRuntimeForMode(
				async (options) => {
					const services = await createAgentSessionServices({
						...options,
						modelRuntime,
						settingsManager: SettingsManager.inMemory(),
						resourceLoaderOptions: {
							noExtensions: true,
							noSkills: true,
							noPromptTemplates: true,
							noContextFiles: true,
						},
					});
					return {
						...(await createAgentSessionFromServices({
							services,
							sessionManager: options.sessionManager,
							model: getModel("anthropic", "claude-sonnet-4-5"),
							noTools: true,
						})),
						services,
						diagnostics: services.diagnostics,
					};
				},
				root,
				join(root, "agent"),
				manager,
				true,
				true,
				parseArgs([]),
				{},
			);
			try {
				assert.equal(runtime.session.sessionManager.getSessionStore(), store);
				await runtime.session.sessionManager.appendSessionInfo("same store");
				assert.deepEqual((await store.load(manager.getSessionId())).entries, manager.getEntries());
			} finally {
				await runtime.dispose();
				await store.close();
			}
		}
		await database.run("CREATE TABLE still_owned (id INTEGER)");
	} finally {
		await database.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("engine restart replaces an earlier SQLite selection with the newly selected JSONL store", async () => {
	const root = mkdtempSync(join(tmpdir(), "engine-storage-restart-"));
	const sqlite = await resolveSessionStore(root, {
		sessionStore: { kind: "sqlite", path: join(root, "sessions.sqlite") },
	});
	const directory = join(root, "jsonl");
	const jsonl = await JsonlSessionStore.open(directory, { exactDirectory: true });
	let reopened: SessionManager | undefined;
	try {
		const original = await SessionManager.create(sqlite, root, { id: "shared-id" });
		await original.appendSessionInfo("sqlite");
		const selected = await SessionManager.create(jsonl, root, { id: "shared-id" });
		await selected.appendSessionInfo("jsonl");
		const initial = buildInteractiveEngineArgs(parseArgs([]), original, {});
		const restarted = takeEngineSessionStorageArg(restartCliArgs(initial, selected.getSessionId(), directory));
		const parsed = parseArgs(restarted.args);
		reopened = await createSessionManager(
			parsed,
			root,
			parsed.sessionDir,
			SettingsManager.inMemory(),
			restarted.sessionStorage,
		);
		assert.equal(reopened.getSessionStore().descriptor.adapter, "jsonl");
		assert.equal(reopened.getSessionName(), "jsonl");
		assert.equal((await sqlite.load("shared-id")).entries[0]?.type, "session_info");
		const memoryArgs = takeEngineSessionStorageArg(restartCliArgs(initial, undefined));
		const memory = await createSessionManager(
			parseArgs(memoryArgs.args),
			root,
			undefined,
			SettingsManager.inMemory(),
			memoryArgs.sessionStorage,
		);
		try {
			assert.equal(memory.isPersisted(), false);
		} finally {
			await memory.getSessionStore().close();
		}
	} finally {
		await reopened?.getSessionStore().close();
		await jsonl.close();
		await sqlite.close();
		rmSync(root, { recursive: true, force: true });
	}
});
