import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import { getFixtureModel } from "../../../test/helpers/catalog-model-fixtures.ts";
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

const sessionOptions = { model: getFixtureModel("anthropic", "claude-sonnet-4-5"), noTools: true };

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
		// The host does not wait for the engine to start; binding to it reports the failure.
		const isolated = await createIsolatedInteractiveRuntime({
			localRuntime: local,
			createRuntime: factory,
			parsed: parseArgs([]),
			sessionManager: initial.session.sessionManager,
			resources: {},
		});
		await assert.rejects(isolated.waitUntilBound(), /engine startup failed/);
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

/** A stand-in engine child: runs `body` and never speaks the engine protocol unless `body` does. */
function fakeEngine(cwd: string, body: string): RpcClient {
	const path = join(cwd, "fake-engine.mjs");
	writeFileSync(path, body);
	return new RpcClient({
		cliPath: path,
		cwd,
		runtimeExecutable: process.execPath,
		interactiveEngine: { onDiagnostic: () => {} },
	});
}

test("the host's runtime is usable while its engine child is still loading, and a quit then is not a failure", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "loading-engine-store-"));
	const services = await servicesFor(cwd);
	const initial = await createAgentSessionFromServices({ services, ...sessionOptions });
	const factory = async () => ({ ...initial, services, diagnostics: [] });
	const local = new AgentSessionRuntime(initial.session, services, factory);
	// The child never announces readiness, like an engine still loading its modules.
	const client = fakeEngine(cwd, "process.stdin.resume();");
	const isolated = new IsolatedInteractiveRuntime(local, factory, client, client.start());
	try {
		assert.equal(isolated.session, initial.session);
		let settled = false;
		const bound = isolated.waitUntilBound().finally(() => {
			settled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(settled, false);
		await isolated.dispose({ fromSignal: true });
		await bound;
	} finally {
		await local.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("an engine child that exits before it is ready fails startup without a restart and closes the local store", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "early-exit-engine-store-"));
	const services = await servicesFor(cwd);
	const initial = await createAgentSessionFromServices({ services, ...sessionOptions });
	const factory = async () => ({ ...initial, services, diagnostics: [] });
	const local = new AgentSessionRuntime(initial.session, services, factory);
	const restart = vi.spyOn(RpcClient.prototype, "restart");
	const client = fakeEngine(cwd, 'process.stderr.write("engine boom\\n"); process.exit(7);');
	const isolated = new IsolatedInteractiveRuntime(local, factory, client, client.start());
	try {
		await assert.rejects(isolated.waitUntilBound(), /code=7[\s\S]*engine boom/);
		await assert.rejects(isolated.waitUntilResourcesReady(), /code=7/);
		assert.equal(restart.mock.calls.length, 0);
		await assert.rejects(
			initial.session.sessionManager.getSessionStore().load(initial.session.sessionId),
			closedStoreError,
		);
	} finally {
		restart.mockRestore();
		await isolated.dispose({ fromSignal: true });
		await local.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});
