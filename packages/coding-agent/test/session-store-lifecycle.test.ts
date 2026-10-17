import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@bastani/pi-ai/compat";
import { test, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import {
	AgentSessionRuntime,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createSessionManager } from "../src/main-session.ts";
import { createIsolatedInteractiveRuntime } from "../src/modes/interactive-engine/create-isolated-runtime.ts";
import { IsolatedInteractiveRuntime } from "../src/modes/interactive-engine/isolated-runtime.ts";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

const closedStoreError = { name: "StoreClosedError" };

async function servicesFor(cwd: string) {
	return createAgentSessionServices({
		cwd,
		agentDir: join(cwd, "agent"),
		modelRuntime: await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		}),
		settingsManager: SettingsManager.inMemory(),
		resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true },
	});
}

const sessionOptions = { model: getModel("anthropic", "claude-sonnet-4-5"), noTools: true };

test("SDK-owned SQLite survives new, fork and switch, and closes with its runtime", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "session-store-lifetime-"));
	const services = await servicesFor(cwd);
	const initial = await createAgentSessionFromServices({ services, ...sessionOptions });
	const store = initial.session.sessionManager.getSessionStore();
	const runtime = new AgentSessionRuntime(initial.session, services, async (options) => ({
		...(await createAgentSessionFromServices({
			services,
			...sessionOptions,
			sessionManager: options.sessionManager,
			sessionStartEvent: options.sessionStartEvent,
		})),
		services,
		diagnostics: [],
	}));
	try {
		const originalId = runtime.session.sessionId;
		await runtime.newSession();
		await runtime.session.sessionManager.appendMessage({ role: "user", content: "successor message", timestamp: 1 });
		const entry = runtime.session.sessionManager.getEntries().at(-1)!;
		await runtime.fork(entry.id, { position: "at" });
		await runtime.session.sessionManager.appendSessionInfo("fork writes");
		assert.equal((await store.load(runtime.session.sessionId)).entries.at(-1)?.type, "session_info");
		await runtime.switchSession(originalId);
		await runtime.session.sessionManager.appendSessionInfo("switched writes");
		assert.equal((await store.load(originalId)).entries.at(-1)?.type, "session_info");
	} finally {
		await runtime.dispose();
	}
	try {
		await assert.rejects(store.load(initial.session.sessionId), closedStoreError);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("CLI-acquired stores close on SDK disposal and failed SDK construction", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "cli-store-lifetime-"));
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", join(cwd, "agent"));
	const services = await servicesFor(cwd);
	try {
		const manager = await createSessionManager(parseArgs([]), cwd, undefined, services.settingsManager);
		const result = await createAgentSessionFromServices({ services, ...sessionOptions, sessionManager: manager });
		await result.session.dispose();
		await assert.rejects(manager.getSessionStore().load(manager.getSessionId()), closedStoreError);
		const failedManager = await createSessionManager(parseArgs([]), cwd, undefined, services.settingsManager);
		const refresh = services.modelRuntime.refresh;
		services.modelRuntime.refresh = async () => {
			throw new Error("construction failed");
		};
		try {
			await assert.rejects(
				createAgentSessionFromServices({ services, ...sessionOptions, sessionManager: failedManager }),
				/construction failed/,
			);
			await assert.rejects(failedManager.getSessionStore().load(failedManager.getSessionId()), closedStoreError);
		} finally {
			services.modelRuntime.refresh = refresh;
		}
	} finally {
		vi.unstubAllEnvs();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("failed runtime preparation releases a CLI store before SDK handoff", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "cli-store-preparation-"));
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", join(cwd, "agent"));
	const manager = await createSessionManager(parseArgs([]), cwd, undefined, SettingsManager.inMemory());
	try {
		await assert.rejects(
			createAgentSessionRuntime(
				async () => {
					throw new Error("preparation failed");
				},
				{ cwd, agentDir: join(cwd, "agent"), sessionManager: manager },
			),
			/preparation failed/,
		);
		await assert.rejects(manager.getSessionStore().load(manager.getSessionId()), closedStoreError);
	} finally {
		await manager.getSessionStore().close();
		vi.unstubAllEnvs();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("the isolated host takes store ownership from its local runtime", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "isolated-store-owner-"));
	const services = await servicesFor(cwd);
	const initial = await createAgentSessionFromServices({ services, ...sessionOptions });
	const factory = async () => ({ ...initial, services, diagnostics: [] });
	const local = new AgentSessionRuntime(initial.session, services, factory);
	const isolated = new IsolatedInteractiveRuntime(local, factory, new RpcClient({ cliPath: "unused", cwd }));
	try {
		await isolated.dispose({ fromSignal: true });
		await assert.rejects(
			initial.session.sessionManager.getSessionStore().load(initial.session.sessionId),
			closedStoreError,
		);
	} finally {
		await local.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("failed engine startup closes the local runtime's owned store", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "failed-engine-store-"));
	const services = await servicesFor(cwd);
	const initial = await createAgentSessionFromServices({ services, ...sessionOptions });
	const factory = async () => ({ ...initial, services, diagnostics: [] });
	const local = new AgentSessionRuntime(initial.session, services, factory);
	const start = vi.spyOn(RpcClient.prototype, "start").mockRejectedValue(new Error("engine startup failed"));
	try {
		await assert.rejects(
			createIsolatedInteractiveRuntime({
				localRuntime: local,
				createRuntime: factory,
				parsed: parseArgs([]),
				sessionManager: initial.session.sessionManager,
				resources: {},
			}),
			/engine startup failed/,
		);
		await assert.rejects(
			initial.session.sessionManager.getSessionStore().load(initial.session.sessionId),
			closedStoreError,
		);
	} finally {
		start.mockRestore();
		await local.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});
