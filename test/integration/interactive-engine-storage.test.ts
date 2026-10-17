import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { parseArgs } from "../../packages/coding-agent/src/cli/args.js";
import {
	createAgentSessionServices,
	createUnstartedAgentSessionFromServices,
} from "../../packages/coding-agent/src/core/agent-session-services.js";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { resolveSessionStore } from "../../packages/coding-agent/src/core/session-storage.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { buildInteractiveEngineArgs } from "../../packages/coding-agent/src/modes/interactive-engine/engine-args.js";
import { RpcClient } from "../../packages/coding-agent/src/modes/rpc/rpc-client.js";

// A real built CLI child loads all startup resources and serves RPC over pipes.
const BUILT_ENGINE_RPC_TIMEOUT_MS = 90_000;

test(
	"the built engine resumes the selected SQLite database and prefix from a different project",
	async () => {
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
			cliPath: fileURLToPath(new URL("../../packages/coding-agent/dist/cli.js", import.meta.url)),
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
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noContextFiles: true,
				},
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
	},
	BUILT_ENGINE_RPC_TIMEOUT_MS,
);
